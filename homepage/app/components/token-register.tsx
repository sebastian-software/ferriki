import { useState } from "ardo/react";
import { MonoFacing, MonoSegmented, MonoSheet } from "ferramenta-family/monografie";

import { samples } from "./homepage-data";

/* The opening specimen: one HTML file with CSS and JavaScript inside it, as
   Ferriki's token stream. Pointing at a token, or choosing one of the
   examples, shows the scope path the grammar gave it and the theme's color. */

const { register } = samples;
type Position = { line: number; token: number };

/** The first token whose innermost scope starts with `scope`, inside `within` when given. */
function find(scope: string, within?: string): Position {
  for (const [line, tokens] of register.lines.entries()) {
    for (const [token, entry] of tokens.entries()) {
      const path = register.paths[entry.path];
      if (
        path.at(-1)?.startsWith(scope) === true &&
        (within === undefined || path.includes(within))
      )
        return { line, token };
    }
  }
  throw new Error(`The register sample has no ${scope} token`);
}

const examples = [
  {
    value: "attribute",
    label: "HTML attribute",
    at: find("entity.other.attribute-name.html", "meta.attribute.data-x.data-name.html"),
  },
  { value: "property", label: "CSS property", at: find("support.type.property-name.css") },
  { value: "string", label: "JavaScript string", at: find("string.quoted.double.js") },
  {
    value: "expression",
    label: "Template expression",
    at: find("variable.other.readwrite.js", "meta.template.expression.js"),
  },
];

const same = (a: Position, b: Position) => a.line === b.line && a.token === b.token;

/* The fixed output, each line and token with a stable id from its position. */
const rows = register.lines.map((tokens, line) => ({
  id: `line-${String(line + 1)}`,
  tokens: tokens.map((entry, token) => ({
    ...entry,
    id: `${String(line + 1)}:${String(token + 1)}`,
    at: { line, token },
  })),
}));
const tokenAt = ({ line, token }: Position) => register.lines[line][token];

function Readout({ at }: { at: Position }) {
  const token = tokenAt(at);
  const path = register.paths[token.path];
  return (
    <div className="fk-readout" aria-live="polite">
      <p className="fk-readout-token">
        <code style={{ color: token.color }}>{token.content.trim()}</code>
      </p>
      <ol className="fk-scopes">
        {path.map((scope, index) => (
          <li key={scope} data-innermost={index === path.length - 1 ? "" : undefined}>
            {scope}
          </li>
        ))}
      </ol>
      <p className="fk-readout-color">
        <span className="fk-swatch" style={{ background: token.color }} aria-hidden="true" />
        {register.theme} gives it <code>{token.color}</code>
      </p>
    </div>
  );
}

type TokensProps = { active: Position; onActive: (position: Position) => void };

/** The highlighted source, one span per token; pointing at a token selects it. */
function Tokens({ active, onActive }: TokensProps) {
  // Scrolls sideways on a phone; focusable so the keyboard can scroll it too.
  return (
    <pre
      className="fk-tokens"
      tabIndex={0}
      aria-label="Highlighted source of index.html"
      style={{ background: register.background }}
    >
      {rows.map((row) => (
        <span className="fk-line" key={row.id}>
          {row.tokens.map((token) =>
            token.content.trim() === "" ? (
              <span key={token.id}>{token.content}</span>
            ) : (
              <span
                key={token.id}
                className="fk-token"
                data-active={same(active, token.at) ? "" : undefined}
                style={{ color: token.color }}
                onMouseEnter={() => {
                  onActive(token.at);
                }}
              >
                {token.content}
              </span>
            ),
          )}
        </span>
      ))}
    </pre>
  );
}

export function TokenRegister() {
  const [active, setActive] = useState<Position>(examples[3].at);
  const chosen = examples.find((example) => same(example.at, active))?.value ?? "";
  return (
    <figure className="mono-wide fk-register fk-gap">
      <MonoSegmented
        label="Show a token"
        value={chosen}
        options={examples.map(({ value, label }) => ({ value, label }))}
        onChange={(value) => {
          const example = examples.find((entry) => entry.value === value);
          if (example !== undefined) setActive(example.at);
        }}
      />
      <MonoFacing>
        <MonoSheet label="As highlighted by Ferriki" meta={register.file}>
          <Tokens active={active} onActive={setActive} />
        </MonoSheet>
        <MonoSheet label="What the grammar called it" meta="outermost scope first">
          <Readout at={active} />
        </MonoSheet>
      </MonoFacing>
      <figcaption className="mono-caption">
        Real output of @ferriki/core {samples.renderedWith["@ferriki/core"]}: the tokens its
        transformers receive, each with its scope path and its color from {register.theme}. Point at
        a token, or choose one above.
      </figcaption>
    </figure>
  );
}
