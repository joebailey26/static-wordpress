import test from 'node:test'
import type { TestContext } from 'node:test'
import type { ScheduledController } from '@cloudflare/workers-types'
import assert from 'node:assert/strict'
import { environment, fixtureConfig } from './helpers.ts'
import { defineConfig } from '../src/config.ts'
import type { Section, SiteConfigInput } from '../src/config.ts'
import { CHUNK_SIZE, sha256, validateManifest } from '../src/shared.ts'
import type { ContentRecord, Manifest, ManifestFile } from '../src/shared.ts'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'

async function fixture(t: TestContext, config?: SiteConfigInput) {
  const app = environment(config)
  t.after(() => app.close())
  const acquired = await app.request('/api/editor/lease', { method: 'POST', body: {} })
  assert.equal(acquired.status, 200)
  const { token: lease } = await acquired.json() as { token: string }
  const database = new Uint8Array(400)
  database.set(new TextEncoder().encode('SQLite format 3\0'))
  const hash = await sha256(database)
  const manifest: Manifest = { version: 1, runtime: '3.1.60', php: '8.3', wordpress: '6.8.3', databaseSize: database.length, databaseHash: hash, chunks: [hash], files: [], counts: { blog: 1, projects: 0 }, sections: { blog: 'blog', projects: 'projects' } }
  // eslint-disable-next-line camelcase -- WordPress REST field name
  const post: ContentRecord = { id: 1, section: 'blog', status: 'publish', slug: 'hello', date: '2026-10-22T12:00:00', title: { rendered: 'Hello' }, excerpt: { rendered: '<p>Excerpt</p>' }, content: { rendered: '<p>Content</p>' }, acf: { icons: ['PHP'] }, featured_media_url: null }
  async function start(baseRevision: string | null = null, override: Partial<Manifest> = {}): Promise<string> {
    const response = await app.request('/api/editor/snapshots', { method: 'POST', lease, body: { baseRevision, manifest: { ...manifest, ...override } } })
    assert.equal(response.status, 201, await response.clone().text())

    return (await response.json() as { revision: string }).revision
  }
  const upload = async (revision: string, record = post) => {
    assert.equal((await app.request(`/api/editor/snapshots/${revision}/chunks/0`, { method: 'PUT', lease, body: database })).status, 200)
    assert.equal((await app.request(`/api/editor/snapshots/${revision}/content/blog`, { method: 'PUT', lease, body: record })).status, 200)
  }
  const commit = (revision: string) => app.request(`/api/editor/snapshots/${revision}/commit`, { method: 'POST', lease, body: {} })

  return { ...app, lease, database, manifest, post, start, upload, commit }
}

test('a complete checkpoint restores bytes and exposes a revision-pinned, private feed', async t => {
  const f = await fixture(t)
  const revision = await f.start()
  await f.upload(revision)
  assert.equal((await f.commit(revision)).status, 200)
  await f.drain()
  const restored = await f.request(`/api/editor/snapshots/${revision}/chunks/0`)
  assert.deepEqual(new Uint8Array(await restored.arrayBuffer()), f.database)
  assert.equal((await f.request('/api/content/manifest')).status, 401)
  const headers = { Authorization: `Bearer ${f.env.CMS_BUILD_TOKEN}` }
  const response = await f.request(`/api/content/posts?revision=${revision}&section=blog`, { headers })
  const content = await response.json()
  assert.equal(content.revision, revision)
  assert.deepEqual(content.items, [f.post])
  assert.equal((await f.request('/api/content/posts?section=blog', { headers })).status, 400)
})

test('interrupted uploads cannot activate a snapshot or replace the working revision', async t => {
  const f = await fixture(t)
  const first = await f.start(); await f.upload(first); await f.commit(first); await f.drain()
  const second = await f.start(first)
  assert.equal((await f.commit(second)).status, 409)
  assert.equal((await (await f.request('/api/editor/status')).json()).revision, first)
})

