import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { useForm, useTurnstileWidget, type Turnstile } from '../src/vue.ts'

// Node has no window, document or localStorage; give each test its own stand-ins.
function stubGlobals (t: TestContext, globals: Record<string, unknown>) {
  Object.assign(globalThis, globals)
  t.after(() => {
    for (const key of Object.keys(globals)) {
      Reflect.deleteProperty(globalThis, key)
    }
  })
}

function widget (t: TestContext, siteKey = 'public-test-key') {
  const tokens: string[] = []
  const api = {
    render: t.mock.fn<Turnstile['render']>(() => 'widget-1'),
    reset: t.mock.fn(),
    remove: t.mock.fn()
  }
  stubGlobals(t, { window: { turnstile: api } })
  // The widget is never inspected, so any element will do.
  const loaded = useTurnstileWidget({ siteKey, container: {} as HTMLElement, action: 'contact', contactEmail: 'hello@example.com', onToken: (token) => tokens.push(token) })

  return { widget: loaded, api, tokens }
}

test('widget issues tokens, clears expired tokens, retries, and cleans up on navigation', async (t) => {
  const { widget: turnstile, api, tokens } = widget(t)
  await turnstile.renderWidget()
  const options = api.render.mock.calls[0]?.arguments[1]
  assert.ok(options)
  assert.equal(options.action, 'contact')
  options.callback('solved-token')
  assert.equal(tokens.at(-1), 'solved-token')
  options['expired-callback']()
  assert.equal(tokens.at(-1), '')
  assert.equal(api.reset.mock.callCount(), 1)
  options['error-callback']()
  assert.ok(turnstile.error.value)
  assert.equal(tokens.at(-1), '')
  turnstile.retry()
  assert.equal(turnstile.error.value, '')
  assert.equal(api.reset.mock.callCount(), 2)
  turnstile.dispose()
  assert.equal(api.remove.mock.calls[0]?.arguments[0], 'widget-1')
})

test('widget does not render after navigating away while the script loads', async (t) => {
  const { widget: turnstile, api } = widget(t)
  const pending = turnstile.renderWidget()
  turnstile.dispose()
  await pending
  assert.equal(api.render.mock.callCount(), 0)
})

test('a missing public key leaves an email fallback and never renders', async (t) => {
  const { widget: turnstile, api } = widget(t, '')
  await turnstile.renderWidget()
  assert.match(turnstile.error.value, /hello@example.com/)
  assert.equal(api.render.mock.callCount(), 0)
})

test('a blocked script can be retried successfully', async (t) => {
  const api = { render: t.mock.fn(() => 'widget-2') }
  const browserWindow: { turnstile?: typeof api } = {}
  let attempts = 0
  stubGlobals(t, {
    window: browserWindow,
    document: {
      createElement: () => ({ remove () {} }),
      head: {
        appendChild (script: { onerror: () => void, onload: () => void }) {
          queueMicrotask(() => {
            if (++attempts === 1) {
              script.onerror()
            } else {
              browserWindow.turnstile = api
              script.onload()
            }
          })
        }
      }
    }
  })
  const turnstile = useTurnstileWidget({ siteKey: 'public-test-key', container: {} as HTMLElement, action: 'contact', contactEmail: 'hello@example.com', onToken () {} })
  await turnstile.renderWidget()
  assert.match(turnstile.error.value, /could not load/)
  await turnstile.renderWidget()
  assert.equal(api.render.mock.callCount(), 1)
})

function contact (t: TestContext, ok = true) {
  const storage = new Map<string, string>()
  stubGlobals(t, {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key)
    }
  })
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(ok ? { ok: true } : { error: 'Spam check failed or expired. Please try again' }, { status: ok ? 200 : 403 }))
  const reset = t.mock.fn()
  // Outside a component, Vue warns that onMounted has nothing to attach to.
  t.mock.method(console, 'warn', () => {})
  const form = useForm('contact', { storageKey: 'contactForm', turnstile: { reset } })
  let valid = true
  // Only checkValidity() is called on the form element.
  form.formEl.value = { checkValidity: () => valid } as HTMLFormElement
  form.form.value = { name: 'Visitor', email: 'visitor@example.com', message: 'Hello', topics: ['Web', 'SEO'] }

  return { form, fetch, reset, storage, invalid: () => { valid = false } }
}

test('a form needs browser validation and a solved token before sending', async (t) => {
  const { form, fetch, invalid } = contact(t)
  form.changed()
  assert.equal(form.canSubmit.value, false)
  assert.equal(await form.submit('Sent'), false)
  assert.equal(fetch.mock.callCount(), 0)
  form.setToken('solved-token')
  assert.equal(form.canSubmit.value, true)
  invalid()
  form.changed()
  assert.equal(form.canSubmit.value, false)
})

test('drafts are kept until the form is sent', async (t) => {
  const { form, storage } = contact(t)
  form.changed()
  assert.deepEqual(JSON.parse(storage.get('contactForm') ?? ''), form.form.value)
  form.setToken('solved-token')
  assert.equal(await form.submit('Sent'), true)
  assert.equal(storage.has('contactForm'), false)
})

test('a sent form posts every field with the token, prevents double submits, and refreshes the spam check', async (t) => {
  const { form, fetch, reset } = contact(t)
  form.setToken('solved-token')
  const pending = form.submit('Message sent')
  assert.equal(await form.submit('Message sent'), false)
  assert.equal(await pending, true)
  assert.equal(fetch.mock.callCount(), 1)
  const [url, options] = fetch.mock.calls[0]?.arguments ?? []
  assert.equal(url, '/api/forms/contact')
  const body = options?.body
  assert.ok(body instanceof FormData)
  assert.equal(body.get('cf-turnstile-response'), 'solved-token')
  assert.equal(body.get('topics'), 'Web, SEO')
  assert.deepEqual(form.form.value, {})
  assert.equal(form.sending.value, false)
  assert.equal(form.message.value, 'Message sent')
  assert.equal(reset.mock.callCount(), 1)
  assert.equal(form.canSubmit.value, false, 'the spent token cannot be reused')
})

test('a refused form keeps the draft, shows the Worker\'s error and refreshes the spent token', async (t) => {
  const { form, reset } = contact(t, false)
  form.setToken('solved-token')
  assert.equal(await form.submit('Sent'), false)
  assert.equal(form.form.value.message, 'Hello')
  assert.equal(form.sending.value, false)
  assert.equal(form.message.value, 'Spam check failed or expired. Please try again.')
  assert.equal(reset.mock.callCount(), 1)
})
