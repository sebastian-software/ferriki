/**
 * Static analysis of Ferriki's inline highlighting macros on the ESTree that
 * Vite's own parser (Rolldown's OXC `parseAst`) returns. Offsets are the
 * UTF-16 `start`/`end` positions of that tree, the same model `magic-string`
 * edits in. Nothing is evaluated: only literals written inline are accepted.
 */

/** Module specifiers that carry a macro marker, with the one named export each accepts. */
const MACRO_MODULES = new Map([
  ["@ferriki/core/macro", { kind: "code", exportName: "code" }],
  ["@ferriki/core/react/macro", { kind: "react", exportName: "Code" }],
]);

/** The exact specifier spellings that the transform's code filter looks for. */
export const MACRO_MODULE_SPECIFIERS = Object.freeze([...MACRO_MODULES.keys()]);

/** Object keys of TypeScript annotations; their subtrees are erased before runtime. */
const TYPE_KEYS = new Set([
  "typeAnnotation",
  "typeParameters",
  "typeArguments",
  "returnType",
  "superTypeArguments",
  "superTypeParameters",
  "implements",
]);

const SKIPPED_KEYS = new Set(["type", "start", "end", "range", "loc"]);

// JSX character references (the XML/HTML 4 set that JSX compilers decode),
// written as `name:hex-code-point`.
const JSX_ENTITIES = new Map(
  `quot:22 amp:26 apos:27 lt:3c gt:3e nbsp:a0 iexcl:a1 cent:a2 pound:a3 curren:a4 yen:a5
brvbar:a6 sect:a7 uml:a8 copy:a9 ordf:aa laquo:ab not:ac shy:ad reg:ae macr:af deg:b0
plusmn:b1 sup2:b2 sup3:b3 acute:b4 micro:b5 para:b6 middot:b7 cedil:b8 sup1:b9 ordm:ba
raquo:bb frac14:bc frac12:bd frac34:be iquest:bf Agrave:c0 Aacute:c1 Acirc:c2 Atilde:c3
Auml:c4 Aring:c5 AElig:c6 Ccedil:c7 Egrave:c8 Eacute:c9 Ecirc:ca Euml:cb Igrave:cc Iacute:cd
Icirc:ce Iuml:cf ETH:d0 Ntilde:d1 Ograve:d2 Oacute:d3 Ocirc:d4 Otilde:d5 Ouml:d6 times:d7
Oslash:d8 Ugrave:d9 Uacute:da Ucirc:db Uuml:dc Yacute:dd THORN:de szlig:df agrave:e0
aacute:e1 acirc:e2 atilde:e3 auml:e4 aring:e5 aelig:e6 ccedil:e7 egrave:e8 eacute:e9
ecirc:ea euml:eb igrave:ec iacute:ed icirc:ee iuml:ef eth:f0 ntilde:f1 ograve:f2 oacute:f3
ocirc:f4 otilde:f5 ouml:f6 divide:f7 oslash:f8 ugrave:f9 uacute:fa ucirc:fb uuml:fc
yacute:fd thorn:fe yuml:ff OElig:152 oelig:153 Scaron:160 scaron:161 Yuml:178 fnof:192
circ:2c6 tilde:2dc Alpha:391 Beta:392 Gamma:393 Delta:394 Epsilon:395 Zeta:396 Eta:397
Theta:398 Iota:399 Kappa:39a Lambda:39b Mu:39c Nu:39d Xi:39e Omicron:39f Pi:3a0 Rho:3a1
Sigma:3a3 Tau:3a4 Upsilon:3a5 Phi:3a6 Chi:3a7 Psi:3a8 Omega:3a9 alpha:3b1 beta:3b2
gamma:3b3 delta:3b4 epsilon:3b5 zeta:3b6 eta:3b7 theta:3b8 iota:3b9 kappa:3ba lambda:3bb
mu:3bc nu:3bd xi:3be omicron:3bf pi:3c0 rho:3c1 sigmaf:3c2 sigma:3c3 tau:3c4 upsilon:3c5
phi:3c6 chi:3c7 psi:3c8 omega:3c9 thetasym:3d1 upsih:3d2 piv:3d6 ensp:2002 emsp:2003
thinsp:2009 zwnj:200c zwj:200d lrm:200e rlm:200f ndash:2013 mdash:2014 lsquo:2018
rsquo:2019 sbquo:201a ldquo:201c rdquo:201d bdquo:201e dagger:2020 Dagger:2021 bull:2022
hellip:2026 permil:2030 prime:2032 Prime:2033 lsaquo:2039 rsaquo:203a oline:203e
frasl:2044 euro:20ac image:2111 weierp:2118 real:211c trade:2122 alefsym:2135 larr:2190
uarr:2191 rarr:2192 darr:2193 harr:2194 crarr:21b5 lArr:21d0 uArr:21d1 rArr:21d2 dArr:21d3
hArr:21d4 forall:2200 part:2202 exist:2203 empty:2205 nabla:2207 isin:2208 notin:2209
ni:220b prod:220f sum:2211 minus:2212 lowast:2217 radic:221a prop:221d infin:221e ang:2220
and:2227 or:2228 cap:2229 cup:222a int:222b there4:2234 sim:223c cong:2245 asymp:2248
ne:2260 equiv:2261 le:2264 ge:2265 sub:2282 sup:2283 nsub:2284 sube:2286 supe:2287
oplus:2295 otimes:2297 perp:22a5 sdot:22c5 lceil:2308 rceil:2309 lfloor:230a rfloor:230b
lang:2329 rang:232a loz:25ca spades:2660 clubs:2663 hearts:2665 diams:2666`
    .split(/\s+/)
    .map((entry) => {
      const [name, codePoint] = entry.split(":");
      return [name, Number.parseInt(codePoint, 16)];
    }),
);

