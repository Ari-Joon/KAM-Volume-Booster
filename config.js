/**
 * config.js
 *
 * Single source of truth for anything more than one context depends on.
 * Loaded by all three:
 *   - popup      via <script src> in popup.html (before popup.js)
 *   - content    via manifest content_scripts (before content.js), and via
 *                popup.js's executeScript fallback
 *   - worker     via importScripts in background.js
 *
 * The boost ceiling previously lived in three places (MAX_MULTIPLIER in
 * content.js, MAX_PERCENT in popup.js, and the slider/input max attributes in
 * popup.html) and had to be kept in sync by hand. Drift was silent: the UI
 * would happily request a boost the audio chain's level-dependent limiter
 * tuning had never been scaled for. The popup now sets its input bounds from
 * here at runtime, so there is nothing left to desync.
 *
 * Audio *tuning* constants deliberately stay in content.js — nothing else
 * needs them.
 */

// Assigned onto globalThis rather than declared with const/let: popup.js can
// re-inject this file into a frame that already has it, and a top-level const
// redeclaration in the same isolated world throws.
globalThis.KAM_VB = globalThis.KAM_VB || {
  /** Boost floor. 100% = unmodified audio = "off". */
  MIN_PERCENT: 100,

  /** Boost ceiling. The audio chain scales its limiter tuning up to this. */
  MAX_PERCENT: 400,

  /** Slider / number-input increment. */
  STEP_PERCENT: 10,

  /** chrome.storage.local key prefix for per-origin boosts. */
  STORAGE_PREFIX: "boost:",

  /**
   * Storage key for an origin's remembered boost.
   * @param {string} origin  e.g. "https://www.youtube.com"
   * @returns {string}
   */
  storageKey(origin) {
    return globalThis.KAM_VB.STORAGE_PREFIX + origin;
  },

  /**
   * Extract the origin we persist a boost under, or null if this URL has none
   * worth keying on.
   *
   * Only http(s) qualifies. file:// URLs report an origin of "null" in Chrome,
   * which would collapse every local file onto one shared key; chrome:// and
   * friends can't be boosted at all. Callers treat null as "boost this page,
   * but don't remember it".
   *
   * @param {string|undefined} url
   * @returns {string|null}
   */
  originOf(url) {
    if (!url) return null;
    try {
      const parsed = new URL(url);
      return parsed.protocol === "http:" || parsed.protocol === "https:"
        ? parsed.origin
        : null;
    } catch (_) {
      return null;
    }
  },

  /**
   * Toolbar badge for a boost level. Shared by the popup (after the user
   * changes the level) and the service worker (when a boosted site loads), so
   * both always render the same thing.
   *
   * The badge exists because boosts restore themselves silently on page load.
   * Without it a site can come back at 400% with nothing on screen to say so.
   * Colours follow the slider gradient so loud reads as loud.
   *
   * @param {number} percent
   * @returns {{text: string, color: string|null}} empty text clears the badge
   */
  badgeFor(percent) {
    if (!(percent > globalThis.KAM_VB.MIN_PERCENT)) return { text: "", color: null };
    const color = percent <= 200 ? "#2e7d32" : percent <= 300 ? "#b26a00" : "#c62828";
    return { text: `${percent}%`, color };
  },
};
