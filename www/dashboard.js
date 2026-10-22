import { auth, app } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, deleteDoc, addDoc, collection,
  query, where, getDocs, onSnapshot, serverTimestamp, orderBy, limit,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const db = getFirestore(app);
const $ = (id) => document.getElementById(id);

let me = null;             // { uid, name }
let circle = null;         // { id, name, code, ownerId }
let unsubMembers = null;
let unsubLocs = null;
let unsubChat = null;
let chatStick = true;

// map + location state
let map = null;
const markers = new Map();   // uid -> Leaflet marker
let locs = new Map();        // uid -> { name, lat, lng, accuracy, updatedAt }
let people = [];             // current members
let didFit = false;

// ---------- location sharing state ----------
const LOCATION_INTERVAL_MS = 10000;   // auto-refresh every 10 seconds
let watchId = null;
let sharing = false;
let lastPos = null;                    // latest GPS fix from watchPosition
let locationTimer = null;
let locationBusy = false;
let wakeLock = null;

// ---------- screens ----------
function show(which) {
  $("loading").classList.toggle("hidden", which !== "loading");
  $("gate").classList.toggle("hidden", which !== "gate");
  $("circle-view").classList.toggle("hidden", which !== "circle");
  $("circle-chip").classList.toggle("hidden", which !== "circle");
  $("leave").classList.toggle("hidden", which !== "circle");
}

function friendlyError(err) {
  if (err.code === "permission-denied") {
    return "Not allowed. Check that the latest Firestore rules are published.";
  }
  if (err.code === "unavailable") return "No internet connection.";
  return "Something went wrong. (" + (err.code || err.message) + ")";
}

function showFatal(err) {
  console.error(err);
  show("loading");
  $("loading").textContent = friendlyError(err);
}

// ---------- Toast & Status Indicator Helpers ----------
let toastTimer = null;
function showToast(message, isError = false) {
  const toast = $("toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 4000);
}

function setStatus(text, type = "default") {
  const statusEl = $("map-status");
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.classList.remove("active", "refreshing", "error");
  if (type === "active") statusEl.classList.add("active");
  else if (type === "refreshing") statusEl.classList.add("refreshing");
  else if (type === "error") statusEl.classList.add("error");
}

// ---------- start ----------
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.replace("index.html");
    return;
  }
  me = { uid: user.uid, name: user.displayName || user.email.split("@")[0] };
  $("user-name").textContent = me.name;

  try {
    const snap = await getDoc(doc(db, "users", me.uid));
    const circleId = snap.exists() ? snap.data().circleId : null;
    if (circleId) await openCircle(circleId);
    else show("gate");
  } catch (err) {
    showFatal(err);
  }
});

$("logout").addEventListener("click", async () => {
  teardownVoice();
  await stopSharing();
  signOut(auth);
});

// ---------- helpers ----------
function avatarColor(name) {
  const h = [...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 0);
  return "hsl(" + (Math.abs(h) % 360) + " 45% 36%)";
}

function timeAgo(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return Math.round(s / 60) + " min ago";
  if (s < 86400) return Math.round(s / 3600) + " hr ago";
  return Math.round(s / 86400) + " d ago";
}

function randomId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ---------- circle: open ----------
async function openCircle(circleId) {
  const snap = await getDoc(doc(db, "circles", circleId));
  if (!snap.exists()) {
    await setDoc(doc(db, "users", me.uid), { circleId: null }, { merge: true });
    show("gate");
    return;
  }
  circle = { id: snap.id, ...snap.data() };
  $("circle-name").textContent = circle.name;
  $("circle-code").textContent = circle.code;
  show("circle");
  initMap();

  if (unsubMembers) unsubMembers();
  unsubMembers = onSnapshot(
    collection(db, "circles", circle.id, "members"),
    (s) => {
      people = s.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.name.localeCompare(b.name));
      renderMembers();
      syncPeers(); // keep voice connections in sync with the member list
    },
    (err) => showFatal(err)
  );

  if (unsubLocs) unsubLocs();
  locs = new Map();
  didFit = false;
  unsubLocs = onSnapshot(
    collection(db, "circles", circle.id, "locations"),
    (s) => {
      locs = new Map(s.docs.map((d) => [d.id, d.data()]));
      drawPins();
      renderMembers();
    },
    (err) => {
      setStatus(friendlyError(err), "error");
      showToast(friendlyError(err), true);
    }
  );

  subscribeChat();
  setupVoice();

  // Auto-resume sharing if the user had it on before (e.g. after a page reload)
  if (getSharePref() && !sharing) startSharing();
}

