import assert from 'node:assert/strict'

import {
  FERRIKI_NODE_MIN_VERSION,
  FERRIKI_PLATFORM_TARGETS,
  formatFerrikiPlatformMatrix,
  resolveFerrikiPlatformTarget,
} from '../ferriki/platforms.mjs'

assert.equal(FERRIKI_NODE_MIN_VERSION, '22.13.0')
assert.deepEqual(FERRIKI_PLATFORM_TARGETS.map(target => target.id), [
  'linux-x64-gnu',
  'linux-arm64-gnu',
  'darwin-arm64',
  'darwin-x64',
  'win32-x64-msvc',
])
assert.equal(resolveFerrikiPlatformTarget({ platform: 'linux', arch: 'x64', libc: 'gnu' }).id, 'linux-x64-gnu')
assert.equal(resolveFerrikiPlatformTarget({ platform: 'linux', arch: 'x64', libc: 'musl' }), undefined)
assert.equal(resolveFerrikiPlatformTarget({ platform: 'win32', arch: 'x64' }).id, 'win32-x64-msvc')
assert.equal(resolveFerrikiPlatformTarget({ platform: 'win32', arch: 'arm64' }), undefined)
assert.match(formatFerrikiPlatformMatrix(), /linux-arm64-gnu \(Node >= 22\.13\.0\)/)

console.log('Ferriki platform matrix verified (GNU Linux only; musl explicitly unsupported)')
