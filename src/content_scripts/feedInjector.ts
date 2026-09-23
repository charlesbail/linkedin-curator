/**
 * Content script: injects a shared icon toolbar into feed post headers
 * as the user scrolls. Native "..." / hide buttons are adopted into the
 * toolbar so they keep LinkedIn's behaviour; Unfollow / Block are ours.
 * Post classification lives in utils/domParsers.ts; on/off state lives
 * in utils/storage.ts.
 *
 * Block is cross-tab: this script only sends a request to background.ts
 * (which opens a temporary profile tab and drives the actual block flow
 * there via blockAutomation.ts) and reacts to the result it relays back.
 */
import {
  findHidePostButton,
  findOpenPostMenuButton,
  findPostContainers,
  findUnfollowMenuItem,
  isPersonAuthor,
  parseLinkedInPost,
  type ParsedLinkedInPost,
  type ProfileRef,
} from '../utils/domParsers';
import { getState, onStateChanged, type CuratorState } from '../utils/storage';

const LOG_PREFIX = '[Aufwieder-zen:feedInjector]';

const PROCESSED_ATTR = 'data-aufwiederzen-injector-processed';
const INJECTED_MARKER_ATTR = 'data-aufwiederzen-injected-for';
const TOOLBAR_CLASS = 'aufwiederzen-toolbar';
const TOOLBAR_GROUP_CLASS = 'aufwiederzen-toolbar-group';
const DIRECT_TOOLBAR_CLASS = 'aufwiederzen-toolbar--direct';
const DIRECT_POST_CLASS = 'aufwiederzen-post--direct';
const DIRECT_HEADER_CLASS = 'aufwiederzen-direct-header';
const ACTIONS_HOST_CLASS = 'aufwiederzen-actions-host';
const TOOLBAR_BTN_CLASS = 'aufwiederzen-toolbar-btn';
const DANGER_BUTTON_CLASS = 'aufwiederzen-toolbar-btn--danger';
const BUSY_BTN_CLASS = 'aufwiederzen-toolbar-btn--busy';
const OWNED_BTN_ATTR = 'data-aufwiederzen-owned';
const ADOPTED_BTN_ATTR = 'data-aufwiederzen-adopted';
const HIDDEN_NATIVE_ATTR = 'data-aufwiederzen-hidden';
const ICON_ATTR = 'data-aufwiederzen-icon';
const ORIGINAL_LABEL_ATTR = 'data-aufwiederzen-original-aria-label';
const OPTIONS_BUTTON_LABEL = 'Options';

/** How long to keep polling for the "..." popover menu to render before
 *  giving up: 15 attempts * 200ms = up to 3s, generous enough for a slow
 *  connection or a busy main thread. */
const MENU_POLL_OPTIONS = { retries: 15, delayMs: 200 };
const FADE_OUT_DURATION_MS = 250;

let enabled = false;
let observer: MutationObserver | null = null;
let scanScheduled = false;

/** Post containers awaiting a BLOCK_PROFILE_RESULT from background.ts,
 *  keyed by the requestId sent with the original BLOCK_PROFILE_REQUEST. */
const pendingBlockRequests = new Map<string, { postContainer: Element; blockButton: HTMLButtonElement }>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generateRequestId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// --- Toast notifications --------------------------------------------------

const TOAST_CONTAINER_ID = 'aufwiederzen-toast-container';
const TOAST_VISIBLE_MS = 3000;

/**
 * Injects a lightweight, self-dismissing toast in the page's top-left
 * corner (styled in content.css, `z-index` maxed out so it sits above
 * LinkedIn's own overlays). Used to surface success/failure feedback for
 * the cross-tab block flow, which has no LinkedIn UI of its own to react
 * to from this tab.
 */
