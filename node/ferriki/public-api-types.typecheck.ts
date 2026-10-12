import type {
  HighlighterOptions,
  HighlighterSyncOptions,
  HighlightOptions,
  ShikiTransformer,
} from "./index.d.mts";

type AssertTrue<T extends true> = T;
type FerrikiPublicApi = typeof import("./index.d.mts");
type RemovedOutputNames =
  | "codeToHast"
  | "codeToTokens"
  | "codeToTokensBase"
  | "codeToTokensWithThemes"
  | "hastToHtml";
type _NoStructuredOutputExports = AssertTrue<
  [Extract<keyof FerrikiPublicApi, RemovedOutputNames>] extends [never] ? true : false
>;

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

// HAST hooks run while the tree is being assembled. Wrapper fields need guards.
const stageAwareTransformer: ShikiTransformer = {
  span() {
    // @ts-expect-error The pre wrapper does not exist during token span hooks.
    this.pre.properties.class = "unsafe";
    // @ts-expect-error The code wrapper does not exist during token span hooks.
    this.code.properties.class = "unsafe";
  },
  root() {
    if (this.pre) this.addClassToHast(this.pre, "guarded");
    if (this.code) this.addClassToHast(this.code, "guarded");
  },
};
void stageAwareTransformer;
