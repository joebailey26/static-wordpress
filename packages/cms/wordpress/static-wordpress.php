<?php
/**
 * Plugin Name: Static WordPress browser CMS
 * Description: Checkpoint notifications, headless custom fields and database export.
 */

if (!defined('ABSPATH')) {
    exit;
}

if (file_exists('/tmp/static-wordpress-lock') && !defined('STATIC_WORDPRESS_CHECKPOINT')) {
    http_response_code(503);
    header('Retry-After: 3');
    exit('Saving a consistent checkpoint. Retry this request in a moment.');
}

// Saved uploads are not copied into the browser on startup. The editor lists them in a map outside wp-content
// (path => hash/size) and they remain in R2. The map never reaches a snapshot, but the manifest keeps its entries.
define('STATIC_WORDPRESS_VIRTUAL', '/tmp/static-wordpress-virtual.json');
define('STATIC_WORDPRESS_WANTED', '/tmp/static-wordpress-wanted');

function static_wordpress_virtual() {
    $data = file_exists(STATIC_WORDPRESS_VIRTUAL) ? json_decode(file_get_contents(STATIC_WORDPRESS_VIRTUAL), true) : null;
    return is_array($data) && is_array($data['files'] ?? null) ? array('origin' => (string) ($data['origin'] ?? ''), 'files' => $data['files']) : array('origin' => '', 'files' => array());
}

function static_wordpress_media_url($origin, $hash, $name) {
    return $origin . '/media/' . $hash . '/' . substr($hash, 0, 16) . '-' . rawurlencode($name);
}

// A missing upload falls through the static-file server into WordPress. Send the browser to the public,
// content-addressed R2 endpoint, so editor screens, post content and srcset values need no URL rewriting.
if (in_array($_SERVER['REQUEST_METHOD'] ?? 'GET', array('GET', 'HEAD'), true) && !defined('STATIC_WORDPRESS_CHECKPOINT')) {
    $static_wordpress_path = (string) parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH);
    $static_wordpress_marker = strpos($static_wordpress_path, '/wp-content/uploads/');
    if ($static_wordpress_marker !== false) {
        $static_wordpress_relative = rawurldecode(substr($static_wordpress_path, $static_wordpress_marker + strlen('/wp-content/uploads/')));
        $static_wordpress_virtual = static_wordpress_virtual();
        $static_wordpress_item = $static_wordpress_virtual['files']['uploads/' . $static_wordpress_relative] ?? null;
        if ($static_wordpress_item && $static_wordpress_virtual['origin'] !== '' && preg_match('/^[a-f0-9]{64}$/', (string) ($static_wordpress_item['hash'] ?? '')) && !file_exists(WP_CONTENT_DIR . '/uploads/' . $static_wordpress_relative)) {
            header('Location: ' . static_wordpress_media_url($static_wordpress_virtual['origin'], $static_wordpress_item['hash'], basename($static_wordpress_relative)), true, 302);
            exit;
        }
    }
}

// Deleted attachments must leave the manifest. Unlinking a virtual file is a no-op, so drop its map entry here.
add_filter('wp_delete_file', function ($file) {
    $uploads = trailingslashit(wp_get_upload_dir()['basedir']);
    if (strpos($file, $uploads) === 0) {
        $virtual = static_wordpress_virtual();
        $key = 'uploads/' . substr($file, strlen($uploads));
        if (isset($virtual['files'][$key])) {
            unset($virtual['files'][$key]);
            file_put_contents(STATIC_WORDPRESS_VIRTUAL, json_encode($virtual));
        }
    }
    return $file;
});

