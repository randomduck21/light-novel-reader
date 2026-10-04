# Light Novel Reader

A Firefox WebExtension aimed at turning light-novel chapters on arbitrary websites into a smooth listening experience.

## Current stage

Version 0.2.0 has the core architecture in place:

- Generic chapter/article extraction with common page-noise removal.
- Paragraph-aware sentence chunking with a safe maximum chunk size.
- A persistent reader tab so playback does not depend on the popup staying open.
- Piper TTS running inside a dedicated Web Worker.
- Local Piper phonemizer and ONNX Runtime WASM assets included by the CI build.
- Voice models downloaded on first use and cached by the Piper web runtime.
- Web Audio scheduling so already-generated chunks can be queued back-to-back.
- Pause/resume, back, next, stop, speed, voice ID, and pre-buffer controls.
- Firefox Manifest V3 CSP configured for WebAssembly.

## Audio strategy

The reader does not wait for each sentence before starting the next one.

The player keeps a small synthesis window ahead of the current position, sends upcoming chunks to Piper, decodes completed WAV data into AudioBuffers, and schedules the available buffers consecutively in Web Audio. The queue is deliberately bounded so the extension does not try to synthesize an entire chapter into memory.

The Piper browser runtime used here is @mintplex-labs/piper-tts-web. It supports local WASM paths and caches downloaded voice models in browser storage.

## First-run behavior

The packaged extension contains the TTS runtime, but voice models are fetched only when that voice is first used. That keeps the extension package reasonable and avoids bundling a huge voice model for everyone.

The current default voice ID is en_US-lessac-medium.

## Build

Pushes to main run the GitHub Actions build.

The workflow installs the JavaScript dependencies, bundles the extension, downloads the browser-compatible Piper phonemizer assets, and creates:

light-novel-reader.xpi

The XPI is uploaded as a workflow artifact named:

light-novel-reader-xpi

## Project structure

- manifest.json
- background/ — extension service worker
- content/ — webpage extraction and speech chunking
- popup/ — quick launcher
- player/ — persistent playback UI and audio scheduler
- tts/ — Piper Web Worker
- settings/ — saved defaults
- scripts/ — CI build tooling
