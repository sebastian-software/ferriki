import { expect, it } from "vitest";

it("routes every compatibility entry point through the Ferriki backend", async () => {
  const modules = await Promise.all([
    import("shiki"),
    import("shiki/core"),
    import("shiki/bundle/full"),
    import("@shikijs/engine-javascript"),
    import("@shikijs/engine-oniguruma"),
    import("@shikijs/engine-oniguruma/wasm-inlined"),
  ]);

  expect(modules).toHaveLength(6);
  expect(
    (globalThis as typeof globalThis & { __FERRIKI_COMPAT_NATIVE?: boolean })
      .__FERRIKI_COMPAT_NATIVE,
  ).toBe(true);
});
