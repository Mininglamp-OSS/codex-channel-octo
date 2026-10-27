/**
 * Card subsystem contracts — type-only leaf.
 *
 * This module exports types and interfaces only; it has no runtime values and
 * imports nothing at runtime. Every authored and wire card body is a closed
 * discriminated shape. The only open JSON value is `ButtonData`, the bounded
 * application data permitted on interactive buttons (C.1).
 *
 * Gateway authoring grammar (C.1, the model-facing tool contract) and wire
 * card bodies (Adaptive Cards 1.5 / Registry template data) are distinct
 * types; builders in later packages translate one into the other.
 */

import type { AgentOutputEvent } from "../agent-bridge.js";

// ─── JSON values ────────────────────────────────────────────────────────────

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;
export interface JsonObject { readonly [key: string]: JsonValue }

// ─── Identity, clocks and routes ────────────────────────────────────────────

/** Normalized API origin key plus an HMAC of the Bot credential; never the raw token. */
export interface BotRef {
  readonly originKey: string;
  readonly credentialRef: string;
}

export interface MonotonicClock { nowMono(): number }
export interface WallClock { nowUtcMs(): number }

/** Octo channel types that may carry cards (DM, Group, CommunityTopic). */
export type CardChannelType = 1 | 2 | 5;

export interface CardRoute {
  readonly channelId: string;
  readonly channelType: CardChannelType;
}

export type RouteKind = "dm" | "group" | "topic";

/** Opaque trusted route reference returned to the model; never a URL or credential. */
export interface SafeRouteRef {
  readonly kind: RouteKind;
  readonly ref: string;
}

// ─── Trusted turn context (§2.2 / §2.4) ─────────────────────────────────────

export interface TrustedTurnContext {
  readonly botRef: BotRef;
  readonly route: Readonly<{ channelId: string; channelType: number; topicScope?: string }>;
  readonly requesterUid: string;
  readonly sessionKey: string;
  readonly turnGeneration: string;
  readonly resetEpoch: number;
  readonly policyIdentity: string;
  readonly runtimeIncarnation: string;
  /** Absent for automatic-only contexts. */
  readonly injectedServerId?: string;
  readonly routeEligibility: Readonly<{ kind: RouteKind; obo: boolean; docTask: boolean; cron: boolean }>;
  readonly origin: Readonly<{ kind: "user" } | { kind: "card_continuation"; admissionId: string }>;
}

/** Trusted internal injection configuration; never part of model tool arguments. */
export interface CardInjection {
  readonly serverId: string;
  readonly generation: string;
  readonly endpoint: Readonly<{ host: "127.0.0.1"; port: number }>;
  readonly authority: string;
  readonly expiresAtMono: number;
}

// ─── Profile, template, capabilities and limits (§3.1 / E.2) ────────────────

export type CapabilityState = "enabled" | "disabled" | "unavailable";
export type CardProfileName = "octo/v1" | "octo/v2";
export type CardVersion = "1.5";
export type ReasoningTemplateId = "ai.reasoning-process";
export type InputKind = "text" | "number" | "date" | "time" | "toggle" | "choice";

export interface TemplateRef {
  readonly id: ReasoningTemplateId;
  readonly version: string;
}

export type RegistryView = "active" | "error" | "result";

export interface ViewSpec {
  readonly view: RegistryView;
  readonly version: string;
  readonly controlFree: true;
}

export interface PinnedTemplate {
  readonly id: ReasoningTemplateId;
  readonly version: string;
  readonly views: Readonly<{ active: ViewSpec; error: ViewSpec; result: ViewSpec }>;
  readonly controlFree: true;
}

export interface Limits {
  readonly maxNodes: number;
  readonly maxDepth: number;
  readonly maxPayloadBytes: number;
  readonly maxInputTextBytes: number;
  readonly maxInputsBytes: number;
}

/** Content-free reason codes for capability state, degradation and evidence. */
export type SafeReasonCode =
  | "profile_404"
  | "profile_unavailable"
  | "profile_malformed"
  | "config_inconsistent"
  | "capability_disabled"
  | "auth_rejected"
  | "template_incompatible"
  | "profile_incompatible"
  | "local_disabled"
  | "policy_revoked"
  | "interaction_unavailable";

