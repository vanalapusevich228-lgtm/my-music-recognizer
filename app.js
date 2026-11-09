/* My Music Recognizer
   Experimental browser-only audio fingerprinting.
   Uses spectral peak pairs and stores fingerprints in IndexedDB.
*/
(() => {
"use strict";
const DB_NAME = "myMusicRecognizerDB";
const STORE = "tracks";
const SAMPLE_RATE = 11025;
const FFT_SIZE = 2048;
const HOP = 512;
const MAX_PEAKS = 5;
const PAIR_WINDOW = 7;
const $ = id => document.getElementById(id);
let db;
let lastResultBlob = null;

function openDB(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME,1);
    req.onupgradeneeded=()=>req.result.createObjectStore(STORE,{keyPath:"id",autoIncrement:true});
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
}
function txStore(mode="readonly"){return db.transaction(STORE,mode).objectStore(STORE)}
function allTracks(){
  return new Promise((resolve,reject)=>{
    const r=txStore().getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
  });
}
function putTrack(track){
  return new Promise((resolve,reject)=>{
    const r=txStore("readwrite").add(track);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
  });
}
function clearTracks(){
  return new Promise((resolve,reject)=>{
    const r=txStore("readwrite").clear();r.onsuccess=resolve;r.onerror=()=>reject(r.error);
  });
}
function deleteTrack(id){
  return new Promise((resolve,reject)=>{
    const r=txStore("readwrite").delete(id);r.onsuccess=resolve;r.onerror=()=>reject(r.error);
  });
}
function renderTracks(){
  allTracks().then(tracks=>{
    $("libraryStatus").textContent=tracks.length ? `В базе ${tracks.length} ${plural(tracks.length,"композиция","композиции","композиций")}` : "Пока нет добавленных композиций";
    const ul=$("trackList");ul.innerHTML="";
    tracks.slice().sort((a,b)=>a.name.localeCompare(b.name,"ru")).forEach(t=>{
      const li=document.createElement("li");
      const name=document.createElement("span");name.className="track-name";name.textContent=t.name;
      const meta=document.createElement("span");meta.className="track-meta";meta.textContent=`${t.hashes.length} отп.`;
      li.append(name,meta);ul.append(li);
    });
  }).catch(showError);
}
function plural(n,a,b,c){const m=n%10, k=n%100;return (m===1&&k!==11)?a:(m>=2&&m<=4&&(k<12||k>14))?b:c}
function showError(e){console.error(e);$("micStatus").textContent="Ошибка: "+(e.message||e)}
function decodeAudio(file){
  return new Promise(async(resolve,reject)=>{
    try{
      const bytes=await file.arrayBuffer();
      const Ctx=window.AudioContext||window.webkitAudioContext;
      const ctx=new Ctx();
      const decoded=await ctx.decodeAudioData(bytes.slice(0));
      const offline=new OfflineAudioContext(1,Math.ceil(decoded.duration*SAMPLE_RATE),SAMPLE_RATE);
      const src=offline.createBufferSource();src.buffer=decoded;
      src.connect(offline.destination);src.start();
      const rendered=await offline.startRendering();
      const data=rendered.getChannelData(0);
      await ctx.close();
      resolve(data);
    }catch(e){reject(e)}
  });
}
function fft(re,im){
  const n=re.length;
  for(let i=1,j=0;i<n;i++){
    let bit=n>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;
    if(i<j){[re[i],re[j]]=[re[j],re[i]];[im[i],im[j]]=[im[j],im[i]]}
  }
  for(let len=2;len<=n;len<<=1){
    const ang=-2*Math.PI/len,wr0=Math.cos(ang),wi0=Math.sin(ang);
    for(let i=0;i<n;i+=len){
      let wr=1,wi=0;
      for(let j=0;j<len/2;j++){
        const u=i+j,v=i+j+len/2;
        const vr=re[v]*wr-im[v]*wi,vi=re[v]*wi+im[v]*wr;
        re[v]=re[u]-vr;im[v]=im[u]-vi;re[u]+=vr;im[u]+=vi;
        const nw=wr*wr0-wi*wi0;wi=wr*wi0+wi*wr0;wr=nw;
      }
    }
  }
}
function peaksAt(data,start){
  const re=new Float32Array(FFT_SIZE),im=new Float32Array(FFT_SIZE);
  for(let i=0;i<FFT_SIZE;i++){
    const x=data[start+i]||0;
    const win=.5-.5*Math.cos(2*Math.PI*i/(FFT_SIZE-1));
    re[i]=x*win;
  }
  fft(re,im);
  const mags=new Float32Array(FFT_SIZE/2);
  for(let k=3;k<mags.length-2;k++){
    const mag=Math.hypot(re[k],im[k]);
    mags[k]=mag;
  }
  const candidates=[];
  for(let k=4;k<mags.length-3;k++){
    const m=mags[k];
    if(m>mags[k-1]&&m>=mags[k+1]&&m>mags[k-2]&&m>=mags[k+2])candidates.push([m,k]);
  }
  candidates.sort((a,b)=>b[0]-a[0]);
  const chosen=[];
  for(const [mag,k] of candidates){
    if(chosen.every(p=>Math.abs(p-k)>3)){chosen.push({k,mag});if(chosen.length>=MAX_PEAKS)break}
  }
  return chosen.sort((a,b)=>a.k-b.k).map(p=>p.k);
}
function fingerprint(data){
  const frames=[];
  for(let pos=0;pos+FFT_SIZE<data.length;pos+=HOP)frames.push(peaksAt(data,pos));
  const hashes=[];
  for(let t=0;t<frames.length;t++){
    for(let dt=1;dt<=PAIR_WINDOW&&t+dt<frames.length;dt++){
      for(const f1 of frames[t])for(const f2 of frames[t+dt]){
        // Bins and frame distance form a compact landmark hash.
        hashes.push({h:`${f1}.${f2}.${dt}`,t});
      }
    }
  }
  return hashes;
}
async function importFiles(files){
  if(!files.length)return;
  $("importProgressWrap").hidden=false;
  $("audioFiles").disabled=true;
  let done=0,ok=0,failed=[];
  for(const file of files){
    $("importStatus").textContent=`Анализ: ${file.name}`;
    try{
      const data=await decodeAudio(file);
      const hashes=fingerprint(data);
      if(hashes.length<30)throw new Error("слишком короткий файл или мало звуковых данных");
      await putTrack({name:file.name, size:file.size, duration:data.length/SAMPLE_RATE, hashes});
      ok++;
    }catch(e){failed.push(`${file.name}: ${e.message}`)}
    done++;
    $("importProgress").style.width=(done/files.length*100)+"%";
  }
  $("audioFiles").disabled=false;
  $("importStatus").textContent=`Готово: добавлено ${ok} из ${files.length}.`+(failed.length?` Не удалось: ${failed.slice(0,3).join("; ")}`:"");
  renderTracks();
}
function resampleTo11025(input,inputRate){
  if(inputRate===SAMPLE_RATE)return input;
  const outLength=Math.floor(input.length*SAMPLE_RATE/inputRate),out=new Float32Array(outLength);
  const ratio=inputRate/SAMPLE_RATE;
  for(let i=0;i<outLength;i++){
    const p=i*ratio,idx=Math.floor(p),frac=p-idx;
    out[i]=(input[idx]||0)*(1-frac)+(input[idx+1]||0)*frac;
  }
  return out;
}
async function listen(){
  const tracks=await allTracks();
  if(!tracks.length){setResult("Сначала добавь музыку","В коллекции пока нет композиций.","♪");return}
  if(!navigator.mediaDevices?.getUserMedia){setResult("Микрофон недоступен","Открой сайт в Safari через HTTPS и разреши доступ к микрофону.","!");return}
  let stream;
  try{
    $("listenBtn").disabled=true;$("listenBtn").textContent="Слушаю…";
    $("listenOrb").classList.add("active");
    $("listenTitle").textContent="Слушаю музыку";
    $("listenHint").textContent="Включи музыку погромче и подожди около 10 секунд.";
    $("micStatus").textContent="Запись идёт…";
    stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false},video:false});
    const ctx=new (window.AudioContext||window.webkitAudioContext)();
    const micSampleRate=ctx.sampleRate;
    const source=ctx.createMediaStreamSource(stream);
    const processor=ctx.createScriptProcessor(4096,1,1);
    const chunks=[];
    source.connect(processor);processor.connect(ctx.destination);
    processor.onaudioprocess=e=>{
      chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      e.outputBuffer.getChannelData(0).fill(0);
    };
    await new Promise(r=>setTimeout(r,10000));
    processor.disconnect();source.disconnect();stream.getTracks().forEach(t=>t.stop());
    await ctx.close();
    const total=chunks.reduce((s,c)=>s+c.length,0),joined=new Float32Array(total);
    let offset=0;for(const c of chunks){joined.set(c,offset);offset+=c.length}
    const sample=resampleTo11025(joined,micSampleRate);
    $("micStatus").textContent="Сравниваю с твоей коллекцией…";
    const heard=fingerprint(sample);
    const match=compareFingerprints(heard,tracks);
    if(match && match.score>=8 && match.ratio>=0.025){
      const track=tracks.find(t=>t.id===match.id);
      setResult(track.name,`Совпадение найдено · уверенность ${Math.min(99,Math.round(match.ratio*100))}%`,"✓");
      $("resultTitle").dataset.trackId=String(track.id);
    }else{
      setResult("Музыка не найдена","Возможно, её нет в твоей базе или запись слишком тихая/шумная.","×");
    }
    $("micStatus").textContent="Готово. Можно распознавать следующую композицию.";
  }catch(e){
    if(stream)stream.getTracks().forEach(t=>t.stop());
    showError(e);
    setResult("Не удалось включить микрофон",e.message||"Проверь разрешение Safari на микрофон.","!");
  }finally{
    $("listenBtn").disabled=false;$("listenBtn").textContent="Слушать 10 секунд";
    $("listenOrb").classList.remove("active");
  }
}
function compareFingerprints(query,tracks){
  const qMap=new Map();
  for(const x of query){if(!qMap.has(x.h))qMap.set(x.h,[]);qMap.get(x.h).push(x.t)}
  let best=null;
  for(const track of tracks){
    const offsets=new Map();let hits=0;
    for(const x of track.hashes){
      const qtimes=qMap.get(x.h);if(!qtimes)continue;
      hits++;
      for(const qt of qtimes){
        const off=Math.round((x.t-qt)/3);
        offsets.set(off,(offsets.get(off)||0)+1);
      }
    }
    let peak=0;for(const n of offsets.values())if(n>peak)peak=n;
    const ratio=peak/Math.max(1,query.length);
    const score=peak;
    if(!best||score>best.score)best={id:track.id,score,ratio,hits};
  }
  return best;
}
function setResult(title,detail,icon){
  $("resultTitle").textContent=title;$("resultDetail").textContent=detail;$("resultIcon").textContent=icon;
  $("openResultBtn").hidden=true;
}
$("audioFiles").addEventListener("change",e=>importFiles(Array.from(e.target.files||[])));
$("listenBtn").addEventListener("click",listen);
$("refreshBtn").addEventListener("click",renderTracks);
$("clearBtn").addEventListener("click",async()=>{
  if(confirm("Удалить всю музыкальную базу из этого браузера?")){await clearTracks();renderTracks();setResult("База очищена","Добавь музыку, чтобы начать заново.","♪")}
});
$("openResultBtn").addEventListener("click",async()=>{
  const id=Number($("resultTitle").dataset.trackId);
  const t=(await allTracks()).find(x=>x.id===id);if(!t)return;
  alert("Браузер хранит аудиоотпечаток, но не копию исходного файла. Чтобы открыть песню, найди её в приложении «Файлы»: "+t.name);
});
openDB().then(database=>{db=database;renderTracks()}).catch(showError);
})();