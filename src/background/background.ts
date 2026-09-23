/**
 * Background Service Worker.
 *
 * Responsible for cross-tab orchestration: initializing default state,
 * relaying "state changed" notifications to LinkedIn tabs, and driving
 * the Block-profile automation (opening a temporary profile tab,
 * injecting blockAutomation.ts into it, and reporting the result back to
 * the feed tab that requested it). No DOM access happens here directly;
 * parsing/business logic is delegated to utils, and the actual profile-
 * page DOM automation lives in content_scripts/blockAutomation.ts.
 */
import { runBlockAutomation } from '../content_scripts/blockAutomation';
import { blockAutomationPhrases } from '../utils/linkedinPhrases';
import { DEFAULT_STATE, getState, incrementBlockedProfileCount, setState } from '../utils/storage';
import { debugLog, debugWarn } from '../utils/debug';

const LOG_PREFIX = '[Aufwieder-zen:background]';
const LINKEDIN_URL_PATTERN = 'https://www.linkedin.com/*';
const PROFILE_URL_PATTERN = /^https:\/\/(?:www\.)?linkedin\.com\/in\//i;
const TAB_LOAD_TIMEOUT_MS = 15000;
const AUTOMATION_TIMEOUT_MS = 20000;

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await setState(DEFAULT_STATE);
  }
});

export type BackgroundMessage =
  | { type: 'REFRESH_LINKEDIN_TABS' }
  | { type: 'GET_STATE' }
  | { type: 'BLOCK_PROFILE_REQUEST'; requestId: string; profileUrl: string; name: string };

export type BlockProfileResultMessage = {
  type: 'BLOCK_PROFILE_RESULT';
  requestId: string;
  success: boolean;
  reason?: string;
};

chrome.runtime.onMessage.addListener((message: BackgroundMessage, sender, sendResponse) => {
  if (message?.type === 'GET_STATE') {
    getState().then(sendResponse);
    return true; // keep the message channel open for the async response
  }

  if (message?.type === 'REFRESH_LINKEDIN_TABS') {
    broadcastToLinkedInTabs();
    return false;
  }

  if (message?.type === 'BLOCK_PROFILE_REQUEST') {
    const feedTabId = sender.tab?.id;
    if (feedTabId === undefined) {
      void debugWarn(`${LOG_PREFIX} BLOCK_PROFILE_REQUEST received with no sender tab id`, message);
      return false;
    }
    handleBlockProfileRequest(message, feedTabId);
    return false;
  }

  return false;
});

async function broadcastToLinkedInTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: LINKEDIN_URL_PATTERN });
  const state = await getState();
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    chrome.tabs.sendMessage(tab.id, { type: 'STATE_UPDATED', state }).catch(() => {
      // Tab may not have an active content script (e.g. not yet loaded); ignore.
    });
  }
}

/**
 * Orchestrates the full Block flow:
 *   1. Open the target profile in a minimized (effectively hidden) window.
 *   2. Wait for it to finish loading.
 *   3. Inject blockAutomation.ts's exported function into it and await
 *      its result.
 *   4. Close the temporary window.
 *   5. Relay a BLOCK_PROFILE_RESULT back to the feed tab that asked for it.
 */
async function handleBlockProfileRequest(
  message: Extract<BackgroundMessage, { type: 'BLOCK_PROFILE_REQUEST' }>,
  feedTabId: number,
): Promise<void> {
  const { requestId, profileUrl, name } = message;
  await debugLog(`${LOG_PREFIX} BLOCK_PROFILE_REQUEST received for "${name}" (${requestId})`, profileUrl);

  if (!PROFILE_URL_PATTERN.test(profileUrl)) {
    await debugWarn(`${LOG_PREFIX} refusing to open non-profile URL`, profileUrl);
    notifyFeedTab(feedTabId, { type: 'BLOCK_PROFILE_RESULT', requestId, success: false, reason: 'invalid-url' });
    return;
  }

  let createdWindow: chrome.windows.Window | undefined;
  try {
    await debugLog(`${LOG_PREFIX} opening minimized window for`, profileUrl);
    createdWindow = await chrome.windows.create({ url: profileUrl, focused: false, state: 'minimized' });
    if (!createdWindow) throw new Error('failed to create automation window');
    const tabId = createdWindow.tabs?.[0]?.id;
    if (tabId === undefined) throw new Error('created window has no tab');

    await debugLog(`${LOG_PREFIX} waiting for profile tab ${tabId} to finish loading`);
    await waitForTabLoad(tabId, TAB_LOAD_TIMEOUT_MS);

    await debugLog(`${LOG_PREFIX} injecting block automation into tab ${tabId}`);
    const result = await runWithTimeout(
      chrome.scripting
        .executeScript({
          target: { tabId },
          func: runBlockAutomation,
          args: [requestId, name, blockAutomationPhrases()],
        })
        .then((results) => results[0]?.result),
      AUTOMATION_TIMEOUT_MS,
    );

    const success = result?.success ?? false;
    await debugLog(`${LOG_PREFIX} automation finished for "${name}" -> success=${success}`, result?.reason ?? '');

    if (success) {
      await incrementBlockedProfileCount();
    }

    notifyFeedTab(feedTabId, {
      type: 'BLOCK_PROFILE_RESULT',
      requestId,
      success,
      reason: result?.reason,
    });
  } catch (error) {
    await debugWarn(`${LOG_PREFIX} block automation failed for "${name}"`, error);
    notifyFeedTab(feedTabId, { type: 'BLOCK_PROFILE_RESULT', requestId, success: false, reason: 'exception' });
  } finally {
    if (createdWindow?.id !== undefined) {
      await debugLog(`${LOG_PREFIX} closing automation window ${createdWindow.id}`);
      chrome.windows.remove(createdWindow.id).catch(() => {});
    }
  }
}

function notifyFeedTab(feedTabId: number, message: BlockProfileResultMessage): void {
  void debugLog(`${LOG_PREFIX} notifying feed tab ${feedTabId}`, message);
  chrome.tabs.sendMessage(feedTabId, message).catch(async (error) => {
    await debugWarn(`${LOG_PREFIX} failed to notify feed tab ${feedTabId}`, error);
  });
}

/** Resolves once `tabId` reaches `status: 'complete'` (or immediately if
 *  it already has), so we don't inject the automation script before the
 *  profile page has actually navigated/rendered. */
function waitForTabLoad(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('tab load timed out'));
    }, timeoutMs);

    function listener(updatedTabId: number, changeInfo: chrome.tabs.OnUpdatedInfo): void {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }

    chrome.tabs.onUpdated.addListener(listener);

    // The tab may already be "complete" by the time we start listening.
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === 'complete') {
          clearTimeout(timeout);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      })
      .catch(() => {});
  });
}

/** Belt-and-suspenders timeout in case the injected automation throws
 *  before it can return a result (e.g. a page navigation invalidates its
 *  execution context mid-flight) — the automation itself already has its
 *  own internal per-step polling/timeouts. */
function runWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('automation timed out')), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
