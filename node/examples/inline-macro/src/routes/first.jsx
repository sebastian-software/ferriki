import { code } from "@ferriki/core/macro";
import React from "react";
import { CodeBlock } from "../CodeBlock.jsx";

export const block = code("const route = 'first';\nconsole.log(route);", {
  language: "ts",
  meta: 'title="First route" [SSR] {2}',
  lineNumbers: true,
});

export default function FirstRoute() {
  return React.createElement(CodeBlock, { block, route: "first" });
}
