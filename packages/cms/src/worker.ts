import type { D1Database, D1PreparedStatement, ExecutionContext, Fetcher, R2Bucket, Headers as WorkersHeaders, R2ObjectBody, Request as WorkersRequest, ScheduledController } from '@cloudflare/workers-types'
import { editorIdentity, buildIdentity, sameOrigin } from './auth.ts'
import { assert, CHUNK_SIZE, REVISION, sha256, validateManifest, validateRecord, feedHash, isHttpError } from './shared.ts'
import type { ContentRecord, Manifest } from './shared.ts'
import { defineConfig, sectionNames } from './config.ts'
import type { SiteConfig, SiteConfigInput } from './config.ts'

// The site Worker's bindings, vars and secrets (wrangler.jsonc and `wrangler secret put`).
/* eslint-disable @typescript-eslint/naming-convention -- binding and variable names */
export interface CmsEnv {
  DB: D1Database
  FILES: R2Bucket
  ASSETS: Fetcher
  LOCAL_DEV?: string
  ACCESS_TEAM_DOMAIN?: string
  ACCESS_AUD?: string
  CMS_BUILD_TOKEN?: string
  CMS_TRIGGER_BUILDS?: string
  CF_ACCOUNT_ID?: string
  CF_BUILD_API_TOKEN?: string
  CF_BUILD_TRIGGER_ID?: string
  CF_WORKER_TAG?: string
  SITE_BRANCH?: string
}

// D1 rows, named after their columns (migrations/).
interface CmsState {
  active_revision: string | null
  lease_token: string | null
  lease_owner: string | null
  lease_expires: number
}

interface SnapshotRow {
  id: string
  base_revision: string | null
  lease_token: string
  status: 'staging' | 'complete'
  created_at: number
  committed_at: number | null
  manifest: string
  feed_hash: string | null
  build_status: string
  build_error: string | null
}

interface FileObjectRow {
  checksum: string
  size: number
  media: number
  content_type: string
}
/* eslint-enable @typescript-eslint/naming-convention */

export type BuildStatus = 'none' | 'pending' | 'sent' | 'failed' | 'superseded'
type WaitUntil = Pick<ExecutionContext, 'waitUntil'>

export interface Cms {
  fetch(request: Request, env: CmsEnv, ctx: WaitUntil): Promise<Response>
  scheduled(controller: ScheduledController, env: CmsEnv, ctx: WaitUntil): Promise<void>
}

// R2 bodies and the ASSETS binding are typed with Workers' own fetch classes. They are the same runtime objects
// as the standard Request, Response and ReadableStream this module is typed with.
const stream = (body: R2ObjectBody['body']) => body as unknown as ReadableStream<Uint8Array>
const conditions = (request: Request) => request.headers as unknown as WorkersHeaders
const assets = (env: CmsEnv, request: Request) => env.ASSETS.fetch(request as unknown as WorkersRequest) as unknown as Promise<Response>

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
const now = () => Math.floor(Date.now() / 1000)
const statement = (env: CmsEnv, sql: string, ...values: unknown[]) => env.DB.prepare(sql).bind(...values)
// The first migration inserts the single state row.
const state = (env: CmsEnv) => env.DB.prepare('SELECT * FROM cms_state WHERE id = 1').first<CmsState>() as Promise<CmsState>

function guard(env: CmsEnv, token: string, base: string | null) {
  return statement(env, `INSERT INTO commit_assertion(ok) SELECT CASE WHEN EXISTS (
    SELECT 1 FROM cms_state WHERE id = 1 AND lease_token = ? AND lease_expires > ? AND active_revision IS ?
  ) THEN 1 ELSE 0 END`, token, now(), base)
}

async function guardedBatch(env: CmsEnv, token: string, base: string | null, statements: D1PreparedStatement[]) {
  try {
    return await env.DB.batch([guard(env, token, base), ...statements, env.DB.prepare('DELETE FROM commit_assertion')])
  } catch (error) {
    if (error instanceof Error && /CHECK constraint|commit_assertion/.test(error.message)) throw Object.assign(new Error('Editing lease expired or the cloud revision changed. Recover your local work before reopening.'), { status: 409 })
    throw error
  }
}

