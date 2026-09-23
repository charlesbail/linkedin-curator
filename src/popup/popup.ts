/**
 * Popup: UI and toggles only.
 *
 * Reads/writes settings through utils/storage and asks the background
 * worker to notify content scripts. Never touches the LinkedIn page DOM
 * directly.
 */
import { resolveUiLocale, translate, type Locale, type UiKey } from '../utils/linkedinPhrases';
import { getState, onStateChanged, setState, type CuratorState } from '../utils/storage';

const buttonsToggle = document.getElementById('buttons-toggle') as HTMLButtonElement;
const originalAuthorBlockToggle = document.getElementById('original-author-block-toggle') as HTMLButtonElement;
const toolbarOrderToggle = document.getElementById('toolbar-order-toggle') as HTMLButtonElement;
const debugToggle = document.getElementById('debug-toggle') as HTMLButtonElement;
const blockedProfileCount = document.getElementById('blocked-profile-count') as HTMLSpanElement;
const languageButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.popup__segment-btn'));

const COPY: ReadonlyArray<readonly [string, UiKey]> = [
  ['popup-subtitle', 'popupSubtitle'],
  ['buttons-label', 'enableButtonsLabel'],
  ['buttons-desc', 'enableButtonsDesc'],
  ['original-author-label', 'originalAuthorLabel'],
  ['original-author-desc', 'originalAuthorDesc'],
  ['toolbar-order-label', 'toolbarOrderLabel'],
  ['toolbar-order-desc', 'toolbarOrderDesc'],
  ['debug-label', 'debugLabel'],
  ['debug-desc', 'debugDesc'],
  ['language-label', 'languageLabel'],
  ['language-desc', 'languageDesc'],
  ['blocked-count-label', 'blockedCountLabel'],
  ['view-blocked-label', 'viewBlockedLabel'],
];

function setSwitchChecked(toggle: HTMLButtonElement, checked: boolean): void {
  toggle.setAttribute('aria-checked', String(checked));
}

function isSwitchChecked(toggle: HTMLButtonElement): boolean {
  return toggle.getAttribute('aria-checked') === 'true';
}

function applyCopy(locale: Locale): void {
  document.documentElement.lang = locale;
  for (const [id, key] of COPY) {
    const node = document.getElementById(id);
    if (node) node.textContent = translate(key, locale);
  }
  const settings = document.getElementById('feed-settings');
  settings?.setAttribute('aria-label', translate('feedSettingsLabel', locale));
}

function renderLanguage(locale: Locale): void {
  for (const button of languageButtons) {
    button.setAttribute('aria-checked', String(button.dataset.locale === locale));
  }
}

function renderState(state: CuratorState): void {
  const locale = resolveUiLocale(state.popupLocale, chrome.i18n.getUILanguage());
  applyCopy(locale);
  renderLanguage(locale);
  setSwitchChecked(buttonsToggle, state.enableButtonsInFeed);
  setSwitchChecked(originalAuthorBlockToggle, state.enableBlockOnOriginalAuthor);
  setSwitchChecked(toolbarOrderToggle, state.reverseToolbarOrder);
  setSwitchChecked(debugToggle, state.debugMode);
  blockedProfileCount.textContent = String(state.blockedProfileCount);
}

async function notifyContentScripts(): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: 'REFRESH_LINKEDIN_TABS' });
  } catch {
    // No listener yet (e.g. background just woke up); state is already
    // persisted, and content scripts also watch chrome.storage.onChanged.
  }
}

function bindSwitch(toggle: HTMLButtonElement, patch: (checked: boolean) => Partial<CuratorState>): void {
  toggle.addEventListener('click', async () => {
    const next = !isSwitchChecked(toggle);
    setSwitchChecked(toggle, next);
    await setState(patch(next));
    await notifyContentScripts();
  });
}

function bindLanguage(button: HTMLButtonElement): void {
  button.addEventListener('click', async () => {
    if (button.getAttribute('aria-checked') === 'true') return;
    const locale = button.dataset.locale;
    if (locale !== 'fr' && locale !== 'en') return;
    renderLanguage(locale);
    await setState({ popupLocale: locale });
    await notifyContentScripts();
  });
}

bindSwitch(buttonsToggle, (checked) => ({ enableButtonsInFeed: checked }));
bindSwitch(originalAuthorBlockToggle, (checked) => ({ enableBlockOnOriginalAuthor: checked }));
bindSwitch(toolbarOrderToggle, (checked) => ({ reverseToolbarOrder: checked }));
bindSwitch(debugToggle, (checked) => ({ debugMode: checked }));
for (const button of languageButtons) bindLanguage(button);

getState().then(renderState);
onStateChanged(renderState);
