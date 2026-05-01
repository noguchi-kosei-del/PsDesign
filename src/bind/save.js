// 保存系: ドロップダウンメニュー、上書き / 別名で保存、保存中の多重実行ガード。
// 旧 main.js から切り出し。pickSaveParentDir / generateSaveFolderName / runSaveWithMode は
// このモジュール内部に閉じ、外向きには bindSaveMenu / handleOverwriteSave / handleSaveAs と
// 「保存可能フラグ」の get/set を export する。

import { exportEdits, getFolder, getPages, hasEdits } from "../state.js";
import {
  confirmDialog,
  hideProgress,
  notifyDialog,
  showProgress,
  toast,
} from "../ui-feedback.js";
import { baseName, joinPath } from "../utils/path.js";

// PSD 読込時に false にリセットされ、上書き保存成功で true になる。
// 初回 Ctrl+S は別名保存にフォールバックさせるため、ロード経路から setHasSavedThisSession(false) を呼ぶ。
let hasSavedThisSession = false;
let saveMenuOpen = false;
// Photoshop への保存 invoke が走っている間は true。Ctrl+S や保存ボタンの連打で
// 同じ PSD に対して invoke が並行実行されると Photoshop 側で開くドキュメントが
// 競合し、片方の編集が失われる / セッションが破壊されるためガードする。
let saveInflight = false;

export function getHasSavedThisSession() { return hasSavedThisSession; }
export function setHasSavedThisSession(v) { hasSavedThisSession = !!v; }

export function updateSaveButton() {
  const btn = document.getElementById("save-btn");
  if (btn) btn.disabled = getPages().length === 0;
}

async function pickSaveParentDir() {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    directory: true,
    multiple: false,
    title: "別名で保存：親フォルダを選択（この中に新規フォルダを作成します）",
  });
  return typeof picked === "string" ? picked : null;
}

function generateSaveFolderName() {
  const src = getFolder();
  const base = src ? baseName(src) : "PsDesign";
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ts =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${base}_${ts}`;
}

async function runSaveWithMode({ saveMode, targetDir }) {
  if (saveInflight) {
    toast("保存処理中です。完了までお待ちください", { kind: "info", duration: 2200 });
    return;
  }
  if (!hasEdits()) {
    toast("編集内容がありません", { kind: "info" });
    return;
  }
  const base = exportEdits();
  const payload = {
    ...base,
    saveMode,
    targetDir: targetDir ?? null,
  };
  saveInflight = true;
  const saveBtn = document.getElementById("save-btn");
  if (saveBtn) saveBtn.disabled = true;
  showProgress({ title: "Photoshop に反映中", detail: "スクリプトを実行しています..." });
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke("apply_edits_via_photoshop", { payload });
    hideProgress();
    const suffix = saveMode === "saveAs" && targetDir ? `（保存先: ${targetDir}）` : "";
    const hasWarn = typeof result === "string" && result.includes("警告:");
    hasSavedThisSession = true;
    // 保存完了は中央モーダルで通知。警告有無で kind を切替（warning=オレンジ + 警告 SVG / success=緑 + チェック SVG）。
    await notifyDialog({
      title: hasWarn ? "保存完了（警告あり）" : "保存完了",
      message: `${result}${suffix}`,
      kind: hasWarn ? "warning" : "success",
    });
  } catch (e) {
    console.error(e);
    hideProgress();
    toast(`保存失敗: ${e.message ?? e}`, { kind: "error", duration: 5000 });
  } finally {
    saveInflight = false;
    // pages 0 件なら disabled のまま。ある場合のみ復帰。
    if (saveBtn) saveBtn.disabled = getPages().length === 0;
  }
}

export async function handleOverwriteSave() {
  if (getPages().length === 0) return;
  if (!hasSavedThisSession) {
    await handleSaveAs();
    return;
  }
  await runSaveWithMode({ saveMode: "overwrite" });
}

async function handleExplicitOverwrite() {
  if (getPages().length === 0) return;
  await runSaveWithMode({ saveMode: "overwrite" });
}

export async function handleSaveAs() {
  if (getPages().length === 0) return;
  const parent = await pickSaveParentDir();
  if (!parent) return;
  const targetDir = joinPath(parent, generateSaveFolderName());
  await runSaveWithMode({ saveMode: "saveAs", targetDir });
}

function openSaveMenu() {
  const menu = document.getElementById("save-menu");
  const btn = document.getElementById("save-btn");
  if (!menu || !btn) return;
  if (btn.disabled) return;
  menu.hidden = false;
  btn.setAttribute("aria-expanded", "true");
  saveMenuOpen = true;
}

function closeSaveMenu() {
  if (!saveMenuOpen) return;
  const menu = document.getElementById("save-menu");
  const btn = document.getElementById("save-btn");
  if (menu) menu.hidden = true;
  if (btn) btn.setAttribute("aria-expanded", "false");
  saveMenuOpen = false;
}

function toggleSaveMenu() {
  if (saveMenuOpen) closeSaveMenu();
  else openSaveMenu();
}

export function bindSaveMenu() {
  const btn = document.getElementById("save-btn");
  const overwrite = document.getElementById("save-overwrite-btn");
  const saveAs = document.getElementById("save-as-btn");
  const container = document.getElementById("save-container");
  if (!btn || !overwrite || !saveAs || !container) return;

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleSaveMenu();
  });
  overwrite.addEventListener("click", (e) => {
    e.stopPropagation();
    closeSaveMenu();
    handleExplicitOverwrite();
  });
  saveAs.addEventListener("click", (e) => {
    e.stopPropagation();
    closeSaveMenu();
    handleSaveAs();
  });
  document.addEventListener("mousedown", (e) => {
    if (!saveMenuOpen) return;
    if (container.contains(e.target)) return;
    closeSaveMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && saveMenuOpen) {
      e.preventDefault();
      closeSaveMenu();
    }
  });
}
