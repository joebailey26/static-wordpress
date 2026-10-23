import { defineEventHandler } from 'h3'
import { getSection } from '../content.js'

// The paginated post summaries for an index page, without the post content.
export default defineEventHandler((event) => getSection(event).map((page) => page.map(({ content: _content, rawDate: _rawDate, ...summary }) => summary)))
