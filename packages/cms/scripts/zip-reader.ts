import yauzl from 'yauzl'
import type { Entry, ZipFile } from 'yauzl'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'

export interface Archive {
  entries: Map<string, Entry>
  read(name: string, limit?: number): Promise<Buffer>
  extract(name: string, destination: string): Promise<void>
  close(): void
}

export async function openArchive(path: string): Promise<Archive> {
  const zip = await new Promise<ZipFile>((resolve, reject) => yauzl.open(path, { lazyEntries: true, autoClose: false }, (error, zip) => error ? reject(error) : resolve(zip)))
  const entries = new Map<string, Entry>()
  await new Promise((resolve, reject) => {
    zip.on('error', reject)
    zip.on('end', resolve)
    zip.on('entry', (entry: Entry) => { entries.set(entry.fileName, entry); zip.readEntry() })
    zip.readEntry()
  })
  const stream = (name: string) => new Promise<Readable>((resolve, reject) => {
    const entry = entries.get(name)
    if (!entry) {
      reject(new Error(`Missing backup entry: ${name}`))

      return
    }
    zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream))
  })

  return {
    entries,
    async read(name, limit = 128 * 1024 * 1024) {
      if ((entries.get(name)?.uncompressedSize || 0) > limit) throw new Error(`Backup entry is too large to read: ${name}`)
      const chunks: Buffer[] = []; let size = 0
      for await (const chunk of await stream(name)) { size += chunk.length; if (size > limit) throw new Error('Backup size limit exceeded'); chunks.push(chunk) }

      return Buffer.concat(chunks)
    },
    async extract(name, destination) {
      await mkdir(dirname(destination), { recursive: true })
      await pipeline(await stream(name), createWriteStream(destination))
    },
    close() { zip.close() }
  }
}
