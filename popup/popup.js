const button=document.querySelector("#readPage"),settings=document.querySelector("#settings"),status=document.querySelector("#status");
button.addEventListener("click",async()=>{
  const [tab]=await browser.tabs.query({active:true,currentWindow:true});
  if(!tab?.id){status.textContent="No active tab.";return;}
  try{await browser.tabs.sendMessage(tab.id,{type:"TOGGLE_READER"});window.close();}
  catch(e){status.textContent="This page cannot run the reader.";console.error(e);}
});
settings.addEventListener("click",async()=>{await browser.tabs.create({url:browser.runtime.getURL("settings/settings.html"),active:true});window.close();});