/**
 * `GET /v1/bot/card/profile` after structural projection (reference
 * `CardProfileManifest`, `src/api-fetch.ts` getCardProfile). Field presence
 * and types only: permission matrix, template selection, capability and
 * limit negotiation belong to the policy package. Unknown top-level and
 * limit/template extension keys are dropped, never forwarded.
 */
export interface WireTemplateRef {
  readonly id: string;
  readonly version: string;
}

export interface WireTemplateView {
  readonly name: string;
  readonly states: readonly string[];
  readonly wire_profile: string;
  readonly submit_actions: readonly string[];
}

export interface WireTemplate {
  readonly id: string;
  readonly version: string;
  readonly views: readonly WireTemplateView[];
}

export interface WireTemplating {
  readonly supported?: boolean;
  readonly wire?: string;
  readonly templates?: readonly WireTemplate[];
}

/** Effective per-Bot policy; when present it has exactly these typed keys. */
export interface WireCardConfig {
  readonly card_enabled: boolean;
  readonly reasoning_enabled: boolean;
  readonly reasoning_template_ref: WireTemplateRef | null;
  readonly display_enabled: boolean;
  readonly interaction_enabled: boolean;
}

export interface WireProfileLimits {
  readonly max_nodes?: number;
  readonly max_depth?: number;
  readonly max_payload_bytes?: number;
  readonly max_input_text_bytes?: number;
  readonly max_inputs_bytes?: number;
}

export interface CardProfileWire {
  /** Compatibility only; never card-policy authority. */
  readonly available?: boolean;
  /** Compatibility only; never card-policy authority. */
  readonly enabled?: boolean;
  readonly profiles?: readonly string[];
  readonly card_version?: string;
  readonly elements?: readonly string[];
  readonly inputs?: readonly string[];
  readonly actions?: readonly string[];
  readonly limits?: WireProfileLimits;
  readonly templating?: WireTemplating;
  readonly config?: WireCardConfig;
}

export interface PolicySnapshot {
  readonly botRef: BotRef;
  readonly generation: number;
  readonly fetchedAtMono: number;
  /** At most 60 s after `fetchedAtMono`. */
  readonly expiresAtMono: number;
  readonly profileHash: string;
  readonly automatic: Readonly<{ state: CapabilityState; template?: PinnedTemplate; maxPayloadBytes: number }>;
  readonly display: Readonly<{
    state: CapabilityState; profile?: "octo/v1"; cardVersion?: CardVersion;
    elements: ReadonlySet<string>; limits: Limits;
  }>;
  readonly interaction: Readonly<{
    state: CapabilityState; profile?: "octo/v2"; cardVersion?: CardVersion;
    inputs: ReadonlySet<InputKind>; limits: Limits;
  }>;
  readonly reasons: readonly SafeReasonCode[];
}

// ─── Automatic progress events (§3.1) ───────────────────────────────────────

export type SafeCategory = "command" | "file_change" | "web_search" | "tool" | "activity";

declare const safeProgramBrand: unique symbol;
/** Allowlisted program basename produced only by the redaction reducer. */
export type SafeProgram = string & { readonly [safeProgramBrand]: true };

export interface SafeItemFacts {
  readonly category: SafeCategory;
  readonly program?: SafeProgram;
  readonly fileCount?: number;
  readonly domain?: string;
  readonly exitClass?: "ok" | "nonzero" | "unknown";
  /** Only set for an injected-server identity match. */
  readonly mcpServerId?: string;
}

export interface ItemState {
  readonly kind: "item_state";
  readonly attempt: number;
  readonly itemId: string;
  readonly seq: number;
  readonly itemType: "command_execution" | "file_change" | "mcp_tool_call" | "web_search" | "reasoning" | "todo_list";
  readonly phase: "started" | "updated" | "completed";
  readonly status?: "in_progress" | "completed" | "failed";
  readonly safe: SafeItemFacts;
}

export type CardObservableEvent =
  | ItemState
  | Exclude<AgentOutputEvent, { kind: "message" }>
  | { readonly kind: "message_phase"; readonly attempt: number; readonly itemId: string; readonly seq: number; readonly phase?: string };

export type RuntimeErrorCategory = "runtime_failed" | "stream_interrupted" | "sdk_parse_error" | "unknown";

