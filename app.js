/* BloxVibe - Supabase community app
   Profiles, posts, picture+caption uploads, DMs, realtime messages,
   automatic profiles, notifications and WebRTC audio/video calls.
*/
const SUPABASE_URL = "https://hdrlkewcqcirgpreqixi.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_QgfZdMWmvwPrS6DZHi9yRA_NlthUxFX";
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storageKey: "bloxvibe-auth"
  }
});

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg","image/png","image/webp","image/gif"]);

let me = null;
let profile = null;
let authMode = "login";
let usersCache = [];
let activeChatId = null;
let activeChatProfile = null;
let realtimeChannel = null;
let callChannel = null;
let rtc = null;
let localStream = null;
let currentCallPeer = null;
let currentCallMode = "video";
let pendingIce = [];
let incomingCall = null;
let renderedMessageIds = new Set();
let activeSharePost = null;
let feedPostsCache = [];

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
const timeAgo = d => new Intl.RelativeTimeFormat(undefined,{numeric:"auto"}).format(-Math.round((Date.now()-new Date(d))/60000),"minute");

function showToast(title, body = "", type = "info") {
  const box = document.createElement("div");
  box.className = `toast ${type}`;
  box.innerHTML = `<b>${esc(title)}</b>${body ? `<div>${esc(body)}</div>` : ""}`;
  ($("toastContainer") || document.body).appendChild(box);
  setTimeout(() => box.remove(), 5000);
}

async function enableNotifications() {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "default") {
    try { await Notification.requestPermission(); } catch {}
  }
  return Notification.permission === "granted";
}

function browserNotify(title, body, onClick) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const n = new Notification(title, {body, tag:`bloxvibe-${Date.now()}`});
  if (onClick) n.onclick = () => { window.focus(); onClick(); n.close(); };
}

function setMessageBadge(increment = 0, clear = false) {
  const b = $("messageBadge");
  if (!b) return;
  if (clear) { b.textContent = "0"; b.classList.add("hidden"); return; }
  const n = Math.max(0, (parseInt(b.textContent, 10) || 0) + increment);
  b.textContent = String(n);
  b.classList.toggle("hidden", n === 0);
}

async function init() {
  const {data:{session}} = await sb.auth.getSession();
  if (session) await enterApp(session.user); else showAuth();
  sb.auth.onAuthStateChange(async (_event, session) => {
    if (session) await enterApp(session.user); else showAuth();
  });
}

function showAuth() {
  $("auth").classList.remove("hidden");
  $("app").classList.add("hidden");
}

async function enterApp(user) {
  me = user;
  const {data:p, error} = await sb.from("profiles").select("*").eq("id", user.id).maybeSingle();
  if (error) return showToast("Profile error", error.message, "error");
  if (!p) {
    // Normally handled by the DB trigger. This fallback helps if the account predates it.
    const supplied = (user.user_metadata?.username || "").trim();
    const username = supplied || ((user.email?.split("@")[0] || "player") + Math.floor(Math.random()*9999));
    const ins = await sb.from("profiles").insert({id:user.id, username});
    if (ins.error) return showToast("Profile setup failed", ins.error.message, "error");
  }
  const {data:finalProfile, error:finalError} = await sb.from("profiles").select("*").eq("id", user.id).single();
  if (finalError) return showToast("Profile error", finalError.message, "error");
  profile = finalProfile;
  $("auth").classList.add("hidden");
  $("app").classList.remove("hidden");
  renderMyMiniProfile();
  await Promise.all([loadFeed(), loadPeople(), loadUnreadNotifications()]);
  await enableNotifications();
  await startRealtime();
  await startCallListener();
}

function renderMyMiniProfile() {
  $("meMini").innerHTML = `<div class="person"><div class="avatar">${avatarHtml(profile)}</div><div><b>${esc(profile.username)}</b><div class="post-time">Online</div></div></div>`;
}

function avatarHtml(p) {
  return p?.avatar_url
    ? `<img class="avatar" src="${esc(p.avatar_url)}" alt="">`
    : esc((p?.username || "?")[0].toUpperCase());
}

// ---------- Authentication ----------
document.querySelectorAll(".tab").forEach(b => b.onclick = () => {
  document.querySelectorAll(".tab").forEach(x => x.classList.remove("active"));
  b.classList.add("active");
  authMode = b.dataset.auth;
  $("username").classList.toggle("hidden", authMode !== "signup");
  $("authSubmit").textContent = authMode === "signup" ? "Create account" : "Log in";
  $("authMsg").textContent = "";
});

$("authForm").onsubmit = async e => {
  e.preventDefault();
  $("authMsg").textContent = "Working…";
  const email = $("email").value.trim();
  const password = $("password").value;
  const username = $("username").value.trim();
  if (authMode === "signup" && (username.length < 3 || username.length > 24)) {
    $("authMsg").textContent = "Username must be 3–24 characters."; return;
  }
  const result = authMode === "signup"
    ? await sb.auth.signUp({email, password, options:{data:{username}}})
    : await sb.auth.signInWithPassword({email, password});
  if (result.error) $("authMsg").textContent = result.error.message;
  else $("authMsg").textContent = authMode === "signup" ? "Account created. Check your email if confirmation is required." : "";
};

$("logout").onclick = async () => {
  await cleanupRealtime();
  await hangup(false);
  await sb.auth.signOut();
};

// ---------- Navigation ----------
document.querySelectorAll(".nav").forEach(n => n.onclick = async () => {
  document.querySelectorAll(".nav").forEach(x => x.classList.remove("active"));
  n.classList.add("active");
  document.querySelectorAll(".view").forEach(x => x.classList.add("hidden"));
  $(`${n.dataset.view}View`).classList.remove("hidden");
  $("pageTitle").textContent = {feed:"Home",messages:"Messages",profile:"Profile",settings:"Settings"}[n.dataset.view];
  if (n.dataset.view === "profile") await loadProfile();
  if (n.dataset.view === "settings") {
    $("editUsername").value = profile.username;
    $("editAvatar").value = profile.avatar_url || "";
  }
  if (n.dataset.view === "messages") setMessageBadge(0, true);
});

$("newPostBtn").onclick = () => $("postModal").classList.remove("hidden");
document.querySelectorAll("[data-close]").forEach(x => x.onclick = () => $(x.dataset.close).classList.add("hidden"));
$("notifyBtn").onclick = async () => {
  const ok = await enableNotifications();
  showToast(ok ? "Notifications enabled" : "Notifications blocked",
    ok ? "New messages and calls can alert you." : "Allow notifications in your browser settings.",
    ok ? "success" : "error");
};

// ---------- Picture posts ----------
function validateImage(file) {
  if (!file) return null;
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) throw new Error("Use JPG, PNG, WebP or GIF images only.");
  if (file.size > MAX_IMAGE_BYTES) throw new Error("Image must be 8 MB or smaller.");
  return file;
}