test('chunk checksums, SQLite headers, file manifests and draft exclusion are enforced', async t => {
  const f = await fixture(t)
  const revision = await f.start()
  const invalid = f.database.slice(); invalid[100] = 1
  assert.equal((await f.request(`/api/editor/snapshots/${revision}/chunks/0`, { method: 'PUT', lease: f.lease, body: invalid })).status, 400)
  assert.equal((await f.request(`/api/editor/snapshots/${revision}/content/blog`, { method: 'PUT', lease: f.lease, body: { ...f.post, status: 'draft' } })).status, 400)
  assert.throws(() => validateManifest({ ...f.manifest, files: [{ path: 'uploads/../secret', hash: f.manifest.databaseHash, size: 1, kind: 'media' }] }, defineConfig(fixtureConfig('projects'))), /Unsafe/)
  assert.equal((await f.request(`/api/editor/snapshots/${revision}/chunks/0`)).status, 404)
})

test('an editing lease excludes other sessions and rejects stale writes', async t => {
  const f = await fixture(t)
  assert.equal((await f.request('/api/editor/lease', { method: 'POST', body: {} })).status, 409)
  assert.equal((await f.request('/api/editor/snapshots', { method: 'POST', lease: 'stale', body: {} })).status, 409)
  f.sqlite.exec('UPDATE cms_state SET lease_expires = 0')
  assert.equal((await f.request('/api/editor/lease', { method: 'PATCH', lease: f.lease })).status, 409)
})

test('refresh resumes the same owner lease immediately and invalidates the old document', async t => {
  const f = await fixture(t)
  const staging = await f.start()
  const response = await f.request('/api/editor/lease', { method: 'POST', lease: f.lease, body: {} })
  assert.equal(response.status, 200)
  const resumed = await response.json()
  assert.notEqual(resumed.token, f.lease)
  assert.equal(resumed.revision, null)
  assert.equal((await f.request('/api/editor/lease', { method: 'PATCH', lease: resumed.token })).status, 200)
  for (const method of ['PATCH', 'DELETE']) {
    assert.equal((await f.request('/api/editor/lease', { method, lease: f.lease })).status, 409)
  }
  assert.equal((await f.commit(staging)).status, 409)
  assert.equal((await f.request('/api/editor/lease', { method: 'POST', body: {} })).status, 409)
  assert.equal((await f.request('/api/editor/lease', { method: 'POST', lease: f.lease, body: {} })).status, 409)
  f.sqlite.prepare('UPDATE cms_state SET lease_owner = ?').run('another-editor')
  assert.equal((await f.request('/api/editor/lease', { method: 'POST', lease: resumed.token, body: {} })).status, 409)
})

test('a released lease can be reopened even with a stale tab token', async t => {
  const f = await fixture(t)
  assert.equal((await f.request('/api/editor/lease', { method: 'DELETE', lease: f.lease })).status, 200)
  const response = await f.request('/api/editor/lease', { method: 'POST', lease: 'stale-tab-token', body: {} })
  assert.equal(response.status, 200)
  assert.notEqual((await response.json()).token, f.lease)
})

test('lease expiry during commit rolls back the snapshot and active pointer atomically', async t => {
  const f = await fixture(t)
  const revision = await f.start(); await f.upload(revision)
  f.db.beforeBatch = () => { f.sqlite.exec('UPDATE cms_state SET lease_expires = 0'); f.db.beforeBatch = null }
  assert.equal((await f.commit(revision)).status, 409)
  assert.equal(f.sqlite.prepare('SELECT status FROM snapshots WHERE id = ?').get(revision)!.status, 'staging')
  assert.equal(f.sqlite.prepare('SELECT active_revision FROM cms_state').get()!.active_revision, null)
})