export interface DeliveryReport {
  readonly expected: number;
  readonly acked: number;
  readonly failed: number;
  readonly messageIds: readonly string[];
  readonly emptyNotice: boolean;
}

export type TurnSignal =
  | { readonly t: "bridge"; readonly ev: CardObservableEvent }
  | { readonly t: "delivery_start" }
  | { readonly t: "delivery_report"; readonly report: DeliveryReport }
  | { readonly t: "handler_error"; readonly category: RuntimeErrorCategory }
  | { readonly t: "dispatch_timeout" }
  | { readonly t: "settle" }
  | { readonly t: "shutdown" };

// ─── Explicit-tool results (§3.1 / C.1) ─────────────────────────────────────

export type CardError =
  | "policy_denied" | "unavailable" | "invalid_route" | "validation_failed"
  | "limit_exceeded" | "capacity_full" | "send_unconfirmed";

/** path ≤128 bytes, rule ≤64 bytes; never content or authored key spellings. */
export interface Diag {
  readonly path: string;
  readonly rule: string;
}

export type CardToolResult =
  | { readonly status: "sent"; readonly message_id: string; readonly route: SafeRouteRef; readonly session_id?: string }
  | { readonly status: "degraded"; readonly message_id: string; readonly interaction_available: false; readonly reason: SafeReasonCode }
  | { readonly status: "error"; readonly error: { readonly code: CardError; readonly diagnostics?: readonly Diag[] } };

// ─── Closed authoring grammar (C.1) ─────────────────────────────────────────

export type Id = string;
export type Label = string;

export interface LinkSpec { readonly label: Label; readonly url: string }

export type RichRun =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "emphasis"; readonly text: string }
  | { readonly kind: "strong"; readonly text: string }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "link"; readonly label: Label; readonly url: string };

export type DisplayBlock =
  | { readonly kind: "heading"; readonly text: string; readonly level?: 1 | 2 | 3 }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "rich_text"; readonly runs: readonly RichRun[] }
  | { readonly kind: "facts"; readonly items: readonly { readonly label: Label; readonly value: string }[] }
  | { readonly kind: "columns"; readonly columns: readonly { readonly blocks: readonly DisplayBlock[] }[] }
  | { readonly kind: "table"; readonly headers: readonly Label[]; readonly rows: readonly (readonly string[])[] }
  | { readonly kind: "link"; readonly label: Label; readonly url: string }
  | { readonly kind: "group"; readonly blocks: readonly DisplayBlock[] }
  | { readonly kind: "collapsible"; readonly label: Label; readonly blocks: readonly DisplayBlock[]; readonly expanded?: boolean }
  | { readonly kind: "copy"; readonly label: Label; readonly text: string };

export interface DisplayCardArgs {
  readonly title?: string;
  readonly blocks: readonly DisplayBlock[];
}

export interface Section { readonly text: string }
export interface Option { readonly id: Id; readonly label: Label }

/** Bounded untrusted application data; no routing or control authority. */
export type ButtonData = JsonObject;

export interface ButtonSpec {
  readonly id: Id;
  readonly label: Label;
  readonly data?: ButtonData;
}

export type InputSpec =
  | { readonly id: Id; readonly kind: "text"; readonly label: Label; readonly required: boolean; readonly minLength?: number; readonly maxLength?: number }
  | { readonly id: Id; readonly kind: "number"; readonly label: Label; readonly required: boolean; readonly min: number; readonly max: number }
  | { readonly id: Id; readonly kind: "date"; readonly label: Label; readonly required: boolean; readonly timezone?: string }
  | { readonly id: Id; readonly kind: "time"; readonly label: Label; readonly required: boolean; readonly timezone?: string }
  | { readonly id: Id; readonly kind: "toggle"; readonly label: Label; readonly required: boolean }
  | {
    readonly id: Id; readonly kind: "choice"; readonly label: Label; readonly required: boolean;
    readonly multiple: boolean; readonly min: number; readonly max: number; readonly options: readonly Option[];
  };

export interface InteractiveCardArgs {
  readonly title: string;
  readonly text?: string;
  readonly sections?: readonly Section[];
  readonly inputs?: readonly InputSpec[];
  readonly buttons: readonly ButtonSpec[];
}

