import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as telemetry from "../cards/telemetry.js";

const SRC = join(__dirname, "..");
const CARDS = join(SRC, "cards");
const telemetryFiles = readdirSync(CARDS).filter((f) => /^telemetry(-[a-z]+)*\.ts$/.test(f));

describe("closed src/cards/telemetry.ts boundary", () => {
  it("exports exactly the reviewed runtime surface", () => {
    expect(Object.keys(telemetry).sort()).toEqual([
      "ACCEPTANCE_LEVELS", "ACCEPTANCE_REGISTRY_SHA256", "ACCEPTANCE_REGISTRY_VERSION", "ACCEPTANCE_SUBIDS_V1",
      "ATTESTABLE_LEVELS", "AUTHENTICATED_DISPOSITIONS", "CAPABILITIES", "CAPABILITY_STATES", "CONTROLLED_FAILURE_CASE_IDS",
      "COOLDOWN_CODES", "COOLDOWN_END_CODES", "CRITICAL_CODES", "DELIVERY_FAILURE_CODES", "DISPOSITION_CODES", "EVIDENCE_RULES",
      "EXCLUSION_CODES", "INELIGIBLE_CODES", "INVALIDATION_CODES", "LABEL_KEYS", "LEVELS", "LOSS_CODES",
      "M01_CRITICAL_CODES", "M05_CRITICAL_CODES", "MAX_STORE_ORACLE_REFS", "METRIC_LINE_PREFIX", "METRIC_NAMES",
      "METRIC_ROWS", "POLICY_FETCH_CODES", "PROCESS_CLOSE_CODES", "RECORDABLE_LEVELS", "RECORD_MAX_BYTES",
      "RECOVERY_CODES", "RETRY_CODES", "ROUTE_TYPES", "SAFE_REASON_CODES", "TELEMETRY_LIMITS", "TELEMETRY_REJECT_CODES",
      "TOPOLOGIES", "TelemetryConfigError", "WRITE_FAILURES", "WRITE_OUTCOMES", "acceptanceRegistryDigest", "acceptanceRow", "actionSignalValid",
      "batchSignals", "botRefOf", "channelRefOf", "cooldownComponents", "createTelemetrySink", "declarationSetReasons",
      "dispositionCode", "environmentRuntimesCovered", "evaluateBatch", "evaluateM01", "evidenceBindingValid",
      "inspectEvaluation", "intersects", "isSafeText", "metricRow", "openEvaluation", "openSelectedOutputEvidence", "originRefOf", "parseCollection",
      "processRefOf", "resumeAllowed", "revise", "safeTextRule", "seriesCount", "validateBatchDeclaration",
      "validateDeploymentRecord", "validateEvidenceRecord", "validateExclusionRecord", "validateLivenessRecord",
      "validateSourceAttestation", "windowEvaluation",
    ]);
  });

  it("imports only pure leaves: no I/O, timers, environment or console", () => {
    expect(telemetryFiles.sort()).toEqual([
      "telemetry-acceptance.ts", "telemetry-evaluator.ts", "telemetry-evidence.ts", "telemetry-grammar.ts",
      "telemetry-records.ts", "telemetry-registry.ts", "telemetry-selected-output.ts", "telemetry-sink.ts", "telemetry.ts",
    ]);
    const allowed = new Set(["node:crypto", "node:util", "./contracts.js", "./protocol.js", "./origin.js"]);
    for (const file of telemetryFiles) {
      const text = readFileSync(join(CARDS, file), "utf8");
      const imports = [...text.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
      for (const spec of imports) expect([file, allowed.has(spec) || /^\.\/telemetry(-[a-z]+)*\.js$/.test(spec)]).toEqual([file, true]);
      for (const banned of [/\bprocess\.(env|exit|argv|stdout|stderr|on)\b/, /\bconsole\./, /setTimeout|setInterval|setImmediate/, /\bfetch\(/, /\brequire\(/, /\bimport\(/]) {
        expect([file, banned.test(text)]).toEqual([file, false]);
      }
    }
  });

  it("is not wired into any runtime module", () => {
    const users: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== "__tests__") walk(p); continue; }
        if (!/\.(ts|mjs)$/.test(entry.name) || telemetryFiles.includes(entry.name)) continue;
        if (/(from|import)\s*\(?\s*"[^"]*telemetry/.test(readFileSync(p, "utf8"))) users.push(p);
      }
    };
    walk(SRC);
    expect(users).toEqual([]);
  });

  it("keeps tests and harnesses out of the build", () => {
    const tsconfig = JSON.parse(readFileSync(join(SRC, "..", "tsconfig.json"), "utf8")) as { exclude: string[] };
    expect(tsconfig.exclude).toContain("src/__tests__/**/*");
    const pkg = JSON.parse(readFileSync(join(SRC, "..", "package.json"), "utf8")) as { files: string[] };
    expect(pkg.files).not.toContain("src");
  });
});
