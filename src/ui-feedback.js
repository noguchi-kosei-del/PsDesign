const $ = (id) => document.getElementById(id);

// CSS の transition と一致させる。閉じるアニメーション完了後に hidden=true とする。
export const MODAL_ANIM_MS = 220;

// 中央モーダルを「奥から手前」アニメーションで開閉するヘルパー。
// CSS 側で `.<modal-class> { opacity:0; transition:opacity }` と
// `.<modal-class>.visible { opacity:1 }`、`.card { transform: scale(0.92); transition:transform }` と
// `.<modal-class>.visible .card { transform: scale(1) }` を定義しておく前提。
//
// 連続呼び出し時の競合（fade-out 中に次の open が来る）に耐えるため、
// hideModalAnimated は最後に .visible を持っていなければ hidden=true、持っていれば
// 次の open に上書きされたとみなして hidden を維持する。
export function showModalAnimated(el) {
  if (!el) return;
  el.hidden = false;
  // hidden 解除と同フレームに .visible を付けるとブラウザが初期状態を確定する前に
  // 終端状態へ飛んで transition が効かないため、2 フレーム遅らせる。
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      el.classList.add("visible");
    });
  });
}

export function hideModalAnimated(el, ms = MODAL_ANIM_MS) {
  if (!el) return;
  el.classList.remove("visible");
  setTimeout(() => {
    if (!el.classList.contains("visible")) el.hidden = true;
  }, ms);
}

// 12 ドット円形 spinner。`#progress-icon` の innerHTML に直接挿入する HTML 断片。
// 各 dot は CSS の nth-child セレクタで配置 (rotate(N×30deg) translateY(-22px))・
// fade animation の delay (-N×0.1s) を持ち、回転して見える。
const DEFAULT_SPINNER_HTML = `<div class="progress-spinner">${
  "<div class=\"spinner-dot\"></div>".repeat(12)
}</div>`;

const OPUS_PROGRESS_HTML = `
  <div class="opus-progress-stage" aria-hidden="true">
    <div class="opus-cosmic-clouds">
      <div class="opus-cloud opus-cloud-purple"></div>
      <div class="opus-cloud opus-cloud-pink"></div>
      <div class="opus-cloud opus-cloud-teal"></div>
      <div class="opus-cloud-bulge opus-bulge-1"></div>
      <div class="opus-cloud-bulge opus-bulge-2"></div>
    </div>
    <div class="opus-milky-glow"></div>
    <div class="opus-bg-stars"></div>
    <svg class="opus-constellation-svg" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true"></svg>
    <div class="opus-star-field"></div>
    <div class="opus-top-banner">
      <div class="opus-chapter">
        <div class="opus-chapter-num">I</div>
        <div class="opus-chapter-name">準備中</div>
        <div class="opus-chapter-name-en">standby</div>
      </div>
      <div class="opus-counter">
        <span class="opus-counter-current">0</span>
        <span class="opus-counter-sep">/</span>
        <span class="opus-counter-total">100</span>
      </div>
    </div>
  </div>
`;

const OPUS_PROGRESS_VARIANTS = new Set(["scan", "place"]);
const OPUS_MILKY_COUNT = 240;
const OPUS_AMBIENT_COUNT = 90;
const OPUS_IDLE_CAP_PCT = 98.4;
const OPUS_CONSTELLATION_POINTS = [
  [0.18, 0.24, true], [0.27, 0.31, false], [0.35, 0.22, false], [0.43, 0.36, true],
  [0.58, 0.24, true], [0.67, 0.33, false], [0.73, 0.45, true],
  [0.22, 0.62, true], [0.32, 0.54, false], [0.42, 0.64, false], [0.52, 0.57, true],
  [0.64, 0.70, false], [0.76, 0.62, true],
];
const OPUS_CONSTELLATION_LINES = [
  [0, 1], [1, 2], [1, 3], [4, 5], [5, 6],
  [7, 8], [8, 9], [9, 10], [10, 11], [11, 12],
  [3, 10], [6, 12],
];

const opusProgress = {
  active: false,
  variant: null,
  raf: null,
  detectionTimer: null,
  shootTimer: null,
  milkyStars: [],
  milkyRevealed: 0,
  spawnedStars: 0,
  drawnLines: new Set(),
  targetPct: 0,
  visualPct: 0,
  phaseStartPct: 0,
  phaseEndPct: 86,
  phaseKey: "",
  phaseSerial: 0,
  lastRawPct: null,
  lastTargetAdvanceAt: 0,
  finishing: false,
  indeterminate: false,
  lastFrameAt: 0,
};

// 直前の hideProgress 閉じアニメをキャンセルするためのタイマー ID。
// 閉じ→即開く（loadReferenceFiles 完了直後に runScanExtract が show する等）の連続呼び出しで
// 古い setTimeout が後から発火して新しい表示を hidden にしてしまう事故を防ぐ。
let pendingHideTimer = null;

// icon: SVG 文字列を直接挿入する（呼び出し側で <svg>...</svg> をそのまま渡す）。
//   undefined / 省略 → デフォルト spinner（PSD 読込・見本読込・Photoshop 反映 等）
//   null              → アイコン領域空 (非表示)
//   "<svg>...</svg>"  → カスタムアイコン
export function showProgress({ title, label, detail, current, total, showCount, icon, variant } = {}) {
  const modal = $("progress-modal");
  if (!modal) return;
  // 直前の hideProgress が閉じアニメ中なら割り込みキャンセル。
  if (pendingHideTimer != null) {
    clearTimeout(pendingHideTimer);
    pendingHideTimer = null;
  }
  if (modal.classList.contains("closing")) {
    modal.classList.remove("closing");
    modal.style.removeProperty("--bar-top");
  }
  const displayTitle = title ?? label;
  const progressVariant = normalizeOpusProgressVariant(variant)
    || inferOpusProgressVariant({ title: displayTitle, label, icon });
  setOpusProgressMode(progressVariant, {
    phaseKey: makeOpusProgressPhaseKey({ title: displayTitle, detail, variant: progressVariant }),
  });
  showModalAnimated(modal);
  if (displayTitle != null) $("progress-title").textContent = displayTitle;
  setProgressIcon(progressVariant ? null : (icon === undefined ? DEFAULT_SPINNER_HTML : icon));
  updateProgress({ detail, current, total, showCount });
}

