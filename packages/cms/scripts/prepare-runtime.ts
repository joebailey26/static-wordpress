/* eslint-disable no-console -- command-line output */
import { mkdir, readFile, writeFile, stat, readdir, rm } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'
import { ensureArchive, extractZip, extractTar, preparedRuntime, runtimeInventory } from './runtime-archive.ts'
import type { RuntimeLock } from './runtime-archive.ts'
import { packageRoot, siteRoot } from './site.ts'

const root = siteRoot()
const lock: RuntimeLock = JSON.parse(await readFile(join(packageRoot, 'runtime.lock.json'), 'utf8'))
const archiveArgument = process.argv.slice(2).find((arg, index, all) => !arg.startsWith('--') && all[index - 1] !== '--root')
const cache = join(root, '.cache')
await mkdir(cache, { recursive: true })
if (!archiveArgument && await preparedRuntime(root, lock)) {
  console.log(`Verified prepared Playground ${lock.playground}; runtime is complete.`)
  process.exit(0)
}
const archive = archiveArgument ? resolve(archiveArgument) : join(cache, `playground-${lock.playground}.zip`)
console.log('Verifying the pinned archive; missing or corrupt generated caches download from the release (approximately 685 MiB)…')
await ensureArchive(lock.downloadUrl, archive, lock.artifactSha256, { local: Boolean(archiveArgument) })

const destination = join(root, 'runtime')
// Only this fixed, resolved directory contains disposable extracted runtime data.
if (resolve(destination) !== resolve(root, 'runtime')) throw new Error('Unsafe runtime output directory')
await rm(join(cache, 'runtime-path.json'), { force: true })
await rm(destination, { recursive: true, force: true })
await mkdir(destination, { recursive: true })
await extractZip(archive, destination)
const tarball = join(destination, 'wasm-wordpress-net.tar.gz')
if (await stat(tarball).catch(() => null)) await extractTar(tarball, join(destination, 'assets'))
async function findRemote(directory: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'remote.html') return directory
    if (entry.isDirectory()) { const found = await findRemote(join(directory, entry.name)); if (found) return found }
  }
}
const assets = await findRemote(destination)
if (!assets) throw new Error('The artifact does not contain remote.html')
const files = await runtimeInventory(assets)
await writeFile(join(cache, 'runtime-path.json'), JSON.stringify({ path: relative(root, assets), ...lock, files }, null, 2))
if (!await preparedRuntime(root, lock)) throw new Error('Prepared runtime is incomplete')
console.log(`Verified Playground ${lock.playground}: ${assets}`)
