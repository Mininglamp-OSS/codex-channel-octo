import { describe, expect, it } from "vitest";
import {
  ACCEPTANCE_REGISTRY_SHA256, ACCEPTANCE_SUBIDS_V1, acceptanceRegistryDigest, acceptanceRow, safeTextRule,
  validateEvidenceRecord, validateSourceAttestation, type EvidenceBinding,
} from "../cards/telemetry.js";
import { BASE_SHA, BIND, BOT, ORIGIN, PROFILE, RT, SHA } from "./fixtures/telemetry-harness.js";

const utc = "2026-10-15T07:40:34.000Z";
const RECORD = {
  subId: "AC-023.2", level: "live_api", probe: "P03", candidateSha: SHA, frozenBaselineSha: BASE_SHA,
  codexSdkVersion: RT.codexSdkVersion, codexCliVersion: RT.codexCliVersion, nodeVersion: RT.nodeVersion,
  apiOrigin: ORIGIN, profileHash: PROFILE, botRef: BOT, channelRef: "c" + "1".repeat(16), routeType: "group",
  startUtc: utc, endUtc: "2026-10-15T07:50:34.000Z", fixtureRevision: "cards-fixtures@v3", harnessIdentity: "wp17-harness@1.0.0",
  result: "pass",
};
const ATTEST = {
  subId: "AC-011.10", level: "integration", candidateSha: SHA, frozenBaselineSha: BASE_SHA,
  codexSdkVersion: RT.codexSdkVersion, codexCliVersion: RT.codexCliVersion, nodeVersion: RT.nodeVersion,
  suiteRef: "artifact:vitest@sha256:" + "d".repeat(64), startUtc: utc, endUtc: utc, harnessIdentity: "vitest@3.2.4",
  fixtureRevision: "suite@" + "e".repeat(40), result: "pass",
};
const diags = (r: { ok: boolean; diagnostics?: readonly { path: string; rule: string }[] }) =>
  r.ok ? [] : r.diagnostics!.map((d) => `${d.path}:${d.rule}`);
const rec = (x: Record<string, unknown>, binding?: EvidenceBinding) => diags(validateEvidenceRecord(JSON.stringify({ ...RECORD, ...x }), binding));
const att = (x: Record<string, unknown>, binding?: EvidenceBinding) => diags(validateSourceAttestation(JSON.stringify({ ...ATTEST, ...x }), binding));

describe("acceptance-subids.v1 registry", () => {
  it("pins 99 rows with the PRD v4 §8 level/priority breakdown and its digest", () => {
    expect(ACCEPTANCE_SUBIDS_V1).toHaveLength(99);
    expect(new Set(ACCEPTANCE_SUBIDS_V1.map((r) => r.subId)).size).toBe(99);
    const count = (p: string, l: string) => ACCEPTANCE_SUBIDS_V1.filter((r) => r.priority === p && r.declaredLevel === l).length;
    expect([count("P0", "unit"), count("P0", "integration"), count("P0", "restart_fault"), count("P0", "live_api"), count("P0", "deployment"), count("P0", "black_box")])
      .toEqual([17, 47, 2, 13, 7, 8]);
    expect([count("P1", "unit"), count("P1", "integration"), count("P1", "restart_fault")]).toEqual([2, 2, 1]);
    expect(ACCEPTANCE_SUBIDS_V1.filter((r) => r.priority === "P1").map((r) => r.subId)).toEqual(["AC-006.2", "AC-006.3", "AC-018.3", "AC-018.4", "AC-019.3"]);
    expect(acceptanceRow("AC-011.10")).toEqual({ subId: "AC-011.10", declaredLevel: "integration", priority: "P0" });
    expect(acceptanceRegistryDigest()).toBe(ACCEPTANCE_REGISTRY_SHA256);
    expect(acceptanceRegistryDigest([...ACCEPTANCE_SUBIDS_V1].reverse())).not.toBe(ACCEPTANCE_REGISTRY_SHA256);
    expect(Object.isFrozen(ACCEPTANCE_SUBIDS_V1[0])).toBe(true);
  });
});

