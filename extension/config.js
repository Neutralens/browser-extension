// Configure these to your Neutralens deployment(s).
// EDIT THIS FILE before loading the unpacked extension.

// Primary base URL for opening the Neutralens website (results, billing, etc).
// This is also the origin chrome.cookies.get reads from for the nl_ref
// creator-referral cookie, so it MUST match the domain where users actually
// land after clicking a creator's `/?ref=CODE` link — i.e. the canonical
// custom domain, not the subdomain.
export const NEUTRALENS_BASE_URL = "https://neutralens.com";

// API base used for background.js -> server calls.
export const NEUTRALENS_API_BASE = `${NEUTRALENS_BASE_URL}/api`;

// EXACT list of origins permitted to hand off auth tokens via window.postMessage.
// Add your dev domain below if you
// link the extension while testing against a dev preview.
export const NEUTRALENS_TRUSTED_ORIGINS = [
  "https://neutralens.com",
];

