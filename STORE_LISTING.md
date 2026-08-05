# Chrome Web Store submission notes

Copy for the developer dashboard, kept in the repo so it stays consistent
between versions. Nothing here is loaded by the extension.

---

## Store listing

**Name**
```
KAM Volume Booster
```

**Short description** (132 char limit — this is 110)
```
Hear quiet lectures and videos clearly. Boost any tab up to 400% with clean limiting that prevents distortion.
```

**Category:** Accessibility (alternative: Productivity/Tools)

**Language:** English

### Detailed description

```
Some lectures are just too quiet. The recording was made with a mic at the back
of the hall, your laptop is already at 100%, and you're still straining to catch
half of it.

KAM Volume Booster raises the volume of any audio or video in a Chrome tab up to
400% — four times past the browser's built-in ceiling — so quiet educational
content becomes properly audible.

BUILT FOR STUDYING

• Works inside iframes, so embedded lecture-capture and course-platform players
  are covered, not just the page around them
• Works with Shadow DOM players that other boosters silently miss
• Remembers your level per site, so a platform you use every week is already at
  the right volume when you open it — through reloads and browser restarts
• Set an exact percentage by typing it, not just by dragging

It's just as useful for badly mastered uploads and conference calls mixed too
low, but quiet coursework is the case it was built and tuned for.

WHY IT DOESN'T JUST SOUND LOUDER AND WORSE

Turning the gain up naively clips the audio into crackle, which is exactly what
you don't want when you're trying to make out speech. This extension runs a
proper mastering-style chain instead:

• A soft-clip stage with 4x oversampling rounds peaks so overshoot saturates
  smoothly rather than distorting harshly.
• A brick-wall limiter catches what's left.
• A subsonic filter strips inaudible rumble that would otherwise waste headroom.

The processing scales with how hard you push it. At modest boosts the limiter
sits idle and the chain is essentially a transparent wire — small increases
sound untouched, not "processed". Only at high boost does the limiter
progressively take control.

Volume changes ramp smoothly, so there are no clicks or zipper noise when you
move the slider. And if a site can't be boosted, it tells you plainly instead of
pretending it worked.

PRIVACY

No data collection. No analytics. No network requests. Nothing leaves your
device. The only thing stored is a number per website — the boost level you
picked — kept locally on your computer.

Open source: https://github.com/Ari-Joon/KAM-Volume-Booster

KNOWN LIMITATION

Some sites deliver video under cross-origin rules that make browser audio
processing impossible — the browser would silence the audio entirely rather
than boost it. On those sites the extension deliberately steps aside so
playback stays normal, and tells you why. This is a Chrome security rule that
no extension can work around.
```

---

## Privacy practices tab

**Single purpose**
```
Increase the playback volume of audio and video in the user's current tab
beyond the browser's 100% limit.
```

**Data usage:** tick *nothing*. The extension collects no user data.
Certify all three compliance checkboxes.

**Privacy policy URL**
```
https://github.com/Ari-Joon/KAM-Volume-Booster/blob/main/PRIVACY.md
```

### Permission justifications

These are the usual rejection points — keep them specific.

**`storage`**
```
Stores one number per website: the boost percentage the user selected. This is
what lets a site keep its preferred volume after a reload or browser restart.
Stored locally via chrome.storage.local. No other data is stored.
```

**`activeTab`**
```
Applies the volume boost to the tab the user is currently viewing when they
interact with the extension's popup.
```

**`scripting`**
```
Injects the audio-processing content script into the current tab so the Web
Audio graph can be attached to that page's audio and video elements. Injection
targets all frames because media players are frequently hosted in an iframe.
```

**`tabs`**
```
Reads the active tab's ID and URL for two purposes: to identify which tab the
popup is controlling, and to recognise pages where boosting is impossible
(chrome:// pages, the Chrome Web Store) so the popup can show "Unavailable
here" instead of failing silently. Tab URLs are used only to derive the origin
under which the user's chosen boost level is saved. Browsing history is never
recorded or transmitted.
```

**`host_permissions: <all_urls>`**
```
Audio and video can appear on any website, and the extension cannot know in
advance which sites the user will want to boost. Broad host access is also
required because media players are commonly embedded in third-party iframes
(for example lecture-capture platforms), which need the same processing as the
top-level page.

The extension only reads and modifies audio output. It does not read, collect,
or transmit page content, and makes no network requests.
```

---

## Assets

- [x] **Screenshots** — three 1280×800 PNGs in `promo/`, upload in this order:
      1. `promo/shot-1-lectures.png` — the core pitch
      2. `promo/shot-2-remembers.png` — per-site memory
      3. `promo/shot-3-embedded.png` — iframe and Shadow DOM players

      Regenerate them after any popup UI change; see `promo/README.md`.
- [x] **Privacy policy URL** — published, see above.
- [ ] **Small promo tile** — 440×280 PNG (optional, improves store placement).

## GitHub metadata

Kept here so it can't drift from the store copy. All of it has to be set through
the GitHub web UI.

**About field** (Settings gear on the repo home page)
```
Hear quiet lectures clearly. Chrome extension that boosts any tab up to 400% without clipping it into crackle. Built because half my lecture recordings were too quiet to follow.
```

**Topics** — same panel as the About field. These are what surface the repo in
GitHub search:
```
chrome-extension  manifest-v3  web-audio-api  volume-booster  audio-processing
javascript  accessibility  dsp  built-with-ai
```

**Release notes** for the `v1.2.0` tag (Releases → Draft a new release →
choose the existing tag). Attach `kam-volume-booster-1.2.0.zip` so people can
install without cloning:

```
First public release.

Boosts any Chrome tab up to 400%. The point of it is quiet lecture recordings —
mic at the back of the hall, laptop already maxed out, still can't follow it.

What's in it:

- A mastering-style chain instead of raw gain, so it gets louder without
  clipping into crackle. Soft clipping, brick-wall limiting, and processing
  that scales with the boost so small increases still sound untouched.
- Levels saved per site, and they come back on reload and after a restart.
- Works inside iframes, which is what most lecture-capture platforms use, and
  finds media inside Shadow DOM that other boosters miss.
- Tells you when a site can't be boosted instead of pretending it worked.

Measured, not estimated: 10.05 ms of latency through the chain at 48 kHz and
about 1% of one core while boosting. A tab you never boost builds no
AudioContext at all. The numbers and how they were taken are in the README.

Install: download the zip below, unzip it, then chrome://extensions →
Developer mode → Load unpacked.
```

## Pre-submission checklist

- [ ] Bump `version` in `manifest.json` (the Web Store rejects re-uploads of an
      existing version number).
- [ ] Rebuild the package after any change.
- [ ] Load the zip's contents unpacked once and re-test before uploading.
