const pMap = require('p-map')
const Source = require('./Source')
const EventEmitter = require('events')
const { defaultsDeep, mapValues } = require('lodash')
const { internalRE } = require('../utils/constants')
const { cache, nodeCache } = require('../utils/cache')

class Plugins extends EventEmitter {
  constructor (app) {
    super()

    this.app = app

    this.plugins = app.config.plugins.map(entry => {
      const use = entry.use.replace(internalRE, '../')
      const PluginClass = require(use)
      const defaults = PluginClass.defaultOptions()
      const options = defaultsDeep(entry.options, defaults)
      const { context, config, store, queue } = app

      const transformers = mapValues(app.config.transformers, entry => {
        return new entry.TransformerClass(entry.options, {
          localOptions: options[entry.name] || {},
          context,
          queue,
          cache,
          nodeCache
        })
      })

      const source = new Source(options, { context, store, config, transformers })
      const instance = new PluginClass(options, { context, config, source, queue })

      return { source, instance }
    })
  }

  run () {
    return pMap(this.plugins, async ({ instance, source }) => {
      await instance.apply()

      // setup reversed references
      // forEach(source.ownTypeNames, typeName => {
      //   const options = this.app.store.types[typeName]

      //   forEach(options.refs, (ref, key) => {
      //     this.app.store.types[ref.typeName].belongsTo[options.type] = {
      //       description: `Reference to ${typeName}`,
      //       localKey: ref.key,
      //       foreignType: options.type,
      //       foreignKey: key,
      //       foreignSchemaType: typeName
      //     }
      //   })
      // })

      if (process.env.NODE_ENV === 'development') {
        let regenerateTimeout = null

        // use timeout as a workaround for when files are renamed,
        // which triggers both addPage and removePage events...
        const regenerateRoutes = () => {
          clearTimeout(regenerateTimeout)
          regenerateTimeout = setTimeout(() => {
            this.emit('generateRoutes')
          }, 20)
        }

        source.on('removePage', regenerateRoutes)
        source.on('addPage', regenerateRoutes)

        source.on('change', (node, oldNode = node) => {
          if (
            (node && node.withPath && node.path !== oldNode.path) ||
            (!node && oldNode.withPath)
          ) {
            return regenerateRoutes()
          }

          this.emit('broadcast', {
            type: 'updateAllQueries'
          })
        })

        source.on('updatePage', async (page, oldPage) => {
          const { pageQuery: { paginate: oldPaginate }} = oldPage
          const { pageQuery: { paginate }} = page

          // regenerate route.js whenever paging options changes
          if (paginate.collection !== oldPaginate.collection) {
            return regenerateRoutes()
          }

          // send query to front-end for re-fetch
          this.emit('broadcast', {
            type: 'updateQuery',
            query: page.pageQuery.content,
            file: page.internal.origin
          })
        })
      }
    })
  }

  async callHook (name, ...args) {
    const results = await Promise.all(this.plugins.map(plugin => {
      return this.callMethod(plugin, name, args)
    }))

    return results.filter(value => !!value)
  }

  callHookSync (name, ...args) {
    const results = this.plugins.map(plugin => {
      return this.callMethod(plugin, name, args)
    })

    return results.filter(value => !!value)
  }

  callMethod (plugin, name, args) {
    return typeof plugin.instance[name] === 'function'
      ? plugin.instance[name](...args)
      : null
  }
}

module.exports = Plugins
