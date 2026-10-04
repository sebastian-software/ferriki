//! Private semantic analysis used by Ferriki's Node inline code macro.
//!
//! This crate is deliberately unpublished and is not part of the Rust
//! highlighter API. It recognizes only statically analyzable calls imported
//! from `@ferriki/core/macro`; it never evaluates source code.

use std::collections::HashSet;

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    Argument, CallExpression, Expression, ImportDeclaration, ImportDeclarationSpecifier,
    ImportExpression, ImportOrExportKind, ImportSpecifier, ModuleExportName, ObjectPropertyKind,
    Program, PropertyKey, Statement, TSModuleReference,
};
use oxc_ast_visit::{Visit, walk};
use oxc_parser::Parser;
use oxc_semantic::{Scoping, SemanticBuilder, SymbolId};
use oxc_span::{GetSpan, SourceType, Span};
use serde::Serialize;

const MACRO_MODULE: &str = "@ferriki/core/macro";
const MACRO_EXPORT: &str = "code";

/// Result consumed by the private Node macro transform.
#[derive(Debug, Clone, Serialize)]
pub struct InlineMacroScan {
    pub calls: Vec<InlineMacroCall>,
    pub imports: Vec<InlineMacroImport>,
}

/// One validated inline macro call. Spans are UTF-8 byte offsets into source.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InlineMacroCall {
    pub start: usize,
    pub end: usize,
    pub code: String,
    pub language: String,
    pub meta: Option<String>,
    pub line_numbers: Option<bool>,
}

/// One import declaration to remove or replace after macro expansion.
#[derive(Debug, Clone, Serialize)]
pub struct InlineMacroImport {
    pub start: usize,
    pub end: usize,
    pub replacement: String,
}

/// Parse and analyze JavaScript, JSX, TypeScript, or TSX source for inline
/// `code` calls. Errors include the supplied filename and a source
/// position so a build tool can surface them directly.
pub fn scan_inline_code_macros(source: &str, filename: &str) -> Result<InlineMacroScan, String> {
    let source_type = SourceType::from_path(filename).unwrap_or_else(|_| {
        // Macro source is always consumed as a module. A generic virtual-file
        // name should still support ESM and JSX/TSX syntax (for example an
        // MDX compiler's virtual filename) even when it has no JS suffix.
        SourceType::tsx()
    });
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, source_type).parse();
    if let Some(diagnostic) = parsed.diagnostics.first() {
        let offset = diagnostic
            .labels
            .first()
            .map_or(0, |label| label.offset() as usize);
        return Err(format_diagnostic(
            source,
            filename,
            offset,
            diagnostic.to_string(),
        ));
    }

    let program = parsed.program;
    let semantic = SemanticBuilder::new().build(&program);
    if let Some(diagnostic) = semantic.diagnostics.first() {
        let offset = diagnostic
            .labels
            .first()
            .map_or(0, |label| label.offset() as usize);
        return Err(format_diagnostic(
            source,
            filename,
            offset,
            diagnostic.to_string(),
        ));
    }

    let mut macro_symbols = HashSet::<SymbolId>::new();
    let mut imports = Vec::new();
    collect_imports(&program, source, filename, &mut macro_symbols, &mut imports)?;
    reject_reexports(&program, source, filename)?;

    let mut visitor = MacroReferenceVisitor {
        macro_symbols,
        scoping: semantic.semantic.scoping(),
        references: Vec::new(),
        direct_calls: Vec::new(),
        unsupported_imports: Vec::new(),
    };
    visitor.visit_program(&program);
    if let Some((span, reason)) = visitor.unsupported_imports.first() {
        return Err(format_diagnostic(
            source,
            filename,
            span.start as usize,
            reason,
        ));
    }

    let directly_called: HashSet<_> = visitor
        .direct_calls
        .iter()
        .filter_map(|call| call.reference_id)
        .collect();
    for reference in &visitor.references {
        if !directly_called.contains(&reference.reference_id) {
            return Err(format_diagnostic(
                source,
                filename,
                reference.span.start as usize,
                "the imported code binding must be used as a direct function call",
            ));
        }
    }

    let mut calls = visitor
        .direct_calls
        .into_iter()
        .map(|call| validate_call(call, source, filename))
        .collect::<Result<Vec<_>, _>>()?;
    calls.sort_by_key(|call| (call.start, call.end));
    imports.sort_by_key(|import| (import.start, import.end));
    Ok(InlineMacroScan { calls, imports })
}

