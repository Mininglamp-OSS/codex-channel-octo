/**
 * Card subsystem startup for one Bot (§4.3, WP-13A-1; pre-wiring only).
 *
 * `openCardSubsystem` binds the existing startup contracts and adds no
 * parallel algorithm:
 * - provenance: the deployment-provisioned `<dataDir>/cards/installation-ref`
 *   (a private regular file holding one safe store reference) and the
 *   `FileActivationMarker` at `<dataDir>/cards/activation.json`, written by
 *   `provisionFirstInstallMarker` and never overwritten here;
 * - store: `initializeCardStore` over the Bot's existing database adapter,
 *   which alone owns marker/lineage checks, the pre-migration backup into
 *   `<dataDir>/cards/backups`, migration and invariants, in its own order.
 *
 * A missing or unsafe installation reference disables cards before any
 * database access. Every disabled result leaves the Bot card-inert: no store,
 * no queue, and the ordinary path untouched. On `ready`, the explicit ledger
 * of earlier runtime incarnations is recovered before the queue factory is
 * handed out, so no queue or tool host can exist before it. Queues built by
 * the factory re-derive D-B/N2 suspension from the store; startup never
 * resends, edits or abandons an unresolved send.
 *
 * Nothing here is called by the runtime yet.
 */

import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { DbAdapter } from "../db-adapter.js";
import type { BackupReceipt, CardMeta, InvariantViolation } from "./migrations.js";
import { FileActivationMarker, isSafeStoreRef } from "./migrations.js";
import {
  initializeCardStore,
  type CardStore,
  type CardStoreDisabledReason,
  type CardStoreOptions,
  type LedgerRecovery,
} from "./store.js";
import { createWriteQueue, type CardWriteQueue, type WriteQueueOptions } from "./write-queue.js";

export interface CardSubsystemPaths {
  readonly cardsDir: string;
  readonly markerPath: string;
  readonly installationRefPath: string;
  readonly backupDir: string;
}

export function cardSubsystemPaths(dataDir: string): CardSubsystemPaths {
  const cardsDir = join(dataDir, "cards");
  return Object.freeze({
    cardsDir,
    markerPath: join(cardsDir, "activation.json"),
    installationRefPath: join(cardsDir, "installation-ref"),
    backupDir: join(cardsDir, "backups"),
  });
}

export interface CardSubsystemOptions extends CardStoreOptions {
  /** The Bot's already-open ordinary database adapter (`<dataDir>/cc-octo.db`). */
  readonly adapter: DbAdapter;
  readonly dataDir: string;
  /** Identity of this process run; live handler generations of any other incarnation are closed. */
  readonly runtimeIncarnation: string;
  readonly newLineageId?: () => string;
}

/** Builds a write queue over the recovered store; each call re-derives suspension. */
export type CardQueueFactory = (options: Omit<WriteQueueOptions, "store">) => CardWriteQueue;

export type CardSubsystemDisabledReason = CardStoreDisabledReason | "ledger_recovery_failed" | "startup_failed";

export type CardSubsystem =
  | {
      readonly state: "ready";
      readonly store: CardStore;
      readonly meta: CardMeta;
      readonly provenance: "first_install" | "reopened" | "activation_reconciled";
      readonly backup?: BackupReceipt;
      readonly ledger: LedgerRecovery;
      readonly queueFactory: CardQueueFactory;
    }
  | { readonly state: "disabled"; readonly reason: CardSubsystemDisabledReason; readonly violations?: readonly InvariantViolation[] };

/** Upper bound on the reference file; a safe reference is far shorter. */
const MAX_REF_FILE_BYTES = 1024;

type RefRead = { readonly kind: "ok"; readonly ref: string } | { readonly kind: "missing" } | { readonly kind: "invalid" };

/**
 * Read the installation reference without following a symlink: a regular
 * file, not group/other accessible (POSIX), holding one safe reference with
 * at most one trailing newline.
 */
function readInstallationRef(path: string): RefRead {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : { kind: "invalid" };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_REF_FILE_BYTES) return { kind: "invalid" };
    if (process.platform !== "win32" && (st.mode & 0o077) !== 0) return { kind: "invalid" };
    const buf = Buffer.alloc(MAX_REF_FILE_BYTES + 1);
    let len = 0;
    for (;;) {
      const n = readSync(fd, buf, len, buf.length - len, null);
      if (n === 0) break;
      len += n;
      if (len > MAX_REF_FILE_BYTES) return { kind: "invalid" };
    }
    const text = buf.subarray(0, len).toString("utf8");
    const ref = text.endsWith("\n") ? text.slice(0, -1) : text;
    return isSafeStoreRef(ref) ? { kind: "ok", ref } : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
  }
}

function disabled(reason: CardSubsystemDisabledReason, violations?: readonly InvariantViolation[]): CardSubsystem {
  return Object.freeze(violations ? { state: "disabled", reason, violations } : { state: "disabled", reason });
}

/**
 * Open the card subsystem of one Bot after its ordinary store is initialized
 * and before the gateway connects. Never throws.
 */
export async function openCardSubsystem(options: CardSubsystemOptions): Promise<CardSubsystem> {
  let paths: CardSubsystemPaths;
  try {
    paths = cardSubsystemPaths(options.dataDir);
  } catch {
    return disabled("startup_failed");
  }
  const ref = readInstallationRef(paths.installationRefPath);
  if (ref.kind === "missing") return disabled("provenance_missing");
  if (ref.kind === "invalid") return disabled("provenance_invalid");

  let init;
  try {
    init = await initializeCardStore({
      adapter: options.adapter,
      marker: new FileActivationMarker(paths.markerPath),
      installationRef: ref.ref,
      backupDir: paths.backupDir,
      clock: options.clock,
      ...(options.newId !== undefined ? { newId: options.newId } : {}),
      ...(options.sessionCapacity !== undefined ? { sessionCapacity: options.sessionCapacity } : {}),
      ...(options.newLineageId !== undefined ? { newLineageId: options.newLineageId } : {}),
    });
  } catch {
    return disabled("startup_failed");
  }
  if (init.state !== "ready") return disabled(init.reason, init.violations);

  const { store } = init;
  let ledger: LedgerRecovery;
  try {
    ledger = store.recoverExplicitLedger(options.runtimeIncarnation);
  } catch {
    store.retire();
    return disabled("ledger_recovery_failed");
  }
  if (ledger.violations.length > 0) {
    store.retire();
    return disabled("invariant_failed", ledger.violations);
  }

  const queueFactory: CardQueueFactory = (queueOptions) => createWriteQueue({ ...queueOptions, store });
  return Object.freeze({
    state: "ready",
    store,
    meta: init.meta,
    provenance: init.provenance,
    ...(init.backup !== undefined ? { backup: init.backup } : {}),
    ledger,
    queueFactory,
  });
}
