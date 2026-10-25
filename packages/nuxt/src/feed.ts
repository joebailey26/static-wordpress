// The feed the CMS Worker serves to builds: /api/content/manifest and /api/content/posts.

// A CMS section from the site's cms.config.json. Sections whose path is null are loaded but get no routes.
export interface CmsSection {
  name: string
  path: string | null
  label?: string
}

// A published post as the CMS feed serves it (the WordPress REST shape). The CMS validates each record when it publishes.
/* eslint-disable @typescript-eslint/naming-convention -- the feed's wire format */
export interface ContentRecord {
  title: { rendered: string }
  excerpt: { rendered: string }
  content: { rendered: string }
  slug: string
  // ISO dates, e.g. 2024-01-31T09:00:00
  date: string
  modified?: string | null
  acf?: Record<string, unknown> | null
  tags?: string[]
  author?: string | null
  // The absolute media URL (served from R2 by the CMS).
  featured_media_url?: string | null
  // Older records may carry the media reference here instead; anything but an absolute URL fails the build.
  featured_media?: unknown
  status: string
  section: string
}
/* eslint-enable @typescript-eslint/naming-convention */

// Every section of one CMS revision, paginated as requested.
export interface CmsFeed {
  revision: string
  sections: Record<string, ContentRecord[][]>
  sectionInfo: CmsSection[]
}

export interface CmsFetchInit {
  headers: Record<string, string>
  redirect: 'error'
  signal: AbortSignal
}

export type CmsFetch = (url: URL, init: CmsFetchInit) => Promise<Response>

export interface FetchCmsContentOptions {
  baseUrl?: string
  token?: string
  fetchImpl?: CmsFetch
  // A page size, or one per section.
  perPage?: number | ((section: string) => number)
}

interface CmsManifest {
  revision: string
  counts: Record<string, unknown>
  sections?: CmsSection[]
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const isManifest = (value: unknown): value is CmsManifest => isRecord(value) && typeof value.revision === 'string' && isRecord(value.counts)

// The fields the build relies on; the CMS validated the rest when it published the record.
function isContentRecord (post: unknown, section: string): post is ContentRecord {
  return isRecord(post) && post.status === 'publish' && post.section === section && typeof post.slug === 'string' && post.slug !== '' && Boolean(post.title && post.excerpt && post.content)
}

// Fetches every section of one pinned CMS revision. This runs only during Nuxt generation; never expose the token in runtimeConfig.
export async function fetchCmsContent ({ baseUrl, token, fetchImpl = fetch, perPage = 10 }: FetchCmsContentOptions): Promise<CmsFeed> {
  if (!baseUrl || !token) { throw new Error('CMS_API_URL and CMS_BUILD_TOKEN are required for the CMS content source') }
  const root = new URL(baseUrl)
  if (root.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(root.hostname)) { throw new Error('CMS_API_URL must use HTTPS') }
  const get = async (path: string): Promise<unknown> => {
    const response = await fetchImpl(new URL(path, root), { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(60000) })
    if (!response.ok) {
      const challenge = response.headers?.get('cf-mitigated') === 'challenge' ? ' (Cloudflare blocked the build with an interactive challenge)' : ''
      throw new Error(`CMS content request failed: HTTP ${response.status}${challenge}`)
    }

    return response.json()
  }
  const manifest = await get('/api/content/manifest')
  if (!isManifest(manifest)) { throw new Error('Invalid CMS manifest') }
  // The CMS lists its sections (name, path, label) from the site's cms.config.json.
  const sectionInfo = Array.isArray(manifest.sections) ? manifest.sections : Object.keys(manifest.counts).map((name) => ({ name, path: `/${name}/` }))
  const pageSize = (section: string) => (typeof perPage === 'function' ? perPage(section) : perPage)
  const sections: Record<string, ContentRecord[][]> = {}
  for (const { name: section } of sectionInfo) {
    const total = manifest.counts[section]
    const size = pageSize(section)
    if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) { throw new Error(`Invalid CMS ${section} count`) }
    const pages: ContentRecord[][] = []
    const seen = new Set<string>()
    for (let page = 1; page <= Math.max(1, Math.ceil(total / size)); page++) {
      const payload = await get(`/api/content/posts?revision=${encodeURIComponent(manifest.revision)}&section=${encodeURIComponent(section)}&page=${page}&per_page=${size}`)
      if (!isRecord(payload) || payload.revision !== manifest.revision || payload.total !== total || payload.totalPages !== Math.ceil(total / size) || !Array.isArray(payload.items)) { throw new Error(`Inconsistent CMS ${section} revision or pagination`) }
      const expected = Math.min(size, Math.max(0, total - (page - 1) * size))
      if (payload.items.length !== expected) { throw new Error(`Incomplete CMS ${section} page ${page}`) }
      const records: unknown[] = payload.items
      const items: ContentRecord[] = []
      for (const post of records) {
        if (!isContentRecord(post, section) || seen.has(post.slug)) { throw new Error(`Invalid CMS ${section} record`) }
        seen.add(post.slug)
        items.push(post)
      }
      pages.push(items)
    }
    // Keep an empty first page so page components can show an empty section.
    sections[section] = pages
  }

  return { revision: manifest.revision, sections, sectionInfo }
}