fn collect_imports(
    program: &Program<'_>,
    source: &str,
    filename: &str,
    macro_symbols: &mut HashSet<SymbolId>,
    imports: &mut Vec<InlineMacroImport>,
) -> Result<(), String> {
    for statement in &program.body {
        if let Statement::TSImportEqualsDeclaration(declaration) = statement {
            if declaration.import_kind != ImportOrExportKind::Type
                && matches!(
                    &declaration.module_reference,
                    TSModuleReference::ExternalModuleReference(reference)
                        if reference.expression.value.as_str() == MACRO_MODULE
                )
            {
                return Err(format_diagnostic(
                    source,
                    filename,
                    declaration.span.start as usize,
                    "TypeScript `import = require(...)` from `@ferriki/core/macro` is unsupported; use the named ESM `code` import",
                ));
            }
            continue;
        }
        let Statement::ImportDeclaration(declaration) = statement else {
            continue;
        };
        if declaration.source.value.as_str() != MACRO_MODULE {
            continue;
        }

        // A declaration-level `import type` has no runtime binding to erase.
        if declaration.import_kind == ImportOrExportKind::Type {
            continue;
        }

        let Some(specifiers) = &declaration.specifiers else {
            return Err(format_diagnostic(
                source,
                filename,
                declaration.span.start as usize,
                "side-effect imports from `@ferriki/core/macro` are unsupported",
            ));
        };

        let mut macro_specifiers = 0;
        let mut type_specifiers = Vec::new();
        for specifier in specifiers {
            match specifier {
                ImportDeclarationSpecifier::ImportSpecifier(specifier)
                    if specifier.import_kind == ImportOrExportKind::Type =>
                {
                    type_specifiers.push(type_specifier_text(source, specifier));
                }
                ImportDeclarationSpecifier::ImportSpecifier(specifier) => {
                    if imported_name(&specifier.imported) != Some(MACRO_EXPORT) {
                        return Err(format_diagnostic(
                            source,
                            filename,
                            specifier.span.start as usize,
                            format!(
                                "value imports from `{MACRO_MODULE}` are limited to the named `{MACRO_EXPORT}` export"
                            ),
                        ));
                    }
                    let symbol_id = specifier.local.symbol_id.get().ok_or_else(|| {
                        format_diagnostic(
                            source,
                            filename,
                            specifier.local.span.start as usize,
                            "could not resolve the code import binding",
                        )
                    })?;
                    macro_symbols.insert(symbol_id);
                    macro_specifiers += 1;
                }
                ImportDeclarationSpecifier::ImportDefaultSpecifier(specifier) => {
                    return Err(format_diagnostic(
                        source,
                        filename,
                        specifier.span.start as usize,
                        "default imports from `@ferriki/core/macro` are unsupported; import the named `code` export",
                    ));
                }
                ImportDeclarationSpecifier::ImportNamespaceSpecifier(specifier) => {
                    return Err(format_diagnostic(
                        source,
                        filename,
                        specifier.span.start as usize,
                        "namespace imports from `@ferriki/core/macro` are unsupported; import the named `code` export",
                    ));
                }
            }
        }

        if macro_specifiers == 0 && type_specifiers.is_empty() {
            return Err(format_diagnostic(
                source,
                filename,
                declaration.span.start as usize,
                "empty value imports from `@ferriki/core/macro` are unsupported",
            ));
        }

        if macro_specifiers > 0 {
            let replacement = if type_specifiers.is_empty() {
                String::new()
            } else {
                retained_type_import(source, declaration, &type_specifiers)
            };
            imports.push(InlineMacroImport {
                start: declaration.span.start as usize,
                end: declaration.span.end as usize,
                replacement,
            });
        }
    }
    Ok(())
}

fn imported_name<'arena>(name: &ModuleExportName<'arena>) -> Option<&'arena str> {
    match name {
        ModuleExportName::IdentifierName(identifier) => Some(identifier.name.as_str()),
        ModuleExportName::StringLiteral(literal) => Some(literal.value.as_str()),
        ModuleExportName::IdentifierReference(_) => None,
    }
}

fn retained_type_import(
    source: &str,
    declaration: &ImportDeclaration<'_>,
    type_specifiers: &[String],
) -> String {
    let mut replacement = String::from("import type { ");
    for (index, span) in type_specifiers.iter().enumerate() {
        if index > 0 {
            replacement.push_str(", ");
        }
        replacement.push_str(span);
    }
    replacement.push_str(" } from ");
    replacement.push_str(slice_span(source, declaration.source.span));
    if let Some(with_clause) = &declaration.with_clause {
        replacement.push(' ');
        replacement.push_str(slice_span(source, with_clause.span));
    }
    replacement.push(';');
    replacement
}

fn type_specifier_text(source: &str, specifier: &ImportSpecifier<'_>) -> String {
    let imported_span = specifier.imported.span();
    let local_span = specifier.local.span;
    if imported_span == local_span {
        slice_span(source, imported_span).to_owned()
    } else {
        format!(
            "{} as {}",
            slice_span(source, imported_span),
            slice_span(source, local_span)
        )
    }
}

