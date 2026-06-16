import {
  createFontCombobox,
  fontSearchHaystack,
  resolveFontFromInput as resolveComboboxFontFromInput,
} from "./font-combobox.js";

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
        <span class="opus-counter-pages">0/100P</span>
        <span class="opus-counter-percent">0%</span>
      </div>
    </div>
    <div class="opus-task-panel">
      <div class="opus-task-total">
        <span class="opus-task-total-label">Loading</span>
        <span class="opus-task-total-percent">0%</span>
      </div>
      <div class="opus-task-list"></div>
    </div>
    <div class="opus-save-layer">
      <div class="opus-save-phase-tag">Sending to Photoshop</div>
      <div class="opus-save-rings"></div>
      <div class="opus-save-final-ring"></div>
      <div class="opus-save-core"></div>
      <div class="opus-save-counter">
        <span class="opus-save-counter-current">0</span>
        <span class="opus-save-counter-sep">/</span>
        <span class="opus-save-counter-total">0P</span>
      </div>
      <div class="opus-save-final-seal">
        <svg class="opus-save-seal-ornament" viewBox="0 0 32 32" fill="none" aria-hidden="true">
          <circle cx="16" cy="16" r="13" stroke="currentColor" stroke-width="0.6" opacity="0.7"/>
          <circle cx="16" cy="16" r="8" stroke="currentColor" stroke-width="0.4" opacity="0.5"/>
          <path d="M16 5 L18 14 L27 16 L18 18 L16 27 L14 18 L5 16 L14 14 Z" fill="currentColor" opacity="0.85"/>
        </svg>
        <span class="opus-save-seal-text">Saved</span>
      </div>
    </div>
  </div>