// ---------- chat ----------
function subscribeChat() {
  if (unsubChat) unsubChat();
  $("chat-list").replaceChildren();
  $("chat-empty").classList.remove("hidden");
  $("chat-error").textContent = "";
  chatStick = true;

  const q = query(
    collection(db, "circles", circle.id, "messages"),
    orderBy("createdAt", "desc"),
    limit(100)
  );
  unsubChat = onSnapshot(
    q,
    (s) => {
      const msgs = s.docs
        .map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }))
        .reverse();
      renderChat(msgs);
    },
    (err) => {
      const errText = friendlyError(err);
      $("chat-error").textContent = errText;
      showToast(errText, true);
    }
  );
}

function renderChat(msgs) {
  const log = $("chat-log");
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const list = $("chat-list");
  list.replaceChildren();
  $("chat-empty").classList.toggle("hidden", msgs.length > 0);

  let prevUid = null;
  for (const m of msgs) {
    const mine = m.uid === me.uid;
    const li = document.createElement("li");
    li.className = "msg" + (mine ? " msg--me" : "");

    if (!mine && m.uid !== prevUid) {
      const who = document.createElement("span");
      who.className = "msg__name";
      who.textContent = m.name;
      li.append(who);
    }

    const bubble = document.createElement("div");
    bubble.className = "msg__bubble";
    bubble.textContent = m.text;
    li.append(bubble);

    if (m.createdAt) {
      const time = document.createElement("span");
      time.className = "msg__time";
      time.textContent = m.createdAt.toDate().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      li.append(time);
    }

    list.append(li);
    prevUid = m.uid;
  }

  if (chatStick || nearBottom) log.scrollTop = log.scrollHeight;
  chatStick = false;
}

$("chat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("chat-input").value.trim();
  if (!text || !circle) return;
  $("chat-input").value = "";
  $("chat-error").textContent = "";
  chatStick = true;
  try {
    await addDoc(collection(db, "circles", circle.id, "messages"), {
      uid: me.uid,
      name: me.name,
      text: text.slice(0, 500),
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    $("chat-input").value = text;
    const errText = friendlyError(err);
    $("chat-error").textContent = errText;
    showToast(errText, true);
  }
});

// =====================================================================
//  WALKIE-TALKIE (persistent mesh, full-duplex, many speakers at once)
// =====================================================================
const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
  iceCandidatePoolSize: 2,
};

const peers = new Map();         // uid -> entry
const remoteTalkers = new Map(); // uid -> name of people currently talking
let unsubVoiceSignal = null;
let signalQueue = Promise.resolve();
let healthTimer = null;

let micTrack = null;
let micPromise = null;
let pttHeld = false;
let talking = false;

function signalsCol() {
  return collection(db, "circles", circle.id, "signals");
}

