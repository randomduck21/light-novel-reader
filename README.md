# Light Novel Reader

A Firefox WebExtension for turning light-novel chapters on arbitrary websites into a smooth listening experience.

## Current stage

Version 0.1.0 is the foundation:

- generic chapter/article text extraction
- removal of common page noise
- sentence chunking
- basic continuous playback
- playback speed control
- Firefox MV3 structure

The current playback uses the browser's SpeechSynthesis API only as a temporary development fallback.

## Planned audio pipeline

1. Extract and clean the chapter.
2. Split it into natural speech chunks.
3. Run Piper in a Web Worker.
4. Generate the current chunk while pre-generating upcoming chunks.
5. Keep a small bounded audio queue so playback does not wait between sentences.
6. Cache only the data needed for the current reading session.
7. Expose voice, speed, pause/resume, skip, rewind and progress controls.

The Piper implementation will be added separately after the browser-compatible Piper runtime/model approach is selected.

## Project layout

- manifest.json — Firefox extension manifest
- background/ — service worker
- content/ — webpage extraction
- popup/ — controls
- tts/ — planned Piper audio engine
- reader/ — planned reader state and queue
- settings/ — planned persistent settings
