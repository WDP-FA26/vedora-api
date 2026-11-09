export function extractBearerToken(
  authorization: string | undefined,
): string | undefined {
  const [type, token] = authorization?.split(' ') ?? [];
  return type?.toLowerCase() === 'bearer' && token ? token : undefined;
}
