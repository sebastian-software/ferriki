/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

//! Raw JSON and property-list grammar loading.

use std::error::Error;
use std::fmt;

use crate::plist::{parse_plist, PlistError};
use crate::RawGrammar;

#[derive(Debug)]
pub enum ParseRawGrammarError {
    Json(serde_json::Error),
    Plist(PlistError),
    Grammar(serde_json::Error),
}

impl fmt::Display for ParseRawGrammarError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Json(error) => write!(formatter, "invalid JSON grammar: {error}"),
            Self::Plist(error) => write!(formatter, "invalid property-list grammar: {error}"),
            Self::Grammar(error) => write!(formatter, "invalid raw grammar: {error}"),
        }
    }
}

impl Error for ParseRawGrammarError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Json(error) | Self::Grammar(error) => Some(error),
            Self::Plist(error) => Some(error),
        }
    }
}

/// Parse a TextMate grammar, selecting JSON only for `.json` file names.
///
/// This intentionally follows vscode-textmate's extension dispatch: all
/// extensionless, `.plist`, and `.tmLanguage` inputs use the PLIST reader.
pub fn parse_raw_grammar(
    content: &str,
    file_path: Option<&str>,
) -> Result<RawGrammar, ParseRawGrammarError> {
    if file_path.is_some_and(|path| path.ends_with(".json")) {
        return serde_json::from_str(content).map_err(ParseRawGrammarError::Json);
    }

    let value = parse_plist(content).map_err(ParseRawGrammarError::Plist)?;
    serde_json::from_value(value).map_err(ParseRawGrammarError::Grammar)
}

#[cfg(test)]
mod tests {
    use super::parse_raw_grammar;

    #[test]
    fn dispatches_json_grammar_by_file_extension() {
        let grammar = parse_raw_grammar(
            r#"{"scopeName":"source.json","patterns":[]}"#,
            Some("grammar.json"),
        )
        .unwrap();

        assert_eq!(grammar.scope_name, "source.json");
    }

    #[test]
    fn dispatches_textmate_files_to_the_plist_reader() {
        let grammar = parse_raw_grammar(
            r#"<plist><dict>
                <key>scopeName</key>
                <string>source.plist</string>
                <key>patterns</key>
                <array/>
            </dict></plist>"#,
            Some("grammar.tmLanguage"),
        )
        .unwrap();

        assert_eq!(grammar.scope_name, "source.plist");
    }
}
