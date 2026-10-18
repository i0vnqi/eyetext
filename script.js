/*
  script.js — EyeText
  1) تسجيل الدخول: التحقق من رمز الجلسة، وإلا توجيه لصفحة الدخول.
  2) المظهر: تبديل الوضع الفاتح/الداكن، وحجم خط النص المكتوب.
  3) المعايرة: كل الحروف تظهر موزعة على الشاشة، والمستخدم هو اللي يختار منها 9 حروف (ينظر للحرف ثم يرمش لتأكيده).
  4) تتبع العين: WebGazer لنقطة النظر + MediaPipe FaceMesh لرسم إطار تتبع الوجه وكشف الرمش.
  5) الكتابة: بعد الضغط على "بدء التحديد بالعين" تتحول البطاقة من المعايرة إلى لوحة حروف،
     تثبيت 5 ثواني على حرف ثم رمشة تؤكد اختياره وتضيفه لمربع النص.
  6) كل معايرة وكل حرف وكل حفظ نص يُسجَّل بقاعدة البيانات عبر server.py.
*/

// ---------------- إغلاق الكاميرا / تشغيلها (في أول الملف حتى يشتغل الزر دائمًا) ----------------
const camStreams = [];   // كل تدفقات الكاميرا اللي انفتحت (نوقفها عند الإغلاق)
try {
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    const origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (constraints) =>
      origGUM(constraints).then((stream) => { camStreams.push(stream); return stream; });
  }
} catch (e) {}
let cameraOn = true;
let cameraRunId = 0;   // يتغير عند إغلاق الكاميرا ليتوقف كشف الرمش

function showToast(text) {
  let t = document.getElementById("eyetext-toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "eyetext-toast";
    t.style.cssText = "position:fixed;top:16px;left:50%;transform:translateX(-50%);background:#111;color:#fff;padding:12px 22px;border-radius:10px;font-size:18px;z-index:99999;box-shadow:0 4px 16px rgba(0,0,0,.4)";
    document.body.appendChild(t);
  }
  t.textContent = text; t.style.display = "block";
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { t.style.display = "none"; }, 3000);
}

function stopCamera() {
  cameraOn = false; cameraRunId++;
  // نغيّر الواجهة أول، حتى لو صار خطأ بعدها يشوف المستخدم أن الزر اشتغل
  const btn = document.getElementById("btn-camera-off");
  if (btn) btn.textContent = "📷 تشغيل الكاميرا";
  const cs = document.getElementById("cam-status"); if (cs) cs.textContent = "متوقفة";
  const vw = document.getElementById("video-wrap"); if (vw) vw.style.visibility = "hidden";
  const tg = document.getElementById("toggle-cam"); if (tg) tg.checked = false;
  const sd = document.getElementById("btn-start-detect"); if (sd) sd.disabled = true;
  showToast("جاري إغلاق الكاميرا...");
  // بعدها نوقف الكاميرا فعليًا
  try { if (typeof detectMode !== "undefined") detectMode = false; clearFocus(); } catch (e) {}
  try { camStreams.forEach((st) => st.getTracks().forEach((t) => t.stop())); } catch (e) {}
  try { document.querySelectorAll("video").forEach((v) => { if (v.srcObject) v.srcObject.getTracks().forEach((t) => t.stop()); v.srcObject = null; }); } catch (e) {}
  try { webgazer.stopVideo && webgazer.stopVideo(); } catch (e) {}
  try { webgazer.pause(); } catch (e) {}
  try { webgazer.end(); } catch (e) {}
  const live = camStreams.some((st) => st.getTracks().some((t) => t.readyState === "live"));
  showToast(live ? "تعذر إغلاق الكاميرا بالكامل" : "تم إغلاق الكاميرا ✓");
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest && e.target.closest("#btn-camera-off");
  if (!btn) return;
  if (cameraOn) { stopCamera(); return; }
  // تشغيل من جديد: نعيد تحميل الصفحة (أضمن طريقة) ونحفظ النص المكتوب حتى ما يضيع
  try { sessionStorage.setItem("eyetext_draft", typeof typedText === "string" ? typedText : ""); } catch (err) {}
  location.reload();
});

// ---------------- التحقق من الدخول ----------------
const TOKEN = localStorage.getItem("gaze_token");
if (!TOKEN) window.location.href = "login.html";

async function api(path, extra = {}) {
  return fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: TOKEN, ...extra }),
  }).then((r) => r.json());
}

// نسخة من api تحوّل المستخدم لصفحة الدخول لو الجلسة انتهت، وما تنهار لو انقطع الاتصال
async function apiAuth(path, extra = {}) {
  try {
    const res = await api(path, extra);
    if (res && res.error === "جلسة غير صالحة") {
      localStorage.removeItem("gaze_token"); localStorage.removeItem("gaze_user_name"); localStorage.removeItem("gaze_user_id");
      window.location.href = "login.html";
    }
    return res;
  } catch (e) {
    return { ok: false, error: "تعذر الاتصال بالخادم" };
  }
}

const LETTERS = [
  "ا","ب","ت","ث","ج","ح","خ","د","ذ","ر","ز","س",
  "ش","ص","ض","ط","ظ","ع","غ","ف","ق","ك","ل","م",
  "ن","ه","و","ي",
];

const el = (id) => document.getElementById(id);

// لو index.html القديم ما انستبدل (ما فيه زر الكاميرا)، ننشئ الزر هنا حتى ما ينكسر باقي الكود
function makeCameraBtn() {
  const b = document.createElement("button");
  b.id = "btn-camera-off"; b.className = "btn-ghost btn-big"; b.textContent = "📷 إغلاق الكاميرا";
  const anchor = document.getElementById("btn-start-detect");
  if (anchor && anchor.parentNode) anchor.insertAdjacentElement("afterend", b);
  return b;
}
const els = {
  userName: el("user-name"), btnLogout: el("btn-logout"),
  themeToggle: el("theme-toggle"),
  camStatus: el("cam-status"),
  videoWrap: el("video-wrap"), overlayCanvas: el("overlay-canvas"),
  calibPanel: el("calib-panel"), keyboardPanel: el("keyboard-panel"),
  btnStartCalib: el("btn-start-calib"), calibSteps: [...document.querySelectorAll("#calib-steps .step")],
  btnStartDetect: el("btn-start-detect"), btnCameraOff: el("btn-camera-off") || makeCameraBtn(),
  keyboard: el("keyboard"), blinkHint: el("blink-hint"),
  liveBox: el("live-box"), liveText: el("live-text"),
  outputText: el("output-text"), charCount: el("char-count"),
  btnClear: el("btn-clear"), btnSave: el("btn-save"),
  fontSlider: el("font-size-slider"), dwellSlider: el("dwell-slider"), toggleCam: el("toggle-cam"),
  calibOverlay: el("calibration-overlay"), calibMsg: el("calib-msg"),
  calibGrid: el("calib-grid"), calibDots: [...document.querySelectorAll(".calib-dot")],
  calibProgress: el("calib-progress"),
  statusLine: el("status-line"), videoCaption: el("video-caption"),
};