async function sendSignal(targetUid, type, session, payload = {}) {
  if (!circle) return;
  try {
    await addDoc(signalsCol(), {
      senderUid: me.uid,
      senderName: me.name,
      targetUid,
      type,
      session,
      ...payload,
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    console.warn("signal failed", err);
  }
}

function setPttStatus(text) {
  if ($("ptt-status")) $("ptt-status").textContent = text;
}

function connectedCount() {
  let n = 0;
  for (const e of peers.values()) if (e.pc && e.pc.connectionState === "connected") n++;
  return n;
}

function updateVoiceUI() {
  const btn = $("ptt");
  if (btn) {
    btn.classList.toggle("is-live", talking);
    btn.classList.toggle("is-hearing", remoteTalkers.size > 0);
    btn.textContent = talking ? "Live Talking…" : "Hold to talk";
  }
  if (talking) {
    setPttStatus("Transmitting live to " + connectedCount() + " connected.");
  } else if (remoteTalkers.size > 0) {
    setPttStatus([...remoteTalkers.values()].join(", ") + (remoteTalkers.size > 1 ? " are talking…" : " is talking…"));
  } else {
    const others = peers.size;
    setPttStatus(
      others === 0
        ? "No other members yet."
        : "Hold the button and speak. (" + connectedCount() + "/" + others + " connected)"
    );
  }
}

async function ensureMic() {
  if (micTrack && micTrack.readyState === "live") return micTrack;
  if (micPromise) return micPromise;

  micPromise = (async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    const track = stream.getAudioTracks()[0];
    track.enabled = false;
    track.addEventListener("ended", () => {
      if (micTrack === track) micTrack = null;
    });
    micTrack = track;
    for (const e of peers.values()) {
      if (e.sender) e.sender.replaceTrack(track).catch(() => {});
    }
    return track;
  })();

  try {
    return await micPromise;
  } finally {
    micPromise = null;
  }
}

function broadcastTalking(state) {
  const msg = JSON.stringify({ talking: state });
  for (const e of peers.values()) {
    if (e.dc && e.dc.readyState === "open") {
      try { e.dc.send(msg); } catch { /* ignore */ }
    }
  }
}

async function startTalking() {
  if (talking || pttHeld) return;
  pttHeld = true;
  try {
    const track = await ensureMic();
    if (!pttHeld) return;
    track.enabled = true;
    talking = true;
    broadcastTalking(true);
    updateVoiceUI();
  } catch (err) {
    pttHeld = false;
    console.error("Mic error:", err);
    setPttStatus("Microphone access failed. Check permissions.");
    showToast("Microphone access failed.", true);
  }
}

function stopTalking() {
  pttHeld = false;
  if (!talking) return;
  talking = false;
  if (micTrack) micTrack.enabled = false;
  broadcastTalking(false);
  updateVoiceUI();
}

function getEntry(uid, name) {
  let e = peers.get(uid);
  if (!e) {
    const audio = new Audio();
    audio.autoplay = true;
    audio.id = "audio-" + uid;
    audio.setAttribute("playsinline", "");
    document.body.appendChild(audio);
    e = {
      uid,
      name: name || "Member",
      initiator: me.uid < uid,
      pc: null,
      dc: null,
      sender: null,
      session: null,
      startedAt: 0,
      pendingIce: [],
      audio,
    };
    peers.set(uid, e);
  } else if (name) {
    e.name = name;
  }
  return e;
}

function closePc(e) {
  if (e.dc) { try { e.dc.close(); } catch { /* ignore */ } }
  if (e.pc) {
    e.pc.onicecandidate = e.pc.ontrack = e.pc.onconnectionstatechange = null;
    try { e.pc.close(); } catch { /* ignore */ }
  }
  e.pc = null;
  e.dc = null;
  e.sender = null;
  e.session = null;
  e.audio.srcObject = null;
  remoteTalkers.delete(e.uid);
}

function removePeer(uid) {
  const e = peers.get(uid);
  if (!e) return;
  closePc(e);
  e.audio.remove();
  peers.delete(uid);
}

function createPc(e, session) {
  closePc(e);
  const pc = new RTCPeerConnection(rtcConfig);
  e.pc = pc;
  e.session = session;
  e.startedAt = Date.now();

  const dc = pc.createDataChannel("ptt", { negotiated: true, id: 0 });
  e.dc = dc;
  dc.onopen = () => { if (talking) broadcastTalking(true); };
  dc.onmessage = (ev) => {
    try {
      const { talking: t } = JSON.parse(ev.data);
      if (t) remoteTalkers.set(e.uid, e.name);
      else remoteTalkers.delete(e.uid);
      updateVoiceUI();
    } catch { /* ignore */ }
  };

  pc.onicecandidate = (ev) => {
    if (ev.candidate) sendSignal(e.uid, "candidate", session, { candidate: ev.candidate.toJSON() });
  };

  pc.ontrack = (ev) => {
    e.audio.srcObject = ev.streams[0] || new MediaStream([ev.track]);
    e.audio.play().catch(() => {});
  };

  pc.onconnectionstatechange = () => {
    if (pc !== e.pc) return;
    if (pc.connectionState === "failed" || pc.connectionState === "closed") {
      remoteTalkers.delete(e.uid);
    }
    updateVoiceUI();
  };

  return pc;
}

async function startOffer(e) {
  if (!circle || !e.initiator) return;
  const session = randomId();
  const pc = createPc(e, session);
  const tx = pc.addTransceiver("audio", { direction: "sendrecv" });
  e.sender = tx.sender;
  if (micTrack) tx.sender.replaceTrack(micTrack).catch(() => {});

  try {
    const offer = await pc.createOffer();
    if (e.pc !== pc) return;
    await pc.setLocalDescription(offer);
    await sendSignal(e.uid, "offer", session, { sdp: { type: offer.type, sdp: offer.sdp } });
  } catch (err) {
    console.warn("offer failed", err);
  }
}

async function handleOffer(e, data) {
  const pc = createPc(e, data.session);
  try {
    await pc.setRemoteDescription(data.sdp);
    const tx = pc.getTransceivers().find((t) => t.receiver.track && t.receiver.track.kind === "audio");
    if (tx) {
      tx.direction = "sendrecv";
      e.sender = tx.sender;
      if (micTrack) tx.sender.replaceTrack(micTrack).catch(() => {});
    }
    await flushIce(e);
    const answer = await pc.createAnswer();
    if (e.pc !== pc) return;
    await pc.setLocalDescription(answer);
    await sendSignal(e.uid, "answer", data.session, { sdp: { type: answer.type, sdp: answer.sdp } });
  } catch (err) {
    console.warn("answer failed", err);
  }
}

async function handleAnswer(e, data) {
  const pc = e.pc;
  if (!pc || data.session !== e.session || pc.signalingState !== "have-local-offer") return;
  try {
    await pc.setRemoteDescription(data.sdp);
    await flushIce(e);
  } catch (err) {
    console.warn("set answer failed", err);
  }
}

async function handleCandidate(e, data) {
  e.pendingIce.push({ session: data.session, candidate: data.candidate });
  await flushIce(e);
}

async function flushIce(e) {
  const pc = e.pc;
  if (!pc || !pc.remoteDescription) return;
  const keep = [];
  for (const item of e.pendingIce) {
    if (item.session === e.session) {
      try { await pc.addIceCandidate(item.candidate); } catch { /* ignore */ }
    } else if (!e.session) {
      keep.push(item);
    }
  }
  e.pendingIce = keep;
}

function connectPeer(e) {
  if (e.initiator) {
    startOffer(e);
  } else {
    sendSignal(e.uid, "hello", null);
  }
}

function syncPeers() {
  if (!circle) return;
  const ids = new Set();
  for (const p of people) {
    if (p.id === me.uid) continue;
    ids.add(p.id);
    const isNew = !peers.has(p.id);
    const e = getEntry(p.id, p.name);
    if (isNew) connectPeer(e);
  }
  for (const uid of [...peers.keys()]) {
    if (!ids.has(uid)) removePeer(uid);
  }
  updateVoiceUI();
}

function healthCheck() {
  if (!circle) return;
  const now = Date.now();
  for (const e of peers.values()) {
    const st = e.pc ? e.pc.connectionState : null;
    const dead = !e.pc || st === "failed" || st === "closed";
    const stuck = st && st !== "connected" && now - e.startedAt > 15000;
    if (dead || stuck) connectPeer(e);
  }
  updateVoiceUI();
}

function setupVoice() {
  teardownVoice();

  let first = true;
  const q = query(signalsCol(), where("targetUid", "==", me.uid));
  unsubVoiceSignal = onSnapshot(q, (snapshot) => {
    if (first) {
      first = false;
      snapshot.docs.forEach((d) => deleteDoc(d.ref).catch(() => {}));
      return;
    }
    const order = { hello: 0, offer: 0, answer: 1, candidate: 2 };
    const added = snapshot.docChanges()
      .filter((c) => c.type === "added")
      .map((c) => ({ ref: c.doc.ref, data: c.doc.data() }))
      .sort((a, b) => (order[a.data.type] ?? 3) - (order[b.data.type] ?? 3));

    for (const { ref, data } of added) {
      deleteDoc(ref).catch(() => {});
      signalQueue = signalQueue
        .then(() => handleSignal(data))
        .catch((err) => console.warn("signal error", err));
    }
  }, (err) => console.warn("signal listener", err));

  healthTimer = setInterval(healthCheck, 8000);
  syncPeers();
  updateVoiceUI();
}

async function handleSignal(data) {
  if (!circle || data.senderUid === me.uid) return;
  const e = getEntry(data.senderUid, data.senderName);
  if (data.type === "hello") {
    if (e.initiator) await startOffer(e);
  } else if (data.type === "offer") {
    await handleOffer(e, data);
  } else if (data.type === "answer") {
    await handleAnswer(e, data);
  } else if (data.type === "candidate") {
    await handleCandidate(e, data);
  }
}

function teardownVoice() {
  if (unsubVoiceSignal) unsubVoiceSignal();
  unsubVoiceSignal = null;
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = null;
  stopTalking();
  for (const uid of [...peers.keys()]) removePeer(uid);
  remoteTalkers.clear();
  if (micTrack) { micTrack.stop(); micTrack = null; }
  updateVoiceUI();
}

function unlockAudio() {
  for (const e of peers.values()) {
    if (e.audio.srcObject && e.audio.paused) e.audio.play().catch(() => {});
  }
}
["pointerdown", "touchend", "keydown"].forEach((ev) =>
  document.addEventListener(ev, unlockAudio, { passive: true })
);

const pttBtn = $("ptt");
if (pttBtn) {
  pttBtn.style.touchAction = "none";
  pttBtn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    try { pttBtn.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    startTalking();
  });
  pttBtn.addEventListener("pointerup", stopTalking);
  pttBtn.addEventListener("pointercancel", stopTalking);
  pttBtn.addEventListener("lostpointercapture", stopTalking);
  pttBtn.addEventListener("contextmenu", (e) => e.preventDefault());
}
window.addEventListener("blur", stopTalking);