/** A compile error at a UTF-16 offset of the scanned module. */
export class MacroDiagnostic extends Error {
  /**
   * @param {number} offset UTF-16 offset in the module source.
   * @param {string} message Diagnostic without a location prefix.
   */
  constructor(offset, message) {
    super(message);
    this.name = "MacroDiagnostic";
    this.offset = offset;
  }
}

/**
 * Validate every macro use in one parsed module and return the edits needed to
 * lower it. Throws a {@link MacroDiagnostic} for the first unsupported form.
 *
 * @param {any} program ESTree `Program` from Vite's `parseAst`.
 * @param {string} source The exact text that was parsed.
 * @returns {{
 *   calls: Array<Record<string, any>>,
 *   imports: Array<{ start: number, end: number, replacement: string }>,
 *   names: Set<string>,
 * }} Validated calls and elements, import edits, and every identifier name in the module.
 */
export function scanInlineCodeMacros(program, source) {
  const scanner = new MacroScanner(source);
  scanner.collectImports(program);
  scanner.rejectReexports(program);
  scanner.visit(program);
  return scanner.finish();
}

class MacroScanner {
  constructor(source) {
    this.source = source;
    /** Local binding name -> `code` | `react`. */
    this.macroNames = new Map();
    /** Import specifier nodes that bind a macro; they are the reserved declaration itself. */
    this.macroBindings = new Set();
    this.imports = [];
    /** Every Identifier and JSXIdentifier name, for collision-free generated names. */
    this.names = new Set();
    /** Every name bound anywhere in the module, in any scope. */
    this.declared = new Set();
    /** Offsets where an object literal would be read as a block. */
    this.statementStarts = new Set();
    this.directCalls = [];
    this.jsxCalls = [];
    this.requireCalls = [];
    this.unsupportedImport = undefined;
    this.reservedDeclaration = undefined;
    this.jsxError = undefined;
    this.escapedReference = undefined;
  }

  collectImports(program) {
    for (const statement of program.body) {
      if (statement.type === "TSImportEqualsDeclaration") {
        const reference = statement.moduleReference;
        const module =
          statement.importKind !== "type" &&
          reference?.type === "TSExternalModuleReference" &&
          macroModule(reference.expression?.value);
        if (module)
          throw new MacroDiagnostic(
            statement.start,
            `TypeScript \`import = require(...)\` from \`${module.specifier}\` is unsupported; use the named ESM \`${module.exportName}\` import`,
          );
        continue;
      }
      if (statement.type !== "ImportDeclaration") continue;
      const module = macroModule(statement.source.value);
      // A declaration-level `import type` has no runtime binding to erase.
      if (!module || statement.importKind === "type") continue;
      const { specifier, exportName, kind } = module;

      if (statement.specifiers.length === 0) {
        const head = this.source
          .slice(statement.start + "import".length, statement.source.start)
          .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")
          .trim();
        throw new MacroDiagnostic(
          statement.start,
          head
            ? `empty value imports from \`${specifier}\` are unsupported`
            : `side-effect imports from \`${specifier}\` are unsupported`,
        );
      }

      let macroSpecifiers = 0;
      const typeSpecifiers = [];
      for (const item of statement.specifiers) {
        if (item.type === "ImportDefaultSpecifier")
          throw new MacroDiagnostic(
            item.start,
            `default imports from \`${specifier}\` are unsupported; import the named \`${exportName}\` export`,
          );
        if (item.type === "ImportNamespaceSpecifier")
          throw new MacroDiagnostic(
            item.start,
            `namespace imports from \`${specifier}\` are unsupported; import the named \`${exportName}\` export`,
          );
        if (item.importKind === "type") {
          typeSpecifiers.push(this.typeSpecifierText(item));
          continue;
        }
        if (moduleExportName(item.imported) !== exportName)
          throw new MacroDiagnostic(
            item.start,
            `value imports from \`${specifier}\` are limited to the named \`${exportName}\` export`,
          );
        const name = item.local.name;
        if (this.macroNames.has(name))
          throw new MacroDiagnostic(item.local.start, reservedMessage(name, kind));
        this.macroNames.set(name, kind);
        this.macroBindings.add(item.local);
        macroSpecifiers++;
      }

      if (macroSpecifiers > 0)
        this.imports.push({
          start: statement.start,
          end: statement.end,
          replacement: typeSpecifiers.length
            ? this.retainedTypeImport(statement, typeSpecifiers)
            : "",
        });
    }
  }

