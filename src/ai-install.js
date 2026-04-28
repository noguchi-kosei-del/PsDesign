// AIインストール (manga-ocr / comic-text-detector / mokuro)
//
// PowerShell スクリプト install-ai-models.ps1 を起動し、
// ai_install:log / ai_install:done イベントを購読して進捗 UI を駆動する。
//
// 依存: @tauri-apps/api/core (invoke), @tauri-apps/api/event (listen)
// イベント仕様 (Rust 側 ocr.rs):
//   - ai_install:start (payload: target dir 文字列)
//   - ai_install:log   (payload: { line, stream: "stdout" | "stderr" })
//   - ai_install:done  (payload: なし)
//
// 元参照: serifu-memo/src/SetupWizard.tsx (Phase 検出 / pip 進捗パース / ETA)

import { toast, notifyDialog } from "./ui-feedback.js";

const $ = (id) => document.getElementById(id);

const PHASE_GROUPS = ["base", "ctd", "mocr", "torch"];
const PHASE_LABEL_BY_GROUP = {
  base: "共通基盤",
  ctd: "comic-text-detector",
  mocr: "manga-ocr",
  torch: "PyTorch (CUDA) + 検証",
};

// PowerShell スクリプトのログ行 → グループキー
function detectPhaseGroup(line) {
  if (/Phase 1\./.test(line)) return "base";
  if (/Phase 2\./.test(line)) return "base";
  if (/Phase 3\./.test(line)) return "base";
  if (/Phase 4a\./.test(line)) return "ctd";
  if (/Installing comic-text-detector/.test(line)) return "ctd";
  if (/Phase 4b\./.test(line)) return "mocr";
  if (/Installing manga-ocr/.test(line)) return "mocr";
  if (/Phase 4c\./.test(line)) return "mocr"; // mokuro まとめは manga-ocr に隣接させる
  if (/Installing mokuro/.test(line)) return "mocr";
  if (/Phase 5\./.test(line)) return "torch";
  if (/Switching torch/.test(line)) return "torch";
  if (/Phase 6\./.test(line)) return "torch";
  if (/Verifying runtime/.test(line)) return "torch";
  return null;
}

const UNITS = { kB: 1024, MB: 1024 * 1024, GB: 1024 * 1024 * 1024 };
const PIP_PROGRESS_RE = /(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*(GB|MB|kB)\s+(\d+(?:\.\d+)?)\s*(GB|MB|kB)\/s/g;

function parseDownload(line) {
  // pip の進捗は \r で同一行上書き → 最後の一致を採用
  const matches = [...line.matchAll(PIP_PROGRESS_RE)];
  if (matches.length === 0) return null;
  const m = matches[matches.length - 1];
  const current = parseFloat(m[1]) * UNITS[m[3]];
  const total = parseFloat(m[2]) * UNITS[m[3]];
  const speedBps = parseFloat(m[4]) * UNITS[m[5]];
  if (!isFinite(current) || !isFinite(total) || total <= 0) return null;
  return { current, total, speedBps };
}

function formatBytes(b) {
  if (b >= UNITS.GB) return (b / UNITS.GB).toFixed(2) + " GB";
  if (b >= UNITS.MB) return (b / UNITS.MB).toFixed(0) + " MB";
  return (b / UNITS.kB).toFixed(0) + " kB";
}

function formatSpeed(bps) {
  if (bps >= UNITS.MB) return (bps / UNITS.MB).toFixed(1) + " MB/s";
  return (bps / UNITS.kB).toFixed(0) + " kB/s";
}

function formatDuration(seconds) {
  if (!isFinite(seconds) || seconds < 0) return "—";
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s}秒`;
  return `${m}分${s.toString().padStart(2, "0")}秒`;
}

// ===== モーダル状態 =====
let activeGroup = null;
let groupState = {}; // { base: "pending"|"active"|"done", ... }
let listeners = []; // 解除関数の配列
let runningInstall = false;
let userCancelled = false; // ユーザーがインストール中に「中止」ボタンを押した
let lastDownload = null; // { current, total, speedBps, ts }

// ヘッダー右上のボタン (#ai-install-close-btn) を「完了」⇔「中止」で切替。
// インストール中のみ赤い中止ボタンに変身させる。
function setHeaderButtonMode(mode /* "close" | "cancel" */) {
  const btn = $("ai-install-close-btn");
  if (!btn) return;
  if (mode === "cancel") {
    btn.textContent = "中止";
    btn.title = "インストールを中止";
    btn.setAttribute("aria-label", "インストールを中止");
    btn.classList.add("ai-install-cancel-btn");
  } else {
    btn.textContent = "完了";
    btn.title = "閉じる";
    btn.setAttribute("aria-label", "閉じる");
    btn.classList.remove("ai-install-cancel-btn");
  }
}

function resetGroupState() {
  activeGroup = null;
  groupState = {};
  for (const g of PHASE_GROUPS) groupState[g] = "pending";
  renderPhaseUI();
}

function setGroupState(group, state) {
  // pending < active < done への単調進行のみ許容
  const order = { pending: 0, active: 1, done: 2 };
  if ((order[state] ?? 0) <= (order[groupState[group]] ?? 0)) return;
  groupState[group] = state;
  if (state === "active") {
    activeGroup = group;
    // それ以前のグループは done として確定 (ログから抜けている場合の補完)
    let seenSelf = false;
    for (const g of PHASE_GROUPS) {
      if (g === group) { seenSelf = true; continue; }
      if (!seenSelf && groupState[g] === "pending") groupState[g] = "done";
    }
  }
  renderPhaseUI();
}

function renderPhaseUI() {
  for (const g of PHASE_GROUPS) {
    const li = document.querySelector(`#ai-phase-list .ai-phase-item[data-phase="${g}"]`);
    if (!li) continue;
    li.classList.remove("active", "done");
    const state = groupState[g] ?? "pending";
    if (state === "active") li.classList.add("active");
    else if (state === "done") li.classList.add("done");
    const stateEl = $(`ai-phase-${g}-state`);
    if (stateEl) {
      stateEl.textContent =
        state === "done" ? "完了" :
        state === "active" ? "進行中…" :
        "未開始";
    }
  }
  const activeLabel = $("ai-install-active-label");
  if (activeLabel) {
    activeLabel.textContent = activeGroup
      ? PHASE_LABEL_BY_GROUP[activeGroup]
      : (runningInstall ? "準備中" : "待機中");
  }
}

