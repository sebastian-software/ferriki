import React from "react";
import { hydrateRoot } from "react-dom/client";
import { App } from "./app.jsx";
import "./style.css";

hydrateRoot(document.getElementById("root"), React.createElement(App, { initialRoute: "first" }));

if (import.meta.hot) import.meta.hot.accept();