function showToast(message: string, variant: 'success' | 'error'): void {
  let container = document.getElementById(TOAST_CONTAINER_ID);
  if (!container) {
    container = document.createElement('div');
    container.id = TOAST_CONTAINER_ID;
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `aufwiederzen-toast aufwiederzen-toast--${variant}`;
  toast.textContent = message;
  container.appendChild(toast);

  window.setTimeout(() => toast.remove(), TOAST_VISIBLE_MS);
}

/**
 * Polls `getValue` at a fixed interval until it returns a truthy value or
 * `retries` is exhausted. This is the "delay/retry" mechanism the popover
 * needs: LinkedIn renders its "..." menu asynchronously, and how long that
 * takes varies with network/render speed, so a single immediate lookup
 * right after the click is unreliable.
 */
async function waitFor<T>(
  getValue: () => T | null | undefined,
  { retries, delayMs }: { retries: number; delayMs: number },
): Promise<T | null> {
  for (let attempt = 0; attempt < retries; attempt++) {
    const value = getValue();
    if (value) return value;
    await sleep(delayMs);
  }
  return null;
}

/**
 * LinkedIn's feed menu ignores a plain element.click() on the
 * role="menuitem" wrapper. The handler sits on the inner label and
 * expects a pointer/mouse sequence with coordinates inside the row,
 * after the popover has finished opening.
 */
function activateMenuItem(item: HTMLElement): void {
  const label = item.querySelector('p');
  const target = label instanceof HTMLElement ? label : item;
  const rect = target.getBoundingClientRect();
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
  const pointerInit: PointerEventInit = {
    ...mouseInit,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
  };

  target.dispatchEvent(new PointerEvent('pointerdown', pointerInit));
  target.dispatchEvent(new MouseEvent('mousedown', mouseInit));
  target.dispatchEvent(new PointerEvent('pointerup', pointerInit));
  target.dispatchEvent(new MouseEvent('mouseup', mouseInit));
  target.dispatchEvent(new MouseEvent('click', mouseInit));
}

/**
 * Drives LinkedIn's own "..." command menu to unfollow `profile`:
 *   1. Click the post's native "..." button to open the popover.
 *   2. Poll for the "Ne plus suivre {name}" menu item to render.
 *   3. Click it.
 * Only on confirmed success do we fade out/hide the post — if the menu
 * never appears, or has no matching item (e.g. the user doesn't actually
 * follow this person), we leave the post untouched.
 */
async function performUnfollow(profile: ProfileRef, postContainer: Element): Promise<void> {
  console.log(`${LOG_PREFIX} performUnfollow: starting for`, profile);

  const menuButton = findOpenPostMenuButton(postContainer);
  if (!menuButton) {
    console.warn(`${LOG_PREFIX} performUnfollow: could not find the "..." menu button for`, profile);
    return;
  }

  menuButton.click();

  const unfollowItem = await waitFor(() => {
    const item = findUnfollowMenuItem(document, profile.name);
    if (!item) return null;
    const rect = item.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? item : null;
  }, MENU_POLL_OPTIONS);
  if (!unfollowItem) {
    console.warn(`${LOG_PREFIX} performUnfollow: "Ne plus suivre ${profile.name}" never appeared; aborting`);
    return;
  }

  // The popover drops clicks that arrive in the same turn it mounts.
  await sleep(100);
  activateMenuItem(unfollowItem);
  console.log(`${LOG_PREFIX} performUnfollow: clicked "Ne plus suivre ${profile.name}"`);

  await fadeOutAndHide(postContainer);
}

/**
 * Hides a post after a successful unfollow/block. Only animates the
 * removal when "Enable Fade-out Animation" is on; the toggle controls the
 * animation style, not whether the post actually gets hidden.
 */
async function fadeOutAndHide(postContainer: Element): Promise<void> {
  const state = await getState();
  const el = postContainer as HTMLElement;

  if (state.enableFadeAnimation) {
    el.style.transition = `opacity ${FADE_OUT_DURATION_MS}ms ease`;
    el.style.opacity = '0';
    await sleep(FADE_OUT_DURATION_MS);
  }

  el.style.display = 'none';
  console.log(`${LOG_PREFIX} fadeOutAndHide: hidden post (animated=${state.enableFadeAnimation})`);
}

// --- Cross-tab "Block" flow -------------------------------------------------

/**
 * Kicks off the Block flow by asking background.ts to open the target's
 * profile in a temporary tab and drive the block confirmation there. The
 * actual result arrives later via a BLOCK_PROFILE_RESULT message, handled
 * in handleBlockProfileResult below.
 */
async function performBlock(
  name: string,
  profileUrl: string,
  postContainer: Element,
  blockButton: HTMLButtonElement,
): Promise<void> {
  const requestId = generateRequestId();
  console.log(`${LOG_PREFIX} performBlock: requesting block for "${name}" (${requestId})`, profileUrl);
  pendingBlockRequests.set(requestId, { postContainer, blockButton });
  setBlockButtonBusy(blockButton, true);

  try {
    await chrome.runtime.sendMessage({ type: 'BLOCK_PROFILE_REQUEST', requestId, profileUrl, name });
  } catch (error) {
    console.warn(`${LOG_PREFIX} performBlock: failed to reach background`, error);
    pendingBlockRequests.delete(requestId);
    setBlockButtonBusy(blockButton, false);
    showToast('Block failed to start', 'error');
  }
}

async function handleBlockProfileResult(requestId: string, success: boolean, reason?: string): Promise<void> {
  const pending = pendingBlockRequests.get(requestId);
  pendingBlockRequests.delete(requestId);

  if (!pending) {
    console.warn(`${LOG_PREFIX} handleBlockProfileResult: no pending request for ${requestId}`);
    return;
  }

  if (success) {
    console.log(`${LOG_PREFIX} handleBlockProfileResult: success (${requestId})`);
    showToast('Blocked successfully', 'success');
    await fadeOutAndHide(pending.postContainer);
  } else {
    console.warn(`${LOG_PREFIX} handleBlockProfileResult: failed (${requestId})`, reason);
    setBlockButtonBusy(pending.blockButton, false);
    showToast('Block failed', 'error');
  }
}

function svgEl(tag: string, attrs: Record<string, string>): SVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, value);
  }
  return el;
}

