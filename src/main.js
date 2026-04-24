import { loadPsdFromPath } from "./psd-loader.js";
import { loadPdfByPath, pickPdfFile } from "./pdf-loader.js";
import { mountPdfView } from "./pdf-view.js";
import { nudgeSelectedLayers, refreshAllOverlays } from "./canvas-tools.js";
import { onFontsRegistered } from "./font-loader.js";
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
  getPsdRotation,
  getTextSize,
  getTool,
  getZoom,
  getPdfRotation,
  hasEdits,
  onPageIndexChange,
  onPdfChange,
  onTextSizeChange,
  onToolChange,
  onZoomChange,
  setPdfRotation,
  setPsdRotation,
  setCurrentPageIndex,
  setFolder,
  setFonts,
  setTextSize,
  setTool,
  setZoom,
} from "./state.js";

async function pickPsdFiles() {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    multiple: true,
    filters: [{ name: "Photoshop Document", extensions: ["psd"] }],
  });
  if (!picked) return [];
  return Array.isArray(picked) ? picked : [picked];
}

async function listPsdFilesInFolder(folder) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("list_psd_files", { folder });
}

async function handleOpenFiles() {
  const files = await pickPsdFiles();
  if (!files.length) return;
  await loadPsdFilesByPaths(files);
}

async function handleOpenPdf() {
  const path = await pickPdfFile();
  if (!path) return;
  await loadPdfByPath(path);
}

function bindPdfWorkspaceToggle() {
  // PDF エリアは常時表示（未読込時は empty state を見せる）。回転ボタンだけ doc 有無で切替。
  const rotateBtn = document.getElementById("pdf-rotate-btn");
  const apply = (doc) => {
    if (rotateBtn) rotateBtn.hidden = !doc;
  };
  onPdfChange(apply);
  apply(null);
}

function bindPdfRotate() {
  const btn = document.getElementById("pdf-rotate-btn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    setPdfRotation((getPdfRotation() + 90) % 360);
  });
}

function bindPsdRotate() {
  const btn = document.getElementById("psd-rotate-btn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    setPsdRotation((getPsdRotation() + 90) % 360);
  });
}

function updatePsdRotateVisibility() {
  const btn = document.getElementById("psd-rotate-btn");
  if (!btn) return;
  btn.hidden = getPages().length === 0;
}

function parentDir(p) {
  if (!p) return null;
  const m = p.match(/^(.+)[\\/][^\\/]+$/);
  return m ? m[1] : null;
}

