(() => {
  if (window.__lightNovelReaderLoaded) return;
  window.__lightNovelReaderLoaded = true;

  const NOISE = [
    "script","style","noscript","template","nav","header","footer","aside","form",
    "button","input","textarea","select","[role='navigation']","[role='banner']",
    "[role='contentinfo']",".comments",".comment",".comments-area",".sidebar",
    ".advertisement",".ads",".ad",".social",".share"
  ];

  const DEFAULTS = { voiceId:"en_US-lessac-medium", speed:1, prebufferChunks:3 };
  const voices = globalThis.LNR_VOICES || ["en_US-lessac-medium"];
  const voiceLabel = globalThis.LNR_VOICE_LABEL || (id => id);

  let host=null, shadow=null, root=null;
  let chunks=[], ranges=[], decoded=new Map(), pending=new Map(), scheduled=new Map();
  let audioContext=null;
  let playing=false, paused=false;
  let generation=0, nextSynthesis=0, nextSchedule=0, finished=0;
  let nextStartTime=0, activeIndex=-1, waitingHighlight=-1;
  let settings={...DEFAULTS};
  let styleNode=null;

  const clean = s => (s || "").replace(/\s+/g," ").trim();
  const chunkText = s => s.split(/(?<=[.!?])\s+/).map(x=>x.trim()).filter(Boolean);

  function score(el){
    const text=clean(el.innerText||"");
    if(text.length<300) return -Infinity;
    const p=el.querySelectorAll("p").length;
    const s=(text.match(/[.!?]["'”’)]?(?=\s|$)/g)||[]).length;
    const links=el.querySelectorAll("a").length;
    return text.length+p*250+s*25-links*100;
  }

  function bestRoot(){
    return [
      document.querySelector("article"),
      document.querySelector("[role='main']"),
      document.querySelector("main"),
      document.querySelector(".chapter"),
      document.querySelector(".chapter-content"),
      document.querySelector(".entry-content"),
      document.querySelector(".post-content"),
      document.querySelector(".reading-content"),
      document.body
    ].filter(Boolean).sort((a,b)=>score(b)-score(a))[0] || null;
  }

  function noisy(el,boundary){
    if(!(el instanceof Element)) return false;
    for(const sel of NOISE){
      try{
        const nearest=el.closest(sel);
        if(nearest && nearest!==boundary) return true;
      }catch{}
    }
    return false;
  }

  function extract(){
    const r=bestRoot();
    if(!r) return {title:document.title,text:"",chunks:[]};
    const clone=r.cloneNode(true);
    for(const sel of NOISE) clone.querySelectorAll(sel).forEach(n=>n.remove());
    const ps=[...clone.querySelectorAll("p")].map(p=>clean(p.innerText)).filter(x=>x.length>=2);
    let text=ps.join("\n\n");
    if(text.length<300) text=clean(clone.innerText||"");
    return {title:document.title.trim(),text,chunks:chunkText(text)};
  }

  function indexFor(container){
    const walker=document.createTreeWalker(container,NodeFilter.SHOW_TEXT);
    const nodes=[]; let raw="";
    while(walker.nextNode()){
      const n=walker.currentNode;
      if(!n.nodeValue) continue;
      if(n.parentElement && noisy(n.parentElement,container)) continue;
      const start=raw.length; raw+=n.nodeValue; nodes.push({node:n,start,end:raw.length});
    }

    let normalized="", spans=[];
    for(let i=0;i<raw.length;){
      if(/\s/.test(raw[i])){
        let j=i+1; while(j<raw.length&&/\s/.test(raw[j])) j++;
        if(normalized && !normalized.endsWith(" ")){normalized+=" ";spans.push([i,j]);}
        i=j;
      }else{normalized+=raw[i];spans.push([i,i+1]);i++;}
    }
    while(normalized.startsWith(" ")){normalized=normalized.slice(1);spans.shift();}
    while(normalized.endsWith(" ")){normalized=normalized.slice(0,-1);spans.pop();}

    function locate(offset){
      const x=Math.max(0,Math.min(raw.length,offset));
      for(const item of nodes){
        if(x>=item.start&&x<=item.end)
          return {node:item.node,offset:Math.min(item.node.nodeValue.length,x-item.start)};
      }
      const last=nodes[nodes.length-1];
      return last ? {node:last.node,offset:last.node.nodeValue.length} : null;
    }
    return {normalized,spans,locate};
  }

  function buildRanges(r){
    const outChunks=[],outRanges=[];
    const ps=[...r.querySelectorAll("p")].filter(p=>!noisy(p,r));
    const containers=ps.length?ps:[r];

    for(const p of containers){
      const idx=indexFor(p);
      if(!idx.normalized) continue;
      let cursor=0;
      for(const text of chunkText(idx.normalized)){
        const start=idx.normalized.indexOf(text,cursor);
        if(start<0) continue;
        const end=start+text.length; cursor=end;
        const a=idx.spans[start]?.[0], b=idx.spans[end-1]?.[1];
        const s=idx.locate(a), e=idx.locate(b);
        if(a==null||b==null||!s||!e) continue;
        const range=document.createRange();
        try{
          range.setStart(s.node,s.offset);
          range.setEnd(e.node,e.offset);
          outChunks.push(text);
          outRanges.push(range);
        }catch{}
      }
    }
    return {chunks:outChunks,ranges:outRanges};
  }

  async function loadSettings(){
    const data=await browser.storage.local.get("settings");
    settings={...DEFAULTS,...(data.settings||{})};
    if(!voices.includes(settings.voiceId)) settings.voiceId=DEFAULTS.voiceId;
  }

  function installHighlightStyle(){
    if(styleNode) return;
    styleNode=document.createElement("style");
    styleNode.id="lnr-highlight-style";
    styleNode.textContent=`
      ::highlight(lnr-current) {
        background: rgba(248, 113, 113, .32);
        color: inherit;
        text-shadow: 0 0 0 transparent;
      }
    `;
    (document.head||document.documentElement).appendChild(styleNode);
  }

  function clearHighlight(){
    if(globalThis.CSS?.highlights) CSS.highlights.delete("lnr-current");
    const fallback=shadow?.querySelector("#fallback");
    fallback?.replaceChildren();
  }

  function fallbackHighlight(range){
    const fallback=shadow?.querySelector("#fallback");
    if(!fallback) return;
    fallback.replaceChildren();
    for(const rect of range.getClientRects()){
      if(!rect.width||!rect.height) continue;
      const marker=document.createElement("div");
      marker.style.cssText="position:fixed;background:rgba(248,113,113,.28);border-radius:3px;pointer-events:none;";
      marker.style.left=(rect.left-2)+"px";
      marker.style.top=(rect.top-1)+"px";
      marker.style.width=(rect.width+4)+"px";
      marker.style.height=(rect.height+2)+"px";
      fallback.appendChild(marker);
    }
  }

  function highlight(index,scroll=true){
    const range=ranges[index];
    if(!range) return;
    activeIndex=index;

    if(globalThis.CSS?.highlights && globalThis.Highlight){
      CSS.highlights.set("lnr-current",new Highlight(range));
    }else{
      fallbackHighlight(range);
    }

    if(scroll){
      const rect=range.getBoundingClientRect();
      if(rect.top<90||rect.bottom>innerHeight-120){
        const el=range.commonAncestorContainer.nodeType===1
          ?range.commonAncestorContainer
          :range.commonAncestorContainer.parentElement;
        el?.scrollIntoView({block:"center",behavior:"smooth"});
      }
    }
  }

  function refreshFallback(){
    if(activeIndex>=0 && ranges[activeIndex] && (!globalThis.CSS?.highlights)) fallbackHighlight(ranges[activeIndex]);
  }

  function update(){
    if(!shadow) return;
    shadow.querySelector("#play").textContent=paused?"Resume":playing?"Pause":"Play";
    shadow.querySelector("#fill").style.width=(chunks.length?Math.min(100,finished/chunks.length*100):0)+"%";
  }

  function status(text){shadow?.querySelector("#status")&&(shadow.querySelector("#status").textContent=text);}
  function error(text=""){
    const n=shadow?.querySelector("#error");
    if(!n) return;
    n.textContent=text;
    n.style.display=text?"block":"none";
  }

  function setVoiceCacheState(cached){
    const b=shadow?.querySelector("#download");
    if(!b) return;
    b.textContent=cached?"✓":"↓";
    b.title=cached?"Voice downloaded":"Download voice";
    b.dataset.cached=cached?"1":"0";
  }

  function ui(){
    if(host) return;
    host=document.createElement("div");
    host.id="lnr-host";
    host.style.cssText="position:fixed;right:14px;bottom:14px;z-index:2147483647;pointer-events:none;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;";
    shadow=host.attachShadow({mode:"open"});
    shadow.innerHTML=`
      <style>
        *{box-sizing:border-box}
        #dock{width:286px;color:#f4f4f5;background:rgba(20,20,24,.94);border:1px solid rgba(255,255,255,.12);border-radius:14px;box-shadow:0 14px 45px rgba(0,0,0,.34);backdrop-filter:blur(14px);pointer-events:auto;overflow:hidden}
        #top{display:flex;align-items:center;justify-content:space-between;padding:10px 11px;border-bottom:1px solid rgba(255,255,255,.07)}
        #brand{display:flex;gap:8px;align-items:center;font-size:13px;font-weight:750}
        #brandIcon{width:26px;height:26px;display:grid;place-items:center;border-radius:8px;background:rgba(255,255,255,.1)}
        .icon{border:0;background:transparent;color:inherit;width:28px;height:28px;border-radius:8px;cursor:pointer}
        .icon:hover{background:rgba(255,255,255,.09)}
        #body{padding:10px}
        #chapter{font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.6;margin-bottom:8px}
        .transport{display:flex;gap:6px}
        button{font:inherit}
        .transport button{flex:1;border:0;border-radius:9px;padding:9px;background:rgba(255,255,255,.08);color:inherit;cursor:pointer;font-size:16px}
        .transport #play{background:#f4f4f5;color:#111;font-weight:750;font-size:13px}
        .transport button:hover{background:rgba(255,255,255,.14)}
        .transport #play:hover{background:#fff}
        .bar{height:4px;background:rgba(255,255,255,.08);border-radius:999px;overflow:hidden;margin-top:9px}.fill{height:100%;width:0;background:#f87171}
        #status{font-size:10px;line-height:1.35;opacity:.62;min-height:15px;margin-top:6px}
        #error{display:none;background:rgba(239,68,68,.12);color:#fecaca;border-radius:8px;padding:7px;margin-top:6px;font-size:10px;line-height:1.35;white-space:pre-wrap}
        .voiceRow{display:flex;gap:6px;align-items:center;margin-top:9px}
        #voiceButton{flex:1;text-align:left;border:1px solid rgba(255,255,255,.1);background:#111116;color:inherit;border-radius:9px;padding:8px 9px;cursor:pointer;min-width:0}
        #voiceName{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}
        #voiceMeta{display:block;margin-top:2px;font-size:9px;opacity:.5}
        #download{width:34px;height:34px;padding:0;border:0;border-radius:9px;background:rgba(255,255,255,.09);color:inherit;cursor:pointer}
        #download:hover{background:rgba(255,255,255,.15)}
        #voices{display:none;margin-top:7px;padding:7px;border-radius:10px;background:rgba(0,0,0,.18);border:1px solid rgba(255,255,255,.07)}
        #voices.open{display:block}
        input[type=search]{width:100%;padding:7px 8px;border:1px solid rgba(255,255,255,.1);border-radius:8px;background:#0f0f13;color:inherit;font:inherit;font-size:11px}
        select{width:100%;height:116px;margin-top:6px;border:1px solid rgba(255,255,255,.1);border-radius:8px;background:#0f0f13;color:inherit;font:inherit;font-size:10px}
        option{padding:4px;background:#0f0f13}
        input[type=range]{width:100%;accent-color:#fff}
        .field{margin-top:8px}.label{display:flex;justify-content:space-between;font-size:9px;opacity:.62;margin-bottom:3px}
        details{margin-top:8px;font-size:10px;opacity:.8}summary{cursor:pointer;padding:4px 0}
        #mini{position:fixed;right:0;bottom:30%;border:0;border-radius:12px 0 0 12px;background:rgba(20,20,24,.95);color:#f4f4f5;padding:9px 10px;box-shadow:0 10px 30px rgba(0,0,0,.3);pointer-events:auto;cursor:pointer;display:none}
        #mini.visible{display:block}
      </style>
      <div id="dock">
        <div id="top"><div id="brand"><span id="brandIcon">◉</span><span>Light Novel Reader</span></div><div><button class="icon" id="collapse" title="Collapse">−</button><button class="icon" id="close" title="Close">×</button></div></div>
        <div id="body">
          <div id="chapter"></div>
          <div class="transport"><button id="back" title="Previous">‹</button><button id="play">Play</button><button id="next" title="Next">›</button></div>
          <div class="bar"><div class="fill" id="fill"></div></div>
          <div id="status">Ready.</div><div id="error"></div>
          <div class="voiceRow"><button id="voiceButton"><span id="voiceName">Voice</span><span id="voiceMeta">Choose voice</span></button><button id="download" title="Download voice">↓</button></div>
          <div id="voices">
            <input id="voiceSearch" type="search" placeholder="Search voices...">
            <select id="voiceList" size="6"></select>
          </div>
          <div class="field"><div class="label"><span>Speed</span><span id="speedText">1.0×</span></div><input id="speed" type="range" min="0.5" max="2.5" step="0.1"></div>
          <details><summary>More</summary><div class="field"><div class="label"><span>Pre-buffer</span><span id="bufferText">3</span></div><input id="prebuffer" type="range" min="1" max="4" step="1"></div></details>
        </div>
      </div>
      <button id="mini" title="Open reader">◉</button>
      <div id="fallback"></div>
    `;

    shadow.querySelector("#close").onclick=closeReader;
    shadow.querySelector("#collapse").onclick=()=>{
      shadow.querySelector("#dock").style.display="none";
      shadow.querySelector("#mini").classList.add("visible");
    };
    shadow.querySelector("#mini").onclick=()=>{
      shadow.querySelector("#dock").style.display="block";
      shadow.querySelector("#mini").classList.remove("visible");
    };
    shadow.querySelector("#play").onclick=toggle;
    shadow.querySelector("#back").onclick=()=>jump(-1);
    shadow.querySelector("#next").onclick=()=>jump(1);
    shadow.querySelector("#voiceButton").onclick=()=>shadow.querySelector("#voices").classList.toggle("open");
    shadow.querySelector("#voiceSearch").oninput=e=>renderVoices(e.target.value);
    shadow.querySelector("#voiceList").onchange=e=>changeVoice(e.target.value);
    shadow.querySelector("#download").onclick=preloadSelected;

    shadow.querySelector("#speed").oninput=e=>{
      settings.speed=Number(e.target.value);
      shadow.querySelector("#speedText").textContent=settings.speed.toFixed(1)+"×";
      browser.storage.local.set({settings});
    };
    shadow.querySelector("#prebuffer").oninput=e=>{
      settings.prebufferChunks=Number(e.target.value);
      shadow.querySelector("#bufferText").textContent=String(settings.prebufferChunks);
      browser.storage.local.set({settings});
      fillQueue();
    };

    document.documentElement.appendChild(host);
  }

  function renderVoices(filter=""){
    const list=shadow.querySelector("#voiceList"),q=filter.toLowerCase().trim(),current=settings.voiceId;
    list.replaceChildren();
    const groups=new Map();
    for(const id of voices){
      const label=voiceLabel(id);
      if(q&&!id.toLowerCase().includes(q)&&!label.toLowerCase().includes(q)) continue;
      const locale=id.slice(0,5);
      if(!groups.has(locale)) groups.set(locale,[]);
      groups.get(locale).push(id);
    }
    for(const [locale,ids] of groups){
      const group=document.createElement("optgroup");group.label=locale.replace("_","-");
      for(const id of ids){
        const option=document.createElement("option");
        option.value=id;option.textContent=voiceLabel(id);option.selected=id===current;group.appendChild(option);
      }
      list.appendChild(group);
    }
    if(!list.value&&list.options.length) list.options[0].selected=true;
    showVoice();
  }

  function showVoice(){
    const id=settings.voiceId;
    shadow?.querySelector("#voiceName")?.replaceChildren(document.createTextNode(voiceLabel(id)));
    shadow?.querySelector("#voiceMeta")?.replaceChildren(document.createTextNode(id));
  }

  function changeVoice(id){
    if(!id||id===settings.voiceId)return;
    const wasPlaying=playing;
    const at=Math.max(0,activeIndex>=0?activeIndex:nextSchedule);
    settings.voiceId=id;
    browser.storage.local.set({settings});
    showVoice();
    error("");
    checkVoice();
    if(wasPlaying) startPlayback(at);
    else status("Voice selected. Click ↓ to download it.");
  }

  function checkVoice(){
    const requestId="check:"+settings.voiceId+":"+Date.now();
    browser.runtime.sendMessage({type:"TTS_CHECK_VOICE",requestId,generation:0,voiceId:settings.voiceId}).catch(()=>{});
  }

  function preloadSelected(){
    const requestId="preload:"+settings.voiceId+":"+Date.now();
    setVoiceCacheState(false);
    status("Downloading voice model...");
    browser.runtime.sendMessage({
      type:"TTS_PRELOAD",requestId,generation:0,voiceId:settings.voiceId
    }).catch(e=>error(e instanceof Error?e.message:String(e)));
  }

  function audioCtx(){if(!audioContext)audioContext=new AudioContext();return audioContext}

  function killSources(){
    for(const source of scheduled.values()){try{source.stop()}catch{}}
    scheduled.clear();
  }

  async function reset(index){
    killSources();decoded.clear();pending.clear();nextSynthesis=index;nextSchedule=index;finished=index;
    nextStartTime=0;activeIndex=-1;waitingHighlight=-1;generation++;
    clearHighlight();
    try{await browser.runtime.sendMessage({type:"TTS_STOP"});}catch{}
    update();
  }

  async function requestSynthesis(index){
    if(index>=chunks.length||pending.has(index)||decoded.has(index)||scheduled.has(index))return;
    const requestId=index+":"+generation+":"+Math.random().toString(36).slice(2);
    pending.set(index,requestId);
    try{
      await browser.runtime.sendMessage({
        type:"TTS_SYNTHESIZE",requestId,generation,voiceId:settings.voiceId,text:chunks[index]
      });
    }catch(e){
      pending.delete(index);playing=false;error(e instanceof Error?e.message:String(e));update();
    }
  }

  function fillQueue(){
    if(!playing)return;
    const target=Math.min(chunks.length,nextSchedule+Number(settings.prebufferChunks||3));
    while(nextSynthesis<target){requestSynthesis(nextSynthesis);nextSynthesis++;}
  }

  async function onAudio(index,buffer){
    if(!playing)return;
    const b=await audioCtx().decodeAudioData(buffer.slice(0));
    if(!playing)return;
    decoded.set(index,b);scheduleReady();fillQueue();
  }

  function scheduleReady(){
    if(!playing||paused)return;
    const c=audioCtx(),safe=.06;
    if(!nextStartTime||nextStartTime<c.currentTime+safe)nextStartTime=c.currentTime+safe;

    while(decoded.has(nextSchedule)){
      const index=nextSchedule,b=decoded.get(index);
      decoded.delete(index);
      if(!b)break;

      const source=c.createBufferSource();
      source.buffer=b;source.playbackRate.value=Number(settings.speed);source.connect(c.destination);
      const when=Math.max(nextStartTime,c.currentTime+safe);
      scheduled.set(index,{source,when});
      source.onended=()=>{
        scheduled.delete(index);
        if(!playing)return;
        finished=Math.max(finished,index+1);update();
        if(index+1>=chunks.length){
          playing=false;paused=false;clearHighlight();status("Finished.");update();return;
        }
        if(scheduled.has(index+1)) highlight(index+1);
        else waitingHighlight=index+1;
        fillQueue();
      };
      source.start(when);
      nextStartTime=when+b.duration/Number(settings.speed);
      nextSchedule++;

      if(activeIndex<0) highlight(index);
      else if(waitingHighlight===index){waitingHighlight=-1;highlight(index);}
    }
  }

  async function startPlayback(index=nextSchedule){
    if(!chunks.length)return;
    await reset(Math.max(0,Math.min(chunks.length-1,index)));
    if(!chunks.length)return;
    playing=true;paused=false;error("");status("Preparing speech...");
    try{await audioCtx().resume();}catch{}
    update();fillQueue();
  }

  function toggle(){
    if(!chunks.length)return;
    if(!playing)return startPlayback(activeIndex>=0?activeIndex:nextSchedule);
    if(paused){
      audioCtx().resume();paused=false;status("Playing.");scheduleReady();
    }else{
      audioCtx().suspend();paused=true;status("Paused.");
    }
    update();
  }

  function stopPlayback(){
    playing=false;paused=false;killSources();decoded.clear();pending.clear();
    browser.runtime.sendMessage({type:"TTS_STOP"}).catch(()=>{});
    if(audioContext)audioContext.suspend();
    clearHighlight();status("Stopped.");update();
  }

  function jump(delta){
    const base=activeIndex>=0?activeIndex:nextSchedule;
    if(chunks.length)startPlayback(Math.max(0,Math.min(chunks.length-1,base+delta)));
  }

  function closeReader(){
    stopPlayback();
    if(globalThis.CSS?.highlights)CSS.highlights.delete("lnr-current");
    styleNode?.remove();
    host?.remove();
    host=null;shadow=null;root=null;chunks=[];ranges=[];
  }

  async function startReader(){
    ui();installHighlightStyle();await loadSettings();
    root=bestRoot();
    if(!root){error("Could not find readable chapter text on this page.");return;}
    const data=extract(),indexed=buildRanges(root);
    chunks=indexed.chunks.length?indexed.chunks:data.chunks;
    ranges=indexed.ranges;
    if(!chunks.length){error("No readable chapter text was found on this page.");return;}

    shadow.querySelector("#chapter").textContent=data.title||"Current page";
    shadow.querySelector("#speed").value=settings.speed;
    shadow.querySelector("#speedText").textContent=Number(settings.speed).toFixed(1)+"×";
    shadow.querySelector("#prebuffer").value=settings.prebufferChunks;
    shadow.querySelector("#bufferText").textContent=String(settings.prebufferChunks);
    renderVoices();checkVoice();
    nextSynthesis=nextSchedule=finished=0;activeIndex=-1;waitingHighlight=-1;update();error("");
    status(chunks.length+" sentences ready. Click Play or download the voice first.");
  }

  browser.runtime.onMessage.addListener(message=>{
    if(message?.type==="TOGGLE_READER") return host?closeReader():startReader();
    if(message?.type==="START_READER") return startReader();
    if(message?.type==="EXTRACT_PAGE"){const d=extract();return Promise.resolve(d);}

    if(message?.type==="TTS_AUDIO"){
      if(!playing||message.generation!==generation)return;
      const index=Number(String(message.requestId).split(":")[0]);pending.delete(index);
      onAudio(index,message.buffer).catch(e=>{playing=false;error(e instanceof Error?e.message:String(e));update();});
    }

    if(message?.type==="TTS_PROGRESS"){
      const p=message.progress||{};
      if(p.stage==="model-download"||p.stage==="model-start"){
        if(p.total){
          status("Downloading voice model: "+Math.min(100,Math.round(p.loaded/p.total*100))+"%");
        }else{
          status("Downloading voice model...");
        }
      }else if(p.stage==="model-complete"){
        status("Voice downloaded. Initializing...");
      }else if(p.stage==="model-initializing"){
        status("Initializing voice...");
      }else if(p.stage==="model-ready"){
        setVoiceCacheState(true);status("Voice ready.");
      }
    }

    if(message?.type==="TTS_VOICE_STATUS"){
      if(message.voiceId===settings.voiceId)setVoiceCacheState(Boolean(message.cached));
    }

    if(message?.type==="TTS_VOICE_READY"){
      if(message.voiceId===settings.voiceId){setVoiceCacheState(true);status("Voice downloaded and ready.");}
    }

    if(message?.type==="TTS_ERROR"){
      error(message.error||"TTS failed.");
      if(message.generation===generation)playing=false;
      update();
    }
  });

  window.addEventListener("scroll",refreshFallback,true);
  window.addEventListener("resize",refreshFallback);

  browser.runtime.onMessage.addListener(()=>{});
})();