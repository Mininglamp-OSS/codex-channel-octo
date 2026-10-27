/**
 * Deterministic plain-text representation of a display card (WP-09): the
 * `plain` fallback sent beside every authored card.
 *
 * Pure. One fixed rendering per block kind in source order, nested
 * collapsible content indented two spaces per level, an omission marker for
 * blocks the card could not show, and byte fitting that drops whole trailing
 * lines (stating how many) and never splits a Unicode scalar. Input is the
 * schema-normalized card; mentions are neutralized again defensively.
 */
import type { DisplayBlock, DisplayCardArgs, RichRun } from "./contracts.js";
import { neutralizeMentions, neutralizeUrls as u } from "./display-schema.js";

/** Plain-text cap; the envelope fit in the builder still applies on top. */
export const PLAIN_MAX_BYTES = 4096;
const ELLIPSIS = "…";
const INDENT = "  ";

function plural(n: number, noun: string): string {
  return `${n} more ${noun}${n === 1 ? "" : "s"} not shown`;
}

/** Marker for trailing blocks the fitted card omits. */
export function omittedBlocksText(n: number): string {
  return `${ELLIPSIS} ${plural(n, "block")}`;
}

function omittedLinesText(n: number): string {
  return `${ELLIPSIS} ${plural(n, "line")}`;
}

function bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function truncate(line: string, maxBytes: number): string {
  const budget = maxBytes - bytes(ELLIPSIS);
  if (budget < 0) return "";
  let out = "";
  let used = 0;
  for (const c of line) {
    const size = bytes(c);
    if (used + size > budget) break;
    out += c;
    used += size;
  }
  return out + ELLIPSIS;
}

/**
 * Fit text within `maxBytes`: keep the longest prefix of whole lines plus a
 * "N more lines not shown" marker; when not even one line fits beside the
 * marker, truncate the first line on a scalar boundary with an ellipsis.
 */
export function fitPlain(text: string, maxBytes: number): string {
  if (bytes(text) <= maxBytes) return text;
  const lines = text.split("\n");
  let used = 0;
  for (let k = 0; k < lines.length; k++) {
    const next = used + bytes(lines[k]) + 1;
    if (next + bytes(omittedLinesText(lines.length - k - 1)) > maxBytes) {
      if (k === 0) return truncate(lines[0], maxBytes);
      return `${lines.slice(0, k).join("\n")}\n${omittedLinesText(lines.length - k)}`;
    }
    used = next;
  }
  return truncate(lines[0], maxBytes);
}

function runText(run: RichRun): string {
  switch (run.kind) {
    case "code": return `\`${u(run.text)}\``;
    case "link": return `${u(run.label)} (${run.url})`;
    default: return u(run.text);
  }
}

function blockLines(block: DisplayBlock): string[] {
  switch (block.kind) {
    // Authored text is URL-defanged; only validated structured link URLs stay as written.
    case "heading": return [u(block.text)];
    case "text": return u(block.text).split("\n");
    case "rich_text": return block.runs.map(runText).join("").split("\n");
    case "facts": return block.items.flatMap((f) => `${u(f.label)}: ${u(f.value)}`.split("\n"));
    case "columns": return block.columns.flatMap((c) => c.blocks.flatMap(blockLines));
    case "table": return [block.headers, ...block.rows].flatMap((row) => row.map(u).join(" | ").split("\n"));
    case "link": return [`${u(block.label)}: ${block.url}`];
    case "group": return block.blocks.flatMap(blockLines);
    case "collapsible": return [u(block.label), ...block.blocks.flatMap(blockLines).map((l) => INDENT + l)];
    case "copy": return `${u(block.label)}: ${u(block.text)}`.split("\n");
  }
}

/** Plain text of a (fitted) display card: title, blank line, blocks, omission marker. */
export function renderDisplayPlain(args: DisplayCardArgs, opts: { readonly omittedBlocks?: number; readonly maxBytes?: number } = {}): string {
  const lines: string[] = [];
  if (args.title !== undefined) lines.push(u(args.title), "");
  for (const block of args.blocks) lines.push(...blockLines(block));
  const maxBytes = opts.maxBytes ?? PLAIN_MAX_BYTES;
  const text = neutralizeMentions(lines.join("\n"));
  // The block omission marker always survives line fitting.
  if (opts.omittedBlocks === undefined || opts.omittedBlocks <= 0) return fitPlain(text, maxBytes);
  const marker = omittedBlocksText(opts.omittedBlocks);
  if (lines.length === 0) return fitPlain(marker, maxBytes);
  const fitted = fitPlain(text, maxBytes - bytes(marker) - 1);
  return fitted === "" ? fitPlain(marker, maxBytes) : `${fitted}\n${marker}`;
}