  rejectReexports(program) {
    for (const statement of program.body) {
      const reexport =
        (statement.type === "ExportAllDeclaration" &&
          macroModule(statement.source.value) &&
          statement.exportKind !== "type") ||
        (statement.type === "ExportNamedDeclaration" &&
          statement.source &&
          macroModule(statement.source.value) &&
          statement.exportKind !== "type" &&
          (statement.specifiers.length === 0 ||
            statement.specifiers.some((item) => item.exportKind !== "type")));
      if (reexport)
        throw new MacroDiagnostic(
          statement.start,
          "re-exports from Ferriki macro subpaths are unsupported",
        );
    }
  }

  finish() {
    const unsupportedRequire = this.declared.has("require") ? undefined : this.requireCalls[0];
    const unsupported = [this.unsupportedImport, unsupportedRequire]
      .filter(Boolean)
      .sort((left, right) => left.offset - right.offset)[0];
    for (const diagnostic of [
      unsupported,
      this.reservedDeclaration,
      this.jsxError,
      this.escapedReference,
    ])
      if (diagnostic) throw diagnostic;

    const calls = [
      ...this.directCalls.map((call) => this.validateCall(call)),
      ...this.jsxCalls,
    ].sort((left, right) => left.start - right.start || left.end - right.end);
    return { calls, imports: this.imports, names: this.names };
  }

  // --- Tree walk ----------------------------------------------------------

