#!/usr/bin/env node
/* eslint-disable no-console -- command-line output */
import { spawn } from 'node:child_process'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { siteRoot, wranglerBin } from '../scripts/site.ts'

// Each command runs a package script against the site's cms folder (the working directory, or --root).
const scripts: Record<string, [string, string[]?]> = {
  build: ['build'],
  runtime: ['prepare-runtime'],
  'runtime:upload': ['upload-runtime'],
  deploy: ['deploy'],
  import: ['migrate-backup'],
  'import:wxr': ['migrate'],
  'inspect-backup': ['inspect-backup'],
  'test:wordpress': ['wordpress-smoke', ['--experimental-wasm-jspi']],
  'test:browser': ['browser-smoke']
}
// The scripts sit beside this file's folder: TypeScript sources in the repository, compiled JavaScript in dist/.
const scriptsDirectory = fileURLToPath(new URL('../scripts/', import.meta.url))
const extension = extname(fileURLToPath(import.meta.url))

const root = siteRoot()
// --root is resolved here and passed on as an absolute path.
const [command, ...args] = process.argv.slice(2).filter((arg, index, all) => arg !== '--root' && all[index - 1] !== '--root')

function run(argv: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, argv, { cwd: root, stdio: 'inherit' })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve() : reject(Object.assign(new Error(`${command} failed`), { code })))
  })
}

const script = (name: string, extra: string[] = []) => {
  const [file, flags = []] = scripts[name]

  return run([...flags, join(scriptsDirectory, file + extension), ...extra, '--root', root])
}

try {
  if (command === 'build:ci') {
    await script('runtime')
    await script('build', ['--production'])
  } else if (command === 'dev') {
    await script('build')
    await run([wranglerBin(root), 'dev', '--host', '127.0.0.1', '--ip', '127.0.0.1', '--port', '8787', ...args])
  } else if (command === 'db:local' || command === 'db:remote') {
    await run([wranglerBin(root), 'd1', 'migrations', 'apply', 'DB', command === 'db:local' ? '--local' : '--remote', ...args])
  } else if (scripts[command]) {
    await script(command, args)
  } else {
    console.error(`Usage: static-wordpress <${['build', 'build:ci', 'dev', 'db:local', 'db:remote', ...Object.keys(scripts).filter(name => name !== 'build')].join('|')}> [options]`)
    process.exitCode = 1
  }
} catch (error) {
  // A script that failed has reported its own error; its exit code is passed on.
  const { code, message } = error as Error & { code?: number | string }
  if (!code) console.error(message)
  process.exitCode = code || 1
}
