import { load } from 'cheerio'
import { defaultImageWidth, imageSrcset, transformImageUrl } from '../images.js'

export function removeLinksAroundImages (postContent) {
  const regex = /<img.*?>/g
  const matches = postContent.match(regex)
  if (!matches) {
    return postContent
  }
  const $ = load(postContent, null, false)

  // Replace all links around images with just the image
  $('a').each((i, elem) => {
    if ($(elem).has('img').length) {
      $(elem).replaceWith($(elem).find('img'))
    }
  })

  // Return the blog post html
  return $.html()
}

// CMS media (R2) is resized through Cloudflare Image Transformations where enabled, and wrapped in the markup the post styles expect.
// `sizes` describes the content column; the default suits a 1140px container.
export function prepareImages (postContent, { sizes = '(min-width: 1200px) 1140px, 100vw' } = {}) {
  const regex = /<img.*?>/g
  const matches = postContent.match(regex)
  if (!matches) {
    return postContent
  }
  const $ = load(postContent, null, false)

  // add class to <figure> elements that contain an <img>
  $('figure:has(img)').addClass('wp-block-image')

  $('img').each((i, elem) => {
    const $img = $(elem)
    const img = $('<img>')
    const src = $img.attr('src')
    const srcset = imageSrcset(src, $img.attr('width'))
    if (srcset) {
      const intrinsicWidth = Number.parseInt($img.attr('width'), 10)
      img.attr('src', transformImageUrl(src, intrinsicWidth > 0 ? Math.min(defaultImageWidth, intrinsicWidth) : defaultImageWidth))
      img.attr('srcset', srcset)
      img.attr('sizes', sizes)
    } else {
      img.attr('src', src)
    }
    img.attr('decoding', 'async')
    img.attr('loading', 'lazy')
    img.attr('alt', $img.attr('alt') || '')
    for (const dimension of ['width', 'height']) {
      if ($img.attr(dimension)) {
        img.attr(dimension, $img.attr(dimension))
      }
    }
    $img.replaceWith($('<picture>').append(img))
  })

  // Return the blog post html
  return $.html()
}