`;

const OPUS_PROGRESS_VARIANTS = new Set(["scan", "place", "save", "load"]);
const OPUS_LOAD_TASKS = ["ファイル読込", "内容解析", "表示準備"];
const OPUS_PLACE_TASKS = ["配置準備", "テキスト配置", "仕上げ"];
const OPUS_SCAN_TASKS = ["読込準備", "画像スキャン", "書き起こし"];
const OPUS_MILKY_COUNT = 300;
const OPUS_MILKY_OPEN_FILL_COUNT = 140;
const OPUS_MILKY_BLOOM_COUNT = 130;
const OPUS_PSD_PARSE_FILL_COUNT = 150;
const OPUS_AMBIENT_COUNT = 84;
const OPUS_DEEP_SPACE_COUNT = 190;
const OPUS_FRAME_INTERVAL_MS = 16;
const OPUS_SAVE_FRAME_INTERVAL_MS = 33;
const OPUS_CONSTELLATION_SCALE = 0.5;
const OPUS_CONSTELLATION_AUTO_STEP_MS = 3200;
const OPUS_CONSTELLATION_MAX_VISIBLE = 5;
const OPUS_CONSTELLATION_MIN_VISIBLE = 2;
const OPUS_CONSTELLATION_BURST_CHANCE = 0.07;
const OPUS_CONSTELLATION_LIFE_MIN_MS = 17000;
const OPUS_CONSTELLATION_LIFE_MAX_MS = 28000;
const OPUS_CONSTELLATION_FADE_STAGGER_MS = 70;
const OPUS_CONSTELLATION_MIN_GAP = 0.12;
const OPUS_CONSTELLATION_PLACEMENT_TRIES = 80;
const OPUS_IDLE_CAP_PCT = 98.4;
const OPUS_CONSTELLATION_TEMPLATES = [
  {
    name: "orion",
    points: [[-0.16, -0.15, true], [0.14, -0.14, true], [-0.07, -0.02, false], [0, 0, false], [0.07, 0.02, false], [-0.13, 0.16, true], [0.13, 0.15, true]],
    lines: [[0, 2], [1, 4], [2, 3], [3, 4], [2, 5], [4, 6]],
  },
  {
    name: "cassiopeia",
    points: [[-0.16, -0.03, true], [-0.08, 0.05, false], [0, -0.04, false], [0.08, 0.06, false], [0.16, -0.02, true]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4]],
  },
  {
    name: "cygnus",
    points: [[0, -0.17, true], [0, -0.06, false], [0, 0.06, false], [0, 0.17, true], [-0.13, 0.02, false], [0.13, 0.02, false]],
    lines: [[0, 1], [1, 2], [2, 3], [4, 2], [2, 5]],
  },
  {
    name: "lyra",
    points: [[-0.10, -0.06, true], [0.02, -0.10, false], [0.12, -0.02, true], [0.06, 0.10, false], [-0.08, 0.08, false]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 0], [0, 2]],
  },
  {
    name: "ursa_major",
    points: [[-0.19, 0.06, true], [-0.10, -0.02, false], [0.01, -0.06, false], [0.10, -0.02, true], [0.16, 0.07, true], [0.07, 0.12, false], [-0.03, 0.10, false]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4], [3, 6], [6, 5], [5, 4]],
  },
  {
    name: "ursa_minor",
    points: [[-0.16, 0.12, true], [-0.09, 0.04, false], [-0.02, -0.02, false], [0.08, -0.05, false], [0.17, 0.02, true], [0.11, 0.12, false], [0.01, 0.10, false]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4], [3, 6], [6, 5], [5, 4]],
  },
  {
    name: "scorpius",
    points: [[-0.18, -0.04, true], [-0.10, -0.10, false], [-0.02, -0.08, true], [0.05, 0.00, false], [0.10, 0.08, false], [0.18, 0.10, true], [0.12, 0.17, false], [0.03, 0.16, false]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7]],
  },
  {
    name: "sagittarius",
    points: [[-0.16, 0.10, true], [-0.08, -0.04, false], [0.02, -0.12, true], [0.14, -0.05, false], [0.10, 0.10, true], [-0.02, 0.15, false], [-0.12, -0.12, true]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0], [1, 6], [6, 2]],
  },
  {
    name: "aquila",
    points: [[-0.17, 0.04, false], [-0.06, -0.02, false], [0.03, -0.08, true], [0.14, -0.02, false], [0.18, 0.10, true], [0.02, 0.08, false], [-0.12, 0.13, true]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4], [2, 5], [5, 6]],
  },
  {
    name: "pegasus",
    points: [[-0.16, -0.12, true], [0.08, -0.14, true], [0.16, 0.06, true], [-0.08, 0.12, true], [-0.18, 0.00, false], [0.18, -0.04, false]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 0], [3, 4], [2, 5]],
  },
  {
    name: "andromeda",
    points: [[-0.18, 0.10, true], [-0.08, 0.04, false], [0.02, -0.01, true], [0.12, -0.06, false], [0.18, -0.13, true], [0.02, 0.12, false]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4], [2, 5]],
  },
  {
    name: "perseus",
    points: [[-0.15, -0.13, true], [-0.06, -0.05, false], [0.00, 0.04, true], [0.08, 0.12, false], [0.18, 0.10, true], [-0.10, 0.12, false], [-0.18, 0.04, true]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4], [2, 5], [5, 6]],
  },
  {
    name: "auriga",
    points: [[-0.14, -0.12, true], [0.02, -0.18, true], [0.16, -0.04, false], [0.12, 0.12, true], [-0.06, 0.16, false], [-0.18, 0.02, true]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0]],
  },
  {
    name: "bootes",
    points: [[0, -0.18, true], [0.12, -0.06, false], [0.10, 0.10, false], [0, 0.18, true], [-0.12, 0.08, false], [-0.10, -0.06, true]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0]],
  },
  {
    name: "corona_borealis",
    points: [[-0.17, 0.06, false], [-0.10, -0.05, true], [-0.02, -0.11, false], [0.08, -0.09, true], [0.16, 0.02, false], [0.13, 0.12, true]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]],
  },
  {
    name: "leo",
    points: [[-0.18, 0.04, true], [-0.08, -0.06, false], [0.02, -0.10, true], [0.12, -0.02, false], [0.18, 0.10, true], [0.04, 0.13, false], [-0.08, 0.12, true]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 0]],
  },
  {
    name: "gemini",
    points: [[-0.10, -0.16, true], [-0.08, -0.02, false], [-0.10, 0.14, true], [0.10, -0.14, true], [0.08, 0.00, false], [0.10, 0.16, true], [-0.08, -0.02, false], [0.08, 0.00, false]],
    lines: [[0, 1], [1, 2], [3, 4], [4, 5], [1, 4]],
  },
  {
    name: "taurus",
    points: [[-0.18, -0.12, true], [-0.05, -0.02, false], [0.04, 0.05, true], [0.14, 0.13, false], [0.19, -0.02, true], [-0.02, 0.16, false], [-0.12, 0.10, true]],
    lines: [[0, 1], [1, 2], [2, 3], [2, 4], [2, 5], [5, 6]],
  },
  {
    name: "canis_major",
    points: [[-0.15, -0.10, false], [-0.02, -0.02, true], [0.12, -0.08, false], [0.18, 0.04, true], [0.04, 0.10, false], [-0.08, 0.16, true], [-0.16, 0.06, false]],
    lines: [[0, 1], [1, 2], [2, 3], [1, 4], [4, 5], [4, 6]],
  },
  {
    name: "virgo",
    points: [[-0.18, -0.02, true], [-0.08, 0.02, false], [0.02, -0.04, true], [0.12, -0.12, false], [0.18, 0.02, true], [0.04, 0.12, false], [-0.10, 0.16, true]],
    lines: [[0, 1], [1, 2], [2, 3], [2, 4], [2, 5], [5, 6]],
  },
  {
    name: "aquarius",
    points: [[-0.18, -0.04, true], [-0.10, 0.04, false], [-0.01, -0.02, true], [0.08, 0.06, false], [0.17, -0.01, true], [0.04, 0.16, false], [-0.08, 0.12, true]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4], [2, 5], [5, 6]],
  },
  {
    name: "pisces",
    points: [[-0.18, -0.10, true], [-0.10, -0.02, false], [-0.02, 0.05, false], [0.08, 0.10, false], [0.18, 0.04, true], [0.08, -0.12, true], [0.16, -0.16, false]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4], [3, 5], [5, 6]],
  },
  {
    name: "draco",
    points: [[-0.18, 0.12, true], [-0.08, 0.04, false], [-0.02, -0.08, false], [0.10, -0.14, true], [0.18, -0.04, false], [0.10, 0.10, true], [0.00, 0.16, false], [-0.10, 0.18, true]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7]],
  },
  {
    name: "hercules",
    points: [[-0.13, -0.12, true], [0.08, -0.13, true], [0.15, 0.04, false], [0.02, 0.15, true], [-0.14, 0.08, false], [-0.02, -0.01, false], [-0.19, -0.03, true], [0.19, 0.15, true]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 0], [0, 5], [5, 3], [4, 6], [2, 7]],
  },
  {
    name: "aries",
    points: [[-0.18, 0.08, true], [-0.07, 0.00, false], [0.04, -0.06, true], [0.15, -0.12, false], [0.18, 0.02, true]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4]],
  },
];
const opusProgress = {
  active: false,
  variant: null,
  raf: null,
  detectionTimer: null,
  shootTimer: null,
  saveChordTimer: null,
  saveParticleTimer: null,
  milkyBloomStars: [],
  milkyBloomRevealed: 0,
  psdParseStars: [],
  psdParseRevealed: false,
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
  stage: null,
  nodes: null,
  lastAppliedPct: -1,
  lastCopyKey: "",
  lastConstellationAdvanceAt: 0,
  constellationQueue: [],
  constellationCurrent: null,
  constellationSerial: 0,
  lastConstellationTemplateIndex: -1,
  lastCountCurrent: null,
  lastCountTotal: null,
  saveCompleted: 0,
  taskNames: OPUS_LOAD_TASKS,
  taskIndex: 0,
  lastTaskKey: "",
  lastFlowStepId: null,
  lastFlowPhaseSerial: -1,
  flowSnapshot: null,
  completionBurstPlayed: false,
};

// 直前の hideProgress 閉じアニメをキャンセルするためのタイマー ID。
// 閉じ→即開く（loadReferenceFiles 完了直後に runScanExtract が show する等）の連続呼び出しで
// 古い setTimeout が後から発火して新しい表示を hidden にしてしまう事故を防ぐ。
let pendingHideTimer = null;
let pendingOpusExitTimer = null;

// icon: SVG 文字列を直接挿入する（呼び出し側で <svg>...</svg> をそのまま渡す）。
//   undefined / 省略 → デフォルト spinner（PSD 読込・見本読込・Photoshop 反映 等）
//   null              → アイコン領域空 (非表示)
//   "<svg>...</svg>"  → カスタムアイコン
export function showProgress({ title, label, detail, current, total, showCount, icon, variant, tasks, taskIndex, taskProgress, flow } = {}) {
  const modal = $("progress-modal");
  if (!modal) return;
  // 直前の hideProgress が閉じアニメ中なら割り込みキャンセル。
  if (pendingHideTimer != null) {
    clearTimeout(pendingHideTimer);
    pendingHideTimer = null;
  }
  if (pendingOpusExitTimer != null) {
    clearTimeout(pendingOpusExitTimer);
    pendingOpusExitTimer = null;
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
  updateProgress({ detail, current, total, showCount, tasks, taskIndex, taskProgress, flow });
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
export function updateProgress({ detail, current, total, showCount = true, tasks, taskIndex, taskProgress, flow } = {}) {
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
  updateOpusProgress({ detail, current, total, tasks, taskIndex, taskProgress, flow });
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
  if (variant === "load") return 100;
  if (variant === "save") return 82;
  return variant === "scan" ? 78 : 72;
}

function maxOpusPhaseEnd(variant) {
  if (variant === "load") return 100;
  if (variant === "save") return 96;
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
  opusProgress.milkyBloomStars = [];
  opusProgress.milkyBloomRevealed = 0;
  opusProgress.psdParseStars = [];
  opusProgress.psdParseRevealed = false;
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
  opusProgress.stage = stage;
  opusProgress.nodes = cacheOpusNodes(stage);
  opusProgress.lastAppliedPct = -1;
  opusProgress.lastCopyKey = "";
  opusProgress.lastConstellationAdvanceAt = performance.now();
  opusProgress.constellationQueue = [];
  opusProgress.constellationCurrent = null;
  opusProgress.constellationSerial = 0;
  opusProgress.lastConstellationTemplateIndex = -1;
  opusProgress.lastCountCurrent = null;
  opusProgress.lastCountTotal = null;
  opusProgress.saveCompleted = 0;
  opusProgress.taskNames = getDefaultOpusTaskNames(variant);
  opusProgress.taskIndex = 0;
  opusProgress.lastTaskKey = "";
  opusProgress.lastFlowStepId = null;
  opusProgress.lastFlowPhaseSerial = -1;
  opusProgress.flowSnapshot = null;
  opusProgress.completionBurstPlayed = false;

  stage.classList.remove("is-milky-visible", "is-complete", "is-exiting", "is-completion-constellation", "is-psd-parse", "has-milky-rhythm", "is-scan", "is-place", "is-save", "is-load", "is-saving", "is-final", "has-flow");
  if (variant === "save") {
    stage.classList.add("is-save", "is-saving");
  } else if (variant === "load") {
    stage.classList.add("is-load", "has-milky-rhythm");
  } else {
    stage.classList.add(variant === "scan" ? "is-scan" : "is-place", "has-milky-rhythm");
  }
  stage.style.setProperty("--opus-progress-pct", "0%");
  opusProgress.nodes.starField.innerHTML = "";
  opusProgress.nodes.constellationSvg.innerHTML = "";
  generateOpusBackgroundStars(stage);
  stage.classList.add("is-milky-visible");
  updateOpusCopy({ detail: "", current: 0, total: 100 });
  if (variant === "save") resetOpusSaveStage({ current: 0, total: 0 });
  if (variant === "load") updateOpusTasks({ current: 0, total: 100, tasks: OPUS_LOAD_TASKS });
  if (variant === "scan") updateOpusTasks({ detail: "画像スキャン準備中…", current: 0, total: 100, tasks: OPUS_SCAN_TASKS });

  opusProgress.detectionTimer = window.setInterval(() => {
    if (!opusProgress.active) return;
    if (isOpusPsdParseActive()) return;
    if (opusProgress.variant === "scan") spawnOpusDetectionDot();
    else if (opusProgress.variant === "place" || opusProgress.variant === "load") {
      advanceOpusConstellationByTime();
      spawnOpusConstellationPulse();
    }
  }, 760);
  if (variant === "save") {
    opusProgress.saveChordTimer = window.setInterval(spawnOpusSaveRingChord, 2700);
    opusProgress.saveParticleTimer = window.setInterval(spawnOpusSaveParticleCluster, 1500);
    window.setTimeout(spawnOpusSaveRingChord, 120);
  }
  if (variant !== "load") {
    opusProgress.shootTimer = window.setInterval(() => {
      if (!opusProgress.active) return;
      if (isOpusPsdParseActive()) return;
      if (Math.random() < 0.68) spawnOpusShootingStar();
    }, 3600);
  }
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
  if (opusProgress.saveChordTimer != null) {
    clearInterval(opusProgress.saveChordTimer);
    opusProgress.saveChordTimer = null;
  }
  if (opusProgress.saveParticleTimer != null) {
    clearInterval(opusProgress.saveParticleTimer);
    opusProgress.saveParticleTimer = null;
  }
  if (!keepDom) {
    const modal = $("progress-modal");
    modal?.classList.remove("opus-progress-active");
    if (modal) delete modal.dataset.progressVariant;
  }
  opusProgress.stage = null;
  opusProgress.nodes = null;
  opusProgress.lastAppliedPct = -1;
  opusProgress.lastCopyKey = "";
  opusProgress.lastConstellationAdvanceAt = 0;
  opusProgress.milkyBloomStars = [];
  opusProgress.milkyBloomRevealed = 0;
  opusProgress.psdParseStars = [];
  opusProgress.psdParseRevealed = false;
  opusProgress.constellationQueue = [];
  opusProgress.constellationCurrent = null;
  opusProgress.constellationSerial = 0;
  opusProgress.lastConstellationTemplateIndex = -1;
  opusProgress.lastCountCurrent = null;
  opusProgress.lastCountTotal = null;
  opusProgress.saveCompleted = 0;
  opusProgress.taskNames = OPUS_LOAD_TASKS;
  opusProgress.taskIndex = 0;
  opusProgress.lastTaskKey = "";
  opusProgress.lastFlowStepId = null;
  opusProgress.lastFlowPhaseSerial = -1;
  opusProgress.flowSnapshot = null;
  opusProgress.completionBurstPlayed = false;
}

function cacheOpusNodes(stage) {
  return {
    bgStars: stage.querySelector(".opus-bg-stars"),
    starField: stage.querySelector(".opus-star-field"),
    constellationSvg: stage.querySelector(".opus-constellation-svg"),
    milkyGlow: stage.querySelector(".opus-milky-glow"),
    chapterNum: stage.querySelector(".opus-chapter-num"),
    chapterName: stage.querySelector(".opus-chapter-name"),
    chapterNameEn: stage.querySelector(".opus-chapter-name-en"),
    counter: stage.querySelector(".opus-counter"),
    counterPages: stage.querySelector(".opus-counter-pages"),
    counterPercent: stage.querySelector(".opus-counter-percent"),
    taskPanel: stage.querySelector(".opus-task-panel"),
    taskList: stage.querySelector(".opus-task-list"),
    taskTotalLabel: stage.querySelector(".opus-task-total-label"),
    taskTotalPercent: stage.querySelector(".opus-task-total-percent"),
    saveLayer: stage.querySelector(".opus-save-layer"),
    saveRings: stage.querySelector(".opus-save-rings"),
    saveCore: stage.querySelector(".opus-save-core"),
    saveCounterCurrent: stage.querySelector(".opus-save-counter-current"),
    saveCounterTotal: stage.querySelector(".opus-save-counter-total"),
    saveFinalNum: stage.querySelector(".opus-save-final-num"),
  };
}

function generateOpusBackgroundStars(stage) {
  const container = opusProgress.nodes?.bgStars ?? stage.querySelector(".opus-bg-stars");
  if (!container) return;
  container.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (let i = 0; i < OPUS_AMBIENT_COUNT; i++) {
    const pos = randomOpusSkyPosition({ avoidTaskPanel: true });
    frag.appendChild(createOpusBgStar(pos.x, pos.y));
  }
  for (let i = 0; i < OPUS_DEEP_SPACE_COUNT; i++) {
    const pos = randomOpusDeepSpacePosition();
    frag.appendChild(createOpusBgStar(pos.x, pos.y, { deepSpace: true }));
  }

  const milky = [];
  const totalMilky = OPUS_MILKY_COUNT + OPUS_MILKY_BLOOM_COUNT;
  for (let i = 0; i < totalMilky; i++) {
    const t = i / (totalMilky - 1);
    const { x: baseX, y: baseY } = opusMilkyPoint(t);
    const scatter = Math.pow(Math.random(), 2) * 20;
    const angle = Math.random() * Math.PI * 2;
    const x = Math.max(0, Math.min(100, baseX + Math.cos(angle) * scatter));
    const y = Math.max(0, Math.min(100, baseY + Math.sin(angle) * scatter * 0.55));
    milky.push({ x, y, t, bloom: i >= OPUS_MILKY_COUNT });
  }
  const bloomStars = [];
  milky.sort((a, b) => a.t - b.t);
  for (const star of milky) {
    const el = createOpusBgStar(star.x, star.y, { milky: true, bloom: star.bloom });
    frag.appendChild(el);
    if (star.bloom) bloomStars.push(el);
  }
  for (const star of generateOpusMilkyOpenFillStars()) {
    frag.appendChild(createOpusBgStar(star.x, star.y, { milky: true, openingFill: true }));
  }
  const psdParseStars = [];
  for (const star of generateOpusPsdParseFillStars()) {
    const el = createOpusBgStar(star.x, star.y, { milky: true, bloom: true, psdFill: true });
    frag.appendChild(el);
    psdParseStars.push(el);
  }
  opusProgress.milkyBloomStars = shuffleArray(bloomStars);
  opusProgress.psdParseStars = shuffleArray(psdParseStars);
  container.appendChild(frag);
}

function generateOpusMilkyOpenFillStars() {
  const stars = [];
  for (let i = 0; i < OPUS_MILKY_OPEN_FILL_COUNT; i++) {
    const leftLower = i < OPUS_MILKY_OPEN_FILL_COUNT * 0.44;
    const t = leftLower
      ? 0.68 + Math.random() * 0.32
      : Math.pow(Math.random(), 0.88);
    const u = 1 - t;
    const baseX = (u * u * u * 92) + (3 * u * u * t * 76) + (3 * u * t * t * 35) + (t * t * t * 12);
    const baseY = (u * u * u * 12) + (3 * u * u * t * 20) + (3 * u * t * t * 88) + (t * t * t * 95);
    const scatter = (leftLower ? 9 : 6) + Math.pow(Math.random(), 1.55) * (leftLower ? 24 : 18);
    const angle = Math.random() * Math.PI * 2;
    const x = Math.max(0, Math.min(100, baseX + Math.cos(angle) * scatter));
    const y = Math.max(0, Math.min(100, baseY + Math.sin(angle) * scatter * (leftLower ? 0.78 : 0.54)));
    stars.push({ x, y });
  }
  return stars;
}

function opusMilkyPoint(t) {
  const u = 1 - t;
  return {
    x: (u * u * u * 92) + (3 * u * u * t * 76) + (3 * u * t * t * 35) + (t * t * t * 12),
    y: (u * u * u * 12) + (3 * u * u * t * 20) + (3 * u * t * t * 88) + (t * t * t * 95),
  };
}

function randomOpusSkyPosition({ avoidTaskPanel = false } = {}) {
  for (let i = 0; i < 12; i++) {
    const pos = { x: Math.random() * 100, y: Math.random() * 100 };
    if (!avoidTaskPanel || !isOpusTaskPanelArea(pos)) return pos;
  }
  return { x: Math.random() * 72, y: Math.random() * 100 };
}

function isOpusTaskPanelArea({ x, y }) {
  return x > 61 && y > 56;
}

function distanceToOpusMilkyPath(x, y) {
  let nearest = Infinity;
  for (let i = 0; i <= 16; i++) {
    const p = opusMilkyPoint(i / 16);
    const dx = (x - p.x) / 100;
    const dy = (y - p.y) / 62;
    nearest = Math.min(nearest, Math.hypot(dx, dy));
  }
  return nearest;
}

function randomOpusDeepSpacePosition() {
  let best = randomOpusSkyPosition({ avoidTaskPanel: true });
  let bestDistance = distanceToOpusMilkyPath(best.x, best.y);
  for (let i = 0; i < 18; i++) {
    const pos = randomOpusSkyPosition({ avoidTaskPanel: true });
    const distance = distanceToOpusMilkyPath(pos.x, pos.y);
    if (distance > bestDistance) {
      best = pos;
      bestDistance = distance;
    }
    if (distance > 0.18) return pos;
  }
  return best;
}

function generateOpusPsdParseFillStars() {
  const stars = [];
  for (let i = 0; i < OPUS_PSD_PARSE_FILL_COUNT; i++) {
    const leftLower = i < OPUS_PSD_PARSE_FILL_COUNT * 0.46;
    const t = leftLower
      ? 0.66 + Math.random() * 0.34
      : Math.pow(Math.random(), 0.92);
    const u = 1 - t;
    const baseX = (u * u * u * 92) + (3 * u * u * t * 76) + (3 * u * t * t * 35) + (t * t * t * 12);
    const baseY = (u * u * u * 12) + (3 * u * u * t * 20) + (3 * u * t * t * 88) + (t * t * t * 95);
    const scatter = (leftLower ? 11 : 8) + Math.pow(Math.random(), 1.7) * (leftLower ? 24 : 17);
    const angle = Math.random() * Math.PI * 2;
    const x = Math.max(0, Math.min(100, baseX + Math.cos(angle) * scatter));
    const y = Math.max(0, Math.min(100, baseY + Math.sin(angle) * scatter * (leftLower ? 0.78 : 0.52)));
    stars.push({ x, y });
  }
  return stars;
}

function createOpusBgStar(x, y, { pending = false, milky = false, bloom = false, psdFill = false, openingFill = false, deepSpace = false } = {}) {
  const el = document.createElement("div");
  el.className = "opus-bg-star"
    + (pending || bloom || psdFill ? " is-pending" : "")
    + (milky ? " is-milky" : "")
    + (bloom ? " is-bloom" : "")
    + (psdFill ? " is-psd-fill" : "")
    + (openingFill ? " is-opening-fill" : "")
    + (deepSpace ? " is-deep-space" : "");
  const size = milky
    ? (bloom ? 0.62 + Math.pow(Math.random(), 0.8) * (psdFill ? 2.2 : 2.6) : 0.68 + Math.pow(Math.random(), openingFill ? 0.8 : 0.55) * (openingFill ? 2.6 : 3.5))
    : deepSpace ? 0.34 + Math.pow(Math.random(), 1.85) * 1.35 : 0.5 + Math.pow(Math.random(), 1.8) * 2.2;
  const opacity = milky
    ? (bloom ? 0.42 + Math.random() * (psdFill ? 0.3 : 0.34) : 0.54 + Math.random() * (openingFill ? 0.28 : 0.42))
    : deepSpace ? 0.16 + Math.random() * 0.34 : 0.35 + Math.random() * 0.45;
  const blueWhite = Math.random() < (milky ? 0.68 : deepSpace ? 0.58 : 0.42);
  const warm = Math.random() < (deepSpace ? 0.10 : 0.18);
  const rgb = blueWhite ? "215,232,255" : warm ? "255,230,190" : "255,255,255";
  el.style.left = `${x}%`;
  el.style.top = `${y}%`;
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  el.style.background = `rgba(${rgb}, ${opacity})`;
  if (size > 1.2) el.style.boxShadow = `0 0 ${size * (milky ? 2.8 : 2.0)}px rgba(${rgb}, ${opacity * 0.7})`;
  if (milky) {
    el.style.setProperty("--milky-min-opacity", String(bloom ? 0.32 + Math.random() * 0.12 : openingFill ? 0.28 + Math.random() * 0.16 : 0.38 + Math.random() * 0.2));
    el.style.setProperty("--milky-max-opacity", String(bloom ? 0.62 + Math.random() * 0.22 : openingFill ? 0.58 + Math.random() * 0.26 : 0.74 + Math.random() * 0.24));
    el.style.setProperty("--psd-rhythm-min-opacity", String(bloom ? 0.18 + Math.random() * 0.12 : openingFill ? 0.18 + Math.random() * 0.13 : 0.24 + Math.random() * 0.18));
    el.style.setProperty("--psd-rhythm-mid-opacity", String(bloom ? 0.52 + Math.random() * 0.2 : openingFill ? 0.48 + Math.random() * 0.22 : 0.58 + Math.random() * 0.26));
    el.style.setProperty("--psd-rhythm-max-opacity", String(bloom ? 0.76 + Math.random() * 0.18 : openingFill ? 0.72 + Math.random() * 0.2 : 0.82 + Math.random() * 0.18));
    el.style.setProperty("--psd-rhythm-dur", `${2.4 + Math.random() * 2.4}s`);
    el.style.setProperty("--psd-rhythm-delay", `${-Math.random() * 4.8}s`);
    const breatheAnim = `opus-milky-star-breathe ${8 + Math.random() * 12}s ease-in-out ${Math.random() * 7}s infinite`;
    el.dataset.breatheAnim = breatheAnim;
    if (!bloom) el.style.animation = breatheAnim;
  } else if (!pending && Math.random() < (deepSpace ? 0.16 : 0.22)) {
    el.style.animation = `opus-bg-star-twinkle ${deepSpace ? 8 + Math.random() * 13 : 5 + Math.random() * 8}s ease-in-out ${Math.random() * 5}s infinite`;
  } else if (pending && Math.random() < 0.22) {
    el.dataset.twinkleAnim = `opus-bg-star-twinkle ${5 + Math.random() * 8}s ease-in-out ${Math.random() * 4}s infinite`;
  }
  return el;
}

function shuffleArray(items) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function startOpusProgressLoop() {
  const tick = (now) => {
    if (!opusProgress.active) {
      opusProgress.raf = null;
      return;
    }
    if (!opusProgress.lastFrameAt) opusProgress.lastFrameAt = now;
    const frameInterval = opusProgress.variant === "save" ? OPUS_SAVE_FRAME_INTERVAL_MS : OPUS_FRAME_INTERVAL_MS;
    if (now - opusProgress.lastFrameAt < frameInterval) {
      opusProgress.raf = requestAnimationFrame(tick);
      return;
    }
    const dt = Math.min(120, now - opusProgress.lastFrameAt);
    opusProgress.lastFrameAt = now;
    if (opusProgress.finishing) {
      setOpusTargetPct(100, now);
    } else if (opusProgress.variant !== "load") {
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

function updateOpusProgress({ detail, current, total, tasks, taskIndex, taskProgress, flow } = {}) {
  if (!opusProgress.active) return;
  if (flow && Array.isArray(flow.steps)) {
    updateOpusFlowProgress(flow, { detail, current, total, tasks, taskIndex, taskProgress });
    return;
  }
  let taskPct = null;
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
    const pct = opusProgress.variant === "load" ? rawPct : mapOpusProgressPct(rawPct);
    taskPct = opusProgress.variant === "place" ? pct : rawPct;
    opusProgress.indeterminate = rawPct <= 0 && opusProgress.targetPct <= opusProgress.phaseStartPct + 0.5;
    setOpusTargetPct(pct);
    if (opusProgress.variant === "save") {
      updateOpusSaveProgress({ current, total });
    } else if (opusProgress.variant === "load") {
      updateOpusTasks({ detail, current, total, tasks, taskIndex, taskProgress, pct: rawPct });
    }
  } else {
    opusProgress.lastRawPct = null;
    opusProgress.indeterminate = true;
  }
  updateOpusCopy({ detail, current, total, tasks, taskIndex, taskProgress });
  if (opusProgress.variant === "scan" || opusProgress.variant === "place") {
    updateOpusTasks({
      detail,
      current,
      total,
      tasks,
      taskIndex,
      taskProgress,
      pct: taskPct ?? Math.max(opusProgress.visualPct, opusProgress.targetPct),
    });
  }
  setOpusPsdParseMode(isOpusPsdParseActive({ detail, tasks }));
}

function updateOpusFlowProgress(flow, payload = {}) {
  const stage = opusProgress.stage || ensureOpusProgressStage();
  if (!stage) return;
  opusProgress.flowSnapshot = flow;
  setOpusPsdParseMode(isOpusPsdParseActive({ detail: payload.detail, flow }));
  const rawPct = Math.max(0, Math.min(100, Number(flow.overallPct) || 0));
  const stepChanged = flow.activeStepId && flow.activeStepId !== opusProgress.lastFlowStepId;
  const phaseChanged = Number.isFinite(flow.phaseSerial) && flow.phaseSerial !== opusProgress.lastFlowPhaseSerial;
  if (stepChanged || phaseChanged) {
    opusProgress.lastFlowStepId = flow.activeStepId;
    opusProgress.lastFlowPhaseSerial = Number.isFinite(flow.phaseSerial) ? flow.phaseSerial : opusProgress.lastFlowPhaseSerial;
  }
  stage.classList.add("has-flow");
  opusProgress.lastRawPct = rawPct;
  opusProgress.indeterminate = false;
  setOpusTargetPct(rawPct);
  updateOpusTasks({ ...payload, flow, pct: rawPct });
  updateOpusCopy({ ...payload, flow });
}

function updateOpusCopy({ detail, current, total, tasks, taskIndex, taskProgress, flow } = {}) {
  const stage = opusProgress.stage || ensureOpusProgressStage();
  if (!stage || !opusProgress.active) return;
  const pct = Math.max(opusProgress.visualPct, opusProgress.targetPct);
  const nodes = opusProgress.nodes || cacheOpusNodes(stage);
  if (flow && Array.isArray(flow.steps)) {
    const active = flow.steps[flow.activeIndex] || flow.steps.find((step) => step.id === flow.activeStepId) || flow.steps[0];
    const stepCurrent = Number.isFinite(active?.current) ? Math.round(active.current) : null;
    const stepTotal = Number.isFinite(active?.total) && active.total > 0 ? Math.round(active.total) : null;
    const counterPagesText = stepCurrent != null && stepTotal != null ? `${stepCurrent}/${stepTotal}` : "";
    const counterPercentText = `${Math.round(flow.completed ? 100 : Math.max(0, Math.min(100, flow.overallPct || pct)))}%`;
    const subtitleText = [active?.labelEn || "processing", flow.remainingLabel].filter(Boolean).join(" / ");
    const copyKey = [
      flow.activeOrdinal,
      active?.label,
      subtitleText,
      counterPagesText,
      counterPercentText,
      flow.phaseSerial,
    ].join("|");
    if (copyKey === opusProgress.lastCopyKey) return;
    opusProgress.lastCopyKey = copyKey;
    setTextIfChanged(nodes.chapterNum, flow.activeOrdinal || "");
    setTextIfChanged(nodes.chapterName, active?.label || flow.title || "");
    setTextIfChanged(nodes.chapterNameEn, subtitleText);
    nodes.counter?.classList.toggle("is-percent-only", !counterPagesText);
    setTextIfChanged(nodes.counterPages, counterPagesText);
    setTextIfChanged(nodes.counterPercent, counterPercentText);
    return;
  }
  const copy = getOpusCopy(opusProgress.variant, pct, detail);
  const incomingHasCount = Number.isFinite(current) && Number.isFinite(total) && total > 0;
  if (incomingHasCount) {
    opusProgress.lastCountCurrent = current;
    opusProgress.lastCountTotal = total;
  }
  const hasCount = Number.isFinite(opusProgress.lastCountCurrent)
    && Number.isFinite(opusProgress.lastCountTotal)
    && opusProgress.lastCountTotal > 0;
  const displayTotal = hasCount ? Math.round(opusProgress.lastCountTotal) : 0;
  const displayCurrent = hasCount
    ? (opusProgress.finishing
      ? displayTotal
      : Math.max(0, Math.min(displayTotal, Math.round(opusProgress.lastCountCurrent))))
    : 0;
  const counterPagesText = hasCount ? `${displayCurrent}/${displayTotal}P` : "";
  const rawPercent = incomingHasCount
    ? (current / total) * 100
    : hasCount
      ? (displayCurrent / Math.max(displayTotal, 1)) * 100
      : pct;
  const counterPercentText = `${Math.round(opusProgress.finishing ? 100 : Math.max(0, Math.min(100, rawPercent)))}%`;
  const copyKey = [
    copy.num,
    copy.name,
    copy.en,
    counterPagesText,
    counterPercentText,
    hasCount ? "count" : "percent",
  ].join("|");
  if (copyKey === opusProgress.lastCopyKey) return;
  opusProgress.lastCopyKey = copyKey;
  setTextIfChanged(nodes.chapterNum, copy.num);
  setTextIfChanged(nodes.chapterName, copy.name);
  setTextIfChanged(nodes.chapterNameEn, copy.en);
  nodes.counter?.classList.toggle("is-percent-only", !hasCount);
  setTextIfChanged(nodes.counterPages, counterPagesText);
  setTextIfChanged(nodes.counterPercent, counterPercentText);
  if (opusProgress.variant === "load") {
    updateOpusTasks({ detail, current, total, tasks, taskIndex, taskProgress });
  }
}

function setTextIfChanged(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

function getOpusCopy(variant, pct, detail = "") {
  if (variant === "load") {
    if (pct < 35) return { num: "LOAD", name: "ファイル読込", en: "reading files" };
    if (pct < 86) return { num: "LOAD", name: "内容解析", en: "parsing content" };
    return { num: "LOAD", name: "表示準備", en: "preparing view" };
  }
  if (variant === "save") {
    if (pct < 24) return { num: "PSD", name: "Sending to Photoshop", en: "opening documents" };
    if (pct < 88) return { num: "PSD", name: "Writing changes", en: "saving documents" };
    return { num: "PSD", name: "Finalizing", en: "closing documents" };
  }
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
  if (pct >= 99 && !/完了|complete/i.test(detail)) return { num: "III", name: "最終調整中", en: "finalizing" };
  return { num: "III", name: "仕上げを反映する", en: "finishing the page" };
}

function applyOpusProgress(pct) {
  const stage = opusProgress.stage || ensureOpusProgressStage();
  if (!stage) return;
  const clamped = Math.max(0, Math.min(100, pct));
  const rounded = Math.round(clamped * 10) / 10;
  if (Math.abs(rounded - opusProgress.lastAppliedPct) < 0.1) return;
  opusProgress.lastAppliedPct = rounded;
  stage.style.setProperty("--opus-progress-pct", `${rounded}%`);
  $("progress-modal")?.style.setProperty("--opus-progress-pct", `${rounded}%`);
  const nodes = opusProgress.nodes || cacheOpusNodes(stage);
  if (nodes.milkyGlow) nodes.milkyGlow.style.opacity = String(0.52 + 0.22 * (rounded / 100));
  if (!isOpusPsdParseActive()) revealOpusMilkyBloomStars(rounded);
  stage.classList.add("is-milky-visible");
}

function revealOpusMilkyBloomStars(pct) {
  const targetRatio = Math.max(0, Math.min(1, Math.pow(pct / 100, 1.18)));
  const target = Math.round(targetRatio * opusProgress.milkyBloomStars.length);
  let revealedThisFrame = 0;
  const maxRevealPerFrame = opusProgress.finishing ? 6 : 18;
  while (opusProgress.milkyBloomRevealed < target && revealedThisFrame < maxRevealPerFrame) {
    const el = opusProgress.milkyBloomStars[opusProgress.milkyBloomRevealed++];
    revealedThisFrame++;
    if (!el) continue;
    el.classList.remove("is-pending");
    const breatheAnim = el.dataset.breatheAnim;
    if (breatheAnim) {
      el.style.animation = "opus-milky-bloom-in 1.2s ease-out forwards";
      setTimeout(() => {
        if (!el.classList.contains("is-pending")) el.style.animation = breatheAnim;
      }, 1200);
    }
  }
}

function randomBetween(min, max) {
  return min + Math.random() * Math.max(0, max - min);
}

function normalizeOpusTaskNames(tasks) {
  if (!Array.isArray(tasks)) return opusProgress.taskNames?.length ? opusProgress.taskNames : OPUS_LOAD_TASKS;
  const names = tasks
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .slice(0, 6);
  return names.length ? names : OPUS_LOAD_TASKS;
}

function getDefaultOpusTaskNames(variant) {
  if (variant === "scan") return OPUS_SCAN_TASKS;
  return variant === "place" ? OPUS_PLACE_TASKS : OPUS_LOAD_TASKS;
}

function isOpusPsdParseActive({ detail, tasks, flow } = {}) {
  const flowData = flow ?? opusProgress.flowSnapshot;
  if (flowData && Array.isArray(flowData.steps)) {
    const active = flowData.steps[flowData.activeIndex]
      || flowData.steps.find((step) => step.id === flowData.activeStepId)
      || flowData.steps[0];
    const text = `${active?.id ?? ""} ${active?.label ?? ""} ${active?.labelEn ?? ""} ${detail ?? ""}`;
    return /psd/i.test(text);
  }
  if (opusProgress.variant !== "load") return false;
  const text = [
    detail,
    ...(Array.isArray(tasks) ? tasks : []),
    ...(Array.isArray(opusProgress.taskNames) ? opusProgress.taskNames : []),
  ].filter(Boolean).join(" ");
  return /psd/i.test(text);
}

function setOpusPsdParseMode(active) {
  const stage = opusProgress.stage || ensureOpusProgressStage();
  if (!stage) return;
  const shouldEnable = !!active;
  const wasEnabled = stage.classList.contains("is-psd-parse");
  stage.classList.toggle("is-psd-parse", shouldEnable);
  if (shouldEnable) stage.classList.add("has-milky-rhythm");
  if (!shouldEnable || wasEnabled) return;
  opusProgress.constellationQueue = [];
  opusProgress.constellationCurrent = null;
  opusProgress.nodes?.starField?.replaceChildren();
  opusProgress.nodes?.constellationSvg?.replaceChildren();
  revealOpusPsdParseStars();
}

function revealOpusPsdParseStars() {
  if (opusProgress.psdParseRevealed) return;
  opusProgress.psdParseRevealed = true;
  opusProgress.psdParseStars.forEach((el, index) => {
    if (!el) return;
    window.setTimeout(() => {
      el.classList.remove("is-pending");
      if (el.dataset.breatheAnim) el.style.animation = el.dataset.breatheAnim;
    }, Math.min(1100, index * 14 + Math.random() * 220));
  });
}

function inferOpusTaskIndex({ pct = 0, taskIndex } = {}) {
  const count = Math.max(1, opusProgress.taskNames?.length || OPUS_LOAD_TASKS.length);
  if (Number.isFinite(taskIndex)) {
    return Math.max(0, Math.min(count - 1, Math.round(taskIndex)));
  }
  if (pct >= 100) return count - 1;
  return Math.max(0, Math.min(count - 1, Math.floor((Math.max(0, pct) / 100) * count)));
}

function updateOpusTasks({ detail, current, total, tasks, taskIndex, taskProgress, pct, flow } = {}) {
  const stage = opusProgress.stage || ensureOpusProgressStage();
  const nodes = opusProgress.nodes || (stage ? cacheOpusNodes(stage) : null);
  if (!stage || !nodes?.taskList) return;
  if (flow && Array.isArray(flow.steps)) {
    updateOpusFlowTasks({ detail, flow, nodes });
    return;
  }
  const names = normalizeOpusTaskNames(tasks);
  opusProgress.taskNames = names;
  const hasCount = Number.isFinite(current) && Number.isFinite(total) && total > 0;
  const rawPct = Number.isFinite(pct)
    ? pct
    : hasCount
      ? Math.max(0, Math.min(100, (current / total) * 100))
      : Math.max(opusProgress.visualPct, opusProgress.targetPct);
  const activeIndex = inferOpusTaskIndex({ pct: rawPct, taskIndex });
  opusProgress.taskIndex = activeIndex;
  const safePct = Math.round(Math.max(0, Math.min(100, rawPct)));
  const activeName = names[activeIndex] || names[0] || "処理";
  const completed = safePct >= 100;
  const taskHeading = buildOpusTaskHeading({
    label: activeName,
    detail,
    completed,
  });
  const key = [
    names.join("|"),
    activeIndex,
    safePct,
    taskHeading.primary,
    taskHeading.secondary,
    String(detail ?? "").slice(0, 48),
  ].join("::");
  if (key === opusProgress.lastTaskKey) return;
  opusProgress.lastTaskKey = key;
  setOpusTaskTotalLabel(nodes, taskHeading.primary, taskHeading.secondary);
  if (nodes.taskTotalPercent) nodes.taskTotalPercent.textContent = `${safePct}%`;
  const frag = document.createDocumentFragment();
  names.forEach((name, index) => {
    const item = document.createElement("div");
    item.className = "opus-task-item";
    if (safePct >= 100 || index < activeIndex) item.classList.add("is-done");
    else if (index === activeIndex) item.classList.add("is-active");
    const dot = document.createElement("span");
    dot.className = "opus-task-dot";
    const text = document.createElement("span");
    text.className = "opus-task-name";
    text.textContent = name;
    const status = document.createElement("span");
    status.className = "opus-task-status";
    status.textContent = index < activeIndex || safePct >= 100
      ? "完了"
      : index === activeIndex
        ? "実行中"
        : "次";
    item.append(dot, text, status);
    frag.appendChild(item);
  });
  nodes.taskList.replaceChildren(frag);
}

function updateOpusFlowTasks({ detail, flow, nodes }) {
  const activeIndex = Math.max(0, Number(flow.activeIndex) || 0);
  const safePct = Math.round(Math.max(0, Math.min(100, Number(flow.overallPct) || 0)));
  const active = flow.steps[activeIndex] || flow.steps.find((step) => step.id === flow.activeStepId) || flow.steps[0];
  const activeDetailComplete = isOpusCompletionDetail(detail);
  const taskHeading = buildOpusTaskHeading({
    label: active?.label || flow.title || "処理",
    detail,
    completed: flow.completed || active?.status === "done" || active?.progress >= 100,
    remainingLabel: flow.remainingLabel,
    allCompleted: flow.completed,
  });
  const key = [
    flow.id,
    flow.phaseSerial,
    flow.activeStepId,
    safePct,
    flow.steps.map((step) => `${step.id}:${step.status}:${Math.round(step.progress || 0)}:${step.current ?? ""}/${step.total ?? ""}`).join("|"),
    taskHeading.primary,
    taskHeading.secondary,
    String(detail ?? "").slice(0, 48),
  ].join("::");
  if (key === opusProgress.lastTaskKey) return;
  opusProgress.lastTaskKey = key;
  setOpusTaskTotalLabel(nodes, taskHeading.primary, taskHeading.secondary);
  if (nodes.taskTotalPercent) nodes.taskTotalPercent.textContent = `${safePct}%`;
  const frag = document.createDocumentFragment();
  flow.steps.forEach((step, index) => {
    const isActiveStep = step.id === flow.activeStepId;
    const isStepDone = flow.completed
      || index < activeIndex
      || (!isActiveStep && (step.status === "done" || step.progress >= 100))
      || (isActiveStep && activeDetailComplete);
    const item = document.createElement("div");
    item.className = "opus-task-item";
    if (isStepDone) item.classList.add("is-done");
    else if (isActiveStep) item.classList.add("is-active");
    const dot = document.createElement("span");
    dot.className = "opus-task-dot";
    const text = document.createElement("span");
    text.className = "opus-task-name";
    text.textContent = step.label;
    const status = document.createElement("span");
    status.className = "opus-task-status";
    if (isStepDone) {
      status.textContent = "完了";
    } else if (isActiveStep && Number.isFinite(step.current) && Number.isFinite(step.total) && step.total > 0) {
      status.textContent = `${Math.round(step.current)}/${Math.round(step.total)}`;
    } else if (isActiveStep) {
      status.textContent = "実行中";
    } else {
      status.textContent = "次";
    }
    item.append(dot, text, status);
    frag.appendChild(item);
  });
  nodes.taskList.replaceChildren(frag);
}

function buildOpusTaskHeading({ label, detail, completed = false, remainingLabel = "", allCompleted = false } = {}) {
  const baseLabel = String(label ?? "").trim() || "処理";
  const detailComplete = isOpusCompletionDetail(detail);
  const detailRunning = isOpusRunningDetail(detail);
  const showComplete = allCompleted || (completed && detailComplete && !detailRunning);
  const primary = allCompleted
    ? "すべて完了"
    : showComplete
      ? `${baseLabel} 完了`
      : formatOpusRunningLabel(baseLabel);
  const secondaryParts = [
    normalizeOpusTaskSupplement(detail, baseLabel, primary, { completed: showComplete, allCompleted }),
    showComplete ? "" : String(remainingLabel ?? "").trim(),
  ].filter(Boolean);
  const secondary = secondaryParts.join("\n");
  return { primary, secondary };
}

function formatOpusRunningLabel(label) {
  const text = String(label ?? "").trim();
  if (!text) return "処理中…";
  if (/中[…。]*$|実行中[…。]*$/.test(text)) return text;
  if (/(読込|読み込み|解析|準備|スキャン|配置|調整|抽出|書き起こし|保存|反映|仕上げ)$/.test(text)) {
    return `${text}中…`;
  }
  return `${text}を実行中…`;
}

function normalizeOpusTaskSupplement(detail, activeLabel, primaryLabel, { completed = false, allCompleted = false } = {}) {
  const text = String(detail ?? "").trim();
  if (!text) return "";
  if (allCompleted) return "";
  if (completed && isOpusRunningDetail(text)) {
    return "";
  }
  const compact = (value) => String(value ?? "")
    .replace(/[。、，,・\s…]+/g, "")
    .replace(/を?実行中|中|完了|処理中/g, "")
    .trim();
  const normalizedDetail = compact(text);
  if (!normalizedDetail) return "";
  if (normalizedDetail === compact(activeLabel) || normalizedDetail === compact(primaryLabel)) return "";
  return splitOpusSupplementText(text).join("\n");
}

function isOpusCompletionDetail(detail = "") {
  return /(?:^|[\s　])(?:完了|complete)(?:$|[\s　…。！!）)])/i.test(String(detail ?? ""));
}

function isOpusRunningDetail(detail = "") {
  return /(?:実行中|起動中|読込中|読み込み中|計算中|準備中|展開中|処理中|配置中|調整中|解析中|スキャン中)/.test(String(detail ?? ""));
}

function splitOpusSupplementText(text) {
  const normalized = String(text ?? "")
    .replace(/\s*[（(](完了まで[^）)]+)[）)]\s*/g, "\n$1")
    .replace(/\s*\/\s*/g, "\n")
    .trim();
  const lines = normalized
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  return joinOpusEtaSupplementLines(lines);
}

function joinOpusEtaSupplementLines(lines) {
  const result = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const next = lines[index + 1] ?? "";
    if (/^完了まで/.test(line) && /^残り/.test(next)) {
      result.push(`${line} / ${next}`);
      index += 1;
    } else {
      result.push(line);
    }
  }
  return result;
}

function setOpusTaskTotalLabel(nodes, label, secondary = "") {
  const el = nodes?.taskTotalLabel;
  if (!el) return;
  const { sub } = splitOpusTaskLabel(label, secondary);
  const lines = splitOpusSupplementText(sub);
  el.replaceChildren();
  el.hidden = lines.length === 0;
  if (!lines.length) return;
  const subEl = document.createElement("span");
  subEl.className = "opus-task-total-sub";
  lines.forEach((line) => {
    const lineEl = document.createElement("span");
    lineEl.className = "opus-task-total-sub-line";
    lineEl.textContent = line;
    subEl.appendChild(lineEl);
  });
  el.appendChild(subEl);
  }

function splitOpusTaskLabel(label, secondary = "") {
  const text = String(label ?? "").trim();
  const sub = String(secondary ?? "").trim();
  const approxMatch = text.match(/^(.*?)\s*[（(](完了まで[^）)]+)[）)]\s*$/);
  if (!approxMatch) return { primary: text, sub };
  return {
    primary: approxMatch[1].trim(),
    sub: sub || approxMatch[2].trim(),
  };
}

function resetOpusSaveStage({ current = 0, total = 0 } = {}) {
  const stage = opusProgress.stage || ensureOpusProgressStage();
  const nodes = opusProgress.nodes || (stage ? cacheOpusNodes(stage) : null);
  if (!stage || !nodes) return;
  nodes.saveRings?.replaceChildren();
  stage.querySelectorAll(".opus-save-particle").forEach((el) => el.remove());
  if (nodes.saveCounterCurrent) nodes.saveCounterCurrent.textContent = String(Math.max(0, Math.round(current)));
  if (nodes.saveCounterTotal) nodes.saveCounterTotal.textContent = `${Math.max(0, Math.round(total))}P`;
  if (nodes.saveCore) {
    nodes.saveCore.style.width = "14px";
    nodes.saveCore.style.height = "14px";
  }
}

function updateOpusSaveProgress({ current = 0, total = 0 } = {}) {
  const stage = opusProgress.stage || ensureOpusProgressStage();
  const nodes = opusProgress.nodes || (stage ? cacheOpusNodes(stage) : null);
  if (!stage || !nodes) return;
  const safeTotal = Math.max(0, Math.round(total));
  const safeCurrent = Math.max(0, Math.min(safeTotal || Infinity, Math.round(current)));
  if (nodes.saveCounterTotal) nodes.saveCounterTotal.textContent = `${safeTotal}P`;
  if (safeCurrent > opusProgress.saveCompleted) {
    const burstCount = Math.min(4, safeCurrent - opusProgress.saveCompleted);
    for (let i = 0; i < burstCount; i++) {
      window.setTimeout(() => spawnOpusSaveRing(true), i * 120);
    }
    setOpusSaveCounter(safeCurrent);
  }
  growOpusSaveCore(safeCurrent, safeTotal);
  opusProgress.saveCompleted = Math.max(opusProgress.saveCompleted, safeCurrent);
}

function setOpusSaveCounter(value) {
  const stage = opusProgress.stage || ensureOpusProgressStage();
  const nodes = opusProgress.nodes || (stage ? cacheOpusNodes(stage) : null);
  const el = nodes?.saveCounterCurrent;
  if (!el) return;
  el.textContent = String(value);
  el.classList.remove("is-pop");
  void el.offsetWidth;
  el.classList.add("is-pop");
}

function growOpusSaveCore(current, total) {
  const stage = opusProgress.stage || ensureOpusProgressStage();
  const nodes = opusProgress.nodes || (stage ? cacheOpusNodes(stage) : null);
  if (!nodes?.saveCore) return;
  const ratio = total > 0 ? Math.max(0, Math.min(1, current / total)) : Math.max(0, Math.min(1, opusProgress.targetPct / 100));
  const size = 14 + (20 - 14) * ratio;
  nodes.saveCore.style.width = `${size}px`;
  nodes.saveCore.style.height = `${size}px`;
}

function spawnOpusSaveRingChord() {
  if (!opusProgress.active || opusProgress.variant !== "save" || opusProgress.finishing) return;
  const chordSize = Math.random() < 0.28 ? 3 : 2;
  for (let i = 0; i < chordSize; i++) {
    window.setTimeout(() => spawnOpusSaveRing(false), i * (160 + Math.random() * 80));
  }
}

function spawnOpusSaveRing(isStrong = false) {
  const stage = opusProgress.stage || ensureOpusProgressStage();
  const nodes = opusProgress.nodes || (stage ? cacheOpusNodes(stage) : null);
  const layer = nodes?.saveRings;
  if (!layer) return;
  const ring = document.createElement("div");
  ring.className = `opus-save-ring${isStrong ? " is-strong" : ""}`;
  if (!isStrong) {
    ring.style.borderWidth = `${(0.9 + Math.random() * 0.5).toFixed(2)}px`;
    ring.style.transform = `rotate(${Math.random() * 360}deg)`;
  }
  layer.appendChild(ring);
  window.setTimeout(() => ring.remove(), isStrong ? 4500 : 3900);
}

function spawnOpusSaveParticleCluster() {
  if (!opusProgress.active || opusProgress.variant !== "save" || opusProgress.finishing) return;
  const count = Math.random() < 0.4 ? 3 : 2;
  for (let i = 0; i < count; i++) {
    window.setTimeout(spawnOpusSaveParticle, i * (70 + Math.random() * 80));
  }
}

function spawnOpusSaveParticle() {
  const stage = opusProgress.stage || ensureOpusProgressStage();
  if (!stage || opusProgress.variant !== "save") return;
  const particle = document.createElement("div");
  particle.className = "opus-save-particle";
  particle.style.setProperty("--angle", `${Math.random() * 360}deg`);
  particle.style.setProperty("--distance", `${180 + Math.random() * 240}px`);
  particle.style.setProperty("--dur", `${5.5 + Math.random() * 5.5}s`);
  stage.appendChild(particle);
  const dur = parseFloat(particle.style.getPropertyValue("--dur")) || 8;
  window.setTimeout(() => particle.remove(), (dur + 0.5) * 1000);
}

function clamp01(value) {
  return Math.max(0.04, Math.min(0.96, value));
}

function seededJitter(index, axis) {
  const seed = (axis === "x" ? 12.9898 : 78.233) * (index + 1);
  const raw = Math.sin(seed) * 43758.5453;
  return (raw - Math.floor(raw)) * 2 - 1;
}

function advanceOpusConstellationByTime(now = performance.now()) {
  if (isOpusPsdParseActive()) return;
  if (opusProgress.variant !== "place" && opusProgress.variant !== "load") return;
  fadeExpiredOpusConstellations(now);
  if (opusProgress.lastConstellationAdvanceAt && now - opusProgress.lastConstellationAdvanceAt < OPUS_CONSTELLATION_AUTO_STEP_MS) return;
  const canBurst = activeOpusConstellationCount() <= OPUS_CONSTELLATION_MAX_VISIBLE - 2;
  const burstCount = canBurst && Math.random() < OPUS_CONSTELLATION_BURST_CHANCE ? 2 : 1;
  if (advanceOpusConstellationBurst(burstCount, { stagger: true })) {
    opusProgress.lastConstellationAdvanceAt = now;
  }
}

function advanceOpusConstellationBurst(count = 1, { stagger = false } = {}) {
  pruneOpusConstellationQueue();
  const safeCount = Math.max(1, Math.min(2, Math.round(count)));
  for (let i = 0; i < safeCount; i++) {
    const launch = () => {
      if (!opusProgress.active || (opusProgress.variant !== "place" && opusProgress.variant !== "load")) return;
      startOpusConstellation();
    };
    if (stagger && i > 0) {
      window.setTimeout(launch, randomBetween(360, 620) * i);
    } else {
      launch();
    }
  }
  return true;
}

function startOpusConstellation() {
  const instance = createOpusConstellationInstance();
  opusProgress.constellationCurrent = instance;
  opusProgress.constellationQueue.push(instance);
  while (activeOpusConstellationCount() > OPUS_CONSTELLATION_MAX_VISIBLE) {
    fadeOldestOpusConstellation();
  }
  scheduleOpusConstellationGrowth(instance);
  return instance;
}

function scheduleOpusConstellationGrowth(instance) {
  const grow = () => {
    if (!opusProgress.active || instance.fading || instance.removed) return;
    const didSpawn = spawnOpusConstellationStar(instance);
    if (didSpawn && instance.spawned < instance.points.length) {
      window.setTimeout(grow, randomBetween(520, 900));
    }
  };
  window.setTimeout(grow, randomBetween(0, 85));
}

function activeOpusConstellationCount() {
  return opusProgress.constellationQueue.filter((item) => !item.fading).length;
}

function createOpusConstellationInstance() {
  const template = chooseOpusConstellationTemplate();
  const serial = opusProgress.constellationSerial++;
  const scale = OPUS_CONSTELLATION_SCALE * randomBetween(0.62, 0.98);
  const placement = chooseOpusConstellationPlacement(scale);
  const centerX = placement.x;
  const centerY = placement.y;
  const angle = randomBetween(-0.78, 0.78);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const mirror = Math.random() < 0.5 ? -1 : 1;
  const stretchX = randomBetween(0.88, 1.16) * mirror;
  const stretchY = randomBetween(0.86, 1.14);
  const points = template.points.map(([x, y, isKey], pointIndex) => {
    const tx = x * stretchX;
    const ty = y * stretchY;
    const rx = (tx * cos - ty * sin) * scale;
    const ry = (tx * sin + ty * cos) * scale;
    const jitter = isKey ? 0.004 : 0.008;
    return [
      clamp01(centerX + rx + seededJitter(serial * 31 + pointIndex, "x") * jitter),
      clamp01(centerY + ry + seededJitter(serial * 31 + pointIndex, "y") * jitter),
      isKey,
      template.name,
    ];
  });
  return {
    id: `opus-constellation-${serial}`,
    name: template.name,
    points,
    lines: template.lines,
    spawned: 0,
    drawnLines: new Set(),
    elements: [],
    lineElements: [],
    centerX,
    centerY,
    radius: placement.radius,
    fading: false,
    createdAt: performance.now(),
    lifeMs: randomBetween(OPUS_CONSTELLATION_LIFE_MIN_MS, OPUS_CONSTELLATION_LIFE_MAX_MS),
  };
}

function chooseOpusConstellationTemplate() {
  const count = OPUS_CONSTELLATION_TEMPLATES.length;
  if (count <= 1) return OPUS_CONSTELLATION_TEMPLATES[0];
  let index = Math.floor(Math.random() * count);
  for (let tries = 0; tries < 4 && index === opusProgress.lastConstellationTemplateIndex; tries++) {
    index = Math.floor(Math.random() * count);
  }
  opusProgress.lastConstellationTemplateIndex = index;
  return OPUS_CONSTELLATION_TEMPLATES[index];
}

function chooseOpusConstellationPlacement(scale) {
  const radius = Math.max(0.09, Math.min(0.145, scale * 0.22));
  const active = opusProgress.constellationQueue.filter((item) => !item.removed);
  let best = null;
  let bestScore = -Infinity;
  for (let i = 0; i < OPUS_CONSTELLATION_PLACEMENT_TRIES; i++) {
    const candidate = {
      x: randomBetween(0.08 + radius, 0.92 - radius),
      y: randomBetween(0.09 + radius, 0.90 - radius),
      radius,
    };
    const nearest = nearestOpusConstellationDistance(candidate, active);
    const milkyDistance = constellationDistanceToMilkyPath(candidate);
    const taskPanelPenalty = isOpusConstellationTaskPanelArea(candidate) ? 0.34 : 0;
    const milkyCenterPenalty = milkyDistance < 0.07 ? (0.07 - milkyDistance) * 2.1 : 0;
    const edgeBalance = Math.min(candidate.x, 1 - candidate.x, candidate.y, 1 - candidate.y);
    const score = (Number.isFinite(nearest) ? nearest : 0.5)
      + Math.min(milkyDistance, 0.22) * 0.55
      + edgeBalance * 0.18
      - taskPanelPenalty
      - milkyCenterPenalty;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
    if (
      nearest >= requiredOpusConstellationDistance(candidate, active)
      && milkyDistance >= 0.07
      && !isOpusConstellationTaskPanelArea(candidate)
    ) {
      return candidate;
    }
  }
  return best ?? { x: 0.5, y: 0.5, radius };
}

function constellationDistanceToMilkyPath(candidate) {
  return distanceToOpusMilkyPath(candidate.x * 100, candidate.y * 100);
}

function isOpusConstellationTaskPanelArea(candidate) {
  return isOpusTaskPanelArea({ x: candidate.x * 100, y: candidate.y * 100 });
}

function nearestOpusConstellationDistance(candidate, active) {
  if (!active.length) return Infinity;
  return active.reduce((nearest, item) => {
    const distance = Math.hypot(candidate.x - item.centerX, candidate.y - item.centerY);
    return Math.min(nearest, distance - candidate.radius - (item.radius ?? 0.12));
  }, Infinity);
}

function requiredOpusConstellationDistance(candidate, active) {
  if (!active.length) return 0;
  return OPUS_CONSTELLATION_MIN_GAP;
}

function spawnOpusConstellationStar(instance) {
  const stage = opusProgress.stage || ensureOpusProgressStage();
  const nodes = opusProgress.nodes || (stage ? cacheOpusNodes(stage) : null);
  const field = nodes?.starField;
  const svg = nodes?.constellationSvg;
  const index = instance?.spawned ?? 0;
  const point = instance?.points?.[index];
  if (!stage || !field || !svg || !point) return false;
  const [x, y, isKey] = point;
  const el = document.createElement("div");
  el.className = "opus-star" + (isKey ? " is-key" : "");
  el.dataset.constellationId = instance.id;
  el.style.left = `${x * 100}%`;
  el.style.top = `${y * 100}%`;
  el.style.setProperty("--twinkle-dur", `${3.4 + Math.random() * 3}s`);
  field.appendChild(el);
  instance.elements.push(el);

  for (const [a, b] of instance.lines) {
    const key = `${a}-${b}`;
    if (instance.drawnLines.has(key)) continue;
    if (a <= index && b <= index) {
      instance.drawnLines.add(key);
      const p1 = instance.points[a];
      const p2 = instance.points[b];
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(p1[0] * 1000));
      line.setAttribute("y1", String(p1[1] * 1000));
      line.setAttribute("x2", String(p2[0] * 1000));
      line.setAttribute("y2", String(p2[1] * 1000));
      line.setAttribute("class", "opus-connection");
      line.dataset.constellationId = instance.id;
      line.setAttribute("vector-effect", "non-scaling-stroke");
      const len = Math.hypot((p2[0] - p1[0]) * 1000, (p2[1] - p1[1]) * 1000);
      line.style.strokeDasharray = String(len);
      line.style.strokeDashoffset = String(len);
      line.style.setProperty("--len", String(len));
      svg.appendChild(line);
      instance.lineElements.push(line);
    }
  }
  instance.spawned++;
  opusProgress.spawnedStars++;
  return true;
}

function fadeOldestOpusConstellation() {
  const oldest = opusProgress.constellationQueue.find((item) => !item.fading);
  if (!oldest) return;
  fadeOpusConstellation(oldest);
}

function fadeExpiredOpusConstellations(now = performance.now()) {
  if (activeOpusConstellationCount() <= OPUS_CONSTELLATION_MIN_VISIBLE) return;
  const expired = opusProgress.constellationQueue.find((item) => (
    item
    && item !== opusProgress.constellationCurrent
    && !item.fading
    && !item.removed
    && now - (item.createdAt || now) > (item.lifeMs || OPUS_CONSTELLATION_LIFE_MAX_MS)
  ));
  if (expired) fadeOpusConstellation(expired);
}

function fadeOpusConstellation(instance) {
  if (!instance || instance.fading || instance.removed) return;
  instance.fading = true;
  const items = [...instance.elements, ...instance.lineElements];
  items.forEach((el, index) => {
    el.style.setProperty("--fade-delay", `${index * OPUS_CONSTELLATION_FADE_STAGGER_MS}ms`);
    el.classList.add("is-fading");
  });
  const removeAfter = Math.max(520, items.length * OPUS_CONSTELLATION_FADE_STAGGER_MS + 420);
  window.setTimeout(() => {
    items.forEach((el) => el.remove());
    instance.removed = true;
    if (opusProgress.constellationCurrent === instance) {
      opusProgress.constellationCurrent = null;
    }
    pruneOpusConstellationQueue();
  }, removeAfter);
}

function pruneOpusConstellationQueue() {
  opusProgress.constellationQueue = opusProgress.constellationQueue.filter((item) => !item.removed);
}

function spawnOpusDetectionDot() {
  const stage = opusProgress.stage || ensureOpusProgressStage();
  const field = opusProgress.nodes?.starField ?? stage?.querySelector(".opus-star-field");
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
  if (isOpusPsdParseActive()) return;
  const stage = opusProgress.stage || ensureOpusProgressStage();
  const field = opusProgress.nodes?.starField ?? stage?.querySelector(".opus-star-field");
  if (!field) return;
  const points = getVisibleOpusConstellationPoints();
  const point = points[Math.floor(Math.random() * points.length)];
  if (!point) return;
  const dot = document.createElement("div");
  dot.className = "opus-detection-dot opus-constellation-pulse";
  dot.style.left = `${Math.max(4, Math.min(96, point[0] * 100 + (Math.random() - 0.5) * 7))}%`;
  dot.style.top = `${Math.max(4, Math.min(96, point[1] * 100 + (Math.random() - 0.5) * 7))}%`;
  field.appendChild(dot);
  setTimeout(() => dot.remove(), 1500);
}

function getVisibleOpusConstellationPoints() {
  const points = [];
  for (const item of opusProgress.constellationQueue) {
    if (item.fading || item.removed) continue;
    points.push(...item.points.slice(0, item.spawned));
  }
  return points;
}

function spawnOpusShootingStar() {
  if (isOpusPsdParseActive()) return;
  const stage = opusProgress.stage || ensureOpusProgressStage();
  if (!stage) return;
  const el = document.createElement("div");
  const inside = Math.random() < 0.32;
  el.className = `opus-shooting-star${inside ? " is-inside" : ""}`;
  let startX;
  let startY;
  let angle;
  let travel;
  if (inside) {
    const pos = randomOpusSkyPosition({ avoidTaskPanel: true });
    startX = Math.max(8, Math.min(88, pos.x));
    startY = Math.max(7, Math.min(72, pos.y));
    angle = Math.random() < 0.5 ? 24 + Math.random() * 22 : 128 + Math.random() * 20;
    travel = 110 + Math.random() * 150;
  } else {
    const fromTop = Math.random() < 0.62;
    startX = fromTop ? -5 + Math.random() * 110 : (Math.random() < 0.5 ? -4 : 104);
    startY = fromTop ? -4 - Math.random() * 6 : Math.random() * 54;
    angle = startX > 100 ? 132 + Math.random() * 20 : 32 + Math.random() * 26;
    travel = 420 + Math.random() * 280;
  }
  el.style.left = `${startX}%`;
  el.style.top = `${startY}%`;
  el.style.setProperty("--angle", `${angle}deg`);
  el.style.setProperty("--travel", `${travel}px`);
  el.style.setProperty("--travel-mid", `${travel * 0.35}px`);
  el.style.setProperty("--travel-late", `${travel * 0.72}px`);
  stage.appendChild(el);
  setTimeout(() => el.remove(), inside ? 1900 : 2800);
}

function completeOpusProgress() {
  if (!opusProgress.active) return;
  opusProgress.indeterminate = false;
  opusProgress.finishing = true;
  opusProgress.phaseEndPct = 100;
  opusProgress.targetPct = 100;
  const stage = opusProgress.stage || ensureOpusProgressStage();
  stage?.classList.remove("is-complete");
  if (opusProgress.flowSnapshot) {
    const flow = {
      ...opusProgress.flowSnapshot,
      completed: true,
      overallPct: 100,
      steps: opusProgress.flowSnapshot.steps.map((step) => ({
        ...step,
        status: "done",
        progress: 100,
      })),
    };
    updateOpusTasks({ detail: "完了", flow, pct: 100 });
    updateOpusCopy({ detail: "完了", flow });
  } else if (opusProgress.variant === "save") {
    stage?.classList.remove("is-saving");
    stage?.classList.add("is-final");
    if (Number.isFinite(opusProgress.lastCountTotal) && opusProgress.lastCountTotal > 0) {
      updateOpusSaveProgress({ current: opusProgress.lastCountTotal, total: opusProgress.lastCountTotal });
    }
    spawnOpusSaveRing(true);
  } else if (opusProgress.variant === "load") {
    const total = Number.isFinite(opusProgress.lastCountTotal) && opusProgress.lastCountTotal > 0
      ? opusProgress.lastCountTotal
      : 1;
    updateOpusTasks({ detail: "完了", current: total, total, pct: 100, taskIndex: opusProgress.taskNames.length - 1, taskProgress: 100 });
  } else {
    // place / scan: タスクパネル（opus-task-total-percent + タスク一覧）も 100% / 全完了へ。
    // これを欠くと "place"（プロジェクト開き / 自動配置）でタスクパネルがフェーズキャップ
    // （例: initialOpusPhaseEnd 72 + advanceOpusProgressPhase 14 = 86）で固まり「86% で完了」
    // になる。finishing ループは updateOpusTasks を呼ばないため、ここで明示的に最終化する。
    const total = Number.isFinite(opusProgress.lastCountTotal) && opusProgress.lastCountTotal > 0
      ? opusProgress.lastCountTotal
      : 1;
    updateOpusTasks({ detail: "完了", current: total, total, pct: 100, taskIndex: opusProgress.taskNames.length - 1, taskProgress: 100 });
  }
  if (!opusProgress.flowSnapshot) updateOpusCopy({ detail: "完了" });
  requestOpusCompleteClass(stage);
}

function requestOpusCompleteClass(stage) {
  if (!stage) return;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (opusProgress.active && opusProgress.finishing) {
        stage.classList.add("is-complete");
        spawnOpusCompletionSparkles();
      }
    });
  });
}

function spawnOpusCompletionSparkles() {
  const percentEl = opusProgress.nodes?.taskTotalPercent
    || opusProgress.stage?.querySelector(".opus-task-total-percent");
  if (!percentEl) return;
  percentEl.querySelectorAll(".opus-complete-sparkle").forEach((el) => el.remove());
  const angles = [-174, -156, -138, -118, -96, -75, -54, -36, -18, 2, 21, 39, 58, 78, 99, 119, 139, 158, 177, 199];
  const frag = document.createDocumentFragment();
  angles.forEach((angle, index) => {
    const el = document.createElement("span");
    el.className = "opus-complete-sparkle";
    const distance = 54 + (index % 5) * 7 + (index % 2) * 4;
    const delay = 24 + Math.floor(index / 2) * 15 + (index % 2) * 7;
    const size = 2.1 + (index % 5) * 0.32;
    const cool = index % 4 === 1;
    el.style.setProperty("--spark-angle", `${angle}deg`);
    el.style.setProperty("--spark-distance", `${distance}px`);
    el.style.setProperty("--spark-delay", `${delay}ms`);
    el.style.setProperty("--spark-size", `${size}px`);
    el.style.setProperty("--spark-peak", `${cool ? 0.88 : 1}`);
    if (cool) {
      el.style.setProperty("--spark-core", "#f4f8ff");
      el.style.setProperty("--spark-edge", "#bcd2ff");
      el.style.setProperty("--spark-glow", "rgba(174, 202, 255, 0.38)");
    }
    frag.appendChild(el);
    window.setTimeout(() => el.remove(), 1160 + delay);
  });
  percentEl.appendChild(frag);
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
const PROGRESS_CLOSE_ANIM_MS = 500;
const OPUS_CLOSE_ANIM_MS = 620;
const OPUS_SUCCESS_HOLD_MS = 1500;
const OPUS_EXIT_FADE_MS = 240;

// v2.2.x: 進捗 100% 完了の OPUS 成功アニメ (sparkle 含む + 「完了」テキスト) だけを発火し、
// modal は閉じない。外部から「100% 完了 → 別の演出 (星空ディゾルブ等) → close」と
// シーケンスを組みたい時に使う。OPUS モード以外の進捗 modal では何もしない (= false 返却)。
export function showOpusProgressComplete() {
  const modal = $("progress-modal");
  if (!modal || modal.hidden) return false;
  if (!isOpusProgressActive(modal)) return false;
  try {
    completeOpusProgress();
  } catch (e) {
    console.error("showOpusProgressComplete: completeOpusProgress failed", e);
    return false;
  }
  const loadingText = $("progress-loading-text");
  if (loadingText) loadingText.textContent = "完了";
  return true;
}

// 完了演出の hold 時間 (sparkle が消えるまでの余韻含む)。
// 呼び出し側 (transitionToWorkspaceWithStars 等) が `await new Promise(r => setTimeout(r, OPUS_SUCCESS_HOLD_DURATION))`
// で同じ間を取れるよう export。
export const OPUS_SUCCESS_HOLD_DURATION = OPUS_SUCCESS_HOLD_MS;
export function hideProgress({ success = false, variant = null } = {}) {
  return new Promise((resolve) => {
    const modal = $("progress-modal");
    if (!modal) { resolve(); return; }
    // 既に hidden で closing でもなければ、何も走らせず即解決。
    // （未表示状態で呼ばれた場合に 500ms 待つのは無駄）
    if (modal.hidden && !modal.classList.contains("closing")) {
      resolve();
      return;
    }
    const forcedVariant = success ? normalizeOpusProgressVariant(variant) : null;
    if (forcedVariant && (!isOpusProgressActive(modal) || normalizeOpusProgressVariant(modal.dataset.progressVariant) !== forcedVariant)) {
      setOpusProgressMode(forcedVariant, {
        phaseKey: makeOpusProgressPhaseKey({ title: $("progress-title")?.textContent, detail: "complete", variant: forcedVariant }),
      });
      updateProgress({ detail: "complete", current: 1, total: 1 });
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
      if (pendingOpusExitTimer != null) {
        clearTimeout(pendingOpusExitTimer);
        pendingOpusExitTimer = null;
      }
      // .visible は外さず .closing を付ける（opacity 1 維持 + bg 帯のスライドアウト）。
      const opusClosing = isOpusProgressActive(modal);
      modal.classList.add("closing");
      const closeMs = opusClosing ? OPUS_CLOSE_ANIM_MS : PROGRESS_CLOSE_ANIM_MS;
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
      }, closeMs);
    };

    if (success && isOpusProgressActive(modal)) {
      completeOpusProgress();
      const loadingText = $("progress-loading-text");
      if (loadingText) loadingText.textContent = "完了";
      pendingOpusExitTimer = setTimeout(() => {
        pendingOpusExitTimer = null;
        const stage = opusProgress.stage || ensureOpusProgressStage();
        stage?.classList.add("is-exiting");
      }, Math.max(0, OPUS_SUCCESS_HOLD_MS - OPUS_EXIT_FADE_MS));
      setTimeout(startCloseAnim, OPUS_SUCCESS_HOLD_MS);
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
// secondaryAction も同形で渡せる。primaryAction と併用時は「secondary / primary / OK」の順に並ぶ。
//
// 戻り値は Promise<void>。
export function notifyDialog({
  title = "通知",
  message = "",
  okLabel = "OK",
  kind = "info",
  primaryAction = null,
  secondaryAction = null,
  actions = null,
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
    // Cancel ボタンは notify (action 無し) では非表示。action 有りなら
    // 「OK + アクションボタン」の構造で表示し、1 つ目は cancelBtn を再利用する。
    const prevCancelHidden = cancelBtn ? cancelBtn.hidden : false;
    const prevCancelText = cancelBtn ? cancelBtn.textContent : "";
    const prevCancelClass = cancelBtn ? cancelBtn.className : "";
    const actionSource = (Array.isArray(actions) ? actions : [secondaryAction, primaryAction])
      .filter((action) => action && typeof action === "object");
    const actionButtons = [];
    let actionPending = false;
    if (cancelBtn) {
      const firstAction = actionSource[0];
      if (firstAction) {
        cancelBtn.hidden = false;
        cancelBtn.textContent = firstAction.label || "実行";
        // page-jump-btn-* バリアント (place / primary / danger 等) を kind から組み立て
        const variantKind = (firstAction.kind || "primary");
        cancelBtn.className = `page-jump-btn page-jump-btn-${variantKind}`;
        actionButtons.push({ button: cancelBtn, action: firstAction, restore: true });
      } else {
        cancelBtn.hidden = true;
      }
    }
    const actionsContainer = okBtn.parentNode;
    const extraActionButtons = [];
    if (actionsContainer) {
      for (const action of actionSource.slice(cancelBtn ? 1 : 0)) {
        const actionBtn = document.createElement("button");
        const variantKind = action.kind || "primary";
        actionBtn.type = "button";
        actionBtn.className = `page-jump-btn page-jump-btn-${variantKind}`;
        actionBtn.textContent = action.label || "実行";
        actionsContainer.insertBefore(actionBtn, okBtn);
        extraActionButtons.push(actionBtn);
        actionButtons.push({ button: actionBtn, action, restore: false });
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
        extraActionButtons.forEach((button) => button.remove());
        if (titleEl) {
          titleEl.classList.remove("notify-title-success", "notify-title-warning", "notify-title-danger");
          titleEl.textContent = title;
        }
      }, MODAL_ANIM_MS);
      okBtn.removeEventListener("click", onOk);
      actionButtons.forEach(({ button, handler }) => button.removeEventListener("click", handler));
      modal.removeEventListener("mousedown", onOverlay);
      document.removeEventListener("keydown", onKey);
      resolve();
    };
    const onOk = () => cleanup();
    const runAction = async (action) => {
      if (actionPending) return;
      if (!action || typeof action.onClick !== "function") {
        cleanup();
        return;
      }
      actionPending = true;
      try { await action.onClick(); } catch (err) { console.error("notifyDialog action error", err); }
      actionPending = false;
      // 【v2.x】action.keepOpen が true ならダイアログを閉じずに残す。
      // 「PSD 保存後に PDF 化・ProGen 起動など複数アクションを連続実行したい」
      // ケース向け。OK ボタンや Esc / 背景クリックで通常通り閉じる。
      if (!action.keepOpen) cleanup();
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
    actionButtons.forEach((item) => {
      item.handler = () => runAction(item.action);
      item.button.addEventListener("click", item.handler);
    });
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

// 【写植再利用】「既定で統一」用：フォント種類とサイズを選ぶダイアログ。
// confirm-modal を流用し、メッセージ直下に検索可能なフォント入力とサイズ <input number> を挿入する。
// fonts: [{ postScriptName, label }]。OK で { fontPostScriptName, sizePt } を resolve、
// キャンセル / Esc / 背景クリックで null を resolve。
export function chooseReuseFontSizeMode() {
  return new Promise((resolve) => {
    let settled = false;
    const modal = document.createElement("div");
    modal.className = "home-typeset-modal reuse-fontsize-mode-modal";
    modal.hidden = true;
    modal.innerHTML = `
      <div class="home-typeset-card reuse-fontsize-mode-card" role="dialog" aria-modal="true" aria-labelledby="reuse-fontsize-mode-title">
        <div class="home-typeset-header">
          <span class="home-typeset-title" id="reuse-fontsize-mode-title">フォント・サイズの扱い</span>
          <span class="home-typeset-subtitle">再生成するテキストのフォントとサイズを選択</span>
        </div>
        <div class="home-typeset-list reuse-fontsize-mode-list">
          <button class="home-typeset-row reuse-fontsize-mode-row" type="button" data-mode="reproduce">
            <span class="home-typeset-row-icon" aria-hidden="true">
              <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M28 8h20l10 10v27"/>
                <path d="M48 8v10h10"/>
                <path d="M11 22a4 4 0 0 1 4-4h24l11 11v27a4 4 0 0 1-4 4H15a4 4 0 0 1-4-4Z"/>
                <path d="M39 18v11h11"/>
              </svg>
            </span>
            <div class="home-typeset-row-main">
              <span class="home-typeset-row-title">写植見本を再現</span>
              <span class="home-typeset-row-desc">写植見本のフォント・サイズを再現します。</span>
            </div>
          </button>
          <button class="home-typeset-row reuse-fontsize-mode-row" type="button" data-mode="select">
            <span class="home-typeset-row-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 7h16M4 12h16M4 17h10"/>
                <path d="M8 5v14M16 5v9"/>
                <path d="m17 18 2 2 3-4"/>
              </svg>
            </span>
            <div class="home-typeset-row-main">
              <span class="home-typeset-row-title">フォント・サイズを指定</span>
              <span class="home-typeset-row-desc">指定したフォント・サイズを基本に、OCR/背景判定の中丸・白フチ・サイズ感は反映します。</span>
            </div>
          </button>
        </div>
        <div class="home-typeset-actions">
          <button class="page-jump-btn reuse-fontsize-mode-cancel" type="button">キャンセル</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const cleanup = (result) => {
      if (settled) return;
      settled = true;
      hideModalAnimated(modal);
      document.removeEventListener("keydown", onKey);
      for (const btn of modal.querySelectorAll("[data-mode]")) {
        btn.removeEventListener("click", onModeClick);
      }
      modal.querySelector(".reuse-fontsize-mode-cancel")?.removeEventListener("click", onCancel);
      setTimeout(() => modal.remove(), MODAL_ANIM_MS);
      resolve(result);
    };
    const onModeClick = (e) => cleanup(e.currentTarget?.dataset?.mode || null);
    const onCancel = () => cleanup(null);
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cleanup(null);
      }
    };

    for (const btn of modal.querySelectorAll("[data-mode]")) {
      btn.addEventListener("click", onModeClick);
    }
    modal.querySelector(".reuse-fontsize-mode-cancel")?.addEventListener("click", onCancel);
    document.addEventListener("keydown", onKey);
    showModalAnimated(modal);
    requestAnimationFrame(() => modal.querySelector('[data-mode="reproduce"]')?.focus());
  });
}

