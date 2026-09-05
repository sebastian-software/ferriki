export * from '../../ferriki/index.mjs'

// This marker is test-harness state, not a public Ferriki export. Keeping it
// here lets the honest-alias sentinel prove routing without widening the API.
Object.assign(globalThis, {
  __FERRIKI_COMPAT_NATIVE: true,
  __FERRIKI_COMPAT_LEGACY_ANSI: true,
})

// Keep legacy upstream ANSI snapshots runnable while the public Ferriki
// contract rejects control sequences. This marker exists only in the mirror
// adapter and is never set by the package itself.

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
