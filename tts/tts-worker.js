import { TtsSession } from "@realtimex/piper-tts-web";

let session=null,activeVoice=null,queue=Promise.resolve();
const CACHE_VERSION="0.4.0";

async function resetCacheOnce(){
  const root=await navigator.storage.getDirectory();
  const marker=await root.getDirectoryHandle("light-novel-reader",{create:true});
  let version="";
  try{const f=await marker.getFileHandle("tts-cache-version");version=await(await f.getFile()).text();}catch{}
  if(version===CACHE_VERSION)return;
  try{await root.removeEntry("piper",{recursive:true});}catch{}
  const f=await marker.getFileHandle("tts-cache-version",{create:true}),w=await f.createWritable();
  await w.write(CACHE_VERSION);await w.close();
}

async function makeSession(voiceId,wasmPaths,progress){
  if(session&&activeVoice===voiceId)return session;
  session=null;activeVoice=voiceId;
  await resetCacheOnce();
  session=await TtsSession.create({
    voiceId,wasmPaths,allowLocalModels:true,fallbackStrategy:"cdn",
    progress:e=>progress({stage:"download",url:e.url,loaded:e.loaded,total:e.total})
  });
  return session;
}

async function synthesize(m){
  try{
    const tts=await makeSession(m.voiceId,m.wasmPaths,p=>self.postMessage({type:"PROGRESS",requestId:m.requestId,generation:m.generation,progress:p}));
    const wav=await tts.predict(m.text),buffer=await wav.arrayBuffer();
    self.postMessage({type:"AUDIO",requestId:m.requestId,generation:m.generation,buffer},[buffer]);
  }catch(e){
    self.postMessage({type:"ERROR",requestId:m.requestId,generation:m.generation,error:e instanceof Error?e.message:String(e)});
  }
}
self.onmessage=e=>{
  const m=e.data;if(m?.type!=="SYNTHESIZE")return;
  queue=queue.then(()=>synthesize(m)).catch(()=>{});
};