// アイコンを差し替える（呼び出し中に切替えたい場合の補助 API）。
// null / undefined / 空文字を渡すとアイコン領域はクリア。デフォルト spinner に
// 戻したい場合は呼び出し側で DEFAULT_SPINNER_HTML を再渡してください。
export function setProgressIcon(svgString) {
  const el = $("progress-icon");
  if (!el) return;
  el.innerHTML = svgString || "";
}

// showCount: 既定 true。false を渡したときは detail があれば detail を、なければ空を
//            進捗バー内テキストに表示する（画像スキャン の "残り 30 秒" など独自整形向け）。
// バー幅は current/total から計算し fill.style.width に直接反映する（実進捗駆動）。
// 現在/総数が無い場合は .indeterminate を付与してバー満タン表示にし、フラッシュで進行感を出す。
//
// 二重表示対策: showCount: false の経路では detail を progress-loading-text 側だけに反映し、
// 中央テキスト (progress-detail) はクリアする。これがないと「画像スキャン中…」のようにバーと
// 中央の両方に同じ進捗テキストが並んで重複表示される。
export function updateProgress({ detail, current, total, showCount = true } = {}) {
  if (detail != null) {
    $("progress-detail").textContent = showCount ? detail : "";
  }
  const fill = $("progress-fill");
  const loadingText = $("progress-loading-text");
  if (typeof current === "number" && typeof total === "number" && total > 0) {
    const pct = Math.max(0, Math.min(100, (current / total) * 100));
    if (fill) {
      fill.style.width = `${pct}%`;
      fill.classList.remove("indeterminate");
    }
    if (loadingText) {
      if (showCount) {
        const remaining = Math.max(0, total - current);
        loadingText.textContent = `残り ${remaining} ページ ・ ${Math.round(pct)} %`;
      } else {
        // 呼び出し側が detail に進捗テキストを集約しているケース
        loadingText.textContent = detail || "";
      }
    }
  } else {
    if (fill) {
      fill.style.width = "";
      fill.classList.add("indeterminate");
    }
    if (loadingText) {
      // indeterminate (起動中など) は detail があればそれ、なければ "LOADING..." のフォールバック。
      loadingText.textContent = detail || "LOADING...";
    }
  }
  updateOpusProgress({ detail, current, total });
}

function normalizeOpusProgressVariant(variant) {
  return OPUS_PROGRESS_VARIANTS.has(variant) ? variant : null;
}

function inferOpusProgressVariant({ title, label, icon } = {}) {
  const text = `${title ?? ""} ${label ?? ""}`;
  if (text.includes("自動配置") || text.includes("位置検出") || text.includes("位置調整") || text.includes("重ね調整")) {
    return "place";
  }
  if (text.includes("画像スキャン")) return "scan";
  if (typeof icon === "string") {
    if (icon.includes("place-icon")) return "place";
    if (icon.includes("scan-icon")) return "scan";
  }
  return null;
}

function isOpusProgressActive(modal = $("progress-modal")) {
  return !!modal?.classList.contains("opus-progress-active");
}

function makeOpusProgressPhaseKey({ title, detail, variant } = {}) {
  if (!variant) return "";
  const normalizedDetail = String(detail ?? "")
    .replace(/\d+\s*\/\s*\d+/g, "#/#")
    .replace(/\d+\s*%/g, "#%")
    .replace(/\d+/g, "#")
    .slice(0, 64);
  return `${variant}|${title ?? ""}|${normalizedDetail}`;
}

function initialOpusPhaseEnd(variant) {
  return variant === "scan" ? 78 : 72;
}

function maxOpusPhaseEnd(variant) {
  return variant === "scan" ? 92 : 94;
}

function setOpusPhaseWindow({ start, end, key }) {
  const maxEnd = maxOpusPhaseEnd(opusProgress.variant);
  opusProgress.phaseStartPct = Math.max(0, Math.min(maxEnd - 1, start));
  opusProgress.phaseEndPct = Math.max(
    opusProgress.phaseStartPct + 1,
    Math.min(maxEnd, end),
  );
  opusProgress.phaseKey = key ?? opusProgress.phaseKey;
  opusProgress.targetPct = Math.min(
    Math.max(opusProgress.targetPct, opusProgress.phaseStartPct),
    opusProgress.phaseEndPct,
  );
  opusProgress.visualPct = Math.min(opusProgress.visualPct, opusProgress.phaseEndPct);
}

function setOpusTargetPct(pct, at = performance.now()) {
  const next = Math.max(opusProgress.targetPct, Math.min(100, pct));
  if (next > opusProgress.targetPct + 0.01) {
    opusProgress.targetPct = next;
    opusProgress.lastTargetAdvanceAt = at;
  }
}

function advanceOpusProgressPhase(key) {
  if (!opusProgress.active) return;
  const maxEnd = maxOpusPhaseEnd(opusProgress.variant);
  const current = Math.max(opusProgress.visualPct, opusProgress.targetPct, opusProgress.phaseStartPct);
  const start = Math.min(maxEnd - 2, Math.max(current, opusProgress.phaseStartPct));
  const nextSpan = opusProgress.variant === "scan" ? 12 : 14;
  const end = Math.min(maxEnd, Math.max(opusProgress.phaseEndPct + nextSpan, start + 6));
  setOpusPhaseWindow({ start, end, key });
  opusProgress.phaseSerial += 1;
  opusProgress.lastRawPct = null;
  opusProgress.indeterminate = true;
}

