# static-wordpress

WordPress as a static-site CMS. Editors run WordPress Playground in their browser; a Cloudflare Worker stores snapshots in D1 and media in R2, serves a build-token content feed, and triggers the site's Workers Builds. A Nuxt module loads that feed at build time.

Extracted from [joebailey26/joebaileyxyz](https://github.com/joebailey26/joebaileyxyz).

| Package | |
| --- | --- |
| [`@joebailey26/static-wordpress`](packages/cms) | The CMS Worker, browser editor, WordPress bridge, D1 migrations, deploy and import CLI. |
| [`@joebailey26/nuxt-static-wordpress`](packages/nuxt) | The Nuxt module: build-time feed loading, content preparation, image transformations, composables and sitemap. |

Packages are published to GitHub Packages. Consumers need `@joebailey26:registry=https://npm.pkg.github.com` and a token with `read:packages` in `.npmrc`.

## Development

```powershell
corepack enable
pnpm install
pnpm test
```

Add a changeset (`pnpm changeset`) to PRs that change a package. Merging to `master` opens or publishes the release. Every push to another branch publishes `x.y.z-next-<sha>` prereleases under the `next` tag.