type ToolbarIcon = 'more-horizontal' | 'x' | 'user-minus' | 'ban';

/** Lucide (shadcn) outlines, 24×24 viewBox, rendered at 16px. */
function createToolbarIcon(name: ToolbarIcon): SVGSVGElement {
  const svg = svgEl('svg', {
    viewBox: '0 0 24 24',
    width: '16',
    height: '16',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    [ICON_ATTR]: 'true',
  }) as SVGSVGElement;

  if (name === 'more-horizontal') {
    svg.append(
      svgEl('circle', { cx: '12', cy: '12', r: '1' }),
      svgEl('circle', { cx: '19', cy: '12', r: '1' }),
      svgEl('circle', { cx: '5', cy: '12', r: '1' }),
    );
  } else if (name === 'x') {
    svg.append(svgEl('path', { d: 'M18 6 6 18' }), svgEl('path', { d: 'm6 6 12 12' }));
  } else if (name === 'user-minus') {
    svg.append(
      svgEl('path', { d: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2' }),
      svgEl('circle', { cx: '9', cy: '7', r: '4' }),
      svgEl('line', { x1: '22', x2: '16', y1: '11', y2: '11' }),
    );
  } else {
    svg.append(svgEl('circle', { cx: '12', cy: '12', r: '10' }), svgEl('path', { d: 'm4.9 4.9 14.2 14.2' }));
  }

  return svg;
}

function createSpinnerIcon(): SVGSVGElement {
  const svg = svgEl('svg', {
    viewBox: '0 0 24 24',
    width: '16',
    height: '16',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    class: 'aufwiederzen-spinner',
    [ICON_ATTR]: 'true',
  }) as SVGSVGElement;
  svg.append(svgEl('path', { d: 'M21 12a9 9 0 1 1-6.219-8.56' }));
  return svg;
}

function setBlockButtonBusy(button: HTMLButtonElement, busy: boolean): void {
  button.disabled = busy;
  button.classList.toggle(BUSY_BTN_CLASS, busy);
  button.querySelectorAll(`[${ICON_ATTR}]`).forEach((el) => el.remove());
  if (busy) {
    button.setAttribute('aria-busy', 'true');
    button.append(createSpinnerIcon());
  } else {
    button.removeAttribute('aria-busy');
    button.append(createToolbarIcon('ban'));
  }
}

function adoptNativeToolbarButton(button: HTMLElement, icon: ToolbarIcon, displayLabel?: string): void {
  button.classList.add(TOOLBAR_BTN_CLASS);
  button.setAttribute(ADOPTED_BTN_ATTR, 'true');
  if (displayLabel) {
    if (!button.hasAttribute(ORIGINAL_LABEL_ATTR)) {
      button.setAttribute(ORIGINAL_LABEL_ATTR, button.getAttribute('aria-label') ?? '');
    }
    button.setAttribute('aria-label', displayLabel);
    button.title = displayLabel;
  } else if (!button.title) {
    button.title = button.getAttribute('aria-label') ?? '';
  }
  Array.from(button.children).forEach((child) => {
    if (child instanceof HTMLElement) {
      child.setAttribute(HIDDEN_NATIVE_ATTR, 'true');
    }
  });
  button.append(createToolbarIcon(icon));
}

function restoreNativeToolbarButton(button: HTMLElement): void {
  button.querySelectorAll(`[${ICON_ATTR}]`).forEach((icon) => icon.remove());
  button.querySelectorAll(`[${HIDDEN_NATIVE_ATTR}]`).forEach((child) => child.removeAttribute(HIDDEN_NATIVE_ATTR));
  button.classList.remove(TOOLBAR_BTN_CLASS);
  button.removeAttribute(ADOPTED_BTN_ATTR);
  const originalLabel = button.getAttribute(ORIGINAL_LABEL_ATTR);
  if (originalLabel !== null) {
    if (originalLabel) button.setAttribute('aria-label', originalLabel);
    button.removeAttribute(ORIGINAL_LABEL_ATTR);
    button.removeAttribute('title');
  }
}

function buildOwnedToolbarButton(
  icon: ToolbarIcon,
  label: string,
  onClick: (button: HTMLButtonElement) => Promise<void>,
  danger = false,
  persistDisabled = false,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = danger ? `${TOOLBAR_BTN_CLASS} ${DANGER_BUTTON_CLASS}` : TOOLBAR_BTN_CLASS;
  button.setAttribute(OWNED_BTN_ATTR, 'true');
  button.setAttribute('aria-label', label);
  button.title = label;
  button.append(createToolbarIcon(icon));
  button.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (button.disabled) return;
    button.disabled = true;
    try {
      await onClick(button);
    } finally {
      if (!persistDisabled) {
        button.disabled = false;
      }
    }
  });
  return button;
}

