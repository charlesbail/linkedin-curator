/**
 * DOM-reading utilities for LinkedIn feed posts.
 *
 * Read-only: nothing here mutates the DOM or calls chrome.* APIs, so it's
 * safe to unit test against static HTML fixtures (see linkedin-dom-mocks/)
 * and to reuse from content_scripts once wired up.
 *
 * LinkedIn ships obfuscated, auto-generated class names (e.g. `_1957d19a`)
 * that are re-randomized on every deploy â€” they must never be used as
 * selectors. Instead, every heuristic below anchors on things LinkedIn
 * can't easily randomize without breaking accessibility or i18n:
 *   - ARIA labels (e.g. "Masquer le post de {name}")
 *   - `role` attributes (e.g. role="listitem")
 *   - structural relationships (header row -> <hr> -> original-author row)
 *   - visible text fallbacks (e.g. "aime ce contenu")
 *
 * Locale note: LinkedIn is currently viewed in French, so the text
 * fallbacks below match French phrasing. Extend the pattern lists as more
 * locales/reaction verbs are observed.
 */
import { normalizeText } from './parsing';

const LOG_PREFIX = '[Aufwieder-zen:domParsers]';

export type PostType = 'direct' | 'repost' | 'liked' | 'unknown';

/** Whether a profile link points at a person (`/in/...`) or a company
 *  page (`/company/...`). `unknown` means no linkable profile was found. */
export type AuthorKind = 'person' | 'company' | 'unknown';

/** A person or company referenced by a post: the author, reposter, or liker. */
export interface ProfileRef {
  name: string;
  profileUrl: string | null;
  kind: AuthorKind;
}

/** Structured result of parsing a single feed post. */
export interface ParsedLinkedInPost {
  type: PostType;
  container: Element;
  /** The person shown in the top header: the post's own author for a
   *  Direct post, or the person who reposted/liked/commented for a
   *  Repost/Liked post. */
  author: ProfileRef | null;
  /** The header-row element `author` was extracted from, exposed so
   *  callers (e.g. feedInjector) can inject UI next to it without
   *  re-implementing this module's DOM traversal. Null iff no header row
   *  could be located. */
  authorElement: Element | null;
  /** The person who wrote the original post. Only set for Repost/Liked
   *  posts; null for Direct posts. */
  originalAuthor: ProfileRef | null;
  /** The header-row element `originalAuthor` was extracted from. Null for
   *  Direct posts, or if no original-author row could be located. */
  originalAuthorElement: Element | null;
}

/** Matches LinkedIn's "..." and hide-post buttons, which exist on every
 *  post type and always mention the post's author by name. This is one of
 *  the most stable anchors available since it's driven by accessibility
 *  requirements, not styling. */
const HIDE_POST_BUTTON_PATTERN = /^Masquer (?:le|les) posts? de\s+(.+)$/i;
const OPEN_POST_MENU_BUTTON_PATTERN = /^Ouvrir le menu de commandes pour le post de\s+(.+)$/i;

/** Text phrases LinkedIn renders next to the actor's name to describe what
 *  they did. Presence of one of these in the header row is what turns a
 *  post into a "Repost" or "Liked" post instead of a "Direct" one. */
const REPOST_TEXT_PATTERNS = [
  /a ajout[Ã©e] un commentaire/i,
  /a repost[Ã©e] ceci/i,
  /a republi[Ã©e] ceci/i,
  /a partag[Ã©e] ceci/i,
];

const LIKED_TEXT_PATTERNS = [
  /aime\s+ce/i, // matches: "aime ce contenu", "aime cela", "aime ceci"
  /trouve\s+ce.*?pertinent/i, // matches: "trouve ce... pertinent"
  /trouve\s+ce.*?dr[Ã´o]le/i, // matches: "trouve ce... drÃ´le/drole"
  /trouve\s+ce.*?inspirant/i, // matches: "trouve ce... inspirant"
  /trouve\s+ce.*?instructif/i, // matches: "trouve ce contenu instructif"
  /c[Ã©e]l[Ã¨e]bre\s+ce/i, // matches: "cÃ©lÃ¨bre ce contenu", "cÃ©lÃ¨bre cela", "cÃ©lÃ¨bre ceci"
  /soutient\s+ce/i, // matches: "soutient ce contenu", "soutient cela", "soutient ceci"
  /adore\s+ce/i, // matches: "adore ce contenu", "adore cela", "adore ceci"
];

const PROFILE_URL_PATTERN = /(?:^\/in\/)|(?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/)/i;
const COMPANY_URL_PATTERN = /(?:^\/company\/)|(?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/company\/)/i;

