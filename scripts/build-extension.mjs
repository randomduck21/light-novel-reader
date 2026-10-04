import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

async function copyIfExists(from, to) {
  try {
    await mkdir(dirname(to), { recursive: true });
    await cp(from, to, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

async function download(url, destination) {
  await mkdir(dirname(destination), { recursive: true });
  const response = await fetch(url);
  if (!response.ok) throw new Error("Download failed: " + response.status + " " + url);
  if (!response.body) throw new Error("No response body for " + url);
  await pipeline(response.body, createWriteStream(destination));
}

await rm(dist, { recursive: true, force: true });
await rm(join(root, "light-novel-reader.xpi"), { force: true });
await mkdir(dist, { recursive: true });

for (const path of [
  "manifest.json",
  "popup/popup.html",
  "popup/popup.css",
  "player/player.html",
  "player/player.css",
  "settings/settings.html",
  "settings/settings.css"
]) {
  await copyIfExists(join(root, path), join(dist, path));
}

for (const pair of [
  ["background/background.js", "background/background.js"],
  ["content/content.js", "content/content.js"],
  ["popup/popup.js", "popup/popup.js"],
  ["player/player.js", "player/player.js"],
  ["settings/settings.js", "settings/settings.js"],
  ["tts/tts-worker.js", "tts/tts-worker.js"]
]) {
  await build({
    entryPoints: [join(root, pair[0])],
    outfile: join(dist, pair[1]),
    bundle: pair[0] === "tts/tts-worker.js",
    format: "esm",
    platform: "browser",
    target: "es2022",
    sourcemap: false,
    minify: false
  });
}

const ortDist = join(root, "node_modules/onnxruntime-web/dist");
const ortVendor = join(dist, "vendor/ort");
await mkdir(ortVendor, { recursive: true });

for (const name of [
  "ort-wasm.wasm",
  "ort-wasm-threaded.wasm",
  "ort-wasm-simd.wasm",
  "ort-wasm-simd-threaded.wasm"
]) {
  const ok = await copyIfExists(join(ortDist, name), join(ortVendor, name));
  if (!ok) throw new Error("Missing ONNX Runtime asset: " + name);
}

await download(
  "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.wasm",
  join(dist, "vendor/piper_phonemize.wasm")
);
await download(
  "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.data",
  join(dist, "vendor/piper_phonemize.data")
);

execFileSync("powershell", [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "Compress-Archive -Path '" + dist.replace(/'/g, "''") + "\*' -DestinationPath '" +
    join(root, "light-novel-reader.xpi").replace(/'/g, "''") + "' -Force"
], { stdio: "inherit" });

console.log("Built " + join(root, "light-novel-reader.xpi"));
