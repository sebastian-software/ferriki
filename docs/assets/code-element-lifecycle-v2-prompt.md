# Introductory code element illustration prompt

Generated with the built-in ImageGen tool. This version introduces one code
block's journey and the boundary between React and the Web Component. The
editable Mermaid diagrams in `../shadow-code-elements.md` cover implementation
details separately.

## Final plain source correction

The final illustration shows the entire first JSX example as plain text in one
color. Syntax highlighting begins in the second panel, after Ferriki prepares
the code. The following edit was applied after the source example edit below.

```text
Use case: precise-object-edit
Asset type: Ferriki introductory documentation infographic
Input image: edit target, the current infographic with complete JSX in its first panel.
Make one precise correction: in panel 1, 'You write code', every character of the seven-line JSX code example must be the SAME dark navy/near-black color. There must be NO syntax highlighting anywhere in that first code example. This is plain source text before Ferriki processes it. Use uniform monospaced type and uniform weight. Specifically remove the blue from <Code and />, the red from "js" and backticks, the purple from const/function/return, and the teal from 42. Set all those characters, identifiers, punctuation, braces, strings, numbers, and tags to exactly the same dark near-black color as 'answer' currently has.

Preserve this exact code, all line breaks, all indentation, all curly braces and the two literal backticks:
<Code
  language="js"
  source={`const answer = 42;
function add(a, b) {
  return a + b;
}`}
/>

Change ONLY the color (and if necessary weight to make it uniform) of the code glyphs inside the FIRST React component code card. Keep its blue heading 'React component' blue. Do not change any card background, label, caption, number, arrow, size, position or layout.
Critical invariant: Keep the existing syntax highlighting in panel 2, panel 3, panel 4 and the lower browser illustration EXACTLY as it is. The visible contrast must be first panel = plain single-color source; all later panels = highlighted output. Do not recolor those later examples. Do not remove the complete source example, abbreviate it, omit braces/backticks, or introduce ellipses. Preserve all other pixels and text as closely as possible. No other edits. No watermark.
```

## Source example edit

The selected image uses the following targeted edit to show the complete JSX
call, including the string's braces and backticks. Its source matches the code
shown in every later panel.

```text
Use case: precise-object-edit
Asset type: introductory documentation infographic, US English
Input image: edit target, the existing Ferriki four-step infographic.
Primary request: Replace only the abbreviated JSX in the FIRST panel ('You write code') with a real, complete JSX macro call. The reader must see exactly how the example code is passed as a string through the source property, including curly braces and backticks.

Render this exact seven-line code verbatim in the React component card:
<Code
  language="js"
  source={`const answer = 42;
function add(a, b) {
  return a + b;
}`}
/>

CRITICAL punctuation: On line 3, source= is followed by an opening curly brace { and then an actual backtick ` immediately before const. On line 6 the function's closing curly brace } is followed by an actual backtick ` and then the JSX expression's closing curly brace }. The final line is />. Do not use quotes around the full source string. No ellipses. No Markdown fence around the displayed code. Do not add a capitalized Source prop, children, or JSX interpolation inside the string.

Use a readable, crisp monospaced font and subtle code coloring. Make the code fit naturally in that first card; a small adjustment to its internal padding or code font size is allowed. The complete first example must be comfortably legible, with every brace and backtick visible.
The source body is EXACTLY the same four-line code already shown in panels 2, 3, 4 and the final browser picture. Preserve those code examples unchanged.

Invariants: Keep all other panel headings, captions, labels, arrows, callouts, colors, layout, and the final browser ownership illustration unchanged. Preserve the image's landscape 1536 by 1024 proportions. Do not add extra explanations or implementation jargon. Modify only the contents and if necessary padding of the first React component card. No watermark.
```

## Original generation prompt

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
