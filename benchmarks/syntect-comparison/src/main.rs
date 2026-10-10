#[cfg(any(
    all(feature = "syntect-onig", feature = "syntect-fancy"),
    all(feature = "syntect-onig", feature = "ferriki-only"),
    all(feature = "syntect-fancy", feature = "ferriki-only"),
    not(any(
        feature = "syntect-onig",
        feature = "syntect-fancy",
        feature = "ferriki-only"
    ))
))]
compile_error!("enable exactly one of syntect-onig, syntect-fancy, or ferriki-only");

use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

#[cfg(feature = "ferriki-only")]
use ferriki::{Highlighter, RenderOptions, StandardAssetCatalogs, render_html};
use serde::Serialize;
use sha2::{Digest, Sha256};

#[cfg(any(feature = "syntect-onig", feature = "syntect-fancy"))]
use syntect::highlighting::ThemeSet;
#[cfg(any(feature = "syntect-onig", feature = "syntect-fancy"))]
use syntect::html::highlighted_html_for_string;
#[cfg(any(feature = "syntect-onig", feature = "syntect-fancy"))]
use syntect::parsing::SyntaxSet;

#[cfg(feature = "ferriki-only")]
const FERRIKI_THEME: &str = "nord";
#[cfg(any(feature = "syntect-onig", feature = "syntect-fancy"))]
const SYNTECT_THEME: &str = "base16-ocean.dark";
const DEFAULT_FIRST_USE_REPETITIONS: usize = 10;
const DEFAULT_WARMUP_ROUNDS: usize = 5;
const DEFAULT_WARM_SAMPLES: usize = 30;
const CAPTURE_ENGINES: &[&str] = &["syntect-onig", "syntect-fancy", "ferriki-only"];

// This is the fixed common subset of Ferriki's pinned curated 20-format set.
// The selected extensions resolve in syntect's default SyntaxSet; each source
// hash is recorded in every generated report.
const CORPUS: &[(&str, &str, &str, &str)] = &[
    ("java", "Orders.java", "java", "java"),
    ("cpp", "orders.cpp", "cpp", "cpp"),
    ("css", "orders.css", "css", "css"),
    ("html", "orders.html", "html", "html"),
    ("json", "orders.json", "json", "json"),
    ("markdown", "orders.md", "markdown", "md"),
    ("python", "orders.py", "python", "py"),
    ("ruby", "orders.rb", "ruby", "rb"),
    ("rust", "orders.rs", "rust", "rs"),
    ("shellscript", "orders.sh", "bash", "sh"),
    ("yaml", "orders.yaml", "yaml", "yaml"),
];

#[cfg(any(feature = "syntect-onig", feature = "syntect-fancy"))]
// A no-timing probe checks every fixture in Ferriki's curated 20-format
// corpus against syntect's default syntax set. Only verified common documents
// are included in CORPUS; unsupported entries are listed explicitly in the
// report and benchmark README.
const SUPPORT_PROBE: &[(&str, &str, &str)] = &[
    ("astro", "Orders.astro", "astro"),
    ("java", "Orders.java", "java"),
    ("svelte", "Orders.svelte", "svelte"),
    ("swift", "Orders.swift", "swift"),
    ("tsx", "Orders.tsx", "tsx"),
    ("vue", "Orders.vue", "vue"),
    ("cpp", "orders.cpp", "cpp"),
    ("css", "orders.css", "css"),
    ("html", "orders.html", "html"),
    ("json", "orders.json", "json"),
    ("markdown", "orders.md", "md"),
    ("mdx", "orders.mdx", "mdx"),
    ("python", "orders.py", "py"),
    ("ruby", "orders.rb", "rb"),
    ("rust", "orders.rs", "rs"),
    ("scss", "orders.scss", "scss"),
    ("shellscript", "orders.sh", "sh"),
    ("toml", "orders.toml", "toml"),
    ("typescript", "orders.ts", "ts"),
    ("yaml", "orders.yaml", "yaml"),
];

#[derive(Clone)]
struct Document {
    id: String,
    file: String,
    ferriki_language: String,
    syntect_extension: String,
    source_path: String,
    source: String,
    bytes: usize,
    lines: usize,
    sha256: String,
}

#[derive(Serialize)]
struct CorpusEntry {
    id: String,
    file: String,
    ferriki_language: String,
    syntect_extension: String,
    resolved_syntax: String,
    source_path: String,
    bytes: usize,
    lines: usize,
    source_sha256: String,
}

