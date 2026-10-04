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

const PIPER_COMPATIBILITY_PATCH=String.raw`
const LNR_DEFAULT_ID_TO_PHONEME=[
  "_","^","$"," ","!","'","(",")",",","-",
  ":",";","?","a","b","c","d","e","f","h","i","j","k","l","m","n","o","p","q","r","s","t","u","v","w","x","y","z",
  "æ","ç","ð","ø","ħ","ŋ","œ","ǀ","ǁ","ǂ","ǃ","ɐ","ɑ","ɒ","ɓ","ɔ","ɕ","ɖ","ɗ","ɘ","ə","ɚ","ɛ","ɜ","ɞ",
  "ɟ","ɠ","ɡ","ɢ","ɣ","ɤ","ɥ","ɦ","ɧ","ɨ","ɪ","ɫ","ɬ","ɭ","ɮ","ɯ","ɰ","ɱ","ɲ","ɳ","ɴ","ɵ","ɶ","ɸ","ɹ",
  "ɺ","ɻ","ɽ","ɾ","ʀ","ʁ","ʂ","ʃ","ʄ","ʈ","ʉ","ʊ","ʋ","ʌ","ʍ","ʎ","ʏ","ʐ","ʑ","ʒ","ʔ","ʕ","ʘ","ʙ","ʛ",
  "ʜ","ʝ","ʟ","ʡ","ʢ","ʲ","ˈ","ˌ","ː","ˑ","˞","β","θ","χ","ᵻ","ⱱ",
  "0","1","2","3","4","5","6","7","8","9","̧","̃","̪","̯","̩","ʰ","ˤ","ε","↓","#","\"","↑","̺","̻",
  "g","ʦ","X","̝","̊","ɝ","ʷ","aɪ","aʊ","ɔɪ","eɪ","oʊ"
];

function lnrRemapPiperIds(ids,modelConfig){
  const idMap=modelConfig?.phoneme_id_map;
  if(!idMap||typeof idMap!=="object"){
    const maxSymbols=Number(modelConfig?.num_symbols||256);
    if(Number.isFinite(maxSymbols)&&ids.every(id=>Number(id)>=0&&Number(id)<maxSymbols))return ids;
    throw new Error("Voice model has no usable phoneme_id_map.");
  }

  const getIds=symbol=>Array.isArray(idMap[symbol])
    ?idMap[symbol].map(Number).filter(Number.isInteger)
    :[];

  const bos=getIds("^"),pad=getIds("_"),eos=getIds("$");
  if(!bos.length||!pad.length||!eos.length){
    throw new Error("Voice model has an incomplete phoneme_id_map.");
  }

  const output=[...bos,...pad];
  const phonemeMap=modelConfig?.phoneme_map&&typeof modelConfig.phoneme_map==="object"
    ?modelConfig.phoneme_map
    :{};

  for(const raw of ids){
    const id=Number(raw);
    if(id===0||id===1||id===2)continue;

    const phoneme=LNR_DEFAULT_ID_TO_PHONEME[id];
    if(!phoneme)continue;

    const mappedPhonemes=Array.isArray(phonemeMap[phoneme])&&phonemeMap[phoneme].length
      ?phonemeMap[phoneme]
      :[phoneme];

    for(const mappedPhoneme of mappedPhonemes){
      const mappedIds=getIds(mappedPhoneme);
      if(!mappedIds.length)continue;
      output.push(...mappedIds,...pad);
    }
  }

  output.push(...eos);
  return output;
}
`;

async function patchPiperCompatibility(){
  const packageEntry=join(root,"node_modules/@realtimex/piper-tts-web/dist/piper-tts-web.js");
  let source=await readFile(packageEntry,"utf8");

  if(!/const phonemeIds\s*=\s*await new Promise/.test(source))
    throw new Error("Could not locate Piper phoneme ID generation code in "+packageEntry);
  if(!/const speakerId\s*=\s*0\s*;/.test(source))
    throw new Error("Could not locate Piper speaker ID block in "+packageEntry);

  if(!source.includes("LNR_DEFAULT_ID_TO_PHONEME")){
    const marker="var _TtsSession_instances;";
    if(!source.includes(marker))throw new Error("Could not locate Piper class insertion point.");
    source=source.replace(marker,PIPER_COMPATIBILITY_PATCH+"\n"+marker);
  }

  source=source.replace(
    /const phonemeIds\s*=\s*await new Promise/,
    "let phonemeIds = await new Promise"
  );
  source=source.replace(
    /const speakerId\s*=\s*0\s*;/,
    "phonemeIds=lnrRemapPiperIds(phonemeIds,__privateGet(this,_modelConfig));\n    const speakerId=0;"
  );

  await writeFile(packageEntry,source);
}

await rm(dist,{recursive:true,force:true});await rm(xpi,{force:true});await mkdir(dist,{recursive:true});
await patchPiperCompatibility();

for(const p of ["manifest.json","popup/popup.html","popup/popup.css","player/player.html","player/player.css","settings/settings.html","settings/settings.css","test/test.html","tts/voices.js"])
  if(!(await copy(join(root,p),join(dist,p))))throw new Error("Missing required extension file: "+p);

for(const [src,out] of [["background/background.js","background/background.js"],["content/content.js","content/content.js"],["popup/popup.js","popup/popup.js"],["player/player.js","player/player.js"],["settings/settings.js","settings/settings.js"],["tts/tts-worker.js","tts/tts-worker.js"]])
  await build({entryPoints:[join(root,src)],outfile:join(dist,out),bundle:src==="tts/tts-worker.js",format:"esm",platform:"browser",target:"es2022",sourcemap:false,minify:false,plugins:src==="tts/tts-worker.js"?[shim]:[]});

for(const file of ["ort-wasm-simd-threaded.jsep.mjs","ort-wasm-simd-threaded.jsep.wasm","ort-wasm-simd-threaded.mjs","ort-wasm-simd-threaded.wasm"])
  if(!(await copy(join(root,"node_modules/onnxruntime-web/dist",file),join(dist,"vendor/onnx",file))))
    throw new Error("Missing ONNX Runtime WASM artifact: "+file);

await download("https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.wasm",join(dist,"vendor/piper_phonemize.wasm"));
await download("https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.data",join(dist,"vendor/piper_phonemize.data"));

execSync(`npx --yes web-ext@10.7.0 lint --source-dir "${dist}"`,{stdio:"inherit",cwd:root,windowsHide:true});
execSync(`npx --yes web-ext@10.7.0 build --source-dir "${dist}" --artifacts-dir "${root}" --overwrite-dest --filename "light-novel-reader.xpi"`,{stdio:"inherit",cwd:root,windowsHide:true});
console.log("Built "+xpi);