els.userName.textContent = localStorage.getItem("gaze_user_name") || "ضيف";

// ---------------- المظهر ----------------
const savedTheme = localStorage.getItem("eyetext_theme") || "light";
document.body.setAttribute("data-theme", savedTheme);
els.themeToggle.addEventListener("click", () => {
  const next = document.body.getAttribute("data-theme") === "dark" ? "light" : "dark";
  document.body.setAttribute("data-theme", next);
  localStorage.setItem("eyetext_theme", next);
});

els.fontSlider.addEventListener("input", () => {
  els.outputText.style.setProperty("--out-font", els.fontSlider.value + "px");
  els.outputText.style.fontSize = els.fontSlider.value + "px";
});

// ---------------- حالة عامة ----------------
const CALIB_POINTS = 9;
const shuffle = (arr) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
let dwellMs = Number(els.dwellSlider.value) * 1000;
let smoothed = null;
const ALPHA = 0.2;

let calibrationDone = false;
let detectMode = false;
let typedText = "";
let lastSavedText = "";   // آخر نص انحفظ (حتى ما يتكرر الحفظ)
let letterSeq = 0;
let focusedKey = null, focusSince = 0, armed = false, armedAt = 0, offSince = 0, cooldownUntil = 0;
const LIGHT_MS = 2000;          // المرحلة 1: تثبيت نظرك ثانيتين → الحرف يضيء
// المرحلة 2: تثبيت نظرك على الحرف المضيء (مدة التأكيد من السلايدر) → يجهز للرمشة
let lit = false, litAt = 0;
const GRACE_MS = 800;           // سماح لتذبذب تقدير النظر (ما يصفّر المؤقت)
const ARMED_TIMEOUT_MS = 8000;  // لو جهز الحرف وما رمشت خلال 8 ثواني يرجع من جديد
const DEBUG = location.search.includes("debug");

els.dwellSlider.addEventListener("input", () => {
  dwellMs = Number(els.dwellSlider.value) * 1000;
});

// ---------------- بناء لوحة الحروف ----------------
function buildKeyboard() {
  const specials = [
    { label: "␣ مسافة بين الكلمات", action: "space" },
    { label: "⌫ حذف", action: "backspace" },
    { label: "🗑 الكل", action: "clear" },
  ];
  LETTERS.forEach((ch) => addKey(ch, "letter", ch));
  specials.forEach((s) => addKey(s.label, "action", s.action, true));
}
function addKey(label, type, value, isControl = false) {
  const div = document.createElement("div");
  div.className = "key" + (isControl ? " control" : "");
  div.dataset.type = type;
  div.dataset.value = value;
  div.innerHTML = `<span>${label}</span><div class="progress-fill"></div>`;
  els.keyboard.appendChild(div);
}

// ---------------- المعايرة: المستخدم هو اللي يختار الحرف (ما فيه حرف يضيئه النظام) ----------------
let calibActive = false, calibTimer = null;
let calibDone = 0, calibFocus = null, calibSince = 0, calibOffSince = 0, calibArmed = false, calibArmedAt = 0;
const CALIB_COLS = 7, CALIB_ROWS = 4;   // 28 حرف موزعة على الشاشة
const CALIB_HINT = "اختر أي حرف تبيه: ثبّت نظرك عليه ثم ارمش لتأكيده";

function dotCenter(dot) {
  const r = dot.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function setupCalibration() {
  // كل حروف الأبجدية تظهر، والمستخدم يختار اللي يبيه. النقر على الحرف (وأنت تنظر له) يؤكده مباشرة ويفيد في أول مرة
  const grid = els.calibGrid;
  grid.textContent = "";
  grid.classList.add("free");
  els.calibDots = LETTERS.map((ch) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "calib-dot free"; b.textContent = ch;
    b.addEventListener("click", () => {
      if (!calibActive || b.classList.contains("done")) return;
      if (calibFocus && calibFocus !== b) calibFocus.style.backgroundImage = "";
      calibFocus = b;
      confirmCalibDot();
    });
    grid.append(b);
    return b;
  });
  // Escape للخروج من المعايرة
  document.addEventListener("keydown", (e) => {
    if (calibActive && e.code === "Escape") cancelCalibration();
  });
}

function resetCalibDot(d) {
  d.classList.remove("done", "pop"); d.disabled = false;
  d.style.backgroundImage = ""; d.style.background = ""; d.style.opacity = "";
}

function startCalibration() {
  gazeOffset = { x: 0, y: 0 };   // المعايرة الجديدة تبدأ بدون تصحيح قديم
  calibActive = true; calibDone = 0; calibFocus = null; calibArmed = false; calibOffSince = 0;
  els.calibDots.forEach(resetCalibDot);
  els.calibMsg.textContent = CALIB_HINT;
  els.calibProgress.textContent = `0 / ${CALIB_POINTS} — اضغط Esc لتخطي المعايرة`;
  els.calibOverlay.style.display = "flex";
  updateMiniSteps(0);
  clearInterval(calibTimer);
  calibTimer = setInterval(calibTick, 100);
}

function cancelCalibration() {
  calibActive = false;
  clearInterval(calibTimer);
  els.calibDots.forEach(resetCalibDot);
  els.calibOverlay.style.display = "none";
}

// أقرب حرف (غير مختار) لنقطة نظر المستخدم الحالية
function nearestCalibDot() {
  if (!smoothed) return null;
  const g = els.calibGrid.getBoundingClientRect();
  let bestD = Math.min(g.width / CALIB_COLS, g.height / CALIB_ROWS) * 0.75;   // أبعد مسافة مقبولة عن مركز الحرف
  let best = null;
  for (const d of els.calibDots) {
    if (d.classList.contains("done")) continue;
    const c = dotCenter(d);
    const dist = Math.hypot(c.x - smoothed.x, c.y - smoothed.y);
    if (dist < bestD) { best = d; bestD = dist; }
  }
  return best;
}

