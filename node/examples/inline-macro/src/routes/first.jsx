import { code } from "@ferriki/core/macro";
// eslint-disable-next-line no-unused-vars, unused-imports/no-unused-imports -- Vite consumes this JSX marker import at build time.
import { Code } from "@ferriki/core/react/macro";
import React from "react";
import { CodeBlock } from "../CodeBlock.jsx";

export const block = code("const route = 'first';\nconsole.log(route);", {
  language: "ts",
  meta: 'title="First route" [SSR] {2}',
  lineNumbers: true,
});

export default function FirstRoute() {
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(CodeBlock, { block, route: "first" }),
    <Code
      language="ts"
      source={`const macroRoute = 'first';\nconsole.log(macroRoute);`}
      meta='title="First React macro" [default] {2}'
      lineNumbers
    />,
  );
}
