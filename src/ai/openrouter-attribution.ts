export const DEFAULT_OPENROUTER_APP_URL = 'https://vedora-opal.vercel.app';
export const DEFAULT_OPENROUTER_APP_TITLE = 'Vedora Platform';

export type OpenRouterAttribution = {
  appUrl: string;
  appTitle: string;
};

export type OpenRouterAttributionHeaders = {
  'HTTP-Referer': string;
  'X-OpenRouter-Title': string;
};

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolves OpenRouter app attribution (`HTTP-Referer` and `X-OpenRouter-Title`),
 * falling back from explicit overrides to `OPENROUTER_APP_*` env vars and
 * Vedora's defaults so OpenRouter logs attribute requests instead of `Unknown`.
 */
export function openRouterAttribution(overrides?: {
  appUrl?: string;
  appTitle?: string;
}): OpenRouterAttribution {
  return {
    appUrl:
      nonEmpty(overrides?.appUrl) ??
      nonEmpty(process.env.OPENROUTER_APP_URL) ??
      DEFAULT_OPENROUTER_APP_URL,
    appTitle:
      nonEmpty(overrides?.appTitle) ??
      nonEmpty(process.env.OPENROUTER_APP_TITLE) ??
      DEFAULT_OPENROUTER_APP_TITLE,
  };
}

/** HTTP headers OpenRouter requires to attribute requests to an app. */
export function openRouterAttributionHeaders(overrides?: {
  appUrl?: string;
  appTitle?: string;
}): OpenRouterAttributionHeaders {
  const { appUrl, appTitle } = openRouterAttribution(overrides);
  return {
    'HTTP-Referer': appUrl,
    'X-OpenRouter-Title': appTitle,
  };
}
