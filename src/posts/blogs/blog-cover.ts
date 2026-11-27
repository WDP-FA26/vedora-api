import { runtimeConfig } from '../../config/runtime-config.js';
export const MAX_COVER_URL_LENGTH = runtimeConfig.BLOG_COVER_URL_MAX_LENGTH;

const MEDIA_LINE = /^!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)\s*$/gm;

export function isVideoUrl(url: string): boolean {
  return /\/video\/upload\//.test(url) || /\.(mp4|webm|mov)(\?|#|$)/i.test(url);
}

export function coverFromContent(
  content: string,
  isAllowed: (url: string) => boolean,
): string | null {
  for (const [, url] of content.matchAll(MEDIA_LINE)) {
    if (
      url.length <= MAX_COVER_URL_LENGTH &&
      !isVideoUrl(url) &&
      isAllowed(url)
    ) {
      return url;
    }
  }
  return null;
}