function bindImagePicker(inputId, nameId, previewId) {
  const input = $(inputId);
  if (!input) return;
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    const name = $(nameId);
    const preview = previewId ? $(previewId) : null;
    if (!file) {
      if (name) name.textContent = "";
      if (preview) { preview.classList.add("hidden"); preview.innerHTML = ""; }
      return;
    }
    try { validateImage(file); }
    catch (e) { input.value = ""; if (name) name.textContent = ""; if (preview) preview.classList.add("hidden"); showToast("Invalid picture", e.message, "error"); return; }
    if (name) name.textContent = `${file.name} • ${(file.size/1024/1024).toFixed(1)} MB`;
    if (preview) {
      const url = URL.createObjectURL(file);
      preview.innerHTML = `<img src="${url}" alt="Selected picture preview">`;
      preview.classList.remove("hidden");
    }
  });
}

bindImagePicker("postImage", "postImageName", "postImagePreview");
bindImagePicker("modalImage", "modalImageName", "imagePreview");

function bindCaptionCounter(inputId, countId) {
  const input = $(inputId), count = $(countId);
  if (!input || !count) return;
  const update = () => { count.textContent = String(input.value.length); };
  input.addEventListener("input", update);
  update();
}
bindCaptionCounter("statusText", "statusCount");
bindCaptionCounter("modalText", "modalCount");

async function uploadPostImage(file) {
  validateImage(file);
  if (!file) return null;
  const ext = file.name.split(".").pop().toLowerCase();
  const path = `${me.id}/${crypto.randomUUID()}.${ext}`;
  const {error} = await sb.storage.from("posts").upload(path, file, {
    upsert:false,
    contentType:file.type,
    cacheControl:"3600"
  });
  if (error) throw error;
  return sb.storage.from("posts").getPublicUrl(path).data.publicUrl;
}

let postingInProgress = false;
async function createPost(text, file) {
  if (postingInProgress) return;
  text = (text || "").trim();
  if (text.length > 500) return showToast("Caption too long", "Captions can be up to 500 characters.", "error");
  if (!text && !file) return showToast("Nothing to post", "Add a caption, a picture, or both.", "error");
  try {
    postingInProgress = true;
    document.querySelectorAll('#postBtn,#modalPostBtn').forEach(b => { b.disabled = true; b.dataset.originalText = b.textContent; b.textContent = 'Posting…'; });
    if (file) validateImage(file);
    const image_url = await uploadPostImage(file);
    const {error} = await sb.from("posts").insert({user_id:me.id, content:text || null, image_url});
    if (error) throw error;
    resetPostComposer();
    $("postModal").classList.add("hidden");
    await loadFeed();
    showToast("Posted", "Your picture and caption are now on BloxVibe.", "success");
  } catch (e) { showToast("Post failed", e.message, "error"); }
  finally {
    postingInProgress = false;
    document.querySelectorAll('#postBtn,#modalPostBtn').forEach(b => { b.disabled = false; b.textContent = b.dataset.originalText || (b.id === 'modalPostBtn' ? 'Publish' : 'Post'); });
  }
}

function resetPostComposer() {
  ["statusText","postImage","modalText","modalImage"].forEach(id => { if ($(id)) $(id).value = ""; });
  ["postImageName","modalImageName"].forEach(id => { if ($(id)) $(id).textContent = ""; });
  ["postImagePreview","imagePreview"].forEach(id => { if ($(id)) { $(id).classList.add("hidden"); $(id).innerHTML = ""; } });
}

$("postBtn").onclick = () => createPost($("statusText").value, $("postImage").files[0]);
$("modalPostBtn").onclick = () => createPost($("modalText").value, $("modalImage").files[0]);

function postActionsHtml(p) {
  const liked = (p.post_likes || []).some(x => x.user_id === me?.id);
  const comments = p.post_comments || [];
  return `<div class="post-actions">
    <button class="post-action ${liked ? "liked" : ""}" data-like="${p.id}">♥ <span>${(p.post_likes || []).length}</span></button>
    <button class="post-action" data-comments="${p.id}">💬 <span>${comments.length}</span></button>
    <button class="post-action" data-share="${p.id}">↗ Share</button>
  </div>
  <div class="comments" data-comments-box="${p.id}">
    <div class="comment-list">${comments.slice(-10).map(c => `<div class="comment"><div class="avatar mini">${avatarHtml(c.profiles)}</div><div><b>${esc(c.profiles?.username || "User")}</b><span>${esc(c.body)}</span><small>${timeAgo(c.created_at)}</small></div></div>`).join("")}</div>
    <form class="comment-form" data-comment-form="${p.id}"><input maxlength="500" placeholder="Write a comment…"><button class="ghost">Comment</button></form>
  </div>`;
}

function renderPost(p) {
  return `<article class="post" data-post-id="${p.id}">
    <div class="post-head"><div class="avatar">${avatarHtml(p.profiles)}</div><div><b>${esc(p.profiles?.username||"User")}</b><div class="post-time">${timeAgo(p.created_at)}</div></div></div>
    ${p.content ? `<div class="post-body">${esc(p.content)}</div>` : ""}
    ${p.image_url ? `<img class="post-img" src="${esc(p.image_url)}" alt="Post image" loading="lazy">` : ""}
    ${postActionsHtml(p)}
  </article>`;
}

function bindPostActions(container) {
  container.querySelectorAll('[data-like]').forEach(btn => btn.onclick = () => toggleLike(btn.dataset.like));
  container.querySelectorAll('.post-img').forEach(img => {
    let lastTap = 0;
    img.addEventListener('dblclick', () => {
      const post = img.closest('[data-post-id]');
      if (post) toggleLike(post.dataset.postId);
    });
    img.addEventListener('touchend', () => {
      const now = Date.now();
      if (now - lastTap < 320) {
        const post = img.closest('[data-post-id]');
        if (post) toggleLike(post.dataset.postId);
      }
      lastTap = now;
    }, {passive:true});
  });
  container.querySelectorAll('[data-share]').forEach(btn => btn.onclick = () => openShareModal(btn.dataset.share));
  container.querySelectorAll('[data-comments]').forEach(btn => btn.onclick = () => {
    const box = container.querySelector(`[data-comments-box="${btn.dataset.comments}"]`);
    if (box) box.classList.toggle("open");
  });
  container.querySelectorAll('[data-comment-form]').forEach(form => form.onsubmit = e => {
    e.preventDefault();
    addComment(form.dataset.commentForm, form.querySelector("input").value);
  });
}

async function loadFeed() {
  const {data,error} = await sb.from("posts")
    .select("*,profiles(username,avatar_url),post_likes(user_id),post_comments(id,body,user_id,created_at,profiles(username,avatar_url))")
    .order("created_at",{ascending:false}).limit(80);
  if (error) return showToast("Feed error", error.message, "error");
  feedPostsCache = data || [];
  $("feed").innerHTML = feedPostsCache.map(renderPost).join("") || `<div class="empty">No posts yet. Be the first to post!</div>`;
  bindPostActions($("feed"));
}

