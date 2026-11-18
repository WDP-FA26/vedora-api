import { runtimeConfig } from '../../config/runtime-config.js';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const FETCH_TIMEOUT_MS = runtimeConfig.PUBLIC_IMAGE_FETCH_TIMEOUT_MS;
const MAX_IMAGE_BYTES = runtimeConfig.PUBLIC_IMAGE_MAX_MB * 1048576;

export class UnsafeImageUrlError extends Error {}

function isPrivateIPv4Octets(a: number, b: number): boolean {
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

function isPrivateIPv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (
    parts.length !== 4 ||
    parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  ) {
    return true;
  }
  return isPrivateIPv4Octets(parts[0], parts[1]);
}

function isPrivateIPv4Word(hi: number): boolean {
  return isPrivateIPv4Octets((hi >> 8) & 0xff, hi & 0xff);
}

function expandIPv4Tail(bare: string): string | null {
  if (!bare.includes('.')) return bare;
  const lastColon = bare.lastIndexOf(':');
  if (lastColon === -1) return null;
  const ipv4 = bare.slice(lastColon + 1);
  if (isIP(ipv4) !== 4) return null;
  const [a, b, c, d] = ipv4.split('.').map(Number);
  const hi = ((a << 8) | b).toString(16);
  const lo = ((c << 8) | d).toString(16);
  return `${bare.slice(0, lastColon + 1)}${hi}:${lo}`;
}

function parseIPv6Words(address: string): number[] | null {
  const withoutZone = address.split('%')[0]?.toLowerCase() ?? '';
  const expanded = expandIPv4Tail(withoutZone);
  if (!expanded) return null;
  const halves = expanded.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (halves.length === 2 && missing < 1) return null;
  const groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  const words = groups.map((group) =>
    /^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : -1,
  );
  return words.every((w) => w >= 0 && w <= 0xffff) ? words : null;
}

function isPrivateIPv6(address: string): boolean {
  const words = parseIPv6Words(address);
  if (!words) return true;
  const isUnspecified = words.every((w) => w === 0);
  const isLoopback = words.slice(0, 7).every((w) => w === 0) && words[7] === 1;
  if (isUnspecified || isLoopback) return true;
  // ::ffff:0:0/96 (IPv4-mapped) and ::/96 (IPv4-compatible)
  const topZero = words.slice(0, 5).every((w) => w === 0);
  if (topZero && (words[5] === 0xffff || words[5] === 0)) {
    return isPrivateIPv4Word(words[6]);
  }
  // 64:ff9b::/96 (NAT64)
  if (
    words[0] === 0x0064 &&
    words[1] === 0xff9b &&
    words.slice(2, 6).every((w) => w === 0)
  ) {
    return isPrivateIPv4Word(words[6]);
  }
  const first = words[0];
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (first & 0xff00) === 0xff00 // ff00::/8 multicast
  );
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) return isPrivateIPv4(address);
  return isPrivateIPv6(address);
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
