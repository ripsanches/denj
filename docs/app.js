/* Распорядок дня — логика приложения.
   Один и тот же файл работает в браузере на ПК и внутри APK на телефоне.
   Внутри APK доступен window.Capacitor: тогда напоминания ставятся как системные уведомления. */
"use strict";
const APP_VERSION = "1.0.0";

const firebaseConfig = {
  apiKey: "AIzaSyABpompEgGy6Ft3nboT6nUldxtgzEh7gls",
  authDomain: "denj-rip.firebaseapp.com",
  projectId: "denj-rip",
  storageBucket: "denj-rip.firebasestorage.app",
  messagingSenderId: "566487759567",
  appId: "1:566487759567:web:d84840f0fefd82828995ba"
};
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const fs = firebase.firestore();
fs.enablePersistence({synchronizeTabs:true}).catch(()=>{});

const DAYS = ["Пн","Вт","Ср","Чт","Пт","Сб","Вс"]; // 0..6 = пн..вс
const TONES = {bell:"Колокольчик", alarm:"Будильник", soft:"Мягкая мелодия", none:"Без звука"};
const SEED = [
  {title:"Позавтракать", param:"", time:"08:30", repeat:10, order:1},
  {title:"Отжаться", param:"10×3 раз", time:"21:30", repeat:15, order:2},
  {title:"Прочитать главу книги", param:"1 глава", time:null, repeat:15, order:3},
  {title:"Поиграть в Beat Saber", param:"30 мин", time:"21:00", repeat:10, order:4},
  {title:"Почитать вслух", param:"1 глава", time:"21:00", repeat:10, order:5},
];
const REPEAT_WINDOW_MIN = 120;   // сколько минут после начала повторять напоминания
const MAX_REPEATS = 12;

let user = null, tasks = [], settings = {veil:55, wallpaper:null};
let unsubTasks = null, unsubSettings = null;
let shiftMin = 0, soundOn = false, audioCtx = null;
const lastFired = {};
const $ = id => document.getElementById(id);

/* ---------- Capacitor (только в APK) ---------- */
const CAP = window.Capacitor;
const isNative = !!(CAP && CAP.isNativePlatform && CAP.isNativePlatform());
function plugin(name){
  if(!isNative) return null;
  if(CAP.Plugins && CAP.Plugins[name]) return CAP.Plugins[name];
  if(CAP.registerPlugin) return CAP.registerPlugin(name);
  return null;
}
const LN = plugin("LocalNotifications");
if(isNative) soundOn = true; // в приложении звук включён сразу

