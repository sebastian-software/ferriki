"""Compare two release addons with the frozen facade and existing worker."""

import datetime
import hashlib
import json
import os
from pathlib import Path
import statistics
import subprocess
import sys

facade, inputs, baseline, candidate, cache, output = map(Path, sys.argv[1:])
repo = Path(__file__).resolve().parents[4]
worker = repo / "docs/benchmarks/precompiled-patterns/decoded-cache/reproduce.mjs"
scenarios = [item["id"] for item in json.loads(inputs.read_text())]
lanes = [(version, mode) for version in ["2.7.0", "2.7.1"]
         for mode in ["off", "auto", "eager", "prepared"]]
addons = {"2.7.0": baseline.resolve(), "2.7.1": candidate.resolve()}


def run(scenario, version, mode):
    child = subprocess.run(
        ["node", str(worker), "--worker", str(facade.resolve() / "index.mjs"),
         str(inputs.resolve()), scenario, mode, str(cache.resolve())],
        env={**os.environ, "FERRIKI_BENCH_ADDON": str(addons[version])},
        capture_output=True, text=True, timeout=120, check=True,
    )
    return json.loads(child.stdout)


# All downloads and initial derived-cache fills precede measured processes.
for scenario in scenarios:
    run(scenario, "2.7.1", "prepared")

rows = []
for repeat in range(5):
    for scenario_index, scenario in enumerate(scenarios):
        offset = (repeat + scenario_index) % len(lanes)
        for version, mode in lanes[offset:] + lanes[:offset]:
            row = {"version": version, "repeat": repeat, **run(scenario, version, mode)}
            rows.append(row)
            warm = sorted(row["warmMs"])[len(row["warmMs"]) // 2]
            print(f"{scenario} {version} {mode} #{repeat}: "
                  f"setup={row['setupMs']:.2f}, first={row['firstMs']:.2f}, "
                  f"warm={warm:.2f} ms", flush=True)

for scenario in scenarios:
    selected = [row for row in rows if row["scenario"] == scenario]
    assert all(row["outputHashes"] == selected[0]["outputHashes"] for row in selected)

summary = []
for scenario in scenarios:
    for version, mode in lanes:
        selected = [row for row in rows if row["scenario"] == scenario
                    and row["version"] == version and row["mode"] == mode]
        summary.append({
            "scenario": scenario, "version": version, "mode": mode, "n": len(selected),
            **{key: statistics.median(row[key] for row in selected)
               for key in ["importMs", "setupMs", "firstMs", "startupMs"]},
            "warmMs": statistics.median(sorted(row["warmMs"])[len(row["warmMs"]) // 2]
                                        for row in selected),
        })

output.write_text(json.dumps({
    "capturedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "node": subprocess.check_output(["node", "--version"], text=True).strip(),
    "binarySha256": {version: hashlib.sha256(addon.read_bytes()).hexdigest()
                     for version, addon in addons.items()},
    "inputsSha256": hashlib.sha256(inputs.read_bytes()).hexdigest(),
    "summary": summary, "rows": rows,
}, indent=2) + "\n")
