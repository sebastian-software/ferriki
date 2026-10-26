//! Build-time preparation of static TextMate patterns.

use std::borrow::Cow;
use std::collections::BTreeSet;

use crate::RawGrammar;
use crate::grammar::{Grammar, GrammarConfiguration, ThemeProvider};
use crate::raw_grammar::RawRule;
use crate::regexp::ScannerPatternCache;
use crate::regexp::{RegExpSource, normalize_ferroni_pattern};
use crate::rule_factory::{GrammarProvider, GrammarStore};
use crate::theme::Theme;
use ferroni::scanner::PrecompiledEager;
use std::sync::Arc;

/// Combined container/program/group format carried by `.fkbc` sidecars.
/// The high 8 bits identify the container; two 12-bit fields identify programs
/// and Eager groups. A change to any of the formats requires regenerated files.
pub const PRECOMPILED_PATTERNS_VERSION: u32 = (2 << 24)
    | (ferroni::scanner::PRECOMPILED_FORMAT_VERSION << 12)
    | ferroni::scanner::PRECOMPILED_EAGER_FORMAT_VERSION;
pub(crate) const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
const MAGIC: &[u8; 8] = b"FKBC002\0";

#[derive(Clone)]
pub(crate) struct PreparedArchive {
    pub(crate) scope: String,
    pub(crate) eager: PrecompiledEager,
}

/// Decompress a prepared container for a persistent, verified asset cache.
///
/// Checks transport limits and container boundaries. The caller must still
/// authenticate the bytes against trusted metadata. Programs and groups retain
/// their normal lazy validation when attached to a registry. Already decoded
/// containers are accepted as well.
pub fn decompress_precompiled_patterns(bytes: &[u8]) -> Result<Vec<u8>, PrecompiledPatternsError> {
    let decoded = decode_archive(bytes)?;
    archive_layout(&decoded)?;
    Ok(decoded.into_owned())
}

fn decode_archive(bytes: &[u8]) -> Result<Cow<'_, [u8]>, PrecompiledPatternsError> {
    if bytes.starts_with(MAGIC) {
        if bytes.len() as u64 > MAX_ARCHIVE_BYTES {
            return Err(PrecompiledPatternsError::new("excessive archive size"));
        }
        return Ok(Cow::Borrowed(bytes));
    }
    let size = zstd::zstd_safe::get_frame_content_size(bytes)
        .map_err(|_| PrecompiledPatternsError::new("invalid Zstd frame"))?
        .filter(|size| *size <= MAX_ARCHIVE_BYTES)
        .ok_or_else(|| PrecompiledPatternsError::new("missing or excessive archive size"))?;
    // One-shot Zstd decoders can ignore WindowLogMax because they can use
    // the output buffer as their window. Enforce the transport profile before
    // allocating output (RFC 8878, frame header / Window_Descriptor).
    let window = if bytes[4] & 0x20 != 0 {
        size
    } else {
        let descriptor = *bytes
            .get(5)
            .ok_or_else(|| PrecompiledPatternsError::new("missing Zstd window"))?;
        let base = 1_u64 << (10 + (descriptor >> 3));
        base + (base >> 3) * u64::from(descriptor & 7)
    };
    if window > 8 * 1024 * 1024 {
        return Err(PrecompiledPatternsError::new(
            "Zstd archive window exceeds 8 MiB",
        ));
    }
    if zstd::zstd_safe::find_frame_compressed_size(bytes).map_err(PrecompiledPatternsError::new)?
        != bytes.len()
    {
        return Err(PrecompiledPatternsError::new(
            "trailing archive frames or bytes",
        ));
    }
    let mut decoder = zstd::bulk::Decompressor::new().map_err(PrecompiledPatternsError::new)?;
    decoder
        .set_parameter(zstd::zstd_safe::DParameter::WindowLogMax(23))
        .map_err(PrecompiledPatternsError::new)?;
    let decoded = decoder
        .decompress(bytes, size as usize)
        .map_err(PrecompiledPatternsError::new)?;
    if decoded.len() as u64 != size {
        return Err(PrecompiledPatternsError::new(
            "invalid decoded archive size",
        ));
    }
    Ok(Cow::Owned(decoded))
}

