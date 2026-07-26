/// A parsed TextMate grammar `include` reference.
///
/// The variants mirror vscode-textmate's `IncludeReference` classes so rule
/// compilation can dispatch without reinterpreting the original string.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum IncludeReference<'a> {
    Base,
    SelfReference,
    RelativeReference {
        rule_name: &'a str,
    },
    TopLevelReference {
        scope_name: &'a str,
    },
    TopLevelRepositoryReference {
        scope_name: &'a str,
        rule_name: &'a str,
    },
}

/// Parse a TextMate grammar `include` using vscode-textmate's precedence.
pub fn parse_include(include: &str) -> IncludeReference<'_> {
    if include == "$base" {
        IncludeReference::Base
    } else if include == "$self" {
        IncludeReference::SelfReference
    } else if let Some((scope_name, rule_name)) = include.split_once('#') {
        if scope_name.is_empty() {
            IncludeReference::RelativeReference { rule_name }
        } else {
            IncludeReference::TopLevelRepositoryReference {
                scope_name,
                rule_name,
            }
        }
    } else {
        IncludeReference::TopLevelReference {
            scope_name: include,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_include, IncludeReference};

    #[test]
    fn parses_base_and_self_references() {
        assert_eq!(parse_include("$base"), IncludeReference::Base);
        assert_eq!(parse_include("$self"), IncludeReference::SelfReference);
    }

    #[test]
    fn parses_relative_and_top_level_references() {
        assert_eq!(
            parse_include("#string"),
            IncludeReference::RelativeReference {
                rule_name: "string"
            }
        );
        assert_eq!(
            parse_include("source.js"),
            IncludeReference::TopLevelReference {
                scope_name: "source.js"
            }
        );
    }

    #[test]
    fn splits_top_level_repository_references_at_the_first_hash() {
        assert_eq!(
            parse_include("source.js#template#nested"),
            IncludeReference::TopLevelRepositoryReference {
                scope_name: "source.js",
                rule_name: "template#nested",
            }
        );
    }

    #[test]
    fn preserves_upstream_empty_reference_behavior() {
        assert_eq!(
            parse_include(""),
            IncludeReference::TopLevelReference { scope_name: "" }
        );
        assert_eq!(
            parse_include("#"),
            IncludeReference::RelativeReference { rule_name: "" }
        );
        assert_eq!(
            parse_include("source.js#"),
            IncludeReference::TopLevelRepositoryReference {
                scope_name: "source.js",
                rule_name: "",
            }
        );
    }
}
