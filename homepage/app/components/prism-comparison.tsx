/* oxlint-disable react/no-danger -- Output comes from fixed source fixtures, generated and checked against both highlighters. */
import { useState } from "react";

import sample from "../data/prism-comparison.json";
import { FocusableTable } from "../focusable-table";

type Sample = (typeof sample.samples)[number];
type Classification = Sample["classifications"][number];
const observations: Record<string, string> = {
  "typescript-parameters":
    "Ferriki distinguishes a parameter binding, a later variable read, and a property in a type. Prism leaves these identifiers as plain text in this example. Those distinctions let a theme give each role its own treatment.",
  "typescript-templates":
    "Both grammars handle nested interpolation and comments here. Ferriki also retains parameter and surrounding expression scopes. Inspect the binding below to see what the shipped grammars actually emit.",
  "tsx-component":
    "A generic component mixes TypeScript types, JSX attributes, callback parameters, and nested template interpolation. Both recognize the function and JSX attribute; Ferriki also retains the surrounding JSX and expression scopes.",
  "cpp-templates":
    "Templates, a capturing lambda, a preprocessor macro, and a custom-delimited raw string share one example. Both recognize the function, macro, and raw string. Ferriki additionally captures definition and string-delimiter context.",
  "css-components":
    "Ferriki distinguishes custom-property declarations, property names, and known property values such as grid. Prism labels the declarations as property and leaves grid as plain text here. Inspect the captured labels below.",
  "go-handler":
    "Ferriki identifies the Reply type declaration and the Message struct field; Prism leaves both as plain text here. Both identify the function declaration. Those extra distinctions give your theme more roles to style.",
  "rust-result":
    "A small parsing function combines a struct, generic return types, attributes, and macros. The table shows the actual classifications of its declarations and return type.",
  "html-embedded":
    "Both grammars highlight HTML with embedded CSS and JavaScript. Ferriki keeps the TextMate context of each language region; the two outputs can differ in token boundaries and theme treatment.",
  "astro-component":
    "Ferriki highlights TypeScript frontmatter, markup, expressions, CSS, and browser JavaScript in one Astro component. Prism 1.30.0 has no Astro grammar in its component manifest. Its panel shows the unchanged source, with no substitute grammar.",
};

function ComparisonPanels({ entry }: { entry: Sample }) {
  return (
    <div className="prism-comparison-grid">
      <figure className="ferriki-highlighted-panel">
        <figcaption>
          <strong>Ferriki {sample.versions.ferriki}</strong>
          <span>TextMate grammar · GitHub Dark High Contrast</span>
        </figcaption>
        <div
          dangerouslySetInnerHTML={{
            __html: entry.ferrikiHtml.replace("<pre ", '<pre tabindex="0" '),
          }}
        />
      </figure>
      <figure className="ferriki-highlighted-panel prism-rendered">
        <figcaption>
          <strong>Prism {sample.versions.prism}</strong>
          <span>
            {entry.prismHtml === null
              ? "Astro grammar unavailable · source shown"
              : "Prism grammar · matched color palette"}
          </span>
        </figcaption>
        <pre tabIndex={0}>
          <code>
            {entry.prismHtml === null ? (
              entry.source
            ) : (
              <span dangerouslySetInnerHTML={{ __html: entry.prismHtml }} />
            )}
          </code>
        </pre>
      </figure>
    </div>
  );
}

function ClassificationRow({ row }: { row: Classification }) {
  return (
    <tr>
      <th scope="row">
        <code>{row.text}</code>
        <small>{row.label}</small>
      </th>
      <td>
        <code>{row.ferriki.at(-1)}</code>
        <small>{row.ferriki.slice(0, -1).join(" → ")}</small>
      </td>
      <td>
        {row.prism.length > 0 ? (
          <code>{row.prism.join(" → ")}</code>
        ) : (
          "Plain text — no token classification"
        )}
      </td>
    </tr>
  );
}

function ClassificationDetails({ entry }: { entry: Sample }) {
  if (entry.classifications.length === 0) return null;
  return (
    <details className="prism-classifications" open>
      <summary>Inspect the actual token classifications</summary>
      <FocusableTable>
        <caption>
          Selected source occurrences in this example. Neither highlighter performs semantic type
          checking.
        </caption>
        <thead>
          <tr>
            <th scope="col">Source occurrence</th>
            <th scope="col">Ferriki scopes</th>
            <th scope="col">Prism tokens</th>
          </tr>
        </thead>
        <tbody>
          {entry.classifications.map((row) => (
            <ClassificationRow key={row.offset} row={row} />
          ))}
        </tbody>
      </FocusableTable>
    </details>
  );
}

export function PrismComparison() {
  const [selected, setSelected] = useState(sample.samples[0].id);
  const entry = sample.samples.find((item) => item.id === selected) ?? sample.samples[0];
  return (
    <section className="prism-comparison" aria-label="Ferriki and Prism rendered examples">
      <div className="ferriki-chart-control">
        <label htmlFor="prism-example">Choose an example</label>
        <select
          id="prism-example"
          value={selected}
          onChange={(event) => {
            setSelected(event.target.value);
          }}
        >
          {sample.samples.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </div>
      <p className="prism-observation" aria-live="polite">
        {observations[entry.id]}
      </p>
      <ComparisonPanels entry={entry} />
      <p className="prism-presentation-note">
        Same source, font, and code-panel background. Ferriki uses GitHub Dark High Contrast; Prism
        uses custom CSS from the same palette. Theme rules can still differ. No generated token is
        added or relabeled. The classifications below show the grammar evidence behind the colors.
      </p>
      <ClassificationDetails entry={entry} />
    </section>
  );
}
