# Native image delivery plan (#95)

Team decision: implement the minimum generic artifact authorization, snapshot,
presigned upload and stage ledger here; #27's complete file feature stays separate.
Real preview testing awaits an independent test identity and DM/group targets.

1. Test explicit final-envelope selection before truncation, request binding,
   stale/partial output rejection and ordinary paths remaining ordinary text.
2. Add an opt-in `sdk.nativeImages` configuration (default disabled, 10 MiB,
   four images). Give each turn an exclusive output directory and protocol
   instructions in the current prompt, including resumed sessions.
3. Test and implement regular-file snapshots: flat image filenames only,
   no symlinks/hardlinks, inode checks around open/read, bounded reads and
   PNG/JPEG/GIF signatures/dimensions. No broader workspace authorization.
4. Test and implement presign GET, exact-byte PUT with server headers and
   native type=2 send. Keep signed URLs/tokens/content out of errors/logs/storage.
5. Persist per-artifact generation/upload/delivery state before side effects;
   bind to turn/channel via the host, stop at ownership revocation and retain
   unknown on lost replies. No model replay or automatic send retries.
6. Wire text-first delivery, per-item reports, hash deduplication and explicit
   external disposition. Retain local outputs under the existing workspace TTL.
7. Run lint, tests, type checks and build; document contract SHA, unknown server
   limits/GIF behavior, independent preview gap, configuration and rollback in
   a single PR. Reviews and merge decisions belong to the task initiator.
