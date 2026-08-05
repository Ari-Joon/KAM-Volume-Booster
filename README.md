# KAM Volume Booster

**Hear quiet lectures clearly.** A Chrome extension that boosts audio and video
in any tab up to 400% — four times past the browser's built-in ceiling — using
the Web Audio API.

Built for the recordings the native volume slider can't fix: a lecture captured
from the back of the hall, a seminar with the mic too far away, a course
platform that tops out below what you need. It's just as useful for badly
mastered uploads and quiet conference calls, but quiet coursework is the case it
was tuned for.

Boosting naively just clips audio into crackle, which is the last thing you want
when you're trying to make out speech. This runs a mastering-style chain instead
— soft clipping, brick-wall limiting, and level-dependent processing that stays
transparent at small boosts.

![The popup boosting a tab to 250%](promo/shot-1-lectures.png)

---

## Install (unpacked)

1. Clone or download this repo.
2. Go to `chrome://extensions`.
3. Turn on **Developer mode**.
4. **Load unpacked** → select the repo folder.

No build step. The source is what ships.

## Use

Click the toolbar icon, drag the slider (or type a percentage). The boost is
remembered **per site** and comes back automatically on reload and after a
browser restart. **Turn Off** returns the site to 100%.

![Per-site levels persist across reloads and restarts](promo/shot-2-remembers.png)

Embedded players are covered too. Lecture-capture and course platforms usually
run the video in an iframe, and media inside Shadow DOM defeats most boosters —
both work here. When a site genuinely can't be boosted, the popup says so
instead of pretending.

![Works inside embedded iframe and Shadow DOM players](promo/shot-3-embedded.png)

---

## How it works

`content.js` runs in every frame and routes each `<audio>` / `<video>` element
through a Web Audio graph:

```
source → subsonic HP → gain → soft-clip → limiter → makeup → destination
```

- **Subsonic high-pass** (25 Hz, Q 0.707) — strips inaudible rumble that would
  otherwise eat limiter headroom.
- **Gain** — the boost multiplier.
- **Soft-clip WaveShaper** (tanh, 4× oversampled) — rounds peaks so overshoot
  saturates smoothly instead of hard-clipping into crackle.
- **Limiter** (`DynamicsCompressor`, knee 3, ratio 20, 3 ms attack) — brick-wall
  peak control.
- **Makeup gain** — restores headroom lost to limiting.

### Level-dependent processing

The limiter threshold and makeup gain scale with the boost, so the chain isn't
uniformly "processed" at every setting:

| Boost | Limiter threshold | Makeup | Character |
|---|---|---|---|
| ~110–150% | ≈ 0 dBFS (idle) | 1.0× | near-transparent wire |
| 400% | −2 dB | 1.1× | limiter progressively in control |

All parameters ramp on a 10 ms time constant — below perception, but enough to
prevent zipper noise when the slider is dragged or jumped.

### Finding the media

Three mechanisms, because no one of them is sufficient:

1. **MutationObserver** — elements added after load (SPA navigation).
2. **Recursive scan** — descends into open Shadow DOM roots. Runs once per frame;
   the observer covers everything after.
3. **Capture-phase `play` listener** using `event.composedPath()[0]` — catches
   media inside custom web components that `querySelectorAll` can't reach. This
   is what makes Shadow-DOM-heavy players work.

---

## Measured characteristics

Numbers from `OfflineAudioContext` impulse and render benchmarks at 48 kHz, not
estimates.

### Latency: ~10 ms

| Stage | Delay |
|---|---|
| WaveShaper `oversample: "none"` | 0 samples |
| WaveShaper `oversample: "2x"` | 128 smp — 2.67 ms |
| WaveShaper `oversample: "4x"` | 192 smp — 4.00 ms |
| **Full chain** | **480 smp — 10.05 ms** |

