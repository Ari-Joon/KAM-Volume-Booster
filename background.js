/**
 * background.js — MV3 service worker.
 *
 * Single responsibility: tell a freshly loaded content script what boost, if
 * any, applies to its tab. This is what makes a boost survive a page reload,
 * an SPA hard navigation, and a browser restart.
 *
 * Pull, not push. The content script asks as soon as it runs (document_start,
 * every frame) and the worker answers. Pushing from chrome.tabs.onUpdated
 * instead would have to race the content script's readiness, enumerate frames
 * by hand, and would still miss iframes created after the page reports
 * "complete" — all of which the pull model gets for free, because every frame
 * asks on its own behalf when it exists.
 *
 * sender.tab.url is the *top-level* tab URL even when the sender is a
 * subframe. That's the origin we want: a boost belongs to the page the user
 * set it on, not to whatever third-party origin happens to host the player
 * iframe (Panopto, youtube-nocookie, ...).
 *
 * The worker holds no state and is idle between page loads, so MV3 is free to
 * evict it; the next content script simply wakes it again.
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
