import { DatabaseSync } from 'node:sqlite'
import type { SQLInputValue } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { createCms } from '../src/worker.ts'
import type { CmsEnv } from '../src/worker.ts'
import type { SiteConfigInput } from '../src/config.ts'

type Row = Record<string, unknown> | null

// The parts of D1 and R2 the Worker uses, backed by node:sqlite and a Map.
interface FakeStatement {
  bind(...values: unknown[]): FakeStatement
  execute(): Row[]
  first(): Promise<Row>
  all(): Promise<{ results: Row[] }>
  run(): Promise<{ success: boolean }>
}

interface TestRequestOptions extends Omit<RequestInit, 'body'> {
  lease?: string
  body?: Uint8Array<ArrayBuffer> | object
  origin?: string
}

export const fixtureConfig = (name: string): SiteConfigInput => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'))

export function environment(config = fixtureConfig('projects')) {
  const cms = createCms(config)
  const sqlite = new DatabaseSync(':memory:')
  for (const migration of ['0001_cms.sql', '0002_configurable_sections.sql']) sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'))
  const convert = (row: Record<string, unknown> | undefined): Row => row ? Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Uint8Array ? Array.from(value) : value])) : null
  const db = {
    beforeBatch: undefined as (() => void) | null | undefined,
    prepare(sql: string) {
      let params: SQLInputValue[] = []
      const result: FakeStatement = {
        bind(...values) {
          params = values.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value) as SQLInputValue[]

          return result
        },
        execute() { return sqlite.prepare(sql).all(...params).map(convert) },
        async first() { return result.execute()[0] || null },
        async all() { return { results: result.execute() } },
        async run() {
          result.execute()

          return { success: true }
        }
      }

      return result
    },
    async batch(statements: FakeStatement[]) {
      db.beforeBatch?.()
      sqlite.exec('BEGIN IMMEDIATE')
      try {
        const results = statements.map(statement => ({ results: statement.execute() }))
        sqlite.exec('COMMIT')

        return results
      } catch (error) { sqlite.exec('ROLLBACK'); throw error }
    }
  }
  const objects = new Map<string, { bytes: Uint8Array, options: unknown }>()
  const env = {
    DB: db, LOCAL_DEV: 'true',
    ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com', ACCESS_AUD: 'test-audience',
    CMS_BUILD_TOKEN: 'a-test-build-token-with-at-least-32-characters',
    FILES: {
      async put(key: string, data: Uint8Array, options: unknown) { objects.set(key, { bytes: new Uint8Array(data), options }) },
      async head(key: string) { return objects.has(key) ? { size: objects.get(key)!.bytes.length } : null },
      async get(key: string) {
        const object = objects.get(key)

        return object ? { body: object.bytes, size: object.bytes.length, httpEtag: '"test"' } : null
      }
    },
    ASSETS: { async fetch() { return new Response('Missing asset', { status: 404 }) } }
  } as unknown as CmsEnv
  const tasks: Promise<unknown>[] = []
  const ctx = { waitUntil(task: Promise<unknown>) { tasks.push(task) } }
  const request = (path: string, options: TestRequestOptions = {}) => {
    const { lease, body, origin = 'http://localhost', ...rest } = options
    const headers = new Headers(rest.headers)
    if (lease) headers.set('X-CMS-Lease', lease)
    if (rest.method && rest.method !== 'GET') headers.set('Origin', origin)
    if (body && !(body instanceof Uint8Array)) headers.set('Content-Type', 'application/json')

    return cms.fetch(new Request(new URL(path, origin), { ...rest, headers, body: body instanceof Uint8Array ? body : body ? JSON.stringify(body) : undefined }), env, ctx)
  }

  return { cms, env, db, sqlite, objects, request, async drain() { while (tasks.length) await tasks.shift() }, close() { sqlite.close() } }
}
