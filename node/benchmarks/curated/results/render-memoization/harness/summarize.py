"""Regenerate descriptive summaries from the retained raw samples."""
import json
import math
import statistics
from pathlib import Path

OUT = Path(__file__).resolve().parents[1]


def med(values):
    return statistics.median(values)


def geo(values):
    return math.exp(statistics.mean(math.log(value) for value in values))


def summarize(file):
    data = json.loads(file.read_text())
    names = list(data["runs"][0]["cases"][0]["samplesMs"])
    groups = sorted({"/".join(case["id"].split("/")[1:]) for case in data["runs"][0]["cases"]})
    result = {}
    for base, candidate in [(names[0], name) for name in names[1:]] + ([('scope-only', 'candidate')] if 'scope-only' in names else []):
        result[f"{candidate}/{base}"] = {}
        for group in groups:
            processes = []
            for run in data["runs"]:
                selected = [case for case in run["cases"] if case["id"].endswith("/" + group)]
                processes.append(geo([med(case["samplesMs"][candidate]) / med(case["samplesMs"][base]) for case in selected]) - 1)
            result[f"{candidate}/{base}"][group] = {
                "medianChangePercent": med(processes) * 100,
                "processRangePercent": [min(processes) * 100, max(processes) * 100],
                "perProcessChangePercent": [value * 100 for value in processes],
            }
    return result


if __name__ == "__main__":
    result = {file.stem: summarize(file) for file in [OUT / "ablation.json", OUT / "repeat.json"] if file.exists()}
    memory = OUT / "memory.json"
    if memory.exists():
        result['memory'] = [{
            'id': row['id'], 'constructionMedianMs': med(row['constructionMs']),
            'scopeCacheMedianHeapBytes': med(row['scopeCacheHeapBytesPerCopy']),
            'styleLookupMapMedianHeapBytes': med(row['styleLookupMapHeapBytesPerCopy']),
        } for row in json.loads(memory.read_text())['rows']]
    (OUT / "summary.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
