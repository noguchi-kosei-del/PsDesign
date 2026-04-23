import { loadPsdFromPath } from "./psd-loader.js";
import { renderAllSpreads } from "./spread-view.js";
import {
  bindEditorEvents,
  commitSelectedLayerField,
  hasSelection,
  rebuildLayerList,
} from "./text-editor.js";
import { initTxtSource, loadTxtFromPath } from "./txt-source.js";
import { initPagebar, renderPagebar } from "./pagebar.js";
import { initHamburgerMenu } from "./hamburger-menu.js";
import {
  hideProgress,
  showProgress,
  toast,
  updateProgress,
} from "./ui-feedback.js";
import {
  addPage,
  clearPages,
  exportEdits,
  getCurrentPageIndex,
  getFolder,
  getPages,
  getTextSize,
  getTool,
  getZoom,
  hasEdits,
  onPageIndexChange,
  onTextSizeChange,
  onToolChange,
  onZoomChange,
  setCurrentPageIndex,
  setFolder,
  setFonts,
  setTextSize,
  setTool,
  setZoom,
} from "./state.js";

async function pickFolder() {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false });
  return typeof picked === "string" ? picked : null;
}

async function listPsdFiles(folder) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("list_psd_files", { folder });
}

async function handleOpenFolder() {
  const folder = await pickFolder();
  if (!folder) return;
  await loadFolderByPath(folder);
}

async function loadFolderByPath(folder) {
  if (!folder) return;
  setFolder(folder);
  hasSavedThisSession = false;

  showProgress({ title: "PSD を読み込み中", detail: "ファイル一覧を取得中..." });

  let files;
  try {
    files = await listPsdFiles(folder);
  } catch (e) {
    hideProgress();
    toast(`フォルダ読込失敗: ${e.message ?? e}`, { kind: "error", duration: 4500 });
    return;
  }
  if (!files.length) {
    hideProgress();
    toast(`PSD が見つかりません: ${folder}`, { kind: "error", duration: 4500 });
    return;
  }

  clearPages();
  renderAllSpreads();
  rebuildLayerList();
  renderPagebar();

  const failures = [];
  for (let i = 0; i < files.length; i++) {
    const path = files[i];
    updateProgress({
      detail: baseName(path),
      current: i,
      total: files.length,
    });
    try {
      const page = await loadPsdFromPath(path);
      addPage(page);
      renderAllSpreads();
      rebuildLayerList();
      renderPagebar();
    } catch (e) {
      console.error(e);
      failures.push({ path, error: e });
    }
    updateProgress({
      detail: baseName(path),
      current: i + 1,
      total: files.length,
    });
  }

  updateSaveButton();
  hideProgress();
  if (failures.length) {
    const first = failures[0];
    const msg =
      failures.length === 1
        ? `読込失敗 ${baseName(first.path)}: ${first.error?.message ?? first.error}`
        : `読込失敗 ${failures.length} 件（${baseName(first.path)} 他）`;
    toast(msg, { kind: "error", duration: 5000 });
  }
}

function updateSaveButton() {
  const btn = document.getElementById("save-btn");
  btn.disabled = getPages().length === 0;
}

let hasSavedThisSession = false;
let saveMenuOpen = false;

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

function joinPath(parent, child) {
  if (!parent) return child;
  const sep = /[\\/]$/.test(parent) ? "" : "/";
  return `${parent}${sep}${child}`;
}

async function runSaveWithMode({ saveMode, targetDir }) {
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
  showProgress({ title: "Photoshop に反映中", detail: "スクリプトを実行しています..." });
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke("apply_edits_via_photoshop", { payload });
    hideProgress();
    const suffix = saveMode === "saveAs" && targetDir ? `（保存先: ${targetDir}）` : "";
    toast(`保存完了: ${result}${suffix}`, { kind: "success", duration: 3500 });
    hasSavedThisSession = true;
  } catch (e) {
    console.error(e);
    hideProgress();
    toast(`保存失敗: ${e.message ?? e}`, { kind: "error", duration: 5000 });
  }
}

