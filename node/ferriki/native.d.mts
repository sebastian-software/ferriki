export interface FerrikiNativeBinding {
  ferrikiVersion: () => string
  [key: string]: unknown
}
export declare function loadFerrikiNativeBinding(): FerrikiNativeBinding
export declare function tryLoadFerrikiNativeBinding(): FerrikiNativeBinding | undefined
