import process from "node:process";
import { performance } from "node:perf_hooks";
import { createHighlighter } from "../ferriki/index.mjs";
import "./test-asset-env.mjs";

const block =
  "## Streaming example\n\n```js\nconst value = 42;\nconsole.log(value);\n```\n\nA paragraph with **emphasis**, `inline code`, and a link.\n\n";
const chunk = block.repeat(4);
const chunkCount = Number(process.env.FERRIKI_BENCH_CHUNKS || 64);
const sampleCount = Number(process.env.FERRIKI_BENCH_SAMPLES || 3);
const chunks = Array.from({ length: chunkCount }, () => chunk);
const options = { lang: "markdown", theme: "nord" };
const highlighter = await createHighlighter({ langs: ["markdown"], themes: ["nord"] });

function run() {
  let grammarState;
  for (const fragment of chunks)
    grammarState = highlighter.getLastGrammarState(fragment, { ...options, grammarState });
  return grammarState;
}

try {
  run();
  const samplesMs = [];
  for (let sample = 0; sample < sampleCount; sample++) {
    const start = performance.now();
    run();
    samplesMs.push(performance.now() - start);
  }
  const sorted = [...samplesMs].sort((left, right) => left - right);
  const medianMs = sorted[Math.floor(sorted.length / 2)];
  console.log(
    JSON.stringify(
      {
        runtime: process.version,
        platform: `${process.platform}-${process.arch}`,
        chunks: chunkCount,
        chunkBytes: Buffer.byteLength(chunk),
        totalBytes: chunkCount * Buffer.byteLength(chunk),
        samplesMs,
        medianMs,
      },
      null,
      2,
    ),
  );
} finally {
  highlighter.dispose();
}
