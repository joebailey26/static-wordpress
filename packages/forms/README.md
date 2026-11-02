# @joebailey26/turnstile-forms

Website forms that a Cloudflare Worker checks with [Turnstile](https://developers.cloudflare.com/turnstile/) and emails through a [Send Email binding](https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/), plus the Vue composables for the form and the widget. It is not tied to the CMS.

## Worker

```ts
import { createForms } from '@joebailey26/turnstile-forms'

const handleForm = createForms({
  senderName: 'Example website',
  contactEmail: 'hello@example.com',
  forms: {
    contact: { title: 'Contact form', subject: (data) => `Message from ${data.name}`, fields: ['name', 'email', 'message'], required: ['name', 'message'] },
    questionnaire: { title: 'Questionnaire', subject: () => 'Questionnaire', emailOptional: true }
  }
})

export default {
  async fetch (request, env) {
    const name = new URL(request.url).pathname.match(/^\/api\/forms\/([a-z-]+)\/?$/)?.[1]
    if (name) {
      return handleForm(request, name, { email: env.FORMS_EMAIL, from: env.FORMS_FROM, to: env.FORMS_TO, turnstileSecret: env.TURNSTILE_SECRET_KEY })
    }

    return env.ASSETS.fetch(request)
  }
} satisfies ExportedHandler<Env>
```

The handler accepts POSTs from the page's own origin only. The Turnstile token must be valid and issued for the request's hostname, with the form's name as its action, so a token from one form cannot submit another. Each form needs a valid `email` unless `emailOptional` is set; that address becomes the Reply-To. Every submitted field (or only `fields`, when set) is emailed under a label made from its name (`howDidYouHearAboutUs` → "How did you hear about us"). Responses are `{ ok: true }` or `{ error }` with a status: 400, 403, 404, 405, 502, or 503 when the secret is missing or Turnstile is unreachable.

## Vue

```ts
import { useForm, useTurnstileWidget } from '@joebailey26/turnstile-forms/vue'
```

- `useForm(name, { storageKey, endpoint, turnstile })` returns `form` (v-model the fields to `form.<field>`), `formEl` (the `<form>` ref), `canSubmit`, `sending`, `message`, `changed` (call on the form's `input` and `change` events: saves the draft to localStorage and revalidates), `setToken` and `submit(successMessage)`. It posts to `/api/forms/<name>` by default and resets the `turnstile` widget after every attempt, as tokens are single-use.
- `useTurnstileWidget({ siteKey, container, action, contactEmail, onToken })` loads the Turnstile script once per page and renders an explicit widget. Call `renderWidget` when mounted and `dispose` before unmounting; `reset`, `retry` and `error` drive the component's markup.
