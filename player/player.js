const chapterTitle = document.querySelector("#chapterTitle");
const progressText = document.querySelector("#progressText");
const progressBar = document.querySelector("#progressBar");
const status = document.querySelector("#status");
const errorBox = document.querySelector("#error");
const pauseButton = document.querySelector("#pause");
const backButton = document.querySelector("#back");
const forwardButton = document.querySelector("#forward");
const stopButton = document.querySelector("#stop");
const settingsButton = document.querySelector("#settings");
const voiceInput = document.querySelector("#voice");
const speedInput = document.querySelector("#speed");
const speedValue = document.querySelector("#speedValue");
const prebufferInput = document.querySelector("#prebuffer");
const prebufferValue = document.querySelector("#prebufferValue");

const params = new URLSearchParams(location.search);
const sourceTabId = Number(params.get("sourceTabId"));

let audioContext = null;
let worker = null;
let chunks = [];
let decoded = new Map();
let pending = new Map();
let nextSynthesis = 0;
let nextSchedule = 0;
let nextStartTime = 0;
let generation = 0;
let playing = false;
let paused = false;
let finishedChunks = 0;
let currentSource = null;
let settings = {
  voiceId: "en_US-lessac-medium",
  speed: 1,
  prebufferChunks: 3
};

function setStatus(text) {
  status.textContent = text;
}

function setError(text = "") {
  errorBox.textContent = text;
}

function updateProgress() {
  progressBar.max = Math.max(1, chunks.length);
  progressBar.value = Math.min(chunks.length, finishedChunks);
  progressText.textContent = chunks.length
    ? (Math.min(chunks.length, Math.max(1, finishedChunks)) + " / " + chunks.length)
    : "0 / 0";
}

function ensureAudioContext() {
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  return audioContext;
}

function createWorker() {
  if (worker) worker.terminate();
  worker = new Worker(browser.runtime.getURL("tts/tts-worker.js"), { type: "module" });
  worker.onmessage = handleWorkerMessage;
  worker.onerror = (event) => setError(event.message || "TTS worker failed.");
}

function requestSynthesis(index) {
  if (index >= chunks.length || pending.has(index) || decoded.has(index)) return;
  const requestId = index + ":" + generation + ":" + Math.random().toString(36).slice(2);
  pending.set(index, requestId);
  worker.postMessage({
    type: "SYNTHESIZE",
    requestId,
    generation,
    voiceId: settings.voiceId,
    text: chunks[index]
  });
}

function fillSynthesisQueue() {
  const target = Math.min(chunks.length, nextSchedule + settings.prebufferChunks);
  while (nextSynthesis < target) {
    requestSynthesis(nextSynthesis);
    nextSynthesis += 1;
  }
}

async function handleAudio(index, buffer) {
  if (generation !== currentGeneration) return;
  const ctx = ensureAudioContext();
  const audioBuffer = await ctx.decodeAudioData(buffer.slice(0));
  if (generation !== currentGeneration) return;
  decoded.set(index, audioBuffer);
  scheduleReadyBuffers();
  fillSynthesisQueue();
}

function scheduleReadyBuffers() {
  if (!playing || paused) return;

  const ctx = ensureAudioContext();
  const safety = 0.06;
  if (!nextStartTime || nextStartTime < ctx.currentTime + safety) {
    nextStartTime = ctx.currentTime + safety;
  }

  while (decoded.has(nextSchedule)) {
    const buffer = decoded.get(nextSchedule);
    if (!buffer) break;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = Number(settings.speed);
    source.connect(ctx.destination);

    const index = nextSchedule;
    const when = Math.max(nextStartTime, ctx.currentTime + safety);
    source.start(when);
    source.onended = () => {
      if (generation !== currentGeneration) return;
      finishedChunks = Math.max(finishedChunks, index + 1);
      if (currentSource === source) currentSource = null;
      updateProgress();

      if (index + 1 >= chunks.length) {
        playing = false;
        paused = false;
        pauseButton.textContent = "Play";
        setStatus("Finished.");
      }
    };

    currentSource = source;
    nextStartTime = when + buffer.duration / Number(settings.speed);
    decoded.delete(index);
    nextSchedule += 1;
  }
}

let currentGeneration = 0;

function resetGeneration(index) {
  generation += 1;
  currentGeneration = generation;
  for (const source of []) source.stop();
  decoded.clear();
  pending.clear();
  nextSynthesis = index;
  nextSchedule = index;
  finishedChunks = index;
  nextStartTime = 0;
}

function startPlayback(index = nextSchedule) {
  if (!chunks.length) return;
  resetGeneration(index);
  createWorker();
  playing = true;
  paused = false;
  pauseButton.textContent = "Pause";
  setStatus("Generating speech...");
  const ctx = ensureAudioContext();
  ctx.resume();
  fillSynthesisQueue();
}

