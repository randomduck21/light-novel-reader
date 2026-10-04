import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const xpi = join(root, "light-novel-reader.xpi");
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";

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

const nodeFallbackShim = {
  name: "node-fallback-shim",
  setup(buildApi) {
    buildApi.onResolve({ filter: /^(fs|path)$/ }, (args) => ({
      path: args.path,
      namespace: "node-fallback-shim"
    }));
    buildApi.onLoad({ filter: /.*/, namespace: "node-fallback-shim" }, () => ({
      contents: "module.exports = {};",
      loader: "js"
    }));
  }
};

await rm(dist, { recursive: true, force: true });
await rm(xpi, { force: true });
await mkdir(dist, { recursive: true });

for (const path of [
  "manifest.json",
  "popup/popup.html",
  "popup/popup.css",
  "player/player.html",
  "player/player.css",
  "settings/settings.html",
  "settings/settings.css",
  "test/test.html"
]) {
  if (!(await copyIfExists(join(root, path), join(dist, path)))) {
    throw new Error("Missing required extension file: " + path);
  }
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
    minify: false,
    plugins: pair[0] === "tts/tts-worker.js" ? [nodeFallbackShim] : []
  });
}

// Piper phonemizer assets are packaged locally. ONNX Runtime WASM is loaded
// from the pinned CDN URL used by @realtimex/piper-tts-web 1.1.1.
await download(
  "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.wasm",
  join(dist, "vendor/piper_phonemize.wasm")
);
await download(
  "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.data",
  join(dist, "vendor/piper_phonemize.data")
);

// Validate the exact directory that will be packaged. This catches manifest/package
// problems before an XPI is produced.
execFileSync(npxCommand, [
  "--yes",
  "web-ext@10.7.0",
  "lint",
  "--source-dir",
  dist
], { stdio: "inherit", cwd: root });

// Let Mozilla's web-ext create the XPI so manifest.json is guaranteed to be
// packaged at the archive root instead of relying on PowerShell ZIP behavior.
execFileSync(npxCommand, [
  "--yes",
  "web-ext@10.7.0",
  "build",
  "--source-dir",
  dist,
  "--artifacts-dir",
  root,
  "--overwrite-dest",
  "--filename",
  "light-novel-reader.xpi"
], { stdio: "inherit", cwd: root });

console.log("Built " + xpi);
