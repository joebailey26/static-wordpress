import { defineEventHandler, getQuery } from 'h3'
import { getSection } from '../content.js'

// The paginated posts of an index page: summaries without the post content, unless ?content=true.
export default defineEventHandler((event) => {
  const withContent = getQuery(event).content === 'true'

  return getSection(event).map((page) => page.map(({ content, rawDate: _rawDate, ...summary }) => (withContent ? { ...summary, content } : summary)))
})
