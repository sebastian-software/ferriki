/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

use crate::theme::{FontStyle, StyleAttributes};

const LANGUAGE_ID_MASK: u32 = 0b00000000000000000000000011111111;
const TOKEN_TYPE_MASK: u32 = 0b00000000000000000000001100000000;
const BALANCED_BRACKETS_MASK: u32 = 0b00000000000000000000010000000000;
const FONT_STYLE_MASK: u32 = 0b00000000000000000111100000000000;
const FOREGROUND_MASK: u32 = 0b00000000111111111000000000000000;
const BACKGROUND_MASK: u32 = 0b11111111000000000000000000000000;

const LANGUAGE_ID_OFFSET: u32 = 0;
const TOKEN_TYPE_OFFSET: u32 = 8;
const BALANCED_BRACKETS_OFFSET: u32 = 10;
const FONT_STYLE_OFFSET: u32 = 11;
const FOREGROUND_OFFSET: u32 = 15;
const BACKGROUND_OFFSET: u32 = 24;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
#[repr(u8)]
pub enum StandardTokenType {
    #[default]
    Other = 0,
    Comment = 1,
    String = 2,
    RegEx = 3,
}

impl StandardTokenType {
    fn from_bits(value: u32) -> Self {
        match value {
            0 => Self::Other,
            1 => Self::Comment,
            2 => Self::String,
            3 => Self::RegEx,
            _ => unreachable!("standard token type occupies two bits"),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
#[repr(u8)]
pub enum OptionalStandardTokenType {
    Other = 0,
    Comment = 1,
    String = 2,
    RegEx = 3,
    #[default]
    NotSet = 8,
}

impl OptionalStandardTokenType {
    fn to_standard(self) -> StandardTokenType {
        match self {
            Self::Other => StandardTokenType::Other,
            Self::Comment => StandardTokenType::Comment,
            Self::String => StandardTokenType::String,
            Self::RegEx => StandardTokenType::RegEx,
            Self::NotSet => unreachable!("NotSet does not encode a token type"),
        }
    }
}

#[must_use]
pub const fn to_optional_token_type(standard_type: StandardTokenType) -> OptionalStandardTokenType {
    match standard_type {
        StandardTokenType::Other => OptionalStandardTokenType::Other,
        StandardTokenType::Comment => OptionalStandardTokenType::Comment,
        StandardTokenType::String => OptionalStandardTokenType::String,
        StandardTokenType::RegEx => OptionalStandardTokenType::RegEx,
    }
}

/// The collapsed 32-bit metadata carried by a TextMate scope stack.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct EncodedTokenAttributes(u32);

impl EncodedTokenAttributes {
    #[must_use]
    pub const fn new(value: u32) -> Self {
        Self(value)
    }

    #[must_use]
    pub const fn bits(self) -> u32 {
        self.0
    }

    #[must_use]
    pub fn to_binary_str(self) -> String {
        format!("{:032b}", self.0)
    }

    #[must_use]
    pub const fn language_id(self) -> u32 {
        (self.0 & LANGUAGE_ID_MASK) >> LANGUAGE_ID_OFFSET
    }

    #[must_use]
    pub fn token_type(self) -> StandardTokenType {
        StandardTokenType::from_bits((self.0 & TOKEN_TYPE_MASK) >> TOKEN_TYPE_OFFSET)
    }

    #[must_use]
    pub const fn contains_balanced_brackets(self) -> bool {
        self.0 & BALANCED_BRACKETS_MASK != 0
    }

    #[must_use]
    pub const fn font_style(self) -> FontStyle {
        FontStyle::from_bits(((self.0 & FONT_STYLE_MASK) >> FONT_STYLE_OFFSET) as i32)
    }

    #[must_use]
    pub const fn foreground(self) -> u32 {
        (self.0 & FOREGROUND_MASK) >> FOREGROUND_OFFSET
    }

    #[must_use]
    pub const fn background(self) -> u32 {
        (self.0 & BACKGROUND_MASK) >> BACKGROUND_OFFSET
    }

    /// Update selected metadata fields.
    ///
    /// Zero, `NotSet`, and `None` retain the corresponding current field, as
    /// in vscode-textmate's `EncodedTokenAttributes.set`.
    #[must_use]
    pub fn set(
        self,
        language_id: u32,
        token_type: OptionalStandardTokenType,
        contains_balanced_brackets: Option<bool>,
        font_style: FontStyle,
        foreground: u32,
        background: u32,
    ) -> Self {
        let language_id = if language_id == 0 {
            self.language_id()
        } else {
            language_id
        };
        let token_type = if token_type == OptionalStandardTokenType::NotSet {
            self.token_type()
        } else {
            token_type.to_standard()
        };
        let balanced_brackets =
            contains_balanced_brackets.unwrap_or_else(|| self.contains_balanced_brackets());
        let font_style = if font_style == FontStyle::NOT_SET {
            self.font_style()
        } else {
            font_style
        };
        let foreground = if foreground == 0 {
            self.foreground()
        } else {
            foreground
        };
        let background = if background == 0 {
            self.background()
        } else {
            background
        };

        Self(
            (language_id << LANGUAGE_ID_OFFSET)
                | ((token_type as u32) << TOKEN_TYPE_OFFSET)
                | (u32::from(balanced_brackets) << BALANCED_BRACKETS_OFFSET)
                | ((font_style.bits() as u32) << FONT_STYLE_OFFSET)
                | (foreground << FOREGROUND_OFFSET)
                | (background << BACKGROUND_OFFSET),
        )
    }
}

impl From<u32> for EncodedTokenAttributes {
    fn from(value: u32) -> Self {
        Self(value)
    }
}

impl From<EncodedTokenAttributes> for u32 {
    fn from(value: EncodedTokenAttributes) -> Self {
        value.0
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct FontAttribute {
    pub font_family: Option<String>,
    pub font_size: Option<f64>,
    pub line_height: Option<f64>,
}

impl FontAttribute {
    #[must_use]
    pub fn from(
        font_family: Option<String>,
        font_size: Option<f64>,
        line_height: Option<f64>,
    ) -> Self {
        Self {
            font_family,
            font_size,
            line_height,
        }
    }

    #[must_use]
    pub fn with(&self, style_attributes: Option<&StyleAttributes>) -> Self {
        let Some(style_attributes) = style_attributes else {
            return self.clone();
        };
        Self {
            font_family: if style_attributes.font_family.is_empty() {
                self.font_family.clone()
            } else {
                Some(style_attributes.font_family.clone())
            },
            font_size: if style_attributes.font_size == 0.0 {
                self.font_size
            } else {
                Some(style_attributes.font_size)
            },
            line_height: if style_attributes.line_height == 0.0 {
                self.line_height
            } else {
                Some(style_attributes.line_height)
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        EncodedTokenAttributes, FontAttribute, OptionalStandardTokenType, StandardTokenType,
    };
    use crate::{FontStyle, StyleAttributes};

    fn assert_attributes(
        value: EncodedTokenAttributes,
        language_id: u32,
        token_type: StandardTokenType,
        contains_balanced_brackets: bool,
        font_style: FontStyle,
        foreground: u32,
        background: u32,
    ) {
        assert_eq!(value.language_id(), language_id);
        assert_eq!(value.token_type(), token_type);
        assert_eq!(
            value.contains_balanced_brackets(),
            contains_balanced_brackets
        );
        assert_eq!(value.font_style(), font_style);
        assert_eq!(value.foreground(), foreground);
        assert_eq!(value.background(), background);
    }

    fn initial_attributes() -> EncodedTokenAttributes {
        EncodedTokenAttributes::default().set(
            1,
            OptionalStandardTokenType::RegEx,
            Some(false),
            FontStyle::UNDERLINE | FontStyle::BOLD,
            101,
            102,
        )
    }

    #[test]
    fn sets_and_reads_collapsed_metadata() {
        let value = initial_attributes();

        assert_attributes(
            value,
            1,
            StandardTokenType::RegEx,
            false,
            FontStyle::UNDERLINE | FontStyle::BOLD,
            101,
            102,
        );
        assert_eq!(value.to_binary_str().len(), 32);
    }

    #[test]
    fn preserves_not_set_fields_and_overwrites_selected_fields() {
        let value = initial_attributes()
            .set(
                2,
                OptionalStandardTokenType::NotSet,
                Some(false),
                FontStyle::NOT_SET,
                0,
                0,
            )
            .set(
                0,
                OptionalStandardTokenType::Comment,
                Some(true),
                FontStyle::NONE,
                5,
                7,
            );

        assert_attributes(
            value,
            2,
            StandardTokenType::Comment,
            true,
            FontStyle::NONE,
            5,
            7,
        );
    }

    #[test]
    fn retains_balanced_bracket_state_when_not_set() {
        let value = initial_attributes()
            .set(
                0,
                OptionalStandardTokenType::NotSet,
                Some(true),
                FontStyle::NOT_SET,
                0,
                0,
            )
            .set(
                0,
                OptionalStandardTokenType::NotSet,
                None,
                FontStyle::NOT_SET,
                0,
                0,
            );

        assert!(value.contains_balanced_brackets());
    }

    #[test]
    fn supports_upstream_maximum_field_values() {
        let value = EncodedTokenAttributes::default().set(
            255,
            OptionalStandardTokenType::RegEx,
            Some(true),
            FontStyle::BOLD | FontStyle::ITALIC | FontStyle::UNDERLINE,
            511,
            254,
        );

        assert_attributes(
            value,
            255,
            StandardTokenType::RegEx,
            true,
            FontStyle::BOLD | FontStyle::ITALIC | FontStyle::UNDERLINE,
            511,
            254,
        );
    }

    #[test]
    fn font_attributes_inherit_zero_theme_values() {
        let base = FontAttribute::from(Some("Mono".into()), Some(1.0), Some(1.2));
        let inherited = base.with(Some(&StyleAttributes {
            font_style: FontStyle::NONE,
            foreground_id: 1,
            background_id: 2,
            font_family: String::new(),
            font_size: 0.0,
            line_height: 0.0,
        }));
        assert_eq!(inherited, base);

        let overridden = base.with(Some(&StyleAttributes {
            font_style: FontStyle::NONE,
            foreground_id: 1,
            background_id: 2,
            font_family: "Serif".into(),
            font_size: 1.5,
            line_height: 2.0,
        }));
        assert_eq!(overridden.font_family.as_deref(), Some("Serif"));
        assert_eq!(overridden.font_size, Some(1.5));
        assert_eq!(overridden.line_height, Some(2.0));
    }
}