pub(crate) fn archive_layout(decoded: &[u8]) -> Result<(usize, usize), PrecompiledPatternsError> {
    if decoded.len() < 32 || &decoded[..8] != MAGIC {
        return Err(PrecompiledPatternsError::new(
            "unsupported Ferriki prepared archive",
        ));
    }
    let version = u32::from_le_bytes(decoded[8..12].try_into().unwrap());
    let scope_len = u32::from_le_bytes(decoded[12..16].try_into().unwrap()) as usize;
    let program_len = u64::from_le_bytes(decoded[16..24].try_into().unwrap());
    let group_len = u64::from_le_bytes(decoded[24..32].try_into().unwrap());
    let total = 32_u64
        .checked_add(scope_len as u64)
        .and_then(|n| n.checked_add(program_len))
        .and_then(|n| n.checked_add(group_len));
    if version != PRECOMPILED_PATTERNS_VERSION || total != Some(decoded.len() as u64) {
        return Err(PrecompiledPatternsError::new(
            "unsupported archive version or invalid lengths",
        ));
    }
    let scope_end = 32 + scope_len;
    Ok((scope_end, scope_end + program_len as usize))
}

pub(crate) fn open_archive(
    bytes: impl AsRef<[u8]>,
) -> Result<PreparedArchive, PrecompiledPatternsError> {
    let decoded = decode_archive(bytes.as_ref())?;
    let (scope_end, program_end) = archive_layout(&decoded)?;
    let scope = std::str::from_utf8(&decoded[32..scope_end])
        .map_err(PrecompiledPatternsError::new)?
        .to_owned();
    let eager =
        PrecompiledEager::from_bytes(&decoded[scope_end..program_end], &decoded[program_end..])
            .map_err(PrecompiledPatternsError::from_engine)?;
    Ok(PreparedArchive { scope, eager })
}

pub(crate) fn open_owned_archive(
    bytes: Vec<u8>,
) -> Result<PreparedArchive, PrecompiledPatternsError> {
    use ferroni::scanner::PrecompiledBytes;
    let decoded = if bytes.starts_with(MAGIC) {
        bytes
    } else {
        decompress_precompiled_patterns(&bytes)?
    };
    let (scope_end, program_end) = archive_layout(&decoded)?;
    if decoded.len() as u64 > MAX_ARCHIVE_BYTES {
        return Err(PrecompiledPatternsError::new("excessive archive size"));
    }
    let scope = std::str::from_utf8(&decoded[32..scope_end])
        .map_err(PrecompiledPatternsError::new)?
        .to_owned();
    let image = PrecompiledBytes::new(decoded);
    let eager = PrecompiledEager::from_shared_bytes(
        image
            .slice(scope_end..program_end)
            .map_err(PrecompiledPatternsError::from_engine)?,
        image
            .slice(program_end..image.len())
            .map_err(PrecompiledPatternsError::from_engine)?,
    )
    .map_err(PrecompiledPatternsError::from_engine)?;
    Ok(PreparedArchive { scope, eager })
}

/// A failure to generate or open a precompiled pattern archive.
#[derive(Clone, Debug)]
pub struct PrecompiledPatternsError {
    message: String,
    source: Option<Arc<ferroni::scanner::PrecompiledError>>,
}

impl PartialEq for PrecompiledPatternsError {
    fn eq(&self, other: &Self) -> bool {
        self.message == other.message
    }
}
impl Eq for PrecompiledPatternsError {}

impl std::fmt::Display for PrecompiledPatternsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.message.fmt(f)
    }
}

impl std::error::Error for PrecompiledPatternsError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.source
            .as_deref()
            .map(|source| source as &dyn std::error::Error)
    }
}

impl PrecompiledPatternsError {
    pub(crate) fn new(error: impl std::fmt::Display) -> Self {
        Self {
            message: error.to_string(),
            source: None,
        }
    }

    pub(crate) fn from_engine(error: ferroni::scanner::PrecompiledError) -> Self {
        Self {
            message: error.to_string(),
            source: Some(Arc::new(error)),
        }
    }
}