#[derive(Serialize)]
struct ExcludedInput {
    id: String,
    file: String,
    syntect_extension: String,
    source_sha256: String,
    reason: String,
}

const EXCLUDED_FROM_COMPARISON: &[(&str, &str, &str)] = &[
    ("astro", "Orders.astro", "astro"),
    ("svelte", "Orders.svelte", "svelte"),
    ("swift", "Orders.swift", "swift"),
    ("tsx", "Orders.tsx", "tsx"),
    ("vue", "Orders.vue", "vue"),
    ("mdx", "orders.mdx", "mdx"),
    ("scss", "orders.scss", "scss"),
    ("toml", "orders.toml", "toml"),
    ("typescript", "orders.ts", "ts"),
];

#[derive(Serialize)]
struct DocumentSamples {
    document_id: String,
    samples_ns: Vec<u64>,
}

#[derive(Serialize)]
struct Report {
    schema_version: u32,
    benchmark: String,
    engine: String,
    engine_version: String,
    regex_mode: String,
    render_api: String,
    theme: String,
    profile: String,
    build: BuildProvenance,
    capture: CaptureMetadata,
    captured_at_unix_seconds: u64,
    machine: Machine,
    source: SourceProvenance,
    inputs: Vec<CorpusEntry>,
    excluded_inputs: Vec<ExcludedInput>,
    samples: SampleSet,
    output_validation: OutputValidation,
    input_integrity: InputIntegrity,
    rendered_byte_sink: u64,
}

#[derive(Serialize)]
struct BuildProvenance {
    binary_sha256_before: String,
    binary_sha256_after: String,
    binary_unchanged: bool,
    cargo_feature: String,
    cargo_command: String,
    target: String,
    release_profile: String,
    rustflags: String,
}

#[derive(Serialize)]
struct CaptureMetadata {
    round: String,
    engine_order: Vec<String>,
    engine_position: usize,
}

#[derive(Serialize)]
struct InputIntegrity {
    manifest_sha256_before: String,
    manifest_sha256_after: String,
    unchanged: bool,
}

#[derive(Serialize)]
struct Machine {
    os: String,
    architecture: String,
    cpu: String,
    rustc: String,
}

#[derive(Serialize)]
struct SourceProvenance {
    revision: String,
    working_tree_clean: bool,
    benchmark_lock_sha256: String,
    ferriki_assets_release_manifest_sha256: String,
    benchmark_sources: Vec<FileHash>,
}

#[derive(Serialize)]
struct FileHash {
    path: String,
    sha256: String,
}

#[derive(Serialize)]
struct SampleSet {
    first_use_repetitions: usize,
    first_use_definition: String,
    setup_samples_ns: Vec<u64>,
    first_use_samples: Vec<DocumentSamples>,
    first_use_order: Vec<Vec<String>>,
    warmup_rounds: usize,
    warm_samples_per_document: usize,
    warm_samples: Vec<DocumentSamples>,
    warm_order: Vec<Vec<String>>,
    setup_median_ns: u64,
    first_use_document_median_range_ns: [u64; 2],
    warm_document_median_range_ns: [u64; 2],
}

#[derive(Serialize)]
struct OutputValidation {
    documents: usize,
    source_preserved: bool,
    highlighted_markup: bool,
    note: String,
}

struct Engine {
    #[cfg(any(feature = "syntect-onig", feature = "syntect-fancy"))]
    syntaxes: SyntaxSet,
    #[cfg(any(feature = "syntect-onig", feature = "syntect-fancy"))]
    themes: ThemeSet,
    #[cfg(feature = "ferriki-only")]
    highlighter: ferriki::Highlighter,
}

impl Engine {
    fn new(_repo_root: &Path) -> Result<Self, Box<dyn Error>> {
        #[cfg(any(feature = "syntect-onig", feature = "syntect-fancy"))]
        {
            let syntaxes = SyntaxSet::load_defaults_newlines();
            let themes = ThemeSet::load_defaults();
            if !themes.themes.contains_key(SYNTECT_THEME) {
                return Err(format!("syntect default theme `{SYNTECT_THEME}` is missing").into());
            }
            Ok(Self { syntaxes, themes })
        }
        #[cfg(feature = "ferriki-only")]
        {
            let assets = StandardAssetCatalogs::load_from_root(&_repo_root.join("assets/shiki"))?;
            let highlighter = Highlighter::builder()
                .with_assets(assets)
                .load_themes([FERRIKI_THEME])
                .build()?;
            Ok(Self { highlighter })
        }
    }