The 288 samples beyond the shaper are `DynamicsCompressorNode`'s internal
lookahead — 6.0 ms, fixed, and not configurable in Chrome. The total is constant
(it doesn't drift) and sits under the usual ~20 ms threshold for noticing
audio/video desync.

**Consequence for contributors:** no part of this graph is sample-aligned with
unprocessed audio. Don't add a dry "bypass" path and crossfade to it — the two
paths are 10 ms apart and it flanges audibly.

### CPU: ~1% of one core

| Configuration | Cost | vs. untouched |
|---|---|---|
| Untouched audio | 0.039% of a core | 1× |
| Gain only | 0.049% | 1.3× |
| Full chain, shaper `4x` | **0.973%** | 25× |
| Full chain, shaper `2x` | 0.591% | 15× |
| Full chain, shaper `none` | 0.418% | 11× |

The 4× oversampled shaper dominates. The limiter is only ~0.11%.

A page that is never boosted **never constructs an AudioContext at all**, so
this cost applies only to tabs actually being boosted.

Other measured overheads, for anyone tempted to optimise them: the
MutationObserver callback costs **0.76 µs per added node** (a page inserting
21,000 nodes costs 6.8 ms total), and the one-time full-document scan costs
**2.6 ms at 20,000 elements**. Both are already negligible.

---

## Known limitations

**CORS-restricted media can't be boosted.** A cross-origin media resource whose
element isn't CORS-enabled makes `MediaElementAudioSource` output *silence*, not
just un-boosted audio. The extension detects this and deliberately skips wiring,
so playback stays normal, and the popup tells you it happened. This is a browser
security rule, not a bug — it can't be worked around from an extension.

**Other extensions' pages can't be boosted.** Chrome forbids content-script
injection into `chrome-extension://` pages belonging to other extensions.

**Restricted pages.** `chrome://`, `about:`, `view-source:` and the Web Store are
off-limits to all extensions; the popup says so instead of failing silently.

---

## Approaches deliberately rejected

Recorded so they don't get re-litigated:

- **`tabCapture` + offscreen document** — wrong tool. Designed for
  recording/streaming, mutes the source tab unless re-output, needs an offscreen
  document. The content-script model is correct here.
- **Lookahead limiting** — lookahead *is* latency.
- **Multiband limiting** — crossover filters add phase shift and group delay;
  doing it transparently needs lookahead-style compensation.
- **High-shelf "air" EQ** — implemented, then reverted. It amplified existing
  hiss and lossy-compression artifacts, which read as harshness.
- **True-peak / oversampled limiting** — `DynamicsCompressorNode` can't
  oversample; doing it properly needs an `AudioWorklet`, which adds latency. The
  4× oversampled shaper already absorbs most inter-sample overshoot.
- **Dry bypass path with crossfade** — see the latency table above.
- **Dynamic content-script registration** (registering only for boosted origins)
  — content script `matches` are tested against each *frame's* URL, so a player
  in a third-party iframe would stop auto-restoring.
- **All-tabs control / global mute, EQ controls** — not worth the complexity for
  a volume booster.

---

## Architecture notes

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest |
| `config.js` | Single source of truth for the boost ceiling and storage keys; loaded by all three contexts |
| `content.js` | Audio processing and element discovery |
| `background.js` | One listener: resolves a subframe's tab origin when the frame can't |
| `popup.*` | UI |

**Shared config.** `config.js` is loaded by the popup (`<script>`), the content
script (manifest, before `content.js`) and the worker (`importScripts`). The
popup sets its slider bounds from it at runtime, so the ceiling has exactly one
definition and can't drift out of sync with the audio tuning.

**Persistence.** Boosts are stored in `chrome.storage.local` keyed by origin.
100% is stored as *absence* of a key, so storage doesn't accumulate an entry per
site ever visited.

**Restore is pull, not push.** The content script asks for its tab's boost at
`document_start` rather than the worker pushing on `tabs.onUpdated` — no frame
enumeration, no race against script readiness, and iframes created later ask on
their own behalf. Frames resolve the tab's origin themselves via
`location.ancestorOrigins`, so the service worker doesn't start at all on a
normal page load; it's a fallback for sandboxed frames with an opaque origin.

**Honest status reporting.** Each frame returns raw tallies
(`{wired, cors, failed}`) rather than a verdict, and the popup sums them across
frames. A frame that found nothing therefore can't mask a frame that succeeded.

---

## How this was built

I built this with Claude Code, and I've kept the `Co-Authored-By` trailers in the
history on purpose. I want to work in AI engineering, so hiding that I build
things with models would be a strange place to start.

How it worked in practice: I set the constraints and decided what counted as
good, the model wrote most of the code, and I tested by ear and said what I
actually heard. The one rule was that nothing about audio quality or performance
got to stay unless there was a measurement behind it.

That rule is what made the project worth doing, because a lot of what we assumed
turned out to be wrong.

The whole thing was built around "zero added latency, non-negotiable". Then we
measured it. The chain was already at 10.05 ms, and 6.0 ms of that came from
`DynamicsCompressorNode`'s internal lookahead — lookahead being the exact thing
the rule existed to ban. That constraint had been driving design decisions the
whole time and nobody had checked whether it was true.

The same thing happened with an optimisation I liked the sound of. We built a
bypass path to cut CPU while the boost is off, measured it, and found the two
paths sit 10 ms apart, so crossfading between them flanges. It was deleted before
it shipped. The reason is written into `content.js` so I don't rebuild it in six
months.

One optimisation did nothing at all. A filter in the MutationObserver callback to
skip childless nodes benchmarked identical to the version without it: 0.76 µs per
node either way, because the cost is Chrome handing over mutation records, not the
query. I kept the code and fixed the comment. A comment claiming a speedup that
isn't there is worse than no comment.

The one I'm most glad we caught: registering the content script only on sites
you've boosted, so it stays off the rest of the web. That sounds obviously good.
But content script `matches` are checked against each frame's URL, not the tab's,
so a lecture player inside an iframe would have quietly stopped restoring its
boost — which is the main thing I built this for.

Two things I turned down on judgement instead of measurement: suspending the
`AudioContext` when nothing is playing (if you're not using it you just turn the
booster off), and `latencyHint: "playback"`, which saves CPU by doubling output
buffering to 20 ms.

## Privacy

No data collection, no analytics, no network requests. The only thing stored is
a number per origin (your chosen boost level), kept locally in
`chrome.storage.local`. See [PRIVACY.md](PRIVACY.md).

## License

[MIT](LICENSE)