// Every upload file that belongs to an attachment, relative to wp-content.
function static_wordpress_attachment_paths($id) {
    $uploads = trailingslashit(wp_get_upload_dir()['basedir']);
    $relative = array();
    foreach (array(get_attached_file($id, true), function_exists('wp_get_original_image_path') ? wp_get_original_image_path($id, true) : '') as $path) {
        if ($path && strpos($path, $uploads) === 0) {
            $relative[] = substr($path, strlen($uploads));
        }
    }
    $meta = wp_get_attachment_metadata($id, true);
    $directory = !empty($meta['file']) ? dirname($meta['file']) : '';
    $names = array();
    foreach ((array) ($meta['sizes'] ?? array()) as $size) {
        $names[] = $size['file'] ?? '';
    }
    foreach ((array) get_post_meta($id, '_wp_attachment_backup_sizes', true) as $size) {
        $names[] = is_array($size) ? ($size['file'] ?? '') : '';
    }
    $names[] = $meta['original_image'] ?? '';
    foreach ($names as $name) {
        if ($name !== '') {
            $relative[] = ($directory !== '' && $directory !== '.' ? $directory . '/' : '') . $name;
        }
    }
    return array_values(array_unique($relative));
}

// Image editing needs original pixels in the browser. PHP cannot fetch them, so request them from the editor,
// which downloads the checksum-verified files and asks the user to retry.
function static_wordpress_require_media($id) {
    $virtual = static_wordpress_virtual();
    $needed = array();
    foreach (static_wordpress_attachment_paths($id) as $relative) {
        if (isset($virtual['files']['uploads/' . $relative])) {
            $needed[] = 'uploads/' . $relative;
        }
    }
    if (!$needed) {
        return true;
    }
    file_put_contents(STATIC_WORDPRESS_WANTED, json_encode($needed));
    return false;
}

const STATIC_WORDPRESS_DOWNLOADING = 'The original image is being downloaded from storage. Close the editor and open it again in a few seconds.';

add_action('admin_init', function () {
    if (!wp_doing_ajax()) {
        return;
    }
    $action = $_REQUEST['action'] ?? '';
    $id = (int) ($_REQUEST['postid'] ?? ($action === 'crop-image' ? ($_REQUEST['id'] ?? 0) : 0));
    if ($id && in_array($action, array('image-editor', 'imgedit-preview', 'crop-image'), true) && !static_wordpress_require_media($id)) {
        wp_die(esc_html(STATIC_WORDPRESS_DOWNLOADING));
    }
});

add_filter('rest_request_before_callbacks', function ($response, $handler, $request) {
    if (preg_match('#^/wp/v2/media/(\d+)/edit$#', $request->get_route(), $match) && !static_wordpress_require_media((int) $match[1])) {
        return new WP_Error('static_wordpress_media_downloading', STATIC_WORDPRESS_DOWNLOADING, array('status' => 409));
    }
    return $response;
}, 10, 3);

add_action('init', function () {
    if (!isset($_GET['static_wordpress_login'])) {
        return;
    }
    $path = '/tmp/static-wordpress-login';
    if (!file_exists($path) || !hash_equals(file_get_contents($path), (string) $_GET['static_wordpress_login'])) {
        status_header(403);
        exit('Invalid local login token');
    }
    unlink($path);
    $users = get_users(array('role' => 'administrator', 'number' => 1));
    if (!$users) {
        status_header(403);
        exit('No WordPress administrator in backup');
    }
    wp_set_auth_cookie($users[0]->ID, true);
    echo 'Logged in';
    exit;
});

// A token outside wp-content survives PHP request boundaries, without being backed up.
add_filter('query', function ($query) {
    if (!defined('STATIC_WORDPRESS_CHECKPOINT') && preg_match('/^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/i', $query)) {
        file_put_contents('/tmp/static-wordpress-dirty', bin2hex(random_bytes(12)));
    }
    return $query;
});

// The site's cms.config.json, written by the editor at startup.
function static_wordpress_config() {
    static $config = null;
    if ($config === null) {
        $config = file_exists('/tmp/static-wordpress-config.json') ? json_decode(file_get_contents('/tmp/static-wordpress-config.json'), true) : null;
        $config = is_array($config) ? $config : array('sections' => array(), 'fieldGroups' => array());
    }
    return $config;
}

function static_wordpress_fields($config) {
    $fields = array();
    foreach ((array) ($config['fieldGroups'] ?? array()) as $group) {
        foreach ((array) $group['fields'] as $field) {
            $fields[$field['key']] = $field;
        }
    }
    return $fields;
}

