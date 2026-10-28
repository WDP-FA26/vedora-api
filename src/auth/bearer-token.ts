/** The token of an `Authorization: Bearer <token>` header, or undefined when absent or malformed. */
export function extractBearerToken(
  authorization: string | undefined,
): string | undefined {
  const [type, token] = authorization?.split(' ') ?? [];
  return type?.toLowerCase() === 'bearer' && token ? token : undefined;
}
