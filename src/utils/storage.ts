/**
 * Centralized, typed access to chrome.storage.local.
 *
 * Every other layer (popup, content_scripts, background) must go through
 * these helpers instead of calling chrome.storage.local directly, so the
 * shape of persisted state only needs to change in one place.
 */
import type { Locale } from './linkedinPhrases';

export interface CuratorState {
  /**
   * Shows Unfollow and Block on feed posts. The native "..." and hide
   * controls stay either way. Visibility is CSS on the action group.
   */
  enableButtonsInFeed: boolean;
  /**
   * Shows the Block button on the original-author row of a repost or like.
   * The actor's own row is unaffected. Visibility is CSS on the injected toolbar.
   */
  enableBlockOnOriginalAuthor: boolean;
  /**
   * Swaps the two toolbar button groups. The header row is unchanged.
   * Applied in CSS via flex-direction; the DOM order stays unchanged.
   */
  reverseToolbarOrder: boolean;
  /** Enables console logs and debug helpers throughout the extension. */
  debugMode: boolean;
  /**
   * Popup and feed-button language. Null follows the browser language,
   * then English when that language is not one of the shipped locales.
   */
  popupLocale: Locale | null;
  /** Number of profiles this extension has successfully blocked. */
  blockedProfileCount: number;
}

export const DEFAULT_STATE: CuratorState = {
  enableButtonsInFeed: true,
  enableBlockOnOriginalAuthor: true,
  reverseToolbarOrder: false,
  debugMode: false,
  popupLocale: null,
  blockedProfileCount: 0,
};

const STORAGE_KEY = 'curatorState';

export async function getState(): Promise<CuratorState> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const stored = result[STORAGE_KEY] as Partial<CuratorState> | undefined;
  return { ...DEFAULT_STATE, ...stored };
}

export async function setState(patch: Partial<CuratorState>): Promise<CuratorState> {
  const current = await getState();
  const next: CuratorState = { ...current, ...patch };
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

/** Records one successful block in the persisted profile count. */
export async function incrementBlockedProfileCount(): Promise<number> {
  const current = await getState();
  const next = current.blockedProfileCount + 1;
  await setState({ blockedProfileCount: next });
  return next;
}

/**
 * Subscribes to changes of the curator state in chrome.storage.local.
 * Returns an unsubscribe function.
 */
export function onStateChanged(callback: (state: CuratorState) => void): () => void {
  const listener = (
    changes: { [key: string]: chrome.storage.StorageChange },
    areaName: chrome.storage.AreaName,
  ) => {
    if (areaName !== 'local') return;
    const change = changes[STORAGE_KEY];
    if (!change) return;
    callback({ ...DEFAULT_STATE, ...(change.newValue as Partial<CuratorState>) });
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
