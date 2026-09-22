/**
 * Popup: UI and toggles only.
 *
 * Reads/writes settings through utils/storage and asks the background
 * worker to notify content scripts. Never touches the LinkedIn page DOM
 * directly.
 */
import { getState, setState, type CuratorState } from '../utils/storage';

const buttonsToggle = document.getElementById('buttons-toggle') as HTMLButtonElement;
const fadeToggle = document.getElementById('fade-toggle') as HTMLButtonElement;

function setSwitchChecked(toggle: HTMLButtonElement, checked: boolean): void {
  toggle.setAttribute('aria-checked', String(checked));
}

function isSwitchChecked(toggle: HTMLButtonElement): boolean {
  return toggle.getAttribute('aria-checked') === 'true';
}

function renderState(state: CuratorState): void {
  setSwitchChecked(buttonsToggle, state.enableButtonsInFeed);
  setSwitchChecked(fadeToggle, state.enableFadeAnimation);
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

bindSwitch(buttonsToggle, (checked) => ({ enableButtonsInFeed: checked }));
bindSwitch(fadeToggle, (checked) => ({ enableFadeAnimation: checked }));

getState().then(renderState);
