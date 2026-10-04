import { type ComparisonRow, ComparisonTable, type Contender, Measured } from "ferramenta-family";

import footprint from "../data/footprint.json";

// Every size on the footprint page comes from app/data/footprint.json, which
// scripts/write-footprint.mjs measures; scripts/verify-build.mjs checks that
// the prerendered page carries the committed figures.

const size: Contender[] = [{ id: "size", label: "Size", own: true }];

/** "2,775,072 bytes (2.78 MB)" or "70,815 bytes (70.8 kB)". */
function formatBytes(bytes: number): string {
  const short =
    bytes < 1_000_000 ? `${(bytes / 1000).toFixed(1)} kB` : `${(bytes / 1e6).toFixed(2)} MB`;
  return `${bytes.toLocaleString("en-US")} bytes (${short})`;
}

const rows: ComparisonRow[] = [
  {
    label: `${footprint.core.name}, packed`,
    detail: `The npm tarball: the JavaScript API, type declarations, macro markers and the language and theme catalogs, ${footprint.core.files} files.`,
    values: { size: formatBytes(footprint.core.packedBytes) },
  },
  {
    label: `${footprint.core.name}, installed`,
    detail: "The same files, unpacked in node_modules.",
    values: { size: formatBytes(footprint.core.unpackedBytes) },
  },
  {
    label: `Native addon, ${footprint.addon.platform}`,
    detail: `ferriki.node as pnpm run build:native builds it for @ferriki/${footprint.addon.platform}, the only platform package npm installs on that system.`,
    values: { size: formatBytes(footprint.addon.bytes) },
  },
  {
    label: "Grammars and themes",
    detail: "Downloaded when first loaded, verified by SHA-256 and cached. None is bundled.",
    values: { size: "On demand" },
  },
];

/** What an install adds, part by part. */
export function FootprintTable() {
  return (
    <ComparisonTable
      caption="What installing Ferriki adds to a project, in bytes as measured."
      subject="Part"
      contenders={size}
      rows={rows}
      align="end"
    />
  );
}

/** Where and from what the sizes were measured. */
export function FootprintMeasured() {
  return (
    <Measured
      on={footprint.measured}
      machine={`${footprint.addon.platform}, Cargo release profile, ${footprint.addon.toolchain}`}
      revision={
        <a
          href={`https://github.com/sebastian-software/ferriki/commit/${footprint.revision}`}
          translate="no"
        >
          {footprint.revision}
        </a>
      }
    >
      <a href="https://github.com/sebastian-software/ferriki/blob/main/homepage/scripts/write-footprint.mjs">
        homepage/scripts/write-footprint.mjs, after build:native on {footprint.addon.platform}
      </a>
    </Measured>
  );
}
