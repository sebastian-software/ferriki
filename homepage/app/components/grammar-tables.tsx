import { grammarCatalog as catalog, type Grammar } from "../data/grammar-catalog";
import { type GrammarGroup, labels, standardGroups, supportGroups } from "../data/grammar-groups";
import { FocusableTable } from "../focusable-table";

function groupGrammars(role: Grammar["role"], groups: GrammarGroup[]) {
  const entries = catalog.filter((entry) => entry.role === role);
  const assigned = new Set(groups.flatMap((group) => group.languages));
  // A new catalog entry remains visible until its editorial grouping is refined.
  const allGroups = [
    ...groups,
    {
      id: `other-${role}`,
      title: role === "standard" ? "Other standard grammars" : "Other support grammars",
      description: "Additional grammars included in the current catalog.",
      languages: entries.filter((entry) => !assigned.has(entry.id)).map((entry) => entry.id),
    },
  ];
  return allGroups
    .map((group) => ({
      ...group,
      entries: entries
        .filter((entry) => group.languages.includes(entry.id))
        .sort((a, b) =>
          (labels[a.id] ?? a.name ?? a.id).localeCompare(labels[b.id] ?? b.name ?? b.id, "en"),
        ),
    }))
    .filter((group) => group.entries.length > 0);
}

function GrammarRow({ entry }: { entry: Grammar }) {
  return (
    <tr data-grammar-id={entry.id} data-grammar-role={entry.role}>
      <th scope="row">{labels[entry.id] ?? entry.name ?? entry.id}</th>
      <td>
        <code translate="no">{entry.id}</code>
        {entry.aliases.length > 0 && (
          <div className="ferriki-grammar-aliases">
            Aliases:{" "}
            {entry.aliases.map((alias, index) => (
              <span key={alias}>
                {index > 0 && ", "}
                <code translate="no">{alias}</code>
              </span>
            ))}
          </div>
        )}
      </td>
    </tr>
  );
}

function GrammarSection({ group }: { group: { entries: Grammar[] } & GrammarGroup }) {
  return (
    <section aria-labelledby={`grammar-${group.id}`}>
      <h3 id={`grammar-${group.id}`}>{group.title}</h3>
      <p>{group.description}</p>
      <FocusableTable className="ferriki-grammar-table">
        <caption>
          {group.entries.length} included grammars · {group.title}
        </caption>
        <thead>
          <tr>
            <th scope="col">Grammar</th>
            <th scope="col">Language ID and aliases</th>
          </tr>
        </thead>
        <tbody>
          {group.entries.map((entry) => (
            <GrammarRow key={entry.id} entry={entry} />
          ))}
        </tbody>
      </FocusableTable>
    </section>
  );
}

function GrammarTables({
  grammarRole,
  groups,
}: {
  grammarRole: Grammar["role"];
  groups: GrammarGroup[];
}) {
  const sections = groupGrammars(grammarRole, groups);
  return (
    <div className="ferriki-grammar-coverage">
      <ul className="ferriki-grammar-index" aria-label="Grammar groups">
        {sections.map((group) => (
          <li key={group.id}>
            <a href={`#grammar-${group.id}`}>
              {group.title} ({group.entries.length})
            </a>
          </li>
        ))}
      </ul>
      {sections.map((group) => (
        <GrammarSection key={group.id} group={group} />
      ))}
    </div>
  );
}

export function GrammarCoverageSummary() {
  return (
    <p>
      The standard catalog contains{" "}
      <strong>
        {catalog.filter((entry) => entry.role === "standard").length} standard grammars
      </strong>{" "}
      and{" "}
      <strong>
        {catalog.filter((entry) => entry.role === "dependency").length} support grammars
      </strong>
      , {catalog.length} entries in all. Support grammars handle embedded syntax and injections;
      they are listed separately below.
    </p>
  );
}

export function StandardGrammarTables() {
  return <GrammarTables grammarRole="standard" groups={standardGroups} />;
}

export function SupportGrammarTables() {
  return <GrammarTables grammarRole="dependency" groups={supportGroups} />;
}
