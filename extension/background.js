import { NEUTRALENS_BASE_URL, NEUTRALENS_API_BASE } from "./config.js";

const MENU_IMAGE = "neutralens-search-image";
const MENU_PAGE = "neutralens-search-page";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_IMAGE,
    title: "Search this image with Neutralens",
    contexts: ["image"],
  });
  chrome.contextMenus.create({
    id: MENU_PAGE,
    title: "Find this product on other retailers",
    contexts: ["page", "selection"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === MENU_IMAGE && info.srcUrl) {
    // Target the specific frame the user right-clicked in — Google Images,
    // YouTube cards, embedded shopping widgets, etc. all live in iframes,
    // and blob: URLs are only valid in the frame that minted them. Falls
    // back to the top frame if frameId isn't provided.
    const frameOpts = typeof info.frameId === "number" ? { frameId: info.frameId } : undefined;
    try {
      // Best-effort loading state — content script may not be loaded on
      // restricted pages (chrome://, the Chrome Web Store, etc.). Don't let
      // that abort the rest of the flow.
      try {
        await chrome.tabs.sendMessage(
          tab.id,
          { type: "NEUTRALENS_PANEL_LOADING", title: "Searching image…" },
          frameOpts,
        );
      } catch {
        // ignore — proceed without the loading affordance.
      }
      // Some pages (Google Images lightbox, in-canvas editors) hand us a
      // blob: URL that's only valid inside the page context. Ask the content
      // script to resolve it first — it can either lift a real https URL out
      // of nearby DOM hints, or fetch the blob locally and convert it to a
      // data URL we can pass straight to /recognise.
      let resolved = null;
      try {
        resolved = await chrome.tabs.sendMessage(
          tab.id,
          { type: "NEUTRALENS_RESOLVE_IMAGE_URL", srcUrl: info.srcUrl },
          frameOpts,
        );
      } catch {
        // Content script unreachable. Fall through with a synthesized
        // resolution so the existing path runs unchanged — but only if the
        // URL is something /fetch-image can actually handle (https). blob:
        // and other unfetchable schemes go straight to fallback.
        resolved = info.srcUrl.startsWith("https://")
          ? { type: "url", value: info.srcUrl }
          : { type: "fallback", value: info.srcUrl };
      }
      const sourceUrl = tab.url ?? null;
      let out;
      if (resolved?.type === "dataUrl" && typeof resolved.value === "string") {
        out = await runDataUrlSearch({
          imageDataUrl: resolved.value,
          sourceUrl,
          source: "image",
        });
      } else if (resolved?.type === "url" && typeof resolved.value === "string") {
        out = await runImageSearch({ imageUrl: resolved.value, sourceUrl });
      } else {
        out = openFallback(sourceUrl ?? info.srcUrl);
      }
      await chrome.tabs.sendMessage(tab.id, {
        type: "NEUTRALENS_PANEL_RESULTS",
        response: out,
      });
    } catch (err) {
      if (isContentSafetyError(err)) {
        notifyContentSafety();
        await chrome.tabs.sendMessage(tab.id, {
          type: "NEUTRALENS_PANEL_RESULTS",
          response: { ok: false, error: CONTENT_SAFETY_MESSAGE, code: "CONTENT_SAFETY" },
        });
      } else {
        await chrome.tabs.sendMessage(tab.id, {
          type: "NEUTRALENS_PANEL_RESULTS",
          response: { ok: false, error: String(err?.message ?? err) },
        });
      }
    }
  } else if (info.menuItemId === MENU_PAGE) {
    const query = info.selectionText?.trim();
    const url = query
      ? `${NEUTRALENS_BASE_URL}/?q=${encodeURIComponent(query)}`
      : tab.url
        ? `${NEUTRALENS_BASE_URL}/?url=${encodeURIComponent(tab.url)}`
        : NEUTRALENS_BASE_URL;
    await chrome.tabs.create({ url });
  }
});

