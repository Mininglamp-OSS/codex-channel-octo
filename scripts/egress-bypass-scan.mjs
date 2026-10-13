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
  for (const sf of program.getSourceFiles()) {
    const file = rel(sf.fileName);
    if (file.startsWith('..') || sf.isDeclarationFile || isBoundary(sf) || isEgress(file)) continue;
    const visit = (node) => {
      if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
        if (!node.exportClause && node.moduleSpecifier) {
          const modSym = checker.getSymbolAtLocation(node.moduleSpecifier);
          const reexported = modSym ? checker.getExportsOfModule(modSym).some((e) => primitiveOf(e)) : false;
          if (reexported) violations.push({ code: 'unauthorized-reexport', file, symbol: '*' });
        } else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
          for (const el of node.exportClause.elements) {
            const name = primitiveOf(checker.getSymbolAtLocation(el.name)) ?? primitiveOf(checker.getExportSpecifierLocalTargetSymbol(el));
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
      if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
        const prop = checker.getPropertyOfType(checker.getTypeAtLocation(node.expression), node.argumentExpression.text);
        const name = primitiveOf(prop);
        if (name) usages.push({ file, symbol: name, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, via: 'element-access' });
      }
      if (ts.isIdentifier(node)) {
        const name = primitiveOf(checker.getSymbolAtLocation(node));
        if (name) usages.push({ file, symbol: name, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, via: ts.isPropertyAccessExpression(node.parent) ? 'namespace' : 'identifier' });
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