  /** Walk a node in a runtime (value) position. */
  visit(node) {
    if (Array.isArray(node)) {
      for (const child of node) this.visit(child);
      return;
    }
    if (!node || typeof node.type !== "string") return;

    switch (node.type) {
      case "Identifier":
        this.names.add(node.name);
        this.reference(node);
        return;
      case "Literal":
      case "TemplateElement":
      case "JSXText":
      case "JSXEmptyExpression":
      case "ThisExpression":
      case "Super":
      case "PrivateIdentifier":
        return;
      case "ImportDeclaration":
        this.visitImport(node);
        return;
      case "ExportNamedDeclaration":
        this.visitExportNamed(node);
        return;
      case "ExportAllDeclaration":
        this.collect(node.exported);
        return;
      case "ExpressionStatement":
        this.statementStarts.add(node.start);
        this.visit(node.expression);
        return;
      case "VariableDeclarator":
        this.pattern(node.id, true);
        this.visit(node.init);
        return;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        this.visitFunction(node);
        return;
      case "TSDeclareFunction":
        // An overload signature or ambient function: only its name is a binding.
        if (node.id) this.declare(node.id);
        this.collect([node.typeParameters, node.params, node.returnType]);
        return;
      case "TSEmptyBodyFunctionExpression":
        this.collect(node);
        return;
      case "ClassDeclaration":
      case "ClassExpression":
        this.visit(node.decorators);
        if (node.id) this.declare(node.id);
        this.collect([node.typeParameters, node.superTypeArguments, node.implements]);
        this.visit(node.superClass);
        this.visit(node.body);
        return;
      case "MethodDefinition":
      case "PropertyDefinition":
      case "AccessorProperty":
      case "TSAbstractMethodDefinition":
      case "TSAbstractPropertyDefinition":
      case "TSAbstractAccessorProperty":
        this.visit(node.decorators);
        this.visitKey(node);
        this.collect(node.typeAnnotation);
        this.visit(node.value);
        return;
      case "Property":
        this.visitKey(node);
        this.visit(node.value);
        return;
      case "MemberExpression":
        this.visit(node.object);
        if (node.computed) this.visit(node.property);
        else this.collect(node.property);
        return;
      case "CallExpression":
        this.visitCall(node);
        return;
      case "ImportExpression":
        if (isMacroSpecifier(node.source))
          this.unsupportedImport ??= new MacroDiagnostic(
            node.start,
            "dynamic imports from Ferriki macro subpaths are unsupported; use a named ESM macro import",
          );
        this.visit(node.source);
        this.visit(node.options);
        return;
      case "CatchClause":
        if (node.param) this.pattern(node.param, true);
        this.visit(node.body);
        return;
      case "AssignmentExpression":
        this.pattern(node.left, false);
        this.visit(node.right);
        return;
      case "ForInStatement":
      case "ForOfStatement":
        if (node.left.type === "VariableDeclaration") this.visit(node.left);
        else this.pattern(node.left, false);
        this.visit(node.right);
        this.visit(node.body);
        return;
      case "LabeledStatement":
        this.collect(node.label);
        this.visit(node.body);
        return;
      case "BreakStatement":
      case "ContinueStatement":
      case "MetaProperty":
        this.collect(node);
        return;
      case "JSXElement":
        this.visitJsxElement(node);
        return;
      case "JSXAttribute":
        this.collect(node.name);
        this.visit(node.value);
        return;
      case "TSAsExpression":
      case "TSSatisfiesExpression":
      case "TSTypeAssertion":
      case "TSNonNullExpression":
      case "TSInstantiationExpression":
        this.visit(node.expression);
        this.collect([node.typeAnnotation, node.typeArguments]);
        return;
      case "TSEnumDeclaration":
        this.declare(node.id);
        this.visit(node.body);
        return;
      case "TSEnumMember":
        if (node.computed) this.visit(node.id);
        else if (node.id.type === "Identifier") this.declare(node.id);
        else this.collect(node.id);
        this.visit(node.initializer);
        return;
      case "TSModuleDeclaration":
        if (node.id.type === "Identifier") this.declare(node.id);
        else if (node.id.type === "TSQualifiedName") this.declare(leftmostName(node.id));
        else this.collect(node.id);
        this.visit(node.body);
        return;
      case "TSImportEqualsDeclaration":
        this.declare(node.id);
        // `import x = A.B` reads the runtime value `A`; type-only forms are erased.
        if (node.importKind === "type" || node.moduleReference.type === "TSExternalModuleReference")
          this.collect(node.moduleReference);
        else this.visit(leftmostName(node.moduleReference));
        return;
      case "TSParameterProperty":
        this.visit(node.decorators);
        this.pattern(node.parameter, true);
        return;
      case "TSTypeAliasDeclaration":
      case "TSInterfaceDeclaration":
        this.declare(node.id);
        this.collect([node.typeParameters, node.typeAnnotation, node.extends, node.body]);
        return;
      default:
        // Remaining TypeScript nodes are types, which are erased before runtime;
        // `TSExportAssignment`, `TSEnumBody` and `TSModuleBlock` hold values.
        if (
          node.type.startsWith("TS") &&
          !["TSExportAssignment", "TSEnumBody", "TSModuleBlock"].includes(node.type)
        ) {
          this.collect(node);
          return;
        }
        this.visitChildren(node);
    }
  }

  visitChildren(node) {
    for (const key of Object.keys(node)) {
      if (SKIPPED_KEYS.has(key)) continue;
      if (TYPE_KEYS.has(key)) this.collect(node[key]);
      else this.visit(node[key]);
    }
  }

  visitKey(node) {
    if (node.computed) this.visit(node.key);
    else this.collect(node.key);
  }

  visitImport(node) {
    this.collect([node.source, node.attributes]);
    for (const item of node.specifiers) {
      if (item.imported) this.collect(item.imported);
      if (this.macroBindings.has(item.local)) this.names.add(item.local.name);
      else this.declare(item.local);
    }
  }

  visitExportNamed(node) {
    this.visit(node.declaration);
    this.collect([node.source, node.attributes]);
    for (const item of node.specifiers) {
      this.collect(item.exported);
      // A re-export names another module's binding; a type export is erased.
      if (node.source || node.exportKind === "type" || item.exportKind === "type")
        this.collect(item.local);
      else this.visit(item.local);
    }
  }

  visitFunction(node) {
    this.visit(node.decorators);
    if (node.id) this.declare(node.id);
    for (const parameter of node.params) this.pattern(parameter, true);
    this.collect([node.typeParameters, node.returnType]);
    // An object literal must not be emitted as the first token of a concise body.
    if (node.type === "ArrowFunctionExpression" && node.expression)
      this.statementStarts.add(node.body.start);
    this.visit(node.body);
  }

