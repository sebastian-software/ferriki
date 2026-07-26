use crate::injection::*;
use crate::render::*;
use crate::rule::*;
use crate::scanner::*;
use crate::types::*;
use napi::bindgen_prelude::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

// ─────────────────────────────────────────────────────────────────────────────
// Grammar parsing helpers (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

pub(crate) fn parse_lang(options_json: &str) -> Option<String> {
    let parsed: Value = serde_json::from_str(options_json).ok()?;
    parsed.get("lang")?.as_str().map(str::to_owned)
}

pub(crate) fn parse_theme(options_json: &str) -> Option<String> {
    let parsed: Value = serde_json::from_str(options_json).ok()?;
    parsed.get("theme")?.as_str().map(str::to_owned)
}

pub(crate) fn parse_dual_themes(options_json: &str) -> Option<(String, String)> {
    let parsed: Value = serde_json::from_str(options_json).ok()?;
    let themes = parsed.get("themes")?.as_object()?;
    let light = themes.get("light")?.as_str()?.to_owned();
    let dark = themes.get("dark")?.as_str()?.to_owned();
    Some((light, dark))
}

pub(crate) fn serialize_state_frames(stack: &[StateFrame], root_scope: Option<&str>) -> Value {
    let mut obj = serde_json::Map::new();
    if let Some(scope) = root_scope {
        obj.insert("rootScope".to_owned(), Value::String(scope.to_owned()));
    }
    let frames: Vec<Value> = stack
        .iter()
        .map(|frame| {
            json!({
              "ruleId": frame.rule_id,
              "endRule": frame.end_rule,
              "nameScopes": frame.name_scopes,
              "contentScopes": frame.content_scopes,
            })
        })
        .collect();
    obj.insert("frames".to_owned(), Value::Array(frames));
    Value::Object(obj)
}

pub(crate) fn deserialize_state_frames(value: &Value) -> Option<Vec<StateFrame>> {
    // Support both new format { rootScope, frames: [...] } and legacy bare array
    let arr = if let Some(obj) = value.as_object() {
        obj.get("frames")?.as_array()?
    } else {
        value.as_array()?
    };
    let mut frames = Vec::with_capacity(arr.len());
    for item in arr {
        let obj = item.as_object()?;
        let rule_id = obj.get("ruleId")?.as_i64()? as RuleId;
        let end_rule = obj
            .get("endRule")
            .and_then(|v| v.as_str().map(str::to_owned));
        let name_scopes = obj
            .get("nameScopes")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        let content_scopes = obj
            .get("contentScopes")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        frames.push(StateFrame {
            rule_id,
            _enter_pos: 0,
            _anchor_pos: 0,
            end_rule,
            name_scopes,
            content_scopes,
        });
    }
    Some(frames)
}

pub(crate) fn parse_initial_state_from_options(options_json: &str) -> Option<Vec<StateFrame>> {
    let parsed: Value = serde_json::from_str(options_json).ok()?;
    if let Some(rust_state) = parsed.get("_rustState") {
        return deserialize_state_frames(rust_state);
    }
    None
}

pub(crate) fn parse_grammar_context_code(options_json: &str) -> Option<String> {
    let parsed: Value = serde_json::from_str(options_json).ok()?;
    parsed
        .get("grammarContextCode")?
        .as_str()
        .map(str::to_owned)
}

pub(crate) fn parse_standard_asset_root(options_json: &str) -> Option<String> {
    let parsed: Value = serde_json::from_str(options_json).ok()?;
    parsed.get("standardAssetRoot")?.as_str().map(str::to_owned)
}

pub(crate) fn parse_string_array(value: Option<&Value>) -> Vec<String> {
    let Some(Value::Array(items)) = value else {
        return Vec::new();
    };

    items
        .iter()
        .filter_map(|item| item.as_str().map(str::to_owned))
        .collect::<Vec<_>>()
}

pub(crate) fn parse_grammar_registration(payload_json: &str) -> Result<GrammarRegistration> {
    let payload: Value = serde_json::from_str(payload_json).map_err(|err| {
        Error::from_reason(format!("Failed to parse grammar registration JSON: {err}"))
    })?;

    let payload_obj = payload
        .as_object()
        .ok_or_else(|| Error::from_reason("Grammar registration payload must be an object."))?;

    let has_explicit_grammar = payload_obj.contains_key("grammar")
        || payload_obj.contains_key("patterns")
        || payload_obj.contains_key("repository")
        || payload_obj.contains_key("injections");
    let mut grammar = payload
        .get("grammar")
        .cloned()
        .unwrap_or_else(|| payload.clone());

    let mut scope_name = payload_obj
        .get("scopeName")
        .and_then(Value::as_str)
        .map(str::to_owned);
    if scope_name.is_none() {
        scope_name = grammar
            .get("scopeName")
            .and_then(Value::as_str)
            .map(str::to_owned);
    }
    let scope_name = scope_name
        .ok_or_else(|| Error::from_reason("Grammar registration requires `scopeName`."))?;

    if let Value::Object(ref mut grammar_obj) = grammar {
        grammar_obj
            .entry("scopeName".to_owned())
            .or_insert_with(|| Value::String(scope_name.clone()));
    } else {
        return Err(Error::from_reason(
            "Grammar registration `grammar` must be an object.",
        ));
    }

    let mut aliases = parse_string_array(payload_obj.get("aliases"));
    if aliases.is_empty() {
        aliases = parse_string_array(grammar.get("aliases"));
    }

    let inject_to = parse_string_array(payload_obj.get("injectTo"));

    Ok(GrammarRegistration {
        scope_name,
        grammar,
        aliases,
        has_explicit_grammar,
        inject_to,
    })
}