function renderDownloadUI() {
  const progressBox = $("ai-install-progress");
  if (!progressBox) return;
  if (!lastDownload) {
    progressBox.hidden = true;
    return;
  }
  progressBox.hidden = false;
  const { current, total, speedBps } = lastDownload;
  const pct = total > 0 ? Math.max(0, Math.min(100, (current / total) * 100)) : 0;
  $("ai-install-progress-fill").style.width = pct.toFixed(1) + "%";
  $("ai-install-progress-count").textContent =
    `${formatBytes(current)} / ${formatBytes(total)}`;
  const speedEl = $("ai-install-speed");
  const etaEl = $("ai-install-eta");
  if (speedEl) speedEl.textContent = speedBps > 0 ? formatSpeed(speedBps) : "";
  if (etaEl) {
    const remain = total - current;
    const eta = (speedBps > 0 && remain > 0) ? remain / speedBps : NaN;
    etaEl.textContent = isFinite(eta) ? `残り ${formatDuration(eta)}` : "";
  }
}

function appendLogLine(line, stream) {
  const viewer = $("ai-log-viewer");
  if (!viewer) return;
  const div = document.createElement("div");
  div.className = "ai-log-line" + (stream === "stderr" ? " stderr" : "");
  div.textContent = line;
  viewer.appendChild(div);
  // 行数制限 (古い行を間引く)
  while (viewer.childElementCount > 1500) {
    viewer.removeChild(viewer.firstChild);
  }
  // 自動スクロール
  viewer.scrollTop = viewer.scrollHeight;
}

function clearLog() {
  const viewer = $("ai-log-viewer");
  if (viewer) viewer.innerHTML = "";
}

async function refreshStatusBadge() {
  try {
    const status = await checkAiModelsStatus();
    const row = $("ai-status-runtime");
    const value = $("ai-status-runtime-value");
    const badge = $("ai-install-menu-badge");
    if (!row || !value) return status;
    row.classList.remove("installed", "missing");
    if (status?.available) {
      row.classList.add("installed");
      value.textContent = `インストール済み (${status.path ?? "—"})`;
      if (badge) badge.hidden = true;
    } else {
      row.classList.add("missing");
      value.textContent = "未インストール";
      if (badge) badge.hidden = false;
    }
    const startBtn = $("ai-install-start-btn");
    if (startBtn) {
      startBtn.disabled = !!runningInstall;
      startBtn.textContent = status?.available ? "再インストール" : "インストール開始";
    }
    return status;
  } catch (e) {
    console.error(e);
    return null;
  }
}