  visitCall(node) {
    const callee = node.callee;
    if (
      callee.type === "Identifier" &&
      callee.name === "require" &&
      isMacroSpecifier(node.arguments[0])
    )
      // Reported in `finish()` unless the module binds its own `require`.
      this.requireCalls.push(
        new MacroDiagnostic(
          node.start,
          "CommonJS `require()` from a Ferriki macro subpath is unsupported; use a named ESM macro import",
        ),
      );
    if (callee.type === "Identifier" && this.macroNames.get(callee.name) === "code") {
      this.names.add(callee.name);
      this.directCalls.push(node);
    } else {
      this.visit(callee);
    }
    this.collect(node.typeArguments);
    this.visit(node.arguments);
  }

  visitJsxElement(node) {
    const opening = node.openingElement;
    const name = opening.name;
    const macroKind =
      name.type === "JSXIdentifier" && isJsxReferenceName(name.name)
        ? this.macroNames.get(name.name)
        : undefined;
    if (macroKind === "react") {
      this.names.add(name.name);
      try {
        this.jsxCalls.push(this.validateReactElement(node));
      } catch (error) {
        if (!(error instanceof MacroDiagnostic)) throw error;
        this.jsxError ??= error;
      }
    } else {
      this.visitJsxName(name);
    }
    this.collect(opening.typeArguments);
    this.visit(opening.attributes);
    this.visit(node.children);
    // The closing tag repeats the opening name; it is not a second use.
    if (node.closingElement) this.collect(node.closingElement.name);
  }

  visitJsxName(name) {
    if (name.type === "JSXIdentifier") {
      this.names.add(name.name);
      if (isJsxReferenceName(name.name)) this.reference(name);
    } else if (name.type === "JSXMemberExpression") {
      // The leftmost object of `<a.b>` is always a reference, whatever its case.
      if (name.object.type === "JSXIdentifier") {
        this.names.add(name.object.name);
        this.reference(name.object);
      } else {
        this.visitJsxName(name.object);
      }
      this.collect(name.property);
    } else {
      this.collect(name);
    }
  }

  /**
   * Walk a binding (`declare`) or assignment target pattern.
   * @param {any} node
   * @param {boolean} declare
   */
  pattern(node, declare) {
    if (!node) return;
    switch (node.type) {
      case "Identifier":
        this.visit(node.decorators);
        this.collect(node.typeAnnotation);
        if (declare) this.declare(node);
        else {
          this.names.add(node.name);
          this.reference(node);
        }
        return;
      case "ObjectPattern":
        for (const property of node.properties) {
          if (property.type === "RestElement") this.pattern(property, declare);
          else {
            this.visitKey(property);
            this.pattern(property.value, declare);
          }
        }
        this.collect(node.typeAnnotation);
        return;
      case "ArrayPattern":
        for (const element of node.elements) this.pattern(element, declare);
        this.collect(node.typeAnnotation);
        return;
      case "AssignmentPattern":
        this.pattern(node.left, declare);
        this.visit(node.right);
        return;
      case "RestElement":
        this.pattern(node.argument, declare);
        this.collect(node.typeAnnotation);
        return;
      case "TSParameterProperty":
        this.visit(node.decorators);
        this.pattern(node.parameter, declare);
        return;
      default:
        // Member expressions and other assignment targets are ordinary values.
        this.visit(node);
    }
  }

  /** Record identifier names in a subtree that holds no runtime references. */
  collect(node) {
    if (Array.isArray(node)) {
      for (const child of node) this.collect(child);
      return;
    }
    if (!node || typeof node !== "object") return;
    if (node.type === "Identifier" || node.type === "JSXIdentifier") this.names.add(node.name);
    for (const key of Object.keys(node)) {
      if (SKIPPED_KEYS.has(key)) continue;
      const value = node[key];
      if (value && typeof value === "object") this.collect(value);
    }
  }

  declare(identifier) {
    this.names.add(identifier.name);
    this.declared.add(identifier.name);
    const kind = this.macroNames.get(identifier.name);
    if (kind)
      this.reservedDeclaration ??= new MacroDiagnostic(
        identifier.start,
        reservedMessage(identifier.name, kind),
      );
  }

  reference(identifier) {
    const kind = this.macroNames.get(identifier.name);
    if (kind)
      this.escapedReference ??= new MacroDiagnostic(
        identifier.start,
        kind === "code"
          ? "the imported code binding must be used as a direct function call"
          : "the imported React Code binding must be used as a direct self-closing JSX element",
      );
  }

