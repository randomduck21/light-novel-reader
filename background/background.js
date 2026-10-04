let ttsWorker=null,ownerTabId=null,activeVoice=null;

function stopTtsWorker(){
  try{ttsWorker?.terminate()}catch{}
  ttsWorker=null;ownerTabId=null;activeVoice=null;
}

function ensureTtsWorker(tabId){
  if(ttsWorker&&ownerTabId===tabId)return;
  stopTtsWorker();
  ttsWorker=new Worker(browser.runtime.getURL("tts/tts-worker.js"),{type:"module"});
  ownerTabId=tabId;
  ttsWorker.onmessage=({data})=>{
    if(ownerTabId==null||!data)return;
    browser.tabs.sendMessage(ownerTabId,{
      type:"TTS_"+data.type,
      requestId:data.requestId,
      generation:data.generation,
      buffer:data.buffer,
      progress:data.progress,
      error:data.error,
      voiceId:data.voiceId,
      cached:data.cached
    }).catch(()=>{});
  };
  ttsWorker.onerror=e=>{
    if(ownerTabId!=null)browser.tabs.sendMessage(ownerTabId,{
      type:"TTS_ERROR",requestId:"",generation:0,error:e.message||"TTS worker failed."
    }).catch(()=>{});
    stopTtsWorker();
  };
}

function wasmPaths(){
  return {
    onnxWasm:browser.runtime.getURL("vendor/onnx/"),
    piperData:browser.runtime.getURL("vendor/piper_phonemize.data"),
    piperWasm:browser.runtime.getURL("vendor/piper_phonemize.wasm")
  };
}

browser.runtime.onInstalled.addListener(async()=>{
  const {settings}=await browser.storage.local.get("settings");
  if(!settings){
    await browser.storage.local.set({
      settings:{voiceId:"en_US-lessac-medium",speed:1,autoRead:false,prebufferChunks:3}
    });
  }
});

browser.tabs.onRemoved.addListener(tabId=>{if(tabId===ownerTabId)stopTtsWorker()});

browser.runtime.onMessage.addListener((message,sender)=>{
  if(message?.type==="GET_SETTINGS")return browser.storage.local.get("settings");
  if(message?.type==="SAVE_SETTINGS")return browser.storage.local.set({settings:message.settings});

  if(["TTS_SYNTHESIZE","TTS_PRELOAD","TTS_CHECK_VOICE"].includes(message?.type)){
    const tabId=sender.tab?.id;
    if(!Number.isInteger(tabId))return Promise.reject(new Error("No source tab available for TTS."));
    ensureTtsWorker(tabId);
    ttsWorker.postMessage({
      type:message.type.replace("TTS_",""),
      requestId:message.requestId,
      generation:message.generation,
      voiceId:message.voiceId,
      text:message.text,
      wasmPaths:wasmPaths()
    });
    return Promise.resolve({ok:true});
  }

  if(message?.type==="TTS_STOP"){
    const tabId=sender.tab?.id;
    if(tabId==null||tabId===ownerTabId)stopTtsWorker();
    return Promise.resolve({ok:true});
  }
});