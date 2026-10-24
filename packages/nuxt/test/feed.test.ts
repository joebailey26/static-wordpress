import test from 'node:test'
import assert from 'node:assert/strict'
import * as feed from '../src/feed.ts'

const post = (section: string | null, slug: string) => ({ section, slug, status: 'publish', title: { rendered: slug }, content: { rendered: '<p>Hello</p>' }, excerpt: { rendered: '' } })

test('Nuxt loads every section from one pinned revision, including empty sections', async () => {
  const urls: URL[] = []
  const result = await feed.fetchCmsContent({ baseUrl: 'https://cms.example.com', token: 'private', perPage: 1, async fetchImpl(url, options) {
    urls.push(url)
    assert.equal(options.headers.Authorization, 'Bearer private')
    if (url.pathname.endsWith('manifest')) return Response.json({ revision: 'fixed-revision', counts: { blog: 2, projects: 0 } })
    assert.equal(url.searchParams.get('revision'), 'fixed-revision')
    const section = url.searchParams.get('section')

    return Response.json({ revision: 'fixed-revision', total: section === 'blog' ? 2 : 0, totalPages: section === 'blog' ? 2 : 0, items: section === 'blog' ? [post(section, `post-${url.searchParams.get('page')}`)] : [] })
  } })
  assert.equal(urls.length, 4)
  assert.equal(result.sections.blog.length, 2)
  assert.deepEqual(result.sections.projects, [[]])
})

test('Nuxt fails on authorization errors, expired revisions and incomplete pages', async () => {
  for (const status of [401, 410, 500]) {
    await assert.rejects(feed.fetchCmsContent({ baseUrl: 'https://cms.example.com', token: 'private', fetchImpl: async () => new Response('', { status }) }), new RegExp(`HTTP ${status}`))
  }
  await assert.rejects(feed.fetchCmsContent({ baseUrl: 'https://cms.example.com', token: 'private', fetchImpl: async url => url.pathname.endsWith('manifest') ? Response.json({ revision: 'fixed', counts: { blog: 1, projects: 0 } }) : Response.json({ revision: 'fixed', total: 1, totalPages: 1, items: [] }) }), /Incomplete/)
})

test('the manifest section list decides which sections load, with per-section page sizes', async () => {
  const sections = [{ name: 'blog', path: '/blog/' }, { name: 'testimonials', path: null }]
  const requested: string[] = []
  const result = await feed.fetchCmsContent({ baseUrl: 'https://cms.example.com', token: 'private', perPage: section => section === 'testimonials' ? 100 : 1, async fetchImpl(url) {
    if (url.pathname.endsWith('manifest')) return Response.json({ revision: 'fixed', counts: { blog: 1, testimonials: 2 }, sections })
    const section = url.searchParams.get('section')
    requested.push(`${section}:${url.searchParams.get('per_page')}`)
    const total = section === 'blog' ? 1 : 2

    return Response.json({ revision: 'fixed', total, totalPages: section === 'blog' ? 1 : 1, items: Array.from({ length: total }, (_, index) => post(section, `${section}-${index}`)) })
  } })
  assert.deepEqual(requested, ['blog:1', 'testimonials:100'])
  assert.deepEqual(result.sectionInfo, sections)
  assert.equal(result.sections.testimonials[0].length, 2)
})