async function toggleLike(postId) {
  try {
    const {data,error:checkError} = await sb.from("post_likes").select("post_id").eq("post_id",postId).eq("user_id",me.id).maybeSingle();
    if (checkError) throw checkError;
    if (data) {
      const {error} = await sb.from("post_likes").delete().eq("post_id",postId).eq("user_id",me.id);
      if (error) throw error;
    } else {
      const {error} = await sb.from("post_likes").insert({post_id:postId,user_id:me.id});
      if (error) throw error;
    }
    await loadFeed();
  } catch (e) { showToast("Like failed", e.message, "error"); }
}

async function addComment(postId, body) {
  body = (body || "").trim();
  if (!body) return;
  if (body.length > 500) return showToast("Comment too long", "Comments can be up to 500 characters.", "error");
  const {error} = await sb.from("post_comments").insert({post_id:postId,user_id:me.id,body});
  if (error) return showToast("Comment failed", error.message, "error");
  await loadFeed();
}

function openShareModal(postId) {
  activeSharePost = feedPostsCache.find(p => p.id === postId);
  if (!activeSharePost) return showToast("Post unavailable", "Please refresh the feed and try again.", "error");
  $("sharePostPreview").innerHTML = renderPostPreview(activeSharePost);
  $("shareUsers").innerHTML = usersCache.map(u => `<button class="share-user" data-share-user="${u.id}"><div class="avatar">${avatarHtml(u)}</div><div><b>${esc(u.username)}</b><small>Send in DM</small></div></button>`).join("") || `<div class="empty">No other users yet.</div>`;
  $("shareModal").classList.remove("hidden");
  document.querySelectorAll("[data-share-user]").forEach(b => b.onclick = () => sharePostToUser(b.dataset.shareUser));
}

function renderPostPreview(p) {
  return `<div class="share-preview-card">${p.image_url ? `<img src="${esc(p.image_url)}" alt="Shared post">` : ""}<div>${p.content ? esc(p.content) : "Shared BloxVibe post"}</div><small>by ${esc(p.profiles?.username || "User")}</small></div>`;
}

async function sharePostToUser(receiverId) {
  if (!activeSharePost || receiverId === me.id) return;
  const body = `📤 Shared a post from ${activeSharePost.profiles?.username || "BloxVibe user"}`;
  const {error} = await sb.from("messages").insert({sender_id:me.id,receiver_id:receiverId,body,shared_post_id:activeSharePost.id});
  if (error) return showToast("Share failed", error.message, "error");
  $("shareModal").classList.add("hidden");
  showToast("Post shared", "The post was sent to their DMs.", "success");
}

// ---------- People + messages ----------
async function loadPeople() {
  const {data,error} = await sb.from("profiles").select("*").neq("id",me.id).order("username").limit(500);
  if (error) return showToast("Users error", error.message, "error");
  usersCache = data || [];
  renderPeople(usersCache);
}

function renderPeople(list) {
  $("people").innerHTML = list.map(p => `<div class="person ${activeChatId===p.id?"active":""}" data-id="${p.id}"><div class="avatar">${avatarHtml(p)}</div><div><b>${esc(p.username)}</b><div class="post-time">Message</div></div></div>`).join("") || `<div class="empty">No users found.</div>`;
  document.querySelectorAll(".person[data-id]").forEach(x => x.onclick = () => openChat(x.dataset.id));
}

$("userSearch").oninput = e => renderPeople(usersCache.filter(u => u.username.toLowerCase().includes(e.target.value.toLowerCase())));

async function openChat(id) {
  activeChatId = id;
  activeChatProfile = usersCache.find(u => u.id === id);
  setMessageBadge(0, true);
  $("chatEmpty").classList.add("hidden");
  $("chat").classList.remove("hidden");
  $("chatUser").innerHTML = `<div class="avatar">${avatarHtml(activeChatProfile)}</div>${esc(activeChatProfile?.username||"User")}`;
  renderPeople(usersCache);
  await loadMessages();
}

async function loadMessages() {
  if (!activeChatId) return;
  const {data,error} = await sb.from("messages")
    .select("*,posts:shared_post_id(id,content,image_url,profiles(username,avatar_url))")
    .or(`and(sender_id.eq.${me.id},receiver_id.eq.${activeChatId}),and(sender_id.eq.${activeChatId},receiver_id.eq.${me.id})`)
    .order("created_at",{ascending:true});
  if (error) return showToast("Messages error", error.message, "error");
  renderedMessageIds = new Set((data||[]).map(m=>m.id));
  $("chatMessages").innerHTML = (data||[]).map(renderMessage).join("");
  $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
}

function renderMessage(m) {
  const shared = m.posts ? `<div class="shared-post-message"><div class="shared-label">↗ Shared post</div>${renderPostPreview(m.posts)}</div>` : "";
  return `<div class="bubble ${m.sender_id===me.id?"mine":""}">${shared}<div>${esc(m.body)}</div><small>${new Date(m.created_at).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}</small></div>`;
}

async function startRealtime() {
  if (realtimeChannel) await sb.removeChannel(realtimeChannel);
  realtimeChannel = sb.channel(`bloxvibe-${me.id}`)
    .on("postgres_changes",{event:"INSERT",schema:"public",table:"messages"},payload=>handleIncomingMessage(payload.new))
    .on("postgres_changes",{event:"INSERT",schema:"public",table:"notifications",filter:`user_id=eq.${me.id}`},payload=>handleNotification(payload.new))
    .on("postgres_changes",{event:"*",schema:"public",table:"post_likes"},()=>loadFeed())
    .on("postgres_changes",{event:"*",schema:"public",table:"post_comments"},()=>loadFeed())
    .subscribe(status=>{
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") showToast("Realtime unavailable","Messages will still be saved, but live updates may be delayed.","error");
    });
}

function handleIncomingMessage(m) {
  if (!m || renderedMessageIds.has(m.id)) return;
  if (m.sender_id !== me.id && m.receiver_id !== me.id) return;
  renderedMessageIds.add(m.id);
  if (activeChatId && ((m.sender_id===me.id&&m.receiver_id===activeChatId)||(m.sender_id===activeChatId&&m.receiver_id===me.id))) {
    $("chatMessages").insertAdjacentHTML("beforeend",renderMessage(m));
    $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
    if (m.sender_id !== me.id) return;
  }
  if (m.receiver_id === me.id && m.sender_id !== activeChatId) {
    const sender = usersCache.find(u=>u.id===m.sender_id);
    setMessageBadge(1);
    showToast(`New message from ${sender?.username||"User"}`,m.body,"success");
    browserNotify(`BloxVibe — ${sender?.username||"User"}`,m.body,()=>{
      document.querySelector('[data-view="messages"]').click();
      openChat(m.sender_id);
    });
  }
}

