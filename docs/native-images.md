# Native outbound images (#95)

Inbound image download, channel-native image delivery, and external `octo-cli`
skills are separate paths. Receiving images does not enable outbound delivery.
External skills need their own installation, credentials and authorization.
This feature uses the configured Bot token directly, does not require octo-cli
and does not add an image generation model.

## Enable and use

In the global or per-bot config:

```json
{
  "sdk": {
    "sandboxMode": "workspace-write",
    "allowWorkspaceWrite": true,
    "outputSelection": "final",
    "nativeImages": { "enabled": true, "maxBytes": 10485760 }
  }
}
```

Restart to apply. Default: disabled. Enabling images does not grant workspace
writes, network access or access to external directories. The existing sandbox
double switch still applies. Compatibility output modes do not offer exports.
`danger-full-access` also permits exports but needs an external isolation boundary.

Ask the bot to generate/send images using its existing generation tool. Every
turn (including resumed sessions) receives a fresh export directory and protocol.
The agent writes/copies the requested images there, then returns ONE bare final
JSON object, without Markdown fences:

```json
{
  "octo_output": 1,
  "requestId": "<host-provided current turn ID>",
  "text": "Here are your images.",
  "artifacts": [
    { "id": "image1", "kind": "image", "path": "image.png", "disposition": "relay" }
  ]
}
```

Only the final selected complete primary run supplies artifacts. Ordinary paths,
Markdown images and URLs never trigger uploads. Destination channel/type come
from the host turn; model output cannot redirect delivery. Operator opt-in grants
exports only from this fresh directory; prompt instructions ask the agent to
export only images requested by the current user. This is an explicit protocol,
not intent detection or an additional execution sandbox.

One image per native message, at most **four per turn**. All selected text goes
first, then images in array order, then a bounded numbered stage report. An
image-only envelope receives a neutral introductory text. Text uses the response
cap; the fixed stage report is additional. Once the report is acknowledged,
history contains the same text and report; the independent stage ledger remains
if an acknowledgment is lost. Per-item failures do not rerun generation or block
other distinct images. Failed/unknown text delivery stops image delivery.

## Authorization and client policy

- Flat filenames relative to this turn's directory only: no nested/absolute
  paths, URLs, hidden/config/credential names, symlinks, hardlinks or special files.
- Before/after scope, inode, link-count, size and timestamp checks; no-follow
  open; bounded reads. Upload uses captured bytes and never reopens the path.
- PNG chunk lengths/CRCs, JPEG markers/SOF dimensions and GIF blocks/dimensions
  are checked against actual bytes and matching extensions. These structural
  checks are not a complete image decoding library.
- Default **10 MiB per file**, configurable integer `maxBytes` **1..50 MiB**.
  Width/height **1..16384**, at most **40 million pixels**. These are conservative
  **client policies, not verified server limits**. A returned presign
  `maxFileSize` is also enforced.
- Export files stay in the session workspace for inspection/reconciliation.
  Existing **seven-day idle session TTL** removes them with the workspace;
  active sessions retain files. Operators may remove completed exports after
  reconciliation. No detached uploads or cleanup jobs are started.

The workspace is a starting directory, not a chroot. These checks protect the
upload path against links/replacements; they cannot prevent an agent with
separately granted filesystem access from copying sensitive pixel data.

## Delivery and external tools

SQLite `image_deliveries` records generation (`ready`/`failed`), upload
(`not_started`/`unknown`/`confirmed`/`failed`) and delivery
(`not_started`/`unknown`/`confirmed`/`external`/`duplicate`) separately by turn/item.
`ready` means an authorized snapshot exists, not successful upload or delivery.
Message intents are marked unknown before the request; only a valid positive
int64 message ID confirms delivery. Revoked/canceled/expired turns cannot start
another step or accept late acknowledgments. In-flight remote writes may already
have happened and remain unknown. The verified API offers no orphan-object
deletion; cancellation does not roll back uploads. No automatic upload/send
retry or model replay occurs.

If an explicit external sending tool delivers an image, the agent must declare
the same local file with `disposition:"external"`, or omit it from relay
artifacts. External delivery is unverified, never channel-confirmed. Its content
hash suppresses relay copies even when declared later in the array. Identical
relay content is sent at most once. Never explicitly send an image and also
declare it as relay. Undeclared independent external sends are not observable;
no scanning of tool output/paths or server deduplication guarantee is implied.
Reentry reads the durable ledger without resending. A new user-authorized turn
must reconcile unknown outcomes before requesting another send.

New diagnostics/ledger never contain Bot tokens, signed URLs, response bodies,
image bytes or content hashes. Reports use fixed stages and numeric positions.

## Contract evidence and remaining manual validation

Reference: openclaw-channel-octo
[`3cdb7e794ba40ae617fb0215177d1493dd26460a`](https://github.com/Mininglamp-OSS/openclaw-channel-octo/tree/3cdb7e794ba40ae617fb0215177d1493dd26460a):
`src/api-fetch.ts` (`getUploadPresign`, `uploadFileToPresignedUrl`,
`sendMediaMessage`), `src/channel.ts` (`sendMedia`), and
`skills/octo-bot-api/SKILL.md` (presign and image examples).

1. GET `/v1/bot/upload/presigned` with filename/fileSize/contentType and Bot bearer.
2. PUT the exact bytes to uploadUrl, echoing contentType and optional
   contentDisposition unchanged, without forwarding the Bot token. Redirects
   are rejected. Public HTTPS storage is required; a localhost API may return
   storage URLs on its exact origin for local deployments/tests.
3. POST `/v1/bot/sendMessage` with original channel ID/type and
   `{type:2,url:downloadUrl,width,height,name,size}`. client_msg_no is local
   correlation only; verified server deduplication is absent.

Unknown: server format whitelist, size limits, dimension requirements/limits,
GIF static/animated preview, actual DM/group/topic frontend preview, server
message deduplication. The reference sends GIF as type=2; this does not prove
animated rendering. No GIF animation guarantee is made.

Mock HTTP tests cover exact bytes/headers, native payloads, ordered multiple
images, partial outcomes, cancellation, deadlines, lost responses, late acks,
external disposition and deduplication. Handler tests cover DM/group text-first
delivery and history. **Real preview acceptance is pending** an independent
test Bot identity and DM/group targets, unavailable to this team. Once supplied,
compare downloaded PNG/JPEG bytes, inspect ordering and record GIF frontend
behavior with the backend/client version.

Team scope decision: #27 remains open with no common implementation at baseline
`5dfde6cfd56621b0fbcf9ec7f310c7caa5135f34`. This PR supplies minimum generic
artifact/snapshot/upload/stage seams needed by #95, not #27's complete file scope.

Rollback: disable sdk.nativeImages and restart, or revert this PR. The additive
SQLite table is ignored by older code; unknown sends still require manual
reconciliation, never automatic replay.
