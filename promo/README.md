# Store assets

Source for the Chrome Web Store screenshots. Each frame is an HTML file that
renders at exactly **1280×800** — a valid Web Store screenshot size — and the
committed PNG next to it is the render.

The popup in each frame is the real markup from `popup.html` with the real
styles from `popup.css`, scaled up so it stays legible at listing size. Nothing
is mocked up or drawn to look better than it is: what the listing shows is what
ships.

## Regenerating

After any change to `popup.html` or `popup.css`, mirror it into
`promo/_shared.css` (the popup rules there are copied verbatim) and re-render:

```bash
"C:/Program Files/Google/Chrome/Application/chrome.exe" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --window-size=1280,800 --screenshot=promo/shot-1-lectures.png promo/shot-1-lectures.html
```

Repeat per frame. `--force-device-scale-factor=1` matters: without it a HiDPI
display produces 2560×1600 output.

## Frames

| File | Size | Slot |
|---|---|---|
| `shot-1-lectures` | 1280×800 | Store screenshot 1, README hero |
| `shot-2-remembers` | 1280×800 | Store screenshot 2, README |
| `shot-3-embedded` | 1280×800 | Store screenshot 3, README |
| `tile-small-440x280` | 440×280 | Store "Small promo tile" |
| `tile-marquee-1400x560` | 1400×560 | Store "Marquee promo tile" |
| `signal-chain` | 1280×400 | README only |

`signal-chain` is a README banner, not a store asset — its dimensions match no
store slot, so don't try to upload it.

The store rejects PNGs with an alpha channel. Headless Chrome writes 24-bit RGB
for an opaque page, which is what we want, but it's worth checking after any
change:

```bash
python -c "print(open('promo/shot-1-lectures.png','rb').read()[25])"
```

`2` is RGB and fine. `6` is RGBA and will be rejected.

![Signal chain](signal-chain.png)

## Still missing

A **440×280** small promo tile, if you want better placement in the store.
