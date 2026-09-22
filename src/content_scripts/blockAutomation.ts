/**
 * Block-profile automation, injected into a temporary profile tab via
 * `chrome.scripting.executeScript({ func: runBlockAutomation })` from
 * background.ts.
 *
 * IMPORTANT: Chrome re-executes this function standalone in the target
 * tab — it only transfers the function's own literal source, not this
 * module's surrounding scope. Every helper it needs (sleep/waitFor,
 * pointer-event dispatch, DOM matching) is therefore declared *inside*
 * the function body; a top-level helper in this file would silently be
 * unavailable at runtime, so don't be tempted to factor any of this out.
 *
 * Drives LinkedIn's own profile-page UI, based on the flow captured in
 * linkedin-dom-mocks/profile-actions.html.html (the "Plus" overflow
 * button), profile-submenu.html.html (the "Bloquer {name}" menu item),
 * and block-modal.html.html (the confirmation dialog's "Bloquer" button).
 */
export async function runBlockAutomation(
  requestId: string,
  targetName: string,
): Promise<{ requestId: string; success: boolean; reason?: string }> {
  const LOG_PREFIX = '[Aufwieder-zen:blockAutomation]';

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function normalizeText(raw: string): string {
    return raw.replace(/\s+/g, ' ').trim();
  }

  async function waitFor<T>(getValue: () => T | null | undefined, retries: number, delayMs: number): Promise<T | null> {
    for (let attempt = 0; attempt < retries; attempt++) {
      const value = getValue();
      if (value) return value;
      await sleep(delayMs);
    }
    return null;
  }

  function isVisible(el: Element): boolean {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /** LinkedIn's custom menu/dialog rows ignore plain element.click() —
   *  same finding as feedInjector.ts's activateMenuItem for the feed's
   *  "..." menu. Dispatch a full pointer+mouse sequence instead. */
  function activatePointer(el: HTMLElement): void {
    const rect = el.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    const mouseInit: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX,
      clientY,
      button: 0,
    };
    const pointerInit: PointerEventInit = { ...mouseInit, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    el.dispatchEvent(new PointerEvent('pointerdown', pointerInit));
    el.dispatchEvent(new MouseEvent('mousedown', mouseInit));
    el.dispatchEvent(new PointerEvent('pointerup', pointerInit));
    el.dispatchEvent(new MouseEvent('mouseup', mouseInit));
    el.dispatchEvent(new MouseEvent('click', mouseInit));
  }

  /** The "Plus" overflow trigger has no aria-label, just a <span>Plus</span>
   *  child — match on its own text content instead. */
  function findPlusButton(): HTMLElement | null {
    const buttons = Array.from(document.querySelectorAll<HTMLElement>('button[aria-expanded]'));
    return buttons.find((b) => normalizeText(b.textContent ?? '').toLowerCase() === 'plus') ?? null;
  }

  /** Matches "Bloquer {name}" menu items; profile-submenu.html.html shows
   *  LinkedIn using just the first name here, so match loosely in both
   *  directions rather than requiring an exact full-name match. */
  function findBlockMenuItem(name: string): HTMLElement | null {
    const items = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    const candidates = items
      .map((item) => {
        const text = normalizeText(item.textContent ?? '');
        const match = /^Bloquer\s+(.+)$/i.exec(text);
        return match ? { item, capturedName: match[1] ?? '' } : null;
      })
      .filter((entry): entry is { item: HTMLElement; capturedName: string } => entry !== null);

    const lowerName = name.toLowerCase();
    const byName = candidates.find(
      (entry) =>
        lowerName.includes(entry.capturedName.toLowerCase()) || entry.capturedName.toLowerCase().includes(lowerName),
    );
    if (byName) return byName.item;
    return candidates.length === 1 ? (candidates[0]?.item ?? null) : null;
  }

  /** The confirmation dialog's bottom container has two plain buttons
   *  ("Retour"/"Bloquer") with no aria-label; prefer matching by text,
   *  falling back to "the second button" per the dialog's own layout. */
  function findBlockConfirmButton(dialog: Element): HTMLElement | null {
    const buttons = Array.from(dialog.querySelectorAll<HTMLElement>('button')).filter(
      (b) => !b.hasAttribute('aria-label'),
    );
    const byText = buttons.find((b) => normalizeText(b.textContent ?? '').toLowerCase() === 'bloquer');
    if (byText) return byText;
    return buttons[1] ?? null;
  }

  console.log(`${LOG_PREFIX} starting for "${targetName}" (request ${requestId})`);

  try {
    console.log(`${LOG_PREFIX} step 1/3: waiting for the "Plus" button`);
    const plusButton = await waitFor(() => {
      const btn = findPlusButton();
      return btn && isVisible(btn) ? btn : null;
    }, 15, 200);
    if (!plusButton) {
      console.warn(`${LOG_PREFIX} "Plus" button never appeared`);
      return { requestId, success: false, reason: 'plus-button-not-found' };
    }
    console.log(`${LOG_PREFIX} found "Plus" button, clicking`);
    activatePointer(plusButton);

    console.log(`${LOG_PREFIX} step 2/3: waiting for "Bloquer ${targetName}" in the submenu`);
    await sleep(150);
    const blockMenuItem = await waitFor(() => {
      const item = findBlockMenuItem(targetName);
      return item && isVisible(item) ? item : null;
    }, 15, 200);
    if (!blockMenuItem) {
      console.warn(`${LOG_PREFIX} "Bloquer ${targetName}" menu item never appeared`);
      return { requestId, success: false, reason: 'block-menu-item-not-found' };
    }
    console.log(`${LOG_PREFIX} found "${normalizeText(blockMenuItem.textContent ?? '')}", clicking`);
    activatePointer(blockMenuItem);

    console.log(`${LOG_PREFIX} step 3/3: waiting for the confirmation dialog`);
    await sleep(150);
    const dialog = await waitFor(() => {
      const el = document.querySelector('dialog[data-testid="dialog"]');
      return el && isVisible(el) ? el : null;
    }, 15, 200);
    if (!dialog) {
      console.warn(`${LOG_PREFIX} confirmation dialog never appeared`);
      return { requestId, success: false, reason: 'dialog-not-found' };
    }
    const confirmButton = findBlockConfirmButton(dialog);
    if (!confirmButton) {
      console.warn(`${LOG_PREFIX} "Bloquer" confirm button not found in dialog`);
      return { requestId, success: false, reason: 'confirm-button-not-found' };
    }
    console.log(`${LOG_PREFIX} found dialog confirm button, clicking`);
    activatePointer(confirmButton);

    console.log(`${LOG_PREFIX} block confirmed for "${targetName}"`);
    return { requestId, success: true };
  } catch (error) {
    console.warn(`${LOG_PREFIX} threw`, error);
    return { requestId, success: false, reason: 'exception' };
  }
}
