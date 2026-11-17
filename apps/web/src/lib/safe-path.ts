/**
 * True for same-site paths only ("/tasks/1?x=y"). Rejects absolute and protocol-relative URLs,
 * including the backslash forms browsers normalise to "//host" ("/\evil.com", "/\/evil.com"),
 * any backslash, and control characters. Used for post-login `next` targets and service-worker
 * navigation messages.
 */
export function isSafeInternalPath(p: unknown): p is string {
  return (
    typeof p === 'string' &&
    p.length <= 2048 &&
    p.startsWith('/') &&
    !p.startsWith('//') &&
    !p.includes('\\') &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(p)
  );
}
