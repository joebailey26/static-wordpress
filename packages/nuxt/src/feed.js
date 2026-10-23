// Fetches every section of one pinned CMS revision. This runs only during Nuxt generation; never expose the token in runtimeConfig.
export async function fetchCmsContent ({ baseUrl, token, fetchImpl = fetch, perPage = 10 }) {
  if (!baseUrl || !token) { throw new Error('CMS_API_URL and CMS_BUILD_TOKEN are required for the CMS content source') }
  const root = new URL(baseUrl)
  if (root.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(root.hostname)) { throw new Error('CMS_API_URL must use HTTPS') }
  const get = async (path) => {
    const response = await fetchImpl(new URL(path, root), { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(60000) })
    if (!response.ok) {
      const challenge = response.headers?.get('cf-mitigated') === 'challenge' ? ' (Cloudflare blocked the build with an interactive challenge)' : ''
      throw new Error(`CMS content request failed: HTTP ${response.status}${challenge}`)
    }
    return response.json()
  }
  const manifest = await get('/api/content/manifest')
  if (typeof manifest.revision !== 'string' || !manifest.counts || typeof manifest.counts !== 'object') { throw new Error('Invalid CMS manifest') }
  // The CMS lists its sections (name, path, label) from the site's cms.config.json.
  const sectionInfo = Array.isArray(manifest.sections) ? manifest.sections : Object.keys(manifest.counts).map((name) => ({ name, path: `/${name}/` }))
  const pageSize = (section) => (typeof perPage === 'function' ? perPage(section) : perPage)
  const sections = {}
  for (const { name: section } of sectionInfo) {
    const total = manifest.counts[section]
    const size = pageSize(section)
    if (!Number.isSafeInteger(total) || total < 0) { throw new Error(`Invalid CMS ${section} count`) }
    const pages = []
    const seen = new Set()
    for (let page = 1; page <= Math.max(1, Math.ceil(total / size)); page++) {
      const payload = await get(`/api/content/posts?revision=${encodeURIComponent(manifest.revision)}&section=${encodeURIComponent(section)}&page=${page}&per_page=${size}`)
      if (payload.revision !== manifest.revision || payload.total !== total || payload.totalPages !== Math.ceil(total / size) || !Array.isArray(payload.items)) { throw new Error(`Inconsistent CMS ${section} revision or pagination`) }
      const expected = Math.min(size, Math.max(0, total - (page - 1) * size))
      if (payload.items.length !== expected) { throw new Error(`Incomplete CMS ${section} page ${page}`) }
      for (const post of payload.items) {
        if (post.status !== 'publish' || post.section !== section || !post.slug || seen.has(post.slug) || !post.title || !post.excerpt || !post.content) { throw new Error(`Invalid CMS ${section} record`) }
        seen.add(post.slug)
      }
      pages.push(payload.items)
    }
    // Keep an empty first page so page components can show an empty section.
    sections[section] = pages
  }

  return { revision: manifest.revision, sections, sectionInfo }
}
