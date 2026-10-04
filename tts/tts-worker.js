import { TtsSession } from "@mintplex-labs/piper-tts-web";

let session = null;
let activeVoice = null;

const extensionUrl = (path) => browser.runtime.getURL(path);

async function createSession(voiceId, postProgress) {
  if (session && activeVoice === voiceId) return session;

  session = null;
  activeVoice = voiceId;

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
    wasmPaths: {
      onnxWasm: extensionUrl("vendor/ort/"),
      piperData: extensionUrl("vendor/piper_phonemize.data"),
      piperWasm: extensionUrl("vendor/piper_phonemize.wasm")
    }
  });

  return session;
}

self.onmessage = async (event) => {
  const message = event.data;
  if (!message || message.type !== "SYNTHESIZE") return;

  const requestId = message.requestId;
  const generation = message.generation;

  try {
    const tts = await createSession(message.voiceId, (progress) => {
      self.postMessage({
        type: "PROGRESS",
        requestId,
        generation,
        progress
      });
    });

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
