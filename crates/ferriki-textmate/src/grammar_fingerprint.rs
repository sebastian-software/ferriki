//! Ferriki extension: the compiled-grammar identity carried by serialized
//! state stacks. vscode-textmate has no counterpart.
//!
//! A compiled grammar is determined by its root raw grammar, the raw grammars
//! it included by scope name and the ordered external injection scopes. The
//! synthetic `$self` and `$base` rules are derived from those sources, so they
//! are not hashed again.
//!
//! Each raw grammar's digest covers its canonical JSON: object keys sorted, as
//! `serde_json::Value` orders them, and every `$vscodeTextmateLocation` entry
//! removed. It is computed once per shared `RawGrammar` and reused by every
//! grammar compiled from the same registry. The fingerprint itself is computed
//! on first use, so compiling a grammar never hashes its sources.

use std::collections::BTreeMap;
use std::fmt;
use std::io;
use std::sync::{Arc, OnceLock};

use serde::Serialize;
use serde::ser::{SerializeMap, Serializer};
use sha2::{Digest, Sha256};

use crate::raw_grammar::{RawGrammar, RawRule};

const LOCATION_KEY: &str = "$vscodeTextmateLocation";

/// serde_json writes many small fragments; batching them keeps the per-call
/// overhead of the digest out of the hot path.
const BUFFER_BYTES: usize = 64 * 1024;

type Sha256Digest = [u8; 32];

/// Memoized digest of a raw grammar's source.
///
/// It is not part of the grammar's value: clones start empty because the
/// crate edits cloned grammars (see `initialize_grammar`), and equality
/// ignores it.
#[derive(Default)]
pub(crate) struct SourceDigest(OnceLock<Sha256Digest>);

impl Clone for SourceDigest {
    fn clone(&self) -> Self {
        Self::default()
    }
}

impl PartialEq for SourceDigest {
    fn eq(&self, _other: &Self) -> bool {
        true
    }
}

impl fmt::Debug for SourceDigest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SourceDigest")
    }
}

/// The identity of one compiled grammar, computed on first use.
pub(crate) struct GrammarFingerprint {
    root_grammar: Arc<RawGrammar>,
    included_grammars: BTreeMap<String, Arc<RawGrammar>>,
    external_injection_scopes: Vec<String>,
    value: OnceLock<String>,
}

impl GrammarFingerprint {
    pub(crate) fn new(
        root_grammar: Arc<RawGrammar>,
        included_grammars: BTreeMap<String, Arc<RawGrammar>>,
        external_injection_scopes: Vec<String>,
    ) -> Self {
        Self {
            root_grammar,
            included_grammars,
            external_injection_scopes,
            value: OnceLock::new(),
        }
    }

    pub(crate) fn get(&self) -> &str {
        self.value.get_or_init(|| {
            let included_grammars = self
                .included_grammars
                .iter()
                .map(|(scope_name, grammar)| (scope_name.clone(), source_digest(grammar)))
                .collect();
            grammar_fingerprint(
                source_digest(&self.root_grammar),
                &included_grammars,
                &self.external_injection_scopes,
            )
        })
    }
}

/// Returns the digest of `grammar`'s canonical source, computing it once.
fn source_digest(grammar: &RawGrammar) -> Sha256Digest {
    *grammar.source_digest.0.get_or_init(|| {
        let mut writer = io::BufWriter::with_capacity(BUFFER_BYTES, DigestWriter(Sha256::new()));
        serde_json::to_writer(&mut writer, &Canonical(grammar))
            .expect("raw grammar source is serializable");
        let Ok(writer) = writer.into_inner() else {
            unreachable!("the digest writer cannot fail")
        };
        writer.0.finalize().into()
    })
}

fn grammar_fingerprint(
    root_grammar: Sha256Digest,
    included_grammars: &BTreeMap<String, Sha256Digest>,
    external_injection_scopes: &[String],
) -> String {
    let included_grammars = included_grammars
        .iter()
        .map(|(scope_name, digest)| (scope_name, hex(digest)))
        .collect::<BTreeMap<_, _>>();
    let identity = serde_json::to_vec(&(
        hex(&root_grammar),
        included_grammars,
        external_injection_scopes,
    ))
    .expect("compiled grammar identity is serializable");
    hex(&Sha256::digest(identity).into())
}