// Preserve source ACF fields. Also offer a small native editor for the configured fields when ACF is absent.
add_action('add_meta_boxes', function () {
    if (function_exists('acf_add_local_field_group')) {
        return;
    }
    foreach ((array) (static_wordpress_config()['fieldGroups'] ?? array()) as $index => $group) {
        add_meta_box('static-wordpress-fields-' . $index, $group['title'], function ($post) use ($group) {
            wp_nonce_field('static_wordpress_fields', 'static_wordpress_fields_nonce');
            foreach ($group['fields'] as $field) {
                $name = 'static_wordpress_' . $field['key'];
                $value = get_post_meta($post->ID, $field['key'], true);
                if ($field['type'] === 'checkboxes') {
                    $selected = (array) $value;
                    echo '<p>' . esc_html($field['label']) . '</p>';
                    foreach ($field['options'] as $option) {
                        echo '<label style="display:inline-block;margin-right:12px"><input type="checkbox" name="' . esc_attr($name) . '[]" value="' . esc_attr($option) . '" ' . checked(in_array($option, $selected, true), true, false) . '>' . esc_html($option) . '</label>';
                    }
                } elseif ($field['type'] === 'textarea') {
                    echo '<p><label>' . esc_html($field['label']) . '<br><textarea style="width:100%" rows="3" name="' . esc_attr($name) . '">' . esc_textarea((string) $value) . '</textarea></label></p>';
                } else {
                    echo '<p><label>' . esc_html($field['label']) . '<br><input style="width:100%" type="' . ($field['type'] === 'url' ? 'url' : 'text') . '" name="' . esc_attr($name) . '" value="' . esc_attr((string) $value) . '"></label></p>';
                }
            }
        }, 'post');
    }
});

add_action('save_post_post', function ($post_id) {
    if (!isset($_POST['static_wordpress_fields_nonce']) || !wp_verify_nonce(sanitize_text_field(wp_unslash($_POST['static_wordpress_fields_nonce'])), 'static_wordpress_fields') || !current_user_can('edit_post', $post_id) || wp_is_post_revision($post_id)) {
        return;
    }
    foreach (static_wordpress_fields(static_wordpress_config()) as $key => $field) {
        $name = 'static_wordpress_' . $key;
        if ($field['type'] === 'checkboxes') {
            $values = isset($_POST[$name]) ? array_map('sanitize_text_field', (array) wp_unslash($_POST[$name])) : array();
            update_post_meta($post_id, $key, array_values(array_intersect($values, $field['options'])));
        } elseif (isset($_POST[$name])) {
            $value = wp_unslash($_POST[$name]);
            update_post_meta($post_id, $key, $field['type'] === 'url' ? esc_url_raw($value) : ($field['type'] === 'textarea' ? sanitize_textarea_field($value) : sanitize_text_field($value)));
        }
    }
});

function static_wordpress_database_path() {
    global $wpdb;
    if (method_exists($wpdb, 'get_driver')) {
        $driver = $wpdb->get_driver();
        if (method_exists($driver, 'get_sqlite_pdo')) {
            $rows = $driver->get_sqlite_pdo()->query('PRAGMA database_list')->fetchAll(PDO::FETCH_ASSOC);
            foreach ($rows as $row) {
                if ($row['name'] === 'main') {
                    return $row['file'];
                }
            }
        }
    }
    if (defined('FQDB')) {
        return FQDB;
    }
    if (defined('DB_DIR') && defined('DB_FILE')) {
        return rtrim(DB_DIR, '/') . '/' . DB_FILE;
    }
    throw new RuntimeException('Cannot locate the Playground SQLite database');
}