describe("EvidenceRecord / SourceAttestation grammar (§4.3)", () => {
  it("accepts valid records and binds them", () => {
    expect(rec({})).toEqual([]);
    expect(rec({}, BIND)).toEqual([]);
    expect(att({})).toEqual([]);
    expect(att({}, BIND)).toEqual([]);
    const v = validateEvidenceRecord(JSON.stringify(RECORD));
    expect(v.ok && Object.isFrozen(v.value)).toBe(true);
  });

  it("reports closed field rules at known paths only", () => {
    expect(rec({ smuggled: "x" })).toEqual(["/:unknown_field"]);
    expect(rec({ probe: null })).toEqual(["/probe:null_value"]);
    expect(rec({ probe: 3 })).toEqual(["/probe:wrong_type"]);
    expect(rec({ probe: "P11" })).toEqual(["/probe:grammar"]);
    expect(rec({ subId: "AC-026.1" })).toEqual(["/subId:grammar"]);
    expect(rec({ subId: "AC-025.10" })).toEqual(["/subId:unknown_sub_id"]);
    expect(rec({ codexSdkVersion: "01.2.3" })).toEqual(["/codexSdkVersion:grammar"]);
    expect(rec({ codexSdkVersion: "1.2.3-" + "a".repeat(60) })).toEqual(["/codexSdkVersion:too_long"]);
    expect(rec({ nodeVersion: "22.11.0" })).toEqual(["/nodeVersion:grammar"]);
    expect(rec({ startUtc: "2026-10-15T07:40:34Z" })).toEqual(["/startUtc:grammar"]);
    expect(rec({ fixtureRevision: "Fixture@v1" })).toEqual(["/fixtureRevision:grammar"]);
    expect(rec({ topologyRef: "comment:XIN-2201#4e439455-934e-43d7-bf8d-972ecae90583" })).toEqual([]);
    expect(rec({ ownerApprovalRef: "artifact:a@sha256:" + "0".repeat(64) })).toEqual(["/ownerApprovalRef:too_long"]);
    expect(rec({ ownerApprovalRef: "comment:XIN-2038#2E0EF55A-b5a4-42e8-9f03-52e26d95e292" })).toEqual(["/ownerApprovalRef:grammar"]);
    const missing: Record<string, unknown> = { ...RECORD };
    delete missing.botRef;
    expect(diags(validateEvidenceRecord(JSON.stringify(missing)))).toEqual(["/botRef:missing_field"]);
  });

  it("requires the exact canonical origin key", () => {
    for (const bad of ["https://api.example.com", "https://API.example.com:443", "https://u:p@api.example.com:443", "https://api.example.com:443/v1", "http://api.example.com:80", "ftp://x:21"]) {
      expect(rec({ apiOrigin: bad })).toEqual(["/apiOrigin:not_canonical_origin"]);
    }
    expect(rec({ apiOrigin: "https://" + "a".repeat(300) })).toEqual(["/apiOrigin:too_long"]);
  });

  it("rejects secret-shaped template versions", () => {
    expect(rec({ templateFingerprint: "ai.reasoning-process@1.4.0#" + "d".repeat(64) })).toEqual([]);
    expect(rec({ templateFingerprint: "ai.reasoning-process@" + "A".repeat(64) + "#" + "d".repeat(64) })).toEqual(["/templateFingerprint:secret_shape"]);
    expect(rec({ templateFingerprint: "ai.reasoning-process@1#" + "D".repeat(64) })).toEqual(["/templateFingerprint:grammar"]);
  });

  it("applies the level, time and n/a rules", () => {
    expect(rec({ level: "unit" })).toEqual(["/level:level_not_recordable"]);
    expect(rec({ subId: "AC-001.1" })).toEqual(["/subId:level_not_recordable"]);
    expect(rec({ level: "deployment" })).toEqual(["/level:level_mismatch"]);
    expect(att({ level: "live_api" })).toEqual(["/level:level_not_attestable"]);
    expect(att({ subId: "AC-022.4" })).toEqual(["/subId:level_not_attestable"]);
    expect(att({ level: "unit" })).toEqual(["/level:level_mismatch"]);
    expect(rec({ level: "LIVE" })).toEqual(["/level:grammar"]);
    expect(rec({ endUtc: "2026-10-15T07:40:33.999Z" })).toEqual(["/endUtc:time_order"]);
    expect(rec({ endUtc: new Date(Date.parse(utc) + 2_592_000_000).toISOString() })).toEqual([]);
    expect(rec({ endUtc: new Date(Date.parse(utc) + 2_592_000_001).toISOString() })).toEqual(["/endUtc:span_exceeded"]);
    expect(rec({ result: "n/a" })).toEqual(["/result:na_requires_approval"]);
    expect(rec({ result: "n/a", rationale: "Capability disabled by owner scope decision" })).toEqual(["/result:na_requires_approval"]);
    expect(rec({ result: "n/a", rationale: "Capability disabled by owner scope decision", ownerApprovalRef: "comment:XIN-2038#2e0ef55a-b5a4-42e8-9f03-52e26d95e292" })).toEqual([]);
    expect(rec({ result: "skipped" })).toEqual(["/result:grammar"]);
  });

  it("caps diagnostics at 16 and never echoes input bytes", () => {
    const hostile: Record<string, unknown> = {};
    for (const k of Object.keys(RECORD)) hostile[k] = "CANARY-" + k;
    for (let i = 0; i < 20; i++) hostile[`CANARY_KEY_${i}`] = "CANARY";
    const r = validateEvidenceRecord(JSON.stringify(hostile));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.diagnostics.length).toBeLessThanOrEqual(16);
      expect(JSON.stringify(r.diagnostics)).not.toContain("CANARY");
      for (const d of r.diagnostics) expect(d.path === "/" || Object.hasOwn(RECORD, d.path.slice(1)) || ["/rationale", "/ownerApprovalRef"].includes(d.path)).toBe(true);
    }
  });

  it("applies the structural limits and the executed worst cases", () => {
    const sv = "1.0.0-" + "a".repeat(58);
    const ref = "artifact:" + "a".repeat(64) + "@sha256:" + "f".repeat(64);
    const worst = (rationale: string) => ({
      ...RECORD, subId: "AC-023.10", probe: "P10", codexSdkVersion: sv, codexCliVersion: sv, nodeVersion: "v9999999.9999999.9999999",
      apiOrigin: "https://" + ("a".repeat(63) + ".").repeat(3) + "a".repeat(61) + ":65535",
      templateFingerprint: "ai.reasoning-process@" + "Ab1.".repeat(16) + "#" + "d".repeat(64),
      fixtureRevision: "a".repeat(64) + "@" + "f".repeat(40), harnessIdentity: "a".repeat(64) + "@" + sv,
      topologyRef: ref, clockRef: ref, faultRef: ref, result: "unverified", rationale,
      ownerApprovalRef: "comment:ABCDEFGHIJ-1234567#01234567-89ab-cdef-0123-456789abcdef",
    });
    const quotes = JSON.stringify(worst('"'.repeat(512)));
    expect(Buffer.byteLength(quotes)).toBe(2982);
    expect(diags(validateEvidenceRecord(quotes))).toEqual([]);
    expect(diags(validateEvidenceRecord(JSON.stringify(worst("中".repeat(170)))))).toEqual([]);
    const escaped = JSON.stringify(worst("x")).replace('"rationale":"x"', '"rationale":"' + "\\u0041".repeat(512) + '"');
    expect(Buffer.byteLength(escaped)).toBeGreaterThan(4096);
    expect(diags(validateEvidenceRecord(escaped))).toEqual(["/:record_too_large"]);
    const attWorst = JSON.stringify({ ...ATTEST, subId: "AC-011.10", codexSdkVersion: sv, codexCliVersion: sv, nodeVersion: "v9999999.9999999.9999999",
      suiteRef: ref, harnessIdentity: "a".repeat(64) + "@" + sv, fixtureRevision: "a".repeat(64) + "@" + "f".repeat(40), result: "unverified",
      rationale: '"'.repeat(512), ownerApprovalRef: "comment:ABCDEFGHIJ-1234567#01234567-89ab-cdef-0123-456789abcdef" });
    expect(Buffer.byteLength(attWorst)).toBeLessThanOrEqual(2032);
    expect(diags(validateSourceAttestation(attWorst))).toEqual([]);
    expect(diags(validateEvidenceRecord("{"))).toEqual(["/:malformed_json"]);
    expect(diags(validateEvidenceRecord('{"subId":{"x":1}}'))).toEqual(["/:depth_exceeded"]);
    expect(diags(validateEvidenceRecord(null))).toEqual(["/:wrong_type"]);
  });
});

