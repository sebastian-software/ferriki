import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readLocalGrammar, validateLocalGrammarEntry } from "./local-grammar.mjs";

const COMMIT = /^[a-f0-9]{40}$/;
const REDIRECT_STATUSES = new Set([301, 302, 307, 308]);
export const MAX_UPSTREAM_BYTES = 8 * 1024 * 1024;

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function readBoundedResponse(
  response,
  label,
  { maxBytes = MAX_UPSTREAM_BYTES, collectBytes = false } = {},
) {
  const contentLengthHeader = response.headers?.get?.("content-length");
  if (
    contentLengthHeader !== null &&
    contentLengthHeader !== undefined &&
    /^\d+$/.test(contentLengthHeader.trim())
  ) {
    const declaredLength = Number(contentLengthHeader.trim());
    if (declaredLength > maxBytes) {
      await response.body?.cancel?.();
      throw new Error(
        `${label}: upstream response exceeds ${maxBytes} bytes (Content-Length: ${declaredLength})`,
      );
    }
  }
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const hasher = createHash("sha256");
    const chunks = collectBytes ? [] : null;
    let totalBytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        totalBytes += chunk.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel();
          throw new Error(`${label}: upstream response exceeds ${maxBytes} bytes`);
        }
        hasher.update(chunk);
        if (chunks) chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }
    return {
      sha256: hasher.digest("hex"),
      bytes: chunks ? Buffer.concat(chunks) : null,
      size: totalBytes,
    };
  }
  const bytes =
    typeof response.arrayBuffer === "function"
      ? Buffer.from(await response.arrayBuffer())
      : Buffer.from(await response.text(), "utf8");
  if (bytes.byteLength > maxBytes) {
    throw new Error(`${label}: upstream response exceeds ${maxBytes} bytes`);
  }
  return {
    sha256: digest(bytes),
    bytes: collectBytes ? bytes : null,
    size: bytes.byteLength,
  };
}

export function parseRepoPins(rawJson, expectedRepoIds) {
  if (typeof rawJson === "string" && rawJson.trim() === "") {
    throw new Error("Empty --repo-pins value: expected a JSON object");
  }
  const parsed = typeof rawJson === "string" ? JSON.parse(rawJson) : rawJson;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid repository pins payload: expected a JSON object");
  }
  const keys = Object.keys(parsed);
  if (
    keys.length !== expectedRepoIds.size ||
    keys.some((id) => !expectedRepoIds.has(id))
  ) {
    throw new Error("Repository pins set drift against assets/grammars/repositories.json");
  }
  for (const [id, commit] of Object.entries(parsed)) {
    if (typeof commit !== "string" || !COMMIT.test(commit)) {
      throw new Error(`Invalid resolved commit pin for ${id}: ${commit}`);
    }
  }
  return parsed;
}

export async function resolveRepositoryPins({
  config,
  token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "",
  fetchImpl = fetch,
}) {
  if (!Array.isArray(config?.repositories)) {
    throw new TypeError("Invalid repository config: assets/grammars/repositories.json");
  }
  const apiHeaders = {
    Accept: "application/vnd.github+json",
    "User-Agent": "ferriki-grammar-verifier",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const pins = {};
  for (const repo of config.repositories) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo?.repository ?? "") || !repo?.ref) {
      throw new Error(`Invalid repository config entry: ${repo?.id}`);
    }
    const response = await fetchPinnedGithub(
      `https://api.github.com/repos/${repo.repository}/commits/${encodeURIComponent(repo.ref)}`,
      { allowedHosts: ["api.github.com"], headers: apiHeaders, fetchImpl },
    );
    if (!response.ok) {
      throw new Error(
        `Failed to resolve commit pin for ${repo.id} (${repo.repository}@${repo.ref}): HTTP ${response.status}`,
      );
    }
    const data = await response.json();
    const commit = data?.sha;
    if (typeof commit !== "string" || !COMMIT.test(commit)) {
      throw new Error(`Invalid resolved commit for ${repo.id}: ${commit}`);
    }
    pins[repo.id] = commit;
  }
  return pins;
}

function rawGitHubUrl(repository, commit, file) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !COMMIT.test(commit))
    throw new Error(`Invalid repository pin: ${repository}@${commit}`);
  if (file.startsWith("/") || file.split("/").includes(".."))
    throw new Error(`Unsafe repository path: ${file}`);
  return `https://raw.githubusercontent.com/${repository}/${commit}/${file.split("/").map(encodeURIComponent).join("/")}`;
}