test('R2 file uploads are checked, reusable and private unless explicitly media', async t => {
  const f = await fixture(t)
  const bytes = new TextEncoder().encode('private plugin file')
  const hash = await sha256(bytes)
  const files: ManifestFile[] = [{ path: 'plugins/example/example.php', hash, size: bytes.length, kind: 'private' }]
  const revision = await f.start(null, { files })
  const endpoint = `/api/editor/snapshots/${revision}/files/0`
  assert.equal((await f.request(endpoint, { method: 'PUT', lease: f.lease, body: new Uint8Array([1]) })).status, 400)
  assert.equal((await f.request(endpoint, { method: 'PUT', lease: f.lease, body: bytes })).status, 200)
  assert.equal((await f.request(endpoint, { method: 'PUT', lease: f.lease, headers: { 'X-CMS-Reuse': 'true' } })).status, 200)
  assert.equal((await f.request(`/media/${hash}/example.php`)).status, 404)
  const restored = await f.request(`/api/editor/files/${hash}`)
  assert.deepEqual(new Uint8Array(await restored.arrayBuffer()), bytes)
})

test('production editor access cannot use the localhost bypass or a build token', async t => {
  const f = await fixture(t)
  assert.equal((await f.request('/api/editor/status', { origin: 'https://cms.example.com' })).status, 401)
  assert.equal((await f.request('/api/editor/status', { origin: 'https://cms.example.com', headers: { Authorization: `Bearer ${f.env.CMS_BUILD_TOKEN}` } })).status, 401)
  const request = new Request('http://localhost/api/editor/lease', { method: 'POST', headers: { Origin: 'https://attacker.example' } })
  assert.equal((await f.cms.fetch(request, f.env, { waitUntil() {} })).status, 403)
})

test('Access JWT signature, audience and expiration are verified', async t => {
  const f = await fixture(t)
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const jwk = { ...await exportJWK(publicKey), kid: 'cms-test-key', alg: 'RS256', use: 'sig' }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({ keys: [jwk] })
  t.after(() => { globalThis.fetch = originalFetch })
  const token = (audience: string, expires = '2m') => new SignJWT({ email: 'editor@example.test' }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer('https://example.cloudflareaccess.com').setAudience(audience).setIssuedAt().setExpirationTime(expires).sign(privateKey)
  const good = await token('test-audience')
  assert.equal((await f.request('/api/editor/status', { origin: 'https://cms.example.com', headers: { 'Cf-Access-Jwt-Assertion': good } })).status, 200)
  const wrongAudience = await token('other-audience')
  assert.equal((await f.request('/api/editor/status', { origin: 'https://cms.example.com', headers: { 'Cf-Access-Jwt-Assertion': wrongAudience } })).status, 401)
  const expired = await token('test-audience', '-1m')
  assert.equal((await f.request('/api/editor/status', { origin: 'https://cms.example.com', headers: { 'Cf-Access-Jwt-Assertion': expired } })).status, 401)
})

test('only published output changes schedule builds; failed build triggers can be retried', async t => {
  const f = await fixture(t)
  const originalFetch = globalThis.fetch
  let builds = 0
  t.after(() => { globalThis.fetch = originalFetch })
  Object.assign(f.env, { CF_ACCOUNT_ID: 'account', CF_WORKER_TAG: 'tag', CF_BUILD_API_TOKEN: 'token' })
  const cloudflare = (status: number) => async (url: string | URL | Request, options: RequestInit = {}) => {
    // eslint-disable-next-line camelcase -- Cloudflare API field names
    if (String(url).endsWith('/builds/workers/tag/triggers')) return Response.json({ result: [{ trigger_uuid: 'other', branch_includes: ['dev'] }, { trigger_uuid: 'trigger', branch_includes: ['master'] }] })
    assert.match(String(url), /\/builds\/triggers\/trigger\/builds$/)
    assert.equal(options.method, 'POST')
    builds++

    return new Response('', { status })
  }
  globalThis.fetch = cloudflare(200)
  const one = await f.start(); await f.upload(one); await f.commit(one); await f.drain()
  assert.equal(builds, 1)
  const two = await f.start(one); await f.upload(two); await f.commit(two); await f.drain()
  assert.equal(builds, 1, 'a full database checkpoint with identical published content should not rebuild')
  const three = await f.start(two); await f.upload(three, { ...f.post, content: { rendered: 'Updated content' } })
  globalThis.fetch = cloudflare(503)
  await f.commit(three); await f.drain()
  assert.equal(f.sqlite.prepare('SELECT build_status FROM snapshots WHERE id = ?').get(three)!.build_status, 'failed')
  globalThis.fetch = cloudflare(200)
  await f.request(`/api/editor/snapshots/${three}/retry-build`, { method: 'POST', body: {} }); await f.drain()
  assert.equal(f.sqlite.prepare('SELECT build_status FROM snapshots WHERE id = ?').get(three)!.build_status, 'sent')
  const four = await f.start(three, { counts: { blog: 0, projects: 0 } })
  await f.request(`/api/editor/snapshots/${four}/chunks/0`, { method: 'PUT', lease: f.lease, body: f.database })
  await f.commit(four); await f.drain()
  assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM snapshots WHERE status = \'complete\'').get()!.total, 3)
  assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM snapshot_chunks WHERE revision = ?').get(one)!.total, 0)
})

