import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, resolveBotConfigs, type Config, type BotOverride } from '../config.js';
import { watchConfig } from '../config-watcher.js';

const DEFAULTS = { disable: false, eventTransport: 'off', reasoningSummary: 'off' } as const;
const KEYS = ['cardProgress', 'reasoningCardTemplateMode', 'cardDisplay', 'cardInteraction',
  'OCTO_CARD_MESSAGE_ENABLED', 'OCTO_CARD_MERGE_FINAL'] as const;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cards-config-'));
  vi.stubEnv('OCTO_CARD_MESSAGE_ENABLED', undefined);
  vi.stubEnv('OCTO_CARD_MERGE_FINAL', undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function write(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
function globalConfig(extra: Record<string, unknown> = {}): string {
  const path = join(dir, 'config.json');
  write(path, { apiUrl: 'https://octo.example', bots: [{ id: 'a', botToken: 'token-a' }], ...extra });
  return path;
}
function perBot(extra: Record<string, unknown>, id = 'a'): void {
  write(join(dir, id, 'config.json'), extra);
}
function boot(extra: Record<string, unknown> = {}): Config[] {
  return resolveBotConfigs(loadConfig(globalConfig(extra)));
}

describe('canonical cards configuration', () => {
  it('canonical types require exact booleans/enums and expose readonly snapshots', () => {
    expectTypeOf<Config['cards']>().toEqualTypeOf<Readonly<{
      disable: boolean;
      eventTransport: 'off' | 'short' | 'long';
      reasoningSummary: 'off' | 'on' | 'stream';
    }>>();
    expectTypeOf<BotOverride['cards']>().toEqualTypeOf<Partial<{
      disable: boolean;
      eventTransport: 'off' | 'short' | 'long';
      reasoningSummary: 'off' | 'on' | 'stream';
    }> | undefined>();
    const typeOnly = (cfg: Config, bot: BotOverride): void => {
      // @ts-expect-error Snapshot fields cannot be mutated by typed consumers.
      cfg.cards.disable = false;
      // @ts-expect-error The snapshot reference is readonly too.
      cfg.cards = DEFAULTS;
      // @ts-expect-error No boolean coercion at the canonical input boundary.
      bot.cards = { disable: 'true' };
      // @ts-expect-error Only the closed transport enum is accepted.
      bot.cards = { eventTransport: 'websocket' };
      // @ts-expect-error Only the closed summary enum is accepted.
      bot.cards = { reasoningSummary: true };
      // @ts-expect-error Capability-granting fields are not part of this config.
      bot.cards = { enabled: true };
    };
    expectTypeOf(typeOnly).returns.toBeVoid();
  });

  it('absent subtree, empty object and single-bot configuration use exactly the safe defaults', () => {
    for (const extra of [{}, { cards: {} }, { botToken: 'legacy-token', bots: [] }]) {
      const path = globalConfig(extra);
      expect(loadConfig(path).cards).toEqual(DEFAULTS);
      expect(resolveBotConfigs(loadConfig(path))[0].cards).toEqual(DEFAULTS);
    }
  });

  const valid = [
    { disable: false }, { disable: true },
    ...['off', 'short', 'long'].map(eventTransport => ({ eventTransport })),
    ...['off', 'on', 'stream'].map(reasoningSummary => ({ reasoningSummary })),
  ];
  for (const layer of ['global', 'inline', 'file'] as const) {
    it.each(valid)(`accepts each valid boolean/enum at ${layer}: %j`, cards => {
      if (layer === 'file') perBot({ cards });
      const extra = layer === 'global' ? { cards }
        : layer === 'inline' ? { bots: [{ id: 'a', botToken: 'token-a', cards }] } : {};
      expect(boot(extra)[0].cards).toEqual({ ...DEFAULTS, ...cards });
    });
  }

  const partials = [
    {}, { disable: true }, { eventTransport: 'long' }, { reasoningSummary: 'stream' },
    { disable: false, eventTransport: 'short', reasoningSummary: 'on' },
  ];
  for (const global of partials) for (const inline of partials) for (const file of partials) {
    it(`merges explicit fields only: ${JSON.stringify([global, inline, file])}`, () => {
      perBot({ cards: file });
      const [a, b] = boot({ cards: global, bots: [
        { id: 'a', botToken: 'token-a', cards: inline }, { id: 'b', botToken: 'token-b' },
      ] });
      expect(a.cards).toEqual({ ...DEFAULTS, ...global, ...inline, ...file });
      expect(b.cards).toEqual({ ...DEFAULTS, ...global });
      expect(a.cards).not.toBe(b.cards);
    });
  }

  const invalid = [
    null, [], [true], true, false, 0, 'off',
    ...[null, 0, 1, 'true', 'false', [], {}].map(disable => ({ disable })),
    ...[null, true, 0, 'ON', 'Short', '', [], {}].map(eventTransport => ({ eventTransport })),
    ...[null, true, 0, 'ON', 'short', '', [], {}].map(reasoningSummary => ({ reasoningSummary })),
    { unknown: 'PRIVATE-VALUE' }, { _comment: 'PRIVATE-VALUE' },
    { cardProgress: true }, { cardDisplay: true }, { cardInteraction: true },
    { reasoningCardTemplateMode: 'on' }, { OCTO_CARD_MESSAGE_ENABLED: true },
    { OCTO_CARD_MERGE_FINAL: true }, JSON.parse('{"__proto__":{"disable":false}}') as unknown,
  ];
  for (const layer of ['global', 'inline', 'file'] as const) {
    it.each(invalid)(`rejects invalid ${layer} forms without coercion or content: %j`, cards => {
      if (layer === 'file') perBot({ cards });
      const extra = layer === 'global' ? { cards }
        : layer === 'inline' ? { bots: [{ id: 'a', botToken: 'token-a', cards }] } : {};
      expect(() => boot(extra)).toThrow(/^Invalid cards configuration: (expected object|unknown field|disable must be boolean|eventTransport must be off, short or long|reasoningSummary must be off, on or stream)$/);
    });
  }

  it('invalid lower layers fail even when a higher layer replaces every field', () => {
    perBot({ cards: DEFAULTS });
    expect(() => boot({ cards: { disable: 'PRIVATE-VALUE' } })).toThrow('disable must be boolean');
    expect(() => boot({ bots: [{ id: 'a', botToken: 'token-a', cards: null }] })).toThrow('expected object');
  });

  it('invalid per-bot configuration fails the whole initial resolution', () => {
    perBot({ cards: { eventTransport: 'PRIVATE-VALUE' } }, 'b');
    expect(() => boot({ bots: [
      { id: 'a', botToken: 'token-a' }, { id: 'b', botToken: 'token-b' },
    ] })).toThrow('eventTransport must be off, short or long');
  });

  it('invalid default per-bot cards also fail in the zero-bot idle path', () => {
    perBot({ cards: null }, 'default');
    expect(() => boot({ bots: [] })).toThrow('expected object');
  });

  it('diagnostics never include attacker-controlled keys, values, ids, tokens or paths', () => {
    perBot({ botToken: 'SECRET-TOKEN', cards: { ['SECRET-KEY'.repeat(1000)]: 'SECRET-VALUE' } }, 'SECRET-ID');
    try {
      boot({ bots: [{ id: 'SECRET-ID' }] });
      expect.fail('invalid configuration was accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Invalid cards configuration: unknown field');
    }
  });

  it('server/profile assumptions and deprecated flags convey no configuration authority', () => {
    const ignored = Object.fromEntries(KEYS.map(key => [key, true]));
    vi.stubEnv('OCTO_CARD_MESSAGE_ENABLED', 'true');
    vi.stubEnv('OCTO_CARD_MERGE_FINAL', 'true');
    perBot({ ...ignored, card_enabled: true, profile: { enabled: true } });
    const [bot] = boot({ ...ignored, cards: { disable: true },
      card_enabled: true, profile: { enabled: true } });
    expect(bot.cards).toEqual({ ...DEFAULTS, disable: true });
    expect(Object.keys(bot.cards)).toEqual(['disable', 'eventTransport', 'reasoningSummary']);
    expect(boot({ ...ignored })[0].cards).toEqual(DEFAULTS);
    // Modes are preferences only: no policy, route or permission fields are created.
    expect(boot({ cards: { eventTransport: 'long', reasoningSummary: 'stream' } })[0].cards)
      .toEqual({ disable: false, eventTransport: 'long', reasoningSummary: 'stream' });
  });

  it('ignored names preserve unrelated sdk.env and produce at most one fixed warning per key', async () => {
    vi.resetModules();
    const fresh = await import('../config.js');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ignored = Object.fromEntries(KEYS.map(key => [key, 'SECRET-VALUE'.repeat(1000)]));
    vi.stubEnv('OCTO_CARD_MESSAGE_ENABLED', 'SECRET-ENV');
    vi.stubEnv('OCTO_CARD_MERGE_FINAL', 'SECRET-ENV');
    perBot({ ...ignored });
    const path = globalConfig({ ...ignored, bots: [{ id: 'a', botToken: 'token-a', ...ignored }],
      sdk: { env: { OCTO_CARD_MESSAGE_ENABLED: 'keep-child-env', CUSTOM: 'keep-custom' } } });
    for (let i = 0; i < 3; i++) {
      const [bot] = fresh.resolveBotConfigs(fresh.loadConfig(path));
      expect(bot.cards).toEqual(DEFAULTS);
      expect(bot.sdk.env).toEqual({ OCTO_CARD_MESSAGE_ENABLED: 'keep-child-env', CUSTOM: 'keep-custom' });
    }
    expect(warn.mock.calls).toHaveLength(KEYS.length);
    expect(new Set(warn.mock.calls.map(call => call[0]))).toEqual(new Set(KEYS.map(key =>
      `[codex-channel-octo] WARNING: ignored deprecated card setting ${key}`)));
    expect(warn.mock.calls.every(call => call.length === 1 && String(call[0]).length < 110)).toBe(true);
  });

  it.each(['OCTO_CARD_MESSAGE_ENABLED', 'OCTO_CARD_MERGE_FINAL'])('warns for environment-only %s without copying its value', async key => {
    vi.resetModules();
    const fresh = await import('../config.js');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv(key, 'SECRET-ENV');
    for (let i = 0; i < 3; i++) expect(fresh.loadConfig(globalConfig()).cards).toEqual(DEFAULTS);
    expect(warn.mock.calls).toEqual([[`[codex-channel-octo] WARNING: ignored deprecated card setting ${key}`]]);
  });

  it('takes independent frozen startup snapshots, then reads fresh values on reconstruction', () => {
    const path = globalConfig({ cards: { disable: true } });
    const source = loadConfig(path);
    const [running] = resolveBotConfigs(source);
    expect(Object.isFrozen(running.cards)).toBe(true);
    expect(running.cards).not.toBe(source.cards);
    expect(Reflect.set(running.cards, 'disable', false)).toBe(false);
    expect(Reflect.set(running.cards, 'eventTransport', 'long')).toBe(false);
    const inline = { id: 'a', botToken: 'token-a', cards: { eventTransport: 'short' } };
    const [inlineSnapshot] = resolveBotConfigs({ ...source, bots: [inline as BotOverride] });
    inline.cards.eventTransport = 'long';
    expect(inlineSnapshot.cards.eventTransport).toBe('short');
    write(path, { apiUrl: 'https://octo.example', bots: [{ id: 'a', botToken: 'token-a' }],
      cards: { disable: false, eventTransport: 'long', reasoningSummary: 'stream' } });
    perBot({ cards: { eventTransport: 'short' } });
    expect(running.cards).toEqual({ ...DEFAULTS, disable: true });
    const [restarted] = resolveBotConfigs(loadConfig(path));
    expect(restarted.cards).toEqual({ disable: false, eventTransport: 'short', reasoningSummary: 'stream' });
    expect(restarted.cards).not.toBe(running.cards);
  });

  it('same-ID watcher keeps the startup snapshot; remove/re-add obtains a new snapshot', async () => {
    let desired = { apiUrl: 'https://octo.example', bots: [{ id: 'a', botToken: 'token-a' }],
      cards: { disable: true, eventTransport: 'off', reasoningSummary: 'off' } };
    const path = globalConfig(desired);
    const running = new Map(resolveBotConfigs(loadConfig(path)).map(cfg => [cfg.botId!, cfg]));
    const old = running.get('a')!;
    const added = vi.fn(async (id: string) => {
      running.set(id, resolveBotConfigs(loadConfig(path)).find(cfg => cfg.botId === id)!);
    });
    const removed = vi.fn(async (id: string) => { running.delete(id); });
    const logs: string[] = [];
    const watcher = watchConfig({ configPath: path,
      manager: { runningKeys: () => [...running.keys()], addBot: added, removeBot: removed },
      loadDesired: () => resolveBotConfigs(loadConfig(path)).map(cfg => cfg.botId!),
      log: msg => logs.push(msg),
    });
    try {
      desired = { ...desired, cards: { disable: false, eventTransport: 'long', reasoningSummary: 'stream' } };
      write(path, desired);
      await watcher.applyNow();
      expect(added).not.toHaveBeenCalled();
      expect(removed).not.toHaveBeenCalled();
      expect(running.get('a')).toBe(old);
      expect(old.cards).toEqual({ ...DEFAULTS, disable: true });
      write(path, { ...desired, cards: { disable: 'SECRET-VALUE' }, bots: [] });
      await watcher.applyNow();
      expect(running.get('a')).toBe(old);
      expect(logs).toEqual(['[hot-reload] config invalid, keeping current bots: Invalid cards configuration: disable must be boolean']);
      write(path, { ...desired, bots: [] });
      await watcher.applyNow();
      expect(removed).toHaveBeenCalledExactlyOnceWith('a');
      write(path, desired);
      await watcher.applyNow();
      expect(added).toHaveBeenCalledExactlyOnceWith('a');
      expect(running.get('a')).not.toBe(old);
      expect(running.get('a')!.cards).toEqual(desired.cards);
      expect(old.cards).toEqual({ ...DEFAULTS, disable: true });
    } finally {
      watcher.close();
    }
  });
});