// ---------- members list (with Owner Remove Support) ----------
async function removeMember(memberUid, memberName) {
  if (!confirm(`Talagang gusto mong alisin si ${memberName} sa circle na ito?`)) return;
  try {
    // Tanggalin sa members collection
    await deleteDoc(doc(db, "circles", circle.id, "members", memberUid));
    // Tanggalin din ang circleId reference sa user document para bumalik sa gate screen ang pinalis
    await setDoc(doc(db, "users", memberUid), { circleId: null }, { merge: true });
    showToast(`Naalis si ${memberName} sa circle.`);
  } catch (err) {
    const errText = friendlyError(err);
    showToast(errText, true);
  }
}

function renderMembers() {
  const list = $("members");
  if (!list) return;
  list.replaceChildren();
  $("member-count").textContent = people.length;

  const isUserOwner = circle && circle.ownerId === me.uid;

  for (const p of people) {
    const li = document.createElement("li");
    li.className = "member";

    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.textContent = (p.name[0] || "?").toUpperCase();
    avatar.style.background = avatarColor(p.name);

    const info = document.createElement("div");
    info.className = "member__info";
    const name = document.createElement("span");
    name.className = "member__name";
    name.textContent = p.name;
    const status = document.createElement("span");
    status.className = "member__status";
    const loc = locs.get(p.id);
    status.textContent = loc ? "Sharing, " + timeAgo(loc.updatedAt) : "Not sharing";
    info.append(name, status);
    li.append(avatar, info);

    if (loc) {
      li.classList.add("member--link");
      li.tabIndex = 0;
      li.setAttribute("role", "button");
      li.setAttribute("aria-label", "Show " + p.name + " on the map");
      const go = () => focusMember(p.id);
      li.addEventListener("click", go);
      li.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    }

    const tags = [];
    if (p.id === me.uid) tags.push("You");
    if (p.id === circle.ownerId) tags.push("Owner");
    for (const t of tags) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = t;
      li.append(tag);
    }

    // Kung ikaw ang owner at hindi mo sarili ang row, lagyan ng "Remove" button
    if (isUserOwner && p.id !== me.uid) {
      const removeBtn = document.createElement("button");
      removeBtn.textContent = "Remove";
      removeBtn.className = "btn-remove"; // Maaari mong lagyan ng estilo sa CSS
      removeBtn.style.cssText = "background: #dc2626; color: white; border: none; padding: 4px 8px; border-radius: 4px; font-size: 12px; cursor: pointer; margin-left: 8px; width: auto;";
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        removeMember(p.id, p.name);
      });
      li.append(removeBtn);
    }

    list.append(li);
  }
}