/* ---------- даты ---------- */
function now(){ return new Date(Date.now() + shiftMin*60000) }
function dayKey(d){ return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0") }
function weekday(d){ return (d.getDay()+6)%7 }
function minsOf(t){ const [h,m]=t.split(":").map(Number); return h*60+m }
function onDay(t,d){ return !t.days || !t.days.length || t.days.includes(weekday(d)) }
function isDone(t,d){ return t.doneOn === dayKey(d) }
function nextHour(){ const d=now(); return String((d.getHours()+1)%24).padStart(2,"0")+":00" }

/* ---------- вход ---------- */
const AUTH_ERR = {
  "auth/invalid-email":"Почта введена с ошибкой.",
  "auth/missing-password":"Введите пароль.",
  "auth/weak-password":"Пароль слишком короткий: нужно минимум 6 символов.",
  "auth/email-already-in-use":"Такой аккаунт уже есть. Нажмите «Войти».",
  "auth/invalid-credential":"Неверная почта или пароль.",
  "auth/wrong-password":"Неверный пароль.",
  "auth/user-not-found":"Аккаунт не найден. Нажмите «Создать аккаунт».",
  "auth/too-many-requests":"Слишком много попыток. Подождите пару минут.",
  "auth/network-request-failed":"Нет интернета. Проверьте подключение.",
  "auth/operation-not-allowed":"Вход по почте не включён в Firebase (Authentication → Sign-in method → Email/Password).",
};
function showLoginErr(e){ const el=$("lErr"); el.textContent=AUTH_ERR[e&&e.code]||("Ошибка: "+(e&&e.message||e)); el.hidden=false }
$("loginForm").addEventListener("submit", async e=>{
  e.preventDefault(); $("lErr").hidden=true;
  try{ await auth.signInWithEmailAndPassword($("lEmail").value.trim(), $("lPass").value) }catch(err){ showLoginErr(err) }
});
$("lUp").onclick = async ()=>{
  $("lErr").hidden=true;
  try{ await auth.createUserWithEmailAndPassword($("lEmail").value.trim(), $("lPass").value) }catch(err){ showLoginErr(err) }
};
$("lReset").onclick = async ()=>{
  const em=$("lEmail").value.trim(); if(!em){ showLoginErr({code:"auth/invalid-email"}); return }
  try{ await auth.sendPasswordResetEmail(em); toast("Письмо для сброса пароля отправлено") }catch(err){ showLoginErr(err) }
};

auth.onAuthStateChanged(u=>{
  user=u;
  if(unsubTasks){unsubTasks();unsubTasks=null} if(unsubSettings){unsubSettings();unsubSettings=null}
  if(!u){ $("loginView").hidden=false; $("appView").hidden=true; $("add").hidden=true; tasks=[]; applyWall(); return }
  $("loginView").hidden=true; $("appView").hidden=false; $("add").hidden=false;
  const base=fs.collection("users").doc(u.uid);
  unsubTasks = base.collection("tasks").onSnapshot({includeMetadataChanges:true}, snap=>{
    tasks = snap.docs.map(d=>({id:d.id, ...d.data()}));
    const pending = snap.metadata.hasPendingWrites, cached = snap.metadata.fromCache;
    setSync(!cached, cached ? "Нет связи: изменения сохранятся, когда появится интернет" : pending ? "Сохраняю…" : "Синхронизировано");
    $("seedBox").hidden = !(tasks.length===0 && !cached);
    render(); scheduleNative();
  }, err=>setSync(false, err.code==="permission-denied" ? "Нет доступа к базе: проверьте правила Firestore" : "Ошибка связи с базой"));
  unsubSettings = base.collection("meta").doc("settings").onSnapshot(s=>{
    if(s.exists){ settings={veil:55, wallpaper:null, ...s.data()} } applyWall();
  }, ()=>{});
  initNative();
});
function setSync(on,txt){ $("syncDot").classList.toggle("on",on); $("syncTxt").textContent=txt }
function tasksRef(){ return fs.collection("users").doc(user.uid).collection("tasks") }

/* ---------- сохранение ---------- */
async function saveTask(t){
  const {id, ...body} = t;
  Object.keys(body).forEach(k=>{ if(body[k]===undefined) delete body[k] });
  try{
    if(id) await tasksRef().doc(id).set(body);
    else await tasksRef().add(body);
  }catch(e){ toast(e.code==="permission-denied" ? "Нет прав на запись: проверьте правила Firestore" : "Не удалось сохранить") }
}
async function removeTask(id){ try{ await tasksRef().doc(id).delete() }catch(e){ toast("Не удалось удалить") } }
async function saveSettings(){
  try{ await fs.collection("users").doc(user.uid).collection("meta").doc("settings").set(settings) }
  catch(e){ toast(e.code==="invalid-argument" ? "Картинка слишком большая" : "Не удалось сохранить настройки") }
  applyWall();
}
async function toggleDone(t){
  const d=now(); const copy={...t, doneOn: isDone(t,d) ? null : dayKey(d), snoozeUntil:null};
  delete lastFired[t.id]; stopSound(t.id);
  await saveTask(copy);
  if(copy.doneOn) toast("Отмечено: "+t.title);
}
async function snooze(t, min=10){
  stopSound(t.id);
  await saveTask({...t, snoozeUntil: now().getTime()+min*60000});
  toast("Напомню через "+min+" минут");
}
$("seedBtn").onclick = async ()=>{
  $("seedBtn").disabled=true;
  const batch=fs.batch();
  SEED.forEach(s=>batch.set(tasksRef().doc(), {...s, days:[0,1,2,3,4,5,6], doneOn:null, sound:{kind:"tone",id:"bell"}}));
  try{ await batch.commit(); toast("Дела добавлены") }catch(e){ toast("Не удалось добавить"); $("seedBtn").disabled=false }
};

/* ---------- перенос между блоками ---------- */
function moveTo(t, zone){
  if(zone==="free" && t.time){ saveTask({...t, lastTime:t.time, time:null}); stopSound(t.id); toast("Перенесено в «В течение дня»") }
  else if(zone==="timed" && !t.time){
    if(t.lastTime){ delete lastFired[t.id]; saveTask({...t, time:t.lastTime}); toast("Перенесено на "+t.lastTime) }
    else openSheet({...t, time:nextHour()}, {moving:true});
  }
}

/* ---------- файлы на этом устройстве (IndexedDB) ---------- */
function idb(){ return new Promise((res,rej)=>{ const r=indexedDB.open("denj",1); r.onupgradeneeded=()=>r.result.createObjectStore("files"); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error) }) }
async function idbPut(k,v){ const d=await idb(); return new Promise((res,rej)=>{ const tx=d.transaction("files","readwrite"); tx.objectStore("files").put(v,k); tx.oncomplete=res; tx.onerror=()=>rej(tx.error) }) }
async function idbGet(k){ const d=await idb(); return new Promise((res,rej)=>{ const r=d.transaction("files").objectStore("files").get(k); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error) }) }

