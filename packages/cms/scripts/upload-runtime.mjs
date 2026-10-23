import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { siteRoot, wranglerBin, wranglerConfig } from './site.mjs';

const root = siteRoot();
const objects = JSON.parse(await readFile(join(root, '.cache/runtime-objects.json'), 'utf8'));
const config = await wranglerConfig(root);
const preview = process.argv.includes('--preview');
const target = preview ? config.previews : config;
const bucket = target?.r2_buckets?.find(item => item.binding === 'FILES')?.bucket_name;
if (!bucket) throw new Error('Runtime bucket is not configured');
if (preview && config.r2_buckets.some(item => item.bucket_name === bucket)) throw new Error('Preview upload cannot use production storage');
// An override is useful for local tooling, but cannot redirect a deployment.
if (process.env.CMS_R2_BUCKET && process.env.CMS_R2_BUCKET !== bucket) throw new Error('CMS_R2_BUCKET does not match deployment configuration');
for (const { hash, type } of new Map(Object.values(objects).map(object => [object.hash, object])).values()) {
  const child = spawn(process.execPath, [wranglerBin(root), 'r2', 'object', 'put', `${bucket}/runtime/${hash}`, '--file', join(root, '.cache/runtime-objects', hash), '--content-type', type, process.argv.includes('--local') ? '--local' : '--remote'], { cwd: root, stdio: 'inherit' });
  await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error('Runtime upload failed'))); });
}