function mapOpusProgressPct(rawPct) {
  const start = opusProgress.phaseStartPct;
  const span = Math.max(1, opusProgress.phaseEndPct - start);
  const pct = Math.max(0, Math.min(100, rawPct));
  return start + (pct / 100) * span;
}

function ensureOpusProgressStage() {
  const card = $("progress-modal")?.querySelector(".progress-card");
  if (!card) return null;
  let stage = card.querySelector(".opus-progress-stage");
  if (!stage) {
    card.insertAdjacentHTML("afterbegin", OPUS_PROGRESS_HTML);
    stage = card.querySelector(".opus-progress-stage");
  }
  return stage;
}

function setOpusProgressMode(variant, { phaseKey = "" } = {}) {
  const modal = $("progress-modal");
  if (!modal) return;
  if (!variant) {
    modal.classList.remove("opus-progress-active");
    delete modal.dataset.progressVariant;
    stopOpusProgress();
    return;
  }
  const currentVariant = normalizeOpusProgressVariant(modal.dataset.progressVariant);
  if (currentVariant === variant && opusProgress.active) {
    modal.classList.add("opus-progress-active");
    if (phaseKey && phaseKey !== opusProgress.phaseKey) {
      advanceOpusProgressPhase(phaseKey);
    }
    return;
  }
  modal.classList.add("opus-progress-active");
  modal.dataset.progressVariant = variant;
  resetOpusProgress(variant, phaseKey);
}

function resetOpusProgress(variant, phaseKey = "") {
  stopOpusProgress({ keepDom: true });
  const stage = ensureOpusProgressStage();
  if (!stage) return;
  opusProgress.active = true;
  opusProgress.variant = variant;
  opusProgress.milkyStars = [];
  opusProgress.milkyRevealed = 0;
  opusProgress.spawnedStars = 0;
  opusProgress.drawnLines = new Set();
  opusProgress.targetPct = 0;
  opusProgress.visualPct = 0;
  opusProgress.phaseStartPct = 0;
  opusProgress.phaseEndPct = initialOpusPhaseEnd(variant);
  opusProgress.phaseKey = phaseKey;
  opusProgress.phaseSerial = 0;
  opusProgress.lastRawPct = null;
  opusProgress.lastTargetAdvanceAt = performance.now();
  opusProgress.finishing = false;
  opusProgress.indeterminate = true;
  opusProgress.lastFrameAt = 0;

  stage.classList.remove("is-final", "is-milky-visible", "is-scan", "is-place");
  stage.classList.add(variant === "scan" ? "is-scan" : "is-place");
  stage.style.setProperty("--opus-progress-pct", "0%");
  stage.querySelector(".opus-star-field").innerHTML = "";
  stage.querySelector(".opus-constellation-svg").innerHTML = "";
  generateOpusBackgroundStars(stage);
  updateOpusCopy({ detail: "", current: 0, total: 100 });

  opusProgress.detectionTimer = window.setInterval(() => {
    if (!opusProgress.active) return;
    if (opusProgress.variant === "scan") spawnOpusDetectionDot();
    else spawnOpusConstellationPulse();
  }, 760);
  opusProgress.shootTimer = window.setInterval(() => {
    if (!opusProgress.active) return;
    if (Math.random() < 0.55) spawnOpusShootingStar();
  }, 4200);
  startOpusProgressLoop();
}

function stopOpusProgress({ keepDom = false } = {}) {
  opusProgress.active = false;
  if (opusProgress.raf != null) {
    cancelAnimationFrame(opusProgress.raf);
    opusProgress.raf = null;
  }
  if (opusProgress.detectionTimer != null) {
    clearInterval(opusProgress.detectionTimer);
    opusProgress.detectionTimer = null;
  }
  if (opusProgress.shootTimer != null) {
    clearInterval(opusProgress.shootTimer);
    opusProgress.shootTimer = null;
  }
  if (!keepDom) {
    const modal = $("progress-modal");
    modal?.classList.remove("opus-progress-active");
    if (modal) delete modal.dataset.progressVariant;
  }
}

function generateOpusBackgroundStars(stage) {
  const container = stage.querySelector(".opus-bg-stars");
  if (!container) return;
  container.innerHTML = "";
  for (let i = 0; i < OPUS_AMBIENT_COUNT; i++) {
    container.appendChild(createOpusBgStar(Math.random() * 100, Math.random() * 100));
  }

  const milky = [];
  for (let i = 0; i < OPUS_MILKY_COUNT; i++) {
    const t = i / (OPUS_MILKY_COUNT - 1);
    const u = 1 - t;
    const baseX = (u * u * u * 92) + (3 * u * u * t * 76) + (3 * u * t * t * 35) + (t * t * t * 12);
    const baseY = (u * u * u * 12) + (3 * u * u * t * 20) + (3 * u * t * t * 88) + (t * t * t * 95);
    const scatter = Math.pow(Math.random(), 2) * 20;
    const angle = Math.random() * Math.PI * 2;
    const x = Math.max(0, Math.min(100, baseX + Math.cos(angle) * scatter));
    const y = Math.max(0, Math.min(100, baseY + Math.sin(angle) * scatter * 0.55));
    milky.push({ x, y, t });
  }
  milky.sort((a, b) => a.t - b.t);
  for (const star of milky) {
    const el = createOpusBgStar(star.x, star.y, { pending: true, milky: true });
    container.appendChild(el);
    opusProgress.milkyStars.push(el);
  }
}