fn hex(digest: &Sha256Digest) -> String {
    use std::fmt::Write;

    digest
        .iter()
        .fold(String::with_capacity(64), |mut text, byte| {
            let _ = write!(text, "{byte:02x}");
            text
        })
}

struct DigestWriter(Sha256);

impl io::Write for DigestWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Serializes a raw grammar value with sorted keys and without locations.
struct Canonical<'a, T: ?Sized>(&'a T);

impl Serialize for Canonical<'_, RawGrammar> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let grammar = self.0;
        // Keys in byte order; `skip_serializing_if` mirrors `RawGrammar`.
        let mut map = serializer.serialize_map(None)?;
        if !grammar.file_types.is_empty() {
            map.serialize_entry("fileTypes", &grammar.file_types)?;
        }
        if let Some(first_line_match) = &grammar.first_line_match {
            map.serialize_entry("firstLineMatch", first_line_match)?;
        }
        if let Some(injection_selector) = &grammar.injection_selector {
            map.serialize_entry("injectionSelector", injection_selector)?;
        }
        if !grammar.injections.is_empty() {
            map.serialize_entry("injections", &Canonical(&grammar.injections))?;
        }
        if let Some(name) = &grammar.name {
            map.serialize_entry("name", name)?;
        }
        map.serialize_entry("patterns", &Canonical(grammar.patterns.as_slice()))?;
        map.serialize_entry("repository", &Canonical(&grammar.repository))?;
        map.serialize_entry("scopeName", &grammar.scope_name)?;
        map.end()
    }
}

impl Serialize for Canonical<'_, RawRule> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let rule = self.0;
        // Keys in byte order; `skip_serializing_if` mirrors `RawRule`.
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("applyEndPatternLast", &rule.apply_end_pattern_last)?;
        if let Some(begin) = &rule.begin {
            map.serialize_entry("begin", begin)?;
        }
        if let Some(begin_captures) = &rule.begin_captures {
            map.serialize_entry("beginCaptures", &Canonical(begin_captures))?;
        }
        if let Some(captures) = &rule.captures {
            map.serialize_entry("captures", &Canonical(captures))?;
        }
        if let Some(content_name) = &rule.content_name {
            map.serialize_entry("contentName", content_name)?;
        }
        if let Some(end) = &rule.end {
            map.serialize_entry("end", end)?;
        }
        if let Some(end_captures) = &rule.end_captures {
            map.serialize_entry("endCaptures", &Canonical(end_captures))?;
        }
        if let Some(include) = &rule.include {
            map.serialize_entry("include", include)?;
        }
        if let Some(match_pattern) = &rule.match_pattern {
            map.serialize_entry("match", match_pattern)?;
        }
        if let Some(name) = &rule.name {
            map.serialize_entry("name", name)?;
        }
        if let Some(patterns) = &rule.patterns {
            map.serialize_entry("patterns", &Canonical(patterns.as_slice()))?;
        }
        if let Some(repository) = &rule.repository {
            map.serialize_entry("repository", &Canonical(repository))?;
        }
        if let Some(while_pattern) = &rule.while_pattern {
            map.serialize_entry("while", while_pattern)?;
        }
        if let Some(while_captures) = &rule.while_captures {
            map.serialize_entry("whileCaptures", &Canonical(while_captures))?;
        }
        map.end()
    }
}

impl<T> Serialize for Canonical<'_, [Arc<T>]>
where
    for<'a> Canonical<'a, T>: Serialize,
{
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_seq(self.0.iter().map(|value| Canonical(value.as_ref())))
    }
}

