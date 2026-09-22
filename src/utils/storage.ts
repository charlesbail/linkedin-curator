/**
 * Centralized, typed access to chrome.storage.local.
 *
 * Every other layer (popup, content_scripts, background) must go through
 * these helpers instead of calling chrome.storage.local directly, so the
 * shape of persisted state only needs to change in one place.
 */

export interface CuratorState {
  /** Injects quick-action buttons onto feed posts. */
  enableButtonsInFeed: boolean;
  /** Animates removed/hidden posts with a fade-out instead of an instant cut. */
  enableFadeAnimation: boolean;
}

export const DEFAULT_STATE: CuratorState = {
  enableButtonsInFeed: true,
  enableFadeAnimation: true,
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