function createOpusBgStar(x, y, { pending = false, milky = false } = {}) {
  const el = document.createElement("div");
  el.className = "opus-bg-star" + (pending ? " is-pending" : "") + (milky ? " is-milky" : "");
  const size = milky
    ? 0.8 + Math.pow(Math.random(), 0.55) * 3.4
    : 0.5 + Math.pow(Math.random(), 1.8) * 2.2;
  const opacity = milky ? 0.68 + Math.random() * 0.32 : 0.35 + Math.random() * 0.45;
  const blueWhite = Math.random() < (milky ? 0.68 : 0.42);
  const warm = Math.random() < 0.18;
  const rgb = blueWhite ? "215,232,255" : warm ? "255,230,190" : "255,255,255";
  el.style.left = `${x}%`;
  el.style.top = `${y}%`;
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  el.style.background = `rgba(${rgb}, ${opacity})`;
  if (size > 1.2) el.style.boxShadow = `0 0 ${size * (milky ? 2.8 : 2.0)}px rgba(${rgb}, ${opacity * 0.7})`;
  if (!pending && Math.random() < 0.22) {
    el.style.animation = `opus-bg-star-twinkle ${5 + Math.random() * 8}s ease-in-out ${Math.random() * 4}s infinite`;
  } else if (pending && Math.random() < 0.22) {
    el.dataset.twinkleAnim = `opus-bg-star-twinkle ${5 + Math.random() * 8}s ease-in-out ${Math.random() * 4}s infinite`;
  }
  return el;
}

function startOpusProgressLoop() {
  const tick = (now) => {
    if (!opusProgress.active) {
      opusProgress.raf = null;
      return;
    }
    if (!opusProgress.lastFrameAt) opusProgress.lastFrameAt = now;
    const dt = Math.min(120, now - opusProgress.lastFrameAt);
    opusProgress.lastFrameAt = now;
    if (opusProgress.finishing) {
      setOpusTargetPct(100, now);
    } else {
      const idleFor = now - (opusProgress.lastTargetAdvanceAt || now);
      const phaseCap = Math.max(opusProgress.phaseStartPct, opusProgress.phaseEndPct - 1.5);
      const atPhaseCap = opusProgress.targetPct >= phaseCap - 0.2;
      const shouldDrift = opusProgress.indeterminate || atPhaseCap || idleFor > 520;
      if (shouldDrift) {
        const cap = atPhaseCap || idleFor > 520 ? OPUS_IDLE_CAP_PCT : phaseCap;
        const speed = atPhaseCap || idleFor > 520 ? 0.0011 : 0.004;
        setOpusTargetPct(Math.min(cap, opusProgress.targetPct + dt * speed), now);
      }
    }
    const ease = opusProgress.finishing ? 0.16 : 0.045;
    opusProgress.visualPct += (opusProgress.targetPct - opusProgress.visualPct) * ease;
    applyOpusProgress(opusProgress.visualPct);
    if (opusProgress.finishing) updateOpusCopy({ detail: "完了" });
    opusProgress.raf = requestAnimationFrame(tick);
  };
  opusProgress.raf = requestAnimationFrame(tick);
}

function updateOpusProgress({ detail, current, total } = {}) {
  if (!opusProgress.active) return;
  if (typeof current === "number" && typeof total === "number" && total > 0) {
    const rawPct = Math.max(0, Math.min(100, (current / total) * 100));
    if (
      opusProgress.lastRawPct != null
      && rawPct + 8 < opusProgress.lastRawPct
      && opusProgress.targetPct >= opusProgress.phaseEndPct - 2
    ) {
      advanceOpusProgressPhase(`${opusProgress.phaseKey}|auto:${opusProgress.phaseSerial + 1}`);
    }
    opusProgress.lastRawPct = rawPct;
    const pct = mapOpusProgressPct(rawPct);
    opusProgress.indeterminate = rawPct <= 0 && opusProgress.targetPct <= opusProgress.phaseStartPct + 0.5;
    setOpusTargetPct(pct);
  } else {
    opusProgress.lastRawPct = null;
    opusProgress.indeterminate = true;
  }
  updateOpusCopy({ detail, current, total });
}

function updateOpusCopy({ detail, current, total } = {}) {
  const stage = ensureOpusProgressStage();
  if (!stage || !opusProgress.active) return;
  const pct = Math.max(opusProgress.visualPct, opusProgress.targetPct);
  const chapterNum = stage.querySelector(".opus-chapter-num");
  const chapterName = stage.querySelector(".opus-chapter-name");
  const chapterNameEn = stage.querySelector(".opus-chapter-name-en");
  const counterCurrent = stage.querySelector(".opus-counter-current");
  const counterTotal = stage.querySelector(".opus-counter-total");
  const copy = getOpusCopy(opusProgress.variant, pct, detail);
  if (chapterNum) chapterNum.textContent = copy.num;
  if (chapterName) chapterName.textContent = copy.name;
  if (chapterNameEn) chapterNameEn.textContent = copy.en;
  if (counterCurrent && counterTotal) {
    if (typeof current === "number" && typeof total === "number" && total > 1) {
      counterCurrent.textContent = String(Math.max(0, Math.min(total, Math.round(current))));
      counterTotal.textContent = String(total);
    } else {
      counterCurrent.textContent = String(Math.round(pct));
      counterTotal.textContent = "100";
    }
  }
}

