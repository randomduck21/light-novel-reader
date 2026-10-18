# Light Novel Reader

A Firefox WebExtension for listening to web-novel chapters with local Piper neural text-to-speech. This branch adds a red-themed, TTSFlow-inspired reader dock while keeping the project’s own implementation and assets.

## Features

- In-page floating reader dock with red/dark styling, collapse/restore, close, and drag-to-reposition (position saved locally).
- Article and chapter text extraction that attempts to skip navigation, comments, sidebars, forms, and ads.
- Sentence-by-sentence highlighting with automatic scroll-following.
- Click a sentence on the page to jump playback to it.
- Play/pause/resume, previous/next sentence, stop, adjustable speed, voice selection, and voice-model download.
- Optional automatic navigation to a detected next-chapter link when playback finishes; enabled by default and adjustable under **More settings**.
- Saves the last sentence position per page and resumes from that position when the reader is opened again.
- Keyboard shortcuts: **Space** play/pause, **Left/Right Arrow** previous/next sentence, **Escape** close the reader.
- Piper neural speech runs locally in a Web Worker using WebAssembly. Voice models download on first use and are cached in browser storage.
- Preferences and reader position are stored locally; chapter text is not uploaded to a cloud TTS service.

## Install for temporary testing

1. Download or clone this branch.
2. Run `npm install` and `npm run build` if you need the packaged build assets.
3. In Firefox, open `about:debugging#/runtime/this-firefox`.
4. Click **Load Temporary Add-on…** and select the built extension's `manifest.json` (or the project manifest when using a fully built distribution).

Temporary add-ons are removed when Firefox restarts. The first use of a voice requires an internet connection to download that voice model; speech synthesis itself runs locally afterward.

## Voice models

The reader uses Piper-compatible voice IDs from `tts/voices.js`. Use the voice picker in the in-page dock and click the download arrow to cache the selected voice. The available voice and language depend on the model catalog.

## Important testing notes

This is a development build. It has not yet been verified against every novel website. Chapter continuation relies on identifying a visible next-chapter link, so sites with JavaScript-only navigation or unusual link labels may need site-specific support. The UI and navigation changes should be tested on a few representative novel sites before being treated as release-ready.

## Project structure

- `background/` — extension worker and TTS message routing
- `content/` — page extraction, sentence highlighting, dock UI, navigation
- `popup/` — quick launcher
- `player/` — persistent reader page
- `tts/` — Piper Web Worker and voice catalog
- `settings/` — saved defaults
- `scripts/` — build tooling
