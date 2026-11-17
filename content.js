/**
 * content.js
 *
 * Boosts audio/video output beyond the native 100% ceiling using the Web Audio
 * API. Runs in every frame at document_start (declared in the manifest).
 *
 * Signal chain (gain-aware; see levelSettings):
 *   source -> subsonic HP -> gain -> soft clip -> limiter -> makeup -> output
 *
 * MEASURED CHAIN LATENCY: ~10.0 ms at 48 kHz (480 samples), made up of
 *   - 4.0 ms (192 smp) from the WaveShaper's 4x oversampling resamplers
 *   - 6.0 ms (288 smp) from DynamicsCompressorNode's internal lookahead
 * Both are fixed, not drift-prone, and sit under the ~20 ms A/V-sync detection
 * threshold. They are inherent to these nodes, not something this code adds.
 * Worth knowing before assuming any part of this graph is sample-aligned with
 * unprocessed audio — in particular, do not build a dry "bypass" path and
 * crossfade to it, because the two paths are 10 ms apart and the crossfade
 * flanges audibly.
 *
 * Element discovery, and what each mechanism actually reaches (measured):
 *   - one full scan when a boost is armed, re-run whenever the user moves the
 *     slider — reaches everything in light DOM and in open shadow roots
 *   - a MutationObserver on the document AND on every open shadow root found —
 *     MutationObserver never sees inside a shadow root it wasn't attached to,
 *     so each root needs its own observe() call
 *   - a "loadstart" listener on each discovered element — wires media whose
 *     source wasn't known yet, and catches later source switches
 * Closed shadow roots are unreachable from an extension. So are web components
 * whose shadow content renders after the scan without any light-DOM mutation;
 * moving the slider rescans and picks those up.
 *
 * On load this frame looks up whether its tab's origin has a remembered boost,
 * so a boost survives reloads and browser restarts without the user reopening
 * the popup. See restoreStoredGain().
 *
 * Depends on config.js (loaded immediately before it) for KAM_VB.
 */

