# static-wordpress

WordPress as a static-site CMS. Editors run WordPress Playground in their browser; a Cloudflare Worker stores snapshots in D1 and media in R2, serves a build-token content feed, and triggers the site's Workers Builds. A Nuxt module loads that feed at build time.

Extracted from [joebailey26/joebaileyxyz](https://github.com/joebailey26/joebaileyxyz).