function buildUnfollowButton(postContainer: Element, profile: ProfileRef): HTMLButtonElement {
  return buildOwnedToolbarButton(
    'user-minus',
    `Ne plus suivre ${profile.name} (Aufwieder-zen)`,
    async () => {
      console.log(`${LOG_PREFIX} Unfollow clicked for: "${profile.name}" | URL: ${profile.profileUrl ?? 'null'}`);
      await performUnfollow(profile, postContainer);
    },
  );
}

function buildBlockButton(postContainer: Element, profile: ProfileRef): HTMLButtonElement {
  const button = buildOwnedToolbarButton(
    'ban',
    `Bloquer ${profile.name} (Aufwieder-zen)`,
    async (blockButton) => {
      const profileUrl = profile.profileUrl;
      if (!profileUrl) return;
      console.log(`${LOG_PREFIX} Block clicked for: "${profile.name}" | URL: ${profileUrl}`);
      await performBlock(profile.name, profileUrl, postContainer, blockButton);
    },
    true,
    true,
  );
  if (!profile.profileUrl) {
    button.disabled = true;
    button.title = 'Missing profile URL for this post';
    console.warn(`${LOG_PREFIX} "Block" disabled: missing profile URL for`, profile.name);
  }
  return button;
}

/**
 * Finds the rightmost native action button (LinkedIn's "..." menu, hide
 * button, or follow/connect button) in a header row, so a Block-only
 * toolbar can be inserted immediately after Follow/Connect on original-
 * author rows that have no overflow/hide chrome.
 */