pub(crate) fn parse_theme_registration(payload_json: &str) -> Result<ThemeData> {
    let payload: Value = serde_json::from_str(payload_json).map_err(|err| {
        Error::from_reason(format!("Failed to parse theme registration JSON: {err}"))
    })?;

    let obj = payload
        .as_object()
        .ok_or_else(|| Error::from_reason("Theme registration payload must be an object."))?;

    let name = obj
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::from_reason("Theme registration requires `name`."))?
        .to_owned();

    let fg = obj
        .get("fg")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();

    let bg = obj
        .get("bg")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();

    let mut settings = Vec::new();
    if let Some(Value::Array(rules)) = obj.get("settings") {
        for rule in rules {
            let rule_obj = match rule.as_object() {
                Some(o) => o,
                None => continue,
            };
            let scopes = match rule_obj.get("scope") {
                Some(Value::Array(arr)) => arr
                    .iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect(),
                _ => Vec::new(),
            };
            let foreground = rule_obj
                .get("foreground")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let font_style = rule_obj
                .get("fontStyle")
                .and_then(Value::as_u64)
                .unwrap_or(0) as u8;
            settings.push(ThemeRule::new(scopes, foreground, font_style));
        }
    }

    Ok(ThemeData {
        name,
        fg_normalized: Arc::<str>::from(normalize_hex_color(&fg)),
        fg,
        bg,
        settings,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Grammar capture parsing (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

pub(crate) fn parse_grammar_captures(value: Option<&Value>) -> Vec<GrammarCapture> {
    let Some(Value::Object(obj)) = value else {
        return Vec::new();
    };

    let mut captures = obj
        .iter()
        .filter_map(|(key, capture)| {
            let index = key.parse::<usize>().ok()?;
            let name = capture
                .as_object()
                .and_then(|entry| entry.get("name"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            Some(GrammarCapture { index, name })
        })
        .collect::<Vec<_>>();

    captures.sort_by_key(|entry| entry.index);
    captures
}

// ─────────────────────────────────────────────────────────────────────────────
// Grammar compilation (caching entry point)
// ─────────────────────────────────────────────────────────────────────────────

pub(crate) fn compile_grammar(
    grammar: &Value,
    grammar_pool: &HashMap<String, Value>,
    injection_map: &HashMap<String, Vec<String>>,
) -> Result<CompiledGrammar> {
    let initialized = init_grammar(grammar, None);
    let obj = initialized
        .as_object()
        .ok_or_else(|| Error::from_reason("Grammar is not an object"))?;
    let repository = obj
        .get("repository")
        .and_then(Value::as_object)
        .ok_or_else(|| Error::from_reason("Grammar has no repository"))?;

    let mut registry = RuleRegistry::new();
    let mut compiled_map: HashMap<String, RuleId> = HashMap::new();

    let self_entry = repository
        .get("$self")
        .ok_or_else(|| Error::from_reason("Grammar missing $self after init"))?;
    let root_rule_id = compile_rule(
        self_entry,
        &mut registry,
        &mut compiled_map,
        repository,
        grammar_pool,
        "root/$self",
        Some(grammar),
    )
    .ok_or_else(|| Error::from_reason("Failed to compile root grammar rule"))?;

    let mut injections = collect_injections(
        &initialized,
        &mut registry,
        &mut compiled_map,
        repository,
        grammar_pool,
    );

    // Collect external injections from the injection map
    let scope_name = grammar
        .get("scopeName")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !scope_name.is_empty() {
        let scope_parts: Vec<&str> = scope_name.split('.').collect();
        for i in 1..=scope_parts.len() {
            let sub_scope = scope_parts[..i].join(".");
            if let Some(injecting_scopes) = injection_map.get(&sub_scope) {
                for injecting_scope in injecting_scopes {
                    if let Some(ext_grammar) = grammar_pool.get(injecting_scope) {
                        collect_external_injection(
                            ext_grammar,
                            &mut injections,
                            &mut registry,
                            &mut compiled_map,
                            repository,
                            grammar_pool,
                        );
                    }
                }
            }
        }
    }

    let mut scanner_cache: HashMap<(RuleId, Option<String>), CompiledScanner> = HashMap::new();
    let root_scanner = build_scanner_for_rule(root_rule_id, &registry, None, false);
    if let Some(scanner) = root_scanner {
        scanner_cache.insert((root_rule_id, None), scanner);
    }

    Ok(CompiledGrammar {
        registry,
        root_rule_id,
        injections,
        scanner_cache,
        injection_scanner_cache: HashMap::new(),
        while_scanner_cache: HashMap::new(),
    })
}