function setCalibFocus(dot, now) {
  if (calibFocus) calibFocus.style.backgroundImage = "";
  calibFocus = dot; calibSince = now; calibOffSince = 0;
  els.calibMsg.textContent = CALIB_HINT;
}

// كل 100ms: الحرف اللي تنظر له يمتلئ بالأخضر، وإذا اكتمل التثبيت ننتظر الرمشة
function calibTick() {
  if (!calibActive || calibArmed) return;
  const now = performance.now();
  const target = nearestCalibDot();
  if (target === calibFocus) calibOffSince = 0;
  else if (calibFocus) {
    if (!calibOffSince) calibOffSince = now;                              // سماح لتذبذب النظر
    if (now - calibOffSince >= GRACE_MS) setCalibFocus(target, now);
  } else setCalibFocus(target, now);
  if (!calibFocus) return;

  const { x, y } = dotCenter(calibFocus);
  if (eyeState === "open") {   // لا نسجّل عيّنات أثناء الرمش
    try { webgazer.recordScreenPosition(x, y, "click"); } catch (e) {}
  }
  const elapsed = now - calibSince;
  const pct = Math.min(100, (elapsed / dwellMs) * 100);
  calibFocus.style.backgroundImage = `linear-gradient(to top, #22c55e ${pct}%, #ffffff ${pct}%)`;
  if (elapsed >= dwellMs) {
    calibArmed = true; calibArmedAt = now;
    calibFocus.style.backgroundImage = "linear-gradient(#22c55e, #22c55e)";
    els.calibMsg.textContent = `ارمش الآن لتأكيد اختيارك «${calibFocus.textContent}»`;
  }
}

function confirmCalibDot() {
  const dot = calibFocus;
  if (!dot) return;
  const { x, y } = dotCenter(dot);
  try { webgazer.recordScreenPosition(x, y, "click"); } catch (e) {}
  dot.classList.add("done"); dot.disabled = true; dot.style.backgroundImage = "";
  dot.classList.remove("pop"); void dot.offsetWidth; dot.classList.add("pop"); // تفاعل بصري مع الاختيار
  setTimeout(() => dot.classList.remove("pop"), 400);
  calibFocus = null; calibArmed = false; calibOffSince = 0;
  calibDone++;
  updateMiniSteps(calibDone / CALIB_POINTS);
  els.calibProgress.textContent = `${calibDone} / ${CALIB_POINTS} — اضغط Esc لتخطي المعايرة`;
  if (calibDone >= CALIB_POINTS) finishCalibration();
  else els.calibMsg.textContent = CALIB_HINT;
}

function updateMiniSteps(fraction) {
  const litCount = Math.round(fraction * els.calibSteps.length);
  els.calibSteps.forEach((s, i) => s.classList.toggle("on", i < litCount));
}

function finishCalibration() {
  calibActive = false;
  clearInterval(calibTimer);
  els.calibOverlay.style.display = "none";
  calibrationDone = true;
  els.btnStartDetect.disabled = false;
  els.statusLine.textContent = "تمت المعايرة — اضغطي بدء التحديد بالعين";
  api("/api/calibration", { points_count: CALIB_POINTS });
}
els.btnStartCalib.addEventListener("click", startCalibration);

// ---------------- بدء التحديد بالعين (تحويل البطاقة للوحة حروف) ----------------
els.btnStartDetect.addEventListener("click", () => {
  detectMode = true;
  els.calibPanel.hidden = true;
  els.keyboardPanel.hidden = false;
  document.getElementById("camera-stage").classList.add("typing");   // تكبير لوحة الحروف داخل نفس الصفحة
  if (!els.keyboard.children.length) buildKeyboard();
  els.btnStartDetect.disabled = true;
  els.btnStartDetect.textContent = "✓ التحديد يعمل الآن";
});

// ---------------- تشغيل WebGazer + عرض الكاميرا داخل البطاقة ----------------
async function startWebgazer() {
  // الجوال (وأي جهاز غير localhost) لا يفتح الكاميرا إلا من رابط https
  if (!window.isSecureContext) {
    const m = "الكاميرا لا تعمل إلا من رابط https (مثل رابط Railway). افتح الموقع المستضاف بدل عنوان الشبكة المحلية.";
    els.statusLine.textContent = "⚠️ " + m; showToast(m);
    return;
  }
  // الكاميرا الأمامية للجوال
  try { webgazer.params.camConstraints = { video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false }; } catch (e) {}
  els.statusLine.textContent = "جاري تشغيل الكاميرا...";
  await webgazer.setRegression("ridge").setGazeListener(onGaze).saveDataAcrossSessions(true).begin();
  webgazer.showPredictionPoints(DEBUG);   // مع ?debug تظهر نقطة حمراء مكان تقدير نظرك
  webgazer.applyKalmanFilter(true);

  // ننقل فيديو WebGazer داخل بطاقتنا بدل حاويته العائمة الافتراضية
  const vid = document.getElementById("webgazerVideoFeed");
  if (vid) {
    vid.style.position = "absolute";
    vid.style.inset = "0";
    vid.style.width = "100%";
    vid.style.height = "100%";
    vid.style.transform = "scaleX(-1)";
    els.videoWrap.insertBefore(vid, els.overlayCanvas);
  }
  startBlinkAndOverlayDetection();
  keepScreenAwake();
  els.statusLine.textContent = "جاهزة — ابدأ الكتابة مباشرة، أو عاير أولاً (اختياري)";
}

// يمنع انطفاء شاشة الجوال أثناء التثبيت الطويل (5 ثواني لكل حرف)
function keepScreenAwake() {
  try {
    if (!("wakeLock" in navigator)) return;
    const lock = () => navigator.wakeLock.request("screen").catch(() => {});
    lock();
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && cameraOn) lock(); });
  } catch (e) {}
}

let gazeOffset = { x: 0, y: 0 };   // تصحيح انحراف النظر (يُحسب في «ضبط الدقة»)
let rawSm = null;                  // النظر المنعّم بدون التصحيح
let driftActive = false;
function onGaze(data) {
  if (!data) return;
  rawSm = rawSm
    ? { x: ALPHA * data.x + (1 - ALPHA) * rawSm.x, y: ALPHA * data.y + (1 - ALPHA) * rawSm.y }
    : { x: data.x, y: data.y };
  const raw = { x: data.x + gazeOffset.x, y: data.y + gazeOffset.y };
  smoothed = smoothed
    ? { x: ALPHA * raw.x + (1 - ALPHA) * smoothed.x, y: ALPHA * raw.y + (1 - ALPHA) * smoothed.y }
    : raw;
  if (detectMode && !driftActive) handleGazePoint(smoothed.x, smoothed.y);
}