function handleNotification(n) {
  if (!n || n.user_id !== me.id || n.actor_id === me.id) return;
  if (n.type === "message") {
    // The message handler already displays the richer alert. This hook keeps the DB notification realtime.
    return;
  }
}

async function loadUnreadNotifications() {
  const {data,error} = await sb.from("notifications").select("id,type,actor_id,title,body,created_at").is("read_at",null).order("created_at",{ascending:false}).limit(50);
  if (!error && data?.length) setMessageBadge(data.filter(n=>n.type==="message").length);
}

$("messageForm").onsubmit = async e => {
  e.preventDefault();
  const body = $("messageInput").value.trim();
  if (!body || !activeChatId) return;
  const {error} = await sb.from("messages").insert({sender_id:me.id,receiver_id:activeChatId,body});
  if (error) return showToast("Message failed",error.message,"error");
  $("messageInput").value = "";
};

// ---------- WebRTC audio/video ----------
async function startCallListener() {
  if (callChannel) await sb.removeChannel(callChannel);
  // Public Realtime channel per user. The channel only carries signaling; actual media is peer-to-peer.
  callChannel = sb.channel(`bloxvibe-call-${me.id}`)
    .on("broadcast",{event:"signal"},async ({payload}) => {
      if (!payload || payload.to !== me.id) return;
      try { await handleCallSignal(payload); }
      catch (e) { showToast("Call error",e.message,"error"); }
    })
    .subscribe(status=>{
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") showToast("Calling unavailable","Realtime calling signaling could not connect.","error");
    });
}

async function sendCallSignal(payload) {
  if (!callChannel) await startCallListener();
  return callChannel.send({type:"broadcast",event:"signal",payload});
}

async function createPeerConnection(peerId, mode) {
  rtc = new RTCPeerConnection({iceServers:[{urls:"stun:stun.l.google.com:19302"}]});
  rtc.ontrack = e => { $("remoteVideo").srcObject = e.streams[0]; };
  rtc.onicecandidate = e => { if (e.candidate) sendCallSignal({to:peerId,from:me.id,type:"ice",candidate:e.candidate}); };
  rtc.onconnectionstatechange = () => {
    if (!rtc) return;
    if (rtc.connectionState === "connected") $("callStatus").textContent = mode === "video" ? "Video call connected" : "Audio call connected";
    if (["failed","disconnected"].includes(rtc.connectionState)) $("callStatus").textContent = "Connection problem";
  };
  return rtc;
}

async function getLocalMedia(mode) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Your browser does not support microphone/camera access.");
  if (localStream) localStream.getTracks().forEach(t=>t.stop());
  localStream = await navigator.mediaDevices.getUserMedia({audio:true,video:mode==="video"});
  $("localVideo").srcObject = localStream;
  $("localVideo").style.display = mode === "video" ? "block" : "none";
}

async function startCall(mode) {
  if (!activeChatId) return showToast("Choose a user first","Open a chat before calling.","error");
  if (!window.isSecureContext) return showToast("Calling requires HTTPS","Use your GitHub Pages HTTPS address.","error");
  if (rtc) await hangup(false);
  try {
    currentCallPeer = activeChatId;
    currentCallMode = mode;
    await getLocalMedia(mode);
    await createPeerConnection(activeChatId,mode);
    localStream.getTracks().forEach(t=>rtc.addTrack(t,localStream));
    $("callModal").classList.remove("hidden");
    $("callIncoming").classList.add("hidden");
    $("callTitle").textContent = `Calling ${activeChatProfile?.username||"user"}…`;
    $("callStatus").textContent = mode === "video" ? "Video call — ringing…" : "Audio call — ringing…";
    const offer = await rtc.createOffer();
    await rtc.setLocalDescription(offer);
    await sendCallSignal({to:activeChatId,from:me.id,type:"offer",mode,sdp:rtc.localDescription});
  } catch (e) {
    await hangup(false);
    showToast("Could not start call",e.message,"error");
  }
}

async function handleCallSignal(p) {
  if (p.type === "offer") {
    if (rtc || incomingCall) { await sendCallSignal({to:p.from,from:me.id,type:"busy"}); return; }
    incomingCall = p;
    currentCallPeer = p.from;
    currentCallMode = p.mode === "audio" ? "audio" : "video";
    const caller = usersCache.find(u=>u.id===p.from);
    $("callModal").classList.remove("hidden");
    $("callIncoming").classList.remove("hidden");
    $("callTitle").textContent = `Incoming ${currentCallMode} call`;
    $("callCaller").textContent = caller?.username || "BloxVibe user";
    $("callStatus").textContent = "Waiting for you to answer…";
    browserNotify(`Incoming call from ${caller?.username||"BloxVibe user"}`,`${currentCallMode} call`,()=>$("callModal").classList.remove("hidden"));
    return;
  }
  if (p.type === "answer" && rtc) {
    await rtc.setRemoteDescription(p.sdp);
    for (const c of pendingIce.splice(0)) { try { await rtc.addIceCandidate(c); } catch {} }
    return;
  }
  if (p.type === "ice" && p.candidate) {
    if (rtc?.remoteDescription) { try { await rtc.addIceCandidate(p.candidate); } catch {} }
    else pendingIce.push(p.candidate);
    return;
  }
  if (p.type === "reject") { showToast("Call declined","The other user declined the call.","error"); return hangup(false); }
  if (p.type === "busy") { showToast("User is busy","That user is already on another call.","error"); return hangup(false); }
  if (p.type === "hangup") return hangup(false);
}

$("videoCallBtn").onclick = () => startCall("video");
$("audioCallBtn").onclick = () => startCall("audio");
$("hangup").onclick = () => hangup(true);
$("acceptCall").onclick = acceptIncomingCall;
$("rejectCall").onclick = async () => {
  if (incomingCall) await sendCallSignal({to:incomingCall.from,from:me.id,type:"reject"});
  incomingCall = null;
  await hangup(false);
};

async function acceptIncomingCall() {
  const p = incomingCall;
  if (!p) return;
  incomingCall = null;
  try {
    currentCallPeer = p.from;
    currentCallMode = p.mode === "audio" ? "audio" : "video";
    await getLocalMedia(currentCallMode);
    await createPeerConnection(p.from,currentCallMode);
    localStream.getTracks().forEach(t=>rtc.addTrack(t,localStream));
    $("callIncoming").classList.add("hidden");
    $("callTitle").textContent = `Call with ${usersCache.find(u=>u.id===p.from)?.username||"user"}`;
    $("callStatus").textContent = "Connecting…";
    await rtc.setRemoteDescription(p.sdp);
    for (const c of pendingIce.splice(0)) { try { await rtc.addIceCandidate(c); } catch {} }
    const answer = await rtc.createAnswer();
    await rtc.setLocalDescription(answer);
    await sendCallSignal({to:p.from,from:me.id,type:"answer",sdp:rtc.localDescription});
  } catch (e) {
    await hangup(false);
    showToast("Could not answer call",e.message,"error");
  }
}

