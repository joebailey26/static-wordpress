import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '../src/config.ts'
import type { SiteConfig } from '../src/config.ts'

// The package holds the editor, Worker, WordPress bridge and runtime pin. Everything a site owns or generates
// (cms.config.json, wrangler config, dist/, runtime/ and .cache/) lives in the site's cms folder, the working directory.
// Scripts run from source in this repository and from dist/ once published, so find the root by its package.json.
function findPackageRoot(directory: string): string {
  try {
    if ((JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { name?: string }).name === '@joebailey26/static-wordpress') return directory
  } catch { /* No package.json at this level. */ }
  const parent = dirname(directory)
  if (parent === directory) throw new Error('Cannot find the @joebailey26/static-wordpress package root')

  return findPackageRoot(parent)
}

export const packageRoot = findPackageRoot(dirname(fileURLToPath(import.meta.url)))

export function siteRoot(): string {
  const index = process.argv.indexOf('--root')

  return resolve(index > 0 ? process.argv[index + 1] : process.cwd())
}

export async function siteConfig(root: string): Promise<SiteConfig> {
  return defineConfig(JSON.parse(await readFile(join(root, 'cms.config.json'), 'utf8')))
}

/* eslint-disable @typescript-eslint/naming-convention -- wrangler.jsonc keys */
export interface D1Binding {
  binding: string
  database_name?: string
  database_id?: string
  migrations_dir?: string
}

export interface R2Binding {
  binding: string
  bucket_name?: string
}

export interface WranglerEnvironment {
  d1_databases?: D1Binding[]
  r2_buckets?: R2Binding[]
  vars?: Record<string, string>
}
/* eslint-enable @typescript-eslint/naming-convention */

// The production bindings sit at the top level, the Preview ones under previews.
/* eslint-disable @typescript-eslint/naming-convention -- wrangler.jsonc keys */
export interface WranglerConfig extends WranglerEnvironment {
  d1_databases: D1Binding[]
  r2_buckets: R2Binding[]
  previews?: WranglerEnvironment
}
/* eslint-enable @typescript-eslint/naming-convention */

export async function wranglerConfig(root: string, name = 'wrangler.jsonc'): Promise<WranglerConfig> {
  return JSON.parse(await readFile(join(root, name), 'utf8'))
}

// Wrangler is the site's dependency, so its version follows the site's lockfile.
export function wranglerBin(root: string): string {
  return join(dirname(createRequire(join(root, 'package.json')).resolve('wrangler/package.json')), 'bin/wrangler.js')
}
