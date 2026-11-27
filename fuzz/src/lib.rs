use std::borrow::Cow;
use std::cell::{OnceCell, RefCell};
use std::collections::hash_map::RandomState;
use std::fs::{File, OpenOptions};
use std::hash::{BuildHasher, Hasher};
use std::io::{ErrorKind, Seek, SeekFrom, Write};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};

use ferriki::__private::{
    DecorationBoundaries, DecorationNode, DecorationPosition, DecorationRange, DecorationSection,
    DecorationSource, DecorationToken, HighlighterCore, HtmlDecoration, MultiThemeRenderOptions,
    decoration_sections, plan_decoration_mutations, render_html_with_decorations,
    render_html_with_themes,
};
use ferriki::{
    LanguageRegistration, RenderOptions, StyleMode, ThemeData, TokenizeOptions, parse_theme_data,
    render_html, render_html_with_css,
};
use ferriki_textmate::{
    Grammar, GrammarConfiguration, ParseRawGrammarError, RawGrammar, RawTheme, SyncRegistry, Theme,
    TokenizeLineResultWithScopes, decompress_precompiled_patterns, index_precompiled_patterns,
    parse_raw_grammar,
};

pub const MAX_GRAMMAR_BYTES: usize = 64 * 1024;
pub const MAX_COMPILE_GRAMMAR_BYTES: usize = 16 * 1024;
pub const MAX_ASSET_BYTES: usize = 64 * 1024;
pub const MAX_THEME_INPUT_BYTES: usize = 16 * 1024;
pub const MAX_TOKENIZER_INPUT_BYTES: usize = 16 * 1024;
pub const MAX_TOKENIZER_LINE_BYTES: usize = 4 * 1024;
pub const MAX_TOKENIZER_LINES: usize = 8;
pub const MAX_STATE_STACK_BYTES: usize = 64 * 1024;
pub const MAX_DECORATION_INPUT_BYTES: usize = 4 * 1024;
pub const TOKENIZE_LIMIT_MILLIS: u64 = 100;
pub const UNTRUSTED_TOKENIZE_LIMIT_MILLIS: u64 = 10;

pub const CONTROLLED_GRAMMAR_JSON: &str = r#"{
    "scopeName": "source.fuzz",
    "patterns": [
        { "match": "[a-zA-Z_]+", "name": "word.fuzz" },
        { "match": "[0-9]+", "name": "number.fuzz" },
        { "begin": "\"", "end": "\"", "name": "string.quoted.fuzz" }
    ]
}"#;

/// Richer fixed grammar covering nested begin/end, begin/while, backreferences,
/// contentName, and repository includes for state-stack continuation fuzzing.
pub const STATE_STACK_GRAMMAR_JSON: &str = r##"{
    "scopeName": "source.fuzz.state",
    "patterns": [
        { "include": "#heredoc" },
        { "include": "#blockquote" },
        { "include": "#string" },
        { "match": "[a-zA-Z_]+", "name": "word.fuzz" },
        { "match": "[0-9]+", "name": "number.fuzz" }
    ],
    "repository": {
        "heredoc": {
            "begin": "<<([A-Z_]+)",
            "end": "^\\1$",
            "name": "meta.heredoc.fuzz",
            "contentName": "string.unquoted.heredoc.fuzz",
            "patterns": [
                { "include": "#string" }
            ]
        },
        "blockquote": {
            "begin": "^(>)",
            "while": "^(>)",
            "name": "markup.quote.fuzz",
            "contentName": "meta.quote.body.fuzz",
            "patterns": [
                { "include": "#string" }
            ]
        },
        "string": {
            "begin": "\"",
            "end": "\"",
            "name": "string.quoted.double.fuzz",
            "contentName": "meta.string.inner.fuzz",
            "patterns": [
                { "match": "\\\\.", "name": "constant.character.escape.fuzz" }
            ]
        }
    }
}"##;

const CONTROLLED_THEME_JSON: &str = r##"{
    "name": "Fuzz seed theme",
    "fg": "#d4d4d4",
    "bg": "#1e1e1e",
    "settings": [
        { "scope": "word.fuzz", "settings": { "foreground": "#123456", "fontStyle": "bold" } },
        { "scope": ["number.fuzz", "string.quoted.fuzz"], "settings": { "foreground": "#abcdef" } }
    ]
}"##;

const UNTRUSTED_GRAMMAR_SAMPLE_LINES: &[&str] = &[
    "",
    "let x = \"hello\" + 42;",
    "// comment\t日本語 🚀",
    "\"unterminated",
];

const STATE_STACK_CONTINUATION_LINES: &[&str] = &["> \"hello\"", "EOF", "END", "word 123"];

static SCRATCH_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Convert arbitrary bytes to UTF-8 and cap the resulting string by byte size.
///
/// Truncation backs up to a character boundary, including when replacement
/// characters make the lossy conversion larger than the input byte slice.
pub fn bounded_utf8(input: &[u8], max_bytes: usize) -> Cow<'_, str> {
    let prefix = &input[..input.len().min(max_bytes)];
    let text = String::from_utf8_lossy(prefix);
    if text.len() <= max_bytes {
        return text;
    }

    let mut end = max_bytes;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    Cow::Owned(text[..end].to_owned())
}

pub fn controlled_theme() -> RawTheme {
    serde_json::from_str(CONTROLLED_THEME_JSON).expect("the fixed fuzz theme is valid JSON")
}

pub fn controlled_theme_data(id: &str) -> ThemeData {
    let mut theme =
        parse_theme_data(id, CONTROLLED_THEME_JSON).expect("the fixed fuzz theme data is valid");
    theme.name = id.to_owned();
    theme
}

