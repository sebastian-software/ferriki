import type { ShikiTransformer } from '@shikijs/types'
import type { CreateTwoslashOptions } from 'twoslash'
import type { ModuleResolutionKind } from 'typescript'
import type { RendererRichOptions, TransformerTwoslashOptions } from './core'
import { createTwoslasher } from 'twoslash'
import { createTransformerFactory, rendererRich } from './core'

export * from './core'

export interface TransformerTwoslashIndexOptions extends TransformerTwoslashOptions, Pick<CreateTwoslashOptions, 'cache' | 'tsModule'> {
  /**
   * Options for the default rich renderer.
   *
   * Available when no custom renderer is provided.
   */
  rendererRich?: RendererRichOptions
}

/**
 * Factory function to create a Shiki transformer for twoslash integrations.
 */
export function transformerTwoslash(options: TransformerTwoslashIndexOptions = {}): ShikiTransformer {
  const twoslashOptions: CreateTwoslashOptions = {
    cache: options.cache,
    compilerOptions: {
      moduleResolution: 100 satisfies ModuleResolutionKind.Bundler,
    },
  }

  // tsModule is a create-time option that must reach createTwoslasher directly.
  // It can be set at the top level or inside twoslashOptions; top level takes precedence.
  const tsModule = options.tsModule || options.twoslashOptions?.tsModule

  // Only include when defined, passing `undefined` explicitly overrides the default
  // TypeScript module that twoslash sets internally, causing an immediate crash.
  if (tsModule) {
    twoslashOptions.tsModule = tsModule
  }

  return createTransformerFactory(
    createTwoslasher(twoslashOptions),
    rendererRich(options.rendererRich),
  )(options)
}
