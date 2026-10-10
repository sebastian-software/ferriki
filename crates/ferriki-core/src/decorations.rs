//! Typed, semver-exempt transport for decoration plans. No callback payload or
//! HTML property is serialized; the facade applies mutations to existing objects.
use ferriki::__private as core;
use napi::bindgen_prelude::{Float64Array, Uint32Array};
use napi::{Error, Result, Status};
use napi_derive::napi;

#[napi(object)]
pub struct NativeDecorationRange {
    pub start_offset: Option<f64>,
    pub start_line: Option<f64>,
    pub start_character: Option<f64>,
    pub end_offset: Option<f64>,
    pub end_line: Option<f64>,
    pub end_character: Option<f64>,
    pub always_wrap: bool,
}

#[napi(object)]
pub struct NativeDecorationSection {
    pub decoration: u32,
    pub line: u32,
    pub start: f64,
    pub end: Option<f64>,
    pub whole_line: bool,
    pub always_wrap: bool,
}
#[napi(object)]
pub struct NativeDecorationMutation {
    pub decoration: u32,
    pub node: u32,
    pub line: u32,
    pub start: u32,
    pub count: u32,
    pub target: String,
}

#[napi(object)]
pub struct NativeDecorationPosition {
    pub line: u32,
    pub character: f64,
    pub offset: f64,
}
#[napi(object)]
pub struct NativeResolvedDecoration {
    pub start: NativeDecorationPosition,
    pub end: NativeDecorationPosition,
}
#[napi(object)]
pub struct NativeDecorationPreparation {
    pub ranges: Vec<NativeResolvedDecoration>,
    pub sections: Vec<NativeDecorationSection>,
}
#[napi(object)]
pub struct NativeDecorationPlan {
    pub mutations: Vec<NativeDecorationMutation>,
    pub error: Option<String>,
}

fn integer(value: f64) -> Result<usize> {
    if !value.is_finite() || value < 0.0 || value.fract() != 0.0 || value > u32::MAX as f64 {
        return Err(Error::new(
            Status::InvalidArg,
            "Decoration coordinates must be finite integers in range",
        ));
    }
    Ok(value as usize)
}
fn position(
    offset: Option<f64>,
    line: Option<f64>,
    character: Option<f64>,
) -> Result<core::DecorationPosition> {
    if let Some(offset) = offset {
        return Ok(core::DecorationPosition::Offset(integer(offset)?));
    }
    let line = integer(line.ok_or_else(|| {
        Error::new(
            Status::InvalidArg,
            "Invalid decoration position: missing line",
        )
    })?)?;
    let character = character.ok_or_else(|| {
        Error::new(
            Status::InvalidArg,
            "Invalid decoration position: missing character",
        )
    })?;
    if !character.is_finite() || character.fract() != 0.0 || character.abs() > u32::MAX as f64 {
        return Err(Error::new(
            Status::InvalidArg,
            "Invalid decoration character",
        ));
    }
    Ok(core::DecorationPosition::Line {
        line,
        character: character as isize,
    })
}
fn ranges(
    source: &str,
    ranges: Vec<NativeDecorationRange>,
) -> Result<Vec<core::ResolvedDecoration>> {
    core::DecorationSource::utf16(source)
        .resolve_ranges(&range_inputs(ranges)?)
        .map_err(usage)
}

pub(crate) fn range_inputs(
    ranges: Vec<NativeDecorationRange>,
) -> Result<Vec<core::DecorationRange>> {
    ranges.into_iter().map(range_input).collect()
}

pub(crate) fn range_input(r: NativeDecorationRange) -> Result<core::DecorationRange> {
    Ok(core::DecorationRange {
        start: position(r.start_offset, r.start_line, r.start_character)?,
        end: position(r.end_offset, r.end_line, r.end_character)?,
        always_wrap: r.always_wrap,
    })
}

fn usage(reason: String) -> Error {
    Error::new(Status::InvalidArg, reason)
}

#[napi(js_name = "splitDecorationTokens")]
pub fn split_decoration_tokens(
    source: String,
    input: Vec<NativeDecorationRange>,
    lines: Vec<Float64Array>,
) -> Result<Vec<Uint32Array>> {
    let ranges = ranges(&source, input)?;
    let boundaries = core::DecorationBoundaries::new(&ranges);
    let mut tokens = Vec::new();
    lines
        .into_iter()
        .map(|values| {
            if values.len() % 2 != 0 {
                return Err(usage("Invalid decoration token metadata".into()));
            }
            // Pairs carry exact JS numbers; validate before converting to Rust indices.
            tokens.clear();
            for pair in values.as_chunks::<2>().0 {
                tokens.push(core::DecorationToken {
                    offset: integer(pair[0])?,
                    length: integer(pair[1])?,
                });
            }
            // Four-word records: source token index, slice start, slice end, offset.
            let mut slices = Vec::with_capacity(tokens.len() * 4);
            boundaries.split_tokens(&tokens, |s| {
                slices.extend_from_slice(&[
                    s.token as u32,
                    s.start as u32,
                    s.end as u32,
                    s.offset as u32,
                ]);
            });
            Ok(slices.into())
        })
        .collect()
}

