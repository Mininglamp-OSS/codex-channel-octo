import type { BotMessage } from '../octo/types.js';

/** Transport observations only. These do not establish native Header authority. */
export interface ReceivedDelivery {
  readonly recipientUid: string;
  readonly message: Readonly<BotMessage>;
  readonly payloadSha256: string;
}

export type ProcessingDisposition = 'terminal' | 'uncertain';

export type IngressReservation =
  | { disposition: 'reserved'; finish: (state: ProcessingDisposition) => void }
  | { disposition: 'duplicate' }
  | { disposition: 'unavailable' };

/**
 * Trusted host integration point. Resolve/compare the real native delivery
 * identity and durably commit its reservation before returning `reserved`.
 * This is not an admission grant. The handler must still perform Stage 1.
 */
export type ReserveBeforeAck = (delivery: ReceivedDelivery) => IngressReservation | Promise<IngressReservation>;
