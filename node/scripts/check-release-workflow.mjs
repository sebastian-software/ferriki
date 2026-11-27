import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, posix } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const { load: loadYaml } = createRequire(new URL("../package.json", import.meta.url))("js-yaml");

function workflowJob(workflow, name) {
  const startMarker = `\n  ${name}:\n`;
  const start = workflow.indexOf(startMarker);
  assert(start >= 0, `release workflow is missing ${name} job`);
  const body = workflow.slice(start + startMarker.length);
  const nextJob = body.search(/\n {2}[a-z0-9-]+:\s*\n/);
  return body.slice(0, nextJob >= 0 ? nextJob : body.length);
}

// Dependency order: `ferriki` depends on the two library crates.
const CRATE_PUBLISH_ORDER = ["ferriki-textmate", "ferriki-asset-gen", "ferriki"];

const PNPM_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "--dir",
  "-F",
  "--filter",
  "--filter-prod",
  "--workspace-concurrency",
  "--config",
  "--store-dir",
  "--modules-dir",
  "--virtual-store-dir",
  "--reporter",
  "--loglevel",
  "--network-concurrency",
]);

const PNPM_ALLOWED_INSTALL_VALUE_OPTIONS = new Set([
  "--workspace-concurrency",
  "--store-dir",
  "--reporter",
  "--loglevel",
  "--network-concurrency",
]);

const PNPM_ALLOWED_INSTALL_FLAGS = new Set([
  "--offline",
  "--prefer-offline",
  "--prefer-frozen-lockfile",
  "--no-prefer-frozen-lockfile",
  "--force",
  "--color",
  "--no-color",
  "--silent",
  "-s",
]);

const EXECUTABLE_STEP_INPUTS = ["prepare-command", "command", "test-command"];

const SHELL_CONDITIONAL_KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "do",
  "while",
  "until",
  "case",
  "!",
]);

const SHELL_PREFIX_KEYWORDS = new Set([
  ...SHELL_CONDITIONAL_KEYWORDS,
  "exec",
  "command",
  "corepack",
  "env",
  "time",
]);

const SHELL_WRAPPERS = new Set(["sh", "bash", "zsh", "dash"]);

const DOCKER_GLOBAL_VALUE_OPTIONS = new Set([
  "-H",
  "--host",
  "--context",
  "--config",
  "-l",
  "--log-level",
]);

const DOCKER_RUN_VALUE_OPTIONS = new Set([
  "-e",
  "--env",
  "--env-file",
  "-v",
  "--volume",
  "-w",
  "--workdir",
  "-u",
  "--user",
  "-p",
  "--publish",
  "--name",
  "--network",
  "--net",
  "--entrypoint",
  "--platform",
  "--shm-size",
  "--mount",
  "--tmpfs",
  "--label",
  "-l",
  "--add-host",
  "--cap-add",
  "--cap-drop",
  "--security-opt",
  "--memory",
  "-m",
  "--cpus",
  "--pid",
  "--ipc",
  "--uts",
  "--hostname",
  "-h",
  "--dns",
  "--device",
  "--ulimit",
  "--log-driver",
  "--log-opt",
  "--pull",
  "--restart",
  "--stop-signal",
  "--stop-timeout",
  "--cgroupns",
  "--gpus",
]);

function scanShellLine(line, initialQuote) {
  let quote = initialQuote;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (character === "\\" && index + 1 < line.length) {
        index++;
        continue;
      }
      if (character === '"') quote = null;
      continue;
    }
    if (character === "\\" && index + 1 < line.length) {
      index++;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "#" && (index === 0 || /\s/.test(line[index - 1]))) {
      return { text: line.slice(0, index), quote: null };
    }
  }
  return { text: line, quote };
}

