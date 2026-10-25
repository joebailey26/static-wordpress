import { createError, defineEventHandler, getRouterParam } from 'h3'
import { getSection } from '../content'
import type { SerialisedCmsPost } from '../../types'

export default defineEventHandler((event): SerialisedCmsPost => {
  const slug = getRouterParam(event, 'slug')
  const post = getSection(event).flat().find((item) => item.slug === slug)
  if (!post) {
    throw createError({ statusCode: 404, statusMessage: 'Post not found' })
  }

  return post
})
