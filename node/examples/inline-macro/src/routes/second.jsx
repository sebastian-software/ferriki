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

function CustomCodeBlock({ code }) {
  return React.createElement(CodeBlock, { block: code, route: "second-react-macro" });
}

export default function SecondRoute() {
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(CodeBlock, { block, route: "second" }),
    <Code
      language="ts"
      source={`const macroRoute = 'second';\nconsole.log(macroRoute);`}
      meta='title="Second React macro" [custom] {2}'
      lineNumbers
      component={CustomCodeBlock}
    />,
  );
}