fn reject_reexports(program: &Program<'_>, source: &str, filename: &str) -> Result<(), String> {
    for statement in &program.body {
        let span =
            match statement {
                Statement::ExportAllDeclaration(declaration)
                    if declaration.source.value.as_str() == MACRO_MODULE
                        && declaration.export_kind != ImportOrExportKind::Type =>
                {
                    Some(declaration.span)
                }
                Statement::ExportNamedDeclaration(declaration)
                    if declaration.source.as_ref().is_some_and(|export_source| {
                        export_source.value.as_str() == MACRO_MODULE
                    }) && declaration.export_kind != ImportOrExportKind::Type
                        && (declaration.specifiers.is_empty()
                            || declaration.specifiers.iter().any(|specifier| {
                                specifier.export_kind != ImportOrExportKind::Type
                            })) =>
                {
                    Some(declaration.span)
                }
                _ => None,
            };
        if let Some(span) = span {
            return Err(format_diagnostic(
                source,
                filename,
                span.start as usize,
                "re-exports from `@ferriki/core/macro` are unsupported",
            ));
        }
    }
    Ok(())
}

#[derive(Debug)]
struct MacroReference {
    reference_id: oxc_semantic::ReferenceId,
    span: Span,
}

#[derive(Debug)]
struct DirectCall {
    reference_id: Option<oxc_semantic::ReferenceId>,
    span: Span,
    optional: bool,
    arguments: Vec<ArgumentSnapshot>,
}

#[derive(Debug)]
enum ArgumentSnapshot {
    Spread(Span),
    Expression(ExpressionSnapshot),
}

#[derive(Debug)]
enum ExpressionSnapshot {
    Boolean(bool),
    String {
        value: String,
        span: Span,
        lone_surrogates: bool,
    },
    Template {
        cooked: Option<String>,
        interpolated: bool,
        span: Span,
        lone_surrogates: bool,
    },
    Object(Vec<ObjectPropertySnapshot>),
    Other,
}

#[derive(Debug)]
enum ObjectPropertySnapshot {
    Spread(Span),
    Property {
        span: Span,
        key: Option<String>,
        computed: bool,
        method: bool,
        kind_is_init: bool,
        value: ExpressionSnapshot,
    },
}

struct MacroReferenceVisitor<'s> {
    macro_symbols: HashSet<SymbolId>,
    scoping: &'s Scoping,
    references: Vec<MacroReference>,
    direct_calls: Vec<DirectCall>,
    unsupported_imports: Vec<(Span, &'static str)>,
}

impl<'a> Visit<'a> for MacroReferenceVisitor<'_> {
    fn visit_identifier_reference(&mut self, identifier: &oxc_ast::ast::IdentifierReference<'a>) {
        let Some(reference_id) = identifier.reference_id.get() else {
            return;
        };
        let Some(symbol_id) = self.scoping.get_reference(reference_id).symbol_id() else {
            return;
        };
        if self.macro_symbols.contains(&symbol_id) {
            self.references.push(MacroReference {
                reference_id,
                span: identifier.span,
            });
        }
    }

    fn visit_call_expression(&mut self, expression: &CallExpression<'a>) {
        if let Expression::Identifier(identifier) = &expression.callee
            && identifier.name.as_str() == "require"
            && identifier.reference_id.get().is_some_and(|reference_id| {
                self.scoping
                    .get_reference(reference_id)
                    .symbol_id()
                    .is_none()
            })
            && expression
                .arguments
                .first()
                .and_then(|argument| argument.as_expression())
                .is_some_and(is_macro_module_expression)
        {
            self.unsupported_imports.push((
                expression.span,
                "CommonJS `require()` from `@ferriki/core/macro` is unsupported; use the named ESM `code` import",
            ));
        }
        let reference_id = match &expression.callee {
            Expression::Identifier(identifier) => {
                identifier.reference_id.get().filter(|reference_id| {
                    self.scoping
                        .get_reference(*reference_id)
                        .symbol_id()
                        .is_some_and(|symbol_id| self.macro_symbols.contains(&symbol_id))
                })
            }
            _ => None,
        };
        if let Some(reference_id) = reference_id {
            self.direct_calls.push(DirectCall {
                reference_id: Some(reference_id),
                span: expression.span,
                optional: expression.optional,
                arguments: expression.arguments.iter().map(snapshot_argument).collect(),
            });
        }
        walk::walk_call_expression(self, expression);
    }

    fn visit_import_expression(&mut self, expression: &ImportExpression<'a>) {
        if is_macro_module_expression(&expression.source) {
            self.unsupported_imports.push((
                expression.span,
                "dynamic imports from `@ferriki/core/macro` are unsupported; use the named ESM `code` import",
            ));
        }
        walk::walk_import_expression(self, expression);
    }
}

