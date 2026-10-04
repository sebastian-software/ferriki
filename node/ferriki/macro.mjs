/**
 * Build-time macro replaced by `@ferriki/vite` with a prepared HTML payload.
 * Calling it in the browser means the Ferriki Vite transform did not run.
 *
 * @param {string} source
 * @param {{language: string, meta?: string, lineNumbers?: boolean}} options
 * @returns {never} Throws if the Vite transform did not replace this call.
 */
export function code(source, options) {
  void source;
  void options;
  throw new Error(
    "code() is a compile-time macro and must be transformed by @ferriki/vite. Add ferriki() to your Vite config and keep this call statically analyzable.",
  );
}
