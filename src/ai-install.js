// AIインストール (画像スキャンエンジン)
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

import {
  toast,
  notifyDialog,
  confirmDialog,
  showProgress,
  hideProgress,
} from "./ui-feedback.js";

const $ = (id) => document.getElementById(id);

const PHASE_GROUPS = ["base", "ctd", "mocr", "torch"];
const PHASE_LABEL_BY_GROUP = {
  base: "共通基盤",
  ctd: "画像スキャンエンジン (吹き出し検出)",
  mocr: "画像スキャンエンジン (テキスト抽出)",
  torch: "PyTorch (CUDA) + 検証",
};

// PowerShell スクリプトのログ行 → グループキー
function detectPhaseGroup(line) {
  if (/Phase 1\./.test(line)) return "base";
  if (/Phase 2\./.test(line)) return "base";
  if (/Phase 3\./.test(line)) return "base";
  if (/Phase 4a\./.test(line)) return "ctd";
  if (/Phase 4b\./.test(line)) return "mocr";
  if (/Phase 4c\./.test(line)) return "mocr"; // オーケストレータ部分はテキスト抽出に隣接させる
  if (/Phase 5\./.test(line)) return "torch";
  if (/Phase 6\./.test(line)) return "torch";
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
let runningUninstall = false;
let userCancelled = false; // ユーザーがインストール中に「中止」ボタンを押した
let lastDownload = null; // { current, total, speedBps, ts }
let uninstallProgressTimer = null;

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
  updateLogProgressForPhase();
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
  updateLogProgressForPhase();
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

function renderDownloadUILegacy() {
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

function appendLogLineLegacy(line, stream) {
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

function clearLogLegacy() {
  const viewer = $("ai-log-viewer");
  if (viewer) viewer.innerHTML = "";
}

// ai-log-viewer 内にもインストール状況の進捗バーを表示する。
// 既存の上部プログレスはダウンロード行が来た時だけ使い、ログ内はフェーズ進行中も表示する。
function setProgressElements(prefix, { pct, label, count, speed, eta }) {
  const isMain = prefix === "ai-install";
  const fill = $(isMain ? "ai-install-progress-fill" : `${prefix}-fill`);
  const countEl = $(isMain ? "ai-install-progress-count" : `${prefix}-count`);
  const labelEl = $(isMain ? "ai-install-active-label" : `${prefix}-label`);
  const speedEl = $(isMain ? "ai-install-speed" : `${prefix}-speed`);
  const etaEl = $(isMain ? "ai-install-eta" : `${prefix}-eta`);
  if (fill) fill.style.width = `${Math.max(0, Math.min(100, pct || 0)).toFixed(1)}%`;
  if (countEl) countEl.textContent = count || "";
  if (labelEl) labelEl.textContent = label || "";
  if (speedEl) speedEl.textContent = speed || "";
  if (etaEl) etaEl.textContent = eta || "";
}

function renderLogProgressFallback() {
  const box = $("ai-log-progress");
  if (!box) return;
  if (!runningInstall && !runningUninstall) {
    box.hidden = true;
    setProgressElements("ai-log-progress", { pct: 0, label: "", count: "", speed: "", eta: "" });
    return;
  }
  if (runningUninstall) {
    box.hidden = false;
    return;
  }
  box.hidden = false;
  let done = 0;
  let activeBonus = 0;
  for (const group of PHASE_GROUPS) {
    if (groupState[group] === "done") done += 1;
    else if (groupState[group] === "active") activeBonus = 0.5;
  }
  const pct = ((done + activeBonus) / PHASE_GROUPS.length) * 100;
  const label = activeGroup ? PHASE_LABEL_BY_GROUP[activeGroup] : "インストール準備中";
  const current = Math.min(PHASE_GROUPS.length, Math.max(0, Math.floor(done + activeBonus)));
  setProgressElements("ai-log-progress", {
    pct,
    label,
    count: `${current} / ${PHASE_GROUPS.length} フェーズ`,
    speed: "",
    eta: "",
  });
}

function updateLogProgressForPhase() {
  if (!lastDownload) renderLogProgressFallback();
}

function renderDownloadUI() {
  const progressBox = $("ai-install-progress");
  const logProgressBox = $("ai-log-progress");
  if (!lastDownload) {
    if (progressBox) progressBox.hidden = true;
    renderLogProgressFallback();
    return;
  }
  if (progressBox) progressBox.hidden = false;
  if (logProgressBox) logProgressBox.hidden = false;
  const { current, total, speedBps } = lastDownload;
  const pct = total > 0 ? Math.max(0, Math.min(100, (current / total) * 100)) : 0;
  const countText = `${formatBytes(current)} / ${formatBytes(total)}`;
  const speedText = speedBps > 0 ? formatSpeed(speedBps) : "";
  const remain = total - current;
  const eta = (speedBps > 0 && remain > 0) ? remain / speedBps : NaN;
  const etaText = isFinite(eta) ? `残り ${formatDuration(eta)}` : "";
  const label = activeGroup ? PHASE_LABEL_BY_GROUP[activeGroup] : "インストール中";
  setProgressElements("ai-install", { pct, label, count: countText, speed: speedText, eta: etaText });
  setProgressElements("ai-log-progress", { pct, label, count: countText, speed: speedText, eta: etaText });
}

function appendLogLine(line, stream) {
  const viewer = $("ai-log-viewer");
  const lines = $("ai-log-lines") || viewer;
  if (!viewer || !lines) return;
  const div = document.createElement("div");
  div.className = "ai-log-line" + (stream === "stderr" ? " stderr" : "");
  div.textContent = line;
  lines.appendChild(div);
  while (lines.childElementCount > 1500) {
    lines.removeChild(lines.firstChild);
  }
  viewer.scrollTop = viewer.scrollHeight;
}

function clearLog() {
  const lines = $("ai-log-lines");
  if (lines) lines.innerHTML = "";
}

function setUninstallProgress(pct, label, count) {
  const box = $("ai-log-progress");
  if (box) box.hidden = false;
  setProgressElements("ai-log-progress", {
    pct,
    label,
    count,
    speed: "",
    eta: "",
  });
}

function startUninstallProgress() {
  if (uninstallProgressTimer) clearInterval(uninstallProgressTimer);
  let pct = 3;
  setUninstallProgress(pct, "アンインストール準備中", "0 / 3 ステップ");
  uninstallProgressTimer = setInterval(() => {
    if (!runningUninstall) return;
    const step = pct < 35 ? 6 : pct < 70 ? 3 : 1.2;
    pct = Math.min(92, pct + step);
    const count = pct < 35 ? "1 / 3 ステップ" : pct < 70 ? "2 / 3 ステップ" : "3 / 3 ステップ";
    setUninstallProgress(pct, "アンインストール中", count);
  }, 350);
}

function finishUninstallProgress(success, countText) {
  if (uninstallProgressTimer) {
    clearInterval(uninstallProgressTimer);
    uninstallProgressTimer = null;
  }
  setUninstallProgress(success ? 100 : 100, success ? "アンインストール完了" : "アンインストール失敗", countText);
}

function finishInstallProgress() {
  lastDownload = null;
  setProgressElements("ai-log-progress", {
    pct: 100,
    label: "インストール完了",
    count: `${PHASE_GROUPS.length} / ${PHASE_GROUPS.length} フェーズ`,
    speed: "",
    eta: "",
  });
  const box = $("ai-log-progress");
  if (box) box.hidden = false;
  const mainBox = $("ai-install-progress");
  if (mainBox) mainBox.hidden = true;
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
      startBtn.disabled = !!runningInstall || !!runningUninstall;
      startBtn.textContent = status?.available ? "再インストール" : "インストール開始";
    }
    // アンインストールボタンはインストール済み + インストール処理中でない時のみ表示。
    const uninstallBtn = $("ai-uninstall-btn");
    if (uninstallBtn) {
      uninstallBtn.hidden = !status?.available || !!runningInstall;
      uninstallBtn.disabled = !!runningInstall || !!runningUninstall;
    }
    window.dispatchEvent(new CustomEvent("psdesign:ai-model-status", {
      detail: { available: !!status?.available, status },
    }));
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
  if (runningInstall || runningUninstall) return;
  runningInstall = true;
  userCancelled = false;
  resetGroupState();
  lastDownload = null;
  clearLog();
  renderDownloadUI();
  setHeaderButtonMode("cancel");
  const startBtn = $("ai-install-start-btn");
  if (startBtn) startBtn.disabled = true;

  // 経過時間表示の開始
  const installStartedAt = Date.now();
  const timingBox = $("ai-install-timing");
  const elapsedEl = $("ai-install-elapsed");
  if (timingBox) timingBox.hidden = false;
  if (elapsedEl) elapsedEl.textContent = "0秒";
  const elapsedTick = setInterval(() => {
    if (elapsedEl) {
      const sec = Math.floor((Date.now() - installStartedAt) / 1000);
      elapsedEl.textContent = formatDuration(sec);
    }
  }, 1000);

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
    finishInstallProgress();
  });
  listeners = [unsubLog, unsubDone];

  // ETA を 250ms ごとに更新するタイマー (新しいログが来ない間も残り時間を進める)
  const tick = setInterval(() => {
    if (lastDownload) renderDownloadUI();
  }, 250);

  try {
    await invoke("install_ai_models");
    for (const g of PHASE_GROUPS) groupState[g] = "done";
    activeGroup = null;
    renderPhaseUI();
    finishInstallProgress();
    toast("スキャンエンジンインストール完了", { kind: "info", duration: 2400 });
    await refreshStatusBadge();
  } catch (e) {
    console.error(e);
    if (!userCancelled) {
      toast(`スキャンエンジンインストール失敗: ${e?.message ?? e}`, { kind: "error", duration: 6000 });
      await notifyDialog({
        title: "スキャンエンジンインストール失敗",
        message: String(e?.message ?? e ?? "不明なエラー"),
      });
    }
    // userCancelled === true: ポップアップ・トーストとも出さず静かに戻る
  } finally {
    clearInterval(tick);
    clearInterval(elapsedTick);
    if (timingBox) timingBox.hidden = true;
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

// 画像スキャンエンジン (AI ランタイム + 重みキャッシュ) のアンインストール。
//   - 削除対象: %LOCALAPPDATA%\PsDesign\ai-runtime\ + ~/.cache/huggingface/hub/models--kha-white--manga-ocr-base
//   - 削除総量: 約 5〜5.5 GB
// インストール処理中は呼ばない。confirmDialog (kind: danger) で明示確認、
// 成功で notifyDialog (success) → ステータス再評価で UI を未インストール状態に戻す。
async function runUninstall() {
  if (runningInstall || runningUninstall) return;
  // 念のため再確認: 既にアンインストール済みなら通知だけ。
  let pre;
  try { pre = await checkAiModelsStatus(); } catch (_) { pre = null; }
  if (!pre?.available) {
    await notifyDialog({
      title: "アンインストール不要",
      message: "画像スキャンエンジンは既にインストールされていません。",
    });
    await refreshStatusBadge();
    return;
  }

  const ok = await confirmDialog({
    title: "画像スキャンエンジンをアンインストール",
    message:
      "AI ランタイムとモデルファイル（合計 約 5〜5.5 GB）を削除します。\n" +
      "この操作は元に戻せません。再度利用するにはインストールし直す必要があります。\n\n" +
      "続行しますか？",
    kind: "danger",
    confirmLabel: "アンインストール",
    cancelLabel: "キャンセル",
  });
  if (!ok) return;

  runningUninstall = true;
  lastDownload = null;
  clearLog();
  renderDownloadUI();
  appendLogLine("アンインストールを開始しました。", "stdout");
  startUninstallProgress();
  await refreshStatusBadge();

  // 進捗モーダル (current/total を渡さないので automatically indeterminate モード)。
  // ファイル削除は通常数秒〜十数秒で終わるが 5GB の filesystem 削除なので環境次第。
  showProgress({ title: "画像スキャンエンジン", detail: "アンインストール中…" });

  let result = null;
  let error = null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    result = await invoke("uninstall_ai_models");
  } catch (e) {
    error = e;
  } finally {
    await hideProgress();
  }

  await refreshStatusBadge();

  if (error) {
    appendLogLine(String(error?.message ?? error ?? "不明なエラー"), "stderr");
    finishUninstallProgress(false, "削除に失敗しました");
    runningUninstall = false;
    await refreshStatusBadge();
    await notifyDialog({
      title: "アンインストール失敗",
      message:
        String(error?.message ?? error ?? "不明なエラー") +
        "\n\nファイルが使用中の場合は PsDesign を再起動してから再試行してください。",
    });
    return;
  }

  // 部分成功: deleted は 1 件以上、errors も 0 件以上の混在 → warning ダイアログ。
  const deletedCount = Array.isArray(result?.deleted) ? result.deleted.length : 0;
  const errorList = Array.isArray(result?.errors) ? result.errors : [];
  appendLogLine(`${deletedCount} 件の項目を削除しました。`, "stdout");
  for (const item of result?.deleted ?? []) appendLogLine(`削除: ${item}`, "stdout");
  for (const item of errorList) appendLogLine(`削除失敗: ${item}`, "stderr");
  finishUninstallProgress(true, errorList.length > 0 ? `${deletedCount} 件削除 / ${errorList.length} 件失敗` : `${deletedCount} 件削除`);
  runningUninstall = false;
  await refreshStatusBadge();

  if (errorList.length > 0) {
    await notifyDialog({
      title: "アンインストール完了 (一部失敗)",
      message:
        `${deletedCount} 件の項目を削除しましたが、以下は削除できませんでした:\n\n` +
        errorList.join("\n") +
        "\n\nファイルが使用中の場合は PsDesign を再起動してから再試行してください。",
      kind: "warning",
    });
  } else {
    await notifyDialog({
      title: "アンインストール完了",
      message: "画像スキャンエンジンを削除しました。",
      kind: "success",
    });
  }
}

// ===== モーダル開閉 =====
export async function openAiInstallModal() {
  const modal = $("ai-install-modal");
  if (!modal) return;
  modal.hidden = false;
  resetGroupState();
  lastDownload = null;
  renderDownloadUI();
  await refreshStatusBadge();
}

function closeAiInstallModal() {
  if (runningInstall || runningUninstall) return; // 実行中はクローズしない (中止は cancelInstall で別経路)
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

  const uninstallBtn = $("ai-uninstall-btn");
  if (uninstallBtn) {
    uninstallBtn.addEventListener("click", () => {
      runUninstall();
    });
  }

  // 起動時に1回ステータスチェック → バッジ点灯
  refreshStatusBadge();
}
