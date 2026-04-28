import { loadPsdFromPath } from "./psd-loader.js";
import { loadPdfByPath, pickPdfFile } from "./pdf-loader.js";
import { mountPdfView } from "./pdf-view.js";
import { deleteSelectedLayers, nudgeSelectedLayers, refreshAllOverlays } from "./canvas-tools.js";
import { onFontsRegistered } from "./font-loader.js";
import { renderAllSpreads } from "./spread-view.js";
import {
  bindEditorEvents,
  commitSelectedLayerField,
  hasSelection,
  rebuildLayerList,
} from "./text-editor.js";
import { initTxtSource, loadTxtFromPath } from "./txt-source.js";
import { bindAiInstallMenu } from "./ai-install.js";
import { bindAiOcrButton } from "./ai-ocr.js";
import { bindAiPlaceButton } from "./ai-place.js";
import { initHamburgerMenu } from "./hamburger-menu.js";
import {
  confirmDialog,
  hideProgress,
  notifyDialog,
  showProgress,
  toast,
  updateProgress,
} from "./ui-feedback.js";
import {
  findShortcutMatch,
  getPageDirectionInverted,
  getShortcut,
  matchShortcut,
} from "./settings.js";
import { initSettingsUi } from "./settings-ui.js";
import {
  initRulers,
  toggleRulersVisible,
  getRulersVisible,
  onRulersVisibleChange,
  getGuidesLocked,
  toggleGuidesLocked,
  onGuidesLockedChange,
} from "./rulers.js";
import {
  addPage,
  canRedo,
  canUndo,
  clearAllEdits,
  clearPages,
  exportEdits,
  getActivePane,
  getCurrentPageIndex,
  getFolder,
  getPages,
  getParallelSyncMode,
  getParallelViewMode,
  getPdfPageIndex,
  getPdfRotation,
  getPdfSkipFirstBlank,
  getPdfZoom,
  getPsdRotation,
  getPsdZoom,
  getTextSize,
  getTool,
  hasEdits,
  onActivePaneChange,
  onHistoryChange,
  onPageIndexChange,
  onParallelSyncModeChange,
  onParallelViewModeChange,
  onPdfChange,
  onPdfPageIndexChange,
  onPdfSkipFirstBlankChange,
  onPdfSplitModeChange,
  onPdfZoomChange,
  onPsdZoomChange,
  onTextSizeChange,
  onToolChange,
  setActivePane,
  setCurrentPageIndex,
  setFolder,
  setFonts,
  setParallelSyncMode,
  setParallelViewMode,
  setPdfPageIndex,
  setPdfRotation,
  setPdfSkipFirstBlank,
  setPdfZoom,
  setPsdRotation,
  setPsdZoom,
  setTextSize,
  setTool,
  redo,
  undo,
  getLeadingPct,
  setLeadingPct,
  onLeadingPctChange,
  getEditingContext,
  onEditingContextChange,
  setLineLeading,
  getLineLeading,
  toggleFramesVisible,
  onFramesVisibleChange,
  getFramesVisible,
  applyToolDefaults,
} from "./state.js";
import {
  getPdfVirtualIndexForPhysicalPage,
  getPdfVirtualPageAt,
  getPdfVirtualPageCount,
} from "./pdf-pages.js";

