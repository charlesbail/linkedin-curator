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
