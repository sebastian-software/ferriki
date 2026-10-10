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
        source.lengths.push(
            source.length - source.starts.last().unwrap() - usize::from(previous == Some(13)),
        );
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
                    length as isize + character
                } else {
                    character
                };
                if character < 0 || character as usize > length {
                    return Err(format!(
                        "Invalid decoration character: {character}. Line {line} length: {length}"
                    ));
                }
                let character = character as usize;
                Ok(ResolvedPosition {
                    line,
                    character,
                    offset: self.starts[line] + character,
                })
            }
        }
    }

    pub fn resolve_ranges(
        &self,
        ranges: &[DecorationRange],
    ) -> Result<Vec<ResolvedDecoration>, String> {
        let items = ranges
            .iter()
            .map(|range| {
                Ok(ResolvedDecoration {
                    start: self.resolve(range.start)?,
                    end: self.resolve(range.end)?,
                    always_wrap: range.always_wrap,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        for (index, current) in items.iter().enumerate() {
            if current.start.offset > current.end.offset {
                return Err("Invalid decoration range: start follows end".into());
            }
            for other in &items[index + 1..] {
                let nested = (current.start.offset <= other.start.offset
                    && other.end.offset <= current.end.offset)
                    || (other.start.offset <= current.start.offset
                        && current.end.offset <= other.end.offset);
                let intersects = current.start.offset < other.end.offset
                    && other.start.offset < current.end.offset;
                if intersects && !nested {
                    return Err("Decorations intersect without nesting".into());
                }
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

pub fn split_decoration_tokens(
    tokens: &[DecorationToken],
    ranges: &[ResolvedDecoration],
) -> Vec<DecorationSlice> {
    let mut boundaries = ranges
        .iter()
        .flat_map(|range| [range.start.offset, range.end.offset])
        .collect::<Vec<_>>();
    boundaries.sort_unstable();
    boundaries.dedup();
    let mut slices = Vec::new();
    for (index, token) in tokens.iter().enumerate() {
        let end = token.offset + token.length;
        let mut start = token.offset;
        for point in boundaries
            .iter()
            .copied()
            .filter(|point| *point > token.offset && *point < end)
            .chain(std::iter::once(end))
        {
            if point > start {
                slices.push(DecorationSlice {
                    token: index,
                    start: start - token.offset,
                    end: point - token.offset,
                    offset: start,
                });
            }
            start = point;
        }
    }
    slices
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
        DecorationCursor::AfterStart => {
            return next_decoration_section(
                range,
                decoration,
                DecorationCursor::Middle(range.start.line + 1),
            );
        }
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
    for root in 0..nodes.len() {
        if state[root] == 2 {
            continue;
        }
        state[root] = 1;
        let mut stack = vec![(root, 0usize)];
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
    let mut mutations = Vec::new();
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
        let children = &nodes[line].children;
        let (start, end) = if section.whole_line {
            (0, children.len())
        } else {
            let mut cursor = 0;
            let mut start = (section.start == 0).then_some(0);
            let mut end = section.end.is_none().then_some(children.len());
            for (index, child) in children.iter().enumerate() {
                cursor += lengths[*child];
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
        } else if !section.always_wrap && count == 1 && nodes[children[start]].element {
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
                lengths.push(selected.iter().map(|child| lengths[*child]).sum());
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
        let slices = split_decoration_tokens(
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
            &[range],
        );
        assert_eq!(
            slices
                .iter()
                .map(|s| (s.token, s.start, s.end, s.offset))
                .collect::<Vec<_>>(),
            [(0, 0, 1, 0), (0, 1, 3, 1), (0, 3, 4, 3)]
        );
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
}
