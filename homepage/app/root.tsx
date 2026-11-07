import { type ReactNode, useState } from "ardo/react";
import { ArdoActiveLink as NavLink, useArdoPageData, useArdoPath } from "ardo/runtime";
import {
  ArdoErrorBoundary,
  ArdoHeaderSearch,
  ArdoMobileNavigation,
  ArdoRoot,
  ArdoRootLayout,
  ArdoTOC,
} from "ardo/ui";
import { Mark, MarkDefs } from "ferramenta-family";
import touchIcon from "ferramenta-family/ferra-assets/ferriki/apple-touch-icon.png?url";
import favicon from "ferramenta-family/ferra-assets/ferriki/favicon.ico?url";
import {
  MonoFooter,
  MonoGuideNavigation,
  MonoHeader,
  MonoPage,
  MonoReadingLayout,
  MonoReadingTable,
  MonoSectionRail,
} from "ferramenta-family/monografie";

import { documentationSections as navigation } from "./navigation";
import { version } from "./version";
import "ferramenta-family/monografie.css";
import "ferramenta-family/monografie-docs.css";
import "ferramenta-family/monografie-ardo.css";

// Ferriki's own specimens, all under fk- classes; after the package so they win its ties.
import "./components/homepage-specimens.css";

export function Layout({ children }: { children: ReactNode }) {
  return (
    <ArdoRootLayout
      colorScheme="light"
      className="mono-ardo"
      icon={favicon}
      appleTouchIcon={touchIcon}
      iconBasePath={false}
    >
      {children}
    </ArdoRootLayout>
  );
}
export const ErrorBoundary = ArdoErrorBoundary;

function GuideNavigation({ onNavigate }: { onNavigate?: () => void }) {
  const path = useArdoPath();
  const current = navigation.find((section) => path.startsWith(`/${section.id}/`)) ?? navigation[0];
  return (
    <>
      <MonoSectionRail aria-label="Documentation sections">
        {navigation.map((section) => (
          <NavLink
            key={section.id}
            to={section.to}
            data-active={current.id === section.id}
            onClick={onNavigate}
          >
            <Mark name={section.icon} />
            {section.label}
          </NavLink>
        ))}
      </MonoSectionRail>
      <MonoGuideNavigation aria-label="Documentation pages">
        <NavLink to="/" onClick={onNavigate}>
          Overview
        </NavLink>
        <p>{current.label}</p>
        {current.pages.map(([title, href]) => (
          <NavLink key={href} to={href} onClick={onNavigate}>
            {title}
          </NavLink>
        ))}
      </MonoGuideNavigation>
    </>
  );
}

const links = [
  <NavLink key="guide" to="/guide/getting-started">
    Guide
  </NavLink>,
  <NavLink key="rust" to="/rust/getting-started">
    Rust
  </NavLink>,
  <a key="speed" href="/#evidence">
    Benchmarks
  </a>,
  <NavLink key="evidence" to="/evidence/compatibility">
    Compatibility
  </NavLink>,
  <a key="github" href="https://github.com/sebastian-software/ferriki">
    GitHub
  </a>,
];

/** The documentation menu and search, beside the header's own menu on documentation pages. */
function DocsActions() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ArdoMobileNavigation title="Ferriki documentation" open={open} onOpenChange={setOpen}>
        <GuideNavigation
          onNavigate={() => {
            setOpen(false);
          }}
        />
      </ArdoMobileNavigation>
      <ArdoHeaderSearch
        variant="icon"
        onActivate={() => {
          setOpen(false);
        }}
      />
    </>
  );
}

/** The Monografie header on every page; documentation adds its section menu and search. */
function Header({ docs }: { docs: boolean }) {
  return (
    <MonoHeader
      product="ferriki"
      home="/"
      release={version}
      links={links}
      actions={docs ? <DocsActions /> : undefined}
    />
  );
}

function Article({ children }: { children: ReactNode }) {
  const page = useArdoPageData();
  const path = useArdoPath();
  const current = navigation.find((section) => path.startsWith(`/${section.id}/`));
  return (
    <MonoReadingLayout
      id="ferriki-article"
      navigation={<GuideNavigation />}
      outline={<ArdoTOC source="dom" scope="#ferriki-article" />}
    >
      <header>
        <p>Ferriki / {current?.label ?? "Documentation"}</p>
        <h1>{page?.title ?? "Documentation"}</h1>
      </header>
      {children}
    </MonoReadingLayout>
  );
}
const components = { table: MonoReadingTable, wrapper: Article };

/**
 * Every page wears the Monografie header and footer and reads on the Monografie
 * page ground; documentation adds the reading layout.
 */
export default function Root() {
  const path = useArdoPath();
  const home = path === "/" || path === "";
  const shell = (
    <>
      <ArdoRoot
        className="mono-ardo-shell"
        scrollMode="document"
        header={<Header docs={!home} />}
        sidebar={false}
        footer={false}
        components={components}
      />
      <MonoFooter product="ferriki" home="/">
        <a href="https://github.com/sebastian-software/ferriki">GitHub</a>
        <a href="https://www.npmjs.com/package/@ferriki/core">npm</a>
        <a href="https://crates.io/crates/ferriki">crates.io</a>
        <a href="https://ardo-docs.dev">Built with Ardo</a>
      </MonoFooter>
    </>
  );
  if (home) return <MonoPage className="fk-site">{shell}</MonoPage>;
  return (
    <MonoPage className="mono-docs fk-docs">
      <MarkDefs />
      {shell}
    </MonoPage>
  );
}
