#!/usr/bin/env node
/**
 * Egress bypass scan (R8 §1.2 B5, §3.5.5).
 *
 *   node scripts/egress-bypass-scan.mjs [--config test/egress/egress-boundary.json]
 *
 * Uses the TypeScript checker over src/ to find every reference to an export of
 * the outbound API module boundary, following import aliases, namespace imports
 * (property and element access), named and star re-exports (including chains)
 * and dynamic imports. Every boundary export is a guarded primitive unless the
 * config classifies it as infrastructure, read or helper; an unclassified export
 * is reported and treated as guarded. Outside the egress modules, observed
 * references must equal the explicit baseline exactly.
 */
import ts from 'typescript';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PERMITTED_CLASSES = new Set(['infrastructure', 'read', 'helper']);

function listTs(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== '__tests__') out.push(...listTs(p)); }
    else if (e.endsWith('.ts') && !e.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

export function scanEgress(cfg) {
  const root = resolve(cfg.root);
  const rel = (p) => relative(root, p).split(sep).join('/');
  const files = listTs(join(root, cfg.srcDir ?? 'src'));
  const options = { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022, noEmit: true, skipLibCheck: true, allowJs: false };
  const program = ts.createProgram(files, options);
  const checker = program.getTypeChecker();
  const boundary = new Set(cfg.boundaryModules);
  const isBoundary = (sf) => boundary.has(rel(sf.fileName));
  const isEgress = (file) => (cfg.egressModules ?? []).some((m) => file.startsWith(m));
  const classification = cfg.classification ?? {};

  // Boundary exports → guarded primitives (default-deny).
  const primitives = new Set();
  const unclassified = [];
  for (const sf of program.getSourceFiles().filter(isBoundary)) {
    const mod = checker.getSymbolAtLocation(sf);
    for (const ex of mod ? checker.getExportsOfModule(mod) : []) {
      const target = ex.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(ex) : ex;
      if (!(target.flags & ts.SymbolFlags.Value)) continue; // types/interfaces are not callable
      const c = classification[ex.name]?.class;
      if (!c) unclassified.push(ex.name);
      if (!PERMITTED_CLASSES.has(c)) primitives.add(ex.name);
    }
  }

  /** Resolve a symbol through aliases to a boundary primitive name, if any. */
  const primitiveOf = (sym) => {
    if (!sym) return undefined;
    const s = sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
    const decl = s.declarations?.[0];
    if (!decl || !isBoundary(decl.getSourceFile())) return undefined;
    return primitives.has(s.name) ? s.name : undefined;
  };
  const resolvesToBoundary = (spec, fromFile) => {
    const r = ts.resolveModuleName(spec, fromFile, options, ts.sys).resolvedModule;
    return r && boundary.has(rel(r.resolvedFileName)) ? rel(r.resolvedFileName) : undefined;
  };

  const usages = [];
  const violations = [];
  const opaque = ts.TypeFlags.Any | ts.TypeFlags.Unknown;
  const ASSIGN = new Set([ts.SyntaxKind.EqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken,
    ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken]);
  const wrapper = (n) => ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)
    || ts.isSatisfiesExpression(n) || ts.isNonNullExpression(n) || ts.isAwaitExpression(n);
  const unwrap = (n) => { while (wrapper(n)) n = n.expression; return n; };
  const isAssignment = (n) => ts.isBinaryExpression(n) && ASSIGN.has(n.operatorToken.kind);

  // Every identifier assignment in the program, so an origin survives `let x; x = api`.
  const assignments = new Map();
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || rel(sf.fileName).startsWith('..')) continue;
    const collect = (node) => {
      if (isAssignment(node) && ts.isIdentifier(unwrap(node.left))) {
        const sym = checker.getSymbolAtLocation(unwrap(node.left));
        if (sym) { if (!assignments.has(sym)) assignments.set(sym, []); assignments.get(sym).push(node.right); }
      }
      ts.forEachChild(node, collect);
    };
    collect(sf);
  }

  // A syntactic constant property key: literals, assertions over them and
  // initialized `const` bindings. Asserted types are never trusted as keys.
  const constantKey = (expr, depth = 0) => {
    if (!expr || depth > 32) return undefined;
    if (ts.isStringLiteralLike(expr) || ts.isNumericLiteral(expr)) return expr.text;
    if (wrapper(expr)) return constantKey(expr.expression, depth + 1);
    if (!ts.isIdentifier(expr)) return undefined;
    const decl = checker.getSymbolAtLocation(expr)?.valueDeclaration;
    if (!decl || !ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name) || !decl.initializer
      || !(ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const)) return undefined;
    return constantKey(decl.initializer, depth + 1);
  };
  const bindingKey = (element) => {
    if (element.dotDotDotToken) return undefined;
    const key = element.propertyName ?? element.name;
    if (ts.isComputedPropertyName(key)) return constantKey(key.expression);
    return ts.isIdentifier(key) || ts.isStringLiteralLike(key) || ts.isNumericLiteral(key) ? key.text : undefined;
  };

  // Abstract values reaching a node: a checker type, an object literal, or a
  // boundary primitive. Origins follow wrappers, conditionals, identifiers
  // (initializers, assignments, import aliases), object literals and nested
  // binding patterns. Results reached without cutting a cycle are memoized.
  const memo = new Map();
  const active = new Set();
  let cuts = 0;
  const typeValue = (node) => {
    const type = node && checker.getTypeAtLocation(node);
    return type && !(type.flags & opaque) ? [{ type }] : [];
  };
  const propertyValues = (values, key, seen = new Set()) => values.flatMap((v) => {
    if (v.type) {
      const prop = checker.getPropertyOfType(v.type, key);
      if (!prop) return [];
      const name = primitiveOf(prop);
      if (name) return [{ primitive: name }];
      const type = checker.getTypeOfSymbol(prop);
      return type.flags & opaque ? [] : [{ type }];
    }
    if (!v.object || seen.has(v.object)) return [];
    const path = new Set(seen).add(v.object);
    return v.object.properties.flatMap((p) => {
      if (ts.isSpreadAssignment(p)) return propertyValues(valuesOf(p.expression), key, path);
      const name = p.name && (ts.isComputedPropertyName(p.name) ? constantKey(p.name.expression)
        : ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name) || ts.isNumericLiteral(p.name) ? p.name.text : undefined);
      if (name !== key) return [];
      if (ts.isPropertyAssignment(p)) return valuesOf(p.initializer);
      if (ts.isShorthandPropertyAssignment(p)) return [
        ...valuesOf(p.name), ...symbolValues(checker.getShorthandAssignmentValueSymbol(p)),
      ];
      return [];
    });
  });
  const symbolValues = (sym) => {
    if (!sym) return [];
    const symbols = [sym];
    if (sym.flags & ts.SymbolFlags.Alias) symbols.push(checker.getAliasedSymbol(sym));
    return symbols.flatMap((s) => [
      ...(s.declarations ?? []).flatMap((d) => (ts.isVariableDeclaration(d) || ts.isParameter(d) ? valuesOf(d.initializer)
        : ts.isBindingElement(d) ? valuesOf(d) : [])),
      ...(assignments.get(s) ?? []).flatMap((right) => valuesOf(right)),
    ]);
  };
  const computeValues = (node) => {
    if (ts.isObjectBindingPattern(node)) {
      const owner = node.parent;
      if (ts.isBindingElement(owner)) return valuesOf(owner);
      return [...typeValue(owner), ...(ts.isVariableDeclaration(owner) || ts.isParameter(owner) ? valuesOf(owner.initializer) : [])];
    }
    if (ts.isBindingElement(node)) {
      if (!ts.isObjectBindingPattern(node.parent)) return typeValue(node);
      const key = bindingKey(node);
      return [...typeValue(node), ...(key === undefined ? [] : propertyValues(valuesOf(node.parent), key)), ...valuesOf(node.initializer)];
    }
    const out = typeValue(node);
    if (wrapper(node)) out.push(...valuesOf(node.expression));
    else if (ts.isObjectLiteralExpression(node)) out.push({ object: node });
    else if (ts.isConditionalExpression(node)) out.push(...valuesOf(node.whenTrue), ...valuesOf(node.whenFalse));
    else if (isAssignment(node)) out.push(...valuesOf(node.right));
    else if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (op === ts.SyntaxKind.CommaToken) out.push(...valuesOf(node.right));
      else if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.AmpersandAmpersandToken) {
        out.push(...valuesOf(node.left), ...valuesOf(node.right));
      }
    } else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) out.push(...propertyValues(valuesOf(node.expression), node.name.text));
    else if (ts.isElementAccessExpression(node)) {
      const key = constantKey(node.argumentExpression);
      if (key !== undefined) out.push(...propertyValues(valuesOf(node.expression), key));
    } else if (ts.isIdentifier(node)) out.push(...symbolValues(checker.getSymbolAtLocation(node)));
    return out;
  };
  function valuesOf(node) {
    if (!node) return [];
    if (memo.has(node)) return memo.get(node);
    if (active.has(node)) { cuts++; return []; }
    active.add(node);
    const before = cuts;
    const values = computeValues(node);
    active.delete(node);
    if (cuts === before) memo.set(node, values);
    return values;
  }
  const primitivesIn = (values) => [...new Set(values.filter((v) => v.primitive).map((v) => v.primitive))];
  // A value is a guarded namespace when it exposes a boundary primitive as a
  // property (directly or through an object literal holding such a namespace).
  const guarded = (values, seen = new Set()) => values.some((v) => {
    if (v.type) return checker.getPropertiesOfType(v.type).some((p) => primitiveOf(p));
    if (!v.object || seen.has(v.object)) return false;
    seen.add(v.object);
    return v.object.properties.some((p) => guarded(
      ts.isSpreadAssignment(p) ? valuesOf(p.expression) : ts.isPropertyAssignment(p) ? valuesOf(p.initializer)
        : ts.isShorthandPropertyAssignment(p) ? [
          ...valuesOf(p.name), ...symbolValues(checker.getShorthandAssignmentValueSymbol(p)),
        ] : [], seen));
  });
  // Positions where a guarded namespace leaves the tracked origin graph.
  const escapeContext = (node) => {
    const p = node.parent;
    if (!p || !ts.isExpression(node) || wrapper(p)) return undefined;
    if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.arguments?.includes(node)) return p;
    if (ts.isArrayLiteralExpression(p) || ts.isReturnStatement(p) || ts.isThrowStatement(p)
      || ts.isYieldExpression(p) || ts.isExportAssignment(p)) return p;
    if (ts.isArrowFunction(p) && p.body === node) return p;
    if (ts.isSpreadElement(p)) return p.parent;
    if (isAssignment(p) && p.right === node && !ts.isIdentifier(unwrap(p.left))) return p;
    return undefined;
  };
  const exportsGuardedNamespace = (sym) => {
    const s = sym && sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
    return Boolean(s && s.flags & ts.SymbolFlags.ValueModule && checker.getExportsOfModule(s).some((e) => primitiveOf(e)));
  };

  for (const sf of program.getSourceFiles()) {
    const file = rel(sf.fileName);
    if (file.startsWith('..') || sf.isDeclarationFile || isBoundary(sf) || isEgress(file)) continue;
    const line = (node) => sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    const unresolved = (symbol) => violations.push({ code: 'unresolved-boundary-extraction', file, symbol });
    const visit = (node) => {
      const context = escapeContext(node);
      if (context && guarded(valuesOf(node))) unresolved(context.getText());
      if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        // A binding's local symbol points to this declaration, not the imported
        // export. Resolve its property on the origins of the bound value.
        const source = valuesOf(node.parent);
        const key = bindingKey(node);
        if (key === undefined) {
          if (guarded(source)) {
            const k = node.propertyName ?? node.name;
            unresolved(node.dotDotDotToken ? `...${node.name.getText()}` : ts.isComputedPropertyName(k) ? `[${k.expression.getText()}]` : k.getText());
          }
        } else {
          // One reference extraction, matching const local = namespace.export.
          // Binding declaration names and alias invocations are not extra sites.
          for (const name of primitivesIn(propertyValues(source, key))) usages.push({ file, symbol: name, line: line(node), via: 'namespace-binding' });
        }
        if (node.propertyName && ts.isComputedPropertyName(node.propertyName)) visit(node.propertyName.expression);
        if (!ts.isIdentifier(node.name)) visit(node.name);
        if (node.initializer) visit(node.initializer);
        return;
      }
      if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
        if (!node.exportClause && node.moduleSpecifier) {
          const modSym = checker.getSymbolAtLocation(node.moduleSpecifier);
          const reexported = modSym ? checker.getExportsOfModule(modSym).some((e) => primitiveOf(e)) : false;
          if (reexported) violations.push({ code: 'unauthorized-reexport', file, symbol: '*' });
        } else if (node.exportClause && ts.isNamespaceExport(node.exportClause) && node.moduleSpecifier) {
          if (exportsGuardedNamespace(checker.getSymbolAtLocation(node.moduleSpecifier))) {
            violations.push({ code: 'unauthorized-reexport', file, symbol: `* as ${node.exportClause.name.text}` });
          }
        } else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
          for (const el of node.exportClause.elements) {
            const local = checker.getExportSpecifierLocalTargetSymbol(el);
            const name = primitiveOf(checker.getSymbolAtLocation(el.name)) ?? primitiveOf(local)
              ?? (exportsGuardedNamespace(local) || guarded(symbolValues(local)) ? el.name.text : undefined);
            if (name) violations.push({ code: 'unauthorized-reexport', file, symbol: name });
          }
        }
        return; // specifiers are declarations, not uses
      }
      if (ts.isImportDeclaration(node)) return;
      if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])
        && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        const target = resolvesToBoundary(node.arguments[0].text, sf.fileName);
        if (target) violations.push({ code: 'unauthorized-dynamic-import', file, symbol: target });
      }
      if (ts.isElementAccessExpression(node)) {
        const key = constantKey(node.argumentExpression);
        const source = valuesOf(node.expression);
        if (key !== undefined) {
          for (const name of primitivesIn(propertyValues(source, key))) usages.push({ file, symbol: name, line: line(node), via: 'element-access' });
        } else if (guarded(source)) unresolved(`[${node.argumentExpression.getText()}]`);
      }
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
        // Counted once here; the name identifier is not visited again.
        const names = new Set(primitivesIn(propertyValues(valuesOf(node.expression), node.name.text)));
        const direct = primitiveOf(checker.getSymbolAtLocation(node.name));
        if (direct) names.add(direct);
        for (const name of names) usages.push({ file, symbol: name, line: line(node.name), via: 'namespace' });
        visit(node.expression);
        return;
      }
      if (ts.isIdentifier(node)) {
        const name = primitiveOf(checker.getSymbolAtLocation(node));
        if (name) usages.push({ file, symbol: name, line: line(node), via: 'identifier' });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  // Exact baseline accounting for call sites outside the egress modules.
  const observed = new Map();
  for (const u of usages) observed.set(`${u.file}#${u.symbol}`, (observed.get(`${u.file}#${u.symbol}`) ?? 0) + 1);
  const baseline = new Map((cfg.baselinePermittedCallers ?? []).map((b) => [`${b.file}#${b.symbol}`, b.count]));
  for (const [k, n] of observed) {
    const [file, symbol] = k.split('#');
    const allowed = baseline.get(k) ?? 0;
    if (n > allowed) violations.push({ code: 'unauthorized-call', file, symbol, observed: n, baseline: allowed });
  }
  for (const [k, n] of baseline) {
    const [file, symbol] = k.split('#');
    if ((observed.get(k) ?? 0) < n) violations.push({ code: 'stale-baseline', file, symbol, observed: observed.get(k) ?? 0, baseline: n });
  }
  return { primitives: [...primitives].sort(), unclassified: unclassified.sort(), usages, violations };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--config');
  const cfgPath = i >= 0 ? process.argv[i + 1] : 'test/egress/egress-boundary.json';
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const result = scanEgress({ root: process.cwd(), srcDir: 'src', egressModules: ['src/egress/'], ...cfg });
  console.log(JSON.stringify({ primitives: result.primitives, unclassified: result.unclassified, usages: result.usages.length, violations: result.violations }, null, 2));
  process.exit(result.violations.length || result.unclassified.length ? 1 : 0);
}
