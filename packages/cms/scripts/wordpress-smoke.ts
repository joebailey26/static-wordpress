/* eslint-disable no-console -- command-line output */
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { loadNodeRuntime } from '@php-wasm/node'
import { bootWordPressAndRequestHandler } from '@wp-playground/wordpress'
import type { PhpInstance } from '@wp-playground/wordpress'
import { packageRoot, siteConfig, siteRoot } from './site.ts'
import type { RuntimeFile, RuntimeLock, RuntimeMetadata } from './runtime-archive.ts'
import type { ContentRecord } from '../src/shared.ts'

// Runs against a site folder that has a prepared runtime (static-wordpress runtime) and a cms.config.json with blog and projects sections.
const root = siteRoot()
const config = await siteConfig(root)
const theme = `${config.id}-headless`
const configJson = JSON.stringify(config).replaceAll('\\', '\\\\').replaceAll('\'', '\\\'')
const capture = `static_wordpress_capture(json_decode('${configJson}', true))`
const metadata: RuntimeMetadata = JSON.parse(await readFile(join(root, '.cache/runtime-path.json'), 'utf8'))
const assets = resolve(root, metadata.path)
const lock: RuntimeLock = JSON.parse(await readFile(join(packageRoot, 'runtime.lock.json'), 'utf8'))
const core = (await readdir(join(assets, 'assets'))).find(name => name.startsWith(`wp-${lock.wordpressMajor}.tar-`) && name.endsWith('.zst'))
if (!core) throw new Error('Could not find the pinned WordPress core bundle')
const coreFile = new File([await readFile(join(assets, 'assets', core))], 'wordpress.tar.zst')
const sqliteFile = new File([await readFile(join(dirname(createRequire(import.meta.url).resolve('@wp-playground/cli/package.json')), 'sqlite-database-integration.zip'))], 'sqlite.zip')
const bridge = await readFile(join(packageRoot, 'wordpress/static-wordpress.php'), 'utf8')
const migration = await readFile(join(packageRoot, 'wordpress/migration.php'), 'utf8')
type Site = Awaited<ReturnType<typeof boot>>
async function installHeadlessTheme(site: Site) {
  site.php.mkdir(`/wordpress/wp-content/themes/${theme}`)
  for (const name of ['style.css', 'functions.php', 'index.php']) {
    site.php.writeFile(`/wordpress/wp-content/themes/${theme}/${name}`, await readFile(join(packageRoot, 'wordpress/themes/headless', name)))
  }
  await site.run(`wp_clean_themes_cache(); switch_theme('${theme}');`)
  site.php.rmdir('/wordpress/wp-content/themes/twentytwentyfive', { recursive: true })
}
async function boot() {
  // Set by the primary instance hook before boot resolves.
  let php!: PhpInstance
  const handler = await bootWordPressAndRequestHandler({
    createPhpRuntime: () => loadNodeRuntime('8.5', { emscriptenOptions: { processId: process.pid } }), phpVersion: '8.5',
    siteUrl: `https://cms.example.test/scope:${config.id}-cms/`, documentRoot: '/wordpress',
    wordPressZip: coreFile, sqliteIntegrationPluginZip: sqliteFile, maxPhpInstances: 1,
    constants: { DISABLE_WP_CRON: true },
    onPHPInstanceCreated(instance, { isPrimary }) { if (isPrimary) php = instance }
  })
  php.mkdir('/wordpress/wp-content/mu-plugins')
  php.writeFile('/tmp/static-wordpress-config.json', JSON.stringify(config))
  php.writeFile('/wordpress/wp-content/mu-plugins/static-wordpress.php', bridge)
  php.writeFile('/tmp/migration.php', migration)
  async function run(code: string) {
    const response = await php.run({ code: `<?php define('STATIC_WORDPRESS_CHECKPOINT', true); require '/wordpress/wp-load.php'; ${code}` })
    assert.equal(response.exitCode, 0, response.errors || response.text)
    assert.equal(response.httpStatusCode, 200, response.text)

    return response.text
  }

  return { php, handler, run }
}