function getOpusCopy(variant, pct, detail = "") {
  if (variant === "scan") {
    if (pct < 18) return { num: "I", name: "画像を読む", en: "opening the page" };
    if (pct < 72) return { num: "II", name: "吹き出しを見つける", en: "finding the speech bubbles" };
    return { num: "III", name: "原稿を抽出する", en: "extracting dialogue" };
  }
  if (/位置調整|重ね調整/.test(detail)) {
    if (pct < 35) return { num: "I", name: "見本と照合する", en: "matching the reference" };
    if (pct < 82) return { num: "II", name: "位置を整える", en: "aligning the frames" };
    return { num: "III", name: "調整を反映する", en: "applying alignment" };
  }
  if (pct < 22) return { num: "I", name: "配置を準備する", en: "preparing the layout" };
  if (pct < 86) return { num: "II", name: "文字を配置する", en: "placing the typesetting" };
  return { num: "III", name: "仕上げを反映する", en: "finishing the page" };
}

function applyOpusProgress(pct) {
  const stage = ensureOpusProgressStage();
  if (!stage) return;
  const clamped = Math.max(0, Math.min(100, pct));
  stage.style.setProperty("--opus-progress-pct", `${clamped}%`);
  $("progress-modal")?.style.setProperty("--opus-progress-pct", `${clamped}%`);
  stage.querySelector(".opus-milky-glow").style.opacity = String(0.1 + 0.72 * (clamped / 100));
  stage.classList.toggle("is-milky-visible", clamped > 10);
  revealOpusMilkyStars(clamped);
  if (opusProgress.variant === "place") spawnOpusConstellationUntil(clamped);
}

function revealOpusMilkyStars(pct) {
  const target = Math.round((pct / 100) * opusProgress.milkyStars.length);
  while (opusProgress.milkyRevealed < target) {
    const el = opusProgress.milkyStars[opusProgress.milkyRevealed++];
    if (!el) continue;
    el.classList.remove("is-pending");
    if (el.dataset.twinkleAnim) {
      const anim = el.dataset.twinkleAnim;
      setTimeout(() => { el.style.animation = anim; }, 900);
    }
  }
}

function spawnOpusConstellationUntil(pct) {
  const target = Math.round((pct / 100) * OPUS_CONSTELLATION_POINTS.length);
  while (opusProgress.spawnedStars < target) {
    spawnOpusConstellationStar(opusProgress.spawnedStars);
    opusProgress.spawnedStars++;
  }
}

function spawnOpusConstellationStar(index) {
  const stage = ensureOpusProgressStage();
  const field = stage?.querySelector(".opus-star-field");
  const svg = stage?.querySelector(".opus-constellation-svg");
  const point = OPUS_CONSTELLATION_POINTS[index];
  if (!stage || !field || !svg || !point) return;
  const [x, y, isKey] = point;
  const el = document.createElement("div");
  el.className = "opus-star" + (isKey ? " is-key" : "");
  el.style.left = `${x * 100}%`;
  el.style.top = `${y * 100}%`;
  el.style.setProperty("--twinkle-dur", `${3.4 + Math.random() * 3}s`);
  field.appendChild(el);

  for (const [a, b] of OPUS_CONSTELLATION_LINES) {
    const key = `${a}-${b}`;
    if (opusProgress.drawnLines.has(key)) continue;
    if (a <= index && b <= index) {
      opusProgress.drawnLines.add(key);
      const p1 = OPUS_CONSTELLATION_POINTS[a];
      const p2 = OPUS_CONSTELLATION_POINTS[b];
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(p1[0] * 1000));
      line.setAttribute("y1", String(p1[1] * 1000));
      line.setAttribute("x2", String(p2[0] * 1000));
      line.setAttribute("y2", String(p2[1] * 1000));
      line.setAttribute("class", "opus-connection");
      line.setAttribute("vector-effect", "non-scaling-stroke");
      const len = Math.hypot((p2[0] - p1[0]) * 1000, (p2[1] - p1[1]) * 1000);
      line.style.strokeDasharray = String(len);
      line.style.strokeDashoffset = String(len);
      line.style.setProperty("--len", String(len));
      svg.appendChild(line);
    }
  }
}

function spawnOpusDetectionDot() {
  const stage = ensureOpusProgressStage();
  const field = stage?.querySelector(".opus-star-field");
  if (!field) return;
  const t = Math.random();
  const u = 1 - t;
  const baseX = (u * u * u * 92) + (3 * u * u * t * 76) + (3 * u * t * t * 35) + (t * t * t * 12);
  const baseY = (u * u * u * 12) + (3 * u * u * t * 20) + (3 * u * t * t * 88) + (t * t * t * 95);
  const x = Math.max(4, Math.min(96, baseX + (Math.random() - 0.5) * 20));
  const y = Math.max(4, Math.min(96, baseY + (Math.random() - 0.5) * 12));
  const dot = document.createElement("div");
  dot.className = "opus-detection-dot";
  dot.style.left = `${x}%`;
  dot.style.top = `${y}%`;
  field.appendChild(dot);
  setTimeout(() => dot.remove(), 1500);
}

function spawnOpusConstellationPulse() {
  const stage = ensureOpusProgressStage();
  const field = stage?.querySelector(".opus-star-field");
  if (!field) return;
  const visibleCount = Math.max(1, Math.min(OPUS_CONSTELLATION_POINTS.length, Math.max(opusProgress.spawnedStars, 1)));
  const point = OPUS_CONSTELLATION_POINTS[Math.floor(Math.random() * visibleCount)] ?? OPUS_CONSTELLATION_POINTS[0];
  if (!point) return;
  const dot = document.createElement("div");
  dot.className = "opus-detection-dot opus-constellation-pulse";
  dot.style.left = `${Math.max(4, Math.min(96, point[0] * 100 + (Math.random() - 0.5) * 7))}%`;
  dot.style.top = `${Math.max(4, Math.min(96, point[1] * 100 + (Math.random() - 0.5) * 7))}%`;
  field.appendChild(dot);
  setTimeout(() => dot.remove(), 1500);
}

