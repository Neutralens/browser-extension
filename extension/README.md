# Neutralens Browser Extension (MV3)

**Patent Pending.**

A small Chrome/Edge/Brave/Safari Web Extension that lets you right-click any
product image — on any site — and search for it neutrally across multiple
retailers via Neutralens, with no ranking bias.

## Install (Chrome / Edge / Brave / Arc)

1. Edit `config.js` and set `NEUTRALENS_BASE_URL` to your deployment
   (default `https://neutralens.com` — change if you self-host on a
   different domain).
2. Open `chrome://extensions` and toggle **Developer mode** on.
3. Click **Load unpacked** and select this `extension/` folder.
4. Visit the deployed Neutralens site, sign in, then open
   `/extension/link` and click **Generate token**. The extension picks it
   up automatically via `window.postMessage` and persists it in
   `chrome.storage.local`.

## What it does

- **Context menu on images** — "Search this image with Neutralens" opens a
  new tab with the image's URL pre-filled.
- **Context menu on pages/selection** — "Find this product on other
  retailers" forwards the page URL (or selected text) to Neutralens.
- **Video frame capture** — adds a small "Neutralens this frame" pill in the
  top-right corner of any `<video>` element. When the video is same-origin,
  the current frame is captured client-side. For cross-origin videos
  (YouTube etc.), it falls back to opening Neutralens' server-side YouTube
  frame flow.
- **Tier-aware popup** — shows your current tier (free / pro / premium)
  and links to billing or account management.

## Safari

See `../safari-extension/README.md` for the `xcrun
safari-web-extension-converter` command to wrap this into a signable Safari
Web Extension.
