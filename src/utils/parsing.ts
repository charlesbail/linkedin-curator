/**
 * Pure parsing/decision functions for the feed curator.
 *
 * Nothing in this file touches chrome.* APIs or the DOM. Every function
 * takes plain data in and returns plain data out, so it can be unit tested
 * and reused from content_scripts, background, or the popup.
 */
import { PROMOTED_TEXT } from './selectors';

/** Snapshot of a single feed post, extracted from the DOM by a content script. */
export interface FeedPostInfo {
  text: string;
  supplementaryInfo: string;
  headerText: string;
}

export function normalizeText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

export function containsKeyword(text: string, keywords: readonly string[]): boolean {
  if (keywords.length === 0) return false;
  const haystack = normalizeText(text).toLowerCase();
  return keywords.some((keyword) => {
    const needle = keyword.trim().toLowerCase();
    return needle.length > 0 && haystack.includes(needle);
  });
}

export function isPromotedPost(supplementaryInfo: string): boolean {
  return normalizeText(supplementaryInfo).toLowerCase().includes(PROMOTED_TEXT.toLowerCase());
}

const RESHARE_PATTERN = /(reacted to this|commented on this|likes this|reposted this)/i;

export function isReshare(headerText: string): boolean {
  return RESHARE_PATTERN.test(normalizeText(headerText));
}

/**
 * True for LinkedIn's home feed: `/`, `/feed`, and `/feed/...` (a single
 * update or a hashtag feed). Other app routes (`/jobs/`, `/in/`,
 * `/messaging/`) are false so a content script injected on every
 * linkedin.com document can ignore them.
 */
export function isLinkedInFeedUrl(url: string): boolean {
  let pathname: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.hostname !== 'www.linkedin.com' && parsed.hostname !== 'linkedin.com') return false;
    pathname = parsed.pathname;
  } catch {
    return false;
  }

  const normalized = pathname.replace(/\/+$/, '') || '/';
  return normalized === '/' || normalized === '/feed' || normalized.startsWith('/feed/');
}