export type ToolOpcode = "display" | "interactive";

// ─── Wire card bodies and writes (§3.1 / §5.1) ──────────────────────────────
//
// Source-grounded in the approved reference client
// Mininglamp-OSS/openclaw-channel-octo@2e710e903fa43ac9440723746f7395d2f7b4347e:
// authored cards are Adaptive Cards 1.5 bodies (`src/card-blocks.ts`,
// `src/card-author.ts`, `src/card-action-status.ts`; sent by
// `src/api-fetch.ts` sendCardMessage/editCardMessage), and Registry frames
// carry `ai.reasoning-process` data (`src/reasoning-process.ts`
// ReasoningProcessData; sent by sendTemplateCardMessage/editTemplateCardMessage).
// Only the element and property set those builders emit is representable,
// plus Adaptive Cards 1.5 input properties needed by the C.1 input contract.
// Server acceptance of these bodies is still a P02/P03 live gate.

export type AcSpacing = "None" | "Small" | "Medium";
export type AcContainerStyle = "default" | "good" | "warning" | "attention" | "emphasis";
export type AcTextColor = "default" | "good" | "warning" | "attention" | "accent";

export interface AcOpenUrlAction {
  readonly type: "Action.OpenUrl";
  readonly title: string;
  readonly url: string;
}

export interface AcToggleTarget {
  readonly elementId: string;
  readonly isVisible: boolean;
}

export interface AcToggleVisibilityAction {
  readonly type: "Action.ToggleVisibility";
  readonly title: string;
  readonly targetElements: readonly AcToggleTarget[];
}

export interface AcCopyToClipboardAction {
  readonly type: "Action.CopyToClipboard";
  readonly title: string;
  readonly text: string;
}

/** Local/navigation actions only; they never call back into the Bot. */
export type AcLocalAction = AcOpenUrlAction | AcToggleVisibilityAction | AcCopyToClipboardAction;

export interface AcSubmitAction {
  readonly type: "Action.Submit";
  readonly id: string;
  readonly title: string;
  readonly data?: ButtonData;
  readonly style?: "positive" | "destructive";
}

export interface AcTextBlock {
  readonly type: "TextBlock";
  readonly text: string;
  readonly wrap: true;
  readonly weight?: "Bolder";
  readonly size?: "Medium" | "Large";
  readonly spacing?: AcSpacing;
  readonly separator?: boolean;
  /** Navigation only; a submit action is never a select action. */
  readonly selectAction?: AcOpenUrlAction;
}

export interface AcTextRun {
  readonly type: "TextRun";
  readonly text: string;
  readonly weight?: "Bolder";
  readonly isSubtle?: boolean;
  readonly fontType?: "Default" | "Monospace";
  readonly color?: Exclude<AcTextColor, "default">;
}

export interface AcRichTextBlock {
  readonly type: "RichTextBlock";
  readonly inlines: readonly AcTextRun[];
}

export interface AcFact { readonly title: string; readonly value: string }

export interface AcFactSet {
  readonly type: "FactSet";
  readonly facts: readonly AcFact[];
}

export interface AcActionSet {
  readonly type: "ActionSet";
  readonly id?: string;
  readonly isVisible?: boolean;
  readonly actions: readonly AcLocalAction[];
}

export interface AcChoice { readonly title: string; readonly value: string }

interface AcInputBase {
  readonly id: string;
  readonly label?: string;
  readonly isRequired?: boolean;
}

export type AcInput =
  | (AcInputBase & { readonly type: "Input.Text"; readonly placeholder?: string; readonly maxLength?: number })
  | (AcInputBase & { readonly type: "Input.Number"; readonly placeholder?: string; readonly min?: number; readonly max?: number })
  | (AcInputBase & { readonly type: "Input.Date"; readonly placeholder?: string })
  | (AcInputBase & { readonly type: "Input.Time"; readonly placeholder?: string })
  | (AcInputBase & { readonly type: "Input.Toggle"; readonly title?: string })
  | (AcInputBase & {
    readonly type: "Input.ChoiceSet"; readonly choices: readonly AcChoice[];
    readonly style?: "expanded" | "compact"; readonly isMultiSelect?: boolean;
  });

/**
 * Display elements (profile `octo/v1`); containers recurse over the same
 * closed union, so a display body can never carry an input or submit action.
 */
