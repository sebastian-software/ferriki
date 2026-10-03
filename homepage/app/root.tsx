import type { LinksFunction, MetaFunction } from "react-router";

import {
  ArdoErrorBoundary,
  ArdoRoot,
  ArdoRootLayout,
  ArdoSearch,
  ArdoSidebar,
  ArdoSidebarLink,
  ArdoSidebarSection,
  ArdoThemeToggle,
} from "ardo/ui";
import { MarkDefs, SiteFooter, SiteHeader, SiteMenu } from "ferramenta-family";
import barlowCondensedFont from "ferramenta-family/fonts/barlow-condensed-700.woff2?url";
import { NavLink, useLocation } from "react-router";
import config from "virtual:ardo/config";

import { documentationSections } from "./navigation";
import { version } from "./version";
import "ardo/ui/styles.css";
import "ferramenta-family/tokens.css";
import "ferramenta-family/fonts.css";
import "ferramenta-family/theme.css";
import "ferramenta-family/docs.css";
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
    href: barlowCondensedFont,
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
 * overrides it. Ardo provides the sidebar rail and link primitives; the page
 * list comes from Ferriki's shared documentationSections.
 */
// oxlint-disable-next-line react/only-export-components -- Ardo reads this route handle.
export const handle = { chrome: false };

/** The site's own navigation, in the header's `nav` slot. */
function DocsNav() {
  const { pathname } = useLocation();
  return (
    <nav className="site-links" aria-label="Documentation">
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

function DocsActions() {
  const { pathname } = useLocation();
  const current = documentationSections.find((section) => pathname.startsWith(`/${section.id}/`));
  return (
    <>
      <div className="site-search">
        <ArdoSearch />
      </div>
      <SiteMenu label="Docs">
        <nav aria-label="Documentation menu">
          <NavLink to="/">Ferriki home</NavLink>
          {documentationSections.flatMap((section) =>
            section.pages.map(([label, to]) => (
              <NavLink
                key={to}
                to={to}
                data-active={current?.id === section.id && pathname.replace(/\/$/, "") === to}
              >
                {label}
              </NavLink>
            )),
          )}
        </nav>
      </SiteMenu>
    </>
  );
}

/** The small print under the family columns. */
function FooterLegal() {
  return (
    <>
      {`Ferriki v${version}`} · Released under the MIT or Apache-2.0 License ·{" "}
      <a href="https://ardo-docs.dev">Built with Ardo</a>
    </>
  );
}

export default function Root() {
  const { pathname } = useLocation();
  return (
    <>
      <MarkDefs />
      <SiteHeader
        current="ferriki"
        lockup="project"
        nav={<DocsNav />}
        actions={<DocsActions />}
        themeToggle={pathname === "/" ? undefined : <ArdoThemeToggle />}
      />

      <div className="fam-docs-shell">
        <ArdoRoot config={config}>
          <ArdoSidebar>
            {documentationSections.map((section) => (
              <ArdoSidebarSection
                key={section.id}
                id={section.id}
                label={section.label}
                to={section.to}
              >
                {section.pages.map(([label, to]) => (
                  <ArdoSidebarLink key={to} to={to}>
                    {label}
                  </ArdoSidebarLink>
                ))}
              </ArdoSidebarSection>
            ))}
          </ArdoSidebar>
        </ArdoRoot>
      </div>

      <SiteFooter current="ferriki" legal={<FooterLegal />} />
    </>
  );
}
