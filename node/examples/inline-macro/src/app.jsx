import React, { useEffect, useState } from "react";
import FirstRoute from "./routes/first.jsx";

let secondRoute;

if (import.meta.hot) {
  import.meta.hot.accept("./routes/second.jsx", (updated) => {
    if (updated) {
      secondRoute = updated.default;
      window.dispatchEvent(new CustomEvent("ferriki:inline-macro-hmr", { detail: secondRoute }));
    }
  });
}

export function App({ initialRoute = "first" }) {
  const [route, setRoute] = useState(initialRoute);
  const [RouteComponent, setRouteComponent] = useState(() => FirstRoute);

  useEffect(() => {
    window.__ferrikiHydrated = true;
    const refresh = (event) => {
      secondRoute = event.detail;
      setRouteComponent(() => secondRoute);
    };
    const onPopState = () => {
      void loadRoute(window.location.pathname === "/second" ? "second" : "first", false);
    };
    window.addEventListener("ferriki:inline-macro-hmr", refresh);
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("ferriki:inline-macro-hmr", refresh);
      window.removeEventListener("popstate", onPopState);
    };
  }, []);

  async function loadRoute(nextRoute, push = true) {
    const nextComponent =
      nextRoute === "first"
        ? FirstRoute
        : (secondRoute ?? (await import("./routes/second.jsx")).default);
    secondRoute ??= nextRoute === "second" ? nextComponent : undefined;
    setRoute(nextRoute);
    setRouteComponent(() => nextComponent);
    if (push) window.history.pushState({}, "", nextRoute === "second" ? "/second" : "/");
  }

  return React.createElement(
    "main",
    { "data-current-route": route },
    React.createElement(
      "nav",
      { "aria-label": "Code examples" },
      React.createElement(
        "button",
        { type: "button", onClick: () => void loadRoute("first"), "data-route": "first" },
        "First example",
      ),
      React.createElement(
        "button",
        { type: "button", onClick: () => void loadRoute("second"), "data-route": "second" },
        "Second example",
      ),
    ),
    React.createElement(RouteComponent),
  );
}