fn is_macro_module_expression(expression: &Expression<'_>) -> bool {
    match expression {
        Expression::StringLiteral(literal) => literal.value.as_str() == MACRO_MODULE,
        Expression::TemplateLiteral(template) if template.expressions.is_empty() => template
            .quasis
            .first()
            .and_then(|quasi| quasi.value.cooked.as_ref())
            .is_some_and(|specifier| specifier.as_str() == MACRO_MODULE),
        _ => false,
    }
}

fn snapshot_argument(argument: &Argument<'_>) -> ArgumentSnapshot {
    match argument {
        Argument::SpreadElement(spread) => ArgumentSnapshot::Spread(spread.span),
        _ => ArgumentSnapshot::Expression(
            argument
                .as_expression()
                .map(snapshot_expression)
                .unwrap_or(ExpressionSnapshot::Other),
        ),
    }
}

fn snapshot_expression(expression: &Expression<'_>) -> ExpressionSnapshot {
    match expression {
        Expression::BooleanLiteral(literal) => ExpressionSnapshot::Boolean(literal.value),
        Expression::StringLiteral(literal) => ExpressionSnapshot::String {
            value: literal.value.as_str().to_owned(),
            span: literal.span,
            lone_surrogates: literal.lone_surrogates,
        },
        Expression::TemplateLiteral(template) if template.expressions.is_empty() => {
            ExpressionSnapshot::Template {
                cooked: template
                    .quasis
                    .first()
                    .and_then(|quasi| quasi.value.cooked.as_ref())
                    .map(|cooked| cooked.as_str().to_owned()),
                interpolated: false,
                span: template.span,
                lone_surrogates: template.quasis.iter().any(|quasi| quasi.lone_surrogates),
            }
        }
        Expression::TemplateLiteral(template) => ExpressionSnapshot::Template {
            cooked: None,
            interpolated: true,
            span: template.span,
            lone_surrogates: template.quasis.iter().any(|quasi| quasi.lone_surrogates),
        },
        Expression::ObjectExpression(object) => ExpressionSnapshot::Object(
            object
                .properties
                .iter()
                .map(|property| match property {
                    ObjectPropertyKind::SpreadProperty(spread) => {
                        ObjectPropertySnapshot::Spread(spread.span)
                    }
                    ObjectPropertyKind::ObjectProperty(property) => {
                        ObjectPropertySnapshot::Property {
                            span: property.span,
                            key: match &property.key {
                                PropertyKey::StaticIdentifier(identifier) => {
                                    Some(identifier.name.as_str().to_owned())
                                }
                                PropertyKey::StringLiteral(literal) => {
                                    Some(literal.value.as_str().to_owned())
                                }
                                _ => None,
                            },
                            computed: property.computed,
                            method: property.method,
                            kind_is_init: property.kind == oxc_ast::ast::PropertyKind::Init,
                            value: snapshot_expression(&property.value),
                        }
                    }
                })
                .collect(),
        ),
        _ => ExpressionSnapshot::Other,
    }
}