// --- Search orchestration ---------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "NEUTRALENS_LINK_TOKEN" && typeof msg.token === "string") {
    // Token handoff comes from the same neutralens.com tab where the user
    // may have just clicked a referral link — invalidate the cached nl_ref
    // so the next fetch picks up the freshly-set cookie.
    invalidateNlRefCache();
    chrome.storage.local.set(
      {
        neutralensToken: msg.token,
        neutralensTier: msg.tier ?? "free",
        neutralensEmail: msg.email ?? null,
        neutralensLinkedAt: Date.now(),
      },
      () => sendResponse({ ok: true }),
    );
    return true;
  }
  if (msg?.type === "NEUTRALENS_REFRESH_ME") {
    invalidateNlRefCache();
    void refreshMe().then(sendResponse).catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
    return true;
  }
  if (msg?.type === "NEUTRALENS_SEARCH" && msg.payload) {
    const { imageUrl, imageDataUrl, sourceUrl, source } = msg.payload;
    (async () => {
      try {
        const out = imageDataUrl
          ? await runDataUrlSearch({ imageDataUrl, sourceUrl, source })
          : await runImageSearch({ imageUrl, sourceUrl, source });
        sendResponse(out);
      } catch (err) {
        if (isContentSafetyError(err)) {
          notifyContentSafety();
          sendResponse({ ok: false, error: CONTENT_SAFETY_MESSAGE, code: "CONTENT_SAFETY" });
        } else {
          sendResponse({ ok: false, error: String(err?.message ?? err) });
        }
      }
    })();
    return true;
  }
  if (msg?.type === "NEUTRALENS_REFINE_SEARCH" && msg.payload) {
    // Re-run /search with a user-picked alternative label (an "Not quite
    // right?" chip in the panel). We skip /recognise — reuse the existing
    // imageHash so the server can still attribute the search to the same
    // image, but force the query to the user's pick.
    const { query, imageHash } = msg.payload;
    (async () => {
      try {
        if (typeof query !== "string" || query.trim().length === 0) {
          sendResponse({ ok: false, error: "Missing query" });
          return;
        }
        const out = await fetchJson(`${NEUTRALENS_API_BASE}/search`, {
          method: "POST",
          body: JSON.stringify({
            query: query.trim(),
            imageHash: typeof imageHash === "string" ? imageHash : undefined,
            maxResults: 10,
            source: "image",
          }),
        });
        sendResponse({ ok: true, query: query.trim(), products: out?.products ?? [] });
      } catch (err) {
        if (isContentSafetyError(err)) {
          notifyContentSafety();
          sendResponse({ ok: false, error: CONTENT_SAFETY_MESSAGE, code: "CONTENT_SAFETY" });
        } else {
          sendResponse({ ok: false, error: String(err?.message ?? err) });
        }
      }
    })();
    return true;
  }
  return false;
});

async function authHeaders() {
  const { neutralensToken } = await chrome.storage.local.get("neutralensToken");
  return neutralensToken ? { Authorization: `Bearer ${neutralensToken}` } : {};
}

// Read the creator-referral cookie (nl_ref) that the website sets when a fan
// clicks `/?ref=CODE`. Extension fetches do NOT carry first-party cookies, so
// we read the cookie here and forward the code as a header + query param on
// every API request. The companion HttpOnly `nl_ref_session` cookie is
// deliberately not forwarded — extension-originated searches mint a fresh
// attribution session on the server side (see search.ts).
//
// Cache strategy: cookies API is async and we don't want every fetch to hit
// it, but we also can't rely on `chrome.cookies.onChanged` for cross-origin
// cookies (Safari and some Chromium policies don't fire it reliably). So we
// use a short TTL (60s) — fresh enough that a newly-clicked referral link is
// picked up within a minute, cheap enough not to matter for back-to-back
// recognise+search calls. `onChanged` invalidates immediately when it does
// fire; explicit invalidate() hooks cover link/refresh paths.
const NL_REF_TTL_MS = 60_000;
let cachedNlRef = null; // null = unknown, "" = checked-and-absent, "CODE" = present.
let cachedNlRefAt = 0;
async function getNlRefCode() {
  const now = Date.now();
  if (typeof cachedNlRef === "string" && now - cachedNlRefAt < NL_REF_TTL_MS) {
    return cachedNlRef || null;
  }
  if (!chrome.cookies || !chrome.cookies.get) {
    cachedNlRef = "";
    cachedNlRefAt = now;
    return null;
  }
  try {
    const cookie = await chrome.cookies.get({
      url: NEUTRALENS_BASE_URL,
      name: "nl_ref",
    });
    const raw = cookie?.value;
    cachedNlRef =
      typeof raw === "string" && raw.length > 0 && raw.length <= 32
        ? raw.trim().toUpperCase()
        : "";
    cachedNlRefAt = now;
    return cachedNlRef || null;
  } catch {
    cachedNlRef = "";
    cachedNlRefAt = now;
    return null;
  }
}
function invalidateNlRefCache() {
  cachedNlRef = null;
  cachedNlRefAt = 0;
}

// Refresh the cache when neutralens.com cookies change (e.g. user just
// clicked a referral link in another tab). Best-effort; not all browsers
// fire this reliably for cross-origin cookies — the TTL above is the real
// floor.
if (chrome.cookies && chrome.cookies.onChanged) {
  chrome.cookies.onChanged.addListener((info) => {
    if (info?.cookie?.name === "nl_ref") invalidateNlRefCache();
  });
}

async function runImageSearch({ imageUrl, sourceUrl, source }) {
  // /fetch-image expects { url } and returns { base64, mimeType, byteSize }.
  const fetched = await fetchJson(`${NEUTRALENS_API_BASE}/fetch-image`, {
    method: "POST",
    body: JSON.stringify({ url: imageUrl }),
  });
  if (!fetched?.base64) {
    return openFallback(sourceUrl ?? imageUrl);
  }
  return await runRecogniseAndSearch(
    { base64: fetched.base64, mimeType: fetched.mimeType ?? "image/jpeg" },
    source ?? "image",
    sourceUrl ?? imageUrl,
  );
}

