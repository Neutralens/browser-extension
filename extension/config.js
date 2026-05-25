// Configure these to your Neutralens deployment(s).
// EDIT THIS FILE before loading the unpacked extension.

// Primary base URL for opening the Neutralens website (results, billing, etc).
export const NEUTRALENS_BASE_URL = "https://neutralens.replit.app";

// API base used for background.js -> server calls.
export const NEUTRALENS_API_BASE = `${NEUTRALENS_BASE_URL}/api`;

// EXACT list of origins permitted to hand off auth tokens via window.postMessage.
// Add your dev domain (e.g. https://<repl>.<owner>.replit.dev) below if you
// link the extension while testing against a dev preview.
export const NEUTRALENS_TRUSTED_ORIGINS = [
  "https://neutralens.replit.app",
  // "https://<repl>.<owner>.replit.dev",
];