async function requireLease(request: Request, env: CmsEnv, owner: string) {
  const token = request.headers.get('X-CMS-Lease')
  const current = await state(env)
  assert(token && token === current.lease_token && current.lease_owner === owner && current.lease_expires > now(), 'This editing session has expired or another device is editing', 409)

  return { token, current }
}

async function staging(request: Request, env: CmsEnv, owner: string, revision: string) {
  assert(REVISION.test(revision), 'Invalid revision')
  const lease = await requireLease(request, env, owner)
  const snapshot = await statement(env, 'SELECT * FROM snapshots WHERE id = ?', revision).first<SnapshotRow>()
  assert(snapshot && snapshot.status === 'staging' && snapshot.lease_token === lease.token, 'Unknown staging revision', 404)
  assert(snapshot.base_revision === lease.current.active_revision, 'Cloud revision changed', 409)

  return { ...lease, snapshot, manifest: JSON.parse(snapshot.manifest) as Manifest }
}

// The parsed body is validated by the caller.
async function bodyJson<T>(request: Request, max = 1800000): Promise<T> {
  const reader = request.body?.getReader()
  assert(reader, 'Request body required')
  const chunks: Uint8Array[] = []
  let length = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    length += value.length
    assert(length <= max, 'Request body too large', 413)
    chunks.push(value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  try { return JSON.parse(new TextDecoder().decode(bytes)) }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }) }
}

async function binaryBody(request: Request, limit: number) {
  const reader = request.body?.getReader()
  assert(reader, 'Request body required')
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.length
    assert(size <= limit, 'Upload exceeds allowed size', 413)
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }

  return bytes
}

// A pasted secret can carry a trailing newline, which makes fetch reject the Authorization header.
const apiToken = (env: CmsEnv) => String(env.CF_BUILD_API_TOKEN).trim()

/* eslint-disable @typescript-eslint/naming-convention -- Cloudflare API field names */
interface BuildTrigger {
  trigger_uuid?: string
  branch_includes?: unknown
}
/* eslint-enable @typescript-eslint/naming-convention */

