#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { packageRoot, siteRoot, wranglerBin } from '../scripts/site.mjs';

// Each command runs a package script against the site's cms folder (the working directory, or --root).
const scripts = {
  build: ['build.mjs'],
  runtime: ['prepare-runtime.mjs'],
  'runtime:upload': ['upload-runtime.mjs'],
  deploy: ['deploy.mjs'],
  import: ['migrate-backup.mjs'],
  'import:wxr': ['migrate.mjs'],
  'inspect-backup': ['inspect-backup.mjs'],
  'test:wordpress': ['wordpress-smoke.mjs', ['--experimental-wasm-jspi']],
  'test:browser': ['browser-smoke.mjs']
};

const root = siteRoot();
// --root is resolved here and passed on as an absolute path.
const [command, ...args] = process.argv.slice(2).filter((arg, index, all) => arg !== '--root' && all[index - 1] !== '--root');

function run(argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, { cwd: root, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(Object.assign(new Error(`${command} failed`), { code })));
  });
}

const script = (name, extra = []) => {
  const [file, flags = []] = scripts[name];
  return run([...flags, join(packageRoot, 'scripts', file), ...extra, '--root', root]);
};

try {
  if (command === 'build:ci') {
    await script('runtime');
    await script('build', ['--production']);
  } else if (command === 'dev') {
    await script('build');
    await run([wranglerBin(root), 'dev', '--host', '127.0.0.1', '--ip', '127.0.0.1', '--port', '8787', ...args]);
  } else if (command === 'db:local' || command === 'db:remote') {
    await run([wranglerBin(root), 'd1', 'migrations', 'apply', 'DB', command === 'db:local' ? '--local' : '--remote', ...args]);
  } else if (scripts[command]) {
    await script(command, args);
  } else {
    console.error(`Usage: static-wordpress <${['build', 'build:ci', 'dev', 'db:local', 'db:remote', ...Object.keys(scripts).filter(name => name !== 'build')].join('|')}> [options]`);
    process.exitCode = 1;
  }
} catch (error) {
  if (!error.code) console.error(error.message);
  process.exitCode = error.code || 1;
}
