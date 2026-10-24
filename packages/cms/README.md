# @joebailey26/static-wordpress

WordPress runs in the editor's browser (WordPress Playground). A Cloudflare Worker authenticates editors with Cloudflare Access, stores complete SQLite snapshots in D1 and user-owned files in R2, and exposes a token-protected, revision-pinned content feed. The site's Nuxt build reads that feed with [`@joebailey26/nuxt-static-wordpress`](../nuxt) and is hosted as a static site. No PHP server runs in Cloudflare.

## A site's `cms/` folder

The package holds the editor, Worker, WordPress bridge, D1 migrations and the pinned Playground runtime. Each site keeps a small folder, conventionally `cms/`, with everything that is its own:

```text
cms/
  package.json                       depends on @joebailey26/static-wordpress and wrangler
  .npmrc                             GitHub Packages registry for @joebailey26
  cms.config.json                    sections and custom fields (below)
  worker.mjs                         export default createCms(config)
  wrangler.jsonc                     Worker name, route, D1/R2 bindings, Access settings
  wrangler.preview-migrations.jsonc  Preview D1 database only
  access-policy.json                 Access allowlist, for reference
  .dev.vars.example
```

`worker.mjs`:

```js
import { createCms } from '@joebailey26/static-wordpress/worker'
import config from './cms.config.json'

export default createCms(config)
```

In `wrangler.jsonc`, set `"main": "worker.mjs"`, `"assets": { "directory": "./dist", "binding": "ASSETS", "run_worker_first": true, "html_handling": "none", "not_found_handling": "none" }` and point both D1 bindings' `migrations_dir` at `node_modules/@joebailey26/static-wordpress/migrations`.

`package.json` scripts call the `static-wordpress` CLI, which runs against the current directory (or `--root <dir>`):

```json
{
  "scripts": {
    "dev": "static-wordpress dev",
    "build": "static-wordpress build",
    "build:ci": "static-wordpress build:ci",
    "runtime": "static-wordpress runtime",
    "runtime:upload": "static-wordpress runtime:upload",
    "db:local": "static-wordpress db:local",
    "deploy:production": "static-wordpress deploy",
    "deploy:preview": "static-wordpress deploy --preview",
    "import": "static-wordpress import"
  }
}
```

`.npmrc` (GitHub Packages needs a token even for public packages; set `GITHUB_PACKAGES_TOKEN` to a token with `read:packages`, locally and in Workers Builds):

