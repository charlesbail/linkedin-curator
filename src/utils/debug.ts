/**
 * Debug logging utilities.
 *
 * Pure wrapper functions that check debugMode from chrome.storage.local before
 * emitting console output. All logging throughout the extension should use
 * these helpers instead of calling console.* directly, so debug output can be
 * toggled from the popup without reloading.
 */

import { getState } from './storage';

let cachedDebugMode = false;
let isInitialized = false;

async function ensureDebugModeCache(): Promise<void> {
  if (!isInitialized) {
    const state = await getState();
    cachedDebugMode = state.debugMode;
    isInitialized = true;

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      const stateChange = changes['curatorState'];
      if (stateChange?.newValue?.debugMode !== undefined) {
        cachedDebugMode = stateChange.newValue.debugMode;
      }
    });
  }
}

export async function debugLog(message?: unknown, ...optionalParams: unknown[]): Promise<void> {
  await ensureDebugModeCache();
  if (cachedDebugMode) {
    console.log(message, ...optionalParams);
  }
}

export async function debugWarn(message?: unknown, ...optionalParams: unknown[]): Promise<void> {
  await ensureDebugModeCache();
  if (cachedDebugMode) {
    console.warn(message, ...optionalParams);
  }
}

export async function debugError(message?: unknown, ...optionalParams: unknown[]): Promise<void> {
  await ensureDebugModeCache();
  if (cachedDebugMode) {
    console.error(message, ...optionalParams);
  }
}