#[napi(js_name = "decorationSections")]
pub fn decoration_sections(
    source: String,
    input: Vec<NativeDecorationRange>,
) -> Result<NativeDecorationPreparation> {
    let ranges = ranges(&source, input)?;
    let sections = core::decoration_sections(&ranges)
        .into_iter()
        .map(|s| NativeDecorationSection {
            decoration: s.decoration as u32,
            line: s.line as u32,
            start: s.start as f64,
            end: s.end.map(|end| end as f64),
            whole_line: s.whole_line,
            always_wrap: s.always_wrap,
        })
        .collect();
    let position = |p: core::ResolvedPosition| NativeDecorationPosition {
        line: p.line as u32,
        character: p.character as f64,
        offset: p.offset as f64,
    };
    Ok(NativeDecorationPreparation {
        ranges: ranges
            .into_iter()
            .map(|r| NativeResolvedDecoration {
                start: position(r.start),
                end: position(r.end),
            })
            .collect(),
        sections,
    })
}

#[napi(object)]
pub struct NativeDecorationCursor {
    /// 0 = start, 1 = after start, 2 = middle, 3 = done.
    pub phase: u32,
    pub line: u32,
}
#[napi(object)]
pub struct NativeDecorationContinuation {
    pub section: NativeDecorationSection,
    pub cursor: NativeDecorationCursor,
}

#[napi(js_name = "nextDecorationSection")]
pub fn next_decoration_section(
    range: NativeResolvedDecoration,
    decoration: u32,
    always_wrap: bool,
    cursor: NativeDecorationCursor,
) -> Result<Option<NativeDecorationContinuation>> {
    let position = |p: NativeDecorationPosition| -> Result<core::ResolvedPosition> {
        Ok(core::ResolvedPosition {
            line: p.line as usize,
            character: integer(p.character)?,
            offset: integer(p.offset)?,
        })
    };
    let cursor = match cursor.phase {
        0 => core::DecorationCursor::Start,
        1 => core::DecorationCursor::AfterStart,
        2 => core::DecorationCursor::Middle(cursor.line as usize),
        3 => core::DecorationCursor::Done,
        _ => return Err(usage("Invalid decoration cursor".into())),
    };
    Ok(core::next_decoration_section(
        core::ResolvedDecoration {
            start: position(range.start)?,
            end: position(range.end)?,
            always_wrap,
        },
        decoration as usize,
        cursor,
    )
    .map(|(s, cursor)| {
        let (phase, line) = match cursor {
            core::DecorationCursor::Start => (0, 0),
            core::DecorationCursor::AfterStart => (1, 0),
            core::DecorationCursor::Middle(line) => (2, line as u32),
            core::DecorationCursor::Done => (3, 0),
        };
        NativeDecorationContinuation {
            section: NativeDecorationSection {
                decoration: s.decoration as u32,
                line: s.line as u32,
                start: s.start as f64,
                end: s.end.map(|end| end as f64),
                whole_line: s.whole_line,
                always_wrap: s.always_wrap,
            },
            cursor: NativeDecorationCursor { phase, line },
        }
    }))
}

