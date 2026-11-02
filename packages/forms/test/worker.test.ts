import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test, type TestContext } from 'node:test'
import type { FormsEnv } from '../src/worker.ts'

// Only replace the Workers-only email constructor; exercise the real request handler.
const hooks = registerHooks({
  resolve (specifier, context, next) {
    if (specifier === 'cloudflare:email') {
      return { url: 'data:text/javascript,export class EmailMessage { constructor(...args) { this.args = args; } }', shortCircuit: true }
    }

    return next(specifier, context)
  }
})
const { createForms, label } = await import('../src/worker.ts')
hooks.deregister()

type Fields = Record<string, string>

const handle = createForms({
  senderName: 'Example website',
  contactEmail: 'hello@example.com',
  forms: {
    enquiry: { title: 'Enquiry', subject: (data) => `Enquiry: ${data.subject || 'New enquiry'}` },
    contact: { title: 'Contact form', subject: (data) => `Message from ${data.name}`, fields: ['name', 'email', 'message'], required: ['name', 'message'] },
    questionnaire: { title: 'Questionnaire', subject: () => 'Questionnaire', emailOptional: true }
  }
})

const enquiry: Fields = { firstName: 'Test', lastName: 'Visitor', email: 'visitor@example.com', subject: 'A new site', howDidYouHearAboutUs: 'Other' }
const contact: Fields = { name: 'Test Visitor', email: 'visitor@example.com', message: 'Hello' }

function request (fields: Fields = enquiry, { token = 'valid-token', ...options }: RequestInit & { token?: string | Blob | null } = {}) {
  const body = new FormData()
  for (const [key, value] of Object.entries(fields)) {
    body.set(key, value)
  }
  if (token !== null) {
    body.set('cf-turnstile-response', token)
  }

  return new Request('https://example.com/api/forms/x', { method: 'POST', body, ...options })
}

function setup (t: TestContext, result: unknown = null) {
  const send = t.mock.fn(async (_message: unknown) => {})
  let action = 'enquiry'
  const verify = t.mock.method(globalThis, 'fetch', async (_url: unknown, _options?: RequestInit) => Response.json(result ?? { success: true, action, hostname: 'example.com' }))
  const env: FormsEnv = { email: { send }, from: 'website@example.com', to: 'hello@example.com', turnstileSecret: 'private-test-key' }

  return { send, verify, env, action: (value: string) => { action = value } }
}

// The stubbed EmailMessage keeps its constructor arguments: from, to and the raw message.
const sent = (message: unknown) => {
  assert.ok(typeof message === 'object' && message !== null && 'args' in message && Array.isArray(message.args))

  return message.args.map(String)
}

const decode = (raw = '') => {
  const [headers = '', body = ''] = raw.split('\r\n\r\n')

  return { headers, body: new TextDecoder().decode(Uint8Array.from(atob(body.replace(/\r\n/g, '')), (c) => c.charCodeAt(0))) }
}

test('a verified form emails every submitted field with a Reply-To', async (t) => {
  const { env, send, verify } = setup(t)
  const response = await handle(request(), 'enquiry', env)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  const [url, options] = verify.mock.calls[0]?.arguments ?? []
  assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify')
  assert.deepEqual(JSON.parse(String(options?.body)), { secret: 'private-test-key', response: 'valid-token' })
  assert.ok(options?.signal instanceof AbortSignal)
  const [from, to, raw] = sent(send.mock.calls[0]?.arguments[0])
  assert.equal(from, 'website@example.com')
  assert.equal(to, 'hello@example.com')
  const { headers, body } = decode(raw)
  assert.match(headers, /^From: Example website <website@example.com>/)
  assert.match(headers, /Reply-To: visitor@example.com/)
  assert.match(headers, /Message-ID: <[^@]+@example.com>/)
  assert.match(headers, new RegExp(`Subject: =\\?UTF-8\\?B\\?${btoa('Enquiry: A new site')}\\?=`))
  assert.match(body, /Enquiry from Test Visitor/)
  assert.match(body, /How did you hear about us:\nOther/)
  assert.doesNotMatch(body, /cf-turnstile-response|valid-token/)
})

test('a form with a field list ignores other fields and needs its required ones', async (t) => {
  const { env, send, action } = setup(t)
  action('contact')
  assert.equal((await handle(request({ ...contact, extra: 'Not emailed' }), 'contact', env)).status, 200)
  const { body } = decode(sent(send.mock.calls[0]?.arguments[0])[2])
  assert.match(body, /Contact form from Test Visitor\n\nName:\nTest Visitor\n\nEmail:\nvisitor@example.com\n\nMessage:\nHello/)
  assert.doesNotMatch(body, /Not emailed/)
  assert.equal((await handle(request({ ...contact, message: '  ' }), 'contact', env)).status, 400)
  assert.equal((await handle(request({ email: 'visitor@example.com', message: 'Hi' }), 'contact', env)).status, 400)
})

