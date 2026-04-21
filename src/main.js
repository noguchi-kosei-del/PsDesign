import { loadPsdFromPath } from "./psd-loader.js";
import { renderAllSpreads } from "./spread-view.js";
import {
  bindEditorEvents,
  commitSelectedLayerField,
  hasSelection,
  rebuildLayerList,
} from "./text-editor.js";
import { initTxtSource } from "./txt-source.js";
import { initPagebar, renderPagebar } from "./pagebar.js";
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
  getPages,
  getTextSize,
  getTool,
  hasEdits,
  onPageIndexChange,
  onTextSizeChange,
  onToolChange,
  setCurrentPageIndex,
  setFolder,
  setFonts,
  setTextSize,
  setTool,
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
  setFolder(folder);

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

async function handleSave() {
  if (!hasEdits()) {
    toast("編集内容がありません", { kind: "info" });
    return;
  }
  const payload = exportEdits();
  showProgress({ title: "Photoshop に反映中", detail: "スクリプトを実行しています..." });
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke("apply_edits_via_photoshop", { payload });
    hideProgress();
    toast(`保存完了: ${result}`, { kind: "success", duration: 3500 });
  } catch (e) {
    console.error(e);
    hideProgress();
    toast(`保存失敗: ${e.message ?? e}`, { kind: "error", duration: 5000 });
  }
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
  onToolChange(applyActive);
  applyActive();

  window.addEventListener("keydown", (e) => {
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
  dec.addEventListener("click", (e) => adjustTextSize(-(e.shiftKey ? 10 : 2)));
  inc.addEventListener("click", (e) => adjustTextSize(+(e.shiftKey ? 10 : 2)));
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
  document.getElementById("save-btn").addEventListener("click", handleSave);
  bindTools();
  bindSizeTool();
  bindPageChange();
  bindEditorEvents();
  bindWindowControls();
  initTxtSource();
  initPagebar();
  renderAllSpreads();
  renderPagebar();
  loadFontsFromBackend();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
