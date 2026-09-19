/**
 * Content-Security-Policy for the renderer (TDD §3). Applied in dev as well
 * as in packaged builds, so a violation (a remote font, a blob: worker, a
 * stray fetch) fails on the developer's machine instead of only in a release.
 *
 * The dev variant relaxes exactly what Vite needs and nothing else: the
 * inline react-refresh preamble, and the HMR socket on localhost.
 */
export function contentSecurityPolicy(packaged: boolean): string {
  const directives = packaged
    ? ["default-src 'self'", "style-src 'self' 'unsafe-inline'"]
    : [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "connect-src 'self' ws://localhost:* http://localhost:*",
      ];
  return directives.join('; ');
}
