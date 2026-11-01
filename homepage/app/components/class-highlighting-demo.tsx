/* cspell:words Monokai */
import { useId, useState } from "ardo/react";
import { FerraRenderedCode, FerraSelect, FerraToggle } from "ferramenta-family/ferra";

import sample from "../data/class-sample.json";

export function ClassHighlightingDemo() {
  const id = useId();
  const [theme, setTheme] = useState("light");
  const [custom, setCustom] = useState(false);
  return (
    <section
      aria-label="Class highlighting example"
      data-class-example={id}
      data-ferriki-theme={theme}
      data-custom={custom}
    >
      {/* The generated example owns its theme variables; the page uses shared styles. */}
      <style>{`${sample.css}
[data-class-example="${id}"] .ferriki { color: var(--ferriki-color); background-color: var(--ferriki-background); }
[data-class-example="${id}"][data-custom="true"] .tok-string { color: inherit; }`}</style>
      <FerraSelect
        label="Theme"
        value={theme}
        options={[
          { value: "light", label: "GitHub Light" },
          { value: "dark", label: "Monokai" },
        ]}
        onChange={(event) => {
          setTheme(event.target.value);
        }}
      />
      <FerraToggle
        pressed={custom}
        label="Use plain string color"
        description="Override one token class with CSS."
        onClick={() => {
          setCustom(!custom);
        }}
      />
      <FerraRenderedCode caption="The same token elements, restyled" html={sample.html} />
      <p>
        Change the theme or enable the CSS override. The highlighted token elements stay in place.
      </p>
    </section>
  );
}
