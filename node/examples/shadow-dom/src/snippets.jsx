import { code } from "@ferriki/core/macro";

export const initialBlock = code(
  `const message = "Shadow DOM keeps real text: λ 😀";
const markers = ["</template>", "</style>", "<img src=x onerror=alert(1)>"];
const entities = "{ braces } &amp; <tag>";

export function Example() {
\treturn <pre>{message}</pre>;
}
`,
  { language: "tsx", meta: 'title="A prepared code island" [Shadow DOM] {2}', lineNumbers: true },
);

export const updatedBlock = code(
  `const message = "Updated without rebuilding the host";
const resultCount = 42;
// This block has a comment scope absent from the initial reference.
const values = [1, 2, 3];

export function Example() {
\treturn <code>{values.join(" & ")}</code>;
}
`,
  { language: "tsx", meta: 'title="Updated code island" [Shadow DOM] {2}', lineNumbers: true },
);