export type AcDisplayElement =
  | AcTextBlock
  | AcRichTextBlock
  | AcFactSet
  | AcActionSet
  | { readonly type: "Container"; readonly id?: string; readonly isVisible?: boolean;
      readonly style?: Exclude<AcContainerStyle, "default">; readonly spacing?: AcSpacing;
      readonly items: readonly AcDisplayElement[] }
  | { readonly type: "ColumnSet"; readonly columns: readonly {
      readonly type: "Column"; readonly width: "stretch" | "auto"; readonly items: readonly AcDisplayElement[] }[] }
  | { readonly type: "Table"; readonly firstRowAsHeader: boolean; readonly columns: readonly { readonly width: number }[];
      readonly rows: readonly { readonly type: "TableRow"; readonly cells: readonly {
        readonly type: "TableCell"; readonly items: readonly AcDisplayElement[] }[] }[] };

/** Interactive elements (profile `octo/v2`): sections, facts and inputs (`src/card-author.ts`). */
export type AcInteractiveElement =
  | AcTextBlock
  | AcFactSet
  | AcInput
  | { readonly type: "Container"; readonly spacing?: AcSpacing; readonly items: readonly AcInteractiveElement[] };

export type AdaptiveCardVersion = "1.5";
export type AdaptiveCardSchemaUrl = "http://adaptivecards.io/schemas/adaptive-card.json";

export interface DisplayAdaptiveCard {
  readonly type: "AdaptiveCard";
  readonly version: AdaptiveCardVersion;
  readonly $schema: AdaptiveCardSchemaUrl;
  readonly body: readonly AcDisplayElement[];
}

export interface InteractiveAdaptiveCard {
  readonly type: "AdaptiveCard";
  readonly version: AdaptiveCardVersion;
  readonly $schema: AdaptiveCardSchemaUrl;
  readonly body: readonly AcInteractiveElement[];
  /** Absent or empty on control-free status frames. */
  readonly actions?: readonly AcSubmitAction[];
}

/** Authored card body bound to its profile. */
export type AuthoredCard =
  | { readonly profile: "octo/v1"; readonly card: DisplayAdaptiveCard }
  | { readonly profile: "octo/v2"; readonly card: InteractiveAdaptiveCard };

/** Registry wire state: payload `state` and `data.state` (`ReasoningProcessState`). */
export type WireState = "reasoning" | "answering" | "completed" | "stopped" | "error";

export interface RegistryAction {
  readonly tool: string;
  /** May be empty; ≤192 runes per the template data contract. */
  readonly detail: string;
  readonly statusGlyph: string;
  readonly statusTone: "Accent" | "Good" | "Attention";
}

export interface RegistryPhase {
  /** Nonempty; ≤280 Unicode scalars (E.2, no 0.4.0 widening). */
  readonly thought: string;
  /** Nonempty. */
  readonly actions: readonly RegistryAction[];
}

/** `ai.reasoning-process` template data (`ReasoningProcessData`). */
export interface RegistryData {
  readonly reasoningId: string;
  readonly state: WireState;
  readonly title: string;
  readonly statusLabel: string;
  readonly statusTone: "Accent" | "Good" | "Warning" | "Attention";
  readonly timerText: string;
  readonly traceExpanded: boolean;
  readonly traceCollapsed: boolean;
  readonly collapsedSummary: string;
  readonly progressText?: string;
  /** Newest ≤6 phases carrying ≤12 actions in total. */
  readonly phases: readonly RegistryPhase[];
  readonly errorTitle?: string;
  readonly errorMessage?: string;
}

/** Design-level automatic status mapping (E.3); `state` is the wire state. */
export type AutomaticStatus =
  | { readonly view: "active"; readonly state: "reasoning"; readonly reason: "working"; readonly text: "Working" }
  | { readonly view: "active"; readonly state: "answering"; readonly reason: "answering"; readonly text: "Answering" }
  | { readonly view: "result"; readonly state: "completed"; readonly reason: "completed"; readonly text: "Completed" }
  | { readonly view: "error"; readonly state: "error"; readonly reason: "failed"; readonly text: "Failed" }
  | { readonly view: "error"; readonly state: "error"; readonly reason: "interrupted"; readonly text: "Interrupted; needs review" }
  | { readonly view: "error"; readonly state: "error"; readonly reason: "timed_out"; readonly text: "Timed out" }
  | { readonly view: "error"; readonly state: "error"; readonly reason: "expired"; readonly text: "Expired" }
  | { readonly view: "error"; readonly state: "error"; readonly reason: "policy_revoked"; readonly text: "Unavailable by policy" };

