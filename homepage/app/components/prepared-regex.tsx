import { ArdoLink as Link } from "ardo/runtime";
import { FerraArticle, FerraSteps } from "ferramenta-family/ferra";

const steps = [
  {
    heading: "Compile before delivery",
    text: "Ferroni compiles static regex programs and prepares Eager scanner automata.",
  },
  {
    heading: "Deliver the package",
    text: "Requested grammars arrive with their reusable programs and scanner preparation.",
  },
  {
    heading: "Keep the prepared work",
    text: "Verified downloads and unpacked packages stay in your disk cache across builds.",
  },
  {
    heading: "Restore, then highlight",
    text: "A fresh process restores the requested scanners and starts on your code.",
  },
];
export function PreparedRegexSection() {
  return (
    <FerraArticle
      id="prepared-regex"
      title="We ship the preparation."
      introduction="Standard language packages carry compiled regex programs and prepared static scanners. They are ready for production and enabled by default."
      meta={
        <Link to="/evidence/benchmarks#four-regex-policies">
          Compare startup, memory and every policy
        </Link>
      }
    >
      <FerraSteps caption="From a syntax definition to a reusable language package" items={steps} />
      <p>
        Matching runs in Ferroni’s native, Oniguruma-compatible engine, without translating patterns
        to JavaScript RegExp. A fresh process restores the prepared work, rather than rebuilding
        every static scanner.
      </p>
      <p>
        The preparation adds download weight: Rust needs about 58 kB in total versus 18 kB for its
        grammar alone. TypeScript with required embeddings needs 4.65 MB versus 0.54 MB; Markdown
        needs 1.97 MB versus 61 kB. Decimal payload sizes, excluding themes and HTTP overhead. Keep
        the disk cache to reuse downloads; decoded data also takes disk space.{" "}
        <Link to="/evidence/benchmarks#shared-language-packages">Compare the download sizes.</Link>
      </p>
      <p>
        Missing packages fall back to source. Capture-dependent end and while patterns stay dynamic
        to preserve TextMate behavior. Only requested languages and required dependencies load;
        optional code-fence languages stay optional.
      </p>
      <p>
        Sponsored by <a href="https://sebastian-software.de/">Sebastian Software</a>, which
        currently covers Ferriki&rsquo;s CDN costs.
      </p>
    </FerraArticle>
  );
}
