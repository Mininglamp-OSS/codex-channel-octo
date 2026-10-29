/**
 * Server data contract of `ai.reasoning-process@0.4.1` (draft-07), pinned
 * byte-for-byte from octo-server; see `ai-reasoning-process-0.4.1/PROVENANCE.json`.
 * The Registry render path answers HTTP 400 for any data this schema rejects.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import Ajv from "ajv";

const DIR = new URL("./ai-reasoning-process-0.4.1/", import.meta.url);
const raw = readFileSync(new URL("data.schema.json", DIR));
const provenance = JSON.parse(readFileSync(new URL("PROVENANCE.json", DIR), "utf8")) as { sha256: string };
if (createHash("sha256").update(raw).digest("hex") !== provenance.sha256) {
  throw new Error("pinned ai.reasoning-process@0.4.1 schema does not match its provenance sha256");
}

export const REASONING_SCHEMA = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;

const validate = new Ajv({ allErrors: true }).compile(REASONING_SCHEMA);

/** Server-equivalent schema errors for template `data`; empty when the server would accept it. */
export function reasoningSchemaErrors(data: unknown): string[] {
  if (validate(data)) return [];
  return (validate.errors ?? []).map((e) => `${e.dataPath || "/"} ${e.keyword} ${e.message ?? ""}`.trim());
}
