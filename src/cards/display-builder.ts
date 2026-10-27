/**
 * Display-card builder (WP-09): schema-normalized C.1 display grammar →
 * `octo/v1` Adaptive Card 1.5 body plus its deterministic plain text.
 *
 * Pure and deterministic.
 * - Only elements in the negotiated set are emitted. Each block kind
 *   degrades on its own to the elements that remain, down to TextBlock,
 *   which every enabled display profile lists.
 * - Links are `Action.OpenUrl` (or a Markdown link without ActionSet);
 *   collapsible sections are a ToggleVisibility button over a hidden
 *   container with a deterministic id; copy blocks are CopyToClipboard.
 *   None of these call back into the Bot.
 * - Fitting before transport (AC-007.4): the longest prefix of source
 *   blocks whose card satisfies the negotiated node, depth and payload
 *   limits (never above the client bounds) and whose exact send envelope
 *   the closed wire serializer accepts. Omitted blocks are replaced by one
 *   marker in both the card and the plain text. If not even the title and
 *   the marker fit, the result is `limit_exceeded`.
 */
import { CARD_ENVELOPE_MAX_BYTES, CARD_MAX_DEPTH, CARD_MAX_NODES, serializeSendAuthored } from "./api.js";
import type {
  AcDisplayElement, AcTextBlock, AcTextRun, CardRoute, Diag, DisplayAdaptiveCard, DisplayBlock, DisplayCardArgs, Limits, RichRun,
} from "./contracts.js";
import { inertText, markdownText, neutralizeUrls } from "./display-schema.js";
import { omittedBlocksText, renderDisplayPlain } from "./plain.js";

/** The closed `octo/v1` display element set the client can emit. */
export const DISPLAY_ELEMENTS: readonly string[] = Object.freeze(["TextBlock", "RichTextBlock", "FactSet", "Container", "ColumnSet", "Table", "ActionSet"]);

export interface DisplayCapabilities {
  /** Negotiated profile elements; anything outside {@link DISPLAY_ELEMENTS} is ignored. */
  readonly elements: ReadonlySet<string>;
  readonly limits: Limits;
}

export interface DisplayBuildOptions {
  readonly caps: DisplayCapabilities;
  /** Trusted route of the send envelope; only used to measure it. */
  readonly route: CardRoute;
}

export interface DisplayAuthored {
  readonly profile: "octo/v1";
  readonly card: DisplayAdaptiveCard;
}

export type DisplayBuild =
  | { readonly ok: true; readonly authored: DisplayAuthored; readonly plain: string; readonly shownBlocks: number; readonly omittedBlocks: number }
  | { readonly ok: false; readonly error: { readonly code: "limit_exceeded" | "unavailable"; readonly diagnostics: readonly Diag[] } };

const AC_HEADER = Object.freeze({ type: "AdaptiveCard", version: "1.5", $schema: "http://adaptivecards.io/schemas/adaptive-card.json" } as const);
/** Same length as every store-minted client message number. */
const MEASURE_CLIENT_MSG_NO = "00000000-0000-0000-0000-000000000000";

const CAPABILITY_ERROR: DisplayBuild = deepFreeze({ ok: false, error: { code: "unavailable", diagnostics: [{ path: "$", rule: "display_capability" }] } });
const TOO_LARGE: DisplayBuild = deepFreeze({ ok: false, error: { code: "limit_exceeded", diagnostics: [{ path: "$", rule: "card_too_large" }] } });

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** TextBlock over builder-generated Markdown; authored parts must already be {@link markdownText}. */
function tb(text: string, extra: Partial<Pick<AcTextBlock, "weight" | "size">> = {}): AcTextBlock {
  return { type: "TextBlock", text, wrap: true, ...extra };
}

/** TextBlock over authored text: escaped and URL-defanged. */
function atb(text: string, extra: Partial<Pick<AcTextBlock, "weight" | "size">> = {}): AcTextBlock {
  return tb(markdownText(text), extra);
}

