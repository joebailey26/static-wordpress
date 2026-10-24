import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { spawn } from 'node:child_process'
import { openArchive } from './zip-reader.ts'

// runtime.lock.json: the pinned Playground release.
export interface RuntimeLock {
  playground: string
  downloadUrl: string
  wordpressMajor: string
  commit: string
  artifactId: number
  artifactSha256: string
  repository: string
}

export interface RuntimeFile {
  path: string
  size: number
}

// .cache/runtime-path.json: where the runtime was extracted, the lock it came from and its file inventory.
export interface RuntimeMetadata extends Partial<RuntimeLock> {
  path: string
  artifactSha256: string
  files: RuntimeFile[]
}

// A runtime file too large for Workers static assets, uploaded to R2 under its hash.
export interface RuntimeObject {
  hash: string
  type: string
}

interface ArchiveOptions {
  local?: boolean
  fetchImpl?: typeof fetch
}

const errorCode = (error: unknown) => error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined

export async function verifyArchive(path: string, checksum: string): Promise<void> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  if (hash.digest('hex') !== checksum) throw Object.assign(new Error('Runtime artifact checksum mismatch'), { code: 'CMS_RUNTIME_CHECKSUM' })
}

export async function ensureArchive(url: string, destination: string, checksum: string, { local = false, fetchImpl = fetch }: ArchiveOptions = {}): Promise<void> {
  const existing = await stat(destination).catch((error: unknown) => {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  })
  if (existing) {
    try {
      await verifyArchive(destination, checksum)

      return
    } catch (error) {
      // Cloudflare can restore only part of its build cache. A supplied source
      // archive belongs to the user; only discard our generated cache copy.
      if (local || errorCode(error) !== 'CMS_RUNTIME_CHECKSUM') throw error
      await rm(destination)
    }
  } else if (local) throw new Error(`Runtime ZIP not found: ${destination}`)
  await downloadArchive(url, destination, checksum, { fetchImpl })
}

export async function downloadArchive(url: string, destination: string, checksum: string, { fetchImpl = fetch }: ArchiveOptions = {}): Promise<void> {
  await mkdir(dirname(destination), { recursive: true })
  const temporary = `${destination}.${randomUUID()}.partial`
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(15 * 60 * 1000) })
    if (!response.ok || !response.body) throw new Error(`Runtime download failed: HTTP ${response.status}`)
    const hash = createHash('sha256')
    const hashing = new Transform({ transform(chunk: Buffer, encoding, callback) { hash.update(chunk); callback(null, chunk) } })
    // fetch's stream is Node's web stream; the DOM typings describe the same object.
    await pipeline(Readable.fromWeb(response.body as NodeReadableStream), hashing, createWriteStream(temporary, { flags: 'wx' }))
    if (hash.digest('hex') !== checksum) throw new Error('Runtime artifact checksum mismatch')
    await rename(temporary, destination)
  } finally { await rm(temporary, { force: true }) }
}

export function archivePath(root: string, name: string): string {
  if (!name || name.startsWith('/') || name.includes('\\') || name.includes(':') || name.includes('\0') || name.split('/').some(part => part === '..')) throw new Error(`Unsafe artifact path: ${name}`)
  const target = resolve(root, name)
  if (target !== resolve(root) && !target.startsWith(`${resolve(root)}${sep}`)) throw new Error(`Unsafe artifact path: ${name}`)

  return target
}

export async function extractZip(source: string, destination: string): Promise<void> {
  const archive = await openArchive(source)
  try {
    // Validate the entire list before writing; only regular files/directories.
    for (const [name, entry] of archive.entries) {
      archivePath(destination, name)
      const mode = (entry.externalFileAttributes >>> 16) & 0o170000
      if (mode && ![0o040000, 0o100000].includes(mode)) throw new Error(`Unsupported artifact entry: ${name}`)
    }
    for (const name of archive.entries.keys()) {
      const target = archivePath(destination, name)
      if (name.endsWith('/')) await mkdir(target, { recursive: true })
      else await archive.extract(name, target)
    }
  } finally { archive.close() }
}

export function runTar(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', errors = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4000) })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error(`Runtime tar failed (${code}): ${errors}`)))
  })
}

export async function extractTar(source: string, destination: string): Promise<void> {
  const names = await runTar(['-tzf', source])
  for (const name of names.split(/\r?\n/).filter(Boolean)) archivePath(destination, name)
  const details = await runTar(['-tvzf', source])
  if (details.split(/\r?\n/).some(line => /^[lh]/.test(line))) throw new Error('Unsupported link in runtime tarball')
  await mkdir(destination, { recursive: true })
  await runTar(['-xzf', source, '-C', destination])
}

export async function runtimeInventory(directory: string, prefix = ''): Promise<RuntimeFile[]> {
  const files: RuntimeFile[] = []
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...await runtimeInventory(directory, name))
    else if (entry.isFile()) files.push({ path: name, size: (await stat(join(directory, name))).size })
    else throw new Error(`Unsupported runtime entry: ${name}`)
  }

  return files
}

export async function preparedRuntime(root: string, lock: Pick<RuntimeLock, 'artifactSha256'>): Promise<RuntimeMetadata & { assets: string } | null> {
  try {
    const metadata: RuntimeMetadata = JSON.parse(await readFile(join(root, '.cache/runtime-path.json'), 'utf8'))
    if (metadata.artifactSha256 !== lock.artifactSha256 || !metadata.files?.length) return null
    const assets = resolve(root, metadata.path)
    if (!assets.startsWith(`${join(root, 'runtime')}${sep}`)) return null
    for (const name of ['remote.html', 'sw.js', 'assets']) await stat(join(assets, name))
    for (const file of metadata.files) {
      const info = await stat(archivePath(assets, file.path))
      if (!info.isFile() || info.size !== file.size) return null
    }

    return { ...metadata, assets }
  } catch { return null }
}
