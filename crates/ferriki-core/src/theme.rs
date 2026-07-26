use crate::types::*;
use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};
use std::sync::Arc;

// ─────────────────────────────────────────────────────────────────────────────
// Theme / scope resolution (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Clone)]
pub(crate) struct ResolvedStyle {
    pub(crate) foreground: Option<Arc<str>>,
    pub(crate) font_style: u8,
}

/// Identity hasher for already-hashed u64 cache keys.
#[derive(Default)]
pub(crate) struct U64IdentityHasher(u64);

impl Hasher for U64IdentityHasher {
    fn finish(&self) -> u64 {
        self.0
    }

    fn write(&mut self, bytes: &[u8]) {
        // Fallback path; u64 keys use `write_u64`.
        let mut h: u64 = 0xcbf29ce484222325;
        for b in bytes {
            h ^= *b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
        self.0 = h;
    }

    fn write_u64(&mut self, i: u64) {
        self.0 = i;
    }
}

pub(crate) type U64HashBuilder = BuildHasherDefault<U64IdentityHasher>;

/// Cache for theme resolution results, keyed by a hash of the scope stack.
pub(crate) struct ThemeCache {
    pub(crate) map: HashMap<u64, ResolvedStyle, U64HashBuilder>,
}

impl ThemeCache {
    pub(crate) fn new() -> Self {
        Self {
            map: HashMap::with_hasher(U64HashBuilder::default()),
        }
    }

    /// Hash scope stack from &[String] without intermediate Vec<&str>
    pub(crate) fn scope_hash_owned(scope_stack: &[String]) -> u64 {
        let mut h: u64 = 0xcbf29ce484222325;
        h ^= scope_stack.len() as u64;
        h = h.wrapping_mul(0x100000001b3);
        for s in scope_stack {
            for b in s.as_bytes() {
                h ^= *b as u64;
                h = h.wrapping_mul(0x100000001b3);
            }
            h ^= 0xff;
            h = h.wrapping_mul(0x100000001b3);
        }
        h
    }

    pub(crate) fn scope_hash_with_extra_owned(
        scope_stack: &[String],
        extra_scopes: &[String],
    ) -> u64 {
        let mut h: u64 = 0xcbf29ce484222325;
        h ^= (scope_stack.len() + extra_scopes.len()) as u64;
        h = h.wrapping_mul(0x100000001b3);
        for s in scope_stack {
            for b in s.as_bytes() {
                h ^= *b as u64;
                h = h.wrapping_mul(0x100000001b3);
            }
            h ^= 0xff;
            h = h.wrapping_mul(0x100000001b3);
        }
        for scope in extra_scopes {
            for b in scope.as_bytes() {
                h ^= *b as u64;
                h = h.wrapping_mul(0x100000001b3);
            }
            h ^= 0xfe;
            h = h.wrapping_mul(0x100000001b3);
        }
        h
    }

    pub(crate) fn resolve_owned(
        &mut self,
        scope_stack: &[String],
        theme: &ThemeData,
    ) -> &ResolvedStyle {
        let key = Self::scope_hash_owned(scope_stack);
        self.map.entry(key).or_insert_with(|| {
            let refs: Vec<&str> = scope_stack.iter().map(String::as_str).collect();
            resolve_token_style(&refs, theme)
        })
    }

    pub(crate) fn resolve_with_extra_owned(
        &mut self,
        scope_stack: &[String],
        extra: &str,
        theme: &ThemeData,
    ) -> &ResolvedStyle {
        let extra_scopes = parse_scope_list(extra);
        let key = Self::scope_hash_with_extra_owned(scope_stack, &extra_scopes);
        self.map.entry(key).or_insert_with(|| {
            let mut refs: Vec<&str> = scope_stack.iter().map(String::as_str).collect();
            refs.extend(extra_scopes.iter().map(String::as_str));
            resolve_token_style(&refs, theme)
        })
    }
}

pub(crate) fn parse_scope_list(value: &str) -> Vec<String> {
    value.split_whitespace().map(str::to_owned).collect()
}

pub(crate) fn scope_component_matches(selector: &str, scope: &str) -> bool {
    selector == scope
        || (scope.starts_with(selector) && scope.as_bytes().get(selector.len()) == Some(&b'.'))
}

pub(crate) fn selector_matches_presplit(parts: &[String], scope_stack: &[&str]) -> Option<usize> {
    if parts.is_empty() {
        return None;
    }

    let innermost = scope_stack.last()?;
    if !scope_component_matches(&parts[parts.len() - 1], innermost) {
        return None;
    }

    if parts.len() == 1 {
        return Some(parts[0].len());
    }

    let mut part_idx = (parts.len() - 2) as isize;
    let parent_scopes = &scope_stack[..scope_stack.len() - 1];
    let mut stack_idx = (parent_scopes.len() as isize) - 1;

    while part_idx >= 0 && stack_idx >= 0 {
        if scope_component_matches(&parts[part_idx as usize], parent_scopes[stack_idx as usize]) {
            part_idx -= 1;
        }
        stack_idx -= 1;
    }

    if part_idx < 0 {
        return Some(parts.iter().map(|p| p.len()).sum());
    }

    None
}

pub(crate) fn resolve_token_style(scope_stack: &[&str], theme: &ThemeData) -> ResolvedStyle {
    let mut best_score: usize = 0;
    let mut best_fg: Option<Arc<str>> = None;
    let mut best_font_style: u8 = 0;
    let mut has_global = false;

    for rule in &theme.settings {
        if rule.scopes.is_empty() {
            if !has_global {
                has_global = true;
                best_fg = rule.foreground.clone();
                best_font_style = rule.font_style;
            }
            continue;
        }

        for parts in &rule.scope_parts {
            if let Some(score) = selector_matches_presplit(parts, scope_stack) {
                if score >= best_score {
                    best_score = score;
                    best_fg = rule.foreground.clone().or(best_fg);
                    best_font_style = rule.font_style;
                }
            }
        }
    }

    ResolvedStyle {
        foreground: best_fg,
        font_style: best_font_style,
    }
}
