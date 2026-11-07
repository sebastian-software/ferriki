// Generated from the published facade manifest, Cargo.toml and the asset catalog
// before development, typecheck and build (scripts/write-site-data.mjs).
import site from "./data/site.json";

export const { version, themeCount } = site;

/** "1.3" for "1.3.0": the release line the homepage names. */
export const releaseLine = version.split(".").slice(0, 2).join(".");

/** The minimum toolchains, as "22.13" for "22.13.0". */
const short = (value: string) => value.replace(/\.0$/, "");
export const rustVersion = short(site.rustVersion);
export const nodeVersion = short(site.nodeVersion);
