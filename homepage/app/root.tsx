import type { ReactNode } from "ardo/react";

import { ArdoActiveLink as NavLink } from "ardo/runtime";
import {
  MonoArdoErrorBoundary,
  MonoArdoLayout,
  MonoArdoSite,
  type MonoDocsSection,
} from "ferramenta-family/ardo";
import touchIcon from "ferramenta-family/ferra-assets/ferriki/apple-touch-icon.png?url";
import favicon from "ferramenta-family/ferra-assets/ferriki/favicon.ico?url";

import { documentationSections as navigation } from "./navigation";
import { version } from "./version";
import "ferramenta-family/monografie.css";
import "ferramenta-family/monografie-docs.css";
import "ferramenta-family/monografie-ardo.css";

// Ferriki's own specimens, all under fk- classes; after the package so they win its ties.
import "./components/homepage-specimens.css";

export function Layout({ children }: { children: ReactNode }) {
  return (
    <MonoArdoLayout icon={favicon} appleTouchIcon={touchIcon}>
      {children}
    </MonoArdoLayout>
  );
}
export const ErrorBoundary = MonoArdoErrorBoundary;

const sections: MonoDocsSection[] = navigation.map((section) => ({
  id: section.id,
  label: section.label,
  to: section.to,
  icon: section.icon,
  pages: section.pages.map(([label, to]) => ({ label, to })),
}));

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

/** Every page on Monografie's Ardo shell; the documentation adds its menu, search and reading layout. */
export default function Root() {
  return (
    <MonoArdoSite
      product="ferriki"
      name="Ferriki"
      release={version}
      links={links}
      sections={sections}
      homeClassName="fk-site"
      docsClassName="fk-docs"
      footer={
        <>
          <a href="https://github.com/sebastian-software/ferriki">GitHub</a>
          <a href="https://www.npmjs.com/package/@ferriki/core">npm</a>
          <a href="https://crates.io/crates/ferriki">crates.io</a>
          <a href="https://ardo-docs.dev">Built with Ardo</a>
        </>
      }
    />
  );
}