function splitShellSegmentsWithMeta(command) {
  const segments = [];
  let current = "";
  let quote = null;
  let conditional = false;

  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (quote === "'") {
      current += character;
      if (character === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      current += character;
      if (character === "\\" && index + 1 < command.length) {
        current += command[++index];
        continue;
      }
      if (character === '"') quote = null;
      continue;
    }
    if (character === "\\" && index + 1 < command.length) {
      current += character + command[++index];
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (character === ";" || character === "\n") {
      if (current.trim()) segments.push({ segment: current.trim(), conditional });
      current = "";
      conditional = false;
      continue;
    }
    if (character === "&" && command[index + 1] === "&") {
      if (current.trim()) segments.push({ segment: current.trim(), conditional });
      current = "";
      conditional = true;
      index++;
      continue;
    }
    if (character === "|" && command[index - 1] !== ">") {
      if (current.trim()) segments.push({ segment: current.trim(), conditional });
      current = "";
      conditional = true;
      if (command[index + 1] === "|") index++;
      continue;
    }
    current += character;
  }
  if (current.trim()) segments.push({ segment: current.trim(), conditional });
  return segments;
}

function splitShellSegments(command) {
  return splitShellSegmentsWithMeta(command).map((entry) => entry.segment);
}

function tokenizeShellWords(segment) {
  const tokens = [];
  let current = "";
  let inToken = false;
  let quote = null;

  for (let index = 0; index < segment.length; index++) {
    const character = segment[index];
    if (quote === "'") {
      if (character === "'") {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }
    if (quote === '"') {
      if (character === "\\" && index + 1 < segment.length) {
        current += segment[++index];
      } else if (character === '"') {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }
    if (character === "\\" && index + 1 < segment.length) {
      inToken = true;
      current += segment[++index];
      continue;
    }
    if (character === "'" || character === '"') {
      inToken = true;
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (inToken) {
        tokens.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }
    inToken = true;
    current += character;
  }
  if (inToken) tokens.push(current);
  return tokens;
}

function findHeredocDelimiters(line) {
  const delimiters = [];
  let quote = null;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (character === "\\" && index + 1 < line.length) {
        index++;
        continue;
      }
      if (character === '"') quote = null;
      continue;
    }
    if (character === "\\" && index + 1 < line.length) {
      index++;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "<" && line[index + 1] === "<") {
      if (line[index + 2] === "<") {
        index += 2;
        continue;
      }
      let cursor = index + 2;
      const stripTabs = line[cursor] === "-";
      if (stripTabs) cursor++;
      while (cursor < line.length && (line[cursor] === " " || line[cursor] === "\t")) cursor++;
      let delimiter = "";
      let delimQuote = null;
      while (cursor < line.length) {
        const ch = line[cursor];
        if (delimQuote) {
          if (ch === delimQuote) {
            delimQuote = null;
            cursor++;
            continue;
          }
          delimiter += ch;
          cursor++;
          continue;
        }
        if (ch === "'" || ch === '"') {
          delimQuote = ch;
          cursor++;
          continue;
        }
        if (ch === "\\" && cursor + 1 < line.length) {
          delimiter += line[++cursor];
          cursor++;
          continue;
        }
        if (/[\s;&|<>()]/.test(ch)) break;
        delimiter += ch;
        cursor++;
      }
      if (delimiter) {
        delimiters.push({ delimiter, stripTabs });
        index = cursor - 1;
      }
    }
  }
  return delimiters;
}

function mergeEnvCaseInsensitive(baseEnv, overlayEnv, contextLabel) {
  const result = {};
  const keyByLower = new Map();
  for (const [key, value] of Object.entries(baseEnv ?? {})) {
    const lower = key.toLowerCase();
    if (keyByLower.has(lower)) {
      const existingKey = keyByLower.get(lower);
      assert.equal(
        result[existingKey],
        value,
        `conflicting case-variant env keys (${existingKey} vs ${key}) in ${contextLabel}`,
      );
      delete result[existingKey];
    }
    keyByLower.set(lower, key);
    result[key] = value;
  }
  const overlaySeen = new Map();
  for (const [key, value] of Object.entries(overlayEnv ?? {})) {
    const lower = key.toLowerCase();
    if (overlaySeen.has(lower)) {
      const existingKey = overlaySeen.get(lower);
      assert.equal(
        overlayEnv[existingKey],
        value,
        `conflicting case-variant env keys (${existingKey} vs ${key}) in ${contextLabel}`,
      );
    }
    overlaySeen.set(lower, key);
    if (keyByLower.has(lower)) {
      delete result[keyByLower.get(lower)];
    }
    keyByLower.set(lower, key);
    result[key] = value;
  }
  return result;
}

function getEnvCaseInsensitive(envMap, targetLowerKey) {
  let found;
  for (const [key, value] of Object.entries(envMap ?? {})) {
    if (key.toLowerCase() === targetLowerKey) {
      found = value;
    }
  }
  return found;
}

function unsetEnvCaseInsensitive(envMap, targetKey) {
  const lower = targetKey.toLowerCase();
  for (const key of Object.keys(envMap)) {
    if (key.toLowerCase() === lower) {
      delete envMap[key];
    }
  }
}

function hasProductionEnv(envMap) {
  for (const [key, rawValue] of Object.entries(envMap)) {
    if (rawValue === undefined || rawValue === null) continue;
    const value = String(rawValue).trim().toLowerCase();
    const lowerKey = key.toLowerCase();
    if (lowerKey === "node_env" && value === "production") return true;
    if (
      (lowerKey === "npm_config_production" || lowerKey === "pnpm_config_production") &&
      (value === "true" || value === "1")
    ) {
      return true;
    }
  }
  return false;
}

const SHELL_REDIRECTION_PREFIX = /^(?:\d*(?:>>|>\||>&|<<<|<<-?|<>|<&|[<>])|&>>?)/;

function matchShellRedirection(token) {
  if (typeof token !== "string") return 0;
  const match = SHELL_REDIRECTION_PREFIX.exec(token);
  if (!match) return 0;
  return match[0].length === token.length ? 2 : 1;
}

function parseCommandPrefix(tokens) {
  let conditional = false;
  let grouped = false;
  let changesDir = false;
  let clearEnv = false;
  const inlineEnv = {};
  const unsetEnv = new Set();
  if (tokens.length > 0 && /[)}]+$/.test(tokens[tokens.length - 1])) {
    grouped = true;
    tokens[tokens.length - 1] = tokens[tokens.length - 1].replace(/[)}]+$/, "");
  }
  let index = 0;
  while (index < tokens.length) {
    if (/^[({]+/.test(tokens[index])) {
      grouped = true;
      tokens[index] = tokens[index].replace(/^[({]+/, "");
    }
    if (!tokens[index]) {
      index++;
      continue;
    }
    const redirectionTokens = matchShellRedirection(tokens[index]);
    if (redirectionTokens > 0) {
      index += redirectionTokens;
      continue;
    }
    const base = tokens[index].split("/").at(-1);
    if (SHELL_PREFIX_KEYWORDS.has(tokens[index]) || base === "env") {
      if (SHELL_CONDITIONAL_KEYWORDS.has(tokens[index])) conditional = true;
      const keyword = base;
      index++;
      if (keyword === "env") {
        while (index < tokens.length && tokens[index].startsWith("-")) {
          const flag = tokens[index];
          index++;
          if (flag === "--") break;
          if (
            flag === "-" ||
            flag === "-i" ||
            flag === "--ignore-environment" ||
            /^-[a-z]*i/.test(flag)
          ) {
            clearEnv = true;
            for (const key of Object.keys(inlineEnv)) delete inlineEnv[key];
            unsetEnv.clear();
          }
          if (
            flag === "-C" ||
            flag === "--chdir" ||
            flag.startsWith("--chdir=") ||
            flag.startsWith("-C=") ||
            /^-[a-z]*C/.test(flag)
          ) {
            changesDir = true;
          }
          if ((flag === "-u" || flag === "--unset") && index < tokens.length) {
            unsetEnv.add(tokens[index]);
            unsetEnvCaseInsensitive(inlineEnv, tokens[index]);
            index++;
            continue;
          }
          if (flag.startsWith("--unset=")) {
            const name = flag.slice("--unset=".length);
            unsetEnv.add(name);
            unsetEnvCaseInsensitive(inlineEnv, name);
            continue;
          }
          if ((flag === "-C" || flag === "--chdir") && index < tokens.length) {
            index++;
          }
        }
      }
      continue;
    }
    if (/^[a-z_]\w*=/i.test(tokens[index])) {
      const eq = tokens[index].indexOf("=");
      const key = tokens[index].slice(0, eq);
      inlineEnv[key] = tokens[index].slice(eq + 1);
      unsetEnv.delete(key);
      index++;
      continue;
    }
    break;
  }
  return { index, conditional, grouped, changesDir, clearEnv, inlineEnv, unsetEnv };
}

function findCommandIndex(tokens) {
  return parseCommandPrefix(tokens).index;
}

function collectLineHeredocs(line) {
  const entries = [];
  for (const segment of splitShellSegments(line)) {
    const delimiters = findHeredocDelimiters(segment);
    if (delimiters.length === 0) continue;
    const tokens = tokenizeShellWords(segment);
    const commandIndex = findCommandIndex(tokens);
    const commandName = tokens[commandIndex]?.split("/").at(-1);
    const executable = SHELL_WRAPPERS.has(commandName);
    for (const entry of delimiters) {
      entries.push({ ...entry, executable, lines: [] });
    }
  }
  return entries;
}

function shellScriptCommands(script, depth = 0) {
  if (depth > 8) return [];
  const commands = [];
  const heredocs = [];
  let pending = "";
  let quote = null;

  function flushPending() {
    const trimmed = pending.trim();
    if (trimmed) commands.push(trimmed);
    pending = "";
  }

  for (const rawLine of script.split(/\r?\n/)) {
    if (heredocs.length > 0) {
      const current = heredocs[0];
      const candidate = current.stripTabs ? rawLine.replace(/^\t+/, "") : rawLine;
      if (candidate === current.delimiter) {
        heredocs.shift();
        if (current.executable && current.lines.length > 0) {
          commands.push(...shellScriptCommands(current.lines.join("\n"), depth + 1));
        }
      } else if (current.executable) {
        current.lines.push(candidate);
      }
      continue;
    }

    const scanned = scanShellLine(rawLine, quote);
    if (quote !== null) {
      pending += `\n${scanned.text}`;
      quote = scanned.quote;
      if (quote === null) {
        heredocs.push(...collectLineHeredocs(pending));
        if (pending.trimEnd().endsWith("\\")) {
          pending = `${pending.trimEnd().slice(0, -1)} `;
        } else {
          flushPending();
        }
      }
      continue;
    }

    const uncommented = scanned.text.trim();
    if (!uncommented) {
      flushPending();
      continue;
    }
    quote = scanned.quote;
    if (quote !== null) {
      pending += uncommented;
      continue;
    }
    heredocs.push(...collectLineHeredocs(uncommented));
    if (uncommented.endsWith("\\")) {
      pending += `${uncommented.slice(0, -1)} `;
    } else {
      pending += uncommented;
      flushPending();
    }
  }
  for (const unclosed of heredocs) {
    if (unclosed.executable && unclosed.lines.length > 0) {
      commands.push(...shellScriptCommands(unclosed.lines.join("\n"), depth + 1));
    }
  }
  flushPending();
  return commands;
}

function extractShellWrapperScript(tokens, startIndex) {
  const commandName = tokens[startIndex]?.split("/").at(-1);
  if (!SHELL_WRAPPERS.has(commandName)) return null;
  let sawC = false;
  let optIndex = startIndex + 1;
  while (optIndex < tokens.length) {
    const arg = tokens[optIndex];
    if (arg === "--") {
      optIndex++;
      break;
    }
    if (arg === "-o" || arg === "+o") {
      optIndex += 2;
      continue;
    }
    if (/^-[a-z]+$/i.test(arg)) {
      if (arg.includes("c")) sawC = true;
      optIndex++;
      if (arg.endsWith("o") && !arg.includes("c") && optIndex < tokens.length) {
        optIndex++;
      }
      continue;
    }
    if (/^\+[a-z]+$/i.test(arg)) {
      optIndex++;
      continue;
    }
    break;
  }
  return sawC && optIndex < tokens.length ? tokens[optIndex] : null;
}

function extractDockerRunInnerTokens(tokens, startIndex) {
  const runtime = tokens[startIndex]?.split("/").at(-1);
  if (runtime !== "docker" && runtime !== "podman") return null;
  let cursor = startIndex + 1;
  while (cursor < tokens.length && tokens[cursor].startsWith("-")) {
    const flag = tokens[cursor];
    cursor++;
    if (DOCKER_GLOBAL_VALUE_OPTIONS.has(flag) && cursor < tokens.length) {
      cursor++;
    }
  }
  if (tokens[cursor] === "container") cursor++;
  if (tokens[cursor] !== "run") return null;
  cursor++;
  const envAssignments = {};
  const forwardedEnvKeys = [];
  const recordContainerEnv = (spec) => {
    const eq = spec.indexOf("=");
    if (eq >= 0) {
      envAssignments[spec.slice(0, eq)] = spec.slice(eq + 1);
    } else if (spec) {
      forwardedEnvKeys.push(spec);
    }
  };
  while (cursor < tokens.length) {
    const arg = tokens[cursor];
    if (arg === "--") {
      cursor++;
      break;
    }
    if (!arg.startsWith("-")) break;
    cursor++;
    if ((arg === "-e" || arg === "--env") && cursor < tokens.length) {
      recordContainerEnv(tokens[cursor++]);
      continue;
    }
    if (arg.startsWith("--env=")) {
      recordContainerEnv(arg.slice("--env=".length));
      continue;
    }
    if (arg.startsWith("-e=")) {
      recordContainerEnv(arg.slice("-e=".length));
      continue;
    }
    if (!arg.includes("=") && DOCKER_RUN_VALUE_OPTIONS.has(arg) && cursor < tokens.length) {
      cursor++;
    }
  }
  // Skip the <image> argument; remaining tokens are the container command.
  if (cursor >= tokens.length) return null;
  const inner = tokens.slice(cursor + 1);
  return inner.length > 0 ? { inner, envAssignments, forwardedEnvKeys } : null;
}

function effectivePnpmDir(stepCwd, dirFlag) {
  const base = stepCwd || ".";
  if (
    posix.isAbsolute(base) ||
    base.startsWith("\\") ||
    /^[a-z]:/i.test(base) ||
    (dirFlag && (posix.isAbsolute(dirFlag) || dirFlag.startsWith("\\") || /^[a-z]:/i.test(dirFlag)))
  ) {
    return null;
  }
  const workspaceRoot = "/__workspace__";
  const resolved = dirFlag
    ? posix.resolve(workspaceRoot, base, dirFlag)
    : posix.resolve(workspaceRoot, base);
  if (resolved === workspaceRoot) return ".";
  return resolved.startsWith(`${workspaceRoot}/`) ? resolved.slice(workspaceRoot.length + 1) : null;
}

const PNPM_EXECUTABLES = new Set(["pnpm", "pnpm.cmd", "pnpm.exe"]);
const NPM_EXECUTABLES = new Set(["npm", "npm.cmd", "npm.exe"]);
const NPX_EXECUTABLES = new Set(["npx", "npx.cmd", "npx.exe"]);
const PNPM_SUBCOMMAND_PREFIXES = new Set(["recursive", "m", "multi"]);
const PNPM_FORBIDDEN_SUBCOMMANDS = new Set([
  "add",
  "update",
  "up",
  "upgrade",
  "install-test",
  "it",
  "rebuild",
  "rb",
  "dlx",
]);
const PNPM_MUTATING_SUBCOMMANDS = new Set([
  "prune",
  "remove",
  "rm",
  "uninstall",
  "un",
  "unlink",
  "dedupe",
  "link",
  "ln",
  "patch-commit",
]);
const NPM_FORBIDDEN_SUBCOMMANDS = new Set([
  "rebuild",
  "rb",
  "install-test",
  "it",
  "cit",
  "install-ci-test",
  "add",
  "update",
  "up",
  "upgrade",
  "exec",
  "x",
]);
const NPM_SUBCOMMAND_ALIASES = new Map([
  ["clean-install", "ci"],
  ["ic", "ci"],
  ["install-clean", "ci"],
  ["in", "install"],
  ["ins", "install"],
  ["inst", "install"],
  ["insta", "install"],
  ["instal", "install"],
  ["isnt", "install"],
  ["isnta", "install"],
  ["isntal", "install"],
  ["isntall", "install"],
  ["clean-install-test", "install-ci-test"],
  ["cit", "install-ci-test"],
  ["u", "update"],
  ["up", "update"],
  ["upgrade", "update"],
  ["udpate", "update"],
]);
const NPM_INSTALL_SUBCOMMANDS = new Set(["install", "i", "ci"]);
const NPM_MUTATING_SUBCOMMANDS = new Set([
  "prune",
  "uninstall",
  "remove",
  "rm",
  "r",
  "un",
  "dedupe",
  "ddp",
  "link",
  "ln",
  "unlink",
]);
const NPM_PACK_PUBLISH_SUBCOMMANDS = new Set(["pack", "publish"]);
const PNPM_PACK_PUBLISH_SUBCOMMANDS = new Set(["pack", "publish"]);
const NPM_ALLOWED_SAFE_SUBCOMMANDS = new Set([
  "pack",
  "publish",
  "view",
  "info",
  "show",
  "whoami",
  "ping",
  "dist-tag",
  "ls",
  "list",
]);
const NPM_GLOBAL_VALUE_OPTIONS = new Set([
  "--prefix",
  "-C",
  "--cache",
  "--registry",
  "--userconfig",
  "--globalconfig",
  "--location",
  "--loglevel",
  "--workspace",
  "-w",
  "--workspaces-update",
  "--tag",
  "--omit",
  "--include",
]);
const NPM_GLOBAL_BOOLEAN_FLAGS = new Set([
  "-g",
  "--global",
  "-s",
  "--silent",
  "-q",
  "--quiet",
  "--verbose",
  "--version",
  "-v",
  "--no-audit",
  "--no-fund",
  "--ignore-scripts",
  "--no-ignore-scripts",
  "--workspaces",
  "-ws",
  "--yes",
  "-y",
  "--no-yes",
]);

function applyCommandPrefixEnv(baseEnv, prefix, contextLabel) {
  const effective = prefix.clearEnv ? {} : { ...(baseEnv ?? {}) };
  for (const unsetKey of prefix.unsetEnv ?? []) {
    unsetEnvCaseInsensitive(effective, unsetKey);
  }
  return mergeEnvCaseInsensitive(effective, prefix.inlineEnv ?? {}, `${contextLabel} command`);
}

function applyShellEnvMutation(
  currentEnv,
  tokens,
  contextLabel,
  { isConditional = false, requireIgnoreScripts = false } = {},
) {
  const prefix = parseCommandPrefix([...tokens]);
  const effectiveConditional = isConditional || prefix.conditional || prefix.grouped;
  let nextEnv = { ...(currentEnv ?? {}) };
  let touchedIgnoreScripts = false;
  const noteKey = (key) => {
    if (key.toLowerCase() === "npm_config_ignore_scripts") {
      touchedIgnoreScripts = true;
    }
  };

  const cmd = prefix.index < tokens.length ? tokens[prefix.index] : null;
  const isEnvBuiltin =
    cmd === "export" || cmd === "unset" || cmd === "declare" || cmd === "typeset";
  if ((cmd === null || isEnvBuiltin) && Object.keys(prefix.inlineEnv).length > 0) {
    for (const key of Object.keys(prefix.inlineEnv)) noteKey(key);
    nextEnv = mergeEnvCaseInsensitive(nextEnv, prefix.inlineEnv, `${contextLabel} assignment`);
  }

  if (cmd === "export" || cmd === "declare" || cmd === "typeset") {
    let unexport = false;
    let cursor = prefix.index + 1;
    while (
      cursor < tokens.length &&
      (tokens[cursor].startsWith("-") || tokens[cursor].startsWith("+"))
    ) {
      const flag = tokens[cursor++];
      if (flag === "--") break;
      if (cmd === "export" && flag.startsWith("-") && flag.includes("n")) unexport = true;
      if ((cmd === "declare" || cmd === "typeset") && flag.startsWith("+") && flag.includes("x")) {
        unexport = true;
      }
    }
    const assigned = {};
    for (; cursor < tokens.length; cursor++) {
      const token = tokens[cursor];
      if (matchShellRedirection(token) > 0) {
        if (matchShellRedirection(token) === 2) cursor++;
        continue;
      }
      const eq = token.indexOf("=");
      if (unexport) {
        const key = eq >= 0 ? token.slice(0, eq) : token;
        if (/^[a-z_]\w*$/i.test(key)) {
          noteKey(key);
          unsetEnvCaseInsensitive(nextEnv, key);
        }
      } else if (eq >= 0) {
        const key = token.slice(0, eq);
        if (/^[a-z_]\w*$/i.test(key)) {
          noteKey(key);
          assigned[key] = token.slice(eq + 1);
        }
      } else if (/^[a-z_]\w*$/i.test(token)) {
        noteKey(token);
      }
    }
    if (Object.keys(assigned).length > 0) {
      nextEnv = mergeEnvCaseInsensitive(nextEnv, assigned, `${contextLabel} ${cmd}`);
    }
  } else if (cmd === "unset") {
    let cursor = prefix.index + 1;
    while (cursor < tokens.length && tokens[cursor].startsWith("-")) {
      const flag = tokens[cursor++];
      if (flag === "--") break;
    }
    for (; cursor < tokens.length; cursor++) {
      const token = tokens[cursor];
      if (matchShellRedirection(token) > 0) {
        if (matchShellRedirection(token) === 2) cursor++;
        continue;
      }
      if (/^[a-z_]\w*$/i.test(token)) {
        noteKey(token);
        unsetEnvCaseInsensitive(nextEnv, token);
      }
    }
  }

  if (touchedIgnoreScripts) {
    const beforeVal = getEnvCaseInsensitive(currentEnv, "npm_config_ignore_scripts");
    const afterVal = getEnvCaseInsensitive(nextEnv, "npm_config_ignore_scripts");
    if (requireIgnoreScripts) {
      assert.equal(
        afterVal,
        "true",
        `${contextLabel} must not override npm_config_ignore_scripts away from "true"`,
      );
      assert.equal(
        effectiveConditional,
        false,
        `${contextLabel} must not conditionally mutate npm_config_ignore_scripts`,
      );
    } else if (effectiveConditional && beforeVal !== "true" && afterVal === "true") {
      unsetEnvCaseInsensitive(nextEnv, "npm_config_ignore_scripts");
      if (beforeVal !== undefined) {
        nextEnv.npm_config_ignore_scripts = beforeVal;
      }
    }
  }
  return nextEnv;
}

function parsePnpmTokens(
  tokens,
  raw,
  baseEnv = {},
  contextLabel = "command",
  depth = 0,
  inContainer = false,
  requireIgnoreScripts = false,
) {
  if (depth > 8) return [];
  const prefix = parseCommandPrefix(tokens);
  const { index, conditional, grouped, changesDir } = prefix;
  const effectiveEnv = applyCommandPrefixEnv(baseEnv, prefix, contextLabel);
  const dockerInfo = extractDockerRunInnerTokens(tokens, index);
  if (dockerInfo !== null) {
    const containerEnv = {};
    for (const forwardedKey of dockerInfo.forwardedEnvKeys) {
      const value = getEnvCaseInsensitive(effectiveEnv, forwardedKey.toLowerCase());
      if (value !== undefined) {
        containerEnv[forwardedKey] = value;
      }
    }
    const mergedContainerEnv = mergeEnvCaseInsensitive(
      containerEnv,
      dockerInfo.envAssignments,
      `${contextLabel} container`,
    );
    return parsePnpmTokens(
      dockerInfo.inner,
      raw,
      mergedContainerEnv,
      contextLabel,
      depth + 1,
      true,
      requireIgnoreScripts,
    );
  }
  const wrapperScript = extractShellWrapperScript(tokens, index);
  if (wrapperScript !== null) {
    const nested = [];
    let wrapperEnv = { ...effectiveEnv };
    let wrapperControlDepth = 0;
    for (const nestedCommand of shellScriptCommands(wrapperScript)) {
      for (const {
        segment: nestedSegment,
        conditional: nestedAfterOperator,
      } of splitShellSegmentsWithMeta(nestedCommand)) {
        const nestedTokens = tokenizeShellWords(nestedSegment);
        const nestedFirstWord = nestedTokens[0]?.replace(/^[({]+/, "");
        if (
          (nestedFirstWord === "fi" || nestedFirstWord === "done" || nestedFirstWord === "esac") &&
          wrapperControlDepth > 0
        ) {
          wrapperControlDepth -= 1;
        }
        const nestedInControlBlock = wrapperControlDepth > 0;
        const nestedOpensControlBlock =
          nestedFirstWord === "if" ||
          nestedFirstWord === "while" ||
          nestedFirstWord === "until" ||
          nestedFirstWord === "for" ||
          nestedFirstWord === "case";
        nested.push(
          ...parsePnpmTokens(
            [...nestedTokens],
            nestedSegment.trim(),
            wrapperEnv,
            contextLabel,
            depth + 1,
            inContainer,
            requireIgnoreScripts,
          ),
        );
        wrapperEnv = applyShellEnvMutation(wrapperEnv, nestedTokens, contextLabel, {
          isConditional: nestedInControlBlock || nestedAfterOperator,
          requireIgnoreScripts,
        });
        if (nestedOpensControlBlock) wrapperControlDepth += 1;
      }
    }
    return nested;
  }
  const commandBase =
    typeof tokens[index] === "string"
      ? posix.basename(tokens[index].replaceAll("\\", "/")).toLowerCase()
      : "";
  if (NPX_EXECUTABLES.has(commandBase)) {
    return [
      {
        tool: "npx",
        subcommand: "exec",
        frozenLockfile: false,
        ignoreScripts: false,
        dir: null,
        changesDir,
        disqualifiesDevInstall: true,
        hasPositionalOperands: false,
        explicitDevEnabled: false,
        effectiveEnv,
        inContainer,
        conditional,
        wrapped: grouped || depth > 0,
        raw,
      },
    ];
  }
  if (NPM_EXECUTABLES.has(commandBase)) {
    let subcommand = null;
    let ignoreScripts =
      String(
        getEnvCaseInsensitive(effectiveEnv, "npm_config_ignore_scripts") ?? "",
      ).toLowerCase() === "true";
    let dir = null;
    let isGlobal = false;
    let unknownPreSubcommandFlag = null;
    for (let cursor = index + 1; cursor < tokens.length; cursor++) {
      const token = tokens[cursor];
      const redirectionTokens = matchShellRedirection(token);
      if (redirectionTokens > 0) {
        if (redirectionTokens === 2) cursor++;
        continue;
      }
      if (token === "--") break;
      if (token === "--ignore-scripts") {
        const next = tokens[cursor + 1]?.toLowerCase();
        if (next === "true" || next === "false") {
          ignoreScripts = next === "true";
          cursor++;
        } else {
          ignoreScripts = true;
        }
        continue;
      }
      if (token === "--ignore-scripts=true") {
        ignoreScripts = true;
        continue;
      }
      if (token === "--no-ignore-scripts" || token.startsWith("--ignore-scripts=")) {
        ignoreScripts = false;
        continue;
      }
      if (token === "-g" || token === "--global") {
        const next = tokens[cursor + 1]?.toLowerCase();
        if (next === "true" || next === "false") {
          isGlobal = next === "true";
          cursor++;
        } else {
          isGlobal = true;
        }
        continue;
      }
      if (token === "--global=true") {
        isGlobal = true;
        continue;
      }
      if (token === "--no-global" || token === "--global=false" || token.startsWith("--global=")) {
        isGlobal = false;
        continue;
      }
      if (token === "--location" && cursor + 1 < tokens.length) {
        isGlobal = tokens[++cursor] === "global";
        continue;
      }
      if (token.startsWith("--location=")) {
        isGlobal = token.slice("--location=".length) === "global";
        continue;
      }
      if ((token === "--prefix" || token === "-C") && cursor + 1 < tokens.length) {
        dir = tokens[++cursor];
        continue;
      }
      if (token.startsWith("--prefix=") || token.startsWith("-C=")) {
        dir = token.slice(token.indexOf("=") + 1);
        continue;
      }
      if (subcommand === null) {
        if (NPM_GLOBAL_VALUE_OPTIONS.has(token)) {
          if (cursor + 1 < tokens.length) cursor++;
          continue;
        }
        const eq = token.indexOf("=");
        if (eq > 0 && NPM_GLOBAL_VALUE_OPTIONS.has(token.slice(0, eq))) {
          continue;
        }
        if (NPM_GLOBAL_BOOLEAN_FLAGS.has(token)) {
          continue;
        }
        if (token.startsWith("-")) {
          unknownPreSubcommandFlag = token;
          continue;
        }
        subcommand = token;
      }
    }
    const normalizedSubcommand =
      subcommand !== null ? (NPM_SUBCOMMAND_ALIASES.get(subcommand) ?? subcommand) : null;
    return [
      {
        tool: "npm",
        subcommand: normalizedSubcommand,
        frozenLockfile: false,
        ignoreScripts,
        dir,
        isGlobal,
        unknownPreSubcommandFlag,
        changesDir,
        disqualifiesDevInstall: true,
        hasPositionalOperands: false,
        explicitDevEnabled: false,
        effectiveEnv,
        inContainer,
        conditional,
        wrapped: grouped || depth > 0,
        raw,
      },
    ];
  }
  if (!PNPM_EXECUTABLES.has(commandBase)) return [];
  let cursor = index + 1;

  let subcommand = null;
  let frozenLockfile = false;
  let ignoreScripts = false;
  let effectiveIgnoreScripts =
    String(getEnvCaseInsensitive(effectiveEnv, "npm_config_ignore_scripts") ?? "").toLowerCase() ===
    "true";
  let dir = null;
  let disqualifiesDevInstall = false;
  let explicitDevEnabled = false;
  let hasPositionalOperands = false;

  for (; cursor < tokens.length; cursor++) {
    const token = tokens[cursor];
    const redirectionTokens = matchShellRedirection(token);
    if (redirectionTokens > 0) {
      if (redirectionTokens === 2) cursor++;
      continue;
    }
    if (token === "--") {
      for (let rest = cursor + 1; rest < tokens.length; rest++) {
        const trailingRedirection = matchShellRedirection(tokens[rest]);
        if (trailingRedirection > 0) {
          if (trailingRedirection === 2) rest++;
          continue;
        }
        hasPositionalOperands = true;
        disqualifiesDevInstall = true;
        break;
      }
      break;
    }
    if (token === "--frozen-lockfile" || token === "--frozen-lockfile=true") {
      frozenLockfile = true;
      continue;
    }
    if (token === "--no-frozen-lockfile" || token.startsWith("--frozen-lockfile=")) {
      frozenLockfile = false;
      continue;
    }
    if (token === "--ignore-scripts" || token === "--ignore-scripts=true") {
      ignoreScripts = true;
      effectiveIgnoreScripts = true;
      continue;
    }
    if (token === "--no-ignore-scripts" || token.startsWith("--ignore-scripts=")) {
      ignoreScripts = false;
      effectiveIgnoreScripts = false;
      continue;
    }
    if (
      token === "--prod=false" ||
      token === "--production=false" ||
      token === "--no-prod" ||
      token === "--no-production"
    ) {
      explicitDevEnabled = true;
      continue;
    }
    if (
      token === "-P" ||
      token === "--prod" ||
      token === "--prod=true" ||
      token === "--production" ||
      token === "--production=true" ||
      token === "-D" ||
      token === "--dev" ||
      token === "--dev=true" ||
      token === "--lockfile-only" ||
      token === "--lockfile-only=true" ||
      token === "--ignore-workspace" ||
      token === "--ignore-workspace=true" ||
      token === "--no-dev" ||
      token === "--dev=false" ||
      token === "--no-optional" ||
      token === "--optional=false" ||
      token.startsWith("--filter=") ||
      token.startsWith("--filter-prod=") ||
      token.startsWith("--modules-dir=") ||
      token.startsWith("--virtual-store-dir=")
    ) {
      disqualifiesDevInstall = true;
      continue;
    }
    if (
      token === "-F" ||
      token === "--filter" ||
      token === "--filter-prod" ||
      token === "--modules-dir" ||
      token === "--virtual-store-dir"
    ) {
      disqualifiesDevInstall = true;
      cursor++;
      continue;
    }
    if ((token === "-C" || token === "--dir") && cursor + 1 < tokens.length) {
      dir = tokens[++cursor];
      continue;
    }
    if (token.startsWith("--dir=")) {
      dir = token.slice("--dir=".length);
      continue;
    }
    if (token.startsWith("-C=")) {
      dir = token.slice("-C=".length);
      continue;
    }
    if (PNPM_ALLOWED_INSTALL_VALUE_OPTIONS.has(token)) {
      cursor++;
      continue;
    }
    if (PNPM_OPTIONS_WITH_VALUE.has(token)) {
      disqualifiesDevInstall = true;
      cursor++;
      continue;
    }
    if (
      PNPM_ALLOWED_INSTALL_FLAGS.has(token) ||
      /^--(?:workspace-concurrency|store-dir|reporter|loglevel|network-concurrency)=/.test(token)
    ) {
      continue;
    }
    if (token.startsWith("-")) {
      disqualifiesDevInstall = true;
      continue;
    }
    if (subcommand === null) {
      if (PNPM_SUBCOMMAND_PREFIXES.has(token)) continue;
      subcommand = token;
    } else {
      hasPositionalOperands = true;
      disqualifiesDevInstall = true;
    }
  }

  return [
    {
      tool: "pnpm",
      subcommand,
      frozenLockfile,
      ignoreScripts,
      effectiveIgnoreScripts,
      dir,
      changesDir,
      disqualifiesDevInstall,
      hasPositionalOperands,
      explicitDevEnabled,
      effectiveEnv,
      inContainer,
      conditional,
      wrapped: grouped || depth > 0,
      raw,
    },
  ];
}

function parsePnpmCommandsInSegment(
  segment,
  baseEnv = {},
  contextLabel = "command",
  depth = 0,
  inContainer = false,
  requireIgnoreScripts = false,
) {
  return parsePnpmTokens(
    tokenizeShellWords(segment),
    segment.trim(),
    baseEnv,
    contextLabel,
    depth,
    inContainer,
    requireIgnoreScripts,
  );
}

export function assertReleaseWorkflow({ workflow, checklist, releaseConfig, nodePackage }) {
  const releasePackage = releaseConfig.packages?.["."];
  const extraFiles = releasePackage?.["extra-files"] ?? [];

  assert.match(
    workflow,
    /googleapis\/release-please-action@[0-9a-f]{40}/,
    "release workflow must pin release-please to an immutable commit",
  );
  assert.doesNotMatch(
    workflow,
    /uses: [^\n]+@(main|master|v\d)/,
    "release workflow must not follow mutable action refs",
  );
  const parsedWorkflow = loadYaml(workflow);
  assert(
    parsedWorkflow && typeof parsedWorkflow === "object" && parsedWorkflow.jobs,
    "release workflow must parse as valid YAML with jobs",
  );
  let checkoutCount = 0;
  for (const [jobName, job] of Object.entries(parsedWorkflow.jobs)) {
    for (const step of job?.steps ?? []) {
      if (typeof step?.uses === "string" && step.uses.startsWith("actions/checkout@")) {
        checkoutCount += 1;
        const persistCredentials = step.with?.["persist-credentials"];
        assert(
          persistCredentials === false || persistCredentials === "false",
          `every release workflow checkout must set persist-credentials: false (${jobName})`,
        );
      }
    }
  }
  assert(checkoutCount > 0, "release workflow must contain checkout steps");
  const workflowEnv = mergeEnvCaseInsensitive({}, parsedWorkflow.env ?? {}, "workflow.env");
  for (const jobName of ["build-native", "publish-npm"]) {
    const job = parsedWorkflow.jobs[jobName];
    const jobEffective = mergeEnvCaseInsensitive(workflowEnv, job?.env ?? {}, `${jobName}.env`);
    assert.equal(
      getEnvCaseInsensitive(jobEffective, "npm_config_ignore_scripts"),
      "true",
      `${jobName} must disable lifecycle scripts across nested npm/pnpm invocations via npm_config_ignore_scripts: "true"`,
    );
    for (const step of job?.steps ?? []) {
      const stepLabel = `${jobName} step "${step?.name ?? step?.uses ?? "run"}"`;
      const stepEffective = mergeEnvCaseInsensitive(jobEffective, step?.env ?? {}, stepLabel);
      assert.equal(
        getEnvCaseInsensitive(stepEffective, "npm_config_ignore_scripts"),
        "true",
        `${stepLabel} must not override npm_config_ignore_scripts away from "true"`,
      );
    }
  }
  let pnpmInstallCount = 0;
  const pnpmRunInstallsByJob = new Map();
  const workflowDefaultCwd = parsedWorkflow.defaults?.run?.["working-directory"] ?? ".";
  for (const [jobName, job] of Object.entries(parsedWorkflow.jobs)) {
    const jobDefaultCwd = job?.defaults?.run?.["working-directory"] ?? workflowDefaultCwd;
    const jobEffectiveEnv = mergeEnvCaseInsensitive(workflowEnv, job?.env ?? {}, `${jobName}.env`);
    const requiresIgnoreScriptsEnv = jobName === "build-native" || jobName === "publish-npm";
    let sawCheckedRunInstall = false;
    for (const step of job?.steps ?? []) {
      if (typeof step?.uses === "string" && step.uses.startsWith("actions/checkout@")) {
        sawCheckedRunInstall = false;
      }
      const stepCwd = step?.["working-directory"] ?? jobDefaultCwd;
      const stepLabel = `${jobName} step "${step?.name ?? step?.uses ?? "run"}"`;
      const stepEffectiveEnv = mergeEnvCaseInsensitive(jobEffectiveEnv, step?.env ?? {}, stepLabel);
      const unconditionalStep = step?.if === undefined;
      const failsJobOnError =
        step?.["continue-on-error"] === undefined || step?.["continue-on-error"] === false;
      if (
        typeof step?.uses === "string" &&
        step.uses.startsWith("./node/node_modules/ferramenta-native/")
      ) {
        assert(
          sawCheckedRunInstall,
          `${jobName} must run a checked unconditional node-workspace pnpm install step before invoking ${step.uses}`,
        );
      }
      const inspectScript = (script, isRunStep) => {
        const commands = shellScriptCommands(script);
        let controlDepth = 0;
        let currentDir = stepCwd;
        let dirUncertain = false;
        let currentStepEnv = { ...stepEffectiveEnv };
        const dirStack = [];
        for (const command of commands) {
          if (requiresIgnoreScriptsEnv) {
            assert.doesNotMatch(
              command,
              /\bGITHUB_ENV\b/,
              `${stepLabel} must not mutate GITHUB_ENV in release jobs: ${command}`,
            );
          }
          const segments = splitShellSegmentsWithMeta(command);
          const standaloneStepCommand = isRunStep && commands.length === 1 && segments.length === 1;
          for (const { segment, conditional: afterOperator } of segments) {
            const segTokens = tokenizeShellWords(segment);
            const firstWord = segTokens[0]?.replace(/^[({]+/, "");
            if (
              (firstWord === "fi" || firstWord === "done" || firstWord === "esac") &&
              controlDepth > 0
            ) {
              controlDepth -= 1;
            }
            const inControlBlock = controlDepth > 0;
            const opensControlBlock =
              firstWord === "if" ||
              firstWord === "while" ||
              firstWord === "until" ||
              firstWord === "for" ||
              firstWord === "case";
            for (const parsed of parsePnpmCommandsInSegment(
              segment,
              currentStepEnv,
              stepLabel,
              0,
              false,
              requiresIgnoreScriptsEnv,
            )) {
              const resolvedPnpmDir = dirUncertain
                ? null
                : effectivePnpmDir(currentDir, parsed.dir);
              const targetsNodeRoot = !dirUncertain && resolvedPnpmDir === "node";
              const targetsNodeWorkspace =
                dirUncertain ||
                resolvedPnpmDir === "node" ||
                (resolvedPnpmDir?.startsWith("node/") ?? false);
              const mergedCommandEnv = parsed.effectiveEnv;
              if (parsed.tool === "npx") {
                assert.fail(`release workflow must not run npx (${jobName}): ${parsed.raw}`);
              }
              if (parsed.tool === "npm") {
                if (parsed.unknownPreSubcommandFlag) {
                  assert.fail(
                    `release workflow npm invocation has unrecognized pre-subcommand option ${parsed.unknownPreSubcommandFlag} (${jobName}): ${parsed.raw}`,
                  );
                }
                if (NPM_FORBIDDEN_SUBCOMMANDS.has(parsed.subcommand)) {
                  assert.fail(
                    `release workflow must not run npm ${parsed.subcommand} (${jobName}): ${parsed.raw}`,
                  );
                }
                if (NPM_INSTALL_SUBCOMMANDS.has(parsed.subcommand)) {
                  assert.equal(
                    parsed.ignoreScripts,
                    true,
                    `release workflow npm ${parsed.subcommand} must effectively enable --ignore-scripts (${jobName}): ${parsed.raw}`,
                  );
                  if (!parsed.isGlobal && (targetsNodeWorkspace || parsed.changesDir)) {
                    sawCheckedRunInstall = false;
                  }
                } else if (NPM_PACK_PUBLISH_SUBCOMMANDS.has(parsed.subcommand)) {
                  assert.equal(
                    parsed.ignoreScripts,
                    true,
                    `release workflow npm ${parsed.subcommand} must effectively enable --ignore-scripts (${jobName}): ${parsed.raw}`,
                  );
                } else if (
                  NPM_MUTATING_SUBCOMMANDS.has(parsed.subcommand) &&
                  !parsed.isGlobal &&
                  (targetsNodeWorkspace || parsed.changesDir)
                ) {
                  sawCheckedRunInstall = false;
                } else if (
                  !NPM_MUTATING_SUBCOMMANDS.has(parsed.subcommand) &&
                  parsed.subcommand !== null &&
                  !NPM_ALLOWED_SAFE_SUBCOMMANDS.has(parsed.subcommand)
                ) {
                  assert.fail(
                    `release workflow must not run unrecognized npm subcommand ${parsed.subcommand} (${jobName}): ${parsed.raw}`,
                  );
                }
                if (requiresIgnoreScriptsEnv) {
                  assert.equal(
                    getEnvCaseInsensitive(mergedCommandEnv, "npm_config_ignore_scripts"),
                    "true",
                    `${stepLabel} must not override npm_config_ignore_scripts away from "true": ${parsed.raw}`,
                  );
                }
                continue;
              }
              if (PNPM_FORBIDDEN_SUBCOMMANDS.has(parsed.subcommand)) {
                assert.fail(
                  `release workflow must not run pnpm ${parsed.subcommand} (${jobName}): ${parsed.raw}`,
                );
              }
              if (
                PNPM_MUTATING_SUBCOMMANDS.has(parsed.subcommand) &&
                (targetsNodeWorkspace || parsed.changesDir)
              ) {
                sawCheckedRunInstall = false;
              }
              if (PNPM_PACK_PUBLISH_SUBCOMMANDS.has(parsed.subcommand)) {
                assert.equal(
                  parsed.effectiveIgnoreScripts,
                  true,
                  `release workflow pnpm ${parsed.subcommand} must effectively enable --ignore-scripts (${jobName}): ${parsed.raw}`,
                );
              }
              if (parsed.subcommand === "install" || parsed.subcommand === "i") {
                pnpmInstallCount += 1;
                assert.equal(
                  parsed.frozenLockfile,
                  true,
                  `release workflow pnpm install must effectively enable --frozen-lockfile (${jobName}): ${parsed.raw}`,
                );
                assert.equal(
                  parsed.ignoreScripts,
                  true,
                  `release workflow pnpm install must effectively enable --ignore-scripts (${jobName}): ${parsed.raw}`,
                );
                assert.equal(
                  parsed.hasPositionalOperands,
                  false,
                  `release workflow pnpm install must not pass positional package operands (${jobName}): ${parsed.raw}`,
                );
                const productionMode =
                  hasProductionEnv(mergedCommandEnv) && !parsed.explicitDevEnabled;
                if (
                  standaloneStepCommand &&
                  unconditionalStep &&
                  failsJobOnError &&
                  !inControlBlock &&
                  !afterOperator &&
                  !parsed.conditional &&
                  !parsed.wrapped &&
                  !parsed.inContainer &&
                  !parsed.changesDir &&
                  !parsed.disqualifiesDevInstall &&
                  !productionMode &&
                  targetsNodeRoot
                ) {
                  sawCheckedRunInstall = true;
                  pnpmRunInstallsByJob.set(jobName, (pnpmRunInstallsByJob.get(jobName) ?? 0) + 1);
                } else if (
                  (targetsNodeWorkspace || parsed.changesDir) &&
                  (parsed.disqualifiesDevInstall || productionMode)
                ) {
                  sawCheckedRunInstall = false;
                }
              }
              if (requiresIgnoreScriptsEnv) {
                assert.equal(
                  getEnvCaseInsensitive(mergedCommandEnv, "npm_config_ignore_scripts"),
                  "true",
                  `${stepLabel} must not override npm_config_ignore_scripts away from "true": ${parsed.raw}`,
                );
              }
            }
            currentStepEnv = applyShellEnvMutation(currentStepEnv, segTokens, stepLabel, {
              isConditional: inControlBlock || afterOperator,
              requireIgnoreScripts: requiresIgnoreScriptsEnv,
            });
            const prefixTokens = tokenizeShellWords(segment);
            const { index: cmdIdx } = parseCommandPrefix(prefixTokens);
            const dirCmd = prefixTokens[cmdIdx];
            if (dirCmd === "cd" || dirCmd === "pushd") {
              if (dirCmd === "pushd") {
                dirStack.push({ dir: currentDir, uncertain: dirUncertain });
              }
              let argIdx = cmdIdx + 1;
              while (argIdx < prefixTokens.length && prefixTokens[argIdx].startsWith("-")) {
                if (prefixTokens[argIdx] === "--") {
                  argIdx++;
                  break;
                }
                if (prefixTokens[argIdx] === "-") break;
                argIdx++;
              }
              const target = prefixTokens[argIdx];
              if (
                inControlBlock ||
                dirUncertain ||
                !target ||
                target === "-" ||
                target.includes("$") ||
                target.includes("`") ||
                target.startsWith("~")
              ) {
                dirUncertain = true;
              } else {
                const nextDir = effectivePnpmDir(currentDir, target);
                if (nextDir === null) {
                  dirUncertain = true;
                } else {
                  currentDir = nextDir;
                }
              }
            } else if (dirCmd === "popd") {
              if (inControlBlock || dirStack.length === 0) {
                dirUncertain = true;
              } else {
                const previous = dirStack.pop();
                currentDir = previous.dir;
                dirUncertain = previous.uncertain;
              }
            }
            if (opensControlBlock) controlDepth += 1;
          }
        }
      };
      if (typeof step?.run === "string") {
        inspectScript(step.run, true);
      }
      for (const inputName of EXECUTABLE_STEP_INPUTS) {
        if (typeof step?.with?.[inputName] === "string") {
          inspectScript(step.with[inputName], false);
        }
      }
    }
  }
  assert(pnpmInstallCount > 0, "release workflow must install workspace dependencies");
  for (const jobName of ["build-native", "publish-npm"]) {
    assert(
      (pnpmRunInstallsByJob.get(jobName) ?? 0) > 0,
      `${jobName} must contain a checked pnpm install command`,
    );
  }
  assert.equal(
    releaseConfig["release-type"],
    "rust",
    "Ferriki release authority is the root Rust package (ADR 0012)",
  );
  assert.equal(
    releaseConfig["include-component-in-tag"],
    false,
    "Ferriki must preserve the unscoped product tag format",
  );
  assert.equal(
    releasePackage?.["changelog-path"],
    "node/ferriki/CHANGELOG.md",
    "release package must declare its changelog path",
  );
  assert(
    extraFiles.some(
      (file) => file.path === "/node/ferriki/package.json" && file.jsonpath === "$.version",
    ),
    "release config must update the npm package version with the product version",
  );
  assert(
    extraFiles.some(
      (file) =>
        file.path === "/node/ferriki/package.json" && file.jsonpath === "$.optionalDependencies[*]",
    ),
    "release config must update all platform dependency versions with the product version",
  );
  assert(
    extraFiles.some(
      (file) => file.path === "/node/vite/package.json" && file.jsonpath === "$.version",
    ),
    "release config must update the Vite integration version with the product version",
  );
  assert(
    extraFiles.some(
      (file) =>
        file.path === "/node/vite/package.json" &&
        file.jsonpath === "$.dependencies['@ferriki/core']",
    ),
    "release config must keep the Vite integration's Ferriki dependency on the product version",
  );
  assert(
    extraFiles.some(
      (file) =>
        file.path === "/node/platforms/*/package.json" &&
        file.glob === true &&
        file.jsonpath === "$.version",
    ),
    "release config must update every platform package manifest with the product version",
  );
  assert(
    extraFiles.some(
      (file) =>
        file.path === "/node/pnpm-lock.yaml" &&
        file.type === "yaml" &&
        file.jsonpath === "$.importers.ferriki.optionalDependencies[*].specifier",
    ),
    "release config must update the pnpm lockfile dependency specifiers",
  );
  assert(
    extraFiles.some(
      (file) =>
        file.path === "/node/pnpm-lock.yaml" &&
        file.type === "yaml" &&
        file.jsonpath === "$.importers.vite.dependencies['@ferriki/core'].specifier",
    ),
    "release config must update the Vite importer dependency in the pnpm lockfile",
  );
  // The pinned Release Please TOML parser wraps scalar names in `.value`.
  // A registry copy of the same crate must keep its separately pinned version.
  for (const crate of ["ferriki", "ferriki-textmate", "ferriki-asset-gen"])
    assert(
      extraFiles.some(
        (file) =>
          file.path === "/fuzz/Cargo.lock" &&
          file.type === "toml" &&
          file.jsonpath === `$.package[?(@.name.value=='${crate}' && !@.source)].version`,
      ),
      `release config must update ${crate} in the separate fuzz lockfile`,
    );
  assert.match(
    nodePackage?.packageManager ?? "",
    /^pnpm@10\./,
    "the workspace must use pnpm 10 for catalog rewriting and npm 11 publishing",
  );
  assert.doesNotMatch(
    workflow,
    /sync:platform-versions/,
    "release workflow must not patch generated release candidates",
  );
  assert.match(
    workflow,
    /concurrency:\n {2}group: publish-\$\{\{ github\.repository \}\}\n {2}cancel-in-progress: false/,
    "main publication and tag recovery must share one non-canceling concurrency group",
  );
  for (const job of [
    "release-please:",
    "verify-release-source:",
    "publish-crates:",
    "build-native:",
    "publish-npm:",
    "verify-npm-publish:",
    "release-summary:",
  ])
    assert(workflow.includes(`  ${job}`), `release workflow is missing ${job}`);
  for (const required of [
    "force-publish:",
    "dist-tag:",
    "timeout-minutes:",
    "actions/download-artifact@",
    "verify-crates-publish:",
    "NPM_PUBLISH_RESULT:",
    "write-release-summary.mjs",
    // The package ships no payloads. Keep exact release provenance in the
    // manifest alongside immutable payload hashes (ADR 0013).
    'sync-standard-assets.mjs --release-commit "$(git rev-parse HEAD)"',
    // The publish job downloads native addons instead of running
    // build-native.mjs, so it must materialize the catalog and notices itself.
    "node ../scripts/materialize-assets.mjs --payloads",
    "node ../scripts/write-grammar-notices.mjs",
  ])
    assert(workflow.includes(required), `release workflow is missing ${required}`);

  const assetsJob = workflowJob(workflow, "publish-locked-assets");
  assert.match(
    workflow,
    /rebuild-assets:/,
    "asset publication must support rebuilding new locked payloads",
  );
  assert.match(
    assetsJob,
    /if: inputs\.rebuild-assets[\s\S]*run: node scripts\/rebuild-locked-assets\.mjs/,
    "asset rebuild must verify the reviewed lock before upload",
  );
  assert(
    assetsJob.indexOf("run: node scripts/rebuild-locked-assets.mjs") <
      assetsJob.indexOf("run: node scripts/publish-assets.mjs"),
    "locked asset rebuilding must precede publication",
  );

  const cratesJob = workflowJob(workflow, "publish-crates");
  const gateJob = workflowJob(workflow, "verify-release-source");
  assert.match(
    gateJob,
    /node \.\/node\/scripts\/release-source-gate\.mjs resolve/,
    "release source gate must resolve the tag and SHA",
  );
  assert.match(
    gateJob,
    /node \.\/node\/scripts\/release-source-gate\.mjs verify/,
    "release source gate must require exact-commit CI",
  );
  assert.match(gateJob, /actions: read/, "release source gate needs Actions read permission");
  assert.match(
    gateJob,
    /ref: \$\{\{ steps\.source\.outputs\.release_sha \}\}/,
    "release source gate must verify the exact checkout",
  );
  assert.match(
    gateJob,
    /release_sha: \$\{\{ steps\.source\.outputs\.release_sha \}\}/,
    "release source gate must export the verified SHA",
  );
  assert.match(
    workflow,
    /release-tag:\n\s+description:/,
    "force publication must require an explicit release tag",
  );
  for (const jobName of ["publish-crates", "build-native", "publish-npm", "verify-npm-publish"]) {
    const job = workflowJob(workflow, jobName);
    assert.match(
      job,
      /^\s+- verify-release-source\s*$/m,
      `${jobName} must depend on exact-release verification`,
    );
    assert.match(
      job,
      /ref: \$\{\{ needs\.verify-release-source\.outputs\.release_sha \}\}/,
      `${jobName} must check out the verified release SHA`,
    );
  }
  assert.match(
    cratesJob,
    /sebastian-software\/project-infra\/\.github\/actions\/publish-crates@[0-9a-f]{40}/,
    "publish-crates must use the shared, pinned project-infra action",
  );
  assert.match(
    cratesJob,
    /^\s+id-token: write\s*$/m,
    "publish-crates needs an OIDC token for crates.io Trusted Publishing",
  );
  assert.doesNotMatch(
    cratesJob,
    /CARGO_REGISTRY_TOKEN/,
    "publish-crates must not fall back to a long-lived registry token",
  );
  const crateList = cratesJob.match(/crates: \|\n((?:[ \t]+[a-z0-9-]+\n?)+)/);
  assert(crateList, "publish-crates must list the crates to publish");
  assert.deepEqual(
    crateList[1]
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
    CRATE_PUBLISH_ORDER,
    "publish-crates must publish the crates in dependency order",
  );

  const publishWorkflow = workflowJob(workflow, "publish-npm");
  assert.match(
    publishWorkflow,
    /uses: \.\/node\/node_modules\/ferramenta-native\/actions\/release-native/,
    "publish-npm must use the shared native release action",
  );
  assert.match(
    publishWorkflow,
    /source-sha: \$\{\{ needs\.verify-release-source\.outputs\.release_sha \}\}/,
    "native release must bind artifacts to the verified source",
  );
  assert.match(
    publishWorkflow,
    /tag: \$\{\{ needs\.verify-release-source\.outputs\.release_tag \}\}/,
    "native release must use the verified tag",
  );
  assert.match(
    publishWorkflow,
    /publish: "true"/,
    "native release must enable publication explicitly",
  );
  assert.match(
    publishWorkflow,
    /prepare-command: \|[\s\S]*pnpm run check:packed-vite/,
    "native release must include the packed Vite consumer check before publishing",
  );
  assert.match(
    publishWorkflow,
    /^\s+id-token: write\s*$/m,
    "publish-npm needs an OIDC token for npm Trusted Publishing",
  );

  // Every release summary lists each sidecar's addon size (#216).
  const summaryJob = workflowJob(workflow, "release-summary");
  const cratesVerifyJob = workflowJob(workflow, "verify-crates-publish");
  assert.match(
    cratesVerifyJob,
    /^\s+- publish-crates\s*$/m,
    "crates verification must wait for publication",
  );
  assert.match(
    cratesVerifyJob,
    /needs\.verify-release-source\.result == 'success'/,
    "crates verification must not check out an unverified release source",
  );
  assert.match(
    cratesVerifyJob,
    /verify-crates-publish\.mjs/,
    "crates verification must run the public verifier",
  );
  assert.match(summaryJob, /^\s+- publish-crates\s*$/m, "summary must wait for Rust publication");
  assert.match(
    summaryJob,
    /^\s+- verify-crates-publish\s*$/m,
    "summary must wait for Rust verification",
  );
  assert.match(summaryJob, /^\s+CRATES_RESULT: \$\{\{ needs\.publish-crates\.result \}\}\s*$/m);
  assert.match(
    summaryJob,
    /^\s+CRATES_VERIFY_RESULT: \$\{\{ needs\.verify-crates-publish\.result \}\}\s*$/m,
  );
  const sidecarDirectory = /^\s+pattern: native-\*\n\s+path: (\S+)$/m.exec(summaryJob)?.[1];
  assert(sidecarDirectory, "release-summary must download every native sidecar artifact");
  assert(
    summaryJob.includes(`NATIVE_SIDECARS_DIR: ${sidecarDirectory}\n`),
    "release-summary must report addon sizes from the downloaded sidecars",
  );

  for (const required of [
    "npm provenance",
    "GitHub release",
    "tarball",
    "rollback",
    "deprecate",
    "go/no-go",
    "Trusted Publishing",
    "Allow npm dist-tag",
    "@ferriki/vite",
    "0.0.0-bootstrap.0",
    "bootstrap",
    `cargo publish --locked ${CRATE_PUBLISH_ORDER.map((name) => `-p ${name}`).join(" ")}`,
  ])
    assert(
      checklist.toLowerCase().includes(required.toLowerCase()),
      `release checklist is missing ${required}`,
    );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const nodeRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
  const repoRoot = join(nodeRoot, "..");
  const workflow = await readFile(join(repoRoot, ".github/workflows/publish.yml"), "utf8");
  const checklist = await readFile(join(repoRoot, "docs/release-checklist.md"), "utf8");
  const releaseConfig = JSON.parse(
    await readFile(join(repoRoot, ".release-please-config.json"), "utf8"),
  );
  const nodePackage = JSON.parse(await readFile(join(nodeRoot, "package.json"), "utf8"));
  assertReleaseWorkflow({ workflow, checklist, releaseConfig, nodePackage });
  console.log("Ferriki release workflow and checklist verified");
}
