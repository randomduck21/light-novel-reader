const readPage = document.querySelector("#readPage");
const stop = document.querySelector("#stop");
const speed = document.querySelector("#speed");
const speedValue = document.querySelector("#speedValue");
const status = document.querySelector("#status");

let chunks = [];
let index = 0;
let running = false;

function setStatus(text) {
  status.textContent = text;
}

async function getActiveTab() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function speakNext() {
  if (!running || index >= chunks.length) {
    running = false;
    setStatus(index >= chunks.length ? "Finished." : "Stopped.");
    return;
  }

  const utterance = new SpeechSynthesisUtterance(chunks[index++]);
  utterance.rate = Number(speed.value);
  utterance.onend = speakNext;
  utterance.onerror = () => {
    running = false;
    setStatus("Speech playback failed.");
  };

  speechSynthesis.speak(utterance);
  setStatus(`Reading ${index}/${chunks.length}`);
}

readPage.addEventListener("click", async () => {
  speechSynthesis.cancel();
  running = false;

  try {
    const tab = await getActiveTab();
    const result = await browser.tabs.sendMessage(tab.id, { type: "EXTRACT_PAGE" });
    chunks = result.chunks || [];
    index = 0;

    if (!chunks.length) {
      setStatus("No readable chapter text found.");
      return;
    }

    running = true;
    await speakNext();
  } catch (error) {
    console.error(error);
    setStatus("Could not read this page.");
  }
});

stop.addEventListener("click", () => {
  running = false;
  speechSynthesis.cancel();
  setStatus("Stopped.");
});

speed.addEventListener("input", () => {
  speedValue.textContent = `${speed.value}x`;
});