/* ---------- обои (сжимаются и хранятся в базе, видны на всех устройствах) ---------- */
function applyWall(){
  const url = user && settings.wallpaper || null;
  $("wall").style.backgroundImage = url ? `url("${url}")` : "none";
  $("veil").style.opacity = url ? String((settings.veil ?? 55)/100) : "0";
  const th=$("wallThumb"); if(th){ th.style.backgroundImage = url?`url("${url}")`:"none"; th.textContent = url?"":"Обои не выбраны" }
}
function shrinkImage(file){
  return new Promise((res,rej)=>{
    const img=new Image(); const u=URL.createObjectURL(file);
    img.onload=()=>{
      let max=1600, q=0.8, out="";
      for(let i=0;i<6;i++){
        const k=Math.min(1, max/Math.max(img.width,img.height));
        const c=document.createElement("canvas"); c.width=Math.round(img.width*k); c.height=Math.round(img.height*k);
        c.getContext("2d").drawImage(img,0,0,c.width,c.height);
        out=c.toDataURL("image/jpeg",q);
        if(out.length<900000) break;
        max=Math.round(max*0.8); q=Math.max(0.5,q-0.08);
      }
      URL.revokeObjectURL(u); res(out);
    };
    img.onerror=()=>{ URL.revokeObjectURL(u); rej(new Error("bad image")) };
    img.src=u;
  });
}
$("pickWall").addEventListener("change", async e=>{
  const f=e.target.files[0]; e.target.value=""; if(!f) return;
  toast("Сохраняю обои…");
  try{ settings.wallpaper = await shrinkImage(f); await saveSettings(); toast("Обои сохранены") }
  catch(err){ toast("Не получилось открыть картинку") }
});

/* ---------- звук ---------- */
const playing = {};
function ctx(){ audioCtx = audioCtx || new (window.AudioContext||window.webkitAudioContext)(); if(audioCtx.state==="suspended") audioCtx.resume(); return audioCtx }
const PATTERNS = {bell:[[1046,0],[1318,.18],[1568,.36]], alarm:[[880,0],[880,.15],[880,.3],[880,.45]], soft:[[523,0],[659,.3],[784,.6],[659,.9]]};
function playTone(name, loop){
  if(!PATTERNS[name]) return {stop(){}};
  let stopped=false, timer=null;
  const once=()=>{ if(stopped) return;
    try{ const c=ctx(); PATTERNS[name].forEach(([f,off])=>{ const o=c.createOscillator(), g=c.createGain(); o.type=name==="alarm"?"square":"sine"; o.frequency.value=f; o.connect(g); g.connect(c.destination);
      const t0=c.currentTime+off; g.gain.setValueAtTime(0.0001,t0); g.gain.exponentialRampToValueAtTime(name==="alarm"?0.12:0.25,t0+0.02); g.gain.exponentialRampToValueAtTime(0.0001,t0+0.28); o.start(t0); o.stop(t0+0.3) }) }catch(e){}
    if(loop) timer=setTimeout(once,1600) };
  once(); return {stop(){ stopped=true; clearTimeout(timer) }};
}
async function startSound(id, s, loop=true, maxSec=60){
  stopSound(id);
  let p;
  if(s && s.kind==="local"){
    let blob=null; try{ blob=await idbGet("snd-"+s.key) }catch(e){}
    if(blob){
      const url=URL.createObjectURL(blob); const a=new Audio(url); a.loop=loop;
      p={stop(){ a.pause(); URL.revokeObjectURL(url) }};
      a.play().catch(()=>{ if(playing[id]===p) playing[id]=playTone("bell",loop) });
    }
  }
  if(!p) p = playTone(s && s.kind==="tone" ? s.id : "bell", loop);
  playing[id]=p;
  setTimeout(()=>{ if(playing[id]===p) stopSound(id) }, maxSec*1000);
}
function stopSound(id){ if(playing[id]){ playing[id].stop(); delete playing[id] } }

