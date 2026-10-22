/**
 * Shared WP-14 grammars and opaque reference derivations (§3.2, §4.3, §4.4).
 *
 * Pure: hashing is the only computation. Reference derivations never return
 * or retain their inputs; only the truncated digest leaves this module.
 */

import { createHash, createHmac } from "node:crypto";
import type { BotRef } from "./contracts.js";
import { normalizeOrigin } from "./origin.js";
import { TELEMETRY_LIMITS } from "./telemetry-registry.js";

/** `T`: batchId, cohortRef and slot tokens (max 64 B). */
export const TOKEN_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const PROCESS_REF_PATTERN = /^p[0-9a-f]{16}$/;
export const INC_PATTERN = /^i[0-9a-f]{16}$/;
export const CHANNEL_REF_PATTERN = /^c[0-9a-f]{16}$/;
export const SHA40_PATTERN = /^[0-9a-f]{40}$/;
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
export const ARTIFACT_REF_PATTERN = /^artifact:[a-z0-9][a-z0-9._-]{0,63}@sha256:[0-9a-f]{64}$/;
export const COMMENT_REF_PATTERN =
  /^comment:[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,6}#[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const UTC_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** `<UTC>`: the exact `Date.prototype.toISOString()` form, round-tripping. */
export function isIsoUtc(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 24 || !UTC_SHAPE.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

/** Canonical UTC inside the admissible evaluation domain [0, 253402300799999]. */
export function isDomainUtc(value: unknown): value is string {
  if (!isIsoUtc(value)) return false;
  const ms = Date.parse(value);
  return ms >= 0 && ms <= TELEMETRY_LIMITS.utcMax;
}

export function isoUtc(ms: number): string {
  return new Date(ms).toISOString();
}

const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** `"b" + hex(SHA-256("cards-bot-ref-v1\0" + originKey + "\0" + credentialRef))[0:16]` (ephemeral per process, O-2 A). */
export function botRefOf(bot: BotRef): string {
  return "b" + sha256Hex(`cards-bot-ref-v1\0${bot.originKey}\0${bot.credentialRef}`).slice(0, 16);
}

/** `"o" + hex(SHA-256("cards-origin-ref-v1\0" + normalizeOrigin(x).key))[0:16]`; throws `OriginPolicyError`. */
export function originRefOf(apiOrigin: string): string {
  return "o" + sha256Hex(`cards-origin-ref-v1\0${normalizeOrigin(apiOrigin).key}`).slice(0, 16);
}

/** `"c" + hex(HMAC-SHA256(credentialRef, "cards-channel-ref-v1\0" + type + "\0" + id + "\0" + topicScope))[0:16]`. */
export function channelRefOf(credentialRef: string, channelType: number, channelId: string, topicScope?: string): string {
  const mac = createHmac("sha256", credentialRef)
    .update(`cards-channel-ref-v1\0${channelType}\0${channelId}\0${topicScope ?? ""}`, "utf8")
    .digest("hex");
  return "c" + mac.slice(0, 16);
}

/** `"p" + hex(SHA-256("cards-process-ref-v1\0" + cohortRef + "\0" + slot))[0:16]`. */
export function processRefOf(cohortRef: string, slot: string): string {
  return "p" + sha256Hex(`cards-process-ref-v1\0${cohortRef}\0${slot}`).slice(0, 16);
}

/** SHA-256 of a JSON serialization; used for receipt binding, never as provenance. */
export function fingerprint(value: unknown): string {
  return sha256Hex(JSON.stringify(value) ?? "undefined");
}

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
