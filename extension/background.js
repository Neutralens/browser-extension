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
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: "NEUTRALENS_PANEL_LOADING",
        title: "Searching image…",
      });
      const out = await runImageSearch({ imageUrl: info.srcUrl, sourceUrl: tab.url ?? null });
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
  return false;
});

async function authHeaders() {
  const { neutralensToken } = await chrome.storage.local.get("neutralensToken");
  return neutralensToken ? { Authorization: `Bearer ${neutralensToken}` } : {};
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
    source ?? "ext-image",
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
    source ?? "ext-frame",
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
  // /recognise expects { base64, mimeType } and returns { imageHash, objects, cached }.
  const recog = await fetchJson(`${NEUTRALENS_API_BASE}/recognise`, {
    method: "POST",
    body: JSON.stringify({ base64, mimeType }),
  });
  const imageHash = recog?.imageHash;
  if (!imageHash) return openFallback(sourceUrl);
  const objects = Array.isArray(recog?.objects) ? recog.objects : [];
  const query = objectsToQuery(objects) ?? "product";
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
  return { ok: true, query, products: out?.products ?? [] };
}

async function fetchJson(url, init = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(await authHeaders()),
    ...(init.headers ?? {}),
  };
  const res = await fetch(url, { ...init, headers });
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
