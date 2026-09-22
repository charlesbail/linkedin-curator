/**
 * Content script: injects "Unfollow"/"Unfollow (API)"/"Block" quick-action
 * buttons into feed post headers as the user scrolls. DOM manipulation and
 * injection only — post classification/parsing lives in
 * utils/domParsers.ts, and the on/off state lives in utils/storage.ts.
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
const BUTTON_CLASS = 'aufwiederzen-action-btn';
const DANGER_BUTTON_CLASS = 'aufwiederzen-action-btn--danger';
const GHOST_BUTTON_CLASS = 'aufwiederzen-action-btn--ghost';

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
 * actions that have no LinkedIn UI of their own to react to (the direct
 * API unfollow, and the cross-tab block flow).
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

// --- Voyager/SDUI "unfollow" API ------------------------------------------

/**
 * Reads the CSRF token LinkedIn's own internal APIs require from the
 * `JSESSIONID` cookie. On linkedin.com this cookie's value is normally
 * already the quoted token itself (e.g. `"ajax:-6808756743868471872"`),
 * so we just strip the surrounding quotes; we still add an `ajax:` prefix
 * defensively in case a future cookie format drops it.
 */
function getCsrfToken(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)JSESSIONID=("?)([^;]*)\1/);
  const raw = match?.[2] ? decodeURIComponent(match[2]).trim() : '';
  if (!raw) return null;
  return raw.startsWith('ajax:') ? raw : `ajax:${raw}`;
}

const UNFOLLOW_API_URL =
  'https://www.linkedin.com/flagship-web/rsc-action/actions/server-request?sduiid=com.linkedin.sdui.requests.feed.updateFollowState';

/**
 * Exact body LinkedIn's own client sends for this SDUI action, kept as a
 * raw string (rather than rebuilt as an object literal) so we don't risk
 * drifting from its precise shape (proto `$type` discriminators, the
 * embedded French toast copy, etc). The two placeholder ids below are
 * swapped for the real memberId/activityId — each appears twice in the
 * payload (once under `serverRequest`, once at the top level) and both
 * occurrences need to change.
 */
const UNFOLLOW_API_BODY_TEMPLATE =
  '{"requestId":"com.linkedin.sdui.requests.feed.updateFollowState","serverRequest":{"requestId":"com.linkedin.sdui.requests.feed.updateFollowState","requestedArguments":{"$type":"proto.sdui.actions.requests.RequestedArguments","requestedStateKeys":[],"payload":{"followStateType":"FollowStateType_UNFOLLOW","memberUrn":{"memberId":"676616964"},"memberFirstName":"","memberLastName":"","memberVanityName":"","memberNonIterableProfileId":"","memberProfileCanonicalUrl":"","hasConnection":true,"updateKey":{"feedType":71,"items":[{"feedUpdateUrn":{"updateUrnActivityUrn":{"activityUrn":{"activityId":"7508142094625021952"}}},"trackingId":""}],"isVideoCarousel":false},"controlActionContainerType":{"type":"com.linkedin.sdui.platform.api.feed.controlmenu.ControlMenuActionSource","value":{}}},"requestMetadata":{"$type":"proto.sdui.common.RequestMetadata"}}},"onClientRequestFailureAction":{"actions":[{"$type":"proto.sdui.actions.core.ShowToast","value":{"duration":"ToastDuration_UNKNOWN","key":"93a772c1-bff5-482a-b918-23f36f9a16d0","presetToast":{"category":"ToastPresetCategory_ERROR","text":["Une erreur s’est produite. Veuillez essayer de nouveau."]}}}]},"isApfcEnabled":false,"isStreaming":false,"rumPageKey":""},"states":[],"requestedArguments":{"$type":"proto.sdui.actions.requests.RequestedArguments","requestedStateKeys":[],"payload":{"followStateType":"FollowStateType_UNFOLLOW","memberUrn":{"memberId":"676616964"},"memberFirstName":"","memberLastName":"","memberVanityName":"","memberNonIterableProfileId":"","memberProfileCanonicalUrl":"","hasConnection":true,"updateKey":{"feedType":71,"items":[{"feedUpdateUrn":{"updateUrnActivityUrn":{"activityUrn":{"activityId":"7508142094625021952"}}},"trackingId":""}],"isVideoCarousel":false},"controlActionContainerType":{"type":"com.linkedin.sdui.platform.api.feed.controlmenu.ControlMenuActionSource","value":{}}},"requestMetadata":{"$type":"proto.sdui.common.RequestMetadata"},"states":[],"screenId":"","knownTemplateIds":[]}}';

function buildUnfollowRequestBody(memberId: string, activityId: string): string {
  return UNFOLLOW_API_BODY_TEMPLATE.replaceAll('676616964', memberId).replaceAll(
    '7508142094625021952',
    activityId,
  );
}

/**
 * Unfollows a person by calling LinkedIn's internal Voyager/SDUI endpoint
 * directly, bypassing the "..." menu entirely. On a confirmed `res.ok` we
 * show a success toast then call the same `fadeOutAndHide` the click-
 * simulation path uses; on any failure (bad status or thrown error) we
 * show an error toast and leave the post untouched.
 */