test('a form can go without an email address, and then has no Reply-To', async (t) => {
  const { env, send, action } = setup(t)
  action('questionnaire')
  assert.equal((await handle(request({ yourCompanyName: 'Acme', whatIsYourWhy: 'Because' }), 'questionnaire', env)).status, 200)
  assert.doesNotMatch(decode(sent(send.mock.calls[0]?.arguments[0])[2]).headers, /Reply-To/)
  assert.equal((await handle(request({ yourCompanyName: 'Acme', email: 'not-an-email' }), 'questionnaire', env)).status, 400)
})

test('a token for one form cannot submit another', async (t) => {
  const { env, send } = setup(t)
  assert.equal((await handle(request(contact), 'contact', env)).status, 403)
  assert.equal(send.mock.callCount(), 0)
})

for (const token of [null, '', '   ', 'x'.repeat(2049), new Blob(['file'])]) {
  test(`missing or invalid token is blocked (${token === null ? 'missing' : typeof token === 'string' ? token.length : 'file'})`, async (t) => {
    const { env, send, verify } = setup(t)
    assert.equal((await handle(request(enquiry, { token }), 'enquiry', env)).status, 400)
    assert.equal(send.mock.callCount(), 0)
    assert.equal(verify.mock.callCount(), 0)
  })
}

for (const result of [
  { success: false, 'error-codes': ['invalid-input-response'] },
  { success: false, 'error-codes': ['timeout-or-duplicate'] },
  { success: true, hostname: 'example.com', action: 'login' },
  { success: true, hostname: 'attacker.example', action: 'enquiry' },
  { success: true },
  { success: 'true', hostname: 'example.com', action: 'enquiry' },
  []
]) {
  test(`failed or mismatched verification cannot send email: ${JSON.stringify(result)}`, async (t) => {
    const { env, send } = setup(t, result)
    assert.ok([403, 503].includes((await handle(request(), 'enquiry', env)).status))
    assert.equal(send.mock.callCount(), 0)
  })
}

for (const failure of ['network', 'timeout', 'http', 'json']) {
  test(`verification ${failure} failure cannot send email`, async (t) => {
    const { env, send, verify } = setup(t)
    verify.mock.mockImplementation(async () => {
      if (failure === 'http') {
        return new Response('unavailable', { status: 503 })
      }
      if (failure === 'json') {
        return new Response('invalid JSON')
      }
      throw new DOMException('Unavailable', failure === 'timeout' ? 'TimeoutError' : 'NetworkError')
    })
    assert.equal((await handle(request(), 'enquiry', env)).status, 503)
    assert.equal(send.mock.callCount(), 0)
  })
}

test('bad requests are refused before verification', async (t) => {
  const { env, send, verify } = setup(t)
  assert.equal((await handle(request(), 'unknown', env)).status, 404)
  assert.equal((await handle(request(), 'toString', env)).status, 404)
  assert.equal((await handle(request({ ...enquiry, email: 'nope' }), 'enquiry', env)).status, 400)
  assert.equal((await handle(request({ ...enquiry, 'bad field!': 'x' }), 'enquiry', env)).status, 400)
  assert.equal((await handle(request(enquiry, { headers: { Origin: 'https://attacker.example' } }), 'enquiry', env)).status, 403)
  assert.equal((await handle(new Request('https://example.com/api/forms/enquiry'), 'enquiry', env)).status, 405)
  assert.equal(send.mock.callCount(), 0)
  assert.equal(verify.mock.callCount(), 0)
})

test('a missing secret fails closed, offering the contact email', async (t) => {
  const { env, send, verify } = setup(t)
  const response = await handle(request(), 'enquiry', { ...env, turnstileSecret: undefined })
  assert.equal(response.status, 503)
  assert.match(JSON.stringify(await response.json()), /hello@example.com/)
  assert.equal(send.mock.callCount(), 0)
  assert.equal(verify.mock.callCount(), 0)
})

test('a failed email reports an error', async (t) => {
  const { env, send } = setup(t)
  send.mock.mockImplementation(async () => { throw new Error('rejected') })
  t.mock.method(console, 'error', () => {})
  assert.equal((await handle(request(), 'enquiry', env)).status, 502)
})

test('field names become labels', () => {
  assert.equal(label('howDidYouHearAboutUs'), 'How did you hear about us')
  assert.equal(label('your_company-name'), 'Your company name')
})
