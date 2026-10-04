import { ferrikiCode } from "@ferriki/core/macro";
import React from "react";
import { CodeBlock } from "../CodeBlock.jsx";

export const block = ferrikiCode("const route = 'second';\nconsole.log(route);", {
  language: "ts",
  meta: 'title="Second route" [navigation] {2}',
  lineNumbers: true,
});

export default function SecondRoute() {
  return React.createElement(CodeBlock, { block, route: "second" });
}