fn validate_call(
    call: DirectCall,
    source: &str,
    filename: &str,
) -> Result<InlineMacroCall, String> {
    if call.optional {
        return Err(format_diagnostic(
            source,
            filename,
            call.span.start as usize,
            "optional calls to `code` are unsupported",
        ));
    }
    if call.arguments.len() != 2 {
        return Err(format_diagnostic(
            source,
            filename,
            call.span.start as usize,
            "`code` requires exactly two non-spread arguments: code and an options object",
        ));
    }
    let code = match &call.arguments[0] {
        ArgumentSnapshot::Spread(span) => {
            return Err(format_diagnostic(
                source,
                filename,
                span.start as usize,
                "spread arguments to `code` are unsupported",
            ));
        }
        ArgumentSnapshot::Expression(ExpressionSnapshot::String {
            value,
            span,
            lone_surrogates,
        }) => {
            reject_lone_surrogates(source, filename, *span, *lone_surrogates, "code string")?;
            value.clone()
        }
        ArgumentSnapshot::Expression(ExpressionSnapshot::Template {
            cooked: Some(code),
            interpolated: false,
            span,
            lone_surrogates,
        }) => {
            reject_lone_surrogates(source, filename, *span, *lone_surrogates, "code template")?;
            code.clone()
        }
        ArgumentSnapshot::Expression(ExpressionSnapshot::Template {
            interpolated: true, ..
        }) => {
            return Err(format_diagnostic(
                source,
                filename,
                call.span.start as usize,
                "template literals passed to `code` cannot contain interpolations",
            ));
        }
        ArgumentSnapshot::Expression(ExpressionSnapshot::Template { cooked: None, .. }) => {
            return Err(format_diagnostic(
                source,
                filename,
                call.span.start as usize,
                "the code template passed to `code` has no cooked value",
            ));
        }
        ArgumentSnapshot::Expression(_) => {
            return Err(format_diagnostic(
                source,
                filename,
                call.span.start as usize,
                "the first `code` argument must be a string literal or an interpolation-free template literal",
            ));
        }
    };
    let options = match &call.arguments[1] {
        ArgumentSnapshot::Spread(span) => {
            return Err(format_diagnostic(
                source,
                filename,
                span.start as usize,
                "spread arguments to `code` are unsupported",
            ));
        }
        ArgumentSnapshot::Expression(ExpressionSnapshot::Object(properties)) => properties,
        _ => {
            return Err(format_diagnostic(
                source,
                filename,
                call.span.start as usize,
                "the second `code` argument must be an object literal",
            ));
        }
    };

    let mut keys = HashSet::new();
    let mut language = None;
    let mut meta = None;
    let mut line_numbers = None;
    for property in options {
        let (span, key, computed, method, kind_is_init, value) = match property {
            ObjectPropertySnapshot::Spread(span) => {
                return Err(format_diagnostic(
                    source,
                    filename,
                    span.start as usize,
                    "spread properties in `code` options are unsupported",
                ));
            }
            ObjectPropertySnapshot::Property {
                span,
                key,
                computed,
                method,
                kind_is_init,
                value,
            } => (
                *span,
                key.as_deref(),
                *computed,
                *method,
                *kind_is_init,
                value,
            ),
        };
        if computed || method || !kind_is_init || key.is_none() {
            return Err(format_diagnostic(
                source,
                filename,
                span.start as usize,
                "computed keys, methods, getters, and setters in `code` options are unsupported",
            ));
        }
        let key = key.expect("checked above");
        if !keys.insert(key.to_owned()) {
            return Err(format_diagnostic(
                source,
                filename,
                span.start as usize,
                format!("duplicate `{key}` key in `code` options"),
            ));
        }
        match key {
            "language" => match value {
                ExpressionSnapshot::String {
                    value,
                    span: value_span,
                    lone_surrogates,
                } => {
                    reject_lone_surrogates(
                        source,
                        filename,
                        *value_span,
                        *lone_surrogates,
                        "`language` option",
                    )?;
                    if value.trim().is_empty() {
                        return Err(format_diagnostic(
                            source,
                            filename,
                            span.start as usize,
                            "`code` requires a nonempty string literal `language` option",
                        ));
                    }
                    language = Some(value.clone());
                }
                _ => {
                    return Err(format_diagnostic(
                        source,
                        filename,
                        span.start as usize,
                        "`code` requires a nonempty string literal `language` option",
                    ));
                }
            },
            "meta" => match value {
                ExpressionSnapshot::String {
                    value,
                    span: value_span,
                    lone_surrogates,
                } => {
                    reject_lone_surrogates(
                        source,
                        filename,
                        *value_span,
                        *lone_surrogates,
                        "`meta` option",
                    )?;
                    meta = Some(value.clone());
                }
                _ => {
                    return Err(format_diagnostic(
                        source,
                        filename,
                        span.start as usize,
                        "the `meta` option must be a string literal",
                    ));
                }
            },
            "lineNumbers" => match value {
                ExpressionSnapshot::Boolean(value) => line_numbers = Some(*value),
                _ => {
                    return Err(format_diagnostic(
                        source,
                        filename,
                        span.start as usize,
                        "the `lineNumbers` option must be a boolean literal",
                    ));
                }
            },
            _ => {
                return Err(format_diagnostic(
                    source,
                    filename,
                    span.start as usize,
                    format!("unknown `{key}` option in `code` call"),
                ));
            }
        }
    }
    let language = language.ok_or_else(|| {
        format_diagnostic(
            source,
            filename,
            call.span.start as usize,
            "`code` options require a nonempty string literal `language`",
        )
    })?;
    Ok(InlineMacroCall {
        start: call.span.start as usize,
        end: call.span.end as usize,
        code,
        language,
        meta,
        line_numbers,
    })
}

fn reject_lone_surrogates(
    source: &str,
    filename: &str,
    span: Span,
    lone_surrogates: bool,
    value_kind: &str,
) -> Result<(), String> {
    if lone_surrogates {
        return Err(format_diagnostic(
            source,
            filename,
            span.start as usize,
            format!(
                "the {value_kind} contains an unpaired UTF-16 surrogate and cannot be represented as UTF-8"
            ),
        ));
    }
    Ok(())
}

fn slice_span(source: &str, span: Span) -> &str {
    source
        .get(span.start as usize..span.end as usize)
        .unwrap_or("")
}

