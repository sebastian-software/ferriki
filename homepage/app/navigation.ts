/*
 * The documentation sections, in reading order. One list feeds the links in
 * the header bar, the menu that stands in for them on a narrow viewport, the
 * sidebar rail and the page titles.
 */
export const documentationSections = [
  {
    id: "guide",
    label: "Guide",
    to: "/guide/getting-started",
    pages: [
      ["Getting started", "/guide/getting-started"],
      ["Build-time macros", "/guide/build-time-macros"],
      ["Migrating from Shiki", "/guide/migrating-from-shiki"],
      ["Ferriki vs Prism", "/guide/ferriki-vs-prism"],
      ["Languages and themes", "/guide/languages-and-themes"],
      ["Class-based output", "/guide/class-highlighting"],
      ["API overview", "/guide/api"],
      ["Troubleshooting", "/guide/troubleshooting"],
    ],
  },
  {
    id: "rust",
    label: "Rust",
    to: "/rust/getting-started",
    pages: [["Start with Rust", "/rust/getting-started"]],
  },
  {
    id: "evidence",
    label: "Evidence",
    to: "/evidence/benchmarks",
    pages: [
      ["Benchmarks", "/evidence/benchmarks"],
      ["Compatibility", "/evidence/compatibility"],
      ["Footprint", "/evidence/footprint"],
    ],
  },
] as const;
