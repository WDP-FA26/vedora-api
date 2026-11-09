import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const FETCH_TIMEOUT_MS = 10_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export class UnsafeImageUrlError extends Error {}

function isPrivateIPv4(address: string): boolean {
  const [a = 0, b = 0] = address.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) return isPrivateIPv4(address);
  const lower = address.toLowerCase();
  if (lower.startsWith('::ffff:')) return isPrivateIPv4(lower.slice(7));
  return (
    lower === '::' ||
    lower === '::1' ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower.startsWith('fe8') ||
    lower.startsWith('fe9') ||
    lower.startsWith('fea') ||
    lower.startsWith('feb')
  );
}

export async function fetchPublicImage(rawUrl: string): Promise<Buffer | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeImageUrlError(`Not a URL: ${rawUrl}`);
  }
  if (url.protocol !== 'https:') {
    throw new UnsafeImageUrlError('Only https image URLs are fetched');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses =
    isIP(host) === 0
      ? await lookup(host, { all: true })
      : [{ address: host, family: isIP(host) }];
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => isPrivateAddress(address))
  ) {
    throw new UnsafeImageUrlError('Image host is not public');
  }

  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (response.status >= 400 && response.status < 500) return null;
  if (!response.ok) throw new Error(`Image fetch answered ${response.status}`);
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_IMAGE_BYTES) {
    throw new UnsafeImageUrlError('Image is too large');
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new UnsafeImageUrlError('Image is too large');
  }
  return bytes;
}
