import { build } from "esbuild";
import { cp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const dist=join(root,"dist"),xpi=join(root,"light-novel-reader.xpi");

async function copy(from,to){try{await mkdir(dirname(to),{recursive:true});await cp(from,to,{recursive:true});return true}catch{return false}}
async function download(url,to){await mkdir(dirname(to),{recursive:true});const r=await fetch(url);if(!r.ok||!r.body)throw new Error("Download failed: "+url);await pipeline(r.body,createWriteStream(to));}
const shim={name:"node-fallback-shim",setup(b){b.onResolve({filter:/^(fs|path)$/},a=>({path:a.path,namespace:"shim"}));b.onLoad({filter:/.*/,namespace:"shim"},()=>({contents:"module.exports={};",loader:"js"}));}};

async function patchPiperCompatibility() {
  const packageEntry = join(root,"node_modules/@realtimex/piper-tts-web/dist/piper-tts-web.js");
  let source = await readFile(packageEntry, "utf8");

  if (!/const phonemeIds\s*=\s*await new Promise/.test(source)) {
    throw new Error("Could not locate Piper phoneme ID generation code in " + packageEntry);
  }

  source = source.replace(
    /const phonemeIds\s*=\s*await new Promise/,
    "let phonemeIds = await new Promise"
  );

  const speakerNeedle = /const speakerId\s*=\s*0\s*;/;
  if (!speakerNeedle.test(source)) {
    throw new Error("Could not locate Piper speaker ID block in " + packageEntry);
  }

  source = source.replace(
    speakerNeedle,
    "const maxSymbols = Number(__privateGet(this, _modelConfig)?.num_symbols || 256);\n" +
    "    if (Number.isFinite(maxSymbols) && maxSymbols > 0 && maxSymbols < 256) {\n" +
    "      phonemeIds = phonemeIds.filter(id => Number(id) >= 0 && Number(id) < maxSymbols);\n" +
    "    }\n\n" +
    "    const speakerId = 0;"
  );

  await writeFile(packageEntry, source);
}

await patchPiperCompatibility();
await rm(dist,{recursive:true,force:true});await rm(xpi,{force:true});await mkdir(dist,{recursive:true});

for(const p of ["manifest.json","popup/popup.html","popup/popup.css","player/player.html","player/player.css","settings/settings.html","settings/settings.css","test/test.html","tts/voices.js"])
  if(!(await copy(join(root,p),join(dist,p))))throw new Error("Missing required extension file: "+p);

for(const [src,out] of [["background/background.js","background/background.js"],["content/content.js","content/content.js"],["popup/popup.js","popup/popup.js"],["player/player.js","player/player.js"],["settings/settings.js","settings/settings.js"],["tts/tts-worker.js","tts/tts-worker.js"]])
  await build({entryPoints:[join(root,src)],outfile:join(dist,out),bundle:src==="tts/tts-worker.js",format:"esm",platform:"browser",target:"es2022",sourcemap:false,minify:false,plugins:src==="tts/tts-worker.js"?[shim]:[]});

for(const file of ["ort-wasm-simd-threaded.jsep.mjs","ort-wasm-simd-threaded.jsep.wasm","ort-wasm-simd-threaded.mjs","ort-wasm-simd-threaded.wasm"]){
  if(!(await copy(join(root,"node_modules/onnxruntime-web/dist",file),join(dist,"vendor/onnx",file))))
    throw new Error("Missing ONNX Runtime WASM artifact: "+file);
}

await download("https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.wasm",join(dist,"vendor/piper_phonemize.wasm"));
await download("https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.data",join(dist,"vendor/piper_phonemize.data"));

execSync(`npx --yes web-ext@10.7.0 lint --source-dir "${dist}"`,{stdio:"inherit",cwd:root,windowsHide:true});
execSync(`npx --yes web-ext@10.7.0 build --source-dir "${dist}" --artifacts-dir "${root}" --overwrite-dest --filename "light-novel-reader.xpi"`,{stdio:"inherit",cwd:root,windowsHide:true});
console.log("Built "+xpi);