export async function fetchPinnedGithub(
  url,
  { allowedHosts, headers = {}, fetchImpl = fetch, maxRedirects = 5 },
) {
  const allowed = new Set(allowedHosts);
  const initial = new URL(url);
  let current = initial;
  if (current.protocol !== "https:" || current.port !== "" || !allowed.has(current.hostname)) {
    throw new Error(`Disallowed upstream URL: ${current.href}`);
  }
  let currentHeaders = { ...headers };
  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    const response = await fetchImpl(current.href, {
      headers: currentHeaders,
      redirect: "manual",
      signal: AbortSignal.timeout(60000),
    });
    if (!REDIRECT_STATUSES.has(response.status)) {
      return response;
    }
    if (redirects === maxRedirects) {
      throw new Error(`Too many redirects fetching ${url}`);
    }
    const location = response.headers?.get?.("location");
    if (!location) {
      throw new Error(`Redirect (${response.status}) missing Location header for ${current.href}`);
    }
    const next = new URL(location, current);
    if (next.protocol !== "https:" || next.port !== "" || !allowed.has(next.hostname)) {
      throw new Error(`Disallowed redirect target from ${current.href} to ${next.href}`);
    }
    if (next.origin !== initial.origin) {
      currentHeaders = Object.fromEntries(
        Object.entries(currentHeaders).filter(([key]) => key.toLowerCase() !== "authorization"),
      );
    }
    current = next;
  }
}

