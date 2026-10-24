// @php-wasm/node and @wp-playground/wordpress publish declarations that re-export from extensionless paths, which
// NodeNext resolution cannot follow. These are the parts the WordPress smoke test uses.
declare module '@php-wasm/node' {
  export function loadNodeRuntime(phpVersion: string, options?: { emscriptenOptions?: { processId?: number } }): Promise<number>
}

declare module '@wp-playground/wordpress' {
  export interface PhpResponse {
    exitCode: number
    httpStatusCode: number
    headers: Record<string, string[]>
    text: string
    errors: string
  }

  export interface PhpInstance {
    mkdir(path: string): void
    writeFile(path: string, data: string | Uint8Array): void
    readFileAsBuffer(path: string): Uint8Array
    readFileAsText(path: string): string
    fileExists(path: string): boolean
    unlink(path: string): void
    rmdir(path: string, options?: { recursive?: boolean }): void
    run(request: { code: string }): Promise<PhpResponse>
    exit(code?: number): void
  }

  export interface BootOptions {
    createPhpRuntime: () => Promise<number>
    phpVersion: string
    siteUrl: string
    documentRoot?: string
    wordPressZip?: File
    sqliteIntegrationPluginZip?: File
    maxPhpInstances?: number
    constants?: Record<string, string | number | boolean | null>
    onPHPInstanceCreated?: (php: PhpInstance, options: { isPrimary: boolean }) => void | Promise<void>
  }

  export interface RequestHandler {
    request(request: { url: string }): Promise<PhpResponse>
  }

  export function bootWordPressAndRequestHandler(options: BootOptions): Promise<RequestHandler>
}
