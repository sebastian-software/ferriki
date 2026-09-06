import type { HighlighterOptions, HighlighterSyncOptions, HighlightOptions } from "./index.d.mts";

const highlighterOptions: HighlighterOptions = {
  langs: ["typescript"],
  themes: ["nord"],
  langAlias: { ts: "typescript" },
};

const syncOptions: HighlighterSyncOptions = {
  langs: ["typescript"],
  themes: ["nord"],
};

const highlightOptions: HighlightOptions = {
  lang: "typescript",
  theme: "nord",
  defaultColor: false,
};

void highlighterOptions;
void syncOptions;
void highlightOptions;

// @ts-expect-error Unsupported factory options must not pass through the public type.
const unsupportedFactoryOption: HighlighterOptions = { engine: "javascript" };

// @ts-expect-error Unsupported synchronous factory options must not pass through the public type.
const unsupportedSyncOption: HighlighterSyncOptions = { wasmBinary: new Uint8Array() };

const unsupportedHighlightOption: HighlightOptions = {
  lang: "typescript",
  theme: "nord",
  // @ts-expect-error Unsupported highlight options must not pass through the public type.
  unknown: true,
};

void unsupportedFactoryOption;
void unsupportedSyncOption;
void unsupportedHighlightOption;
