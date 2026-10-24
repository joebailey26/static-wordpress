import { readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { transform } from 'esbuild'
import { packageRoot } from './site.ts'

// Module service-worker script fetches omit cookies, which makes Access redirect
// them to login. Keep the runtime private by compiling the bundled, import-free
// upstream worker as a classic script and adapting its registration together.
export async function prepareAccessCompatibleRuntime(source: string, output: string): Promise<void> {
  const registration = '{type:"module",updateViaCache:"none"}'
  let patched = 0
  for (const name of await readdir(join(source, 'assets'))) {
    if (!/^wordpress-.*\.js$/.test(name)) continue
    const code = await readFile(join(source, 'assets', name), 'utf8')
    if (!code.includes(registration)) continue
    if (code.split(registration).length !== 2) throw new Error('Pinned Playground service-worker registration changed; review the Access compatibility patch')
    await writeFile(join(output, 'assets', name), code.replace(registration, '{type:"classic",updateViaCache:"none"}'))
    patched++
  }
  if (patched !== 1) throw new Error('Expected one pinned Playground service-worker registration')
  const worker = await readFile(join(source, 'sw.js'), 'utf8')
  // The policy ships as TypeScript source. Strip its types on its own, so the upstream worker is still parsed as JavaScript.
  const policy = (await transform(await readFile(join(packageRoot, 'scripts/service-worker-policy.ts'), 'utf8'), { loader: 'ts' })).code
  const result = await transform(`${policy}\n${worker}`, { format: 'iife', platform: 'browser', target: 'es2022', minify: true, define: { 'import.meta.url': 'self.location.href' } })
  await writeFile(join(output, 'sw.js'), result.code)
}