    fn render(&mut self, document: &Document) -> Result<String, Box<dyn Error>> {
        #[cfg(any(feature = "syntect-onig", feature = "syntect-fancy"))]
        {
            let syntax = self
                .syntaxes
                .find_syntax_by_extension(&document.syntect_extension)
                .filter(|syntax| syntax.name != "Plain Text")
                .ok_or_else(|| {
                    format!(
                        "syntect has no exact non-plain default syntax for extension `{}` ({})",
                        document.syntect_extension, document.file
                    )
                })?;
            let theme = self
                .themes
                .themes
                .get(SYNTECT_THEME)
                .ok_or_else(|| format!("syntect default theme `{SYNTECT_THEME}` is missing"))?;
            Ok(highlighted_html_for_string(
                &document.source,
                &self.syntaxes,
                syntax,
                theme,
            )?)
        }
        #[cfg(feature = "ferriki-only")]
        {
            let tokens = self.highlighter.highlight(
                &document.source,
                &document.ferriki_language,
                FERRIKI_THEME,
            )?;
            Ok(render_html(&tokens, &RenderOptions::default()))
        }
    }

    fn resolved_syntax(&self, document: &Document) -> Result<String, Box<dyn Error>> {
        #[cfg(any(feature = "syntect-onig", feature = "syntect-fancy"))]
        {
            Ok(self
                .syntaxes
                .find_syntax_by_extension(&document.syntect_extension)
                .filter(|syntax| syntax.name != "Plain Text")
                .ok_or_else(|| {
                    format!(
                        "syntect has no exact non-plain default syntax for extension `{}` ({})",
                        document.syntect_extension, document.file
                    )
                })?
                .name
                .clone())
        }
        #[cfg(feature = "ferriki-only")]
        {
            Ok(document.ferriki_language.clone())
        }
    }
}

fn main() -> Result<(), Box<dyn Error>> {
    let mut args = std::env::args().skip(1);
    let command = args.next().unwrap_or_default();
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir.join("../..").canonicalize()?;
    let documents = load_corpus(&repo_root)?;

    match command.as_str() {
        "validate" => validate(&repo_root, &documents),
        "probe-syntect" => probe_syntect(&repo_root),
        "measure" => {
            let output = args.next().ok_or(
                "usage: ferriki-syntect-comparison measure <report.json> [--first-repetitions N] [--warmup-rounds N] [--warm-samples N]",
            )?;
            let mut first_repetitions = DEFAULT_FIRST_USE_REPETITIONS;
            let mut warmup_rounds = DEFAULT_WARMUP_ROUNDS;
            let mut warm_samples_per_document = DEFAULT_WARM_SAMPLES;
            let mut capture_round = None;
            let mut capture_order = None;
            while let Some(option) = args.next() {
                let value = args.next().ok_or("benchmark option is missing a value")?;
                match option.as_str() {
                    "--first-repetitions" => first_repetitions = value.parse()?,
                    "--warmup-rounds" => warmup_rounds = value.parse()?,
                    "--warm-samples" => warm_samples_per_document = value.parse()?,
                    "--capture-round" => capture_round = Some(value),
                    "--capture-order" => {
                        capture_order = Some(value.split(',').map(str::to_owned).collect::<Vec<_>>())
                    }
                    _ => return Err(format!("unknown benchmark option `{option}`").into()),
                }
            }
            let capture = capture_metadata(
                capture_round.ok_or("--capture-round A or B is required")?,
                capture_order.ok_or("--capture-order is required")?,
            )?;
            if first_repetitions < 10 || warmup_rounds < 1 || warm_samples_per_document < 30 {
                return Err(
                    "use at least 10 first-use repetitions, one warmup, and 30 warm samples".into(),
                );
            }
            let report = measure(
                &repo_root,
                &documents,
                first_repetitions,
                warmup_rounds,
                warm_samples_per_document,
                capture,
            )?;
            write_report(Path::new(&output), &report)?;
            println!(
                "Wrote {} report for {} documents to {}",
                report.engine,
                documents.len(),
                output
            );
            Ok(())
        }
        _ => Err(
            "usage: ferriki-syntect-comparison validate | probe-syntect | measure <report.json> --capture-round A|B --capture-order onig,fancy,ferriki [options]".into(),
        ),
    }
}

