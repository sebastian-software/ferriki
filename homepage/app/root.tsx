import type { LinksFunction, MetaFunction } from "react-router";

import {
  ArdoErrorBoundary,
  ArdoGeneratedSidebar,
  ArdoRoot,
  ArdoRootLayout,
  ArdoSearch,
  ArdoSidebar,
  ArdoSidebarSection,
  ArdoThemeToggle,
} from "ardo/ui";
import { MarkDefs, SiteFooter, SiteHeader } from "ferramenta-family";
import bigShouldersFont from "ferramenta-family/fonts/big-shoulders.woff2?url";
import { useRef } from "react";
import { NavLink, useLocation } from "react-router";
import config from "virtual:ardo/config";

import { documentationSections } from "./navigation";
import { version } from "./version";
import "ardo/ui/styles.css";
import "ferramenta-family/tokens.css";
import "ferramenta-family/fonts.css";
import "ferramenta-family/theme.css";
import "ferramenta-family/landing.css";

import "./styles/site.css";
// Last on purpose, as the package README requires: the shared chrome has to win
// the selector ties the site stylesheet would otherwise take.
import "ferramenta-family/chrome.css";

// React Router consumes these as named route exports.
// oxlint-disable-next-line react/only-export-components -- React Router requires this route export.
export const links: LinksFunction = () => [
  {
    rel: "preload",
    href: bigShouldersFont,
    as: "font",
    type: "font/woff2",
    crossOrigin: "anonymous",
  },
];

// oxlint-disable-next-line react/only-export-components -- React Router requires this route export.
export const meta: MetaFunction = ({ location }) => {
  const path = location.pathname.replace(/\/$/, "");
  const section = documentationSections.find((candidate) => path.startsWith(`/${candidate.id}/`));
  const page = section?.pages.find(([, to]) => to === path);
  const title = page
    ? `${page[0]} · ${section?.label} · Ferriki`
    : "Ferriki — Shiki-compatible highlighting, native speed";
  return [
    { title },
    {
      name: "description",
      content:
        "Ferriki highlights code with the TextMate grammars and themes VS Code uses, behind the API you know from Shiki, on a native Rust engine for Node.js and Rust.",
    },
  ];
};

// oxlint-disable-next-line react/only-export-components -- React Router requires this route export.
export function Layout({ children }: { children: React.ReactNode }) {
  return <ArdoRootLayout iconBasePath="/">{children}</ArdoRootLayout>;
}

export const ErrorBoundary = ArdoErrorBoundary;

/*
 * The family header and footer replace Ardo's chrome, so Ardo must not render
 * either: `chrome` is read from every route match and no route below this one
 * overrides it. The sidebar rail and its generated navigation stay Ardo's.
 */
// oxlint-disable-next-line react/only-export-components -- Ardo reads this route handle.
export const handle = { chrome: false };

/** The site's own navigation, in the header's `nav` slot. */
function DocsNav() {
  const { pathname } = useLocation();
  return (
    <nav className="ferriki-nav" aria-label="Documentation">
      {documentationSections.map((section) => (
        <NavLink
          key={section.id}
          to={section.to}
          data-active={pathname.startsWith(`/${section.id}/`)}
        >
          {section.label}
        </NavLink>
      ))}
    </nav>
  );
}

/*
 * Search, and -- below the width where the section links give up their room
 * and Ardo hides the sidebar rail -- a menu that is then the only way into
 * the documentation.
 */
function DocsActions() {
  const menuRef = useRef<HTMLDetailsElement>(null);
  const { pathname } = useLocation();
  const current = documentationSections.find((section) => pathname.startsWith(`/${section.id}/`));
  const close = () => menuRef.current?.removeAttribute("open");
  return (
    <>
      <div className="ferriki-search">
        <ArdoSearch />
      </div>
      <details
        className="ferriki-menu"
        ref={menuRef}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            close();
            menuRef.current?.querySelector("summary")?.focus();
          }
        }}
      >
        {/* No aria-label: the visible word is the accessible name. */}
        <summary>Docs</summary>
        <nav className="ferriki-menu-flyout" aria-label="Documentation menu">
          <NavLink to="/" onClick={close}>
            Ferriki home
          </NavLink>
          {documentationSections.map((section) => (
            <div key={section.id} className="ferriki-menu-group">
              <p className="ferriki-menu-label">{section.label}</p>
              {section.pages.map(([label, to]) => (
                <NavLink
                  key={to}
                  to={to}
                  onClick={close}
                  data-active={current?.id === section.id && pathname.replace(/\/$/, "") === to}
                >
                  {label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
      </details>
    </>
  );
}

/** The small print under the family columns. */
function FooterLegal() {
  return (
    <>
      {`Ferriki v${version}`} · Released under the MIT or Apache-2.0 License · Copyright{" "}
      {new Date().getFullYear()} Sebastian Software GmbH ·{" "}
      <a href="https://ardo-docs.dev">Built with Ardo</a>
    </>
  );
}

export default function Root() {
  return (
    <>
      <MarkDefs />
      <SiteHeader
        current="ferriki"
        lockup="project"
        nav={<DocsNav />}
        actions={<DocsActions />}
        themeToggle={<ArdoThemeToggle />}
      />

      {/* `ferriki-shell` is the hook site.css needs to turn Ardo's
          fixed-viewport application shell into a document-scrolling page: the
          family footer sits below the shell, so the page -- not the article --
          has to be what scrolls. */}
      <div className="ferriki-shell">
        <ArdoRoot config={config}>
          <ArdoSidebar>
            {documentationSections.map((section) => (
              <ArdoSidebarSection
                key={section.id}
                id={section.id}
                label={section.label}
                to={section.to}
              >
                <ArdoGeneratedSidebar section={section.id} />
              </ArdoSidebarSection>
            ))}
          </ArdoSidebar>
        </ArdoRoot>
      </div>

      <SiteFooter current="ferriki" legal={<FooterLegal />} />
    </>
  );
}
