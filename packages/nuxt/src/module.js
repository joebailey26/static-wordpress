import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { addImports, addServerHandler, createResolver, defineNuxtModule } from '@nuxt/kit'
import { loadCmsContent } from './content/load-content.js'
import { configureFavicons } from './content/convert-links.js'
import { imageTransformationsEnabled } from './images.js'

// Loads the CMS content once per build and hands it to the Nitro /_content routes, which the pages read through
// useCmsIndex and useCmsPost. Prerendering stores each result in the page payload.
export default defineNuxtModule({
  meta: { name: 'static-wordpress', configKey: 'cms' },
  defaults: {
    apiUrl: process.env.CMS_API_URL,
    token: process.env.CMS_BUILD_TOKEN,
    // The public origin, for absolute og:image URLs and the sitemap.
    siteUrl: undefined,
    perPage: 10,
    // Per-section options: { blog: { perPage: 10, paginate: true } }. Paginated sections prerender {path}page/N/.
    sections: {},
    // Workers Builds sets WORKERS_CI_BRANCH; only this branch's builds run on the zone that serves /cdn-cgi/image.
    productionBranch: 'master',
    imageTransformations: undefined,
    imageSizes: undefined,
    favicons: false,
    torchlight: false,
    sitemap: { exclude: [] }
  },
  async setup (options, nuxt) {
    const resolver = createResolver(import.meta.url)
    if (!options.siteUrl) {
      throw new Error('Set cms.siteUrl in nuxt.config to the public origin, e.g. https://example.com')
    }
    const siteUrl = options.siteUrl.replace(/\/$/, '')
    // Every image helper reads this, so the pages, the content pipeline and runtimeConfig agree.
    const transformations = options.imageTransformations ?? imageTransformationsEnabled(process.env, options.productionBranch)
    process.env.IMAGE_TRANSFORMATIONS = String(transformations)
    nuxt.options.runtimeConfig.public.imageTransformations = transformations

    const cacheDirectory = path.join(nuxt.options.rootDir, 'node_modules/.cache/nuxt/cms')
    configureFavicons({ publicDirectory: path.resolve(nuxt.options.rootDir, nuxt.options.dir.public), cacheDirectory })

    // `nuxt prepare` (postinstall, typecheck) only generates types, so it needs no content or CMS credentials.
    const { content, sections } = nuxt.options._prepare
      ? { content: {}, sections: [] }
      : await loadCmsContent({ ...options, siteUrl, cacheDirectory, torchlight: options.torchlight === true ? {} : options.torchlight })

    const routes = []
    for (const { name, path: sectionPath } of sections) {
      if (!sectionPath) {
        continue
      }
      if (options.sections[name]?.paginate) {
        for (let page = 2; page <= content[name].length; page++) {
          routes.push(`${sectionPath}page/${page}/`)
        }
      }
      for (const post of content[name].flat()) {
        routes.push(`${sectionPath}${post.slug}/`)
      }
    }

    nuxt.hook('nitro:config', (config) => {
      config.virtual = { ...config.virtual, '#cms-content': `export default ${JSON.stringify(content)}` }
      config.prerender = { ...config.prerender, routes: [...(config.prerender?.routes || []), ...routes] }
    })
    addServerHandler({ route: '/_content/:section', handler: resolver.resolve('./runtime/server/routes/index.get.js') })
    addServerHandler({ route: '/_content/:section/:slug', handler: resolver.resolve('./runtime/server/routes/post.get.js') })
    addImports(['useCmsIndex', 'useCmsPost'].map((name) => ({ name, from: resolver.resolve('./runtime/composables/useCms.js') })))

    // Writes sitemap.xml from the HTML pages that prerendering generated, with trailing slashes.
    const exclude = (options.sitemap?.exclude || []).map((route) => (route instanceof RegExp ? route : new RegExp(`^${route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)))
    nuxt.hook('nitro:init', (nitro) => {
      const pages = new Set()
      nitro.hooks.hook('prerender:route', ({ route, error, contentType }) => {
        if (error || !contentType?.startsWith('text/html') || /^\/(?:404|200)(?:\.html|\/)?$/.test(route)) {
          return
        }
        const normalised = route.endsWith('/') ? route : `${route}/`
        if (!exclude.some((pattern) => pattern.test(normalised))) {
          pages.add(normalised)
        }
      })
      nitro.hooks.hook('prerender:done', async () => {
        if (!pages.size || options.sitemap === false) {
          return
        }
        const body = [...pages].sort().map((route) => `  <url><loc>${siteUrl}${route}</loc></url>`).join('\n')
        const dir = nitro.options.output.publicDir
        await mkdir(dir, { recursive: true })
        await writeFile(path.join(dir, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`)
      })
    })
  }
})
