# @joebailey26/nuxt-static-wordpress

Loads a [static-wordpress](../cms) CMS feed once per `nuxt generate`, prepares post HTML (Cloudflare Image Transformations, video markup, optional link favicons and Torchlight highlighting), and serves it to pages through `/_content` routes that prerendering bakes into each page's payload.

```js
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['@joebailey26/nuxt-static-wordpress'],
  cms: {
    siteUrl: 'https://example.com',
    sections: { blog: { perPage: 10, paginate: true } },
    sitemap: { exclude: ['/client/'] }
  },
  nitro: { preset: 'static', prerender: { crawlLinks: true, failOnError: true } }
})
```

Build variables: `CMS_API_URL` and `CMS_BUILD_TOKEN` (server-side only; never put the token in `runtimeConfig`). `nuxt prepare` skips loading content.

## Options (`cms`)

| Option | Default | |
| --- | --- | --- |
| `siteUrl` | required | Public origin, for absolute og:image URLs and `sitemap.xml`. |
| `apiUrl`, `token` | `CMS_API_URL`, `CMS_BUILD_TOKEN` | The CMS Worker and its build token. |
| `perPage` | `10` | Feed page size; also the page size of `useCmsIndex` pages. |
| `sections.<name>.perPage` | `perPage` | Per-section page size. |
| `sections.<name>.paginate` | `false` | Prerender `{path}page/N/` for N ≥ 2. Add the route with `pages:extend`. |
| `productionBranch` | `'master'` | Image transformations default on only for Workers Builds of this branch (`WORKERS_CI_BRANCH`). |
| `imageTransformations` | auto | Force on or off; `IMAGE_TRANSFORMATIONS=true/false` also overrides. Exposed as `runtimeConfig.public.imageTransformations`. |
| `imageSizes` | `(min-width: 1200px) 1140px, 100vw` | `sizes` for images in post content. |
| `favicons` | `false` | Fetch each external link's favicon into `public/img/favicons/` and show it after the link. |
| `torchlight` | `false` | `true` or `{ theme }` to highlight `<pre><code>` with Torchlight (install `@torchlight-api/client`, set `TORCHLIGHT_TOKEN`). |
| `sitemap` | `{ exclude: [] }` | Writes `sitemap.xml` from prerendered HTML routes; `exclude` takes routes or RegExps. `false` disables it. |

Sections, their order and their public `path` come from the CMS (`cms.config.json`); sections whose path is `null` are loaded but get no routes.

## Pages

```js
const { data: pages } = await useCmsIndex('blog')      // [[summary, …], …] pages of post summaries, no content
const { data: testimonials } = await useCmsIndex('testimonials', { content: true })  // summaries plus content
const post = await useCmsPost('blog', route.params.slug, { notFound: 'Post not found' })
```

A post has `title`, `excerpt.{raw,plain}`, `slug`, `date` and `modified` (Dates), `content` (HTML), `readingTime`, `acf` (the configured fields), `tags`, `author`, `featuredMediaUrl` (original CMS URL) and `featuredMedia` (absolute 1200px og:image URL).

## Images

```js
import { cdnImageUrl, imageSrcset, transformImageUrl } from '@joebailey26/nuxt-static-wordpress/images'
```

`transformImageUrl(src, width)` and `imageSrcset(src, intrinsicWidth)` return Cloudflare `/cdn-cgi/image/` URLs for CMS media and root-relative `public/` images when transformations are enabled, and the original otherwise. `cdnImageUrl(src, width, origin?, options?)` always builds one (pages check `runtimeConfig.public.imageTransformations` first). SVG, GIF and ICO are never transformed. Enable Image Transformations on the site's zone and allow the CMS hostname as a source.
