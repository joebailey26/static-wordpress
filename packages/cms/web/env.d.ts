// What the build (scripts/build.ts) provides to the editor bundle: the site's configuration and text imports.
declare const __STATIC_WORDPRESS_CONFIG__: import('../src/config.ts').SiteConfig

declare module '*.css' {
  const text: string
  export default text
}

declare module '*.php' {
  const text: string
  export default text
}

// @php-wasm/progress publishes declarations that re-export from extensionless paths, which NodeNext resolution
// cannot follow. Its tracker is the class @wp-playground/client's declarations bundle.
declare module '@php-wasm/progress' {
  export const ProgressTracker: new () => NonNullable<import('@wp-playground/client').StartPlaygroundOptions['progressTracker']>
}
