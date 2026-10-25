"""Compare release addons using the same facade, inputs and existing worker.

Arguments: facade inputs baseline-addon candidate-addon populated-cache output
Downloads are outside timers. First-fill lanes start with compressed files only.
"""
import datetime
import hashlib
import json
import os
from pathlib import Path
import statistics
import subprocess
import sys
import tempfile

facade, inputs, baseline, candidate, cache, output = map(Path, sys.argv[1:])
repo = Path(__file__).resolve().parents[4]
worker = repo / "docs/benchmarks/precompiled-patterns/decoded-cache/reproduce.mjs"
scenarios = [item["id"] for item in json.loads(inputs.read_text())]
addons = {"before": baseline.resolve(), "after": candidate.resolve()}
lanes = [(label, mode, "populated") for label in addons
         for mode in ["off", "auto", "eager", "prepared"]]
lanes += [(label, "prepared", "first-fill") for label in addons]


def run(scenario, label, mode, cache_dir):
    child = subprocess.run(
        ["node", str(worker), "--worker", str(facade.resolve() / "index.mjs"),
         str(inputs.resolve()), scenario, mode, str(cache_dir.resolve())],
        env={**os.environ, "FERRIKI_BENCH_ADDON": str(addons[label])},
        capture_output=True, text=True, timeout=120, check=True,
    )
    return json.loads(child.stdout)


# Create/upgrade verification receipts before populated-cache measurements.
for scenario in scenarios:
    run(scenario, "after", "prepared", cache)

rows = []
for repeat in range(5):
    for scenario_index, scenario in enumerate(scenarios):
        offset = (repeat + scenario_index) % len(lanes)
        for label, mode, state in lanes[offset:] + lanes[:offset]:
            if state == "first-fill":
                with tempfile.TemporaryDirectory(prefix="ferriki-stat-fill-") as directory:
                    fill_cache = Path(directory)
                    for entry in cache.iterdir():
                        if len(entry.name) == 64 and entry.is_file():
                            os.link(entry, fill_cache / entry.name)
                    result = run(scenario, label, mode, fill_cache)
            else:
                result = run(scenario, label, mode, cache)
            row = {"label": label, "cacheState": state, "repeat": repeat, **result}
            rows.append(row)
            warm = sorted(row["warmMs"])[len(row["warmMs"]) // 2]
            print(f"{scenario} {label} {mode} {state} #{repeat}: "
                  f"setup={row['setupMs']:.2f}, first={row['firstMs']:.2f}, "
                  f"warm={warm:.2f} ms", flush=True)

for scenario in scenarios:
    selected = [row for row in rows if row["scenario"] == scenario]
    assert all(row["outputHashes"] == selected[0]["outputHashes"] for row in selected)

summary = []
for scenario in scenarios:
    for label, mode, state in lanes:
        selected = [row for row in rows if row["scenario"] == scenario
                    and row["label"] == label and row["mode"] == mode
                    and row["cacheState"] == state]
        summary.append({
            "scenario": scenario, "label": label, "mode": mode,
            "cacheState": state, "n": len(selected),
            **{key: statistics.median(row[key] for row in selected)
               for key in ["importMs", "setupMs", "firstMs", "startupMs"]},
            "warmMs": statistics.median(sorted(row["warmMs"])[len(row["warmMs"]) // 2]
                                        for row in selected),
        })

output.write_text(json.dumps({
    "capturedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "node": subprocess.check_output(["node", "--version"], text=True).strip(),
    "binarySha256": {label: hashlib.sha256(addon.read_bytes()).hexdigest()
                     for label, addon in addons.items()},
    "inputsSha256": hashlib.sha256(inputs.read_bytes()).hexdigest(),
    "releaseManifestSha256": hashlib.sha256((facade / "assets/standard/release-manifest.json").read_bytes()).hexdigest(),
    "summary": summary, "rows": rows,
}, indent=2) + "\n")