async function runDataUrlSearch({ imageDataUrl, sourceUrl, source }) {
  // Skip /fetch-image entirely — we already have the bytes.
  const match = /^data:([^;]+);base64,(.+)$/.exec(imageDataUrl ?? "");
  if (!match) return { ok: false, error: "Invalid image data" };
  const mimeType = match[1] ?? "image/jpeg";
  const base64 = match[2] ?? "";
  return await runRecogniseAndSearch(
    { base64, mimeType },
    source ?? "video-frame",
    sourceUrl,
  );
}

function objectsToQuery(objects) {
  if (!Array.isArray(objects) || objects.length === 0) return null;
  const top = [...objects]
    .sort((a, b) => (b?.confidence ?? 0) - (a?.confidence ?? 0))
    .slice(0, 2)
    .map((o) => o?.label)
    .filter(Boolean);
  return top.length ? top.join(" ") : null;
}

function openFallback(sourceUrl) {
  const fallback = `${NEUTRALENS_BASE_URL}/?imageUrl=${encodeURIComponent(sourceUrl ?? "")}`;
  return { ok: true, products: [], query: null, fallbackUrl: fallback };
}

async function runRecogniseAndSearch({ base64, mimeType }, source, sourceUrl) {
  // /recognise expects { base64, mimeType } and returns
  // { imageHash, objects, enrichment, cached }.
  const recog = await fetchJson(`${NEUTRALENS_API_BASE}/recognise`, {
    method: "POST",
    body: JSON.stringify({ base64, mimeType }),
  });
  const imageHash = recog?.imageHash;
  if (!imageHash) return openFallback(sourceUrl);
  const objects = Array.isArray(recog?.objects) ? recog.objects : [];
  const enrichment = recog?.enrichment ?? null;
  // Prefer the enriched search query when GPT-4o gave us one — matches the
  // web app's behaviour and yields better cross-retailer matches.
  const enrichedQuery =
    enrichment && typeof enrichment.search_query === "string" && enrichment.search_query.trim().length > 0
      ? enrichment.search_query.trim()
      : null;
  const query = enrichedQuery ?? objectsToQuery(objects) ?? "product";
  const searchBody = {
    query,
    imageHash,
    maxResults: 10,
    source,
    objectsDetected: objects,
  };
  const out = await fetchJson(`${NEUTRALENS_API_BASE}/search`, {
    method: "POST",
    body: JSON.stringify(searchBody),
  });
  return {
    ok: true,
    query,
    products: out?.products ?? [],
    enrichment,
    imageHash,
    isImageSearch: true,
  };
}

async function fetchJson(url, init = {}) {
  const nlRef = await getNlRefCode();
  // Origin-gate BOTH the header and the query param to our own API base, so
  // the creator code is never leaked to a third-party URL even if a caller
  // accidentally routes through fetchJson with a non-Neutralens URL.
  const forwardRef = nlRef && url.startsWith(NEUTRALENS_API_BASE);
  const headers = {
    "Content-Type": "application/json",
    ...(await authHeaders()),
    ...(forwardRef ? { "X-Creator-Ref": nlRef } : {}),
    ...(init.headers ?? {}),
  };
  let finalUrl = url;
  if (forwardRef) {
    const sep = url.includes("?") ? "&" : "?";
    finalUrl = `${url}${sep}nl_ref=${encodeURIComponent(nlRef)}`;
  }
  const res = await fetch(finalUrl, { ...init, headers });
  if (!res.ok) {
    let payload = null;
    try {
      payload = await res.json();
    } catch {}
    const msg = payload?.error ?? `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    if (payload?.code) err.code = payload.code;
    throw err;
  }
  return await res.json();
}

const CONTENT_SAFETY_MESSAGE =
  "This image cannot be processed. Please try a different image.";

function isContentSafetyError(err) {
  return !!err && err.status === 422 && err.code === "CONTENT_SAFETY";
}

function notifyContentSafety() {
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMjgiIGhlaWdodD0iMTI4Ii8+",
      title: "Neutralens",
      message: CONTENT_SAFETY_MESSAGE,
    });
  } catch {
    // notifications API may be unavailable in some contexts; ignore.
  }
}

async function refreshMe() {
  const { neutralensToken } = await chrome.storage.local.get("neutralensToken");
  if (!neutralensToken) return { ok: false, signedOut: true };
  const res = await fetch(`${NEUTRALENS_API_BASE}/extension/me`, {
    headers: { Authorization: `Bearer ${neutralensToken}` },
  });
  if (res.status === 401) {
    await chrome.storage.local.remove(["neutralensToken", "neutralensTier", "neutralensEmail"]);
    return { ok: false, signedOut: true };
  }
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  const data = await res.json();
  await chrome.storage.local.set({ neutralensTier: data.tier, neutralensEmail: data.email });
  return { ok: true, ...data };
}