#[cfg(any(feature = "syntect-onig", feature = "syntect-fancy"))]
fn probe_syntect(repo_root: &Path) -> Result<(), Box<dyn Error>> {
    let syntaxes = SyntaxSet::load_defaults_newlines();
    for (id, file, extension) in SUPPORT_PROBE {
        let source_path = repo_root
            .join("node/benchmarks/curated/fixtures")
            .join(file);
        let source = fs::read(&source_path)?;
        match syntaxes.find_syntax_by_extension(extension) {
            Some(syntax) if syntax.name != "Plain Text" => println!(
                "{id}\t{file}\t{extension}\t{}\t{}",
                syntax.name,
                sha256(&source)
            ),
            Some(syntax) => println!(
                "{id}\t{file}\t{extension}\tUNSUPPORTED: resolved to {}\t{}",
                syntax.name,
                sha256(&source)
            ),
            None => println!(
                "{id}\t{file}\t{extension}\tUNSUPPORTED: no exact extension entry\t{}",
                sha256(&source)
            ),
        }
    }
    println!("AVAILABLE DEFAULT SYNTAX NAMES:");
    for syntax in syntaxes.syntaxes() {
        println!(
            "SYNTAX\t{}\t{}",
            syntax.name,
            syntax.file_extensions.join(",")
        );
    }
    Ok(())
}

#[cfg(feature = "ferriki-only")]
fn probe_syntect(_repo_root: &Path) -> Result<(), Box<dyn Error>> {
    Err("probe-syntect is available only in a syntect build".into())
}

fn capture_metadata(round: String, order: Vec<String>) -> Result<CaptureMetadata, Box<dyn Error>> {
    if round != "A" && round != "B" {
        return Err("capture round must be A or B".into());
    }
    if order.len() != CAPTURE_ENGINES.len()
        || CAPTURE_ENGINES
            .iter()
            .any(|engine| !order.contains(&engine.to_string()))
    {
        return Err(format!(
            "capture order must contain each engine once: {}",
            CAPTURE_ENGINES.join(",")
        )
        .into());
    }
    let position = order
        .iter()
        .position(|engine| engine == engine_id())
        .ok_or_else(|| format!("capture order omits {}", engine_id()))?;
    Ok(CaptureMetadata {
        round,
        engine_order: order,
        engine_position: position + 1,
    })
}

fn load_corpus(repo_root: &Path) -> Result<Vec<Document>, Box<dyn Error>> {
    CORPUS
        .iter()
        .map(|(id, file, ferriki_language, extension)| {
            let source_path = format!("node/benchmarks/curated/fixtures/{file}");
            let source = fs::read_to_string(repo_root.join(&source_path))?;
            Ok(Document {
                id: (*id).to_owned(),
                file: (*file).to_owned(),
                ferriki_language: (*ferriki_language).to_owned(),
                syntect_extension: (*extension).to_owned(),
                source_path,
                bytes: source.len(),
                lines: source.lines().count(),
                sha256: sha256(source.as_bytes()),
                source,
            })
        })
        .collect()
}

fn validate(repo_root: &Path, documents: &[Document]) -> Result<(), Box<dyn Error>> {
    let mut engine = Engine::new(repo_root)?;
    for document in documents {
        let html = engine.render(document)?;
        let visible = visible_code(&html)?;
        if visible != document.source {
            return Err(source_preservation_error(document, &visible));
        }
        if !html.contains("<span") {
            return Err(format!("{} produced no highlighted span markup", document.file).into());
        }
    }
    println!(
        "Validated {} {} HTML documents; source text and span markup are present.",
        documents.len(),
        engine_name()
    );
    Ok(())
}