async function buildTriggerId(env: CmsEnv): Promise<string> {
  if (env.CF_BUILD_TRIGGER_ID) return env.CF_BUILD_TRIGGER_ID
  assert(env.CF_WORKER_TAG, 'Cloudflare build trigger is not configured', 503)
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(String(env.CF_ACCOUNT_ID))}/builds/workers/${encodeURIComponent(env.CF_WORKER_TAG)}/triggers`
  const response = await fetch(url, { headers: { Authorization: `Bearer ${apiToken(env)}` }, signal: AbortSignal.timeout(20000), redirect: 'manual' })
  assert(response.ok, `Cloudflare returned HTTP ${response.status} listing build triggers`, 502)
  const { result } = await response.json() as { result?: unknown }
  const branch = env.SITE_BRANCH || 'master'
  const triggers: BuildTrigger[] = Array.isArray(result) ? result : []
  const trigger = triggers.find(item => Array.isArray(item.branch_includes) && item.branch_includes.includes(branch)) || triggers[0]
  assert(trigger?.trigger_uuid, 'No Workers Builds trigger found for the site Worker', 502)

  return trigger.trigger_uuid
}

export async function triggerBuild(env: CmsEnv, revision: string): Promise<void> {
  if (env.CMS_TRIGGER_BUILDS === 'false') return
  const claim = crypto.randomUUID()
  const claimed = await statement(env, `UPDATE snapshots SET build_claim = ?, build_claim_expires = ?, build_attempts = build_attempts + 1
    WHERE id = ? AND status = 'complete' AND build_status IN ('pending', 'failed') AND build_claim_expires < ? RETURNING id`, claim, now() + 120, revision, now()).first()
  if (!claimed) return
  try {
    assert(env.CF_ACCOUNT_ID && env.CF_BUILD_API_TOKEN, 'Cloudflare build trigger is not configured', 503)
    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CF_ACCOUNT_ID)}/builds/triggers/${encodeURIComponent(await buildTriggerId(env))}/builds`
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken(env)}` }, body: JSON.stringify({ branch: env.SITE_BRANCH || 'master' }), signal: AbortSignal.timeout(20000), redirect: 'manual' })
    assert(response.ok, `Cloudflare returned HTTP ${response.status}`, 502)
    await statement(env, 'UPDATE snapshots SET build_status = \'sent\', build_error = NULL, build_claim_expires = 0 WHERE id = ? AND build_claim = ? AND build_status IN (\'pending\', \'failed\')', revision, claim).run()
  } catch (error) {
    // Never persist/log credentials from a network error.
    const message = isHttpError(error) ? error.message : `Cloudflare build request failed (${(error as Error).name}); retry is available`
    await statement(env, 'UPDATE snapshots SET build_status = \'failed\', build_error = ?, build_claim_expires = 0 WHERE id = ? AND build_claim = ? AND build_status IN (\'pending\', \'failed\')', message, revision, claim).run()
  }
}

async function cleanup(env: CmsEnv) {
  // FK cascading removes chunks, file manifests and feed rows together. R2 content-addressed
  // files are deliberately retained so deployed pages and unsynced recovery files keep working.
  await env.DB.batch([
    statement(env, 'DELETE FROM snapshots WHERE status = \'staging\' AND created_at < ? AND lease_token IS NOT (SELECT lease_token FROM cms_state WHERE id = 1)', now() - 86400),
    env.DB.prepare(`DELETE FROM snapshots WHERE status = 'complete' AND id NOT IN (
      SELECT id FROM snapshots WHERE status = 'complete' ORDER BY committed_at DESC, rowid DESC LIMIT 3
    ) AND id IS NOT (SELECT active_revision FROM cms_state WHERE id = 1)`)
  ])
}

async function editorRoute(request: Request, env: CmsEnv, ctx: WaitUntil, owner: string, path: string, config: SiteConfig) {
  sameOrigin(request)
  if (path === '/api/editor/status' && request.method === 'GET') {
    const current = await state(env)
    const snapshot = current.active_revision ? await statement(env, 'SELECT id, manifest, committed_at, build_status, build_error FROM snapshots WHERE id = ?', current.active_revision).first<SnapshotRow>() : null

    return json({ revision: current.active_revision, snapshot: snapshot && { ...snapshot, manifest: JSON.parse(snapshot.manifest) }, locked: current.lease_expires > now(), owner: current.lease_expires > now() ? current.lease_owner : null, config })
  }
  if (path === '/api/editor/lease' && request.method === 'POST') {
    const resume = request.headers.get('X-CMS-Lease')
    const token = crypto.randomUUID()
    // A tab retains its secret across reloads. Rotate it atomically on resumption so
    // requests from the previous document can neither write nor release the new lease.
    const acquired = await statement(env, `UPDATE cms_state SET lease_token = ?, lease_owner = ?, lease_expires = ?
      WHERE id = 1 AND (lease_expires <= ? OR (lease_token = ? AND lease_owner = ?)) RETURNING active_revision`, token, owner, now() + 120, now(), resume, owner).first<Pick<CmsState, 'active_revision'>>()
    assert(acquired, 'Another editing session is open. Close it or wait two minutes for its lease to expire.', 409)

    return json({ token, revision: acquired.active_revision, expires: now() + 120 })
  }
  if (path === '/api/editor/lease' && ['PATCH', 'DELETE'].includes(request.method)) {
    const { token } = await requireLease(request, env, owner)
    const expires = request.method === 'DELETE' ? 0 : now() + 120
    const renewed = await statement(env, 'UPDATE cms_state SET lease_expires = ? WHERE id = 1 AND lease_token = ? AND lease_expires > ? RETURNING id', expires, token, now()).first()
    assert(renewed, 'Lease expired', 409)

    return json({ expires })
  }
  if (path === '/api/editor/snapshots' && request.method === 'POST') {
    const { token, current } = await requireLease(request, env, owner)
    const body = await bodyJson<{ baseRevision?: unknown, manifest: Manifest }>(request, 12000000)
    assert(body.baseRevision === current.active_revision, 'Cloud revision changed', 409)
    const manifest = validateManifest(body.manifest, config)
    const id = crypto.randomUUID()
    await guardedBatch(env, token, current.active_revision, [
      statement(env, 'INSERT INTO snapshots (id, base_revision, lease_token, status, created_at, manifest) VALUES (?, ?, ?, \'staging\', ?, ?)', id, current.active_revision, token, now(), JSON.stringify(manifest)),
      statement(env, `INSERT INTO snapshot_files(revision, path, checksum, size, kind)
        SELECT ?, json_extract(f.value, '$.path'), o.checksum, o.size, json_extract(f.value, '$.kind')
        FROM snapshots s, json_each(s.manifest, '$.files') f
        JOIN file_objects o ON o.checksum = json_extract(f.value, '$.hash') AND o.size = json_extract(f.value, '$.size')
        WHERE s.id = ? AND (json_extract(f.value, '$.kind') = 'private' OR o.media = 1)`, id, id)
    ])
    const { results: present } = await statement(env, 'SELECT path FROM snapshot_files WHERE revision = ?', id).all<{ path: string }>()
    const knownPaths = new Set(present.map(file => file.path))

    return json({ revision: id, missingFiles: manifest.files.map((file, index) => knownPaths.has(file.path) ? null : index).filter(index => index !== null) }, 201)
  }
  const chunkMatch = path.match(/^\/api\/editor\/snapshots\/([^/]+)\/chunks\/(\d+)$/)
  if (chunkMatch) {
    const [, revision, positionString] = chunkMatch
    const position = Number(positionString)
    if (request.method === 'PUT') {
      const { token, snapshot, manifest } = await staging(request, env, owner, revision)
      assert(Number.isSafeInteger(position) && position >= 0 && position < manifest.chunks.length, 'Invalid chunk position')
      const bytes = await binaryBody(request, CHUNK_SIZE)
      const expectedLength = Math.min(CHUNK_SIZE, manifest.databaseSize - position * CHUNK_SIZE)
      assert(bytes.length === expectedLength && await sha256(bytes) === manifest.chunks[position], 'Database chunk checksum or size mismatch')
      if (position === 0) assert(new TextDecoder().decode(bytes.subarray(0, 16)) === 'SQLite format 3\0', 'Not a SQLite database')
      await guardedBatch(env, token, snapshot.base_revision, [statement(env, 'INSERT OR REPLACE INTO snapshot_chunks (revision, position, checksum, data) VALUES (?, ?, ?, ?)', revision, position, manifest.chunks[position], bytes)])

      return json({ ok: true })
    }
    if (request.method === 'GET') {
      const row = await statement(env, 'SELECT c.data FROM snapshot_chunks c JOIN snapshots s ON s.id = c.revision WHERE c.revision = ? AND c.position = ? AND s.status = \'complete\'', revision, position).first<{ data: ArrayLike<number> }>()
      assert(row, 'Snapshot chunk not found', 404)

      return new Response(new Uint8Array(row.data), { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' } })
    }
  }
  const filesMatch = path.match(/^\/api\/editor\/snapshots\/([^/]+)\/files\/(\d+)$/)
  if (filesMatch && request.method === 'PUT') {
    const [, revision, index] = filesMatch
    const { token, snapshot, manifest } = await staging(request, env, owner, revision)
    const file = manifest.files[Number(index)]
    assert(file, 'Unknown file')
    const key = `files/${file.hash}`
    const known = await statement(env, 'SELECT size, media FROM file_objects WHERE checksum = ?', file.hash).first<Pick<FileObjectRow, 'size' | 'media'>>()
    const contentType = request.headers.get('Content-Type') || 'application/octet-stream'
    if (request.headers.get('X-CMS-Reuse') === 'true') {
      if (known?.size !== file.size || !await env.FILES.head(key)) return json({ needsUpload: true })
    } else {
      const bytes = await binaryBody(request, 50 * 1024 * 1024)
      assert(bytes.length === file.size && await sha256(bytes) === file.hash, 'File checksum or size mismatch')
      // R2 objects are immutable by content hash. Authorization is checked again in the SQL batch.
      await env.FILES.put(key, bytes, { httpMetadata: { contentType } })
    }
    await guardedBatch(env, token, snapshot.base_revision, [
      statement(env, `INSERT INTO file_objects(checksum, size, media, content_type) VALUES (?, ?, ?, ?)
        ON CONFLICT(checksum) DO UPDATE SET media = MAX(file_objects.media, excluded.media)`, file.hash, file.size, file.kind === 'media' ? 1 : 0, contentType),
      statement(env, 'INSERT OR REPLACE INTO snapshot_files (revision, path, checksum, size, kind) VALUES (?, ?, ?, ?, ?)', revision, file.path, file.hash, file.size, file.kind)
    ])

    return json({ ok: true })
  }
  const objectMatch = path.match(/^\/api\/editor\/files\/([a-f0-9]{64})$/)
  if (objectMatch && request.method === 'GET') {
    const object = await env.FILES.get(`files/${objectMatch[1]}`)
    assert(object, 'File not found', 404)

    return new Response(stream(object.body), { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' } })
  }
  const contentMatch = path.match(/^\/api\/editor\/snapshots\/([^/]+)\/content\/([a-z0-9-]+)$/)
  if (contentMatch && request.method === 'PUT') {
    const [, revision, section] = contentMatch
    assert(sectionNames(config).includes(section), 'Unknown content section', 404)
    const { token, snapshot } = await staging(request, env, owner, revision)
    const record = await bodyJson<ContentRecord>(request)
    validateRecord(record, section)
    // A rendered feed cannot reference temporary Playground URLs or unpublished file endpoints.
    assert(!/https?:\/\/[^\s"'<>]*\/scope:[^\s"'<>]*/.test(JSON.stringify(record)), 'Content contains temporary Playground URLs; migrate media and internal links first')
    await guardedBatch(env, token, snapshot.base_revision, [statement(env, 'INSERT OR REPLACE INTO content_records(revision, section, slug, date, payload) VALUES (?, ?, ?, ?, ?)', revision, section, record.slug, record.date, JSON.stringify(record))])

    return json({ ok: true })
  }
  const commitMatch = path.match(/^\/api\/editor\/snapshots\/([^/]+)\/commit$/)
  if (commitMatch && request.method === 'POST') {
    const revision = commitMatch[1]
    const { token, snapshot, manifest } = await staging(request, env, owner, revision)
    const contentSize = await statement(env, 'SELECT COALESCE(SUM(length(CAST(payload AS BLOB))), 0) AS size FROM content_records WHERE revision = ?', revision).first<{ size: number }>()
    assert(contentSize && contentSize.size <= 24 * 1024 * 1024, 'Rendered feed exceeds the 24 MiB checkpoint limit', 413)
    const [{ results: chunks }, { results: files }, { results: rows }] = await Promise.all([
      statement(env, 'SELECT position, checksum, length(data) AS size FROM snapshot_chunks WHERE revision = ? ORDER BY position', revision).all<{ position: number, checksum: string, size: number }>(),
      statement(env, 'SELECT path, checksum, size, kind FROM snapshot_files WHERE revision = ?', revision).all<{ path: string, checksum: string, size: number, kind: string }>(),
      statement(env, 'SELECT section, payload FROM content_records WHERE revision = ? ORDER BY section, slug', revision).all<{ section: string, payload: string }>()
    ])
    assert(chunks.length === manifest.chunks.length && chunks.every((chunk, i) => chunk.position === i && chunk.checksum === manifest.chunks[i] && chunk.size === Math.min(CHUNK_SIZE, manifest.databaseSize - i * CHUNK_SIZE)), 'Snapshot database is incomplete', 409)
    const fileMap = new Map(files.map(file => [file.path, file]))
    assert(files.length === manifest.files.length && manifest.files.every(file => {
      const row = fileMap.get(file.path)

      return row && row.checksum === file.hash && row.size === file.size && row.kind === file.kind
    }), 'Snapshot files are incomplete', 409)
    assert(sectionNames(config).every(section => rows.filter(row => row.section === section).length === manifest.counts[section]) && rows.every(row => Object.hasOwn(manifest.counts, row.section)), 'Published feed is incomplete', 409)
    const hash = await feedHash(rows.map(row => JSON.parse(row.payload) as ContentRecord))
    const previous = snapshot.base_revision ? await statement(env, 'SELECT feed_hash, build_status, build_error FROM snapshots WHERE id = ?', snapshot.base_revision).first<Pick<SnapshotRow, 'feed_hash' | 'build_status' | 'build_error'>>() : null
    const changed = previous?.feed_hash !== hash
    const buildStatus = env.CMS_TRIGGER_BUILDS === 'false' ? 'none' : changed ? 'pending' : previous && ['pending', 'failed'].includes(previous.build_status) ? previous.build_status : 'none'
    await guardedBatch(env, token, snapshot.base_revision, [
      statement(env, 'UPDATE snapshots SET build_status = \'superseded\' WHERE status = \'complete\' AND build_status IN (\'pending\', \'failed\')'),
      statement(env, 'UPDATE snapshots SET status = \'complete\', committed_at = ?, feed_hash = ?, build_status = ?, build_error = ? WHERE id = ? AND status = \'staging\'', now(), hash, buildStatus, changed ? null : previous?.build_error || null, revision),
      statement(env, 'UPDATE cms_state SET active_revision = ? WHERE id = 1', revision)
    ])
    ctx.waitUntil((async () => { if (changed && env.CMS_TRIGGER_BUILDS !== 'false') await triggerBuild(env, revision); await cleanup(env) })())

    return json({ revision, committedAt: now(), buildStatus })
  }
  const retryMatch = path.match(/^\/api\/editor\/snapshots\/([^/]+)\/retry-build$/)
  if (retryMatch && request.method === 'POST') {
    assert(REVISION.test(retryMatch[1]), 'Invalid revision')
    if (env.CMS_TRIGGER_BUILDS === 'false') return json({ queued: false })
    ctx.waitUntil(triggerBuild(env, retryMatch[1]))

    return json({ queued: true })
  }
  if (path === '/api/editor/snapshots' && request.method === 'GET') {
    const { results } = await env.DB.prepare('SELECT id, committed_at, manifest, build_status, build_error FROM snapshots WHERE status = \'complete\' ORDER BY committed_at DESC, rowid DESC LIMIT 3').all<SnapshotRow>()

    return json(results.map(row => ({ ...row, manifest: JSON.parse(row.manifest) })))
  }

  return json({ error: 'Editor endpoint not found' }, 404)
}

async function feedRoute(request: Request, env: CmsEnv, path: string, config: SiteConfig) {
  await buildIdentity(request, env)
  assert(request.method === 'GET', 'Read-only feed', 405)
  if (path === '/api/content/manifest') {
    const current = await state(env)
    assert(current.active_revision, 'No committed CMS snapshot', 503)
    // Cleanup never removes the active snapshot.
    const snapshot = await statement(env, 'SELECT manifest FROM snapshots WHERE id = ?', current.active_revision).first<Pick<SnapshotRow, 'manifest'>>() as Pick<SnapshotRow, 'manifest'>

    return json({ revision: current.active_revision, counts: (JSON.parse(snapshot.manifest) as Manifest).counts, sections: config.sections })
  }
  if (path === '/api/content/posts') {
    const url = new URL(request.url)
    const revision = url.searchParams.get('revision'), section = url.searchParams.get('section')
    const page = Number(url.searchParams.get('page') || 1), perPage = Number(url.searchParams.get('per_page') || 10)
    assert(revision !== null && REVISION.test(revision) && section !== null && sectionNames(config).includes(section), 'Specify a revision and section')
    assert(Number.isSafeInteger(page) && page >= 1 && Number.isSafeInteger(perPage) && perPage >= 1 && perPage <= 100, 'Invalid pagination')
    const snapshot = await statement(env, 'SELECT manifest FROM snapshots WHERE id = ? AND status = \'complete\'', revision).first<Pick<SnapshotRow, 'manifest'>>()
    assert(snapshot, 'This content revision has expired; restart the build', 410)
    const total = (JSON.parse(snapshot.manifest) as Manifest).counts[section]
    assert(Number.isSafeInteger(total), 'This content revision predates the section; restart the build', 410)
    assert(page <= Math.max(1, Math.ceil(total / perPage)), 'Page out of range', 404)
    const { results } = await statement(env, 'SELECT payload FROM content_records WHERE revision = ? AND section = ? ORDER BY date DESC, slug ASC LIMIT ? OFFSET ?', revision, section, perPage, (page - 1) * perPage).all<{ payload: string }>()

    return json({ revision, total, totalPages: Math.ceil(total / perPage), items: results.map(row => JSON.parse(row.payload) as ContentRecord) })
  }

  return json({ error: 'Feed endpoint not found' }, 404)
}

async function mediaRoute(request: Request, env: CmsEnv, path: string) {
  assert(['GET', 'HEAD'].includes(request.method), 'Read-only media', 405)
  const match = path.match(/^\/media\/([a-f0-9]{64})\/[^/]+$/)
  assert(match, 'Media not found', 404)
  const metadata = await statement(env, 'SELECT * FROM file_objects WHERE checksum = ? AND media = 1', match[1]).first<FileObjectRow>()
  assert(metadata, 'Media not found', 404)
  const object = await env.FILES.get(`files/${match[1]}`, { range: conditions(request), onlyIf: conditions(request) })
  assert(object, 'Media not found', 404)
  const inline = /^(image\/(png|jpeg|gif|webp|avif)|video\/(mp4|webm|ogg)|audio\/[a-z0-9.+-]+)$/.test(metadata.content_type)
  const headers = new Headers({
    'Content-Type': inline ? metadata.content_type : 'application/octet-stream',
    'Cache-Control': 'public, max-age=31536000, immutable',
    ETag: object.httpEtag,
    'Content-Security-Policy': 'default-src \'none\'; sandbox',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes'
  })
  if (!inline) headers.set('Content-Disposition', 'attachment')
  let status = 200
  if (!('body' in object)) return new Response(null, { status: 304, headers })
  if (object.range) {
    // R2 reports the range it served as an offset and length.
    const range = object.range as { offset: number, length: number }
    headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`)
    headers.set('Content-Length', String(range.length))
    status = 206
  } else headers.set('Content-Length', String(object.size))

  return new Response(request.method === 'HEAD' ? null : stream(object.body), { status, headers })
}

