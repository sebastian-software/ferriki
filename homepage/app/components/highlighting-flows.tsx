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
        detail: "code(): prepared data · <Code />: React markup",
      },
      { label: "Browser", detail: "Render without running a highlighter" },
    ],
  },
];

export function HighlightingFlows() {
  return (
    <div className="ferriki-flows">
      {flows.map((flow) => (
        <figure className="ferriki-flow" key={flow.title}>
          <figcaption>{flow.title}</figcaption>
          <ol>
            {flow.steps.map((step) => (
              <li key={step.label}>
                <strong>{step.label}</strong>
                <span>{step.detail}</span>
              </li>
            ))}
          </ol>
        </figure>
      ))}
    </div>
  );
}
