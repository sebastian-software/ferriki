//! Private semantic analysis used by Ferriki's Node inline code macro.
//!
//! This crate is deliberately unpublished and is not part of the Rust
//! highlighter API. It recognizes only statically analyzable uses imported
//! from Ferriki's build-time macro subpaths; it never evaluates source code.

use std::collections::{HashMap, HashSet};

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    Argument, CallExpression, Expression, ImportDeclaration, ImportDeclarationSpecifier,
    ImportExpression, ImportOrExportKind, ImportSpecifier, JSXAttributeItem, JSXAttributeName,
    JSXAttributeValue, JSXElement, JSXElementName, JSXExpression, ModuleExportName,
    ObjectPropertyKind, Program, PropertyKey, Statement, TSModuleReference,
};
use oxc_ast_visit::{Visit, walk};
use oxc_parser::Parser;
use oxc_semantic::{Scoping, SemanticBuilder, SymbolId};
use oxc_span::{GetSpan, SourceType, Span};
use oxc_syntax::xml_entities::XML_ENTITIES;
use serde::Serialize;

const MACRO_MODULE: &str = "@ferriki/core/macro";
const MACRO_EXPORT: &str = "code";
const REACT_MACRO_MODULE: &str = "@ferriki/core/react/macro";
const REACT_MACRO_EXPORT: &str = "Code";

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
    /// Present only for the React `Code` macro.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<InlineMacroCallKind>,
    /// Original-source presentation expressions, in JSX attribute order.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presentation: Option<Vec<InlineMacroPresentationProp>>,
}

/// A React presentation prop that remains application code for the adapter.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InlineMacroPresentationProp {
    pub name: String,
    /// UTF-8 byte offsets in the original source; braces are excluded for expressions.
    pub start: usize,
    pub end: usize,
    /// Decoded value only when `className` was supplied as a quoted JSX string.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub literal: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InlineMacroCallKind {
    React,
}

/// One import declaration to remove or replace after macro expansion.
#[derive(Debug, Clone, Serialize)]
pub struct InlineMacroImport {
    pub start: usize,
    pub end: usize,
    pub replacement: String,
}

/// Parse and analyze JavaScript, JSX, TypeScript, or TSX source for inline
/// `code` calls and self-closing React `Code` elements. Errors include the supplied filename and a source
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

    let mut macro_symbols = HashMap::<SymbolId, MacroKind>::new();
    let mut imports = Vec::new();
    collect_imports(&program, source, filename, &mut macro_symbols, &mut imports)?;
    reject_reexports(&program, source, filename)?;

    let mut visitor = MacroReferenceVisitor {
        macro_symbols,
        scoping: semantic.semantic.scoping(),
        references: Vec::new(),
        direct_calls: Vec::new(),
        direct_jsx_references: HashSet::new(),
        jsx_calls: Vec::new(),
        jsx_errors: Vec::new(),
        source,
        filename,
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

    let mut directly_called: HashSet<_> = visitor
        .direct_calls
        .iter()
        .filter_map(|call| call.reference_id)
        .collect();
    directly_called.extend(visitor.direct_jsx_references.iter().copied());
    if let Some(error) = visitor.jsx_errors.first() {
        return Err(error.clone());
    }
    for reference in &visitor.references {
        if !directly_called.contains(&reference.reference_id) {
            let message = match reference.kind {
                MacroKind::Code => {
                    "the imported code binding must be used as a direct function call"
                }
                MacroKind::React => {
                    "the imported React Code binding must be used as a direct self-closing JSX element"
                }
            };
            return Err(format_diagnostic(
                source,
                filename,
                reference.span.start as usize,
                message,
            ));
        }
    }

    let mut calls = visitor
        .direct_calls
        .into_iter()
        .map(|call| validate_call(call, source, filename))
        .collect::<Result<Vec<_>, _>>()?;
    calls.extend(visitor.jsx_calls);
    calls.sort_by_key(|call| (call.start, call.end));
    imports.sort_by_key(|import| (import.start, import.end));
    Ok(InlineMacroScan { calls, imports })
}

