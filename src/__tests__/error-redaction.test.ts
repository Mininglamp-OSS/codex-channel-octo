import { describe, expect, it } from 'vitest';
import { redactErrorText } from '../error-redaction.js';
import { summarizeAgentError } from '../agent-errors.js';
import { snapshotError } from '../error-details.js';
import { classifyFailure, failureReply, TurnFailure } from '../agent-failure.js';

describe('best-effort credential masking with visible failure causes',()=>{
  it.each([
    'Authorization: Bearer SYNTHETIC_CREDENTIAL',
    'Proxy-Authorization: Basic SYNTHETIC_CREDENTIAL',
    'failed using Bearer SYNTHETIC_CREDENTIAL',
    'Cookie: sid=SYNTHETIC_CREDENTIAL; session=OTHER_CREDENTIAL',
    'Set-Cookie: sid=SYNTHETIC_CREDENTIAL; HttpOnly',
    '{"api_key":"SYNTHETIC_CREDENTIAL","status":503}',
    "{'client_secret':'SYNTHETIC_CREDENTIAL'}",
    'access_token=SYNTHETIC_CREDENTIAL&status=503',
    'refreshToken=SYNTHETIC_CREDENTIAL',
    'password = "SYNTHETIC_CREDENTIAL with spaces"',
    'https://user:SYNTHETIC_CREDENTIAL@provider.example/v1?token=OTHER_CREDENTIAL&status=503',
    '-----BEGIN RSA PRIVATE KEY-----\nSYNTHETIC_CREDENTIAL\n-----END RSA PRIVATE KEY-----',
    '-----BEGIN PRIVATE KEY-----\nSYNTHETIC_CREDENTIAL',
    'token="SYNTHETIC_CREDENTIAL',
  ])('masks supplied credential forms: %s',value=>{
    const result=redactErrorText(`503 provider unavailable\n${value}\n at handler.ts:42`);
    expect(result).not.toContain('SYNTHETIC_CREDENTIAL');expect(result).not.toContain('OTHER_CREDENTIAL');
    expect(result).toContain('503 provider unavailable');expect(result).toContain('[REDACTED]');
    expect(redactErrorText(result)).toBe(result);
  });
  it('keeps ordinary reasons, URLs, status and stack locations unchanged',()=>{
    const text='503 service unavailable; ECONNREFUSED\nhttps://provider.example/v1?retry=2\n at handler.ts:42';
    expect(redactErrorText(text)).toBe(text);
  });
  it('masks nested structured credentials without traversing their values',()=>{
    const error={message:'provider failed',cause:{apiKey:{nested:'SYNTHETIC_CREDENTIAL'},password:12345},cookie:'OTHER_CREDENTIAL'};
    const details=snapshotError(error);
    expect(details.details).toContain('[REDACTED]');expect(details.details).not.toMatch(/SYNTHETIC_CREDENTIAL|OTHER_CREDENTIAL|12345/);
  });
  it('continues retaining diagnostic fields after masking a credential',()=>{
    const detail=snapshotError({message:'provider failed',api_key:'SYNTHETIC_CREDENTIAL',after:'diagnostic tail'});
    expect(detail.details).toContain('diagnostic tail');expect(detail.details).not.toContain('SYNTHETIC_CREDENTIAL');
    expect(redactErrorText('Authorization: Bearer SYNTHETIC_CREDENTIAL')).toBe('Authorization: Bearer [REDACTED]');
    expect(redactErrorText('{"Authorization":"Bearer SYNTHETIC_CREDENTIAL","status":503}')).toBe('{"Authorization":"[REDACTED]","status":503}');
  });
  it('masks a long URL credential before copying a wrapper for diagnostic logging',()=>{
    const credential='SYNTHETIC_CREDENTIAL'.repeat(1000);
    const final=classifyFailure(new Error('unknown'));
    const text=summarizeAgentError(new TurnFailure({diagnosticId:'wrapper-mask-test',attempts:1,decision:'blocked_uncertain',executionRisk:'unknown',first:final,final,
      finalError:{message:`503 https://user:${credential}@provider.example/v1`,details:'at handler.ts:42'}}));
    expect(text).not.toContain('SYNTHETIC_CREDENTIAL');expect(text).toContain('provider.example/v1');expect(text).toContain('wrapper-mask-test');
  });
  it('masks before truncation and handles reports not produced by snapshotError',()=>{
    const secret='SYNTHETIC_CREDENTIAL'.repeat(1000);
    const original={message:`503 token=${secret}`,details:`stderr: -----BEGIN PRIVATE KEY-----\n${secret}`};
    const final=classifyFailure(new Error('unknown'));
    const reply=failureReply({diagnosticId:'masking-test',attempts:1,decision:'blocked_uncertain',executionRisk:'unknown',first:final,final,
      originalError:original,finalError:original});
    expect(reply).not.toContain('SYNTHETIC_CREDENTIAL');expect(reply).toContain('503');expect(reply).toContain('masking-test');
    expect(Array.from(reply).length).toBeLessThanOrEqual(4500);
    const captured=snapshotError(original);
    expect(captured.message).toBe('503 token=[REDACTED]');expect(captured.details).not.toContain('SYNTHETIC_CREDENTIAL');
  });
});
