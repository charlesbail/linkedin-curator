/**
 * Content script: DOM manipulation and injection only.
 *
 * Mirrors the curator state onto the page as data attributes on <html> so
 * CSS/JS feature code (button injection, fade-out animation, etc.) can key
 * off them. Listens both to chrome.storage.onChanged (via utils/storage)
 * and to explicit messages from the background worker, so it always has
 * the latest settings.
 */
import { LOCALES, translate } from '../utils/linkedinPhrases';
import { getState, onStateChanged, type CuratorState } from '../utils/storage';

const BUTTONS_ATTR = 'data-aufwiederzen-buttons-enabled';
const FADE_ATTR = 'data-aufwiederzen-fade-enabled';
const ORIGINAL_AUTHOR_BLOCK_ATTR = 'data-aufwiederzen-original-author-block-enabled';
const TOOLBAR_REVERSED_ATTR = 'data-aufwiederzen-toolbar-reversed';
const UNSUPPORTED_LANGUAGE_ID = 'aufwiederzen-unsupported-language';
const LINKEDIN_LANGUAGE_SETTINGS_URL = 'https://www.linkedin.com/mypreferences/d/settings/language';

/** LinkedIn sets `<html lang>` to the interface language (`fr`, `en-US`, …). */
function linkedInLanguageIsSupported(): boolean {
  const base = document.documentElement.lang.toLowerCase().split('-')[0] ?? '';
  if (!base) return true;
  return (LOCALES as readonly string[]).includes(base);
}

function syncUnsupportedLanguageNotice(): void {
  const existing = document.getElementById(UNSUPPORTED_LANGUAGE_ID);
  if (linkedInLanguageIsSupported()) {
    existing?.remove();
    return;
  }
  if (existing) return;

  const notice = document.createElement('a');
  notice.id = UNSUPPORTED_LANGUAGE_ID;
  notice.href = LINKEDIN_LANGUAGE_SETTINGS_URL;
  notice.setAttribute('role', 'status');

  const label = document.createElement('span');
  label.textContent = `${translate('unsupportedLinkedInLanguage', 'en')} `;

  const action = document.createElement('span');
  action.className = 'aufwiederzen-unsupported-language__action';
  action.textContent = translate('unsupportedLinkedInLanguageAction', 'en');

  const arrow = document.createElement('span');
  arrow.className = 'aufwiederzen-unsupported-language__arrow';
  arrow.setAttribute('aria-hidden', 'true');
  arrow.textContent = '\u2192';

  notice.append(label, action, arrow);
  document.body.appendChild(notice);
}

function applyState(state: CuratorState): void {
  document.documentElement.setAttribute(BUTTONS_ATTR, String(state.enableButtonsInFeed));
  document.documentElement.setAttribute(FADE_ATTR, String(state.enableFadeAnimation));
  document.documentElement.setAttribute(ORIGINAL_AUTHOR_BLOCK_ATTR, String(state.enableBlockOnOriginalAuthor));
  document.documentElement.setAttribute(TOOLBAR_REVERSED_ATTR, String(state.reverseToolbarOrder));
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
  syncUnsupportedLanguageNotice();
  new MutationObserver(() => syncUnsupportedLanguageNotice()).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['lang'],
  });
}

init();