fn format_diagnostic(
    source: &str,
    filename: &str,
    offset: usize,
    message: impl AsRef<str>,
) -> String {
    let offset = offset.min(source.len());
    let prefix = source.get(..offset).unwrap_or(source);
    let line = prefix.bytes().filter(|byte| *byte == b'\n').count() + 1;
    let column = prefix
        .rsplit_once('\n')
        .map_or(prefix, |(_, current_line)| current_line)
        .trim_end_matches('\r')
        .chars()
        .count()
        + 1;
    format!("{filename}:{line}:{column}: {}", message.as_ref())
}

#[cfg(test)]
mod tests {
    use super::scan_inline_code_macros;

    fn scan(source: &str, filename: &str) -> super::InlineMacroScan {
        scan_inline_code_macros(source, filename).unwrap_or_else(|error| panic!("{error}"))
    }

    fn error(source: &str, filename: &str) -> String {
        scan_inline_code_macros(source, filename).expect_err("source should be rejected")
    }

    fn assert_lone_surrogate_error(source: &str, marker: &str, filename: &str) {
        let message = error(source, filename);
        let offset = source.find(marker).expect("the marked literal is present");
        let prefix = &source[..offset];
        let line = prefix.bytes().filter(|byte| *byte == b'\n').count() + 1;
        let line_prefix = prefix.rsplit_once('\n').map_or(prefix, |(_, line)| line);
        let column = line_prefix.chars().count() + 1;
        assert!(
            message.starts_with(&format!("{filename}:{line}:{column}:")),
            "{message}"
        );
        assert!(message.contains("unpaired UTF-16 surrogate"), "{message}");
        assert!(message.contains("UTF-8"), "{message}");
    }

    #[test]
    fn recognizes_aliases_and_ignores_shadowed_names() {
        let result = scan(
            "import { code as snippet } from '@ferriki/core/macro';\nfunction f(snippet) { return snippet('x', { language: 'text' }); }\nwhile (ready) snippet(`a\\nb`, { language: 'ts', meta: 'demo', lineNumbers: false });",
            "example.js",
        );
        assert_eq!(result.calls.len(), 1);
        assert_eq!(result.calls[0].code, "a\nb");
        assert_eq!(result.calls[0].language, "ts");
        assert_eq!(result.calls[0].meta.as_deref(), Some("demo"));
        assert_eq!(result.calls[0].line_numbers, Some(false));
        assert_eq!(result.imports.len(), 1);
        assert_eq!(result.imports[0].replacement, "");
    }

    #[test]
    fn recognizes_cooked_literals_and_keeps_type_imports() {
        use oxc_allocator::Allocator;
        use oxc_parser::Parser;
        use oxc_span::SourceType;

        let source = "import { code as snippet, type CodeOptions as Options } from '@ferriki/core/macro';\nsnippet(`const x = \\u{1F680};`, { language: 'js' });";
        let result = scan(source, "sample.ts");
        assert_eq!(result.calls[0].code, "const x = 🚀;");
        assert_eq!(
            result.imports[0].replacement,
            "import type { CodeOptions as Options } from '@ferriki/core/macro';"
        );
        let allocator = Allocator::default();
        let reparsed =
            Parser::new(&allocator, &result.imports[0].replacement, SourceType::ts()).parse();
        assert!(reparsed.diagnostics.is_empty());
    }

    #[test]
    fn supports_string_and_template_literals_with_optional_metadata() {
        let source = r#"import { code } from '@ferriki/core/macro';
code('π\n', { 'language': 'text', meta: '' });
code(`const rocket = '🚀';`, { language: 'js', lineNumbers: true });"#;
        let result = scan(source, "literals.mjs");
        assert_eq!(result.calls.len(), 2);
        assert_eq!(result.calls[0].code, "π\n");
        assert_eq!(result.calls[0].meta.as_deref(), Some(""));
        assert_eq!(result.calls[0].line_numbers, None);
        assert_eq!(result.calls[1].code, "const rocket = '🚀';");
        assert_eq!(result.calls[1].meta, None);
        assert_eq!(result.calls[1].line_numbers, Some(true));
    }