function isProfileUrl(href: string): boolean {
  return PROFILE_URL_PATTERN.test(href);
}

function isCompanyUrl(href: string): boolean {
  return COMPANY_URL_PATTERN.test(href);
}

function classifyAuthorUrl(href: string | null): AuthorKind {
  if (!href) return 'unknown';
  if (isProfileUrl(href)) return 'person';
  if (isCompanyUrl(href)) return 'company';
  return 'unknown';
}

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/** Finds every "hide this post" button under root, regardless of case. */
function findHidePostButtons(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('button[aria-label]')).filter((button) =>
    HIDE_POST_BUTTON_PATTERN.test(button.getAttribute('aria-label') ?? ''),
  );
}

/** Finds every "..." (open post command menu) button under root. */
function findOpenPostMenuButtons(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('button[aria-label]')).filter((button) =>
    OPEN_POST_MENU_BUTTON_PATTERN.test(button.getAttribute('aria-label') ?? ''),
  );
}

/**
 * Finds the "..." button that opens a post's command/overflow menu,
 * scoped to a post container (or any of its descendants). Exported so
 * callers (e.g. feedInjector) can programmatically open the menu without
 * duplicating this module's aria-label pattern matching.
 */
export function findOpenPostMenuButton(root: ParentNode): HTMLElement | null {
  return findOpenPostMenuButtons(root)[0] ?? null;
}

/**
 * Finds the "Masquer le post de {name}" (hide) button, scoped to a post
 * container or header row. Exported so feedInjector can adopt the native
 * control into the shared header toolbar without duplicating ARIA matching.
 */
export function findHidePostButton(root: ParentNode): HTMLElement | null {
  return findHidePostButtons(root)[0] ?? null;
}

/**
 * Climbs from a "hide this post" button to the post's root container.
 *
 * Prefers the nearest `role="listitem"` ancestor â€” LinkedIn's own
 * structural marker for a feed entry â€” since real feed markup often
 * inserts extra layout-only wrapper divs (e.g. `data-display-contents`)
 * between the header row and the actual post root, and the number of such
 * wrappers isn't stable across post shapes.
 *
 * Falls back to a fixed two-level climb (button -> header row -> its
 * parent) for isolated post fragments that don't include a `role`
 * wrapper at all (observed in some Repost markup excerpts).
 */
function resolvePostRootFromHideButton(button: HTMLElement): Element | null {
  const listItemAncestor = button.closest('[role="listitem"]');
  if (listItemAncestor) return listItemAncestor;

  const headerRow = button.parentElement;
  const postRoot = headerRow?.parentElement ?? headerRow;
  return postRoot ?? null;
}

/**
 * Locates candidate post containers within a root (defaults to the whole
 * document). Combines two independent signals so a change to either one
 * alone doesn't break detection:
 *   1. Elements exposing `role="listitem"` that also contain a profile
 *      link (LinkedIn's structural role for a feed entry).
 *   2. Elements reached by climbing up from a "hide this post" button
 *      (ARIA-label based, works even when no `role="listitem"` is present).
 */
export function findPostContainers(root: ParentNode = document): Element[] {
  const containers = new Set<Element>();

  root.querySelectorAll('[role="listitem"]').forEach((el) => {
    if (el.querySelector(`a[href*="linkedin.com/in/"], a[href^="/in/"]`)) {
      containers.add(el);
    }
  });

  findHidePostButtons(root).forEach((button) => {
    const postRoot = resolvePostRootFromHideButton(button);
    if (postRoot) containers.add(postRoot);
  });

  const result = Array.from(containers);
  console.log(`${LOG_PREFIX} findPostContainers: found ${result.length} candidate post container(s)`);
  return result;
}

/**
 * Returns the header row of a post: the block containing the actor's name,
 * the optional "did X" phrase, and the "..."/hide buttons. This is where
 * we look to both classify the post type and extract the top-line author.
 * Exported so callers (e.g. feedInjector) can inject UI next to it without
 * re-implementing this traversal themselves.
 */
export function getActorHeaderRow(container: Element): Element | null {
  const hideButton = findHidePostButtons(container)[0];
  if (hideButton?.parentElement) return hideButton.parentElement;

  // Fallback: no hide button found (locale/markup drift) â€” try the
  // "open post menu" button, which lives in the same row.
  const menuButton = findOpenPostMenuButtons(container)[0];
  return menuButton?.parentElement ?? null;
}

/**
 * Returns the "original author" row for Repost/Liked posts: LinkedIn
 * renders it as the element immediately following the `<hr>` divider that
 * separates the actor's header from the original post. Exported for the
 * same reason as `getActorHeaderRow` above.
 */
