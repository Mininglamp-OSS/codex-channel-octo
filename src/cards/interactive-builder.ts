/** Lossless translation of validated C.1 decisions to the closed v2 wire body. */
import { CARD_ENVELOPE_MAX_BYTES, serializeSendAuthored } from './api.js';
import type { AcInput, AcInteractiveElement, CardRoute, InputKind, InteractiveCardArgs, InteractiveAdaptiveCard, Limits } from './contracts.js';
import { inertText, markdownText } from './display-schema.js';
import { freezeInteractive, interactiveFailure } from './interactive-schema.js';
import { renderInteractivePlain } from './plain.js';

export interface InteractiveCapabilities { readonly inputs: ReadonlySet<InputKind>; readonly limits: Limits }
export function buildInteractiveCard(args: InteractiveCardArgs, options: { readonly caps: InteractiveCapabilities; readonly route: CardRoute }) {
  const { caps, route } = options;
  if (!caps || !caps.limits || Object.values(caps.limits).some(n => !Number.isSafeInteger(n) || n <= 0)
    || (args.inputs ?? []).some(i => !caps.inputs.has(i.kind))) return interactiveFailure('unavailable', '$', 'interactive_capability');
  if ((args.inputs ?? []).some(i => i.kind === 'text' && (i.minLength ?? (i.required ? 1 : 0)) > caps.limits.maxInputTextBytes)) return interactiveFailure('limit_exceeded', '$', 'input_text_bytes');
  const tb = (text: string): AcInteractiveElement => ({ type: 'TextBlock', text: markdownText(text), wrap: true });
  const body: AcInteractiveElement[] = [tb(args.title), ...(route.channelType === 1 ? [] : [tb('For the original requester')]),
    ...(args.text === undefined ? [] : [tb(args.text)]), ...(args.sections ?? []).map(s => tb(s.text))];
  for (const input of args.inputs ?? []) {
    const base = { id: input.id, label: inertText(input.label), isRequired: input.required };
    let control: AcInput;
    switch (input.kind) {
      case 'text': control = { ...base, type: 'Input.Text', ...((input.maxLength ?? 4096) > 0 ? { maxLength: input.maxLength ?? 4096 } : {}) }; break;
      case 'number': control = { ...base, type: 'Input.Number', min: input.min, max: input.max }; break;
      case 'date': control = { ...base, type: 'Input.Date' }; break;
      case 'time': control = { ...base, type: 'Input.Time' }; break;
      case 'toggle': control = { ...base, type: 'Input.Toggle', title: inertText(input.label) }; break;
      case 'choice': control = { ...base, type: 'Input.ChoiceSet', isMultiSelect: input.multiple, style: 'expanded', choices: input.options.map(o => ({ title: inertText(o.label), value: o.id })) }; break;
    }
    // Textual constraints survive viewers which do not expose the associated input metadata.
    const detail = renderInteractivePlain({ title: '', inputs: [input], buttons: [] }).split('\n').slice(1, -1).join('\n');
    // TextBlock is the profile's guaranteed layout lower bound. No unadvertised Container is needed.
    body.push(tb(detail), control);
  }
  const card: InteractiveAdaptiveCard = { type: 'AdaptiveCard', version: '1.5', $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', body,
    actions: args.buttons.map(b => ({ type: 'Action.Submit', id: b.id, title: inertText(b.label), ...(b.data === undefined ? {} : { data: b.data }) })) };
  const plain = renderInteractivePlain(args, route.channelType !== 1);
  // Every source wrapper, option and button is a real cost; no interactive subtree is fitted away.
  const source = 1 + (args.text === undefined ? 0 : 1) + (args.sections?.length ?? 0) + (args.inputs?.length ?? 0) + args.buttons.length
    + (args.inputs ?? []).reduce((n, i) => n + (i.kind === 'choice' ? i.options.length : 0), 0);
  let nodes = args.buttons.length, depth = args.buttons.length ? 1 : 0;
  const walk = (items: readonly AcInteractiveElement[], d: number): void => {
    depth = Math.max(depth, d);
    for (const e of items) {
      nodes++;
      if (e.type === 'Container') walk(e.items, d + 1);
      if (e.type === 'Input.ChoiceSet') { nodes += e.choices.length; depth = Math.max(depth, d + 1); }
    }
  };
  walk(body, 1);
  if (source > 200 || nodes > Math.min(200, caps.limits.maxNodes) || depth > Math.min(12, caps.limits.maxDepth)) return interactiveFailure('limit_exceeded', '$', 'card_structure');
  const authored = { profile: 'octo/v2' as const, card };
  try {
    serializeSendAuthored({ ...authored, route, clientMsgNo: '00000000-0000-0000-0000-000000000000', plain,
      maxEnvelopeBytes: Math.min(CARD_ENVELOPE_MAX_BYTES, caps.limits.maxPayloadBytes) });
  } catch { return interactiveFailure('limit_exceeded', '$', 'wire_bytes'); }
  return freezeInteractive({ ok: true as const, authored, plain });
}