describe("SafeText (§4.3)", () => {
  it("accepts plain prose, email addresses and lowercase assignments", () => {
    for (const ok of ["Probe passed on the isolated Bot.", "contact ops@example.com", "password=hunter2 rotated", "token: ok", "中文说明", "x"]) {
      expect(safeTextRule(ok)).toBeNull();
    }
  });

  it("rejects Unicode, control and secret shapes with the closed rule", () => {
    const cases: [string, string][] = [
      ["e\u0301", "not_nfc"], ["bell\u0007", "forbidden_char"], ["rtl\u202eoverride", "forbidden_char"],
      ["zero\u200bwidth", "forbidden_char"], ["private\ue000use", "forbidden_char"], ["line\u2028sep", "forbidden_char"],
      ["lone\ud800", "forbidden_char"], [" lead", "grammar"], ["trail\u00a0", "grammar"], ["", "grammar"],
      ["a".repeat(513), "too_long"], ["中".repeat(171), "too_long"],
      ["see https://x", "secret_shape"], ["dsn user:pw@host", "secret_shape"], ["eyJhbGc.eyJzdWI.sig", "secret_shape"],
      ["set API_KEY=abc", "secret_shape"], ["sk-abc", "secret_shape"], ["ghp_x", "secret_shape"], ["gho_x", "secret_shape"],
      ["github_pat_x", "secret_shape"], ["xoxb-1", "secret_shape"], ["AKIAABCDEFGHIJKLMNOP", "secret_shape"],
      ["-----BEGIN KEY", "secret_shape"], ["deadbeef".repeat(4), "secret_shape"], ["QUJD".repeat(8) + "==", "secret_shape"],
      ["at /etc/passwd", "secret_shape"], ["~/x", "secret_shape"], ["../up", "secret_shape"], ["C:\\Users", "secret_shape"],
      ["\\\\share\\x", "secret_shape"],
    ];
    for (const [text, rule] of cases) expect([text, safeTextRule(text)]).toEqual([text, rule]);
    expect(safeTextRule(5)).toBe("wrong_type");
    expect(safeTextRule(null)).toBe("null_value");
  });
});