// ---------- map ----------
function initMap() {
  if (!map) {
    map = L.map("map").setView([14.5995, 120.9842], 12);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
  }
  setTimeout(() => map.invalidateSize(), 0);
}

function pinIcon(name) {
  const el = document.createElement("span");
  el.textContent = (name[0] || "?").toUpperCase();
  el.style.background = avatarColor(name);
  return L.divIcon({ className: "pin", html: el, iconSize: [38, 38], iconAnchor: [19, 19] });
}

function drawPins() {
  if (!map) return;

  for (const [uid, m] of markers) {
    if (!locs.has(uid)) {
      m.remove();
      markers.delete(uid);
    }
  }

  for (const [uid, l] of locs) {
    const name = l.name || "?";
    const text = name + (uid === me.uid ? " (you)" : "") + "<br>Updated " + timeAgo(l.updatedAt);
    let m = markers.get(uid);
    if (!m) {
      m = L.marker([l.lat, l.lng], { icon: pinIcon(name) }).addTo(map);
      m.bindTooltip(name, { permanent: true, direction: "top", offset: [0, -22], className: "pin-label" });
      m.bindPopup("");
      markers.set(uid, m);
    } else {
      m.setLatLng([l.lat, l.lng]);
    }
    m.setPopupContent(text);
    m.setOpacity(Date.now() - l.updatedAt > 10 * 60 * 1000 ? 0.5 : 1);
  }

  if (!didFit && markers.size > 0) {
    didFit = true;
    const points = [...locs.values()].map((l) => [l.lat, l.lng]);
    if (points.length === 1) map.setView(points[0], 16);
    else map.fitBounds(L.latLngBounds(points).pad(0.3), { maxZoom: 17 });
  }
}

