//! Typed decoration policy for the private Node bridge.
//! Plans reference existing nodes, so applying a plan need not copy callback data.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecorationPosition {
    Offset(usize),
    Line { line: usize, character: isize },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DecorationRange {
    pub start: DecorationPosition,
    pub end: DecorationPosition,
    pub always_wrap: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ResolvedPosition {
    pub line: usize,
    pub character: usize,
    pub offset: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ResolvedDecoration {
    pub start: ResolvedPosition,
    pub end: ResolvedPosition,
    pub always_wrap: bool,
}

/// Rust coordinates count UTF-8 bytes. The private Node adapter retains UTF-16
/// code units, including boundaries inside a surrogate pair; JS performs the
/// final string slice without a lossy trip through Rust strings.
#[derive(Debug)]
pub struct DecorationSource {
    starts: Vec<usize>,
    lengths: Vec<usize>,
    length: usize,
}

impl DecorationSource {
    pub fn utf8(source: &str) -> Self {
        Self::from_units(source.bytes().map(u32::from))
    }

    pub fn utf16(source: &str) -> Self {
        Self::from_units(source.encode_utf16().map(u32::from))
    }

    fn from_units(units: impl Iterator<Item = u32>) -> Self {
        let mut source = Self {
            starts: vec![0],
            lengths: Vec::new(),
            length: 0,
        };
        let mut previous = None;
        for unit in units {
            if unit == 10 {
                source.lengths.push(
                    source.length
                        - source.starts.last().unwrap()
                        - usize::from(previous == Some(13)),
                );
                source.starts.push(source.length + 1);
            }
            source.length += 1;
            previous = Some(unit);
        }
        source
            .lengths
            .push(source.length - source.starts.last().unwrap());
        source
    }

    fn resolve(&self, position: DecorationPosition) -> Result<ResolvedPosition, String> {
        match position {
            DecorationPosition::Offset(offset) => {
                if offset > self.length {
                    return Err(format!(
                        "Invalid decoration offset: {offset}. Code length: {}",
                        self.length
                    ));
                }
                let line = self.starts.partition_point(|start| *start <= offset) - 1;
                Ok(ResolvedPosition {
                    line,
                    character: offset - self.starts[line],
                    offset,
                })
            }
            DecorationPosition::Line { line, character } => {
                let Some(&length) = self.lengths.get(line) else {
                    return Err(format!(
                        "Invalid decoration line: {line}. Lines length: {}",
                        self.starts.len()
                    ));
                };
                let character = if character < 0 {
                    let Some(resolved) = isize::try_from(length)
                        .ok()
                        .and_then(|len| len.checked_add(character))
                    else {
                        return Err(format!(
                            "Invalid decoration character: {character}. Line {line} length: {length}"
                        ));
                    };
                    resolved
                } else {
                    character
                };
                if character < 0 || character as usize > length {
                    return Err(format!(
                        "Invalid decoration character: {character}. Line {line} length: {length}"
                    ));
                }
                let character = character as usize;
                let offset = self.starts[line].checked_add(character).ok_or_else(|| {
                    format!("Decoration offset overflow on line {line} at character {character}")
                })?;
                Ok(ResolvedPosition {
                    line,
                    character,
                    offset,
                })
            }
        }
    }

    pub fn resolve_ranges(
        &self,
        ranges: &[DecorationRange],
    ) -> Result<Vec<ResolvedDecoration>, String> {
        let mut items = Vec::with_capacity(ranges.len());
        for range in ranges {
            let resolved = ResolvedDecoration {
                start: self.resolve(range.start)?,
                end: self.resolve(range.end)?,
                always_wrap: range.always_wrap,
            };
            if resolved.start.offset > resolved.end.offset {
                return Err("Invalid decoration range: start follows end".into());
            }
            items.push(resolved);
        }
        if items.len() > 1 {
            // Empty ranges never cross any interval. Sort non-empty spans by
            // ascending start and descending end so enclosing ranges precede
            // nested ones, then sweep active end offsets in O(D log D).
            let mut spans: Vec<(usize, usize)> = items
                .iter()
                .filter_map(|item| {
                    (item.start.offset < item.end.offset)
                        .then_some((item.start.offset, item.end.offset))
                })
                .collect();
            spans.sort_unstable_by(|left, right| {
                left.0.cmp(&right.0).then_with(|| right.1.cmp(&left.1))
            });
            let mut active_ends: Vec<usize> = Vec::new();
            for (start, end) in spans {
                while active_ends.last().is_some_and(|&top_end| top_end <= start) {
                    active_ends.pop();
                }
                if let Some(&top_end) = active_ends.last()
                    && end > top_end
                {
                    return Err("Decorations intersect without nesting".into());
                }
                active_ends.push(end);
            }
        }
        Ok(items)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DecorationToken {
    pub offset: usize,
    pub length: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DecorationSlice {
    pub token: usize,
    pub start: usize,
    pub end: usize,
    pub offset: usize,
}

/// Sorted, deduplicated boundaries shared by every line in a render.
pub struct DecorationBoundaries(Vec<usize>);

impl DecorationBoundaries {
    pub fn new(ranges: &[ResolvedDecoration]) -> Self {
        let mut boundaries = ranges
            .iter()
            .flat_map(|range| [range.start.offset, range.end.offset])
            .collect::<Vec<_>>();
        boundaries.sort_unstable();
        boundaries.dedup();
        Self(boundaries)
    }

    /// Emit slices directly so the host can build its packed output without
    /// allocating a second intermediate list. Tokens need not be ordered.
    pub fn split_tokens(
        &self,
        tokens: &[DecorationToken],
        mut emit: impl FnMut(DecorationSlice) -> Result<(), String>,
    ) -> Result<(), String> {
        for (index, token) in tokens.iter().enumerate() {
            let end = token.offset.checked_add(token.length).ok_or_else(|| {
                format!(
                    "Decoration token offset overflow at token {index}: offset {} + length {}",
                    token.offset, token.length
                )
            })?;
            let mut start = token.offset;
            let first = self.0.partition_point(|point| *point <= token.offset);
            for point in self.0[first..]
                .iter()
                .copied()
                .take_while(|point| *point < end)
                .chain(std::iter::once(end))
            {
                if point > start {
                    emit(DecorationSlice {
                        token: index,
                        start: start - token.offset,
                        end: point - token.offset,
                        offset: start,
                    })?;
                }
                start = point;
            }
        }
        Ok(())
    }
}

/// A section is applied after earlier sections, which may run JS callbacks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DecorationSection {
    pub decoration: usize,
    pub line: usize,
    pub start: usize,
    pub end: Option<usize>,
    pub whole_line: bool,
    pub always_wrap: bool,
}

pub fn decoration_sections(ranges: &[ResolvedDecoration]) -> Vec<DecorationSection> {
    let mut indices = (0..ranges.len()).collect::<Vec<_>>();
    indices.sort_by_key(|index| std::cmp::Reverse(ranges[*index].start.offset));
    let mut sections = Vec::new();
    for decoration in indices {
        let range = ranges[decoration];
        for line in range.start.line..=range.end.line {
            sections.push(DecorationSection {
                decoration,
                line,
                start: if line == range.start.line {
                    range.start.character
                } else {
                    0
                },
                end: (line == range.end.line).then_some(range.end.character),
                whole_line: line > range.start.line && line < range.end.line,
                always_wrap: range.always_wrap,
            });
        }
    }
    sections
}

/// Traversal state for a decoration callback that can change its own resolved
/// bounds. The branch is fixed at the first section, matching the JS contract.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum DecorationCursor {
    #[default]
    Start,
    AfterStart,
    Middle(usize),
    Done,
}

pub fn next_decoration_section(
    range: ResolvedDecoration,
    decoration: usize,
    cursor: DecorationCursor,
) -> Option<(DecorationSection, DecorationCursor)> {
    let (line, start, end, whole_line, next) = match cursor {
        DecorationCursor::Start if range.start.line == range.end.line => (
            range.start.line,
            range.start.character,
            Some(range.end.character),
            false,
            DecorationCursor::Done,
        ),
        DecorationCursor::Start => (
            range.start.line,
            range.start.character,
            None,
            false,
            DecorationCursor::AfterStart,
        ),
        DecorationCursor::AfterStart => match range.start.line.checked_add(1) {
            Some(next_line) => {
                return next_decoration_section(
                    range,
                    decoration,
                    DecorationCursor::Middle(next_line),
                );
            }
            None => (
                range.end.line,
                0,
                Some(range.end.character),
                false,
                DecorationCursor::Done,
            ),
        },
        DecorationCursor::Middle(line) if line < range.end.line => {
            (line, 0, None, true, DecorationCursor::Middle(line + 1))
        }
        DecorationCursor::Middle(_) => (
            range.end.line,
            0,
            Some(range.end.character),
            false,
            DecorationCursor::Done,
        ),
        DecorationCursor::Done => return None,
    };
    Some((
        DecorationSection {
            decoration,
            line,
            start,
            end,
            whole_line,
            always_wrap: range.always_wrap,
        },
        next,
    ))
}

/// Transport-neutral node arena. Properties and callback payloads stay opaque
/// in the host; only element identity, text length and child order affect policy.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecorationNode {
    pub element: bool,
    pub text_length: usize,
    pub children: Vec<usize>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecorationTarget {
    Line,
    Token,
    Wrapper,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecorationMutation {
    pub decoration: usize,
    pub node: usize,
    pub line: usize,
    pub start: usize,
    pub count: usize,
    pub target: DecorationTarget,
}

// Cache text lengths once, including shared child nodes. An iterative walk also
// rejects cycles without risking recursion through an untrusted bridge input.
fn text_lengths(nodes: &[DecorationNode]) -> Result<Vec<usize>, String> {
    let mut lengths = vec![0usize; nodes.len()];
    let mut state = vec![0u8; nodes.len()];
    let mut stack = Vec::new();
    for root in 0..nodes.len() {
        if state[root] == 2 {
            continue;
        }
        state[root] = 1;
        stack.push((root, 0usize));
        while let Some((node, next)) = stack.last_mut() {
            if let Some(&child) = nodes[*node].children.get(*next) {
                *next += 1;
                match state.get(child) {
                    Some(0) => {
                        state[child] = 1;
                        stack.push((child, 0));
                    }
                    Some(1) => return Err("Cyclic decoration node graph".into()),
                    Some(2) => {}
                    _ => return Err("Invalid decoration node reference".into()),
                }
            } else {
                lengths[*node] = if nodes[*node].children.is_empty() {
                    nodes[*node].text_length
                } else {
                    nodes[*node]
                        .children
                        .iter()
                        .try_fold(0usize, |sum, child| {
                            sum.checked_add(lengths[*child])
                                .ok_or_else(|| "Decoration text length overflow".to_string())
                        })?
                };
                state[*node] = 2;
                stack.pop();
            }
        }
    }
    Ok(lengths)
}

#[derive(Debug)]
pub struct DecorationPlan {
    pub mutations: Vec<DecorationMutation>,
    pub error: Option<String>,
}

pub fn plan_decoration_mutations(
    mut nodes: Vec<DecorationNode>,
    lines: &[usize],
    sections: &[DecorationSection],
) -> DecorationPlan {
    let input_node_count = nodes.len();
    let mut mutations = Vec::with_capacity(sections.len());
    let mut lengths = match text_lengths(&nodes) {
        Ok(lengths) => lengths,
        Err(error) => {
            return DecorationPlan {
                mutations,
                error: Some(error),
            };
        }
    };
    for section in sections {
        let Some(&line) = lines.get(section.line) else {
            if section.whole_line {
                return DecorationPlan {
                    mutations,
                    error: Some(format!("Missing decoration line {}", section.line)),
                };
            }
            continue;
        };
        let Some(line_node) = (line < input_node_count).then(|| nodes.get(line)).flatten() else {
            return DecorationPlan {
                mutations,
                error: Some(format!("Invalid decoration line node reference {line}")),
            };
        };
        let children = &line_node.children;
        let (start, end) = if section.whole_line {
            (0, children.len())
        } else {
            let mut cursor = 0usize;
            let mut start = (section.start == 0).then_some(0);
            let mut end = section.end.is_none().then_some(children.len());
            for (index, &child) in children.iter().enumerate() {
                let Some(&child_length) = lengths.get(child) else {
                    return DecorationPlan {
                        mutations,
                        error: Some(format!("Invalid decoration node reference {child}")),
                    };
                };
                let Some(next_cursor) = cursor.checked_add(child_length) else {
                    return DecorationPlan {
                        mutations,
                        error: Some("Decoration text length overflow".into()),
                    };
                };
                cursor = next_cursor;
                if start.is_none() && cursor >= section.start {
                    start = Some(if cursor == section.start {
                        index + 1
                    } else {
                        index
                    });
                }
                if let Some(bound) = section.end
                    && end.is_none()
                    && cursor >= bound
                {
                    end = Some(if cursor == bound { index + 1 } else { index });
                }
            }
            match (start, end) {
                (Some(start), Some(end)) => (start, end),
                _ => {
                    return DecorationPlan {
                        mutations,
                        error: Some(format!(
                            "Failed to find decoration boundary on line {}",
                            section.line
                        )),
                    };
                }
            }
        };
        let count = end.saturating_sub(start);
        let target = if section.whole_line || (!section.always_wrap && count == children.len()) {
            DecorationTarget::Line
        } else if !section.always_wrap
            && count == 1
            && nodes.get(children[start]).is_some_and(|node| node.element)
        {
            DecorationTarget::Token
        } else {
            DecorationTarget::Wrapper
        };
        let node = match target {
            DecorationTarget::Line => line,
            DecorationTarget::Token => children[start],
            DecorationTarget::Wrapper => {
                let node = nodes.len();
                let selected = children[start..end.max(start)].to_vec();
                let wrapper_length = match selected.iter().try_fold(0usize, |sum, &child| {
                    lengths
                        .get(child)
                        .copied()
                        .ok_or_else(|| format!("Invalid decoration node reference {child}"))
                        .and_then(|len| {
                            sum.checked_add(len)
                                .ok_or_else(|| "Decoration text length overflow".to_string())
                        })
                }) {
                    Ok(length) => length,
                    Err(error) => {
                        return DecorationPlan {
                            mutations,
                            error: Some(error),
                        };
                    }
                };
                lengths.push(wrapper_length);
                nodes.push(DecorationNode {
                    element: true,
                    text_length: 0,
                    children: selected,
                });
                nodes[line].children.splice(start..start + count, [node]);
                node
            }
        };
        mutations.push(DecorationMutation {
            decoration: section.decoration,
            node,
            line,
            start,
            count,
            target,
        });
    }
    DecorationPlan {
        mutations,
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn callback_continuations_read_changed_bounds_and_wrapping() {
        let mut range = ResolvedDecoration {
            start: ResolvedPosition {
                line: 0,
                character: 1,
                offset: 1,
            },
            end: ResolvedPosition {
                line: 2,
                character: 3,
                offset: 14,
            },
            always_wrap: false,
        };
        let (first, cursor) = next_decoration_section(range, 0, DecorationCursor::Start).unwrap();
        assert_eq!(first.end, None);
        range.end.line = 1;
        range.end.character = 4;
        range.always_wrap = true;
        let (last, cursor) = next_decoration_section(range, 0, cursor).unwrap();
        assert_eq!((last.line, last.end, last.always_wrap), (1, Some(4), true));
        assert!(next_decoration_section(range, 0, cursor).is_none());
    }

    #[test]
    fn shared_nodes_are_counted_per_edge_and_cycles_are_rejected() {
        let mut nodes = vec![
            DecorationNode {
                element: true,
                text_length: 0,
                children: vec![1, 1],
            },
            DecorationNode {
                element: false,
                text_length: 3,
                children: vec![],
            },
        ];
        assert_eq!(text_lengths(&nodes).unwrap(), [6, 3]);
        nodes[1].children = vec![0];
        assert!(text_lengths(&nodes).unwrap_err().contains("Cyclic"));
        nodes[1].children = vec![99];
        assert!(text_lengths(&nodes).is_err());
    }

    #[test]
    fn a_late_error_retains_the_successful_mutation_prefix() {
        let nodes = vec![
            DecorationNode {
                element: true,
                text_length: 0,
                children: vec![1],
            },
            DecorationNode {
                element: true,
                text_length: 4,
                children: vec![],
            },
        ];
        let first = DecorationSection {
            decoration: 0,
            line: 0,
            start: 0,
            end: Some(4),
            whole_line: false,
            always_wrap: false,
        };
        let plan = plan_decoration_mutations(
            nodes,
            &[0],
            &[
                first,
                DecorationSection {
                    decoration: 1,
                    end: Some(5),
                    ..first
                },
            ],
        );
        assert_eq!(plan.mutations.len(), 1);
        assert_eq!(plan.mutations[0].target, DecorationTarget::Line);
        assert!(plan.error.is_some());
    }

    #[test]
    fn coordinates_keep_crlf_negative_columns_and_encoding_explicit() {
        let source = "a😀\r\nbé\n";
        let utf8 = DecorationSource::utf8(source);
        let utf16 = DecorationSource::utf16(source);
        assert_eq!(
            utf8.resolve(DecorationPosition::Line {
                line: 1,
                character: -1
            })
            .unwrap()
            .offset,
            9
        );
        assert_eq!(
            utf16
                .resolve(DecorationPosition::Line {
                    line: 1,
                    character: -1
                })
                .unwrap()
                .offset,
            6
        );
        assert_eq!(
            utf16
                .resolve(DecorationPosition::Offset(2))
                .unwrap()
                .character,
            2
        );
        assert!(
            utf16
                .resolve(DecorationPosition::Line {
                    line: 0,
                    character: 4
                })
                .is_err()
        );
        assert_eq!(
            utf16.resolve(DecorationPosition::Offset(8)).unwrap().line,
            2
        );
    }

    #[test]
    fn final_carriage_return_is_part_of_the_unterminated_line() {
        let text = "a😀\r\nb😀\r";
        for (source, first_end, final_start, final_length) in [
            (DecorationSource::utf8(text), 5, 7, 6),
            (DecorationSource::utf16(text), 3, 5, 4),
        ] {
            assert_eq!(
                source
                    .resolve(DecorationPosition::Line {
                        line: 0,
                        character: first_end
                    })
                    .unwrap(),
                source
                    .resolve(DecorationPosition::Offset(first_end as usize))
                    .unwrap()
            );
            assert!(
                source
                    .resolve(DecorationPosition::Line {
                        line: 0,
                        character: first_end + 1
                    })
                    .is_err()
            );
            let end = source
                .resolve(DecorationPosition::Line {
                    line: 1,
                    character: final_length,
                })
                .unwrap();
            assert_eq!(
                end,
                source
                    .resolve(DecorationPosition::Offset(
                        final_start + final_length as usize
                    ))
                    .unwrap()
            );
            assert_eq!(end.character, final_length as usize);
            assert_eq!(
                source
                    .resolve(DecorationPosition::Line {
                        line: 1,
                        character: -1
                    })
                    .unwrap()
                    .offset,
                end.offset - 1
            );
        }
    }
    #[test]
    fn range_validation_allows_nesting_touching_and_empty_but_not_crossing() {
        let range = |start, end| DecorationRange {
            start: DecorationPosition::Offset(start),
            end: DecorationPosition::Offset(end),
            always_wrap: false,
        };
        let source = DecorationSource::utf8("abcdef");
        assert!(
            source
                .resolve_ranges(&[range(0, 6), range(1, 4), range(4, 6), range(2, 2)])
                .is_ok()
        );
        assert!(source.resolve_ranges(&[range(0, 4), range(2, 6)]).is_err());
        assert!(source.resolve_ranges(&[range(4, 1)]).is_err());
    }
    #[test]
    fn splitting_keeps_indices_offsets_and_drops_empty_tokens_like_node() {
        let range = ResolvedDecoration {
            start: ResolvedPosition {
                line: 0,
                character: 1,
                offset: 1,
            },
            end: ResolvedPosition {
                line: 0,
                character: 3,
                offset: 3,
            },
            always_wrap: false,
        };
        let boundaries = DecorationBoundaries::new(&[range]);
        let mut slices = Vec::new();
        boundaries
            .split_tokens(
                &[
                    DecorationToken {
                        offset: 0,
                        length: 4,
                    },
                    DecorationToken {
                        offset: 4,
                        length: 0,
                    },
                ],
                |slice| {
                    slices.push(slice);
                    Ok(())
                },
            )
            .unwrap();
        assert_eq!(
            slices
                .iter()
                .map(|s| (s.token, s.start, s.end, s.offset))
                .collect::<Vec<_>>(),
            [(0, 0, 1, 0), (0, 1, 3, 1), (0, 3, 4, 3)]
        );
    }
    #[test]
    fn splitting_reuses_boundaries_for_unordered_tokens_and_other_lines() {
        let source = DecorationSource::utf16("abcdefgh\nijklmnop");
        let ranges = source
            .resolve_ranges(&[
                DecorationRange {
                    start: DecorationPosition::Offset(1),
                    end: DecorationPosition::Offset(3),
                    always_wrap: false,
                },
                DecorationRange {
                    start: DecorationPosition::Offset(3),
                    end: DecorationPosition::Offset(5),
                    always_wrap: false,
                },
                DecorationRange {
                    start: DecorationPosition::Offset(11),
                    end: DecorationPosition::Offset(13),
                    always_wrap: false,
                },
            ])
            .unwrap();
        let boundaries = DecorationBoundaries::new(&ranges);
        let mut slices = Vec::new();
        for tokens in [
            vec![
                DecorationToken {
                    offset: 3,
                    length: 5,
                },
                DecorationToken {
                    offset: 0,
                    length: 3,
                },
                DecorationToken {
                    offset: 1,
                    length: 0,
                },
            ],
            vec![DecorationToken {
                offset: 9,
                length: 8,
            }],
        ] {
            slices.clear();
            boundaries
                .split_tokens(&tokens, |slice| {
                    slices.push(slice);
                    Ok(())
                })
                .unwrap();
            let actual = slices
                .iter()
                .map(|slice| (slice.token, slice.start, slice.end, slice.offset))
                .collect::<Vec<_>>();
            if tokens.len() == 3 {
                assert_eq!(
                    actual,
                    [(0, 0, 2, 3), (0, 2, 5, 5), (1, 0, 1, 0), (1, 1, 3, 1)]
                );
            } else {
                assert_eq!(actual, [(0, 0, 2, 9), (0, 2, 4, 11), (0, 4, 8, 13)]);
            }
        }
    }
    #[test]
    fn plans_nested_wrappers_and_reports_missing_boundaries() {
        let nodes = vec![
            DecorationNode {
                element: true,
                text_length: 0,
                children: vec![1, 2],
            },
            DecorationNode {
                element: true,
                text_length: 2,
                children: vec![],
            },
            DecorationNode {
                element: true,
                text_length: 2,
                children: vec![],
            },
        ];
        let section = DecorationSection {
            decoration: 0,
            line: 0,
            start: 0,
            end: Some(2),
            whole_line: false,
            always_wrap: true,
        };
        let plan = plan_decoration_mutations(
            nodes.clone(),
            &[0],
            &[
                section,
                DecorationSection {
                    decoration: 1,
                    end: Some(4),
                    ..section
                },
            ],
        );
        assert!(plan.error.is_none());
        assert_eq!(
            plan.mutations
                .iter()
                .map(|p| (p.node, p.count, p.target))
                .collect::<Vec<_>>(),
            [
                (3, 1, DecorationTarget::Wrapper),
                (4, 2, DecorationTarget::Wrapper)
            ]
        );
        assert!(
            plan_decoration_mutations(
                nodes,
                &[0],
                &[DecorationSection {
                    end: Some(5),
                    ..section
                }]
            )
            .error
            .is_some()
        );
    }

    #[test]
    fn rejects_out_of_range_line_node_indices_without_panicking() {
        let nodes = vec![
            DecorationNode {
                element: true,
                text_length: 0,
                children: vec![1],
            },
            DecorationNode {
                element: true,
                text_length: 3,
                children: vec![],
            },
        ];
        let section = DecorationSection {
            decoration: 0,
            line: 0,
            start: 0,
            end: Some(3),
            whole_line: false,
            always_wrap: false,
        };
        let invalid = plan_decoration_mutations(nodes.clone(), &[99], &[section]);
        assert!(invalid.mutations.is_empty());
        assert!(
            invalid
                .error
                .as_deref()
                .is_some_and(|message| message.contains("Invalid decoration line node reference"))
        );

        // Partial prefix is retained when a subsequent line references an out-of-range node.
        let partial = plan_decoration_mutations(
            nodes.clone(),
            &[0, 99],
            &[
                section,
                DecorationSection {
                    decoration: 1,
                    line: 1,
                    ..section
                },
            ],
        );
        assert_eq!(partial.mutations.len(), 1);
        assert!(partial.error.is_some());

        // An initially out-of-range line reference (`2` for a 2-node arena) must stay
        // invalid even after an earlier section appends wrapper node `2`.
        let aliased = plan_decoration_mutations(
            nodes,
            &[0, 2],
            &[
                DecorationSection {
                    always_wrap: true,
                    ..section
                },
                DecorationSection {
                    decoration: 1,
                    line: 1,
                    ..section
                },
            ],
        );
        assert_eq!(aliased.mutations.len(), 1);
        assert_eq!(aliased.mutations[0].node, 2);
        assert_eq!(aliased.mutations[0].target, DecorationTarget::Wrapper);
        assert!(
            aliased
                .error
                .as_deref()
                .is_some_and(|message| message.contains("Invalid decoration line node reference 2"))
        );
    }

    #[test]
    fn rejects_overflowing_token_offsets_and_extreme_coordinates() {
        let boundaries = DecorationBoundaries::new(&[]);
        let err = boundaries
            .split_tokens(
                &[DecorationToken {
                    offset: usize::MAX,
                    length: 1,
                }],
                |_| Ok(()),
            )
            .unwrap_err();
        assert!(err.contains("overflow"));

        let err = boundaries
            .split_tokens(
                &[DecorationToken {
                    offset: usize::MAX - 4,
                    length: 10,
                }],
                |_| Ok(()),
            )
            .unwrap_err();
        assert!(err.contains("overflow"));

        // Extreme negative character offset fails cleanly without overflow.
        let source = DecorationSource::utf8("abc");
        assert!(
            source
                .resolve(DecorationPosition::Line {
                    line: 0,
                    character: isize::MIN,
                })
                .is_err()
        );

        // Callback cursor advancement at usize::MAX does not overflow.
        let max_range = ResolvedDecoration {
            start: ResolvedPosition {
                line: usize::MAX,
                character: 0,
                offset: 0,
            },
            end: ResolvedPosition {
                line: usize::MAX,
                character: 1,
                offset: 1,
            },
            always_wrap: false,
        };
        let (section, next) =
            next_decoration_section(max_range, 0, DecorationCursor::AfterStart).unwrap();
        assert_eq!(section.line, usize::MAX);
        assert_eq!(next, DecorationCursor::Done);
    }

    #[test]
    fn sweep_line_range_validation_matches_pairwise_oracle_and_scales() {
        let source = DecorationSource::utf8("0123456789");
        let mk = |start, end| DecorationRange {
            start: DecorationPosition::Offset(start),
            end: DecorationPosition::Offset(end),
            always_wrap: false,
        };
        let naive_ok = |spans: &[(usize, usize)]| -> bool {
            for (i, &(s1, e1)) in spans.iter().enumerate() {
                if s1 > e1 {
                    return false;
                }
                for &(s2, e2) in &spans[i + 1..] {
                    let nested = (s1 <= s2 && e2 <= e1) || (s2 <= s1 && e1 <= e2);
                    let intersects = s1 < e2 && s2 < e1;
                    if intersects && !nested {
                        return false;
                    }
                }
            }
            true
        };

        // Test tricky edge cases: identical, same-start, same-end, nested, empty, reverse-order crossing.
        let cases: &[&[(usize, usize)]] = &[
            &[],
            &[(2, 5)],
            &[(2, 5), (2, 5)],
            &[(1, 6), (1, 4), (4, 6), (1, 1), (4, 4), (6, 6)],
            &[(1, 4), (1, 6)],
            &[(3, 6), (1, 6)],
            &[(0, 10), (1, 5), (3, 7)],
            &[(2, 6), (0, 4)],
            &[(0, 4), (4, 8), (5, 7), (2, 2)],
            &[(0, 8), (2, 6), (2, 4), (4, 6), (3, 5)],
            &[(0, 8), (2, 4), (3, 3), (4, 6)],
            &[(5, 2), (0, 4)],
            &[(0, 4), (3, 1)],
        ];
        for spans in cases {
            let input: Vec<_> = spans.iter().map(|&(s, e)| mk(s, e)).collect();
            assert_eq!(
                source.resolve_ranges(&input).is_ok(),
                naive_ok(spans),
                "mismatch for {spans:?}"
            );
        }

        // Exhaustive check over triples of intervals on [0..=4].
        let mut all_valid = Vec::new();
        for s in 0..=4 {
            for e in s..=4 {
                all_valid.push((s, e));
            }
        }
        for &a in &all_valid {
            for &b in &all_valid {
                for &c in &all_valid {
                    let spans = [a, b, c];
                    let input = [mk(a.0, a.1), mk(b.0, b.1), mk(c.0, c.1)];
                    assert_eq!(
                        source.resolve_ranges(&input).is_ok(),
                        naive_ok(&spans),
                        "triple mismatch for {spans:?}"
                    );
                }
            }
        }

        // Scale check: 10,000 disjoint/nested ranges validate cleanly in O(D log D).
        let long_code = "a".repeat(20_000);
        let long_source = DecorationSource::utf8(&long_code);
        let many: Vec<_> = (0..10_000).map(|i| mk(i * 2, i * 2 + 2)).collect();
        assert_eq!(long_source.resolve_ranges(&many).unwrap().len(), 10_000);
    }
}
