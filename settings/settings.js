const voice = document.querySelector("#voice");
const prebuffer = document.querySelector("#prebuffer");
const save = document.querySelector("#save");
const status = document.querySelector("#status");

async function load() {
  const { settings = {} } = await browser.storage.local.get("settings");
  if (settings.voiceId) voice.value = settings.voiceId;
  if (settings.prebufferChunks) prebuffer.value = settings.prebufferChunks;
}

save.addEventListener("click", async () => {
  const settings = {
    voiceId: voice.value.trim() || "en_US-lessac-medium",
    prebufferChunks: Math.max(1, Math.min(4, Number(prebuffer.value) || 3))
  };
  await browser.storage.local.set({ settings });
  status.textContent = "Saved.";
});

load();
