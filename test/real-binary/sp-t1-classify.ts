/** R8 §6.4 SP-T1 outcome classification (exact A/B/C; anything else is unclassified). */
export interface StageResult { advertised: boolean; called: boolean; toolOutputSeen: boolean }
export interface SpT1Observations {
  turn1: StageResult; afterResume: StageResult; afterRespawn: StageResult;
  /** Requests other than thread/start whose pinned schema params accept dynamicTools. */
  registrationPaths: string[];
  /** Present only when the re-registration probe was executed. */
  reRegistration: { method: string; afterReRegistration: StageResult } | null;
}

export const callable = (s: StageResult): boolean => s.advertised && s.called && s.toolOutputSeen;

export function classifySpT1(o: SpT1Observations): { outcome: 'A' | 'B' | 'C' | 'unclassified'; basis: string } {
  if (callable(o.turn1) && callable(o.afterResume) && callable(o.afterRespawn)) {
    return { outcome: 'A', basis: 'callable on turn 1, after thread/resume{config:{}} and after respawn + resume without re-registration' };
  }
  if (!callable(o.turn1)) return { outcome: 'C', basis: 'not callable on turn 1' };
  if (o.registrationPaths.length === 0) {
    return { outcome: 'C', basis: 'lost after resume/respawn and the pinned schema exposes no request other than thread/start accepting dynamicTools' };
  }
  if (!o.reRegistration) return { outcome: 'unclassified', basis: 'a schema registration path exists but the re-registration probe did not run' };
  if (callable(o.reRegistration.afterReRegistration)) {
    return { outcome: 'B', basis: `lost after resume/respawn; re-registration via ${o.reRegistration.method} restored the tool` };
  }
  return { outcome: 'C', basis: `lost after resume/respawn; re-registration via ${o.reRegistration.method} did not restore the tool` };
}
