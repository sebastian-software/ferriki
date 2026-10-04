/**
 * JSX marker replaced by `@ferriki/vite` before the React JSX transform.
 * Its `source` must be a direct string or non-interpolated template literal.
 * Optional `render` and `className` expressions remain application code.
 *
 * @param {object} props
 * @returns {never} Throws if the build integration did not replace this element.
 */
export function Code(props) {
  void props;
  throw new Error(
    "Code is a compile-time React macro and must be transformed by @ferriki/vite. Add ferriki() before your React plugin and supply static source and highlighting options.",
  );
}