export function getOriginalAuthorHeaderRow(container: Element): Element | null {
  const divider = container.querySelector('hr[role="presentation"], hr');
  const next = divider?.nextElementSibling ?? null;
  return next;
}

/** Finds the first link pointing at a LinkedIn profile or company page
 *  within a block. Matching both lets us report `kind: 'company'` instead
 *  of silently dropping the link when a post's actor is a company page. */
function findActorAnchor(block: Element): HTMLAnchorElement | null {
  return (
    Array.from(block.querySelectorAll<HTMLAnchorElement>('a[href]')).find((anchor) => {
      const href = anchor.getAttribute('href') ?? '';
      return isProfileUrl(href) || isCompanyUrl(href);
    }) ?? null
  );
}

/**
 * LinkedIn appends relationship/status suffixes to the visible name
 * ("AurÃ©lien Marrast â€¢ Suivi", "Dan Saffer VÃ©rifiÃ©"). The feed "..." menu
 * only prints the bare name ("Ne plus suivre AurÃ©lien Marrast"), so we
 * keep the part before the first bullet/pipe.
 */
function barePersonName(raw: string): string {
  const normalized = normalizeText(raw);
  const beforeStatus = normalized.split(/\s*[â€¢|]\s*/)[0] ?? normalized;
  return beforeStatus.replace(/\s+VÃ©rifiÃ©.*$/i, '').trim();
}

/**
 * Extracts a person's display name from a header block.
 *
 * LinkedIn isn't consistent about where the name text lives relative to
 * the profile link: sometimes it's inside the anchor (wrapping a
 * <strong>/<span>), sometimes the anchor only wraps the avatar image and
 * the name is a sibling <span>. We therefore try the anchor's own text
 * first, then fall back to the first non-empty <strong>/<span> in the
 * block that isn't itself a "did X" action phrase or a metadata line
 * (LinkedIn puts headline/timestamp text inside <p> tags, which we skip).
 */
function extractNameFromBlock(block: Element, anchor: HTMLAnchorElement | null): string {
  const anchorText = barePersonName(anchor?.textContent ?? '');
  // Avatar-only anchors have no text. Anchors that wrap the whole actor
  // card have a headline and timestamp mixed in; those are too long to be
  // a display name, so fall through to a shorter <strong>/<span>.
  if (anchorText && anchorText.length <= 80) return anchorText;

  const candidates = Array.from(block.querySelectorAll('strong, span'))
    .map((el) => barePersonName(el.textContent ?? ''))
    .filter(
      (text) =>
        text.length > 0 &&
        text.length <= 80 &&
        !matchesAny(text, REPOST_TEXT_PATTERNS) &&
        !matchesAny(text, LIKED_TEXT_PATTERNS),
    );

  return candidates[0] ?? '';
}

function extractProfileRef(block: Element | null, label: string): ProfileRef | null {
  if (!block) {
    console.log(`${LOG_PREFIX} extractProfileRef: no "${label}" block found`);
    return null;
  }

  const anchor = findActorAnchor(block);
  const name = extractNameFromBlock(block, anchor);
  const profileUrl = anchor?.getAttribute('href') ?? null;
  const kind = classifyAuthorUrl(profileUrl);

  if (!name && !profileUrl) {
    console.warn(`${LOG_PREFIX} extractProfileRef: could not find "${label}" in block`, block);
    return null;
  }

  const ref: ProfileRef = { name, profileUrl, kind };
  console.log(`${LOG_PREFIX} extractProfileRef: found ${label} ->`, ref);
  return ref;
}

/** True unless the profile is positively identified as a company page.
 *  Treats `unknown` as "not a company" so we don't silently withhold
 *  moderation actions just because a profile link couldn't be resolved. */
export function isPersonAuthor(ref: ProfileRef | null): boolean {
  return ref?.kind !== 'company';
}

/**
 * Determines whether a post is a Direct post, a Repost (share/"added a
 * comment"), or a Liked post ("X likes this"), based on the phrase next to
 * the actor's name in the header row.
 */
export function identifyPostType(container: Element): PostType {
  const headerRow = getActorHeaderRow(container);
  if (!headerRow) {
    console.warn(`${LOG_PREFIX} identifyPostType: no header row found; type is unknown`, container);
    return 'unknown';
  }

  const headerText = normalizeText(headerRow.textContent ?? '');

  if (matchesAny(headerText, REPOST_TEXT_PATTERNS)) {
    console.log(`${LOG_PREFIX} identifyPostType: detected "repost"`);
    return 'repost';
  }

  if (matchesAny(headerText, LIKED_TEXT_PATTERNS)) {
    console.log(`${LOG_PREFIX} identifyPostType: detected "liked"`);
    return 'liked';
  }

  console.log(`${LOG_PREFIX} identifyPostType: no repost/liked phrase found; defaulting to "direct"`);
  return 'direct';
}