    #[test]
    fn rejects_lone_surrogates_in_consumed_literals_and_preserves_valid_unicode() {
        let code = r#"const prefix = '🧪';
import { code } from '@ferriki/core/macro';
code('\uD800', { language: 'text' });"#;
        assert_lone_surrogate_error(code, "'\\uD800'", "surrogate.js");

        let template = r#"import { code } from '@ferriki/core/macro';
code(`before \uD800 after`, { language: 'text' });"#;
        assert_lone_surrogate_error(template, "`before \\uD800 after`", "surrogate.mjs");

        let language = r#"import { code } from '@ferriki/core/macro';
code('code', { language: '\uD800' });"#;
        assert_lone_surrogate_error(language, "'\\uD800'", "surrogate-language.ts");

        let metadata = r#"import { code } from '@ferriki/core/macro';
code('code', { language: 'text', meta: '\uD800' });"#;
        assert_lone_surrogate_error(metadata, "'\\uD800'", "surrogate-meta.ts");

        let valid = r#"const ignored = '\uD800';
import { code } from '@ferriki/core/macro';
code('\uD83D\uDE80', { language: 'text' });
code(`\uD83D\uDE80`, { language: 'text' });
code('�', { language: 'text' });"#;
        let result = scan(valid, "valid-unicode.ts");
        assert_eq!(result.calls.len(), 3);
        assert_eq!(result.calls[0].code, "🚀");
        assert_eq!(result.calls[1].code, "🚀");
        assert_eq!(result.calls[2].code, "�");
    }

    #[test]
    fn resolves_cooked_module_specifiers_and_utf8_positions() {
        let source = "const café = 1;\nimport { code } from '@ferriki/core/\\u006dacro';\nconst result = code('x', { language: 'text', extra: true });";
        let message = error(source, "unicode.tsx");
        let offset = source.find("extra").expect("extra option is present");
        let line_prefix = source[..offset]
            .rsplit_once('\n')
            .map_or(&source[..offset], |(_, current_line)| current_line);
        let expected_column = line_prefix.chars().count() + 1;
        assert!(
            message.starts_with(&format!("unicode.tsx:3:{expected_column}:")),
            "{message}"
        );
        assert!(message.contains("unknown `extra` option"), "{message}");

        let byte_source = "const note = '🦀';\nimport { code } from '@ferriki/core/macro';\ncode('ok', { language: 'text' });";
        let result = scan(byte_source, "offset.ts");
        let call_source_start = byte_source.find("code('ok'").unwrap();
        assert_eq!(result.calls[0].start, call_source_start);
        assert_eq!(
            &byte_source[result.calls[0].start..result.calls[0].end],
            "code('ok', { language: 'text' })"
        );
        assert_eq!(
            result.imports[0].start,
            byte_source.find("import ").unwrap()
        );
    }

    #[test]
    fn rejects_escaped_macro_binding_and_unsupported_imports() {
        let escaped = error(
            "import { code as snippet } from '@ferriki/core/macro';\nconst saved = snippet;",
            "escape.ts",
        );
        assert!(escaped.contains("direct function call"), "{escaped}");

        let jsx_escape = error(
            "import { code as Code } from '@ferriki/core/macro';\nexport const view = <Code />;",
            "escape.tsx",
        );
        assert!(jsx_escape.contains("direct function call"), "{jsx_escape}");

        let namespace = error(
            "import * as macros from '@ferriki/core/macro';",
            "namespace.js",
        );
        assert!(namespace.contains("namespace imports"), "{namespace}");

        let other_value = error(
            "import { anotherThing } from '@ferriki/core/macro';",
            "other.js",
        );
        assert!(
            other_value.contains("limited to the named `code`"),
            "{other_value}"
        );
    }

    #[test]
    fn accepts_only_named_esm_value_imports_from_the_macro_subpath() {
        let cases = [
            (
                "import macro from '@ferriki/core/macro';",
                "imports/macro.js",
                "default imports",
            ),
            (
                "import * as macro from '@ferriki/core/macro';",
                "imports/namespace.js",
                "namespace imports",
            ),
            (
                "import '@ferriki/core/macro';",
                "imports/side-effect.js",
                "side-effect imports",
            ),
            (
                "import {} from '@ferriki/core/macro';",
                "imports/empty.js",
                "empty value imports",
            ),
            (
                "export * from '@ferriki/core/macro';",
                "imports/reexport-all.js",
                "re-exports",
            ),
            (
                "export { code } from '@ferriki/core/macro';",
                "imports/reexport-named.js",
                "re-exports",
            ),
            (
                "void import('@ferriki/core/macro');",
                "imports/dynamic.js",
                "dynamic imports",
            ),
            (
                "void import('@ferriki/core/macro', { with: { type: 'json' } });",
                "imports/dynamic-options.js",
                "dynamic imports",
            ),
            (
                "require('@ferriki/core/macro');",
                "imports/require.js",
                "CommonJS `require()`",
            ),
            (
                "require('@ferriki/core/macro', 'extra');",
                "imports/require-extra.js",
                "CommonJS `require()`",
            ),
            (
                "require(`@ferriki/core/macro`, 'extra');",
                "imports/require-template-extra.js",
                "CommonJS `require()`",
            ),
            (
                "import macros = require('@ferriki/core/macro');",
                "imports/equals.ts",
                "`import = require(...)`",
            ),
        ];
        for (source, filename, expected) in cases {
            let message = error(source, filename);
            assert!(message.contains(expected), "{filename}: {message}");
            assert!(message.starts_with(filename), "{filename}: {message}");
        }

        let type_only = scan(
            "import type { CodeOptions as Options } from '@ferriki/core/macro';\nexport type { PreparedCodeBlock } from '@ferriki/core/macro';",
            "imports/types.ts",
        );
        assert!(type_only.calls.is_empty());
        assert!(type_only.imports.is_empty());

        let shadowed_require = scan(
            "function load(require) { return require('@ferriki/core/macro'); }",
            "imports/shadowed-require.js",
        );
        assert!(shadowed_require.calls.is_empty());
        assert!(shadowed_require.imports.is_empty());
    }