/** Serialized `content_edit` envelope fields for an authored edit. */
export type AuthoredContentEdit = AuthoredCard & {
  readonly plain: string;
  readonly card_seq: number;
  readonly transient: boolean;
};

/**
 * Card writes. Minimum normative fields are kept verbatim from §3.1;
 * `route` is the trusted channel binding the transport needs.
 */
export type CardWrite =
  | { readonly k: "registry_send"; readonly route: CardRoute; readonly clientMsgNo: string;
      readonly ref: TemplateRef; readonly state: WireState; readonly data: RegistryData }
  | { readonly k: "registry_edit"; readonly route: CardRoute; readonly messageId: string;
      readonly ref: TemplateRef; readonly state: WireState; readonly data: RegistryData;
      readonly seq: number; readonly transient: boolean }
  | ({ readonly k: "authored_send"; readonly route: CardRoute; readonly clientMsgNo: string; readonly plain: string } & AuthoredCard)
  | { readonly k: "authored_edit"; readonly route: CardRoute; readonly messageId: string; readonly contentEdit: AuthoredContentEdit };

export type WriteOutcome = "acked" | "ambiguous" | "stale" | "contract" | "policy" | "gone" | "retry_exhausted";

// ─── Integration ports (E.1) ────────────────────────────────────────────────

export interface DispatchObserver {
  /** Bound before the handler race; never resolves the latest session turn. */
  onTimeout(dispatchId: string): void;
}

export interface TurnCoordinator {
  observe(event: CardObservableEvent): void;
  signal(event: TurnSignal): void;
  /** Idempotent and enqueue-only. */
  settle(): void;
}

export interface ContinuationTurn {
  readonly admissionId: string;
  readonly sessionKey: string;
  readonly route: TrustedTurnContext["route"];
  readonly requesterUid: string;
}

declare const admissionReservationBrand: unique symbol;
/** Opaque preflight reservation; grants no route or policy authority. */
export interface AdmissionReservation { readonly [admissionReservationBrand]: true }

export type ReservationResult =
  | { readonly accepted: true; readonly reservation: AdmissionReservation }
  | { readonly accepted: false; readonly reason: "rate_limited" | "unsupported_channel" | "closing" };

export interface ContinuationPort {
  preflightContinuation(turn: ContinuationTurn): ReservationResult;
  /** Resolution never supplies completion evidence. */
  dispatchContinuation(turn: ContinuationTurn, reservation: AdmissionReservation): Promise<void>;
}

// ─── Resource-owner shutdown port (§4.5, WP-13A) ────────────────────────────

export type ShutdownReason = "shutdown" | "bot_removed";

export interface ShutdownFence {
  readonly reason: ShutdownReason;
  /** Monotonic deadline of the single aggregate card drain budget for this Bot. */
  readonly deadlineMono: number;
  /** Aborted when the aggregate deadline is reached. */
  readonly signal: AbortSignal;
}

export interface ResourceDrainReport {
  readonly settled: number;
  readonly aborted: number;
  /** Tasks whose transport outcome stays unknown and must be treated as ambiguous. */
  readonly unresolved: number;
}

export interface CardResourceOwner {
  /** Closed resource class identifier, used only for content-free telemetry. */
  readonly kind: "tool_host" | "write_queue" | "event_consumer" | "policy" | "recovery" | "store_lease";
  /** Synchronous: stop intake and fence authority immediately; must not throw. */
  close(fence: ShutdownFence): void;
  /** Settle or abort owned work before `fence.deadlineMono`; never rejects. */
  drain(fence: ShutdownFence): Promise<ResourceDrainReport>;
}

export interface ResourceRegistration {
  unregister(): void;
}

export interface CardResourceRegistry {
  /** Rejected (returns null) once closing has begun. */
  register(owner: CardResourceOwner): ResourceRegistration | null;
}
