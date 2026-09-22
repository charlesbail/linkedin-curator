/**
 * Content script: DOM manipulation and injection only.
 *
 * Mirrors the curator state onto the page as data attributes on <html> so
 * CSS/JS feature code (button injection, fade-out animation, etc.) can key
 * off them. Listens both to chrome.storage.onChanged (via utils/storage)
 * and to explicit messages from the background worker, so it always has
 * the latest settings.
 */
import { getState, onStateChanged, type CuratorState } from '../utils/storage';

const BUTTONS_ATTR = 'data-aufwiederzen-buttons-enabled';
const FADE_ATTR = 'data-aufwiederzen-fade-enabled';

function applyState(state: CuratorState): void {
  document.documentElement.setAttribute(BUTTONS_ATTR, String(state.enableButtonsInFeed));
  document.documentElement.setAttribute(FADE_ATTR, String(state.enableFadeAnimation));
}

chrome.runtime.onMessage.addListener((message: { type: string; state?: CuratorState }) => {
  if (message?.type === 'STATE_UPDATED' && message.state) {
    applyState(message.state);
  }
});

onStateChanged((state) => {
  applyState(state);
});

async function init(): Promise<void> {
  applyState(await getState());
}

init();
