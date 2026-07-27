/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

use std::fmt;
use std::sync::Arc;

use crate::basic_scope_attributes::{BasicScopeAttributes, BasicScopeAttributesProvider};
use crate::encoded_token_attributes::{EncodedTokenAttributes, FontAttribute};
use crate::theme::{FontStyle, ScopeStack, StyleAttributes, Theme};

pub trait ScopeAttributesProvider {
    fn metadata_for_scope(&self, scope_name: &str) -> BasicScopeAttributes;
    fn theme_match(&self, scope_path: &ScopeStack) -> Option<StyleAttributes>;
}

pub struct ScopeAttributesResolver<'a> {
    pub basic_scope_attributes: &'a BasicScopeAttributesProvider,
    pub theme: &'a Theme,
}

impl ScopeAttributesProvider for ScopeAttributesResolver<'_> {
    fn metadata_for_scope(&self, scope_name: &str) -> BasicScopeAttributes {
        self.basic_scope_attributes
            .basic_scope_attributes(Some(scope_name))
    }

    fn theme_match(&self, scope_path: &ScopeStack) -> Option<StyleAttributes> {
        self.theme.match_scope(Some(scope_path))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttributedScopeStackFrame {
    pub encoded_token_attributes: EncodedTokenAttributes,
    pub scope_names: Vec<String>,
}

#[derive(Debug)]
pub struct AttributedScopeStack {
    pub parent: Option<Arc<Self>>,
    pub scope_path: Arc<ScopeStack>,
    pub token_attributes: EncodedTokenAttributes,
    pub font_attributes: Option<FontAttribute>,
    pub style_attributes: Option<StyleAttributes>,
}

impl AttributedScopeStack {
    #[must_use]
    pub fn from_extension(
        names_scope_list: Option<Arc<Self>>,
        content_name_scopes_list: &[AttributedScopeStackFrame],
    ) -> Option<Arc<Self>> {
        let mut current = names_scope_list;
        let mut scope_names = current.as_ref().map(|scope| Arc::clone(&scope.scope_path));
        for frame in content_name_scopes_list {
            scope_names = ScopeStack::push(scope_names, frame.scope_names.iter().cloned());
            current = Some(Arc::new(Self {
                parent: current,
                scope_path: Arc::clone(
                    scope_names
                        .as_ref()
                        .expect("attributed scope extension must contain a scope"),
                ),
                token_attributes: frame.encoded_token_attributes,
                font_attributes: None,
                style_attributes: None,
            }));
        }
        current
    }

    #[must_use]
    pub fn create_root(
        scope_name: impl Into<String>,
        token_attributes: EncodedTokenAttributes,
        font_attribute: FontAttribute,
    ) -> Arc<Self> {
        Arc::new(Self {
            parent: None,
            scope_path: Arc::new(ScopeStack {
                parent: None,
                scope_name: scope_name.into(),
            }),
            token_attributes,
            font_attributes: Some(font_attribute),
            style_attributes: None,
        })
    }

    #[must_use]
    pub fn create_root_and_lookup_scope_name(
        scope_name: impl Into<String>,
        token_attributes: EncodedTokenAttributes,
        font_attribute: FontAttribute,
        provider: &impl ScopeAttributesProvider,
    ) -> Arc<Self> {
        let scope_name = scope_name.into();
        let raw_root_metadata = provider.metadata_for_scope(&scope_name);
        let scope_path = Arc::new(ScopeStack {
            parent: None,
            scope_name,
        });
        let root_style = provider.theme_match(&scope_path);
        let resolved_token_attributes =
            merge_attributes(token_attributes, raw_root_metadata, root_style.as_ref());
        let resolved_font_attributes = font_attribute.with(root_style.as_ref());

        Arc::new(Self {
            parent: None,
            scope_path,
            token_attributes: resolved_token_attributes,
            font_attributes: Some(resolved_font_attributes),
            style_attributes: root_style,
        })
    }

    #[must_use]
    pub fn scope_name(&self) -> &str {
        &self.scope_path.scope_name
    }

    #[must_use]
    pub fn equals(left: Option<&Arc<Self>>, right: Option<&Arc<Self>>) -> bool {
        let mut left = left.cloned();
        let mut right = right.cloned();
        loop {
            match (left.as_ref(), right.as_ref()) {
                (Some(left_scope), Some(right_scope)) => {
                    if Arc::ptr_eq(left_scope, right_scope) {
                        return true;
                    }
                    if left_scope.scope_name() != right_scope.scope_name()
                        || left_scope.token_attributes != right_scope.token_attributes
                    {
                        return false;
                    }
                    left = left_scope.parent.clone();
                    right = right_scope.parent.clone();
                }
                (None, None) => return true,
                _ => return false,
            }
        }
    }

    #[must_use]
    pub fn push_attributed(
        self: &Arc<Self>,
        scope_path: Option<&str>,
        provider: &impl ScopeAttributesProvider,
    ) -> Arc<Self> {
        let Some(scope_path) = scope_path else {
            return Arc::clone(self);
        };
        let mut result = Arc::clone(self);
        for scope_name in scope_path.split(' ') {
            result = Self::push_single_attributed(&result, scope_name, provider);
        }
        result
    }

    fn push_single_attributed(
        target: &Arc<Self>,
        scope_name: &str,
        provider: &impl ScopeAttributesProvider,
    ) -> Arc<Self> {
        let raw_metadata = provider.metadata_for_scope(scope_name);
        let new_path = ScopeStack::push(Some(Arc::clone(&target.scope_path)), [scope_name])
            .expect("pushing a scope must produce a scope path");
        let scope_theme_match_result = provider.theme_match(&new_path);
        let metadata = merge_attributes(
            target.token_attributes,
            raw_metadata,
            scope_theme_match_result.as_ref(),
        );
        let font_attributes = target
            .font_attributes
            .as_ref()
            .map(|font| font.with(scope_theme_match_result.as_ref()));
        Arc::new(Self {
            parent: Some(Arc::clone(target)),
            scope_path: new_path,
            token_attributes: metadata,
            font_attributes,
            style_attributes: scope_theme_match_result,
        })
    }

    #[must_use]
    pub fn scope_names(&self) -> Vec<String> {
        self.scope_path.get_segments()
    }

    #[must_use]
    pub fn extension_if_defined(
        self: &Arc<Self>,
        base: Option<&Arc<Self>>,
    ) -> Option<Vec<AttributedScopeStackFrame>> {
        let mut result = Vec::new();
        let mut current = Some(Arc::clone(self));

        while let Some(scope) = current.as_ref() {
            if base.is_some_and(|base| Arc::ptr_eq(scope, base)) {
                break;
            }
            result.push(AttributedScopeStackFrame {
                encoded_token_attributes: scope.token_attributes,
                scope_names: scope
                    .scope_path
                    .get_extension_if_defined(
                        scope.parent.as_ref().map(|parent| &parent.scope_path),
                    )
                    .expect("attributed scope path must extend its parent"),
            });
            current = scope.parent.clone();
        }

        let reached_base = match (current.as_ref(), base) {
            (None, None) => true,
            (Some(current), Some(base)) => Arc::ptr_eq(current, base),
            _ => false,
        };
        reached_base.then(|| {
            result.reverse();
            result
        })
    }
}

impl fmt::Display for AttributedScopeStack {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.scope_names().join(" "))
    }
}

