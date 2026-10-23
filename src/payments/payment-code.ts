/**
 * Recover complete server-generated codes without removing arbitrary memo text.
 * Only the configured contiguous prefix + exactly 20 hex suffix characters is
 * accepted. Wallet-added ASCII spaces/tabs may separate suffix characters.
 */
export function paymentCodesFromContent(
  content: string | null | undefined,
  prefix: string,
): string[] {
  if (!content || content.length > 4096 || !/^[A-Z][A-Z0-9]{1,4}$/.test(prefix))
    return [];
  const pattern = new RegExp(
    `(?:^|[^A-Z0-9])(${prefix}(?:[ \\t]{0,3}[A-F0-9]){20})(?![A-Z0-9])`,
    'gi',
  );
  const codes = new Set<string>();
  for (const match of content.matchAll(pattern)) {
    // Never accept the first 20 characters of a longer whitespace-split hex ID.
    const following = content
      .slice(match.index + match[0].length)
      .match(/^[ \t]+([A-Z0-9]+)/i)?.[1];
    if (following && /^[A-F0-9]+$/i.test(following)) continue;
    // Uppercase only the ASCII capture: Unicode ligatures must not expand to hex.
    codes.add(match[1].replace(/[ \t]/g, '').toUpperCase());
    if (codes.size > 1) break; // Multiple candidates are rejected, not ranked by amount/status.
  }
  return [...codes];
}