// ---------------- التثبيت + الاستعداد (Armed) ----------------
function advanceDwell(now) {
  if (!focusedKey || armed || now < cooldownUntil) return;
  const fill = focusedKey.querySelector(".progress-fill");
  const label = focusedKey.querySelector("span").textContent;

  // المرحلة 1: ثانيتان من التثبيت → الحرف يضيء (قبلها ما يضيء شي)
  if (!lit) {
    const elapsed = Math.max(0, now - focusSince);
    fill.style.width = Math.min(100, (elapsed / LIGHT_MS) * 100) + "%";
    if (elapsed >= LIGHT_MS) {
      lit = true; litAt = now;
      focusedKey.classList.remove("focused");
      focusedKey.classList.add("lit");
      paintKey(focusedKey, "lit");
      fill.style.width = "0%";
      const secs = +(dwellMs / 1000).toFixed(1);
      els.blinkHint.textContent = `أضاء «${label}» — ثبّت نظرك عليه ${secs} ثواني لتأكيد الاختيار (إذا أبعدت نظرك يُلغى الحرف)`;
    }
    return;
  }
  // المرحلة 2: ثبّت نظرك على الحرف المضيء لتأكيد الاختيار → يصير جاهز للرمشة
  const elapsed2 = now - litAt;
  fill.style.width = Math.min(100, (elapsed2 / dwellMs) * 100) + "%";
  if (elapsed2 >= dwellMs) {
    armed = true; armedAt = now;
    focusedKey.classList.remove("lit");
    focusedKey.classList.add("armed");
    paintKey(focusedKey, "armed");
    els.blinkHint.textContent = "ارمش الآن لتأكيد «" + label + "» — ولا تبعد نظرك عنه";
  }
}
// ---------------- اختيار الحرف (ثبات + تعليمات واضحة) ----------------
// المرحلة 1: ثبّت نظرك على الحرف ثانيتين → يمتلئ مربعه، ثم يضيء.
// المرحلة 2: ثبّت نظرك عليه (مدة التأكيد) → يتلون بالأصفر كاملًا = جاهز للرمشة.
// الرمشة → يُكتب الحرف. وإذا أبعدت نظرك وهو مضيء أو أصفر → يُلغى مع رسالة تشرح السبب.
const KEY_SCORES = new Map();
let lastVoteAt = 0, switchSince = 0, awaySince = 0;
const VOTE_TAU_MS = 700;
const MIN_START_SCORE = 0.15;   // أقل نسبة وقت لبدء التركيز على حرف
const LEAVE_SCORE = 0.05;       // أقل من كذا = النظر خارج لوحة الحروف
const KEY_NEAR_PX = 150;        // بعد ما يضيء الحرف يبقى مادام نظرك ضمن هذي المسافة منه
const AWAY_MS = 1500;           // مدة الابتعاد اللي تلغي الحرف المضيء
function rectDist(r, x, y) {
  const dx = Math.max(r.left - x, 0, x - r.right), dy = Math.max(r.top - y, 0, y - r.bottom);
  return Math.hypot(dx, dy);
}
// ألوان واضحة للحالات (تُطبَّق مباشرة حتى لا تعتمد على ملف التصميم)
function paintKey(keyEl, stage) {
  if (!keyEl) return;
  const st = keyEl.style;
  if (stage === "focus") { st.outline = "4px solid #6366f1"; st.outlineOffset = "2px"; }
  else if (stage === "lit") { st.outline = "4px solid #F5C518"; st.background = "#FDE68A"; st.color = "#1B1F5E"; }
  else if (stage === "armed") { st.outline = "4px solid #F59E0B"; st.background = "#F5C518"; st.color = "#1B1F5E"; }
  else { st.outline = ""; st.outlineOffset = ""; st.background = ""; st.color = ""; }
}
// كل عينة نظر توزّع "صوتها" على الحروف حسب القرب، والحرف الأعلى خلال آخر ~0.7 ثانية يكسب
function voteForKeys(x, y, now) {
  const dt = Math.min(200, Math.max(16, lastVoteAt ? now - lastVoteAt : 16));
  lastVoteAt = now;
  const decay = Math.exp(-dt / VOTE_TAU_MS), gain = 1 - decay;
  const keys = [...els.keyboard.querySelectorAll(".key")].map((k) => ({ k, r: k.getBoundingClientRect() })).filter((o) => o.r.width);
  const kb = els.keyboard.getBoundingClientRect(), pad = 140;
  const onBoard = x > kb.left - pad && x < kb.right + pad && y > kb.top - pad && y < kb.bottom + pad;
  const w = keys.map((o) => (onBoard ? Math.exp(-Math.pow(rectDist(o.r, x, y), 2) / (2 * 30 * 30)) : 0));
  let total = w.reduce((a, b) => a + b, 0);
  if (onBoard && total < 1e-9 && keys.length) {   // بعيد عن كل الحروف: نعتمد أقرب حرف
    let bi = 0, bd = Infinity;
    keys.forEach((o, i) => { const d = rectDist(o.r, x, y); if (d < bd) { bd = d; bi = i; } });
    w[bi] = 1; total = 1;
  }
  let best = null, bestScore = 0;
  keys.forEach((o, i) => {
    const share = total > 0 ? w[i] / total : 0;
    const sc = (KEY_SCORES.get(o.k) || 0) * decay + share * gain;
    KEY_SCORES.set(o.k, sc);
    if (sc > bestScore) { bestScore = sc; best = o.k; }
  });
  return { key: best, score: bestScore };
}
function startFocus(keyEl, now) {
  focusedKey = keyEl;
  focusSince = Math.max(now, cooldownUntil);
  focusedKey.classList.add("focused");
  paintKey(focusedKey, "focus");
  switchSince = 0; offSince = 0; awaySince = 0;
}
// إلغاء الحرف مع رسالة تشرح السبب للمستخدم
function cancelSelection(reasonText) {
  const label = focusedKey ? focusedKey.querySelector("span").textContent : "";
  clearFocus();
  const msg = reasonText || `أبعدت نظرك عن «${label}» فأُلغي الحرف — انظر إليه من جديد`;
  els.blinkHint.textContent = msg;
  showToast(msg);
}
function handleGazePoint(x, y) {
  const now = performance.now();
  if (eyeState === "closing") return;   // العين مغلقة (رمشة): لا نعتمد على النظر

  // حرف أضاء أو صار جاهزًا: يبقى ثابت مادام نظرك قريب منه، وإذا ابتعدت يُلغى
  if (focusedKey && (lit || armed)) {
    const near = rectDist(focusedKey.getBoundingClientRect(), x, y) <= KEY_NEAR_PX;
    if (near) awaySince = 0;
    else {
      if (!awaySince) awaySince = now;
      if (now - awaySince >= AWAY_MS) { cancelSelection(); return; }
    }
    if (armed) {
      if (now - armedAt > ARMED_TIMEOUT_MS) cancelSelection("انتهى الوقت بدون رمشة — انظر للحرف من جديد");
      return;
    }
    advanceDwell(now);
    return;
  }

  const { key: cand, score } = voteForKeys(x, y, now);

  if (!focusedKey) {
    if (cand && score >= MIN_START_SCORE) startFocus(cand, now);
    return;
  }
  // النظر خرج من لوحة الحروف؟
  if (score < LEAVE_SCORE) {
    if (!offSince) offSince = now;
    if (now - offSince > 1500) clearFocus();
    return;
  }
  offSince = 0;
  // صار حرف ثاني أوضح؟ نبدّل بعد ثبات مدة نصف ثانية
  const curScore = KEY_SCORES.get(focusedKey) || 0;
  if (cand !== focusedKey && score > curScore * 1.5 && score >= MIN_START_SCORE) {
    if (!switchSince) switchSince = now;
    if (now - switchSince >= 500) { clearFocus(true); startFocus(cand, now); return; }
  } else switchSince = 0;
  advanceDwell(now);
}
function clearFocus(keepScores) {
  if (focusedKey) {
    focusedKey.classList.remove("focused", "lit", "armed");
    paintKey(focusedKey, null);
    focusedKey.querySelector(".progress-fill").style.width = "0%";
  }
  focusedKey = null; armed = false; lit = false; offSince = 0; switchSince = 0; awaySince = 0;
  if (!keepScores) KEY_SCORES.clear();
  els.blinkHint.textContent = "ثبّت نظرك على الحرف ثانيتين ليضيء، ثم ثبّته للتأكيد وارمش — وبين الكلمات اختر «مسافة»";
}
// كل حرف يختاره المستخدم ويؤكده بالرمشة = "كان ينظر هنا": نعلّم WebGazer من اختياره بدل معايرة إجبارية
function learnFromSelection(keyEl) {
  const r = keyEl.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  try { webgazer.recordScreenPosition(x, y, "click"); webgazer.recordScreenPosition(x, y, "click"); } catch (e) {}
}
function selectKey(keyEl) {
  learnFromSelection(keyEl);
  const { type, value } = keyEl.dataset;
  const dwellUsed = Math.round(performance.now() - focusSince);
  if (type === "letter") typedText += value;
  else if (value === "space") typedText += " ";
  else if (value === "backspace") typedText = typedText.slice(0, -1);
  else if (value === "clear") typedText = "";
  renderOutput();
  keyEl.classList.add("selected");
  setTimeout(() => keyEl.classList.remove("selected"), 350);

  letterSeq++;
  api("/api/letter", {
    letter: type === "letter" ? value : `[${value}]`,
    sequence_order: letterSeq, dwell_time_ms: dwellUsed, confirmed_by: "blink",
  });

  cooldownUntil = performance.now() + 700;
  clearFocus();
}
function renderOutput() {
  els.outputText.textContent = typedText;
  els.charCount.textContent = typedText.length + " حرف";
  renderLiveBox();
}
// المربع الصغير فوق الحروف: يعرض الجملة أول بأول، وآخر حرف يظهر بحركة تأكيد
function renderLiveBox() {
  const box = els.liveText;
  if (!box) return;   // لو غاب المربع الصغير من الصفحة، يبقى النص الرئيسي يُكتب بدل ما ينهار الكود
  box.textContent = "";
  if (!typedText) { box.dataset.empty = "1"; return; }
  delete box.dataset.empty;
  box.append(document.createTextNode(typedText.slice(0, -1)));
  const last = document.createElement("span");
  last.className = "live-last";
  last.textContent = typedText.slice(-1);
  box.append(last);
  if (els.liveBox) els.liveBox.scrollTop = els.liveBox.scrollHeight;
}

