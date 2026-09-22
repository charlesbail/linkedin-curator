/**
 * Content script: injects "Unfollow"/"Block" quick-action buttons into
 * feed post headers as the user scrolls. DOM manipulation and injection
 * only — post classification/parsing lives in utils/domParsers.ts, and
 * the on/off state lives in utils/storage.ts.
 *
 * Block is cross-tab: this script only sends a request to background.ts
 * (which opens a temporary profile tab and drives the actual block flow
 * there via blockAutomation.ts) and reacts to the result it relays back.
 */
import {
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
const ACTIONS_CLASS = 'aufwiederzen-actions';
const ACTIONS_HOST_CLASS = 'aufwiederzen-actions-host';
const BUTTON_CLASS = 'aufwiederzen-action-btn';
const DANGER_BUTTON_CLASS = 'aufwiederzen-action-btn--danger';

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
const pendingBlockRequests = new Map<string, Element>();

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
async function performBlock(name: string, profileUrl: string, postContainer: Element): Promise<void> {
  const requestId = generateRequestId();
  console.log(`${LOG_PREFIX} performBlock: requesting block for "${name}" (${requestId})`, profileUrl);
  pendingBlockRequests.set(requestId, postContainer);

  try {
    await chrome.runtime.sendMessage({ type: 'BLOCK_PROFILE_REQUEST', requestId, profileUrl, name });
  } catch (error) {
    console.warn(`${LOG_PREFIX} performBlock: failed to reach background`, error);
    pendingBlockRequests.delete(requestId);
    showToast('Block failed to start', 'error');
  }
}

async function handleBlockProfileResult(requestId: string, success: boolean, reason?: string): Promise<void> {
  const postContainer = pendingBlockRequests.get(requestId);
  pendingBlockRequests.delete(requestId);

  if (!postContainer) {
    console.warn(`${LOG_PREFIX} handleBlockProfileResult: no pending request for ${requestId}`);
    return;
  }

  if (success) {
    console.log(`${LOG_PREFIX} handleBlockProfileResult: success (${requestId})`);
    showToast('Blocked successfully', 'success');
    await fadeOutAndHide(postContainer);
  } else {
    console.warn(`${LOG_PREFIX} handleBlockProfileResult: failed (${requestId})`, reason);
    showToast('Block failed', 'error');
  }
}

function buildActionButtons(postContainer: Element, profile: ProfileRef, includeUnfollow: boolean): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = ACTIONS_CLASS;

  if (includeUnfollow) {
    const unfollowButton = document.createElement('button');
    unfollowButton.type = 'button';
    unfollowButton.className = BUTTON_CLASS;
    unfollowButton.textContent = 'Unfollow';
    unfollowButton.setAttribute('aria-label', `Ne plus suivre ${profile.name} (Aufwieder-zen)`);
    unfollowButton.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      console.log(`${LOG_PREFIX} Unfollow clicked for: "${profile.name}" | URL: ${profile.profileUrl ?? 'null'}`);
      if (unfollowButton.disabled) return;
      unfollowButton.disabled = true;
      try {
        await performUnfollow(profile, postContainer);
      } finally {
        unfollowButton.disabled = false;
      }
    });
    wrapper.append(unfollowButton);
  }

  const blockButton = document.createElement('button');
  blockButton.type = 'button';
  blockButton.className = `${BUTTON_CLASS} ${DANGER_BUTTON_CLASS}`;
  blockButton.textContent = 'Block';
  blockButton.setAttribute('aria-label', `Bloquer ${profile.name} (Aufwieder-zen)`);
  if (!profile.profileUrl) {
    blockButton.disabled = true;
    blockButton.title = 'Missing profile URL for this post';
    console.warn(`${LOG_PREFIX} "Block" disabled: missing profile URL for`, profile.name);
  } else {
    const profileUrl = profile.profileUrl;
    blockButton.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      console.log(`${LOG_PREFIX} Block clicked for: "${profile.name}" | URL: ${profileUrl}`);
      if (blockButton.disabled) return;
      blockButton.disabled = true;
      try {
        await performBlock(profile.name, profileUrl, postContainer);
      } finally {
        blockButton.disabled = false;
      }
    });
  }

  wrapper.append(blockButton);
  return wrapper;
}

/**
 * Finds the rightmost native action button (LinkedIn's "..." menu, hide
 * button, or follow/connect button) in a header row, so our buttons can be
 * inserted immediately after it — i.e. next to the existing controls,
 * without needing separate positioning logic per post type.
 */
function findLastNativeActionButton(headerElement: Element): HTMLElement | null {
  const buttons = Array.from(headerElement.querySelectorAll<HTMLElement>('button[aria-label], a[aria-label]'));
  return buttons.length > 0 ? (buttons[buttons.length - 1] ?? null) : null;
}

/**
 * Tags the nearest real layout parent of a native Follow/Connect/"..."
 * button. LinkedIn's hashed atomic CSS often uses a column flex (so Block
 * stacks under long labels) and `align-items: start` on liked/reshare
 * headers (so Unfollow/Block sit at the top). content.css then forces a
 * centered horizontal row. `display: contents` shims are skipped so the
 * class lands on the box that actually lays out the children.
 */
function tagActionsLayoutHost(nativeButton: HTMLElement): void {
  let current: HTMLElement | null = nativeButton.parentElement;
  while (current) {
    if (window.getComputedStyle(current).display === 'contents') {
      current = current.parentElement;
      continue;
    }
    current.classList.add(ACTIONS_HOST_CLASS);
    return;
  }
}

function injectActionButtons(
  postContainer: Element,
  headerElement: Element,
  profile: ProfileRef,
  markerId: string,
  includeUnfollow: boolean,
): void {
  if (headerElement.querySelector(`[${INJECTED_MARKER_ATTR}="${markerId}"]`)) {
    return; // already injected for this header
  }

  const wrapper = buildActionButtons(postContainer, profile, includeUnfollow);
  wrapper.setAttribute(INJECTED_MARKER_ATTR, markerId);

  const lastNativeButton = findLastNativeActionButton(headerElement);
  if (lastNativeButton) {
    lastNativeButton.insertAdjacentElement('afterend', wrapper);
    tagActionsLayoutHost(lastNativeButton);
  } else {
    headerElement.appendChild(wrapper);
  }

  console.log(`${LOG_PREFIX} injected buttons (${markerId}, includeUnfollow=${includeUnfollow}) for`, profile);
}

function processParsedPost(parsed: ParsedLinkedInPost): void {
  if (parsed.author && parsed.authorElement && isPersonAuthor(parsed.author)) {
    injectActionButtons(parsed.container, parsed.authorElement, parsed.author, 'author', true);
  }

  const isReshare = parsed.type === 'repost' || parsed.type === 'liked';
  if (isReshare && parsed.originalAuthor && parsed.originalAuthorElement && isPersonAuthor(parsed.originalAuthor)) {
    injectActionButtons(parsed.container, parsed.originalAuthorElement, parsed.originalAuthor, 'originalAuthor', false);
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
  document.querySelectorAll(`.${ACTIONS_CLASS}`).forEach((el) => el.remove());
  document.querySelectorAll(`.${ACTIONS_HOST_CLASS}`).forEach((el) => el.classList.remove(ACTIONS_HOST_CLASS));
  document.querySelectorAll(`[${PROCESSED_ATTR}]`).forEach((el) => el.removeAttribute(PROCESSED_ATTR));
  console.log(`${LOG_PREFIX} removed previously injected buttons`);
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
