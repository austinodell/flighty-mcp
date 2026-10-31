/** Fail closed: only an exact configured owner email may finish Access login or call /mcp. */
export function normalizeEmail(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

export function ownerAllowed(email: string | null | undefined, allowed: string | null | undefined): boolean {
  const want = normalizeEmail(allowed);
  const got = normalizeEmail(email);
  return want.length > 0 && got === want;
}