fn measure(
    repo_root: &Path,
    documents: &[Document],
    first_repetitions: usize,
    warmup_rounds: usize,
    warm_samples_per_document: usize,
    capture: CaptureMetadata,
) -> Result<Report, Box<dyn Error>> {
    // Correctness and source preservation run before any timed lane.
    let mut validation_engine = Engine::new(repo_root)?;
    let mut resolved_syntax = Vec::with_capacity(documents.len());
    for document in documents {
        resolved_syntax.push(validation_engine.resolved_syntax(document)?);
        let html = validation_engine.render(document)?;
        let visible = visible_code(&html)?;
        if visible != document.source {
            return Err(source_preservation_error(document, &visible));
        }
        if !html.contains("<span") {
            return Err(format!("{} produced no highlighted span markup", document.file).into());
        }
    }
    drop(validation_engine);

    let input_manifest_sha256_before = fixture_manifest_sha256(repo_root)?;
    verify_documents_unchanged(repo_root, documents)?;
    let binary_sha256_before = current_binary_sha256()?;
    let mut setup_samples_ns = Vec::with_capacity(first_repetitions);
    let mut first_use_samples = new_samples(documents, first_repetitions);
    let mut first_use_order = Vec::with_capacity(first_repetitions);
    let mut rendered_byte_sink = 0u64;
    for repetition in 0..first_repetitions {
        let setup_start = Instant::now();
        let mut engine = Engine::new(repo_root)?;
        setup_samples_ns.push(elapsed_ns(setup_start));
        let order = rotated_order(documents.len(), repetition);
        let mut order_ids = Vec::with_capacity(order.len());
        for index in order {
            let document = &documents[index];
            let started = Instant::now();
            let html = engine.render(document)?;
            let elapsed = elapsed_ns(started);
            rendered_byte_sink = rendered_byte_sink.wrapping_add(html.len() as u64);
            std::hint::black_box(rendered_byte_sink);
            first_use_samples[index].samples_ns.push(elapsed);
            order_ids.push(document.id.clone());
        }
        first_use_order.push(order_ids);
    }

    let mut warm_engine = Engine::new(repo_root)?;
    for round in 0..warmup_rounds {
        for index in rotated_order(documents.len(), round) {
            let html = warm_engine.render(&documents[index])?;
            rendered_byte_sink = rendered_byte_sink.wrapping_add(html.len() as u64);
        }
    }
    let mut warm_samples = new_samples(documents, warm_samples_per_document);
    let mut warm_order = Vec::with_capacity(warm_samples_per_document);
    for round in 0..warm_samples_per_document {
        let order = rotated_order(documents.len(), round);
        let mut order_ids = Vec::with_capacity(order.len());
        for index in order {
            let document = &documents[index];
            let started = Instant::now();
            let html = warm_engine.render(document)?;
            let elapsed = elapsed_ns(started);
            rendered_byte_sink = rendered_byte_sink.wrapping_add(html.len() as u64);
            std::hint::black_box(rendered_byte_sink);
            warm_samples[index].samples_ns.push(elapsed);
            order_ids.push(document.id.clone());
        }
        warm_order.push(order_ids);
    }
    std::hint::black_box(rendered_byte_sink);

    let input_manifest_sha256_after =
        verify_inputs_unchanged(repo_root, documents, &input_manifest_sha256_before)?;
    let binary_sha256_after = current_binary_sha256()?;
    if binary_sha256_before != binary_sha256_after {
        return Err("benchmark executable changed during measurement".into());
    }
    let source = source_provenance(repo_root)?;
    let machine = machine()?;
    Ok(Report {
        schema_version: 1,
        benchmark: "ferriki-syntect-rust-html".to_owned(),
        engine: engine_name().to_owned(),
        engine_version: engine_version().to_owned(),
        regex_mode: regex_mode().to_owned(),
        render_api: render_api().to_owned(),
        theme: theme_name().to_owned(),
        profile: if cfg!(debug_assertions) { "debug" } else { "release" }.to_owned(),
        build: build_provenance(binary_sha256_before, binary_sha256_after)?,
        capture,
        captured_at_unix_seconds: SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs(),
        machine,
        source,
        inputs: documents
            .iter()
            .zip(resolved_syntax)
            .map(|(document, resolved_syntax)| CorpusEntry {
                id: document.id.clone(),
                file: document.file.clone(),
                ferriki_language: document.ferriki_language.clone(),
                syntect_extension: document.syntect_extension.clone(),
                resolved_syntax,
                source_path: document.source_path.clone(),
                bytes: document.bytes,
                lines: document.lines,
                source_sha256: document.sha256.clone(),
            })
            .collect(),
        excluded_inputs: excluded_inputs(repo_root)?,
        samples: SampleSet {
            first_use_repetitions: first_repetitions,
            first_use_definition: "fresh in-process engine instance for each repetition; setup is timed separately, then the first corpus pass is timed; OS process startup and cold OS caches are excluded".to_owned(),
            setup_median_ns: median(&setup_samples_ns),
            setup_samples_ns,
            first_use_document_median_range_ns: median_range(&first_use_samples),
            first_use_samples,
            first_use_order,
            warmup_rounds,
            warm_samples_per_document,
            warm_document_median_range_ns: median_range(&warm_samples),
            warm_samples,
            warm_order,
        },
        output_validation: OutputValidation {
            documents: documents.len(),
            source_preserved: true,
            highlighted_markup: true,
            note: "Source preservation and span markup were validated before timing; engine-specific HTML is not compared for equality.".to_owned(),
        },
        input_integrity: InputIntegrity {
            manifest_sha256_before: input_manifest_sha256_before.clone(),
            manifest_sha256_after: input_manifest_sha256_after.clone(),
            unchanged: input_manifest_sha256_before == input_manifest_sha256_after,
        },
        rendered_byte_sink,
    })
}

