import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";

const composerProject = (nodeRoot) => join(nodeRoot, "benchmarks", "phiki");
const phpWorker = (nodeRoot) => join(nodeRoot, "scripts", "phiki-benchmark-worker.php");
const phpIniArgs = [
  "-d",
  "opcache.enable_cli=0",
  "-d",
  "opcache.jit=disable",
  "-d",
  "opcache.jit_buffer_size=0",
];

function commandResult(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", ...options });
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function npmPackage(nodeRoot, name) {
  return JSON.parse(readFileSync(join(nodeRoot, "node_modules", name, "package.json"), "utf8"));
}

function phpRuntime(command) {
  const result = commandResult(command, [
    ...phpIniArgs,
    "-r",
    'echo json_encode(["version"=>PHP_VERSION,"versionId"=>PHP_VERSION_ID,"sapi"=>PHP_SAPI,"mbstring"=>extension_loaded("mbstring"),"oniguruma"=>defined("MB_ONIGURUMA_VERSION")?MB_ONIGURUMA_VERSION:null,"opcacheLoaded"=>extension_loaded("Zend OPcache"),"opcacheEnabled"=>ini_get("opcache.enable"),"opcacheCli"=>ini_get("opcache.enable_cli"),"jit"=>ini_get("opcache.jit"),"jitBufferSize"=>ini_get("opcache.jit_buffer_size"),"xdebug"=>extension_loaded("xdebug")], JSON_THROW_ON_ERROR);',
  ]);
  if (result.error || result.status !== 0) return undefined;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
}

function unavailable(reason, runtime) {
  return { status: "skipped", reason, runtime };
}

/** Check optional local prerequisites without installing or contacting Composer. */
export function checkPhikiPrerequisites(nodeRoot) {
  const php = process.env.FERRIKI_BENCH_PHP ?? "php";
  const composer = process.env.FERRIKI_BENCH_COMPOSER ?? "composer";
  const runtime = phpRuntime(php);
  if (!runtime) return unavailable(`PHP executable “${php}” is unavailable.`, null);
  if (runtime.versionId < 80300)
    return unavailable(
      `PHP ${runtime.version} is installed; the benchmark requires PHP 8.3 or later.`,
      runtime,
    );
  if (!runtime.mbstring || !runtime.oniguruma) {
    return unavailable("PHP mbstring with its Oniguruma regex backend is required.", runtime);
  }

  const composerResult = commandResult(composer, ["--version", "--no-ansi"]);
  if (composerResult.error || composerResult.status !== 0) {
    return unavailable(`Composer executable “${composer}” is unavailable.`, runtime);
  }

  const project = composerProject(nodeRoot);
  const lockPath = join(project, "composer.lock");
  if (!existsSync(lockPath)) {
    return unavailable(
      "The optional Phiki benchmark has no composer.lock; run composer update in node/benchmarks/phiki.",
      runtime,
    );
  }
  if (!existsSync(join(project, "vendor", "autoload.php"))) {
    return unavailable(
      "Phiki dependencies are not installed; run composer install --no-interaction --working-dir=node/benchmarks/phiki.",
      runtime,
    );
  }

  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const packages = new Map(
    (lock.packages ?? []).map((packageInfo) => [packageInfo.name, packageInfo.version]),
  );
  if (packages.get("phiki/phiki") !== "v2.2.1") {
    return unavailable(
      `composer.lock must pin phiki/phiki v2.2.1 (found ${packages.get("phiki/phiki") ?? "no Phiki package"}).`,
      runtime,
    );
  }

  const version = composerResult.stdout.match(/^Composer version\s+([^\s]+)/m)?.[1] ?? "unknown";
  return {
    status: "available",
    php,
    composer,
    composerVersion: version,
    runtime,
    project,
    lockPath,
    phikiVersion: packages.get("phiki/phiki"),
    psrSimpleCacheVersion: packages.get("psr/simple-cache") ?? null,
  };
}

/** Build an identical, recursively embedded asset set from the lockfile-pinned Node assets. */
export async function createPhikiSetup({ nodeRoot, repoRoot, langs, theme, docs, prerequisites }) {
  const [{ grammars, injections }, { themes }] = await Promise.all([
    import("tm-grammars"),
    import("tm-themes"),
  ]);
  const grammarIndex = new Map([...grammars, ...injections].map((entry) => [entry.name, entry]));
  const pending = [...new Set(langs)];
  const selected = new Set();
  while (pending.length > 0) {
    const name = pending.shift();
    if (selected.has(name)) continue;
    const metadata = grammarIndex.get(name);
    if (!metadata) throw new Error(`Pinned tm-grammars ${name} metadata is missing.`);
    selected.add(name);
    pending.push(...(metadata.embedded ?? []));
  }

  const grammarRoot = join(nodeRoot, "node_modules", "tm-grammars", "grammars");
  const grammarFiles = {};
  const grammarDigests = [];
  const grammarScopes = new Set();
  for (const name of [...selected].sort()) {
    const path = join(grammarRoot, `${name}.json`);
    if (!existsSync(path)) throw new Error(`Pinned tm-grammars asset ${name}.json is missing.`);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    grammarFiles[name] = path;
    grammarDigests.push({ name, scopeName: raw.scopeName, sha256: sha256(path) });
    grammarScopes.add(raw.scopeName);
  }

  // tm-grammars also publishes grammars that attach to other scopes through
  // TextMate's external injectionSelector/injectTo metadata. Phiki 2.2.1 has
  // no public equivalent of Shiki's external injection registry. Inventory
  // candidates that target this asset closure so the report can distinguish
  // them from ordinary recursively embedded grammars.
  const injectionAssets = injections
    .filter(
      (entry) =>
        (entry.injectTo ?? []).some((scope) => grammarScopes.has(scope)) ||
        (entry.embeddedIn ?? []).some((name) => selected.has(name)),
    )
    .map((entry) => {
      const path = join(grammarRoot, `${entry.name}.json`);
      if (!existsSync(path))
        throw new Error(`Pinned tm-grammars injection asset ${entry.name}.json is missing.`);
      const raw = JSON.parse(readFileSync(path, "utf8"));
      return {
        name: entry.name,
        scopeName: raw.scopeName ?? null,
        injectionSelector: raw.injectionSelector ?? null,
        embeddedIn: entry.embeddedIn ?? [],
        injectTo: entry.injectTo ?? [],
        sha256: sha256(path),
        activation:
          selected.has(entry.name) && typeof raw.injectionSelector !== "string"
            ? "registered-as-recursive-embedded-grammar"
            : "unsupported-external-injection-activation",
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  const themeMetadata = themes.find((entry) => entry.name === theme);
  const themePath = join(nodeRoot, "node_modules", "tm-themes", "themes", `${theme}.json`);
  if (!themeMetadata || !existsSync(themePath))
    throw new Error(`Pinned tm-themes asset ${theme}.json is missing.`);
  const grammarPackage = npmPackage(nodeRoot, "tm-grammars");
  const themePackage = npmPackage(nodeRoot, "tm-themes");
  const shikiPackage = npmPackage(nodeRoot, "shiki");
  const ferrikiPackage = JSON.parse(
    readFileSync(join(nodeRoot, "ferriki", "package.json"), "utf8"),
  );
  const composerLock = readFileSync(prerequisites.lockPath);

  return {
    prerequisites,
    workerPath: phpWorker(nodeRoot),
    setup: {
      repoRoot,
      grammarFiles,
      themePath,
      theme,
      documents: docs.map(({ lang, path }) => ({ lang, path })),
    },
    assets: {
      theme,
      themeSha256: sha256(themePath),
      grammarCount: grammarDigests.length,
      grammars: grammarDigests,
      injections: injectionAssets,
      unsupportedInjectionCount: injectionAssets.filter((entry) =>
        entry.activation.startsWith("unsupported"),
      ).length,
      composerLockSha256: createHash("sha256").update(composerLock).digest("hex"),
    },
    versions: {
      ferriki: ferrikiPackage.version,
      shiki: shikiPackage.version,
      tmGrammars: grammarPackage.version,
      tmThemes: themePackage.version,
      phiki: prerequisites.phikiVersion,
      psrSimpleCache: prerequisites.psrSimpleCacheVersion,
      php: prerequisites.runtime.version,
      composer: prerequisites.composerVersion,
    },
  };
}

class JsonLineWorker {
  constructor(child) {
    this.child = child;
    this.responses = [];
    this.waiters = [];
    this.stderr = "";
    this.exitError = null;
    this.exit = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        this.exitError = new Error(
          `PHP worker exited ${signal ? `from ${signal}` : `with status ${code}`}${this.stderr ? `: ${this.stderr}` : ""}`,
        );
        for (const waiter of this.waiters.splice(0)) waiter.reject(this.exitError);
        resolve(code);
      });
      child.once("error", (error) => {
        this.exitError = error;
        for (const waiter of this.waiters.splice(0)) waiter.reject(error);
        resolve(null);
      });
    });

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        const error = new Error(`PHP worker returned invalid JSON: ${line.slice(0, 200)}`);
        for (const waiter of this.waiters.splice(0)) waiter.reject(error);
        return;
      }
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(value);
      else this.responses.push(value);
    });
    child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-4000);
    });
  }

  receive() {
    if (this.responses.length > 0) return Promise.resolve(this.responses.shift());
    if (this.exitError) return Promise.reject(this.exitError);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  async request(value) {
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
    return this.receive();
  }

  async close() {
    if (this.exitError) return;
    await this.request({ op: "shutdown" });
    this.child.stdin.end();
    await this.exit;
  }
}