/** Extracts the header-row author: the post's own author for Direct
 *  posts, or the person who reposted/liked/commented otherwise. */
export function extractAuthor(container: Element): ProfileRef | null {
  const headerRow = getActorHeaderRow(container);
  return extractProfileRef(headerRow, 'author');
}

/** Extracts the original post's author for Repost/Liked posts. Returns
 *  null for Direct posts (there is no separate original author). */
export function extractOriginalAuthor(container: Element): ProfileRef | null {
  const originalAuthorRow = getOriginalAuthorHeaderRow(container);
  return extractProfileRef(originalAuthorRow, 'original author');
}

/** Matches LinkedIn's "Unfollow" item inside a post's "..." command menu
 *  (see linkedin-dom-mocks/feed-submenu.html.html), capturing the name of
 *  the person it would unfollow. */
const UNFOLLOW_MENU_ITEM_PATTERN = /^Ne plus suivre\s+(.+)$/i;

function menuItemUnfollowName(item: HTMLElement): string | null {
  const match = UNFOLLOW_MENU_ITEM_PATTERN.exec(normalizeText(item.textContent ?? ''));
  return match?.[1] ? barePersonName(match[1]) : null;
}

/**
 * True when the menu item's "Ne plus suivre {name}" refers to the same
 * person. Comparison is bidirectional: the header name is often longer
 * than the menu label ("AurÃ©lien Marrast â€¢ Suivi" vs "AurÃ©lien Marrast").
 */
function unfollowNamesMatch(menuName: string, personName: string): boolean {
  const menu = menuName.toLowerCase();
  const person = barePersonName(personName).toLowerCase();
  if (!menu || !person) return false;
  return menu.includes(person) || person.includes(menu);
}

/**
 * Finds the "Ne plus suivre {name}" (Unfollow) item inside a currently
 * rendered command menu (`role="menuitem"`), matched against a target
 * person's name. LinkedIn appears to reuse a single global popover for
 * every post's "..." menu (repositioned per click), so `root` is usually
 * `document`. A repost/liked post's menu can list this item for either
 * the actor or the original author, so we match by name rather than
 * position.
 */
export function findUnfollowMenuItem(root: ParentNode, personName: string): HTMLElement | null {
  const candidates = Array.from(root.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    .map((item) => ({ item, menuName: menuItemUnfollowName(item) }))
    .filter((entry): entry is { item: HTMLElement; menuName: string } => entry.menuName !== null);

  const match =
    candidates.find((entry) => unfollowNamesMatch(entry.menuName, personName))?.item ??
    // The open menu belongs to the post whose "..." we just clicked, and
    // LinkedIn renders a single "Ne plus suivre â€¦" row for that actor.
    (candidates.length === 1 ? candidates[0]?.item : null) ??
    null;

  if (match) {
    console.log(
      `${LOG_PREFIX} findUnfollowMenuItem: found "Ne plus suivre" item for "${personName}" -> "${normalizeText(match.textContent ?? '')}"`,
    );
  } else if (candidates.length > 0) {
    console.warn(
      `${LOG_PREFIX} findUnfollowMenuItem: found "Ne plus suivre" item(s) but none matched "${personName}"`,
      candidates.map((entry) => normalizeText(entry.item.textContent ?? '')),
    );
  }

  return match;
}

/**
 * Identifies the post container passed in and fully parses it: type,
 * author, and (when applicable) original author. This is the main
 * entry point content scripts should call once they have a candidate
 * element (e.g. from `findPostContainers`).
 */
export function parseLinkedInPost(container: Element): ParsedLinkedInPost {
  const type = identifyPostType(container);
  const authorElement = getActorHeaderRow(container);
  const author = extractProfileRef(authorElement, 'author');

  const isReshare = type === 'repost' || type === 'liked';
  const originalAuthorElement = isReshare ? getOriginalAuthorHeaderRow(container) : null;
  const originalAuthor = isReshare ? extractProfileRef(originalAuthorElement, 'original author') : null;

  const parsed: ParsedLinkedInPost = {
    type,
    container,
    author,
    authorElement,
    originalAuthor,
    originalAuthorElement,
  };
  console.log(`${LOG_PREFIX} parseLinkedInPost: parsed post ->`, parsed);
  return parsed;
}