function static_wordpress_capture($config) {
    global $wp_version;
    $records = array();
    $links = array();
    $keys = array_keys(static_wordpress_fields($config));
    $site = rtrim($config['siteUrl'], '/');
    foreach ($config['sections'] as $section_config) {
        $section = $section_config['name'];
        $slug = $section_config['category'];
        $term = get_term_by('slug', $slug, 'category');
        if (!$term) {
            throw new RuntimeException('Missing category: ' . $slug . '. Configure category slugs before syncing.');
        }
        $posts = get_posts(array('post_type' => 'post', 'post_status' => 'publish', 'posts_per_page' => -1, 'cat' => $term->term_id, 'orderby' => 'date', 'order' => 'DESC'));
        foreach ($posts as $post) {
            if ($section_config['path'] !== null) {
                $public = $site . $section_config['path'] . $post->post_name . '/';
                $links[get_permalink($post)] = $public;
                $links[site_url('/?p=' . $post->ID)] = $public;
            }
            $GLOBALS['post'] = $post;
            setup_postdata($post);
            $fields = function_exists('get_fields') ? (get_fields($post->ID) ?: array()) : array();
            foreach ($keys as $key) {
                if (!isset($fields[$key])) {
                    $fields[$key] = get_post_meta($post->ID, $key, true);
                }
            }
            $fields = array_intersect_key($fields, array_flip($keys));
            $author = get_userdata((int) $post->post_author);
            $records[] = array(
                'id' => $post->ID, 'section' => $section, 'status' => 'publish',
                'slug' => $post->post_name, 'date' => $post->post_date, 'modified' => $post->post_modified,
                'title' => array('rendered' => get_the_title($post)),
                'excerpt' => array('rendered' => apply_filters('the_excerpt', get_the_excerpt($post))),
                'content' => array('rendered' => apply_filters('the_content', $post->post_content)),
                'acf' => $fields,
                'tags' => wp_get_post_tags($post->ID, array('fields' => 'names')),
                'author' => $author ? $author->display_name : null,
                'featured_media_url' => get_the_post_thumbnail_url($post, 'full') ?: null
            );
        }
        wp_reset_postdata();
    }
    // WP REST dates contain T. Keep the source's local publication date/time.
    foreach ($records as &$record) {
        $record['date'] = str_replace(' ', 'T', $record['date']);
        $record['modified'] = str_replace(' ', 'T', $record['modified']);
    }
    unset($record);
    $inventory = array();
    $root = WP_CONTENT_DIR;
    foreach (array('uploads', 'plugins', 'themes', 'mu-plugins', 'languages') as $directory) {
        if (!is_dir($root . '/' . $directory)) {
            continue;
        }
        $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root . '/' . $directory, FilesystemIterator::SKIP_DOTS));
        foreach ($iterator as $file) {
            if ($file->isFile() && !$file->isLink()) {
                $relative = substr($file->getPathname(), strlen($root) + 1);
                if (strpos($relative, 'mu-plugins/static-wordpress') === 0 || preg_match('#^mu-plugins/(0-playground\.php|sqlite-database-integration)(/|$)#', $relative)) {
                    continue;
                }
                $inventory[] = array('path' => $relative, 'size' => $file->getSize());
            }
        }
    }
    $path = static_wordpress_database_path();
    $target = '/tmp/static-wordpress.sqlite';
    if (file_exists($target)) {
        unlink($target);
    }
    // VACUUM INTO is a consistent database backup, including committed WAL contents.
    $pdo = new PDO('sqlite:' . $path);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->exec("VACUUM INTO '" . str_replace("'", "''", $target) . "'");
    $uploads = wp_upload_dir();
    return array(
        'wordpress' => $wp_version,
        'databasePath' => $path,
        'files' => $inventory,
        'records' => $records,
        'uploadBase' => $uploads['baseurl'],
        'siteUrl' => site_url(),
        'virtual' => static_wordpress_virtual()['files'],
        'links' => $links,
        'dirtyToken' => file_exists('/tmp/static-wordpress-dirty') ? file_get_contents('/tmp/static-wordpress-dirty') : ''
    );
}

// Site Health: drop checks that cannot apply to WordPress running in a browser tab with no web server,
// outbound networking, WP-Cron, page cache or updater. Core and plugin updates are managed by pinned runtime upgrades.
add_filter('site_status_tests', function ($tests) {
    foreach (array('background_updates', 'loopback_requests', 'https_status', 'dotorg_communication', 'authorization_header', 'scheduled_events', 'persistent_object_cache', 'page_cache', 'available_updates_disk_space') as $test) {
        unset($tests['direct'][$test], $tests['async'][$test]);
    }
    return $tests;
});