fn merge_attributes(
    existing_token_attributes: EncodedTokenAttributes,
    basic_scope_attributes: BasicScopeAttributes,
    style_attributes: Option<&StyleAttributes>,
) -> EncodedTokenAttributes {
    let (font_style, foreground, background) = style_attributes
        .map_or((FontStyle::NOT_SET, 0, 0), |style| {
            (style.font_style, style.foreground_id, style.background_id)
        });
    existing_token_attributes.set(
        basic_scope_attributes.language_id,
        basic_scope_attributes.token_type,
        None,
        font_style,
        foreground,
        background,
    )
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::{AttributedScopeStack, BasicScopeAttributes, ScopeAttributesProvider};
    use crate::{
        EncodedTokenAttributes, FontAttribute, FontStyle, OptionalStandardTokenType, ScopeStack,
        StyleAttributes,
    };

    struct TestProvider;

    impl ScopeAttributesProvider for TestProvider {
        fn metadata_for_scope(&self, scope_name: &str) -> BasicScopeAttributes {
            BasicScopeAttributes {
                language_id: u32::from(scope_name == "source.embedded"),
                token_type: if scope_name.contains("string") {
                    OptionalStandardTokenType::String
                } else {
                    OptionalStandardTokenType::NotSet
                },
            }
        }

        fn theme_match(&self, scope_path: &ScopeStack) -> Option<StyleAttributes> {
            (scope_path.scope_name == "string.quoted").then(|| StyleAttributes {
                font_style: FontStyle::ITALIC,
                foreground_id: 7,
                background_id: 0,
                font_family: "Serif".into(),
                font_size: 1.2,
                line_height: 0.0,
            })
        }
    }

    #[test]
    fn pushes_scopes_and_merges_language_type_and_theme_metadata() {
        let root = AttributedScopeStack::create_root_and_lookup_scope_name(
            "source.test",
            EncodedTokenAttributes::default().set(
                9,
                OptionalStandardTokenType::NotSet,
                None,
                FontStyle::NONE,
                1,
                2,
            ),
            FontAttribute::from(Some("Mono".into()), Some(1.0), Some(1.0)),
            &TestProvider,
        );
        let pushed = root.push_attributed(Some("source.embedded string.quoted"), &TestProvider);

        assert_eq!(
            pushed.scope_names(),
            ["source.test", "source.embedded", "string.quoted"]
        );
        assert_eq!(pushed.token_attributes.language_id(), 1);
        assert_eq!(
            pushed.token_attributes.token_type(),
            crate::StandardTokenType::String
        );
        assert_eq!(pushed.token_attributes.font_style(), FontStyle::ITALIC);
        assert_eq!(pushed.token_attributes.foreground(), 7);
        assert_eq!(
            pushed
                .font_attributes
                .as_ref()
                .and_then(|font| font.font_family.as_deref()),
            Some("Serif")
        );
    }

    #[test]
    fn compares_structural_scope_and_metadata_values() {
        let first = AttributedScopeStack::create_root(
            "source.test",
            EncodedTokenAttributes::new(1),
            FontAttribute::default(),
        )
        .push_attributed(Some("meta.block"), &TestProvider);
        let second = AttributedScopeStack::create_root(
            "source.test",
            EncodedTokenAttributes::new(1),
            FontAttribute::default(),
        )
        .push_attributed(Some("meta.block"), &TestProvider);
        let different = AttributedScopeStack::create_root(
            "source.test",
            EncodedTokenAttributes::new(2),
            FontAttribute::default(),
        )
        .push_attributed(Some("meta.block"), &TestProvider);

        assert!(AttributedScopeStack::equals(Some(&first), Some(&second)));
        assert!(!AttributedScopeStack::equals(
            Some(&first),
            Some(&different)
        ));
        assert!(AttributedScopeStack::equals(Some(&first), Some(&first)));
    }

    #[test]
    fn roundtrips_scope_extensions() {
        let root = AttributedScopeStack::create_root(
            "source.test",
            EncodedTokenAttributes::new(1),
            FontAttribute::default(),
        );
        let pushed = root.push_attributed(Some("meta.block string.quoted"), &TestProvider);
        let extension = pushed.extension_if_defined(Some(&root)).unwrap();
        let rebuilt =
            AttributedScopeStack::from_extension(Some(Arc::clone(&root)), &extension).unwrap();

        assert!(AttributedScopeStack::equals(Some(&pushed), Some(&rebuilt)));
        assert!(pushed.extension_if_defined(None).is_some());
        let unrelated = AttributedScopeStack::create_root(
            "source.other",
            EncodedTokenAttributes::default(),
            FontAttribute::default(),
        );
        assert!(pushed.extension_if_defined(Some(&unrelated)).is_none());
    }
}
