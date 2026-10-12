# Code element lifecycle illustration prompt

Generated with the built-in ImageGen tool. The editable Mermaid diagrams in
`../shadow-code-elements.md` remain the reference for the implementation.

```text
Use case: infographic-diagram
Asset type: repository architecture documentation, US English labels
Primary request: Create a polished, technically accurate landscape architecture infographic explaining Ferriki's React Code macro and its Declarative Shadow DOM lifecycle. The reader should understand what is generated when, what the browser consumes, and what React owns at the end.

Style: crisp contemporary technical editorial infographic on a warm near-white background, dark navy typography, restrained teal and blue accents, elegant rounded cards, generous whitespace, thin directional arrows, small consistent code/document/browser icons. Flat 2D, readable sans-serif labels and monospaced code labels. No ornamental gradients, no photographic elements. Wide landscape layout with a clear left-to-right upper flow and a final ownership diagram below.

Text and structure (verbatim):
Title: "From Code macro to isolated code"
Subtitle: "Build once · render on the server · reuse in the browser"

Upper flow: four numbered cards connected left to right.
Card 1: "1  BUILD"
Main: "Code macro → prepared module"
Detail: "HTML + reference + CSS + line count"

Card 2: "2  SERVER"
Main: "SSR branch"
Diagram: an outer "ferriki-code" box containing a "template" box.
Detail: "Shared CSS link + highlighted HTML"

Card 3: "3  BROWSER"
Main: "HTML parser creates the Shadow Root"
Detail: "The template is consumed"
Secondary: "Code is visible before JavaScript"

Card 4: "4  HYDRATION"
Main: "React manages the host"
Detail: "Web Component keeps the code nodes"

Lower section heading: "What remains in the browser"
Draw two adjacent host trees, each with a small blue top boundary labeled "React: ferriki-code host". Inside each host, draw a teal isolated box labeled "Shadow Root", containing a small attractive syntax-highlighted real-text code snippet and the text "Real text + syntax spans". Do not put any template box in these final trees.
Below both trees draw one single shared horizontal asset card labeled "One constructed stylesheet per document", connected by a small line to each Shadow Root. Distinguish this browser constructed stylesheet from the shared server CSS file.
A compact side note with a file icon says "SSR: one shared CSS file" and "Each template links to it".
A final compact note says "Client navigation: reference → registry → Shadow DOM".

Technical constraints: React owns only the custom-element host during client rendering/hydration; the Web Component owns the Shadow Root and syntax nodes. SSR emits a declarative template directly, with a stylesheet link; the HTML parser consumes that template and moves its content into the Shadow Root before JavaScript. The final DOM contains no template and no React token tree. The browser runtime adopts one shared constructed stylesheet. The shared server CSS file is linked, not duplicated as a full inline style block in every template. Never show React processing individual syntax spans. Render every required label accurately, avoid extra labels or invented metrics, keep all arrows unambiguous, no watermark.
```

The selected image received this targeted edit:

```text
Edit only the small stylesheet code example in the lower right of this Ferriki architecture infographic. Change the link href from "/ferriki-code.css" to "/assets/ferriki-code-[hash].css", showing that Vite emits a hashed production asset. Keep the text "<link rel=\"stylesheet\"" and a matching closing ">" as a simple example. Resize the monospaced type in that small code card if needed so the longer filename fits cleanly. Preserve every other label, arrow, icon, shape, color, layout, and all four numbered steps exactly. No other changes.
```