function findLastNativeActionButton(headerElement: Element): HTMLElement | null {
  const buttons = Array.from(headerElement.querySelectorAll<HTMLElement>('button[aria-label], a[aria-label]'));
  return buttons.length > 0 ? (buttons[buttons.length - 1] ?? null) : null;
}

/**
 * Tags the nearest real layout parent of the toolbar. LinkedIn's hashed
 * atomic CSS often uses a column flex (so the toolbar stacks under long
 * Follow/Connect labels) and `align-items: start` on liked/reshare
 * headers. content.css then forces a centered horizontal row.
 * `display: contents` shims and the toolbar itself are skipped so the
 * class lands on the box that actually lays out the children.
 */
function tagActionsLayoutHost(start: HTMLElement): void {
  let current: HTMLElement | null = start;
  while (current) {
    if (current.classList.contains(TOOLBAR_CLASS)) {
      current = current.parentElement;
      continue;
    }
    if (window.getComputedStyle(current).display === 'contents') {
      current = current.parentElement;
      continue;
    }
    current.classList.add(ACTIONS_HOST_CLASS);
    return;
  }
}

function appendToolbarGroup(toolbar: HTMLElement, buttons: HTMLElement[]): void {
  if (buttons.length === 0) return;
  const group = document.createElement('div');
  group.className = TOOLBAR_GROUP_CLASS;
  group.append(...buttons);
  toolbar.append(group);
}

function injectActionButtons(
  postContainer: Element,
  headerElement: Element,
  profile: ProfileRef,
  markerId: string,
  includeUnfollow: boolean,
  pinToCardCorner: boolean,
): void {
  if (headerElement.querySelector(`[${INJECTED_MARKER_ATTR}="${markerId}"]`)) {
    return; // already injected for this header
  }
  if (pinToCardCorner && postContainer.querySelector(`[${INJECTED_MARKER_ATTR}="${markerId}"]`)) {
    return;
  }

  const toolbar = document.createElement('div');
  toolbar.className = pinToCardCorner ? `${TOOLBAR_CLASS} ${DIRECT_TOOLBAR_CLASS}` : TOOLBAR_CLASS;
  toolbar.setAttribute(INJECTED_MARKER_ATTR, markerId);

  const menuButton = findOpenPostMenuButton(headerElement);
  const hideButton = findHidePostButton(headerElement);
  const firstNative = menuButton ?? hideButton;

  if (pinToCardCorner) {
    postContainer.classList.add(DIRECT_POST_CLASS);
    if (headerElement instanceof HTMLElement) {
      headerElement.classList.add(DIRECT_HEADER_CLASS);
    }
    postContainer.append(toolbar);
  } else if (firstNative) {
    firstNative.insertAdjacentElement('beforebegin', toolbar);
  } else {
    const lastNativeButton = findLastNativeActionButton(headerElement);
    if (lastNativeButton) {
      lastNativeButton.insertAdjacentElement('afterend', toolbar);
    } else {
      headerElement.appendChild(toolbar);
    }
  }

  const nativeButtons: HTMLElement[] = [];
  if (menuButton) {
    adoptNativeToolbarButton(menuButton, 'more-horizontal', OPTIONS_BUTTON_LABEL);
    nativeButtons.push(menuButton);
  }
  if (hideButton) {
    adoptNativeToolbarButton(hideButton, 'x');
    nativeButtons.push(hideButton);
  }
  const ownedButtons: HTMLElement[] = [];
  if (includeUnfollow) {
    ownedButtons.push(buildUnfollowButton(postContainer, profile));
  }
  ownedButtons.push(buildBlockButton(postContainer, profile));
  appendToolbarGroup(toolbar, nativeButtons);
  appendToolbarGroup(toolbar, ownedButtons);

  if (!pinToCardCorner) {
    tagActionsLayoutHost(toolbar);
  }

  console.log(`${LOG_PREFIX} injected toolbar (${markerId}, includeUnfollow=${includeUnfollow}, pinToCardCorner=${pinToCardCorner}) for`, profile);
}