async function hangup(notifyPeer=true) {
  const peer = currentCallPeer;
  if (notifyPeer && peer) { try { await sendCallSignal({to:peer,from:me.id,type:"hangup"}); } catch {} }
  if (rtc) rtc.close();
  if (localStream) localStream.getTracks().forEach(t=>t.stop());
  rtc = null; localStream = null; currentCallPeer = null; pendingIce = []; incomingCall = null;
  if ($("remoteVideo")) $("remoteVideo").srcObject = null;
  if ($("localVideo")) $("localVideo").srcObject = null;
  $("callModal").classList.add("hidden");
  if ($("callIncoming")) $("callIncoming").classList.add("hidden");
}

// ---------- Profile ----------
$("saveProfile").onclick = async () => {
  const username = $("editUsername").value.trim();
  const avatar_url = $("editAvatar").value.trim() || null;
  if (username.length < 3 || username.length > 24) return $("settingsMsg").textContent = "Username must be 3–24 characters.";
  const {data,error} = await sb.from("profiles").update({username,avatar_url}).eq("id",me.id).select("*").single();
  if (error) return $("settingsMsg").textContent = error.message;
  profile = data;
  $("settingsMsg").textContent = "Saved!";
  renderMyMiniProfile();
  await loadPeople();
};

async function loadProfile() {
  const {data:p,error} = await sb.from("profiles").select("*").eq("id",me.id).single();
  if (error) return showToast("Profile error",error.message,"error");
  profile = p;
  $("profileCard").innerHTML = `<div class="profile-box"><div class="avatar">${avatarHtml(p)}</div><div><h2>${esc(p.username)}</h2><div class="muted">BloxVibe member</div></div></div>`;
  const {data,error:postError} = await sb.from("posts").select("*,profiles(username,avatar_url)").eq("user_id",me.id).order("created_at",{ascending:false});
  if (postError) return showToast("Profile posts error",postError.message,"error");
  const profilePosts = data || [];
  // Load interaction data for the profile's posts so the same Like/Comment/Share controls work here.
  if (profilePosts.length) {
    const ids = profilePosts.map(p => p.id);
    const [{data:likes},{data:comments}] = await Promise.all([
      sb.from("post_likes").select("post_id,user_id").in("post_id",ids),
      sb.from("post_comments").select("id,post_id,body,user_id,created_at,profiles(username,avatar_url)").in("post_id",ids).order("created_at",{ascending:true})
    ]);
    profilePosts.forEach(p => { p.post_likes=(likes||[]).filter(x=>x.post_id===p.id); p.post_comments=(comments||[]).filter(x=>x.post_id===p.id); });
  }
  $("myPosts").innerHTML = profilePosts.map(renderPost).join("") || `<div class="empty">You haven't posted yet.</div>`;
  bindPostActions($("myPosts"));
}

async function cleanupRealtime() {
  if (realtimeChannel) { await sb.removeChannel(realtimeChannel); realtimeChannel = null; }
  if (callChannel) { await sb.removeChannel(callChannel); callChannel = null; }
}


$("shareModalClose").onclick = () => $("shareModal").classList.add("hidden");
init();

// ============================================================
// BloxVibe 2.0 social expansion
// ============================================================
let followingIds = new Set();
let savedIds = new Set();
let storyCache = [];
let activeStoryIndex = 0;
let pendingReport = null;
let typingChannel = null;
let typingTimer = null;

