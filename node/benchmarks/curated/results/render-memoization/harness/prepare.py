"""Snapshot ordinary facades and add phase counters only to a diagnostic copy."""
import hashlib
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[6]
NODE = ROOT / "node"
OUT = Path(__file__).resolve().parents[1]
CACHE = NODE / ".cache/render-memoization"


def snapshot(name):
    target = CACHE / name
    shutil.copytree(NODE / "ferriki", target, dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns("node_modules", "dist", "*.node"))
    addon = target / "ferriki.node"
    if not addon.exists():
        addon.symlink_to(NODE / "platforms/darwin-arm64/ferriki.node")
    return target


def replace(path, old, new):
    source = path.read_text()
    assert old in source, (path, old)
    path.write_text(source.replace(old, new))


if __name__ == "__main__":
    import sys
    name = sys.argv[1]
    target = snapshot(name)
    if name in ("baseline", "diagnostic"):
        shutil.copy2(OUT / "harness/baseline-classes.measured.mjs", target / "classes.mjs")
        shutil.copy2(OUT / "harness/baseline-transformers.measured.mjs", target / "transformers.mjs")
    if name == "baseline":
        shutil.copy2(NODE / "ferriki/.benchmark-build.json", OUT / "baseline-build.json")
    if name in ("scope-only", "style-only"):
        current = (target / "classes.mjs").read_text()
        base = (OUT / "harness/baseline-classes.measured.mjs").read_text()
        start = "export function extractClassStyles(tree) {"
        end = "export function themeSwitchStyles(options) {"
        current_extract = current[current.index(start):current.index(end)]
        base_extract = base[base.index(start):base.index(end)]
        if name == "scope-only":
            (target / "classes.mjs").write_text(current.replace(current_extract, base_extract))
        else:
            (target / "classes.mjs").write_text(base.replace(base_extract, current_extract))
            shutil.copy2(OUT / "harness/baseline-transformers.measured.mjs", target / "transformers.mjs")
    if name == "diagnostic":
        classes = target / "classes.mjs"
        replace(classes, "function scopePrefixes(scope, prefix) {", """function scopePrefixes(scope, prefix) {
  const started = performance.now();
  globalThis.renderProfile.scopeCalls++;
  globalThis.renderProfile.scopes.add(scope);""")
        replace(classes, "return parts.map((_, index)", "const result = parts.map((_, index)")
        replace(classes, "scopeClass(parts.slice(0, index + 1).join(\".\"))}`);",
                "scopeClass(parts.slice(0, index + 1).join(\".\"))}`);\n  globalThis.renderProfile.scopeMs += performance.now() - started;\n  return result;")
        replace(classes, "const name = `ferriki-style-${createHash", """const started = performance.now();
      globalThis.renderProfile.styleCalls++;
      globalThis.renderProfile.styles.add(style);
      const name = `ferriki-style-${createHash""")
        replace(classes, ".update(style).digest(\"hex\")}`;", ".update(style).digest(\"hex\")}`;\n      globalThis.renderProfile.styleMs += performance.now() - started;")
        source = target / "src/index.mjs"
        replace(source, "function hastToHtml(tree) {", """function hastToHtml(tree) {
  const started = performance.now();
  const output = hastToHtmlUnprofiled(tree);
  globalThis.renderProfile.serializeMs += performance.now() - started;
  return output;
}
function hastToHtmlUnprofiled(tree) {""")
        replace(source, "const result = removeGrammarPrefix(\n      renderHtmlDataRaw", "const nativeStarted = performance.now();\n    const result = removeGrammarPrefix(\n      renderHtmlDataRaw")
        replace(source, "result.tokens = applyTokenTransformers(\n      prepareRenderTokens", "globalThis.renderProfile.nativeMs += performance.now() - nativeStarted;\n    const renderStarted = performance.now();\n    result.tokens = applyTokenTransformers(\n      prepareRenderTokens")
        replace(source, "    return tree;\n  }", "    globalThis.renderProfile.renderMs += performance.now() - renderStarted;\n    return tree;\n  }")
    files = ["classes.mjs", "transformers.mjs", "src/index.mjs", "src/asset-download.mjs", "native.mjs", "platforms.mjs"]
    (OUT / f"{name}-source.json").write_text(json.dumps({
        file: hashlib.sha256((target / file).read_bytes()).hexdigest() for file in files
    }, indent=2) + "\n")
