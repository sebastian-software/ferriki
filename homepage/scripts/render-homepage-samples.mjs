/* eslint-disable security/detect-non-literal-fs-filename -- Paths are a fresh temporary directory and fixed files in this repository. */
// Renders every specimen on the homepage with the published npm packages and
// writes app/data/homepage-samples.json. The page imports that file; nobody
// edits it by hand.
//
//   node scripts/render-homepage-samples.mjs          # write the file
//   node scripts/render-homepage-samples.mjs --check  # fail when it drifted
//
// Writing renders with the versions the site documents, node/ferriki/package.json
// and node/vite/package.json, and records them in `renderedWith`. The check
// renders again with the recorded versions, so a release pull request that
// bumps the manifests before npm has the new version still passes; the page
// keeps crediting the release that produced its specimens until the next write.
// The packages install from npm into a temporary directory with lifecycle
// scripts disabled and download their grammars and themes into a cache inside
// it, so the site's own dependency tree and the repository's asset cache stay
// untouched. Run the write again after a release.
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const check = process.argv.includes("--check");
const target = new URL("../app/data/homepage-samples.json", import.meta.url);
const manifest = async (path) =>
  JSON.parse(await readFile(new URL(`../../${path}`, import.meta.url), "utf8"));
const recorded = check ? JSON.parse(await readFile(target, "utf8")).renderedWith : undefined;
const coreManifest = await manifest("node/ferriki/package.json");
const viteManifest = await manifest("node/vite/package.json");
const packages = {
  "@ferriki/core": recorded?.["@ferriki/core"] ?? coreManifest.version,
  "@ferriki/vite": recorded?.["@ferriki/vite"] ?? viteManifest.version,
};

/** The diagnostics the homepage shows, in a fixed order. */
const pick = ({
  mode,
  preparedArchives,
  loadedPreparedGroups,
  staticScanners,
  dynamicScanners,
  invalidPreparedGroups,
  assemblyFallbacks,
}) => ({
  mode,
  preparedArchives,
  loadedPreparedGroups,
  staticScanners,
  dynamicScanners,
  invalidPreparedGroups,
  assemblyFallbacks,
});

const directory = await mkdtemp(join(tmpdir(), "ferriki-homepage-samples-"));
try {
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify({ private: true, type: "module", dependencies: packages }, null, 2)}\n`,
  );
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: directory,
    stdio: check ? "ignore" : "inherit",
  });
  process.env.FERRIKI_CACHE_DIR = join(directory, "cache");
  const require = createRequire(join(directory, "package.json"));
  const load = async (name) => {
    const installed = JSON.parse(
      await readFile(join(directory, "node_modules", name, "package.json"), "utf8"),
    );
    if (installed.version !== packages[name]) {
      throw new Error(`Installed ${name} ${installed.version}, expected ${packages[name]}`);
    }
    return import(pathToFileURL(require.resolve(name)).href);
  };
  const { createHighlighter, ferrikiVersion } = await load("@ferriki/core");
  const { ferriki } = await load("@ferriki/vite");

  // The light themes keep every token above 4.5:1 contrast on their ground.
  const light = "github-light-default";
  const highlighter = await createHighlighter({
    langs: ["html", "typescript", "tsx", "javascript", "rust"],
    themes: [light, "github-dark-default", "monokai"],
  });

  /* ---------- The token register: one file, three languages ---------- */
  const page = await readFile(new URL("sample-input.html", import.meta.url), "utf8");
  // Classes mode hands transformers every token with its full scope path.
  let lines = [];
  highlighter.codeToHtml(page, {
    lang: "html",
    theme: light,
    styleMode: "classes",
    transformers: [
      {
        tokens(tokens) {
          lines = tokens;
        },
      },
    ],
  });
  if (lines.map((line) => line.map((token) => token.content).join("")).join("\n") !== page) {
    throw new Error("The token stream does not reproduce the source");
  }
  // The file's final newline leaves one empty line; the sheet ends before it.
  if (lines.at(-1)?.length === 0) lines = lines.slice(0, -1);
  // Each distinct scope path once; a token points at its path by index.
  const paths = [];
  const pathIndex = (scopeNames = []) => {
    const key = scopeNames.join(" ");
    const found = paths.findIndex((path) => path.join(" ") === key);
    if (found !== -1) return found;
    paths.push([...scopeNames]);
    return paths.length - 1;
  };
  // The theme's own ground, from the inline-styled rendering of the same file.
  const background = /^<pre[^>]*style="background-color:(#[\da-f]+)/i.exec(
    highlighter.codeToHtml(page, { lang: "html", theme: light }),
  )?.[1];
  if (background === undefined) throw new Error(`${light} names no background color`);
  const register = {
    file: "index.html",
    lang: "html",
    theme: light,
    background,
    lines: lines.map((line) =>
      line.map(({ content, color, fontStyle, scopeNames }) => {
        // The page sets each token's color only; a theme that adds italics would need more.
        if (fontStyle) throw new Error(`${light} styles "${content}" beyond its color`);
        return { content, color: color?.toUpperCase(), path: pathIndex(scopeNames) };
      }),
    ),
    paths,
  };

  /* ---------- Prepared packages: the same file, two regex policies ---------- */
  const policy = async (regexMode) => {
    const fresh = await createHighlighter({
      langs: ["html"],
      themes: [light],
      ...(regexMode ? { regexMode } : {}),
    });
    try {
      const html = fresh.codeToHtml(page, { lang: "html", theme: light });
      return { html, diagnostics: fresh.getRegexDiagnostics() };
    } finally {
      fresh.dispose();
    }
  };
  const prepared = await policy();
  const source = await policy("auto");
  if (prepared.html !== source.html) {
    throw new Error("Prepared and source highlighting must produce the same HTML");
  }
  /* ---------- Themes as a stylesheet ---------- */
  const themed = `type Greeting = { name: string };

