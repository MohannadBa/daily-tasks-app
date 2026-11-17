import { describe, expect, it } from 'vitest';
import { clientIpHeaders, proxyHops } from './client-ip';

const req = (xff?: string) => new Request('http://x', { headers: xff ? { 'x-forwarded-for': xff } : {} });

describe('clientIpHeaders', () => {
  it('uses the last X-Forwarded-For entry (appended by the ALB), ignoring client-supplied ones', () => {
    expect(clientIpHeaders(req('1.2.3.4, 203.0.113.9'))).toEqual({ 'X-Forwarded-For': '203.0.113.9' });
    expect(clientIpHeaders(req('2001:db8::1'))).toEqual({ 'X-Forwarded-For': '2001:db8::1' });
  });
  it('behind CloudFront (2 hops): the viewer is the second-to-last entry; spoofed entries are ignored', () => {
    expect(clientIpHeaders(req('6.6.6.6, 198.51.100.7, 10.0.3.25'), 2)).toEqual({ 'X-Forwarded-For': '198.51.100.7' });
    expect(clientIpHeaders(req('198.51.100.7, 10.0.3.25'), 2)).toEqual({ 'X-Forwarded-For': '198.51.100.7' });
    // Fewer entries than trusted hops: forward nothing rather than a client-controlled value.
    expect(clientIpHeaders(req('10.0.3.25'), 2)).toEqual({});
  });
  it('reads the hop count from CLIENT_IP_PROXY_HOPS (1–3, default 1)', () => {
    expect(proxyHops(undefined)).toBe(1);
    expect(proxyHops('2')).toBe(2);
    expect(proxyHops('0')).toBe(1);
    expect(proxyHops('9')).toBe(1);
    expect(proxyHops('abc')).toBe(1);
  });
  it('drops missing or malformed values', () => {
    expect(clientIpHeaders(req())).toEqual({});
    expect(clientIpHeaders(req('1.2.3.4, not-an-ip<script>'))).toEqual({});
    expect(clientIpHeaders(req('1.2.3.4, '))).toEqual({ 'X-Forwarded-For': '1.2.3.4' });
  });
});
