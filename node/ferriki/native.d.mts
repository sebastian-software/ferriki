/** Raw N-API binding surface of the ferriki native addon. */
export interface FerrikiNativeBinding {
  ferrikiVersion: () => string
  [key: string]: unknown
}

/**
 * Load the native binding, throwing with a diagnostic message when no
 * matching platform binary is available.
 */
export declare function loadFerrikiNativeBinding(): FerrikiNativeBinding

/** Load the native binding, returning undefined when unavailable. */
export declare function tryLoadFerrikiNativeBinding(): FerrikiNativeBinding | undefined