pub fn controlled_raw_grammar() -> RawGrammar {
    serde_json::from_str(CONTROLLED_GRAMMAR_JSON).expect("the fixed fuzz grammar is valid JSON")
}

/// Build a grammar using only the bounded, fixed regexes owned by this crate.
pub fn grammar_with_theme(
    theme: Option<RawTheme>,
) -> Result<Rc<Grammar>, ferriki_textmate::ThemeError> {
    let raw_grammar = controlled_raw_grammar();
    let mut registry = SyncRegistry::new(theme, None)?;
    registry.add_grammar(raw_grammar, Vec::new());
    registry
        .grammar_for_scope_name("source.fuzz", GrammarConfiguration::default())?
        .ok_or_else(|| unreachable!("the fixed grammar was just registered"))
}

/// Build the richer fixed grammar used for state-stack serialization fuzzing.
pub fn state_stack_grammar() -> Rc<Grammar> {
    let raw_grammar: RawGrammar = serde_json::from_str(STATE_STACK_GRAMMAR_JSON)
        .expect("the fixed state-stack grammar is valid JSON");
    let mut registry =
        SyncRegistry::new(Some(controlled_theme()), None).expect("the fixed theme must compile");
    registry.add_grammar(raw_grammar, Vec::new());
    registry
        .grammar_for_scope_name("source.fuzz.state", GrammarConfiguration::default())
        .expect("the fixed state-stack grammar must compile")
        .expect("the fixed state-stack grammar was just registered")
}

/// Extract the active grammar fingerprint from a serialized initial state.
pub fn extract_grammar_fingerprint(grammar: &Grammar) -> String {
    let serialized = grammar
        .serialize_state_stack(None)
        .expect("initial state must serialize");
    let value: serde_json::Value =
        serde_json::from_str(&serialized).expect("serialized state must be valid JSON");
    value["grammarFingerprint"]
        .as_str()
        .expect("serialized state must include grammarFingerprint")
        .to_owned()
}

/// Check public token offsets and the paired binary-token shape.
///
/// TextMate reports offsets in UTF-16 code units. The tokenizer appends a
/// newline internally, so the maximum output offset is one unit past the
/// supplied line's UTF-16 length.
pub fn assert_token_output_invariants(result: &TokenizeLineResultWithScopes, line: &str) {
    let max_offset = line.encode_utf16().count() + 1;
    let mut previous_start = 0;
    for token in &result.tokens {
        assert!(token.start_index <= token.end_index);
        assert!(token.end_index <= max_offset);
        assert!(token.start_index >= previous_start);
        previous_start = token.start_index;
    }

    assert!(!result.binary_tokens.is_empty());
    assert_eq!(result.binary_tokens.len() % 2, 0);
    let mut previous_binary_start = 0;
    for [start, _] in result.binary_tokens.as_chunks::<2>().0 {
        let start = *start as usize;
        assert!(start <= max_offset);
        assert!(start >= previous_binary_start);
        previous_binary_start = start;
    }

    for font in &result.fonts {
        assert!(font.start_index <= font.end_index);
        assert!(font.end_index <= max_offset);
    }
}

/// Select the parser dispatch file path for raw grammar fuzzing.
///
/// Any input whose BOM-stripped, whitespace-trimmed text begins with `<`
/// (including `<?xml`, `<!DOCTYPE`, `<!--`, `<plist>`, and bare `<dict>` or
/// `<array>` roots) routes to the property-list parser; all other inputs route
/// to the JSON parser.
pub fn select_raw_grammar_file_path(content: &str) -> &'static str {
    let trimmed = content
        .strip_prefix('\u{feff}')
        .unwrap_or(content)
        .trim_start();
    if trimmed.starts_with('<') {
        "grammar.tmLanguage"
    } else {
        "grammar.json"
    }
}

/// Dispatch and parse bounded raw grammar bytes using the same routing as the fuzz target.
pub fn parse_raw_grammar_bytes(
    input: &[u8],
) -> (&'static str, Result<RawGrammar, ParseRawGrammarError>) {
    let content = bounded_utf8(input, MAX_GRAMMAR_BYTES);
    let file_path = select_raw_grammar_file_path(&content);
    let parsed = parse_raw_grammar(&content, Some(file_path));
    (file_path, parsed)
}

/// Dispatch, parse, compile, and tokenize an untrusted raw grammar input.
///
/// Covers JSON grammars as well as XML property-list grammars including bare
/// `<dict>` / `<array>` roots and BOM-prefixed inputs.
pub fn fuzz_parse_raw_grammar(input: &[u8]) {
    let content = bounded_utf8(input, MAX_GRAMMAR_BYTES);
    let file_path = select_raw_grammar_file_path(&content);

    // Parse errors are expected for arbitrary input. Do not catch panics: a
    // panic in the parser or compiler must remain a libFuzzer finding.
    let Ok(raw_grammar) = parse_raw_grammar(&content, Some(file_path)) else {
        return;
    };

    if content.len() > MAX_COMPILE_GRAMMAR_BYTES {
        return;
    }

    let scope_name = raw_grammar.scope_name.clone();
    let Ok(mut registry) = SyncRegistry::new(Some(controlled_theme()), None) else {
        return;
    };
    registry.add_grammar(raw_grammar, Vec::new());

    let Ok(Some(grammar)) =
        registry.grammar_for_scope_name(&scope_name, GrammarConfiguration::default())
    else {
        return;
    };

    let _ = grammar.compile_all_scanners();

    let mut previous_state = None;
    for line in UNTRUSTED_GRAMMAR_SAMPLE_LINES {
        match grammar.tokenize_line_with_scopes(
            line,
            previous_state,
            UNTRUSTED_TOKENIZE_LIMIT_MILLIS,
        ) {
            Ok(result) => {
                assert_token_output_invariants(&result, line);
                previous_state = Some(result.rule_stack);
            }
            Err(_) => {
                previous_state = None;
            }
        }
    }
}

