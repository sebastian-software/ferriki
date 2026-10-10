export const expectedPages = [
  "index.html",
  "guide/getting-started/index.html",
  "guide/build-time-macros/index.html",
  "guide/migrating-from-shiki/index.html",
  "guide/ferriki-vs-prism/index.html",
  "guide/languages-and-themes/index.html",
  "guide/class-highlighting/index.html",
  "guide/api/index.html",
  "guide/troubleshooting/index.html",
  "rust/getting-started/index.html",
  "evidence/benchmarks/index.html",
  "evidence/compatibility/index.html",
  "evidence/footprint/index.html",
];

export function pagePath(page) {
  return page === "index.html" ? "/" : `/${page.replace(/\/index\.html$/, "")}/`;
}
