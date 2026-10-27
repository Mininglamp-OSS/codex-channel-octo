/**
 * Admissible G-d fixture (WP09-PF v3 §4.4 as amended by v3.1).
 *
 * A temp CODEX_HOME with the reviewed admitted `config.toml`, one exposure
 * registered as resolved `read-only` with API-key auth only, and a session cwd
 * under `/tmp` (no project `.codex` ancestor on any CI host). `admit` is the
 * real `gatewayAdmitsInjection(cwd)`, so it fills the single-use admit slot
 * exactly as the runtime's admit does; nothing here bypasses a gate. It needs
 * the host preconditions G-d itself checks: no `/etc/codex`, no managed
 * preferences with a Codex plist and no auth marker in `process.env`.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REQUIRED_DISABLED_CODEX_FEATURES, gatewayAdmitsInjection, registerGatewayExposure } from "../../cards/tool-host.js";

/** The admitted `config.toml`: API-key login forced and every required-disabled feature explicitly off. */
export const ADMITTED_CONFIG_TOML = `forced_login_method = "api"\n[features]\n${REQUIRED_DISABLED_CODEX_FEATURES.map((f) => `${f} = false`).join("\n")}\n`;

export interface AdmissibleGateway {
  readonly codexHome: string;
  readonly cwd: string;
  /** The real G-d admit for `cwd`. */
  readonly admit: () => boolean;
  /** Unregister the exposure and remove the temp directories; idempotent. */
  readonly release: () => void;
}

export function admissibleGateway(): AdmissibleGateway {
  const codexHome = mkdtempSync(join(tmpdir(), "gd-home-"));
  writeFileSync(join(codexHome, "config.toml"), ADMITTED_CONFIG_TOML);
  const cwd = mkdtempSync("/tmp/gd-cwd-");
  const unregister = registerGatewayExposure({ sandboxMode: "read-only", codexHome, apiKeyConfigured: true, sdkEnvAuthMarkers: false });
  let released = false;
  return {
    codexHome,
    cwd,
    admit: () => gatewayAdmitsInjection(cwd),
    release: () => {
      if (released) return;
      released = true;
      unregister();
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}