test('256 KiB chunking is deterministic at boundary sizes', async () => {
  const bytes = new Uint8Array(CHUNK_SIZE + 1)
  assert.equal(Math.ceil(bytes.length / CHUNK_SIZE), 2)
  assert.notEqual(await sha256(bytes.subarray(0, CHUNK_SIZE)), await sha256(bytes.subarray(CHUNK_SIZE)))
})

test('preview checkpoints restore but never queue, request or retry website builds', async t => {
  const f = await fixture(t)
  Object.assign(f.env, { CMS_TRIGGER_BUILDS: 'false', CF_ACCOUNT_ID: 'account', CF_WORKER_TAG: 'tag', CF_BUILD_API_TOKEN: 'token' })
  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async () => { requests++; throw new Error('Preview must not request website builds') }
  t.after(() => { globalThis.fetch = originalFetch })
  const revision = await f.start()
  await f.upload(revision)
  const committed = await f.commit(revision)
  assert.equal(committed.status, 200)
  assert.equal((await committed.json()).buildStatus, 'none')
  await f.drain()
  assert.deepEqual(new Uint8Array(await (await f.request(`/api/editor/snapshots/${revision}/chunks/0`)).arrayBuffer()), f.database)
  assert.equal((await (await f.request(`/api/editor/snapshots/${revision}/retry-build`, { method: 'POST', body: {} })).json()).queued, false)
  // Old failed rows cannot start builds after disabling the integration either.
  f.sqlite.prepare('UPDATE snapshots SET build_status = \'failed\' WHERE id = ?').run(revision)
  const tasks: Promise<unknown>[] = []
  await f.cms.scheduled({} as ScheduledController, f.env, { waitUntil(task) { tasks.push(task) } })
  await Promise.all(tasks)
  await f.drain()
  assert.equal(requests, 0)
})

test('snapshots taken before sections were configurable still validate and restore', () => {
  const config = defineConfig(fixtureConfig('projects'))
  const legacy = { version: 1, runtime: '3.1.60', php: '8.5', wordpress: '7.0.7', databaseSize: 1, databaseHash: 'a'.repeat(64), chunks: ['a'.repeat(64)], files: [], counts: { blog: 3, projects: 1 }, blogCategory: 'blog', projectsCategory: 'projects' }
  assert.equal(validateManifest(legacy, config), legacy)
  assert.throws(() => validateManifest({ ...legacy, projectsCategory: 'work' }, config), /Category mapping/)
})

