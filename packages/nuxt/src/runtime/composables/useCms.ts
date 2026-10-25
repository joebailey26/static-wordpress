import type { Ref } from 'vue'
import type { AsyncData, NuxtError } from '#app'
import { createError, useAsyncData } from '#imports'
import type { CmsIndexPost, CmsPost, SerialisedCmsPost, SerialisedCmsPostSummary, UseCmsIndexOptions, UseCmsPostOptions } from '../types'

// CMS content is loaded at build time by @joebailey26/nuxt-static-wordpress and served by its /_content routes.
// Prerendering stores each result in the page payload, so the static site never calls those routes.

const withDates = <T extends { date: string, modified: string | null }>(post: T): Omit<T, 'date' | 'modified'> & { date: Date, modified: Date | null } => ({ ...post, date: new Date(post.date), modified: post.modified ? new Date(post.modified) : null })

// The paginated post summaries of a section. `content: true` includes each post's HTML, for sections shown
// whole on another page (testimonials, for example).
export function useCmsIndex<WithContent extends boolean = false> (section: string, options: UseCmsIndexOptions<WithContent> = {}): AsyncData<CmsIndexPost<WithContent>[][], NuxtError | undefined> {
  const content = options.content === true

  return useAsyncData(content ? `cms-${section}-content` : `cms-${section}`, () => $fetch<SerialisedCmsPostSummary[][]>(`/_content/${section}`, { query: content ? { content: 'true' } : {} }), {
    // The route includes the content exactly when `content` is true.
    transform: (pages) => pages.map((page) => page.map(withDates)) as CmsIndexPost<WithContent>[][],
    default: () => []
  })
}

// A single post, or a fatal 404 when the section has no post with that slug.
export async function useCmsPost (section: string, slug: string, { notFound = 'Post not found' }: UseCmsPostOptions = {}): Promise<Ref<CmsPost>> {
  const { data, error } = await useAsyncData(`cms-${section}-${slug}`, () => $fetch<SerialisedCmsPost>(`/_content/${section}/${encodeURIComponent(slug)}`), {
    transform: withDates
  })
  if (error.value || !data.value) {
    throw createError({ status: 404, message: notFound, fatal: true })
  }

  // useAsyncData types data as possibly undefined (before it loads, or after clear()); the 404 above rules that out here.
  return data as Ref<CmsPost>
}
