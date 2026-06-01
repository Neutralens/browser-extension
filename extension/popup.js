const tierEl = document.getElementById("tier");
const emailEl = document.getElementById("email");
const statusEl = document.getElementById("status");

async function render() {
  const data = await chrome.storage.local.get(["neutralensToken", "neutralensTier", "neutralensEmail"]);
  if (!data.neutralensToken) {
    statusEl.textContent = "Not linked. Click 'Link account' to sign in.";
    tierEl.textContent = "free";
    tierEl.className = "tier free";
    emailEl.textContent = "";
    return;
  }
  const tier = data.neutralensTier ?? "free";
  tierEl.textContent = tier;
  tierEl.className = `tier ${tier}`;
  emailEl.textContent = data.neutralensEmail ?? "";
  statusEl.textContent = "Linked — right-click any product image to search.";
}

document.getElementById("refresh").addEventListener("click", async () => {
  statusEl.textContent = "Refreshing…";
  const out = await chrome.runtime.sendMessage({ type: "NEUTRALENS_REFRESH_ME" });
  if (out?.signedOut) statusEl.textContent = "Session expired — re-link.";
  await render();
});

document.getElementById("signout").addEventListener("click", async () => {
  await chrome.storage.local.remove(["neutralensToken", "neutralensTier", "neutralensEmail"]);
  await render();
});

void render();