// ---------------- كشف الرمش + رسم إطار التتبع (MediaPipe FaceMesh) ----------------
const LEFT_EYE = { top: 159, bottom: 145, cornerA: 33, cornerB: 133 };
const RIGHT_EYE = { top: 386, bottom: 374, cornerA: 362, cornerB: 263 };
// العتبات تتكيّف تلقائيًا مع شكل عينك (بدل أرقام ثابتة): نقيس "العين المفتوحة" ونعتبر الرمشة هبوطًا منها
const EAR_HISTORY = [];
let earBase = 0.28;
const MAX_BLINK_MS = 2500;     // أطول من كذا يعتبر إغلاق عين وليس رمشة (رفعناها: المستخدم يغمض إغماضة مقصودة)
const HOLD_CONFIRM_MS = 600;   // والحرف جاهز: إغماض مستمر هذي المدة يؤكد الحرف دون انتظار فتح العين
let closureHandled = false;    // الإغماضة الحالية أُكّد بها حرف بالفعل
let eyeState = "open", eyeClosedAt = 0, blinkCooldownUntil = 0, faceLost = false;
const DEFAULT_CAPTION = "جاري تتبع حركة العين";
let captionTimer = null;

// المسافات بالبكسل (الإحداثيات مطبّعة بعرض/ارتفاع مختلفين، وهذا كان يخلّي النسبة غير دقيقة)
const dist = (a, b, vw, vh) => Math.hypot((a.x - b.x) * vw, (a.y - b.y) * vh);
const earFor = (lm, eye, vw, vh) =>
  dist(lm[eye.top], lm[eye.bottom], vw, vh) / (dist(lm[eye.cornerA], lm[eye.cornerB], vw, vh) + 1e-6);

function flashCaption(text, ok) {
  els.videoCaption.textContent = text;
  els.videoCaption.style.background = ok ? "rgba(34,197,94,.85)" : "rgba(245,158,11,.85)";
  clearTimeout(captionTimer);
  captionTimer = setTimeout(() => {
    els.videoCaption.textContent = faceLost ? "لم يتم اكتشاف الوجه — حسّن الإضاءة وقرّب وجهك" : DEFAULT_CAPTION;
    els.videoCaption.style.background = "";
  }, 900);
}