function processParsedPost(parsed: ParsedLinkedInPost): void {
  if (parsed.author && parsed.authorElement && isPersonAuthor(parsed.author)) {
    injectActionButtons(
      parsed.container,
      parsed.authorElement,
      parsed.author,
      'author',
      true,
      parsed.type === 'direct',
    );
  }

  const isReshare = parsed.type === 'repost' || parsed.type === 'liked';
  if (isReshare && parsed.originalAuthor && parsed.originalAuthorElement && isPersonAuthor(parsed.originalAuthor)) {
    injectActionButtons(
      parsed.container,
      parsed.originalAuthorElement,
      parsed.originalAuthor,
      'originalAuthor',
      false,
      false,
    );
  }
}

function processContainer(container: Element): void {
  if (container.hasAttribute(PROCESSED_ATTR)) return;
  container.setAttribute(PROCESSED_ATTR, 'true');
  processParsedPost(parseLinkedInPost(container));
}

function scanFeedForNewPosts(): void {
  if (!enabled) return;
  findPostContainers(document).forEach(processContainer);
}

/**
 * Coalesces bursts of feed mutations (LinkedIn's infinite scroll appends
 * many nodes at once) into a single scan per microtask tick, instead of
 * re-scanning on every individual DOM change.
 */
function scheduleScan(): void {
  if (scanScheduled) return;
  scanScheduled = true;
  queueMicrotask(() => {
    scanScheduled = false;
    scanFeedForNewPosts();
  });
}

function removeInjectedButtons(): void {
  document.querySelectorAll(`.${TOOLBAR_CLASS}`).forEach((toolbar) => {
    const parent = toolbar.parentNode;
    toolbar.querySelectorAll(`.${TOOLBAR_BTN_CLASS}`).forEach((child) => {
      if (!(child instanceof HTMLElement)) {
        child.remove();
        return;
      }
      if (child.hasAttribute(OWNED_BTN_ATTR)) {
        child.remove();
        return;
      }
      restoreNativeToolbarButton(child);
      parent?.insertBefore(child, toolbar);
    });
    toolbar.remove();
  });
  document.querySelectorAll(`.${ACTIONS_HOST_CLASS}`).forEach((el) => el.classList.remove(ACTIONS_HOST_CLASS));
  document.querySelectorAll(`.${DIRECT_POST_CLASS}`).forEach((el) => el.classList.remove(DIRECT_POST_CLASS));
  document.querySelectorAll(`.${DIRECT_HEADER_CLASS}`).forEach((el) => el.classList.remove(DIRECT_HEADER_CLASS));
  document.querySelectorAll(`[${PROCESSED_ATTR}]`).forEach((el) => el.removeAttribute(PROCESSED_ATTR));
  console.log(`${LOG_PREFIX} removed previously injected toolbars`);
}

function startObserving(): void {
  scanFeedForNewPosts();

  if (observer) return;
  observer = new MutationObserver(() => scheduleScan());
  observer.observe(document.body, { childList: true, subtree: true });
  console.log(`${LOG_PREFIX} started observing the feed for new posts`);
}

function stopObserving(): void {
  observer?.disconnect();
  observer = null;
  console.log(`${LOG_PREFIX} stopped observing the feed`);
}

function applyEnabledState(nextEnabled: boolean): void {
  enabled = nextEnabled;
  if (enabled) {
    startObserving();
  } else {
    stopObserving();
    removeInjectedButtons();
  }
}

chrome.runtime.onMessage.addListener(
  (message: { type: string; state?: CuratorState; requestId?: string; success?: boolean; reason?: string }) => {
    if (message?.type === 'STATE_UPDATED' && message.state) {
      applyEnabledState(message.state.enableButtonsInFeed);
      return;
    }

    if (message?.type === 'BLOCK_PROFILE_RESULT' && message.requestId) {
      void handleBlockProfileResult(message.requestId, message.success ?? false, message.reason);
    }
  },
);

onStateChanged((state) => {
  applyEnabledState(state.enableButtonsInFeed);
});

async function init(): Promise<void> {
  const state = await getState();
  applyEnabledState(state.enableButtonsInFeed);
}

init();
