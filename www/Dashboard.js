import { auth, app } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, deleteDoc, addDoc, collection,
  query, where, getDocs, onSnapshot, serverTimestamp, orderBy, limit,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const db = getFirestore(app);
const $ = (id) => document.getElementById(id);

let me = null;            // { uid, name }
let circle = null;        // { id, name, code, ownerId }
let unsubMembers = null;
let unsubLocs = null;
let unsubChat = null;
let unsubVoiceSignal = null;
let chatStick = true;     // scroll to bottom on next render

// map + location state
let map = null;
const markers = new Map();   // uid -> Leaflet marker
let locs = new Map();        // uid -> { name, lat, lng, accuracy, updatedAt }
let people = [];             // current members
let watchId = null;
let sharing = false;
let lastWrite = 0;
let didFit = false;
let locationSyncInterval = null;

// ---------- WebRTC Walkie-Talkie State ----------
let peerConnection = null;
let localAudioStream = null;
const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

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
function showToast(message, isError = false) {
  const toast = $("toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.remove("hidden");
  
  setTimeout(() => {
    toast.classList.add("hidden");
  }, 4000);
}

function setStatus(text, type = "default") {
  const statusEl = $("map-status");
  if (!statusEl) return;
  statusEl.textContent = text;
  
  // Alisin lahat ng lumang status classes
  statusEl.classList.remove("active", "refreshing", "error");
  
  // Idagdag ang tamang kulay batay sa type (active = green, refreshing = yellow, error = red)
  if (type === "active") {
    statusEl.classList.add("active");
  } else if (type === "refreshing") {
    statusEl.classList.add("refreshing");
  } else if (type === "error") {
    statusEl.classList.add("error");
  }
}

// ---------- start ----------
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = "index.html";
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
  setupWebRTCPTT();
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

// ---------- REAL-TIME WEBRTC WALKIE TALKIE (NO DATABASE STORAGE) ----------
function setPttStatus(text) {
  $("ptt-status").textContent = text;
}

function idleStatus() {
  setPttStatus("Hold the button and speak. Release to send.");
}

function setupWebRTCPTT() {
  if (unsubVoiceSignal) unsubVoiceSignal();
  
  const signalsRef = collection(db, "circles", circle.id, "signals");
  unsubVoiceSignal = onSnapshot(signalsRef, (snapshot) => {
    snapshot.docChanges().forEach(async (change) => {
      if (change.type === "added") {
        const data = change.doc.data();
        if (data.senderUid === me.uid) return;

        if (data.type === "offer") {
          await handleIncomingOffer(data, change.doc.id);
        } else if (data.type === "answer" && peerConnection) {
          await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
          deleteDoc(doc(db, "circles", circle.id, "signals", change.doc.id));
        } else if (data.type === "candidate" && peerConnection) {
          await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
          deleteDoc(doc(db, "circles", circle.id, "signals", change.doc.id));
        } else if (data.type === "hangup") {
          closePeerConnection();
          setPttStatus(data.senderName + " stopped talking.");
          setTimeout(idleStatus, 1500);
          deleteDoc(doc(db, "circles", circle.id, "signals", change.doc.id));
        }
      }
    });
  });
}

async function handleIncomingOffer(data, signalDocId) {
  closePeerConnection();
  setPttStatus(data.senderName + " is talking live…");
  $("ptt").classList.add("is-hearing");

  peerConnection = new RTCPeerConnection(rtcConfig);

  peerConnection.ontrack = (event) => {
    const audio = new Audio();
    audio.srcObject = event.streams[0];
    audio.play().catch(() => {
      document.addEventListener("pointerdown", () => audio.play(), { once: true });
    });
  };

  await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);

  await addDoc(collection(db, "circles", circle.id, "signals"), {
    senderUid: me.uid,
    senderName: me.name,
    type: "answer",
    sdp: answer,
    createdAt: serverTimestamp()
  });

  deleteDoc(doc(db, "circles", circle.id, "signals", signalDocId));
}

async function startStreamingAudio() {
  if (!circle) return;
  try {
    localAudioStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true }
    });

    closePeerConnection();
    peerConnection = new RTCPeerConnection(rtcConfig);

    localAudioStream.getTracks().forEach((track) => {
      peerConnection.addTrack(track, localAudioStream);
    });

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        addDoc(collection(db, "circles", circle.id, "signals"), {
          senderUid: me.uid,
          senderName: me.name,
          type: "candidate",
          candidate: event.candidate.toJSON(),
          createdAt: serverTimestamp()
        });
      }
    };

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    await addDoc(collection(db, "circles", circle.id, "signals"), {
      senderUid: me.uid,
      senderName: me.name,
      type: "offer",
      sdp: offer,
      createdAt: serverTimestamp()
    });

    const btn = $("ptt");
    btn.classList.add("is-live");
    btn.textContent = "Live Talking…";
    setPttStatus("Transmitting live voice… Release to stop.");

  } catch (err) {
    console.error("Mic error:", err);
    setPttStatus("Microphone access failed.");
    showToast("Microphone access failed.", true);
  }
}