test('configured sections replace blog and projects throughout the editor and feed', async t => {
  const f = await fixture(t, fixtureConfig('agency'))
  const counts = { blog: 0, legal: 1, portfolio: 0, testimonials: 1 }
  const sections = { blog: 'blog', legal: 'legal', portfolio: 'portfolio', testimonials: 'testimonials' }
  assert.equal((await f.request('/api/editor/snapshots', { method: 'POST', lease: f.lease, body: { baseRevision: null, manifest: f.manifest } })).status, 400, 'a manifest for another site is rejected')
  const revision = (await (await f.request('/api/editor/snapshots', { method: 'POST', lease: f.lease, body: { baseRevision: null, manifest: { ...f.manifest, counts, sections } } })).json()).revision
  assert.equal((await f.request(`/api/editor/snapshots/${revision}/chunks/0`, { method: 'PUT', lease: f.lease, body: f.database })).status, 200)
  assert.equal((await f.request(`/api/editor/snapshots/${revision}/content/projects`, { method: 'PUT', lease: f.lease, body: { ...f.post, section: 'projects' } })).status, 404)
  for (const section of ['legal', 'testimonials']) {
    const record = { ...f.post, section, slug: `${section}-one`, modified: '2026-10-23T09:00:00', tags: ['Vue'], author: 'Editor' }
    assert.equal((await f.request(`/api/editor/snapshots/${revision}/content/${section}`, { method: 'PUT', lease: f.lease, body: record })).status, 200)
  }
  assert.equal((await f.commit(revision)).status, 200)
  await f.drain()
  const headers = { Authorization: `Bearer ${f.env.CMS_BUILD_TOKEN}` }
  const manifest: { counts: Record<string, number>, sections: Section[] } = await (await f.request('/api/content/manifest', { headers })).json()
  assert.deepEqual(manifest.counts, counts)
  assert.deepEqual(manifest.sections.map(section => [section.name, section.path]), [['blog', '/blog/'], ['legal', '/legal/'], ['portfolio', null], ['testimonials', null]])
  const feed: { items: ContentRecord[] } = await (await f.request(`/api/content/posts?revision=${revision}&section=testimonials`, { headers })).json()
  assert.deepEqual(feed.items.map(item => [item.slug, item.author, item.tags]), [['testimonials-one', 'Editor', ['Vue']]])
  assert.equal((await f.request(`/api/content/posts?revision=${revision}&section=projects`, { headers })).status, 400)
})

test('site configuration is validated before the Worker starts', () => {
  assert.throws(() => defineConfig({ ...fixtureConfig('projects'), id: 'Has Spaces' }), /id/)
  assert.throws(() => defineConfig({ ...fixtureConfig('projects'), sections: [{ name: 'blog' }, { name: 'blog' }] }), /duplicate/)
  assert.throws(() => defineConfig({ ...fixtureConfig('projects'), sections: [{ name: 'blog', path: 'blog' }] }), /path/)
  assert.equal(defineConfig(fixtureConfig('projects')).sections[0].category, 'blog')
})

test('snapshots open on the same or a newer WordPress, never an older one', async () => {
  const { compareVersions, canOpenSnapshot } = await import('../src/shared.ts')
  assert.equal(compareVersions('7.0.7', '7.0.8'), -1)
  assert.equal(compareVersions('7.0', '7.0.0'), 0)
  assert.equal(compareVersions('7.10', '7.9.9'), 1)
  assert.equal(canOpenSnapshot('7.0.7', '7.0.8'), true)
  assert.equal(canOpenSnapshot('6.8.3', '7.0.7'), true)
  assert.equal(canOpenSnapshot('7.0.7', '7.0.7'), true)
  assert.equal(canOpenSnapshot('7.1', '7.0.7'), false)
})

test('manifests from any Playground build and supported PHP validate; other PHP versions do not', () => {
  const config = defineConfig(fixtureConfig('projects'))
  const base = { version: 1, wordpress: '7.0.7', databaseSize: 1, databaseHash: 'a'.repeat(64), chunks: ['a'.repeat(64)], files: [], counts: { blog: 0, projects: 0 }, sections: { blog: 'blog', projects: 'projects' } }
  for (const [runtime, php] of [['3.1.60', '8.3'], ['3.2.4', '8.5'], ['3.2.4', '8.4']]) validateManifest({ ...base, runtime, php }, config)
  assert.throws(() => validateManifest({ ...base, runtime: '3.2.4', php: '7.4' }, config), /Unsupported runtime/)
  assert.throws(() => validateManifest({ ...base, runtime: 'latest', php: '8.5' }, config), /Unsupported runtime/)
})