/** A code span is literal, so it may carry defanged text only when it cannot be broken out of. */
const CODE_SPAN_SAFE = /^[^`\n[\]()<>\\]*$/;

/** Wrap the non-blank core of `text` in a Markdown mark, keeping outer spaces. */
function mark(text: string, m: string): string {
  const core = text.trim();
  if (core === "") return text;
  const start = text.indexOf(core);
  return `${text.slice(0, start)}${m}${core}${m}${text.slice(start + core.length)}`;
}

/** The only live Markdown link: escaped authored label, validated URL. */
function markdownLink(label: string, url: string): string {
  return `[${markdownText(label)}](${url.replace(/\(/g, "%28").replace(/\)/g, "%29")})`;
}

function textRun(run: RichRun): AcTextRun {
  switch (run.kind) {
    case "text": return { type: "TextRun", text: inertText(run.text) };
    case "emphasis": return { type: "TextRun", text: inertText(run.text), isSubtle: true };
    case "strong": return { type: "TextRun", text: inertText(run.text), weight: "Bolder" };
    case "code": return { type: "TextRun", text: inertText(run.text), fontType: "Monospace" };
    case "link": return { type: "TextRun", text: `${inertText(run.label)} (${run.url})`, color: "accent" };
  }
}

function markdownRun(run: RichRun): string {
  switch (run.kind) {
    // Authored run text is escaped first; only the builder's marks stay live.
    case "text": return markdownText(run.text);
    case "emphasis": return mark(markdownText(run.text), "_");
    case "strong": return mark(markdownText(run.text), "**");
    case "code": {
      const code = neutralizeUrls(run.text);
      return CODE_SPAN_SAFE.test(code) ? mark(code, "`") : markdownText(run.text);
    }
    case "link": return markdownLink(run.label, run.url);
  }
}

class Renderer {
  private ids = 0;
  constructor(private readonly elements: ReadonlySet<string>) {}

  private has(type: string): boolean { return this.elements.has(type); }

  /** Container if supported, else the items inline. */
  private wrap(items: AcDisplayElement[]): AcDisplayElement[] {
    return this.has("Container") ? [{ type: "Container", items }] : items;
  }

  blocks(blocks: readonly DisplayBlock[]): AcDisplayElement[] {
    return blocks.flatMap((b) => this.block(b));
  }

  block(block: DisplayBlock): AcDisplayElement[] {
    switch (block.kind) {
      case "heading": {
        const level = block.level ?? 2;
        return [atb(block.text, level === 1 ? { weight: "Bolder", size: "Large" } : level === 2 ? { weight: "Bolder", size: "Medium" } : { weight: "Bolder" })];
      }
      case "text":
        return [atb(block.text)];
      case "rich_text":
        return this.has("RichTextBlock")
          ? [{ type: "RichTextBlock", inlines: block.runs.map(textRun) }]
          : [tb(block.runs.map(markdownRun).join(""))];
      case "facts":
        // Fact title and value render Markdown, like TextBlock text.
        return this.has("FactSet")
          ? [{ type: "FactSet", facts: block.items.map((f) => ({ title: markdownText(f.label), value: markdownText(f.value) })) }]
          : block.items.map((f) => tb(`${markdownText(f.label)}: ${markdownText(f.value)}`));
      case "columns":
        if (this.has("ColumnSet")) {
          return [{ type: "ColumnSet", columns: block.columns.map((c) => ({ type: "Column", width: "stretch", items: this.blocks(c.blocks) })) }];
        }
        return block.columns.flatMap((c) => this.wrap(this.blocks(c.blocks)));
      case "table":
        if (this.has("Table")) {
          return [{
            type: "Table", firstRowAsHeader: true, columns: block.headers.map(() => ({ width: 1 })),
            rows: [block.headers, ...block.rows].map((row, r) => ({
              type: "TableRow", cells: row.map((cell) => ({ type: "TableCell", items: [r === 0 ? atb(cell, { weight: "Bolder" }) : atb(cell)] })),
            })),
          }];
        }
        return [tb(block.headers.map(markdownText).join(" | "), { weight: "Bolder" }), ...block.rows.map((row) => tb(row.map(markdownText).join(" | ")))];
      case "link":
        return this.has("ActionSet")
          ? [{ type: "ActionSet", actions: [{ type: "Action.OpenUrl", title: inertText(block.label), url: block.url }] }]
          : [tb(markdownLink(block.label, block.url))];
      case "group":
        return this.wrap(this.blocks(block.blocks));
      case "collapsible": {
        const items = this.blocks(block.blocks);
        if (this.has("ActionSet") && this.has("Container")) {
          const id = `d${++this.ids}`;
          return [
            { type: "ActionSet", actions: [{ type: "Action.ToggleVisibility", title: inertText(block.label), targetElements: [{ elementId: id, isVisible: true }] }] },
            { type: "Container", id, isVisible: block.expanded === true, items },
          ];
        }
        return [atb(block.label, { weight: "Bolder" }), ...this.wrap(items)];
      }
      case "copy":
        return this.has("ActionSet")
          // The clipboard payload is never rendered, so it keeps the exact (redacted) authored text.
          ? [atb(block.text), { type: "ActionSet", actions: [{ type: "Action.CopyToClipboard", title: inertText(block.label), text: block.text }] }]
          : [tb(`${markdownText(block.label)}: ${markdownText(block.text)}`)];
    }
  }
}

