import { TtsSession } from "@realtimex/piper-tts-web";

let session = null;
let activeVoice = null;

async function createSession(voiceId, wasmPaths, postProgress) {
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
    wasmPaths,
    allowLocalModels: true,
    fallbackStrategy: "local"
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
