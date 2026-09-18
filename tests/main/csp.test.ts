import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy } from '../../src/main/csp';

describe('contentSecurityPolicy', () => {
  it('locks a packaged build to self, with inline styles only', () => {
    expect(contentSecurityPolicy(true)).toBe(
      "default-src 'self'; style-src 'self' 'unsafe-inline'",
    );
  });

  it('never allows inline scripts in a packaged build', () => {
    expect(contentSecurityPolicy(true)).not.toContain('script-src');
  });

  it('relaxes dev only for the react-refresh preamble and the localhost HMR socket', () => {
    const dev = contentSecurityPolicy(false);
    expect(dev).toContain("script-src 'self' 'unsafe-inline'");
    expect(dev).toContain('ws://localhost:*');
  });

  it('keeps default-src self in dev, so remote fetches and blob: workers still fail there', () => {
    const dev = contentSecurityPolicy(false);
    expect(dev).toContain("default-src 'self'");
    expect(dev).not.toContain('blob:');
    expect(dev).not.toContain('https:');
  });
});
