# Mermaid grammar coverage

Ferriki combines the Linguist-pinned `Alhadis/language-mermaid` grammars with
first-party TextMate injections. The upstream grammar provides rules for
flowchart, class, state, ER, requirement, mindmap, sequence, Gantt, timeline,
journey, GitGraph, pie, quadrant, Sankey, ZenUML, C4, and `info`. The C4
injection scopes common calls and their arguments. The ZenUML injection scopes
basic Markdown emphasis, inline code, and links in comments.

The local diagram injection recognizes headers and common body syntax for:

<!-- local-mermaid-diagrams:start -->

- swimlanes
- block
- xychart
- packet
- treemap
- radar
- kanban
- architecture
- ishikawa
- eventmodeling
- cynefin
- wardley
- venn
- tree-view
- railroad
- agentflow
- usecase

<!-- local-mermaid-diagrams:end -->

These rules provide syntax highlighting rather than validation, and individual
diagram features may still lack a specific scope. Each listed diagram has a
Ferrigura example checked for both a header and a body token. The check also
fails when upstream's diagram entry points change, so an update prompts review
of the list and overlapping local rules. Additional syntax needs an example and
a scope test before it is claimed as covered.