(() => {
  "use strict";

  if (window.__volumeBooster) {
    return; // already initialised in this frame
  }

  /**
   * Audio tuning constants. Adjust to A/B audio character.
   *   SHAPER_KNEE        level (linear, 1.0 = 0 dBFS) below which the soft
   *                      clipper is a straight wire. 0.7 is about -3 dBFS:
   *                      everything quieter passes through untouched, peaks
   *                      above it are rounded smoothly toward 1.0. Higher keeps
   *                      loud peaks cleaner at 100%; lower saturates more gently
   *                      at high boost.
   *   LIMITER_RELEASE    limiter release time in seconds. Lower = snappier, can
   *                      pump; higher = smoother, less transient control.
   *   LEGACY_TANH_CURVE  true restores the 1.2.0 shaper, for A/B listening.
   *                      That curve had a small-signal slope of 1.44, so it
   *                      added ~3.2 dB to quiet audio even at 100%, and it
   *                      hard-clipped anything above 1.0 after the gain stage.
   * The boost ceiling is shared with the popup and lives in config.js.
   */
  const CONFIG = {
    SHAPER_KNEE: 0.7,
    LIMITER_RELEASE: 0.15,
    LEGACY_TANH_CURVE: false,
  };

  /** Boost ceiling as a multiplier (4.0 = 400%). Sourced from shared config. */
  const MAX_MULTIPLIER = KAM_VB.MAX_PERCENT / 100;

  /**
   * Input range the shaper curve covers. A WaveShaper only reads inputs in
   * [-1, 1] and clamps anything outside to the curve's end values, which is a
   * hard clip. So the gain stage scales the signal down by this factor, and the
   * curve is defined over [-range, range] in real signal units. At max boost a
   * full-scale source reaches exactly the edge, where the curve is already flat,
   * so the clamp never produces a kink.
   */
  const SHAPER_RANGE = CONFIG.LEGACY_TANH_CURVE ? 1 : Math.max(2, MAX_MULTIPLIER);

  /** AudioParam ramp time-constant; see rampParams(). */
  const RAMP_TAU = 0.01;

  let audioCtx = null;
  let gainNode = null;
  let shaperNode = null;
  let limiterNode = null;
  let makeupNode = null;
  let subsonicNode = null;
  let currentGain = 1.0;

  /**
   * Set once the popup sends a level. A remembered boost is read from storage
   * asynchronously at load; if the user changes the level before that read
   * resolves, the stored value is stale and must not overwrite their choice.
   */
  let userHasSetGain = false;

  let observer = null;
  let observedRoots = new WeakSet();
  let discoveryArmed = false;

  /**
   * Per-element state, keyed by element:
   *   "deferred"  seen, but no source yet; wired on its first loadstart
   *   "wired"     routed through the graph
   *   "cors"      skipped: its source is cross-origin and would be silenced
   *   "failed"    createMediaElementSource threw (bound elsewhere already)
   *   "silenced"  was wired, then switched to a cross-origin source, so the
   *               browser now feeds the graph zeroes. Routing can't be undone;
   *               a reload is the only fix.
   */
  const media = new WeakMap();

  /**
   * Live tallies of the counted states, reported to the popup so its status
   * line says what actually happened rather than what was requested.
   */
  const found = { wired: 0, cors: 0, failed: 0, silenced: 0 };

  /** Move an element to a new state, keeping the tallies in step. */
  function setState(el, next) {
    const prev = media.get(el);
    if (prev in found) found[prev]--;
    if (next in found) found[next]++;
    media.set(el, next);
  }

  /**
   * Transfer curve for the WaveShaper, defined over [-SHAPER_RANGE,
   * SHAPER_RANGE] in signal units. Unity slope up to the knee, then a tanh
   * shoulder that approaches 1.0 with a continuous slope, so there is no corner
   * anywhere in the curve.
   *
   * Measured against the 1.2.0 curve through the full chain (1 kHz sine):
   *   100% boost, -40 and -12 dBFS input:  +0.00 dB, 0.00% THD  (was +3.2 dB)
   *   400% boost, -12 dBFS input:          2.86% THD            (was 8.92%)
   */
  function makeShaperCurve() {
    if (CONFIG.LEGACY_TANH_CURVE) {
      const n = 1024;
      const curve = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        curve[i] = Math.tanh(1.2 * x) / Math.tanh(1.2);
      }
      return curve;
    }
    const n = 4096;
    const knee = CONFIG.SHAPER_KNEE;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = ((i / (n - 1)) * 2 - 1) * SHAPER_RANGE;
      const ax = Math.abs(x);
      const y = ax <= knee ? ax : knee + (1 - knee) * Math.tanh((ax - knee) / (1 - knee));
      curve[i] = Math.sign(x) * y;
    }
    return curve;
  }

  /**
   * Map boost multiplier to level-dependent limiter/makeup settings.
   * Low boost -> transparent (limiter idle); high boost -> progressive control.
   * @param {number} multiplier  1.0 = 100% .. MAX_MULTIPLIER.
   */
  function levelSettings(multiplier) {
    const t = Math.min(1, Math.max(0, (multiplier - 1) / (MAX_MULTIPLIER - 1)));
    const threshold = 0 - 2 * t; // 0 dBFS at low boost -> -2 dB at max
    const makeup = 1 + 0.1 * t; //  1.0x at low boost -> 1.1x at max
    return { threshold, makeup };
  }

  /**
   * Lazily create the AudioContext and processing chain.
   *
   * Only ever called from wireElement, i.e. when there is real media to route.
   * A frame with no media — an ad iframe, a tracking pixel — never builds a
   * context, however the boost was set. This script runs in every frame of
   * every page, and the chain costs ~1% of a core once it's rendering.
   *
   * @returns {boolean} true if the graph is ready.
   */
  function ensureGraph() {
    if (gainNode) return true;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new Ctx();

      // Subsonic high-pass: removes <25 Hz rumble (inaudible, wastes headroom).
      subsonicNode = audioCtx.createBiquadFilter();
      subsonicNode.type = "highpass";
      subsonicNode.frequency.value = 25;
      subsonicNode.Q.value = 0.707; // Butterworth, no resonant peak

      // Carries the boost, pre-scaled into the shaper's input range.
      gainNode = audioCtx.createGain();

      // Soft clip: transparent below the knee, smooth saturation above it.
      // 4x oversampling absorbs inter-sample overshoot. It is also the most
      // expensive node here and the source of 4 ms of the chain's latency.
      shaperNode = audioCtx.createWaveShaper();
      shaperNode.curve = makeShaperCurve();
      shaperNode.oversample = "4x";

      // Brick-wall limiter. A small knee softens the onset of limiting so it
      // engages musically rather than snapping.
      limiterNode = audioCtx.createDynamicsCompressor();
      limiterNode.knee.value = 3;
      limiterNode.ratio.value = 20;
      limiterNode.attack.value = 0.003;
      limiterNode.release.value = CONFIG.LIMITER_RELEASE;

      makeupNode = audioCtx.createGain();

      // Seed the level-dependent params for whatever gain is already pending.
      // Set directly rather than ramped: nothing is playing through it yet.
      const { threshold, makeup } = levelSettings(currentGain);
      gainNode.gain.value = currentGain / SHAPER_RANGE;
      limiterNode.threshold.value = threshold;
      makeupNode.gain.value = makeup;

      subsonicNode.connect(gainNode);
      gainNode.connect(shaperNode);
      shaperNode.connect(limiterNode);
      limiterNode.connect(makeupNode);
      makeupNode.connect(audioCtx.destination);

      console.info("[Volume Booster] Audio graph created.");
      return true;
    } catch (err) {
      console.error("[Volume Booster] Failed to create AudioContext:", err);
      return false;
    }
  }

  /**
   * Resume the context if the autoplay policy left it suspended. Safe to call
   * without a user gesture — it simply stays suspended until one arrives.
   */
  function resumeContext() {
    if (audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
  }

  /**
   * Whether the element has a source we can judge yet. Before resource
   * selection runs, an element using <source> children has neither src nor
   * currentSrc, so there is nothing to check CORS against.
   * @param {HTMLMediaElement} el
   */
  function hasKnownSource(el) {
    return Boolean(el.srcObject || el.currentSrc || el.src);
  }

  /**
   * Determine whether routing this element through Web Audio would output
   * silence due to CORS. A cross-origin media resource whose element is not
   * CORS-enabled produces zeroes from MediaElementAudioSource (the browser
   * refuses to expose samples). In that case we must NOT wire it, or audio goes
   * silent instead of merely un-boosted.
   *
   * The check is only meaningful once the source is known — see wireElement,
   * which defers elements without one rather than treating them as safe.
   *
   * @param {HTMLMediaElement} el
   * @returns {boolean} true if wiring is unsafe (would mute the element).
   */
  function wouldMuteFromCORS(el) {
    if (el.srcObject) return false; // MediaStream / MediaSource: no CORS taint
    const src = el.currentSrc || el.src;
    if (!src || src.startsWith("blob:") || src.startsWith("data:")) return false;
    let origin;
    try {
      origin = new URL(src, location.href).origin;
    } catch (_) {
      return false;
    }
    // self.origin is the document's real origin, including one inherited by an
    // about:blank frame, where location.origin would report "null".
    const pageOrigin = self.origin && self.origin !== "null" ? self.origin : location.origin;
    if (origin === pageOrigin) return false; // same-origin: safe
    // Cross-origin: only safe if the element opted into CORS AND the server
    // honours it. We can't verify the server here, so if crossOrigin isn't set
    // we treat it as unsafe (the common failure case).
    return !el.crossOrigin;
  }

  /**
   * Listen for source changes on the element itself. Media events don't
   * bubble or cross shadow boundaries, so a document-level listener can't see
   * them for shadow-DOM players; a listener on the element always can.
   * @param {HTMLMediaElement} el
   */
  function watch(el) {
    if (el.__vbWatched) return;
    el.__vbWatched = true;
    el.addEventListener("loadstart", () => onNewSource(el));
  }

  /**
   * A new resource started loading, so currentSrc is now known.
   *   deferred / cors   -> (re)try wiring against the new source
   *   wired / silenced  -> re-check: routing can't be undone, but the popup
   *                        can at least report a source that's now silenced
   * @param {HTMLMediaElement} el
   */
  function onNewSource(el) {
    const state = media.get(el);
    if (state === "deferred" || state === "cors") {
      if (state === "cors") setState(el, "deferred");
      wireElement(el);
      return;
    }
    if (state === "wired" || state === "silenced") {
      const tainted = wouldMuteFromCORS(el);
      if (tainted && state === "wired") {
        setState(el, "silenced");
        console.warn(
          "[Volume Booster] A boosted element switched to a cross-origin " +
            "source; the browser now silences it. Reload the page to hear it:",
          el.currentSrc
        );
      } else if (!tainted && state === "silenced") {
        setState(el, "wired");
      }
    }
  }

  /**
   * Route a single media element through the graph. Idempotent per element.
   * Caches the MediaElementSource on the element (__vbSource) so re-injection
   * and SPA navigation reuse it instead of throwing InvalidStateError.
   * @param {HTMLMediaElement} el
   */
  function wireElement(el) {
    if (!(el instanceof HTMLMediaElement)) return;
    const state = media.get(el);
    if (state && state !== "deferred") return; // later changes go via onNewSource

    // Nothing to route audio through at 100% — skip, so a page that was never
    // boosted never pays for an AudioContext it doesn't need. Once the graph
    // exists we keep wiring regardless, so re-enabling the boost is instant.
    if (currentGain <= 1 && !gainNode) return;

    watch(el);

    // No source yet: judging CORS now would wrongly pass it as safe, and once
    // wired, a cross-origin source set later would silence it permanently.
    if (!hasKnownSource(el)) {
      setState(el, "deferred");
      return;
    }

    // Skip cross-origin media that would be silenced by CORS. Leaving it
    // unwired keeps normal (un-boosted) playback rather than muting it.
    if (wouldMuteFromCORS(el)) {
      setState(el, "cors");
      console.info(
        "[Volume Booster] Skipping cross-origin media (CORS-restricted; " +
          "cannot boost without muting):",
        el.currentSrc || el.src
      );
      return;
    }

    if (!ensureGraph()) return;

    try {
      let source = el.__vbSource;
      if (!source) {
        source = audioCtx.createMediaElementSource(el);
        el.__vbSource = source;
      } else {
        try {
          source.disconnect();
        } catch (_) {
          /* no-op if not connected */
        }
      }
      source.connect(subsonicNode);
      setState(el, "wired");
      resumeContext();
      console.info("[Volume Booster] Wired element:", el.currentSrc || el.src || el.tagName);
    } catch (err) {
      setState(el, "failed");
      console.info(
        "[Volume Booster] Element pre-bound to another context; will work " +
          "after the next page load. (One-time, harmless.)"
      );
    }
  }

  /** Start watching a shadow root for inserted media, once. */
  function observeRoot(root) {
    if (!observer || observedRoots.has(root)) return;
    observedRoots.add(root);
    observer.observe(root, { childList: true, subtree: true });
  }

  /**
   * Wire every media element under root, descending into open shadow roots and
   * attaching the observer to each one on the way.
   *
   * The querySelectorAll("*") shadow-host hunt materialises every element in
   * the tree — measured at 2.6 ms for 20,000 elements. It runs when a boost is
   * armed and when the user moves the slider, never on a timer.
   *
   * @param {Document|ShadowRoot|Element} root
   */
  function collectFrom(root) {
    if (root instanceof ShadowRoot) observeRoot(root);
    root.querySelectorAll("audio, video").forEach(wireElement);
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) collectFrom(el.shadowRoot);
    }
  }

  /** Handle one node the observer reported as added. */
  function scanAdded(node) {
    const tag = node.localName;
    if (tag === "audio" || tag === "video") wireElement(node);
    if (node.shadowRoot) collectFrom(node.shadowRoot);
    // Descendants, including shadow hosts nested inside the inserted subtree.
    if (node.firstElementChild) collectFrom(node);
  }

  /** Observe the document for newly inserted media. */
  function startObserver() {
    if (observer) return;
    observedRoots = new WeakSet();
    observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node instanceof HTMLElement) scanAdded(node);
        }
      }
    });
    // documentElement normally exists by document_start, but fall back to the
    // document so the restore path can't throw on an unusually early frame.
    observer.observe(document.documentElement || document, {
      childList: true,
      subtree: true,
    });
  }

  /**
   * Arm element discovery: start the observer, then scan.
   *
   * Observer first, scan second — the reverse order leaves a window in which an
   * element inserted mid-scan is seen by neither. The scan also attaches the
   * observer to every open shadow root it passes through.
   */
  function armDiscovery() {
    if (discoveryArmed) return;
    discoveryArmed = true;
    startObserver();
    collectFrom(document);
  }

  /**
   * Stop watching the DOM while the boost is off. The observer fires on every
   * insertion anywhere in the frame, which is real work on a busy SPA and buys
   * nothing when there is no boost to apply. Re-arming rescans, so media added
   * in the meantime is still picked up.
   */
  function disarmDiscovery() {
    if (!discoveryArmed) return;
    discoveryArmed = false;
    observer?.disconnect();
    observer = null;
    observedRoots = new WeakSet();
  }

  /**
   * Ramp the level-dependent AudioParams to match currentGain.
   * All params ramp on a 10 ms time-constant: below perception (reads as
   * instant) but avoids zipper-noise/clicks when the slider moves or jumps.
   */
  function rampParams() {
    const now = audioCtx.currentTime;
    const { threshold, makeup } = levelSettings(currentGain);

    gainNode.gain.cancelScheduledValues(now);
    gainNode.gain.setTargetAtTime(currentGain / SHAPER_RANGE, now, RAMP_TAU);

    limiterNode.threshold.cancelScheduledValues(now);
    limiterNode.threshold.setTargetAtTime(threshold, now, RAMP_TAU);

    makeupNode.gain.cancelScheduledValues(now);
    makeupNode.gain.setTargetAtTime(makeup, now, RAMP_TAU);
  }

  /**
   * Set the boost multiplier.
   *
   * Never creates the graph itself: discovery wires whatever media exists, and
   * wiring builds the graph on demand. In 1.2.0 this forced a graph into every
   * frame the popup messaged, so pressing "Turn Off" on a page you never
   * boosted started an AudioContext in every ad iframe.
   *
   * @param {number} multiplier
   * @param {{userInitiated?: boolean}} [opts]  true when the popup sent it,
   *        which also rescans: the user moving the slider is the one moment
   *        it's worth paying for a scan to catch players discovery missed.
   */
  function setGain(multiplier, { userInitiated = false } = {}) {
    currentGain = multiplier;

    if (multiplier > 1) {
      if (!discoveryArmed) armDiscovery();
      else if (userInitiated) collectFrom(document);
    } else {
      disarmDiscovery();
    }

    if (gainNode) {
      resumeContext();
      rampParams();
    }
  }

  /**
   * The tab's top-level origin as seen from this frame, or null if this frame
   * can't determine it.
   *
   * A boost belongs to the page the user set it on, not to whatever
   * third-party origin happens to host the player iframe (Panopto,
   * youtube-nocookie), so subframes need the TOP origin, not their own.
   *
   * location.ancestorOrigins is Chrome-only but exact — its last entry is the
   * top-level browsing context's origin — which lets a subframe read storage
   * itself instead of messaging the service worker. Sandboxed frames report
   * "null" (an opaque origin), which originOf rejects, and those fall back to
   * asking the worker.
   *
   * @returns {string|null}
   */
  function topOrigin() {
    if (window.top === window) return KAM_VB.originOf(location.href);
    const ancestors = location.ancestorOrigins;
    if (!ancestors || ancestors.length === 0) return null;
    return KAM_VB.originOf(ancestors[ancestors.length - 1]);
  }

  /** Look up this tab's remembered boost and adopt it. */
  function restoreStoredGain() {
    /** @param {unknown} percent */
    const adopt = (percent) => {
      if (userHasSetGain) return; // the popup already chose; storage is stale
      if (!Number.isFinite(percent) || percent <= KAM_VB.MIN_PERCENT) return;
      setGain(percent / 100);
    };

    try {
      const origin = topOrigin();
      if (origin) {
        const key = KAM_VB.storageKey(origin);
        chrome.storage.local
          .get(key)
          .then((items) => adopt(items[key]))
          .catch(() => {});
        return;
      }

      // A top frame with no persistable origin (file://, about:) has nothing
      // remembered; only an opaque subframe is worth asking the worker about.
      if (window.top === window) return;

      chrome.runtime.sendMessage({ type: "GET_STORED_GAIN" }, (res) => {
        // Reading lastError suppresses the "unchecked runtime.lastError"
        // console noise when the worker can't answer (e.g. mid-update).
        if (chrome.runtime.lastError) return;
        adopt(res?.percent);
      });
    } catch (_) {
      // Extension context invalidated (reload/update). Nothing to restore.
    }
  }

  window.__volumeBooster = { setGain, getGain: () => currentGain };

  /**
   * Capture-phase "play" listener, light DOM only. Media events are not
   * composed, so one fired inside a shadow root never reaches the document —
   * measured, which is why shadow roots get their own observers above. This
   * is a cheap backstop for light-DOM media and nothing more.
   */
  document.addEventListener(
    "play",
    (event) => {
      const target = event.target;
      if (target instanceof HTMLMediaElement) {
        wireElement(target);
        resumeContext();
      }
    },
    true // capture phase
  );

  // Respond to popup messages. Both replies carry this frame's raw tallies —
  // not a single verdict — so the popup can sum them across frames and say what
  // actually happened instead of assuming it worked. A frame that saw nothing
  // reports zeroes and so can't mask a frame that succeeded.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "SET_GAIN") {
      userHasSetGain = true;
      setGain(msg.value, { userInitiated: true });
      sendResponse({ ok: true, gain: currentGain, found: { ...found } });
    } else if (msg?.type === "GET_GAIN") {
      sendResponse({ ok: true, gain: currentGain, found: { ...found } });
    }
    return true; // keep channel open for async sendResponse
  });

  restoreStoredGain();
})();
