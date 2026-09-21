import type { Config } from './config.js';
import { parentGroupNo } from './channel-id.js';
import { getGroupMembers, getMentionPreference } from './octo/api.js';

const CACHE_TTL_MS = 30_000;
const MAX_CACHED_GROUPS = 512;
const WARNING_INTERVAL_MS = 30_000;

interface GroupDecision {
  effective: boolean;
  members: Set<string>;
  humans: Set<string>;
}

interface CacheEntry {
  value: Promise<GroupDecision>;
  expiresAt: number;
}

/** One cache per router/bot: preferences and member classification never cross credentials. */
export class MentionPreferences {
  private readonly cache = new Map<string, CacheEntry>();
  private nextWarningAt = 0;

  constructor(private readonly config: Pick<Config, 'apiUrl' | 'botToken'>) {}

  invalidate(channelId: string): void {
    this.cache.delete(parentGroupNo(channelId));
  }

  async allows(channelId: string, senderUid: string, allowedBot = false): Promise<boolean> {
    const groupNo = parentGroupNo(channelId);
    if (!groupNo || !senderUid) return false;
    let entry = this.cache.get(groupNo);
    if (!entry || entry.expiresAt <= Date.now()) {
      this.cache.delete(groupNo);
      const fresh: CacheEntry = { value: this.load(groupNo), expiresAt: Infinity };
      entry = fresh;
      this.cache.set(groupNo, fresh);
      void fresh.value.then(() => {
        fresh.expiresAt = Date.now() + CACHE_TTL_MS;
      });
      if (this.cache.size > MAX_CACHED_GROUPS) {
        this.cache.delete(this.cache.keys().next().value!);
      }
    }
    const decision = await entry.value;
    // An update event (or eviction) during the request must not resurrect stale permission.
    if (this.cache.get(groupNo) !== entry) return false;
    return decision.effective && (allowedBot
      ? decision.members.has(senderUid)
      : decision.humans.has(senderUid));
  }

  private async load(groupNo: string): Promise<GroupDecision> {
    const denied: GroupDecision = { effective: false, members: new Set(), humans: new Set() };
    let stage = 'preference';
    try {
      const params = { apiUrl: this.config.apiUrl, botToken: this.config.botToken, groupNo };
      if (!await getMentionPreference(params)) return denied;
      stage = 'member roster';
      const members = await getGroupMembers({ ...params, signal: AbortSignal.timeout(5000) });
      const ids = new Set<string>();
      const humans = new Set<string>();
      const unconfirmed = new Set<string>();
      for (const member of members) {
        if (!member || typeof member.uid !== 'string' || !member.uid) continue;
        ids.add(member.uid);
        // Missing/malformed flags are unknown, never proof of a human. Conflicting
        // duplicate rows must not turn a robot into a human either.
        const robot: unknown = member.robot;
        if (robot === 0 || robot === false) humans.add(member.uid);
        else unconfirmed.add(member.uid);
      }
      for (const uid of unconfirmed) humans.delete(uid);
      if (ids.size === 0) {
        this.warn('member roster is empty or malformed; requiring @. Check the server response');
        return denied;
      }
      if (humans.size === 0) {
        this.warn('member roster has no confirmed humans; requiring @ for human messages. Check the server robot flags');
      }
      return { effective: true, members: ids, humans };
    } catch {
      // Errors (including timeout, missing endpoint, and bad JSON) keep the @ gate.
      // Cache the failure briefly so every message does not retry a broken endpoint.
      // Throttle across groups and invalidations, per bot. Never log the raw
      // error: server responses can echo credentials or other private data.
      this.warn(`${stage} lookup failed; requiring @. Check the bot's API endpoint, authentication, and server response`);
      return denied;
    }
  }

  private warn(reason: string): void {
    const now = Date.now();
    if (now < this.nextWarningAt) return;
    this.nextWarningAt = now + WARNING_INTERVAL_MS;
    // Callers supply fixed diagnostic text only, never payloads or errors.
    console.warn(`[codex-channel-octo] Mention ${reason}.`);
  }
}
