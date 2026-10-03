import { type ComparisonRow, ComparisonTable, type Contender } from "ferramenta-family";

const ferriki: Contender[] = [{ id: "ferriki", label: "Ferriki", own: true }];

const scopeRows: ComparisonRow[] = [
  {
    label: "Highlighting runtime and direct output APIs",
    detail: "codeToHtml, codeToHast and codeToTokens.",
    values: { ferriki: { mark: "yes", note: "Part of Ferriki" } },
  },
  {
    label: "Transformers and decorations",
    detail: "JavaScript hooks around the native pipeline.",
    values: {
      ferriki: { mark: "partial", note: "The @shikijs/transformers package is external." },
    },
  },
  {
    label: "rehype, markdown-it and other adapters",
    detail: "Adapters build on codeToHtml and codeToHast.",
    values: { ferriki: { mark: "no", note: "Outside Ferriki." } },
  },
  {
    label: "Browser runtime, WASM and engine selection",
    detail: "Ferriki runs in Node.js and Rust.",
    values: { ferriki: { mark: "no", note: "Not a goal." } },
  },
];

const platformRows: ComparisonRow[] = [
  {
    label: "linux-x64-gnu, linux-arm64-gnu",
    detail: "Linux, glibc",
    values: { ferriki: { mark: "yes", note: "Supported" } },
  },
  {
    label: "linux-x64-musl, linux-arm64-musl",
    detail: "Linux, musl (Alpine)",
    values: { ferriki: { mark: "yes", note: "Supported" } },
  },
  {
    label: "darwin-arm64",
    detail: "macOS on Apple Silicon",
    values: { ferriki: { mark: "yes", note: "Supported" } },
  },
  {
    label: "win32-x64-msvc, win32-arm64-msvc",
    detail: "Windows",
    values: { ferriki: { mark: "yes", note: "Supported" } },
  },
  {
    label: "darwin-x64",
    detail: "macOS on Intel",
    values: { ferriki: { mark: "no", note: "Not supported" } },
  },
];

/** Compatibility scope rendered with the Family2 comparison component. */
export function CompatibilityScopeTable() {
  return (
    <ComparisonTable
      caption="What Ferriki includes in its compatibility scope."
      subject="Area"
      contenders={ferriki}
      rows={scopeRows}
    />
  );
}

/** Supported Node.js native targets. */
export function CompatibilityPlatformTable() {
  return (
    <ComparisonTable
      caption="Node.js 22.13.0 or newer."
      subject="Native target"
      contenders={ferriki}
      rows={platformRows}
    />
  );
}
