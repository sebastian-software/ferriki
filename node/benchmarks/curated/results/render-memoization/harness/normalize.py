"""Redact local paths without changing samples, source hashes, or CPU frames."""
import gzip
import hashlib
import json
import shutil
from pathlib import Path

OUT = Path(__file__).resolve().parents[1]
ROOT = OUT.parents[4]
PRIVATE = ROOT / "node/.cache/render-memoization/private-originals"


def digest(data):
    return hashlib.sha256(data).hexdigest()


if __name__ == "__main__":
    PRIVATE.mkdir(parents=True, exist_ok=True)
    replacements = [
        (str(ROOT), "/WORKTREE/ferriki"),
        (str(Path.home() / ".cargo"), "$CARGO_HOME"),
        (str(Path.home() / "Library/pnpm"), "$PNPM_HOME"),
        (str(Path.home() / ".cache/node/corepack"), "$COREPACK_HOME"),
        (str(Path.home() / ".cache/codex-runtimes"), "$CODEX_RUNTIME"),
    ]
    mapping = []
    index = OUT / "path-redactions.json"
    previous = {entry["file"]: entry for entry in json.loads(index.read_text())} if index.exists() else {}
    files = sorted(OUT.glob("*.json")) + sorted((OUT / "validation").glob("*.json")) + sorted((OUT / "validation").glob("*.log.gz"))
    for path in files:
        if path.name == "path-redactions.json":
            continue
        original = path.read_bytes()
        relative = str(path.relative_to(OUT))
        if relative in previous and previous[relative]["publishedSha256"] == digest(original):
            mapping.append(previous[relative])
            continue
        text = gzip.decompress(original).decode() if path.suffix == ".gz" else original.decode()
        for source, target in replacements:
            text = text.replace(source, target)
        normalized = gzip.compress(text.encode(), mtime=0) if path.suffix == ".gz" else text.encode()
        if normalized != original:
            copy = PRIVATE / path.relative_to(OUT)
            copy.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, copy)
            path.write_bytes(normalized)
        mapping.append({"file": relative, "capturedSha256": digest(original), "publishedSha256": digest(normalized)})
    (OUT / "path-redactions.json").write_text(json.dumps(mapping, indent=2) + "\n")
