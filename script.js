/*
  script.js — EyeText
  1) تسجيل الدخول: التحقق من رمز الجلسة، وإلا توجيه لصفحة الدخول.
  2) المظهر: تبديل الوضع الفاتح/الداكن، وحجم خط النص المكتوب.
  3) المعايرة: 9 نقاط بالنقر (تظهر في شاشة كاملة)، مع شريط تقدم مصغّر داخل البطاقة.
  4) تتبع العين: WebGazer لنقطة النظر + MediaPipe FaceMesh لرسم إطار تتبع الوجه وكشف الرمش.
  5) الكتابة: بعد الضغط على "بدء التحديد بالعين" تتحول البطاقة من المعايرة إلى لوحة حروف،
     تثبيت 5 ثواني على حرف ثم رمشة تؤكد اختياره وتضيفه لمربع النص.
  6) كل معايرة وكل حرف وكل حفظ نص يُسجَّل بقاعدة البيانات عبر server.py.
*/

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

const LETTERS = [
  "ا","ب","ت","ث","ج","ح","خ","د","ذ","ر","ز","س",
  "ش","ص","ض","ط","ظ","ع","غ","ف","ق","ك","ل","م",
  "ن","ه","و","ي",
];

const el = (id) => document.getElementById(id);
const els = {
  userName: el("user-name"), btnLogout: el("btn-logout"),
  themeToggle: el("theme-toggle"),
  camStatus: el("cam-status"),
  videoWrap: el("video-wrap"), overlayCanvas: el("overlay-canvas"),
  calibPanel: el("calib-panel"), keyboardPanel: el("keyboard-panel"),
  btnStartCalib: el("btn-start-calib"), calibSteps: [...document.querySelectorAll("#calib-steps .step")],
  btnStartDetect: el("btn-start-detect"),
  keyboard: el("keyboard"), blinkHint: el("blink-hint"),
  outputText: el("output-text"), charCount: el("char-count"),
  btnClear: el("btn-clear"), btnSave: el("btn-save"),
  fontSlider: el("font-size-slider"), dwellSlider: el("dwell-slider"), toggleCam: el("toggle-cam"),
  calibOverlay: el("calibration-overlay"), calibMsg: el("calib-msg"),
  calibGrid: el("calib-grid"), calibDots: [...document.querySelectorAll(".calib-dot")],
  calibProgress: el("calib-progress"),
  statusLine: el("status-line"),
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
const CLICKS_PER_DOT = 5;
let dwellMs = Number(els.dwellSlider.value) * 1000;
let smoothed = null;
const ALPHA = 0.25;

let calibrationDone = false;
let detectMode = false;
let typedText = "";
let letterSeq = 0;
let focusedKey = null, focusSince = 0, armed = false, cooldownUntil = 0;

els.dwellSlider.addEventListener("input", () => {
  dwellMs = Number(els.dwellSlider.value) * 1000;
});

// ---------------- بناء لوحة الحروف ----------------
function buildKeyboard() {
  const specials = [
    { label: "␣ مسافة", action: "space" },
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

// ---------------- المعايرة (9 نقاط بنقرة كاملة الشاشة) ----------------
function setupCalibration() {
  els.calibDots.forEach((dot) => {
    dot._clicks = 0;
    dot.addEventListener("click", () => {
      dot._clicks++;
      if (dot._clicks >= CLICKS_PER_DOT) { dot.classList.add("done"); dot.disabled = true; }
      const total = els.calibDots.reduce((s, d) => s + Math.min(d._clicks, CLICKS_PER_DOT), 0);
      const max = CLICKS_PER_DOT * els.calibDots.length;
      els.calibProgress.textContent = `${total} / ${max}`;
      updateMiniSteps(total / max);
      if (total >= max) finishCalibration();
    });
  });
}
function updateMiniSteps(fraction) {
  const litCount = Math.round(fraction * els.calibSteps.length);
  els.calibSteps.forEach((s, i) => s.classList.toggle("on", i < litCount));
}
function finishCalibration() {
  els.calibOverlay.style.display = "none";
  calibrationDone = true;
  els.btnStartDetect.disabled = false;
  els.statusLine.textContent = "تمت المعايرة — اضغطي بدء التحديد بالعين";
  api("/api/calibration", { points_count: CLICKS_PER_DOT * els.calibDots.length });
}
els.btnStartCalib.addEventListener("click", () => {
  els.calibDots.forEach((d) => { d.classList.remove("done"); d.disabled = false; d._clicks = 0; });
  els.calibProgress.textContent = `0 / ${CLICKS_PER_DOT * els.calibDots.length}`;
  updateMiniSteps(0);
  els.calibOverlay.style.display = "flex";
});

// ---------------- بدء التحديد بالعين (تحويل البطاقة للوحة حروف) ----------------
els.btnStartDetect.addEventListener("click", () => {
  if (!calibrationDone) return;
  detectMode = true;
  els.calibPanel.hidden = true;
  els.keyboardPanel.hidden = false;
  if (!els.keyboard.children.length) buildKeyboard();
  els.btnStartDetect.disabled = true;
  els.btnStartDetect.textContent = "✓ التحديد يعمل الآن";
});

// ---------------- تشغيل WebGazer + عرض الكاميرا داخل البطاقة ----------------
async function startWebgazer() {
  els.statusLine.textContent = "جاري تشغيل الكاميرا...";
  await webgazer.setRegression("ridge").setGazeListener(onGaze).saveDataAcrossSessions(true).begin();
  webgazer.showPredictionPoints(false);
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
  els.statusLine.textContent = "جاهزة — اضغطي بدء المعايرة";
}

function onGaze(data) {
  if (!data) return;
  const raw = { x: data.x, y: data.y };
  smoothed = smoothed
    ? { x: ALPHA * raw.x + (1 - ALPHA) * smoothed.x, y: ALPHA * raw.y + (1 - ALPHA) * smoothed.y }
    : raw;
  if (detectMode) handleGazePoint(smoothed.x, smoothed.y);
}

// ---------------- التثبيت + الاستعداد (Armed) ----------------
function handleGazePoint(x, y) {
  const node = document.elementFromPoint(x, y);
  const keyEl = node ? node.closest(".key") : null;
  if (!keyEl) { clearFocus(); return; }

  if (keyEl !== focusedKey) {
    clearFocus();
    focusedKey = keyEl; focusSince = performance.now();
    focusedKey.classList.add("focused");
  }
  if (performance.now() < cooldownUntil || armed) return;

  const elapsed = performance.now() - focusSince;
  focusedKey.querySelector(".progress-fill").style.width = Math.min(100, (elapsed / dwellMs) * 100) + "%";

  if (elapsed >= dwellMs) {
    armed = true;
    focusedKey.classList.remove("focused");
    focusedKey.classList.add("armed");
    els.blinkHint.textContent = "ارمش الآن لتأكيد: " + focusedKey.querySelector("span").textContent;
  }
}
function clearFocus() {
  if (focusedKey) { focusedKey.classList.remove("focused", "armed"); focusedKey.querySelector(".progress-fill").style.width = "0%"; }
  focusedKey = null; armed = false;
  els.blinkHint.textContent = "انظر لحرف 5 ثواني ثم ارمش للتأكيد";
}
function selectKey(keyEl) {
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
  api("/api/message", { full_text: typedText });

  cooldownUntil = performance.now() + 700;
  clearFocus();
}
function renderOutput() {
  els.outputText.textContent = typedText;
  els.charCount.textContent = typedText.length + " حرف";
}

// ---------------- كشف الرمش + رسم إطار التتبع (MediaPipe FaceMesh) ----------------
const LEFT_EYE = { top: 159, bottom: 145, cornerA: 33, cornerB: 133 };
const RIGHT_EYE = { top: 386, bottom: 374, cornerA: 362, cornerB: 263 };
const CLOSE_T = 0.16, OPEN_T = 0.22;
let eyeState = "open", blinkCooldownUntil = 0;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const earFor = (lm, eye) => dist(lm[eye.top], lm[eye.bottom]) / (dist(lm[eye.cornerA], lm[eye.cornerB]) + 1e-6);

function startBlinkAndOverlayDetection() {
  const videoEl = document.getElementById("webgazerVideoFeed");
  if (!videoEl) return;

  const faceMesh = new FaceMesh({ locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}` });
  faceMesh.setOptions({ maxNumFaces: 1, refineLandmarks: true, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
  faceMesh.onResults(onFaceMeshResults);

  let last = 0;
  function loop(ts) {
    if (ts - last > 66 && videoEl.readyState >= 2) { last = ts; faceMesh.send({ image: videoEl }); }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

function onFaceMeshResults(results) {
  const ctx = els.overlayCanvas.getContext("2d");
  const w = els.videoWrap.clientWidth, h = els.videoWrap.clientHeight;
  els.overlayCanvas.width = w; els.overlayCanvas.height = h;
  ctx.clearRect(0, 0, w, h);

  if (!results.multiFaceLandmarks || !results.multiFaceLandmarks.length) return;
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
  const earAvg = (earFor(lm, LEFT_EYE) + earFor(lm, RIGHT_EYE)) / 2;
  if (eyeState === "open" && earAvg < CLOSE_T) eyeState = "closing";
  else if (eyeState === "closing" && earAvg > OPEN_T) { eyeState = "open"; onBlinkDetected(); }
}
function onBlinkDetected() {
  if (performance.now() < blinkCooldownUntil) return;
  blinkCooldownUntil = performance.now() + 500;
  if (detectMode && armed && focusedKey) selectKey(focusedKey);
}

// ---------------- أزرار إضافية ----------------
els.btnClear.addEventListener("click", () => { typedText = ""; renderOutput(); api("/api/message", { full_text: "" }); });
els.btnSave.addEventListener("click", async () => {
  await api("/api/message", { full_text: typedText });
  els.statusLine.textContent = "تم حفظ النص ✓";
  setTimeout(() => (els.statusLine.textContent = ""), 1800);
});
els.toggleCam.addEventListener("change", () => {
  els.videoWrap.style.visibility = els.toggleCam.checked ? "visible" : "hidden";
});
els.btnLogout.addEventListener("click", async () => {
  await api("/api/logout");
  localStorage.removeItem("gaze_token"); localStorage.removeItem("gaze_user_name"); localStorage.removeItem("gaze_user_id");
  window.location.href = "login.html";
});

// ---------------- البدء ----------------
setupCalibration();
renderOutput();
startWebgazer().catch((e) => { els.statusLine.textContent = "تعذر تشغيل الكاميرا: " + e.message; });
