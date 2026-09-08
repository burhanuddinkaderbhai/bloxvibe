/*
  BloxVibe MVP
  1) Create a Supabase project.
  2) Run schema.sql in Supabase SQL Editor.
  3) Create Storage buckets named "avatars" and "posts" (public).
  4) Put your project URL + anon key below.
*/
const SUPABASE_URL = "PASTE_YOUR_SUPABASE_URL";
const SUPABASE_ANON_KEY = "PASTE_YOUR_SUPABASE_ANON_KEY";
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let me=null, currentUser=null, authMode="login", usersCache=[], rtc=null, localStream=null, callChannel=null;

const $=id=>document.getElementById(id);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
const timeAgo=d=>new Intl.RelativeTimeFormat(undefined,{numeric:"auto"}).format(-Math.round((Date.now()-new Date(d))/60000),"minute");

async function init(){
  const {data:{session}}=await sb.auth.getSession();
  if(session) await enterApp(session.user); else showAuth();
  sb.auth.onAuthStateChange(async(_e,s)=>{if(s) await enterApp(s.user); else showAuth()});
}
function showAuth(){$("auth").classList.remove("hidden");$("app").classList.add("hidden")}
async function enterApp(user){
  me=user;
  const {data:profile}=await sb.from("profiles").select("*").eq("id",user.id).single();
  if(!profile){
    const username=(user.email?.split("@")[0]||"player")+Math.floor(Math.random()*9999);
    await sb.from("profiles").insert({id:user.id,username});
  }
  const {data:p}=await sb.from("profiles").select("*").eq("id",user.id).single(); currentUser=p;
  $("auth").classList.add("hidden");$("app").classList.remove("hidden");
  $("meMini").innerHTML=`<div class="person"><div class="avatar">${avatarHtml(p)}</div><div><b>${esc(p.username)}</b><div class="post-time">Online</div></div></div>`;
  await loadFeed(); await loadPeople();
}
function avatarHtml(p){return p?.avatar_url?`<img class="avatar" src="${esc(p.avatar_url)}" alt="">`:esc((p?.username||"?")[0].toUpperCase())}

document.querySelectorAll(".tab").forEach(b=>b.onclick=()=>{
  document.querySelectorAll(".tab").forEach(x=>x.classList.remove("active"));b.classList.add("active");
  authMode=b.dataset.auth;$("username").classList.toggle("hidden",authMode!=="signup");$("authSubmit").textContent=authMode==="signup"?"Create account":"Log in";
});
$("authForm").onsubmit=async e=>{
  e.preventDefault();$("authMsg").textContent="Working…";
  const email=$("email").value,password=$("password").value;
  let r=authMode==="signup"?await sb.auth.signUp({email,password,options:{data:{username:$("username").value}}}):await sb.auth.signInWithPassword({email,password});
  if(r.error)$("authMsg").textContent=r.error.message;else $("authMsg").textContent=authMode==="signup"?"Check your email to confirm your account.":"";
};
$("logout").onclick=()=>sb.auth.signOut();

document.querySelectorAll(".nav").forEach(n=>n.onclick=()=>{
  document.querySelectorAll(".nav").forEach(x=>x.classList.remove("active"));n.classList.add("active");
  document.querySelectorAll(".view").forEach(x=>x.classList.add("hidden"));$(`${n.dataset.view}View`).classList.remove("hidden");
  $("pageTitle").textContent={feed:"Home",messages:"Messages",profile:"Profile",settings:"Settings"}[n.dataset.view];
  if(n.dataset.view==="profile")loadProfile(); if(n.dataset.view==="settings"){ $("editUsername").value=currentUser.username;$("editAvatar").value=currentUser.avatar_url||"";}
});
$("newPostBtn").onclick=()=>$("postModal").classList.remove("hidden");
document.querySelectorAll("[data-close]").forEach(x=>x.onclick=()=>$(x.dataset.close).classList.add("hidden"));