function startBlinkAndOverlayDetection() {
  const videoEl = document.getElementById("webgazerVideoFeed");
  if (!videoEl) { els.statusLine.textContent = "تعذر الوصول لفيديو الكاميرا لكشف الرمش"; return; }

  const faceMesh = new FaceMesh({ locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}` });
  faceMesh.setOptions({ maxNumFaces: 1, refineLandmarks: true, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
  faceMesh.onResults(onFaceMeshResults);

  let last = 0, busy = false;
  const myRun = cameraRunId;
  function loop(ts) {
    if (myRun !== cameraRunId) return;   // الكاميرا انغلقت: نوقف الحلقة
    // نحو 25 إطار بالثانية، وما نرسل إطار جديد قبل ما يخلص السابق (الرمشة سريعة وتحتاج إطارات كثيرة)
    if (!busy && ts - last > 40 && videoEl.readyState >= 2) {
      last = ts; busy = true;
      faceMesh.send({ image: videoEl }).catch(() => {}).finally(() => { busy = false; });
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

function onFaceMeshResults(results) {
  const ctx = els.overlayCanvas.getContext("2d");
  const w = els.videoWrap.clientWidth, h = els.videoWrap.clientHeight;
  els.overlayCanvas.width = w; els.overlayCanvas.height = h;
  ctx.clearRect(0, 0, w, h);

  if (!results.multiFaceLandmarks || !results.multiFaceLandmarks.length) {
    // الوجه ضاع: إذا كانت العين مغلقة (رمشة) نبقي الحالة "closing" ليُحسب الرمش عند رجوع الوجه (كان يضيع هنا)
    if (eyeState === "closing" && performance.now() - eyeClosedAt > 3000) { eyeState = "open"; closureHandled = false; }
    if (!faceLost) { faceLost = true; els.videoCaption.textContent = "لم يتم اكتشاف الوجه — حسّن الإضاءة وقرّب وجهك"; }
    return;
  }
  if (faceLost) { faceLost = false; els.videoCaption.textContent = DEFAULT_CAPTION; }
  const lm = results.multiFaceLandmarks[0];

  // صندوق تتبع الوجه + زوايا خضراء (الفيديو معكوس أفقيًا على الشاشة فقط عبر CSS)
  let minX = 1, maxX = 0, minY = 1, maxY = 0;
  for (const p of lm) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  const fx = (1 - maxX) * w, fy = minY * h, fw = (maxX - minX) * w, fh = (maxY - minY) * h;
  ctx.strokeStyle = "#22c55e"; ctx.lineWidth = 2;
  const c = 14;
  ctx.beginPath();
  ctx.moveTo(fx, fy + c); ctx.lineTo(fx, fy); ctx.lineTo(fx + c, fy);
  ctx.moveTo(fx + fw - c, fy); ctx.lineTo(fx + fw, fy); ctx.lineTo(fx + fw, fy + c);
  ctx.moveTo(fx + fw, fy + fh - c); ctx.lineTo(fx + fw, fy + fh); ctx.lineTo(fx + fw - c, fy + fh);
  ctx.moveTo(fx + c, fy + fh); ctx.lineTo(fx, fy + fh); ctx.lineTo(fx, fy + fh - c);
  ctx.stroke();

  // نقاط صغيرة حول العينين
  ctx.fillStyle = "#22d3ee";
  [LEFT_EYE, RIGHT_EYE].forEach((eye) => {
    [eye.top, eye.bottom, eye.cornerA, eye.cornerB].forEach((idx) => {
      const p = lm[idx];
      ctx.beginPath(); ctx.arc((1 - p.x) * w, p.y * h, 2.5, 0, 7); ctx.fill();
    });
  });

  // كشف الرمش
  const img = results.image || {};
  const vw = img.videoWidth || img.width || 640, vh = img.videoHeight || img.height || 480;
  const earAvg = (earFor(lm, LEFT_EYE, vw, vh) + earFor(lm, RIGHT_EYE, vw, vh)) / 2;
  processEar(earAvg, performance.now());
}

function processEar(ear, now) {
  if (eyeState === "open") {
    EAR_HISTORY.push(ear);
    if (EAR_HISTORY.length > 90) EAR_HISTORY.shift();
    if (EAR_HISTORY.length >= 15) {
      const sorted = [...EAR_HISTORY].sort((a, b) => a - b);
      earBase = sorted[Math.floor(sorted.length * 0.8)];   // قيمة "العين المفتوحة" الحالية
    }
  }
  if (EAR_HISTORY.length < 15) return;   // نحو نصف ثانية تعلّم أولية قبل ما نبدأ نكشف الرمش
  const closeT = earBase * 0.72, openT = earBase * 0.86;

  if (eyeState === "open") {
    if (ear < closeT) { eyeState = "closing"; eyeClosedAt = now; closureHandled = false; }
  } else if (ear > openT) {
    eyeState = "open";
    if (!closureHandled && now - eyeClosedAt <= MAX_BLINK_MS) onBlinkDetected(eyeClosedAt);
    closureHandled = false;
  } else if (now - eyeClosedAt > 3000) {
    eyeState = "open"; EAR_HISTORY.length = 0; closureHandled = false;   // علقت الحالة: نرجّعها
  } else if (!closureHandled && now - eyeClosedAt >= HOLD_CONFIRM_MS &&
             (calibActive ? (calibArmed && eyeClosedAt >= calibArmedAt)
                          : (detectMode && armed && focusedKey && eyeClosedAt >= armedAt))) {
    closureHandled = true;           // الحرف جاهز والعين مغلقة مدة كافية: نؤكد الآن
    onBlinkDetected(eyeClosedAt);
  }
  if (DEBUG) els.statusLine.textContent =
    `EAR ${ear.toFixed(3)} | أساس ${earBase.toFixed(3)} | إغلاق < ${closeT.toFixed(3)} | فتح > ${openT.toFixed(3)} | ${eyeState}`;
}

function onBlinkDetected(closedAt) {
  const now = performance.now();
  if (now < blinkCooldownUntil) return;
  blinkCooldownUntil = now + 500;

  if (calibActive) {
    // الرمشة تُحسب فقط إذا بدأت بعد ما صارت النقطة جاهزة (خضراء)
    if (calibArmed && closedAt >= calibArmedAt) { flashCaption("✓ تم اكتشاف الرمشة", true); confirmCalibDot(); }
    else flashCaption("رمشة — انتظر لين يكتمل التثبيت", false);
    return;
  }
  if (!detectMode) { flashCaption("✓ الرمشة تشتغل", true); return; }
  if (armed && focusedKey && closedAt >= armedAt) {
    flashCaption("✓ تم اكتشاف الرمشة", true);
    selectKey(focusedKey);
  } else {
    flashCaption("رمشة — ثبّت نظرك على الحرف أولاً", false);
  }
}

try {
  const draft = sessionStorage.getItem("eyetext_draft");
  if (draft) { typedText = draft; sessionStorage.removeItem("eyetext_draft"); }
} catch (e) {}

// للتجربة ولمرافق المستخدم: الضغط بالماوس على الحرف يضيفه لمربع الجملة مباشرة (لا يُسجَّل في قاعدة البيانات)
els.keyboard.addEventListener("click", (e) => {
  const keyEl = e.target.closest(".key");
  if (!keyEl || !detectMode) return;
  const { type, value } = keyEl.dataset;
  if (type === "letter") typedText += value;
  else if (value === "space") typedText += " ";
  else if (value === "backspace") typedText = typedText.slice(0, -1);
  else if (value === "clear") typedText = "";
  renderOutput();
  keyEl.classList.add("selected");
  setTimeout(() => keyEl.classList.remove("selected"), 350);
});

// ---------------- ضبط الدقة (تصحيح انحراف النظر بنقطة واحدة) ----------------
// تقدير النظر غالبًا فيه انحراف ثابت (يشوفك تنظر لحرف وأنت تنظر للي جنبه).
// نعرض نقطة صفراء في وسط اللوحة، ونقيس الفرق بين نظرك وموقعها، ونطبّقه على كل النظر بعدها.
function runDriftCorrection() {
  if (driftActive || !detectMode || !cameraOn) return;
  driftActive = true;
  clearFocus();
  const kb = els.keyboard.getBoundingClientRect();
  const tx = kb.left + kb.width / 2, ty = kb.top + kb.height / 2;
  const dot = document.createElement("div");
  dot.style.cssText = "position:fixed;width:34px;height:34px;border-radius:50%;background:#F5C518;border:4px solid #1B1F5E;box-shadow:0 0 0 12px rgba(245,197,24,.35);z-index:99998;pointer-events:none;transform:translate(-50%,-50%)";
  dot.style.left = tx + "px"; dot.style.top = ty + "px";
  document.body.appendChild(dot);
  const samples = [], t0 = performance.now();
  const timer = setInterval(() => {
    const t = performance.now() - t0;
    if (t < 1200) { els.blinkHint.textContent = "انظر إلى النقطة الصفراء في وسط اللوحة..."; return; }
    if (rawSm) samples.push({ x: rawSm.x, y: rawSm.y });
    els.blinkHint.textContent = "ثبّت نظرك على النقطة الصفراء... " + Math.max(0, Math.ceil((4200 - t) / 1000));
    if (t < 4200) return;
    clearInterval(timer); dot.remove(); driftActive = false;
    if (samples.length >= 10) {
      const med = (arr) => { const a = [...arr].sort((m, n) => m - n); return a[Math.floor(a.length / 2)]; };
      const dx = tx - med(samples.map((p) => p.x)), dy = ty - med(samples.map((p) => p.y));
      const lim = Math.min(window.innerWidth, window.innerHeight) * 0.3;
      if (Math.hypot(dx, dy) > lim) showToast("ما انضبطت الدقة (كان نظرك بعيد عن النقطة)، اضغط 🎯 ضبط الدقة وجرّب مرة ثانية");
      else { gazeOffset = { x: dx, y: dy }; smoothed = null; KEY_SCORES.clear(); showToast("تم ضبط الدقة ✓"); }
    } else showToast("ما انضبطت الدقة، جرّب مرة ثانية");
    clearFocus();
  }, 100);
}
els.btnStartDetect.addEventListener("click", () => setTimeout(runDriftCorrection, 700));
(function addDriftButton() {
  if (document.getElementById("btn-drift")) return;
  const b = document.createElement("button");
  b.id = "btn-drift"; b.className = "btn-ghost btn-big"; b.textContent = "🎯 ضبط الدقة";
  const anchor = document.getElementById("btn-camera-off") || document.getElementById("btn-start-detect");
  if (anchor && anchor.parentNode) anchor.insertAdjacentElement("afterend", b);
})();
document.addEventListener("click", (e) => { if (e.target.closest && e.target.closest("#btn-drift")) runDriftCorrection(); });

// تأكيد احتياطي: إذا صار الحرف جاهزًا (ارمش الآن) تقدر تأكده بزر Enter أو المسافة (مفيد للتجربة ولمرافق المستخدم)
document.addEventListener("keydown", (e) => {
  if (armed && focusedKey && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); selectKey(focusedKey); }
});

// ---------------- أزرار إضافية ----------------
els.btnClear.addEventListener("click", () => { typedText = ""; renderOutput(); });
els.btnSave.addEventListener("click", async () => {
  const say = (t) => { els.statusLine.textContent = t; setTimeout(() => (els.statusLine.textContent = ""), 2500); };
  if (!typedText.trim()) { say("اكتب جملة أولاً"); return; }
  const res = await apiAuth("/api/message", { full_text: typedText });
  if (res.ok) { lastSavedText = typedText; say("تم حفظ النص ✓ — تجده في «النصوص السابقة»"); }
  else say("تعذر حفظ النص");
});
els.toggleCam.addEventListener("change", () => {
  els.videoWrap.style.visibility = els.toggleCam.checked ? "visible" : "hidden";
});
els.btnLogout.addEventListener("click", async () => {
  // لا نخلي نصًا مكتوبًا يضيع: نحفظه قبل الخروج إذا ما انحفظ
  if (typedText.trim() && typedText !== lastSavedText) { try { await api("/api/message", { full_text: typedText }); } catch (e) {} }
  await api("/api/logout");
  localStorage.removeItem("gaze_token"); localStorage.removeItem("gaze_user_name"); localStorage.removeItem("gaze_user_id");
  window.location.href = "login.html";
});

// ---------------- التنقل بين الصفحات (كلها داخل نفس الصفحة، ما تنفتح صفحة ثانية) ----------------
const VIEWS = ["home", "history", "settings", "help"];
function showView(name) {
  VIEWS.forEach((v) => { el("view-" + v).hidden = v !== name; });
  document.querySelectorAll("#nav .nav-item").forEach((a) => a.classList.toggle("active", a.dataset.view === name));
  el("app").classList.toggle("wide", name !== "home");
  el("right-panel").hidden = name !== "home";
  if (name === "history") loadHistory();
  if (name === "settings") loadProfile();
  window.scrollTo(0, 0);
}
document.querySelectorAll("#nav .nav-item").forEach((a) =>
  a.addEventListener("click", (e) => { e.preventDefault(); showView(a.dataset.view); }));

const setMsg = (node, text, ok) => { node.textContent = text; node.style.color = ok ? "#16a34a" : "#dc2626"; };
function mkBtn(label, onClick, extra = "") {
  const b = document.createElement("button");
  b.className = "btn-ghost " + extra; b.textContent = label;
  b.addEventListener("click", () => onClick(b));
  return b;
}

// ----- النصوص السابقة -----
async function loadHistory() {
  const box = el("history-list");
  box.textContent = "جاري التحميل...";
  const res = await apiAuth("/api/texts");
  if (!res.ok) { box.textContent = res.error || "تعذر تحميل النصوص"; return; }
  renderHistory(res.texts);
}
function renderHistory(texts) {
  const box = el("history-list");
  box.textContent = "";
  if (!texts.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "لم يتم حفظ نصوص إلى الآن. اكتب جملة في الصفحة الرئيسية واضغط «حفظ النص».";
    box.append(p);
    return;
  }
  texts.forEach((t) => {
    const item = document.createElement("div"); item.className = "hist-item";
    const txt = document.createElement("div"); txt.className = "hist-text"; txt.textContent = t.text;
    const meta = document.createElement("div"); meta.className = "hist-meta"; meta.textContent = t.created_at;
    const actions = document.createElement("div"); actions.className = "hist-actions";
    actions.append(
      mkBtn("📋 نسخ", async (b) => {
        try { await navigator.clipboard.writeText(t.text); b.textContent = "✓ تم النسخ"; }
        catch (e) { b.textContent = "تعذر النسخ"; }
        setTimeout(() => (b.textContent = "📋 نسخ"), 1500);
      }),
      mkBtn("✍️ استخدام", () => { typedText = t.text; lastSavedText = t.text; renderOutput(); showView("home"); }),
      mkBtn("🗑 حذف", async () => {
        if (!confirm("حذف هذا النص نهائيًا؟")) return;
        const res = await apiAuth("/api/text_delete", { message_id: t.message_id });
        if (res.ok) { item.remove(); if (!box.children.length) renderHistory([]); }
        else alert(res.error || "تعذر الحذف");
      }, "danger"),
    );
    item.append(txt, meta, actions);
    box.append(item);
  });
}

// ----- الإعدادات: الحساب -----
const ROLE_LABELS = { patient: "مستخدم", caregiver: "مرافق", admin: "مدير" };
async function loadProfile() {
  syncPrefsUI();
  const res = await apiAuth("/api/profile");
  if (!res.ok) { setMsg(el("msg-profile"), res.error || "تعذر تحميل بيانات الحساب", false); return; }
  const p = res.profile, st = res.stats;
  el("set-name").value = p.full_name;
  el("set-email").value = p.email;
  el("set-cur-email").value = "";
  el("acc-line").textContent = `${p.full_name} · ${p.email} · ${ROLE_LABELS[p.role] || p.role}`;
  el("st-sessions").textContent = st.sessions;
  el("st-texts").textContent = st.texts;
  el("st-letters").textContent = st.letters;
  el("st-since").textContent = (p.created_at || "").split(" ")[0] || "—";
}
el("btn-save-profile").addEventListener("click", async () => {
  const msg = el("msg-profile"); setMsg(msg, "", true);
  const res = await apiAuth("/api/profile_update", {
    full_name: el("set-name").value, email: el("set-email").value, current_password: el("set-cur-email").value,
  });
  if (!res.ok) { setMsg(msg, res.error || "تعذر الحفظ", false); return; }
  localStorage.setItem("gaze_user_name", res.full_name);
  els.userName.textContent = res.full_name;
  await loadProfile();
  setMsg(msg, "تم حفظ البيانات ✓", true);
});
el("btn-change-pw").addEventListener("click", async () => {
  const msg = el("msg-pw"); setMsg(msg, "", true);
  const cur = el("pw-cur").value, nw = el("pw-new").value, nw2 = el("pw-new2").value;
  if (nw.length < 4) { setMsg(msg, "كلمة المرور الجديدة 4 أحرف على الأقل", false); return; }
  if (nw !== nw2) { setMsg(msg, "كلمتا المرور الجديدتان غير متطابقتين", false); return; }
  const res = await apiAuth("/api/password_change", { current_password: cur, new_password: nw });
  if (!res.ok) { setMsg(msg, res.error || "تعذر التغيير", false); return; }
  el("pw-cur").value = el("pw-new").value = el("pw-new2").value = "";
  setMsg(msg, "تم تغيير كلمة المرور ✓", true);
});

// ----- الإعدادات: التفضيلات (تُحفظ على هذا المتصفح) -----
function setTheme(t) { document.body.setAttribute("data-theme", t); localStorage.setItem("eyetext_theme", t); }
el("theme-light").addEventListener("click", () => setTheme("light"));
el("theme-dark").addEventListener("click", () => setTheme("dark"));

function syncPrefsUI() {
  el("pref-font").value = els.fontSlider.value; el("pref-font-val").textContent = els.fontSlider.value;
  el("pref-dwell").value = els.dwellSlider.value; el("pref-dwell-val").textContent = els.dwellSlider.value;
}
el("pref-font").addEventListener("input", () => {
  els.fontSlider.value = el("pref-font").value;
  els.fontSlider.dispatchEvent(new Event("input"));
  el("pref-font-val").textContent = el("pref-font").value;
});
el("pref-dwell").addEventListener("input", () => {
  els.dwellSlider.value = el("pref-dwell").value;
  els.dwellSlider.dispatchEvent(new Event("input"));
  el("pref-dwell-val").textContent = el("pref-dwell").value;
});
els.fontSlider.addEventListener("input", () => localStorage.setItem("eyetext_font", els.fontSlider.value));
els.dwellSlider.addEventListener("input", () => localStorage.setItem("eyetext_dwell", els.dwellSlider.value));
for (const [key, slider] of [["eyetext_font", els.fontSlider], ["eyetext_dwell", els.dwellSlider]]) {
  const saved = localStorage.getItem(key);
  if (saved) { slider.value = saved; slider.dispatchEvent(new Event("input")); }
}

// ---------------- البدء ----------------
setupCalibration();
renderOutput();
startWebgazer().catch((e) => {
  const denied = e && (e.name === "NotAllowedError" || /permission|denied/i.test(e.message || ""));
  els.statusLine.textContent = denied
    ? "تم رفض إذن الكاميرا — اسمح بها من أيقونة القفل بجانب الرابط في Chrome ثم أعد تحميل الصفحة"
    : "تعذر تشغيل الكاميرا: " + ((e && e.message) || e);
});