export function parseLinguistSubmodules(text) {
  const modules = new Map();
  for (const section of text.split(/\[submodule /).slice(1)) {
    const modulePath = /^\s*path\s*=\s*(\S.*)$/m.exec(section)?.[1].trim();
    const repository =
      /^\s*url\s*=\s*https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\s*$/m.exec(section)?.[1];
    if (modulePath?.startsWith("vendor/grammars/") && repository)
      modules.set(modulePath, repository);
  }
  return modules;
}

export async function verifyLinguistModules({
  snapshot,
  expectedModules,
  token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "",
  fetchImpl = fetch,
}) {
  if (
    !snapshot ||
    !/^[\w.-]+\/[\w.-]+$/.test(snapshot.repository ?? "") ||
    !COMMIT.test(snapshot.commit ?? "")
  )
    throw new Error("Invalid Linguist repository snapshot");
  const apiHeaders = {
    Accept: "application/vnd.github+json",
    "User-Agent": "ferriki-grammar-verifier",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const treeResponse = await fetchPinnedGithub(
    `https://api.github.com/repos/${snapshot.repository}/git/trees/${snapshot.commit}?recursive=1`,
    { allowedHosts: ["api.github.com"], headers: apiHeaders, fetchImpl },
  );
  if (!treeResponse.ok)
    throw new Error(
      `Failed to fetch Linguist tree for ${snapshot.repository}@${snapshot.commit}: HTTP ${treeResponse.status}`,
    );
  const tree = await treeResponse.json();
  if (tree.truncated || !Array.isArray(tree.tree))
    throw new Error(`Truncated or invalid Linguist git tree for ${snapshot.commit}`);
  const gitmodulesResponse = await fetchPinnedGithub(
    rawGitHubUrl(snapshot.repository, snapshot.commit, ".gitmodules"),
    { allowedHosts: ["raw.githubusercontent.com"], fetchImpl },
  );
  if (!gitmodulesResponse.ok)
    throw new Error(
      `Failed to fetch Linguist .gitmodules for ${snapshot.repository}@${snapshot.commit}: HTTP ${gitmodulesResponse.status}`,
    );
  const { bytes: gitmodulesBytes } = await readBoundedResponse(gitmodulesResponse, ".gitmodules", {
    collectBytes: true,
  });
  const submodules = parseLinguistSubmodules(gitmodulesBytes.toString("utf8"));
  for (const modulePath of expectedModules) {
    const actual = snapshot.modules?.[modulePath];
    const gitlink = tree.tree.find((item) => item.path === modulePath && item.type === "commit");
    const repository = submodules.get(modulePath);
    if (!actual || !gitlink || !repository || !COMMIT.test(gitlink.sha))
      throw new Error(`Missing Linguist module gitlink: ${modulePath}`);
    if (actual.repository !== repository || actual.commit !== gitlink.sha)
      throw new Error(
        `Linguist module pin drift for ${modulePath}: expected ${repository}@${gitlink.sha}, got ${actual.repository}@${actual.commit}`,
      );
  }
}

export async function verifyUpstreamBlobs({
  sources,
  baseSources = null,
  fetchImpl = fetch,
  maxBytes = MAX_UPSTREAM_BYTES,
}) {
  const baseById = new Map((baseSources?.languages ?? []).map((entry) => [entry.id, entry]));
  const licensesToVerify = new Map();

  for (const entry of sources.languages) {
    if (entry.repository_id === "local") continue;
    const baseEntry = baseById.get(entry.id);
    const sourceUnchanged =
      baseEntry &&
      baseEntry.repository_id === entry.repository_id &&
      (baseEntry.module ?? null) === (entry.module ?? null) &&
      baseEntry.upstream_repository === entry.upstream_repository &&
      baseEntry.upstream_commit === entry.upstream_commit &&
      baseEntry.upstream_path === entry.upstream_path &&
      baseEntry.source === entry.source &&
      baseEntry.upstream_sha256 === entry.upstream_sha256;
    if (!sourceUnchanged) {
      const response = await fetchPinnedGithub(entry.source, {
        allowedHosts: ["raw.githubusercontent.com"],
        fetchImpl,
      });
      if (!response.ok)
        throw new Error(
          `Failed to fetch pinned grammar source for ${entry.id} (${entry.source}): HTTP ${response.status}`,
        );
      const fetched = await readBoundedResponse(response, entry.id, { maxBytes });
      if (fetched.sha256 !== entry.upstream_sha256)
        throw new Error(
          `Upstream source digest mismatch for ${entry.id}: expected ${entry.upstream_sha256}, fetched ${fetched.sha256}`,
        );
    }

    const licenseUnchanged =
      baseEntry &&
      baseEntry.license === entry.license &&
      baseEntry.license_url === entry.license_url &&
      baseEntry.license_file === entry.license_file;
    if (!licenseUnchanged) {
      const key = `${entry.license_url}\0${entry.license_file}`;
      if (!licensesToVerify.has(key)) {
        licensesToVerify.set(key, {
          id: entry.id,
          license_url: entry.license_url,
          license_file: entry.license_file,
        });
      }
    }
  }

  for (const {
    id,
    license_url: licenseUrl,
    license_file: licenseFile,
  } of licensesToVerify.values()) {
    const response = await fetchPinnedGithub(licenseUrl, {
      allowedHosts: ["raw.githubusercontent.com"],
      fetchImpl,
    });
    if (!response.ok)
      throw new Error(
        `Failed to fetch pinned license for ${id} (${licenseUrl}): HTTP ${response.status}`,
      );
    const fetched = await readBoundedResponse(response, `${id} license`, { maxBytes });
    const expectedLicenseFile = `assets/grammars/licenses/${fetched.sha256}.txt`;
    if (licenseFile !== expectedLicenseFile)
      throw new Error(
        `Upstream license digest mismatch for ${id}: expected ${expectedLicenseFile}, got ${licenseFile}`,
      );
  }
}

async function main() {
  const args = process.argv.slice(2);
  let resolvePins = false;
  let check = false;
  let verifyLinguist = false;
  let verifyUpstream = false;
  let baseCatalogPath = null;
  let baseSourcesPath = null;
  let repoPinsRaw;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--resolve-pins") {
      resolvePins = true;
    } else if (arg === "--check") {
      check = true;
    } else if (arg === "--verify-linguist-modules") {
      verifyLinguist = true;
    } else if (arg === "--verify-upstream-pins") {
      verifyUpstream = true;
    } else if (arg === "--base-catalog" && args[index + 1]) {
      baseCatalogPath = args[++index];
    } else if (arg === "--base-sources" && args[index + 1]) {
      baseSourcesPath = args[++index];
    } else if (arg === "--repo-pins") {
      if (index + 1 >= args.length) throw new Error("--repo-pins requires a JSON object value");
      repoPinsRaw = args[++index];
    } else if (arg.startsWith("--repo-pins=")) {
      repoPinsRaw = arg.slice("--repo-pins=".length);
    } else {
      throw new Error(
        "Usage: node scripts/write-grammar-notices.mjs [--resolve-pins | --check [--base-catalog <path>] [--base-sources <path>] [--repo-pins <json>] [--verify-linguist-modules] [--verify-upstream-pins]]",
      );
    }
  }
  if (resolvePins) {
    if (
      check ||
      baseCatalogPath ||
      baseSourcesPath ||
      repoPinsRaw !== undefined ||
      verifyLinguist ||
      verifyUpstream
    ) {
      throw new Error("--resolve-pins cannot be combined with other flags");
    }
    const root = new URL("../", import.meta.url);
    const config = JSON.parse(
      await readFile(new URL("assets/grammars/repositories.json", root), "utf8"),
    );
    const pins = await resolveRepositoryPins({ config });
    process.stdout.write(`${JSON.stringify(pins)}\n`);
    return;
  }
  if (
    (baseCatalogPath ||
      baseSourcesPath ||
      repoPinsRaw !== undefined ||
      verifyLinguist ||
      verifyUpstream) &&
    !check
  )
    throw new Error(
      "--base-catalog, --base-sources, --repo-pins, --verify-linguist-modules, and --verify-upstream-pins require --check",
    );

  const root = new URL("../", import.meta.url);
  const repoRoot = path.resolve(fileURLToPath(root));
  const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
  const sources = JSON.parse(
    await readFile(new URL("assets/grammars/sources.json", root), "utf8"),
  );
  const { languages } = sources;

  async function readConfinedRegularFile(relativePath) {
    const parts = relativePath.split("/");
    let current = repoRoot;
    for (let index = 0; index < parts.length; index++) {
      current = path.resolve(current, parts[index]);
      if (!current.startsWith(`${repoRoot}${path.sep}`))
        throw new Error(`Path escapes repository root: ${relativePath}`);
      const stat = await lstat(current);
      if (stat.isSymbolicLink())
        throw new Error(
          `Symlinked notice path is not allowed: ${parts.slice(0, index + 1).join("/")}`,
        );
      if (index === parts.length - 1 && !stat.isFile())
        throw new Error(`License notice must be a regular file: ${relativePath}`);
      if (index < parts.length - 1 && !stat.isDirectory())
        throw new Error(
          `Expected directory for notice path: ${parts.slice(0, index + 1).join("/")}`,
        );
    }
    return readFile(current);
  }

  const referencedLicenseFiles = new Set();
  for (const entry of languages) {
    if (
      typeof entry.license_file !== "string" ||
      !/^assets\/grammars\/licenses\/[a-f0-9]{64}\.txt$/.test(entry.license_file)
    )
      throw new Error(`Invalid license file path for ${entry.id}: ${entry.license_file}`);
    referencedLicenseFiles.add(entry.license_file);
  }
  const licenseTexts = new Map();
  for (const file of [...referencedLicenseFiles].sort()) {
    const bytes = await readConfinedRegularFile(file);
    if (!file.endsWith(`${digest(bytes)}.txt`)) throw new Error(`License notice drift: ${file}`);
    licenseTexts.set(file, utf8Decoder.decode(bytes));
  }
  if (check) {
    const repositoriesConfig = JSON.parse(
      utf8Decoder.decode(await readConfinedRegularFile("assets/grammars/repositories.json")),
    );
    if (!Array.isArray(repositoriesConfig?.repositories))
      throw new Error("Invalid repository config: assets/grammars/repositories.json");
    const repoConfigById = new Map(repositoriesConfig.repositories.map((repo) => [repo.id, repo]));
    const configuredRepoIds = new Set(repoConfigById.keys());
    const snapshotRepositories = sources.repositories ?? {};
    const snapshotRepoIds = new Set(Object.keys(snapshotRepositories));
    if (
      configuredRepoIds.size !== repositoriesConfig.repositories.length ||
      configuredRepoIds.size !== snapshotRepoIds.size ||
      repositoriesConfig.repositories.some((repo) => !snapshotRepoIds.has(repo.id))
    )
      throw new Error("Grammar repository set drift: assets/grammars/sources.json");
    const expectedRepoPins =
      repoPinsRaw !== undefined ? parseRepoPins(repoPinsRaw, configuredRepoIds) : null;
    for (const repo of repositoriesConfig.repositories) {
      const snapshot = snapshotRepositories[repo.id];
      if (
        !snapshot ||
        snapshot.repository !== repo.repository ||
        snapshot.ref !== repo.ref ||
        !COMMIT.test(snapshot.commit ?? "")
      )
        throw new Error(`Grammar repository config drift: ${repo.id}`);
      if (expectedRepoPins && snapshot.commit !== expectedRepoPins[repo.id])
        throw new Error(
          `Grammar repository pin drift against resolve-base for ${repo.id}: expected ${expectedRepoPins[repo.id]}, got ${snapshot.commit}`,
        );
      const expectedModules = Array.isArray(repo.modules) ? new Set(repo.modules) : null;
      const actualModules = snapshot.modules ? new Set(Object.keys(snapshot.modules)) : null;
      if (expectedModules) {
        if (
          !actualModules ||
          expectedModules.size !== actualModules.size ||
          [...expectedModules].some((mod) => !actualModules.has(mod))
        )
          throw new Error(`Grammar repository module set drift: ${repo.id}`);
        for (const mod of expectedModules) {
          const pin = snapshot.modules[mod];
          if (!/^[\w.-]+\/[\w.-]+$/.test(pin?.repository ?? "") || !COMMIT.test(pin?.commit ?? ""))
            throw new Error(`Invalid grammar module pin for ${repo.id}/${mod}`);
        }
        if (verifyLinguist && repo.adapter === "linguist") {
          await verifyLinguistModules({ snapshot, expectedModules });
        }
      } else if (actualModules && actualModules.size > 0) {
        throw new Error(`Unexpected grammar repository modules: ${repo.id}`);
      }
    }
    const catalog = JSON.parse(
      utf8Decoder.decode(await readConfinedRegularFile("assets/grammars/catalog.json")),
    );
    if (!Array.isArray(catalog?.languages))
      throw new Error("Invalid grammar catalog: assets/grammars/catalog.json");
    const languageIds = new Set(languages.map((entry) => entry.id));
    if (languageIds.size !== languages.length) throw new Error("Duplicate source language IDs");
    if (
      catalog.languages.length !== languageIds.size ||
      new Set(catalog.languages.map((entry) => entry.id)).size !== languageIds.size ||
      catalog.languages.some((entry) => !languageIds.has(entry.id))
    )
      throw new Error("Grammar catalog selection drift: assets/grammars/catalog.json");
    const selectionFields = [
      "id",
      "grammar_file",
      "scope_name",
      "display_name",
      "aliases",
      "embedded_langs",
      "embedded_langs_lazy",
      "inject_to",
    ];
    const selectionsById = new Map(catalog.languages.map((entry) => [entry.id, entry]));
    if (baseCatalogPath) {
      const baseCatalog = JSON.parse(await readFile(baseCatalogPath, "utf8"));
      if (!Array.isArray(baseCatalog?.languages))
        throw new Error(`Invalid base grammar catalog: ${baseCatalogPath}`);
      const basePrimary = baseCatalog.languages.filter((entry) => entry.role !== "dependency");
      const candidatePrimary = catalog.languages.filter((entry) => entry.role !== "dependency");
      const basePrimaryIds = new Set(basePrimary.map((entry) => entry.id));
      if (
        candidatePrimary.length !== basePrimary.length ||
        candidatePrimary.some((entry) => !basePrimaryIds.has(entry.id))
      )
        throw new Error("Primary grammar catalog selection drift against BASE_SHA");
      const primaryInvariantFields = [
        "role",
        "repository_id",
        "selector",
        "scope_name",
        "display_name",
        "aliases",
        "embedded_langs_lazy",
      ];
      for (const expected of basePrimary) {
        const actual = selectionsById.get(expected.id);
        if (!actual) throw new Error(`Primary grammar dropped from catalog: ${expected.id}`);
        for (const field of primaryInvariantFields) {
          if (JSON.stringify(actual[field]) !== JSON.stringify(expected[field]))
            throw new Error(
              `Primary grammar selection drift against BASE_SHA: ${expected.id}.${field}`,
            );
        }
      }
    }
    for (const entry of languages) {
      if (
        typeof entry.grammar_file !== "string" ||
        !/^[a-z0-9][\w.-]*$/i.test(entry.grammar_file)
      )
        throw new Error(`Invalid grammar file path for ${entry.id}: ${entry.grammar_file}`);
      const selection = selectionsById.get(entry.id);
      if (entry.repository_id === "local") {
        if (selection?.repository_id !== "local" || selection.selector?.path !== entry.upstream_path)
          throw new Error(`Grammar catalog local selection drift: ${entry.id}`);
        validateLocalGrammarEntry(entry);
        await readConfinedRegularFile(entry.upstream_path);
        await readLocalGrammar(repoRoot, entry.upstream_path, entry.upstream_sha256);
        const mitHash = digest(await readConfinedRegularFile("LICENSE-MIT"));
        if (entry.license_file !== `assets/grammars/licenses/${mitHash}.txt`)
          throw new Error(`Local grammar license drift: ${entry.id}`);
      } else {
        if (selection?.repository_id !== entry.repository_id)
          throw new Error(`Grammar catalog repository drift: ${entry.id}`);
        const repoConfig = repoConfigById.get(entry.repository_id);
        const repository = sources.repositories?.[entry.repository_id];
        const pin = entry.module ? repository?.modules?.[entry.module] : repository;
        if (
          !pin ||
          pin.repository !== entry.upstream_repository ||
          pin.commit !== entry.upstream_commit ||
          entry.source !== rawGitHubUrl(pin.repository, pin.commit, entry.upstream_path)
        )
          throw new Error(`Grammar repository pin drift: ${entry.id}`);
        const expectedLicense =
          (entry.module ? repoConfig?.module_licenses?.[entry.module] : null) ??
          repoConfig?.license;
        if (!expectedLicense?.id || !expectedLicense?.path)
          throw new Error(`Missing license rule in repositories.json for ${entry.id}`);
        if (entry.license !== expectedLicense.id)
          throw new Error(`Grammar license ID drift: ${entry.id}`);
        const expectedLicenseUrl = rawGitHubUrl(pin.repository, pin.commit, expectedLicense.path);
        if (entry.license_url !== expectedLicenseUrl)
          throw new Error(`Grammar license URL drift: ${entry.id}`);
      }
      if (selection.selector?.path && entry.upstream_path !== selection.selector.path)
        throw new Error(`Grammar catalog selector path drift: ${entry.id}`);
      if (selection.selector?.module && entry.module !== selection.selector.module)
        throw new Error(`Grammar catalog selector module drift: ${entry.id}`);
      for (const field of selectionFields) {
        if (JSON.stringify(selection[field]) !== JSON.stringify(entry[field]))
          throw new Error(`Grammar catalog metadata drift: ${entry.id}.${field}`);
      }
    }
    if (verifyUpstream) {
      const baseSources = baseSourcesPath
        ? JSON.parse(await readFile(baseSourcesPath, "utf8"))
        : null;
      await verifyUpstreamBlobs({ sources, baseSources });
    }
    const diskLicenseFiles = (await readdir(new URL("assets/grammars/licenses", root)))
      .map((name) => `assets/grammars/licenses/${name}`)
      .sort();
    for (const file of diskLicenseFiles) {
      if (!referencedLicenseFiles.has(file))
        throw new Error(`Unreferenced license notice file: ${file}`);
    }
  }

  const notices = [
    "# Third-party grammar notices",
    "",
    "Ferriki standard grammars come from the following pinned sources. The notices below apply to grammar data, separately from Ferriki's own license.",
    "",
  ];
  const thirdPartyLanguages = languages.filter((entry) => entry.repository_id !== "local");
  for (const file of [...new Set(thirdPartyLanguages.map((entry) => entry.license_file))].sort()) {
    const text = licenseTexts.get(file);
    const entries = thirdPartyLanguages.filter((entry) => entry.license_file === file);
    notices.push(`## ${entries.map((entry) => entry.id).join(", ")}`, "");
    for (const entry of entries)
      notices.push(`- [${entry.id}](${entry.source}) — [${entry.license}](${entry.license_url})`);
    notices.push("", text.trim(), "");
  }
  const noticeFile = new URL("assets/standard/GRAMMAR-NOTICES.md", root);
  const noticeText = `${notices.join("\n")}\n`;
  if (check) {
    if ((await readFile(noticeFile, "utf8")) !== noticeText)
      throw new Error("Grammar notices drift: assets/standard/GRAMMAR-NOTICES.md");
  } else {
    await mkdir(new URL("assets/standard", root), { recursive: true });
    await writeFile(noticeFile, noticeText);
  }
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  await main();
}
