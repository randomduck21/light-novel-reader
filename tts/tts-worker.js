import { TtsSession } from "@realtimex/piper-tts-web";

let session = null;
let activeVoice = null;
let queue = Promise.resolve();

const CACHE_VERSION = "0.6.0";
const HF_BASE = "https://huggingface.co/diffusionstudio/piper-voices/resolve/main";

function voiceFiles(voiceId) {
  const parts = voiceId.split("-");
  if (parts.length < 3) throw new Error("Invalid voice ID: " + voiceId);
  const quality = parts.pop();
  const locale = parts.shift();
  const speaker = parts.join("-");
  const lang = locale.slice(0, 2);
  const file = `${voiceId}.onnx`;
  const base = `${lang}/${locale}/${speaker}/${quality}/${file}`;
  return {
    onnx: `${HF_BASE}/${base}`,
    json: `${HF_BASE}/${base}.json`,
    name: file
  };
}

async function piperDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle("piper", { create: true });
}

async function fileExists(dir, name, minimumBytes = 1) {
  try {
    const file = await dir.getFileHandle(name);
    return (await file.getFile()).size >= minimumBytes;
  } catch {
    return false;
  }
}

async function isVoiceCached(voiceId) {
  const files = voiceFiles(voiceId);
  const dir = await piperDir();
  return (await fileExists(dir, files.name, 1000000)) && (await fileExists(dir, files.name + ".json", 32));
}

async function resetCacheOnce() {
  const root = await navigator.storage.getDirectory();
  const markerDir = await root.getDirectoryHandle("light-novel-reader", { create: true });

  let version = "";
  try {
    const file = await markerDir.getFileHandle("tts-cache-version");
    version = await (await file.getFile()).text();
  } catch {}

  if (version === CACHE_VERSION) return;

  try {
    await root.removeEntry("piper", { recursive: true });
  } catch {}

  const file = await markerDir.getFileHandle("tts-cache-version", { create: true });
  const writable = await file.createWritable();
  await writable.write(CACHE_VERSION);
  await writable.close();
}

async function downloadFile(url, fileName, postProgress, totalBase = 0) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Voice download failed: ${response.status} ${url}`);
  }
  if (!response.body) throw new Error("Voice download returned no body.");

  const total = Number(response.headers.get("Content-Length") || 0);
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      postProgress({
        url,
        loaded: totalBase + loaded,
        total: totalBase + total,
        stage: "model-download"
      });
    }
  }

  if (url.endsWith(".onnx") && loaded < 1000000) {
    throw new Error("Voice model download was incomplete or invalid (" + loaded + " bytes): " + url);
  }

  const contentType = response.headers.get("Content-Type") || "";
  if (url.endsWith(".onnx") && /^text\/(html|plain)/i.test(contentType) && loaded < 5000000) {
    throw new Error("Voice model download returned text instead of ONNX data: " + url);
  }

  const blob = new Blob(chunks, {
    type: contentType || "application/octet-stream"
  });

  const dir = await piperDir();
  const file = await dir.getFileHandle(fileName, { create: true });
  const writable = await file.createWritable();
  await writable.write(blob);
  await writable.close();

  return { bytes: loaded, total };
}

async function ensureVoiceCached(voiceId, postProgress = () => {}) {
  await resetCacheOnce();

  const files = voiceFiles(voiceId);
  const dir = await piperDir();

  const hasOnnx = await fileExists(dir, files.name, 1000000);
  const hasJson = await fileExists(dir, files.name + ".json", 32);
  if (hasOnnx && hasJson) {
    postProgress({ stage: "model-cached", url: files.onnx, loaded: 1, total: 1 });
    return false;
  }

  postProgress({ stage: "model-start", url: files.onnx, loaded: 0, total: 0 });

  // The JSON config is tiny. Cache it first so TtsSession can immediately
  // read both files from the same directory after the large ONNX finishes.
  if (!hasJson) {
    await downloadFile(files.json, files.name + ".json", () => {});
  }

  if (!hasOnnx) {
    const result = await downloadFile(
      files.onnx,
      files.name,
      postProgress
    );

    postProgress({
      stage: "model-complete",
      url: files.onnx,
      loaded: result.bytes || 1,
      total: result.total || result.bytes || 1
    });
  }

  return true;
}

function postProgress(message, requestId, generation) {
  self.postMessage({
    type: "PROGRESS",
    requestId,
    generation,
    progress: message
  });
}

async function createSession(voiceId, wasmPaths, requestId, generation) {
  if (session && activeVoice === voiceId) return session;

  session = null;
  activeVoice = null;

  await ensureVoiceCached(
    voiceId,
    progress => postProgress(progress, requestId, generation)
  );

  // The upstream wrapper uses a process-wide singleton. Clear it before
  // creating a different voice so the old ONNX session cannot be reused.
  TtsSession._instance = null;

  postProgress(
    { stage: "model-initializing", url: voiceId, loaded: 0, total: 0 },
    requestId,
    generation
  );

  session = await TtsSession.create({
    voiceId,
    progress: progress => postProgress(progress, requestId, generation),
    wasmPaths,
    allowLocalModels: true,
    fallbackStrategy: "local"
  });

  activeVoice = voiceId;

  postProgress(
    { stage: "model-ready", url: voiceId, loaded: 1, total: 1 },
    requestId,
    generation
  );

  return session;
}

async function synthesize(message) {
  try {
    const tts = await createSession(
      message.voiceId,
      message.wasmPaths,
      message.requestId,
      message.generation
    );

    const wav = await tts.predict(message.text);
    const buffer = await wav.arrayBuffer();

    self.postMessage({
      type: "AUDIO",
      requestId: message.requestId,
      generation: message.generation,
      buffer
    }, [buffer]);
  } catch (error) {
    self.postMessage({
      type: "ERROR",
      requestId: message.requestId,
      generation: message.generation,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function preload(message) {
  try {
    await createSession(
      message.voiceId,
      message.wasmPaths,
      message.requestId,
      message.generation
    );

    self.postMessage({
      type: "VOICE_READY",
      requestId: message.requestId,
      generation: message.generation,
      voiceId: message.voiceId
    });
  } catch (error) {
    self.postMessage({
      type: "ERROR",
      requestId: message.requestId,
      generation: message.generation,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function checkVoice(message) {
  try {
    const cached = await isVoiceCached(message.voiceId);
    self.postMessage({
      type: "VOICE_STATUS",
      requestId: message.requestId,
      generation: message.generation,
      voiceId: message.voiceId,
      cached
    });
  } catch (error) {
    self.postMessage({
      type: "ERROR",
      requestId: message.requestId,
      generation: message.generation,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

self.onmessage = event => {
  const message = event.data;
  if (!message) return;

  if (message.type === "SYNTHESIZE") {
    queue = queue.then(() => synthesize(message)).catch(() => {});
  } else if (message.type === "PRELOAD") {
    queue = queue.then(() => preload(message)).catch(() => {});
  } else if (message.type === "CHECK_VOICE") {
    queue = queue.then(() => checkVoice(message)).catch(() => {});
  }
};