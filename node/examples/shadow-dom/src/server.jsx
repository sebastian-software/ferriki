import React from "react";
import { renderToString } from "react-dom/server";
import { App } from "./app.jsx";

export function render() {
  return renderToString(React.createElement(React.StrictMode, null, React.createElement(App)));
}
