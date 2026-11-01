import type { ArdoMetaFunction } from "ardo/runtime";

import { ArdoLink as Link } from "ardo/runtime";
import { Mark, RegistryFacts } from "ferramenta-family";
import {
  FerraAction,
  FerraArticle,
  FerraColumns,
  FerraEditorialRow,
  FerraInstrument,
  FerraNotes,
  FerraProductLead,
  FerraProductPage,
  FerraReleaseFacts,
} from "ferramenta-family/ferra";
import { family, WORKSHOP } from "ferramenta-family/registry";

import {
  ClosingSection,
  CodeSection,
  CoverageSection,
  FamilySection,
  MacroSection,
  SampleSection,
  ThemeSection,
} from "../components/home-sections";
import { PreparedRegexSection } from "../components/prepared-regex";
import preparedReport from "../data/evidence/regex-modes-comparison.json";
import { version } from "../version";

// oxlint-disable-next-line react/only-export-components -- Ardo reads route metadata.
export const meta: ArdoMetaFunction = () => [
  { title: "Ferriki — Beautiful code. Head start included." },
  {
    name: "description",
    content:
      "Native TextMate syntax highlighting for Node.js, Rust and Vite. Familiar Shiki-style calls, embedded languages, and prepared grammar packages.",
  },
];
// oxlint-disable-next-line react/only-export-components -- Ardo reads the route layout.
export const handle = { layout: "bare" };

const member = family.find((entry) => entry.name === "ferriki");
if (!member) throw new Error("Ferriki is missing from the family registry.");
const tool = { ...member, version };
const factors = preparedReport.profiles.map(
  (profile) => profile.warm["shiki-wasm"] / profile.warm["ferriki-precompiled"],
);
const speedRange = `${Math.min(...factors).toFixed(1)}–${Math.max(...factors).toFixed(1)}×`;
const measurementDate = new Date(preparedReport.measured).toLocaleDateString("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function Opening() {
  return (
    <FerraProductLead
      id="overview"
      title="Beautiful code. Head start included."
      introduction="TextMate syntax highlighting for Node.js, Rust and Vite. Keep the grammars and themes your editor uses, with a native engine and prepared language packages that arrive ready to work."
      art={<FerraInstrument product="ferriki" />}
      byline={
        <>
          An open-source project by <a href={WORKSHOP.openSource}>{WORKSHOP.company}</a>.
        </>
      }
    >
      <div className="ferra-actions">
        <FerraAction href="/guide/getting-started">Start with Node.js</FerraAction>
        <FerraAction variant="secondary" href="/rust/getting-started">
          Start with Rust
        </FerraAction>
      </div>
    </FerraProductLead>
  );
}
function Overview() {
  return (
    <FerraColumns>
      <FerraArticle
        title="Your editor’s grammar, on your page."
        icon={<Mark name="pen" size={28} />}
        meta={<Link to="/evidence/compatibility">What compatibility covers</Link>}
      >
        <p>
          TextMate tokenization, embedded languages and grammar injections, with familiar
          Shiki-style HTML calls. The detail comes from the grammar your editor uses.
        </p>
        <a href="#sample">See the languages in action</a>
      </FerraArticle>
      <FerraArticle
        title="A head start, built in."
        icon={<Mark name="document" size={28} />}
        meta={<FerraReleaseFacts tool={tool} />}
      >
        <p>
          Standard language packages include compiled regex programs and prepared scanners. Restore
          that work on startup, then highlight with native Rust.
        </p>
        <a href="#prepared-regex">How the preparation travels</a>
      </FerraArticle>
    </FerraColumns>
  );
}
function EvidenceSection() {
  return (
    <FerraArticle
      id="evidence"
      title="Spend less time rendering code."
      introduction="Load a highlighter once, then keep using it. On our fourteen-file repository corpus, Ferriki delivered identical HTML to Shiki/WASM on both measured hosts."
      meta={
        <>
          Measured <time dateTime={preparedReport.measured}>{measurementDate}</time> with Ferriki{" "}
          {preparedReport.ferriki} and Ferroni {preparedReport.ferroni}.{" "}
          <a href={preparedReport.runUrl}>Source run</a>
          {" · "}
          <Link to="/evidence/benchmarks">Timings, startup, memory and every language case</Link>
        </>
      }
    >
      <p>
        With the languages and themes already loaded, repeated HTML calls were {speedRange} faster
        than Shiki/WASM across Linux x86-64 and macOS ARM64. These are highlighting measurements,
        rather than total build times; another workload or machine can give different results.
      </p>
      <p>
        Prepared packages also used about 45% less whole-process RSS after 600 documents across
        twelve loaded languages on both hosts. Six isolated processes per contender produced
        identical HTML. The detailed report keeps the startup cost, download weight and measurement
        conditions alongside the results.
      </p>
    </FerraArticle>
  );
}
export default function HomePage() {
  return (
    <RegistryFacts>
      <FerraProductPage>
        <Opening />
        <Overview />
        <SampleSection />
        <FerraEditorialRow
          notes={
            <FerraNotes
              label="Preparation and compatibility"
              notes={tool.editorial?.notes.slice(0, 1) ?? []}
            />
          }
        >
          <PreparedRegexSection />
        </FerraEditorialRow>
        <MacroSection />
        <FerraEditorialRow
          notes={
            <FerraNotes
              label="Inside the grammar engine"
              notes={tool.editorial?.notes.slice(1) ?? []}
            />
          }
        >
          <ThemeSection />
        </FerraEditorialRow>
        <CodeSection />
        <EvidenceSection />
        <FamilySection />
        <CoverageSection />
        <ClosingSection />
      </FerraProductPage>
    </RegistryFacts>
  );
}
