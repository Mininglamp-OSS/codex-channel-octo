# R8-AMD-01: A-R8-PM05-01 and A-R8-SB07-01

| Field | Value |
|---|---|
| Amendment version | `R8-AMD-01` (amends R8) |
| Proposals | `A-R8-PM05-01`, `A-R8-SB07-01` |
| Owner ratification | `owner-ratified-R8-AMD-01` |
| Stage | DEV-01 harness and invariant foundations |
| Source pin B | `Mininglamp-OSS/openclaw-channel-octo` `2e710e903fa43ac9440723746f7395d2f7b4347e` |
| Binary pin | `codex-cli 0.142.3` |

This implementation traceability record references the owner-ratified proposal in XIN-2118 comment `owner-ratified-R8-AMD-01`; it does not replace PjM publication of the authoritative amendment. Everything else in R8 remains unchanged.

## A-R8-PM05-01: Octo tool surfaces (R8 §4 O24, §9 DEV-14)

### Normative text

R8 stated 27 `octo_management` actions. The pinned B source defines two
disjoint public surfaces. The advertised message actions are a subset of
reachable message routes; the parity accounting follows the source:

1. **`octo_management`**: exactly **24** actions. The enum lives in
   `createOctoManagementTools` (`src/agent-tools.ts`, sha256
   `bf549838a2995094fcf95514e081317c8b35820979b661a1d3615409e75cbf06`). `write-secret`
   appears exactly once. The tool is registered by `api.registerTool` in `index.ts`
   (`names: ['octo_management']`).
2. **Advertised message actions**: exactly **3**: `send`, `read` and `search`. They
   are returned by `getAvailableActions` (`src/channel.ts`, sha256
   `c18771187069feda3ee4212978b6da4ebb2c39da8a704ec548e97cbfd85bca4c`) through
   `octoPlugin.actions.listActions` and `describeMessageTool`. This surface is
   disjoint from `octo_management`.
3. **Reachable message routes**: exactly **8** `handleOctoMessageAction` cases
   (`src/actions.ts`, sha256
   `928312349952a5f3697ee46ef51742aae5d7d528dd08add595fc7d3f6d5d7002`), dispatched from
   `octoPlugin.actions.handleAction`:

   | Route | Case line | Handler | Advertised | Matrix row | References |
   |---|---|---|---|---|---|
   | `send` | 189 | `handleSend` | yes | `O24.msg.send` | none |
   | `read` | 191 | `handleRead` | yes | `O24.msg.read` | none |
   | `search` | 193 | `handleSearch` | yes | `O24.msg.search` | none |
   | `member-info` | 195 | `handleMemberInfo` | no | `O24.msg-route.member-info` | `EP-13`, `O24.mgmt.group-members` |
   | `channel-list` | 197 | `handleChannelList` | no | `O24.msg-route.channel-list` | `EP-12`, `O24.mgmt.list-groups` |
   | `channel-info` | 199 | `handleChannelInfo` | no | `O24.msg-route.channel-info` | `EP-12`, `O24.mgmt.group-info` |
   | `group-md-read` | 201 | `handleGroupMdRead` | no | `O24.msg-route.group-md-read` | `EP-15`, `O24.mgmt.group-md-read` |
   | `group-md-update` | 203 | `handleGroupMdUpdate` | no | `O24.msg-route.group-md-update` | `EP-15`, `O24.mgmt.group-md-update` |

   The advertised 3 are a subset of the reachable 8. The 5 reachable-only routes
   are not advertised capabilities, and nothing here adds a new advertised
   capability.

### Ratified O24 clarification (verbatim)

The ratified substring replacements are:

| R8 location | Old text | Replacement text |
|---|---|---|
| §4 ledger introduction | `especially EP-17/18/20/27 and 27 management actions` | `especially EP-17/18/20/27, the 24 octo_management enum actions and the three separately advertised message actions (send, read, search)` |
| §4 O24 title | ``Agent tools (`octo_management` 27 actions, message send/read/search, write-secret)`` | ``Agent tools (`octo_management`: 24 enum actions including write-secret; separate advertised message actions: send/read/search)`` |
| §9 DEV-14 deliverables | `27 action-level fixtures` | `action-level fixture accounting for the 24 octo_management enum actions plus the three separately advertised message actions (send/read/search), preserving approved DEV-14/DEV-17 and Tier B/C ownership` |

