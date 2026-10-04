import { TtsSession } from "@realtimex/piper-tts-web";

let session = null;
let activeVoice = null;
const TTS_CACHE_VERSION = "0.3.2";

async function resetTtsCacheOnce() {
  const stored = await browser.storage.local.get("ttsCacheVersion");
  if (stored.ttsCacheVersion === TTS_CACHE_VERSION) return;

  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry("piper", { recursive: true });
  } catch {
    // The cache may not exist yet or OPFS may be unavailable.
  }

  await browser.storage.local.set({ ttsCacheVersion: TTS_CACHE_VERSION });
}

async function createSession(voiceId, wasmPaths, postProgress) {
  if (session && activeVoice === voiceId) return session;

  session = null;
  activeVoice = voiceId;

  await resetTtsCacheOnce();

  session = await TtsSession.create({
    voiceId,
    progress: (event) => {
      postProgress({
        stage: "download",
        url: event.url,
        loaded: event.loaded,
        total: event.total
      });
    },
    wasmPaths,
    allowLocalModels: true,
    fallbackStrategy: "cdn"
  });

  return session;
}

self.onmessage = async (event) => {
  const message = event.data;
  if (!message || message.type !== "SYNTHESIZE") return;

  const requestId = message.requestId;
  const generation = message.generation;

  try {
    const tts = await createSession(
      message.voiceId,
      message.wasmPaths,
      (progress) => {
        self.postMessage({
          type: "PROGRESS",
          requestId,
          generation,
          progress
        });
      }
    );

    const wav = await tts.predict(message.text);
    const buffer = await wav.arrayBuffer();

    self.postMessage({
      type: "AUDIO",
      requestId,
      generation,
      buffer
    }, [buffer]);
  } catch (error) {
    self.postMessage({
      type: "ERROR",
      requestId,
      generation,
      error: error instanceof Error ? error.message : String(error)
    });
  }
};