describe("binding (§4.6) and exact-SHA invalidation", () => {
  const flip = (sha: string) => (sha[0] === "a" ? "b" : "a") + sha.slice(1);
  it("invalidates other-SHA and other-runtime evidence", () => {
    expect(rec({ candidateSha: flip(SHA) }, BIND)).toEqual(["/candidateSha:binding_mismatch"]);
    expect(rec({ frozenBaselineSha: flip(BASE_SHA) }, BIND)).toEqual(["/frozenBaselineSha:binding_mismatch"]);
    expect(rec({ nodeVersion: "v22.11.1" }, BIND)).toEqual(["/nodeVersion:binding_mismatch"]);
    expect(rec({ codexCliVersion: "0.142.4" }, BIND)).toEqual(["/codexCliVersion:binding_mismatch"]);
    expect(rec({ botRef: "b" + "9".repeat(16) }, BIND)).toEqual(["/botRef:binding_missing"]);
    expect(rec({ apiOrigin: "https://other.example.com:443" }, BIND)).toEqual(["/apiOrigin:binding_mismatch"]);
    expect(rec({ profileHash: "0".repeat(64) }, BIND)).toEqual(["/profileHash:binding_mismatch"]);
    expect(rec({ templateFingerprint: "ai.reasoning-process@1.4.0#" + "d".repeat(64) }, BIND)).toEqual(["/templateFingerprint:binding_mismatch"]);
    expect(att({ codexSdkVersion: "0.142.4" }, BIND)).toEqual(["/codexSdkVersion:binding_mismatch"]);
    expect(att({ candidateSha: flip(SHA) }, BIND)).toEqual(["/candidateSha:binding_mismatch"]);
  });

  it("requires every environment runtime to be a source runtime", () => {
    const uncovered: EvidenceBinding = { ...BIND, sourceRuntimes: [{ ...RT, nodeVersion: "v24.0.0" }] };
    expect(rec({}, uncovered)).toEqual(["/:binding_missing"]);
    expect(rec({}, { candidateSha: SHA } as never)).toEqual(["/:binding_missing"]);
  });
});