fn source_preservation_error(document: &Document, visible: &str) -> Box<dyn Error> {
    let expected = document.source.chars().collect::<Vec<_>>();
    let actual = visible.chars().collect::<Vec<_>>();
    let mismatch = expected
        .iter()
        .zip(&actual)
        .position(|(expected, actual)| expected != actual)
        .unwrap_or(expected.len().min(actual.len()));
    let context = |characters: &[char]| {
        let start = mismatch.saturating_sub(40);
        let end = (mismatch + 80).min(characters.len());
        characters[start..end].iter().collect::<String>()
    };
    format!(
        "{} changed the source text (expected {} bytes, got {} bytes; first difference at character {}; expected around {:?}; visible around {:?})",
        document.file,
        document.source.len(),
        visible.len(),
        mismatch,
        context(&expected),
        context(&actual)
    )
    .into()
}

fn new_samples(documents: &[Document], capacity: usize) -> Vec<DocumentSamples> {
    documents
        .iter()
        .map(|document| DocumentSamples {
            document_id: document.id.clone(),
            samples_ns: Vec::with_capacity(capacity),
        })
        .collect()
}

fn excluded_inputs(repo_root: &Path) -> Result<Vec<ExcludedInput>, Box<dyn Error>> {
    EXCLUDED_FROM_COMPARISON
        .iter()
        .map(|(id, file, extension)| {
            let path = repo_root
                .join("node/benchmarks/curated/fixtures")
                .join(file);
            Ok(ExcludedInput {
                id: (*id).to_owned(),
                file: (*file).to_owned(),
                syntect_extension: (*extension).to_owned(),
                source_sha256: sha256(&fs::read(path)?),
                reason: "no exact extension mapping in syntect 5.3.0's bundled default SyntaxSet; no alternate grammar was substituted".to_owned(),
            })
        })
        .collect()
}

fn fixture_manifest_sha256(repo_root: &Path) -> Result<String, Box<dyn Error>> {
    let mut paths = CORPUS
        .iter()
        .map(|(_, file, _, _)| format!("node/benchmarks/curated/fixtures/{file}"))
        .chain(
            EXCLUDED_FROM_COMPARISON
                .iter()
                .map(|(_, file, _)| format!("node/benchmarks/curated/fixtures/{file}")),
        )
        .collect::<Vec<_>>();
    paths.sort();
    let mut manifest = String::new();
    for path in paths {
        manifest.push_str(&path);
        manifest.push('\t');
        manifest.push_str(&sha256(&fs::read(repo_root.join(&path))?));
        manifest.push('\n');
    }
    Ok(sha256(manifest.as_bytes()))
}

fn verify_inputs_unchanged(
    repo_root: &Path,
    documents: &[Document],
    expected_manifest: &str,
) -> Result<String, Box<dyn Error>> {
    verify_documents_unchanged(repo_root, documents)?;
    let current_manifest = fixture_manifest_sha256(repo_root)?;
    if current_manifest != expected_manifest {
        return Err(
            "one or more of the 20 benchmark fixture files changed during measurement".into(),
        );
    }
    Ok(current_manifest)
}

fn verify_documents_unchanged(
    repo_root: &Path,
    documents: &[Document],
) -> Result<(), Box<dyn Error>> {
    for document in documents {
        let current = sha256(&fs::read(repo_root.join(&document.source_path))?);
        if current != document.sha256 {
            return Err(format!(
                "input differs from the loaded source: {} (expected {}, found {current})",
                document.source_path, document.sha256
            )
            .into());
        }
    }
    Ok(())
}

fn current_binary_sha256() -> Result<String, Box<dyn Error>> {
    Ok(sha256(&fs::read(std::env::current_exe()?)?))
}

fn build_provenance(
    binary_sha256_before: String,
    binary_sha256_after: String,
) -> Result<BuildProvenance, Box<dyn Error>> {
    let target_dir = if engine_id() == "ferriki-only" {
        "ferriki"
    } else {
        engine_id()
    };
    Ok(BuildProvenance {
        binary_unchanged: binary_sha256_before == binary_sha256_after,
        binary_sha256_before,
        binary_sha256_after,
        cargo_feature: engine_id().to_owned(),
        cargo_command: format!(
            "CARGO_TARGET_DIR=/tmp/ferriki-syntect-{target_dir} cargo build --manifest-path benchmarks/syntect-comparison/Cargo.toml --release --locked --no-default-features --features {}",
            engine_id()
        ),
        target: option_env!("BENCHMARK_TARGET")
            .unwrap_or("unknown target")
            .to_owned(),
        release_profile:
            "release; opt-level=3; debug=false; strip=symbols; lto=fat; codegen-units=1".to_owned(),
        rustflags: option_env!("BENCHMARK_RUSTFLAGS")
            .unwrap_or("<unset>")
            .to_owned(),
    })
}