async function loadPsdFilesByPaths(files) {
  if (!files || files.length === 0) return;
  // 最初に選んだファイルの親ディレクトリを「別名で保存」の既定フォルダ名算出に使う。
  setFolder(parentDir(files[0]) ?? null);
  hasSavedThisSession = false;

  showProgress({
    title: "PSD を読み込み中",
    detail: baseName(files[0]),
    current: 0,
    total: files.length,
  });

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
  updatePsdRotateVisibility();
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
    const hasWarn = typeof result === "string" && result.includes("警告:");
    toast(`保存完了: ${result}${suffix}`, {
      kind: hasWarn ? "info" : "success",
      duration: hasWarn ? 7000 : 3500,
    });
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
    // Space 長押しで一時的に pan 化しているときは、直前ツールを選択中として表示し続ける
    const current = panSpaceActive && panPreviousTool ? panPreviousTool : getTool();
    for (const btn of buttons) {
      btn.classList.toggle("active", btn.dataset.tool === current);
    }
  };
  onToolChange((tool) => {
    if (panSpaceActive && tool !== "pan") {
      panPreviousTool = null;
      panSpaceActive = false;
    }
    applyActive();
  });
  applyActive();

  // Alt 単独押下/離上で Windows のシステムメニューが活性化し、次の Space で開いてしまう
  // 事故を防ぐ。Alt+wheel でズームした直後に Space を押すと左上にメニューが出る現象の対策。
  const suppressAltMenuActivation = (e) => {
    if (e.key === "Alt" || e.code === "AltLeft" || e.code === "AltRight") {
      e.preventDefault();
    }
  };
  window.addEventListener("keydown", suppressAltMenuActivation);
  window.addEventListener("keyup", suppressAltMenuActivation);

  window.addEventListener("keydown", (e) => {
    if (e.code === "Space") {
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      // ボタンにフォーカスが残っていると Space で click が誘発され、直前に押したツール/回転ボタンが
      // 再発火してしまう。Space をパン専用キーとして扱うため、入り口でフォーカスを解除する。
      const active = document.activeElement;
      if (active instanceof HTMLElement && (active.tagName === "BUTTON" || active.tagName === "A")) {
        active.blur();
      }
      // MojiQ 互換：リピート含めて全 Space keydown を preventDefault（既定の「Space で1画面下スクロール」を常に抑止）
      e.preventDefault();
      if (e.repeat) return;
      if (!panSpaceActive) {
        panSpaceActive = true;
        if (getTool() !== "pan") {
          panPreviousTool = getTool();
          setTool("pan");
        } else {
          panPreviousTool = null;
        }
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
      setTool("text-v");
    } else if (e.key === "y" || e.key === "Y") {
      setTool("text-h");
    } else if (e.key === "[") {
      adjustTextSize(-(e.shiftKey ? 10 : 2));
    } else if (e.key === "]") {
      adjustTextSize(+(e.shiftKey ? 10 : 2));
    } else if (
      e.key === "ArrowLeft" ||
      e.key === "ArrowRight" ||
      e.key === "ArrowUp" ||
      e.key === "ArrowDown"
    ) {
      const step = e.shiftKey ? 10 : 1;
      let dx = 0;
      let dy = 0;
      if (e.key === "ArrowLeft") dx = -step;
      else if (e.key === "ArrowRight") dx = +step;
      else if (e.key === "ArrowUp") dy = -step;
      else if (e.key === "ArrowDown") dy = +step;
      if (getTool() === "move" && nudgeSelectedLayers(dx, dy)) {
        e.preventDefault();
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setCurrentPageIndex(getCurrentPageIndex() - 1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setCurrentPageIndex(getCurrentPageIndex() + 1);
      }
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
    updatePsdRotateVisibility();
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
  const psdFiles = [];
  const txtFiles = [];
  const pdfFiles = [];
  const unknowns = []; // 拡張子なし ＝ おそらくフォルダ
  for (const p of paths) {
    if (/\.psd$/i.test(p)) psdFiles.push(p);
    else if (/\.txt$/i.test(p)) txtFiles.push(p);
    else if (/\.pdf$/i.test(p)) pdfFiles.push(p);
    else unknowns.push(p);
  }
  // フォルダらしきものは中の .psd を展開して取り込む（従来の利便性を維持）。
  for (const folder of unknowns) {
    try {
      const files = await listPsdFilesInFolder(folder);
      if (Array.isArray(files) && files.length) psdFiles.push(...files);
    } catch (e) {
      console.warn("フォルダ展開に失敗:", folder, e);
    }
  }
  if (psdFiles.length > 0) {
    await loadPsdFilesByPaths(psdFiles);
  }
  for (const t of txtFiles) {
    await loadTxtFromPath(t);
  }
  if (pdfFiles.length > 0) {
    if (pdfFiles.length > 1) {
      toast("PDF は 1 つだけ読み込みました（先頭のみ）", { kind: "info", duration: 3000 });
    }
    await loadPdfByPath(pdfFiles[0]);
  }
}

async function setupTauriDragDrop() {
  try {
    const { listen } = await import("@tauri-apps/api/event");
    const overlay = document.getElementById("drag-overlay");
    const showOverlay = () => {
      if (!overlay) return;
      overlay.classList.remove("flash");
      overlay.classList.add("active");
    };
    const hideOverlay = () => overlay?.classList.remove("active");
    const flashOverlay = () => {
      if (!overlay) return;
      overlay.classList.remove("active");
      overlay.classList.remove("flash");
      // 同フレームの re-add でアニメーションを確実に再発火
      void overlay.offsetWidth;
      overlay.classList.add("flash");
      setTimeout(() => overlay.classList.remove("flash"), 400);
    };

    await listen("tauri://drag-enter", showOverlay);
    await listen("tauri://drag-over", showOverlay);
    await listen("tauri://drag-leave", hideOverlay);
    await listen("tauri://drag-drop", (e) => {
      flashOverlay();
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
  document.getElementById("open-folder-btn").addEventListener("click", handleOpenFiles);
  document.getElementById("open-pdf-btn")?.addEventListener("click", handleOpenPdf);
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
  bindPdfWorkspaceToggle();
  bindPdfRotate();
  bindPsdRotate();
  updatePsdRotateVisibility();
  mountPdfView();
  setupTauriDragDrop();
  renderAllSpreads();
  renderPagebar();
  loadFontsFromBackend();
  // フォントが非同期で登録されるたびにオーバーレイを再描画して反映。
  onFontsRegistered(() => refreshAllOverlays());
  bindGlobalBlurOnOutsideClick();
}

// INPUT/TEXTAREA/contenteditable 以外をクリックしたら、現在フォーカス中のテキスト入力から
// フォーカスを外す。Space でパンを切り替えた際に入力欄に文字が入る事故を防ぐ。
function bindGlobalBlurOnOutsideClick() {
  document.addEventListener("mousedown", (e) => {
    const active = document.activeElement;
    if (!active) return;
    const tag = active.tagName;
    const isTextInput =
      (tag === "INPUT" && !/^(button|submit|checkbox|radio|range|color)$/i.test(active.type || "")) ||
      tag === "TEXTAREA" ||
      active.isContentEditable;
    if (!isTextInput) return;
    const target = e.target;
    if (!target) return;
    // 入力欄自身やそれに紐づく UI（コンボボックス・ドロップダウン等）の中をクリックしたときは維持
    if (target === active || active.contains(target)) return;
    const near = target.closest?.("input, textarea, [contenteditable], .font-combobox, .save-menu, .text-input-floater");
    if (near) return;
    active.blur();
  }, true);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