function spawnOpusShootingStar() {
  const stage = ensureOpusProgressStage();
  if (!stage) return;
  const el = document.createElement("div");
  el.className = "opus-shooting-star";
  const fromTop = Math.random() < 0.62;
  const startX = fromTop ? -5 + Math.random() * 110 : (Math.random() < 0.5 ? -4 : 104);
  const startY = fromTop ? -4 - Math.random() * 6 : Math.random() * 54;
  const angle = startX > 100 ? 132 + Math.random() * 20 : 32 + Math.random() * 26;
  el.style.left = `${startX}%`;
  el.style.top = `${startY}%`;
  el.style.setProperty("--angle", `${angle}deg`);
  el.style.setProperty("--travel", `${420 + Math.random() * 280}px`);
  stage.appendChild(el);
  setTimeout(() => el.remove(), 2800);
}

function completeOpusProgress() {
  if (!opusProgress.active) return;
  opusProgress.indeterminate = false;
  opusProgress.finishing = true;
  opusProgress.phaseEndPct = 100;
  opusProgress.targetPct = 100;
  const stage = ensureOpusProgressStage();
  window.setTimeout(() => {
    if (opusProgress.active && opusProgress.finishing) stage?.classList.add("is-final");
  }, 420);
  updateOpusCopy({ detail: "完了" });
}

// 完了時の閉じアニメは「進捗バーを中心線として、ぼかし背景が上下に開く」演出。
// バーの Y 座標を計測して --bar-top に注入 → 上下 2 つの bg 帯の境界をバー位置に揃え、
// .closing クラス付与で bg-top は translateY(-100%)、bg-bottom は translateY(100%) で
// 物理的に画面外へスライドアウトさせる。card は少し遅れてフェードアウト。
//
// 戻り値: 閉じアニメ完了時に resolve する Promise。await すれば「次に開くモーダルが
// progress-modal の上に重なってアニメが見えなくなる」事故を防げる（既存の fire-and-forget
// 呼び出しは await しないだけで、Promise 自体は GC で回収されるため互換）。
//
// success: true を渡すと、close アニメに入る前にアイコン領域へ緑のチェックマーク
// アニメーション（リング描画 + チェック描画 + バースト）を再生してから閉じる。
const PROGRESS_CLOSE_ANIM_MS = 500;
const SUCCESS_HOLD_MS = 700;
const OPUS_SUCCESS_HOLD_MS = 950;
const SUCCESS_CHECK_HTML = `
  <div class="success-check-anim">
    <div class="success-check-burst"></div>
    <svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <circle class="success-check-ring" cx="24" cy="24" r="22"/>
      <path class="success-check-path" d="M14 24l7 7 13-13"/>
    </svg>
  </div>
`;
export function hideProgress({ success = false } = {}) {
  return new Promise((resolve) => {
    const modal = $("progress-modal");
    if (!modal) { resolve(); return; }
    // 既に hidden で closing でもなければ、何も走らせず即解決。
    // （未表示状態で呼ばれた場合に 500ms 待つのは無駄）
    if (modal.hidden && !modal.classList.contains("closing")) {
      resolve();
      return;
    }

    const startCloseAnim = () => {
      // バーの中心 Y をビューポート % で算出し --bar-top に設定（bg-top の高さ = バー位置まで）。
      if (isOpusProgressActive(modal)) {
        modal.style.setProperty("--bar-top", "50%");
      } else {
        const trackEl = modal.querySelector(".progress-track");
        if (trackEl) {
          const r = trackEl.getBoundingClientRect();
          const barCenterY = r.top + r.height / 2;
          const winH = window.innerHeight || document.documentElement.clientHeight || 1;
          const topPct = Math.max(0, Math.min(100, (barCenterY / winH) * 100));
          modal.style.setProperty("--bar-top", `${topPct}%`);
        }
      }
      // 直前の hideProgress があれば置き換え（重複タイマー防止）。
      if (pendingHideTimer != null) clearTimeout(pendingHideTimer);
      // .visible は外さず .closing を付ける（opacity 1 維持 + bg 帯のスライドアウト）。
      modal.classList.add("closing");
      pendingHideTimer = setTimeout(() => {
        pendingHideTimer = null;
        // 万一 .closing が外れていたら（次の showProgress が割り込んだ）何もしない。
        if (!modal.classList.contains("closing")) {
          resolve();
          return;
        }
        // アニメ完了 → 状態リセット + hidden 化。次回 open に備えて変数も消す。
        modal.classList.remove("closing");
        modal.classList.remove("visible");
        modal.hidden = true;
        modal.style.removeProperty("--bar-top");
        modal.style.removeProperty("--opus-progress-pct");
        // 次回 open 時に 0% から再開するため fill 幅と indeterminate クラスを明示リセット。
        const fill = $("progress-fill");
        if (fill) {
          fill.classList.remove("indeterminate");
          fill.style.width = "0%";
        }
        $("progress-detail").textContent = "";
        const loadingText = $("progress-loading-text");
        if (loadingText) loadingText.textContent = "LOADING...";
        setProgressIcon(null);
        stopOpusProgress();
        resolve();
      }, PROGRESS_CLOSE_ANIM_MS);
    };

    if (success && isOpusProgressActive(modal)) {
      completeOpusProgress();
      const loadingText = $("progress-loading-text");
      if (loadingText) loadingText.textContent = "完了";
      setTimeout(startCloseAnim, OPUS_SUCCESS_HOLD_MS);
    } else if (success) {
      // close アニメに入る前にアイコンを成功チェックマークに差し替えて約 700ms 再生。
      // ローディングテキストもクリアして「完了」感を視覚的に揃える。
      setProgressIcon(SUCCESS_CHECK_HTML);
      const loadingText = $("progress-loading-text");
      if (loadingText) loadingText.textContent = "";
      setTimeout(startCloseAnim, SUCCESS_HOLD_MS);
    } else {
      startCloseAnim();
    }
  });
}