export async function handleRequest(request: Request, env: CmsEnv, ctx: WaitUntil, config: SiteConfig): Promise<Response> {
  try {
    const path = new URL(request.url).pathname
    if (path.startsWith('/media/')) return await mediaRoute(request, env, path)
    if (path.startsWith('/api/content/')) return await feedRoute(request, env, path, config)
    const owner = await editorIdentity(request, env)
    if (path.startsWith('/api/editor/')) return await editorRoute(request, env, ctx, owner, path, config)
    assert(['GET', 'HEAD'].includes(request.method), 'Method not allowed', 405)
    const assetUrl = new URL(request.url)
    if (path === '/') assetUrl.pathname = '/index.html'
    let response = await assets(env, new Request(assetUrl, request))
    if (response.status === 404) {
      const mapping = await assets(env, new Request(new URL('/runtime-objects.json', request.url)))
      const objects: Record<string, { hash: string, type: string }> = mapping.ok ? await mapping.json() : {}
      if (objects[path]) {
        const object = await env.FILES.get(`runtime/${objects[path].hash}`)
        assert(object, 'Runtime assets are not uploaded. Run pnpm run runtime:upload.', 503)
        response = new Response(request.method === 'HEAD' ? null : stream(object.body), { headers: { 'Content-Type': objects[path].type } })
      }
    }
    const headers = new Headers(response.headers)
    // Access-protected runtime assets must never be cached by a shared intermediary.
    headers.set('Cache-Control', 'private, no-cache')
    headers.set('X-Frame-Options', 'SAMEORIGIN')
    headers.set('Referrer-Policy', 'same-origin')
    headers.set('X-Content-Type-Options', 'nosniff')
    headers.set('Service-Worker-Allowed', '/')

    return new Response(response.body, { status: response.status, headers })
  } catch (error) {
    // eslint-disable-next-line no-console -- Worker logs
    if (!isHttpError(error)) console.error('CMS request failed', (error as Error).name)

    return isHttpError(error) ? json({ error: error.message }, error.status) : json({ error: 'CMS storage request failed' }, 500)
  }
}

async function scheduled(_controller: ScheduledController, env: CmsEnv, ctx: WaitUntil): Promise<void> {
  ctx.waitUntil((async () => {
    const { results } = await env.DB.prepare('SELECT id FROM snapshots WHERE status = \'complete\' AND build_status IN (\'pending\', \'failed\') ORDER BY committed_at LIMIT 5').all<{ id: string }>()
    for (const row of results) await triggerBuild(env, row.id)
    await cleanup(env)
  })())
}

// The site's Worker entry: `export default createCms(config)`, with the same cms.config.json the editor is built from.
export function createCms(siteConfig: SiteConfigInput): Cms {
  const config = defineConfig(siteConfig)

  return { fetch: (request, env, ctx) => handleRequest(request, env, ctx, config), scheduled }
}