function focusMember(uid) {
  const l = locs.get(uid);
  const m = markers.get(uid);
  if (!l || !m) return;
  map.flyTo([l.lat, l.lng], 16);
  m.openPopup();
}

setInterval(() => {
  if (circle) {
    drawPins();
    renderMembers();
  }
}, 10000);

// =====================================================================
//  LOCATION SHARING
// =====================================================================
const prefKey = () => "sharing:" + (me ? me.uid : "");
function getSharePref() {
  try { return localStorage.getItem(prefKey()) === "1"; } catch { return false; }
}
function setSharePref(on) {
  try { localStorage.setItem(prefKey(), on ? "1" : "0"); } catch { /* ignore */ }
}

function updateShareButton() {
  const btn = $("share-btn");
  if (!btn) return;
  btn.textContent = sharing ? "Pause sharing" : "Share my location";
  btn.classList.toggle("is-sharing", sharing);
}

async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    }
  } catch { /* not supported or denied */ }
}
function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

function startSharing() {
  if (!navigator.geolocation) {
    const errText = "This device can't share location.";
    setStatus(errText, "error");
    showToast(errText, true);
    return;
  }
  sharing = true;
  lastPos = null;
  updateShareButton();
  setStatus("Finding your location… please allow permission.", "refreshing");
  requestWakeLock();

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const first = !lastPos;
      lastPos = pos;
      if (first) writeLocation(pos);
    },
    onPositionError,
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
  );

  if (locationTimer) clearInterval(locationTimer);
  locationTimer = setInterval(locationTick, LOCATION_INTERVAL_MS);
}

function locationTick() {
  if (!sharing || !circle || locationBusy) return;
  locationBusy = true;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      lastPos = pos;
      writeLocation(pos).finally(() => { locationBusy = false; });
    },
    () => {
      if (lastPos && Date.now() - lastPos.timestamp < 60000) {
        writeLocation(lastPos).finally(() => { locationBusy = false; });
      } else {
        locationBusy = false;
        setStatus("Still looking for your location…", "refreshing");
      }
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 8000 }
  );
}

async function writeLocation(pos) {
  if (!circle || !sharing) return;
  const { latitude, longitude, accuracy } = pos.coords;
  try {
    await setDoc(doc(db, "circles", circle.id, "locations", me.uid), {
      name: me.name,
      lat: latitude,
      lng: longitude,
      accuracy: Math.round(accuracy),
      updatedAt: Date.now(),
    });
    setStatus("Sharing your location with " + circle.name + ".", "active");
  } catch (err) {
    const errText = friendlyError(err);
    setStatus(errText, "error");
    showToast(errText, true);
  }
}