async function unfollowUserAPI(memberId: string, activityId: string, postContainer: Element): Promise<void> {
  console.log(`${LOG_PREFIX} unfollowUserAPI: starting for memberId=${memberId} activityId=${activityId}`);

  const csrfToken = getCsrfToken();
  if (!csrfToken) {
    console.warn(`${LOG_PREFIX} unfollowUserAPI: no CSRF token found (missing JSESSIONID cookie)`);
    showToast('Unfollow failed: missing CSRF token', 'error');
    return;
  }

  try {
    const res = await fetch(UNFOLLOW_API_URL, {
      headers: {
        accept: '*/*',
        'content-type': 'application/json',
        'csrf-token': csrfToken,
        'x-li-rsc-stream': 'true',
      },
      referrer: 'https://www.linkedin.com/feed/',
      body: buildUnfollowRequestBody(memberId, activityId),
      method: 'POST',
      mode: 'cors',
      credentials: 'include',
    });

    if (!res.ok) {
      console.warn(`${LOG_PREFIX} unfollowUserAPI: request failed with status ${res.status}`);
      showToast('Unfollow failed', 'error');
      return;
    }

    console.log(`${LOG_PREFIX} unfollowUserAPI: unfollowed member ${memberId} successfully`);
    showToast('Unfollowed successfully', 'success');
    await fadeOutAndHide(postContainer);
  } catch (error) {
    console.warn(`${LOG_PREFIX} unfollowUserAPI: request threw`, error);
    showToast('Unfollow failed', 'error');
  }
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

function buildActionButtons(postContainer: Element, profile: ProfileRef, activityId: string | null): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = ACTIONS_CLASS;

  const unfollowButton = document.createElement('button');
  unfollowButton.type = 'button';
  unfollowButton.className = BUTTON_CLASS;
  unfollowButton.textContent = 'Unfollow';
  unfollowButton.setAttribute('aria-label', `Ne plus suivre ${profile.name} (Aufwieder-zen)`);
  unfollowButton.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (unfollowButton.disabled) return;
    unfollowButton.disabled = true;
    try {
      await performUnfollow(profile, postContainer);
    } finally {
      unfollowButton.disabled = false;
    }
  });

  // Second entry point for the same action, calling LinkedIn's internal
  // API directly instead of driving its "..." menu. Kept side-by-side
  // with the click-simulation button above so both approaches can be
  // compared/tested independently.
  const unfollowApiButton = document.createElement('button');
  unfollowApiButton.type = 'button';
  unfollowApiButton.className = `${BUTTON_CLASS} ${GHOST_BUTTON_CLASS}`;
  unfollowApiButton.textContent = 'Unfollow (API)';
  unfollowApiButton.setAttribute('aria-label', `Ne plus suivre ${profile.name} via l'API (Aufwieder-zen)`);
  if (!profile.memberId || !activityId) {
    unfollowApiButton.disabled = true;
    unfollowApiButton.title = 'Missing memberId/activityId for this post';
    console.warn(`${LOG_PREFIX} "Unfollow (API)" disabled: missing id(s) for`, {
      name: profile.name,
      memberId: profile.memberId,
      activityId,
    });
  } else {
    const memberId = profile.memberId;
    unfollowApiButton.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (unfollowApiButton.disabled) return;
      unfollowApiButton.disabled = true;
      try {
        await unfollowUserAPI(memberId, activityId, postContainer);
      } finally {
        unfollowApiButton.disabled = false;
      }
    });
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
      if (blockButton.disabled) return;
      blockButton.disabled = true;
      try {
        await performBlock(profile.name, profileUrl, postContainer);
      } finally {
        blockButton.disabled = false;
      }
    });
  }

  wrapper.append(unfollowButton, unfollowApiButton, blockButton);
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

function injectActionButtons(
  postContainer: Element,
  headerElement: Element,
  profile: ProfileRef,
  markerId: string,
  activityId: string | null,
): void {
  if (headerElement.querySelector(`[${INJECTED_MARKER_ATTR}="${markerId}"]`)) {
    return; // already injected for this header
  }

  const wrapper = buildActionButtons(postContainer, profile, activityId);
  wrapper.setAttribute(INJECTED_MARKER_ATTR, markerId);

  const lastNativeButton = findLastNativeActionButton(headerElement);
  if (lastNativeButton) {
    lastNativeButton.insertAdjacentElement('afterend', wrapper);
  } else {
    headerElement.appendChild(wrapper);
  }

  console.log(`${LOG_PREFIX} injected buttons (${markerId}) for`, profile);
}

function processParsedPost(parsed: ParsedLinkedInPost): void {
  if (parsed.author && parsed.authorElement && isPersonAuthor(parsed.author)) {
    injectActionButtons(parsed.container, parsed.authorElement, parsed.author, 'author', parsed.activityId);
  }

  const isReshare = parsed.type === 'repost' || parsed.type === 'liked';
  if (isReshare && parsed.originalAuthor && parsed.originalAuthorElement && isPersonAuthor(parsed.originalAuthor)) {
    injectActionButtons(
      parsed.container,
      parsed.originalAuthorElement,
      parsed.originalAuthor,
      'originalAuthor',
      parsed.activityId,
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
  document.querySelectorAll(`.${ACTIONS_CLASS}`).forEach((el) => el.remove());
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