function parseSocialText(text){
  return esc(text).replace(/(^|\s)(#[a-zA-Z0-9_]{1,50})\b/g,'$1<span class="hashtag">$2</span>').replace(/(^|\s)(@[a-zA-Z0-9_]{3,24})\b/g,'$1<span class="mention">$2</span>');
}

async function loadSocialState(){
  const [{data:f},{data:s}] = await Promise.all([
    sb.from('follows').select('following_id').eq('follower_id',me.id),
    sb.from('saved_posts').select('post_id').eq('user_id',me.id)
  ]);
  followingIds = new Set((f||[]).map(x=>x.following_id));
  savedIds = new Set((s||[]).map(x=>x.post_id));
}

async function loadStories(){
  const {data,error}=await sb.from('stories').select('*,profiles(username,avatar_url)').gt('expires_at',new Date().toISOString()).order('created_at',{ascending:true}).limit(100);
  if(error) return;
  storyCache=data||[];
  const grouped=[]; const seen=new Set();
  storyCache.forEach(s=>{if(!seen.has(s.user_id)){seen.add(s.user_id);grouped.push(s);}});
  $('stories').innerHTML=grouped.map(s=>`<button class="story-chip" data-story-user="${s.user_id}"><span class="story-ring">${s.media_type==='video'?'<video muted src="'+esc(s.media_url)+'"></video>':'<img src="'+esc(s.media_url)+'" alt="">'}</span><small>${esc(s.profiles?.username||'User')}</small></button>`).join('');
  document.querySelectorAll('[data-story-user]').forEach(b=>b.onclick=()=>openStoryUser(b.dataset.storyUser));
}

$('addStoryBtn').onclick=()=>{$('storyModal').classList.remove('hidden');};
$('storyMedia').onchange=()=>{const f=$('storyMedia').files[0]; if(!f)return; const url=URL.createObjectURL(f); $('storyPreview').innerHTML=f.type.startsWith('video/')?`<video src="${url}" controls></video>`:`<img src="${url}" alt="preview">`; $('storyPreview').classList.remove('hidden');};
$('publishStoryBtn').onclick=async()=>{
  const f=$('storyMedia').files[0]; if(!f)return showToast('Choose media','Select an image or short video.','error');
  if(f.size>8*1024*1024)return showToast('Story too large','Maximum 8 MB.','error');
  if(!/^image\/(jpeg|png|webp|gif)$/.test(f.type) && !/^video\/(mp4|webm)$/.test(f.type))return showToast('Unsupported media','Use JPG, PNG, WebP, GIF, MP4 or WebM.','error');
  try{$('publishStoryBtn').disabled=true; const ext=f.name.split('.').pop().toLowerCase(); const path=`${me.id}/${crypto.randomUUID()}.${ext}`; const up=await sb.storage.from('stories').upload(path,f,{contentType:f.type,upsert:false}); if(up.error)throw up.error; const url=sb.storage.from('stories').getPublicUrl(path).data.publicUrl; const {error}=await sb.from('stories').insert({user_id:me.id,media_url:url,media_type:f.type.startsWith('video/')?'video':'image',caption:$('storyCaption').value.trim()||null}); if(error)throw error; $('storyModal').classList.add('hidden'); $('storyMedia').value=''; $('storyCaption').value=''; $('storyPreview').classList.add('hidden'); await loadStories(); showToast('Story shared','It will disappear after 24 hours.','success');}catch(e){showToast('Story failed',e.message,'error')}finally{$('publishStoryBtn').disabled=false;}
};

async function openStoryUser(userId){
  const arr=storyCache.filter(s=>s.user_id===userId); if(!arr.length)return; activeStoryIndex=0; window.currentStoryList=arr; await renderCurrentStory(); $('storyViewer').classList.remove('hidden');
}
async function renderCurrentStory(){
  const s=window.currentStoryList?.[activeStoryIndex]; if(!s)return; await sb.from('story_views').upsert({story_id:s.id,user_id:me.id},{onConflict:'story_id,user_id'}); $('storyViewerContent').innerHTML=`<div class="story-content">${s.media_type==='video'?`<video src="${esc(s.media_url)}" controls autoplay></video>`:`<img src="${esc(s.media_url)}" alt="Story">`}<div class="story-meta"><b>${esc(s.profiles?.username||'User')}</b>${s.caption?`<div>${parseSocialText(s.caption)}</div>`:''}<small>${timeAgo(s.created_at)}</small></div></div>`;
}
$('storyPrev').onclick=async()=>{if(!window.currentStoryList)return;activeStoryIndex=(activeStoryIndex-1+window.currentStoryList.length)%window.currentStoryList.length;await renderCurrentStory()};
$('storyNext').onclick=async()=>{if(!window.currentStoryList)return;activeStoryIndex=(activeStoryIndex+1)%window.currentStoryList.length;await renderCurrentStory()};

async function toggleFollow(userId,btn){
  if(userId===me.id)return;
  try{if(followingIds.has(userId)){const {error}=await sb.from('follows').delete().eq('follower_id',me.id).eq('following_id',userId);if(error)throw error;followingIds.delete(userId)}else{const {error}=await sb.from('follows').insert({follower_id:me.id,following_id:userId});if(error)throw error;followingIds.add(userId)} if(btn){btn.textContent=followingIds.has(userId)?'Following':'Follow';btn.classList.toggle('following',followingIds.has(userId));} await loadFollowingFeed();}catch(e){showToast('Follow failed',e.message,'error')}
}

async function loadFollowingFeed(){
  if(!followingIds.size){$('followingFeed').innerHTML='<div class="empty">Follow people to build your Following feed.</div>';return}
  const ids=[...followingIds]; const {data,error}=await sb.from('posts').select('*,profiles(username,avatar_url),post_likes(user_id),post_comments(id,body,user_id,created_at,profiles(username,avatar_url))').in('user_id',ids).order('created_at',{ascending:false}).limit(80); if(error)return showToast('Following error',error.message,'error'); $('followingFeed').innerHTML=(data||[]).map(renderPost).join('')||'<div class="empty">No posts from people you follow yet.</div>';bindPostActions($('followingFeed'));
}

async function loadSavedFeed(){
  if(!savedIds.size){$('savedFeed').innerHTML='<div class="empty">No saved posts yet.</div>';return}
  const {data,error}=await sb.from('posts').select('*,profiles(username,avatar_url),post_likes(user_id),post_comments(id,body,user_id,created_at,profiles(username,avatar_url))').in('id',[...savedIds]).order('created_at',{ascending:false}); if(error)return showToast('Saved error',error.message,'error'); $('savedFeed').innerHTML=(data||[]).map(renderPost).join('')||'<div class="empty">No saved posts yet.</div>';bindPostActions($('savedFeed'));
}

async function toggleSave(postId){try{if(savedIds.has(postId)){const {error}=await sb.from('saved_posts').delete().eq('user_id',me.id).eq('post_id',postId);if(error)throw error;savedIds.delete(postId)}else{const {error}=await sb.from('saved_posts').insert({user_id:me.id,post_id:postId});if(error)throw error;savedIds.add(postId)}await loadFeed();}catch(e){showToast('Save failed',e.message,'error')}}

async function exploreSearch(){const q=$('globalSearch').value.trim(); if(!q)return; const tag=q.replace(/^#/,'').toLowerCase(); const [{data:users},{data:posts}] = await Promise.all([sb.from('profiles').select('*').ilike('username',`%${q.replace(/^@/,'')}%`).limit(30), sb.from('posts').select('*,profiles(username,avatar_url),post_likes(user_id),post_comments(id,body,user_id,created_at,profiles(username,avatar_url))').ilike('content',`%${q}%`).order('created_at',{ascending:false}).limit(50)]); let tagPosts=[]; if(q.startsWith('#')){const {data:tp}=await sb.from('post_hashtags').select('post_id').eq('tag',tag).limit(50); if(tp?.length){const {data:p}=await sb.from('posts').select('*,profiles(username,avatar_url),post_likes(user_id),post_comments(id,body,user_id,created_at,profiles(username,avatar_url))').in('id',tp.map(x=>x.post_id)).order('created_at',{ascending:false});tagPosts=p||[]}} const merged=[...(posts||[]),...tagPosts].filter((p,i,a)=>a.findIndex(x=>x.id===p.id)===i); $('exploreResults').innerHTML=`<div class="explore-users">${(users||[]).map(u=>`<div class="person explore-user"><div class="avatar">${avatarHtml(u)}</div><div><b>${esc(u.username)}</b><button class="follow-btn ${followingIds.has(u.id)?'following':''}" data-follow="${u.id}">${followingIds.has(u.id)?'Following':'Follow'}</button></div></div>`).join('')}</div>${merged.map(renderPost).join('')||'<div class="empty">No results found.</div>'}`; bindPostActions($('exploreResults')); document.querySelectorAll('[data-follow]').forEach(b=>b.onclick=()=>toggleFollow(b.dataset.follow,b));}
$('exploreSearchBtn').onclick=exploreSearch;$('globalSearch').onkeydown=e=>{if(e.key==='Enter')exploreSearch()};

// Enhanced post renderer with save/menu and hashtags.
const originalRenderPost=renderPost;
renderPost=function(p){const liked=(p.post_likes||[]).some(x=>x.user_id===me?.id);const comments=p.post_comments||[];const owner=p.user_id===me?.id;return `<article class="post" data-post-id="${p.id}"><div class="post-head"><div class="avatar">${avatarHtml(p.profiles)}</div><div><b>${esc(p.profiles?.username||'User')}</b><div class="post-time">${timeAgo(p.created_at)}</div></div><div class="post-menu"><button data-menu="${p.id}">•••</button><div class="post-menu-panel hidden" data-menu-panel="${p.id}"><button data-save="${p.id}">${savedIds.has(p.id)?'🔖 Remove save':'🔖 Save'}</button>${owner?'<button data-delete-post="'+p.id+'">🗑 Delete</button>':'<button data-report="'+p.id+'">🚩 Report</button><button data-block="'+p.user_id+'">🚫 Block user</button>'}</div></div></div>${p.content?`<div class="post-body">${parseSocialText(p.content)}</div>`:''}${p.image_url?(p.media_type==='video'?`<video class="post-img" src="${esc(p.image_url)}" controls playsinline preload="metadata"></video>`:`<img class="post-img" src="${esc(p.image_url)}" alt="Post image" loading="lazy">`):''}<div class="post-actions"><button class="post-action ${liked?'liked':''}" data-like="${p.id}">♥ <span>${(p.post_likes||[]).length}</span></button><button class="post-action" data-comments="${p.id}">💬 <span>${comments.length}</span></button><button class="post-action" data-share="${p.id}">↗ Share</button><button class="post-action save-action" data-save="${p.id}">${savedIds.has(p.id)?'🔖':'♡'}</button></div><div class="comments" data-comments-box="${p.id}"><div class="comment-list">${comments.slice(-10).map(c=>`<div class="comment"><div class="avatar mini">${avatarHtml(c.profiles)}</div><div><b>${esc(c.profiles?.username||'User')}</b><span>${parseSocialText(c.body)}</span><small>${timeAgo(c.created_at)} ${c.user_id===me?.id?`<button class="link-btn" data-delete-comment="${c.id}">Delete</button>`:''}</small></div></div>`).join('')}</div><form class="comment-form" data-comment-form="${p.id}"><input maxlength="500" placeholder="Add a comment…"><button class="ghost">Comment</button></form></div></article>`}

// Rebind post actions with menus/save/delete/report/block.
const enhancedBind=bindPostActions;
bindPostActions=function(container){enhancedBind(container);container.querySelectorAll('[data-menu]').forEach(b=>b.onclick=e=>{e.stopPropagation();const p=container.querySelector(`[data-menu-panel="${b.dataset.menu}"]`);if(p)p.classList.toggle('hidden')});container.querySelectorAll('[data-save]').forEach(b=>b.onclick=()=>toggleSave(b.dataset.save));container.querySelectorAll('[data-delete-post]').forEach(b=>b.onclick=()=>deletePost(b.dataset.deletePost));container.querySelectorAll('[data-delete-comment]').forEach(b=>b.onclick=()=>deleteComment(b.dataset.deleteComment));container.querySelectorAll('[data-report]').forEach(b=>b.onclick=()=>{pendingReport={postId:b.dataset.report};$('reportModal').classList.remove('hidden')});container.querySelectorAll('[data-block]').forEach(b=>b.onclick=()=>blockUser(b.dataset.block));}

async function deletePost(id){if(!confirm('Delete this post?'))return;const {error}=await sb.from('posts').delete().eq('id',id).eq('user_id',me.id);if(error)return showToast('Delete failed',error.message,'error');await loadFeed();showToast('Post deleted','Your post was removed.','success')}
async function deleteComment(id){if(!confirm('Delete this comment?'))return;const {error}=await sb.from('post_comments').delete().eq('id',id).eq('user_id',me.id);if(error)return showToast('Delete failed',error.message,'error');await loadFeed()}
async function blockUser(id){if(!confirm('Block this user? Their posts will be hidden from your feed.'))return;const {error}=await sb.from('blocks').insert({blocker_id:me.id,blocked_id:id});if(error)return showToast('Block failed',error.message,'error');await loadFeed();await loadPeople();showToast('User blocked','You will no longer see their content.','success')}
$('submitReportBtn').onclick=async()=>{if(!pendingReport)return;const reason=$('reportReason').value;const {error}=await sb.from('reports').insert({reporter_id:me.id,post_id:pendingReport.postId,reason});if(error)return showToast('Report failed',error.message,'error');$('reportModal').classList.add('hidden');pendingReport=null;showToast('Report sent','Thanks for helping keep BloxVibe safe.','success')};

async function loadActivity(){const {data,error}=await sb.from('notifications').select('*,profiles:actor_id(username,avatar_url)').eq('user_id',me.id).order('created_at',{ascending:false}).limit(100);if(error)return showToast('Activity error',error.message,'error');$('activityList').innerHTML=(data||[]).map(n=>`<div class="activity-item"><div class="avatar">${avatarHtml(n.profiles)}</div><div><b>${esc(n.title||'Activity')}</b><div>${esc(n.body||'')}</div><small>${timeAgo(n.created_at)}</small></div></div>`).join('')||'<div class="empty">No activity yet.</div>';}

async function showUserProfile(id){const {data:p,error}=await sb.from('profiles').select('*').eq('id',id).single();if(error)return;const [{data:posts},{count:followers},{count:following}] = await Promise.all([sb.from('posts').select('*,profiles(username,avatar_url),post_likes(user_id),post_comments(id,body,user_id,created_at,profiles(username,avatar_url))').eq('user_id',id).order('created_at',{ascending:false}),sb.from('follows',{count:'exact',head:true}).eq('following_id',id),sb.from('follows',{count:'exact',head:true}).eq('follower_id',id)]);$('profileCard').innerHTML=`<div class="profile-box"><div class="avatar">${avatarHtml(p)}</div><div><h2>${esc(p.username)}</h2><div class="muted">${esc(p.bio||'BloxVibe member')}</div><div class="profile-stats"><div><b>${posts?.length||0}</b>posts</div><div><b>${followers||0}</b>followers</div><div><b>${following||0}</b>following</div></div><div class="profile-actions"><button class="primary follow-btn ${followingIds.has(id)?'following':''}" data-profile-follow="${id}">${followingIds.has(id)?'Following':'Follow'}</button></div></div></div>`;$('myPosts').innerHTML=(posts||[]).map(renderPost).join('')||'<div class="empty">No posts yet.</div>';bindPostActions($('myPosts'));document.querySelector('[data-profile-follow]')?.addEventListener('click',e=>toggleFollow(id,e.currentTarget));}

// Online presence + last seen.
async function setPresence(online){if(!me)return;await sb.from('profiles').update({is_online:online,last_seen_at:new Date().toISOString()}).eq('id',me.id)}
setInterval(()=>{if(me)setPresence(true)},60000);window.addEventListener('beforeunload',()=>{if(me)setPresence(false)});

// Read receipts + typing broadcast.
async function setupTyping(){if(typingChannel)await sb.removeChannel(typingChannel);if(!activeChatId)return;typingChannel=sb.channel(`bloxvibe-chat-${[me.id,activeChatId].sort().join('-')}`);typingChannel.on('broadcast',{event:'typing'},({payload})=>{if(payload?.from===activeChatId){$('typingIndicator').textContent=payload.typing?'Typing…':'';clearTimeout(typingTimer);if(payload.typing)typingTimer=setTimeout(()=>$('typingIndicator').textContent='',1600)}}).subscribe();}
$('messageInput').addEventListener('input',()=>{if(!typingChannel)return;typingChannel.send({type:'broadcast',event:'typing',payload:{from:me.id,typing:true}});clearTimeout(typingTimer);typingTimer=setTimeout(()=>typingChannel?.send({type:'broadcast',event:'typing',payload:{from:me.id,typing:false}}),1000)});

// Replace openChat to also mark messages read and start typing channel.
const oldOpenChat=openChat;
openChat=async function(id){await oldOpenChat(id);await sb.from('messages').update({read_at:new Date().toISOString()}).eq('sender_id',id).eq('receiver_id',me.id).is('read_at',null);await setupTyping();};

// Replace message rendering with delete/read indicators.
const oldRenderMessage=renderMessage;
renderMessage=function(m){if(m.is_deleted)return `<div class="bubble ${m.sender_id===me.id?'mine':''}"><i>Message deleted</i></div>`;const shared=m.posts?`<div class="shared-post-message"><div class="shared-label">↗ Shared post</div>${renderPostPreview(m.posts)}</div>`:'';return `<div class="bubble ${m.sender_id===me.id?'mine':''}" data-message-id="${m.id}">${shared}<div>${esc(m.body)}</div><small>${new Date(m.created_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})} ${m.sender_id===me.id?`<span class="read-receipt">${m.read_at?'✓✓ Read':'✓ Sent'}</span>`:''}${m.sender_id===me.id?` <button class="link-btn" data-delete-message="${m.id}">Delete</button>`:''}</small></div>`}

async function deleteMessage(id){const {error}=await sb.from('messages').update({is_deleted:true,body:'Message deleted'}).eq('id',id).eq('sender_id',me.id);if(error)return showToast('Delete failed',error.message,'error');await loadMessages()}
document.addEventListener('click',e=>{const b=e.target.closest('[data-delete-message]');if(b)deleteMessage(b.dataset.deleteMessage)});

// Better navigation for the expanded app. The original handlers remain harmless; this layer loads new views.
document.querySelectorAll('.nav[data-view]').forEach(n=>n.addEventListener('click',async()=>{const v=n.dataset.view;const titles={feed:['Home','See what the BloxVibe community is posting.'],following:['Following','Posts from people you follow.'],explore:['Explore','Discover people, posts and hashtags.'],messages:['Messages','Chat with the community.'],notifications:['Activity','Likes, comments, follows and messages.'],saved:['Saved','Your saved posts.'],profile:['Profile','Your BloxVibe profile.'],settings:['Settings','Account and privacy.']};if(titles[v]){$('pageTitle').textContent=titles[v][0];$('pageSubtitle').textContent=titles[v][1];}if(v==='following')await loadFollowingFeed();if(v==='saved')await loadSavedFeed();if(v==='explore'){$('globalSearch').focus()}if(v==='notifications')await loadActivity();if(v==='profile')await loadProfile();}));
$('mobileNewPost').onclick=()=>$('postModal').classList.remove('hidden');
$('exportDataBtn').onclick=()=>{const blob=new Blob([JSON.stringify({profile,username:profile?.username,created_at:profile?.created_at},null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='bloxvibe-profile.json';a.click();URL.revokeObjectURL(a.href)};
$('deleteAccountInfoBtn').onclick=()=>showToast('Account deletion','For secure account deletion, contact the BloxVibe administrator.','info');

// Upgrade feed loader to exclude blocked users and prepare state.
const baseLoadFeed=loadFeed;
loadFeed=async function(){await loadSocialState();await baseLoadFeed();await loadStories();};

// Parse hashtags/mentions into normalized tables after posting.
async function indexPostSocial(postId,text){const tags=[...String(text||'').matchAll(/#([a-zA-Z0-9_]{1,50})/g)].map(m=>m[1].toLowerCase());const unique=[...new Set(tags)];if(unique.length)await sb.from('post_hashtags').insert(unique.map(tag=>({post_id:postId,tag})));const mentions=[...String(text||'').matchAll(/@([a-zA-Z0-9_]{3,24})/g)].map(m=>m[1].toLowerCase());for(const u of [...new Set(mentions)]){const {data:p}=await sb.from('profiles').select('id').ilike('username',u).maybeSingle();if(p)await sb.from('post_mentions').insert({post_id:postId,user_id:p.id});}}

// Multi-media/video post support. First media remains the feed cover; all files are also stored in post_media.
createPost=async function(text,fileList){if(postingInProgress)return;text=(text||'').trim();const files=fileList instanceof FileList ? Array.from(fileList) : (fileList instanceof File ? [fileList] : Array.from(fileList||[]));if(!text&&files.length===0)return showToast('Nothing to post','Add text or media.','error');if(text.length>500)return showToast('Caption too long','Captions can be up to 500 characters.','error');if(files.length>10)return showToast('Too many files','You can attach up to 10 media items.','error');try{postingInProgress=true;document.querySelectorAll('#postBtn,#modalPostBtn').forEach(b=>{b.disabled=true;b.textContent='Posting…'});for(const f of files){if(f.size>8*1024*1024)throw new Error(`${f.name} is larger than 8 MB.`);if(!ALLOWED_IMAGE_TYPES.has(f.type)&&!['video/mp4','video/webm'].includes(f.type))throw new Error('Use JPG, PNG, WebP, GIF, MP4 or WebM.');}const uploaded=[];for(const f of files){const ext=f.name.split('.').pop().toLowerCase();const path=`${me.id}/${crypto.randomUUID()}.${ext}`;const bucket='posts';const up=await sb.storage.from(bucket).upload(path,f,{upsert:false,contentType:f.type,cacheControl:'3600'});if(up.error)throw up.error;uploaded.push({url:sb.storage.from(bucket).getPublicUrl(path).data.publicUrl,type:f.type.startsWith('video/')?'video':'image'});}const cover=uploaded[0];const {data:post,error}=await sb.from('posts').insert({user_id:me.id,content:text||null,image_url:cover?.url||null,media_type:cover?.type||'text'}).select().single();if(error)throw error;if(post&&uploaded.length){await sb.from('post_media').insert(uploaded.map((m,i)=>({post_id:post.id,media_url:m.url,media_type:m.type,sort_order:i})));}await indexPostSocial(post.id,text);resetPostComposer();$('postModal').classList.add('hidden');await loadFeed();showToast('Posted','Your post is live.','success')}catch(e){showToast('Post failed',e.message,'error')}finally{postingInProgress=false;document.querySelectorAll('#postBtn,#modalPostBtn').forEach(b=>{b.disabled=false;b.textContent=b.id==='modalPostBtn'?'Publish':'Post'})}};

// File inputs now accept multiple media; existing onclick handlers pass FileList.
['postImage','modalImage'].forEach(id=>$(id).setAttribute('multiple','multiple'));
['postImage','modalImage'].forEach(id=>$(id).setAttribute('accept','image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm'));

// Boot upgrades after original init has started.
sb.auth.getSession().then(({data})=>{if(data.session){setPresence(true);loadSocialState().then(()=>{loadStories();loadFollowingFeed();})}});
