import { load } from 'cheerio'
import type { CheerioAPI } from 'cheerio'

interface RelIcon {
  href: string
  size: string[]
  type: string
}

export default class FetchFavicon {
  url: string
  body?: string
  // Replaced by the fetched page
  $: CheerioAPI = load('')

  constructor (url: string) {
    this.url = url
  }

  isFullUrl (url: string): URL | false {
    try {
      const parsedUrl = new URL(url)

      return parsedUrl
    } catch {
      // invalid url OR local path
      return false
    }
  }

  async fetch (): Promise<void> {
    const response = await fetch(this.url, { signal: AbortSignal.timeout(10000) })
    if (!response.ok) {
      return Promise.reject(new Error('Could not fetch webpage'))
    }
    const body = await response.text()
    this.body = body

    this.$ = load(body)

    return Promise.resolve()
  }

  normalizePath (path: string): string {
    let actualUrl = this.url
    const canonical = this.$('link[rel~=\'canonical\']')
    if (canonical.length) {
      actualUrl = canonical[0].attribs.href
    }
    const u = new URL(path, actualUrl)

    return u.href
  }

  findRelIcons (): RelIcon[] {
    const results: RelIcon[] = []
    const icons = this.$('link[rel~=\'icon\']')

    for (const icon of icons) {
      const sizesStr = icon.attribs.sizes
      const typeStr = icon.attribs.type
      let type
      if (typeStr) {
        if (typeStr.startsWith('image/') || typeStr.startsWith('img/')) {
          type = typeStr.split('/')[1]
        }
      }

      results.push({
        href: this.normalizePath(icon.attribs.href),
        size: sizesStr ? sizesStr.split('x') : ['0', '0'],
        type: type || 'auto'
      })
    }

    // TODO deprioritize "image/x-icon" if the sizes are the same
    return results.sort((a, b) => {
      const ordering = Number(b.size[0]) - Number(a.size[0])
      if (!Number.isNaN(ordering)) { return ordering } else if (b.size[0].toLowerCase() === 'any') { return 1 } else { return -1 }
    })
  }

  findAppleTouchIcon (): string | undefined {
    const icon = this.$('link[rel~=\'apple-touch-icon\']')
    if (icon.length) {
      return this.normalizePath(icon[0].attribs.href)
    }

    const precomposedIcon = this.$('link[rel~=\'apple-touch-icon-precomposed\']')
    if (precomposedIcon.length) {
      return this.normalizePath(precomposedIcon[0].attribs.href)
    }
  }

  async getFavicon (): Promise<string | null> {
    try {
      await this.fetch()
    } catch {
      return null
    }
    const appleTouchIconHref = this.findAppleTouchIcon()
    if (appleTouchIconHref) {
      return appleTouchIconHref
    }

    const relIcons = this.findRelIcons()
    if (relIcons.length) {
      return relIcons[0].href
    }

    return null
  }
}
