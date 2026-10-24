import { createError, getRouterParam } from 'h3'
import type { H3Event } from 'h3'
import content from '#cms-content'
import type { SerialisedCmsPost } from '../types'

export function getSection (event: H3Event): SerialisedCmsPost[][] {
  const section = getRouterParam(event, 'section')
  if (section === undefined || !Object.hasOwn(content, section)) {
    throw createError({ statusCode: 404, statusMessage: 'Section not found' })
  }

  return content[section]
}