/// Fuzz `Grammar::deserialize_state_stack` on raw and fingerprint-matched inputs.
pub fn fuzz_deserialize_state_stack(input: &[u8]) {
    thread_local! {
        static STATE_GRAMMAR: OnceCell<(Rc<Grammar>, String)> = const { OnceCell::new() };
    }

    let text = bounded_utf8(input, MAX_STATE_STACK_BYTES);
    STATE_GRAMMAR.with(|slot| {
        let (grammar, fingerprint) = slot.get_or_init(|| {
            let grammar = state_stack_grammar();
            let fingerprint = extract_grammar_fingerprint(&grammar);
            (grammar, fingerprint)
        });

        let exercise = |candidate: &str| {
            if let Ok(state) = grammar.deserialize_state_stack(candidate) {
                let serialized = grammar
                    .serialize_state_stack(Some(&state))
                    .expect("accepted state snapshot must serialize");
                let round_tripped = grammar
                    .deserialize_state_stack(&serialized)
                    .expect("re-serialized accepted state snapshot must deserialize");
                assert!(
                    state.equals(&round_tripped),
                    "accepted state snapshot must round-trip identically"
                );

                for line in STATE_STACK_CONTINUATION_LINES {
                    if let Ok(result) = grammar.tokenize_line_with_scopes(
                        line,
                        Some(state.clone()),
                        UNTRUSTED_TOKENIZE_LIMIT_MILLIS,
                    ) {
                        assert_token_output_invariants(&result, line);
                        if let Ok(resumed_serialized) =
                            grammar.serialize_state_stack(Some(&result.rule_stack))
                        {
                            let resumed_round_tripped = grammar
                                .deserialize_state_stack(&resumed_serialized)
                                .expect("serialized resumed state must deserialize");
                            assert!(
                                result.rule_stack.equals(&resumed_round_tripped),
                                "resumed state snapshot must round-trip identically"
                            );
                        }
                    }
                }
            }
        };

        // Always exercise raw untrusted bytes first (header, version, fingerprint,
        // unknown-field, and JSON error paths within the 64 KiB fuzz input cap).
        exercise(&text);

        // If the input parses as a JSON object, also patch the live grammar
        // metadata so libFuzzer reaches deep frame/scope/backreference validation.
        if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&text)
            && let Some(object) = value.as_object_mut()
        {
            object.insert("version".to_owned(), serde_json::Value::from(1u8));
            object.insert(
                "grammarFingerprint".to_owned(),
                serde_json::Value::String(fingerprint.clone()),
            );
            object.insert(
                "rootScope".to_owned(),
                serde_json::Value::String(grammar.root_scope_name().to_owned()),
            );
            if let Ok(patched) = serde_json::to_string(&value) {
                exercise(&patched);
            }
        }
    });
}

struct ScratchArchive {
    file: File,
    #[cfg(not(unix))]
    path: PathBuf,
}

impl ScratchArchive {
    fn new(label: &str) -> Self {
        let temp_dir = std::env::temp_dir();
        for _ in 0..64 {
            let id = SCRATCH_COUNTER.fetch_add(1, Ordering::Relaxed);
            let mut hasher = RandomState::new().build_hasher();
            hasher.write_u64(id);
            hasher.write_u32(std::process::id());
            let nonce = hasher.finish();
            let path: PathBuf = temp_dir.join(format!(
                "ferriki-fuzz-{label}-{}-{id}-{nonce:016x}.tmp",
                std::process::id()
            ));
            let mut options = OpenOptions::new();
            options.read(true).write(true).create_new(true);
            #[cfg(unix)]
            options.mode(0o600);
            match options.open(&path) {
                Ok(file) => {
                    // Unlink immediately on Unix so the OS reclaims the inode even if
                    // libFuzzer exits via _exit or crashes.
                    #[cfg(unix)]
                    let _ = std::fs::remove_file(&path);
                    return Self {
                        file,
                        #[cfg(not(unix))]
                        path,
                    };
                }
                Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("fuzz scratch file must open exclusively: {error}"),
            }
        }
        panic!("could not create a unique fuzz scratch file after 64 attempts");
    }

    fn write_and_clone(&mut self, bytes: &[u8]) -> Option<File> {
        self.file.set_len(0).ok()?;
        self.file.seek(SeekFrom::Start(0)).ok()?;
        self.file.write_all(bytes).ok()?;
        self.file.seek(SeekFrom::Start(0)).ok()?;
        self.file.try_clone().ok()
    }
}

