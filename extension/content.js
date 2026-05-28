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
    panelHost.remove();
    panelHost = null;
    panelShadow = null;
    document.removeEventListener("keydown", onEscape);
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
    lastSearchContext = { imageHash, enrichment, isImageSearch };
    openPanel({ kind: "results", products, query, enrichment, isImageSearch });
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
      openPanel({
        kind: "results",
        products,
        query: resp.query ?? label,
        enrichment: ctx.enrichment,
        isImageSearch: ctx.isImageSearch,
        chosenLabel: label,
        emptyHint:
          products.length === 0
            ? `No matches for "${label}". Try another option above.`
            : null,
      });
    } catch (err) {
      showPanelError(String(err?.message ?? err));
    }
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
      const items = state.products ?? [];
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
      body.innerHTML = enrichmentHtml + itemsHtml;
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
    }
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
