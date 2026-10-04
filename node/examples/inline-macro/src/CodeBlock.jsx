import React from "react";

export function CodeBlock({ block, route }) {
  return React.createElement(
    "section",
    {
      className: "code-example",
      "data-code-route": route,
      "data-copy-text": block.code,
      "data-language": block.language,
    },
    React.createElement(
      "header",
      null,
      React.createElement("h2", null, block.metadata.title ?? route),
      React.createElement(
        "button",
        {
          type: "button",
          "data-copy-code": "",
          onClick: () => navigator.clipboard.writeText(block.code),
        },
        "Copy code",
      ),
    ),
    React.createElement("div", {
      className: "rendered-code",
      dangerouslySetInnerHTML: { __html: block.html },
    }),
  );
}
