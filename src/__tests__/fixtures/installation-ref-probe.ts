/**
 * Subprocess probe for the installation-reference reader (S2). Opens the card
 * subsystem of the dataDir in argv[2] over an adapter that only records being
 * touched, and prints one JSON line `{ state, reason, adapterTouched }`. A
 * reader that blocks never prints; the parent test bounds and kills it.
 */

import type { DbAdapter } from "../../db-adapter.js";
import { openCardSubsystem } from "../../cards/recovery.js";

let adapterTouched = false;
const adapter = new Proxy({}, { get() { adapterTouched = true; throw new Error("adapter touched"); } }) as DbAdapter;
const result = await openCardSubsystem({ adapter, dataDir: process.argv[2]!, runtimeIncarnation: "probe", clock: { nowUtcMs: () => Date.now() } });
process.stdout.write(`${JSON.stringify({ state: result.state, reason: result.state === "disabled" ? result.reason : undefined, adapterTouched })}\n`);
