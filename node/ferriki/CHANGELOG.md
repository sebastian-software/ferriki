# Changelog

## [0.8.0](https://github.com/sebastian-software/ferriki/compare/v0.7.0...v0.8.0) (2026-09-30)


### ⚠ BREAKING CHANGES

* @ferriki/core no longer bundles grammar and theme payloads. The first load of a language or theme downloads it, so offline environments need a populated cache or a mirror (FERRIKI_ASSETS_BASE_URL). Synchronous factories and highlighting no longer load standard languages or themes that were never loaded asynchronously and are not cached; they throw ERR_ASSET.

### Features

* add optional nested scope class highlighting ([661ee1e](https://github.com/sebastian-software/ferriki/commit/661ee1e104c7888e4d07f00d13b24a72823ef96a))
* load Node standard assets from the CDN instead of bundling them ([#170](https://github.com/sebastian-software/ferriki/issues/170)) ([a8eecc1](https://github.com/sebastian-software/ferriki/commit/a8eecc1485a1024e00a54fa2b5ba1285b8016318))


### Bug Fixes

* use fixed-size token chunks for current Clippy ([6c25aa8](https://github.com/sebastian-software/ferriki/commit/6c25aa8bfd07a2740285fd7d40f5a6e73935fac7))


### Performance Improvements

* avoid duplicate grammar scans for scoped tokens ([#174](https://github.com/sebastian-software/ferriki/issues/174)) ([f0afd51](https://github.com/sebastian-software/ferriki/commit/f0afd51935a20e8b233ec46e2fb23a575c9b0680))

## [0.7.0](https://github.com/sebastian-software/ferriki/compare/v0.6.0...v0.7.0) (2026-09-30)


### Features

* **assets:** pin every standard payload in a release manifest ([6c6bea3](https://github.com/sebastian-software/ferriki/commit/6c6bea36e51770cb0083ea4d8871bd65a466125d)), closes [#141](https://github.com/sebastian-software/ferriki/issues/141)
* **bench:** add TIOBE workloads for Ferroni comparisons ([30ba288](https://github.com/sebastian-software/ferriki/commit/30ba2883570e160414c61fde60e2d63d4fc62559))
* load standard assets from the CDN with the remote feature ([7635557](https://github.com/sebastian-software/ferriki/commit/7635557289fae3d860fbe419d94466c6df14e005)), closes [#141](https://github.com/sebastian-software/ferriki/issues/141)


### Bug Fixes

* **bench:** flush large worker reports before exiting ([fe52cbc](https://github.com/sebastian-software/ferriki/commit/fe52cbceda2d359d3c35eaea709730e091d8e317))
* **build:** resolve benchmark metadata with locked dependencies ([4671bb1](https://github.com/sebastian-software/ferriki/commit/4671bb1e3d545f39c360e7abed90f6b8a01a3354))


### Performance Improvements

* **bench:** record two complete TIOBE baseline runs ([3b20bc7](https://github.com/sebastian-software/ferriki/commit/3b20bc77831ea96ec098fdd53b3c858d23928dd5))

## [0.6.0](https://github.com/sebastian-software/ferriki/compare/v0.5.0...v0.6.0) (2026-09-29)


### ⚠ BREAKING CHANGES

* HighlightToken::font_style is Option<FontStyle> instead of Option<i32>, and token_type is Option<StandardTokenType> instead of Option<u8>.
* **assets:** the binary asset format is version 3. Assets generated for format 2 must be regenerated. ferriki-asset-gen no longer exports its generate and import modules, and its schema types can no longer be built with struct literals outside the crate; use AssetSourceRef::new.
* **textmate:** ferriki-textmate modules are private; import from the crate root. Types such as Rule, RuleId, RawRule, Matcher, ScopeStack, Theme and the re-exported ferroni scanner types are no longer public. Raw theme input and GrammarConfiguration must be built with Default and the with_* setters.

### Features

* **assets:** encode catalogs with postcard and narrow the codec crate API ([23a7727](https://github.com/sebastian-software/ferriki/commit/23a7727ebd18556161c38fc9c6456cbf480f9afa))
* **textmate:** keep the port's modules private behind a curated API ([1cea59a](https://github.com/sebastian-software/ferriki/commit/1cea59abd0d6b38b6283c934b85dd1a252e36c22))
* type token font styles and token types, derive common traits ([538619d](https://github.com/sebastian-software/ferriki/commit/538619dcbe5607b20d7de8e8fae75dc233a17c05))

## [0.5.0](https://github.com/sebastian-software/ferriki/compare/v0.4.1...v0.5.0) (2026-09-29)


### ⚠ BREAKING CHANGES

* add verified asset sources and extensible Rust options

### Features

* add verified asset sources and extensible Rust options ([2131d38](https://github.com/sebastian-software/ferriki/commit/2131d38fbba91f93da6e729e7552729e21a2de7a))


### Bug Fixes

* match Shiki multi-theme rendering ([61f19c6](https://github.com/sebastian-software/ferriki/commit/61f19c62215428ca9bbec01f32213437f1fdd9db))
* **npm:** stop shipping a Linux addon in the main package ([a813367](https://github.com/sebastian-software/ferriki/commit/a81336772043c1b794c3bd27a907f9cce777bc27))


### Performance Improvements

* **deps:** update ferroni to 1.6.1 ([6a36499](https://github.com/sebastian-software/ferriki/commit/6a36499ad4c22e82494a857416027d196ff5f426))

## [0.4.1](https://github.com/sebastian-software/ferriki/compare/v0.4.0...v0.4.1) (2026-09-28)


### Bug Fixes

* **release:** wait for npm to serve new versions and normalize sidecar repository ([d7a419d](https://github.com/sebastian-software/ferriki/commit/d7a419d68cd92dc25fddac469b14e3c74a93f4f5))

## [0.4.0](https://github.com/sebastian-software/ferriki/compare/v0.3.0...v0.4.0) (2026-09-27)


### ⚠ BREAKING CHANGES

* macOS Intel (`darwin-x64`) is no longer a supported native target and no `@ferriki/darwin-x64` sidecar is published.
* the `@ferriki/core/native` subpath is no longer exported; use `ferrikiVersion()` from `@ferriki/core` to check that the native binding loaded.
* install and import `@ferriki/core` instead of `ferriki` (and `@ferriki/core/native` instead of `ferriki/native`); the platform sidecars are published as `@ferriki/<platform>`. No version of these packages has been published before.
* the optional native sidecars are now published as `ferriki-<platform>` rather than `@sebastian-software/ferriki-<platform>`.

### Features

* drop the macOS Intel native target ([00aa74c](https://github.com/sebastian-software/ferriki/commit/00aa74ce0774a96f650ab3ffa9384188c51612a4)), closes [#52](https://github.com/sebastian-software/ferriki/issues/52)
* keep the native binding loader internal ([ab1bfff](https://github.com/sebastian-software/ferriki/commit/ab1bfff11aad92fcfbbad3ad28793d5868e81ecc)), closes [#136](https://github.com/sebastian-software/ferriki/issues/136)
* **native:** add Linux musl and Windows arm64 targets ([dede78e](https://github.com/sebastian-software/ferriki/commit/dede78e86d81b2f47386aae53962f8fd0a2daca9))
* publish under the [@ferriki](https://github.com/ferriki) npm scope ([f975ae0](https://github.com/sebastian-software/ferriki/commit/f975ae031920864943747b4859dcb9059c6d81c3))
* rename the native sidecars to unscoped ferriki-&lt;platform&gt; ([#106](https://github.com/sebastian-software/ferriki/issues/106)) ([71d47a3](https://github.com/sebastian-software/ferriki/commit/71d47a379ac9054380343eaeb39f6ae2a4322566))
* **rust:** expose reusable highlighter for Ferromark ([#128](https://github.com/sebastian-software/ferriki/issues/128)) ([6bff499](https://github.com/sebastian-software/ferriki/commit/6bff499ea63943adebee15f547a1e90c29933fa9))


### Bug Fixes

* **ci:** publish platform packages from local paths ([#91](https://github.com/sebastian-software/ferriki/issues/91)) ([f21104f](https://github.com/sebastian-software/ferriki/commit/f21104f7a33984c3ddc6c997067ba9d22f668623))
* harden release workflow contract ([8bb734a](https://github.com/sebastian-software/ferriki/commit/8bb734a14f276c7037e73b3954b5d4feb7e87f32))
* **release:** let release-please update platform versions ([#92](https://github.com/sebastian-software/ferriki/issues/92)) ([c0e4593](https://github.com/sebastian-software/ferriki/commit/c0e4593b6295efb4cf83c3b091477861790b77cd))


### Performance Improvements

* **textmate:** scan with CAPTURE_GROUP and drop the direct-search fallback ([d38deb6](https://github.com/sebastian-software/ferriki/commit/d38deb69972f935e5c71b2b25c996bc2ebadb403))

## [0.3.0](https://github.com/sebastian-software/ferriki/compare/v0.2.1...v0.3.0) (2026-09-06)


### Features

* add Ardo-grade multi-theme highlighting ([3451d87](https://github.com/sebastian-software/ferriki/commit/3451d87eee77497070d7e53466f55600c324ee56))
* add native platform sidecar packages ([#85](https://github.com/sebastian-software/ferriki/issues/85)) ([3fa5a00](https://github.com/sebastian-software/ferriki/commit/3fa5a003b27050b4f3c8f1c33374a2e5e42a9e3e))
* add token explanations and grammar state ([63dc738](https://github.com/sebastian-software/ferriki/commit/63dc738a9ec424eeea092a9755f67dc920726bb5))
* add token explanations and grammar state ([b03714b](https://github.com/sebastian-software/ferriki/commit/b03714be0b02f01c89aafc9286503bf2ec7676b4)), closes [#47](https://github.com/sebastian-software/ferriki/issues/47)
* **core:** add native codeToHast path ([5ed3144](https://github.com/sebastian-software/ferriki/commit/5ed31443d3476c542051a48cd36c3b9ea4ce6811))
* **core:** make render options native ([b9961b8](https://github.com/sebastian-software/ferriki/commit/b9961b8bf65939653c2e910ad10dead42c03bce7))
* define supported native platform matrix ([da11626](https://github.com/sebastian-software/ferriki/commit/da116260f2d2837b27c150fee55cbc4e9f1e3094))
* define supported native platform matrix ([dfbe7a7](https://github.com/sebastian-software/ferriki/commit/dfbe7a7185ae78394a8b0e98d8c1f639df5bd9e0))
* expose enumerable bundled catalogs ([5b3658f](https://github.com/sebastian-software/ferriki/commit/5b3658fe8b8a489a43393a64a934bab036196053))
* implement the JS transformer and decoration pipeline ([5d8013a](https://github.com/sebastian-software/ferriki/commit/5d8013aa240cf5feea0de9404fcfad7872bcaedf))
* make ANSI input contract explicit ([5f5a7b5](https://github.com/sebastian-software/ferriki/commit/5f5a7b560f719e896e0fd53486814093e316c1f8)), closes [#48](https://github.com/sebastian-software/ferriki/issues/48)
* **node:** default to the native backend and expose Shiki subpaths ([453a550](https://github.com/sebastian-software/ferriki/commit/453a550640f57f71fee3e85537df507e5383c45b))
* **node:** default to the native backend and expose Shiki subpaths ([e237380](https://github.com/sebastian-software/ferriki/commit/e237380cc8fbbf4398b19a9ef71f8d779a4991b1))
* **node:** publish ferriki via release-please with platform binaries ([30edf1c](https://github.com/sebastian-software/ferriki/commit/30edf1c449709d1d94004e87b734e7291684b137))
* **node:** restore native shiki facade ([6485a78](https://github.com/sebastian-software/ferriki/commit/6485a78a6f059e993598632d46905867e5ac7a13))
* **node:** type native highlighter api ([8381ded](https://github.com/sebastian-software/ferriki/commit/8381dedd6a5489c62c698baf5f77d291821e2971))
* **node:** wire standard asset loading into native adapter ([6793d72](https://github.com/sebastian-software/ferriki/commit/6793d72d7342f9e28fed8379d4228b0f1a96126e))
* stabilize public Ferriki error contracts ([#70](https://github.com/sebastian-software/ferriki/issues/70)) ([a35f8f2](https://github.com/sebastian-software/ferriki/commit/a35f8f2aeb087535f2ea9cb1cc5ddeb483165072))
* support validated custom registrations ([ebd0cbc](https://github.com/sebastian-software/ferriki/commit/ebd0cbc49b0d09b222a380fac27b8ab475ea5e66)), closes [#46](https://github.com/sebastian-software/ferriki/issues/46)


### Bug Fixes

* **api:** expose bundled language and theme key types ([#90](https://github.com/sebastian-software/ferriki/issues/90)) ([00ae483](https://github.com/sebastian-software/ferriki/commit/00ae48368c3411898ef5909e8bbc39c52b0a2af2))
* **ci:** point pnpm setup at node workspace and repair lint/typecheck ([561e8c9](https://github.com/sebastian-software/ferriki/commit/561e8c92ab764b04e5348e72796d6fdeb1275cdc))
* **compat:** restore vue injection parity ([167b26d](https://github.com/sebastian-software/ferriki/commit/167b26dda2e129c94380ff68c42b1c278b5e7d9c))
* **core:** normalize standard assets and restore native shiki parity ([9514886](https://github.com/sebastian-software/ferriki/commit/95148866b0ec88a09746cb855d9985c472255332))
* **core:** remove astro renderer fallback ([7e70caf](https://github.com/sebastian-software/ferriki/commit/7e70cafc1f61f4f5be589d3b1dab08cc63df6edd))
* **core:** remove vue renderer fallback ([b9f6c1d](https://github.com/sebastian-software/ferriki/commit/b9f6c1d17f8c358a1af02cc823cdb2b6b3ad142e))
* **node:** exclude legacy addon from tarball via explicit globs ([bada0d5](https://github.com/sebastian-software/ferriki/commit/bada0d532ac1ed110717dd4a126c76fb93271d4b))
* **node:** preserve core function signatures ([c29bbf1](https://github.com/sebastian-software/ferriki/commit/c29bbf127b439b0b2f7eb692eb4ff03429fbd0ff))
* **node:** replace transitional shiki-rust naming and re-guard the workspace root ([f9802ae](https://github.com/sebastian-software/ferriki/commit/f9802aef272cd2c90775ec63d63f0c12e828a35f))
* **node:** replace transitional shiki-rust naming with ferriki ([4b75c7c](https://github.com/sebastian-software/ferriki/commit/4b75c7c2ff489f1d398edcf416cf1c6557969268))
* **node:** ship standard assets ([bfb2f08](https://github.com/sebastian-software/ferriki/commit/bfb2f08b5de0a8af32cbb58c0411eb5332c1e837))
* reject unsupported public api options ([1025b18](https://github.com/sebastian-software/ferriki/commit/1025b188fe81908c2d9983b68eaaeb0c4f9a8cde))
* reject unsupported public API options ([3ed3dfb](https://github.com/sebastian-software/ferriki/commit/3ed3dfb59fa277b492c56163aff0bed539b523b0))
* require Node 20, matching upstream shiki@4 and @shikijs/types ([e56d084](https://github.com/sebastian-software/ferriki/commit/e56d0844392cd7ec7c444b1fc6296af01a2fcded))
* resolve windows native target ([47fcf38](https://github.com/sebastian-software/ferriki/commit/47fcf38471a599f3eed0405e955de4fdb9d9d218))
* sort the npm files array for jsonc lint ([7bf465a](https://github.com/sebastian-software/ferriki/commit/7bf465a6a5d0ad5bf13831b75e1f9e6eece4243f))

## [0.2.1](https://github.com/sebastian-software/ferriki/compare/v0.2.0...v0.2.1) (2026-09-06)

### Features

* **node:** prepare the native sidecar release candidate and public install verification

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