export async function startPhikiWorker(nodeRoot, prepared) {
  const { php } = prepared.prerequisites;
  const child = spawn(
    php,
    [...phpIniArgs, prepared.workerPath, "--warm", JSON.stringify(prepared.setup)],
    {
      cwd: nodeRoot,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const worker = new JsonLineWorker(child);
  const ready = await worker.receive();
  if (!ready.ready || !ready.runtime) {
    throw new Error(ready.error ?? "PHP worker did not report readiness.");
  }
  return { worker, runtime: ready.runtime };
}

export function renderPhikiCold(nodeRoot, prepared, docs) {
  const setup = {
    ...prepared.setup,
    documents: docs.map(({ lang, path }) => ({ lang, path })),
  };
  const result = commandResult(
    prepared.prerequisites.php,
    [...phpIniArgs, prepared.workerPath, "--cold", JSON.stringify(setup)],
    { cwd: nodeRoot, maxBuffer: 4 * 1024 * 1024 },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `Cold Phiki process failed: ${result.stderr || result.error?.message || result.status}`,
    );
  }
  try {
    const report = JSON.parse(result.stdout);
    if (report.documents !== docs.length)
      throw new Error("Cold Phiki document count differs from the requested cohort.");
    return report.elapsedMs;
  } catch (error) {
    throw new Error(`Cold Phiki worker returned an invalid result: ${error.message}`);
  }
}

export { phpIniArgs };
