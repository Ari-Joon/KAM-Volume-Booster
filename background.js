/**
 * background.js — MV3 service worker.
 *
 * Two jobs:
 *
 * 1. Tell a content script in an opaque-origin subframe what boost applies to
 *    its tab. Normal frames resolve the tab's origin themselves (via
 *    location.ancestorOrigins) and read storage directly; only sandboxed frames
 *    can't, and they ask here. sender.tab.url is the *top-level* tab URL even
 *    when the sender is a subframe, which is the origin the boost belongs to.
 *
 * 2. Keep the toolbar badge in step with the remembered boost whenever a tab
 *    loads a page. Boosts restore themselves silently on load, so without the
 *    badge a site can come back at 400% with nothing on screen to say so.
 *
 * The cost of job 2, stated plainly: the worker now wakes on page loads. In
 * 1.2.0 it almost never started, which was a deliberate efficiency choice. A
 * worker wake is a few milliseconds and Chrome keeps it alive briefly between
 * events, so the trade buys a visible safety signal for very little. The
 * per-tab badge has to be set from here because Chrome keeps it across
 * navigations — something must clear it when you leave a boosted site.
 *
 * The worker holds no state, so MV3 is free to evict it between events.
 */

importScripts("config.js");

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "GET_STORED_GAIN") return false;

  const origin = KAM_VB.originOf(sender.tab?.url);
  if (!origin) {
    // No persistable origin (file://, chrome://, no tab). Nothing remembered.
    sendResponse({ percent: KAM_VB.MIN_PERCENT });
    return false;
  }

  const key = KAM_VB.storageKey(origin);
  chrome.storage.local
    .get(key)
    .then((items) => sendResponse({ percent: items[key] ?? KAM_VB.MIN_PERCENT }))
    .catch(() => sendResponse({ percent: KAM_VB.MIN_PERCENT }));

  return true; // keep the channel open for the async sendResponse
});

/**
 * Set a tab's badge from the boost remembered for the page it's loading. This
 * is the same value the page's content script adopts, so the badge matches
 * what the tab is actually doing.
 * @param {number} tabId
 * @param {string} url
 */
async function showRememberedBoost(tabId, url) {
  const origin = KAM_VB.originOf(url);
  let percent = KAM_VB.MIN_PERCENT;
  if (origin) {
    const key = KAM_VB.storageKey(origin);
    try {
      percent = (await chrome.storage.local.get(key))[key] ?? KAM_VB.MIN_PERCENT;
    } catch (_) {
      /* fall through with no boost */
    }
  }
  const { text, color } = KAM_VB.badgeFor(percent);
  try {
    if (color) await chrome.action.setBadgeBackgroundColor({ tabId, color });
    await chrome.action.setBadgeText({ tabId, text });
  } catch (_) {
    // Tab closed between the event and here. Nothing to update.
  }
}

// "loading" fires once per page load, including reloads, which is exactly
// when the content script re-reads storage. Other updates (title, favicon,
// "complete") are ignored.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "loading" || !tab.url) return;
  showRememberedBoost(tabId, tab.url);
});