async function uploadImage(file,bucket){
  if(!file)return null; const ext=file.name.split(".").pop();const path=`${me.id}/${crypto.randomUUID()}.${ext}`;
  const {error}=await sb.storage.from(bucket).upload(path,file,{upsert:false});if(error)throw error;
  return sb.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}
async function createPost(text,file){
  if(!text.trim()&&!file)return;
  try{const image_url=await uploadImage(file,"posts");const {error}=await sb.from("posts").insert({user_id:me.id,content:text.trim(),image_url});if(error)throw error;
    $("statusText").value="";$("postImage").value="";$("modalText").value="";$("modalImage").value="";$("postModal").classList.add("hidden");await loadFeed();
  }catch(e){alert(e.message)}
}
$("postBtn").onclick=()=>createPost($("statusText").value,$("postImage").files[0]);
$("modalPostBtn").onclick=()=>createPost($("modalText").value,$("modalImage").files[0]);

async function loadFeed(){
  const {data}=await sb.from("posts").select("*,profiles(username,avatar_url)").order("created_at",{ascending:false}).limit(80);
  $("feed").innerHTML=(data||[]).map(p=>`<article class="post"><div class="post-head"><div class="avatar">${avatarHtml(p.profiles)}</div><div><b>${esc(p.profiles?.username||"User")}</b><div class="post-time">${timeAgo(p.created_at)}</div></div></div><div class="post-body">${esc(p.content||"")}</div>${p.image_url?`<img class="post-img" src="${esc(p.image_url)}" alt="Post image" loading="lazy">`:""}</article>`).join("")||`<div class="empty">No posts yet. Be the first to post!</div>`;
}
async function loadPeople(){
  const {data}=await sb.from("profiles").select("*").neq("id",me.id).order("username").limit(200);usersCache=data||[];renderPeople(usersCache);
}
function renderPeople(list){$("people").innerHTML=list.map(p=>`<div class="person" data-id="${p.id}"><div class="avatar">${avatarHtml(p)}</div><div><b>${esc(p.username)}</b><div class="post-time">Message</div></div></div>`).join("");document.querySelectorAll(".person[data-id]").forEach(x=>x.onclick=()=>openChat(x.dataset.id))}
$("userSearch").oninput=e=>renderPeople(usersCache.filter(u=>u.username.toLowerCase().includes(e.target.value.toLowerCase())));

async function openChat(id){
  currentUser={...currentUser};currentUser.chattingWith=id;currentUser.chatProfile=usersCache.find(u=>u.id===id);
  $("chatEmpty").classList.add("hidden");$("chat").classList.remove("hidden");
  const p=currentUser.chatProfile;$("chatUser").innerHTML=`<div class="avatar">${avatarHtml(p)}</div>${esc(p.username)}`;
  await loadMessages();subscribeMessages();
}
async function loadMessages(){
  const ids=[me.id,currentUser.chattingWith].sort();
  const {data}=await sb.from("messages").select("*").or(`and(sender_id.eq.${ids[0]},receiver_id.eq.${ids[1]}),and(sender_id.eq.${ids[1]},receiver_id.eq.${ids[0]})`).order("created_at");
  $("chatMessages").innerHTML=(data||[]).map(renderMessage).join("");$("chatMessages").scrollTop=$("chatMessages").scrollHeight;
}
function renderMessage(m){return `<div class="bubble ${m.sender_id===me.id?"mine":""}">${esc(m.body)}<small>${new Date(m.created_at).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}</small></div>`}
let msgSub=null;
function subscribeMessages(){
  if(msgSub)sb.removeChannel(msgSub);
  msgSub=sb.channel("messages-"+[me.id,currentUser.chattingWith].sort().join("-")).on("postgres_changes",{event:"INSERT",schema:"public",table:"messages"},payload=>{
    const m=payload.new;if((m.sender_id===me.id&&m.receiver_id===currentUser.chattingWith)||(m.sender_id===currentUser.chattingWith&&m.receiver_id===me.id)){$("chatMessages").insertAdjacentHTML("beforeend",renderMessage(m));$("chatMessages").scrollTop=$("chatMessages").scrollHeight}
  }).subscribe();
}
$("messageForm").onsubmit=async e=>{e.preventDefault();const body=$("messageInput").value.trim();if(!body)return;await sb.from("messages").insert({sender_id:me.id,receiver_id:currentUser.chattingWith,body});$("messageInput").value=""};

