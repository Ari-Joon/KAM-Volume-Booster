/**
 * popup.js
 *
 * Drives the popup UI and pushes gain changes to the content script in the
 * active tab. Messages are sent to ALL frames (the booster may live in an
 * iframe), and the content script is injected as a fallback for tabs that were
 * already open before the extension loaded.
 *
 * Boosts are remembered per origin in chrome.storage.local, so a site keeps its
 * preferred level across reloads and browser restarts. The content script picks
 * that value up on load; the popup only reads it back to show current state.
 *
 * The status line reports what the frames actually did (see summarize), not
 * what was requested — a boost the browser refused to apply must not be
 * reported as a boost.
 *
 * Depends on config.js (loaded immediately before it) for KAM_VB.
 */

const { MIN_PERCENT, MAX_PERCENT, STEP_PERCENT } = KAM_VB;

const slider = document.getElementById("slider");
const percentInput = document.getElementById("percent");
const toggleBtn = document.getElementById("toggle");
const statusEl = document.getElementById("status");

// Bounds come from shared config rather than markup, so the ceiling can't drift
// out of sync with the audio chain's tuning. See config.js.
for (const input of [slider, percentInput]) {
  input.min = String(MIN_PERCENT);
  input.max = String(MAX_PERCENT);
  input.step = String(STEP_PERCENT);
}

let tabId = null;

/**
 * chrome.storage.local key for the active tab's origin, or null when the page
 * has no persistable origin (file://, etc). Null means "boost still works,
 * just isn't remembered".
 */
let storageKey = null;

/** Clamp an arbitrary number into the valid percent range. */
function clamp(percent) {
  if (Number.isNaN(percent)) return MIN_PERCENT;
  return Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, Math.round(percent)));
}

/** Sync slider, input, and toggle-button to a percent. */
function reflect(percent) {
  slider.value = String(percent);
  percentInput.value = String(percent);
  const isOff = percent <= MIN_PERCENT;
  toggleBtn.textContent = isOff ? "Boost Off" : "Turn Off";
  toggleBtn.classList.toggle("is-off", isOff);
}

function setStatus(msg, isError = false) {
  if (!statusEl) return;
  statusEl.textContent = msg;
  statusEl.style.color = isError ? "#c0392b" : "#2e7d32";
}

/**
 * Ensure the content script is present in all frames, then message it.
 *
 * We inject first (executeScript is idempotent — the script's own
 * window.__volumeBooster guard prevents double-init) so there is always a
 * receiver before we send. A short retry covers the rare race where the
 * listener hasn't registered in the few ms after injection.
 *
 * @param {object} message
 * @returns {Promise<object[]>} one reply per frame that answered.
 */
async function sendToTab(message) {
  // Inject into all frames (idempotent; the __volumeBooster guard prevents
  // double-init) so a receiver exists even in cross-origin iframes. config.js
  // must come first — content.js reads KAM_VB at load.
  let frameIds = [];
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["config.js", "content.js"],
    });
    frameIds = results.map((r) => r.frameId);
  } catch (_) {
    // Injection can fail on privileged frames; fall back to top frame only.
  }

  // Send to each frame individually. tabs.sendMessage without a frameId only
  // reaches the top frame, so iframe-hosted players (e.g. Panopto) are missed.
  if (frameIds.length === 0) frameIds = [0];

  // Every reply is kept. Keeping only the last one let a frame that wired
  // nothing overwrite the frame that actually did the work.
  const responses = [];
  await Promise.all(
    frameIds.map(async (frameId) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await chrome.tabs.sendMessage(tabId, message, {
            frameId,
          });
          if (res) responses.push(res);
          return;
        } catch (err) {
          if (attempt === 2) return; // frame may have no listener; skip quietly
          await new Promise((r) => setTimeout(r, 60));
        }
      }
    })
  );
  return responses;
}

/**
 * Sum the per-frame tallies into one picture of the tab.
 * @param {object[]} responses
 * @returns {{wired: number, cors: number, failed: number}}
 */
function summarize(responses) {
  const total = { wired: 0, cors: 0, failed: 0 };
  for (const res of responses) {
    if (!res?.found) continue;
    for (const key of Object.keys(total)) total[key] += res.found[key] || 0;
  }
  return total;
}