/// Compile a grammar's static programs into a deterministic compressed archive.
///
/// Uses runtime normalization, anchor variants and both prefilter settings.
/// Prepares every statically known ordered scanner group in Eager mode.
/// Dynamic captured end/while patterns retain ordinary compilation. Use
/// [`crate::SyncRegistry::precompile_patterns`] to resolve registered includes
/// and external injections or to restrict preparation to representative samples.
pub fn precompile_grammar_patterns(
    grammar: &RawGrammar,
) -> Result<Vec<u8>, PrecompiledPatternsError> {
    let mut provider = GrammarStore::new();
    provider.insert(grammar.clone());
    prepare(grammar, &provider, &[])
}

pub(crate) fn prepare(
    grammar: &RawGrammar,
    provider: &dyn GrammarProvider,
    samples: &[&str],
) -> Result<Vec<u8>, PrecompiledPatternsError> {
    let mut patterns = BTreeSet::new();
    for rule in grammar
        .patterns
        .iter()
        .chain(grammar.repository.values())
        .chain(grammar.injections.values())
    {
        collect_rule(rule, &mut patterns);
    }
    let cache = ScannerPatternCache::for_preparation();
    for pattern in patterns {
        for prefilter in [false, true] {
            cache.compile_static(&pattern, prefilter)?;
        }
    }
    let raw = Arc::new(grammar.clone());
    {
        let prefilter = true;
        let grammar = Grammar::with_theme_provider(
            &raw,
            provider,
            ThemeProvider::new(
                Theme::create_from_raw_theme(None, None).map_err(PrecompiledPatternsError::new)?,
            ),
            GrammarConfiguration::default().with_regex_prefilter(prefilter),
            cache.clone(),
        );
        if samples.is_empty() {
            grammar
                .prepare_static_scanners()
                .map_err(PrecompiledPatternsError::new)?;
        }
        for sample in samples {
            let mut state = None;
            for line in sample.lines() {
                let result = grammar
                    .tokenize_line2(line, state.take(), 0)
                    .map_err(PrecompiledPatternsError::new)?;
                state = Some(result.rule_stack);
            }
        }
    }
    let prepared = cache.export_prepared()?;
    prepared
        .validate_groups()
        .map_err(PrecompiledPatternsError::from_engine)?;
    let scope = raw.scope_name.as_bytes();
    let mut bytes = Vec::with_capacity(
        32 + scope.len() + prepared.program_bytes().len() + prepared.group_bytes().len(),
    );
    bytes.extend_from_slice(MAGIC);
    bytes.extend_from_slice(&PRECOMPILED_PATTERNS_VERSION.to_le_bytes());
    bytes.extend_from_slice(&(scope.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&(prepared.program_bytes().len() as u64).to_le_bytes());
    bytes.extend_from_slice(&(prepared.group_bytes().len() as u64).to_le_bytes());
    bytes.extend_from_slice(scope);
    bytes.extend_from_slice(prepared.program_bytes());
    bytes.extend_from_slice(prepared.group_bytes());
    if bytes.len() as u64 > MAX_ARCHIVE_BYTES {
        return Err(PrecompiledPatternsError::new(
            "precompiled archive exceeds its size limit",
        ));
    }
    let mut encoder = zstd::bulk::Compressor::new(19).map_err(PrecompiledPatternsError::new)?;
    encoder
        .set_parameter(zstd::zstd_safe::CParameter::WindowLog(23))
        .map_err(PrecompiledPatternsError::new)?;
    encoder
        .set_parameter(zstd::zstd_safe::CParameter::ChecksumFlag(true))
        .map_err(PrecompiledPatternsError::new)?;
    encoder
        .compress(&bytes)
        .map_err(PrecompiledPatternsError::new)
}

fn collect_rule(rule: &RawRule, patterns: &mut BTreeSet<String>) {
    for pattern in rule.match_pattern.iter().chain(rule.begin.iter()) {
        collect_pattern(pattern, false, patterns);
    }
    for pattern in rule.end.iter().chain(rule.while_pattern.iter()) {
        collect_pattern(pattern, true, patterns);
    }
    for child in rule
        .patterns
        .iter()
        .flatten()
        .chain(rule.repository.iter().flat_map(|rules| rules.values()))
        .chain(rule.captures.iter().flat_map(|rules| rules.values()))
        .chain(rule.begin_captures.iter().flat_map(|rules| rules.values()))
        .chain(rule.end_captures.iter().flat_map(|rules| rules.values()))
        .chain(rule.while_captures.iter().flat_map(|rules| rules.values()))
    {
        collect_rule(child, patterns);
    }
}

fn collect_pattern(pattern: &str, dynamic: bool, patterns: &mut BTreeSet<String>) {
    let source = RegExpSource::new(pattern, ());
    if dynamic && source.has_back_references {
        return;
    }
    for allow_a in [false, true] {
        for allow_g in [false, true] {
            patterns.insert(normalize_ferroni_pattern(
                source.resolve_anchors(allow_a, allow_g),
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::regexp::scanner_config;
    use crate::{GrammarConfiguration, SyncRegistry, parse_raw_grammar};

    fn grammar() -> RawGrammar {
        parse_raw_grammar(r##"{
          "scopeName": "source.precompiled",
          "patterns": [
            {"begin": "(<<)(\\w+)", "end": "^\\2$", "name": "string.heredoc"},
            {"begin": "^>", "while": "\\G>", "name": "markup.quote"},
            {"match": "\\Afirst|\\Gnext|last\\z", "name": "keyword.anchor"},
            {"match": "(a+)\\1", "name": "constant.backref"},
            {"match": "(:)\\s*(?!(\\s*{))", "name": "punctuation.colon"},
            {"match": "(x+)+$", "name": "constant.risky"},
            {"match": "(word)", "captures": {"1": {"patterns": [{"match": "word", "name": "entity.capture"}]}}}
          ],
          "repository": {"unused": {"match": "unused", "name": "unused"}},
          "injections": {"L:source.precompiled": {"match": "TODO", "name": "comment.todo"}}
        }"##, Some("grammar.json")).unwrap()
    }

    fn sampled_archive(raw: &RawGrammar) -> Result<Vec<u8>, PrecompiledPatternsError> {
        let mut provider = GrammarStore::new();
        provider.insert(raw.clone());
        prepare(
            raw,
            &provider,
            &[
                "first next last\n<<END\nword TODO 😀\nEND\n>quote\n>continued\naaaa : word\nxxx\nalpha beta gamma",
            ],
        )
    }

    #[test]
    fn owned_decoded_archive_retains_program_and_group_sections_without_copying() {
        let compressed = precompile_grammar_patterns(&grammar()).unwrap();
        let decoded = decompress_precompiled_patterns(&compressed).unwrap();
        let (scope_end, program_end) = archive_layout(&decoded).unwrap();
        let programs = decoded[scope_end..program_end].as_ptr();
        let groups = decoded[program_end..].as_ptr();
        let source = open_owned_archive(decoded).unwrap();
        assert_eq!(source.eager.program_bytes().as_ptr(), programs);
        assert_eq!(source.eager.group_bytes().as_ptr(), groups);
        source.eager.validate_groups().unwrap();
        let compressed_source = open_owned_archive(compressed).unwrap();
        assert_eq!(
            source.eager.program_bytes(),
            compressed_source.eager.program_bytes()
        );
        assert_eq!(
            source.eager.group_bytes(),
            compressed_source.eager.group_bytes()
        );
    }

    #[test]
    fn standard_archives_prepare_static_groups() {
        let archive = open_archive(precompile_grammar_patterns(&grammar()).unwrap()).unwrap();
        assert!(!archive.eager.is_empty());
    }

    #[test]
    fn indexed_archives_load_only_requested_records_and_cover_later_contexts() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let raw = grammar();
        let decoded =
            decompress_precompiled_patterns(&precompile_grammar_patterns(&raw).unwrap()).unwrap();
        let index = crate::index_precompiled_patterns(&decoded).unwrap();
        let path = std::env::temp_dir().join(format!(
            "ferriki-indexed-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::write(&path, &decoded).unwrap();
        let mut prepared = SyncRegistry::new(None, None).unwrap();
        prepared
            .add_precompiled_patterns_file(std::fs::File::open(&path).unwrap(), &index)
            .unwrap();
        prepared.add_grammar(raw.clone(), vec![]);
        assert_eq!(prepared.regex_diagnostics().prepared_bytes_read, 0);
        let mut source = SyncRegistry::new(None, None).unwrap();
        source.add_grammar(raw.clone(), vec![]);
        let compare = |source: &mut SyncRegistry, prepared: &mut SyncRegistry, text: &str| {
            let tokenize = |registry: &mut SyncRegistry| {
                let grammar = registry
                    .grammar_for_scope_name(&raw.scope_name, GrammarConfiguration::default())
                    .unwrap()
                    .unwrap();
                let mut stack = None;
                text.lines()
                    .map(|line| {
                        let result = grammar.tokenize_line(line, stack.take(), 0).unwrap();
                        stack = Some(result.rule_stack);
                        result.tokens
                    })
                    .collect::<Vec<_>>()
            };
            assert_eq!(tokenize(source), tokenize(prepared));
        };
        compare(&mut source, &mut prepared, "first word TODO");
        let first = prepared.regex_diagnostics();
        assert!(first.prepared_bytes_read > 0);
        assert!(first.prepared_bytes_read < decoded.len() as u64);
        assert!(first.loaded_prepared_groups > 0);
        assert_eq!(first.invalid_prepared_groups, 0);
        compare(&mut source, &mut prepared, "first word TODO");
        assert_eq!(
            prepared.regex_diagnostics().prepared_bytes_read,
            first.prepared_bytes_read
        );
        compare(
            &mut source,
            &mut prepared,
            "<<END\nword TODO 😀\nEND\n>quote\n>continued\naaaa : word\nxxx\nalpha beta gamma",
        );
        let later = prepared.regex_diagnostics();
        assert!(later.loaded_prepared_groups > first.loaded_prepared_groups);
        assert_eq!(later.invalid_prepared_groups, 0);
        assert_eq!(later.assembly_fallbacks, 0);
        prepared.dispose();
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn decoded_containers_outlive_the_input_and_preserve_tokens() {
        let raw = grammar();
        let mut prepared = SyncRegistry::new(None, None).unwrap();
        {
            let compressed = precompile_grammar_patterns(&raw).unwrap();
            let decoded = decompress_precompiled_patterns(&compressed).unwrap();
            assert!(decoded.starts_with(MAGIC));
            prepared
                .add_precompiled_patterns_from_slice(&decoded)
                .unwrap();
        }
        let mut source = SyncRegistry::new(None, None).unwrap();
        for registry in [&mut source, &mut prepared] {
            registry.add_grammar(raw.clone(), vec![]);
        }
        let tokenize = |registry: &mut SyncRegistry| {
            registry
                .grammar_for_scope_name(&raw.scope_name, GrammarConfiguration::default())
                .unwrap()
                .unwrap()
                .tokenize_line("first word TODO", None, 0)
                .unwrap()
                .tokens
        };
        assert_eq!(tokenize(&mut source), tokenize(&mut prepared));
        let (loaded, invalid) = prepared.prepared_stats(&raw.scope_name);
        assert!(loaded > 0);
        assert_eq!(invalid, 0);
    }

    #[test]
    fn preparation_does_not_export_unreachable_standalone_match_scanners() {
        let raw = parse_raw_grammar(
            r#"{"scopeName":"source.flat","patterns":[{"match":"alpha"},{"match":"beta"}]}"#,
            Some("grammar.json"),
        )
        .unwrap();
        let archive = open_archive(precompile_grammar_patterns(&raw).unwrap()).unwrap();
        assert_eq!(
            archive.eager.len(),
            1,
            "only the ordered parent scanner is reachable"
        );
    }

    #[test]
    fn archive_covers_runtime_variants_and_excludes_dynamic_ends() {
        let raw = grammar();
        let bytes = sampled_archive(&raw).unwrap();
        assert_eq!(bytes, sampled_archive(&raw).unwrap());
        let archive = open_archive(bytes).unwrap();
        assert!(!archive.eager.is_empty());
        assert_eq!(archive.eager.stats().loaded_groups, 0);
        archive.eager.validate_groups().unwrap();
        let programs =
            ferroni::scanner::PrecompiledPatterns::from_bytes(archive.eager.program_bytes())
                .unwrap();
        let mut patterns = BTreeSet::new();
        collect_pattern(r"\Afirst|\Gnext|last\z", false, &mut patterns);
        patterns.extend([
            r"(a+)\1".to_owned(),
            "word".to_owned(),
            "unused".to_owned(),
            "TODO".to_owned(),
        ]);
        for prefilter in [false, true] {
            for pattern in &patterns {
                assert!(
                    programs
                        .validate_pattern(pattern, &scanner_config(prefilter), false)
                        .unwrap(),
                    "missing {pattern}"
                );
            }
            assert!(
                !programs
                    .validate_pattern(r"^\2$", &scanner_config(prefilter), false)
                    .unwrap()
            );
        }
    }

    #[test]
    fn loaded_patterns_preserve_scopes_dynamic_captures_and_warnings() {
        let raw = grammar();
        let bytes = sampled_archive(&raw).unwrap();
        for prefilter in [false, true] {
            let run = |prepared| {
                let mut registry = SyncRegistry::new(None, None).unwrap();
                if prepared {
                    registry.add_precompiled_patterns(bytes.clone()).unwrap();
                }
                registry.add_grammar(raw.clone(), vec![]);
                let grammar = registry
                    .grammar_for_scope_name(
                        &raw.scope_name,
                        GrammarConfiguration::default().with_regex_prefilter(prefilter),
                    )
                    .unwrap()
                    .unwrap();
                let mut state = None;
                let mut tokens = Vec::new();
                for line in [
                    "first next last",
                    "<<END",
                    "word TODO 😀",
                    "END",
                    ">quote",
                    ">continued",
                    "aaaa : word",
                    "xxx",
                ] {
                    let result = grammar.tokenize_line(line, state.take(), 0).unwrap();
                    tokens.push(result.tokens);
                    state = Some(result.rule_stack);
                }
                if prepared && prefilter {
                    let (loaded, invalid) = registry.prepared_stats(&raw.scope_name);
                    assert!(
                        loaded > 0,
                        "ordered Eager groups must load from the archive"
                    );
                    assert_eq!(invalid, 0);
                }
                (tokens, grammar.backtracking_warnings())
            };
            assert_eq!(run(false), run(true));
        }
    }

    #[test]
    fn multiple_languages_keep_their_own_group_sources() {
        let first = grammar();
        let second = parse_raw_grammar(r#"{"scopeName":"source.second","patterns":[{"match":"alpha","name":"keyword.a"},{"match":"beta","name":"keyword.b"},{"match":"gamma","name":"keyword.c"}]}"#, Some("grammar.json")).unwrap();
        let mut registry = SyncRegistry::new(None, None).unwrap();
        for raw in [&first, &second] {
            registry
                .add_precompiled_patterns(sampled_archive(raw).unwrap())
                .unwrap();
            registry.add_grammar(raw.clone(), vec![]);
        }
        for raw in [&first, &second, &first] {
            let grammar = registry
                .grammar_for_scope_name(&raw.scope_name, GrammarConfiguration::default())
                .unwrap()
                .unwrap();
            grammar
                .tokenize_line("first alpha beta gamma TODO", None, 0)
                .unwrap();
            let (loaded, invalid) = registry.prepared_stats(&raw.scope_name);
            assert!(
                loaded > 0,
                "{} must retain its prepared groups",
                raw.scope_name
            );
            assert_eq!(invalid, 0);
        }
        registry.dispose();
        assert!(registry.lookup("source.second").is_none());
    }

    #[test]
    fn registry_preparation_resolves_includes_and_external_injections() {
        let root = parse_raw_grammar(
            r#"{"scopeName":"source.root","patterns":[{"include":"source.child"}]}"#,
            Some("grammar.json"),
        )
        .unwrap();
        let child = parse_raw_grammar(r#"{"scopeName":"source.child","patterns":[{"match":"alpha","name":"keyword.child"},{"match":"beta","name":"keyword.beta"},{"match":"gamma","name":"keyword.gamma"}]}"#, Some("grammar.json")).unwrap();
        let injection = parse_raw_grammar(r#"{"scopeName":"source.inject","injectionSelector":"L:source.root","patterns":[{"match":"TODO","name":"comment.todo"}]}"#, Some("grammar.json")).unwrap();
        let registry = || {
            let mut registry = SyncRegistry::new(None, None).unwrap();
            registry.add_grammar(root.clone(), vec!["source.inject".into()]);
            registry.add_grammar(child.clone(), vec![]);
            registry.add_grammar(injection.clone(), vec![]);
            registry
        };
        let sample = "TODO alpha beta gamma";
        let bytes = registry()
            .precompile_patterns("source.root", &[sample])
            .unwrap()
            .unwrap();
        let mut source = registry();
        let mut prepared = registry();
        prepared.add_precompiled_patterns(bytes).unwrap();
        let tokenize = |registry: &mut SyncRegistry| {
            registry
                .grammar_for_scope_name("source.root", GrammarConfiguration::default())
                .unwrap()
                .unwrap()
                .tokenize_line(sample, None, 0)
                .unwrap()
                .tokens
        };
        assert_eq!(tokenize(&mut source), tokenize(&mut prepared));
        let (loaded, invalid) = prepared.prepared_stats("source.root");
        assert!(loaded > 0);
        assert_eq!(invalid, 0);
    }

    #[test]
    fn archive_can_mix_with_previously_compiled_and_missing_source_patterns() {
        let raw = grammar();
        let cache = ScannerPatternCache::new().for_scope(&raw.scope_name);
        cache.compile_static("word", true).unwrap();
        cache
            .add_precompiled(precompile_grammar_patterns(&raw).unwrap())
            .unwrap();
        let mut sources = crate::regexp::RegExpSourceList::with_pattern_cache(true, cache);
        for (id, pattern) in ["word", "TODO", "new-source-pattern"]
            .into_iter()
            .enumerate()
        {
            sources.push(RegExpSource::new(pattern, id));
        }
        let scanner = sources.compile().unwrap();
        let found = scanner
            .find_next_match(
                &crate::regexp::OnigString::new("new-source-pattern TODO"),
                0,
                ferroni::scanner::ScannerFindOptions::NONE,
            )
            .unwrap();
        assert_eq!(found.rule_id, 2);
    }

    #[test]
    fn oversized_zstd_window_is_rejected_before_decoding() {
        // A valid raw block with four content bytes and a declared 64 MiB
        // window. One-shot decoders need no large window allocation for it.
        let frame = vec![
            0x28, 0xb5, 0x2f, 0xfd, 0x80, 0x80, 4, 0, 0, 0, 0x21, 0, 0, b't', b'i', b'n', b'y',
        ];
        assert_eq!(zstd::bulk::decompress(&frame, 4).unwrap(), b"tiny");
        assert!(
            open_archive(frame)
                .err()
                .unwrap()
                .to_string()
                .contains("window")
        );
    }

    #[test]
    fn archive_rejects_invalid_lengths_versions_and_transport() {
        let archive = precompile_grammar_patterns(&grammar()).unwrap();
        let decoded = zstd::bulk::decompress(&archive, MAX_ARCHIVE_BYTES as usize).unwrap();
        for range in [8..12, 12..16, 16..24, 24..32] {
            let mut invalid = decoded.clone();
            invalid[range].fill(0xff);
            assert!(decompress_precompiled_patterns(&invalid).is_err());
            assert!(open_archive(&invalid).is_err());
            assert!(open_archive(zstd::bulk::compress(&invalid, 1).unwrap()).is_err());
        }
        let mut trailing = archive.clone();
        trailing.extend_from_slice(&archive);
        assert!(open_archive(trailing).is_err());
        let mut corrupt = archive.clone();
        let middle = corrupt.len() / 2;
        corrupt[middle] ^= 0xff;
        assert!(open_archive(corrupt).is_err());
        assert!(open_archive(&archive[..archive.len() - 1]).is_err());
    }

    #[test]
    fn invalid_archive_does_not_prevent_source_compilation() {
        let mut registry = SyncRegistry::new(None, None).unwrap();
        assert!(registry.add_precompiled_patterns(vec![0; 16]).is_err());
        let raw = grammar();
        registry.add_grammar(raw, vec![]);
        let grammar = registry
            .grammar_for_scope_name("source.precompiled", GrammarConfiguration::default())
            .unwrap()
            .unwrap();
        assert!(
            !grammar
                .tokenize_line("first", None, 0)
                .unwrap()
                .tokens
                .is_empty()
        );
        registry.dispose();
    }
}
