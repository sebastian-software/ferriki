export * from '../../ferriki/index.mjs'

// Keep legacy upstream ANSI snapshots runnable while the public Ferriki
// contract rejects control sequences. This marker exists only in the mirror
// adapter and is never set by the package itself.
(globalThis as typeof globalThis & { __FERRIKI_COMPAT_LEGACY_ANSI?: boolean }).__FERRIKI_COMPAT_LEGACY_ANSI = true

// The upstream mirror still imports engine names while its compatibility
// tests are being retired. Keep those names isolated to the test harness;
// they are intentionally absent from Ferriki's public package exports.
export function createJavaScriptRegexEngine(): { kind: string } {
  return { kind: 'compatibility-only-native-engine' }
}

export function createOnigurumaEngine(): { kind: string } {
  return { kind: 'compatibility-only-native-engine' }
}

export async function loadWasm(): Promise<never> {
  throw new Error('Ferriki uses its native runtime; WASM loading is not supported.')
}

export const wasmBinary = new Uint8Array()
