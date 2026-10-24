// In a site, Nuxt's generated types register Nitro's types with @nuxt/schema (see @nuxt/nitro-server/augments).
// The module is type-checked without them, so it registers the instance and config types its hooks use.
import type { Nitro, NitroConfig } from 'nitropack/types'

declare module '@nuxt/schema' {
  interface NitroTypes {
    instance: Nitro
    config: NitroConfig
  }
}
