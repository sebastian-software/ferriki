// Placeholder release: ferriki is being rebuilt as a native-only runtime
// (Rust core via napi, no JS engine). The highlighting API returns with
// the vscode-textmate re-port. Track progress:
// https://github.com/sebastian-software/ferriki/issues/30
import { tryLoadFerrikiNativeBinding } from './native.mjs'

export function ferrikiVersion() {
  return tryLoadFerrikiNativeBinding()?.ferrikiVersion()
}
