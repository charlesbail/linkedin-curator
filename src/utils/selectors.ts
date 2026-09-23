/**
 * Centralized DOM selectors for LinkedIn's feed markup.
 *
 * LinkedIn ships frequent, unannounced markup changes. Keeping every
 * selector here means a markup change only requires an update in this one
 * file instead of hunting through content_scripts.
 */
export const FEED_SELECTORS = {
  /** Scrollable container that holds the main feed. */
  feedContainer: 'div.scaffold-finite-scroll__content',
  /** A single post/update card in the feed. */
  feedItem: 'div.feed-shared-update-v2',
  /** Text body of a post, used for keyword matching. */
  postText: '.feed-shared-update-v2__description, .update-components-text',
  /** Label shown on sponsored/promoted posts. */
  promotedLabel: '.update-components-actor__supplementary-actor-info',
  /** "X reacted to this" / "X commented on this" reshare header. */
  reshareHeader: '.update-components-header__text-view',
} as const;
