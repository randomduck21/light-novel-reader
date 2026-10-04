const button = document.querySelector("#readPage");
const settingsButton = document.querySelector("#settings");
const status = document.querySelector("#status");

button.addEventListener("click", async () => {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const sourceTab = tabs[0];

  if (!sourceTab?.id) {
    status.textContent = "No active tab.";
    return;
  }

  const playerUrl = browser.runtime.getURL(
    "player/player.html?sourceTabId=" + encodeURIComponent(sourceTab.id)
  );

  await browser.tabs.create({ url: playerUrl, active: true });
  window.close();
});

settingsButton.addEventListener("click", async () => {
  await browser.tabs.create({
    url: browser.runtime.getURL("settings/settings.html"),
    active: true
  });
  window.close();
});
