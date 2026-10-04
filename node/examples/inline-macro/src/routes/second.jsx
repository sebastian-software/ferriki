import { code } from "@ferriki/core/macro";
// eslint-disable-next-line no-unused-vars, unused-imports/no-unused-imports -- Vite consumes this JSX marker import at build time.
import { Code } from "@ferriki/core/react/macro";
import React from "react";
import { CodeBlock } from "../CodeBlock.jsx";

export const block = code("const route = 'second';\nconsole.log(route);", {
  language: "ts",
  meta: 'title="Second route" [navigation] {2}',
  lineNumbers: true,
});

let renderCalls = 0;

export function getRenderCalls() {
  return renderCalls;
}

const runtimeClassName = "second-react-macro-class";
const alternateRuntimeClassName = "second-react-macro-class-alternate";
const runtimeTitle = "Second React macro";

function StatefulMacroBlock({ code, className, title }) {
  const [count, setCount] = React.useState(0);
  return React.createElement(
    "section",
    {
      className,
      "data-code-route": "second-react-macro",
      "data-render-class": className,
      "data-render-title": title,
      "data-copy-text": code.code,
      "data-language": code.language,
    },
    React.createElement(
      "header",
      null,
      React.createElement("h2", null, title),
      React.createElement(
        "button",
        {
          type: "button",
          "data-copy-code": "",
          onClick: () => navigator.clipboard.writeText(code.code),
        },
        "Copy code",
      ),
      React.createElement(
        "button",
        { type: "button", "data-render-counter": "", onClick: () => setCount(count + 1) },
        String(count),
      ),
    ),
    React.createElement("div", {
      className: "rendered-code",
      dangerouslySetInnerHTML: { __html: code.html },
    }),
  );
}

function renderSecondMacro({ code, className }) {
  renderCalls += 1;
  return React.createElement(StatefulMacroBlock, { code, className, title: runtimeTitle });
}

export default function SecondRoute() {
  const [alternateClass, setAlternateClass] = React.useState(false);
  const macroClassName = alternateClass ? alternateRuntimeClassName : runtimeClassName;
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(CodeBlock, { block, route: "second" }),
    React.createElement(
      "button",
      {
        type: "button",
        "data-render-class-toggle": "",
        onClick: () => setAlternateClass((value) => !value),
      },
      "Toggle renderer class",
    ),
    <Code
      language="ts"
      source={`const macroRoute = 'second';\nconsole.log(macroRoute);`}
      meta='title="Second React macro" [custom] {2}'
      lineNumbers
      className={macroClassName}
      render={renderSecondMacro}
    />,
  );
}
