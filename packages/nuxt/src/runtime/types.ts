// The posts the module prepares at build time and the shapes pages receive through useCmsIndex and useCmsPost.

// A prepared post as the /_content routes serialise it, with ISO date strings.
export interface SerialisedCmsPost {
  title: string
  excerpt: {
    // HTML, without WordPress' "Continue reading" link
    raw: string
    plain: string
  }
  slug: string
  // The CMS date as published
  rawDate: string
  date: string
  modified: string | null
  // HTML, with images, videos, links and code prepared
  content: string
  // Minutes, at 200 words a minute
  readingTime: number
  acf: Record<string, unknown>
  tags: string[]
  author: string | null
  // The original CMS media URL
  featuredMediaUrl: string | null
  // The absolute 1200px og:image URL
  featuredMedia: string | null
}

// Every section's posts, paginated as the site shows them. This is the #cms-content virtual module.
export type CmsContent = Record<string, SerialisedCmsPost[][]>

// The index routes leave out the post content unless asked for it, and never send rawDate.
export type SerialisedCmsPostSummary = Omit<SerialisedCmsPost, 'content' | 'rawDate'> & { content?: string }

type WithDates<T> = Omit<T, 'date' | 'modified'> & { date: Date, modified: Date | null }

// A post as useCmsPost returns it.
export type CmsPost = WithDates<SerialisedCmsPost>

// A post as useCmsIndex returns it: no content, unless the index asked for it with `content: true`.
export type CmsPostSummary = WithDates<Omit<SerialisedCmsPost, 'content' | 'rawDate'>>
export type CmsPostSummaryWithContent = CmsPostSummary & { content: string }

// The summaries useCmsIndex returns, with the post content when the index asked for it.
export type CmsIndexPost<WithContent extends boolean> = WithContent extends true ? CmsPostSummaryWithContent : CmsPostSummary

export interface UseCmsIndexOptions<WithContent extends boolean> {
  content?: WithContent
}

export interface UseCmsPostOptions {
  // The message of the 404 when the section has no post with that slug.
  notFound?: string
}