```ini
node-linker=hoisted
@joebailey26:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

### `cms.config.json`

```json
{
  "id": "example",
  "name": "Example",
  "siteUrl": "https://example.com",
  "sections": [
    { "name": "blog", "category": "blog", "label": "Blog", "path": "/blog/" },
    { "name": "testimonials", "category": "testimonials", "label": "Testimonials", "path": null }
  ],
  "fieldGroups": [
    { "title": "SEO", "fields": [{ "key": "seo_description", "label": "Meta description", "type": "textarea" }] }
  ]
}
```

- `id` names the Playground scope, browser storage, lock and headless theme (`<id>-headless`). Never change it for an existing site: the scope is part of URLs stored in its database.
- Each **section** is one WordPress category. Published posts in it make up that section of the feed. `path` is the public URL prefix; links to posts are rewritten to `siteUrl + path + slug/`. Use `"path": null` for content that has no page of its own.
- **Field groups** become native metaboxes on posts (when ACF is not installed; ACF values are used when it is). Field types: `text`, `textarea`, `url` and `checkboxes` (with `options`). Every record's `acf` object carries every configured key.
- Records also carry `modified`, `tags` (names) and `author` (display name).

The Worker and the editor are both built from this file; the editor refuses to open when they differ.

## Local setup

Use Node **24.18.0** and pnpm **10.11.1**. From the site's `cms/` folder:

```powershell
pnpm install --frozen-lockfile
pnpm run runtime
Copy-Item .dev.vars.example .dev.vars
pnpm run db:local
pnpm run dev
```

The runtime command streams the pinned Playground archive (approximately 685 MiB) from the release URL in this package's `runtime.lock.json`, verifies its SHA-256 and extracts it into `cms/runtime/`. An already downloaded ZIP can be supplied with `static-wordpress runtime C:/path/playground.zip`. Prepared runtime reuse checks its checksum and file inventory; a partial Workers Builds cache restore triggers a fresh, verified download. Every build reconstructs `dist`.

Open the localhost address printed by Wrangler. `.dev.vars` enables a localhost-only authentication bypass (`LOCAL_DEV=true`); it cannot bypass Access on a deployed hostname. Use a local build token of at least 32 random characters.

The runtime contains WordPress 7.0.7, PHP 8.5, its SQLite integration and Playground 3.1.60. WordPress never updates itself in the editor (automatic updates, cron and networking are off); updates arrive as a new runtime in a package release (see [Updating WordPress and PHP](#updating-wordpress-and-php)).

The build adapts Playground's bundled service worker to a classic script, because Chrome omits cookies on module service-worker script requests and Access would redirect them to login. The build fails if the expected upstream registration changes.

## Cloudflare deployment

1. Create a D1 database and R2 bucket for production and a separate pair for previews, and put their names and IDs in `wrangler.jsonc` (`previews` holds the preview bindings) and `wrangler.preview-migrations.jsonc`.
2. Create a Cloudflare Access self-hosted application for the CMS hostname with the editors' emails. Require Access for the editor, runtime and `/api/editor/*`. Exclude `/media/*` and `/api/content/*` from interactive login: media is public, and the Worker enforces the build token on the feed. Set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` in `vars`. Protect Preview `workers.dev` hostnames with a second Access application and set its audience in `previews.vars.ACCESS_AUD`.
3. Create a user-scoped API token with **Workers Builds Configuration: Edit**. Set Worker secrets from `cms/`: `wrangler secret put CMS_BUILD_TOKEN` and `wrangler secret put CF_BUILD_API_TOKEN`. Set `CF_ACCOUNT_ID`, `CF_WORKER_TAG` (the site Worker's tag) and `SITE_BRANCH` in `vars`; `CF_BUILD_TRIGGER_ID` overrides the trigger lookup. Give the site's Workers Builds the same `CMS_API_URL` and `CMS_BUILD_TOKEN`.
4. `pnpm run build:ci`, then `pnpm run deploy:production`: migrations, oversized runtime assets to R2, then `wrangler deploy`. Any failed step stops deployment.

### Workers Builds

Configure the CMS Worker with root `/cms`, build command `pnpm run build:ci`, deploy command `pnpm run deploy:production` and Preview command `pnpm run deploy:preview`. Set `NODE_VERSION=24.18.0` and `GITHUB_PACKAGES_TOKEN`. Watch `cms/**`.

Previews bind the preview database and bucket. The deploy script refuses production storage, a migrations config for another database, or preview builds that could trigger website builds: set `"CMS_TRIGGER_BUILDS": "false"` in `previews.vars`. All previews share the preview content and the single-editor lease. The five-minute cron applies to production only.

### Updating WordPress and PHP

WordPress and PHP come from the pinned Playground build in `runtime.lock.json`. To update them:

1. Publish a reviewed official Playground archive under a new release tag on this repository. Never replace the bytes behind an existing pinned URL.
2. Update `runtime.lock.json` together: URL, checksum, Playground version, WordPress major and provenance. For a PHP change, update `PHP_VERSION` (and `SUPPORTED_PHP`) in `src/shared.mjs`.
3. Run `pnpm run test:runtime` (CI runs it on Linux and Windows), release the package, and bump it in each site's `cms/package.json`; the CMS Workers Build redeploys the editor.

Existing content needs no manual migration. A snapshot opens on the WordPress it was saved with or any newer one: after restoring, the editor runs core's database upgrade (`wp_upgrade()`, as `wp-admin/upgrade.php` would), shows a notice and marks the site unsynced, so the next sync saves the upgraded snapshot. The previous versions stay under **Saved versions** as the rollback. A snapshot from a newer WordPress than the editor's is refused, because WordPress cannot run on a newer database. The SQLite database does not depend on the PHP version, so snapshots from any supported PHP version restore unchanged.

Plugins installed through the editor live in the snapshot and do not update themselves; upload a new version's ZIP in wp-admin and sync.

## Import existing content

A BackWPup-style full-site backup (SQL dump plus `wp-content`) converts without running its SQL, PHP or installer:

```powershell
static-wordpress import --archive C:/backups/site.zip --rename-meta _yoast_wpseo_metadesc=seo_description --fetch-missing true
```

- Each section imports the source category with the same slug as its `category`. Use `--map <source id or slug>=<section>` (repeatable) when they differ.
- `--rename-meta <source key>=<field>` (repeatable) renames post meta, for example a Yoast description into a configured field.
- `--fetch-missing true` downloads media missing from the archive from the source site; `--uploads <dir>` supplies them from a local folder instead.
- The bundle and `migration-report.json` (counts per section, drafts, media, missing files, shortcodes) are written to `cms/migration/`, which must stay out of Git. No bundle is written while original attachments are missing.

A WXR export works too: `static-wordpress import:wxr --wxr export.xml --content wp-content [--acf fields.json]`.

Open the preview editor and use **Import migration/backup**. Import runs through WordPress APIs, maps taxonomies and attachment IDs, preserves dates, statuses, serialized meta and authors, and rewrites upload and content links. Reimporting updates the same records. Automatic sync is paused after import; review every section, then **Sync now**.

## Synchronization and recovery

- Automatic sync checks for changes every two minutes; **Sync now** and **Close editor** sync immediately. During capture the bridge briefly answers other WordPress requests with a retryable 503 so the database and files are consistent. Each checkpoint stores the whole SQLite database in 256 KiB D1 chunks with SHA-256 checksums.
- Saved uploads stay in R2 while editing; the bridge redirects missing `wp-content/uploads/...` requests to the public `/media/<hash>/...` URL. Image edits fetch the original pixels on demand.
- A local IndexedDB recovery checkpoint is written before upload. Cloud activation is a guarded D1 transaction that requires the current lease and base revision.
- One browser session holds a two-minute lease, renewed every 30 seconds. Refreshing resumes it; duplicated tabs are excluded with a Web Lock.
- The latest three snapshots are kept and can be downloaded from **Saved versions**.
- A hash of published output decides whether to request a site build; draft-only saves do not. Failed build requests are retried from the editor and by the cron.
- WordPress cron is disabled, so scheduled publishing while the editor is closed is unsupported. This is a single-editor CMS.

Limits: a 128 MiB database, 50 MiB per file, a 1.5 MB manifest and rendered record, and a 24 MiB rendered feed.

## Verification

```powershell
pnpm test
pnpm run check
pnpm run test:runtime    # prepares the runtime for test/site and boots the pinned WordPress twice
# With `static-wordpress dev --root test/site` running and Playwright Chromium installed:
node bin/static-wordpress.mjs test:browser --root test/site
```

References: [Playground self-hosting](https://developer.wordpress.org/playground/developers/architecture/host-your-own-playground/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/), [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/).
