import { categoryMap, sectionNames } from './config.mjs';

export const CHUNK_SIZE = 256 * 1024;
export const MAX_DATABASE_SIZE = 128 * 1024 * 1024;
export const MAX_FILE_SIZE = 50 * 1024 * 1024;
export const HASH = /^[a-f0-9]{64}$/;
export const REVISION = /^[a-f0-9-]{36}$/;
// The PHP version the editor runs. Snapshots from older supported versions restore unchanged: the SQLite
// database does not depend on the PHP version.
export const PHP_VERSION = '8.5';
export const SUPPORTED_PHP = ['8.3', '8.4', '8.5'];
const VERSION = /^\d+(\.\d+){1,2}$/;

// Compares dotted version numbers (7.0, 7.0.8): negative when a is older than b, 0 when equal, positive when newer.
export function compareVersions(a, b) {
  const left = String(a).split('.').map(Number), right = String(b).split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

// A snapshot opens on the WordPress it was saved with or a newer one, whose database upgrade then runs.
// WordPress cannot run on a database from a newer release, so a downgrade is refused.
export function canOpenSnapshot(snapshotVersion, runtimeVersion) {
  return compareVersions(snapshotVersion, runtimeVersion) <= 0;
}

export async function sha256(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
}

export function assert(condition, message, status = 400) {
  if (!condition) throw Object.assign(new Error(message), { status });
}

export function safePath(path) {
  return typeof path === 'string' && path.length <= 512 &&
    /^(uploads|plugins|themes|mu-plugins|languages)\//.test(path) &&
    !path.includes('\\') && !path.includes('\0') &&
    path.split('/').every(part => part && part !== '.' && part !== '..') &&
    !path.startsWith('mu-plugins/static-wordpress') &&
    !/^mu-plugins\/(0-playground\.php|sqlite-database-integration)(\/|$)/.test(path);
}

// Snapshots record the category behind each section, so a checkpoint cannot be published to a site that maps them differently.
// Snapshots taken before sections were configurable stored only the blog and projects categories.
function manifestCategories(manifest) {
  if (manifest.sections && typeof manifest.sections === 'object') return manifest.sections;
  if (typeof manifest.blogCategory === 'string' && typeof manifest.projectsCategory === 'string') return { blog: manifest.blogCategory, projects: manifest.projectsCategory };
  return null;
}

export function validateManifest(manifest, config) {
  assert(manifest && manifest.version === 1, 'Unsupported snapshot version');
  // runtime records the Playground build a snapshot was saved with; any later build can restore it.
  assert(typeof manifest.runtime === 'string' && VERSION.test(manifest.runtime) && SUPPORTED_PHP.includes(manifest.php), 'Unsupported runtime');
  assert(typeof manifest.wordpress === 'string' && VERSION.test(manifest.wordpress), 'Missing WordPress version');
  assert(Number.isSafeInteger(manifest.databaseSize) && manifest.databaseSize > 0 && manifest.databaseSize <= MAX_DATABASE_SIZE, 'Database exceeds 128 MiB limit');
  assert(HASH.test(manifest.databaseHash), 'Invalid database checksum');
  assert(Array.isArray(manifest.chunks) && manifest.chunks.length === Math.ceil(manifest.databaseSize / CHUNK_SIZE) && manifest.chunks.every(hash => HASH.test(hash)), 'Invalid database chunks');
  assert(Array.isArray(manifest.files) && manifest.files.length <= 50000, 'Invalid file manifest');
  const paths = new Set();
  for (const file of manifest.files) {
    assert(safePath(file.path) && !paths.has(file.path), 'Unsafe or duplicate file path');
    assert(HASH.test(file.hash) && Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= MAX_FILE_SIZE, 'Invalid file metadata');
    assert(file.kind === (file.path.startsWith('uploads/') ? 'media' : 'private'), 'Invalid file visibility');
    paths.add(file.path);
  }
  const sections = sectionNames(config);
  assert(manifest.counts && Object.keys(manifest.counts).length === sections.length && sections.every(key => Number.isSafeInteger(manifest.counts[key]) && manifest.counts[key] >= 0 && manifest.counts[key] <= 10000), 'Invalid content counts');
  const categories = manifestCategories(manifest), expected = categoryMap(config);
  assert(categories && sections.every(key => categories[key] === expected[key]) && Object.keys(categories).length === sections.length, 'Category mapping does not match the site configuration');
  assert(new TextEncoder().encode(JSON.stringify(manifest)).length < 1500000, 'File manifest exceeds D1 row limit');
  return manifest;
}

export function validateRecord(record, section) {
  assert(record && record.status === 'publish' && record.section === section, 'Only published records belong in the feed');
  if (record.modified !== undefined) assert(typeof record.modified === 'string' && !Number.isNaN(Date.parse(record.modified)), 'Invalid modified date');
  if (record.tags !== undefined) assert(Array.isArray(record.tags) && record.tags.every(tag => typeof tag === 'string'), 'Invalid tags');
  if (record.author !== undefined) assert(record.author === null || typeof record.author === 'string', 'Invalid author');
  assert(typeof record.slug === 'string' && record.slug.length > 0 && record.slug.length <= 200 && !/[/?#\\]/.test(record.slug), 'Invalid post slug');
  assert(typeof record.date === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(record.date) && !Number.isNaN(Date.parse(record.date)), 'Invalid post date');
  assert(['title', 'excerpt', 'content'].every(key => typeof record[key]?.rendered === 'string'), 'Missing rendered content');
  if (record.featured_media_url) {
    assert(typeof record.featured_media_url === 'string' && URL.canParse(record.featured_media_url), 'Invalid featured image');
    const url = new URL(record.featured_media_url);
    assert(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)), 'Invalid featured image');
  }
  assert(new TextEncoder().encode(JSON.stringify(record)).length < 1500000, 'Post exceeds feed row size limit');
}

export async function feedHash(records) {
  const ordered = records.slice().sort((a, b) => `${a.section}/${a.slug}`.localeCompare(`${b.section}/${b.slug}`, 'en'));
  // Only fields consumed by the public site affect rebuilding; revisions and edit timestamps do not.
  return sha256(new TextEncoder().encode(JSON.stringify(ordered.map(post => [
    post.section, post.slug, post.date, post.title.rendered, post.excerpt.rendered,
    post.content.rendered, post.acf || {}, post.featured_media_url || null,
    post.modified || null, post.tags || [], post.author || null
  ]))));
}

export function rewriteRecords(exported, files, origin, config) {
  const replacements = Object.entries(exported.links || {});
  for (const file of files.filter(file => file.kind === 'media')) {
    const relative = file.path.slice('uploads/'.length);
    const publicUrl = `${origin}/media/${file.hash}/${file.hash.slice(0, 16)}-${encodeURIComponent(relative.split('/').pop())}`;
    for (const base of new Set([exported.uploadBase, `${exported.siteUrl}/wp-content/uploads`])) {
      replacements.push([`${base}/${relative}`, publicUrl]);
      replacements.push([`${base}/${relative.split('/').map(encodeURIComponent).join('/')}`, publicUrl]);
    }
  }
  replacements.sort((a, b) => b[0].length - a[0].length);
  const rewrite = value => {
    if (typeof value === 'string') {
      for (const [from, to] of replacements) value = value.replaceAll(from, to);
      // Links typed by hand against the editor's address still point at the public section.
      for (const section of config.sections) if (section.path) value = value.replaceAll(`${exported.siteUrl}${section.path}`, `${config.siteUrl}${section.path}`);
      return value;
    }
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item)]));
    return value;
  };
  return rewrite(exported.records);
}
