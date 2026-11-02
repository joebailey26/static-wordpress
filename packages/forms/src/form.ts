import { onMounted, ref, toValue, type MaybeRefOrGetter } from 'vue'

// A field's v-model value: text, or a list (sent joined with commas).
export type FormValue = string | number | string[] | null | undefined

export type FormFields = Record<string, FormValue>

export interface FormOptions {
  // Where the draft is kept in localStorage; defaults to the form's name.
  storageKey?: string
  // The forms Worker route; defaults to /api/forms/<name>.
  endpoint?: string
  // The Turnstile widget, reset after every attempt as tokens are single-use.
  turnstile?: MaybeRefOrGetter<{ reset: () => void } | null>
}

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null && !Array.isArray(value)

// The forms Worker answers { error } when it refuses a submission.
const errorFrom = (result: unknown) => (isObject(result) && 'error' in result && typeof result.error === 'string' ? result.error : '')

// A form that posts to the forms Worker after a Turnstile check. Bind `formEl` to the <form>, call `changed`
// on its input and change events and `setToken` with the widget's tokens. Drafts are kept in localStorage,
// and `canSubmit` is true once the browser's own validation passes and the spam check has a token.
export function useForm (name: string, { storageKey = name, endpoint = `/api/forms/${name}`, turnstile }: FormOptions = {}) {
  const form = ref<FormFields>({})
  const formEl = ref<HTMLFormElement | null>(null)
  const canSubmit = ref(false)
  const sending = ref(false)
  const message = ref('')
  const token = ref('')

  const validate = () => {
    canSubmit.value = Boolean(formEl.value?.checkValidity() && token.value) && !sending.value
  }

  const changed = () => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(form.value))
    } catch {
      // Private browsing can refuse storage; the form still works.
    }
    validate()
  }

  const setToken = (value: string) => {
    token.value = value
    validate()
  }

  onMounted(() => {
    try {
      const saved = localStorage.getItem(storageKey)
      const draft: unknown = saved ? JSON.parse(saved) : {}
      // A draft is only ever written by changed() above, so an object holds the form's values.
      form.value = isObject(draft) ? draft as FormFields : {}
    } catch {
      form.value = {}
    }
    validate()
  })

  // Resolves to whether the message was sent; `message` then holds `success` or what went wrong.
  async function submit (success: string) {
    validate()
    if (!canSubmit.value) {
      return false
    }
    sending.value = true
    validate()
    const body = new FormData()
    for (const [key, value] of Object.entries(form.value)) {
      if (value !== undefined && value !== null && value !== '') {
        body.set(key, Array.isArray(value) ? value.join(', ') : String(value))
      }
    }
    body.set('cf-turnstile-response', token.value)
    try {
      const response = await fetch(endpoint, { method: 'POST', body })
      const result: unknown = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(errorFrom(result) || `Message could not be sent (${response.status})`)
      }
      try {
        localStorage.removeItem(storageKey)
      } catch {
        // Nothing to clear
      }
      form.value = {}
      message.value = success

      return true
    } catch (error) {
      // The Worker's messages already say what to do next.
      const text = error instanceof Error ? error.message : String(error)
      message.value = /try again|email/i.test(text) ? `${text}.` : `${text}. Please try again.`

      return false
    } finally {
      sending.value = false
      // The token was spent, including when email delivery failed after verification.
      token.value = ''
      toValue(turnstile)?.reset()
      validate()
    }
  }

  return { form, formEl, canSubmit, sending, message, changed, setToken, submit }
}
