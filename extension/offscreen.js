keepAlive();

async function keepAlive() {
  while (true) {
    try {
      await chrome.runtime.sendMessage({ type: "pump" });
    } catch {
      // The service worker is waking up.
    }
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
}
