# Introductory code element illustration prompt

Generated with the built-in ImageGen tool. This version introduces one code
block's journey and the boundary between React and the Web Component. The
editable Mermaid diagrams in `../shadow-code-elements.md` cover implementation
details separately.

```text
Use case: infographic-diagram
Asset type: accessible introductory documentation illustration, US English labels
Primary request: Explain ONE code example moving from a React source file to a visible code block. This replaces an overcomplicated architecture diagram. The reader knows React but knows nothing about Shadow DOM or this implementation. Show what happens and who is responsible, with everyday words and concrete objects. Make the explanation readable at a glance.

Style: simple, polished editorial infographic. Warm white background, large dark navy text, restrained blue for React and teal for the code component. Flat 2D illustration, generous white space, strong reading order, very few labels. Landscape, approximately 3:2. Large text, no tiny annotations.

Title (verbatim): "From your code to the page"
Subtitle (verbatim): "First page load with server rendering"

Top: FOUR simple numbered panels connected by clear left-to-right arrows. Use a single small three-line code example consistently throughout, such as "const answer = 42;" plus abstract code lines. Show plain source first, colored ready-made code afterwards.
Panel 1 heading: "1. You write code"
Small visual: a React source card with "<Code source=\"...\" />".
Caption: "In your React component"
Panel 2 heading: "2. Ferriki prepares it"
Small visual: plain source becomes a document containing colored code.
Caption: "Highlighting runs during the build"
Panel 3 heading: "3. The server sends it"
Small visual: a card labeled "Code element" contains a smaller card labeled "Template", holding the SAME colored code.
Caption: "The HTML already contains the code"
Panel 4 heading: "4. The browser shows it"
Small visual: the SAME outer code card now contains an area labeled "Isolated code", with the SAME colored code. There is NO template in this panel.
Caption: "The browser opens the template"
Short sentence below these four panels: "The code is visible before JavaScript runs."

Bottom: ONE large simplified browser page illustration, not a second process diagram. Title: "Who looks after what?"
Show a blue page frame with a normal heading and small button, and within it a code element with a blue OUTER border. Inside that outer border, draw a teal isolated code region showing the SAME code. Keep the surrounding page and outer border clearly blue and the inner code area clearly teal.
ONE blue callout pointing to the page and outer code border: "React manages the page and the outer code box."
ONE teal callout pointing INSIDE the isolated code area: "The Web Component manages the code inside."
ONE simple definition below: "Shadow DOM is the boundary around the code."
Small footer: "The code stays real text: select it, copy it."

Constraints: Exactly one upper four-step flow and one final ownership picture. All required labels spelled verbatim. No low-level APIs, no registry, no IDs, no host terminology, no stylesheet files, no CSSStyleSheet, no code-ref, no hydration jargon, no extra side notes, no arrows to shared assets. Do not imply that React processes the individual code tokens. The build creates prepared HTML; the server embeds it in a template; the browser moves its contents into an isolated Shadow DOM area before JavaScript. Page CSS selectors cannot reach into that area, though this is not a security boundary. Do not add "safe", "secure", "sandbox", "all styles blocked", or claims that text is an image. Keep labels very legible and the picture substantially simpler than a system architecture diagram. No watermark.
```