/* ---------- напоминания на открытом экране ---------- */
function dueState(t,d){
  if(!t.time || isDone(t,d) || !onDay(t,d)) return null;
  if(t.snoozeUntil && t.snoozeUntil > d.getTime()) return null;
  const nowM=d.getHours()*60+d.getMinutes(), start=minsOf(t.time);
  if(nowM<start) return null;
  const rep=Math.max(1,t.repeat||5), k=Math.floor((nowM-start)/rep);
  return {slot:dayKey(d)+"#"+k, late:nowM-start};
}
function checkReminders(){
  const d=now();
  for(const t of tasks){
    const s=dueState(t,d); if(!s) continue;
    if(lastFired[t.id]!==s.slot){ lastFired[t.id]=s.slot; ring(t) }
  }
}
function ring(t){
  if(soundOn && document.visibilityState==="visible") startSound(t.id, t.sound, true, 45);
  try{ navigator.vibrate && navigator.vibrate([200,100,200]) }catch(e){}
  if(!isNative){ try{ if(window.Notification && Notification.permission==="granted") new Notification("Пора: "+t.title, {body:t.param||""}) }catch(e){} }
}

/* ---------- системные уведомления (APK) ---------- */
const CHANNELS = [
  {id:"tone_bell", name:"Колокольчик", sound:"bell.wav"},
  {id:"tone_alarm", name:"Будильник", sound:"alarm.wav"},
  {id:"tone_soft", name:"Мягкая мелодия", sound:"soft.wav"},
  {id:"tone_none", name:"Без звука", sound:null},
];
let nativeReady=false;
async function initNative(){
  if(!LN || nativeReady) return; nativeReady=true;
  try{
    for(const c of CHANNELS){
      const ch={id:c.id, name:c.name, description:"Напоминания о делах", importance: c.sound?5:3, visibility:1, vibration:true, lights:true};
      if(c.sound) ch.sound=c.sound;
      await LN.createChannel(ch);
    }
    await LN.registerActionTypes({types:[{id:"TASK", actions:[{id:"done",title:"Готово"},{id:"snooze",title:"Отложить 10 мин"}]}]});
    LN.addListener("localNotificationActionPerformed", async a=>{
      const id=a.notification && a.notification.extra && a.notification.extra.taskId;
      const t=tasks.find(x=>x.id===id) || await waitTask(id); if(!t) return;
      if(a.actionId==="done" && !isDone(t,now())) toggleDone(t);
      else if(a.actionId==="snooze") snooze(t,10);
    });
  }catch(e){ console.warn(e) }
  await checkPermissions();
}
function waitTask(id){ return new Promise(res=>{ let n=0; const iv=setInterval(()=>{ const t=tasks.find(x=>x.id===id); if(t||++n>40){clearInterval(iv);res(t)} },250) }) }
async function checkPermissions(){
  if(!LN) return;
  const box=$("permBanner"); const msgs=[];
  try{ const p=await LN.checkPermissions(); if(p.display!=="granted") msgs.push(`<span>Уведомления выключены — без них будильники не сработают.</span><button class="btn primary" id="pmNotif">Разрешить уведомления</button>`) }catch(e){}
  try{ if(LN.checkExactNotificationSetting){ const x=await LN.checkExactNotificationSetting(); if(x.exact_alarm && x.exact_alarm!=="granted") msgs.push(`<span>Точные будильники выключены — напоминания могут опаздывать.</span><button class="btn primary" id="pmExact">Включить точные будильники</button>`) } }catch(e){}
  box.innerHTML = msgs.length ? `<div class="banner">${msgs.join("")}</div>` : "";
  box.hidden = !msgs.length;
  if($("pmNotif")) $("pmNotif").onclick=async()=>{ try{ await LN.requestPermissions() }catch(e){} checkPermissions(); scheduleNative() };
  if($("pmExact")) $("pmExact").onclick=async()=>{ try{ await LN.changeExactNotificationSetting() }catch(e){} setTimeout(checkPermissions,1500) };
}
function hashId(str){ let h=0; for(let i=0;i<str.length;i++){ h=((h<<5)-h+str.charCodeAt(i))|0 } return Math.abs(h)%2000000000 }
let schedTimer=null;
function scheduleNative(){ if(!LN) return; clearTimeout(schedTimer); schedTimer=setTimeout(doSchedule,1200) }
async function doSchedule(){
  try{
    const pend=await LN.getPending();
    if(pend.notifications && pend.notifications.length) await LN.cancel({notifications:pend.notifications.map(n=>({id:n.id}))});
    const real=new Date(), list=[];
    for(let off=0; off<2; off++){
      const day=new Date(real.getFullYear(), real.getMonth(), real.getDate()+off);
      for(const t of tasks){
        if(!t.time || !onDay(t,day)) continue;
        if(off===0 && isDone(t,day)) continue;
        const rep=Math.max(1,t.repeat||5);
        const [h,m]=t.time.split(":").map(Number);
        const start=new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0).getTime();
        const n=Math.min(MAX_REPEATS, Math.floor(REPEAT_WINDOW_MIN/rep)+1);
        for(let k=0;k<n;k++){
          const at=start+k*rep*60000;
          if(at<=real.getTime()+3000) continue;
          if(t.snoozeUntil && at<t.snoozeUntil) continue;
          const tone=t.sound && t.sound.kind==="tone" ? t.sound.id : "bell";
          list.push({
            id: hashId(t.id+"|"+dayKey(day)+"|"+k),
            title: (k?"Напоминаю: ":"Пора: ")+t.title,
            body: (t.param?t.param+" · ":"")+"нажмите «Готово», когда сделаете",
            schedule:{at:new Date(at), allowWhileIdle:true},
            channelId:"tone_"+(TONES[tone]?tone:"bell"),
            actionTypeId:"TASK",
            smallIcon:"ic_stat_notify",
            extra:{taskId:t.id},
          });
        }
      }
    }
    list.sort((a,b)=>a.schedule.at-b.schedule.at);
    if(list.length) await LN.schedule({notifications:list.slice(0,400)});
  }catch(e){ console.warn("schedule failed", e) }
}
document.addEventListener("visibilitychange",()=>{ if(document.visibilityState==="visible"){ checkReminders(); render(); scheduleNative(); checkPermissions() } else Object.keys(playing).forEach(stopSound) });

