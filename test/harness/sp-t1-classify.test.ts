/** Negative controls for the SP-T1 classifier (R8 §6.4): no ambiguous outcome passes. */
import { describe, it, expect } from 'vitest';
import { classifySpT1, type StageResult } from '../real-binary/sp-t1-classify.js';

const yes: StageResult = { advertised: true, called: true, toolOutputSeen: true };
const lost: StageResult = { advertised: false, called: false, toolOutputSeen: false };
const base = { turn1: yes, afterResume: yes, afterRespawn: yes, registrationPaths: [] as string[], reRegistration: null };

describe('SP-T1 classification', () => {
  it('SPT1-CL-01: A only when callable at every stage without re-registration', () => {
    expect(classifySpT1(base).outcome).toBe('A');
    expect(classifySpT1({ ...base, afterRespawn: { ...yes, toolOutputSeen: false } }).outcome).not.toBe('A');
  });
  it('SPT1-CL-02: C when not callable on turn 1', () => {
    expect(classifySpT1({ ...base, turn1: { ...yes, called: false } }).outcome).toBe('C');
  });
  it('SPT1-CL-03: C when lost after resume and the schema exposes no registration path', () => {
    expect(classifySpT1({ ...base, afterResume: lost })).toMatchObject({ outcome: 'C' });
  });
  it('SPT1-CL-04: B only when a schema path exists and the executed re-registration restores the tool', () => {
    const r = { ...base, afterRespawn: lost, registrationPaths: ['thread/resume'] };
    expect(classifySpT1({ ...r, reRegistration: { method: 'thread/resume', afterReRegistration: yes } }).outcome).toBe('B');
    expect(classifySpT1({ ...r, reRegistration: { method: 'thread/resume', afterReRegistration: lost } }).outcome).toBe('C');
  });
  it('SPT1-CL-05: an unprobed registration path is unclassified (never silently A/B/C)', () => {
    expect(classifySpT1({ ...base, afterResume: lost, registrationPaths: ['thread/resume'], reRegistration: null }).outcome).toBe('unclassified');
  });
});