export function pickReuseFontSize({
  fonts = [],
  defaultFontPs = "",
  defaultSizePt = 12,
  defaultPunctuationSpaceReplacementEnabled = true,
} = {}) {
  return new Promise((resolve) => {
    const modal = $("confirm-modal");
    const titleEl = $("confirm-modal-title");
    const msgEl = $("confirm-modal-message");
    const okBtn = $("confirm-modal-ok");
    const cancelBtn = $("confirm-modal-cancel");
    if (!modal || !okBtn || !cancelBtn || !msgEl) { resolve(null); return; }
    if (titleEl) {
      titleEl.classList.remove("notify-title-success", "notify-title-warning", "notify-title-danger");
      titleEl.textContent = "統一するフォントとサイズ";
    }
    msgEl.textContent = "再生成するテキストの基本フォントと基本サイズを選んでください。中丸・白フチ・検出サイズは自動で反映されます。";
    okBtn.textContent = "この設定で開始";
    cancelBtn.textContent = "キャンセル";

    const wrap = document.createElement("div");
    wrap.className = "reuse-fontsize-fields";

    const fontLabel = document.createElement("label");
    fontLabel.className = "reuse-fontsize-label";
    fontLabel.textContent = "フォント";
    const fontCombo = document.createElement("div");
    fontCombo.className = "font-combobox reuse-fontsize-combo";
    const fontInput = document.createElement("input");
    fontInput.type = "text";
    fontInput.autocomplete = "off";
    fontInput.spellcheck = false;
    fontInput.placeholder = "フォント名で検索...";
    fontInput.className = "font-input prompt-modal-input reuse-fontsize-font-input";
    fontInput.setAttribute("aria-label", "フォントを検索");
    const fontToggle = document.createElement("button");
    fontToggle.type = "button";
    fontToggle.className = "font-combobox-toggle reuse-fontsize-font-toggle";
    fontToggle.setAttribute("aria-label", "フォント一覧を開く");
    fontToggle.tabIndex = -1;
    fontToggle.textContent = "▾";
    const fontList = document.createElement("ul");
    fontList.className = "font-combobox-list reuse-fontsize-font-list";
    fontList.hidden = true;
    fontList.setAttribute("role", "listbox");
    fontCombo.appendChild(fontInput);
    fontCombo.appendChild(fontToggle);
    fontCombo.appendChild(fontList);

    const fontChoices = fonts
      .filter((f) => f && f.postScriptName)
      .map((f) => ({
        postScriptName: String(f.postScriptName),
        label: String(f.label || f.postScriptName),
      }));
    if (defaultFontPs && !fontChoices.some((f) => f.postScriptName === defaultFontPs)) {
      fontChoices.unshift({ postScriptName: String(defaultFontPs), label: String(defaultFontPs) });
    }
    let selectedFontPs = defaultFontPs || fontChoices[0]?.postScriptName || "";
    let fontSearchCleared = false;
    let fontSearchDirty = false;
    let fontSearchRestoreValue = "";
    const displayFontName = (ps) => {
      const found = fontChoices.find((f) => f.postScriptName === ps);
      return found?.label || ps || "";
    };
    const normalizeFontQuery = (value) => String(value ?? "").normalize("NFKC").toLocaleLowerCase("ja");
    const syncFontInput = () => {
      fontInput.dataset.ps = selectedFontPs;
      fontInput.value = displayFontName(selectedFontPs);
    };
    const reuseFontCombo = createFontCombobox({
      input: fontInput,
      list: fontList,
      combo: fontCombo,
      getFonts: () => fontChoices,
      getCurrentPostScriptName: () => selectedFontPs,
      onCommit: (font) => {
        selectedFontPs = font.postScriptName;
        syncFontInput();
      },
      itemClassName: "reuse-fontsize-font-item",
      emptyClassName: "reuse-fontsize-font-empty",
      emptyText: fontChoices.length ? "該当するフォントがありません" : "フォント一覧を読み込み中です",
    });
    reuseFontCombo.rebuild();
    const openFontCombo = (query = fontInput.value) => {
      reuseFontCombo.open({ query, rebuild: false });
    };
    const closeFontCombo = () => {
      reuseFontCombo.close();
    };
    const resetFontSearchForTyping = () => {
      if (fontSearchCleared) return;
      fontSearchRestoreValue = fontInput.value || "";
      fontSearchCleared = true;
      fontSearchDirty = false;
      fontInput.value = "";
      if (reuseFontCombo.isOpen()) reuseFontCombo.filter("");
    };
    const putCaretInFontInput = () => {
      requestAnimationFrame(() => {
        fontInput.focus({ preventScroll: true });
        const len = fontInput.value.length;
        try { fontInput.setSelectionRange(len, len); } catch (_) { /* noop */ }
      });
    };
    const enterFontSearchMode = () => {
      resetFontSearchForTyping();
      openFontCombo("");
      putCaretInFontInput();
    };
    const resolveFontInput = () => {
      const raw = String(fontInput.value ?? "").trim();
      if (!raw) return selectedFontPs;
      const exact = resolveComboboxFontFromInput(fontChoices, raw);
      if (exact) return exact.postScriptName;
      const lower = normalizeFontQuery(raw);
      const partial = fontChoices.find((font) => fontSearchHaystack(font).includes(lower));
      return partial?.postScriptName || selectedFontPs;
    };
    const commitFontInput = () => {
      const committed = reuseFontCombo.commit({ fallbackValue: fontInput.value, blur: false });
      if (!committed) {
        selectedFontPs = resolveFontInput();
        syncFontInput();
        closeFontCombo();
      }
    };
    syncFontInput();

    const sizeLabel = document.createElement("label");
    sizeLabel.className = "reuse-fontsize-label";
    sizeLabel.textContent = "サイズ (pt)";
    const sizeInput = document.createElement("input");
    sizeInput.type = "number";
    sizeInput.className = "prompt-modal-input reuse-fontsize-size";
    sizeInput.min = "6";
    sizeInput.max = "999";
    sizeInput.step = "0.1";
    sizeInput.value = String(Number.isFinite(defaultSizePt) && defaultSizePt > 0 ? defaultSizePt : 12);

    const punctLabel = document.createElement("label");
    punctLabel.className = "reuse-fontsize-label";
    punctLabel.textContent = "句読点置換";
    const punctSelect = document.createElement("select");
    punctSelect.className = "prompt-modal-input reuse-fontsize-punct-select";
    punctSelect.setAttribute("aria-label", "句読点「、」の半角スペース置換");
    punctSelect.innerHTML = '<option value="on">句読点あり</option><option value="off">句読点なし</option>';
    punctSelect.value = defaultPunctuationSpaceReplacementEnabled === false ? "off" : "on";

    wrap.appendChild(fontLabel);
    wrap.appendChild(fontCombo);
    wrap.appendChild(sizeLabel);
    wrap.appendChild(sizeInput);
    wrap.appendChild(punctLabel);
    wrap.appendChild(punctSelect);
    msgEl.parentNode.insertBefore(wrap, msgEl.nextSibling);

    okBtn.classList.remove("page-jump-btn-place");
    if (!okBtn.classList.contains("page-jump-btn-primary")) okBtn.classList.add("page-jump-btn-primary");
    showModalAnimated(modal);

    const cleanup = (result) => {
      hideModalAnimated(modal);
      setTimeout(() => { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }, MODAL_ANIM_MS);
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      modal.removeEventListener("mousedown", onModalMouseDown);
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onOk = () => {
      selectedFontPs = resolveFontInput();
      syncFontInput();
      const ps = selectedFontPs || null;
      const sz = parseFloat(sizeInput.value);
      cleanup({
        fontPostScriptName: ps,
        sizePt: Number.isFinite(sz) && sz > 0 ? Math.min(999, Math.max(6, sz)) : null,
        punctuationSpaceReplacementEnabled: punctSelect.value !== "off",
      });
    };
    const onCancel = () => cleanup(null);
    const onOverlay = (e) => { if (e.target === modal) cleanup(null); };
    const onModalMouseDown = (e) => {
      if (!fontCombo.contains(e.target)) closeFontCombo();
      onOverlay(e);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); cleanup(null); }
      else if (e.key === "Enter") { e.preventDefault(); onOk(); }
    };
    fontInput.addEventListener("focus", () => {
      enterFontSearchMode();
    });
    fontInput.addEventListener("mousedown", () => {
      if (document.activeElement === fontInput) resetFontSearchForTyping();
    });
    fontInput.addEventListener("click", () => {
      if (!fontSearchDirty) enterFontSearchMode();
    });
    fontInput.addEventListener("input", () => {
      fontSearchDirty = true;
      openFontCombo(fontInput.value);
    });
    fontInput.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        if (!reuseFontCombo.isOpen()) openFontCombo(fontInput.value);
        else reuseFontCombo.moveHighlight(+1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        if (!reuseFontCombo.isOpen()) openFontCombo(fontInput.value);
        else reuseFontCombo.moveHighlight(-1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        commitFontInput();
      } else if (e.key === "Escape") {
        if (reuseFontCombo.isOpen()) {
          e.preventDefault();
          e.stopPropagation();
          syncFontInput();
          closeFontCombo();
        }
      }
    });
    fontInput.addEventListener("blur", () => {
      window.setTimeout(() => {
        if (!fontCombo.contains(document.activeElement)) closeFontCombo();
        if (
          document.activeElement !== fontInput
          && fontSearchCleared
          && !fontSearchDirty
          && fontInput.value === ""
        ) {
          fontInput.value = fontSearchRestoreValue || "";
        }
        fontSearchCleared = false;
        fontSearchDirty = false;
      }, 120);
    });
    fontToggle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      if (reuseFontCombo.isOpen()) closeFontCombo();
      else {
        fontInput.focus({ preventScroll: true });
        openFontCombo("");
      }
    });
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    modal.addEventListener("mousedown", onModalMouseDown);
    document.addEventListener("keydown", onKey);
  });
}

export function toast(_message, _opts = {}) {
  // Right-top toast notifications are intentionally disabled app-wide.
}
