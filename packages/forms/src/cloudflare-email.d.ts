// The Workers runtime's email module, as @cloudflare/workers-types declares it, so the package builds without the Workers types.
declare module 'cloudflare:email' {
  export class EmailMessage {
    constructor (from: string, to: string, raw: string)
    readonly from: string
    readonly to: string
  }
}