/** Nodes and depth with the closed wire serializer's convention (body items are depth 1). */
export function measureDisplayCard(card: Pick<DisplayAdaptiveCard, "body">): { readonly nodes: number; readonly depth: number } {
  let nodes = 0;
  let depth = 0;
  const enter = (d: number): void => { nodes++; if (d > depth) depth = d; };
  const element = (e: AcDisplayElement, d: number): void => {
    enter(d);
    switch (e.type) {
      case "RichTextBlock": for (let i = 0; i < e.inlines.length; i++) enter(d + 1); break;
      case "FactSet": for (let i = 0; i < e.facts.length; i++) enter(d + 1); break;
      case "ActionSet":
        for (const a of e.actions) {
          enter(d + 1);
          if (a.type === "Action.ToggleVisibility") for (let i = 0; i < a.targetElements.length; i++) enter(d + 2);
        }
        break;
      case "Container": for (const item of e.items) element(item, d + 1); break;
      case "ColumnSet":
        for (const c of e.columns) { enter(d + 1); for (const item of c.items) element(item, d + 2); }
        break;
      case "Table":
        for (const row of e.rows) {
          enter(d + 1);
          for (const cell of row.cells) { enter(d + 2); for (const item of cell.items) element(item, d + 3); }
        }
        break;
      default: break;
    }
  };
  for (const e of card.body) element(e, 1);
  return Object.freeze({ nodes, depth });
}

function validLimit(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0;
}

/**
 * Build the fitted `octo/v1` card and plain text for schema-normalized
 * display arguments. `unavailable` when the capabilities cannot carry a
 * display card at all; `limit_exceeded` when nothing fits.
 */
export function buildDisplayCard(args: DisplayCardArgs, opts: DisplayBuildOptions): DisplayBuild {
  const caps = opts.caps;
  const limits = caps?.limits;
  if (caps === null || typeof caps !== "object" || typeof caps.elements?.has !== "function" || !caps.elements.has("TextBlock")
    || limits === null || typeof limits !== "object" || !validLimit(limits.maxNodes) || !validLimit(limits.maxDepth)
    || !validLimit(limits.maxPayloadBytes)) return CAPABILITY_ERROR;
  const elements = new Set(DISPLAY_ELEMENTS.filter((e) => caps.elements.has(e)));
  const maxNodes = Math.min(limits.maxNodes, CARD_MAX_NODES);
  const maxDepth = Math.min(limits.maxDepth, CARD_MAX_DEPTH);
  const maxBytes = Math.min(limits.maxPayloadBytes, CARD_ENVELOPE_MAX_BYTES);

  const renderer = new Renderer(elements);
  const head: AcDisplayElement[] = args.title === undefined ? [] : [atb(args.title, { weight: "Bolder", size: "Large" })];
  // Render every block once, in order, so collapsible ids do not depend on the cut.
  const rendered = args.blocks.map((b) => renderer.block(b));
  const total = args.blocks.length;

  const attempt = (shown: number): DisplayBuild | undefined => {
    const omitted = total - shown;
    const body = [...head, ...rendered.slice(0, shown).flat(), ...(omitted > 0 ? [tb(omittedBlocksText(omitted))] : [])];
    if (body.length === 0) return undefined;
    const card: DisplayAdaptiveCard = { ...AC_HEADER, body };
    const m = measureDisplayCard(card);
    if (m.nodes > maxNodes || m.depth > maxDepth) return undefined;
    const plain = renderDisplayPlain({ ...(args.title !== undefined ? { title: args.title } : {}), blocks: args.blocks.slice(0, shown) }, { omittedBlocks: omitted });
    const authored: DisplayAuthored = { profile: "octo/v1", card };
    try {
      serializeSendAuthored({ ...authored, route: opts.route, clientMsgNo: MEASURE_CLIENT_MSG_NO, plain, maxEnvelopeBytes: maxBytes });
    } catch {
      return undefined;
    }
    return deepFreeze({ ok: true, authored, plain, shownBlocks: shown, omittedBlocks: omitted });
  };

  // Every fit term is monotone in the prefix length: binary-search the longest
  // fitting prefix, then step down in case a marker length change broke it.
  const whole = attempt(total);
  if (whole !== undefined) return whole;
  let lo = 0, hi = total - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (attempt(mid) !== undefined) lo = mid; else hi = mid - 1;
  }
  for (let shown = lo; shown >= 0; shown--) {
    const fitted = attempt(shown);
    if (fitted !== undefined) return fitted;
  }
  return TOO_LARGE;
}
