// Primary base URL for opening the Neutralens website (results, billing, etc).
// This is also the origin chrome.cookies.get reads from for the nl_ref
// creator-referral cookie, so it MUST match the domain where users actually
// land after clicking a creator's `/?ref=CODE` link — i.e. the canonical
// custom domain.
export const NEUTRALENS_BASE_URL = "https://neutralens.com";

// API base used for background.js -> server calls.
export const NEUTRALENS_API_BASE = `${NEUTRALENS_BASE_URL}/api`;

// EXACT list of origins permitted to hand off auth tokens via window.postMessage.
export const NEUTRALENS_TRUSTED_ORIGINS = [
  "https://neutralens.com",
  
];
