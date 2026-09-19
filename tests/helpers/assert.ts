/**
 * `expect(actual).toBe(expected)` for the hot loop of a property test: the
 * failure context — usually a `JSON.stringify` of the generated case — is
 * built only when the check fails, not once per iteration.
 */
export function same<T>(actual: T, expected: T, context: () => unknown): void {
  if (actual === expected) return;
  const detail = context();
  throw new Error(
    `expected ${String(expected)}, got ${String(actual)}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`,
  );
}
