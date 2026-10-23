import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '../src/config.mjs';

// The package holds the editor, Worker, WordPress bridge and runtime pin. Everything a site owns or generates
// (cms.config.json, wrangler config, dist/, runtime/ and .cache/) lives in the site's cms folder, the working directory.
export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function siteRoot() {
  const index = process.argv.indexOf('--root');
  return resolve(index > 0 ? process.argv[index + 1] : process.cwd());
}

export async function siteConfig(root) {
  return defineConfig(JSON.parse(await readFile(join(root, 'cms.config.json'), 'utf8')));
}

export async function wranglerConfig(root, name = 'wrangler.jsonc') {
  return JSON.parse(await readFile(join(root, name), 'utf8'));
}

// Wrangler is the site's dependency, so its version follows the site's lockfile.
export function wranglerBin(root) {
  return createRequire(join(root, 'package.json')).resolve('wrangler/bin/wrangler.js');
}
