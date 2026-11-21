# Mermaid grammar coverage

Ferriki's standard Mermaid grammar follows the pinned Linguist submodule
`Alhadis/language-mermaid`. Its entry point and 16 diagram-specific grammars
are loaded together. The grammar recognizes flowchart, class, state, ER,
requirement, mindmap, sequence, Gantt, timeline, journey, GitGraph, pie,
quadrant, Sankey, ZenUML, C4, and the `info` statement. Recognition does not
mean every syntax feature has a scope.

C4's header and shared directives, comments, and title have scopes, but its
body delegates to `source.wsd`, which the current catalog does not provide.
ZenUML's diagram syntax has scopes, but Markdown within its comments delegates
to the unavailable `source.gfm` scope. These are reported by the grammar update
pipeline as external scopes.

The pinned grammar has no diagram-specific rules for swimlanes, block, xychart,
packet, treemap, radar, kanban, architecture, ishikawa, eventmodeling, cynefin,
wardley, venn, tree-view, railroad, agentflow, or usecase. Shared syntax may
still receive scopes. Recheck this list when updating the grammar against
Ferrigura's diagram reference and the update report.
