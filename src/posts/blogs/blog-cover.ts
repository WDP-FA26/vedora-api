import { runtimeConfig } from '../../config/runtime-config.js';
export const MAX_COVER_URL_LENGTH = runtimeConfig.BLOG_COVER_URL_MAX_LENGTH;

/** An image or video on a line of its own, as the blog editor writes it. */
const MEDIA_LINE = /^!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)\s*$/gm;

/** Same test as the web editor's `isVideoUrl`: videos are not covers. */
export function isVideoUrl(url: string): boolean {
  return /\/video\/upload\//.test(url) || /\.(mp4|webm|mov)(\?|#|$)/i.test(url);
}

/**
 * A blog's cover is the first image in its content, so the card in the feed
 * always shows a picture the article still contains. `isAllowed` decides which
 * links may be a cover (https, or an image in Vedora's blog storage).
 */
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
