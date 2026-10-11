#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";
import { gunzipSync } from "node:zlib";
const file = process.argv[2];
if (file === "--help" || file === "-h") {
  console.log("Usage: node scripts/analyze-shadow-dom-trace.mjs <trace.json[.gz]>");
  process.exit(0);
}
if (!file || process.argv.length !== 3) throw new Error("Expected one Chrome trace path");
let bytes = await readFile(file);
if (file.endsWith(".gz")) bytes = gunzipSync(bytes);
const input = JSON.parse(bytes.toString());
const events = input.traceEvents ?? input;
const marks = events.filter((e) => e.name?.startsWith("ferriki:"));
const origin = marks.find((e) => e.name === "ferriki:profile:hydrateRoot:start");
if (!origin) throw new Error("Missing hydrateRoot start mark");
const pid = origin.pid;
const tid = origin.tid;
const main = events.filter((e) => e.pid === pid && e.tid === tid);
const stack = [];
const complete = [];
for (const e of [...main].sort((a, b) => a.ts - b.ts)) {
  if (e.ph === "X" && e.dur > 0) complete.push(e);
  else if (e.ph === "B") stack.push(e);
  else if (e.ph === "E" && stack.length) {
    const start = stack.pop();
    complete.push({ ...start, ph: "X", dur: e.ts - start.ts });
  }
}
const markByName = Object.fromEntries(marks.map((e) => [e.name, e]));
function unionLength(intervals) {
  const sorted = intervals.filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let end = -Infinity;
  for (const [a, b] of sorted) {
    total += Math.max(0, b - Math.max(a, end));
    end = Math.max(end, b);
  }
  return total;
}
const rules = [
  ["htmlParse", (e) => e.name === "ParseHTML"],
  ["style", (e) => e.name === "UpdateLayoutTree" || e.name === "RecalculateStyles"],
  ["layout", (e) => e.name === "Layout"],
  ["prePaint", (e) => e.name === "PrePaint"],
  ["paint", (e) => e.name === "Paint"],
  ["gc", (e) => /^(?:MajorGC|MinorGC|BlinkGC|V8\.GC|v8\.gc)/.test(e.name)],
  [
    "script",
    (e) => e.name === "FunctionCall" || e.name === "EvaluateScript" || e.name === "V8.Execute",
  ],
  ["taskOther", (e) => e.name === "RunTask"],
];
function analyze(startName, endName) {
  const start =
    startName === "trace:renderer:start"
      ? { ts: Math.min(...main.filter((e) => e.ts > 0).map((e) => e.ts)) }
      : markByName[startName];
  const end = markByName[endName];
  if (!start || !end) return null;
  const lo = start.ts;
  const hi = end.ts;
  const active = complete.filter((e) => e.ts < hi && e.ts + e.dur > lo);
  const classified = rules.map(([name, match]) => ({
    name,
    intervals: active.filter(match).map((e) => [Math.max(lo, e.ts), Math.min(hi, e.ts + e.dur)]),
  }));
  const boundaries = [lo, hi, ...classified.flatMap((x) => x.intervals.flat())].sort(
    (a, b) => a - b,
  );
  const totals = Object.fromEntries(rules.map(([k]) => [k, 0]));
  totals.unaccounted = 0;
  for (let i = 0; i < boundaries.length - 1; i++) {
    const a = boundaries[i];
    const b = boundaries[i + 1];
    if (b <= a) continue;
    const c = classified.find((c) => c.intervals.some(([x, y]) => x <= a && y >= b));
    totals[c?.name ?? "unaccounted"] += (b - a) / 1000;
  }
  const top = active
    .filter((e) =>
      [
        "RunTask",
        "FunctionCall",
        "Layout",
        "UpdateLayoutTree",
        "PrePaint",
        "Paint",
        "ParseHTML",
        "TimerFire",
        "FireAnimationFrame",
        "EventDispatch",
      ].includes(e.name),
    )
    .sort((a, b) => a.ts - b.ts)
    .map((e) => ({
      name: e.name,
      offsetMs: (Math.max(lo, e.ts) - lo) / 1000,
      elapsedMs: (Math.min(hi, e.ts + e.dur) - Math.max(lo, e.ts)) / 1000,
      functionName: e.args?.data?.functionName,
      url: e.args?.data?.url,
      lineNumber: e.args?.data?.lineNumber,
      args: e.name === "Layout" ? e.args?.beginData : undefined,
    }));
  return {
    elapsedMs: (hi - lo) / 1000,
    exclusiveApproximationMs: totals,
    mainTaskMs: unionLength(classified.find((x) => x.name === "taskOther").intervals) / 1000,
    events: top,
  };
}
const windows = [
  ["beforeHydration", "trace:renderer:start", "ferriki:profile:hydrateRoot:start"],
  ["setup", "ferriki:setup:start", "ferriki:setup:end"],
  ["preFlush", "ferriki:profile:pre-hydrate-flush:start", "ferriki:profile:pre-hydrate-flush:end"],
  ["reactCall", "ferriki:profile:hydrateRoot:start", "ferriki:profile:hydrateRoot:return"],
  ["untilCommit", "ferriki:profile:hydrateRoot:start", "ferriki:profile:app-commit"],
  ["afterReturn", "ferriki:profile:hydrateRoot:return", "ferriki:profile:app-commit"],
  ["afterCommit", "ferriki:profile:app-commit", "ferriki:profile:post-commit:raf2"],
];
console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      method:
        "Clip main-thread timeline events to User Timing marks. Partition intervals by HTML parse, style, layout, prepaint, paint, GC, observed script event, task remainder, and unaccounted precedence. These are elapsed event intervals, not isolated CPU measurements. Nested Paint events count once. The before-hydration window starts at the earliest retained renderer event; it is not full navigation timing.",
      file,
      pid,
      tid,
      thread: main.find((e) => e.name === "thread_name")?.args?.name,
      marks: marks.map((e) => ({ name: e.name, offsetMs: (e.ts - origin.ts) / 1000 })),
      windows: Object.fromEntries(windows.map(([k, a, b]) => [k, analyze(a, b)])),
    },
    null,
    2,
  ),
);