async function loadProfile(){
  const {data:p}=await sb.from("profiles").select("*").eq("id",me.id).single();currentUser=p;
  $("profileCard").innerHTML=`<div class="profile-box"><div class="avatar">${avatarHtml(p)}</div><div><h2>${esc(p.username)}</h2><div class="muted">BloxVibe member</div></div></div>`;
  const {data}=await sb.from("posts").select("*,profiles(username,avatar_url)").eq("user_id",me.id).order("created_at",{ascending:false});
  $("myPosts").innerHTML=(data||[]).map(p=>`<article class="post"><div class="post-time">${timeAgo(p.created_at)}</div><div class="post-body">${esc(p.content||"")}</div>${p.image_url?`<img class="post-img" src="${esc(p.image_url)}">`:""}</article>`).join("")||`<div class="empty">You haven't posted yet.</div>`;
}
$("saveProfile").onclick=async()=>{
  const username=$("editUsername").value.trim();if(!username)return;
  const {error}=await sb.from("profiles").update({username,avatar_url:$("editAvatar").value.trim()||null}).eq("id",me.id);
  $("settingsMsg").textContent=error?error.message:"Saved!";if(!error)await enterApp(me);
};

async function startCall(){
  if(!currentUser?.chattingWith)return;
  $("callModal").classList.remove("hidden");$("callTitle").textContent=`Calling ${currentUser.chatProfile.username}…`;
  localStream=await navigator.mediaDevices.getUserMedia({audio:true,video:true});$("localVideo").srcObject=localStream;
  rtc=new RTCPeerConnection({iceServers:[{urls:"stun:stun.l.google.com:19302"}]});
  localStream.getTracks().forEach(t=>rtc.addTrack(t,localStream));
  rtc.ontrack=e=>$("remoteVideo").srcObject=e.streams[0];
  const room=[me.id,currentUser.chattingWith].sort().join("-");
  callChannel=sb.channel("call-"+room);
  await callChannel.subscribe();
  callChannel.on("broadcast",{event:"signal"},async({payload})=>{
    if(payload.to!==me.id)return;
    if(payload.type==="offer"){await rtc.setRemoteDescription(payload.sdp);const ans=await rtc.createAnswer();await rtc.setLocalDescription(ans);callChannel.send({type:"broadcast",event:"signal",payload:{to:currentUser.chattingWith,from:me.id,type:"answer",sdp:rtc.localDescription}})}
    if(payload.type==="answer")await rtc.setRemoteDescription(payload.sdp);
    if(payload.type==="ice"&&payload.candidate)try{await rtc.addIceCandidate(payload.candidate)}catch{}
  });
  rtc.onicecandidate=e=>{if(e.candidate)callChannel.send({type:"broadcast",event:"signal",payload:{to:currentUser.chattingWith,from:me.id,type:"ice",candidate:e.candidate}})};
  const offer=await rtc.createOffer();await rtc.setLocalDescription(offer);
  callChannel.send({type:"broadcast",event:"signal",payload:{to:currentUser.chattingWith,from:me.id,type:"offer",sdp:rtc.localDescription}});
  $("callStatus").textContent="Calling…";
}
$("callBtn").onclick=startCall;
$("hangup").onclick=hangup;
async function hangup(){
  if(rtc)rtc.close();if(localStream)localStream.getTracks().forEach(t=>t.stop());if(callChannel)await sb.removeChannel(callChannel);
  rtc=null;localStream=null;callChannel=null;$("remoteVideo").srcObject=null;$("localVideo").srcObject=null;$("callModal").classList.add("hidden");
}
init();