async function stopStreamingAudio() {
  if (localAudioStream) {
    localAudioStream.getTracks().forEach((t) => t.stop());
    localAudioStream = null;
  }
  closePeerConnection();

  const btn = $("ptt");
  btn.classList.remove("is-live", "is-hearing");
  btn.textContent = "Hold to talk";
  idleStatus();

  if (circle) {
    await addDoc(collection(db, "circles", circle.id, "signals"), {
      senderUid: me.uid,
      senderName: me.name,
      type: "hangup",
      createdAt: serverTimestamp()
    });
  }
}

function closePeerConnection() {
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
}

const pttBtn = $("ptt");
pttBtn.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  pttBtn.setPointerCapture(e.pointerId);
  startStreamingAudio();
});
pttBtn.addEventListener("pointerup", stopStreamingAudio);
pttBtn.addEventListener("pointercancel", stopStreamingAudio);
pttBtn.addEventListener("contextmenu", (e) => e.preventDefault());

// ---------- members list ----------
function renderMembers() {
  const list = $("members");
  list.replaceChildren();
  $("member-count").textContent = people.length;

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
}, 30000);

// ---------- LOCATION SHARING & 30-SECOND REFRESH ----------
function updateShareButton() {
  const btn = $("share-btn");
  btn.textContent = sharing ? "Pause sharing" : "Share my location";
  btn.classList.toggle("is-sharing", sharing);
}

function startSharing() {
  if (!navigator.geolocation) {
    const errText = "This browser can't share location.";
    setStatus(errText, "error");
    showToast(errText, true);
    return;
  }
  sharing = true;
  lastWrite = 0;
  updateShareButton();
  setStatus("Finding your location… allow it if your browser asks.", "refreshing");

  watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 20000,
  });

  start30SecLocationLoop();
}

function start30SecLocationLoop() {
  if (locationSyncInterval) clearInterval(locationSyncInterval);

  locationSyncInterval = setInterval(() => {
    if (!sharing || !circle) return;

    navigator.geolocation.getCurrentPosition(
      (pos) => onPosition(pos, true),
      (err) => console.log("30s location pulse:", err.message),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
    );
  }, 30000);
}

async function onPosition(pos, force = false) {
  const now = Date.now();
  if (!force && now - lastWrite < 5000) return;
  lastWrite = now;

  const { latitude, longitude, accuracy } = pos.coords;
  try {
    await setDoc(doc(db, "circles", circle.id, "locations", me.uid), {
      name: me.name,
      lat: latitude,
      lng: longitude,
      accuracy: Math.round(accuracy),
      updatedAt: now,
    });
    // DITO NAGIGING GREEN ANG INDICATOR DAHIL ACTIVE NA ANG SHARING
    setStatus("Sharing your location with " + circle.name + ". Tap Pause sharing to stop.", "active");
  } catch (err) {
    const errText = friendlyError(err);
    setStatus(errText, "error");
    showToast(errText, true);
  }
}

async function onPositionError(err) {
  if (err.code === 1) {
    await stopSharing();
    const errText = "Location is blocked. Click the lock icon in the address bar, allow Location, then try again.";
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
  if (locationSyncInterval) clearInterval(locationSyncInterval);
  watchId = null;
  locationSyncInterval = null;

  const wasSharing = sharing;
  sharing = false;
  if (document.getElementById("share-btn")) updateShareButton();
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
  if (sharing) stopSharing("Sharing is paused. Your circle can't see you.");
  else startSharing();
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
    await stopSharing();
    if (unsubMembers) unsubMembers();
    if (unsubLocs) unsubLocs();
    if (unsubChat) unsubChat();
    if (unsubVoiceSignal) unsubVoiceSignal();
    unsubMembers = unsubLocs = unsubChat = unsubVoiceSignal = null;
    closePeerConnection();

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
    $("copy-code").textContent = "Copied";
  } catch {
    $("copy-code").textContent = "Select and copy";
  }
  setTimeout(() => ($("copy-code").textContent = "Copy"), 1800);
});