async function handleWorkerMessage(event) {
  const message = event.data;
  if (!message || message.generation !== generation) return;

  if (message.type === "PROGRESS") {
    if (message.progress?.url?.endsWith(".onnx")) {
      const loaded = message.progress.loaded || 0;
      const total = message.progress.total || 0;
      if (total) {
        setStatus("Downloading voice model: " + Math.round((loaded / total) * 100) + "%");
      } else {
        setStatus("Downloading voice model...");
      }
    } else {
      setStatus("Preparing voice...");
    }
    return;
  }

  if (message.type === "AUDIO") {
    const index = Number(String(message.requestId).split(":")[0]);
    pending.delete(index);
    try {
      await handleAudio(index, message.buffer);
      setStatus("Ready: " + Math.min(chunks.length, nextSchedule + settings.prebufferChunks) + " buffered/requested");
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (message.type === "ERROR") {
    const index = Number(String(message.requestId).split(":")[0]);
    pending.delete(index);
    setError(message.error || "Piper synthesis failed.");
    playing = false;
    pauseButton.textContent = "Play";
  }
}

function stopPlayback() {
  playing = false;
  paused = false;
  if (audioContext) audioContext.suspend();
  if (worker) worker.terminate();
  worker = null;
  decoded.clear();
  pending.clear();
  nextSynthesis = 0;
  nextSchedule = 0;
  finishedChunks = 0;
  nextStartTime = 0;
  generation += 1;
  currentGeneration = generation;
  pauseButton.textContent = "Play";
  updateProgress();
  setStatus("Stopped.");
}

function pauseOrResume() {
  const ctx = ensureAudioContext();

  if (!playing && nextSchedule < chunks.length) {
    startPlayback(nextSchedule);
    return;
  }

  if (paused) {
    ctx.resume();
    paused = false;
    pauseButton.textContent = "Pause";
    setStatus("Playing.");
    scheduleReadyBuffers();
  } else {
    ctx.suspend();
    paused = true;
    pauseButton.textContent = "Resume";
    setStatus("Paused.");
  }
}

function jump(delta) {
  if (!chunks.length) return;
  const target = Math.min(chunks.length - 1, Math.max(0, nextSchedule + delta));
  startPlayback(target);
}

function loadVoiceSettings() {
  return browser.storage.local.get("settings").then(({ settings: saved }) => {
    if (!saved) return;
    settings = { ...settings, ...saved };
    voiceInput.value = settings.voiceId;
    speedInput.value = settings.speed;
    speedValue.textContent = Number(settings.speed).toFixed(2) + "x";
    prebufferInput.value = settings.prebufferChunks;
    prebufferValue.textContent = settings.prebufferChunks + " chunks";
  });
}

async function loadChapter() {
  if (!Number.isInteger(sourceTabId)) {
    setError("Missing source tab.");
    return;
  }

  setStatus("Extracting chapter text...");
  const result = await browser.tabs.sendMessage(sourceTabId, { type: "EXTRACT_PAGE" });

  chunks = result?.chunks || [];
  chapterTitle.textContent = result?.title || "Untitled chapter";
  updateProgress();

  if (!chunks.length) {
    setError("No readable chapter text was found on this page.");
    setStatus("Nothing to read.");
    return;
  }

  setError("");
  setStatus(chunks.length + " speech chunks ready.");
  startPlayback(0);
}

pauseButton.addEventListener("click", pauseOrResume);
backButton.addEventListener("click", () => jump(-1));
forwardButton.addEventListener("click", () => jump(1));
stopButton.addEventListener("click", stopPlayback);

speedInput.addEventListener("input", () => {
  settings.speed = Number(speedInput.value);
  speedValue.textContent = settings.speed.toFixed(2) + "x";
  browser.storage.local.set({ settings });
});

prebufferInput.addEventListener("input", () => {
  settings.prebufferChunks = Number(prebufferInput.value);
  prebufferValue.textContent = settings.prebufferChunks + " chunks";
  browser.storage.local.set({ settings });
});

voiceInput.addEventListener("change", () => {
  const nextVoice = voiceInput.value.trim();
  if (!nextVoice || nextVoice === settings.voiceId) return;
  settings.voiceId = nextVoice;
  browser.storage.local.set({ settings });
  if (chunks.length) startPlayback(nextSchedule);
});

settingsButton.addEventListener("click", () => {
  browser.tabs.create({ url: browser.runtime.getURL("settings/settings.html") });
});

window.addEventListener("beforeunload", () => {
  if (worker) worker.terminate();
});

loadVoiceSettings()
  .then(loadChapter)
  .catch((error) => {
    setError(error instanceof Error ? error.message : String(error));
    setStatus("Reader failed to initialize.");
  });