  // --- Validation ---------------------------------------------------------

  validateCall(call) {
    if (call.optional)
      throw new MacroDiagnostic(call.start, "optional calls to `code` are unsupported");
    if (call.arguments.length !== 2)
      throw new MacroDiagnostic(
        call.start,
        "`code` requires exactly two non-spread arguments: code and an options object",
      );
    const [sourceArgument, optionsArgument] = call.arguments;
    if (sourceArgument.type === "SpreadElement")
      throw new MacroDiagnostic(sourceArgument.start, "spread arguments to `code` are unsupported");
    let code;
    if (isStringLiteral(sourceArgument)) {
      rejectLoneSurrogates(sourceArgument.start, sourceArgument.value, "code string");
      code = sourceArgument.value;
    } else if (sourceArgument.type === "TemplateLiteral") {
      if (sourceArgument.expressions.length > 0)
        throw new MacroDiagnostic(
          call.start,
          "template literals passed to `code` cannot contain interpolations",
        );
      code = sourceArgument.quasis[0]?.value.cooked;
      if (typeof code !== "string")
        throw new MacroDiagnostic(
          call.start,
          "the code template passed to `code` has no cooked value",
        );
      rejectLoneSurrogates(sourceArgument.start, code, "code template");
    } else {
      throw new MacroDiagnostic(
        call.start,
        "the first `code` argument must be a string literal or an interpolation-free template literal",
      );
    }

    if (optionsArgument.type === "SpreadElement")
      throw new MacroDiagnostic(
        optionsArgument.start,
        "spread arguments to `code` are unsupported",
      );
    if (optionsArgument.type !== "ObjectExpression")
      throw new MacroDiagnostic(call.start, "the second `code` argument must be an object literal");

    const keys = new Set();
    let language;
    let meta;
    let lineNumbers;
    for (const property of optionsArgument.properties) {
      if (property.type === "SpreadElement")
        throw new MacroDiagnostic(
          property.start,
          "spread properties in `code` options are unsupported",
        );
      const key = property.computed ? undefined : propertyKeyName(property.key);
      if (property.computed || property.method || property.kind !== "init" || key === undefined)
        throw new MacroDiagnostic(
          property.start,
          "computed keys, methods, getters, and setters in `code` options are unsupported",
        );
      if (keys.has(key))
        throw new MacroDiagnostic(property.start, `duplicate \`${key}\` key in \`code\` options`);
      keys.add(key);
      const value = property.value;
      switch (key) {
        case "language":
          if (isStringLiteral(value))
            rejectLoneSurrogates(value.start, value.value, "`language` option");
          if (!isStringLiteral(value) || !value.value.trim())
            throw new MacroDiagnostic(
              property.start,
              "`code` requires a nonempty string literal `language` option",
            );
          language = value.value;
          break;
        case "meta":
          if (!isStringLiteral(value))
            throw new MacroDiagnostic(property.start, "the `meta` option must be a string literal");
          rejectLoneSurrogates(value.start, value.value, "`meta` option");
          meta = value.value;
          break;
        case "lineNumbers":
          if (!isBooleanLiteral(value))
            throw new MacroDiagnostic(
              property.start,
              "the `lineNumbers` option must be a boolean literal",
            );
          lineNumbers = value.value;
          break;
        default:
          throw new MacroDiagnostic(property.start, `unknown \`${key}\` option in \`code\` call`);
      }
    }
    if (language === undefined)
      throw new MacroDiagnostic(
        call.start,
        "`code` options require a nonempty string literal `language`",
      );
    return {
      kind: "code",
      start: call.start,
      end: call.end,
      code,
      language,
      meta,
      lineNumbers,
      // A descriptor at the start of a statement or concise arrow body needs parentheses.
      wrap: this.statementStarts.has(call.start),
    };
  }

