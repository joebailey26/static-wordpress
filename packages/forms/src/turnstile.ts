import { ref, toValue, type MaybeRefOrGetter } from 'vue'

// The parts of Cloudflare Turnstile's explicit rendering API that the widget uses.
export interface TurnstileRenderOptions {
  sitekey: string
  action: string
  size: 'normal' | 'compact' | 'flexible'
  callback: (token: string) => void
  'expired-callback': () => void
  'timeout-callback': () => void
  'error-callback': () => void
}

export interface Turnstile {
  // The widget's id, or undefined when it could not render
  render (container: HTMLElement, options: TurnstileRenderOptions): string | undefined
  reset (widgetId: string): void
  remove (widgetId: string): void
}

declare global {
  interface Window {
    turnstile?: Turnstile
  }
}

// One script load is shared by every widget on the page.
let loading: Promise<Turnstile> | null = null

export function loadTurnstile (): Promise<Turnstile> {
  if (window.turnstile) {
    return Promise.resolve(window.turnstile)
  }
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const script = document.createElement('script')
      const fail = () => {
        clearTimeout(timeout)
        script.remove()
        loading = null
        reject(new Error('Turnstile could not load'))
      }
      const timeout = setTimeout(fail, 15000)
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
      // Turnstile rejects ready() when the script has async/defer, and script
      // elements created from JS are async by default, so opt out explicitly.
      script.async = false
      script.onload = () => {
        if (!window.turnstile) {
          fail()

          return
        }
        clearTimeout(timeout)
        resolve(window.turnstile)
      }
      script.onerror = fail
      document.head.appendChild(script)
    })
  }

  return loading
}

export interface TurnstileWidgetOptions {
  siteKey: MaybeRefOrGetter<string>
  container: MaybeRefOrGetter<HTMLElement | null>
  // The form's name; the forms Worker checks it, so a token from one form cannot submit another.
  action: MaybeRefOrGetter<string>
  // Offered when the widget cannot be used, e.g. "info@galexia.agency"
  contactEmail: string
  onToken: (token: string) => void
}

// Renders a Turnstile widget; tokens (or '' once a token is no longer usable) go to onToken.
// Call renderWidget once mounted and dispose before unmounting.
export function useTurnstileWidget ({ siteKey, container, action, contactEmail, onToken }: TurnstileWidgetOptions) {
  const error = ref('')
  let widgetId: string | null = null
  let disposed = false

  function reset () {
    onToken('')
    error.value = ''
    if (widgetId !== null && window.turnstile) {
      window.turnstile.reset(widgetId)
    }
  }

  async function renderWidget () {
    if (!toValue(siteKey)) {
      error.value = `This form is temporarily unavailable. Please email ${contactEmail}.`

      return
    }
    try {
      const turnstile = await loadTurnstile()
      const element = toValue(container)
      if (disposed || !element) {
        return
      }
      widgetId = turnstile.render(element, {
        sitekey: toValue(siteKey),
        action: toValue(action),
        size: 'flexible',
        callback: (token) => {
          error.value = ''
          onToken(token)
        },
        'expired-callback': () => reset(),
        'timeout-callback': () => reset(),
        'error-callback': () => {
          onToken('')
          error.value = 'Spam check could not complete. Please retry.'
        }
      }) ?? null
    } catch {
      if (!disposed) {
        error.value = `Spam check could not load. Please retry or email ${contactEmail}.`
      }
    }
  }

  function retry () {
    reset()
    if (widgetId === null) {
      renderWidget()
    }
  }

  // A script that is still loading then never renders a widget.
  function dispose () {
    disposed = true
    if (widgetId !== null && window.turnstile) {
      window.turnstile.remove(widgetId)
    }
  }

  return { error, renderWidget, reset, retry, dispose }
}