// タイトル要素にテキストとアイコンを書き戻す共通ヘルパー。
// kind: "default" → プレーンテキスト（class クリアのみ）
//       "danger"  → notify-title-danger（赤文字、アイコン無し）
//       "success" → notify-title-success（緑文字 + check-circle SVG）
//       "warning" → notify-title-warning（オレンジ + alert-triangle SVG）
function applyTitleIcon(titleEl, title, kind) {
  if (!titleEl) return;
  titleEl.classList.remove("notify-title-success", "notify-title-warning", "notify-title-danger");
  if (kind === "success" || kind === "warning") {
    titleEl.classList.add(kind === "success" ? "notify-title-success" : "notify-title-warning");
    const iconSvg = kind === "success"
      ? `<svg class="notify-title-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10"/>
          <polyline points="8 12.5 11 15.5 16 9.5"/>
        </svg>`
      : `<svg class="notify-title-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
          <line x1="12" y1="9" x2="12" y2="13"/>
          <line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>`;
    titleEl.innerHTML = `${iconSvg}<span class="notify-title-text"></span>`;
    const span = titleEl.querySelector(".notify-title-text");
    if (span) span.textContent = title;
  } else {
    titleEl.textContent = title;
    if (kind === "danger") titleEl.classList.add("notify-title-danger");
  }
}

// kind: "default" (既定) | "danger" | "success" | "warning"
//   - "danger"  → タイトル赤
//   - "success" → タイトル緑 + チェックアイコン（confirm 用に拡張、画像スキャン完了などで使う）
//   - "warning" → タイトルオレンジ + 警告アイコン
// confirmKind: OK ボタンのスタイル切替
//   - "primary"（既定）→ 青塗り (.page-jump-btn-primary)
//   - "place"          → サイドバーの自動配置ボタン (.scan-place-btn) と同じ緑枠スタイル
export function confirmDialog({
  title = "確認",
  message = "",
  confirmLabel = "OK",
  cancelLabel = "キャンセル",
  kind = "default",
  confirmKind = "primary",
} = {}) {
  return new Promise((resolve) => {
    const modal = $("confirm-modal");
    const titleEl = $("confirm-modal-title");
    const msgEl = $("confirm-modal-message");
    const okBtn = $("confirm-modal-ok");
    const cancelBtn = $("confirm-modal-cancel");
    if (!modal || !okBtn || !cancelBtn || !msgEl) {
      resolve(false);
      return;
    }
    applyTitleIcon(titleEl, title, kind);
    msgEl.textContent = message;
    okBtn.textContent = confirmLabel;
    cancelBtn.textContent = cancelLabel;
    // OK ボタンのスタイル切替: primary（既定の青塗り）を一度外し、必要に応じて place クラスへ。
    okBtn.classList.remove("page-jump-btn-primary", "page-jump-btn-place");
    if (confirmKind === "place") okBtn.classList.add("page-jump-btn-place");
    else okBtn.classList.add("page-jump-btn-primary");
    showModalAnimated(modal);

    const cleanup = (result) => {
      hideModalAnimated(modal);
      // 次回呼び出し時の干渉を避けるため、success/warning/danger の class とアイコン HTML を全リセット。
      if (titleEl) {
        titleEl.classList.remove("notify-title-success", "notify-title-warning", "notify-title-danger");
        titleEl.textContent = title;
      }
      // OK ボタンのスタイルを既定の primary に戻す（次回 confirmDialog 呼び出し時の出発点）。
      okBtn.classList.remove("page-jump-btn-place");
      if (!okBtn.classList.contains("page-jump-btn-primary")) okBtn.classList.add("page-jump-btn-primary");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      modal.removeEventListener("mousedown", onOverlay);
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onOverlay = (e) => { if (e.target === modal) cleanup(false); };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); cleanup(false); }
      else if (e.key === "Enter") { e.preventDefault(); cleanup(true); }
    };
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    modal.addEventListener("mousedown", onOverlay);
    document.addEventListener("keydown", onKey);
    requestAnimationFrame(() => okBtn.focus());
  });
}