  validateReactElement(element) {
    if (element.closingElement || element.children.length > 0)
      throw new MacroDiagnostic(
        element.start,
        "React `Code` macro elements must be self-closing and cannot have children",
      );

    const seen = new Set();
    let code;
    let language;
    let meta;
    let lineNumbers;
    const presentation = [];
    for (const attribute of element.openingElement.attributes) {
      if (attribute.type === "JSXSpreadAttribute")
        throw new MacroDiagnostic(
          attribute.start,
          "spread attributes on React `Code` macro elements are unsupported",
        );
      if (attribute.name.type === "JSXNamespacedName")
        throw new MacroDiagnostic(
          attribute.name.start,
          "namespaced attributes on React `Code` macro elements are unsupported",
        );
      const name = attribute.name.name;
      if (seen.has(name))
        throw new MacroDiagnostic(
          attribute.start,
          `duplicate \`${name}\` attribute on React \`Code\` macro element`,
        );
      seen.add(name);
      switch (name) {
        case "source":
          code = jsxStaticString(attribute, "`source`");
          break;
        case "language":
          language = jsxStaticString(attribute, "`language`");
          if (!language.trim())
            throw new MacroDiagnostic(
              attribute.start,
              "React `Code` requires a nonempty static string `language` prop",
            );
          break;
        case "meta":
          meta = jsxStaticString(attribute, "`meta`");
          break;
        case "lineNumbers": {
          const expression = jsxAttributeExpression(attribute.value);
          if (attribute.value == null) lineNumbers = true;
          else if (isBooleanLiteral(expression)) lineNumbers = expression.value;
          else
            throw new MacroDiagnostic(
              attribute.start,
              "React `Code` requires `lineNumbers` to be a static boolean",
            );
          break;
        }
        case "render":
        case "className":
          presentation.push(jsxPresentationProp(attribute, name));
          break;
        default:
          throw new MacroDiagnostic(
            attribute.start,
            `unknown React \`Code\` prop \`${name}\`; supported props are \`source\`, \`language\`, \`meta\`, \`lineNumbers\`, \`render\`, and \`className\`; \`key\`, \`ref\`, and \`children\` are unsupported`,
          );
      }
    }
    if (code === undefined)
      throw new MacroDiagnostic(
        element.start,
        "React `Code` requires a static string `source` prop",
      );
    if (language === undefined)
      throw new MacroDiagnostic(
        element.start,
        "React `Code` requires a nonempty static string `language` prop",
      );
    return {
      kind: "react",
      start: element.start,
      end: element.end,
      code,
      language,
      meta,
      lineNumbers,
      presentation,
    };
  }

  // --- Import edits -------------------------------------------------------

  retainedTypeImport(statement, typeSpecifiers) {
    let replacement = `import type { ${typeSpecifiers.join(", ")} } from ${this.slice(statement.source)}`;
    if (statement.attributes?.length) {
      const withClause = this.source
        .slice(statement.source.end, statement.end)
        .trim()
        .replace(/;$/, "")
        .trimEnd();
      replacement += ` ${withClause}`;
    }
    return `${replacement};`;
  }

  typeSpecifierText(item) {
    const { imported, local } = item;
    if (imported.start === local.start && imported.end === local.end) return this.slice(imported);
    return `${this.slice(imported)} as ${this.slice(local)}`;
  }

  slice(node) {
    return this.source.slice(node.start, node.end);
  }
}

function macroModule(specifier) {
  const module = typeof specifier === "string" ? MACRO_MODULES.get(specifier) : undefined;
  return module && { specifier, ...module };
}

function isMacroSpecifier(node) {
  if (isStringLiteral(node)) return MACRO_MODULES.has(node.value);
  return (
    node?.type === "TemplateLiteral" &&
    node.expressions.length === 0 &&
    MACRO_MODULES.has(node.quasis[0]?.value.cooked)
  );
}

function moduleExportName(node) {
  if (node.type === "Identifier") return node.name;
  return isStringLiteral(node) ? node.value : undefined;
}

function propertyKeyName(key) {
  if (key.type === "Identifier") return key.name;
  return isStringLiteral(key) ? key.value : undefined;
}

function leftmostName(node) {
  return node.type === "TSQualifiedName" ? leftmostName(node.left) : node;
}

function isStringLiteral(node) {
  return node?.type === "Literal" && typeof node.value === "string";
}

function isBooleanLiteral(node) {
  return node?.type === "Literal" && typeof node.value === "boolean";
}

/** JSX treats a lowercase or dashed name as an intrinsic element, not a binding. */
function isJsxReferenceName(name) {
  return !name.includes("-") && !/^[a-z]/.test(name);
}

function reservedMessage(name, kind) {
  const macro = kind === "code" ? "the `code` macro" : "the React `Code` macro";
  return `\`${name}\` is reserved in this module because it binds ${macro}; rename this declaration or import the macro under another name`;
}

function rejectLoneSurrogates(offset, value, valueKind) {
  if (!value.isWellFormed())
    throw new MacroDiagnostic(
      offset,
      `the ${valueKind} contains an unpaired UTF-16 surrogate and cannot be represented as UTF-8`,
    );
}

function jsxAttributeExpression(value) {
  return value?.type === "JSXExpressionContainer" && value.expression.type !== "JSXEmptyExpression"
    ? value.expression
    : undefined;
}

