import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { regexModeEngines } from "./regex-benchmark-modes.mjs";
import { comparisonCorpus } from "./shiki-comparison-corpus.mjs";

export const memoryEngines = ["ferriki", "shiki-wasm", "shiki-js"];
export const memoryModeEngines = regexModeEngines.filter((id) => id !== "prism");
export const memoryScenarios = ["repository", "large-typescript"];
export const memoryRepetitions = 6;
export const memoryTheme = "github-dark";
export const memoryRoot = fileURLToPath(new URL("../../", import.meta.url));
export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function memoryWorkload(scenario) {
  if (!memoryScenarios.includes(scenario)) throw new Error(`Unknown memory scenario: ${scenario}`);
  const selected = comparisonCorpus.filter(([lang]) =>
    scenario === "repository" ? !["yaml", "sql"].includes(lang) : lang === "typescript",
  );
  const documents = selected.map(([lang, path]) => {
    let code = readFileSync(new URL(path, new URL("../../", import.meta.url)), "utf8");
    const copies =
      scenario === "repository" ? 1 : Math.ceil((256 * 1024) / Buffer.byteLength(code));
    code = Array.from({ length: copies }, () => code).join("\n");
    return { lang, path, copies, code, bytes: Buffer.byteLength(code), sha256: digest(code) };
  });
  return {
    id: scenario,
    checkpoints: scenario === "repository" ? [1, 10, 50] : [1, 5, 10],
    documents,
  };
}

export function workloadIdentity(workload) {
  return {
    ...workload,
    documents: workload.documents.map(({ code, ...identity }) => identity),
  };
}
