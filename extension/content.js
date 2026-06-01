// Content script — runs on every page.
// 1. Listens for token handoff postMessage from /extension/link (strict origin).
// 2. Adds a small floating "Neutralens" pill on top of <video> elements.
// 3. Renders search results in a draggable Shadow-DOM panel (Escape to dismiss).
// All UI is built inside a closed Shadow DOM so we never touch host page styles
// or DOM beyond a single mounted host element.

(() => {
  if (window.__neutralensInstalled) return;
  window.__neutralensInstalled = true;

  // --- Trusted-origin allowlist (loaded synchronously via manifest config) -
  // Hard-coded mirror of extension/config.js NEUTRALENS_TRUSTED_ORIGINS.
  // Keep in sync. Content scripts can't `import` ES modules, so we duplicate.
  const TRUSTED_ORIGINS = new Set([
    "https://neutralens.com",
  ]);

  // --- Token handoff from the Neutralens website ----------------------------
  window.addEventListener("message", (event) => {
    const data = event?.data;
    if (!data || typeof data !== "object") return;
    if (data.source !== "neutralens-link" || typeof data.token !== "string") return;
    // Same-window (no iframe) + exact origin allowlist.
    if (event.source !== window) return;
    if (!TRUSTED_ORIGINS.has(event.origin)) return;
    chrome.runtime.sendMessage(
      {
        type: "NEUTRALENS_LINK_TOKEN",
        token: data.token,
        tier: data.tier ?? "free",
        email: data.email ?? null,
      },
      () => {
        // Acknowledge back to the page so it can show "linked".
        window.postMessage({ source: "neutralens-extension", linked: true }, event.origin);
      },
    );
  });

  // --- Source-media tracking (for object-region highlighting) --------------
  // The object-picker chips need to know which on-page element the search
  // came from so they can outline the matching region. Video-frame searches
  // set this to the <video>; right-click "Search this image" searches set it
  // to the <img> the user invoked the menu on. Stays null when we can't pin
  // down a source element, in which case highlighting is skipped gracefully.
  let pendingSourceEl = null;
  document.addEventListener(
    "contextmenu",
    (e) => {
      const t = e.target;
      const img =
        t && t.tagName === "IMG" ? t : t?.closest?.("img") ?? null;
      pendingSourceEl = img;
    },
    true,
  );

  // --- Floating pill over <video> ------------------------------------------
  const decoratedVideos = new WeakSet();

  function decorateVideo(video) {
    if (decoratedVideos.has(video)) return;
    decoratedVideos.add(video);

    const host = document.createElement("div");
    host.setAttribute("data-neutralens-host", "video-pill");
    host.style.cssText = `
      position: absolute; z-index: 2147483646; pointer-events: none;
      top: 0; left: 0;
    `;
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        .pill {
          pointer-events: auto;
          position: absolute; top: 12px; right: 12px;
          background: rgba(15, 23, 42, 0.85); color: #fff;
          font: 600 12px/1 -apple-system, system-ui, sans-serif;
          padding: 8px 12px; border-radius: 999px;
          cursor: pointer; backdrop-filter: blur(6px);
          border: 1px solid rgba(255,255,255,0.15);
          letter-spacing: 0.02em;
        }
        .pill:hover { background: rgba(15,23,42,1); }
      </style>
      <button class="pill" type="button">Neutralens this frame</button>
    `;
    shadow.querySelector(".pill").addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      captureFrameAndSearch(video).catch((err) =>
        showPanelError(`Could not capture frame: ${err?.message ?? err}`),
      );
    });
    const reposition = () => {
      const rect = video.getBoundingClientRect();
      host.style.top = `${rect.top + window.scrollY}px`;
      host.style.left = `${rect.left + window.scrollX}px`;
      host.style.width = `${rect.width}px`;
      host.style.height = `${rect.height}px`;
    };
    reposition();
    document.documentElement.appendChild(host);
    new ResizeObserver(reposition).observe(video);
    window.addEventListener("scroll", reposition, { passive: true });
    window.addEventListener("resize", reposition, { passive: true });
  }

  function scanVideos() {
    document.querySelectorAll("video").forEach((v) => {
      if (v.clientWidth < 240 || v.clientHeight < 160) return;
      decorateVideo(v);
    });
  }
  new MutationObserver(scanVideos).observe(document.documentElement, {
    subtree: true,
    childList: true,
  });
  scanVideos();

  async function captureFrameAndSearch(video) {
    pendingSourceEl = video;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || video.clientWidth || 640;
    canvas.height = video.videoHeight || video.clientHeight || 360;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas unavailable");
    try {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    } catch {
      // Cross-origin / tainted (e.g. YouTube). Forward to the website's
      // server-side YouTube-frame flow in a new tab.
      const url = `${getNeutralensBase()}/?youtubeUrl=${encodeURIComponent(window.location.href)}`;
      window.open(url, "_blank");
      return;
    }
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    openPanel({ kind: "loading", title: "Searching this frame…" });
    const resp = await chrome.runtime.sendMessage({
      type: "NEUTRALENS_SEARCH",
      payload: { imageDataUrl: dataUrl, source: "video-frame", sourceUrl: window.location.href },
    });
    handleSearchResponse(resp);
  }

  function getNeutralensBase() {
    // Mirrors config.js NEUTRALENS_BASE_URL. Content scripts can't import ESM.
    return "https://neutralens.com";
  }

  // --- Image URL resolution (page context) ---------------------------------
  // The server's /fetch-image only accepts https URLs, but image previews on
  // some sites (Google Images lightbox, lazy-loaders, in-canvas editors) use
  // blob: URLs that are only valid inside the page context. We resolve them
  // here — either by lifting the real https URL out of nearby DOM hints, or
  // by fetching the blob locally and converting it to a base64 data URL the
  // background script can pass straight to /recognise.
  function extractRealUrlFromDom(imgElement) {
    if (!imgElement) return null;
    const candidates = [
      imgElement.getAttribute("data-iurl"),
      imgElement.getAttribute("data-src"),
      imgElement.getAttribute("data-original"),
      imgElement.closest("a")?.href,
      imgElement.closest("[data-url]")?.getAttribute("data-url"),
    ];
    for (const c of candidates) {
      if (typeof c === "string" && c.startsWith("https://")) return c;
    }
    return null;
  }

  async function blobUrlToDataUrl(blobUrl) {
    const response = await fetch(blobUrl);
    if (!response.ok) throw new Error(`blob fetch failed: HTTP ${response.status}`);
    const blob = await response.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
      reader.readAsDataURL(blob);
    });
  }

  function findImgBySrc(srcUrl) {
    if (!srcUrl) return null;
    const all = document.querySelectorAll("img");
    for (const img of all) {
      if (img.currentSrc === srcUrl || img.src === srcUrl) return img;
    }
    return null;
  }

  async function resolveImageUrl(srcUrl, imgElement) {
    if (typeof srcUrl !== "string" || srcUrl.length === 0) {
      return { type: "fallback", value: srcUrl ?? "" };
    }
    if (srcUrl.startsWith("https://")) return { type: "url", value: srcUrl };
    if (srcUrl.startsWith("data:")) return { type: "dataUrl", value: srcUrl };
    if (srcUrl.startsWith("blob:")) {
      const domUrl = extractRealUrlFromDom(imgElement ?? findImgBySrc(srcUrl));
      if (domUrl) return { type: "url", value: domUrl };
      try {
        const dataUrl = await blobUrlToDataUrl(srcUrl);
        return { type: "dataUrl", value: dataUrl };
      } catch {
        return { type: "fallback", value: srcUrl };
      }
    }
    if (srcUrl.startsWith("http://")) {
      return { type: "url", value: "https://" + srcUrl.slice("http://".length) };
    }
    return { type: "fallback", value: srcUrl };
  }

  // --- Result panel (Shadow-DOM, draggable, Escape dismiss) ----------------
  let panelHost = null;
  let panelShadow = null;
  let panelDragOffset = null;

  function ensurePanel() {
    if (panelHost) return panelShadow;
    panelHost = document.createElement("div");
    panelHost.setAttribute("data-neutralens-host", "results-panel");
    panelHost.style.cssText = `
      position: fixed; z-index: 2147483647; top: 20px; right: 20px;
      width: 380px; max-height: calc(100vh - 40px); pointer-events: auto;
    `;
    panelShadow = panelHost.attachShadow({ mode: "closed" });
    panelShadow.innerHTML = panelHtml();
    document.documentElement.appendChild(panelHost);

    // Drag by header.
    const header = panelShadow.querySelector(".header");
    header.addEventListener("pointerdown", (e) => {
      const rect = panelHost.getBoundingClientRect();
      panelDragOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      header.setPointerCapture(e.pointerId);
    });
    header.addEventListener("pointermove", (e) => {
      if (!panelDragOffset) return;
      const x = Math.max(8, Math.min(window.innerWidth - 80, e.clientX - panelDragOffset.x));
      const y = Math.max(8, Math.min(window.innerHeight - 40, e.clientY - panelDragOffset.y));
      panelHost.style.left = `${x}px`;
      panelHost.style.top = `${y}px`;
      panelHost.style.right = "auto";
    });
    header.addEventListener("pointerup", () => {
      panelDragOffset = null;
    });

    panelShadow.querySelector(".close").addEventListener("click", closePanel);

    // Escape to close (key listener on document — does not modify host DOM).
    document.addEventListener("keydown", onEscape);
    return panelShadow;
  }

  function onEscape(e) {
    if (e.key === "Escape" && panelHost) closePanel();
  }

  function closePanel() {
    if (!panelHost) return;
    clearObjectHighlight();
    deactivateTapMode();
    panelHost.remove();
    panelHost = null;
    panelShadow = null;
    document.removeEventListener("keydown", onEscape);
  }

  // --- Object-region highlight overlay -------------------------------------
  // A pointer-events:none box drawn over the source media element marking the
  // region a hovered/focused object chip refers to. Lives in its own closed
  // Shadow DOM host appended to <html>; positioned in document coordinates so
  // it stays anchored to the image while the page scrolls. Never intercepts
  // clicks. Cleared on mouse-out/blur, panel close, and before each re-render.
  let highlightHost = null;
  let highlightShadow = null;

  function ensureHighlightHost() {
    if (highlightHost) return highlightShadow;
    highlightHost = document.createElement("div");
    highlightHost.setAttribute("data-neutralens-host", "object-highlight");
    highlightHost.style.cssText = `
      position: absolute; z-index: 2147483646; pointer-events: none;
      top: 0; left: 0; margin: 0; padding: 0; border: 0;
    `;
    highlightShadow = highlightHost.attachShadow({ mode: "closed" });
    highlightShadow.innerHTML = `
      <style>
        .box {
          position: absolute; box-sizing: border-box; pointer-events: none;
          border: 2px solid #047857; border-radius: 4px;
          background: rgba(16,185,129,0.18);
          box-shadow: 0 1px 6px rgba(15,23,42,0.25);
        }
      </style>
      <div class="box"></div>
    `;
    document.documentElement.appendChild(highlightHost);
    return highlightShadow;
  }

  // Compute the actually-rendered rectangle of a replaced media element
  // (<img>/<video>) in viewport coordinates, accounting for object-fit
  // letterboxing. A naive getBoundingClientRect() returns the element box,
  // which for object-fit:contain/cover differs from where the pixels actually
  // are — breaking normalized-bbox mapping. Returns viewport-space
  // {left, top, width, height}. Falls back to the element box when natural
  // dimensions are unknown or object-fit is fill.
  function getRenderedMediaRect(el) {
    const rect = el.getBoundingClientRect();
    const base = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    const natW = el.naturalWidth || el.videoWidth || 0;
    const natH = el.naturalHeight || el.videoHeight || 0;
    if (!natW || !natH || rect.width === 0 || rect.height === 0) return base;
    let fit = "fill";
    try {
      fit = getComputedStyle(el).objectFit || "fill";
    } catch {
      /* ignore */
    }
    if (fit === "fill") return base;

    const scaleContain = Math.min(rect.width / natW, rect.height / natH);
    const scaleCover = Math.max(rect.width / natW, rect.height / natH);
    let scale;
    if (fit === "contain") scale = scaleContain;
    else if (fit === "cover") scale = scaleCover;
    else if (fit === "scale-down") scale = Math.min(1, scaleContain);
    else if (fit === "none") scale = 1;
    else return base;

    const renderW = natW * scale;
    const renderH = natH * scale;
    // object-position defaults to 50% 50% (centered). We assume the common
    // centered case; non-centered object-position is rare for content imagery.
    return {
      left: rect.left + (rect.width - renderW) / 2,
      top: rect.top + (rect.height - renderH) / 2,
      width: renderW,
      height: renderH,
    };
  }

  // True when an element is a viable crop/highlight source: still in the DOM,
  // has layout size, and has decoded natural pixels we can map normalized
  // coordinates onto.
  function isUsableSourceEl(el) {
    if (!el || !document.contains(el)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const natW = el.naturalWidth || el.videoWidth || 0;
    const natH = el.naturalHeight || el.videoHeight || 0;
    return natW > 0 && natH > 0;
  }

  // Resolve the current source element for the active search context. The
  // element captured at search time may have been detached or had its src
  // swapped (SPA navigation, lazy-loaders). When that happens we try to
  // re-find the original image by its recorded src before giving up.
  function resolveSourceEl() {
    const ctx = lastSearchContext;
    if (!ctx) return null;
    const el = ctx.sourceEl;
    if (isUsableSourceEl(el)) {
      if (!ctx.sourceSrc || el.currentSrc === ctx.sourceSrc || el.src === ctx.sourceSrc) {
        return el;
      }
    }
    const re = findImgBySrc(ctx.sourceSrc);
    if (isUsableSourceEl(re)) {
      ctx.sourceEl = re;
      return re;
    }
    // Fail closed: the recorded src is present but no longer matches the
    // captured element and cannot be re-found (SPA swap / lazy-loader reuse).
    // Returning the swapped element would crop/highlight the wrong image, so
    // give up instead — the CTA simply won't show and tap shows "uncroppable".
    return null;
  }

  function showObjectHighlight(bbox) {
    const el = resolveSourceEl();
    if (!el || !bbox) return;
    const rect = getRenderedMediaRect(el);
    if (rect.width === 0 || rect.height === 0) return;
    const shadow = ensureHighlightHost();
    const box = shadow.querySelector(".box");
    box.style.left = `${rect.left + window.scrollX + bbox.x * rect.width}px`;
    box.style.top = `${rect.top + window.scrollY + bbox.y * rect.height}px`;
    box.style.width = `${bbox.width * rect.width}px`;
    box.style.height = `${bbox.height * rect.height}px`;
  }

  function clearObjectHighlight() {
    if (!highlightHost) return;
    highlightHost.remove();
    highlightHost = null;
    highlightShadow = null;
  }

  function openPanel(state) {
    const shadow = ensurePanel();
    renderPanelState(shadow, state);
  }

  function showPanelError(msg) {
    openPanel({ kind: "error", message: msg });
  }

  // Last successful search context — kept so "Not quite right?" chips can
  // re-call /search with the same imageHash while only swapping the query.
  let lastSearchContext = null;
  // The full-image results state/context, preserved so "Back to full image"
  // can restore the original view after a tap-to-detect region search.
  let lastFullResultsState = null;
  let lastFullContext = null;
  // Data URL of the most recent region crop (panel thumbnail). null when the
  // crop was performed server-side (CORS fallback).
  let lastRegionThumb = null;

  function handleSearchResponse(resp) {
    if (!resp) {
      showPanelError("No response from extension background.");
      return;
    }
    if (resp.ok === false) {
      showPanelError(resp.error ?? "Search failed");
      return;
    }
    const products = Array.isArray(resp.products) ? resp.products : [];
    const query = resp.query ?? null;
    const enrichment = resp.enrichment ?? null;
    const imageHash = typeof resp.imageHash === "string" ? resp.imageHash : null;
    const isImageSearch = resp.isImageSearch !== false && (imageHash !== null || enrichment !== null);
    const objectsDetected = Array.isArray(resp.objectsDetected) ? resp.objectsDetected : [];
    const { chips: objectCandidates, defaultQuery: defaultObjectQuery } = buildObjectChips(
      objectsDetected,
      enrichment,
    );
    // All detected boxes (normalized) drive tap-to-detect snapping and the
    // dashed shortcut outlines in the overlay — independent of the chip rules.
    const detectedBoxes = objectsDetected
      .map((o) => ({
        label: typeof o?.label === "string" ? o.label : "",
        bbox: normaliseBbox(o?.boundingBox ?? o?.bbox),
      }))
      .filter((o) => o.bbox);
    lastSearchContext = {
      imageHash,
      enrichment,
      isImageSearch,
      objectCandidates,
      defaultObjectQuery,
      detectedBoxes,
      // The on-page element this search came from — used to outline the
      // region a chip refers to on hover/focus and as the tap-to-detect crop
      // source. May be null (graceful skip).
      sourceEl: pendingSourceEl,
      sourceSrc: pendingSourceEl ? pendingSourceEl.currentSrc || pendingSourceEl.src || null : null,
      regionSearch: false,
    };
    const fullState = {
      kind: "results",
      products,
      query,
      enrichment,
      isImageSearch,
      objectCandidates,
      defaultObjectQuery,
    };
    lastFullResultsState = fullState;
    lastFullContext = lastSearchContext;
    openPanel(fullState);
  }

  async function refineSearch(label) {
    if (!label || !lastSearchContext) return;
    // Snapshot the context now so a concurrent NEUTRALENS_SEARCH starting
    // mid-flight can't cross-wire enrichment/chips into this re-render.
    const ctx = lastSearchContext;
    openPanel({ kind: "loading", title: `Searching for "${label}"…` });
    try {
      const resp = await chrome.runtime.sendMessage({
        type: "NEUTRALENS_REFINE_SEARCH",
        payload: { query: label, imageHash: ctx.imageHash },
      });
      if (!resp || resp.ok === false) {
        showPanelError(resp?.error ?? "Search failed");
        return;
      }
      const products = Array.isArray(resp.products) ? resp.products : [];
      // Preserve the original enrichment so the chips stay visible — the
      // user may want to try a different alternative. If the refine returned
      // nothing, surface a hint inline rather than the generic "No matches".
      const refinedState = {
        kind: "results",
        products,
        query: resp.query ?? label,
        enrichment: ctx.enrichment,
        isImageSearch: ctx.isImageSearch,
        chosenLabel: label,
        objectCandidates: ctx.objectCandidates,
        defaultObjectQuery: ctx.defaultObjectQuery,
        regionSearch: ctx.regionSearch,
        regionThumb: ctx.regionThumb,
        emptyHint:
          products.length === 0
            ? `No matches for "${label}". Try another option above.`
            : null,
      };
      // Keep "Back to full image" pointing at the full-image view: only a
      // full-image refine updates the saved state, not a within-region refine.
      if (!ctx.regionSearch) {
        lastFullResultsState = refinedState;
        lastFullContext = ctx;
      }
      openPanel(refinedState);
    } catch (err) {
      showPanelError(String(err?.message ?? err));
    }
  }

  // ===================================================================
  // Tap-to-detect: tap a point or drag a rectangle over the source image to
  // crop that region and run a fresh recognise→search on it. Extension-only.
  // ===================================================================

  const UNCROPPABLE_MSG =
    "This image can't be cropped here — try right-clicking the specific object instead.";
  const NEUTRALENS_BLUE = "#2563eb";
  // Brand palette for the branded detection markers (visual only).
  const MARKER_BLUE = "#185FA5";
  const MARKER_NAVY = "#1B3A5C";
  // Short brand confirmation beat before the (unchanged) region search runs.
  const SELECT_CONFIRM_MS = 240;

  // Inline branded blue dot marker. Active (selected) state swaps center to navy.
  function markerDotSvg(active) {
    return `<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="11" fill="#ffffff" fill-opacity="0.5"/>
      <circle cx="12" cy="12" r="8" fill="#ffffff"/>
      <circle cx="12" cy="12" r="6" fill="${active ? MARKER_NAVY : MARKER_BLUE}"/>
      <circle cx="9.3" cy="9.3" r="1.8" fill="#ffffff" fill-opacity="0.85"/>
    </svg>`;
  }

  let tapHost = null;
  let tapShadow = null;
  let tapReposition = null;
  let tapResizeObs = null;
  let tapDrag = null;
  let tapConfirmTimer = null;

  function clamp01(n) {
    return n < 0 ? 0 : n > 1 ? 1 : n;
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error("image load failed"));
      im.src = src;
    });
  }

  // Crop a normalized region {x,y,width,height} (0..1) out of an already-loaded
  // media source via canvas. Upscales small crops to >=256px on the short edge
  // so recognition has enough pixels. Throws an error named "tainted" when the
  // canvas is CORS-tainted (caller falls back to a server-side crop).
  function cropRegionToDataUrl(source, natW, natH, region) {
    const sx = Math.max(0, region.x * natW);
    const sy = Math.max(0, region.y * natH);
    const sw = Math.max(1, Math.min(natW - sx, region.width * natW));
    const sh = Math.max(1, Math.min(natH - sy, region.height * natH));
    const minEdge = Math.min(sw, sh);
    const scale = minEdge > 0 ? Math.max(1, 256 / minEdge) : 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(sw * scale));
    canvas.height = Math.max(1, Math.round(sh * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas unavailable");
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    try {
      return canvas.toDataURL("image/jpeg", 0.9);
    } catch {
      const err = new Error("tainted");
      err.name = "tainted";
      throw err;
    }
  }

  function cropSourceRegion(el, region) {
    const natW = el.naturalWidth || el.videoWidth || 0;
    const natH = el.naturalHeight || el.videoHeight || 0;
    if (!natW || !natH) throw new Error("Image not fully loaded");
    return cropRegionToDataUrl(el, natW, natH, region);
  }

  async function cropDataUrlRegion(dataUrl, region) {
    const im = await loadImage(dataUrl);
    const natW = im.naturalWidth || 0;
    const natH = im.naturalHeight || 0;
    if (!natW || !natH) throw new Error("Image not fully loaded");
    return cropRegionToDataUrl(im, natW, natH, region);
  }

  // A tap point (viewport coords) → normalized crop region. Snaps to a detected
  // object's bbox when the tap lands inside one; otherwise a centered ~40% box.
  function regionFromTap(clientX, clientY, overlayRect) {
    const px = clamp01((clientX - overlayRect.left) / overlayRect.width);
    const py = clamp01((clientY - overlayRect.top) / overlayRect.height);
    const boxes = (lastSearchContext && lastSearchContext.detectedBoxes) || [];
    for (const b of boxes) {
      const bb = b.bbox;
      if (px >= bb.x && px <= bb.x + bb.width && py >= bb.y && py <= bb.y + bb.height) {
        // Clamp to [0,1] in case a model bbox extends past the image edges.
        const x = clamp01(bb.x);
        const y = clamp01(bb.y);
        const width = Math.max(0.02, clamp01(bb.x + bb.width) - x);
        const height = Math.max(0.02, clamp01(bb.y + bb.height) - y);
        return { x: Math.min(x, 1 - width), y: Math.min(y, 1 - height), width, height };
      }
    }
    let x = px - 0.2;
    if (x < 0) x = 0;
    if (x + 0.4 > 1) x = 0.6;
    let y = py - 0.2;
    if (y < 0) y = 0;
    if (y + 0.4 > 1) y = 0.6;
    return { x, y, width: 0.4, height: 0.4 };
  }

  function regionFromDrag(drag, overlayRect) {
    const x0 = clamp01((Math.min(drag.x0, drag.x1) - overlayRect.left) / overlayRect.width);
    const y0 = clamp01((Math.min(drag.y0, drag.y1) - overlayRect.top) / overlayRect.height);
    const x1 = clamp01((Math.max(drag.x0, drag.x1) - overlayRect.left) / overlayRect.width);
    const y1 = clamp01((Math.max(drag.y0, drag.y1) - overlayRect.top) / overlayRect.height);
    const width = Math.max(0.02, x1 - x0);
    const height = Math.max(0.02, y1 - y0);
    return { x: Math.min(x0, 1 - width), y: Math.min(y0, 1 - height), width, height };
  }

  function positionTapOverlay(el) {
    if (!tapHost) return;
    const rect = getRenderedMediaRect(el);
    tapHost.style.left = `${rect.left + window.scrollX}px`;
    tapHost.style.top = `${rect.top + window.scrollY}px`;
    tapHost.style.width = `${rect.width}px`;
    tapHost.style.height = `${rect.height}px`;
  }

  function tapOverlayHtml(boxes) {
    const dotsHtml = boxes
      .map(
        (b, i) =>
          `<div class="nl-dot pulse" data-dot="${i}" style="left:${(b.bbox.x + b.bbox.width / 2) * 100}%;top:${(b.bbox.y + b.bbox.height / 2) * 100}%">${markerDotSvg(false)}</div>`,
      )
      .join("");
    const badgeUrl = chrome.runtime.getURL("icon128.png");
    return `
      <style>
        :host, .ov { all: initial; }
        .ov {
          position: absolute; inset: 0; cursor: crosshair; box-sizing: border-box;
          box-shadow: 0 0 0 2px ${NEUTRALENS_BLUE}; touch-action: none;
        }
        .nl-dot {
          position: absolute; width: 24px; height: 24px; pointer-events: none;
          transform: translate(-50%, -50%);
          filter: drop-shadow(0 0 2px rgba(255,255,255,0.9));
        }
        .nl-dot svg { display: block; }
        .nl-dot.pulse { animation: nlMarkerPulse 1.6s ease-in-out infinite; }
        @keyframes nlMarkerPulse {
          0%, 100% { transform: translate(-50%, -50%) scale(1); }
          50% { transform: translate(-50%, -50%) scale(1.12); }
        }
        @media (prefers-reduced-motion: reduce) {
          .nl-dot.pulse { animation: none; transform: translate(-50%, -50%); }
        }
        .sel {
          position: absolute; box-sizing: border-box; pointer-events: none;
          display: none; border: 2px solid ${MARKER_BLUE};
          background: rgba(24,95,165,0.18); border-radius: 2px;
        }
        .committed {
          position: absolute; box-sizing: border-box; pointer-events: none;
          display: none; border: 2px solid ${MARKER_BLUE};
          background: rgba(24,95,165,0.12); border-radius: 2px;
        }
        .badge {
          position: absolute; width: 32px; height: 32px; pointer-events: none;
          display: none; filter: drop-shadow(0 1px 2px rgba(0,0,0,0.35));
        }
        .hint {
          position: absolute; top: 8px; left: 50%; transform: translateX(-50%);
          background: rgba(15,23,42,0.92); color: #fff; pointer-events: none;
          font: 600 12px/1.2 -apple-system, system-ui, sans-serif;
          padding: 6px 10px; border-radius: 999px; white-space: nowrap;
          max-width: 92%; overflow: hidden; text-overflow: ellipsis;
        }
        .done {
          position: absolute; top: 8px; right: 8px; cursor: pointer;
          background: ${NEUTRALENS_BLUE}; color: #fff; border: 0;
          font: 600 12px/1 -apple-system, system-ui, sans-serif;
          padding: 7px 12px; border-radius: 999px;
        }
      </style>
      <div class="ov">
        ${dotsHtml}
        <div class="sel"></div>
        <div class="committed"></div>
        <img class="badge" src="${badgeUrl}" alt="" aria-hidden="true" />
        <div class="hint">Tap an object, or drag a box</div>
        <button class="done" type="button" data-done>Done</button>
      </div>
    `;
  }

  function updateSelRect(ov, sel) {
    if (!tapDrag || !tapDrag.moved) {
      sel.style.display = "none";
      return;
    }
    const overlayRect = ov.getBoundingClientRect();
    sel.style.display = "block";
    sel.style.left = `${Math.min(tapDrag.x0, tapDrag.x1) - overlayRect.left}px`;
    sel.style.top = `${Math.min(tapDrag.y0, tapDrag.y1) - overlayRect.top}px`;
    sel.style.width = `${Math.abs(tapDrag.x1 - tapDrag.x0)}px`;
    sel.style.height = `${Math.abs(tapDrag.y1 - tapDrag.y0)}px`;
  }

  function activateTapMode() {
    const el = resolveSourceEl();
    if (!el) {
      showPanelError(UNCROPPABLE_MSG);
      return;
    }
    deactivateTapMode();
    clearObjectHighlight();
    const boxes = (lastSearchContext && lastSearchContext.detectedBoxes) || [];
    tapHost = document.createElement("div");
    tapHost.setAttribute("data-neutralens-host", "tap-overlay");
    tapHost.style.cssText =
      "position: absolute; z-index: 2147483646; margin: 0; padding: 0; border: 0; top: 0; left: 0; pointer-events: auto;";
    tapShadow = tapHost.attachShadow({ mode: "closed" });
    tapShadow.innerHTML = tapOverlayHtml(boxes);
    document.documentElement.appendChild(tapHost);
    positionTapOverlay(el);

    tapReposition = () => positionTapOverlay(el);
    window.addEventListener("scroll", tapReposition, { passive: true });
    window.addEventListener("resize", tapReposition, { passive: true });
    try {
      tapResizeObs = new ResizeObserver(tapReposition);
      tapResizeObs.observe(el);
    } catch {
      /* ignore */
    }

    const ov = tapShadow.querySelector(".ov");
    const sel = tapShadow.querySelector(".sel");
    const committed = tapShadow.querySelector(".committed");
    const badge = tapShadow.querySelector(".badge");
    // Guard so the brief branded confirmation can't be re-triggered mid-commit.
    let tapCommitted = false;

    // Paint the branded "selected" stamp: highlight the hit dot (navy center),
    // outline the region, and stamp the n badge in its corner. Visual only —
    // the search region itself is unchanged.
    function showCommitted(region, overlayRect, moved) {
      const left = region.x * overlayRect.width;
      const top = region.y * overlayRect.height;
      const width = region.width * overlayRect.width;
      const height = region.height * overlayRect.height;
      committed.style.display = "block";
      committed.style.left = `${left}px`;
      committed.style.top = `${top}px`;
      committed.style.width = `${width}px`;
      committed.style.height = `${height}px`;
      badge.style.display = "block";
      badge.style.left = `${left - 10}px`;
      badge.style.top = `${top - 10}px`;
      // Only a tap (not a drag) on a detected object swaps its dot to active,
      // matching the web/mobile behavior.
      if (moved) return;
      const cx = region.x + region.width / 2;
      const cy = region.y + region.height / 2;
      const dots = tapShadow.querySelectorAll(".nl-dot");
      const boxes = (lastSearchContext && lastSearchContext.detectedBoxes) || [];
      dots.forEach((dot, i) => {
        const bb = boxes[i] && boxes[i].bbox;
        const active =
          bb &&
          cx >= bb.x &&
          cx <= bb.x + bb.width &&
          cy >= bb.y &&
          cy <= bb.y + bb.height;
        if (active) {
          dot.classList.remove("pulse");
          dot.innerHTML = markerDotSvg(true);
        }
      });
    }

    tapShadow.querySelector("[data-done]").addEventListener("click", (e) => {
      e.stopPropagation();
      deactivateTapMode();
    });
    ov.addEventListener("pointerdown", (e) => {
      if (e.target.closest("[data-done]") || tapCommitted) return;
      e.preventDefault();
      try {
        ov.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      tapDrag = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, moved: false };
      updateSelRect(ov, sel);
    });
    ov.addEventListener("pointermove", (e) => {
      if (!tapDrag || tapCommitted) return;
      tapDrag.x1 = e.clientX;
      tapDrag.y1 = e.clientY;
      if (Math.hypot(e.clientX - tapDrag.x0, e.clientY - tapDrag.y0) >= 10) tapDrag.moved = true;
      updateSelRect(ov, sel);
    });
    ov.addEventListener("pointerup", (e) => {
      if (!tapDrag || tapCommitted) return;
      const drag = tapDrag;
      tapDrag = null;
      sel.style.display = "none";
      const overlayRect = ov.getBoundingClientRect();
      if (overlayRect.width <= 0 || overlayRect.height <= 0) return;
      const region = drag.moved
        ? regionFromDrag(drag, overlayRect)
        : regionFromTap(drag.x0, drag.y0, overlayRect);
      // Show the branded selection stamp briefly, then run the unchanged search.
      tapCommitted = true;
      showCommitted(region, overlayRect, drag.moved);
      tapConfirmTimer = setTimeout(() => {
        tapConfirmTimer = null;
        void searchRegion(region);
      }, SELECT_CONFIRM_MS);
    });
  }

  function deactivateTapMode() {
    if (tapReposition) {
      window.removeEventListener("scroll", tapReposition);
      window.removeEventListener("resize", tapReposition);
      tapReposition = null;
    }
    if (tapResizeObs) {
      try {
        tapResizeObs.disconnect();
      } catch {
        /* ignore */
      }
      tapResizeObs = null;
    }
    tapDrag = null;
    if (tapConfirmTimer) {
      clearTimeout(tapConfirmTimer);
      tapConfirmTimer = null;
    }
    if (tapHost) {
      tapHost.remove();
      tapHost = null;
      tapShadow = null;
    }
  }

  async function searchRegion(region) {
    const el = resolveSourceEl();
    if (!el) {
      showPanelError(UNCROPPABLE_MSG);
      return;
    }
    deactivateTapMode();
    openPanel({ kind: "loading", title: "Searching selected region…" });
    let dataUrl = null;
    try {
      dataUrl = cropSourceRegion(el, region);
    } catch (err) {
      if (err && err.name === "tainted") {
        // Canvas was CORS-tainted. Try a server-side crop using a resolvable
        // https URL; if the image only exists as local blob bytes, crop those
        // locally; otherwise we can't crop it at all.
        const src = el.currentSrc || el.src || "";
        let resolved;
        try {
          resolved = await resolveImageUrl(src, el);
        } catch {
          resolved = { type: "fallback", value: src };
        }
        if (resolved.type === "url") {
          lastRegionThumb = null;
          try {
            const resp = await chrome.runtime.sendMessage({
              type: "NEUTRALENS_SEARCH",
              payload: {
                imageUrl: resolved.value,
                cropRegion: region,
                source: "ext-tap",
                sourceUrl: window.location.href,
              },
            });
            renderRegionResponse(resp);
          } catch (e2) {
            showPanelError(String(e2?.message ?? e2));
          }
          return;
        }
        if (resolved.type === "dataUrl") {
          try {
            dataUrl = await cropDataUrlRegion(resolved.value, region);
          } catch {
            showPanelError(UNCROPPABLE_MSG);
            return;
          }
        } else {
          showPanelError(UNCROPPABLE_MSG);
          return;
        }
      } else {
        showPanelError(String(err?.message ?? err));
        return;
      }
    }
    lastRegionThumb = dataUrl;
    try {
      const resp = await chrome.runtime.sendMessage({
        type: "NEUTRALENS_SEARCH",
        payload: { imageDataUrl: dataUrl, source: "ext-tap", sourceUrl: window.location.href },
      });
      renderRegionResponse(resp);
    } catch (e) {
      showPanelError(String(e?.message ?? e));
    }
  }

  function renderRegionResponse(resp) {
    if (!resp) {
      showPanelError("No response from extension background.");
      return;
    }
    if (resp.ok === false) {
      showPanelError(resp.error ?? "Search failed");
      return;
    }
    const products = Array.isArray(resp.products) ? resp.products : [];
    const enrichment = resp.enrichment ?? null;
    const imageHash = typeof resp.imageHash === "string" ? resp.imageHash : null;
    // Region results refine against the cropped image's own hash. No object
    // picker / source highlight (the crop is not an on-page element).
    lastSearchContext = {
      imageHash,
      enrichment,
      isImageSearch: true,
      objectCandidates: [],
      defaultObjectQuery: null,
      detectedBoxes: [],
      sourceEl: null,
      sourceSrc: null,
      regionSearch: true,
      regionThumb: lastRegionThumb,
    };
    openPanel({
      kind: "results",
      products,
      query: resp.query ?? null,
      enrichment,
      isImageSearch: true,
      objectCandidates: [],
      regionSearch: true,
      regionThumb: lastRegionThumb,
      emptyHint:
        products.length === 0 ? "No matches for that region. Try another area." : null,
    });
  }

  function backToFullImage() {
    if (!lastFullResultsState) return;
    deactivateTapMode();
    lastSearchContext = lastFullContext;
    openPanel(lastFullResultsState);
  }

  // Region bar shown above results after a tap-to-detect search: crop
  // thumbnail, label, and "Back to full image".
  function renderRegionBarHtml(state) {
    if (!state.regionSearch) return "";
    const thumb = state.regionThumb
      ? `<img class="region-thumb" src="${escapeHtml(state.regionThumb)}" alt="" />`
      : "";
    return `
      <div class="region-bar">
        ${thumb}
        <div class="region-label">Searching selected region</div>
        <button type="button" class="region-back" data-back-full>Back to full image</button>
      </div>
    `;
  }

  function panelHtml() {
    return `
      <style>
        :host, .root { all: initial; }
        .root {
          display: flex; flex-direction: column;
          background: #ffffff; color: #0f172a;
          font: 13px/1.45 -apple-system, "Segoe UI", system-ui, sans-serif;
          border-radius: 12px; overflow: hidden;
          box-shadow: 0 12px 32px rgba(15,23,42,0.18), 0 2px 6px rgba(15,23,42,0.10);
          border: 1px solid rgba(15,23,42,0.10);
        }
        @media (prefers-color-scheme: dark) {
          .root { background: #0b1220; color: #e2e8f0; border-color: rgba(255,255,255,0.10); }
          .header { background: #111a2c !important; }
          .item { border-color: rgba(255,255,255,0.08) !important; }
          .price { color: #f1f5f9 !important; }
          .meta { color: #94a3b8 !important; }
        }
        .header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 10px 12px; background: #f8fafc;
          cursor: grab; user-select: none;
          border-bottom: 1px solid rgba(15,23,42,0.08);
        }
        .header:active { cursor: grabbing; }
        .title { font: 600 13px/1 ui-serif, Georgia, serif; letter-spacing: 0.01em; }
        .close {
          background: transparent; border: 0; color: inherit; cursor: pointer;
          font: 600 16px/1 system-ui, sans-serif; padding: 4px 8px; border-radius: 6px;
        }
        .close:hover { background: rgba(15,23,42,0.06); }
        .body { padding: 12px; overflow: auto; max-height: 60vh; }
        .empty, .err, .loading { padding: 20px 12px; text-align: center; color: #64748b; }
        .err { color: #b91c1c; }
        .item {
          display: grid; grid-template-columns: 56px 1fr auto; gap: 10px;
          padding: 10px; border: 1px solid rgba(15,23,42,0.08); border-radius: 8px;
          align-items: center;
        }
        .item + .item { margin-top: 8px; }
        .item img { width: 56px; height: 56px; object-fit: cover; border-radius: 6px; background: #f1f5f9; }
        .name { font-weight: 500; }
        .name a { color: inherit; text-decoration: none; }
        .name a:hover { text-decoration: underline; }
        .meta { font-size: 11px; color: #64748b; margin-top: 2px; }
        .price { font-weight: 700; tabular-nums: 1; white-space: nowrap; }
        .footer {
          padding: 8px 12px; font-size: 11px; color: #64748b;
          border-top: 1px solid rgba(15,23,42,0.06);
          display: flex; justify-content: space-between; align-items: center;
        }
        .footer a { color: inherit; text-decoration: underline; }
        .enrichment {
          border: 1px solid #a7f3d0; background: #ecfdf5;
          border-radius: 8px; padding: 10px; margin-bottom: 10px;
          color: #064e3b;
        }
        @media (prefers-color-scheme: dark) {
          .enrichment { background: rgba(16,185,129,0.08); border-color: rgba(16,185,129,0.35); color: #d1fae5; }
          .enrich-tag { color: #6ee7b7 !important; }
          .enrich-meta { color: #94a3b8 !important; }
          .chip { background: #0b1220 !important; border-color: rgba(16,185,129,0.45) !important; color: #d1fae5 !important; }
          .chip:hover:not(:disabled) { background: rgba(16,185,129,0.15) !important; }
          .badge { background: #0b1220 !important; }
        }
        .enrich-tag {
          font: 600 10px/1 -apple-system, system-ui, sans-serif;
          letter-spacing: 0.06em; text-transform: uppercase;
          color: #047857; margin-bottom: 4px;
        }
        .enrich-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
        .enrich-label {
          font: 600 10px/1 -apple-system, system-ui, sans-serif;
          letter-spacing: 0.06em; text-transform: uppercase;
          color: #64748b; margin-bottom: 2px;
        }
        .enrich-identified { font: 600 13px/1.3 -apple-system, system-ui, sans-serif; word-break: break-word; }
        .enrich-meta { font-size: 11px; color: #475569; margin-top: 2px; text-transform: capitalize; }
        .badge {
          font: 500 10px/1 -apple-system, system-ui, sans-serif;
          padding: 3px 6px; border-radius: 999px; white-space: nowrap;
          background: #ffffff; border: 1px solid;
        }
        .badge.medium { border-color: #6ee7b7; color: #047857; }
        .badge.low { border-color: #fcd34d; color: #b45309; }
        .chips-label { font-size: 11px; color: #475569; margin: 8px 0 4px; }
        .object-picker { margin-bottom: 10px; }
        .object-picker .chips-label { margin-top: 0; font-weight: 600; }
        .tap-cta { margin: 0 0 10px; }
        .tap-btn {
          width: 100%; cursor: pointer;
          font: 600 12px/1 -apple-system, system-ui, sans-serif;
          padding: 9px 12px; border-radius: 8px;
          border: 1px solid #2563eb; background: #2563eb; color: #ffffff;
        }
        .tap-btn:hover { background: #1d4ed8; border-color: #1d4ed8; }
        .region-bar {
          display: flex; align-items: center; gap: 8px;
          margin-bottom: 10px; padding-bottom: 10px;
          border-bottom: 1px solid rgba(15,23,42,0.08);
        }
        .region-thumb {
          width: 40px; height: 40px; object-fit: cover; flex: none;
          border-radius: 6px; border: 1px solid rgba(15,23,42,0.12);
        }
        .region-label { font-size: 12px; font-weight: 600; color: #2563eb; flex: 1; }
        .region-back {
          cursor: pointer; flex: none;
          font: 500 11px/1 -apple-system, system-ui, sans-serif;
          padding: 6px 10px; border-radius: 999px;
          border: 1px solid #2563eb; background: #ffffff; color: #2563eb;
        }
        .region-back:hover { background: #eff6ff; }
        .chips { display: flex; flex-wrap: wrap; gap: 6px; }
        .chip {
          font: 500 11px/1 -apple-system, system-ui, sans-serif;
          padding: 4px 10px; border-radius: 999px;
          border: 1px solid #6ee7b7; background: #ffffff; color: #064e3b;
          cursor: pointer;
        }
        .chip:hover:not(:disabled) { background: #d1fae5; }
        .chip:disabled { opacity: 0.5; cursor: default; }
        .chip[data-active="true"] { background: #047857; color: #ffffff; border-color: #047857; }
        .spinner {
          width: 18px; height: 18px; border-radius: 50%;
          border: 2px solid rgba(100,116,139,0.3); border-top-color: #0f172a;
          animation: spin 0.8s linear infinite; margin: 0 auto 8px;
        }
        @media (prefers-color-scheme: dark) {
          .spinner { border-top-color: #e2e8f0; }
        }
        @keyframes spin { to { transform: rotate(360deg); } }
      </style>
      <div class="root">
        <div class="header">
          <div class="title">Neutralens</div>
          <button class="close" type="button" aria-label="Close">×</button>
        </div>
        <div class="body" data-body></div>
        <div class="footer">
          <span>Neutral ranking — no sponsored slots</span>
          <a href="https://neutralens.com" target="_blank" rel="noreferrer">Open</a>
        </div>
      </div>
    `;
  }

  function renderPanelState(shadow, state) {
    const body = shadow.querySelector("[data-body]");
    if (!body) return;
    if (state.kind === "loading") {
      body.innerHTML = `<div class="loading"><div class="spinner"></div>${escapeHtml(state.title ?? "Searching…")}</div>`;
      return;
    }
    if (state.kind === "error") {
      body.innerHTML = `<div class="err">${escapeHtml(state.message ?? "Search failed")}</div>`;
      return;
    }
    if (state.kind === "results") {
      // Drop any leftover highlight from a prior hover before re-rendering.
      clearObjectHighlight();
      const items = state.products ?? [];
      const regionBarHtml = renderRegionBarHtml(state);
      const objectPickerHtml = renderObjectPickerHtml(state);
      // Offer tap-to-detect only on full-image searches whose source element is
      // still a usable on-page image/video we can crop from.
      const canTap = !state.regionSearch && isUsableSourceEl(resolveSourceEl());
      const tapCtaHtml = canTap
        ? `<div class="tap-cta"><button type="button" class="tap-btn" data-tap-detect>Tap to detect any object</button></div>`
        : "";
      const enrichmentHtml = renderEnrichmentHtml(state);
      const itemsHtml =
        items.length === 0
          ? `<div class="empty">${escapeHtml(state.emptyHint ?? "No matches found.")}</div>`
          : items
              .slice(0, 10)
              .map(
                (p) => `
            <div class="item">
              <img src="${escapeHtml(p.imageUrl ?? "")}" alt="" />
              <div>
                <div class="name"><a href="${escapeHtml(p.affiliateUrl ?? p.productUrl ?? "#")}" target="_blank" rel="noreferrer">${escapeHtml(p.title ?? "Product")}</a></div>
                <div class="meta">${escapeHtml(p.retailer ?? "")}</div>
              </div>
              <div class="price">${formatPrice(p.itemPrice, p.currency)}</div>
            </div>
          `,
              )
              .join("");
      body.innerHTML = regionBarHtml + objectPickerHtml + tapCtaHtml + enrichmentHtml + itemsHtml;
      // Wire the tap-to-detect entry and "Back to full image" controls.
      const tapBtn = body.querySelector("[data-tap-detect]");
      if (tapBtn) tapBtn.addEventListener("click", () => activateTapMode());
      const backBtn = body.querySelector("[data-back-full]");
      if (backBtn) backBtn.addEventListener("click", () => backToFullImage());
      // Wire chip clicks (closed Shadow DOM — handlers must be attached via JS).
      body.querySelectorAll("[data-alt]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const label = btn.getAttribute("data-alt");
          // Visual feedback before the next render replaces the panel.
          body.querySelectorAll("[data-alt]").forEach((b) => (b.disabled = true));
          btn.setAttribute("data-active", "true");
          refineSearch(label);
        });
      });
      // Wire object-picker chips — re-run the search with the chip's underlying
      // query value (full enriched search_query for the default chip). On
      // hover/focus, outline the matching region on the source image.
      body.querySelectorAll("[data-object-query]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const q = btn.getAttribute("data-object-query");
          body.querySelectorAll("[data-object-query]").forEach((b) => (b.disabled = true));
          btn.setAttribute("data-active", "true");
          refineSearch(q);
        });
        const bboxStr = btn.getAttribute("data-bbox");
        if (bboxStr) {
          const [x, y, w, h] = bboxStr.split(",").map(Number);
          const bbox = { x, y, width: w, height: h };
          const show = () => showObjectHighlight(bbox);
          btn.addEventListener("mouseenter", show);
          btn.addEventListener("focus", show);
          btn.addEventListener("mouseleave", clearObjectHighlight);
          btn.addEventListener("blur", clearObjectHighlight);
        }
      });
    }
  }

  function titleCase(s) {
    return String(s).replace(
      /\w\S*/g,
      (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
    );
  }

  // Coerce a detected object's normalized bounding box (server sends
  // `boundingBox`; older payloads may use `bbox`) into {x,y,width,height}.
  // Returns null for missing/degenerate boxes so highlighting is skipped.
  function normaliseBbox(b) {
    if (!b || typeof b !== "object") return null;
    const x = Number(b.x);
    const y = Number(b.y);
    const width = Number(b.width);
    const height = Number(b.height);
    if (![x, y, width, height].every((n) => Number.isFinite(n))) return null;
    if (width <= 0 || height <= 0) return null;
    return { x, y, width, height };
  }

  // Build the "What are you looking for?" object-picker chips. Each chip has a
  // display label (shortened) and an underlying query value that drives the
  // actual search. The highest-confidence object becomes the default; when
  // enrichment ran, its display is the enriched product name but its query is
  // the FULL enriched search_query (so re-selecting it never downgrades to a
  // generic Vision label like "shoe"). Returns no chips when fewer than two
  // objects clear the 0.60 confidence bar — single-object images behave as
  // before.
  function buildObjectChips(objects, enrichment) {
    const seen = new Set();
    const raw = [];
    for (const o of Array.isArray(objects) ? objects : []) {
      if (!o || typeof o.label !== "string") continue;
      const conf = typeof o.confidence === "number" ? o.confidence : 0;
      if (conf <= 0.6) continue;
      const key = o.label.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      raw.push({
        label: o.label.trim(),
        confidence: conf,
        bbox: normaliseBbox(o.boundingBox ?? o.bbox),
      });
    }
    raw.sort((a, b) => b.confidence - a.confidence);
    if (raw.length <= 1) return { chips: [], defaultQuery: null };

    const enrichedQuery =
      enrichment && typeof enrichment.search_query === "string" && enrichment.search_query.trim().length > 0
        ? enrichment.search_query.trim()
        : null;
    const brand = enrichment && typeof enrichment.brand === "string" ? enrichment.brand.trim() : "";
    const productName =
      enrichment && typeof enrichment.product_name === "string" ? enrichment.product_name.trim() : "";
    const enrichedDisplay =
      brand && productName ? `${brand} ${productName}` : brand || productName || null;

    const chips = raw.map((c, i) =>
      i === 0 && enrichedQuery
        ? { display: enrichedDisplay ?? titleCase(c.label), query: enrichedQuery, bbox: c.bbox }
        : { display: titleCase(c.label), query: c.label, bbox: c.bbox },
    );
    return { chips, defaultQuery: chips[0].query };
  }

  // Render the object-picker row (above results). Active chip = the one the
  // user last chose, defaulting to the enriched/highest-confidence chip whose
  // result is already on screen.
  function renderObjectPickerHtml(state) {
    const chips = state.objectCandidates ?? [];
    if (chips.length <= 1) return "";
    const activeQuery = state.chosenLabel ?? state.defaultObjectQuery ?? null;
    const chipsHtml = chips
      .map(
        (c) => `
        <button type="button" class="chip" data-object-query="${escapeHtml(c.query)}"${
          c.bbox
            ? ` data-bbox="${c.bbox.x},${c.bbox.y},${c.bbox.width},${c.bbox.height}"`
            : ""
        }${
          activeQuery && activeQuery === c.query ? ` data-active="true"` : ""
        }>${escapeHtml(c.display)}</button>
      `,
      )
      .join("");
    return `
      <div class="object-picker">
        <div class="chips-label">What are you looking for?</div>
        <div class="chips">${chipsHtml}</div>
      </div>
    `;
  }

  // Mirror of the web app's EnrichmentPanel: header tag, identified label,
  // optional metadata line, confidence badge (omitted for high confidence),
  // and "Not quite right?" alternative chips parsed from `enrichment.notes`.
  function renderEnrichmentHtml(state) {
    const enrichment = state.enrichment;
    if (!enrichment) return "";
    const brand = typeof enrichment.brand === "string" ? enrichment.brand.trim() : "";
    const productName =
      typeof enrichment.product_name === "string" ? enrichment.product_name.trim() : "";
    const identified =
      brand && productName ? `${brand} ${productName}` : brand || productName || null;
    const headline = identified ?? enrichment.search_query ?? state.query ?? "Product";
    const metaParts = [enrichment.color, enrichment.material, enrichment.style]
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .filter((v) => v.length > 0);
    const metaHtml =
      metaParts.length > 0
        ? `<div class="enrich-meta">${escapeHtml(metaParts.join(" · "))}</div>`
        : "";
    const tagHtml = state.isImageSearch
      ? `<div class="enrich-tag">AI-identified from creator image</div>`
      : "";
    const conf = enrichment.confidence;
    const badgeHtml =
      conf === "medium"
        ? `<span class="badge medium">Best match</span>`
        : conf === "low"
          ? `<span class="badge low">Approximate match</span>`
          : "";
    // Alternative chips — best-effort comma/semicolon split of `notes`,
    // matching the web app's filter rules (≥3 chars, ≤60 chars, not the
    // identified label, not the search query).
    const baseLower = (identified ?? "").toLowerCase();
    const queryLower = (enrichment.search_query ?? "").toLowerCase();
    const alts =
      typeof enrichment.notes === "string"
        ? enrichment.notes
            .split(/[,;]/)
            .map((s) => s.trim())
            .filter(
              (s) =>
                s.length > 2 &&
                s.length <= 60 &&
                s.toLowerCase() !== baseLower &&
                s.toLowerCase() !== queryLower,
            )
            .slice(0, 4)
        : [];
    const activeLabel = state.chosenLabel ?? null;
    const chipsHtml =
      alts.length > 0
        ? `
          <div class="chips-label">Not quite right?</div>
          <div class="chips">
            ${alts
              .map(
                (alt) => `
              <button type="button" class="chip" data-alt="${escapeHtml(alt)}"${
                  activeLabel && activeLabel === alt ? ` data-active="true"` : ""
                }>${escapeHtml(alt)}</button>
            `,
              )
              .join("")}
          </div>
        `
        : "";
    return `
      <div class="enrichment">
        ${tagHtml}
        <div class="enrich-row">
          <div style="min-width:0">
            <div class="enrich-label">Identified as</div>
            <div class="enrich-identified">${escapeHtml(headline)}</div>
            ${metaHtml}
          </div>
          ${badgeHtml}
        </div>
        ${chipsHtml}
      </div>
    `;
  }

  function formatPrice(amount, currency) {
    if (typeof amount !== "number" || isNaN(amount)) return "";
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: currency || "USD",
      }).format(amount);
    } catch {
      return `$${amount.toFixed(2)}`;
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
    );
  }

  // --- Listen for "open panel for image" from background context-menu ------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "NEUTRALENS_PANEL_LOADING") {
      openPanel({ kind: "loading", title: msg.title });
      return false;
    }
    if (msg?.type === "NEUTRALENS_PANEL_RESULTS") {
      handleSearchResponse(msg.response);
      return false;
    }
    if (msg?.type === "NEUTRALENS_RESOLVE_IMAGE_URL") {
      // Resolve blob:/http:/etc. in the page context where blob URLs are
      // still valid. Always respond, even on error, so the background script
      // never hangs waiting on us.
      (async () => {
        try {
          const resolved = await resolveImageUrl(msg.srcUrl, null);
          sendResponse(resolved);
        } catch (err) {
          sendResponse({ type: "fallback", value: msg.srcUrl ?? "", error: String(err?.message ?? err) });
        }
      })();
      return true;
    }
    return false;
  });
})();
