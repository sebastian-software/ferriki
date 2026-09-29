use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
/// Version of the binary asset format. Every asset and manifest starts with it.
pub const FORMAT_VERSION: u32 = 3;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct AssetSourceRef {
    pub upstream: String,
    pub version: Option<String>,
    pub commit: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct LanguageAssetEntry {
    pub id: String,
    pub scope_name: String,
    pub asset_file: String,
    pub display_name: Option<String>,
    pub aliases: Vec<String>,
    pub embedded_langs: Vec<String>,
    pub embedded_langs_lazy: Vec<String>,
    pub inject_to: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct ThemeAssetEntry {
    pub id: String,
    pub asset_file: String,
    pub display_name: Option<String>,
    pub theme_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct LanguageManifest {
    pub format_version: u32,
    pub source: AssetSourceRef,
    pub entries: Vec<LanguageAssetEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct ThemeManifest {
    pub format_version: u32,
    pub source: AssetSourceRef,
    pub entries: Vec<ThemeAssetEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct LanguageAsset {
    pub format_version: u32,
    pub id: String,
    pub scope_name: String,
    pub display_name: Option<String>,
    pub aliases: Vec<String>,
    pub embedded_langs: Vec<String>,
    pub embedded_langs_lazy: Vec<String>,
    pub inject_to: Vec<String>,
    pub grammar_json: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct ThemeAsset {
    pub format_version: u32,
    pub id: String,
    pub display_name: Option<String>,
    pub theme_type: Option<String>,
    pub theme_json: String,
}

impl AssetSourceRef {
    /// Describes the upstream collection a catalog was generated from.
    #[must_use]
    pub fn new(
        upstream: impl Into<String>,
        version: Option<String>,
        commit: Option<String>,
    ) -> Self {
        Self {
            upstream: upstream.into(),
            version,
            commit,
        }
    }
}

pub fn encode_language_manifest(manifest: &LanguageManifest) -> Result<Vec<u8>, CodecError> {
    encode(manifest)
}

pub fn decode_language_manifest(bytes: &[u8]) -> Result<LanguageManifest, CodecError> {
    decode(bytes)
}

pub fn encode_theme_manifest(manifest: &ThemeManifest) -> Result<Vec<u8>, CodecError> {
    encode(manifest)
}

pub fn decode_theme_manifest(bytes: &[u8]) -> Result<ThemeManifest, CodecError> {
    decode(bytes)
}

pub fn encode_language_asset(asset: &LanguageAsset) -> Result<Vec<u8>, CodecError> {
    encode(asset)
}

pub fn decode_language_asset(bytes: &[u8]) -> Result<LanguageAsset, CodecError> {
    decode(bytes)
}

pub fn encode_theme_asset(asset: &ThemeAsset) -> Result<Vec<u8>, CodecError> {
    encode(asset)
}

pub fn decode_theme_asset(bytes: &[u8]) -> Result<ThemeAsset, CodecError> {
    decode(bytes)
}

fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>, CodecError> {
    postcard::to_stdvec(value).map_err(CodecError::codec)
}

/// Every encoded value starts with its `format_version`. Reading it first
/// turns a file from another format version into a clear error instead of a
/// decoding failure somewhere in its payload. Format 2 files, encoded before
/// this codec, start with the same leading byte and are reported the same way.
fn decode<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, CodecError> {
    let (found, _) = postcard::take_from_bytes::<u32>(bytes).map_err(CodecError::codec)?;
    if found != FORMAT_VERSION {
        return Err(CodecError {
            kind: CodecErrorKind::UnsupportedFormatVersion { found },
        });
    }
    let (value, rest) = postcard::take_from_bytes(bytes).map_err(CodecError::codec)?;
    if !rest.is_empty() {
        return Err(CodecError {
            kind: CodecErrorKind::TrailingBytes { count: rest.len() },
        });
    }
    Ok(value)
}

/// A versioned asset codec failure. The underlying codec is an implementation detail.
#[derive(Debug)]
pub struct CodecError {
    kind: CodecErrorKind,
}

#[derive(Debug)]
enum CodecErrorKind {
    Codec(postcard::Error),
    UnsupportedFormatVersion { found: u32 },
    TrailingBytes { count: usize },
}

impl CodecError {
    fn codec(source: postcard::Error) -> Self {
        Self {
            kind: CodecErrorKind::Codec(source),
        }
    }

    /// The format version found in the input, when it differs from [`FORMAT_VERSION`].
    #[must_use]
    pub fn unsupported_format_version(&self) -> Option<u32> {
        match self.kind {
            CodecErrorKind::UnsupportedFormatVersion { found } => Some(found),
            _ => None,
        }
    }
}

impl std::fmt::Display for CodecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.kind {
            CodecErrorKind::Codec(source) => source.fmt(f),
            CodecErrorKind::UnsupportedFormatVersion { found } => {
                write!(
                    f,
                    "unsupported asset format version {found}; expected {FORMAT_VERSION}"
                )
            }
            CodecErrorKind::TrailingBytes { count } => {
                write!(
                    f,
                    "{count} unexpected trailing bytes after the encoded value"
                )
            }
        }
    }
}

impl std::error::Error for CodecError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match &self.kind {
            CodecErrorKind::Codec(source) => Some(source),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_manifest_roundtrip_is_stable() {
        let manifest = LanguageManifest {
            format_version: FORMAT_VERSION,
            source: AssetSourceRef {
                upstream: "tm-grammars".to_owned(),
                version: Some("1.0.0".to_owned()),
                commit: Some("abc123".to_owned()),
            },
            entries: vec![LanguageAssetEntry {
                id: "javascript".to_owned(),
                scope_name: "source.js".to_owned(),
                asset_file: "javascript.fkgram".to_owned(),
                display_name: Some("JavaScript".to_owned()),
                aliases: vec!["js".to_owned(), "mjs".to_owned()],
                embedded_langs: vec!["regex".to_owned()],
                embedded_langs_lazy: vec!["css".to_owned()],
                inject_to: vec!["text.html.markdown".to_owned()],
            }],
        };

        let encoded = encode_language_manifest(&manifest).expect("encode");
        let decoded = decode_language_manifest(&encoded).expect("decode");
        let reencoded = encode_language_manifest(&decoded).expect("reencode");

        assert_eq!(decoded, manifest);
        assert_eq!(reencoded, encoded);
    }

    #[test]
    fn theme_manifest_roundtrip_is_stable() {
        let manifest = ThemeManifest {
            format_version: FORMAT_VERSION,
            source: AssetSourceRef {
                upstream: "tm-themes".to_owned(),
                version: Some("2.0.0".to_owned()),
                commit: Some("def456".to_owned()),
            },
            entries: vec![ThemeAssetEntry {
                id: "vitesse-light".to_owned(),
                asset_file: "vitesse-light.fktheme".to_owned(),
                display_name: Some("Vitesse Light".to_owned()),
                theme_type: Some("light".to_owned()),
            }],
        };

        let encoded = encode_theme_manifest(&manifest).expect("encode");
        let decoded = decode_theme_manifest(&encoded).expect("decode");
        let reencoded = encode_theme_manifest(&decoded).expect("reencode");

        assert_eq!(decoded, manifest);
        assert_eq!(reencoded, encoded);
    }

    #[test]
    fn language_asset_roundtrip_is_stable() {
        let asset = LanguageAsset {
            format_version: FORMAT_VERSION,
            id: "javascript".to_owned(),
            scope_name: "source.js".to_owned(),
            display_name: Some("JavaScript".to_owned()),
            aliases: vec!["js".to_owned()],
            embedded_langs: vec!["regex".to_owned()],
            embedded_langs_lazy: vec!["css".to_owned()],
            inject_to: vec!["text.html.markdown".to_owned()],
            grammar_json: r##"{"scopeName":"source.js","patterns":[{"include":"#expression"}]}"##
                .to_owned(),
        };

        let encoded = encode_language_asset(&asset).expect("encode");
        let decoded = decode_language_asset(&encoded).expect("decode");
        let reencoded = encode_language_asset(&decoded).expect("reencode");

        assert_eq!(decoded, asset);
        assert_eq!(reencoded, encoded);
    }

    #[test]
    fn theme_asset_roundtrip_is_stable() {
        let asset = ThemeAsset {
      format_version: FORMAT_VERSION,
      id: "vitesse-light".to_owned(),
      display_name: Some("Vitesse Light".to_owned()),
      theme_type: Some("light".to_owned()),
      theme_json: r##"{"name":"Vitesse Light","type":"light","colors":{"editor.foreground":"#393a34"}}"##.to_owned(),
    };

        let encoded = encode_theme_asset(&asset).expect("encode");
        let decoded = decode_theme_asset(&encoded).expect("decode");
        let reencoded = encode_theme_asset(&decoded).expect("reencode");

        assert_eq!(decoded, asset);
        assert_eq!(reencoded, encoded);
    }

    #[test]
    fn other_format_versions_are_rejected_before_decoding() {
        let asset = ThemeAsset {
            format_version: FORMAT_VERSION + 1,
            id: "demo".to_owned(),
            display_name: None,
            theme_type: None,
            theme_json: "{}".to_owned(),
        };
        let encoded = encode_theme_asset(&asset).expect("encode");
        let error = decode_theme_asset(&encoded).expect_err("newer format");
        assert_eq!(error.unsupported_format_version(), Some(FORMAT_VERSION + 1));

        // Format 2 files were encoded with fixed-width integers.
        let error = decode_theme_asset(&[2, 0, 0, 0, 0]).expect_err("format 2");
        assert_eq!(error.unsupported_format_version(), Some(2));
        assert_eq!(
            error.to_string(),
            format!("unsupported asset format version 2; expected {FORMAT_VERSION}")
        );
    }

    #[test]
    fn trailing_bytes_are_rejected() {
        let asset = ThemeAsset {
            format_version: FORMAT_VERSION,
            id: "demo".to_owned(),
            display_name: None,
            theme_type: None,
            theme_json: "{}".to_owned(),
        };
        let mut encoded = encode_theme_asset(&asset).expect("encode");
        encoded.push(0);
        let error = decode_theme_asset(&encoded).expect_err("trailing byte");
        assert_eq!(error.unsupported_format_version(), None);
        assert!(error.to_string().contains("trailing"), "{error}");
    }
}
