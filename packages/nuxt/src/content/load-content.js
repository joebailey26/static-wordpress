import he from 'he'
import { load } from 'cheerio'
import striptags from 'striptags'
import { fetchCmsContent } from '../feed.js'
import { removeLinksAroundImages, prepareImages } from './convert-images.js'
import prepareVideos from './convert-videos.js'
import addFaviconToLinks from './convert-links.js'
import syntaxHighlightCodeWithTorchlight from './convert-code.js'
import getFeaturedImageUrl from './featured-image.js'

function getReadingTime (content, isHtml = false) {
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

const isoDate = (value) => (value ? new Date(value.substring(0, value.indexOf('T'))).toISOString() : null)

export function getRequiredInfoFromPosts (posts) {
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
      modified: isoDate(modified),
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

async function prepareWordPressContent (post, options) {
  // The order matters here
  post.featuredMedia = getFeaturedImageUrl(post.featuredMedia, options.siteUrl)
  post.content = removeLinksAroundImages(post.content)
  post.content = prepareImages(post.content, { sizes: options.imageSizes })
  post.content = prepareVideos(post.content)
  if (options.favicons) {
    post.content = await addFaviconToLinks(post.content)
  }
  if (options.torchlight) {
    post.content = await syntaxHighlightCodeWithTorchlight(post.content, { ...options.torchlight, cacheDirectory: options.cacheDirectory, productionBranch: options.productionBranch })
  }

  return post
}

const concurrency = 4

// Runs `task` over every item with a few in flight at once; the first failure rejects.
async function mapConcurrently (items, task) {
  const queue = [...items]
  const worker = async () => {
    while (queue.length) {
      await task(queue.shift())
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
}

// Fetches every section from the CMS feed, paginated as the site shows them, and prepares post content.
export async function loadCmsContent (options, fetchImpl = fetch) {
  const { sections, sectionInfo } = await fetchCmsContent({
    baseUrl: options.apiUrl,
    token: options.token,
    fetchImpl,
    perPage: (section) => options.sections[section]?.perPage || options.perPage
  })
  const state = {}
  for (const { name } of sectionInfo) {
    state[name] = sections[name].map(getRequiredInfoFromPosts)
    await mapConcurrently(state[name].flat(), (post) => prepareWordPressContent(post, options))
  }

  return { content: state, sections: sectionInfo }
}
