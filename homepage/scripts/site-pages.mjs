export const expectedPages = [
  "index.html",
  "guide/getting-started/index.html",
  "guide/migrating-from-shiki/index.html",
  "guide/languages-and-themes/index.html",
  "guide/class-highlighting/index.html",
  "guide/api/index.html",
  "guide/troubleshooting/index.html",
  "rust/getting-started/index.html",
  "evidence/benchmarks/index.html",
  "evidence/compatibility/index.html",
];

export function pagePath(page) {
  return page === "index.html" ? "/" : `/${page.replace(/\/index\.html$/, "")}/`;
}
