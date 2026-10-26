//! Regex preparation policies, independent of tokenization semantics.

/// Chooses source preparation or reuse of optional prepared scanner groups.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
#[non_exhaustive]
pub enum RegexMode {
    /// Source scanners without optional prefilters.
    Off,
    /// Source scanners with Ferroni's normal lazy DFA warm-up.
    Auto,
    /// Source scanners with eager acceleration preparation.
    Eager,
    /// Restore prepared standard groups; use Auto where no pair is attached.
    #[default]
    Prepared,
}

impl RegexMode {
    #[must_use]
    pub const fn prefilter(self) -> bool {
        !matches!(self, Self::Off)
    }

    #[must_use]
    pub const fn from_prefilter(enabled: bool) -> Self {
        if enabled { Self::Prepared } else { Self::Off }
    }
}

/// Scanner-construction and archive observations for one registry.
///
/// Loaded groups prove archive use, not complete coverage: Ferroni may build
/// missing groups locally. Assembly fallbacks count only failed cached scanner
/// assembly retries, not those ordinary group misses. These are construction
/// counters; the hot search loop does not update them.
#[derive(Clone, Debug, Default, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct RegexDiagnostics {
    pub static_scanners: usize,
    pub dynamic_scanners: usize,
    pub off_scanners: usize,
    pub auto_scanners: usize,
    pub eager_scanners: usize,
    pub assembly_fallbacks: usize,
    pub prepared_archives: usize,
    pub loaded_prepared_groups: usize,
    pub invalid_prepared_groups: usize,
    /// Program/group payload bytes read by indexed file sources, excluding indexes.
    pub prepared_bytes_read: u64,
}