// 単一 OK ボタンの中央モーダル通知。`#confirm-modal` の DOM を流用し、
// Cancel ボタンを一時的に非表示にする。OK / Esc / Enter / 背景クリックで dismiss。
// kind: "info" (既定) | "success" | "warning"
//   - "success" → タイトル緑 + チェック (check-circle) SVG
//   - "warning" → タイトルオレンジ + 警告 (alert-triangle) SVG
//
// primaryAction: { label, kind?, onClick } を渡すと「OK の隣に追加アクションボタン」を
// 表示する。confirm-modal の cancel ボタンを再利用するため、notify 既定の「cancel 非表示」
// 挙動を抑止する。クリックで onClick (async 可) を実行後、ダイアログを閉じる。
// kind は "place" (緑枠 / page-jump-btn-place) など既存の page-jump-btn-* バリアントを指定。
//
// 戻り値は Promise<void>。
export function notifyDialog({
  title = "通知",
  message = "",
  okLabel = "OK",
  kind = "info",
  primaryAction = null,
} = {}) {
  return new Promise((resolve) => {
    const modal = $("confirm-modal");
    const titleEl = $("confirm-modal-title");
    const msgEl = $("confirm-modal-message");
    const okBtn = $("confirm-modal-ok");
    const cancelBtn = $("confirm-modal-cancel");
    if (!modal || !okBtn || !msgEl) {
      resolve();
      return;
    }
    applyTitleIcon(titleEl, title, kind);
    msgEl.textContent = message;
    okBtn.textContent = okLabel;
    // Cancel ボタンは notify (primaryAction 無し) では非表示。primaryAction 有りなら
    // 「OK + アクションボタン」の 2 ボタン構造で表示し、cancelBtn を再利用する。
    const prevCancelHidden = cancelBtn ? cancelBtn.hidden : false;
    const prevCancelText = cancelBtn ? cancelBtn.textContent : "";
    const prevCancelClass = cancelBtn ? cancelBtn.className : "";
    let actionPending = false;
    if (cancelBtn) {
      if (primaryAction && typeof primaryAction === "object") {
        cancelBtn.hidden = false;
        cancelBtn.textContent = primaryAction.label || "実行";
        // page-jump-btn-* バリアント (place / primary / danger 等) を kind から組み立て
        const variantKind = (primaryAction.kind || "primary");
        cancelBtn.className = `page-jump-btn page-jump-btn-${variantKind}`;
      } else {
        cancelBtn.hidden = true;
      }
    }
    showModalAnimated(modal);

    const cleanup = () => {
      hideModalAnimated(modal);
      // Cancel ボタン復帰 / タイトルリセットはフェード完了後に。フェード中に Cancel が
      // 現れたりタイトルが平文に戻るチラつきを避ける。
      setTimeout(() => {
        if (cancelBtn) {
          cancelBtn.hidden = prevCancelHidden;
          cancelBtn.textContent = prevCancelText;
          cancelBtn.className = prevCancelClass;
        }
        if (titleEl) {
          titleEl.classList.remove("notify-title-success", "notify-title-warning", "notify-title-danger");
          titleEl.textContent = title;
        }
      }, MODAL_ANIM_MS);
      okBtn.removeEventListener("click", onOk);
      if (cancelBtn) cancelBtn.removeEventListener("click", onAction);
      modal.removeEventListener("mousedown", onOverlay);
      document.removeEventListener("keydown", onKey);
      resolve();
    };
    const onOk = () => cleanup();
    const onAction = async () => {
      if (actionPending) return;
      if (!primaryAction || typeof primaryAction.onClick !== "function") {
        cleanup();
        return;
      }
      actionPending = true;
      try { await primaryAction.onClick(); } catch (err) { console.error("notifyDialog primaryAction error", err); }
      actionPending = false;
      cleanup();
    };
    const onOverlay = (e) => { if (e.target === modal && !actionPending) cleanup(); };
    const onKey = (e) => {
      if (actionPending) return;
      if (e.key === "Escape" || e.key === "Enter") {
        e.preventDefault();
        cleanup();
      }
    };
    okBtn.addEventListener("click", onOk);
    if (cancelBtn && primaryAction) cancelBtn.addEventListener("click", onAction);
    modal.addEventListener("mousedown", onOverlay);
    document.addEventListener("keydown", onKey);
    requestAnimationFrame(() => okBtn.focus());
  });
}

// 単一テキスト入力ダイアログ。confirm-modal の DOM を流用し、メッセージの直下に
// `<input type="text">` を動的挿入する。OK で入力値（trim 後）を resolve、
// Cancel / Esc / 背景クリックで null を resolve。Enter で OK、Esc で Cancel。
// 戻り値は Promise<string | null>。
export function promptDialog({
  title = "入力",
  message = "",
  defaultValue = "",
  placeholder = "",
  confirmLabel = "OK",
  cancelLabel = "キャンセル",
} = {}) {
  return new Promise((resolve) => {
    const modal = $("confirm-modal");
    const titleEl = $("confirm-modal-title");
    const msgEl = $("confirm-modal-message");
    const okBtn = $("confirm-modal-ok");
    const cancelBtn = $("confirm-modal-cancel");
    if (!modal || !okBtn || !cancelBtn || !msgEl) {
      resolve(null);
      return;
    }
    if (titleEl) {
      titleEl.classList.remove("notify-title-success", "notify-title-warning", "notify-title-danger");
      titleEl.textContent = title;
    }
    msgEl.textContent = message;
    okBtn.textContent = confirmLabel;
    cancelBtn.textContent = cancelLabel;

    // メッセージ直下に `<input>` を 1 つ動的挿入。cleanup で必ず remove する。
    const input = document.createElement("input");
    input.type = "text";
    input.className = "prompt-modal-input";
    input.value = defaultValue || "";
    input.placeholder = placeholder || "";
    msgEl.parentNode.insertBefore(input, msgEl.nextSibling);

    // OK ボタンは notify-success スタイル等の干渉を避けるため primary に揃える。
    okBtn.classList.remove("page-jump-btn-place");
    if (!okBtn.classList.contains("page-jump-btn-primary")) okBtn.classList.add("page-jump-btn-primary");
    showModalAnimated(modal);

    const cleanup = (result) => {
      hideModalAnimated(modal);
      // input 要素の DOM 除去はフェード完了後に。フェード中に input が消えると
      // 「ダイアログから input だけ先に消える」見た目になって違和感が出る。
      setTimeout(() => {
        if (input.parentNode) input.parentNode.removeChild(input);
      }, MODAL_ANIM_MS);
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      modal.removeEventListener("mousedown", onOverlay);
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onOk = () => cleanup((input.value ?? "").trim());
    const onCancel = () => cleanup(null);
    const onOverlay = (e) => { if (e.target === modal) cleanup(null); };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); cleanup(null); }
      else if (e.key === "Enter" && document.activeElement === input) {
        e.preventDefault();
        cleanup((input.value ?? "").trim());
      }
    };
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    modal.addEventListener("mousedown", onOverlay);
    document.addEventListener("keydown", onKey);
    requestAnimationFrame(() => { input.focus(); input.select(); });
  });
}

export function toast(message, { kind = "info", duration = 2800 } = {}) {
  const container = $("toast-container");
  if (!container) return;
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add("visible"));
  const remove = () => {
    el.classList.remove("visible");
    el.addEventListener("transitionend", () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400);
  };
  setTimeout(remove, duration);
  el.addEventListener("click", remove);
}