fn source_provenance(repo_root: &Path) -> Result<SourceProvenance, Box<dyn Error>> {
    let revision = git_output(repo_root, &["rev-parse", "HEAD"])?;
    let status = git_output(
        repo_root,
        &["status", "--porcelain", "--untracked-files=all"],
    )?;
    let benchmark_sources = [
        "benchmarks/syntect-comparison/Cargo.toml",
        "benchmarks/syntect-comparison/Cargo.lock",
        "benchmarks/syntect-comparison/README.md",
        "benchmarks/syntect-comparison/build.rs",
        "benchmarks/syntect-comparison/src/main.rs",
    ]
    .iter()
    .map(|path| {
        Ok(FileHash {
            path: (*path).to_owned(),
            sha256: sha256(&fs::read(repo_root.join(path))?),
        })
    })
    .collect::<Result<Vec<_>, Box<dyn Error>>>()?;
    Ok(SourceProvenance {
        revision,
        working_tree_clean: status.is_empty(),
        benchmark_lock_sha256: sha256(&fs::read(
            repo_root.join("benchmarks/syntect-comparison/Cargo.lock"),
        )?),
        ferriki_assets_release_manifest_sha256: sha256(&fs::read(
            repo_root.join("assets/shiki/release-manifest.json"),
        )?),
        benchmark_sources,
    })
}

fn machine() -> Result<Machine, Box<dyn Error>> {
    let rustc_output = Command::new("rustc").arg("-Vv").output()?;
    let rustc = String::from_utf8(rustc_output.stdout)?.trim().to_owned();
    let cpu = if cfg!(target_os = "macos") {
        command_output("sysctl", &["-n", "machdep.cpu.brand_string"])
            .or_else(|_| command_output("sysctl", &["-n", "hw.model"]))
            .unwrap_or_else(|_| "unknown".to_owned())
    } else if cfg!(target_os = "linux") {
        fs::read_to_string("/proc/cpuinfo")
            .ok()
            .and_then(|info| {
                info.lines()
                    .find_map(|line| line.strip_prefix("model name\t: ").map(str::to_owned))
            })
            .unwrap_or_else(|| "unknown".to_owned())
    } else {
        "unknown".to_owned()
    };
    Ok(Machine {
        os: std::env::consts::OS.to_owned(),
        architecture: std::env::consts::ARCH.to_owned(),
        cpu,
        rustc,
    })
}

fn write_report(path: &Path, report: &Report) -> Result<(), Box<dyn Error>> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, serde_json::to_vec_pretty(report)?)?;
    Ok(())
}

fn rotated_order(length: usize, round: usize) -> Vec<usize> {
    let offset = (round * 7) % length;
    let mut order = (0..length)
        .map(|index| (index + offset) % length)
        .collect::<Vec<_>>();
    if round % 2 == 1 {
        order.reverse();
    }
    order
}

fn visible_code(html: &str) -> Result<String, Box<dyn Error>> {
    let (container_start, close_tag, preformatted) = if let Some(code_open) = html.find("<code") {
        (code_open, "</code>", false)
    } else if let Some(pre_open) = html.find("<pre") {
        (pre_open, "</pre>", true)
    } else {
        return Err("HTML output has no code or pre element".into());
    };
    let content_start = html[container_start..]
        .find('>')
        .map(|offset| container_start + offset + 1)
        .ok_or("HTML code container has no closing bracket")?;
    let content_end = html[content_start..]
        .find(close_tag)
        .map(|offset| content_start + offset)
        .ok_or("HTML output has no closing code container")?;
    let mut in_tag = false;
    let mut visible = String::new();
    for character in html[content_start..content_end].chars() {
        match character {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => visible.push(character),
            _ => {}
        }
    }
    let mut decoded = decode_html_entities(&visible);
    // HTML parsers ignore one LF immediately after a <pre> start tag.
    if preformatted && decoded.starts_with('\n') {
        decoded.remove(0);
    }
    Ok(decoded)
}

