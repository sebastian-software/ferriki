# Changelog

## [0.3.0](https://github.com/sebastian-software/ferriki/compare/v0.2.0...v0.3.0) (2026-07-27)


### Features

* **node:** default to the native backend and expose Shiki subpaths ([453a550](https://github.com/sebastian-software/ferriki/commit/453a550640f57f71fee3e85537df507e5383c45b))
* **node:** default to the native backend and expose Shiki subpaths ([e237380](https://github.com/sebastian-software/ferriki/commit/e237380cc8fbbf4398b19a9ef71f8d779a4991b1))
* **node:** restore native shiki facade ([6485a78](https://github.com/sebastian-software/ferriki/commit/6485a78a6f059e993598632d46905867e5ac7a13))
* **node:** type native highlighter api ([8381ded](https://github.com/sebastian-software/ferriki/commit/8381dedd6a5489c62c698baf5f77d291821e2971))


### Bug Fixes

* **node:** preserve core function signatures ([c29bbf1](https://github.com/sebastian-software/ferriki/commit/c29bbf127b439b0b2f7eb692eb4ff03429fbd0ff))
* **node:** replace transitional shiki-rust naming and re-guard the workspace root ([f9802ae](https://github.com/sebastian-software/ferriki/commit/f9802aef272cd2c90775ec63d63f0c12e828a35f))
* **node:** replace transitional shiki-rust naming with ferriki ([4b75c7c](https://github.com/sebastian-software/ferriki/commit/4b75c7c2ff489f1d398edcf416cf1c6557969268))
* **node:** ship standard assets ([bfb2f08](https://github.com/sebastian-software/ferriki/commit/bfb2f08b5de0a8af32cbb58c0411eb5332c1e837))
* require Node 20, matching upstream shiki@4 and @shikijs/types ([e56d084](https://github.com/sebastian-software/ferriki/commit/e56d0844392cd7ec7c444b1fc6296af01a2fcded))
* sort the npm files array for jsonc lint ([7bf465a](https://github.com/sebastian-software/ferriki/commit/7bf465a6a5d0ad5bf13831b75e1f9e6eece4243f))

## [0.2.0](https://github.com/sebastian-software/ferriki/compare/v0.1.0...v0.2.0) (2026-07-10)


### Features

* **core:** add native codeToHast path ([5ed3144](https://github.com/sebastian-software/ferriki/commit/5ed31443d3476c542051a48cd36c3b9ea4ce6811))
* **core:** make render options native ([b9961b8](https://github.com/sebastian-software/ferriki/commit/b9961b8bf65939653c2e910ad10dead42c03bce7))
* **node:** publish ferriki via release-please with platform binaries ([30edf1c](https://github.com/sebastian-software/ferriki/commit/30edf1c449709d1d94004e87b734e7291684b137))
* **node:** wire standard asset loading into native adapter ([6793d72](https://github.com/sebastian-software/ferriki/commit/6793d72d7342f9e28fed8379d4228b0f1a96126e))


### Bug Fixes

* **ci:** point pnpm setup at node workspace and repair lint/typecheck ([561e8c9](https://github.com/sebastian-software/ferriki/commit/561e8c92ab764b04e5348e72796d6fdeb1275cdc))
* **compat:** restore vue injection parity ([167b26d](https://github.com/sebastian-software/ferriki/commit/167b26dda2e129c94380ff68c42b1c278b5e7d9c))
* **core:** normalize standard assets and restore native shiki parity ([9514886](https://github.com/sebastian-software/ferriki/commit/95148866b0ec88a09746cb855d9985c472255332))
* **core:** remove astro renderer fallback ([7e70caf](https://github.com/sebastian-software/ferriki/commit/7e70cafc1f61f4f5be589d3b1dab08cc63df6edd))
* **core:** remove vue renderer fallback ([b9f6c1d](https://github.com/sebastian-software/ferriki/commit/b9f6c1d17f8c358a1af02cc823cdb2b6b3ad142e))
* **node:** exclude legacy addon from tarball via explicit globs ([bada0d5](https://github.com/sebastian-software/ferriki/commit/bada0d532ac1ed110717dd4a126c76fb93271d4b))