/**
 * Turn the summary into an honest status line.
 *
 * "wired" is the only outcome that means audio is genuinely being boosted.
 * CORS-restricted media is a browser rule the extension can't work around, and
 * a pre-bound element needs a reload — both are worth saying out loud rather
 * than silently claiming success.
 *
 * @param {number} percent
 * @param {{wired: number, cors: number, failed: number}} total
 * @returns {{msg: string, error: boolean}}
 */
function statusFor(percent, total) {
  if (percent <= MIN_PERCENT) return { msg: "Boost off.", error: false };
  if (total.wired && (total.cors || total.failed)) {
    return { msg: `Boosting to ${percent}% · some media can't be boosted`, error: false };
  }
  if (total.wired) return { msg: `Boosting to ${percent}%`, error: false };
  if (total.cors) {
    return { msg: "This site blocks boosting (CORS restriction).", error: true };
  }
  if (total.failed) {
    return { msg: "Reload the page to boost this audio.", error: true };
  }
  // Nothing found yet. The boost is armed and will apply as soon as media
  // appears, so this is a wait, not a failure.
  return { msg: `Boosting to ${percent}% · waiting for audio`, error: false };
}

/**
 * Persist (or clear) the boost for this origin.
 *
 * 100% is stored as absence rather than as a value: it's the default, and
 * writing it would grow storage by one key per site the user ever visited with
 * the popup open.
 *
 * @param {number} percent
 */
async function persist(percent) {
  if (!storageKey) return;
  if (percent <= MIN_PERCENT) {
    await chrome.storage.local.remove(storageKey);
  } else {
    await chrome.storage.local.set({ [storageKey]: percent });
  }
}

/** Apply a percent: update UI, push to tab, persist per-origin. */
async function apply(percent) {
  percent = clamp(percent);
  reflect(percent);
  if (!tabId) return;

  try {
    const responses = await sendToTab({ type: "SET_GAIN", value: percent / 100 });
    await persist(percent);
    const { msg, error } = statusFor(percent, summarize(responses));
    setStatus(msg, error);
  } catch (err) {
    setStatus(`Failed: ${err.message}`, true);
    console.error("[Volume Booster] apply error:", err);
  }
}

// --- Events ---

slider.addEventListener("input", () => {
  percentInput.value = slider.value;
});

slider.addEventListener("change", () => {
  apply(Number(slider.value));
});

percentInput.addEventListener("change", () => {
  apply(clamp(Number(percentInput.value)));
});

percentInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") percentInput.blur();
});

toggleBtn.addEventListener("click", () => {
  apply(MIN_PERCENT);
});

// --- Init ---

(async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;

  const url = tab?.url || "";
  const restricted =
    /^(chrome|edge|brave|about|chrome-extension|view-source):/i.test(url) ||
    url.startsWith("https://chrome.google.com/webstore") ||
    url.startsWith("https://chromewebstore.google.com");

  if (!tabId || restricted) {
    // The percent field is type="number" — assigning a non-numeric string like
    // "—" throws. Blank it and let the placeholder show instead.
    percentInput.value = "";
    slider.disabled = true;
    percentInput.disabled = true;
    toggleBtn.disabled = true;
    toggleBtn.textContent = "Unavailable here";
    setStatus("Cannot boost this page.", true);
    return;
  }

  const origin = KAM_VB.originOf(url);
  storageKey = origin ? KAM_VB.storageKey(origin) : null;

  let percent = MIN_PERCENT;
  if (storageKey) {
    const stored = await chrome.storage.local.get(storageKey);
    percent = stored[storageKey] ?? MIN_PERCENT;
  }

  reflect(percent);

  if (percent <= MIN_PERCENT) {
    setStatus("Ready.");
    return;
  }

  // A boost is already running from a previous session. Ask the frames how it's
  // actually going rather than asserting it worked.
  setStatus(`Currently boosting to ${percent}%`);
  const responses = await sendToTab({ type: "GET_GAIN" });
  const { msg, error } = statusFor(percent, summarize(responses));
  setStatus(msg, error);
})();
