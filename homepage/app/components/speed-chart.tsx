import { useState } from "ardo/react";
import { ArdoLink as Link } from "ardo/runtime";
import {
  MonoBarChart,
  type MonoBarRow,
  MonoSegmented,
  MonoTableView,
} from "ferramenta-family/monografie";

import { corpus, featured, type FeaturedId, measured, pair, platforms } from "./homepage-data";

const platformLabel = (id: string) => platforms.find((entry) => entry.id === id)?.label ?? id;
const featuredId = (id: string) => featured.find((entry) => entry.id === id)?.id;

function rows(platform: string): MonoBarRow[] {
  return [
    { id: "ferriki", label: "Ferriki", sub: "prepared packages, Node.js", value: 1, own: true },
    ...featured.map((entry) => ({
      id: entry.id,
      label: entry.label,
      sub: entry.sub,
      value: pair(platform, entry.id).ratio,
    })),
  ];
}

function describer(platform: string) {
  const machine = platformLabel(platform);
  return function describe(row: MonoBarRow, cut: boolean) {
    const id = featuredId(row.id);
    if (id === undefined) {
      return (
        <>
          <b>Ferriki</b> is the baseline: 1× on {machine}.
        </>
      );
    }
    const { ratio, files, ahead } = pair(platform, id satisfies FeaturedId);
    return (
      <>
        <b>{row.label}</b> needed {ratio.toFixed(2)}× as long as Ferriki for the same {files} files
        on {machine}
        {ratio < 1 ? ", so it was faster. " : ". "}
        {ahead === files
          ? "Ferriki was quicker on every one of them."
          : ahead === 0
            ? `${row.label} was quicker on every one of them.`
            : `Ferriki was quicker on ${String(ahead)} of them.`}
        {cut ? " The bar is cut at 7×." : ""}
      </>
    );
  };
}

function Figures() {
  return (
    <MonoTableView>
      <table className="mono-table">
        <thead>
          <tr>
            <th scope="col">Highlighter</th>
            {platforms.map((platform) => (
              <th key={platform.id} scope="col" className="mono-num">
                {platform.label}
              </th>
            ))}
            <th scope="col" className="mono-num">
              Files
            </th>
          </tr>
        </thead>
        <tbody>
          {featured.map((entry) => (
            <tr key={entry.id}>
              <td>{entry.label}</td>
              {platforms.map((platform) => (
                <td key={platform.id} className="mono-num">
                  {`${pair(platform.id, entry.id).ratio.toFixed(2)}×`}
                </td>
              ))}
              <td className="mono-num">{pair(platforms[0].id, entry.id).files}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </MonoTableView>
  );
}

const conditions = (
  <>
    <h3>How this was measured</h3>
    <p>
      {measured.date} on Blacksmith virtual machines: {platforms.map((p) => p.cpu).join(" and ")}.
      Ferriki {measured.ferriki} with Ferroni {measured.ferroni}.
    </p>
    <p>
      {corpus.files} files: {corpus.curated} common formats and the {corpus.tiobe} most-used TIOBE
      languages Ferriki supports, each as a short example and a large file.
    </p>
    <p>
      Each figure sums the median time per file, highlighters already loaded. A row counts only the
      files both can highlight.
    </p>
    <p>Highlighting time only, not whole builds; your files and machine change the result.</p>
  </>
);

/** Time for the same files: Ferriki and the best-known alternatives, per machine. */
export function SpeedChart() {
  const [platform, setPlatform] = useState(platforms[0].id);
  return (
    <div className="mono-wide">
      <MonoBarChart
        label={`Time for the same files, ${platformLabel(platform)}`}
        title="Time for the same files"
        description="Ferriki = 1×, the line through every row. A bar past it took longer; a bar short of it was faster."
        toggles={
          <MonoSegmented
            label="Machine"
            value={platform}
            onChange={setPlatform}
            options={platforms.map((entry) => ({ value: entry.id, label: entry.label }))}
          />
        }
        rows={rows(platform)}
        scale={7}
        ticks={[1, 2, 3, 4, 5, 6, 7]}
        describe={describer(platform)}
        after={
          <>
            <p>
              Every contender, language and size, with startup and memory:{" "}
              <Link to="/evidence/benchmarks#four-regex-policies">the benchmark report</Link> and{" "}
              <a href={measured.runUrl}>the run that produced it</a>.
            </p>
            <Figures />
          </>
        }
        conditions={conditions}
      />
    </div>
  );
}
