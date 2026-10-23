import { createError, useAsyncData } from '#imports'

// CMS content is loaded at build time by @joebailey26/nuxt-static-wordpress and served by its /_content routes.
// Prerendering stores each result in the page payload, so the static site never calls those routes.

const withDates = (post) => ({ ...post, date: new Date(post.date), modified: post.modified ? new Date(post.modified) : null })

// The paginated post summaries of a section. `content: true` includes each post's HTML, for sections shown
// whole on another page (testimonials, for example).
export function useCmsIndex (section, { content = false } = {}) {
  return useAsyncData(content ? `cms-${section}-content` : `cms-${section}`, () => $fetch(`/_content/${section}`, { query: content ? { content: 'true' } : {} }), {
    transform: (pages) => pages.map((page) => page.map(withDates)),
    default: () => []
  })
}

// A single post, or a fatal 404 when the section has no post with that slug.
export async function useCmsPost (section, slug, { notFound = 'Post not found' } = {}) {
  const { data, error } = await useAsyncData(`cms-${section}-${slug}`, () => $fetch(`/_content/${section}/${encodeURIComponent(slug)}`), {
    transform: withDates
  })
  if (error.value || !data.value) {
    throw createError({ status: 404, message: notFound, fatal: true })
  }

  return data
}