// 公開: 現在のランタイム状態を取得
export async function checkAiModelsStatus() {
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke("check_ai_models");
}

async function runInstall() {
  if (runningInstall) return;
  runningInstall = true;
  userCancelled = false;
  resetGroupState();
  lastDownload = null;
  clearLog();
  renderDownloadUI();
  setHeaderButtonMode("cancel");
  const startBtn = $("ai-install-start-btn");
  if (startBtn) startBtn.disabled = true;

  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");

  // イベント購読
  const unsubLog = await listen("ai_install:log", (e) => {
    const { line, stream } = e.payload || {};
    if (typeof line === "string") {
      appendLogLine(line, stream);
      const grp = detectPhaseGroup(line);
      if (grp) setGroupState(grp, "active");
      const dl = parseDownload(line);
      if (dl) {
        lastDownload = { ...dl, ts: Date.now() };
        renderDownloadUI();
      }
    }
  });
  const unsubDone = await listen("ai_install:done", () => {
    for (const g of PHASE_GROUPS) {
      if (groupState[g] !== "done") groupState[g] = "done";
    }
    activeGroup = null;
    renderPhaseUI();
  });
  listeners = [unsubLog, unsubDone];

  // ETA を 250ms ごとに更新するタイマー (新しいログが来ない間も残り時間を進める)
  const tick = setInterval(() => {
    if (lastDownload) renderDownloadUI();
  }, 250);

  try {
    await invoke("install_ai_models");
    toast("AIインストール完了", { kind: "info", duration: 2400 });
    await refreshStatusBadge();
  } catch (e) {
    console.error(e);
    if (!userCancelled) {
      toast(`AIインストール失敗: ${e?.message ?? e}`, { kind: "error", duration: 6000 });
      await notifyDialog({
        title: "AIインストール失敗",
        message: String(e?.message ?? e ?? "不明なエラー"),
      });
    }
    // userCancelled === true: ポップアップ・トーストとも出さず静かに戻る
  } finally {
    clearInterval(tick);
    for (const u of listeners) try { u(); } catch (_) {}
    listeners = [];
    runningInstall = false;
    setHeaderButtonMode("close");
    const sb = $("ai-install-start-btn");
    if (sb) sb.disabled = false;
    await refreshStatusBadge();
  }
}

/// 進行中のインストールを中止 (Rust 側 cancel_ai_install を呼び taskkill)。
async function cancelInstall() {
  if (!runningInstall) return;
  userCancelled = true;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("cancel_ai_install");
  } catch (e) {
    console.error(e);
    toast(`中止に失敗: ${e?.message ?? e}`, { kind: "error", duration: 4000 });
    userCancelled = false; // 失敗時はフラグ戻す
  }
  // この後、install_ai_models 側の wait() が止まり runInstall の catch に入る
}

// ===== モーダル開閉 =====
async function openAiInstallModal() {
  const modal = $("ai-install-modal");
  if (!modal) return;
  modal.hidden = false;
  resetGroupState();
  lastDownload = null;
  renderDownloadUI();
  await refreshStatusBadge();
}

function closeAiInstallModal() {
  if (runningInstall) return; // 実行中はクローズしない (中止は cancelInstall で別経路)
  const modal = $("ai-install-modal");
  if (modal) modal.hidden = true;
}

// ヘッダー右上ボタン (#ai-install-close-btn) と Esc キーから呼ばれる。
// 実行中なら中止、停止中なら閉じるに分岐。
function handleHeaderButton() {
  if (runningInstall) cancelInstall();
  else closeAiInstallModal();
}

// ===== 公開 API =====
export function bindAiInstallMenu() {
  const btn = $("ai-install-btn");
  const modal = $("ai-install-modal");
  if (!btn || !modal) return;

  btn.addEventListener("click", () => {
    openAiInstallModal();
  });

  const closeBtn = $("ai-install-close-btn");
  if (closeBtn) closeBtn.addEventListener("click", handleHeaderButton);

  // 背景クリック→閉じる は廃止 (背景は data-tauri-drag-region でウィンドウ移動に使用)。
  // 閉じる手段はヘッダー右上のボタン or Esc キー。

  document.addEventListener("keydown", (e) => {
    if (modal.hidden) return;
    if (e.key === "Escape") {
      e.preventDefault();
      handleHeaderButton();
    }
  });

  const startBtn = $("ai-install-start-btn");
  if (startBtn) {
    startBtn.addEventListener("click", () => {
      runInstall();
    });
  }

  // 起動時に1回ステータスチェック → バッジ点灯
  refreshStatusBadge();
}
