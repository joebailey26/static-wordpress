import { gunzipSync } from 'node:zlib'
import { openArchive } from './zip-reader.ts'
import type { Archive } from './zip-reader.ts'
import { readDump } from './mysql-dump.ts'

// The WordPress tables a backup is read from, as rows of their SQL columns.
/* eslint-disable @typescript-eslint/naming-convention -- WordPress column names */
export interface PostRow {
  ID: string
  post_author: string
  post_date: string
  post_date_gmt: string
  post_content: string
  post_title: string
  post_excerpt: string
  post_status: string
  post_name: string
  post_parent: string
  guid: string
  post_type: string
}

export interface PostMetaRow {
  post_id: string
  meta_key: string
  meta_value: string
}

export interface TermRow {
  term_id: string
  name: string
  slug: string
}

export interface TermTaxonomyRow {
  term_taxonomy_id: string
  term_id: string
  taxonomy: string
  count: string
}

export interface TermRelationshipRow {
  object_id: string
  term_taxonomy_id: string
}

export interface UserRow {
  ID: string
  user_login: string
  display_name: string
}

export interface OptionRow {
  option_name: string
  option_value: string
}

export interface WordPressData {
  posts: PostRow[]
  postmeta: PostMetaRow[]
  terms: TermRow[]
  term_taxonomy: TermTaxonomyRow[]
  term_relationships: TermRelationshipRow[]
  users: UserRow[]
  options: OptionRow[]
}
/* eslint-enable @typescript-eslint/naming-convention */

// readDump keeps exactly these tables, with the columns of their CREATE TABLE statements.
export const wordPressData = (sql: string, prefix: string) => readDump(sql, prefix) as unknown as WordPressData

export async function loadBackup(path: string): Promise<{ archive: Archive, data: WordPressData, contentPrefix: string }> {
  const archive = await openArchive(path)
  try {
    const names = [...archive.entries.keys()]
    const configName = names.find(name => /(^|\/)wp-config\.php$/.test(name))
    if (!configName) throw new Error('Missing backup entry: wp-config.php')
    const config = (await archive.read(configName, 1024 * 1024)).toString('utf8')
    const prefix = config.match(/\$table_prefix\s*=\s*['"]([^'"]+)['"]/)?.[1]
    if (!prefix || !/^[a-zA-Z0-9_]+$/.test(prefix)) throw new Error('Cannot identify WordPress table prefix')
    const sqlName = names.find(name => /\.sql(\.gz)?$/.test(name))
    if (!sqlName) throw new Error('No SQL database in backup')
    const compressed = await archive.read(sqlName)
    const sql = (sqlName.endsWith('.gz') ? gunzipSync(compressed, { maxOutputLength: 512 * 1024 * 1024 }) : compressed).toString('utf8')

    return { archive, data: wordPressData(sql, prefix), contentPrefix: `${configName.slice(0, -'wp-config.php'.length)}wp-content/` }
  } catch (error) { archive.close(); throw error }
}