/* ---------- отрисовка ---------- */
const CHECK='<svg width="16" height="16" viewBox="0 0 16 16"><path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="var(--bg)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const DOWN='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v14M6 12l6 6 6-6"/></svg>';
const UP='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20V6M6 12l6-6 6 6"/></svg>';
function esc(s){ return String(s ?? "").replace(/[&<>"]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])) }
function daysLabel(t){ const d=t.days||[]; if(!d.length||d.length===7) return "каждый день"; const j=[...d].sort().join(); if(j==="0,1,2,3,4") return "будни"; if(j==="5,6") return "выходные"; return [...d].sort().map(i=>DAYS[i]).join(" ") }
function soundLabel(s){ if(!s||s.kind==="tone") return TONES[s?s.id:"bell"]||TONES.bell; return "♪ "+s.name }
function rowHTML(t,d){
  const due=dueState(t,d), done=isDone(t,d);
  const meta=[t.param?`<span class="chip">${esc(t.param)}</span>`:"",
    t.time?`<span class="chip plain">каждые ${t.repeat||5} мин · ${esc(soundLabel(t.sound))}</span>`:"",
    `<span class="chip plain">${daysLabel(t)}</span>`].join("");
  const toFree=!!t.time, lbl=toFree?"Перенести в «В течение дня»":"Перенести в «По времени»";
  return `<div class="row ${done?"done":""} ${due?"due":""}" draggable="true" data-id="${t.id}">
    <button class="chk" data-done="${t.id}" aria-label="Отметить «${esc(t.title)}»">${CHECK}</button>
    <button class="main" data-edit="${t.id}"><div class="title">${esc(t.title)}</div><div class="meta">${meta}</div></button>
    <div class="time">${t.time||""}</div>
    <button class="move" data-move="${t.id}" title="${lbl}" aria-label="${lbl}">${toFree?DOWN:UP}</button></div>`;
}
function render(){
  if(!user) return;
  const d=now();
  const today=tasks.filter(t=>onDay(t,d));
  const timed=today.filter(t=>t.time).sort((a,b)=>minsOf(a.time)-minsOf(b.time));
  const free=today.filter(t=>!t.time).sort((a,b)=>(a.order||0)-(b.order||0));
  $("timed").innerHTML = timed.length ? timed.map(t=>rowHTML(t,d)).join("") : '<div class="empty">Нет дел со временем на сегодня.</div>';
  $("free").innerHTML = free.length ? free.map(t=>rowHTML(t,d)).join("") : '<div class="empty">Нет дел без времени.</div>';
  const doneN=today.filter(t=>isDone(t,d)).length;
  $("cnt").textContent=doneN+"/"+today.length;
  $("arc").setAttribute("stroke-dashoffset", String(201-(today.length?201*doneN/today.length:0)));
  const due=timed.filter(t=>dueState(t,d));
  $("alerts").innerHTML = due.map(t=>{ const s=dueState(t,d), rep=t.repeat||5, next=rep-(s.late%rep);
    return `<div class="alert" role="alert"><div class="t"><b>Пора: ${esc(t.title)}${t.param?" · "+esc(t.param):""}</b>
      <span>Просрочено на ${s.late} мин. Следующее напоминание через ${next} мин</span></div>
      <div class="row-btns"><button class="btn" data-mute="${t.id}">Тише</button><button class="btn" data-snooze="${t.id}">Отложить 10 мин</button><button class="btn warn" data-done="${t.id}">Готово</button></div></div>` }).join("");
}
function tickClock(){
  const d=now();
  $("clock").textContent=d.toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit",second:"2-digit"})+(shiftMin?"  (тест)":"");
  $("date").textContent=d.toLocaleDateString("ru-RU",{weekday:"long",day:"numeric",month:"long"});
}
let lastMinute=-1, lastDay=dayKey(new Date());
setInterval(()=>{
  tickClock();
  const m=now().getMinutes();
  if(m!==lastMinute){ lastMinute=m; checkReminders(); render();
    const dk=dayKey(new Date()); if(dk!==lastDay){ lastDay=dk; scheduleNative() } }
},1000);

/* ---------- перетаскивание мышью (ПК) ---------- */
let dragId=null;
document.addEventListener("dragstart",e=>{ const r=e.target.closest&&e.target.closest(".row"); if(!r) return; dragId=r.dataset.id; r.classList.add("dragging"); try{ e.dataTransfer.setData("text/plain",dragId); e.dataTransfer.effectAllowed="move" }catch(_){} });
document.addEventListener("dragend",()=>{ dragId=null; document.querySelectorAll(".dragging,.drop").forEach(x=>x.classList.remove("dragging","drop")) });
["timed","free"].forEach(z=>{ const el=$(z);
  el.addEventListener("dragover",e=>{ if(!dragId) return; e.preventDefault(); el.classList.add("drop") });
  el.addEventListener("dragleave",e=>{ if(!el.contains(e.relatedTarget)) el.classList.remove("drop") });
  el.addEventListener("drop",e=>{ e.preventDefault(); el.classList.remove("drop"); const t=tasks.find(x=>x.id===dragId); if(t) moveTo(t,z) });
});

/* ---------- редактор дела ---------- */
let pending=null;
function openSheet(t, opts={}){
  const isNew=!t||!t.id;
  t=t||{title:"",param:"",time:opts.timed===false?null:nextHour(),repeat:5,days:[0,1,2,3,4,5,6]};
  let days=[...(t.days&&t.days.length?t.days:[0,1,2,3,4,5,6])];
  pending=t.sound||{kind:"tone",id:"bell"};
  const custom=pending.kind!=="tone";
  $("sheetHost").innerHTML=`<div class="sheet-bg" id="bg"><form class="sheet" id="f" novalidate>
    <h3>${isNew?"Новое дело":opts.moving?"Перенос в «По времени»":"Изменить дело"}</h3>
    <label>Название<input type="text" id="fTitle" value="${esc(t.title)}" placeholder="Например, отжаться"></label>
    <label>Параметр (сколько)<input type="text" id="fParam" value="${esc(t.param)}" placeholder="17 раз, 30 мин, 1 глава"></label>
    <label class="toggle"><input type="checkbox" id="fHasTime" ${t.time?"checked":""}> Привязать ко времени (блок «По времени»)</label>
    <div id="timeBox" ${t.time?"":"hidden"} class="col">
      <div class="inline">
        <label>Время<input type="time" id="fTime" value="${t.time||t.lastTime||nextHour()}"></label>
        <label>Повторять каждые, мин<input type="number" id="fRepeat" min="1" max="120" value="${t.repeat||5}"></label>
      </div>
      <div><div class="lbl">Мелодия будильника</div>
        <div class="sound">
          <select id="fSound">
            ${Object.entries(TONES).map(([k,v])=>`<option value="${k}" ${!custom&&pending.id===k?"selected":""}>${v}</option>`).join("")}
            <option value="custom" ${custom?"selected":""}>${custom?"♪ "+esc(pending.name):"Своя музыка…"}</option>
          </select>
          <button type="button" class="btn" id="fPlay">▶ Прослушать</button>
          <button type="button" class="btn" id="fPick">Выбрать файл</button>
        </div>
        <p class="hint" id="fHint">${custom?"Своя музыка играет, когда приложение открыто; в закрытом приложении звучит «Колокольчик».":"Встроенные мелодии звучат и в системном уведомлении."}</p>
      </div>
    </div>
    <div><div class="lbl">Дни недели</div><div class="days" id="fDays">
      ${DAYS.map((n,i)=>`<button type="button" class="day ${days.includes(i)?"on":""}" data-day="${i}">${n}</button>`).join("")}</div></div>
    <div id="confirmBox"></div>
    <div class="foot">
      ${isNew?"<span></span>":'<button type="button" class="btn" id="fDel">Удалить</button>'}
      <div class="row-btns"><button type="button" class="btn" id="fCancel">Отмена</button><button type="submit" class="btn primary">Сохранить</button></div>
    </div></form></div>`;
  const close=()=>{ stopSound("preview"); $("sheetHost").innerHTML="" };
  $("bg").addEventListener("click",e=>{ if(e.target.id==="bg") close() });
  $("fCancel").onclick=close;
  $("fHasTime").onchange=e=>{ $("timeBox").hidden=!e.target.checked };
  $("fDays").onclick=e=>{ const b=e.target.closest("[data-day]"); if(!b) return; const i=+b.dataset.day;
    days=days.includes(i)?days.filter(x=>x!==i):[...days,i].sort(); b.classList.toggle("on") };
  $("fSound").onchange=e=>{ const v=e.target.value;
    if(v==="custom"){ if(pending.kind==="tone") $("pickAudio").click() }
    else { pending={kind:"tone",id:v}; $("fHint").textContent="Встроенные мелодии звучат и в системном уведомлении." } };
  $("fPick").onclick=()=>$("pickAudio").click();
  $("fPlay").onclick=()=>{ if(playing.preview){ stopSound("preview"); $("fPlay").textContent="▶ Прослушать"; return }
    startSound("preview",pending,false,20); $("fPlay").textContent="■ Стоп"; setTimeout(()=>{ if($("fPlay")) $("fPlay").textContent="▶ Прослушать" },20000) };
  if($("fDel")) $("fDel").onclick=()=>{ $("confirmBox").innerHTML=`<div class="confirm">Удалить «${esc(t.title)}»?
    <button type="button" class="btn warn" id="fDelYes">Удалить</button><button type="button" class="btn" id="fDelNo">Нет</button></div>`;
    $("fDelYes").onclick=()=>{ removeTask(t.id); close(); toast("Удалено") }; $("fDelNo").onclick=()=>{ $("confirmBox").innerHTML="" } };
  $("f").addEventListener("submit",e=>{ e.preventDefault();
    const title=$("fTitle").value.trim(); if(!title){ $("fTitle").focus(); toast("Введите название"); return }
    if(!days.length){ toast("Выберите хотя бы один день"); return }
    const hasTime=$("fHasTime").checked;
    const out={...t, title, param:$("fParam").value.trim(), time:hasTime?$("fTime").value:null,
      repeat:Math.min(120,Math.max(1,parseInt($("fRepeat").value)||5)), days, sound:pending, order:t.order||Date.now()};
    if(!hasTime && t.time) out.lastTime=t.time;
    if(isNew){ delete out.id; out.doneOn=null }
    if(t.id) delete lastFired[t.id];
    saveTask(out); close(); toast(isNew?"Дело добавлено":"Сохранено");
  });
  if(isNew) $("fTitle").focus();
}
$("pickAudio").addEventListener("change", async e=>{
  const f=e.target.files[0]; e.target.value=""; if(!f) return;
  try{
    const key="s"+Date.now(); await idbPut("snd-"+key, f);
    pending={kind:"local", key, name:f.name.replace(/\.[^.]+$/,"").slice(0,40)};
    if($("fSound")){ const o=$("fSound").querySelector('option[value="custom"]'); o.textContent="♪ "+pending.name; $("fSound").value="custom";
      $("fHint").textContent="Файл сохранён на этом устройстве. Играет, когда приложение открыто; в закрытом приложении звучит «Колокольчик»." }
    toast("Мелодия выбрана: "+pending.name);
  }catch(err){ toast("Не удалось сохранить файл") }
});

/* ---------- настройки ---------- */
function openSettings(){
  $("sheetHost").innerHTML=`<div class="sheet-bg" id="bg"><div class="sheet">
    <h3>Настройки</h3>
    <div class="lbl" style="margin:0">Обои</div>
    <div class="thumb" id="wallThumb">Обои не выбраны</div>
    <div class="row-btns"><button class="btn primary" id="wPick">Выбрать картинку</button><button class="btn" id="wClear">Убрать обои</button></div>
    <label>Затемнение под списком: <span id="veilVal">${settings.veil??55}%</span><input type="range" id="wVeil" min="0" max="90" value="${settings.veil??55}"></label>
    ${isNative?`<div class="lbl" style="margin:0">Телефон</div>
      <div class="row-btns"><button class="btn" id="sPerm">Проверить разрешения</button><button class="btn" id="sTest">Тестовое уведомление через 10 с</button></div>
      <p class="hint">Чтобы Samsung не «усыплял» напоминания: Настройки → Приложения → Распорядок → Аккумулятор → «Без ограничений».</p>`
      :`<p class="hint">Это версия для ПК. Уведомления браузера можно включить кнопкой «Звук» в тест-режиме.</p>`}
    <div class="lbl" style="margin:0">Аккаунт</div>
    <p class="hint">${esc(user&&user.email)}</p>
    <div class="foot"><button class="btn" id="sOut">Выйти</button><button class="btn primary" id="wClose">Готово</button></div>
    <div class="ver">Версия интерфейса ${APP_VERSION}${isNative?" · приложение":" · браузер"}</div>
  </div></div>`;
  applyWall();
  const close=()=>{ $("sheetHost").innerHTML="" };
  $("bg").addEventListener("click",e=>{ if(e.target.id==="bg") close() });
  $("wClose").onclick=close;
  $("wPick").onclick=()=>$("pickWall").click();
  $("wClear").onclick=()=>{ settings.wallpaper=null; saveSettings(); toast("Обои убраны") };
  let vt; $("wVeil").oninput=e=>{ settings.veil=+e.target.value; $("veilVal").textContent=settings.veil+"%"; applyWall(); clearTimeout(vt); vt=setTimeout(saveSettings,700) };
  $("sOut").onclick=()=>{ close(); auth.signOut() };
  if($("sPerm")) $("sPerm").onclick=async()=>{ try{ await LN.requestPermissions() }catch(e){} await checkPermissions(); toast($("permBanner").hidden?"Все разрешения есть":"Не хватает разрешений — см. баннер") };
  if($("sTest")) $("sTest").onclick=async()=>{ try{ await LN.schedule({notifications:[{id:999,title:"Проверка",body:"Уведомления работают",schedule:{at:new Date(Date.now()+10000),allowWhileIdle:true},channelId:"tone_bell",smallIcon:"ic_stat_notify"}]}); toast("Сверните приложение — через 10 секунд придёт уведомление") }catch(e){ toast("Ошибка: "+(e.message||e)) } };
}
$("settingsBtn").onclick=openSettings;

/* ---------- события ---------- */
document.addEventListener("click",e=>{
  const dn=e.target.closest("[data-done]"); if(dn){ const t=tasks.find(x=>x.id===dn.dataset.done); if(t) toggleDone(t); return }
  const mv=e.target.closest("[data-move]"); if(mv){ const t=tasks.find(x=>x.id===mv.dataset.move); if(t) moveTo(t, t.time?"free":"timed"); return }
  const ed=e.target.closest("[data-edit]"); if(ed){ openSheet(tasks.find(x=>x.id===ed.dataset.edit)); return }
  const mu=e.target.closest("[data-mute]"); if(mu){ stopSound(mu.dataset.mute); return }
  const sn=e.target.closest("[data-snooze]"); if(sn){ const t=tasks.find(x=>x.id===sn.dataset.snooze); if(t) snooze(t,10); return }
  const sh=e.target.closest("[data-shift]"); if(sh) setShift(shiftMin + +sh.dataset.shift);
});
function setShift(v){ shiftMin=v; $("shiftTxt").textContent=(v>=0?"+":"")+Math.round(v)+" мин"; tickClock(); lastMinute=-1; checkReminders(); render() }
$("shReset").onclick=()=>{ Object.keys(playing).forEach(stopSound); setShift(0) };
$("shNext").onclick=()=>{ const d=now(), nowM=d.getHours()*60+d.getMinutes();
  const next=tasks.filter(t=>t.time&&onDay(t,d)&&!isDone(t,d)&&minsOf(t.time)>nowM).sort((a,b)=>minsOf(a.time)-minsOf(b.time))[0];
  if(!next){ toast("На сегодня больше нет дел со временем"); return }
  setShift(shiftMin+(minsOf(next.time)-nowM)-d.getSeconds()/60+0.05) };
function updateSoundBtn(){ $("sound").textContent="Звук: "+(soundOn?"вкл":"выкл") }
$("sound").onclick=()=>{ soundOn=!soundOn; updateSoundBtn(); if(soundOn) playTone("bell",false); else Object.keys(playing).forEach(stopSound);
  if(!isNative){ try{ if(window.Notification && Notification.permission==="default") Notification.requestPermission() }catch(e){} } };
$("add").onclick=()=>openSheet(null);
$("addTimed").onclick=()=>openSheet(null,{timed:true});
$("addFree").onclick=()=>openSheet(null,{timed:false});
let toastT; function toast(m){ const el=$("toast"); el.textContent=m; el.hidden=false; clearTimeout(toastT); toastT=setTimeout(()=>el.hidden=true,2600) }

updateSoundBtn(); tickClock();