async function handleOverwriteSave() {
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

async function handleSaveAs() {
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

function bindSaveMenu() {
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

async function loadFontsFromBackend() {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const fonts = await invoke("list_fonts");
    setFonts(fonts);
  } catch (e) {
    console.warn("フォント一覧の取得に失敗:", e);
  }
}

function baseName(p) {
  const m = p && p.match(/[\\/]([^\\/]+)$/);
  return m ? m[1] : p;
}

let panPreviousTool = null;
let panSpaceActive = false;

function bindTools() {
  const buttons = document.querySelectorAll(".tool-btn");
  for (const btn of buttons) {
    btn.addEventListener("click", () => setTool(btn.dataset.tool));
  }
  const applyActive = () => {
    const current = getTool();
    for (const btn of buttons) {
      btn.classList.toggle("active", btn.dataset.tool === current);
    }
  };
  onToolChange((tool) => {
    applyActive();
    if (panSpaceActive && tool !== "pan") {
      panPreviousTool = null;
      panSpaceActive = false;
    }
  });
  applyActive();

  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !e.repeat) {
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (!panSpaceActive) {
        panSpaceActive = true;
        if (getTool() !== "pan") {
          panPreviousTool = getTool();
          setTool("pan");
        } else {
          panPreviousTool = null;
        }
        e.preventDefault();
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      if (e.code === "Equal" || e.code === "NumpadAdd" || e.key === "+" || e.key === ";") {
        e.preventDefault();
        setZoom(getZoom() * 1.15);
        return;
      }
      if (e.code === "Minus" || e.code === "NumpadSubtract" || e.key === "-") {
        e.preventDefault();
        setZoom(getZoom() / 1.15);
        return;
      }
      if (e.code === "Digit0" || e.code === "Numpad0") {
        e.preventDefault();
        setZoom(1);
        return;
      }
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "j" || e.key === "J")) {
      e.preventDefault();
      openPageJumpDialog();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      handleOverwriteSave();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.shiftKey && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      handleSaveAs();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const total = getPages().length;
      if (total === 0) return;
      e.preventDefault();
      setCurrentPageIndex(e.key === "ArrowLeft" ? 0 : total - 1);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
      return;
    }
    if (e.key === "v" || e.key === "V") {
      setTool("move");
    } else if (e.key === "t" || e.key === "T") {
      setTool("text");
    } else if (e.key === "[") {
      adjustTextSize(-(e.shiftKey ? 10 : 2));
    } else if (e.key === "]") {
      adjustTextSize(+(e.shiftKey ? 10 : 2));
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      setCurrentPageIndex(getCurrentPageIndex() - 1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      setCurrentPageIndex(getCurrentPageIndex() + 1);
    }
  });

  window.addEventListener("keyup", (e) => {
    if (e.code === "Space" && panSpaceActive) {
      panSpaceActive = false;
      if (panPreviousTool) {
        setTool(panPreviousTool);
        panPreviousTool = null;
      }
    }
  });

  window.addEventListener("blur", () => {
    if (panSpaceActive) {
      panSpaceActive = false;
      if (panPreviousTool) {
        setTool(panPreviousTool);
        panPreviousTool = null;
      }
    }
  });
}

function bindPageChange() {
  onPageIndexChange(() => {
    renderAllSpreads();
    rebuildLayerList();
    renderPagebar();
  });
}

function applyTextSize(n) {
  setTextSize(n);
  if (hasSelection()) {
    commitSelectedLayerField("sizePt", getTextSize());
  }
}

function adjustTextSize(delta) {
  applyTextSize(getTextSize() + delta);
}

function bindSizeTool() {
  const input = document.getElementById("size-input");
  const dec = document.getElementById("size-dec-btn");
  const inc = document.getElementById("size-inc-btn");
  if (!input || !dec || !inc) return;

  input.value = String(getTextSize());
  onTextSizeChange((v) => {
    if (document.activeElement !== input) input.value = String(v);
  });

  input.addEventListener("input", () => {
    const v = parseFloat(input.value);
    if (!Number.isFinite(v)) return;
    applyTextSize(v);
  });
  input.addEventListener("blur", () => {
    input.value = String(getTextSize());
  });
  dec.addEventListener("click", () => adjustTextSize(-1));
  inc.addEventListener("click", () => adjustTextSize(+1));
}

async function handleDroppedPaths(paths) {
  if (!paths || paths.length === 0) return;
  for (const p of paths) {
    if (/\.txt$/i.test(p)) {
      await loadTxtFromPath(p);
    } else {
      await loadFolderByPath(p);
    }
  }
}

async function setupTauriDragDrop() {
  try {
    const { listen } = await import("@tauri-apps/api/event");
    await listen("tauri://drag-drop", (e) => {
      const paths = Array.isArray(e.payload?.paths) ? e.payload.paths : [];
      handleDroppedPaths(paths).catch((err) => console.error(err));
    });
  } catch (e) {
    console.warn("drag-drop listener failed:", e);
  }
}

