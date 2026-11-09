import { object } from './control-client.js';
import type { PrivateControl } from './context-manifest.js';

/** One owned renewal at a time. Failure fences local continuations immediately;
 * draining it before close prevents a late renewal from reviving a closed turn. */
export class TurnLease {
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: Promise<void>;
  private stopped = false;
  private failure?: unknown;
  constructor(private readonly control: PrivateControl, private readonly binding: {
    capsuleId: string; generation: string; ingressId: string;
  }, private readonly controller: AbortController, private readonly intervalMs = 30000) {
    if (!Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 30000) throw new Error('Lease interval unavailable');
    this.schedule();
  }
  assertCurrent(): void {
    if (this.failure) throw this.failure;
    this.controller.signal.throwIfAborted();
  }
  private schedule(): void {
    this.timer = setTimeout(() => {
      this.pending = this.renew();
      // renew handles its rejection; keep its completion for shutdown.
    }, this.intervalMs);
    this.timer.unref();
  }
  private async renew(): Promise<void> {
    if (this.stopped || this.controller.signal.aborted) return;
    try {
      const reply = object(await this.control.call('renew', { capsule_id: this.binding.capsuleId,
        generation: this.binding.generation, ingress_id: this.binding.ingressId }), ['lease_expires_at']);
      const expires = reply.lease_expires_at;
      if (typeof expires !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(expires)
        || !Number.isFinite(Date.parse(expires)) || Date.parse(expires) <= Date.now()) throw new Error('Lease renewal unavailable');
      if (!this.stopped) this.schedule();
    } catch (error) {
      this.failure = error;
      this.controller.abort(error);
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.pending;
  }
}
