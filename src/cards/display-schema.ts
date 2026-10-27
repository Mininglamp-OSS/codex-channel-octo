/**
 * Display-card schema (WP-09): the semantic layer over the structurally
 * accepted C.1 display grammar (`protocol.ts` reads shape only).
 *
 * Pure and deterministic. Every authored string is normalized (controls and
 * format characters removed, NFC), redacted for secret-shaped tokens
 * (AC-019.1, authored scope) and mention-neutralized; every link must be a
 * safe `https:` URL. Cardinality and size bounds are conservative and stay
 * inside `CARD_BOUNDS`. Diagnostics carry grammar paths and closed rule
 * names only, never authored content.
 */
import { isIP } from "node:net";
import type { DisplayBlock, DisplayCardArgs, Diag, RichRun } from "./contracts.js";
import { CARD_BOUNDS } from "./limits.js";
import { MAX_DIAG_PATH_BYTES, MAX_DIAGNOSTICS } from "./protocol.js";
import { hasSecretShape } from "./redact.js";

export const DISPLAY_BOUNDS = Object.freeze({
  /** Every block at every nesting level. */
  sourceBlocks: CARD_BOUNDS.sourceBlocks,
  /** Container ancestors (group, collapsible, column) of any block. */
  nesting: 4,
  titleScalars: 200,
  labelScalars: 120,
  textScalars: 4000,
  cellScalars: 500,
  columns: 6,
  facts: 50,
  tableColumns: 12,
  tableRows: 100,
  runs: 64,
  urlBytes: 2048,
});

/** Replacement for a secret-shaped authored token. */
export const REDACTED = "[redacted]";

export type DisplaySchemaError = { readonly code: "validation_failed" | "limit_exceeded"; readonly diagnostics: readonly Diag[] };
export type DisplaySchemaResult =
  | { readonly ok: true; readonly value: DisplayCardArgs }
  | { readonly ok: false; readonly error: DisplaySchemaError };

export type SafeLink = { readonly ok: true; readonly url: string } | { readonly ok: false; readonly rule: string };