#[cfg(not(unix))]
impl Drop for ScratchArchive {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn prepare_controlled_decoded_archive() -> Vec<u8> {
    let mut registry =
        SyncRegistry::new(Some(controlled_theme()), None).expect("fixed theme must compile");
    registry.add_grammar(controlled_raw_grammar(), Vec::new());
    let compressed = registry
        .precompile_patterns("source.fuzz", &[])
        .expect("fixed grammar must precompile")
        .expect("fixed grammar was registered");
    decompress_precompiled_patterns(&compressed).expect("fixed archive must decompress")
}

fn exercise_registry_tokenization(registry: &mut SyncRegistry) {
    registry.add_grammar(controlled_raw_grammar(), Vec::new());
    if let Ok(Some(grammar)) =
        registry.grammar_for_scope_name("source.fuzz", GrammarConfiguration::default())
    {
        let _ = grammar.compile_all_scanners();
        if let Ok(result) = grammar.tokenize_line_with_scopes(
            "word 123 \"str\"",
            None,
            UNTRUSTED_TOKENIZE_LIMIT_MILLIS,
        ) {
            assert_token_output_invariants(&result, "word 123 \"str\"");
        }
    }
}

fn split_paired_archive(bytes: &[u8]) -> Option<(&[u8], &[u8])> {
    if bytes.len() < 2 {
        return None;
    }
    let split_hint = u16::from_le_bytes([bytes[0], bytes[1]]) as usize;
    let payload = &bytes[2..];
    let split = if payload.is_empty() {
        0
    } else {
        split_hint % (payload.len() + 1)
    };
    Some(payload.split_at(split))
}

/// Fuzz `.fkbc` and `.fkix` precompiled/indexed archive decoders.
pub fn fuzz_decode_precompiled_archives(input: &[u8]) {
    thread_local! {
        static SCRATCH: RefCell<ScratchArchive> = RefCell::new(ScratchArchive::new("archive"));
        static VALID_ARCHIVE_FILE: OnceCell<File> = const { OnceCell::new() };
    }

    let bytes = &input[..input.len().min(MAX_ASSET_BYTES)];

    // 1. Decompress raw input as a `.fkbc` container.
    let decompressed = decompress_precompiled_patterns(bytes);

    // 2. Attach owned bytes (and decoded bytes when decompression succeeded).
    if let Ok(mut registry) = SyncRegistry::new(Some(controlled_theme()), None)
        && registry
            .add_precompiled_patterns_owned(bytes.to_vec())
            .is_ok()
    {
        exercise_registry_tokenization(&mut registry);
    }
    if let Ok(ref decoded) = decompressed
        && let Ok(mut registry) = SyncRegistry::new(Some(controlled_theme()), None)
        && registry
            .add_precompiled_patterns_owned(decoded.clone())
            .is_ok()
    {
        exercise_registry_tokenization(&mut registry);
    }

    // 3. Build `.fkix` indexes from raw and decompressed bytes.
    let _ = index_precompiled_patterns(bytes);
    let indexed_from_decoded = decompressed
        .as_ref()
        .ok()
        .and_then(|decoded| index_precompiled_patterns(decoded).ok());

    // 4. Exercise `IndexedArchive::open` via `SyncRegistry::add_precompiled_patterns_file`.
    // 4a. Arbitrary index bytes against a real precompiled container file.
    VALID_ARCHIVE_FILE.with(|slot| {
        let valid_file = slot.get_or_init(|| {
            let decoded = prepare_controlled_decoded_archive();
            let mut archive = ScratchArchive::new("valid-fkbc");
            archive
                .write_and_clone(&decoded)
                .expect("valid archive file must populate")
        });
        if let Ok(cloned) = valid_file.try_clone()
            && let Ok(mut registry) = SyncRegistry::new(Some(controlled_theme()), None)
            && registry
                .add_precompiled_patterns_file(cloned, bytes)
                .is_ok()
        {
            exercise_registry_tokenization(&mut registry);
        }
    });

    // 4b. When decompression + indexing both succeeded, attach the resulting pair.
    if let (Ok(decoded), Some(index)) = (&decompressed, &indexed_from_decoded) {
        SCRATCH.with(|scratch| {
            if let Some(file) = scratch.borrow_mut().write_and_clone(decoded)
                && let Ok(mut registry) = SyncRegistry::new(Some(controlled_theme()), None)
                && registry.add_precompiled_patterns_file(file, index).is_ok()
            {
                exercise_registry_tokenization(&mut registry);
            }
        });
    }

    // 4c. Split arbitrary bytes into a container file + index pair so the fuzzer
    // can co-mutate container lengths/offsets and index records together.
    if let Some((container_bytes, index_bytes)) = split_paired_archive(bytes) {
        SCRATCH.with(|scratch| {
            if let Some(file) = scratch.borrow_mut().write_and_clone(container_bytes)
                && let Ok(mut registry) = SyncRegistry::new(Some(controlled_theme()), None)
                && registry
                    .add_precompiled_patterns_file(file, index_bytes)
                    .is_ok()
            {
                exercise_registry_tokenization(&mut registry);
            }
        });
    }
}

/// Minimal byte cursor for structured fuzzing without pulling extra crates.
struct ByteCursor<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> ByteCursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn next_u8(&mut self) -> u8 {
        if self.offset < self.bytes.len() {
            let value = self.bytes[self.offset];
            self.offset += 1;
            value
        } else {
            0
        }
    }

    fn next_bool(&mut self) -> bool {
        self.next_u8() & 1 != 0
    }

    fn next_u16(&mut self) -> u16 {
        u16::from_le_bytes([self.next_u8(), self.next_u8()])
    }

    fn next_usize_mod(&mut self, max_exclusive: usize) -> usize {
        if max_exclusive == 0 {
            0
        } else {
            (self.next_u16() as usize) % max_exclusive
        }
    }

    fn next_bounded_utf8(&mut self, max_bytes: usize) -> String {
        if max_bytes == 0 || self.offset >= self.bytes.len() {
            return String::new();
        }
        let requested = self.next_u8() as usize;
        let remaining = self.bytes.len().saturating_sub(self.offset);
        let len = requested.min(max_bytes).min(remaining);
        let slice = &self.bytes[self.offset..self.offset + len];
        self.offset += len;
        bounded_utf8(slice, max_bytes).into_owned()
    }
}

fn next_decoration_position(cursor: &mut ByteCursor<'_>, max_offset: usize) -> DecorationPosition {
    match cursor.next_u8() % 4 {
        0 => DecorationPosition::Offset(cursor.next_usize_mod(max_offset.saturating_add(4))),
        1 => DecorationPosition::Offset(usize::MAX - usize::from(cursor.next_u8() % 4)),
        2 => {
            let line = cursor.next_usize_mod(12);
            let raw = i16::from_le_bytes([cursor.next_u8(), cursor.next_u8()]);
            let character = isize::from(raw.clamp(-32, 64));
            DecorationPosition::Line { line, character }
        }
        _ => DecorationPosition::Line {
            line: usize::from(cursor.next_u8() % 6),
            character: if cursor.next_bool() {
                isize::MIN
            } else {
                isize::MAX
            },
        },
    }
}

