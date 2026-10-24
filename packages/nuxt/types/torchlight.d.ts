// The parts of @torchlight-api/client (an optional peer dependency, with no types of its own) that convert-code uses.
declare module '@torchlight-api/client' {
  export interface TorchlightBlock {
    id: string
  }

  export interface HighlightedBlock {
    id: string
    code: string
    classes: string
    highlighted: string
  }

  export interface TorchlightConfig {
    theme?: string
  }

  export const Block: new (options: { code: string, language: string | null }) => TorchlightBlock
  export const FileCache: new (options: { directory: string }) => object
  export function makeConfig (config: TorchlightConfig): Promise<object>

  export const torchlight: {
    init: (config: object, cache: object) => void
    highlight: (blocks: TorchlightBlock[]) => Promise<HighlightedBlock[]>
  }
}
