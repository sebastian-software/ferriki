use std::fmt;

/// Stable category of a Rust highlighter failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[non_exhaustive]
pub enum ErrorKind {
    /// An asset could not be read from the selected provider.
    AssetIo,
    /// An asset's binary format or version is invalid.
    AssetFormat,
    /// An asset does not match its release-pinned digest or byte size.
    AssetIntegrity,
    /// The selected offline source does not contain the requested asset.
    AssetUnavailable,
    /// A custom grammar or theme registration is invalid.
    InvalidRegistration,
    /// No grammar is registered for the requested language.
    UnknownLanguage,
    /// No theme is registered for the requested theme name.
    UnknownTheme,
    /// A TextMate grammar could not tokenize the input.
    Tokenization,
    /// A TextMate theme could not be resolved.
    Theme,
    /// An internal invariant failed.
    Internal,
}

/// An owned error with a stable category and human-readable context.
#[derive(Debug)]
pub struct Error {
    kind: ErrorKind,
    message: String,
    source: Option<Box<dyn std::error::Error + Send + Sync>>,
}

impl Error {
    /// Creates an error with a category and contextual message.
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            source: None,
        }
    }

    /// Retains a cause without exposing an implementation-specific error type.
    #[must_use]
    pub fn with_source(mut self, source: impl std::error::Error + Send + Sync + 'static) -> Self {
        self.source = Some(Box::new(source));
        self
    }

    /// Returns the category for fallback policy decisions.
    pub fn kind(&self) -> ErrorKind {
        self.kind
    }

    pub(crate) fn from_reason(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Internal, message)
    }
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.source.as_ref().map(|source| source.as_ref() as _)
    }
}

/// Result returned by the native Ferriki runtime.
pub type Result<T> = std::result::Result<T, Error>;