/// Fuzz decoration range resolution, mutation planning, and decorated HTML rendering.
pub fn fuzz_decorations(input: &[u8]) {
    let _ = run_decorations_fuzz(input);
}

fn run_decorations_fuzz(input: &[u8]) -> Option<String> {
    thread_local! {
        static DECORATION_HIGHLIGHTER: RefCell<HighlighterCore> = RefCell::new({
            let mut core = HighlighterCore::new().expect("HighlighterCore must initialize");
            core.register_language(LanguageRegistration::new("fuzz", controlled_raw_grammar()))
                .expect("controlled grammar must register");
            core.register_theme(controlled_theme_data("fuzz-theme"))
                .expect("controlled theme must register");
            core
        });
    }

    let capped = &input[..input.len().min(MAX_DECORATION_INPUT_BYTES)];
    let mut cursor = ByteCursor::new(capped);

    // 1. Structured source text (bounded to keep tokenization and HTML small).
    let source = cursor.next_bounded_utf8(256);
    let max_offset = source.len().max(source.encode_utf16().count()).max(1);

    // 2. Structured decoration ranges and HTML decoration payloads.
    let range_count = cursor.next_usize_mod(10);
    let mut ranges = Vec::with_capacity(range_count);
    let mut html_decorations = Vec::with_capacity(range_count);
    for _ in 0..range_count {
        let range = DecorationRange {
            start: next_decoration_position(&mut cursor, max_offset),
            end: next_decoration_position(&mut cursor, max_offset),
            always_wrap: cursor.next_bool(),
        };
        let tag_name = match cursor.next_u8() % 4 {
            0 => "span".to_owned(),
            1 => "mark".to_owned(),
            2 => "strong".to_owned(),
            _ => {
                let custom = cursor.next_bounded_utf8(16);
                if custom.is_empty() {
                    "span".to_owned()
                } else {
                    custom
                }
            }
        };
        let prop_count = cursor.next_usize_mod(4);
        let mut properties = Vec::with_capacity(prop_count);
        for _ in 0..prop_count {
            let key = match cursor.next_u8() % 3 {
                0 => "class".to_owned(),
                1 => "data-fuzz".to_owned(),
                _ => cursor.next_bounded_utf8(12),
            };
            let value = cursor.next_bounded_utf8(32);
            properties.push((key, value));
        }
        ranges.push(range);
        html_decorations.push(HtmlDecoration {
            range,
            tag_name,
            properties,
        });
    }

    // Exercise both UTF-8 and UTF-16 range resolution.
    let _ = DecorationSource::utf8(&source).resolve_ranges(&ranges);
    if let Ok(resolved) = DecorationSource::utf16(&source).resolve_ranges(&ranges) {
        let boundaries = DecorationBoundaries::new(&resolved);
        let token_count = cursor.next_usize_mod(12);
        let mut tokens = Vec::with_capacity(token_count);
        for _ in 0..token_count {
            let offset = if cursor.next_u8().is_multiple_of(8) {
                usize::MAX - usize::from(cursor.next_u8() % 4)
            } else {
                cursor.next_usize_mod(max_offset.saturating_add(4))
            };
            let length = cursor.next_usize_mod(32);
            tokens.push(DecorationToken { offset, length });
        }
        let mut emitted = 0usize;
        let _ = boundaries.split_tokens(&tokens, |_| {
            emitted += 1;
            Ok(())
        });
        let _ = decoration_sections(&resolved);
    }

    // 3. Direct fuzzing of `plan_decoration_mutations` with arbitrary node graphs
    // (including cycles, out-of-bounds children, and text_length overflows).
    let node_count = cursor.next_usize_mod(24);
    let mut nodes = Vec::with_capacity(node_count);
    for _ in 0..node_count {
        let element = cursor.next_bool();
        let text_length = match cursor.next_u8() % 8 {
            0 => usize::MAX,
            1 => usize::MAX - 1,
            _ => cursor.next_usize_mod(32),
        };
        let child_count = cursor.next_usize_mod(6);
        let mut children = Vec::with_capacity(child_count);
        for _ in 0..child_count {
            children.push(cursor.next_usize_mod(node_count.saturating_add(3)));
        }
        nodes.push(DecorationNode {
            element,
            text_length,
            children,
        });
    }
    let line_count = cursor.next_usize_mod(8);
    let mut lines = Vec::with_capacity(line_count);
    for _ in 0..line_count {
        lines.push(cursor.next_usize_mod(node_count.saturating_add(3)));
    }
    let section_count = cursor.next_usize_mod(10);
    let mut sections = Vec::with_capacity(section_count);
    for decoration in 0..section_count {
        sections.push(DecorationSection {
            decoration,
            line: cursor.next_usize_mod(line_count.saturating_add(3)),
            start: cursor.next_usize_mod(64),
            end: cursor.next_bool().then(|| cursor.next_usize_mod(64)),
            whole_line: cursor.next_bool(),
            always_wrap: cursor.next_bool(),
        });
    }
    let _ = plan_decoration_mutations(nodes, &lines, &sections);

    // 4. End-to-end `render_html_with_decorations` against tokenized source.
    let render_options = RenderOptions::default()
        .with_include_root_style(cursor.next_bool())
        .with_merge_whitespaces(cursor.next_bool())
        .with_merge_same_style_tokens(cursor.next_bool())
        .with_tabindex(cursor.next_bool().then(|| cursor.next_bounded_utf8(8)))
        .with_root_style(cursor.next_bool().then(|| cursor.next_bounded_utf8(32)));

    DECORATION_HIGHLIGHTER.with(|cell| {
        let mut core = cell.borrow_mut();
        let tokenize_options =
            TokenizeOptions::default().with_time_limit_millis(UNTRUSTED_TOKENIZE_LIMIT_MILLIS);
        let tokens_result = core
            .tokenize(&source, "fuzz", "fuzz-theme", &tokenize_options)
            .ok()?;
        let html = render_html_with_decorations(
            &source,
            &tokens_result,
            &render_options,
            &html_decorations,
        )
        .ok()??;
        assert!(html.starts_with("<pre "));
        Some(html)
    })
}

