use crate::types::*;
use ferroni::scanner::{OnigString, Scanner, ScannerFindOptions};

// ─────────────────────────────────────────────────────────────────────────────
// Scanner compilation (port of Rule.collectPatterns / _getCachedCompiledPatterns)
// ─────────────────────────────────────────────────────────────────────────────

/// Maximum number of regex patterns allowed per Scanner.
pub(crate) const MAX_SCANNER_PATTERNS: usize = 256;

/// Recursively collect (regex, rule_id) pairs from a rule's patterns.
pub(crate) fn collect_patterns(
    rule_id: RuleId,
    registry: &RuleRegistry,
    out: &mut Vec<(String, RuleId)>,
) {
    let Some(rule) = registry.get(rule_id) else {
        return;
    };

    match rule {
        Rule::Match { match_re, _id, .. } => {
            out.push((match_re.clone(), *_id));
        }
        Rule::IncludeOnly { patterns, .. } => {
            for &pat_id in patterns {
                if out.len() >= MAX_SCANNER_PATTERNS {
                    break;
                }
                collect_patterns(pat_id, registry, out);
            }
        }
        Rule::BeginEnd { begin_re, _id, .. } => {
            out.push((begin_re.clone(), *_id));
        }
        Rule::BeginWhile { begin_re, _id, .. } => {
            out.push((begin_re.clone(), *_id));
        }
    }
}

/// Build a compiled scanner for matching against a rule's child patterns,
/// optionally including an end pattern.
pub(crate) fn build_scanner_for_rule(
    rule_id: RuleId,
    registry: &RuleRegistry,
    end_re: Option<&str>,
    apply_end_pattern_last: bool,
) -> Option<CompiledScanner> {
    let mut pattern_pairs: Vec<(String, RuleId)> = Vec::new();

    // Collect child patterns
    let rule = registry.get(rule_id)?;

    let child_patterns = match rule {
        Rule::IncludeOnly { patterns, .. } => patterns.clone(),
        Rule::BeginEnd { patterns, .. } => patterns.clone(),
        Rule::BeginWhile { patterns, .. } => patterns.clone(),
        Rule::Match { .. } => Vec::new(),
    };

    // Insert end pattern (if any) at beginning or end based on applyEndPatternLast
    if !apply_end_pattern_last {
        if let Some(end) = end_re {
            pattern_pairs.push((end.to_owned(), END_RULE_ID));
        }
    }

    for &pat_id in &child_patterns {
        if pattern_pairs.len() >= MAX_SCANNER_PATTERNS {
            break;
        }
        collect_patterns(pat_id, registry, &mut pattern_pairs);
    }

    if apply_end_pattern_last {
        if let Some(end) = end_re {
            if pattern_pairs.len() < MAX_SCANNER_PATTERNS {
                pattern_pairs.push((end.to_owned(), END_RULE_ID));
            }
        }
    }

    if pattern_pairs.is_empty() {
        return None;
    }

    // Build scanner, filtering out invalid regexes
    let regexes: Vec<String> = pattern_pairs.iter().map(|(re, _)| re.clone()).collect();
    let rule_ids: Vec<RuleId> = pattern_pairs.iter().map(|(_, id)| *id).collect();

    if regexes.len() > 128 {
        // For large pattern sets, try building the scanner directly
        let regex_refs: Vec<&str> = regexes.iter().map(String::as_str).collect();
        match Scanner::new(&regex_refs) {
            Ok(scanner) => {
                let single_scanners = std::iter::repeat_with(|| None)
                    .take(regexes.len())
                    .collect();
                Some(CompiledScanner {
                    scanner,
                    rule_ids,
                    regexes,
                    single_scanners,
                })
            }
            Err(_) => None,
        }
    } else {
        // For smaller sets, validate each regex individually
        let mut valid_regexes = Vec::new();
        let mut valid_ids = Vec::new();
        for (regex, rule_id) in regexes.into_iter().zip(rule_ids) {
            if Scanner::new(&[regex.as_str()]).is_ok() {
                valid_regexes.push(regex);
                valid_ids.push(rule_id);
            }
        }

        if valid_regexes.is_empty() {
            return None;
        }

        let regex_refs: Vec<&str> = valid_regexes.iter().map(String::as_str).collect();
        match Scanner::new(&regex_refs) {
            Ok(scanner) => {
                let single_scanners = std::iter::repeat_with(|| None)
                    .take(valid_regexes.len())
                    .collect();
                Some(CompiledScanner {
                    scanner,
                    rule_ids: valid_ids,
                    regexes: valid_regexes,
                    single_scanners,
                })
            }
            Err(_) => None,
        }
    }
}

pub(crate) fn find_next_match_ordered(
    compiled_scanner: &mut CompiledScanner,
    input: &OnigString,
    line_str_id: u64,
    cursor: usize,
    find_options: ScannerFindOptions,
) -> Option<ferroni::scanner::ScannerMatch> {
    let best = compiled_scanner.scanner.find_next_match_utf16_with_id(
        input,
        line_str_id,
        cursor,
        find_options,
    )?;
    let mut best_match = best;
    let mut best_start = best_match
        .capture_indices
        .first()
        .map(|capture| capture.start)
        .unwrap_or(usize::MAX);

    for index in 0..best_match.index {
        if compiled_scanner.single_scanners[index].is_none() {
            compiled_scanner.single_scanners[index] =
                Scanner::new(&[compiled_scanner.regexes[index].as_str()]).ok();
        }
        let Some(scanner) = compiled_scanner.single_scanners[index].as_mut() else {
            continue;
        };
        let Some(mut candidate) =
            scanner.find_next_match_utf16_with_id(input, line_str_id, cursor, find_options)
        else {
            continue;
        };
        candidate.index = index;
        let candidate_start = candidate
            .capture_indices
            .first()
            .map(|capture| capture.start)
            .unwrap_or(usize::MAX);
        // On a tie in start position the lower pattern index wins (TextMate
        // declaration order); candidates are visited in ascending index order.
        if candidate_start < best_start
            || (candidate_start == best_start && candidate.index < best_match.index)
        {
            best_start = candidate_start;
            best_match = candidate;
            if best_start == cursor {
                break;
            }
        }
    }

    Some(best_match)
}