impl<T> Serialize for Canonical<'_, BTreeMap<String, Arc<T>>>
where
    for<'a> Canonical<'a, T>: Serialize,
{
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        // Location metadata can also appear as a map entry (a parsed
        // `$vscodeTextmateLocation` object inside a repository or captures).
        serializer.collect_map(
            self.0
                .iter()
                .filter(|(key, _)| key.as_str() != LOCATION_KEY)
                .map(|(key, value)| (key, Canonical(value.as_ref()))),
        )
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::{Canonical, grammar_fingerprint, source_digest};
    use crate::RawGrammar;

    fn grammar(source: &str) -> RawGrammar {
        serde_json::from_str(source).expect("test grammar should deserialize")
    }

    fn stripped_value_json(grammar: &RawGrammar) -> Vec<u8> {
        fn strip_source_locations(value: &mut serde_json::Value) {
            match value {
                serde_json::Value::Array(values) => {
                    values.iter_mut().for_each(strip_source_locations);
                }
                serde_json::Value::Object(values) => {
                    values.remove("$vscodeTextmateLocation");
                    values.values_mut().for_each(strip_source_locations);
                }
                _ => {}
            }
        }
        let mut value = serde_json::to_value(grammar).unwrap();
        strip_source_locations(&mut value);
        serde_json::to_vec(&value).unwrap()
    }

    const LOCATED: &str = r##"{
        "scopeName": "source.test",
        "name": "Test \"quoted\"  ",
        "fileTypes": ["test", "tst"],
        "firstLineMatch": "^#!",
        "injectionSelector": "L:source.other",
        "$vscodeTextmateLocation": { "filename": "a.json", "line": 1, "char": 0 },
        "injections": {
            "L:string": { "match": "\\\\x", "name": "escape.test" }
        },
        "patterns": [
            { "include": "#block" },
            {
                "match": "(a)(b)",
                "captures": [
                    { "name": "first" },
                    null,
                    { "name": "third", "patterns": [{ "match": "b" }] }
                ],
                "$vscodeTextmateLocation": { "filename": "a.json", "line": 3, "char": 4 }
            }
        ],
        "repository": {
            "$vscodeTextmateLocation": { "filename": "a.json", "line": 9, "char": 2 },
            "block": {
                "begin": "\\{", "end": "\\}", "contentName": "meta.block",
                "beginCaptures": { "0": { "name": "punctuation.begin" } },
                "endCaptures": {
                    "0": { "name": "punctuation.end" },
                    "$vscodeTextmateLocation": { "filename": "a.json", "line": 11, "char": 6 }
                },
                "applyEndPatternLast": 1,
                "repository": { "inner": [{ "match": "x" }, { "include": "$self" }] },
                "patterns": [{ "include": "#inner" }]
            },
            "heredoc": {
                "begin": "<<", "while": "^\\s", "whileCaptures": { "0": { "name": "w" } },
                "patterns": []
            }
        }
    }"##;

    #[test]
    fn canonical_source_matches_the_sorted_location_free_value() {
        let located = grammar(LOCATED);

        assert_eq!(
            serde_json::to_vec(&Canonical(&located)).unwrap(),
            stripped_value_json(&located)
        );
    }

    #[test]
    fn source_digest_ignores_locations_and_is_not_cloned() {
        let located = grammar(LOCATED);
        let relocated = grammar(&LOCATED.replace("a.json", "/elsewhere/b.json"));
        let digest = source_digest(&located);

        assert_eq!(digest, source_digest(&relocated));
        assert!(located.source_digest.0.get().is_some());
        let mut edited = located.clone();
        assert!(edited.source_digest.0.get().is_none());
        edited.name = Some("Edited".into());
        assert_ne!(source_digest(&edited), digest);
        assert_eq!(edited.clone(), edited);
    }

    #[test]
    fn fingerprint_distinguishes_every_source() {
        let root = source_digest(&grammar(LOCATED));
        let other = source_digest(&grammar(
            r#"{ "scopeName": "source.other", "patterns": [{ "match": "é" }] }"#,
        ));
        let changed = source_digest(&grammar(
            r#"{ "scopeName": "source.other", "patterns": [{ "match": "e" }] }"#,
        ));
        let included = BTreeMap::from([("source.other".to_owned(), other)]);
        let fingerprint = grammar_fingerprint(root, &included, &[]);

        assert_eq!(fingerprint.len(), 64);
        assert_eq!(fingerprint, grammar_fingerprint(root, &included, &[]));
        assert_ne!(
            fingerprint,
            grammar_fingerprint(root, &BTreeMap::new(), &[])
        );
        assert_ne!(
            fingerprint,
            grammar_fingerprint(
                root,
                &BTreeMap::from([("source.other".to_owned(), changed)]),
                &[]
            )
        );
        assert_ne!(
            fingerprint,
            grammar_fingerprint(
                other,
                &BTreeMap::from([("source.other".to_owned(), root)]),
                &[]
            )
        );
        assert_ne!(
            fingerprint,
            grammar_fingerprint(root, &included, &["source.other".to_owned()])
        );
    }
}
