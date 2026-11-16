import { describe, expect, it } from 'vitest';
import { clientIpHeaders } from './client-ip';

const req = (xff?: string) => new Request('http://x', { headers: xff ? { 'x-forwarded-for': xff } : {} });

describe('clientIpHeaders', () => {
  it('uses the last X-Forwarded-For entry (appended by the ALB), ignoring client-supplied ones', () => {
    expect(clientIpHeaders(req('1.2.3.4, 203.0.113.9'))).toEqual({ 'X-Forwarded-For': '203.0.113.9' });
    expect(clientIpHeaders(req('2001:db8::1'))).toEqual({ 'X-Forwarded-For': '2001:db8::1' });
  });
  it('drops missing or malformed values', () => {
    expect(clientIpHeaders(req())).toEqual({});
    expect(clientIpHeaders(req('1.2.3.4, not-an-ip<script>'))).toEqual({});
    expect(clientIpHeaders(req('1.2.3.4, '))).toEqual({ 'X-Forwarded-For': '1.2.3.4' });
  });
});