async function pickPsdFiles() {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    multiple: true,
    title: "PSDを開く",
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

function bindPsdGuidesLock() {
  const btn = document.getElementById("psd-guides-lock-btn");
  if (!btn) return;
  const sync = () => {
    const locked = getGuidesLocked();
    btn.setAttribute("aria-pressed", locked ? "true" : "false");
    btn.title = locked ? "ガイドのロック解除" : "ガイドをロック";
    btn.setAttribute("aria-label", btn.title);
  };
  btn.addEventListener("click", () => toggleGuidesLocked());
  onGuidesLockedChange(sync);
  sync();
  // ガイド表示と連動して表示/非表示。ルーラー OFF または PSD 未読込時は隠す。
  const updateVis = () => {
    btn.hidden = !getRulersVisible() || getPages().length === 0;
  };
  onRulersVisibleChange(updateVis);
  updateVis();
}

// ガイドロックボタンの「ファイル読込みあり」条件を、PSD ロード/クリア時に同期。
function updatePsdGuidesLockVisibility() {
  const btn = document.getElementById("psd-guides-lock-btn");
  if (!btn) return;
  btn.hidden = !getRulersVisible() || getPages().length === 0;
}

function parentDir(p) {
  if (!p) return null;
  const m = p.match(/^(.+)[\\/][^\\/]+$/);
  return m ? m[1] : null;
}

async function loadPsdFilesByPaths(files) {
  if (!files || files.length === 0) return;
  // 未保存の編集があるなら警告して確認を取る。clearPages() は state.edits / newLayers を
  // 黙って消すため、編集中のユーザーがファイル選択ダイアログ等から別 PSD を開いた瞬間に
  // 作業内容が無警告で失われる事故を防ぐ。
  if (hasEdits()) {
    const ok = await confirmDialog({
      title: "未保存の編集があります",
      message: "現在の編集内容は破棄されます。続行しますか？",
      confirmLabel: "破棄して開く",
    });
    if (!ok) return;
  }
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
  updatePageNav();

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
      updatePageNav();
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
  updatePsdGuidesLockVisibility();
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
// Photoshop への保存 invoke が走っている間は true。Ctrl+S や保存ボタンの連打で
// 同じ PSD に対して invoke が並行実行されると Photoshop 側で開くドキュメントが
// 競合し、片方の編集が失われる / セッションが破壊されるためガードする。
let saveInflight = false;

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
    // 保存完了は中央モーダルで通知（ユーザー要望）。警告ありなら見出しに⚠を付与。
    await notifyDialog({
      title: hasWarn ? "保存完了 ⚠ 警告あり" : "保存完了",
      message: `${result}${suffix}`,
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

// 環境設定経由でカスタマイズされたショートカット ID を実際のアクションに dispatch。
// pagePrev / pageNext / pageFirst / pageLast はページ送り反転設定 (settings.js) に従って
// 進行方向を入替える。＋/− ボタン・サイドバーボタンは反転対象外（物理矢印キーのみ反転）。
function runShortcut(id) {
  const inv = getPageDirectionInverted();
  switch (id) {
    case "save":       handleOverwriteSave(); break;
    case "saveAs":     handleSaveAs(); break;
    case "pagePrev":   advancePage(inv ? +1 : -1); break;
    case "pageNext":   advancePage(inv ? -1 : +1); break;
    case "pageFirst":  jumpToEdge(inv ? "last" : "first"); break;
    case "pageLast":   jumpToEdge(inv ? "first" : "last"); break;
    case "pageJump":   openPageJumpDialog(); break;
    case "toolSelect": setTool("move"); break;
    case "toolTextV":  setTool("text-v"); break;
    case "toolTextH":  setTool("text-h"); break;
    case "zoomIn":     zoomActivePaneBy(1.15); break;
    case "zoomOut":    zoomActivePaneBy(1 / 1.15); break;
    case "zoomReset":  resetActivePaneZoom(); break;
    case "sizeUp":     adjustTextSize(+2); break;
    case "sizeDown":   adjustTextSize(-2); break;
    case "toggleRulers": toggleRulersVisible(); break;
    case "toggleFrames": toggleFramesVisible(); break;
  }
}

// 入力欄 (INPUT/TEXTAREA/contenteditable) 内では発火させたくないショートカット判定。
// 規則：修飾キーなし or 矢印キー使用 → 入力欄では無効。Ctrl+S 等は入力欄でも有効を維持。
function isShortcutBlockedInInput(id, target) {
  if (!target) return false;
  const isInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
  if (!isInput) return false;
  const sc = getShortcut(id);
  if (!sc) return false;
  const isArrow =
    sc.key === "ArrowLeft" || sc.key === "ArrowRight" ||
    sc.key === "ArrowUp"   || sc.key === "ArrowDown";
  const noMods = !sc.modifiers || sc.modifiers.length === 0;
  return isArrow || noMods;
}

function isPageNavShortcut(id) {
  return id === "pagePrev" || id === "pageNext" || id === "pageFirst" || id === "pageLast";
}

// Undo / Redo / 全削除 ボタン群を配線。
// 状態（disabled）は onHistoryChange / onPdfChange... ではなく state.history の
// 変動と pages 切替に追従させたいので、updateHistoryButtons を共通呼び出しにする。
function updateHistoryButtons() {
  const undoBtn = document.getElementById("undo-btn");
  const redoBtn = document.getElementById("redo-btn");
  const clearBtn = document.getElementById("clear-all-btn");
  if (undoBtn) undoBtn.disabled = !canUndo();
  if (redoBtn) redoBtn.disabled = !canRedo();
  if (clearBtn) clearBtn.disabled = !hasEdits();
}

async function handleClearAllEdits() {
  if (!hasEdits()) return;
  const ok = await confirmDialog({
    title: "編集を全て削除",
    message: "現在の編集（移動・追加レイヤー・テキスト変更など）をすべて削除します。",
    confirmLabel: "全て削除",
  });
  if (!ok) return;
  clearAllEdits();
  refreshAllOverlays();
  rebuildLayerList();
}

function bindHistoryButtons() {
  const undoBtn = document.getElementById("undo-btn");
  const redoBtn = document.getElementById("redo-btn");
  const clearBtn = document.getElementById("clear-all-btn");
  if (undoBtn) undoBtn.addEventListener("click", () => { if (undo()) syncAfterHistoryChange(); });
  if (redoBtn) redoBtn.addEventListener("click", () => { if (redo()) syncAfterHistoryChange(); });
  if (clearBtn) clearBtn.addEventListener("click", () => { handleClearAllEdits(); });
  // 履歴の変更（push / undo / redo / baseline reset）に追従して disabled と再描画を更新。
  onHistoryChange(() => {
    updateHistoryButtons();
    refreshAllOverlays();
    rebuildLayerList();
  });
  updateHistoryButtons();
}

// undo / redo は state を書換えるだけなので、UI は onHistoryChange listener が受ける。
// ここでは listener を介さない経路向けに用意（現状未使用、将来のため安全側）。
function syncAfterHistoryChange() {
  refreshAllOverlays();
  rebuildLayerList();
  updateHistoryButtons();
}

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
    // Space は環境設定対象外（パン一時切替の特殊挙動を保つ）。
    if (e.code === "Space") {
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && (active.tagName === "BUTTON" || active.tagName === "A")) {
        active.blur();
      }
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

    // 矢印キーは「move ツール + レイヤー選択中」のときレイヤーナッジを最優先。
    // ナッジが効かない場合は下のショートカット dispatch に流して pagePrev/pageNext に当てる。
    const isArrowKey =
      e.key === "ArrowLeft" || e.key === "ArrowRight" ||
      e.key === "ArrowUp" || e.key === "ArrowDown";
    if (isArrowKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const t = e.target;
      const isInput = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      const tool = getTool();
      const nudgeTool = tool === "move" || tool === "text-v" || tool === "text-h";
      if (!isInput && nudgeTool) {
        const step = e.shiftKey ? 10 : 1;
        let dx = 0, dy = 0;
        if (e.key === "ArrowLeft") dx = -step;
        else if (e.key === "ArrowRight") dx = +step;
        else if (e.key === "ArrowUp") dy = -step;
        else if (e.key === "ArrowDown") dy = +step;
        if (nudgeSelectedLayers(dx, dy)) {
          e.preventDefault();
          return;
        }
      }
    }

    // Delete / Backspace で選択中の追加テキストフレームを削除（修飾キーなし）。
    // 入力欄やテキスト編集中（floater の textarea）には介入しない。
    if (
      (e.key === "Delete" || e.key === "Backspace") &&
      !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
    ) {
      const t = e.target;
      const isInput =
        t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (!isInput) {
        if (deleteSelectedLayers()) {
          e.preventDefault();
          return;
        }
      }
    }

    // 履歴系（Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z / Ctrl+Delete）。
    // 環境設定対象外（破壊的でないため固定キー、入力欄でも有効）。
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        if (undo()) { /* listener が UI を更新 */ }
        return;
      }
      if (k === "y" || (k === "z" && e.shiftKey)) {
        e.preventDefault();
        if (redo()) { /* listener が UI を更新 */ }
        return;
      }
      if (e.key === "Delete" || e.code === "Delete") {
        e.preventDefault();
        handleClearAllEdits();
        return;
      }
    }

    // 環境設定でカスタマイズ可能なショートカットの dispatch。
    const id = findShortcutMatch(e);
    if (!id) return;
    if (isShortcutBlockedInInput(id, e.target)) return;
    // ページ移動系のみ auto-repeat スロットル（80ms ≒ 12Hz、OS auto-repeat の 30Hz 由来の暴走を抑制）。
    if (e.repeat && isPageNavShortcut(id) && !canAdvancePageNow()) return;
    e.preventDefault();
    runShortcut(id, e);
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

// ページ変更時の重い再描画 (renderAllSpreads は DOM を全壊して再構築する) を rAF で
// 合流させる。連打や ←/→ の OS auto-repeat で 1 フレーム内に複数のページ index 変更が
// 来ても、最終 index に対して 1 回だけ rebuild する。ラベル更新 (updatePageNav) は
// 軽いので毎回実行して即時反映させる。
let pageChangeRaf = 0;
function schedulePageRender() {
  if (pageChangeRaf) return;
  pageChangeRaf = requestAnimationFrame(() => {
    pageChangeRaf = 0;
    renderAllSpreads();
    rebuildLayerList();
    updatePsdRotateVisibility();
    updatePsdGuidesLockVisibility();
  });
}

function bindPageChange() {
  onPageIndexChange(() => {
    schedulePageRender();
    updatePageNav();
  });
  onPdfPageIndexChange(() => updatePageNav());
  onPdfChange(() => updatePageNav());
  onPdfSplitModeChange(() => updatePageNav());
  onPdfSkipFirstBlankChange(() => updatePageNav());
  onParallelSyncModeChange(() => updatePageNav());
  onActivePaneChange(() => updatePageNav());
}

// サイドツールバー / サイドパネルの折り畳みトグル。localStorage に状態を保存して
// 起動時に復元する（MojiQ Pro の同様 UI に倣う）。
const SIDE_TOOLBAR_COLLAPSED_KEY = "psdesign_side_toolbar_collapsed";
const SIDE_PANEL_COLLAPSED_KEY = "psdesign_side_panel_collapsed";

function applyPanelCollapsed(el, collapsed, btn, expandedTitle, collapsedTitle) {
  if (!el) return;
  el.classList.toggle("collapsed", collapsed);
  if (btn) {
    const t = collapsed ? collapsedTitle : expandedTitle;
    btn.title = t;
    btn.setAttribute("aria-label", t);
    btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
  }
}

function bindPanelToggle(panelEl, btn, storageKey, expandedTitle, collapsedTitle) {
  if (!panelEl || !btn) return;
  let collapsed = false;
  try { collapsed = localStorage.getItem(storageKey) === "1"; } catch (_) {}
  applyPanelCollapsed(panelEl, collapsed, btn, expandedTitle, collapsedTitle);
  btn.addEventListener("click", () => {
    collapsed = !collapsed;
    applyPanelCollapsed(panelEl, collapsed, btn, expandedTitle, collapsedTitle);
    try { localStorage.setItem(storageKey, collapsed ? "1" : "0"); } catch (_) {}
  });
}

function bindCollapseToggles() {
  bindPanelToggle(
    document.querySelector(".side-toolbar"),
    document.getElementById("toggle-side-toolbar-btn"),
    SIDE_TOOLBAR_COLLAPSED_KEY,
    "ツールバーを折り畳む",
    "ツールバーを展開",
  );
  bindPanelToggle(
    document.querySelector(".side-panel"),
    document.getElementById("toggle-side-panel-btn"),
    SIDE_PANEL_COLLAPSED_KEY,
    "サイドバーを折り畳む",
    "サイドバーを展開",
  );
}

// サイドパネル内 3 セクション（原稿テキスト / 編集 / テキストレイヤー）の折り畳み。
// 各 .panel-section[data-section] の h2 内トグルボタンで開閉、状態は localStorage に保存。
const SECTION_COLLAPSED_KEY = "psdesign_panel_section_collapsed";
function loadSectionState() {
  const defaults = { txt: false, editor: false, layers: false };
  try {
    const raw = localStorage.getItem(SECTION_COLLAPSED_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return { ...defaults, ...parsed };
    }
  } catch (_) {}
  return defaults;
}
function saveSectionState(s) {
  try { localStorage.setItem(SECTION_COLLAPSED_KEY, JSON.stringify(s)); } catch (_) {}
}
function bindSectionToggles() {
  const state = loadSectionState();
  for (const id of ["txt", "editor", "layers"]) {
    const sec = document.querySelector(`.panel-section[data-section="${id}"]`);
    const btn = sec?.querySelector(":scope > .panel-section-h2 > .section-toggle-btn");
    if (!sec || !btn) continue;
    const apply = () => {
      sec.classList.toggle("collapsed", !!state[id]);
      const t = state[id] ? "展開" : "折りたたむ";
      btn.title = t;
      btn.setAttribute("aria-label", t);
      btn.setAttribute("aria-expanded", state[id] ? "false" : "true");
    };
    apply();
    btn.addEventListener("click", () => {
      state[id] = !state[id];
      apply();
      saveSectionState(state);
    });
  }
}

// サイドツールバーの上下ボタン（ページ移動）配線 + 表示更新。
function bindPageNav() {
  const prev = document.getElementById("page-prev-btn");
  const next = document.getElementById("page-next-btn");
  if (prev) prev.addEventListener("click", () => advancePage(-1));
  if (next) next.addEventListener("click", () => advancePage(+1));
  updatePageNav();
}

function updatePageNav() {
  const label = document.getElementById("page-nav-label");
  const prev = document.getElementById("page-prev-btn");
  const next = document.getElementById("page-next-btn");
  // ページバー廃止後の現在位置 / 総数表示。advancePage と同じターゲット決定ロジックを採用。
  const psdCount = getPages().length;
  const pdfCount = getPdfVirtualPageCount();
  let total = 0;
  let current = 0;
  if (getParallelSyncMode()) {
    if (psdCount > 0) { total = psdCount; current = getCurrentPageIndex(); }
    else if (pdfCount > 0) { total = pdfCount; current = getPdfPageIndex(); }
  } else if (getActivePane() === "pdf" && pdfCount > 0) {
    total = pdfCount; current = getPdfPageIndex();
  } else if (psdCount > 0) {
    total = psdCount; current = getCurrentPageIndex();
  } else if (pdfCount > 0) {
    total = pdfCount; current = getPdfPageIndex();
  }
  if (label) {
    label.textContent = total > 0 ? `${current + 1} / ${total}` : "– / –";
  }
  const disabled = total === 0;
  if (prev) prev.disabled = disabled || current <= 0;
  if (next) next.disabled = disabled || current >= total - 1;
}

// 矢印キー auto-repeat 時の leading-edge スロットル（80ms = 約 12Hz）。
// 単発タップは throttle 対象外（ハンドラ側で e.repeat 判定して呼び分け）。
const ARROW_REPEAT_THROTTLE_MS = 80;
let lastArrowAdvanceAt = 0;
function canAdvancePageNow() {
  const now = performance.now();
  if (now - lastArrowAdvanceAt < ARROW_REPEAT_THROTTLE_MS) return false;
  lastArrowAdvanceAt = now;
  return true;
}

// ページ送り：同期モードなら両側、非同期ならアクティブペインだけ進める。
// 同期中でも PSD 未読込の場合は PDF を直接駆動する（空の PSD index 経由だと
// setCurrentPageIndex が「pages 0 件 → index 0 固定」で何も起こらないため）。
function advancePage(delta) {
  if (getParallelSyncMode()) {
    if (getPages().length > 0) {
      setCurrentPageIndex(getCurrentPageIndex() + delta);
    } else {
      const vcount = getPdfVirtualPageCount();
      if (vcount === 0) return;
      const clamped = Math.max(0, Math.min(vcount - 1, getPdfPageIndex() + delta));
      setPdfPageIndex(clamped);
    }
    return;
  }
  if (getActivePane() === "pdf") {
    const vcount = getPdfVirtualPageCount();
    const next = getPdfPageIndex() + delta;
    const clamped = Math.max(0, Math.min(Math.max(0, vcount - 1), next));
    setPdfPageIndex(clamped);
  } else {
    setCurrentPageIndex(getCurrentPageIndex() + delta);
  }
}

function jumpToEdge(where) {
  if (getParallelSyncMode()) {
    const psdTotal = getPages().length;
    if (psdTotal > 0) {
      setCurrentPageIndex(where === "first" ? 0 : psdTotal - 1);
      return;
    }
    const vcount = getPdfVirtualPageCount();
    if (vcount === 0) return;
    setPdfPageIndex(where === "first" ? 0 : vcount - 1);
    return;
  }
  if (getActivePane() === "pdf") {
    const vcount = getPdfVirtualPageCount();
    if (vcount === 0) return;
    setPdfPageIndex(where === "first" ? 0 : vcount - 1);
  } else {
    const total = getPages().length;
    if (total === 0) return;
    setCurrentPageIndex(where === "first" ? 0 : total - 1);
  }
}

// 同期モード中は currentPageIndex（PSD）と pdfPageIndex を相互にミラーする。
// 非同期中は各側が独立して動く。再入防止にフラグで一方向の反映に限定。
let syncBridgeBusy = false;
function bindParallelSync() {
  onPageIndexChange((psdIdx) => {
    if (!getParallelSyncMode()) return;
    if (syncBridgeBusy) return;
    if (getPdfPageIndex() === psdIdx) return;
    syncBridgeBusy = true;
    try { setPdfPageIndex(psdIdx); } finally { syncBridgeBusy = false; }
  });
  onPdfPageIndexChange((pdfIdx) => {
    if (!getParallelSyncMode()) return;
    if (syncBridgeBusy) return;
    if (getCurrentPageIndex() === pdfIdx) return;
    syncBridgeBusy = true;
    try { setCurrentPageIndex(pdfIdx); } finally { syncBridgeBusy = false; }
  });
}

function bindActivePaneTracking() {
  const pdfArea = document.getElementById("spreads-pdf-area");
  const psdArea = document.getElementById("spreads-psd-area");
  // 同期/非同期どちらでも activePane は常に追跡（ズーム対象の決定に使う）。
  // リング枠の視覚強調は非同期モードのときだけ。
  pdfArea?.addEventListener("mousedown", () => setActivePane("pdf"), true);
  psdArea?.addEventListener("mousedown", () => setActivePane("psd"), true);
  const apply = () => {
    const asyncMode = !getParallelSyncMode();
    pdfArea?.classList.toggle("active-pane", asyncMode && getActivePane() === "pdf");
    psdArea?.classList.toggle("active-pane", asyncMode && getActivePane() === "psd");
  };
  onParallelSyncModeChange(apply);
  onActivePaneChange(apply);
  apply();
}

// resync モーダル制御
let resyncResolver = null;
function openResyncModal() {
  const modal = document.getElementById("resync-modal");
  if (!modal) return Promise.resolve(null);
  modal.hidden = false;
  return new Promise((resolve) => {
    resyncResolver = resolve;
  });
}
function closeResyncModal(result) {
  const modal = document.getElementById("resync-modal");
  if (modal) modal.hidden = true;
  if (resyncResolver) {
    const r = resyncResolver;
    resyncResolver = null;
    r(result);
  }
}
function bindResyncModal() {
  const modal = document.getElementById("resync-modal");
  const cancel = document.getElementById("resync-cancel");
  const keep = document.getElementById("resync-keep");
  const match = document.getElementById("resync-match");
  if (!modal || !cancel || !keep || !match) return;
  cancel.addEventListener("click", () => closeResyncModal("cancel"));
  keep.addEventListener("click", () => closeResyncModal("keep"));
  match.addEventListener("click", () => closeResyncModal("match"));
  modal.addEventListener("mousedown", (e) => {
    if (e.target === modal) closeResyncModal("cancel");
  });
  document.addEventListener("keydown", (e) => {
    if (modal.hidden) return;
    if (e.key === "Escape") {
      e.preventDefault();
      closeResyncModal("cancel");
    }
  });
}

function bindViewModeControls() {
  const syncOnBtn = document.getElementById("sync-on-btn");
  const syncOffBtn = document.getElementById("sync-off-btn");
  const skipBlankBtn = document.getElementById("skip-first-blank-btn");
  if (!syncOnBtn || !syncOffBtn) return;

  // 先頭白紙ページ除外トグル
  if (skipBlankBtn) {
    const syncSkipUi = () => {
      skipBlankBtn.setAttribute("aria-pressed", getPdfSkipFirstBlank() ? "true" : "false");
    };
    syncSkipUi();
    skipBlankBtn.addEventListener("click", () => {
      // 切替前後で「同じ物理ページ」を維持するため、現在の virtual page の pageNum を保存しておき
      // 切替後にその pageNum に対応する virtual index へ再マップする。
      const cur = getPdfVirtualPageAt(getPdfPageIndex());
      const prevPageNum = cur ? cur.pageNum : null;
      setPdfSkipFirstBlank(!getPdfSkipFirstBlank());
      if (prevPageNum != null) {
        setPdfPageIndex(getPdfVirtualIndexForPhysicalPage(prevPageNum));
      }
    });
    onPdfSkipFirstBlankChange(syncSkipUi);
  }

  // 同期トグル
  syncOnBtn.addEventListener("click", async () => {
    if (getParallelSyncMode()) return;
    const choice = await openResyncModal();
    if (choice === "cancel" || choice == null) return;
    if (choice === "match") {
      // アクティブペイン側の index を非アクティブ側に合わせる。
      const active = getActivePane();
      if (active === "pdf") {
        setCurrentPageIndex(getPdfPageIndex());
      } else {
        setPdfPageIndex(getCurrentPageIndex());
      }
    }
    setParallelSyncMode(true);
  });
  syncOffBtn.addEventListener("click", () => {
    if (!getParallelSyncMode()) return;
    setParallelSyncMode(false);
    setActivePane("psd");
  });

  const syncModeUi = () => {
    const sync = getParallelSyncMode();
    syncOnBtn.classList.toggle("active", sync);
    syncOffBtn.classList.toggle("active", !sync);
    syncOnBtn.setAttribute("aria-pressed", sync ? "true" : "false");
    syncOffBtn.setAttribute("aria-pressed", !sync ? "true" : "false");
  };
  onParallelSyncModeChange(syncModeUi);
  syncModeUi();
}

const VIEW_MODE_LS_KEY = "psdesign_parallel_view_mode";

function bindParallelViewMode() {
  const parallelBtn = document.getElementById("view-parallel-btn");
  const psdOnlyBtn = document.getElementById("view-psd-only-btn");
  const pdfArea = document.getElementById("spreads-pdf-area");
  if (!parallelBtn || !psdOnlyBtn || !pdfArea) return;

  try {
    const saved = localStorage.getItem(VIEW_MODE_LS_KEY);
    if (saved === "parallel" || saved === "psdOnly") setParallelViewMode(saved);
  } catch {}

  parallelBtn.addEventListener("click", () => setParallelViewMode("parallel"));
  psdOnlyBtn.addEventListener("click", () => {
    setParallelViewMode("psdOnly");
    if (getActivePane() === "pdf") setActivePane("psd");
  });

  const sync = () => {
    const mode = getParallelViewMode();
    const isParallel = mode === "parallel";
    pdfArea.toggleAttribute("hidden", !isParallel);
    parallelBtn.classList.toggle("active", isParallel);
    psdOnlyBtn.classList.toggle("active", !isParallel);
    parallelBtn.setAttribute("aria-pressed", isParallel ? "true" : "false");
    psdOnlyBtn.setAttribute("aria-pressed", !isParallel ? "true" : "false");
    try { localStorage.setItem(VIEW_MODE_LS_KEY, mode); } catch {}
  };
  onParallelViewModeChange(sync);
  sync();
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

// 行間を適用。in-place 編集中（editingContext あり）はカーソル行の per-line override に
// 書き込み、そうでなければ従来どおり layer 全体の leadingPct を更新する。
function applyLeading(n) {
  const v = clampLeading(n);
  const ec = getEditingContext();
  if (ec) {
    const targetId = ec.tempId ?? ec.layerId;
    setLineLeading(ec.psdPath, targetId, ec.currentLineIndex ?? 0, v);
    refreshAllOverlays();
    rebuildLayerList();
    syncLeadingInputForEditingContext();
    return;
  }
  setLeadingPct(v);
  if (hasSelection()) commitSelectedLayerField("leadingPct", getLeadingPct());
}
function clampLeading(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return getLeadingPct();
  return Math.max(50, Math.min(500, Math.round(v)));
}
function adjustLeading(delta) {
  const ec = getEditingContext();
  if (ec) {
    const targetId = ec.tempId ?? ec.layerId;
    const cur = getLineLeading(ec.psdPath, targetId, ec.currentLineIndex ?? 0) ?? getLeadingPct();
    applyLeading(cur + delta);
    return;
  }
  applyLeading(getLeadingPct() + delta);
}

// editingContext が active のときは leading-input にカーソル行の値を表示。
// 行ごとの override が無ければレイヤー global の leadingPct を表示する。
function syncLeadingInputForEditingContext() {
  const input = document.getElementById("leading-input");
  if (!input) return;
  const ec = getEditingContext();
  if (!ec) return;
  const targetId = ec.tempId ?? ec.layerId;
  const v = getLineLeading(ec.psdPath, targetId, ec.currentLineIndex ?? 0) ?? getLeadingPct();
  if (document.activeElement !== input) input.value = String(v);
  // ルビトグルも追従
  const onActive = v >= 150;
  const off = document.getElementById("ruby-off-btn");
  const on = document.getElementById("ruby-on-btn");
  if (off) off.classList.toggle("active", !onActive);
  if (on) on.classList.toggle("active", onActive);
  // ターゲット行のラベル更新
  const label = document.getElementById("leading-target-label");
  if (label) {
    label.textContent = `${ec.currentLineIndex + 1}行目`;
    label.hidden = false;
  }
}

function clearLeadingTargetLabel() {
  const label = document.getElementById("leading-target-label");
  if (label) {
    label.hidden = true;
  }
}

function bindLeadingTool() {
  const input = document.getElementById("leading-input");
  const dec = document.getElementById("leading-dec-btn");
  const inc = document.getElementById("leading-inc-btn");
  const rubyOff = document.getElementById("ruby-off-btn");
  const rubyOn = document.getElementById("ruby-on-btn");
  if (!input || !dec || !inc) return;

  input.value = String(getLeadingPct());
  // ルビトグルの active 表示は現在の leading から導出。150 以上で「ルビあり」、
  // それ未満は「ルビなし」を highlight する。手動で 130 のような中間値にしても
  // どちらかが必ず active なので状態が分かりやすい。
  const syncRuby = (v) => {
    const onActive = v >= 150;
    if (rubyOff) rubyOff.classList.toggle("active", !onActive);
    if (rubyOn) rubyOn.classList.toggle("active", onActive);
  };
  onLeadingPctChange((v) => {
    if (document.activeElement !== input) input.value = String(v);
    syncRuby(v);
  });
  syncRuby(getLeadingPct());

  input.addEventListener("input", () => {
    const v = parseInt(input.value, 10);
    if (!Number.isFinite(v)) return;
    applyLeading(v);
  });
  input.addEventListener("blur", () => {
    // editingContext があれば対象行の値を、なければ global を表示。
    const ec = getEditingContext();
    if (ec) {
      const targetId = ec.tempId ?? ec.layerId;
      const v = getLineLeading(ec.psdPath, targetId, ec.currentLineIndex ?? 0) ?? getLeadingPct();
      input.value = String(v);
    } else {
      input.value = String(getLeadingPct());
    }
  });
  // ボタン群は in-place 編集 textarea からのフォーカス移動を抑止する。これがないと
  // + を押すたびに textarea が blur → カーソル行が失われ、editingContext が消える。
  const keepFocus = (el) => el && el.addEventListener("mousedown", (e) => e.preventDefault());
  keepFocus(dec); keepFocus(inc); keepFocus(rubyOff); keepFocus(rubyOn);
  dec.addEventListener("click", () => adjustLeading(-5));
  inc.addEventListener("click", () => adjustLeading(+5));
  if (rubyOff) rubyOff.addEventListener("click", () => applyLeading(125));
  if (rubyOn) rubyOn.addEventListener("click", () => applyLeading(150));

  // in-place 編集の context 変化に追従して input/ボタンの表示を更新。
  // context が立つ → カーソル行の per-line 値（無ければ global）を表示し対象行ラベル ON。
  // context が消える → global 値に戻し、ラベル OFF。
  onEditingContextChange((ec) => {
    if (ec) {
      syncLeadingInputForEditingContext();
    } else {
      clearLeadingTargetLabel();
      input.value = String(getLeadingPct());
      syncRuby(getLeadingPct());
    }
  });
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

// アクティブペイン基準のズーム操作（ボタン・キーボード）
function zoomActivePaneBy(factor) {
  zoomPaneBy(getActivePane(), factor);
}
function resetActivePaneZoom() {
  resetPaneZoom(getActivePane());
}
function zoomPaneBy(pane, factor) {
  if (pane === "pdf") setPdfZoom(getPdfZoom() * factor);
  else setPsdZoom(getPsdZoom() * factor);
}
function resetPaneZoom(pane) {
  if (pane === "pdf") setPdfZoom(1);
  else setPsdZoom(1);
}

// 定規ボタンの click + ON/OFF 表示同期 + Ctrl+R の WebView リロード抑止。
// Ctrl+R は WebView2 の既定リロードに先取りされやすいので、bindZoomTool と同じく
// capture フェーズで matchShortcut("toggleRulers") を判定して preventDefault。
function bindRulerToggle() {
  const btn = document.getElementById("toggle-rulers-btn");
  const sync = () => {
    if (!btn) return;
    const on = getRulersVisible();
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  };
  if (btn) btn.addEventListener("click", () => toggleRulersVisible());
  onRulersVisibleChange(sync);
  sync();

  window.addEventListener(
    "keydown",
    (e) => {
      if (matchShortcut(e, "toggleRulers")) {
        toggleRulersVisible();
        e.preventDefault();
        e.stopPropagation();
      }
    },
    { capture: true },
  );
}

// Ctrl+H はブラウザ既定で履歴を開くため、capture フェーズで preventDefault してから
// テキストフレーム表示をトグル。InDesign 風に「枠装飾だけ消してテキストは残す」ため、
// DOM は再描画せず body のクラスを toggle して CSS で見た目だけ切替える。
function bindFramesToggle() {
  const applyClass = () => {
    document.body.classList.toggle("frames-hidden", !getFramesVisible());
  };
  applyClass();
  onFramesVisibleChange(applyClass);
  window.addEventListener(
    "keydown",
    (e) => {
      if (matchShortcut(e, "toggleFrames")) {
        toggleFramesVisible();
        e.preventDefault();
        e.stopPropagation();
      }
    },
    { capture: true },
  );
}

function bindZoomTool() {
  const out = document.getElementById("zoom-out-btn");
  const inn = document.getElementById("zoom-in-btn");
  const level = document.getElementById("zoom-level-btn");
  const pdfArea = document.getElementById("spreads-pdf-area");
  const psdArea = document.getElementById("spreads-psd-area");
  if (!out || !inn || !level) return;

  const paneLabel = (pane) => (pane === "pdf" ? "PDF" : "PSD");
  const updateLevel = () => {
    const pane = getActivePane();
    const z = pane === "pdf" ? getPdfZoom() : getPsdZoom();
    level.textContent = `${paneLabel(pane)} ${Math.round(z * 100)}%`;
    level.title = `${paneLabel(pane)} を 100% にリセット`;
  };
  updateLevel();
  onPdfZoomChange(updateLevel);
  onPsdZoomChange(updateLevel);
  onActivePaneChange(updateLevel);

  out.addEventListener("click", () => zoomActivePaneBy(1 / 1.15));
  inn.addEventListener("click", () => zoomActivePaneBy(1.15));
  level.addEventListener("click", () => resetActivePaneZoom());

  // Alt+wheel はカーソルが乗っているペインをズーム（active-pane には依存しない方が直感的）。
  const attachWheel = (area, pane) => {
    if (!area) return;
    area.addEventListener(
      "wheel",
      (e) => {
        if (!e.altKey) return;
        e.preventDefault();
        const factor = e.deltaY > 0 ? 1 / 1.1 : 1.1;
        zoomPaneBy(pane, factor);
      },
      { passive: false },
    );
  };
  attachWheel(pdfArea, "pdf");
  attachWheel(psdArea, "psd");

  window.addEventListener(
    "keydown",
    (e) => {
      // ズーム系は WebView2 の既定ページズームに先取りされるため capture フェーズで拾う。
      // 環境設定のキーを matchShortcut で照合してから handle。
      let handled = false;
      if (matchShortcut(e, "zoomIn")) { zoomActivePaneBy(1.15); handled = true; }
      else if (matchShortcut(e, "zoomOut")) { zoomActivePaneBy(1 / 1.15); handled = true; }
      else if (matchShortcut(e, "zoomReset")) { resetActivePaneZoom(); handled = true; }
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    { capture: true },
  );
}

// ページジャンプ対象は activePane を優先し、無効なら片方にフォールバック。
// PDF 側を選んだ場合は仮想ページ番号（単ページ化時は見開き分割後の番号）でジャンプする。
let pageJumpTarget = "psd"; // "psd" | "pdf"

function decidePageJumpTarget() {
  const psdHas = getPages().length > 0;
  const pdfHas = getPdfVirtualPageCount() > 0;
  const preferred = getActivePane();
  if (preferred === "pdf" && pdfHas) {
    return { kind: "pdf", total: getPdfVirtualPageCount(), current: getPdfPageIndex(), label: "PDF" };
  }
  if (preferred === "psd" && psdHas) {
    return { kind: "psd", total: getPages().length, current: getCurrentPageIndex(), label: "PSD" };
  }
  if (psdHas) return { kind: "psd", total: getPages().length, current: getCurrentPageIndex(), label: "PSD" };
  if (pdfHas) return { kind: "pdf", total: getPdfVirtualPageCount(), current: getPdfPageIndex(), label: "PDF" };
  return null;
}

function openPageJumpDialog() {
  const target = decidePageJumpTarget();
  if (!target) {
    toast("ページが読み込まれていません", { kind: "info", duration: 1800 });
    return;
  }
  pageJumpTarget = target.kind;
  const modal = document.getElementById("page-jump-modal");
  const input = document.getElementById("page-jump-input");
  const hint = document.getElementById("page-jump-hint");
  if (!modal || !input) return;
  input.max = String(target.total);
  input.value = String(target.current + 1);
  if (hint) hint.textContent = `${target.label} ページ：1 〜 ${target.total} を入力してください`;
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
    if (pageJumpTarget === "pdf") setPdfPageIndex(v - 1);
    else setCurrentPageIndex(v - 1);
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
  bindHistoryButtons();
  initHamburgerMenu();
  bindTools();
  bindSizeTool();
  bindLeadingTool();
  bindZoomTool();
  bindPageChange();
  bindEditorEvents();
  bindWindowControls();
  bindPageJumpDialog();
  initTxtSource();
  bindAiInstallMenu();
  bindAiOcrButton();
  bindAiPlaceButton();
  bindPageNav();
  bindCollapseToggles();
  bindSectionToggles();
  bindPdfWorkspaceToggle();
  bindPdfRotate();
  bindPsdRotate();
  updatePsdRotateVisibility();
  bindPsdGuidesLock();
  updatePsdGuidesLockVisibility();
  mountPdfView();
  setupTauriDragDrop();
  bindParallelSync();
  bindActivePaneTracking();
  bindResyncModal();
  bindViewModeControls();
  bindParallelViewMode();
  initSettingsUi();
  // 環境設定の「デフォルト」（文字サイズ・行間・フチ太さ・フォント）をツール初期値に反映。
  applyToolDefaults();
  renderAllSpreads();
  loadFontsFromBackend();
  // フォントが非同期で登録されるたびにオーバーレイを再描画して反映。
  onFontsRegistered(() => refreshAllOverlays());
  bindGlobalBlurOnOutsideClick();
  initRulers();
  bindRulerToggle();
  bindFramesToggle();
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
    // editor パネル内のクリックも安全ゾーンに含める。in-place 編集 textarea が active な
    // ときに行間 input / +/- / ルビボタンを触っても勝手に textarea が blur しないようにする。
    const near = target.closest?.("input, textarea, [contenteditable], .font-combobox, .save-menu, .text-input-floater, .editor");
    if (near) return;
    active.blur();
  }, true);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
