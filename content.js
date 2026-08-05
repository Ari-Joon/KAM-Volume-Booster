/**
 * content.js
 *
 * Boosts audio/video output beyond the native 100% ceiling using the Web Audio
 * API. Runs in every frame at document_start (declared in the manifest).
 *
 * Signal chain (gain-aware; see levelSettings):
 *   source -> subsonic HP -> gain -> soft-clip -> limiter -> makeup -> output
 *
 * MEASURED CHAIN LATENCY: ~10.0 ms at 48 kHz (480 samples), made up of
 *   - 4.0 ms (192 smp) from the WaveShaper's 4x oversampling resamplers
 *   - 6.0 ms (288 smp) from DynamicsCompressorNode's internal lookahead
 * Both are fixed, not drift-prone, and sit under the ~20 ms A/V-sync detection
 * threshold. They are inherent to these nodes, not something this code adds:
 * oversample "2x" is 2.7 ms and "none" is 0 ms, and the compressor's lookahead
 * is not configurable. Worth knowing before assuming any part of this graph is
 * sample-aligned with unprocessed audio — in particular, do not build a dry
 * "bypass" path and crossfade to it, because the two paths are 10 ms apart and
 * the crossfade flanges audibly.
 *
 * Element discovery handles three cases that a naive querySelectorAll misses:
 *   - elements added after load           -> MutationObserver
 *   - elements inside Shadow DOM           -> recursive findMediaElements()
 *   - elements that only appear on play    -> capture-phase "play" listener
 *                                             (composedPath pierces shadow roots)
 * The play-listener is what makes the booster work on Shadow-DOM-heavy pages
 * such as custom web-component players.
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
   *   SHAPER_DRIVE    soft-clip curve steepness. Lower = more transparent,
   *                   only shapes true overshoot; higher = more saturation/color.
   *   LIMITER_RELEASE limiter release time in seconds. Lower = snappier, can
   *                   pump; higher = smoother, less transient control.
   * The boost ceiling is shared with the popup and lives in config.js.
   */
  const CONFIG = {
    SHAPER_DRIVE: 1.2,
    LIMITER_RELEASE: 0.15,
  };

  /** Boost ceiling as a multiplier (4.0 = 400%). Sourced from shared config. */
  const MAX_MULTIPLIER = KAM_VB.MAX_PERCENT / 100;

  /** AudioParam ramp time-constant; see rampParams(). */
  const RAMP_TAU = 0.01;

  let audioCtx = null;
  let gainNode = null;
  let shaperNode = null;
  let limiterNode = null;
  let makeupNode = null;
  let subsonicNode = null;
  let currentGain = 1.0;

  const wired = new WeakSet();
  let observer = null;
  let discoveryArmed = false;

  /**
   * What this frame actually managed to do with the media it saw. Reported to
   * the popup so its status line can be honest rather than assuming success.
   */
  const found = { wired: 0, cors: 0, failed: 0 };

  /** Generate a soft-clipping (tanh) transfer curve for the WaveShaper. */
  function makeSoftClipCurve(drive = CONFIG.SHAPER_DRIVE) {
    const n = 1024;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(drive * x) / Math.tanh(drive);
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
   * Called on demand — from setGain (popup) or from wireElement (first media
   * element found). A page that is never boosted therefore never constructs an
   * AudioContext at all, which matters because this script runs in every frame
   * of every page, and the chain costs ~1% of a core (measured: 25x the cost of
   * passing audio through untouched, dominated by the 4x-oversampled shaper).
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

      gainNode = audioCtx.createGain();

      // Soft-clip saturation: rounds peaks so overshoot distorts gracefully.
      // Drive (CONFIG.SHAPER_DRIVE) kept low so it stays transparent on normal
      // signal and only shapes true overshoot; higher drive colors everything.
      // 4x oversampling absorbs inter-sample overshoot. It is also the single
      // most expensive node here and the source of 4 ms of the chain's latency.
      shaperNode = audioCtx.createWaveShaper();
      shaperNode.curve = makeSoftClipCurve(CONFIG.SHAPER_DRIVE);
      shaperNode.oversample = "4x";

      // Brick-wall limiter. A small knee softens the onset of limiting so it
      // engages musically rather than snapping, which reduces audible
      // distortion on transients.
      limiterNode = audioCtx.createDynamicsCompressor();
      limiterNode.knee.value = 3;
      limiterNode.ratio.value = 20;
      limiterNode.attack.value = 0.003;
      limiterNode.release.value = CONFIG.LIMITER_RELEASE;

      makeupNode = audioCtx.createGain();

      // Seed the level-dependent params for whatever gain is already pending.
      // Set directly rather than ramped: the graph isn't passing audio yet, so
      // there is nothing to zipper.
      const { threshold, makeup } = levelSettings(currentGain);
      gainNode.gain.value = currentGain;
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
   * Determine whether routing this element through Web Audio would output
   * silence due to CORS. A cross-origin media resource whose element is not
   * CORS-enabled produces zeroes from MediaElementAudioSource (the browser
   * refuses to expose samples). In that case we must NOT wire it, or audio goes
   * silent instead of merely un-boosted.
   * @param {HTMLMediaElement} el
   * @returns {boolean} true if wiring is unsafe (would mute the element).
   */
  function wouldMuteFromCORS(el) {
    const src = el.currentSrc || el.src;
    if (!src || src.startsWith("blob:") || src.startsWith("data:")) return false;
    let origin;
    try {
      origin = new URL(src, location.href).origin;
    } catch (_) {
      return false;
    }
    if (origin === location.origin) return false; // same-origin: safe
    // Cross-origin: only safe if the element opted into CORS AND the server
    // honours it. We can't verify the server here, so if crossOrigin isn't set
    // we treat it as unsafe (the common failure case).
    return !el.crossOrigin;
  }

  /**
   * Route a single media element through the graph. Idempotent per element.
   * Caches the MediaElementSource on the element (__vbSource) so re-injection
   * and SPA navigation reuse it instead of throwing InvalidStateError.
   * @param {HTMLMediaElement} el
   */
  function wireElement(el) {
    if (!el || !(el instanceof HTMLMediaElement)) return;
    if (wired.has(el)) return;
    if (el.__vbFailed) return; // unrecoverable this page session; don't retry

    // Nothing to route audio through at 100% — skip, so a page that was never
    // boosted never pays for an AudioContext it doesn't need. Once the graph
    // exists we keep wiring regardless, so re-enabling the boost is instant.
    if (currentGain <= 1 && !gainNode) return;

    if (!ensureGraph()) return;

    // Skip cross-origin media that would be silenced by CORS. Leaving it
    // unwired keeps normal (un-boosted) playback rather than muting it.
    if (wouldMuteFromCORS(el)) {
      el.__vbFailed = true;
      wired.add(el);
      found.cors++;
      console.info(
        "[Volume Booster] Skipping cross-origin media (CORS-restricted; " +
          "cannot boost without muting):",
        el.currentSrc || el.src || el.tagName
      );
      return;
    }

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
      wired.add(el);
      found.wired++;
      resumeContext();
      console.info(
        "[Volume Booster] Wired element:",
        el.currentSrc || el.src || el.tagName
      );
    } catch (err) {
      el.__vbFailed = true;
      wired.add(el);
      found.failed++;
      console.info(
        "[Volume Booster] Element pre-bound to another context; will work " +
          "after the next page load. (One-time, harmless.)"
      );
    }
  }

  /**
   * Recursively collect <audio>/<video>, descending into open Shadow DOMs.
   *
   * The querySelectorAll("*") shadow-host hunt materialises every element in
   * the tree, so this is the most expensive thing the extension does on a large
   * page. armDiscovery() runs it exactly once per frame; everything after that
   * arrives through the observer or the play listener.
   *
   * @param {Document|ShadowRoot} root
   * @returns {HTMLMediaElement[]}
   */
  function findMediaElements(root = document) {
    const elements = Array.from(root.querySelectorAll("audio, video"));
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) {
        elements.push(...findMediaElements(el.shadowRoot));
      }
    }
    return elements;
  }

  /** Observe the DOM for newly inserted media (incl. Shadow DOM hosts). */
  function startObserver() {
    if (observer) return;
    observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          const tag = node.localName;
          if (tag === "audio" || tag === "video") {
            wireElement(node);
          } else if (node.firstElementChild) {
            // A childless element can't contain media, so skip the query. This
            // is a short-circuit for clarity, not a measured win: the callback
            // costs ~0.76 us per added node either way, and that is dominated
            // by record delivery rather than by querySelectorAll.
            node.querySelectorAll("audio, video").forEach(wireElement);
          }
          if (node.shadowRoot) {
            findMediaElements(node.shadowRoot).forEach(wireElement);
          }
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
   * Arm element discovery: start the observer, then do the one full-document
   * scan.
   *
   * Observer first, scan second — the reverse order leaves a window in which an
   * element inserted mid-scan is seen by neither. Once the observer is live
   * nothing can slip past it, so re-scanning on every gain change (as this used
   * to do on every slider release) is pure waste on a large page.
   */
  function armDiscovery() {
    if (discoveryArmed) return;
    discoveryArmed = true;
    startObserver();
    findMediaElements().forEach(wireElement);
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
    gainNode.gain.setTargetAtTime(currentGain, now, RAMP_TAU);

    limiterNode.threshold.cancelScheduledValues(now);
    limiterNode.threshold.setTargetAtTime(threshold, now, RAMP_TAU);

    makeupNode.gain.cancelScheduledValues(now);
    makeupNode.gain.setTargetAtTime(makeup, now, RAMP_TAU);
  }

  /**
   * Set the boost multiplier and apply it to the graph immediately.
   * Used for user-driven changes from the popup, where the graph must exist
   * even if no media has appeared yet.
   * @param {number} multiplier
   */
  function setGain(multiplier) {
    currentGain = multiplier;
    if (!ensureGraph()) return;

    resumeContext();
    if (multiplier > 1) {
      armDiscovery();
    } else {
      disarmDiscovery();
    }
    rampParams();
  }

  /**
   * Adopt a boost restored from storage on page load.
   *
   * Unlike setGain this does NOT force the graph into existence: discovery is
   * armed and any media already present is wired, and ensureGraph runs only if
   * something is actually there to route. A boosted origin therefore doesn't
   * spawn an AudioContext in every empty iframe on the page.
   *
   * @param {number} multiplier
   */
  function adoptGain(multiplier) {
    currentGain = multiplier;
    armDiscovery();
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

  /**
   * Look up this tab's remembered boost and adopt it.
   *
   * Reading storage directly whenever the frame can resolve the tab's origin
   * means the service worker never has to start on a normal page load — worker
   * startup costs far more than the storage read it would perform. The worker
   * remains the fallback for frames with an opaque origin.
   */
  function restoreStoredGain() {
    /** @param {unknown} percent */
    const adopt = (percent) => {
      if (!Number.isFinite(percent) || percent <= KAM_VB.MIN_PERCENT) return;
      adoptGain(percent / 100);
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
   * Capture-phase "play" listener. composedPath()[0] is the real event target
   * even across shadow boundaries, so this catches media elements that only
   * exist inside custom-element players (e.g. KAM TTS) and aren't found by
   * querySelectorAll on the main document.
   */
  document.addEventListener(
    "play",
    (event) => {
      const target = event.composedPath()[0];
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
      setGain(msg.value);
      sendResponse({ ok: true, gain: currentGain, found: { ...found } });
    } else if (msg?.type === "GET_GAIN") {
      sendResponse({ ok: true, gain: currentGain, found: { ...found } });
    }
    return true; // keep channel open for async sendResponse
  });

  restoreStoredGain();
})();
