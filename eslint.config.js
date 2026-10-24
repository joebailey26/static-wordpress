import globals from 'globals'
import galexia from 'eslint-config-galexia'

export default [
  {
    name: 'static-wordpress/ignores',
    ignores: ['**/dist/', '**/.nuxt/', '**/node_modules/', 'packages/cms/test/site/']
  },
  ...galexia,
  {
    name: 'static-wordpress/globals',
    languageOptions: {
      globals: { ...globals.node, ...globals.browser }
    }
  }
]