function jsxStaticString(attribute, label) {
  const value = attribute.value;
  if (isStringLiteral(value)) return decodeJsxString(value, label, `React \`Code\` ${label}`);
  const expression = jsxAttributeExpression(value);
  if (isStringLiteral(expression)) {
    rejectLoneSurrogates(expression.start, expression.value, label);
    return expression.value;
  }
  if (expression?.type === "TemplateLiteral") {
    if (expression.expressions.length > 0)
      throw new MacroDiagnostic(
        attribute.start,
        `React \`Code\` ${label} cannot contain template interpolations`,
      );
    const cooked = expression.quasis[0]?.value.cooked;
    if (typeof cooked === "string") {
      rejectLoneSurrogates(expression.start, cooked, label);
      return cooked;
    }
  }
  throw new MacroDiagnostic(
    attribute.start,
    `React \`Code\` ${label} must be a static string or cooked template literal`,
  );
}

function jsxPresentationProp(attribute, name) {
  const value = attribute.value;
  if (!value)
    throw new MacroDiagnostic(
      attribute.start,
      `React \`Code\` \`${name}\` must have a nonempty value`,
    );
  if (name === "className" && isStringLiteral(value)) {
    const label = "React `Code` `className`";
    return {
      name,
      start: value.start,
      end: value.end,
      literal: decodeJsxString(value, label, label),
    };
  }
  const expression = jsxAttributeExpression(value);
  if (!expression)
    throw new MacroDiagnostic(
      attribute.start,
      `React \`Code\` \`${name}\` must be a nonempty JSX expression`,
    );
  if (name === "render" && isObviouslyNonFunction(expression))
    throw new MacroDiagnostic(
      expression.start,
      "React `Code` `render` must be a callback expression, not a statically obvious nonfunction value",
    );
  return { name, start: expression.start, end: expression.end };
}

function isObviouslyNonFunction(expression) {
  switch (expression.type) {
    case "Literal":
    case "TemplateLiteral":
    case "ArrayExpression":
    case "ObjectExpression":
    case "JSXElement":
    case "JSXFragment":
      return true;
    case "ParenthesizedExpression":
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
    case "TSInstantiationExpression":
      return isObviouslyNonFunction(expression.expression);
    default:
      return false;
  }
}

/** Decode a quoted JSX attribute string once, as JSX compilers do. */
function decodeJsxString(literal, surrogateLabel, referenceLabel) {
  rejectLoneSurrogates(literal.start, literal.value, surrogateLabel);
  let decoded;
  try {
    decoded = decodeJsxEntities(literal.value);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw new MacroDiagnostic(
      literal.start,
      `${referenceLabel} contains an invalid numeric JSX character reference`,
    );
  }
  rejectLoneSurrogates(literal.start, decoded, surrogateLabel);
  return decoded;
}

/**
 * Decode named and numeric JSX character references. Numeric references stay
 * UTF-16 code units, so adjacent surrogate references form one character;
 * unknown names remain literal text.
 * @param {string} input
 */
export function decodeJsxEntities(input) {
  let output = "";
  let cursor = 0;
  while (cursor < input.length) {
    const ampersand = input.indexOf("&", cursor);
    if (ampersand < 0) break;
    output += input.slice(cursor, ampersand);
    let semicolon = ampersand + 1;
    while (semicolon < input.length && /[\da-z#]/i.test(input[semicolon])) semicolon++;
    if (semicolon === input.length) {
      output += input.slice(ampersand);
      return output;
    }
    if (input[semicolon] !== ";") {
      output += "&";
      cursor = ampersand + 1;
      continue;
    }
    const entity = input.slice(ampersand + 1, semicolon);
    const codePoint = entity.startsWith("#")
      ? decodeNumericJsxEntity(entity.slice(1))
      : JSX_ENTITIES.get(entity);
    if (codePoint === undefined) output += input.slice(ampersand, semicolon + 1);
    else if (codePoint <= 0xffff) output += String.fromCharCode(codePoint);
    else output += String.fromCodePoint(codePoint);
    cursor = semicolon + 1;
  }
  return output + input.slice(cursor);
}

function decodeNumericJsxEntity(entity) {
  // JSX follows the TypeScript/Babel-compatible lowercase `x` spelling;
  // uppercase `X` stays an unknown literal entity.
  const hexadecimal = entity.startsWith("x");
  const digits = hexadecimal ? entity.slice(1) : entity;
  if (!(hexadecimal ? /^[\da-f]+$/i : /^\d+$/).test(digits)) return undefined;
  const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10);
  if (codePoint > 0x10ffff) throw new RangeError("invalid numeric JSX character reference");
  return codePoint;
}