const FORMAT_AND_CONTROL = /\p{Cf}|(?!\n)\p{Cc}/gu;
const LONE_SURROGATES = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const UNSAFE_URL_CHARS = /[\s\p{Cc}\p{Cf}]/u;
const PEM_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9+/=_.~-]{8,}/gi;
const VENDOR_TOKEN = /(?:gh[pousr]_|github_pat_|sk-(?:proj-|ant-)?|xox[baprs]-|AKIA|ASIA|AIza)[A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./i;
const SECRET_QUERY_KEY = /token|secret|passw|api[-_]?key|signature|credential|^(?:sig|auth|authorization|session|sessionid|sid|key|code)$/i;
const LOCAL_HOST = /^(?:localhost|localhost\.localdomain)$|\.(?:localhost|local|internal)$/i;

/** Every `@` becomes U+FF20, so no mention, broadcast or structured mention can be parsed. */
export function neutralizeMentions(text: string): string {
  return text.replace(/@/g, "＠");
}

/** Every `://`, whatever precedes it; a literal match keeps this linear on long input. */
const URL_SCHEME = /:\/\//g;
const BARE_SCHEME = /\b(javascript|vbscript|data|file|blob|about|mailto|tel|sms|intent|octo|ftp):(?=\S)/gi;
const WWW = /\bwww\./gi;

/**
 * Defang URLs in authored text so no renderer can autolink them: every
 * `://` becomes `[:]//`, script-like and other non-web schemes become `x[:]`,
 * and `www.` becomes `www[.]`. Only structured, `safeLinkUrl`-validated
 * links are ever live; authored text never is.
 */
export function neutralizeUrls(text: string): string {
  return text.replace(URL_SCHEME, "[:]//").replace(BARE_SCHEME, "$1[:]").replace(WWW, "www[.]");
}

const MD_INLINE = /[\\`*_[\]()<>~|]/g;
const MD_LINE_START = /^([ \t]*)([#+=-]|\d+[.)])/gm;

/**
 * Backslash-escape every Markdown-significant character of authored text
 * placed in a TextBlock, so authored text can carry no link, image,
 * autolink, emphasis, code, heading, list or table syntax. Builder-generated
 * syntax around escaped text is the only Markdown that stays live.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(MD_INLINE, "\\$&").replace(MD_LINE_START, (_m, lead: string, mark: string) =>
    `${lead}${mark.length > 1 ? `${mark.slice(0, -1)}\\${mark.slice(-1)}` : `\\${mark}`}`);
}

/** Authored text for a TextBlock (Markdown) surface. */
export function markdownText(text: string): string {
  return escapeMarkdown(neutralizeUrls(text));
}

/**
 * Authored text for a surface that is not specified as Markdown (TextRun,
 * action titles). Escapes would show literally there, so instead URLs are
 * defanged and link and angle-autolink syntax is broken without assuming
 * any renderer behaviour.
 */
export function inertText(text: string): string {
  return neutralizeUrls(text).replace(/\]\(/g, "] (").replace(/\]\[/g, "] [").replace(/</g, "\u2039").replace(/>/g, "\u203A");
}

/**
 * Replace secret-shaped spans with {@link REDACTED}: private-key blocks and
 * `Bearer`/`Basic` credentials first, then every whitespace-delimited token
 * the conservative WP-05 gate flags. Surrounding prose is kept verbatim.
 */
export function redactAuthored(text: string): string {
  const spans = text.replace(PEM_BLOCK, REDACTED).replace(AUTH_SCHEME, (_m, scheme: string) => `${scheme} ${REDACTED}`);
  return spans.replace(/\S+/g, (token) => (token === REDACTED || !hasSecretShape(token) ? token : REDACTED));
}

/**
 * `https:` only, no credentials, no IP-literal or local host, no whitespace,
 * controls or format characters, no secret-bearing path or query key. The
 * returned href is WHATWG-normalized with `@` percent-encoded.
 */
export function safeLinkUrl(url: string): SafeLink {
  if (typeof url !== "string" || url.length === 0 || UNSAFE_URL_CHARS.test(url) || LONE_SURROGATE.test(url)) {
    return { ok: false, rule: "link_invalid" };
  }
  if (Buffer.byteLength(url, "utf8") > DISPLAY_BOUNDS.urlBytes) return { ok: false, rule: "link_too_long" };
  let parsed: URL;
  try { parsed = new URL(url); } catch { return { ok: false, rule: "link_invalid" }; }
  if (parsed.protocol !== "https:") return { ok: false, rule: "link_scheme" };
  if (parsed.username !== "" || parsed.password !== "") return { ok: false, rule: "link_credentials" };
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (host === "" || isIP(host) !== 0 || LOCAL_HOST.test(host) || !host.includes(".")) return { ok: false, rule: "link_host" };
  let decoded: string;
  try { decoded = decodeURIComponent(parsed.pathname + parsed.hash); } catch { decoded = parsed.pathname + parsed.hash; }
  if (VENDOR_TOKEN.test(parsed.href) || VENDOR_TOKEN.test(decoded)) return { ok: false, rule: "link_secret" };
  for (const key of parsed.searchParams.keys()) if (SECRET_QUERY_KEY.test(key)) return { ok: false, rule: "link_secret" };
  const href = parsed.href.replace(/@/g, "%40");
  if (Buffer.byteLength(href, "utf8") > DISPLAY_BOUNDS.urlBytes) return { ok: false, rule: "link_too_long" };
  return { ok: true, url: href };
}

// ─── validation ──────────────────────────────────────────────────────────────

interface Ctx {
  readonly diagnostics: Diag[];
  validation: boolean;
  blocks: number;
}

function add(ctx: Ctx, path: string, rule: string, kind: "validation" | "limit"): null {
  if (kind === "validation") ctx.validation = true;
  if (ctx.diagnostics.length < MAX_DIAGNOSTICS) ctx.diagnostics.push(Object.freeze({ path, rule }));
  return null;
}

function at(path: string, segment: string): string {
  const next = `${path}${segment}`;
  return Buffer.byteLength(next, "utf8") <= MAX_DIAG_PATH_BYTES ? next : path;
}

function scalars(text: string): number {
  return Array.from(text).length;
}

function clean(text: string): string {
  return text.replace(LONE_SURROGATES, "").replace(FORMAT_AND_CONTROL, (c) => (c === "\t" ? " " : "")).normalize("NFC");
}

function finish(text: string): string {
  return neutralizeMentions(redactAuthored(text));
}

/** Multi-line authored text: nonempty after trim, scalar-bounded. */
function readText(raw: string, path: string, ctx: Ctx, max: number, allowEmpty = false): string | null {
  const text = clean(raw);
  if (!allowEmpty && text.trim() === "") return add(ctx, path, "text_empty", "validation");
  if (scalars(text) > max) return add(ctx, path, "text_too_long", "limit");
  return finish(text);
}

/** Single-line label: trimmed, nonempty, no line break, scalar-bounded. */
function readLabel(raw: string, path: string, ctx: Ctx, max: number = DISPLAY_BOUNDS.labelScalars): string | null {
  const text = clean(raw).trim();
  if (text === "") return add(ctx, path, "label_empty", "validation");
  if (/[\n\r]/.test(text)) return add(ctx, path, "label_multiline", "validation");
  if (scalars(text) > max) return add(ctx, path, "label_too_long", "limit");
  return finish(text);
}

function readUrl(raw: string, path: string, ctx: Ctx): string | null {
  const link = safeLinkUrl(raw);
  return link.ok ? link.url : add(ctx, path, link.rule, link.rule === "link_too_long" ? "limit" : "validation");
}

function readCount(n: number, max: number, path: string, ctx: Ctx, rule: string): boolean {
  if (n === 0) { add(ctx, path, "empty", "validation"); return false; }
  if (n > max) { add(ctx, path, rule, "limit"); return false; }
  return true;
}

function readRun(run: RichRun, path: string, ctx: Ctx): RichRun | null {
  if (run.kind === "link") {
    const label = readLabel(run.label, at(path, ".label"), ctx);
    const url = readUrl(run.url, at(path, ".url"), ctx);
    return label !== null && url !== null ? { kind: "link", label, url } : null;
  }
  // Runs concatenate, so a run may be whitespace only; the block must not be.
  const text = readText(run.text, at(path, ".text"), ctx, DISPLAY_BOUNDS.textScalars, true);
  return text === null ? null : { kind: run.kind, text };
}

function readBlocks(blocks: readonly DisplayBlock[], path: string, ctx: Ctx, depth: number): DisplayBlock[] | null {
  if (blocks.length === 0) return add(ctx, path, "empty", "validation");
  const out: DisplayBlock[] = [];
  let ok = true;
  blocks.forEach((b, i) => {
    const v = readBlock(b, at(path, `[${i}]`), ctx, depth);
    if (v === null) ok = false;
    else out.push(v);
  });
  return ok ? out : null;
}

function readBlock(block: DisplayBlock, path: string, ctx: Ctx, depth: number): DisplayBlock | null {
  ctx.blocks++;
  const child = (key: string): string => at(path, `.${key}`);
  switch (block.kind) {
    case "heading": {
      const text = readLabel(block.text, child("text"), ctx, DISPLAY_BOUNDS.titleScalars);
      return text === null ? null : block.level === undefined ? { kind: "heading", text } : { kind: "heading", text, level: block.level };
    }
    case "text": {
      const text = readText(block.text, child("text"), ctx, DISPLAY_BOUNDS.textScalars);
      return text === null ? null : { kind: "text", text };
    }
    case "rich_text": {
      if (!readCount(block.runs.length, DISPLAY_BOUNDS.runs, child("runs"), ctx, "too_many_runs")) return null;
      const runs = block.runs.map((r, i) => readRun(r, at(child("runs"), `[${i}]`), ctx));
      if (runs.some((r) => r === null)) return null;
      const visible = runs.some((r) => (r!.kind === "link" ? true : r!.text.trim() !== ""));
      if (!visible) return add(ctx, child("runs"), "text_empty", "validation");
      return { kind: "rich_text", runs: runs as RichRun[] };
    }
    case "facts": {
      if (!readCount(block.items.length, DISPLAY_BOUNDS.facts, child("items"), ctx, "too_many_facts")) return null;
      const items = block.items.map((f, i) => {
        const p = at(child("items"), `[${i}]`);
        const label = readLabel(f.label, at(p, ".label"), ctx);
        const value = readText(f.value, at(p, ".value"), ctx, DISPLAY_BOUNDS.cellScalars, true);
        return label !== null && value !== null ? { label, value } : null;
      });
      return items.some((f) => f === null) ? null : { kind: "facts", items: items as { label: string; value: string }[] };
    }
    case "columns": {
      if (!readCount(block.columns.length, DISPLAY_BOUNDS.columns, child("columns"), ctx, "too_many_columns")) return null;
      if (depth >= DISPLAY_BOUNDS.nesting) return add(ctx, child("columns"), "nesting_too_deep", "validation");
      const columns = block.columns.map((c, i) => {
        const blocks = readBlocks(c.blocks, at(at(child("columns"), `[${i}]`), ".blocks"), ctx, depth + 1);
        return blocks === null ? null : { blocks };
      });
      return columns.some((c) => c === null) ? null : { kind: "columns", columns: columns as { blocks: DisplayBlock[] }[] };
    }
    case "table": {
      if (!readCount(block.headers.length, DISPLAY_BOUNDS.tableColumns, child("headers"), ctx, "too_many_columns")) return null;
      if (block.rows.length > DISPLAY_BOUNDS.tableRows) return add(ctx, child("rows"), "too_many_rows", "limit");
      const headers = block.headers.map((h, i) => readLabel(h, at(child("headers"), `[${i}]`), ctx));
      let ok = !headers.some((h) => h === null);
      const rows = block.rows.map((row, r) => {
        const rp = at(child("rows"), `[${r}]`);
        if (row.length !== block.headers.length) { add(ctx, rp, "row_width", "validation"); ok = false; return []; }
        return row.map((cell, c) => {
          const v = readText(cell, at(rp, `[${c}]`), ctx, DISPLAY_BOUNDS.cellScalars, true);
          if (v === null) ok = false;
          return v ?? "";
        });
      });
      return ok ? { kind: "table", headers: headers as string[], rows } : null;
    }
    case "link": {
      const label = readLabel(block.label, child("label"), ctx);
      const url = readUrl(block.url, child("url"), ctx);
      return label !== null && url !== null ? { kind: "link", label, url } : null;
    }
    case "group": {
      if (depth >= DISPLAY_BOUNDS.nesting) return add(ctx, child("blocks"), "nesting_too_deep", "validation");
      const blocks = readBlocks(block.blocks, child("blocks"), ctx, depth + 1);
      return blocks === null ? null : { kind: "group", blocks };
    }
    case "collapsible": {
      const label = readLabel(block.label, child("label"), ctx);
      if (depth >= DISPLAY_BOUNDS.nesting) return add(ctx, child("blocks"), "nesting_too_deep", "validation");
      const blocks = readBlocks(block.blocks, child("blocks"), ctx, depth + 1);
      if (label === null || blocks === null) return null;
      return block.expanded === undefined ? { kind: "collapsible", label, blocks } : { kind: "collapsible", label, blocks, expanded: block.expanded };
    }
    case "copy": {
      const label = readLabel(block.label, child("label"), ctx);
      const text = readText(block.text, child("text"), ctx, DISPLAY_BOUNDS.textScalars);
      return label !== null && text !== null ? { kind: "copy", label, text } : null;
    }
    default:
      return add(ctx, child("kind"), "unknown_kind", "validation");
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/**
 * Validate and normalize grammar-accepted display arguments. The result is
 * a fresh deep-frozen copy; the input is never mutated. Any content rule
 * makes the code `validation_failed`; size and count bounds alone make it
 * `limit_exceeded`.
 */
export function validateDisplayArgs(args: DisplayCardArgs): DisplaySchemaResult {
  const ctx: Ctx = { diagnostics: [], validation: false, blocks: 0 };
  let value: DisplayCardArgs | null = null;
  try {
    const title = args.title === undefined ? undefined : readLabel(args.title, "$.title", ctx, DISPLAY_BOUNDS.titleScalars);
    const blocks = readBlocks(args.blocks, "$.blocks", ctx, 0);
    if (ctx.blocks > DISPLAY_BOUNDS.sourceBlocks) add(ctx, "$.blocks", "too_many_blocks", "limit");
    if (title !== null && blocks !== null && ctx.diagnostics.length === 0) value = title === undefined ? { blocks } : { title, blocks };
  } catch {
    add(ctx, "$", "invalid", "validation");
  }
  if (value !== null) return Object.freeze({ ok: true, value: deepFreeze(value) });
  const diagnostics = ctx.diagnostics.length > 0 ? ctx.diagnostics : [Object.freeze({ path: "$", rule: "invalid" })];
  return Object.freeze({ ok: false, error: Object.freeze({ code: ctx.validation ? "validation_failed" : "limit_exceeded", diagnostics: Object.freeze(diagnostics) }) });
}
