import he from 'he'
import { load } from 'cheerio'
import striptags from 'striptags'
import { fetchCmsContent } from '../feed.ts'
import type { CmsFetch, CmsSection, ContentRecord } from '../feed.ts'
import type { CmsContent, SerialisedCmsPost } from '../runtime/types.ts'
import { removeLinksAroundImages, prepareImages } from './convert-images.ts'
import prepareVideos from './convert-videos.ts'
import addFaviconToLinks from './convert-links.ts'
import syntaxHighlightCodeWithTorchlight from './convert-code.ts'
import type { TorchlightOptions } from './convert-code.ts'
import getFeaturedImageUrl from './featured-image.ts'

export interface LoadContentOptions {
  apiUrl?: string
  token?: string
  siteUrl: string
  perPage: number
  sections: Record<string, { perPage?: number } | undefined>
  productionBranch: string
  imageSizes?: string
  favicons: boolean
  torchlight: TorchlightOptions | false
  cacheDirectory: string
}

export interface LoadedContent {
  content: CmsContent
  sections: CmsSection[]
}

// A post before prepareWordPressContent resolves its featured image and prepares its HTML.
type UnpreparedPost = Omit<SerialisedCmsPost, 'featuredMedia'> & { featuredMedia: unknown }

function getReadingTime (content: string, isHtml = false): number {
  const avgWordsPerMin = 200
  let contentToProcess = content
  if (isHtml) {
    const $ = load(contentToProcess, null, false)
    $('pre').remove()
    contentToProcess = $.html()
    contentToProcess = striptags(contentToProcess)
  }
  const count = (contentToProcess.match(/\w+/g) || []).length

  return Math.ceil(count / avgWordsPerMin)
}

const isoDate = (value: string) => new Date(value.substring(0, value.indexOf('T'))).toISOString()

export function getRequiredInfoFromPosts (posts: ContentRecord[]): UnpreparedPost[] {
  return posts.map(({ title, excerpt, slug, date, modified, content, acf, tags, author, featured_media: featuredMedia, featured_media_url: featuredMediaUrl }) => {
    const convertedExcerpt = excerpt.rendered.replace(/(<p class="link-more">.*<\/p>)/g, '').replace(' &hellip; ', '&hellip;').trim()

    return {
      title: he.decode(title.rendered),
      excerpt: {
        raw: convertedExcerpt,
        plain: he.decode(striptags(convertedExcerpt))
      },
      slug,
      rawDate: date,
      // Serialised as ISO strings; the composables turn them back into Dates.
      date: isoDate(date),
      modified: modified ? isoDate(modified) : null,
      content: content.rendered.trim(),
      readingTime: getReadingTime(content.rendered, true),
      acf: acf || {},
      tags: tags || [],
      author: author || null,
      // The original CMS media URL; featuredMedia becomes the absolute og:image URL.
      featuredMediaUrl: featuredMediaUrl || null,
      featuredMedia: featuredMediaUrl || featuredMedia || null
    }
  })
}

async function prepareWordPressContent (post: UnpreparedPost, options: LoadContentOptions): Promise<SerialisedCmsPost> {
  // The order matters here
  const featuredMedia = getFeaturedImageUrl(post.featuredMedia, options.siteUrl)
  let content = removeLinksAroundImages(post.content)
  content = prepareImages(content, { sizes: options.imageSizes })
  content = prepareVideos(content)
  if (options.favicons) {
    content = await addFaviconToLinks(content)
  }
  if (options.torchlight) {
    content = await syntaxHighlightCodeWithTorchlight(content, { ...options.torchlight, cacheDirectory: options.cacheDirectory, productionBranch: options.productionBranch })
  }

  return { ...post, featuredMedia, content }
}

const concurrency = 4

// Runs `task` over every item with a few in flight at once, keeping the results in order; the first failure rejects.
async function mapConcurrently<T, R> (items: T[], task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await task(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))

  return results
}

// Fetches every section from the CMS feed, paginated as the site shows them, and prepares post content.
export async function loadCmsContent (options: LoadContentOptions, fetchImpl: CmsFetch = fetch): Promise<LoadedContent> {
  const { sections, sectionInfo } = await fetchCmsContent({
    baseUrl: options.apiUrl,
    token: options.token,
    fetchImpl,
    perPage: (section) => options.sections[section]?.perPage || options.perPage
  })
  const state: CmsContent = {}
  for (const { name } of sectionInfo) {
    const pages = sections[name].map(getRequiredInfoFromPosts)
    const prepared = await mapConcurrently(pages.flat(), (post) => prepareWordPressContent(post, options))
    // Put the prepared posts back into their pages
    let offset = 0
    state[name] = pages.map((page) => prepared.slice(offset, (offset += page.length)))
  }

  return { content: state, sections: sectionInfo }
}
