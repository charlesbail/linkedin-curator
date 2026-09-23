/**
 * Pure parsing/decision functions for the feed curator.
 *
 * Nothing in this file touches chrome.* APIs or the DOM. Every function
 * takes plain data in and returns plain data out, so it can be unit tested
 * and reused from content_scripts, background, or the popup.
 */
import { LINKEDIN_LOOKUPS, matchesLookup } from './linkedinPhrases';

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
  return matchesLookup(supplementaryInfo, LINKEDIN_LOOKUPS.promoted);
}

/** True when the header phrase marks a repost or a reaction. Direct posts match neither list. */
export function isReshare(headerText: string): boolean {
  return (
    matchesLookup(headerText, LINKEDIN_LOOKUPS.repostHeader) ||
    matchesLookup(headerText, LINKEDIN_LOOKUPS.likedHeader)
  );
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

/** https://www.linkedin.com/in/... with search and hash removed, or null. */
export function canonicalLinkedInProfileUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw, 'https://www.linkedin.com');
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  if (parsed.hostname !== 'www.linkedin.com') return null;
  if (!parsed.pathname.startsWith('/in/') || parsed.pathname.includes('..')) return null;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

/** Path only. Query and hash are dropped because LinkedIn puts member URNs there. */
export function profilePathForLog(url: string | null): string {
  if (!url) return 'none';
  try {
    const parsed = new URL(url, 'https://www.linkedin.com');
    if (parsed.hostname !== 'www.linkedin.com' && parsed.hostname !== 'linkedin.com') {
      return 'non-linkedin';
    }
    return parsed.pathname;
  } catch {
    return 'invalid';
  }
}
