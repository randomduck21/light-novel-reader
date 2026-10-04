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
  const voices = globalThis.LNR_VOICES || ["en_US-lessac-medium","en_GB-alan-low","en_GB-alan-medium"];
  const voiceLabel = globalThis.LNR_VOICE_LABEL || (x => x);

  let host=null, shadow=null, highlightLayer=null;
  let chunks=[], ranges=[], decoded=new Map(), pending=new Map(), sources=new Set();
  let playing=false, paused=false, generation=0, nextSynthesis=0, nextSchedule=0;
  let finished=0, nextStartTime=0, audioContext=null, root=null, raf=0;
  let settings={...DEFAULTS};

  const clean = s => (s||"").replace(/\s+/g," ").trim();
  const chunk = s => s.split(/(?<=[.!?])\s+/).map(x=>x.trim()).filter(Boolean);

  function bestRoot(){
    const candidates=[
      document.querySelector("article"),
      document.querySelector("[role='main']"),
      document.querySelector("main"),
      document.querySelector(".chapter"),
      document.querySelector(".chapter-content"),
      document.querySelector(".entry-content"),
      document.querySelector(".post-content"),
      document.querySelector(".reading-content"),
      document.body
    ].filter(Boolean);
    return candidates.sort((a,b)=>score(b)-score(a))[0]||null;
  }

  function score(el){
    const text=clean(el.innerText||"");
    if(text.length<300) return -Infinity;
    const p=el.querySelectorAll("p").length;
    const s=(text.match(/[.!?]["'”’)]?(?=\s|$)/g)||[]).length;
    const links=el.querySelectorAll("a").length;
    return text.length+p*250+s*25-links*100;
  }

  function noisy(el, boundary){
    return el instanceof Element && NOISE.some(sel=>{
      try{
        const nearest=el.closest(sel);
        return !!nearest && nearest!==boundary;
      }catch{return false}
    });
  }

  function extract(){
    const r=bestRoot();
    if(!r) return {title:document.title,text:"",chunks:[]};
    const clone=r.cloneNode(true);
    for(const sel of NOISE) clone.querySelectorAll(sel).forEach(n=>n.remove());
    const ps=[...clone.querySelectorAll("p")].map(p=>clean(p.innerText)).filter(x=>x.length>=2);
    let text=ps.join("\n\n");
    if(text.length<300) text=clean(clone.innerText||"");
    return {title:document.title.trim(),text,chunks:chunk(text)};
  }

  function indexFor(container){
    const walker=document.createTreeWalker(container,NodeFilter.SHOW_TEXT);
    const nodes=[]; let raw="";
    while(walker.nextNode()){
      const n=walker.currentNode;
      if(!n.nodeValue) continue;
      const p=n.parentElement;
      if(p && noisy(p,container)) continue;
      const start=raw.length; raw+=n.nodeValue; nodes.push({n,start,end:raw.length});
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
    const locate=offset=>{
      if(!nodes.length) return null;
      const x=Math.max(0,Math.min(raw.length,offset));
      for(const item of nodes){
        if(x>=item.start&&x<=item.end) return {node:item.n,offset:Math.min(item.n.nodeValue.length,x-item.start)};
      }
      const last=nodes[nodes.length-1]; return {node:last.n,offset:last.n.nodeValue.length};
    };
    return {normalized,spans,locate};
  }

  function buildRanges(r){
    const outChunks=[], outRanges=[];
    const ps=[...r.querySelectorAll("p")].filter(p=>!noisy(p,r));
    const containers=ps.length?ps:[r];
    for(const p of containers){
      const idx=indexFor(p);
      if(!idx.normalized) continue;
      let cursor=0;
      for(const text of chunk(idx.normalized)){
        const start=idx.normalized.indexOf(text,cursor);
        if(start<0) continue;
        const end=start+text.length; cursor=end;
        const a=idx.spans[start]?.[0], b=idx.spans[end-1]?.[1];
        const s=idx.locate(a), e=idx.locate(b);
        if(a==null||b==null||!s||!e) continue;
        const range=document.createRange();
        try{range.setStart(s.node,s.offset);range.setEnd(e.node,e.offset);outChunks.push(text);outRanges.push(range);}catch{}
      }
    }
    return {chunks:outChunks,ranges:outRanges};
  }

  async function loadSettings(){
    const data=await browser.storage.local.get("settings");
    settings={...DEFAULTS,...(data.settings||{})};
    if(!voices.includes(settings.voiceId)) settings.voiceId=DEFAULTS.voiceId;
  }

  function ui(){
    if(host) return;
    host=document.createElement("div");
    host.id="lnr-host";
    host.style.cssText="position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483647;pointer-events:none;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;";
    shadow=host.attachShadow({mode:"open"});
    shadow.innerHTML=`
      <style>
        *{box-sizing:border-box}
        #hl{position:fixed;inset:0;pointer-events:none}
        .mark{position:fixed;background:rgba(250,204,21,.24);box-shadow:0 0 0 1px rgba(250,204,21,.18);border-radius:4px}
        #panel{position:fixed;top:16px;right:16px;width:min(360px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;padding:14px;border:1px solid rgba(255,255,255,.12);border-radius:16px;background:rgba(21,21,25,.95);color:#f4f4f5;box-shadow:0 18px 60px rgba(0,0,0,.42);backdrop-filter:blur(14px);pointer-events:auto}
        .row{display:flex;gap:8px;align-items:center}.head{justify-content:space-between}.title{font-size:15px;font-weight:750}.sub{font-size:11px;opacity:.58;margin-top:2px}
        button,input,select{font:inherit}button{border:0;border-radius:10px;padding:9px 10px;background:rgba(255,255,255,.09);color:inherit;cursor:pointer}button:hover{background:rgba(255,255,255,.15)}button.primary{background:#f4f4f5;color:#111;font-weight:700}.icon{width:34px;height:34px;padding:0;font-size:18px}
        .transport{margin-top:10px}.transport button{flex:1}.field{margin-top:11px}.label{display:flex;justify-content:space-between;font-size:12px;opacity:.82;margin-bottom:6px}
        input[type=search],select{width:100%;background:#101014;color:inherit;border:1px solid rgba(255,255,255,.12);border-radius:9px;padding:8px;outline:none}select{min-height:150px;margin-top:7px}option{background:#101014;padding:5px}
        input[type=range]{width:100%;accent-color:#fff}.bar{height:5px;background:rgba(255,255,255,.08);border-radius:999px;overflow:hidden;margin-top:10px}.fill{height:100%;width:0;background:#facc15;transition:width .15s}
        #status{margin-top:8px;min-height:18px;font-size:11px;line-height:1.4;opacity:.7}#error{display:none;margin-top:8px;padding:8px;border-radius:9px;background:rgba(239,68,68,.12);color:#fecaca;font-size:11px;white-space:pre-wrap}
      </style>
      <div id="hl"></div>
      <section id="panel">
        <div class="row head"><div><div class="title">Light Novel Reader</div><div class="sub" id="chapter"></div></div><button class="icon" id="close">×</button></div>
        <div class="row transport"><button id="back">‹</button><button class="primary" id="play">Play</button><button id="next">›</button><button id="stop">■</button></div>
        <div class="bar"><div class="fill" id="fill"></div></div><div id="status">Ready.</div><div id="error"></div>
        <div class="field"><div class="label"><span>Voice</span><span id="voiceId"></span></div><input id="voiceSearch" type="search" placeholder="Search voices: Alan, lessac, UK..."><select id="voice" size="7"></select></div>
        <div class="field"><div class="label"><span>Speed</span><span id="speedText"></span></div><input id="speed" type="range" min="0.5" max="2.5" step="0.1"></div>
        <div class="field"><div class="label"><span>Pre-buffer</span><span id="bufferText"></span></div><input id="prebuffer" type="range" min="1" max="4" step="1"></div>
      </section>`;
    document.documentElement.appendChild(host);
    highlightLayer=shadow.querySelector("#hl");

    shadow.querySelector("#close").onclick=closeReader;
    shadow.querySelector("#play").onclick=toggle;
    shadow.querySelector("#stop").onclick=stopPlayback;
    shadow.querySelector("#back").onclick=()=>jump(-1);
    shadow.querySelector("#next").onclick=()=>jump(1);

    shadow.querySelector("#speed").oninput=e=>{
      settings.speed=Number(e.target.value);
      shadow.querySelector("#speedText").textContent=settings.speed.toFixed(1)+"×";
      browser.storage.local.set({settings});
    };
    shadow.querySelector("#prebuffer").oninput=e=>{
      settings.prebufferChunks=Number(e.target.value);
      shadow.querySelector("#bufferText").textContent=settings.prebufferChunks+" sentences";
      browser.storage.local.set({settings}); fillQueue();
    };
    shadow.querySelector("#voiceSearch").oninput=e=>renderVoices(e.target.value);
    shadow.querySelector("#voice").onchange=e=>{
      const v=e.target.value, wasPlaying=playing, at=Math.max(0,nextSchedule-1);
      settings.voiceId=v; browser.storage.local.set({settings}); showVoice();
      if(wasPlaying) startPlayback(at);
    };
  }

  function renderVoices(filter=""){
    const q=filter.toLowerCase().trim(), select=shadow.querySelector("#voice"), current=settings.voiceId;
    select.replaceChildren();
    const groups=new Map();
    for(const id of voices){
      const label=voiceLabel(id);
      if(q&&!id.toLowerCase().includes(q)&&!label.toLowerCase().includes(q)) continue;
      const locale=id.slice(0,5); if(!groups.has(locale)) groups.set(locale,[]); groups.get(locale).push(id);
    }
    for(const [locale,ids] of groups){
      const group=document.createElement("optgroup"); group.label=locale.replace("_","-");
      for(const id of ids){const o=document.createElement("option");o.value=id;o.textContent=voiceLabel(id);o.selected=id===current;group.appendChild(o);}
      select.appendChild(group);
    }
    if(!select.value&&select.options.length) select.options[0].selected=true;
    showVoice();
  }

  function showVoice(){
    const id=shadow?.querySelector("#voice")?.value||settings.voiceId;
    shadow?.querySelector("#voiceId")?.replaceChildren(document.createTextNode(id));
  }

  function updateUi(){
    if(!shadow) return;
    shadow.querySelector("#play").textContent=paused?"Resume":playing?"Pause":"Play";
    shadow.querySelector("#fill").style.width=(chunks.length?Math.min(100,finished/chunks.length*100):0)+"%";
  }
  function status(text){shadow?.querySelector("#status")&&(shadow.querySelector("#status").textContent=text)}
  function error(text=""){const n=shadow?.querySelector("#error");if(!n)return;n.textContent=text;n.style.display=text?"block":"none"}

  function clearHighlight(){highlightLayer?.replaceChildren()}
  function refreshHighlight(){
    if(!playing||nextSchedule<=0) return clearHighlight();
    const r=ranges[nextSchedule-1]; if(!r) return;
    highlightLayer.replaceChildren();
    for(const rect of r.getClientRects()){
      if(!rect.width||!rect.height) continue;
      const m=document.createElement("div");m.className="mark";
      m.style.left=(rect.left-3)+"px";m.style.top=(rect.top-2)+"px";m.style.width=(rect.width+6)+"px";m.style.height=(rect.height+4)+"px";
      highlightLayer.appendChild(m);
    }
  }
  function refresh(){if(raf)return;raf=requestAnimationFrame(()=>{raf=0;refreshHighlight()})}
  function follow(index){
    const r=ranges[index]; if(!r)return;
    const rect=r.getBoundingClientRect();
    if(rect.top<90||rect.bottom>innerHeight-120){
      const el=r.commonAncestorContainer.nodeType===1?r.commonAncestorContainer:r.commonAncestorContainer.parentElement;
      el?.scrollIntoView({block:"center",behavior:"smooth"});
    }
    refresh();
  }

  function ctx(){if(!audioContext)audioContext=new AudioContext();return audioContext}
  function killSources(){for(const s of sources){try{s.stop()}catch{}}sources.clear()}

  function reset(index){
    killSources();decoded.clear();pending.clear();nextSynthesis=index;nextSchedule=index;finished=index;nextStartTime=0;generation++;
    browser.runtime.sendMessage({type:"TTS_STOP"}).catch(()=>{});
    clearHighlight();updateUi();
  }

  async function askTts(index){
    if(index>=chunks.length||pending.has(index)||decoded.has(index))return;
    const requestId=index+":"+generation+":"+Math.random().toString(36).slice(2);
    pending.set(index,requestId);
    try{
      await browser.runtime.sendMessage({type:"TTS_SYNTHESIZE",requestId,generation,voiceId:settings.voiceId,text:chunks[index]});
    }catch(e){pending.delete(index);playing=false;error(e instanceof Error?e.message:String(e));updateUi();}
  }

  function fillQueue(){
    if(!playing)return;
    const target=Math.min(chunks.length,nextSchedule+Number(settings.prebufferChunks||3));
    while(nextSynthesis<target){askTts(nextSynthesis);nextSynthesis++;}
  }

  async function onAudio(index,buffer){
    if(!playing)return;
    const b=await ctx().decodeAudioData(buffer.slice(0)); if(!playing)return;
    decoded.set(index,b);schedule();fillQueue();
  }

  function schedule(){
    if(!playing||paused)return;
    const c=ctx(),safe=.06;
    if(!nextStartTime||nextStartTime<c.currentTime+safe)nextStartTime=c.currentTime+safe;
    let first=true;
    while(decoded.has(nextSchedule)){
      const index=nextSchedule,b=decoded.get(index);decoded.delete(index);if(!b)break;
      const source=c.createBufferSource();source.buffer=b;source.playbackRate.value=Number(settings.speed);source.connect(c.destination);
      const when=Math.max(nextStartTime,c.currentTime+safe);sources.add(source);
      source.onended=()=>{
        sources.delete(source);if(!playing)return;
        finished=Math.max(finished,index+1);updateUi();
        if(index+1>=chunks.length){playing=false;paused=false;clearHighlight();status("Finished.");updateUi();return;}
        follow(index+1);fillQueue();
      };
      source.start(when);nextStartTime=when+b.duration/Number(settings.speed);nextSchedule++;
      if(first){follow(index);first=false;}
    }
  }

  function startPlayback(index=nextSchedule){
    if(!chunks.length)return;
    reset(Math.max(0,Math.min(chunks.length-1,index)));playing=true;paused=false;error("");status("Generating speech...");
    ctx().resume();updateUi();follow(nextSchedule);fillQueue();
  }

  function toggle(){
    if(!chunks.length)return;
    if(!playing)return startPlayback(nextSchedule);
    const c=ctx();
    if(paused){c.resume();paused=false;status("Playing.");schedule()}else{c.suspend();paused=true;status("Paused.");}
    updateUi();refresh();
  }

  function stopPlayback(){
    playing=false;paused=false;killSources();decoded.clear();pending.clear();
    browser.runtime.sendMessage({type:"TTS_STOP"}).catch(()=>{});
    if(audioContext)audioContext.suspend();
    status("Stopped.");clearHighlight();updateUi();
  }

  function jump(delta){if(chunks.length)startPlayback(Math.max(0,Math.min(chunks.length-1,nextSchedule+delta)))}

  function closeReader(){
    stopPlayback();host?.remove();host=null;shadow=null;highlightLayer=null;chunks=[];ranges=[];root=null;
  }

  async function startReader(){
    ui();await loadSettings();
    root=bestRoot();
    if(!root){error("Could not find readable chapter text on this page.");return;}
    const data=extract(), indexed=buildRanges(root);
    chunks=indexed.chunks.length?indexed.chunks:data.chunks;ranges=indexed.ranges;
    if(!chunks.length){error("No readable chapter text was found on this page.");return;}
    shadow.querySelector("#chapter").textContent=data.title||"Current page";
    shadow.querySelector("#speed").value=settings.speed;shadow.querySelector("#speedText").textContent=Number(settings.speed).toFixed(1)+"×";
    shadow.querySelector("#prebuffer").value=settings.prebufferChunks;shadow.querySelector("#bufferText").textContent=settings.prebufferChunks+" sentences";
    renderVoices();nextSynthesis=nextSchedule=finished=0;updateUi();error("");status(chunks.length+" sentences ready. Press Play.");
  }

  browser.runtime.onMessage.addListener(message=>{
    if(message?.type==="TOGGLE_READER") return host?closeReader():startReader();
    if(message?.type==="START_READER") return startReader();
    if(message?.type==="EXTRACT_PAGE"){const data=extract();return Promise.resolve(data);}
    if(message?.type==="TTS_AUDIO"){
      if(!playing||message.generation!==generation)return;
      const index=Number(String(message.requestId).split(":")[0]);pending.delete(index);
      onAudio(index,message.buffer).catch(e=>{playing=false;error(e instanceof Error?e.message:String(e));updateUi();});
    }
    if(message?.type==="TTS_PROGRESS"){
      if(!playing||message.generation!==generation)return;
      const p=message.progress||{};
      status(p.total&&p.url?.endsWith(".onnx")?"Downloading voice model: "+Math.round(p.loaded/p.total*100)+"%":"Preparing voice...");
    }
    if(message?.type==="TTS_ERROR"){
      if(message.generation!==generation)return;
      pending.delete(Number(String(message.requestId).split(":")[0]));playing=false;error(message.error||"TTS synthesis failed.");updateUi();
    }
  });

  window.addEventListener("scroll",refresh,true);
  window.addEventListener("resize",refresh);
})();