const DEFAULT_THEME_RENDER_SAMPLE: &str = "word 42 \"hello\"";

fn exercise_theme_render(theme_data: ThemeData, code: &str) -> (bool, bool) {
    // Directly exercise Theme compilation from the parsed RawTheme.
    let _ = Theme::create_from_raw_theme(Some(&theme_data.raw_theme), None);

    let Ok(mut core) = HighlighterCore::new() else {
        return (false, false);
    };
    if core
        .register_language(LanguageRegistration::new("fuzz", controlled_raw_grammar()))
        .is_err()
    {
        return (false, false);
    }

    let primary_name = theme_data.name.clone();
    if core.register_theme(theme_data).is_err() {
        return (false, false);
    }
    let secondary_name = if primary_name == "fuzz-secondary" {
        "fuzz-secondary-alt"
    } else {
        "fuzz-secondary"
    };
    let _ = core.register_theme(controlled_theme_data(secondary_name));

    let tokenize_options =
        TokenizeOptions::default().with_time_limit_millis(UNTRUSTED_TOKENIZE_LIMIT_MILLIS);

    let mut rendered_css = false;
    if let Ok(tokens) = core.tokenize(code, "fuzz", &primary_name, &tokenize_options) {
        let inline_html = render_html(&tokens, &RenderOptions::default());
        assert!(inline_html.starts_with("<pre "));

        let css_default = render_html_with_css(&tokens, &RenderOptions::default());
        assert!(css_default.html.starts_with("<pre "));

        let css_unmerged = render_html_with_css(
            &tokens,
            &RenderOptions::default()
                .with_style_mode(StyleMode::Classes)
                .with_include_root_style(false)
                .with_merge_whitespaces(false),
        );
        assert!(css_unmerged.html.starts_with("<pre "));
        rendered_css = true;
    }

    let mut rendered_multi = false;
    let theme_pairs = [
        ("light".to_owned(), primary_name.clone()),
        ("dark".to_owned(), secondary_name.to_owned()),
    ];
    if let Ok(multi_tokens) =
        core.tokenize_with_themes(code, "fuzz", &theme_pairs, &tokenize_options)
    {
        let multi_with_default = render_html_with_themes(
            &multi_tokens,
            &MultiThemeRenderOptions {
                render: RenderOptions::default(),
                default_color: Some("light".to_owned()),
                css_variable_prefix: "--shiki-".to_owned(),
            },
        );
        assert!(multi_with_default.starts_with("<pre "));

        let multi_css_vars = render_html_with_themes(
            &multi_tokens,
            &MultiThemeRenderOptions {
                render: RenderOptions::default().with_merge_same_style_tokens(true),
                default_color: None,
                css_variable_prefix: "--ferriki-".to_owned(),
            },
        );
        assert!(multi_css_vars.starts_with("<pre "));
        rendered_multi = true;
    }

    (rendered_css, rendered_multi)
}

fn run_theme_render_fuzz(input: &[u8]) -> (bool, bool) {
    let text = bounded_utf8(input, MAX_THEME_INPUT_BYTES);
    // Support both full-document (including pretty-printed multiline) theme JSON
    // and compact `<theme-json>\n<sample-code>` inputs.
    if let Ok(theme_data) = parse_theme_data("fuzz-theme", &text) {
        exercise_theme_render(theme_data, DEFAULT_THEME_RENDER_SAMPLE)
    } else if let Some((theme_json, raw_code)) = text.split_once('\n')
        && let Ok(theme_data) = parse_theme_data("fuzz-theme", theme_json)
    {
        let code = bounded_utf8(raw_code.as_bytes(), MAX_TOKENIZER_LINE_BYTES);
        exercise_theme_render(theme_data, &code)
    } else {
        (false, false)
    }
}