fn collect_imports(
    program: &Program<'_>,
    source: &str,
    filename: &str,
    macro_symbols: &mut HashMap<SymbolId, MacroKind>,
    imports: &mut Vec<InlineMacroImport>,
) -> Result<(), String> {
    for statement in &program.body {
        if let Statement::TSImportEqualsDeclaration(declaration) = statement {
            if declaration.import_kind != ImportOrExportKind::Type
                && let TSModuleReference::ExternalModuleReference(reference) =
                    &declaration.module_reference
                && let Some((module, _, macro_export)) =
                    macro_module_for_path(reference.expression.value.as_str())
            {
                return Err(format_diagnostic(
                    source,
                    filename,
                    declaration.span.start as usize,
                    format!(
                        "TypeScript `import = require(...)` from `{module}` is unsupported; use the named ESM `{macro_export}` import"
                    ),
                ));
            }
            continue;
        }
        let Statement::ImportDeclaration(declaration) = statement else {
            continue;
        };
        let Some((module, macro_kind, macro_export)) =
            macro_module_for_path(declaration.source.value.as_str())
        else {
            continue;
        };

        // A declaration-level `import type` has no runtime binding to erase.
        if declaration.import_kind == ImportOrExportKind::Type {
            continue;
        }

        let Some(specifiers) = &declaration.specifiers else {
            return Err(format_diagnostic(
                source,
                filename,
                declaration.span.start as usize,
                format!("side-effect imports from `{module}` are unsupported"),
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
                    if imported_name(&specifier.imported) != Some(macro_export) {
                        return Err(format_diagnostic(
                            source,
                            filename,
                            specifier.span.start as usize,
                            format!(
                                "value imports from `{module}` are limited to the named `{macro_export}` export"
                            ),
                        ));
                    }
                    let symbol_id = specifier.local.symbol_id.get().ok_or_else(|| {
                        format_diagnostic(
                            source,
                            filename,
                            specifier.local.span.start as usize,
                            format!("could not resolve the `{macro_export}` import binding"),
                        )
                    })?;
                    macro_symbols.insert(symbol_id, macro_kind);
                    macro_specifiers += 1;
                }
                ImportDeclarationSpecifier::ImportDefaultSpecifier(specifier) => {
                    return Err(format_diagnostic(
                        source,
                        filename,
                        specifier.span.start as usize,
                        format!(
                            "default imports from `{module}` are unsupported; import the named `{macro_export}` export"
                        ),
                    ));
                }
                ImportDeclarationSpecifier::ImportNamespaceSpecifier(specifier) => {
                    return Err(format_diagnostic(
                        source,
                        filename,
                        specifier.span.start as usize,
                        format!(
                            "namespace imports from `{module}` are unsupported; import the named `{macro_export}` export"
                        ),
                    ));
                }
            }
        }

        if macro_specifiers == 0 && type_specifiers.is_empty() {
            return Err(format_diagnostic(
                source,
                filename,
                declaration.span.start as usize,
                format!("empty value imports from `{module}` are unsupported"),
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MacroKind {
    Code,
    React,
}

fn macro_module_for_path(path: &str) -> Option<(&'static str, MacroKind, &'static str)> {
    match path {
        MACRO_MODULE => Some((MACRO_MODULE, MacroKind::Code, MACRO_EXPORT)),
        REACT_MACRO_MODULE => Some((REACT_MACRO_MODULE, MacroKind::React, REACT_MACRO_EXPORT)),
        _ => None,
    }
}

fn is_macro_module(path: &str) -> bool {
    macro_module_for_path(path).is_some()
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
                    if is_macro_module(declaration.source.value.as_str())
                        && declaration.export_kind != ImportOrExportKind::Type =>
                {
                    Some(declaration.span)
                }
                Statement::ExportNamedDeclaration(declaration)
                    if declaration.source.as_ref().is_some_and(|export_source| {
                        is_macro_module(export_source.value.as_str())
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
                "re-exports from Ferriki macro subpaths are unsupported",
            ));
        }
    }
    Ok(())
}

#[derive(Debug)]
struct MacroReference {
    reference_id: oxc_semantic::ReferenceId,
    span: Span,
    kind: MacroKind,
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
    macro_symbols: HashMap<SymbolId, MacroKind>,
    scoping: &'s Scoping,
    references: Vec<MacroReference>,
    direct_calls: Vec<DirectCall>,
    direct_jsx_references: HashSet<oxc_semantic::ReferenceId>,
    jsx_calls: Vec<InlineMacroCall>,
    jsx_errors: Vec<String>,
    source: &'s str,
    filename: &'s str,
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
        if let Some(kind) = self.macro_symbols.get(&symbol_id).copied() {
            self.references.push(MacroReference {
                reference_id,
                span: identifier.span,
                kind,
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
                "CommonJS `require()` from a Ferriki macro subpath is unsupported; use a named ESM macro import",
            ));
        }
        let reference_id = match &expression.callee {
            Expression::Identifier(identifier) => {
                identifier.reference_id.get().filter(|reference_id| {
                    self.scoping
                        .get_reference(*reference_id)
                        .symbol_id()
                        .and_then(|symbol_id| self.macro_symbols.get(&symbol_id))
                        .is_some_and(|kind| *kind == MacroKind::Code)
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

    fn visit_jsx_element(&mut self, element: &JSXElement<'a>) {
        if let JSXElementName::IdentifierReference(identifier) = &element.opening_element.name
            && let Some(reference_id) = identifier.reference_id.get()
            && self
                .scoping
                .get_reference(reference_id)
                .symbol_id()
                .and_then(|symbol_id| self.macro_symbols.get(&symbol_id))
                .is_some_and(|kind| *kind == MacroKind::React)
        {
            self.direct_jsx_references.insert(reference_id);
            match validate_react_element(element, self.source, self.filename) {
                Ok(call) => self.jsx_calls.push(call),
                Err(error) => self.jsx_errors.push(error),
            }
        }
        walk::walk_jsx_element(self, element);
    }

    fn visit_import_expression(&mut self, expression: &ImportExpression<'a>) {
        if is_macro_module_expression(&expression.source) {
            self.unsupported_imports.push((
                expression.span,
                "dynamic imports from Ferriki macro subpaths are unsupported; use a named ESM macro import",
            ));
        }
        walk::walk_import_expression(self, expression);
    }
}

fn is_macro_module_expression(expression: &Expression<'_>) -> bool {
    match expression {
        Expression::StringLiteral(literal) => is_macro_module(literal.value.as_str()),
        Expression::TemplateLiteral(template) if template.expressions.is_empty() => template
            .quasis
            .first()
            .and_then(|quasi| quasi.value.cooked.as_ref())
            .is_some_and(|specifier| is_macro_module(specifier.as_str())),
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
        kind: None,
        presentation: None,
    })
}

fn validate_react_element(
    element: &JSXElement<'_>,
    source: &str,
    filename: &str,
) -> Result<InlineMacroCall, String> {
    if element.closing_element.is_some() || !element.children.is_empty() {
        return Err(format_diagnostic(
            source,
            filename,
            element.span.start as usize,
            "React `Code` macro elements must be self-closing and cannot have children",
        ));
    }

    let mut seen = HashSet::new();
    let mut code = None;
    let mut language = None;
    let mut meta = None;
    let mut line_numbers = None;
    let mut presentation = Vec::new();
    for item in &element.opening_element.attributes {
        let attribute = match item {
            JSXAttributeItem::SpreadAttribute(spread) => {
                return Err(format_diagnostic(
                    source,
                    filename,
                    spread.span.start as usize,
                    "spread attributes on React `Code` macro elements are unsupported",
                ));
            }
            JSXAttributeItem::Attribute(attribute) => attribute,
        };
        let name = match &attribute.name {
            JSXAttributeName::Identifier(name) => name.name.as_str(),
            JSXAttributeName::NamespacedName(name) => {
                return Err(format_diagnostic(
                    source,
                    filename,
                    name.span.start as usize,
                    "namespaced attributes on React `Code` macro elements are unsupported",
                ));
            }
        };
        if !seen.insert(name.to_owned()) {
            return Err(format_diagnostic(
                source,
                filename,
                attribute.span.start as usize,
                format!("duplicate `{name}` attribute on React `Code` macro element"),
            ));
        }
        match name {
            "source" => code = Some(jsx_static_string(attribute, "`source`", source, filename)?),
            "language" => {
                let value = jsx_static_string(attribute, "`language`", source, filename)?;
                if value.trim().is_empty() {
                    return Err(format_diagnostic(
                        source,
                        filename,
                        attribute.span.start as usize,
                        "React `Code` requires a nonempty static string `language` prop",
                    ));
                }
                language = Some(value);
            }
            "meta" => meta = Some(jsx_static_string(attribute, "`meta`", source, filename)?),
            "lineNumbers" => {
                let value = match &attribute.value {
                    None => true,
                    Some(JSXAttributeValue::ExpressionContainer(_)) => {
                        match attribute.value.as_ref().and_then(jsx_attribute_expression) {
                            Some(Expression::BooleanLiteral(literal)) => literal.value,
                            _ => {
                                return Err(format_diagnostic(
                                    source,
                                    filename,
                                    attribute.span.start as usize,
                                    "React `Code` requires `lineNumbers` to be a static boolean",
                                ));
                            }
                        }
                    }
                    _ => {
                        return Err(format_diagnostic(
                            source,
                            filename,
                            attribute.span.start as usize,
                            "React `Code` requires `lineNumbers` to be a static boolean",
                        ));
                    }
                };
                line_numbers = Some(value);
            }
            "render" => presentation.push(jsx_presentation_prop(
                attribute, "render", source, filename,
            )?),
            "className" => presentation.push(jsx_presentation_prop(
                attribute,
                "className",
                source,
                filename,
            )?),
            _ => {
                return Err(format_diagnostic(
                    source,
                    filename,
                    attribute.span.start as usize,
                    format!(
                        "unknown React `Code` prop `{name}`; supported props are `source`, `language`, `meta`, `lineNumbers`, `render`, and `className`; `key`, `ref`, and `children` are unsupported"
                    ),
                ));
            }
        }
    }

    let code = code.ok_or_else(|| {
        format_diagnostic(
            source,
            filename,
            element.span.start as usize,
            "React `Code` requires a static string `source` prop",
        )
    })?;
    let language = language.ok_or_else(|| {
        format_diagnostic(
            source,
            filename,
            element.span.start as usize,
            "React `Code` requires a nonempty static string `language` prop",
        )
    })?;
    Ok(InlineMacroCall {
        start: element.span.start as usize,
        end: element.span.end as usize,
        code,
        language,
        meta,
        line_numbers,
        kind: Some(InlineMacroCallKind::React),
        presentation: (!presentation.is_empty()).then_some(presentation),
    })
}

fn jsx_presentation_prop(
    attribute: &oxc_ast::ast::JSXAttribute<'_>,
    name: &str,
    source: &str,
    filename: &str,
) -> Result<InlineMacroPresentationProp, String> {
    let value = attribute.value.as_ref().ok_or_else(|| {
        format_diagnostic(
            source,
            filename,
            attribute.span.start as usize,
            format!("React `Code` `{name}` must have a nonempty value"),
        )
    })?;

    if name == "className"
        && let JSXAttributeValue::StringLiteral(literal) = value
    {
        reject_lone_surrogates(
            source,
            filename,
            literal.span,
            literal.lone_surrogates,
            "React `Code` `className`",
        )?;
        let (decoded, lone_surrogates) =
            decode_jsx_entities(literal.value.as_str()).map_err(|()| {
                format_diagnostic(
                    source,
                    filename,
                    literal.span.start as usize,
                    "React `Code` `className` contains an invalid numeric JSX character reference",
                )
            })?;
        reject_lone_surrogates(
            source,
            filename,
            literal.span,
            lone_surrogates,
            "React `Code` `className`",
        )?;
        return Ok(InlineMacroPresentationProp {
            name: name.to_owned(),
            start: literal.span.start as usize,
            end: literal.span.end as usize,
            literal: Some(decoded),
        });
    }

    let expression = jsx_attribute_expression(value).ok_or_else(|| {
        format_diagnostic(
            source,
            filename,
            attribute.span.start as usize,
            format!("React `Code` `{name}` must be a nonempty JSX expression"),
        )
    })?;
    if name == "render" && is_obviously_non_function_render(expression) {
        return Err(format_diagnostic(
            source,
            filename,
            expression.span().start as usize,
            "React `Code` `render` must be a callback expression, not a statically obvious nonfunction value",
        ));
    }
    let span = expression.span();
    Ok(InlineMacroPresentationProp {
        name: name.to_owned(),
        start: span.start as usize,
        end: span.end as usize,
        literal: None,
    })
}

fn is_obviously_non_function_render(expression: &Expression<'_>) -> bool {
    match expression {
        Expression::BooleanLiteral(_)
        | Expression::NullLiteral(_)
        | Expression::NumericLiteral(_)
        | Expression::BigIntLiteral(_)
        | Expression::RegExpLiteral(_)
        | Expression::StringLiteral(_)
        | Expression::TemplateLiteral(_)
        | Expression::ArrayExpression(_)
        | Expression::ObjectExpression(_)
        | Expression::JSXElement(_)
        | Expression::JSXFragment(_) => true,
        Expression::ParenthesizedExpression(parenthesized) => {
            is_obviously_non_function_render(&parenthesized.expression)
        }
        Expression::TSAsExpression(assertion) => {
            is_obviously_non_function_render(&assertion.expression)
        }
        Expression::TSSatisfiesExpression(assertion) => {
            is_obviously_non_function_render(&assertion.expression)
        }
        Expression::TSNonNullExpression(assertion) => {
            is_obviously_non_function_render(&assertion.expression)
        }
        Expression::TSInstantiationExpression(instantiation) => {
            is_obviously_non_function_render(&instantiation.expression)
        }
        _ => false,
    }
}

fn jsx_attribute_expression<'b, 'a>(
    value: &'b JSXAttributeValue<'a>,
) -> Option<&'b Expression<'a>> {
    match value {
        JSXAttributeValue::ExpressionContainer(container) => match &container.expression {
            JSXExpression::EmptyExpression(_) => None,
            _ => Some(container.expression.to_expression()),
        },
        _ => None,
    }
}

fn jsx_static_string(
    attribute: &oxc_ast::ast::JSXAttribute<'_>,
    label: &str,
    source: &str,
    filename: &str,
) -> Result<String, String> {
    let snapshot = match &attribute.value {
        Some(JSXAttributeValue::StringLiteral(literal)) => {
            reject_lone_surrogates(
                source,
                filename,
                literal.span,
                literal.lone_surrogates,
                label,
            )?;
            let (value, lone_surrogates) =
                decode_jsx_entities(literal.value.as_str()).map_err(|()| {
                    format_diagnostic(
                        source,
                        filename,
                        literal.span.start as usize,
                        format!("React `Code` {label} contains an invalid numeric JSX character reference"),
                    )
                })?;
            ExpressionSnapshot::String {
                value,
                span: literal.span,
                lone_surrogates,
            }
        }
        Some(value) => jsx_attribute_expression(value)
            .map(snapshot_expression)
            .unwrap_or(ExpressionSnapshot::Other),
        None => ExpressionSnapshot::Other,
    };
    match snapshot {
        ExpressionSnapshot::String {
            value,
            span,
            lone_surrogates,
        } => {
            reject_lone_surrogates(source, filename, span, lone_surrogates, label)?;
            Ok(value)
        }
        ExpressionSnapshot::Template {
            cooked: Some(value),
            interpolated: false,
            span,
            lone_surrogates,
        } => {
            reject_lone_surrogates(source, filename, span, lone_surrogates, label)?;
            Ok(value)
        }
        ExpressionSnapshot::Template {
            interpolated: true, ..
        } => Err(format_diagnostic(
            source,
            filename,
            attribute.span.start as usize,
            format!("React `Code` {label} cannot contain template interpolations"),
        )),
        _ => Err(format_diagnostic(
            source,
            filename,
            attribute.span.start as usize,
            format!("React `Code` {label} must be a static string or cooked template literal"),
        )),
    }
}

fn decode_jsx_entities(input: &str) -> Result<(String, bool), ()> {
    let mut output = Vec::with_capacity(input.len());
    let mut cursor = 0;
    while let Some(relative_ampersand) = input[cursor..].find('&') {
        let ampersand = cursor + relative_ampersand;
        output.extend(input[cursor..ampersand].encode_utf16());
        let after_ampersand = ampersand + 1;
        let bytes = input.as_bytes();
        let mut semicolon = after_ampersand;
        while semicolon < bytes.len()
            && (bytes[semicolon].is_ascii_alphanumeric() || bytes[semicolon] == b'#')
        {
            semicolon += 1;
        }
        if semicolon == bytes.len() {
            output.extend(input[ampersand..].encode_utf16());
            cursor = input.len();
            break;
        }
        if bytes[semicolon] != b';' {
            output.push(b'&' as u16);
            cursor = after_ampersand;
            continue;
        }
        let entity = &input[after_ampersand..semicolon];
        let decoded: Option<u32> = if entity.starts_with('#') {
            decode_numeric_jsx_entity(entity)?
        } else {
            XML_ENTITIES.get(entity).map(|character| *character as u32)
        };
        if let Some(code_point) = decoded {
            if code_point <= 0xFFFF {
                // Keep numeric surrogate references as UTF-16 code units until
                // the complete value is assembled. Adjacent high/low references
                // form one valid Unicode scalar, as they do in JSX runtimes.
                output.push(code_point as u16);
            } else if let Some(character) = char::from_u32(code_point) {
                let mut units = [0; 2];
                output.extend_from_slice(character.encode_utf16(&mut units));
            } else {
                return Err(());
            }
            cursor = semicolon + 1;
        } else {
            // Match the JSX parser behavior: unknown names remain literal.
            output.extend(input[ampersand..=semicolon].encode_utf16());
            cursor = semicolon + 1;
        }
    }
    if cursor < input.len() {
        output.extend(input[cursor..].encode_utf16());
    }
    match String::from_utf16(&output) {
        Ok(value) => Ok((value, false)),
        Err(_) => Ok((String::from_utf16_lossy(&output), true)),
    }
}

fn decode_numeric_jsx_entity(entity: &str) -> Result<Option<u32>, ()> {
    let Some(entity) = entity.strip_prefix('#') else {
        return Ok(None);
    };
    // JSX follows the TypeScript/Babel-compatible lowercase `x` spelling.
    // Uppercase `X` is left as an unknown literal entity.
    let (digits, radix) = if let Some(digits) = entity.strip_prefix('x') {
        (digits, 16)
    } else {
        (entity, 10)
    };
    if digits.is_empty()
        || !digits.chars().all(|character| match radix {
            16 => character.is_ascii_hexdigit(),
            _ => character.is_ascii_digit(),
        })
    {
        return Ok(None);
    }
    let code_point = u32::from_str_radix(digits, radix).map_err(|_| ())?;
    if code_point > 0x10_FFFF {
        return Err(());
    }
    Ok(Some(code_point))
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
        let offset = source.find(marker).expect("the marked literal is present");
        assert_lone_surrogate_error_at_offset(source, offset, filename);
    }

    fn assert_lone_surrogate_error_at_offset(source: &str, offset: usize, filename: &str) {
        let message = error(source, filename);
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

    #[test]
    fn recognizes_react_code_aliases_shadowing_and_mixed_macro_calls() {
        let source = r#"import { code as inline } from '@ferriki/core/macro';
import { Code as PrepareBlock, type CodeProps as Props } from '@ferriki/core/react/macro';
const options: Props = { source: 'typed source', language: 'text' };
const block = <PrepareBlock
  source={`const rocket = '\u{1F680}';\n`}
  language={'tsx'}
  meta={`title="React"`}
  lineNumbers={false}
  render={ui /* keep the bound member */ . CodeBlock}
/>;
function render(PrepareBlock) {
  return <PrepareBlock>shadowed component is ordinary JSX</PrepareBlock>;
}
const plain = inline('plain', { language: 'text' });"#;
        let result = scan(source, "react-macro.tsx");
        assert_eq!(result.calls.len(), 2);
        assert_eq!(result.calls[0].code, "const rocket = '🚀';\n");
        assert_eq!(result.calls[0].language, "tsx");
        assert_eq!(result.calls[0].meta.as_deref(), Some("title=\"React\""));
        assert_eq!(result.calls[0].line_numbers, Some(false));
        assert!(matches!(
            result.calls[0].kind,
            Some(super::InlineMacroCallKind::React)
        ));
        let presentation = result.calls[0].presentation.as_ref().unwrap();
        assert_eq!(presentation.len(), 1);
        assert_eq!(presentation[0].name, "render");
        assert_eq!(
            &source[presentation[0].start..presentation[0].end],
            "ui /* keep the bound member */ . CodeBlock"
        );
        assert!(presentation[0].literal.is_none());
        assert_eq!(result.calls[1].code, "plain");
        assert!(result.calls[1].kind.is_none());
        assert!(result.calls[1].presentation.is_none());
        assert_eq!(result.imports.len(), 2);
        assert_eq!(
            result.imports[1].replacement,
            "import type { CodeProps as Props } from '@ferriki/core/react/macro';"
        );
    }

    #[test]
    fn recognizes_react_jsx_string_semantics_and_runtime_presentation() {
        let source = r#"import { Code } from '@ferriki/core/react/macro';
const first = <Code source="x &amp; y" language="text" className="syntax &amp; color" />;
const second = <Code source={'const π = 1;'} language={`ts`} render={$Block} />;
const third = <Code source={`default`} language="js" lineNumbers render={(source) => <pre>{source}</pre>} />;
const fourth = <Code source="escaped" language="js" render={function Renderer() { return null; }} />;"#;
        let result = scan(source, "react-attributes.jsx");
        assert_eq!(result.calls.len(), 4);
        assert_eq!(result.calls[0].code, "x & y");
        let class_name = &result.calls[0].presentation.as_ref().unwrap()[0];
        assert_eq!(class_name.name, "className");
        assert_eq!(
            &source[class_name.start..class_name.end],
            "\"syntax &amp; color\""
        );
        assert_eq!(class_name.literal.as_deref(), Some("syntax & color"));
        assert_eq!(result.calls[1].code, "const π = 1;");
        let render = &result.calls[1].presentation.as_ref().unwrap()[0];
        assert_eq!(render.name, "render");
        assert_eq!(&source[render.start..render.end], "$Block");
        assert!(render.literal.is_none());
        assert_eq!(result.calls[2].code, "default");
        assert_eq!(result.calls[2].line_numbers, Some(true));
        assert_eq!(
            &source[result.calls[2].presentation.as_ref().unwrap()[0].start
                ..result.calls[2].presentation.as_ref().unwrap()[0].end],
            "(source) => <pre>{source}</pre>"
        );
        assert_eq!(
            &source[result.calls[3].presentation.as_ref().unwrap()[0].start
                ..result.calls[3].presentation.as_ref().unwrap()[0].end],
            "function Renderer() { return null; }"
        );
        assert!(
            result
                .calls
                .iter()
                .all(|call| matches!(call.kind, Some(super::InlineMacroCallKind::React)))
        );
        assert!(result.calls[2].presentation.is_some());
    }

    #[test]
    fn omits_empty_react_presentation() {
        let result = scan(
            "import { Code } from '@ferriki/core/react/macro'; const block = <Code source=\"x\" language=\"text\" />;",
            "empty-presentation.tsx",
        );
        assert!(matches!(
            result.calls[0].kind,
            Some(super::InlineMacroCallKind::React)
        ));
        assert!(result.calls[0].presentation.is_none());
    }

    #[test]
    fn keeps_presentation_order_and_utf8_source_spans() {
        let source = "const π = 1; import { Code } from '@ferriki/core/react/macro';\nconst block = <Code render={renderExample} source=\"x\" language=\"text\" className=\"例 &amp; code\" />;";
        let result = scan(source, "presentation-spans.tsx");
        let presentation = result.calls[0].presentation.as_ref().unwrap();
        assert_eq!(presentation.len(), 2);
        assert_eq!(presentation[0].name, "render");
        assert_eq!(
            &source[presentation[0].start..presentation[0].end],
            "renderExample"
        );
        assert_eq!(presentation[0].literal, None);
        assert_eq!(presentation[1].name, "className");
        assert_eq!(
            &source[presentation[1].start..presentation[1].end],
            "\"例 &amp; code\""
        );
        assert_eq!(presentation[1].literal.as_deref(), Some("例 & code"));
        assert!(presentation[0].start > source.find("π").unwrap());
    }

    #[test]
    fn scans_nested_macros_inside_render_callbacks_and_checks_marker_escapes() {
        let source = r#"import { Code } from '@ferriki/core/react/macro';
const outer = <Code source="outer" language="text" render={(text) => <Code source="inner" language="ts" className={classFor(text)} />} />;"#;
        let result = scan(source, "nested-render.tsx");
        assert_eq!(result.calls.len(), 2);
        assert_eq!(result.calls[0].code, "outer");
        assert_eq!(result.calls[1].code, "inner");
        let render = &result.calls[0].presentation.as_ref().unwrap()[0];
        assert!(&source[render.start..render.end].contains("<Code source=\"inner\""));
        let class_name = &result.calls[1].presentation.as_ref().unwrap()[0];
        assert_eq!(&source[class_name.start..class_name.end], "classFor(text)");

        let react_escape = error(
            "import { Code } from '@ferriki/core/react/macro'; <Code source=\"x\" language=\"ts\" render={Code} />",
            "presentation-escape.tsx",
        );
        assert!(
            react_escape.contains("React Code binding"),
            "{react_escape}"
        );

        let function_escape = error(
            "import { code } from '@ferriki/core/macro'; import { Code } from '@ferriki/core/react/macro'; <Code source=\"x\" language=\"ts\" className={code} />",
            "presentation-escape.tsx",
        );
        assert!(
            function_escape.contains("code binding must be used as a direct function call"),
            "{function_escape}"
        );
    }

    #[test]
    fn decodes_jsx_entities_once_and_preserves_quoted_attribute_whitespace() {
        let source = concat!(
            "import { Code } from '@ferriki/core/react/macro';\n",
            "const entities = <Code source=\"&copy; &#128640; &#x1F680; &#xD83D;&#xDE80; &unknown; &#X1F680; &amp;lt; &amp;&copy; &&amp;\" language=\"text\" />;\n",
            "const whitespace = <Code source=\"first\n  second\tthird\r\nfourth\" language=\"text\" />;"
        );
        let result = scan(source, "jsx-entities.tsx");
        assert_eq!(result.calls.len(), 2);
        assert_eq!(
            result.calls[0].code,
            "© 🚀 🚀 🚀 &unknown; &#X1F680; &lt; &© &&"
        );
        assert_eq!(result.calls[1].code, "first\n  second\tthird\r\nfourth");
    }

    #[test]
    fn rejects_invalid_jsx_numeric_entities_and_unpaired_surrogates() {
        let unpaired = "import { Code } from '@ferriki/core/react/macro';\nconst block = <Code source=\"&#xD800;\" language=\"text\" />;";
        let value_quote = unpaired.find("source=\"").expect("source prop") + "source=".len();
        assert_lone_surrogate_error_at_offset(unpaired, value_quote, "invalid-jsx-entity.tsx");

        let interrupted_pair = "import { Code } from '@ferriki/core/react/macro';\nconst block = <Code source=\"&#xD83D;x&#xDE80;\" language=\"text\" />;";
        let value_quote =
            interrupted_pair.find("source=\"").expect("source prop") + "source=".len();
        assert_lone_surrogate_error_at_offset(
            interrupted_pair,
            value_quote,
            "invalid-jsx-entity.tsx",
        );

        let out_of_range = error(
            "import { Code } from '@ferriki/core/react/macro';\nconst block = <Code source=\"&#x110000;\" language=\"text\" />;",
            "invalid-jsx-entity.tsx",
        );
        assert!(
            out_of_range.starts_with("invalid-jsx-entity.tsx:2:"),
            "{out_of_range}"
        );
        assert!(
            out_of_range.contains("invalid numeric JSX character reference"),
            "{out_of_range}"
        );
    }

    #[test]
    fn rejects_dynamic_or_unsupported_react_code_elements() {
        let cases = [
            (
                "<Code source={source} language=\"ts\" />",
                "`source` must be a static string",
            ),
            (
                "<Code source={`x ${value}`} language=\"ts\" />",
                "cannot contain template interpolations",
            ),
            (
                "<Code source=\"x\" language={language} />",
                "`language` must be a static string",
            ),
            (
                "<Code source=\"x\" language=\"ts\" meta={title} />",
                "`meta` must be a static string",
            ),
            (
                "<Code source=\"x\" language=\"ts\" lineNumbers={enabled} />",
                "`lineNumbers` to be a static boolean",
            ),
            (
                "<Code source=\"x\" language=\"ts\" lineNumbers={} />",
                "JSX attributes must only be assigned a non-empty 'expression'",
            ),
            (
                "<Code language=\"ts\" />",
                "requires a static string `source`",
            ),
            (
                "<Code source=\"x\" />",
                "requires a nonempty static string `language`",
            ),
            (
                "<Code source=\"x\" source=\"y\" language=\"ts\" />",
                "duplicate `source` attribute",
            ),
            (
                "<Code {...props} source=\"x\" language=\"ts\" />",
                "spread attributes",
            ),
            (
                "<Code source=\"x\" language=\"ts\" key=\"key\" />",
                "unknown React `Code` prop `key`",
            ),
            (
                "<Code source=\"x\" language=\"ts\" ref={reference} />",
                "unknown React `Code` prop `ref`",
            ),
            (
                "<Code source=\"x\" language=\"ts\" children=\"child\" />",
                "unknown React `Code` prop `children`",
            ),
            (
                "<Code source=\"x\" language=\"ts\">child</Code>",
                "must be self-closing and cannot have children",
            ),
            (
                "<Code source=\"x\" language=\"ts\" render />",
                "`render` must have a nonempty value",
            ),
            (
                "<Code source=\"x\" language=\"ts\" render={<pre />} />",
                "statically obvious nonfunction value",
            ),
            (
                "<Code source=\"x\" language=\"ts\" render={<>content</>} />",
                "statically obvious nonfunction value",
            ),
            (
                "<Code source=\"x\" language=\"ts\" render={42} />",
                "statically obvious nonfunction value",
            ),
            (
                "<Code source=\"x\" language=\"ts\" render=\"callback\" />",
                "`render` must be a nonempty JSX expression",
            ),
            (
                "<Code source=\"x\" language=\"ts\" render={null} />",
                "statically obvious nonfunction value",
            ),
            (
                "<Code source=\"x\" language=\"ts\" render={{}} />",
                "statically obvious nonfunction value",
            ),
            (
                "<Code source=\"x\" language=\"ts\" render={[]} />",
                "statically obvious nonfunction value",
            ),
            (
                "<Code source=\"x\" language=\"ts\" component={widget} />",
                "unknown React `Code` prop `component`",
            ),
        ];
        for (jsx, expected) in cases {
            let source = format!("import {{ Code }} from '@ferriki/core/react/macro'; {jsx}");
            let message = error(&source, "invalid-react.tsx");
            assert!(message.contains(expected), "{jsx}: {message}");
            assert!(message.starts_with("invalid-react.tsx:"), "{message}");
        }

        let same_binding = error(
            "import { Code } from '@ferriki/core/react/macro'; <Code source=\"x\" language=\"ts\" render={Code} />",
            "react-binding.tsx",
        );
        assert!(
            same_binding.contains("React Code binding"),
            "{same_binding}"
        );

        let other_macro_binding = error(
            "import { code as InlineCode } from '@ferriki/core/macro'; import { Code } from '@ferriki/core/react/macro'; <Code source=\"x\" language=\"ts\" className={InlineCode} />",
            "react-other-binding.tsx",
        );
        assert!(
            other_macro_binding.contains("code binding must be used as a direct function call"),
            "{other_macro_binding}"
        );
    }

    #[test]
    fn leaves_lowercase_jsx_intrinsics_outside_react_macro_analysis() {
        let result = scan(
            "import { Code as code } from '@ferriki/core/react/macro'; const view = <code source=\"x\" language=\"text\">ordinary intrinsic</code>;",
            "intrinsic.jsx",
        );
        assert!(result.calls.is_empty());
        assert_eq!(result.imports.len(), 1);
        assert_eq!(result.imports[0].replacement, "");
    }

    #[test]
    fn enforces_react_macro_module_import_constraints_and_keeps_type_only_forms() {
        let cases = [
            (
                "import Code from '@ferriki/core/react/macro';",
                "default imports",
            ),
            (
                "import * as macros from '@ferriki/core/react/macro';",
                "namespace imports",
            ),
            ("import '@ferriki/core/react/macro';", "side-effect imports"),
            (
                "import { code } from '@ferriki/core/react/macro';",
                "limited to the named `Code` export",
            ),
            (
                "export { Code } from '@ferriki/core/react/macro';",
                "re-exports from Ferriki macro subpaths",
            ),
            (
                "void import('@ferriki/core/react/macro');",
                "dynamic imports from Ferriki macro subpaths",
            ),
            (
                "require('@ferriki/core/react/macro');",
                "CommonJS `require()` from a Ferriki macro subpath",
            ),
            (
                "import reactMacro = require('@ferriki/core/react/macro');",
                "`import = require(...)` from `@ferriki/core/react/macro`",
            ),
        ];
        for (source, expected) in cases {
            let message = error(source, "react-imports.tsx");
            assert!(message.contains(expected), "{source}: {message}");
            assert!(message.starts_with("react-imports.tsx:"), "{message}");
        }

        let type_only = scan(
            "import type { CodeProps } from '@ferriki/core/react/macro'; export type { CodeProps as Props } from '@ferriki/core/react/macro';",
            "react-types.tsx",
        );
        assert!(type_only.calls.is_empty());
        assert!(type_only.imports.is_empty());
    }
}
