import { MonoSteps } from "ferramenta-family/monografie";

const flows = [
  {
    title: "Call the API",
    steps: [
      { label: "Source code", detail: "A string, file or generated content" },
      { label: "codeToHtml()", detail: "Run Ferriki in your build script or server" },
      { label: "Highlighted HTML", detail: "Write a static page or send a server response" },
      { label: "Browser", detail: "Display the prepared markup" },
    ],
  },
  {
    title: "Prepare examples with Vite",
    steps: [
      { label: "code() or <Code />", detail: "A literal example in your module" },
      { label: "Vite build", detail: "@ferriki/vite highlights the example" },
      {
        label: "HTML and CSS in the bundle",
        detail: "code(): prepared data · <Code />: shadow code element",
      },
      { label: "Browser", detail: "Render without running a highlighter" },
    ],
  },
];

export function HighlightingFlows() {
  return flows.map((flow) => (
    <MonoSteps
      key={flow.title}
      caption={flow.title}
      items={flow.steps.map((step) => ({ heading: step.label, text: step.detail }))}
    />
  ));
}
