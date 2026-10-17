"""Recompute the pooled estimates and admission checks from the raw reports."""

import gzip
import json
import math
import statistics
from pathlib import Path

ROOT = Path(__file__).parent
median = statistics.median


def read_report(name):
    path = ROOT / name
    if path.is_file():
        return json.loads(path.read_text())
    with gzip.open(str(path) + ".gz", "rt") as stream:
        return json.load(stream)


def interval(ratios):
    state = 20261017
    estimates = []
    for _ in range(10000):
        selected = []
        for _ in ratios:
            state = (state * 1664525 + 1013904223) & 0xFFFFFFFF
            selected.append(ratios[(state * len(ratios)) // 2**32])
        estimates.append(median(selected) - 1)
    estimates.sort()
    return [estimates[249], estimates[9749]]


def case_ratios(report, index, base, candidate):
    return [
        median(run["cases"][index]["samplesMs"][candidate])
        / median(run["cases"][index]["samplesMs"][base])
        for run in report["runs"]
    ]


def homepage(report, base, candidate):
    rows = []
    for index, entry in enumerate(report["runs"][0]["cases"]):
        ratios = case_ratios(report, index, base, candidate)
        rows.append({
            "path": entry["path"],
            "change": median(ratios) - 1,
            "interval95": interval(ratios),
            "ratios": ratios,
        })
    totals = [
        {
            name: sum(median(row["samplesMs"][name]) for row in run["cases"])
            for name in [base, candidate]
        }
        for run in report["runs"]
    ]
    cold = [row[candidate] / row[base] for row in report["cold"]]
    return {
        "rows": rows,
        "totals": totals,
        "totalChange": median(row[candidate] / row[base] for row in totals) - 1,
        "coldChange": median(cold) - 1,
        "coldInterval95": interval(cold),
        "coldRatios": cold,
    }


def native(report, base, candidate):
    rows = []
    for index, entry in enumerate(report["runs"][0]["cases"]):
        estimates = case_ratios(report, index, base, candidate)
        rows.append({
            "id": entry["id"],
            "change": median(estimates) - 1,
            "interval95": interval(estimates),
            "changesPerWorker": [value - 1 for value in estimates],
        })
    ratios = [
        math.exp(statistics.mean(
            math.log(
                median(row["samplesMs"][candidate]) / median(row["samplesMs"][base])
            )
            for row in run["cases"]
        ))
        for run in report["runs"]
    ]
    sums = {
        name: sum(
            median(
                value
                for run in report["runs"]
                for value in run["cases"][index]["samplesMs"][name]
            )
            for index in range(len(rows))
        )
        for name in [base, candidate]
    }
    return {
        "cases": len(rows),
        "geomeanChangeMedian": median(ratios) - 1,
        "geomeanChangesPerWorker": [value - 1 for value in ratios],
        "geomeanInterval95": interval(ratios),
        "sumOfMediansMs": sums,
        "sumChange": sums[candidate] / sums[base] - 1,
        "rows": rows,
    }


curated = read_report("curated-final.json")
home = read_report("homepage-final.json")
first_six = {
    name: homepage(home, base, "combined")
    for name, base in [("incremental", "baseline"), ("wholePr", "main")]
}
confirmation = read_report("homepage-confirmation.json")
assert home["engines"] == confirmation["engines"]
assert home["harnessSha256"] == confirmation["harnessSha256"]
for run in confirmation["runs"]:
    for index, row in enumerate(run["cases"]):
        for key in ["path", "sha256", "outputSha256"]:
            assert row[key] == home["runs"][0]["cases"][index][key]
home["runs"].extend(confirmation["runs"])
assert len(home["runs"]) == 12

summary = {
    "homepageFirstSix": first_six,
    "sampling": {
        "warmIndependentProcesses": 12,
        "coldTriples": 40,
        "extensionReason": "The first six-worker incremental HTML upper interval endpoint was +2.34%, although its median was -3.80%.",
        "stoppingRule": "One additional six-worker cohort, same configurations and all prior observations retained.",
    },
    "homepage": {
        name: homepage(home, base, "combined")
        for name, base in [("incremental", "baseline"), ("wholePr", "main")]
    },
    "curated": {
        name: native(curated, "baseline", name)
        for name in ["css", "ascii", "combined"]
    },
}
summary["curated"]["wholePr"] = native(curated, "main", "combined")
for section in summary["homepage"].values():
    assert len(section["rows"]) == 14
    assert max(row["interval95"][1] for row in section["rows"]) < 0.02
    assert section["coldInterval95"][1] < 0.02

admission = {}
for name, languages in [("css", ["mdx", "css"]), ("ascii", ["mdx", "java", "css"])]:
    targets = [f"curated/{language}/example/html" for language in languages]
    selected = [row for row in summary["curated"][name]["rows"] if row["id"] in targets]
    assert min(row["change"] for row in selected) < -0.03, (name, selected)
    admission[name] = {
        "screenedRepresentativeCases": selected,
        "atLeastOneRepeatedCaseThreePercentFaster": True,
    }
summary["admission"] = {
    "candidates": admission,
    "eachHomepageAndColdUpper95BelowTwoPercentSlower": True,
    "interpretation": "Candidate admission is case-specific; the per-candidate broad geometric means need not reach 3%.",
}
print(json.dumps(summary, indent=2))
