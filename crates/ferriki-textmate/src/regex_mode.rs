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
    /// Returns `true` when this policy allows regex prefiltering (everything except [`Self::Off`]).
    #[must_use]
    pub const fn prefilter(self) -> bool {
        !matches!(self, Self::Off)
    }

    /// Maps a boolean prefilter toggle to [`Self::Prepared`] (`true`) or [`Self::Off`] (`false`).
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
    /// Number of static scanner-group construction attempts (including failed attempts).
    pub static_scanners: usize,
    /// Number of dynamic scanner construction attempts for captured `end`/`while` patterns (including failed attempts).
    pub dynamic_scanners: usize,
    /// Number of scanner construction attempts with prefiltering disabled (`RegexMode::Off`, including failed attempts).
    pub off_scanners: usize,
    /// Number of scanner construction attempts with lazy DFA warm-up (`RegexMode::Auto`, including failed attempts).
    pub auto_scanners: usize,
    /// Number of scanner construction attempts with eager acceleration (`RegexMode::Eager` / `Prepared`, including failed attempts).
    pub eager_scanners: usize,
    /// Number of attempts to retry cached scanner assembly from source.
    pub assembly_fallbacks: usize,
    /// Number of prepared pattern archives attached to the registry.
    pub prepared_archives: usize,
    /// Number of precompiled scanner groups successfully loaded from attached archives.
    pub loaded_prepared_groups: usize,
    /// Number of prepared group load failures (including invalid/incompatible records and indexed file read errors).
    pub invalid_prepared_groups: usize,
    /// Program/group payload bytes read by indexed file sources, excluding indexes.
    pub prepared_bytes_read: u64,
}
