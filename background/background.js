browser.runtime.onInstalled.addListener(() => {
  browser.storage.local.set({
    settings: {
      speed: 1.0,
      autoRead: false,
      prebufferChunks: 2
    }
  });
});

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "GET_SETTINGS") {
    return browser.storage.local.get("settings");
  }

  if (message?.type === "SAVE_SETTINGS") {
    return browser.storage.local.set({ settings: message.settings });
  }
});