console.log('Booting the pinned WordPress/PHP/SQLite runtime…')
const first = await boot()
try {
  await first.run(`
    $blog = wp_insert_term('Blog', 'category', array('slug' => 'blog'));
    $projects = wp_insert_term('Projects', 'category', array('slug' => 'projects'));
    $published = wp_insert_post(array('post_title' => 'Published fixture', 'post_name' => 'published-fixture', 'post_status' => 'publish', 'post_content' => '<p>Published content</p>', 'post_category' => array($blog['term_id'])));
    wp_insert_post(array('post_title' => 'Draft fixture', 'post_status' => 'draft', 'post_content' => 'Private draft', 'post_category' => array($blog['term_id'])));
    $project = wp_insert_post(array('post_title' => 'Project fixture', 'post_status' => 'publish', 'post_category' => array($projects['term_id'])));
    update_post_meta($project, 'icons', array('PHP', 'Vue'));
    update_post_meta($project, 'github', 'https://github.com/example/project');
    update_option('static_wordpress_test_setting', 'restored-setting');
  `)
  const captured: { records: ContentRecord[] } = JSON.parse(await first.run(`echo wp_json_encode(${capture}, JSON_THROW_ON_ERROR);`))
  assert.equal(captured.records.length, 2)
  assert.equal(captured.records.some(post => post.title.rendered === 'Draft fixture'), false)
  assert.deepEqual(captured.records.find(post => post.section === 'projects')?.acf?.icons, ['PHP', 'Vue'])
  await installHeadlessTheme(first)
  const headless: { theme: string, thumbnails: boolean, wide: boolean, capture: { records: ContentRecord[], files: RuntimeFile[] } } = JSON.parse(await first.run(`echo wp_json_encode(array('theme' => get_stylesheet(), 'thumbnails' => current_theme_supports('post-thumbnails'), 'wide' => current_theme_supports('align-wide'), 'capture' => ${capture}), JSON_THROW_ON_ERROR);`))
  assert.equal(headless.theme, theme)
  assert.equal(headless.thumbnails, true)
  assert.equal(headless.wide, true)
  assert.deepEqual(headless.capture.records, captured.records, 'Switching themes must preserve rendered published output and project fields')
  assert.deepEqual(headless.capture.files.filter(file => file.path.startsWith('themes/')).map(file => file.path).sort(), ['functions.php', 'index.php', 'style.css'].map(name => `themes/${theme}/${name}`))
  const backup = first.php.readFileAsBuffer('/tmp/static-wordpress.sqlite')
  assert.equal(new TextDecoder().decode(backup.subarray(0, 16)), 'SQLite format 3\0')

  // A completely separate PHP filesystem simulates clearing browser storage / another device.
  console.log('Restoring the checkpoint into a fresh WordPress runtime…')
  const second = await boot()
  try {
    await installHeadlessTheme(second)
    const target = (await second.run('echo static_wordpress_database_path();')).trim()
    second.php.writeFile(target, backup)
    for (const suffix of ['-wal', '-shm']) if (second.php.fileExists(target + suffix)) second.php.unlink(target + suffix)
    const restored = JSON.parse(await second.run(`echo wp_json_encode(array('drafts' => wp_count_posts()->draft, 'setting' => get_option('static_wordpress_test_setting'), 'admins' => count(get_users(array('role' => 'administrator'))), 'records' => ${capture}['records']), JSON_THROW_ON_ERROR);`))
    assert.equal(Number(restored.drafts), 1)
    assert.equal(restored.setting, 'restored-setting')
    assert.equal(restored.admins, 1)
    assert.equal(restored.records.length, 2)
    assert.equal((await second.run('echo get_stylesheet();')).trim(), theme)
    // A snapshot saved with an older WordPress (here 6.7's schema version) is upgraded once, keeping its content.
    assert.equal((await second.run('echo static_wordpress_upgrade_database() ? "upgraded" : "current";')).trim(), 'current')
    await second.run('update_option(\'db_version\', 58975);')
    assert.equal((await second.run('echo static_wordpress_upgrade_database() ? "upgraded" : "current";')).trim(), 'upgraded')
    const upgraded = JSON.parse(await second.run(`echo wp_json_encode(array('version' => (int) get_option('db_version'), 'expected' => $GLOBALS['wp_db_version'], 'records' => count(${capture}['records'])), JSON_THROW_ON_ERROR);`))
    assert.equal(upgraded.version, upgraded.expected)
    assert.equal(upgraded.records, 2)
    assert.equal((await second.run('echo static_wordpress_upgrade_database() ? "upgraded" : "current";')).trim(), 'current')
    second.php.writeFile('/tmp/static-wordpress-login', 'one-time-login')
    const login = await second.handler.request({ url: '/?static_wordpress_login=one-time-login' })
    assert.equal(login.httpStatusCode, 200)
    const admin = await second.handler.request({ url: '/wp-admin/edit.php' })
    assert.equal(admin.httpStatusCode, 200, 'restored editor must be authenticated')
    second.php.mkdir('/wordpress/wp-content/uploads/2025')
    second.php.writeFile('/wordpress/wp-content/uploads/2025/fixture.png', Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7GQAAAAASUVORK5CYII=', 'base64')))
    const source = (id: number, type: string, overrides = {}) => ({ id, type, status: type === 'attachment' ? 'inherit' : 'publish', slug: `imported-${id}`, title: `Imported ${id}`, content: '', excerpt: '', date: '2024-01-02 12:00:00', dateGmt: '2024-01-02 12:00:00', author: 'source-author', parent: 0, categories: [], meta: [], ...overrides })
    const migrationData = {
      version: 1, authors: [{ login: 'source-author', displayName: 'Source author' }],
      categories: [{ name: 'Projects', slug: 'projects', taxonomy: 'category' }], tags: [], acf: [],
      posts: [
        source(900, 'attachment', { attachmentUrl: 'https://old.example/wp-content/uploads/2025/fixture.png', meta: [{ key: '_wp_attached_file', raw: '2025/fixture.png' }] }),
        source(901, 'post', { content: '<p><img src="https://old.example/wp-content/uploads/2025/fixture.png"></p>', categories: [{ taxonomy: 'category', slug: 'projects', name: 'Projects' }], url: 'https://old.example/imported-901/', meta: [{ key: '_thumbnail_id', raw: '900' }, { key: 'icons', raw: 'a:2:{i:0;s:3:"PHP";i:1;s:3:"Vue";}' }, { key: 'github', raw: 'https://github.com/example/imported' }, { key: 'multi', raw: 'one' }, { key: 'multi', raw: 'two' }] }),
        source(902, 'post', { status: 'draft' })
      ]
    }
    second.php.writeFile('/tmp/migration.json', JSON.stringify(migrationData))
    const imported = JSON.parse(await second.run('require \'/tmp/migration.php\'; echo wp_json_encode(static_wordpress_import(\'/tmp/migration.json\'), JSON_THROW_ON_ERROR);'))
    assert.equal(imported.media, 1)
    const checkImport = JSON.parse(await second.run('$posts = get_posts(array(\'name\' => \'imported-901\')); $post = $posts[0]; echo wp_json_encode(array(\'date\' => $post->post_date, \'content\' => $post->post_content, \'icons\' => get_post_meta($post->ID, \'icons\', true), \'multi\' => get_post_meta($post->ID, \'multi\'), \'thumbnail\' => get_post_thumbnail_id($post), \'draft\' => count(get_posts(array(\'name\' => \'imported-902\', \'post_status\' => \'draft\')))), JSON_THROW_ON_ERROR);'))
    assert.equal(checkImport.date, '2024-01-02 12:00:00')
    assert.deepEqual(checkImport.icons, ['PHP', 'Vue'])
    assert.deepEqual(checkImport.multi, ['one', 'two'])
    assert(checkImport.thumbnail)
    assert.equal(checkImport.draft, 1)
    assert(checkImport.content.includes(`https://cms.example.test/scope:${config.id}-cms/wp-content/uploads/2025/fixture.png`))
    await second.run('require \'/tmp/migration.php\'; static_wordpress_import(\'/tmp/migration.json\');')
    const duplicateCount = await second.run('echo count(get_posts(array(\'name\' => \'imported-901\')));')
    assert.equal(duplicateCount.trim(), '1')
    const hash = 'a'.repeat(64)
    second.php.writeFile('/tmp/static-wordpress-virtual.json', JSON.stringify({ origin: 'https://cms.example.test', files: { 'uploads/2026/virtual.jpg': { hash, size: 5 }, 'uploads/2026/virtual-300x200.jpg': { hash: 'b'.repeat(64), size: 3 } } }))
    const redirect = await second.handler.request({ url: '/wp-content/uploads/2026/virtual.jpg' })
    assert.equal(redirect.httpStatusCode, 302)
    assert.equal(redirect.headers.location[0], `https://cms.example.test/media/${hash}/${hash.slice(0, 16)}-virtual.jpg`)
    assert.notEqual((await second.handler.request({ url: '/wp-content/uploads/2026/unknown.jpg' })).httpStatusCode, 302, 'only saved uploads redirect to R2')
    const virtualCapture = JSON.parse(await second.run(`echo wp_json_encode(${capture}['virtual'], JSON_THROW_ON_ERROR);`))
    assert.deepEqual(Object.keys(virtualCapture).sort(), ['uploads/2026/virtual-300x200.jpg', 'uploads/2026/virtual.jpg'])
    const needsEditor = await second.run(`$id = wp_insert_attachment(array('post_title' => 'Virtual', 'post_mime_type' => 'image/jpeg', 'post_status' => 'inherit'), false);
      update_post_meta($id, '_wp_attached_file', '2026/virtual.jpg');
      wp_update_attachment_metadata($id, array('file' => '2026/virtual.jpg', 'sizes' => array('thumb' => array('file' => 'virtual-300x200.jpg'))));
      echo static_wordpress_require_media($id) ? 'ready' : 'missing';`)
    assert.equal(needsEditor.trim(), 'missing')
    assert.deepEqual(JSON.parse(second.php.readFileAsText('/tmp/static-wordpress-wanted')).sort(), ['uploads/2026/virtual-300x200.jpg', 'uploads/2026/virtual.jpg'])
    await second.run('apply_filters(\'wp_delete_file\', wp_get_upload_dir()[\'basedir\'] . \'/2026/virtual.jpg\');')
    assert.deepEqual(Object.keys(JSON.parse(second.php.readFileAsText('/tmp/static-wordpress-virtual.json')).files), ['uploads/2026/virtual-300x200.jpg'])
    console.log('PASS: saved uploads redirect to R2, stay in the manifest until deleted, and image edits request the original files.')
    console.log('PASS: full database restore preserves drafts, settings, users, rendered posts and project fields; an older database is upgraded once; restored WordPress admin login works.')
    console.log('PASS: minimal three-file theme preserves rendered content, featured-image support and wide blocks after snapshot restoration.')
    console.log('PASS: migration preserves dates, drafts, serialized and repeated custom fields, attachment mappings and media URLs; reimport is idempotent.')
  } finally { second.php.exit() }
} finally { first.php.exit() }