function bindZoomTool() {
  const out = document.getElementById("zoom-out-btn");
  const inn = document.getElementById("zoom-in-btn");
  const level = document.getElementById("zoom-level-btn");
  const stage = document.getElementById("spreads-container");
  if (!out || !inn || !level) return;

  const updateLevel = () => {
    level.textContent = `${Math.round(getZoom() * 100)}%`;
  };
  updateLevel();
  onZoomChange(updateLevel);

  const step = (dir) => {
    const cur = getZoom();
    const factor = 1.15;
    setZoom(dir > 0 ? cur * factor : cur / factor);
  };
  out.addEventListener("click", () => step(-1));
  inn.addEventListener("click", () => step(+1));
  level.addEventListener("click", () => setZoom(1));

  if (stage) {
    stage.addEventListener(
      "wheel",
      (e) => {
        if (!e.altKey) return;
        e.preventDefault();
        const factor = e.deltaY > 0 ? 1 / 1.1 : 1.1;
        setZoom(getZoom() * factor);
      },
      { passive: false },
    );
  }

  window.addEventListener(
    "keydown",
    (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      let handled = false;
      if (e.code === "Equal" || e.code === "NumpadAdd" || e.key === "+" || e.key === ";") {
        setZoom(getZoom() * 1.15);
        handled = true;
      } else if (e.code === "Minus" || e.code === "NumpadSubtract" || e.key === "-") {
        setZoom(getZoom() / 1.15);
        handled = true;
      } else if (e.code === "Digit0" || e.code === "Numpad0") {
        setZoom(1);
        handled = true;
      }
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    { capture: true },
  );
}

function openPageJumpDialog() {
  const total = getPages().length;
  if (total === 0) {
    toast("ページが読み込まれていません", { kind: "info", duration: 1800 });
    return;
  }
  const modal = document.getElementById("page-jump-modal");
  const input = document.getElementById("page-jump-input");
  const hint = document.getElementById("page-jump-hint");
  if (!modal || !input) return;
  input.max = String(total);
  input.value = String(getCurrentPageIndex() + 1);
  if (hint) hint.textContent = `1 〜 ${total} のページ番号を入力してください`;
  modal.hidden = false;
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

function closePageJumpDialog() {
  const modal = document.getElementById("page-jump-modal");
  if (modal) modal.hidden = true;
}

function commitPageJump() {
  const input = document.getElementById("page-jump-input");
  if (!input) return;
  const v = parseInt(input.value, 10);
  if (Number.isFinite(v)) {
    setCurrentPageIndex(v - 1);
  }
  closePageJumpDialog();
}

function bindPageJumpDialog() {
  const modal = document.getElementById("page-jump-modal");
  const ok = document.getElementById("page-jump-ok");
  const cancel = document.getElementById("page-jump-cancel");
  const input = document.getElementById("page-jump-input");
  if (!modal || !ok || !cancel || !input) return;
  ok.addEventListener("click", commitPageJump);
  cancel.addEventListener("click", closePageJumpDialog);
  modal.addEventListener("mousedown", (e) => {
    if (e.target === modal) closePageJumpDialog();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitPageJump();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closePageJumpDialog();
    }
  });
}

function bindWindowControls() {
  const min = document.getElementById("window-min-btn");
  const max = document.getElementById("window-max-btn");
  const close = document.getElementById("window-close-btn");
  if (!min || !max || !close) return;
  const getWin = async () => {
    const mod = await import("@tauri-apps/api/window");
    return mod.getCurrentWindow();
  };
  min.addEventListener("click", async () => { (await getWin()).minimize(); });
  max.addEventListener("click", async () => { (await getWin()).toggleMaximize(); });
  close.addEventListener("click", async () => { (await getWin()).close(); });
}

function init() {
  document.getElementById("open-folder-btn").addEventListener("click", handleOpenFolder);
  bindSaveMenu();
  initHamburgerMenu();
  bindTools();
  bindSizeTool();
  bindZoomTool();
  bindPageChange();
  bindEditorEvents();
  bindWindowControls();
  bindPageJumpDialog();
  initTxtSource();
  initPagebar();
  setupTauriDragDrop();
  renderAllSpreads();
  renderPagebar();
  loadFontsFromBackend();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