fn decode_html_entities(source: &str) -> String {
    const ENTITIES: &[(&str, char)] = &[
        ("&quot;", '"'),
        ("&nbsp;", '\u{00a0}'),
        ("&amp;", '&'),
        ("&lt;", '<'),
        ("&gt;", '>'),
    ];
    let mut result = String::with_capacity(source.len());
    let mut rest = source;
    while !rest.is_empty() {
        if rest.starts_with("&#") {
            if let Some(end) = rest.find(';') {
                let encoded = &rest[2..end];
                let decoded = if let Some(hex) = encoded
                    .strip_prefix('x')
                    .or_else(|| encoded.strip_prefix('X'))
                {
                    u32::from_str_radix(hex, 16).ok()
                } else {
                    encoded.parse::<u32>().ok()
                }
                .and_then(char::from_u32);
                if let Some(character) = decoded {
                    result.push(character);
                    rest = &rest[end + 1..];
                    continue;
                }
            }
        }
        if let Some((entity, replacement)) =
            ENTITIES.iter().find(|(entity, _)| rest.starts_with(entity))
        {
            result.push(*replacement);
            rest = &rest[entity.len()..];
        } else {
            let character = rest.chars().next().expect("source is non-empty");
            result.push(character);
            rest = &rest[character.len_utf8()..];
        }
    }
    result
}

fn median(values: &[u64]) -> u64 {
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    if sorted.len() % 2 == 0 {
        (sorted[sorted.len() / 2 - 1] + sorted[sorted.len() / 2]) / 2
    } else {
        sorted[sorted.len() / 2]
    }
}

fn median_range(samples: &[DocumentSamples]) -> [u64; 2] {
    let mut medians = samples
        .iter()
        .map(|sample| median(&sample.samples_ns))
        .collect::<Vec<_>>();
    medians.sort_unstable();
    [medians[0], medians[medians.len() - 1]]
}

fn elapsed_ns(start: Instant) -> u64 {
    start.elapsed().as_nanos() as u64
}

fn git_output(repo_root: &Path, args: &[&str]) -> Result<String, Box<dyn Error>> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo_root)
        .args(args)
        .output()?;
    if !output.status.success() {
        return Err(format!("git {} failed", args.join(" ")).into());
    }
    Ok(String::from_utf8(output.stdout)?.trim().to_owned())
}

fn command_output(command: &str, args: &[&str]) -> Result<String, Box<dyn Error>> {
    let output = Command::new(command).args(args).output()?;
    if !output.status.success() {
        return Err(format!("{command} {} failed", args.join(" ")).into());
    }
    Ok(String::from_utf8(output.stdout)?.trim().to_owned())
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(feature = "syntect-onig")]
fn engine_id() -> &'static str {
    "syntect-onig"
}
#[cfg(feature = "syntect-fancy")]
fn engine_id() -> &'static str {
    "syntect-fancy"
}
#[cfg(feature = "ferriki-only")]
fn engine_id() -> &'static str {
    "ferriki-only"
}

#[cfg(feature = "syntect-onig")]
fn engine_name() -> &'static str {
    "syntect"
}
#[cfg(feature = "syntect-fancy")]
fn engine_name() -> &'static str {
    "syntect"
}
#[cfg(feature = "ferriki-only")]
fn engine_name() -> &'static str {
    "Ferriki"
}

#[cfg(feature = "syntect-onig")]
fn engine_version() -> &'static str {
    "5.3.0"
}
#[cfg(feature = "syntect-fancy")]
fn engine_version() -> &'static str {
    "5.3.0"
}
#[cfg(feature = "ferriki-only")]
fn engine_version() -> &'static str {
    "0.13.0"
}

#[cfg(feature = "syntect-onig")]
fn regex_mode() -> &'static str {
    "regex-onig"
}
#[cfg(feature = "syntect-fancy")]
fn regex_mode() -> &'static str {
    "regex-fancy"
}
#[cfg(feature = "ferriki-only")]
fn regex_mode() -> &'static str {
    "Ferriki native TextMate scanner"
}

#[cfg(any(feature = "syntect-onig", feature = "syntect-fancy"))]
fn render_api() -> &'static str {
    "syntect::html::highlighted_html_for_string"
}
#[cfg(feature = "ferriki-only")]
fn render_api() -> &'static str {
    "ferriki::Highlighter::highlight + ferriki::render_html"
}

#[cfg(any(feature = "syntect-onig", feature = "syntect-fancy"))]
fn theme_name() -> &'static str {
    SYNTECT_THEME
}
#[cfg(feature = "ferriki-only")]
fn theme_name() -> &'static str {
    FERRIKI_THEME
}