export function greet({ name }: Greeting) {
  // Template literals keep their own colors.
  return \`Hello, \${name}!\`;
}`;
  const themes = { light, dark: "github-dark-default", monokai: "monokai" };
  const classes = highlighter.codeToHtmlWithCss(themed, { lang: "typescript", themes });

  /* ---------- Build time: the Vite adapter ---------- */
  const id = "/src/Answer.tsx";
  const component = `import { Code } from "@ferriki/core/react/macro";

export function Answer() {
  return (
    <Code
      language="ts"
      source={\`export const answer = 42;\`}
    />
  );
}
`;
  // One light theme, inline styles: the page's own ground, not a dark field.
  const plugin = ferriki({ theme: light });
  const warnings = [];
  const context = {
    warn(message) {
      warnings.push(message);
    },
    error(error) {
      throw error;
    },
  };
  const transformed = await plugin.transform.handler.call(context, component, id);
  if (!transformed) throw new Error("@ferriki/vite left the macro sample unchanged");
  if (warnings.length > 0) throw new Error(`@ferriki/vite warned:\n${warnings.join("\n")}`);
  const blocks = Object.values(plugin.api.codeElementBlocks());
  if (blocks.length !== 1) throw new Error(`Expected one prepared block, got ${blocks.length}`);

  /* ---------- Code: the two entry points, highlighted by Ferriki ---------- */
  const node = `import { createHighlighter } from "@ferriki/core";

const highlighter = await createHighlighter({
  langs: ["typescript"],
  themes: ["github-light-default"],
});
try {
  const html = highlighter.codeToHtml("const answer = 42;", {
    lang: "typescript",
    theme: "github-light-default",
  });
  console.log(html);
} finally {
  highlighter.dispose();
}`;
  // The Rust guide's first program (rust/getting-started.mdx), in the light theme.
  const rust = `use ferriki::{
    Highlighter, RemoteAssets, RenderOptions,
    StandardAssetCatalogs, render_html,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let assets = StandardAssetCatalogs::remote(RemoteAssets::default())?;
    let mut highlighter = Highlighter::builder()
        .with_assets(assets)
        .load_languages(["rust"])
        .load_themes(["github-light-default"])
        .build()?;

    let tokens = highlighter.highlight(
        "fn main() { println!(\\"Hello, Ferriki!\\"); }",
        "rust",
        "github-light-default",
    )?;
    let html = render_html(&tokens, &RenderOptions::default());
    println!("{html}");
    Ok(())
}`;
  const answer = highlighter.codeToHtml("const answer = 42;", {
    lang: "typescript",
    theme: light,
  });

  const samples = {
    note: "Generated by scripts/render-homepage-samples.mjs with the npm packages in renderedWith. Do not hand-edit.",
    renderedWith: { ...packages, native: ferrikiVersion() },
    register,
    prepared: {
      file: "index.html",
      sameHtml: true,
      prepared: pick(prepared.diagnostics),
      source: pick(source.diagnostics),
    },
    themes: { source: themed, lang: "typescript", themes, html: classes.html, css: classes.css },
    macro: {
      id,
      source: component,
      sourceHtml: highlighter.codeToHtml(component, { lang: "tsx", theme: light }),
      preparedHtml: blocks[0],
    },
    code: {
      theme: light,
      node: {
        file: "example.mjs",
        html: highlighter.codeToHtml(node, { lang: "javascript", theme: light }),
      },
      rust: { file: "main.rs", html: highlighter.codeToHtml(rust, { lang: "rust", theme: light }) },
      answer,
    },
  };
  highlighter.dispose();

  if (check) {
    const committed = JSON.parse(await readFile(target, "utf8"));
    if (JSON.stringify(committed) !== JSON.stringify(samples)) {
      throw new Error(
        "The homepage samples changed. Run pnpm homepage-samples:write and commit the result.",
      );
    }
    console.log(`The committed homepage samples match @ferriki/core ${packages["@ferriki/core"]}.`);
  } else {
    await writeFile(target, `${JSON.stringify(samples, null, 2)}\n`);
    // Format in the generator, so the committed file passes format:check as written.
    execFileSync(
      new URL("../node_modules/.bin/oxfmt", import.meta.url).pathname,
      [target.pathname],
      { cwd: new URL("..", import.meta.url).pathname },
    );
    console.log(`Rendered the homepage samples with @ferriki/core ${packages["@ferriki/core"]}.`);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