async function onPositionError(err) {
  if (err.code === 1) {
    setSharePref(false);
    await stopSharing();
    const errText = "Location is blocked. Please allow Location in your phone settings.";
    setStatus(errText, "error");
    showToast(errText, true);
  } else if (err.code === 2) {
    setStatus("Your device can't find its location right now.", "refreshing");
  } else {
    setStatus("Still looking for your location…", "refreshing");
  }
}

async function stopSharing(message) {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  if (locationTimer) clearInterval(locationTimer);
  watchId = null;
  locationTimer = null;
  locationBusy = false;
  lastPos = null;
  releaseWakeLock();

  const wasSharing = sharing;
  sharing = false;
  if ($("share-btn")) updateShareButton();
  if (wasSharing && circle) {
    try {
      await deleteDoc(doc(db, "circles", circle.id, "locations", me.uid));
    } catch (err) {
      console.error(err);
    }
  }
  if (message) setStatus(message, "default");
}

$("share-btn").addEventListener("click", () => {
  if (sharing) {
    setSharePref(false);
    stopSharing("Sharing is paused. Your circle can't see you.");
  } else {
    setSharePref(true);
    startSharing();
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") {
    stopTalking();
    return;
  }
  if (sharing) {
    requestWakeLock();
    locationTick();
  }
  if (circle) {
    if (micTrack && micTrack.readyState !== "live") micTrack = null;
    healthCheck();
    unlockAudio();
  }
});

// ---------- circle: create / join / leave ----------
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function makeCode() {
  const bytes = new Uint32Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (n) => CODE_CHARS[n % CODE_CHARS.length]).join("");
}

async function addMeToCircle(circleId) {
  await setDoc(doc(db, "circles", circleId, "members", me.uid), {
    name: me.name,
    joinedAt: serverTimestamp(),
  });
  await setDoc(doc(db, "users", me.uid), { circleId, name: me.name }, { merge: true });
  await openCircle(circleId);
}

$("create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("circle-name-input").value.trim();
  $("create-error").textContent = "";
  if (!name) {
    $("create-error").textContent = "Give your circle a name.";
    return;
  }
  const btn = e.submitter;
  btn.disabled = true;
  try {
    const ref = await addDoc(collection(db, "circles"), {
      name,
      code: makeCode(),
      ownerId: me.uid,
      createdAt: serverTimestamp(),
    });
    await addMeToCircle(ref.id);
  } catch (err) {
    const errText = friendlyError(err);
    $("create-error").textContent = errText;
    showToast(errText, true);
  } finally {
    btn.disabled = false;
  }
});

$("join-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = $("code-input").value.trim().toUpperCase();
  $("join-error").textContent = "";
  if (code.length !== 6) {
    $("join-error").textContent = "Enter the 6-character code from your circle owner.";
    return;
  }
  const btn = e.submitter;
  btn.disabled = true;
  try {
    const found = await getDocs(query(collection(db, "circles"), where("code", "==", code)));
    if (found.empty) {
      $("join-error").textContent = "No circle with that code. Check it and try again.";
    } else {
      await addMeToCircle(found.docs[0].id);
    }
  } catch (err) {
    const errText = friendlyError(err);
    $("join-error").textContent = errText;
    showToast(errText, true);
  } finally {
    btn.disabled = false;
  }
});

$("leave").addEventListener("click", async () => {
  if (!confirm("Leave " + circle.name + "? You can rejoin later with the invite code.")) return;
  try {
    teardownVoice();
    setSharePref(false);
    await stopSharing();
    if (unsubMembers) unsubMembers();
    if (unsubLocs) unsubLocs();
    if (unsubChat) unsubChat();
    unsubMembers = unsubLocs = unsubChat = null;

    for (const m of markers.values()) m.remove();
    markers.clear();
    await deleteDoc(doc(db, "circles", circle.id, "members", me.uid));
    await setDoc(doc(db, "users", me.uid), { circleId: null }, { merge: true });
    circle = null;
    show("gate");
  } catch (err) {
    showFatal(err);
  }
});

$("copy-code").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(circle.code);
    showToast("Copied code to clipboard!");
  } catch (err) {
    showToast("Failed to copy code.", true);
  }
});