#[napi(js_name = "planDecorationMutations")]
pub fn plan_decoration_mutations(
    input: Float64Array,
    lines: Vec<u32>,
    sections: Vec<NativeDecorationSection>,
) -> Result<NativeDecorationPlan> {
    let mut nodes = Vec::new();
    let mut cursor = 0;
    // Variable-length records: element flag, text length, child count, child IDs.
    // The host transports shape only; opaque node data never enters this buffer.
    while cursor < input.len() {
        let header = input
            .get(cursor..cursor + 3)
            .ok_or_else(|| usage("Invalid decoration node metadata".into()))?;
        let count = integer(header[2])?;
        let children = input
            .get(cursor + 3..cursor + 3 + count)
            .ok_or_else(|| usage("Invalid decoration child metadata".into()))?;
        let element = match header[0] {
            0.0 => false,
            1.0 => true,
            _ => return Err(usage("Invalid decoration node type".into())),
        };
        nodes.push(core::DecorationNode {
            element,
            text_length: integer(header[1])?,
            children: children
                .iter()
                .copied()
                .map(integer)
                .collect::<Result<Vec<_>>>()?,
        });
        cursor += 3 + count;
    }
    if nodes
        .iter()
        .any(|n| n.children.iter().any(|i| *i >= nodes.len()))
        || lines.iter().any(|i| *i as usize >= nodes.len())
    {
        return Err(usage("Invalid decoration node reference".into()));
    }
    let sections = sections
        .into_iter()
        .map(|s| {
            Ok(core::DecorationSection {
                decoration: s.decoration as usize,
                line: s.line as usize,
                start: integer(s.start)?,
                end: s.end.map(integer).transpose()?,
                whole_line: s.whole_line,
                always_wrap: s.always_wrap,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let plan = core::plan_decoration_mutations(
        nodes,
        &lines.into_iter().map(|i| i as usize).collect::<Vec<_>>(),
        &sections,
    );
    Ok(NativeDecorationPlan {
        error: plan.error,
        mutations: plan
            .mutations
            .into_iter()
            .map(|p| NativeDecorationMutation {
                decoration: p.decoration as u32,
                node: p.node as u32,
                line: p.line as u32,
                start: p.start as u32,
                count: p.count as u32,
                target: match p.target {
                    core::DecorationTarget::Line => "line",
                    core::DecorationTarget::Token => "token",
                    core::DecorationTarget::Wrapper => "wrapper",
                }
                .into(),
            })
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn range(start: f64, end: f64) -> NativeDecorationRange {
        NativeDecorationRange {
            start_offset: Some(start),
            start_line: None,
            start_character: None,
            end_offset: Some(end),
            end_line: None,
            end_character: None,
            always_wrap: false,
        }
    }

    #[test]
    fn token_buffers_preserve_utf16_boundaries_and_validate_records() {
        let slices = split_decoration_tokens(
            "a😀z".into(),
            vec![range(2.0, 3.0)],
            vec![vec![0.0, 4.0].into()],
        )
        .unwrap();
        assert_eq!(slices[0].as_ref(), [0, 0, 2, 0, 0, 2, 3, 2, 0, 3, 4, 3]);
        for metadata in [vec![0.0], vec![f64::NAN, 1.0], vec![0.0, -1.0]] {
            assert!(
                split_decoration_tokens("a".into(), vec![range(0.0, 1.0)], vec![metadata.into()])
                    .is_err()
            );
        }
        for start in [f64::NAN, f64::INFINITY, -1.0, 0.5] {
            assert!(decoration_sections("a".into(), vec![range(start, 1.0)]).is_err());
        }
    }

    #[test]
    fn range_transport_resolves_negative_columns_and_rejects_invalid_positions() {
        let mut input = range(0.0, 6.0);
        input.start_offset = None;
        input.start_line = Some(0.0);
        input.start_character = Some(-1.0);
        let prepared = decoration_sections("a😀\r\nb".into(), vec![input]).unwrap();
        assert_eq!(prepared.ranges[0].start.offset, 2.0);
        assert_eq!(prepared.sections.len(), 2);
        for (line, character) in [
            (None, Some(0.0)),
            (Some(0.0), None),
            (Some(0.0), Some(0.5)),
            (Some(9.0), Some(0.0)),
        ] {
            let mut input = range(0.0, 1.0);
            input.start_offset = None;
            input.start_line = line;
            input.start_character = character;
            assert!(decoration_sections("a".into(), vec![input]).is_err());
        }
    }

    #[test]
    fn node_buffers_check_framing_references_and_plan_wrappers() {
        let section = NativeDecorationSection {
            decoration: 0,
            line: 0,
            start: 0.0,
            end: Some(2.0),
            whole_line: false,
            always_wrap: true,
        };
        // A line containing two existing element nodes, each two units long.
        let plan = plan_decoration_mutations(
            vec![1.0, 0.0, 2.0, 1.0, 2.0, 1.0, 2.0, 0.0, 1.0, 2.0, 0.0].into(),
            vec![0],
            vec![section],
        )
        .unwrap();
        assert!(plan.error.is_none());
        assert_eq!(
            (
                plan.mutations[0].node,
                plan.mutations[0].start,
                plan.mutations[0].count
            ),
            (3, 0, 1)
        );
        assert_eq!(plan.mutations[0].target, "wrapper");
        for input in [
            vec![1.0],
            vec![1.0, 0.0, 2.0, 1.0],
            vec![2.0, 0.0, 0.0],
            vec![1.0, 0.0, 1.0, 9.0],
        ] {
            assert!(plan_decoration_mutations(input.into(), vec![0], vec![]).is_err());
        }
        assert!(plan_decoration_mutations(vec![1.0, 0.0, 0.0].into(), vec![9], vec![]).is_err());
    }

    #[test]
    fn continuation_transport_returns_a_finished_cursor() {
        let resolved = || NativeResolvedDecoration {
            start: NativeDecorationPosition {
                line: 0,
                character: 0.0,
                offset: 0.0,
            },
            end: NativeDecorationPosition {
                line: 0,
                character: 1.0,
                offset: 1.0,
            },
        };
        let next = next_decoration_section(
            resolved(),
            4,
            true,
            NativeDecorationCursor { phase: 0, line: 0 },
        )
        .unwrap()
        .unwrap();
        assert!(next.section.always_wrap);
        assert_eq!(next.section.decoration, 4);
        assert_eq!(next.cursor.phase, 3);
        assert!(
            next_decoration_section(resolved(), 4, false, next.cursor)
                .unwrap()
                .is_none()
        );
        assert!(
            next_decoration_section(
                resolved(),
                4,
                false,
                NativeDecorationCursor { phase: 9, line: 0 }
            )
            .is_err()
        );
    }
}
