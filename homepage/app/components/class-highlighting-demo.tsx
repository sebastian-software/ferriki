/* cspell:words Monokai */
import { useState } from "react";

import sample from "../data/class-sample.json";

export function ClassHighlightingDemo() {
  const [theme, setTheme] = useState("dark");
  const [custom, setCustom] = useState(false);
  return (
    <section
      className={`class-demo${custom ? " class-demo-custom" : ""}`}
      aria-label="Class highlighting example"
    >
      <style>{sample.css}</style>
      <div className="class-demo-controls">
        <label>
          Theme{" "}
          <select
            value={theme}
            onChange={(event) => {
              setTheme(event.target.value);
            }}
          >
            <option value="light">GitHub Light</option>
            <option value="dark">Monokai</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={custom}
            onChange={(event) => {
              setCustom(event.target.checked);
            }}
          />{" "}
          Override strings with CSS
        </label>
      </div>
      {/* HTML and CSS are generated from the fixed local fixture, never user input. */}
      <div
        data-ferriki-theme={theme}
        // oxlint-disable-next-line react/no-danger -- Fixed local source is escaped by Ferriki and committed as an artifact.
        dangerouslySetInnerHTML={{ __html: sample.html }}
      />
      <p>
        Change the theme or enable the CSS override. The highlighted token elements stay in place.
      </p>
    </section>
  );
}