/// Fuzz `parse_theme_data`, `Theme::create_from_raw_theme`, `render_html_with_css`,
/// and `render_html_with_themes` on untrusted theme JSON.
pub fn fuzz_theme_render(input: &[u8]) {
    let _ = run_theme_render_fuzz(input);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn corpus_files(target: &str) -> Vec<PathBuf> {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("corpus")
            .join(target);
        let mut entries: Vec<PathBuf> = std::fs::read_dir(&dir)
            .unwrap_or_else(|error| panic!("missing corpus dir {}: {error}", dir.display()))
            .map(|entry| entry.expect("dir entry").path())
            .filter(|path| {
                path.is_file()
                    && path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.starts_with("seed-"))
            })
            .collect();
        entries.sort();
        assert!(
            !entries.is_empty(),
            "corpus dir {} must contain at least one seed",
            dir.display()
        );
        entries
    }

    #[test]
    fn parse_raw_grammar_handles_json_plist_and_bare_dict_array_seeds() {
        for path in corpus_files("parse_raw_grammar") {
            let bytes = std::fs::read(&path).expect("read seed");
            fuzz_parse_raw_grammar(&bytes);
        }

        // Assert that the bare `<dict>` plist seed routes to the plist parser,
        // parses as a valid RawGrammar, compiles, and tokenizes cleanly.
        let bare_dict_bytes = std::fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("corpus")
                .join("parse_raw_grammar")
                .join("seed-bare-dict-plist"),
        )
        .expect("read seed-bare-dict-plist");
        let (bare_dict_path, bare_dict_parsed) = parse_raw_grammar_bytes(&bare_dict_bytes);
        assert_eq!(bare_dict_path, "grammar.tmLanguage");
        let bare_dict_grammar =
            bare_dict_parsed.expect("seed-bare-dict-plist must parse as a valid plist RawGrammar");
        assert_eq!(bare_dict_grammar.scope_name, "source.bare.plist");
        let mut registry =
            SyncRegistry::new(Some(controlled_theme()), None).expect("fixed theme must compile");
        registry.add_grammar(bare_dict_grammar, Vec::new());
        let compiled = registry
            .grammar_for_scope_name("source.bare.plist", GrammarConfiguration::default())
            .expect("bare dict plist grammar must compile")
            .expect("bare dict plist grammar was registered");
        compiled
            .compile_all_scanners()
            .expect("bare dict plist scanners must compile");
        let result = compiled
            .tokenize_line_with_scopes("word \"hello\"", None, TOKENIZE_LIMIT_MILLIS)
            .expect("bare dict plist grammar must tokenize cleanly");
        assert_token_output_invariants(&result, "word \"hello\"");
        assert!(!result.tokens.is_empty());

        // Assert that the bare `<array>` plist seed routes to the plist parser
        // (failing RawGrammar schema conversion, not JSON parsing).
        let bare_array_bytes = std::fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("corpus")
                .join("parse_raw_grammar")
                .join("seed-bare-array-plist"),
        )
        .expect("read seed-bare-array-plist");
        let (bare_array_path, bare_array_parsed) = parse_raw_grammar_bytes(&bare_array_bytes);
        assert_eq!(bare_array_path, "grammar.tmLanguage");
        assert!(
            matches!(bare_array_parsed, Err(ParseRawGrammarError::Grammar(_))),
            "bare <array> plist must parse as a plist and fail RawGrammar decoding, got {bare_array_parsed:?}"
        );

        // Explicitly verify BOM-prefixed bare `<array>` plist and invalid inputs.
        assert_eq!(
            select_raw_grammar_file_path("\u{feff}<array><string>item</string></array>"),
            "grammar.tmLanguage"
        );
        fuzz_parse_raw_grammar(b"\xef\xbb\xbf<array><string>item</string></array>");
        fuzz_parse_raw_grammar(b"not valid json or plist");
    }

    #[test]
    fn deserialize_state_stack_exercises_seeds_and_adversarial_inputs() {
        for path in corpus_files("deserialize_state_stack") {
            let bytes = std::fs::read(&path).expect("read seed");
            fuzz_deserialize_state_stack(&bytes);
        }

        let grammar = state_stack_grammar();
        for seed_name in [
            "seed-root-state.json",
            "seed-nested-state.json",
            "seed-backref-state.json",
        ] {
            let seed_path = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("corpus")
                .join("deserialize_state_stack")
                .join(seed_name);
            let content = std::fs::read_to_string(&seed_path).expect("read valid state seed");
            let state = grammar
                .deserialize_state_stack(&content)
                .unwrap_or_else(|error| {
                    panic!("valid state seed {seed_name} must deserialize cleanly: {error}")
                });
            let serialized = grammar
                .serialize_state_stack(Some(&state))
                .expect("valid state seed must re-serialize");
            let round_tripped = grammar
                .deserialize_state_stack(&serialized)
                .expect("re-serialized valid state seed must deserialize");
            assert!(state.equals(&round_tripped));
            if seed_name == "seed-backref-state.json" {
                assert_eq!(state.depth, 2, "heredoc seed must sit inside heredoc frame");
                let resumed = grammar
                    .tokenize_line_with_scopes("EOF", Some(state), TOKENIZE_LIMIT_MILLIS)
                    .expect("EOF continuation must tokenize");
                assert_token_output_invariants(&resumed, "EOF");
                assert_eq!(
                    resumed.rule_stack.depth, 1,
                    "tokenizing EOF from seed-backref-state.json must pop back to root scope"
                );
            }
        }

        let line1 = grammar
            .tokenize_line_with_scopes("<<EOF", None, TOKENIZE_LIMIT_MILLIS)
            .expect("heredoc begin must tokenize");
        let serialized = grammar
            .serialize_state_stack(Some(&line1.rule_stack))
            .expect("heredoc state must serialize");
        fuzz_deserialize_state_stack(serialized.as_bytes());
        fuzz_deserialize_state_stack(br#"{"frames":[{"ruleId":999999,"beginRuleCapturedEol":false,"endRule":null,"nameScopes":[],"contentNameScopes":[]}]}"#);
        fuzz_deserialize_state_stack(b"");
    }

    #[test]
    fn deserialize_state_stack_rejects_oversized_input_over_1_mib() {
        let grammar = state_stack_grammar();
        let oversized_whitespace = " ".repeat(1_048_576 + 64);
        let error = grammar
            .deserialize_state_stack(&oversized_whitespace)
            .err()
            .expect("serialized states larger than 1 MiB must be rejected");
        assert!(
            error.contains("too large"),
            "unexpected oversized state error: {error}"
        );

        let root_state = grammar
            .serialize_state_stack(None)
            .expect("initial state must serialize");
        let padded = format!("{root_state}{}", " ".repeat(1_048_576));
        assert!(padded.len() > 1_048_576);
        let padded_error = grammar
            .deserialize_state_stack(&padded)
            .err()
            .expect("valid JSON padded past 1 MiB must be rejected");
        assert!(
            padded_error.contains("too large"),
            "unexpected padded oversized state error: {padded_error}"
        );
    }

    #[test]
    fn decode_precompiled_archives_exercises_seeds_and_corrupt_inputs() {
        for path in corpus_files("decode_precompiled_archives") {
            let bytes = std::fs::read(&path).expect("read seed");
            fuzz_decode_precompiled_archives(&bytes);
        }

        fuzz_decode_precompiled_archives(b"");
        fuzz_decode_precompiled_archives(b"FKBC003\0truncated");
        fuzz_decode_precompiled_archives(b"FKIX002\0truncated");
        fuzz_decode_precompiled_archives(b"FERRONI\0truncated");
    }

    #[test]
    fn decode_precompiled_archives_paired_seed_attaches_and_tokenizes() {
        let paired_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("corpus")
            .join("decode_precompiled_archives")
            .join("seed-paired.bin");
        let bytes = std::fs::read(&paired_path).expect("read paired archive seed");
        let (container_bytes, index_bytes) =
            split_paired_archive(&bytes).expect("paired seed must split into container and index");
        assert!(container_bytes.starts_with(b"FKBC003\0"));
        assert!(index_bytes.starts_with(b"FKIX002\0"));

        let mut scratch = ScratchArchive::new("paired-seed-test");
        let file = scratch
            .write_and_clone(container_bytes)
            .expect("scratch file must populate");
        let mut registry =
            SyncRegistry::new(Some(controlled_theme()), None).expect("fixed theme must compile");
        registry
            .add_precompiled_patterns_file(file, index_bytes)
            .expect("paired seed must attach cleanly through IndexedArchive::open");
        registry.add_grammar(controlled_raw_grammar(), Vec::new());
        let grammar = registry
            .grammar_for_scope_name("source.fuzz", GrammarConfiguration::default())
            .expect("grammar must compile")
            .expect("grammar was registered");
        grammar
            .compile_all_scanners()
            .expect("scanners must compile from paired archive");
        let result = grammar
            .tokenize_line_with_scopes("word 123 \"str\"", None, TOKENIZE_LIMIT_MILLIS)
            .expect("paired archive tokenization must succeed");
        assert_token_output_invariants(&result, "word 123 \"str\"");
        assert!(!result.tokens.is_empty());

        let diagnostics = registry.regex_diagnostics();
        assert!(
            diagnostics.prepared_bytes_read > 0,
            "paired seed must read indexed archive payload bytes, got {diagnostics:?}"
        );
        assert!(
            diagnostics.loaded_prepared_groups > 0,
            "paired seed must load prepared groups instead of falling back to source, got {diagnostics:?}"
        );
        assert_eq!(
            diagnostics.invalid_prepared_groups, 0,
            "paired seed must have no invalid prepared groups, got {diagnostics:?}"
        );
    }

    #[test]
    fn decorations_exercises_seeds_and_adversarial_graphs() {
        for path in corpus_files("decorations") {
            let bytes = std::fs::read(&path).expect("read seed");
            let html = run_decorations_fuzz(&bytes).unwrap_or_else(|| {
                panic!(
                    "decoration seed {} must reach render_html_with_decorations",
                    path.display()
                )
            });
            assert!(
                html.starts_with("<pre "),
                "decoration seed {} rendered unexpected HTML: {html}",
                path.display()
            );
            // Exercise every truncated prefix (including 1-byte and 2-byte inputs)
            // to catch ByteCursor slice-bound regressions.
            for prefix_len in 0..=bytes.len().min(32) {
                fuzz_decorations(&bytes[..prefix_len]);
            }
        }

        for truncated in [
            &[][..],
            &[0x01][..],
            &[0xff][..],
            &[0x05, b'a'][..],
            &[0x02, b'a', b'b', 0xff][..],
            &[0xff; 256][..],
            &[0x00; 256][..],
        ] {
            fuzz_decorations(truncated);
        }
    }

    #[test]
    fn theme_render_exercises_seeds_and_adversarial_themes() {
        for path in corpus_files("theme_render") {
            let bytes = std::fs::read(&path).expect("read seed");
            let (rendered_css, rendered_multi) = run_theme_render_fuzz(&bytes);
            assert!(
                rendered_css && rendered_multi,
                "theme_render seed {} must reach both render_html_with_css and render_html_with_themes",
                path.display()
            );
        }

        let pretty_multiline_theme = r##"{
  "name": "Pretty Multiline Theme",
  "type": "dark",
  "colors": {
    "editor.foreground": "#d4d4d4",
    "editor.background": "#1e1e1e"
  },
  "tokenColors": [
    {
      "scope": "word.fuzz",
      "settings": {
        "foreground": "#569cd6",
        "fontStyle": "bold"
      }
    }
  ]
}"##;
        let parsed = parse_theme_data("fuzz-theme", pretty_multiline_theme)
            .expect("pretty-printed multiline theme JSON must parse");
        assert_eq!(parsed.name, "Pretty Multiline Theme");
        assert_eq!(
            run_theme_render_fuzz(pretty_multiline_theme.as_bytes()),
            (true, true)
        );
        // A theme named "fuzz-secondary" must still render multi-theme output
        // using the non-colliding fallback secondary theme ID.
        assert_eq!(
            run_theme_render_fuzz(br#"{"name":"fuzz-secondary","type":"dark"}"#),
            (true, true)
        );

        fuzz_theme_render(b"");
        fuzz_theme_render(b"{}\nword 123 \"hello\"");
        fuzz_theme_render(
            br##"{"name":"\" onclick=\"alert(1)","fg":"#112233","bg":"#ffffff","tokenColors":[{"scope":"word.fuzz","settings":{"foreground":"#445566","fontStyle":"bold italic underline strikethrough"}}]}"##,
        );
    }
}
