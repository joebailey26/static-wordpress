import { EmailMessage } from 'cloudflare:email'

// A form's submitted fields, by name, with empty fields left out.
export type FormValues = Record<string, string>

export interface FormDefinition {
  // Heads the email body: "<title> from <sender>"
  title: string
  subject: (values: FormValues) => string
  // Fields that must be filled in. Every form also needs a valid email address unless emailOptional is set.
  required?: string[]
  // Only these fields are emailed when set; any others are ignored.
  fields?: string[]
  // Forms without an email field send no Reply-To.
  emailOptional?: boolean
}

export interface FormsOptions {
  // The forms by the name the site routes to; the name is also the Turnstile action.
  forms: Record<string, FormDefinition>
  // The display name on the From header, e.g. "Galexia website"
  senderName: string
  // Shown to visitors when the form cannot be used, e.g. "info@galexia.agency"
  contactEmail: string
}

// What one request needs from the Worker's bindings. Only the methods the handler calls are required, so tests can stub them.
export interface FormsEnv {
  email: { send (message: EmailMessage): Promise<unknown> }
  from: string
  to: string
  // A secret; forms answer 503 without it.
  turnstileSecret?: string
}

interface TurnstileResult {
  success: boolean
  action?: unknown
  hostname?: unknown
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
const clean = (value: unknown) => String(value ?? '').replace(/\r/g, '').trim()
const header = (value: unknown) => clean(value).replace(/\n/g, ' ').slice(0, 200)
const base64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)))
const FIELD = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/
// Fields the browser adds that are not part of the message
const IGNORED = new Set(['cf-turnstile-response', 'form-name', 'submit'])

// camelCase field names become labels: howDidYouHearAboutUs -> How did you hear about us
export const label = (name: string) => {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase()

  return words.charAt(0).toUpperCase() + words.slice(1)
}

const isTurnstileResult = (value: unknown): value is TurnstileResult => typeof value === 'object' && value !== null && 'success' in value && typeof value.success === 'boolean'

async function verifyTurnstile (token: string, action: string, request: Request, secret: string) {
  const verification = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret, response: token }),
    signal: AbortSignal.timeout(10000)
  })
  if (!verification.ok) {
    throw new Error('Turnstile unavailable')
  }
  const result: unknown = await verification.json()
  if (!isTurnstileResult(result)) {
    throw new Error('Invalid Turnstile response')
  }

  return result.success && result.action === action && result.hostname === new URL(request.url).hostname
}

// Returns the handler for the site's form routes: it checks the request and its Turnstile token
// (whose action must be the form's name), then emails every submitted field.
export function createForms ({ forms, senderName, contactEmail }: FormsOptions) {
  return async function handleForm (request: Request, name: string, env: FormsEnv): Promise<Response> {
    const form = Object.hasOwn(forms, name) ? forms[name] : null
    if (!form) {
      return json({ error: 'Form not found' }, 404)
    }
    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405)
    }
    const origin = request.headers.get('Origin')
    if (origin && origin !== new URL(request.url).origin) {
      return json({ error: 'Forbidden' }, 403)
    }
    const data = await request.formData().catch(() => null)
    if (!data) {
      return json({ error: 'Invalid form' }, 400)
    }
    const token = data.get('cf-turnstile-response')
    const fields: [string, string][] = []
    for (const [key, value] of data) {
      if (IGNORED.has(key) || (form.fields && !form.fields.includes(key))) {
        continue
      }
      if (typeof value !== 'string' || !FIELD.test(key) || fields.length >= 60) {
        return json({ error: 'Invalid form' }, 400)
      }
      const text = clean(value).slice(0, 5000)
      if (text) {
        fields.push([key, text])
      }
    }
    const values: FormValues = Object.fromEntries(fields)
    const email = header(values.email)
    const validEmail = EMAIL.test(email)
    const missing = (form.required ?? []).some((key) => !values[key])
    if ((!validEmail && (email || !form.emailOptional)) || fields.length < 2 || missing) {
      return json({ error: 'A valid email address and your details are required' }, 400)
    }
    if (typeof token !== 'string' || !token.trim() || token.length > 2048) {
      return json({ error: 'Please complete the spam check and try again' }, 400)
    }
    if (!env.turnstileSecret) {
      return json({ error: `This form is temporarily unavailable. Please email ${contactEmail}` }, 503)
    }
    try {
      if (!await verifyTurnstile(token, name, request, env.turnstileSecret)) {
        return json({ error: 'Spam check failed or expired. Please try again' }, 403)
      }
    } catch {
      return json({ error: 'Spam check is temporarily unavailable. Please try again' }, 503)
    }
    const sender = header([values.firstName, values.lastName].filter(Boolean).join(' ') || values.name || email || values.yourCompanyName || 'a visitor')
    const raw = [
      `From: ${senderName} <${env.from}>`,
      `To: ${env.to}`,
      ...(validEmail ? [`Reply-To: ${email}`] : []),
      `Subject: =?UTF-8?B?${base64(header(form.subject(values)))}?=`,
      `Message-ID: <${crypto.randomUUID()}@${env.from.split('@').pop()}>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      base64(`${form.title} from ${sender}\n\n${fields.map(([key, value]) => `${label(key)}:\n${value}`).join('\n\n')}\n`).replace(/.{76}/g, '$&\r\n')
    ].join('\r\n')
    try {
      await env.email.send(new EmailMessage(env.from, env.to, raw))
    } catch (error) {
      // The Worker's logs are the only record of a failed delivery.
      // eslint-disable-next-line no-console
      console.error('Form email failed', error instanceof Error ? error.name : typeof error)

      return json({ error: 'Message could not be sent' }, 502)
    }

    return json({ ok: true })
  }
}