    #[test]
    fn rejects_dynamic_arguments_duplicates_and_spreads() {
        for source in [
            "import { code } from '@ferriki/core/macro'; code(getCode(), { language: 'ts' });",
            "import { code } from '@ferriki/core/macro'; code(`x ${name}`, { language: 'ts' });",
            "import { code } from '@ferriki/core/macro'; code('x', { language: 'ts', language: 'js' });",
            "import { code } from '@ferriki/core/macro'; code('x', { ...opts, language: 'ts' });",
            "import { code } from '@ferriki/core/macro'; code(...args, { language: 'ts' });",
            "import { code } from '@ferriki/core/macro'; code('x', { [key]: 'ts' });",
            "import { code } from '@ferriki/core/macro'; code('x', { language: '   ' });",
            "import { code } from '@ferriki/core/macro'; code('x', { language: language });",
            "import { code } from '@ferriki/core/macro'; code('x', { language: 'ts', meta: value });",
            "import { code } from '@ferriki/core/macro'; code('x', { language: 'ts', lineNumbers: 1 });",
            "import { code } from '@ferriki/core/macro'; code('x', { language: 'ts', title: 'demo' });",
            "import { code } from '@ferriki/core/macro'; code('x', {});",
            "import { code } from '@ferriki/core/macro'; code('x', { language: 'ts', get meta() { return 'demo'; } });",
            "import { code } from '@ferriki/core/macro'; code('x', { language: 'ts', set meta(value) {} });",
            "import { code } from '@ferriki/core/macro'; code('x', { language: 'ts', meta() { return 'demo'; } });",
            "import { code } from '@ferriki/core/macro'; code('x', options);",
            "import { code } from '@ferriki/core/macro'; code('x');",
            "import { code } from '@ferriki/core/macro'; code('x', { language: 'ts' }, {});",
            "import { code } from '@ferriki/core/macro'; code(...code, { language: 'ts' });",
            "import { code } from '@ferriki/core/macro'; code?.('x', { language: 'ts' });",
            "import { code } from '@ferriki/core/macro'; (code as any)('x', { language: 'ts' });",
            "import { code } from '@ferriki/core/macro'; code('x', { language: 'ts', meta: 2 });",
        ] {
            let message = error(source, "invalid.ts");
            assert!(message.starts_with("invalid.ts:"), "{message}");
        }
    }

    #[test]
    fn recognizes_tsx_but_ignores_unrelated_functions() {
        let result = scan(
            "import { code } from '@ferriki/core/macro';\nconst ordinary = (code) => code('x', { language: 'js' });\nexport const view = <div>{ordinary}</div>;",
            "example.tsx",
        );
        assert!(result.calls.is_empty());
        assert_eq!(result.imports.len(), 1);
    }

    #[test]
    fn scopes_aliases_across_blocks_parameters_and_destructuring() {
        let result = scan(
            "import { code as snippet } from '@ferriki/core/macro';\nsnippet('kept', { language: 'text' });\n{ const snippet = (source) => source; snippet(readFile(), { language: 'text' }); }\nfunction render({ snippet }) { return snippet(readFile(), { language: 'text' }); }\nconst local = (code) => code(readFile(), { language: 'text' });",
            "scope.mjs",
        );
        assert_eq!(result.calls.len(), 1);
        assert_eq!(result.calls[0].code, "kept");
    }

    #[test]
    fn supports_mdx_virtual_tsx_filenames_and_reports_syntax_errors() {
        let result = scan(
            "import { code } from '@ferriki/core/macro';\nexport const view = <div>{code('x', { language: 'text' })}</div>;",
            "Component.mdx?virtual=1",
        );
        assert_eq!(result.calls.len(), 1);
        assert_eq!(result.calls[0].code, "x");

        let syntax = error("import { code from './broken.js';", "broken.tsx");
        assert!(syntax.starts_with("broken.tsx:1:"), "{syntax}");
        assert!(syntax.to_ascii_lowercase().contains("expected"), "{syntax}");

        let semantics = error("const name = 1; const name = 2;", "semantic.js");
        assert!(semantics.starts_with("semantic.js:"), "{semantics}");
    }
}