> O24 advertised-action accounting is exactly 24 octo_management enum actions, including write-secret, plus the three separately advertised channel/message actions send, read and search. These 27 advertised entries are disjoint by public surface and must each retain a namespaced parity row and request/response/error and authorization fixtures. This count does not exhaust dispatch routes: pinned B handleOctoMessageAction also handles member-info, channel-list, channel-info, group-md-read and group-md-update. Record each additional route with its source ownership and a cross-reference to its existing capability/endpoint; do not count shared endpoint behavior as a new management action or silently omit route-specific authorization, target resolution, result envelope or cache behavior. Adding or removing public tools, merging permission domains, dropping reachable compatibility behavior, or changing approved Tier B/C ownership requires a separate reviewed owner decision.

### Counts

* 24 management + 8 reachable message routes = **32** surface/action pairs.
* **30** distinct action names: `group-md-read` and `group-md-update` exist on
  both the management surface and the message surface.
* No action is counted twice on one surface. The advertised 3 are counted once,
  as reachable routes that are also advertised.

### Route contracts

Each of the 8 routes owns four named pending contracts: **authorization**,
**target resolution**, **result envelope** and **cache**
(`test/contracts/dev-14.message-routes.contract.test.ts`). They belong to the
original O24 ownership, **DEV-14 Tier B**: each reachable-only route follows its
referenced management row, and `send`/`read`/`search` follow O24. Passing
source-provenance assertions (`test/parity/pm05-routes.test.ts`) are not
behavioral contract passes. A route row stays `pending`/`not-run` until its
four contracts execute.

### Unchanged scope

* 155 top-level R8 capability rows and 59 cron behavior IDs.
* The 3 existing advertised message rows (`O24.msg.*`) stay as they are.
* Tier C actions (`voice-context-*`, `write-secret`) remain DEV-17, parity-later.
* The matrix gains exactly 5 `message-route` rows (355 → 360 rows).

### Evidence

* Golden: `test/goldens/b/management-actions.json`, regenerated by
  `scripts/goldens/gen-b.mjs` from the pinned source (`npm run goldens:verify`).
  It carries AST-captured inventories plus file/symbol/line/sha256 ownership.
* Validator: `validateMessageRoutes` in `scripts/parity/validate-matrix.mjs`.
* Historical pre-amendment failure receipts remain in the prior PR history.
  Current results are generated under ignored artifacts and uploaded by CI.

## A-R8-SB07-01: SB-07 exec-parity rejection (R8 §6.3)

### Normative text

> Under `never`, a shell tool call yields a `commandExecution` item with no server request. In a fresh pinned 0.142.3 App Server process with no earlier server requests, the `on-request` escalation probe has request `id:0`. The host sends exactly one same-id JSON-RPC error reply within 5 s: code `-32000`, message ``command execution approval is not supported in exec mode for thread `<threadId>` ``. For this uninterrupted rejection probe, assert the correlated causal sequence `item/commandExecution/requestApproval → host error reply → serverRequest/resolved → item/completed:failed → turn/completed:completed`. Match resolution by process incarnation, threadId and requestId; match item completion by the request's threadId, turnId and itemId, and turn completion by threadId and turn.id. Unrelated notifications may interleave; no missing, duplicate, miscorrelated or reordered required event passes. Request resolution retires the pending request only; it neither completes the command item nor completes the turn.

This replaces the R8 §6.3 order "item `failed` → `turn/completed` →
`serverRequest/resolved`". The pinned binary resolves the request immediately
after the host reply; that order was stable across every DEV-01 run.

### Ownership

* The test harness (`test/harness/jsonl-client.ts`) sends the parity reply and
  records raw line bytes, timestamps and the process incarnation for every
  transcript entry.
* `test/harness/sb07/oracle.ts` is a TEST ONLY transcript oracle, and
  `test/harness/sb07/lifecycle-model.ts` is a TEST ONLY reference lifecycle model.
  The runtime obligations they describe (answer every server request; retire on
  resolution; idempotent duplicate, late and stale-incarnation resolutions;
  release the lane only on turn completion) are **pending DEV-03/04** (HB-B7). The
  host runtime does not implement them yet.

### Unchanged scope

* The `never` half of SB-07, the case ID, the M1 selection and every other SB case.
* The milestone manifest (R8 §10.9 bytes) is unchanged.
