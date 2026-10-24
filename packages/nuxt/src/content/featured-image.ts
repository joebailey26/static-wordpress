import { transformImageUrl } from '../images.ts'

// Featured images are used for og:image, which needs an absolute URL; 1200px suits social cards.
const featuredImageWidth = 1200

export default function getFeaturedImageUrl (mediaUrl: unknown, siteUrl: string): string | null {
  if (!mediaUrl) {
    return null
  }
  // CMS records carry the absolute media URL (served from R2 by the CMS); anything else cannot be resolved.
  if (typeof mediaUrl !== 'string' || !/^https?:\/\//.test(mediaUrl)) {
    throw new Error(`Unsupported featured media reference: ${String(mediaUrl)}`)
  }

  return transformImageUrl(mediaUrl, featuredImageWidth, { origin: siteUrl })
}
