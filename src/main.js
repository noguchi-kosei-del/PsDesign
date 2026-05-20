import { buildReferencePageCards, countReferencePages, loadReferenceFiles, pickReferenceFiles } from "./pdf-loader.js";
import { getVersion } from "@tauri-apps/api/app";
import packageInfo from "../package.json";
import { mountPdfView } from "./pdf-view.js";
import {
  cycleLayerSelection,
  deleteSelectedLayers,
  commitActiveInPlaceEdit,
  nudgeSelectedLayers,
  refreshAllOverlays,
  snapNextSize,
  // 【v1.16.0】in-place 編雁Etextarea 上�E斁E��選択キャチE��ュ
  getLastInplaceSelection,
  onInplaceSelectionChange,
  // 【v1.21.0】per-char サイズ・フォント変更時�E編雁E�� DOM リアルタイム反映
  applyEditModeStyleToRange,
  restoreInplaceSelection,
  // 【v1.26.0】ルビ予定インジケータの編雁E�� DOM 反映
  applyEditModeRubyToRange,
  getExistingLayerEffectiveSizePt,
} from "./canvas-tools.js";
import { onFontsRegistered } from "./font-loader.js";
import { renderAllSpreads } from "./spread-view.js";
import {
  bindEditorEvents,
  commitBoldToSelections,
  commitLeadingToSelections,
  commitSelectedLayerField,
  commitSizeToSelections,
  computeCommonBold,
  hasSelection,
  rebuildLayerList,
  syncBoldToggle,
  unifySelectedTextSize,
} from "./text-editor.js";
import { cycleTxtBlockSelection, deleteSelectedTxtBlock, getTxtPageCount, initTxtSource, loadTxtFromPath, pickTxtPath } from "./txt-source.js";
import { bindAiInstallMenu } from "./ai-install.js";
import { bindFirstRunSetup, maybeShowFirstRunSetup } from "./first-run-setup.js";
import { bindAiOcrButton, PLACE_ICON_SVG, runAiOcrForTranscription } from "./ai-ocr.js";
import { bindAiPlaceButton, bindPositionAdjustButton, runAutoPlace } from "./ai-place.js";
import { bindViewerMode, toggleViewerMode } from "./viewer-mode.js";
import { bindAutoUpdater } from "./auto-updater.js";
import { bindProofreadUi, openProofread } from "./proofread.js";
import { initHamburgerMenu } from "./hamburger-menu.js";
import { bindStylePalette } from "./style-palette.js";
import { initFontBookPanel } from "./font-book.js";
import {
  confirmDialog,
  hideModalAnimated,
  hideProgress,
  notifyDialog,
  showModalAnimated,
  showProgress,
  toast,
} from "./ui-feedback.js";
import {
  bindSaveMenu,
  handleOverwriteSave,
  handleSaveAs,
  setHasSavedThisSession,
  updateSaveButton,
} from "./bind/save.js";
import { bindEditorPane, focusEditor } from "./bind/editor-pane.js";
import {
  handleOpenFiles,
  listPsdFilesInFolder,
  loadPsdFilesByPaths,
  pickPsdFiles,
} from "./services/psd-load.js";
import {
  findShortcutMatch,
  getArrowKeyMoveDistance,
  getDefault,
  getPageDirectionInverted,
  getShortcut,
  matchShortcut,
  onSettingsChange,
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
  hasAnyGuide,
  onGuidesChange,
  applyGuidesToPaths,
  clearGuidesForPaths,
  guidesMatchCurrent,
} from "./rulers.js";
import {
  addPage,
  canRedo,
  canUndo,
  clearAllEdits,
  clearAiOcrDoc,
  clearPages,
  getActivePane,
  getCurrentPageIndex,
  getNewLayersForPsd,
  getPages,
  getParallelSyncMode,
  getParallelViewMode,
  getPdfDoc,
  getPdfPageIndex,
  getPdfRotation,
  getPdfSkipFirstBlank,
  getPdfZoom,
  getPsdRotation,
  getPsdZoom,
  getTextSize,
  getTool,
  getTxtSource,
  hasEdits,
  getEditorLeftPaneMode,
  setEditorLeftPaneMode,
  onEditorLeftPaneModeChange,
  onActivePaneChange,
  onHistoryChange,
  onPageIndexChange,
  onParallelSyncModeChange,
  onParallelViewModeChange,
  onPdfChange,
  onPdfPageIndexChange,
  onPdfRotationChange,
  onPdfSkipFirstBlankChange,
  onPdfSplitModeChange,
  onPdfZoomChange,
  onPsdZoomChange,
  onTextSizeChange,
  onToolChange,
  onTxtSourceChange,
  setActivePane,
  setCurrentPageIndex,
  setFonts,
  setParallelSyncMode,
  setParallelViewMode,
  setPdfPageIndex,
  setSelectedLayers,
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
  // 【v1.16.0】per-char サイズ
  setCharSizesRange,
  // 【v1.22.0】per-char 合�E太孁E
  setCharBoldsRange,
  // 【v1.26.0】per-char ルチE
  setCharRubiesRange,
  getCharRubyAt,
  rangeHasAnyRuby,
  withHistoryTransient,
  getEdit,
  getSelectedLayers,
  getNewTextDirection,
  setNewTextDirection,
  onNewTextDirectionChange,
  applyToolDefaults,
} from "./state.js";
import {
  getPdfVirtualIndexForPhysicalPage,
  getPdfVirtualPageAt,
  getPdfVirtualPageCount,
} from "./pdf-pages.js";

let homeTypesetDropHandler = null;
let homeTypesetDragOverHandler = null;
let homeTypesetDragLeaveHandler = null;

async function handleOpenPdf() {
  const paths = await pickReferenceFiles();
  if (!paths.length) return;
  await loadReferenceFiles(paths);
}

function bindPdfWorkspaceToggle() {
  // PDF エリアは常時表示�E�未読込時�E empty state を見せる）、E
  // 回転ボタンも常時表示し、doc 未読込時�E disabled でグレーアウト、E
  const rotateBtn = document.getElementById("pdf-rotate-btn");
  const apply = (doc) => {
    if (rotateBtn) rotateBtn.disabled = !doc;
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
  btn.disabled = getPages().length === 0;
}

function bindPsdGuidesLock() {
  const btn = document.getElementById("psd-guides-lock-btn");
  if (!btn) return;
  const syncPressed = () => {
    const locked = getGuidesLocked();
    btn.setAttribute("aria-pressed", locked ? "true" : "false");
    btn.title = locked ? "ガイドのロック解除" : "ガイドをロック";
    btn.setAttribute("aria-label", btn.title);
  };
  // PSD 未読込 or ガイドが 1 本も無ぁE��合�E disabled でグレーアウト、E
  // 表示/非表示はルーラー ON/OFF のみで制御�E�読込前でもバー上にボタンは出す）、E
  const syncDisabled = () => {
    btn.disabled = getPages().length === 0 || !hasAnyGuide();
  };
  btn.addEventListener("click", () => toggleGuidesLocked());
  onGuidesLockedChange(syncPressed);
  onGuidesChange(syncDisabled);
  onPageIndexChange(syncDisabled); // ペ�Eジ刁E��で対象 PSD のガイド有無が変わめE
  syncPressed();
  syncDisabled();
  // ルーラー OFF のときだけ完�E非表示�E�機�Eトグル�E�。読込前�E disabled で見せる、E
  const updateVis = () => {
    btn.hidden = !getRulersVisible();
  };
  onRulersVisibleChange(updateVis);
  updateVis();
}

// ガイドロチE��ボタンの「ファイル読込みあり」条件 + ガイド有無を、PSD ローチEクリア時に同期、E
function updatePsdGuidesLockVisibility() {
  const btn = document.getElementById("psd-guides-lock-btn");
  if (!btn) return;
  btn.hidden = !getRulersVisible();
  btn.disabled = getPages().length === 0 || !hasAnyGuide();
}

// 「ガイドを褁E��反映」�Eタン: ロチE��ボタンと同じぁEルーラー ON + PSD 読込渁Eで可視、E
// ただし反映先が無ぁE��意味が無ぁE�Eで PSD ぁE2 ペ�Eジ以上忁E��、E
// また「現在のガイドが確定してぁE��」ことを示すためロチE��中でなぁE��無効にする
// �E�ロチE��剁E= 編雁E��なので、まだ反映を取らなぁE��ぁEUX として安�E�E�、E
function bindPsdGuidesApply() {
  const btn = document.getElementById("psd-guides-apply-btn");
  if (!btn) return;
  btn.addEventListener("click", openGuidesApplyModal);
  const sync = () => updatePsdGuidesApplyVisibility();
  onRulersVisibleChange(sync);
  onGuidesChange(sync);
  onPageIndexChange(sync);
  onGuidesLockedChange(sync);
  sync();
}
function updatePsdGuidesApplyVisibility() {
  const btn = document.getElementById("psd-guides-apply-btn");
  if (!btn) return;
  // ルーラー OFF のときだけ完�E非表示�E�機�Eトグル�E�。読込剁E/ 1 ペ�Eジしか無ぁE��合�E disabled で見せる、E
  btn.hidden = !getRulersVisible();
  // 有効条件: PSD 2 ペ�Eジ以丁E+ 現ペ�EジにガイドあめE+ ガイドロチE��中、E
  const pageCount = getPages().length;
  const tooFewPages = pageCount < 2;
  const noGuides = !hasAnyGuide();
  const notLocked = !getGuidesLocked();
  btn.disabled = tooFewPages || noGuides || notLocked;
  btn.title = pageCount === 0
    ? "PSD を読み込んでください"
    : (tooFewPages
      ? "反映先のページがありません"
      : (noGuides
        ? "現在のページにガイドが引かれていません"
        : (notLocked
          ? "ガイドをロックすると反映できます"
          : "ガイドを複数ページに反映")));
  btn.setAttribute("aria-label", btn.title);
}

function openGuidesApplyModal() {
  const modal = document.getElementById("guides-apply-modal");
  const list = document.getElementById("guides-apply-list");
  const okBtn = document.getElementById("guides-apply-ok");
  const unapplyBtn = document.getElementById("guides-apply-unapply");
  const cancelBtn = document.getElementById("guides-apply-cancel");
  const selAllBtn = document.getElementById("guides-apply-select-all");
  const selNoneBtn = document.getElementById("guides-apply-select-none");
  if (!modal || !list || !okBtn || !cancelBtn) return;

  const pages = getPages();
  const currentIdx = getCurrentPageIndex();
  list.innerHTML = "";
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const isCurrent = i === currentIdx;
    // 反映済み: 現ペ�Eジとガイドが完�E一致、E
    // ガイドあめE 何らか�Eガイドを持つが現ペ�Eジと一致しなぁE��E
    // 解除を後から行えるよぁE��現ペ�Eジ以外�E全て選択可能にする�E�Eisabled は外す�E�、E
    const alreadyApplied = !isCurrent && guidesMatchCurrent(page?.path);
    const otherHasGuides = !isCurrent && !alreadyApplied && hasAnyGuide(page?.path);
    const label = document.createElement("label");
    label.className = "guides-apply-item"
      + (isCurrent ? " guides-apply-item-current" : "")
      + (alreadyApplied ? " guides-apply-item-applied" : "");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.dataset.index = String(i);
    cb.dataset.hasGuides = (alreadyApplied || otherHasGuides) ? "1" : "0";
    // 現ペ�EジもチェチE��可能にしておく�E��E選択に含めるため�E�、E
    // 実際の反映 / 解除は rulers.js 側で path === srcPath を弾く�Eで二重防止、E
    const span = document.createElement("span");
    span.className = "guides-apply-item-name";
    const m = (page?.path ?? "").match(/[\\/]([^\\/]+)$/);
    const name = m ? m[1] : (page?.path ?? `ページ ${i + 1}`);
    let suffix = "";
    if (isCurrent) suffix = "（現在のページ）";
    else if (alreadyApplied) suffix = "（反映済み）";
    else if (otherHasGuides) suffix = "（ガイドあり）";
    span.textContent = `${i + 1}: ${name}${suffix}`;
    label.appendChild(cb);
    label.appendChild(span);
    list.appendChild(label);
  }

  showModalAnimated(modal);

  const cleanup = () => {
    hideModalAnimated(modal);
    okBtn.removeEventListener("click", onOk);
    unapplyBtn?.removeEventListener("click", onUnapply);
    cancelBtn.removeEventListener("click", onCancel);
    selAllBtn?.removeEventListener("click", onSelAll);
    selNoneBtn?.removeEventListener("click", onSelNone);
    modal.removeEventListener("mousedown", onOverlay);
    document.removeEventListener("keydown", onKey);
  };
  const collectSelectedPaths = (filterFn) => {
    const out = [];
    list.querySelectorAll("input[type=checkbox]:not(:disabled):checked").forEach((cb) => {
      if (filterFn && !filterFn(cb)) return;
      const idx = Number(cb.dataset.index);
      if (Number.isFinite(idx) && pages[idx]?.path) out.push(pages[idx].path);
    });
    return out;
  };
  const onOk = () => {
    const targetPaths = collectSelectedPaths();
    cleanup();
    if (targetPaths.length === 0) return;
    const count = applyGuidesToPaths(targetPaths);
    if (count > 0) toast(`${count} ページにガイドを反映しました`, { kind: "success" });
  };
  const onUnapply = () => {
    // 解除はガイドを持つペ�Eジのみ意味がある、E
    // ガイド�EなぁE�Eージが混ざってぁE��めErulers 側で no-op になるが、E
    // ユーザーには「N ペ�Eジのガイドを解除しました」と実際に解除した数だけ通知する、E
    const targetPaths = collectSelectedPaths((cb) => cb.dataset.hasGuides === "1");
    cleanup();
    if (targetPaths.length === 0) return;
    const count = clearGuidesForPaths(targetPaths);
    if (count > 0) toast(`${count} ページのガイドを解除しました`, { kind: "success" });
  };
  const onCancel = () => cleanup();
  const onOverlay = (e) => { if (e.target === modal) cleanup(); };
  const onSelAll = () => list.querySelectorAll("input[type=checkbox]").forEach((cb) => { cb.checked = true; });
  const onSelNone = () => list.querySelectorAll("input[type=checkbox]").forEach((cb) => { cb.checked = false; });
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); cleanup(); }
    else if (e.key === "Enter") { e.preventDefault(); onOk(); }
  };

  okBtn.addEventListener("click", onOk);
  unapplyBtn?.addEventListener("click", onUnapply);
  cancelBtn.addEventListener("click", onCancel);
  selAllBtn?.addEventListener("click", onSelAll);
  selNoneBtn?.addEventListener("click", onSelNone);
  modal.addEventListener("mousedown", onOverlay);
  document.addEventListener("keydown", onKey);
}

async function loadFontsFromBackend() {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const fonts = await invoke("list_fonts");
    setFonts(fonts);
    window.dispatchEvent(new CustomEvent("psdesign:fonts-loaded"));
  } catch (e) {
    console.warn("フォント一覧の取得に失敁E", e);
  }
}

let panPreviousTool = null;
let panSpaceActive = false;

// 環墁E��定経由でカスタマイズされたショートカチE�� ID を実際のアクションに dispatch、E
// pagePrev / pageNext / pageFirst / pageLast はペ�Eジ送り反転設宁E(settings.js) に従って
// 進行方向を入替える。！E∁Eボタン・サイドバーボタンは反転対象外（物琁E��印キーのみ反転�E�、E
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
    case "zoomIn":     zoomActivePaneBy(1.15); break;
    case "zoomOut":    zoomActivePaneBy(1 / 1.15); break;
    case "zoomReset":  resetActivePaneZoom(); break;
    case "sizeUp":     stepTextSize(+1, Math.max(1, Math.round(2 / getSizeStep()))); break;
    case "sizeDown":   stepTextSize(-1, Math.max(1, Math.round(2 / getSizeStep()))); break;
    case "toggleRulers": toggleRulersVisible(); break;
    case "viewerMode":   toggleViewerMode(); break;
  }
}

// 入力欁E(INPUT/TEXTAREA/contenteditable) 冁E��は発火させたくなぁE��ョートカチE��判定、E
// 規則�E�修飾キーなぁEor 矢印キー使用 ↁE入力欁E��は無効、Etrl+S 等�E入力欁E��も有効を維持、E
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

// Undo / Redo / 全削除 ボタン群を�E線、E
// 状態！Eisabled�E��E onHistoryChange / onPdfChange... ではなぁEstate.history の
// 変動と pages 刁E��に追従させたぁE�Eで、updateHistoryButtons を�E通呼び出しにする、E
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
  // 履歴の変更�E�Eush / undo / redo / baseline reset�E�に追従して disabled と再描画を更新、E
  onHistoryChange(() => {
    updateHistoryButtons();
    refreshAllOverlays();
    rebuildLayerList();
  });
  updateHistoryButtons();
}

// undo / redo は state を書換えるだけなので、UI は onHistoryChange listener が受ける、E
// ここでは listener を介さなぁE��路向けに用意（現状未使用、封E��のため安�E側�E�、E
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
    // Space 長押しで一時的に pan 化してぁE��とき�E、直前ツールを選択中として表示し続けめE
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

  // 現在ペ�Eジの全チE��ストフレーム (既存レイヤー + 新規レイヤー) を選択する、E
  // Ctrl+A 経由で呼ばれる。PSD 未読込時�E no-op、E
  const selectAllTextFramesOnCurrentPage = () => {
    const pages = getPages();
    if (pages.length === 0) return;
    const idx = Math.max(0, Math.min(pages.length - 1, getCurrentPageIndex()));
    const page = pages[idx];
    const selections = [];
    for (const layer of page.textLayers ?? []) {
      selections.push({ pageIndex: idx, layerId: layer.id });
    }
    for (const nl of getNewLayersForPsd(page.path)) {
      selections.push({ pageIndex: idx, layerId: nl.tempId });
    }
    if (selections.length === 0) return;
    setSelectedLayers(selections);
    rebuildLayerList();
    refreshAllOverlays();
  };

  // サイドツールバ�Eの「�E選択」�Eタン (パンチE�Eルとレイヤーボタンの閁E、E
  // Ctrl+A と同じく現在ペ�Eジの全チE��ストフレーム (既孁E+ 新要E を選択する、E
  const selectAllBtn = document.getElementById("select-all-btn");
  if (selectAllBtn) {
    selectAllBtn.addEventListener("click", (e) => {
      e.preventDefault();
      selectAllTextFramesOnCurrentPage();
    });
  }

  const unifyTextSizeBtn = document.getElementById("unify-text-size-btn");
  if (unifyTextSizeBtn) {
    unifyTextSizeBtn.addEventListener("click", (e) => {
      e.preventDefault();
      if (!hasSelection()) {
        toast("サイズを統一するテキストを選択してください", { kind: "info", duration: 2400 });
        return;
      }
      const defaultSize = Number(getDefault("textSize"));
      const changed = unifySelectedTextSize(defaultSize);
      if (!changed && !hasSelection()) {
        toast("サイズを統一するテキストを2つ以上選択してください", { kind: "info", duration: 2400 });
      }
    });
  }

  // Alt 単独押丁E離上で Windows のシスチE��メニューが活性化し、次の Space で開いてしまぁE
  // 事故を防ぐ、Elt+wheel でズームした直後に Space を押すと左上にメニューが�Eる現象の対策、E
  const suppressAltMenuActivation = (e) => {
    if (e.key === "Alt" || e.code === "AltLeft" || e.code === "AltRight") {
      e.preventDefault();
    }
  };
  window.addEventListener("keydown", suppressAltMenuActivation);
  window.addEventListener("keyup", suppressAltMenuActivation);

  window.addEventListener("keydown", (e) => {
    // Space は環墁E��定対象外（パン一時�E替の特殊挙動を保つ�E�、E
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

    // 矢印キー:
    //   - Alt+ↁEↁE: 原稿チE��スチE(txt-source-viewer) の選択ブロチE��を頁E��り / 送E��り
    //   - チE��スト�EチE��ス選択あめE 全 4 方向で位置をナチE�� (設定値 / Shift で 10倁E
    //   - レイヤー選択なぁE+ ↁEↁE 現ペ�Eジ冁E�Eレイヤー選択を頁E��り / 送E��り (cycleLayerSelection)
    //   - レイヤー選択なぁE+ ↁEↁE 下�EショートカチE�� dispatch に流して pagePrev/pageNext (ペ�Eジ移勁E
    const isArrowKey =
      e.key === "ArrowLeft" || e.key === "ArrowRight" ||
      e.key === "ArrowUp" || e.key === "ArrowDown";

    // Alt+ↁEↁEで原稿チE��ストブロチE��選択を刁E�� (V チE�Eル限宁E+ 入力欁E��E、E
    // Alt+ↁEↁEは無効 (封E��何かにバインドする可能性のため未使用にしておく)、E
    if (isArrowKey && e.altKey && !e.ctrlKey && !e.metaKey) {
      const t = e.target;
      const isInput = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (!isInput && getTool() === "move" && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        const delta = e.key === "ArrowDown" ? +1 : -1;
        cycleTxtBlockSelection(delta);
        e.preventDefault();
        return;
      }
    }

    if (isArrowKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const t = e.target;
      const isInput = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (!isInput) {
        const hasSel = getSelectedLayers().length > 0;
        if (hasSel) {
          const baseMove = getArrowKeyMoveDistance();
          const step = e.shiftKey ? baseMove * 10 : baseMove;
          let dx = 0, dy = 0;
          if (e.key === "ArrowLeft") dx = -step;
          else if (e.key === "ArrowRight") dx = +step;
          else if (e.key === "ArrowUp") dy = -step;
          else if (e.key === "ArrowDown") dy = +step;
          if (nudgeSelectedLayers(dx, dy)) {
            e.preventDefault();
            return;
          }
        } else if (getTool() === "move" && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
          // 選択なぁE+ ↁEↁE レイヤー選択サイクル (先頭 / 末尾を選ぶ)
          const delta = e.key === "ArrowDown" ? +1 : -1;
          cycleLayerSelection(delta);
          e.preventDefault();
          return;
        }
        // 選択なぁE+ ↁEↁE nudge せず page nav (pagePrev/pageNext) へ素通し、E
      }
    }

    // Delete / Backspace で選択中のも�Eを削除�E�修飾キーなし）、E
    // 入力欁E��チE��スト編雁E���E�Eloater の textarea�E�には介�EしなぁE��E
    // 優先頁E 原稿チE��ストブロチE�� ↁE追加チE��ストフレーム
    if (
      (e.key === "Delete" || e.key === "Backspace") &&
      !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
    ) {
      const t = e.target;
      const isInput =
        t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (!isInput) {
        if (deleteSelectedTxtBlock()) {
          e.preventDefault();
          return;
        }
        if (deleteSelectedLayers()) {
          e.preventDefault();
          return;
        }
      }
    }

    // 履歴系�E�Etrl+Z / Ctrl+Y / Ctrl+Shift+Z / Ctrl+Delete�E�、E
    // 環墁E��定対象外（破壊的でなぁE��め固定キー、�E力欁E��も有効�E�、E
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        if (undo()) { /* listener ぁEUI を更新 */ }
        return;
      }
      if (k === "y" || (k === "z" && e.shiftKey)) {
        e.preventDefault();
        if (redo()) { /* listener ぁEUI を更新 */ }
        return;
      }
      if (e.key === "Delete" || e.code === "Delete") {
        e.preventDefault();
        handleClearAllEdits();
        return;
      }
      // Ctrl+A: 入力欁Econtenteditable 冁E��は通常の「フィールド�EチE��スト�E選択」を
      // 維持。それ以外では現在ペ�Eジの全チE��ストフレーム (既孁E+ 新要E を選択する、E
      // ブラウザ既定�E「�Eージ全体テキスト選択」�E preventDefault で抑止、E
      if (k === "a" && !e.shiftKey) {
        const t = e.target;
        const isInput = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
        if (!isInput) {
          e.preventDefault();
          selectAllTextFramesOnCurrentPage();
          return;
        }
      }
    }

    // 環墁E��定でカスタマイズ可能なショートカチE��の dispatch、E
    const id = findShortcutMatch(e);
    if (!id) return;
    if (isShortcutBlockedInInput(id, e.target)) return;
    // ペ�Eジ移動系のみ auto-repeat スロチE��ル�E�E0ms ≁E12Hz、OS auto-repeat の 30Hz 由来の暴走を抑制�E�、E
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

// ペ�Eジ変更時�E重い再描画 (renderAllSpreads は DOM を�E壊して再構築すめE めErAF で
// 合流させる。連打や ↁEↁEの OS auto-repeat で 1 フレーム冁E��褁E��のペ�Eジ index 変更ぁE
// 来ても、最絁Eindex に対して 1 回だぁErebuild する。ラベル更新 (updatePageNav) は
// 軽ぁE�Eで毎回実行して即時反映させる、E
let pageChangeRaf = 0;
function schedulePageRender() {
  if (pageChangeRaf) return;
  pageChangeRaf = requestAnimationFrame(() => {
    pageChangeRaf = 0;
    commitActiveInPlaceEdit();
    renderAllSpreads();
    rebuildLayerList();
    updatePsdRotateVisibility();
    updatePsdGuidesLockVisibility();
    updatePsdGuidesApplyVisibility();
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
  // TXT 単体運用時�E TXT のマ�Eカー数が�Eージ総数になる�Eで、TXT の読込/クリアでめE
  // ナビ表示を更新する。さらに新 TXT のペ�Eジ数が現在 index を下回ったら 0 にクランプ、E
  onTxtSourceChange(() => {
    if (getPages().length === 0 && getPdfVirtualPageCount() === 0) {
      const total = getTxtPageCount();
      if (total > 0 && getPdfPageIndex() > total - 1) setPdfPageIndex(0);
    }
    updatePageNav();
  });
}

// サイドツールバ�E / サイドパネルの折り畳みトグル。localStorage に状態を保存して
// 起動時に復允E��る！EojiQ Pro の同槁EUI に倣ぁE��、E
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

// サイドパネル先頭の排他タブ（原稿チE��スチE/ チE��スト編雁E��、E
// active なタブ�E panel-section だけ表示し、他�E hidden。状態�E localStorage に保存、E
const SIDE_PANEL_TAB_KEY = "psdesign_side_panel_tab";
function loadSidePanelTab() {
  try {
    const v = localStorage.getItem(SIDE_PANEL_TAB_KEY);
    if (v === "txt" || v === "editor" || v === "font-book") return v;
  } catch (_) {}
  return "txt";
}
function hasTextForEditorTab() {
  const source = getTxtSource();
  return !!String(source?.content ?? "").trim();
}
function syncTextEditorTabLock() {
  const locked = !hasTextForEditorTab();
  const tab = document.getElementById("side-panel-tab-editor");
  if (tab) {
    tab.disabled = locked;
    tab.classList.toggle("locked", locked);
    tab.setAttribute("aria-disabled", locked ? "true" : "false");
    tab.title = locked ? "テキスト生成後に編集できます" : "";
    if (locked && tab.classList.contains("active")) setSidePanelTab("txt");
  }
  for (const btn of [
    document.getElementById("select-all-btn"),
    document.getElementById("layers-toggle-btn"),
  ]) {
    if (!btn) continue;
    if (!btn.dataset.unlockedTitle) btn.dataset.unlockedTitle = btn.title || "";
    btn.disabled = locked;
    btn.classList.toggle("locked", locked);
    btn.setAttribute("aria-disabled", locked ? "true" : "false");
    btn.title = locked ? "テキスト生成後に使用できます" : btn.dataset.unlockedTitle;
  }
  if (locked) closeLayersDrawer();
}
function setSidePanelTab(tab) {
  if (tab === "editor" && !hasTextForEditorTab()) tab = "txt";
  for (const btn of document.querySelectorAll(".side-panel-tab")) {
    const isActive = btn.dataset.tab === tab;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-selected", isActive ? "true" : "false");
  }
  for (const sec of document.querySelectorAll(".side-panel .panel-section")) {
    sec.hidden = sec.dataset.section !== tab;
  }
  if (tab === "font-book") {
    window.dispatchEvent(new CustomEvent("opus:font-book-visible"));
  }
  try { localStorage.setItem(SIDE_PANEL_TAB_KEY, tab); } catch (_) {}
}
function bindSidePanelTabs() {
  const tabs = document.querySelectorAll(".side-panel-tab");
  if (!tabs.length) return;
  for (const btn of tabs) {
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      setSidePanelTab(btn.dataset.tab);
    });
  }
  onTxtSourceChange(syncTextEditorTabLock);
  syncTextEditorTabLock();
  setSidePanelTab(loadSidePanelTab());
}

// レイヤードロワー�E�サイドツールバ�Eの #layers-toggle-btn から横�E�左方向）スライドで開閉、E
// MojiQ の「指示チE�Eル / 斁E��サイズ」ドロチE�Eダウンと同じシンプルパターン:
// .open クラスのトグルだけで opacity / transform の transition を発火させる、E
// visibility / hidden 属性は使わず、display は常に flex 固定！ESS transition ぁE
// 両方向で確実に走るよぁE��する�E�。永続化なし（毎セチE��ョン closed で起動）、E
function isLayersDrawerOpen() {
  return !!document.getElementById("layers-drawer")?.classList.contains("open");
}
function openLayersDrawer() {
  const drawer = document.getElementById("layers-drawer");
  const btn = document.getElementById("layers-toggle-btn");
  if (!drawer) return;
  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
  if (btn) btn.setAttribute("aria-expanded", "true");
}
function closeLayersDrawer() {
  const drawer = document.getElementById("layers-drawer");
  const btn = document.getElementById("layers-toggle-btn");
  if (!drawer) return;
  drawer.classList.remove("open");
  drawer.setAttribute("aria-hidden", "true");
  if (btn) btn.setAttribute("aria-expanded", "false");
}
function toggleLayersDrawer() {
  if (isLayersDrawerOpen()) closeLayersDrawer();
  else openLayersDrawer();
}
function bindLayersDrawer() {
  const btn = document.getElementById("layers-toggle-btn");
  if (btn) {
    btn.addEventListener("click", (e) => {
      // ドキュメントレベルの outside-click ハンドラに伝播させなぁE��E
      e.stopPropagation();
      toggleLayersDrawer();
    });
  }
  const closeBtn = document.getElementById("layers-drawer-close-btn");
  if (closeBtn) closeBtn.addEventListener("click", closeLayersDrawer);
  // 外�EクリチE��で閉じる、E
  // ボタン自身のクリチE��は stopPropagation で除外、ドロワー冁E�EクリチE��は
  // drawer.contains で除外。両老E��めE.side-toolbar 直下に配置されてぁE��ので、E
  // 個別に contains 判定する、E
  document.addEventListener("mousedown", (e) => {
    if (!isLayersDrawerOpen()) return;
    const drawer = document.getElementById("layers-drawer");
    const triggerBtn = document.getElementById("layers-toggle-btn");
    if (drawer && drawer.contains(e.target)) return;
    if (triggerBtn && triggerBtn.contains(e.target)) return;
    closeLayersDrawer();
  });
  // Esc で閉じる（他�Eモーダル類�E自前で Esc めEstopPropagation する設計�Eため安�E�E�、E
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isLayersDrawerOpen()) {
      closeLayersDrawer();
    }
  });
}

// サイドツールバ�Eの上下�Eタン�E��Eージ移動）�E緁E+ 表示更新、E
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
  // advancePage と同じターゲチE��決定ロジチE��。PSD/PDF とも無ければ TXT マ�Eカーへフォールバック、E
  const psdCount = getPages().length;
  const pdfCount = getPdfVirtualPageCount();
  const txtCount = getTxtPageCount();
  let total = 0;
  let current = 0;
  if (getParallelSyncMode()) {
    if (psdCount > 0) { total = psdCount; current = getCurrentPageIndex(); }
    else if (pdfCount > 0) { total = pdfCount; current = getPdfPageIndex(); }
    else if (txtCount > 0) { total = txtCount; current = getPdfPageIndex(); }
  } else if (getActivePane() === "pdf" && pdfCount > 0) {
    total = pdfCount; current = getPdfPageIndex();
  } else if (psdCount > 0) {
    total = psdCount; current = getCurrentPageIndex();
  } else if (pdfCount > 0) {
    total = pdfCount; current = getPdfPageIndex();
  } else if (txtCount > 0) {
    total = txtCount; current = getPdfPageIndex();
  }
  if (label) {
    label.textContent = total > 0 ? `${current + 1} / ${total}` : "- / -";
  }
  const disabled = total === 0;
  if (prev) prev.disabled = disabled || current <= 0;
  if (next) next.disabled = disabled || current >= total - 1;
}

// 矢印キー auto-repeat 時�E leading-edge スロチE��ル�E�E0ms = 紁E12Hz�E�、E
// 単発タチE�Eは throttle 対象外（ハンドラ側で e.repeat 判定して呼び刁E���E�、E
const ARROW_REPEAT_THROTTLE_MS = 80;
let lastArrowAdvanceAt = 0;
function canAdvancePageNow() {
  const now = performance.now();
  if (now - lastArrowAdvanceAt < ARROW_REPEAT_THROTTLE_MS) return false;
  lastArrowAdvanceAt = now;
  return true;
}

// 「現在ペ�Eジ」�Eソースを判定して { source, total, current } を返す、E
// 優先頁E PSD pages ↁEPDF 仮想ペ�Eジ ↁETXT マ�Eカーペ�Eジ。null = どれも無し、E
// TXT 単体運用時�E pdfPageIndex を「閲覧中ペ�Eジ index」として流用する設計、E
export function activePageSource() {
  const psd = getPages().length;
  if (psd > 0) return { source: "psd", total: psd, current: getCurrentPageIndex() };
  const pdf = getPdfVirtualPageCount();
  if (pdf > 0) return { source: "pdf", total: pdf, current: getPdfPageIndex() };
  const txt = getTxtPageCount();
  if (txt > 0) return { source: "txt", total: txt, current: getPdfPageIndex() };
  return null;
}

function setActivePageIndex(source, idx) {
  if (source === "psd") setCurrentPageIndex(idx);
  else setPdfPageIndex(idx); // pdf / txt はどちらも pdfPageIndex 駁E��
}

// ペ�Eジ送り�E�同期モードなら両側、E��同期ならアクチE��ブ�Eインだけ進める、E
// 同期中でめEPSD 未読込の場合�E PDF を直接駁E��する�E�空の PSD index 経由だと
// setCurrentPageIndex が「pages 0 件 ↁEindex 0 固定」で何も起こらなぁE��めE��、E
// PDF も無ければ TXT マ�Eカーペ�Eジ数にフォールバック�E�EdfPageIndex を流用�E�、E
export function advancePage(delta) {
  if (getParallelSyncMode()) {
    const info = activePageSource();
    if (!info) return;
    const next = Math.max(0, Math.min(info.total - 1, info.current + delta));
    setActivePageIndex(info.source, next);
    return;
  }
  if (getActivePane() === "pdf") {
    const vcount = getPdfVirtualPageCount();
    const next = getPdfPageIndex() + delta;
    const clamped = Math.max(0, Math.min(Math.max(0, vcount - 1), next));
    setPdfPageIndex(clamped);
  } else if (getPages().length > 0) {
    setCurrentPageIndex(getCurrentPageIndex() + delta);
  } else {
    // PSD 無ぁE+ PDF 無し時の TXT-only フォールバック�E�非同期 + activePane=psd の場合！E
    const info = activePageSource();
    if (!info) return;
    const next = Math.max(0, Math.min(info.total - 1, info.current + delta));
    setActivePageIndex(info.source, next);
  }
}

function jumpToEdge(where) {
  if (getParallelSyncMode()) {
    const info = activePageSource();
    if (!info) return;
    setActivePageIndex(info.source, where === "first" ? 0 : info.total - 1);
    return;
  }
  if (getActivePane() === "pdf") {
    const vcount = getPdfVirtualPageCount();
    if (vcount === 0) return;
    setPdfPageIndex(where === "first" ? 0 : vcount - 1);
  } else if (getPages().length > 0) {
    const total = getPages().length;
    setCurrentPageIndex(where === "first" ? 0 : total - 1);
  } else {
    const info = activePageSource();
    if (!info) return;
    setActivePageIndex(info.source, where === "first" ? 0 : info.total - 1);
  }
}

// 見本 / PSD ペイン上�Eマウススクロールでペ�Eジを送る、E
// 同期モーチE advancePage で両ペインがブリチE��越しに同時に動く、E
// 非同期モーチE スクロールしたペインだけを動かす！EetActivePane には依存しなぁE��、E
// Alt+wheel はズーム、E��択レイヤー上�E wheel は onLayerWheel がサイズ変更で stopPropagation
// するため、それ以外�E wheel イベントだけここで page nav に使ぁE��E
function bindWheelPageNav() {
  const pdfArea = document.getElementById("spreads-pdf-area");
  const psdArea = document.getElementById("spreads-psd-area");
  let lastWheelMs = 0;
  const throttleMs = 120;

  const navigate = (pane, delta) => {
    if (getParallelSyncMode()) {
      advancePage(delta);
      return;
    }
    if (pane === "pdf") {
      const vcount = getPdfVirtualPageCount();
      if (vcount > 0) {
        const next = Math.max(0, Math.min(vcount - 1, getPdfPageIndex() + delta));
        setPdfPageIndex(next);
      }
    } else if (getPages().length > 0) {
      setCurrentPageIndex(getCurrentPageIndex() + delta);
    }
  };

  const onWheel = (pane) => (e) => {
    // Alt / Ctrl / Meta は他�Eハンドラ�E�ズーム / ブラウザ既定）に委�Eる、E
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    const now = Date.now();
    if (now - lastWheelMs < throttleMs) return;
    lastWheelMs = now;
    const delta = e.deltaY > 0 ? +1 : -1;
    navigate(pane, delta);
  };

  if (pdfArea) pdfArea.addEventListener("wheel", onWheel("pdf"), { passive: false });
  if (psdArea) psdArea.addEventListener("wheel", onWheel("psd"), { passive: false });
}

// 同期モード中は currentPageIndex�E�ESD�E�と pdfPageIndex を相互にミラーする、E
// 非同期中は吁E�Eが独立して動く。�E入防止にフラグで一方向�E反映に限定、E
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
  // 同期/非同期どちらでめEactivePane は常に追跡�E�ズーム対象の決定に使ぁE��、E
  // リング枠の視覚強調は非同期モード�Eときだけ、E
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
  showModalAnimated(modal);
  return new Promise((resolve) => {
    resyncResolver = resolve;
  });
}
function closeResyncModal(result) {
  const modal = document.getElementById("resync-modal");
  if (modal) hideModalAnimated(modal);
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

  // 先頭白紙�Eージ除外トグル
  if (skipBlankBtn) {
    const syncSkipUi = () => {
      skipBlankBtn.setAttribute("aria-pressed", getPdfSkipFirstBlank() ? "true" : "false");
    };
    syncSkipUi();
    skipBlankBtn.addEventListener("click", () => {
      // 刁E��前後で「同じ物琁E�Eージ」を維持するため、現在の virtual page の pageNum を保存しておき
      // 刁E��後にそ�E pageNum に対応すめEvirtual index へ再�EチE�Eする、E
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
      // アクチE��ブ�Eイン側の index を非アクチE��ブ�Eに合わせる、E
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
const EDITOR_LEFT_PANE_LS_KEY = "psdesign_editor_left_pane_mode";

function bindParallelViewMode() {
  const parallelBtn = document.getElementById("view-parallel-btn");
  const proofreadBtn = document.getElementById("view-proofread-btn");
  const editorBtn = document.getElementById("view-editor-btn");
  // ドロワー要素は CSS で制御するため bind は不要だが、�E朁EDOM の存在確認だけ行う、E
  const proofreadArea = document.getElementById("spreads-proofread-area");
  const editorArea = document.getElementById("spreads-editor-area");
  const proofreadPanel = document.getElementById("proofread-panel");
  // editor モード時のみ表示される「校正 / 見本」セグメントトグル、E
  // proofread-panel-header 冁E��配置されてぁE��、E
  const leftProofreadBtn = document.getElementById("editor-left-proofread-btn");
  const leftPdfBtn = document.getElementById("editor-left-pdf-btn");
  if (!parallelBtn || !proofreadBtn || !editorBtn || !proofreadArea || !editorArea || !proofreadPanel) return;

  try {
    const saved = localStorage.getItem(VIEW_MODE_LS_KEY);
    if (saved === "parallel" || saved === "proofread" || saved === "editor") {
      setParallelViewMode(saved);
    }
  } catch {}

  // editor モード左ペイン (校正 / 見本) の選択を localStorage から復允E��E
  // editor モードに入ったときだけ実効化される�E�ESS 側で .workspace.editor-mode が前提）、E
  try {
    const savedLeft = localStorage.getItem(EDITOR_LEFT_PANE_LS_KEY);
    if (savedLeft === "proofread" || savedLeft === "pdf") {
      setEditorLeftPaneMode(savedLeft);
    }
  } catch {}

  parallelBtn.addEventListener("click", () => setParallelViewMode("parallel"));
  proofreadBtn.addEventListener("click", () => setParallelViewMode("proofread"));
  editorBtn.addEventListener("click", () => setParallelViewMode("editor"));
  if (leftProofreadBtn) {
    leftProofreadBtn.addEventListener("click", () => setEditorLeftPaneMode("proofread"));
  }
  if (leftPdfBtn) {
    leftPdfBtn.addEventListener("click", () => setEditorLeftPaneMode("pdf"));
  }

  // 3 モード構�E:
  //   parallel:  PDF + PSD のみ�E�Eroofread / editor ドロワーはどちらも左へ格納！E
  //   proofread: PDF + PSD + 校正パネルが左半�Eにスライドオーバ�Eレイ�E�EDF area の上！E
  //   editor:    PDF/PSD は背景に残し、校正パネル�E�左�E�E エチE��タ�E�右�E�が左からスライドして要E��
  //              サイドバー類�E display:none�E�編雁E��雁E��、本リクエスト対象外！E
  //
  // proofread-panel は #spreads-proofread-area 冁E��固定�E置。モード�E替で DOM を移動しなぁE��E
  // ドロワーの slide-in/out は CSS の transform transition + visibility で実裁E��れ、E
  // .spreads-stage に付けめE`proofread-visible` / `editor-visible` クラスで制御する、E
  const workspace = document.querySelector(".workspace");
  const stage = document.getElementById("spreads-stage");
  const applyEditorLeftPaneClass = () => {
    if (!workspace) return;
    // editor モード時のみ left-pdf class が意味を持つ。それ以外では常に外す、E
    const inEditor = getParallelViewMode() === "editor";
    const leftPdf = inEditor && getEditorLeftPaneMode() === "pdf";
    workspace.classList.toggle("left-pdf", leftPdf);
  };
  const sync = () => {
    const mode = getParallelViewMode();
    const showEditor = mode === "editor";
    const showProofread = mode === "proofread";
    if (workspace) {
      workspace.classList.toggle("editor-mode", showEditor);
      workspace.classList.toggle("proofread-mode", showProofread);
    }
    // ドロワー表示クラス。proofread / editor どちらでめEproofread-area は表示する、E
    if (stage) {
      stage.classList.toggle("proofread-visible", showProofread || showEditor);
      stage.classList.toggle("editor-visible", showEditor);
    }
    parallelBtn.classList.toggle("active", mode === "parallel");
    proofreadBtn.classList.toggle("active", mode === "proofread");
    editorBtn.classList.toggle("active", mode === "editor");
    parallelBtn.setAttribute("aria-pressed", mode === "parallel" ? "true" : "false");
    proofreadBtn.setAttribute("aria-pressed", mode === "proofread" ? "true" : "false");
    editorBtn.setAttribute("aria-pressed", mode === "editor" ? "true" : "false");
    try { localStorage.setItem(VIEW_MODE_LS_KEY, mode); } catch {}
    // editor モーチEON/OFF に応じて left-pdf class も更新�E�Editor モード以外では常に外す�E�、E
    applyEditorLeftPaneClass();

    // 校正パネルの冁E��状態！Eanel 表示�E�を確保。parent (.spreads-proofread-area) の
    // opacity / transform で実際の表示制御を行うため、panel 自体�E閉じなぁE��閉じると
    // スライドアウト中に冁E��が瞬時に display:none になり、空のドロワーが滑る不格好な
    // アニメになる）。closeProofread は呼ばなぁE��E
    if (showProofread || showEditor) openProofread();

    if (showEditor) focusEditor();
  };
  onParallelViewModeChange(sync);

  // 「見本」モード時に pdf-area の幁E��現在の見本ペ�Eジの実アスペクト比に同期する、E
  // 50% 固定だと縦長ペ�Eジで letter-box / 横長ペ�Eジで刁E��る「ぎこちなぁE��示」になる、E
  // - stage 高さ - ヘッダー (34px) を基準に width = (height - padding) * AR + padding
  // - 結果めECSS 変数 `--left-pdf-width` に書き込み、pdf-area / editor-area の両方が参照
  // - rAF で coalesce、async getPage() の競合�E seq token で抑止
  // - syncEditorLeftPane より前に定義する忁E��あめE(sync 初回呼出で requestRecompute を参照するため、E
  //   後置すると const TDZ エラーで init が止まめErenderAllSpreads が走らなぁE��故あり)
  const PANEL_PADDING = 32; // pdf-area の左右 padding 16+16
  const HEADER_OFFSET = 34; // proofread-panel-header 高さ
  const MIN_PANEL_WIDTH = 240;
  const MAX_PANEL_RATIO = 0.85; // stage 幁E�E最大 85%
  let leftPdfRecomputeRaf = 0;
  let leftPdfRecomputeSeq = 0;

  const clearLeftPdfWidth = () => {
    if (workspace) workspace.style.removeProperty("--left-pdf-width");
  };

  const recomputeLeftPdfWidth = async () => {
    if (!workspace) return;
    // editor モード以外では使わなぁE��Ear を消して通常 50% に戻す）、E
    // editor モード中は left-pdf サブ状態でなくても�E行計算しておくと、E
    // 「見本」トグルした瞬間に CSS var が既に正しい値になってぁE�� 50% フラチE��ュが起きなぁE��E
    const inEditor = getParallelViewMode() === "editor";
    if (!inEditor) {
      clearLeftPdfWidth();
      return;
    }
    if (!stage) {
      clearLeftPdfWidth();
      return;
    }
    const stageRect = stage.getBoundingClientRect();
    if (stageRect.height <= 0 || stageRect.width <= 0) return;

    const doc = getPdfDoc();
    const vp = getPdfVirtualPageAt(getPdfPageIndex());
    if (!doc || !vp) {
      // 見本未読込 / 篁E��夁E 50% フォールバック�E�ESS チE��ォルト）、E
      clearLeftPdfWidth();
      return;
    }

    const seq = ++leftPdfRecomputeSeq;
    let page;
    try {
      page = await doc.getPage(vp.pageNum);
    } catch {
      return;
    }
    // 競吁E(新しい recompute が来ぁE なら破棁E��E
    if (seq !== leftPdfRecomputeSeq) return;
    // editor モードを抜けてぁE��ら破棁E��て var クリア、E
    if (getParallelViewMode() !== "editor") {
      clearLeftPdfWidth();
      return;
    }

    const baseRot = typeof page.rotate === "number" ? page.rotate : 0;
    const totalRot = (((baseRot + getPdfRotation()) % 360) + 360) % 360;
    const viewport0 = page.getViewport({ scale: 1, rotation: totalRot });
    const isLandscape = viewport0.width > viewport0.height;
    const wantsSplit = vp.side === "left" || vp.side === "right";
    const side = wantsSplit && isLandscape ? vp.side : "full";
    const fullAR = viewport0.width / viewport0.height;
    const ar = side === "full" ? fullAR : fullAR / 2;

    const availH = Math.max(0, stageRect.height - HEADER_OFFSET - PANEL_PADDING);
    const targetCanvasW = availH * ar;
    const targetPanelW = targetCanvasW + PANEL_PADDING;
    const maxW = stageRect.width * MAX_PANEL_RATIO;
    const finalW = Math.max(MIN_PANEL_WIDTH, Math.min(maxW, targetPanelW));

    workspace.style.setProperty("--left-pdf-width", `${Math.round(finalW)}px`);
  };

  const requestRecomputeLeftPdfWidth = () => {
    if (leftPdfRecomputeRaf) cancelAnimationFrame(leftPdfRecomputeRaf);
    leftPdfRecomputeRaf = requestAnimationFrame(() => {
      leftPdfRecomputeRaf = 0;
      recomputeLeftPdfWidth();
    });
  };

  // recompute トリガー一覧:
  // - PDF (見本) ロード変化、�Eージ刁E��、回転 ↁEアスペクト比が変わめE
  // - parallel view mode 変化 ↁEeditor モード�E退出
  // - 既に editor.left-pdf に屁E��状態でも�E囁Esync で呼ぶ忁E��があるので↑�E sync 経路でも発火
  // - stage の resize ↁE高さ依存なのでウィンドウサイズに追征E
  onPdfChange(requestRecomputeLeftPdfWidth);
  onPdfPageIndexChange(requestRecomputeLeftPdfWidth);
  onPdfRotationChange(requestRecomputeLeftPdfWidth);
  onParallelViewModeChange(requestRecomputeLeftPdfWidth);
  if (typeof ResizeObserver !== "undefined" && stage) {
    const ro = new ResizeObserver(requestRecomputeLeftPdfWidth);
    ro.observe(stage);
  }
  // 初期同期、E
  requestRecomputeLeftPdfWidth();

  // editor モード�E左ペイン (校正 / 見本) 刁E��の同期、E
  // - workspace.classList の left-pdf を更新�E�ESS で表示刁E���E�E
  // - セグメント�Eタンの active / aria-pressed を更新
  // - localStorage に永続化
  // - requestRecomputeLeftPdfWidth を呼ぶので、忁E��それが定義された後に書く、E
  const syncEditorLeftPane = () => {
    const m = getEditorLeftPaneMode();
    applyEditorLeftPaneClass();
    if (leftProofreadBtn) {
      leftProofreadBtn.classList.toggle("active", m === "proofread");
      leftProofreadBtn.setAttribute("aria-pressed", m === "proofread" ? "true" : "false");
    }
    if (leftPdfBtn) {
      leftPdfBtn.classList.toggle("active", m === "pdf");
      leftPdfBtn.setAttribute("aria-pressed", m === "pdf" ? "true" : "false");
    }
    try { localStorage.setItem(EDITOR_LEFT_PANE_LS_KEY, m); } catch {}
    requestRecomputeLeftPdfWidth();
  };
  onEditorLeftPaneModeChange(syncEditorLeftPane);
  syncEditorLeftPane();
  sync();
}

// 【v1.16.0】フォントサイズ一部変更  E選択篁E��があれ�E per-char、無ければ layer 全体に適用、E
function applyTextSize(n) {
  // in-place 編雁E��で斁E��選択がある ↁEper-char サイズ適用、E
  // 選択篁E��は canvas-tools の module-level キャチE��ュから取る�E�Eelect イベントで保存される�E�、E
  const sel = getLastInplaceSelection();
  if (sel && sel.end > sel.start) {
    const v = clampSize(n);
    const targetId = sel.tempId ?? sel.layerId;
    setCharSizesRange(sel.psdPath, targetId, sel.start, sel.end, v);
    // 【v1.21.0】編雁E��の DOM にも即時反映: span でラチE�Eして fontSize めEem 比で当てる、E
    // layer の defaultSizePt を取得して em 毁E= v / defaultSizePt を求める、E
    const defaultSizePt = resolveLayerDefaultSizePt(sel);
    if (defaultSizePt > 0) {
      const ratio = v / defaultSizePt;
      applyEditModeStyleToRange(sel.start, sel.end, { fontSize: `${ratio}em` });
    }
    refreshAllOverlays();
    rebuildLayerList();
    restoreInplaceSelection(sel);
    requestAnimationFrame(() => restoreInplaceSelection(sel));
    setTextSize(v); // サイドバー入力欁E�E値も同朁E
    return;
  }
  setTextSize(n);
  // 選択中の全レイヤーに同じサイズを適用�E�褁E��選択でも一括反映�E�、E
  commitSizeToSelections(getTextSize());
}

// per-char サイズ変更で em 比換算に使ぁE��対象レイヤーの defaultSizePt」を解決、E
function resolveLayerDefaultSizePt(sel) {
  if (!sel) return 0;
  const pages = getPages();
  for (let pi = 0; pi < pages.length; pi++) {
    const page = pages[pi];
    if (page.path !== sel.psdPath) continue;
    if (typeof sel.layerId === "number") {
      const layer = page.textLayers.find((l) => l.id === sel.layerId);
      if (!layer) return 0;
      const edit = getEdit(page.path, layer.id) ?? {};
      // ↁEgetExistingLayerEffectiveSizePt は canvas-tools.js から既に import 済み
      return getExistingLayerEffectiveSizePt(page, layer, edit) || 0;
    }
    if (typeof sel.tempId === "string") {
      const nl = page.textLayers; // 不要、newLayers から探ぁE
      // newLayers は state から
      // import 経由で getNewLayersForPsd を使ぁE��E��があるが既に import 済み
      const list = (typeof getNewLayersForPsd === "function") ? getNewLayersForPsd(page.path) : [];
      const item = list.find((l) => l.tempId === sel.tempId);
      return item?.sizePt ?? 0;
    }
  }
  return 0;
}

function clampSize(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return getTextSize();
  return Math.max(6, Math.min(999, Math.round(v * 100) / 100));
}

function getSizeStep() {
  const v = Number(getDefault("textSizeStep"));
  if (v === 0.25 || v === 0.5) return v;
  return 0.1;
}

// +/- ボタンと [/] ショートカチE��用のサイズ調整、E
// 環墁E��定�E baseStep�E�E.1 / 0.5�E�グリチE��に揁E��る形でスナップする！E
// 例！E.5 刻み設定で現在 12.3pt ↁE"+" で 12.5�E�E3.0 ではなぁE��！E-" で 12.0
function stepTextSize(sign, multiplier = 1) {
  const baseStep = getSizeStep();
  const next = snapNextSize(getTextSize(), baseStep, sign, multiplier);
  applyTextSize(next);
}

// 【v1.22.0】合成太字！Eaux bold�E�トグルボタン。Photoshop の Character パネル B ボタン相当、E
// in-place 編雁E��で斁E��選択あめEↁEper-char (charBolds)、無ければ layer 全佁E(syntheticBold)、E
// クリチE��時�E現在 aria-pressed 値を反転させ、新値を適用する。populateEditor ぁE
// computeCommonBold で aria-pressed を同期する�Eで、E��択�E替・褁E��選択時も正しく追従、E
function bindBoldToggle() {
  const btn = document.getElementById("bold-toggle-btn");
  if (!btn) return;
  // mousedown.preventDefault で contenteditable のフォーカス移動を抑止し、in-place 編雁E��の
  // 斁E��選択を保ったまま B をクリチE��できるようにする�E�EommitFontToSelections の bind パターンと同じ�E�、E
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", () => {
    if (btn.disabled) return;
    const newValue = btn.getAttribute("aria-pressed") !== "true";
    // 1. in-place 編雁E��の斁E��選抁EↁEper-char 適用
    const sel = getLastInplaceSelection();
    if (sel && sel.end > sel.start) {
      const targetId = sel.tempId ?? sel.layerId;
      setCharBoldsRange(sel.psdPath, targetId, sel.start, sel.end, newValue);
      // 編雁E��の DOM にも即時反映: span ラチE�Eで font-weight を当てる、E
      applyEditModeStyleToRange(sel.start, sel.end, { fontWeight: newValue ? "700" : "400" });
      refreshAllOverlays();
      rebuildLayerList();
      // ボタン表示: 篁E��の bold 値を即座に反映�E�Eommit 後�E populateEditor 経由でも同じだぁEvisual lag を避ける�E�、E
      btn.setAttribute("aria-pressed", newValue ? "true" : "false");
      return;
    }
    // 2. layer 選抁EↁEper-layer 適用�E�既存�E commitFontToSelections と同じ流れ�E�E
    if (commitBoldToSelections(newValue)) {
      btn.setAttribute("aria-pressed", newValue ? "true" : "false");
    }
  });
}

// 【v1.26.0】ルビパネル。in-place 編雁E��の斁E��選択篁E�� + ふりがな入劁EↁE「適用」�Eタンで
// charRubies に書き込む。モチEグループ�E動判定�E「�E力にスペ�Eスあり and 刁E��数 == 親斁E��数、E
// のときモノ、それ以外グループ。手勁Emode (自勁EモチEグルーチE で強制も可、E
function bindRubyTool() {
  const parentEl = document.getElementById("ruby-parent-display");
  const inputEl = document.getElementById("ruby-text-input");
  const scaleEl = document.getElementById("ruby-scale-input");
  const applyBtn = document.getElementById("ruby-apply-btn");
  const removeBtn = document.getElementById("ruby-remove-btn");
  const modeAuto = document.getElementById("ruby-mode-auto-btn");
  const modeMono = document.getElementById("ruby-mode-mono-btn");
  const modeGroup = document.getElementById("ruby-mode-group-btn");
  if (!parentEl || !inputEl || !applyBtn || !removeBtn) return;

  let currentMode = "auto"; // "auto" | "mono" | "group"

  // フォーカスを盗まなぁE��ぁE�� mousedown を抑制�E�En-place 編雁E��保護�E�、E
  // ただぁEinput 系�E��Eりがな + scale�E��E通常通りフォーカスを許可する、E
  const noFocusSteal = (el) => el && el.addEventListener("mousedown", (e) => e.preventDefault());
  [applyBtn, removeBtn, modeAuto, modeMono, modeGroup].forEach(noFocusSteal);

  const setMode = (m) => {
    currentMode = m;
    [
      [modeAuto, "auto"],
      [modeMono, "mono"],
      [modeGroup, "group"],
    ].forEach(([b, k]) => {
      if (b) b.classList.toggle("active", k === m);
    });
  };
  modeAuto?.addEventListener("click", () => setMode("auto"));
  modeMono?.addEventListener("click", () => setMode("mono"));
  modeGroup?.addEventListener("click", () => setMode("group"));

  const clampRubyScale = (n) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return 50;
    return Math.max(20, Math.min(100, Math.round(v / 5) * 5));
  };

  const decideRubyType = (mode, text, parentText) => {
    if (mode === "mono") return "mono";
    if (mode === "group") return "group";
    // auto
    if (/[ 　]/.test(text)) {
      const parts = text.split(/[ 　]+/);
      if (parts.length === parentText.length) return "mono";
    }
    return "group";
  };

  // 【v1.29.x】親斁E��選択時に衁Eindex を表示するためのラベル
  const lineHintEl = document.getElementById("ruby-line-hint");

  // 斁E��選択変化で親斁E��表示と入力欁E�E有効化を刁E��
  const updateSelection = (sel) => {
    if (sel && sel.end > sel.start) {
      const targetId = sel.tempId ?? sel.layerId;
      const ec = getEditingContext();
      const contents = ec?.contents ?? "";
      const parentText = contents.substring(sel.start, sel.end);
      parentEl.textContent = parentText || "（選択範囲）";
      inputEl.disabled = false;
      applyBtn.disabled = false;
      // 【v1.29.x】親斁E��が乗る衁Eindex を計箁E(0-based) ↁEユーザーには 1-based で表示
      const startLine = (contents.substring(0, sel.start).match(/\n/g) ?? []).length;
      const endLine = (contents.substring(0, sel.end).match(/\n/g) ?? []).length;
      if (lineHintEl) {
        const lineLabel = startLine === endLine
          ? `${startLine + 1} 行目`
          : `${startLine + 1}、E{endLine + 1} 行目`;
        lineHintEl.textContent = lineLabel;
        lineHintEl.hidden = false;
      }
      // 既存ルビがあれば入力欁E�� reload
      const existing = getCharRubyAt(sel.psdPath, targetId, sel.start);
      if (existing && existing.end === sel.end) {
        inputEl.value = existing.text;
        if (existing.scale) scaleEl.value = String(existing.scale);
        if (existing.type) setMode(existing.type);
        removeBtn.disabled = false;
      } else {
        inputEl.value = "";
        removeBtn.disabled = !rangeHasAnyRuby(sel.psdPath, targetId, sel.start, sel.end);
      }
    } else {
      parentEl.innerHTML = '<span class="ruby-parent-empty">文字を選択</span>';
      if (lineHintEl) { lineHintEl.textContent = ""; lineHintEl.hidden = true; }
      inputEl.disabled = true;
      applyBtn.disabled = true;
      removeBtn.disabled = true;
      inputEl.value = "";
    }
  };
  onInplaceSelectionChange(updateSelection);
  updateSelection(getLastInplaceSelection());

  // 適用
  const doApply = () => {
    const sel = getLastInplaceSelection();
    if (!sel || sel.end <= sel.start) return;
    const text = inputEl.value.trim();
    if (!text) return;
    const targetId = sel.tempId ?? sel.layerId;
    const parentText = parentEl.textContent || "";
    const scale = clampRubyScale(scaleEl.value);
    const type = decideRubyType(currentMode, text, parentText);
    // 【v1.29.0】ルビ適用と同時に、ルビが乗る行�E lineLeading めErubyLeadingPct
    // (チE��ォルチE150%) に上書き。同一 history snapshot にまとめECtrl+Z 一発で
    // ルチE+ leading 両方戻る、E
    // 衁Eindex = 親斁E��Erange の手前にある改行数。褁E��行に跨ぁEruby は range 開始行�Eみ更新、E
    const ec = getEditingContext();
    const contents = ec?.contents ?? "";
    const startLine = (contents.substring(0, sel.start).match(/\n/g) ?? []).length;
    const endLine = (contents.substring(0, sel.end).match(/\n/g) ?? []).length;
    const rubyLeadingPct = Number(getDefault("rubyLeadingPct")) || 150;
    console.info(
      `[ruby-apply] parent range=[${sel.start}, ${sel.end}) lines=${startLine + 1}-${endLine + 1} / lineLeading=${rubyLeadingPct}%`,
    );
    withHistoryTransient(() => {
      setCharRubiesRange(sel.psdPath, targetId, sel.start, sel.end, text, type, scale);
      // 親斁E��Erange が跨ぐすべての行に rubyLeadingPct を当てる、E
      for (let li = startLine; li <= endLine; li++) {
        setLineLeading(sel.psdPath, targetId, li, rubyLeadingPct);
      }
    });
    // 【v1.29.x】編雁E��レイヤー DOM への即晁Eline-height 反映、E
    //   renderOverlay は .editing レイヤーをスキチE�Eする (caret 保護のため)、E
    //   state.lineLeadings の変更を画面に反映するには、編雁E�� inner の style を直接更新する忁E��がある、E
    //   ここでは簡易的に inner 全体�E line-height めErubyLeadingPct に上書きすめE
    //   (per-line ではなぁEper-layer の簡易適用)。編雁E��ードを抜けると renderOverlay ぁE
    //   per-line lineLeadings を正確に反映するので、その時点でズレが解消される、E
    const editingBox = document.querySelector(".layer-box.editing");
    if (editingBox) {
      const inner = editingBox.querySelector(".existing-layer-text, .new-layer-text");
      if (inner) {
        inner.style.lineHeight = String(rubyLeadingPct / 100);
      }
    }
    // 編雁E�� DOM への即時反映�E�宁EDOM ルチEwrap めEinner に挿入�E�、E
    applyEditModeRubyToRange(sel.start, sel.end, text, type, scale);
    refreshAllOverlays();
    rebuildLayerList();
    restoreInplaceSelection(sel);
    requestAnimationFrame(() => restoreInplaceSelection(sel));
    removeBtn.disabled = false;
  };
  applyBtn.addEventListener("click", doApply);

  // 削除
  removeBtn.addEventListener("click", () => {
    const sel = getLastInplaceSelection();
    if (!sel || sel.end <= sel.start) return;
    const targetId = sel.tempId ?? sel.layerId;
    withHistoryTransient(() => {
      setCharRubiesRange(sel.psdPath, targetId, sel.start, sel.end, "", "group", 50);
    });
    refreshAllOverlays();
    rebuildLayerList();
    restoreInplaceSelection(sel);
    requestAnimationFrame(() => restoreInplaceSelection(sel));
    inputEl.value = "";
    removeBtn.disabled = true;
  });

  // Enter で apply、Esc でクリア
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      doApply();
    } else if (e.key === "Escape") {
      e.preventDefault();
      inputEl.value = "";
    }
  });
}

function bindSizeTool() {
  const input = document.getElementById("size-input");
  const dec = document.getElementById("size-dec-btn");
  const inc = document.getElementById("size-inc-btn");
  if (!input || !dec || !inc) return;

  const applyStepAttr = () => {
    input.step = String(getSizeStep());
  };
  applyStepAttr();
  onSettingsChange(applyStepAttr);

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
  dec.addEventListener("mousedown", (e) => e.preventDefault());
  inc.addEventListener("mousedown", (e) => e.preventDefault());
  dec.addEventListener("click", () => stepTextSize(-1));
  inc.addEventListener("click", () => stepTextSize(+1));
}

// 行間を適用。in-place 編雁E���E�EditingContext あり�E��Eカーソル行�E per-line override に
// 書き込み、そぁE��なければ従来どおり layer 全体�E leadingPct を更新する、E
function applyLeading(n) {
  const v = clampLeading(n);
  // 1. in-place 編雁E��はカーソル行�E per-line override�E�既存挙動！E
  const ec = getEditingContext();
  if (ec) {
    const targetId = ec.tempId ?? ec.layerId;
    setLineLeading(ec.psdPath, targetId, ec.currentLineIndex ?? 0, v);
    refreshAllOverlays();
    rebuildLayerList();
    syncLeadingInputForEditingContext();
    return;
  }
  // 2. 通常モード！En-place 編雁E��し！E 選択中レイヤー全体に一括適用 + global leadingPct 更新、E
  //    旧サイドバー行セレクタ�E�「�E衁E/ 2 / 3 / …」�Eタン�E�による per-line override は廁E��、E
  //    in-place 編雁E��のカーソル行�EみぁEper-line 対象、E
  setLeadingPct(v);
  commitLeadingToSelections(getLeadingPct());
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

// editingContext ぁEactive のとき�E leading-input にカーソル行�E値を表示、E
// 行ごとの override が無ければレイヤー global の leadingPct を表示する、E
function syncLeadingInputForEditingContext() {
  const input = document.getElementById("leading-input");
  if (!input) return;
  const ec = getEditingContext();
  if (!ec) return;
  const targetId = ec.tempId ?? ec.layerId;
  const v = getLineLeading(ec.psdPath, targetId, ec.currentLineIndex ?? 0) ?? getLeadingPct();
  if (document.activeElement !== input) input.value = String(v);
}

function bindLeadingTool() {
  const input = document.getElementById("leading-input");
  const dec = document.getElementById("leading-dec-btn");
  const inc = document.getElementById("leading-inc-btn");
  if (!input || !dec || !inc) return;

  input.value = String(getLeadingPct());
  onLeadingPctChange((v) => {
    if (document.activeElement !== input) input.value = String(v);
  });

  input.addEventListener("input", () => {
    const v = parseInt(input.value, 10);
    if (!Number.isFinite(v)) return;
    applyLeading(v);
  });
  input.addEventListener("blur", () => {
    // editingContext (in-place 編雁E��) ならカーソル行�E per-line 値、それ以外�E global、E
    const ec = getEditingContext();
    if (ec) {
      const targetId = ec.tempId ?? ec.layerId;
      const v = getLineLeading(ec.psdPath, targetId, ec.currentLineIndex ?? 0) ?? getLeadingPct();
      input.value = String(v);
      return;
    }
    input.value = String(getLeadingPct());
  });
  // ボタン群は in-place 編雁Etextarea からのフォーカス移動を抑止する。これがなぁE��
  // + を押すたびに textarea ぁEblur ↁEカーソル行が失われ、editingContext が消える、E
  const keepFocus = (el) => el && el.addEventListener("mousedown", (e) => e.preventDefault());
  keepFocus(dec); keepFocus(inc);
  dec.addEventListener("click", () => adjustLeading(-5));
  inc.addEventListener("click", () => adjustLeading(+5));

  // in-place 編雁E�E context 変化に追従して input/ボタンの表示を更新、E
  // context が立つ ↁEカーソル行�E per-line 値�E�無ければ global�E�を表示、E
  // context が消えめEↁEglobal 値に戻す、E
  // 旧 `syncRuby(leadingPct)` 呼出は v1.16.0 期�E「leadingPct >= 150 でルビトグル active、E
  // 機構�E残骸で、ルチEpanel が独自 state�E�EharRubies�E�に移行した時点で dead code 化してぁE��
  // が、未参�Eのままコードに残って `ReferenceError` を起こしてぁE��。撤去済み、E
  onEditingContextChange((ec) => {
    if (ec) {
      syncLeadingInputForEditingContext();
    } else {
      input.value = String(getLeadingPct());
    }
  });
}

async function handleDroppedPaths(paths) {
  if (!paths || paths.length === 0) return;
  const psdFiles = [];
  const txtFiles = [];
  const pdfFiles = []; // PDF / JPEG / PNG ぁE��れも「見本」としてここに入れる
  const unknowns = []; // 拡張子なぁE�E�Eおそらくフォルダ
  for (const p of paths) {
    if (/\.psd$/i.test(p)) psdFiles.push(p);
    else if (/\.txt$/i.test(p)) txtFiles.push(p);
    else if (/\.(pdf|jpe?g|png)$/i.test(p)) pdfFiles.push(p);
    else unknowns.push(p);
  }
  // フォルダらしきものは中の .psd を展開して取り込む�E�従来の利便性を維持E��、E
  for (const folder of unknowns) {
    try {
      const files = await listPsdFilesInFolder(folder);
      if (Array.isArray(files) && files.length) psdFiles.push(...files);
    } catch (e) {
      console.warn("フォルダ展開に失敁E", folder, e);
    }
  }
  if (psdFiles.length > 0) {
    await loadPsdFilesByPaths(psdFiles);
  }
  for (const t of txtFiles) {
    await loadTxtFromPath(t);
  }
  if (pdfFiles.length > 0) {
    // 褁E��ファイルは合�E doc としてまとめて読み込む�E��E然頁E= page1 ↁEpage2 ↁEpage10�E�、E
    await loadReferenceFiles(pdfFiles);
  }
}

async function setupTauriDragDrop() {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const overlay = document.getElementById("drag-overlay");
    const showOverlay = (payload) => {
      if (homeTypesetDragOverHandler?.(payload) === true) return;
      if (homeTypesetDropHandler) return;
      if (!overlay) return;
      overlay.classList.remove("flash");
      overlay.classList.add("active");
    };
    const hideOverlay = () => {
      homeTypesetDragLeaveHandler?.();
      overlay?.classList.remove("active");
    };
    const flashOverlay = () => {
      if (!overlay) return;
      overlay.classList.remove("active");
      overlay.classList.remove("flash");
      // 同フレームの re-add でアニメーションを確実に再発火
      void overlay.offsetWidth;
      overlay.classList.add("flash");
      setTimeout(() => overlay.classList.remove("flash"), 400);
    };

    await getCurrentWindow().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload?.type === "enter" || payload?.type === "over") {
        showOverlay(payload);
        return;
      }
      if (payload?.type === "leave") {
        hideOverlay();
        return;
      }
      if (payload?.type !== "drop") return;

      const paths = Array.isArray(payload.paths) ? payload.paths : [];
      if (homeTypesetDropHandler?.(paths, payload) === true) {
        hideOverlay();
        return;
      }
      flashOverlay();
      handleDroppedPaths(paths).catch((err) => console.error(err));
    });
  } catch (e) {
    console.warn("drag-drop listener failed:", e);
  }
}

// アクチE��ブ�Eイン基準�Eズーム操作（�Eタン・キーボ�Eド！E
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

// 定規�Eタンの click + ON/OFF 表示同期 + Ctrl+R の WebView リロード抑止、E
// Ctrl+R は WebView2 の既定リロードに先取りされやすいので、bindZoomTool と同じぁE
// capture フェーズで matchShortcut("toggleRulers") を判定して preventDefault、E
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

// V チE�Eル直下�E「新規テキスト方向」スイチE�� (縦型トグル)、E
// 1 つのスイチE��をクリチE��すると縦↔横が�E替わる、E
// localStorage 永続化 + aria-checked 同期 (CSS ぁEthumb 位置 / icon 色を担彁E、E
const NEW_TEXT_DIR_LS_KEY = "psdesign_new_text_direction";
function bindNewTextDirectionToggle() {
  const sw = document.getElementById("new-text-dir-switch");
  if (!sw) return;

  // 起動時: localStorage から復允E
  try {
    const saved = localStorage.getItem(NEW_TEXT_DIR_LS_KEY);
    if (saved === "vertical" || saved === "horizontal") {
      setNewTextDirection(saved);
    }
  } catch {}

  const sync = () => {
    const dir = getNewTextDirection();
    const isV = dir === "vertical";
    sw.setAttribute("aria-checked", isV ? "true" : "false");
    sw.setAttribute(
      "aria-label",
      isV ? "新規テキストの方向: 縦書き" : "新規テキストの方向: 横書き",
    );
  };
  sync();
  onNewTextDirectionChange((dir) => {
    sync();
    try { localStorage.setItem(NEW_TEXT_DIR_LS_KEY, dir); } catch {}
  });

  sw.addEventListener("click", () => {
    setNewTextDirection(getNewTextDirection() === "vertical" ? "horizontal" : "vertical");
  });
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
    level.title = `${paneLabel(pane)} を100% にリセット`;
  };
  updateLevel();
  onPdfZoomChange(updateLevel);
  onPsdZoomChange(updateLevel);
  onActivePaneChange(updateLevel);

  out.addEventListener("click", () => zoomActivePaneBy(1 / 1.15));
  inn.addEventListener("click", () => zoomActivePaneBy(1.15));
  level.addEventListener("click", () => resetActivePaneZoom());

  // Alt+wheel はカーソルが乗ってぁE��ペインをズーム�E�Ective-pane には依存しなぁE��が直感的�E�、E
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
      // ズーム系は WebView2 の既定�Eージズームに先取りされるため capture フェーズで拾ぁE��E
      // 環墁E��定�EキーめEmatchShortcut で照合してから handle、E
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

// ペ�Eジジャンプ対象は activePane を優先し、無効なら片方にフォールバック、E
// PDF 側を選んだ場合�E仮想ペ�Eジ番号�E�単ペ�Eジ化時は見開き�E割後�E番号�E�でジャンプする、E
let pageJumpTarget = "psd"; // "psd" | "pdf"

function decidePageJumpTarget() {
  const psdHas = getPages().length > 0;
  const pdfHas = getPdfVirtualPageCount() > 0;
  const txtHas = getTxtPageCount() > 0;
  const preferred = getActivePane();
  if (preferred === "pdf" && pdfHas) {
    return { kind: "pdf", total: getPdfVirtualPageCount(), current: getPdfPageIndex(), label: "PDF" };
  }
  if (preferred === "psd" && psdHas) {
    return { kind: "psd", total: getPages().length, current: getCurrentPageIndex(), label: "PSD" };
  }
  if (psdHas) return { kind: "psd", total: getPages().length, current: getCurrentPageIndex(), label: "PSD" };
  if (pdfHas) return { kind: "pdf", total: getPdfVirtualPageCount(), current: getPdfPageIndex(), label: "PDF" };
  // PSD/PDF とも無ければ TXT マ�Eカーへフォールバック (pdfPageIndex を流用)
  if (txtHas) return { kind: "pdf", total: getTxtPageCount(), current: getPdfPageIndex(), label: "テキスト" };
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
  showModalAnimated(modal);
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

function closePageJumpDialog() {
  const modal = document.getElementById("page-jump-modal");
  if (modal) hideModalAnimated(modal);
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

function showHomeScreen() {
  document.body.classList.add("home-mode");
}

function hideHomeScreen() {
  document.body.classList.remove("home-mode");
}

function homeFlowBaseName(path) {
  if (!path) return "";
  const normalized = String(path).replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function homeFlowFileSummary(paths, emptyLabel) {
  const list = Array.isArray(paths) ? paths.filter(Boolean) : paths ? [paths] : [];
  if (list.length === 0) return emptyLabel;
  if (list.length === 1) return homeFlowBaseName(list[0]);
  return `${homeFlowBaseName(list[0])} ほぁE${list.length - 1}件`;
}

function homeFlowFilterPaths(paths, kind) {
  const list = (Array.isArray(paths) ? paths : [paths])
    .filter((p) => typeof p === "string" && p.length > 0);
  if (kind === "reference") return list.filter((p) => /\.(pdf|jpe?g|png)$/i.test(p));
  if (kind === "psd") return list.filter((p) => /\.psd$/i.test(p));
  if (kind === "txt") return list.filter((p) => /\.txt$/i.test(p)).slice(0, 1);
  return [];
}

async function homeFlowResolveDroppedPaths(paths, kind) {
  const direct = homeFlowFilterPaths(paths, kind);
  const list = (Array.isArray(paths) ? paths : [paths])
    .filter((p) => typeof p === "string" && p.length > 0);
  const folderCandidates = list.filter((p) => !/\.(psd|txt|pdf|jpe?g|png)$/i.test(p));
  const fromFolders = [];
  for (const folder of folderCandidates) {
    try {
      let files = [];
      if (kind === "psd") {
        files = await listPsdFilesInFolder(folder);
      } else {
        const { invoke } = await import("@tauri-apps/api/core");
        const entries = await invoke("list_directory_entries", { path: folder });
        const entryPaths = Array.isArray(entries)
          ? entries.filter((entry) => entry?.isFile).map((entry) => entry.path).filter(Boolean)
          : [];
        files = homeFlowFilterPaths(entryPaths, kind);
      }
      if (Array.isArray(files) && files.length) fromFolders.push(...files);
    } catch (e) {
      console.warn("写植フォルダ展開に失敁E", folder, e);
    }
  }
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const resolved = [...direct, ...fromFolders].sort((a, b) => collator.compare(homeFlowBaseName(a), homeFlowBaseName(b)));
  return kind === "txt" ? resolved.slice(0, 1) : resolved;
}

function openReferenceHiddenPicker(paths, selectedPages = new Set(), skipFirstBlankPage = false) {
  return new Promise(async (resolve) => {
    let settled = false;
    let cards = [];
    const selected = new Set(selectedPages);
    let skipFirstBlank = !!skipFirstBlankPage;
    const escapeHtml = (value) => String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
    const modal = document.createElement("div");
    modal.className = "reference-hidden-modal";
    modal.hidden = true;
    modal.innerHTML = `
      <div class="reference-hidden-card" role="dialog" aria-modal="true" aria-labelledby="reference-hidden-title">
        <div class="reference-hidden-header">
          <div>
            <div class="reference-hidden-title" id="reference-hidden-title">非表示にする見本を選択</div>
            <div class="reference-hidden-subtitle">選択した見本は表示とページ計算から除外されます</div>
          </div>
          <button class="reference-hidden-close" type="button" aria-label="閉じる">×</button>
        </div>
        <div class="reference-hidden-body">
          <div class="reference-hidden-loading">見本を読み込み中...</div>
          <div class="reference-hidden-grid" hidden></div>
        </div>
        <div class="reference-hidden-footer">
          <div class="reference-hidden-footer-info">
            <label class="reference-hidden-skip-first">
              <input type="checkbox" data-reference-hidden-skip-first />
              <span>先頭白紙ページを除外</span>
            </label>
            <span class="reference-hidden-count"></span>
          </div>
          <div class="reference-hidden-actions">
            <button class="page-jump-btn reference-hidden-clear" type="button">選択解除</button>
            <button class="page-jump-btn reference-hidden-cancel" type="button">キャンセル</button>
            <button class="page-jump-btn page-jump-btn-primary reference-hidden-apply" type="button">反映</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    const grid = modal.querySelector(".reference-hidden-grid");
    const loading = modal.querySelector(".reference-hidden-loading");
    const count = modal.querySelector(".reference-hidden-count");
    const skipFirstInput = modal.querySelector("[data-reference-hidden-skip-first]");
    if (skipFirstInput) skipFirstInput.checked = skipFirstBlank;
    const updateCount = () => {
      if (count) {
        const parts = [];
        parts.push(selected.size ? `${selected.size}ページを非表示` : "非表示なし");
        if (skipFirstBlank) parts.push("先頭白紙除外");
        count.textContent = parts.join(" / ");
      }
      for (const btn of modal.querySelectorAll(".reference-hidden-page-card")) {
        btn.classList.toggle("hidden-selected", selected.has(Number(btn.dataset.index)));
      }
    };
    const renderCards = () => {
      if (!grid) return;
      grid.innerHTML = "";
      for (const card of cards) {
        const btn = document.createElement("button");
        btn.className = "reference-hidden-page-card";
        btn.type = "button";
        btn.dataset.index = String(card.index);
        btn.innerHTML = `
          <span class="reference-hidden-thumb">
            ${card.thumbnail ? `<img src="${card.thumbnail}" alt="">` : '<span class="reference-hidden-thumb-empty">Preview</span>'}
            <span class="reference-hidden-overlay">非表示</span>
          </span>
          <span class="reference-hidden-info">
            <span class="reference-hidden-page">${escapeHtml(card.pageLabel)}</span>
            <span class="reference-hidden-name" title="${escapeHtml(card.sourceLabel)}">${escapeHtml(card.sourceLabel)}</span>
          </span>
        `;
        btn.addEventListener("click", () => {
          const index = Number(btn.dataset.index);
          if (selected.has(index)) selected.delete(index); else selected.add(index);
          updateCount();
        });
        grid.appendChild(btn);
      }
      updateCount();
    };
    const cleanup = (value) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("keydown", onKeyDown, true);
      hideModalAnimated(modal);
      setTimeout(() => modal.remove(), 260);
      resolve(value);
    };
    modal.querySelector(".reference-hidden-close")?.addEventListener("click", () => cleanup(null));
    modal.querySelector(".reference-hidden-cancel")?.addEventListener("click", () => cleanup(null));
    modal.querySelector(".reference-hidden-clear")?.addEventListener("click", () => {
      selected.clear();
      updateCount();
    });
    skipFirstInput?.addEventListener("change", (e) => {
      skipFirstBlank = !!e.currentTarget.checked;
      updateCount();
    });
    modal.querySelector(".reference-hidden-apply")?.addEventListener("click", () => cleanup({
      hiddenPages: new Set(selected),
      skipFirstBlankPage: skipFirstBlank,
    }));
    modal.addEventListener("mousedown", (e) => {
      if (e.target === modal) cleanup(null);
    });
    const onKeyDown = (e) => {
      if (e.key === "Escape") cleanup(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    showModalAnimated(modal);
    try {
      cards = await buildReferencePageCards(paths);
      if (!cards.length) {
        if (loading) loading.textContent = "表示できる見本がありません";
        updateCount();
        return;
      }
      if (loading) loading.hidden = true;
      if (grid) grid.hidden = false;
      renderCards();
    } catch (e) {
      console.error("buildReferencePageCards failed:", e);
      if (loading) loading.textContent = "見本の読み込みに失敗しました";
      toast(`見本一覧を作成できませんでした: ${e?.message ?? e}`, { kind: "error", duration: 3500 });
    }
  });
}

function openHomeTypesetDialog() {
  return new Promise((resolve) => {
    let referencePaths = [];
    let psdPaths = [];
    let txtPath = null;
    let settled = false;
    let pickingFile = false;
    let referencePageCount = null;
    let referenceCountToken = 0;
    let excludeFirstReferencePage = false;
    let hiddenReferencePages = new Set();
    let referenceCounting = false;

    const modal = document.createElement("div");
    modal.className = "home-typeset-modal";
    modal.hidden = true;
    modal.innerHTML = `
      <div class="home-typeset-card" role="dialog" aria-modal="true" aria-labelledby="home-typeset-title">
        <div class="home-typeset-header">
          <span class="home-typeset-title" id="home-typeset-title">写植用ファイルを選択</span>
          <button class="home-typeset-close" type="button" aria-label="閉じる">×</button>
        </div>
        <div class="home-typeset-list">
          <div class="home-typeset-row" data-slot="reference">
            <div class="home-typeset-row-main">
              <span class="home-typeset-row-title">見本</span>
              <span class="home-typeset-row-desc">PDF / JPEG / PNG</span>
              <span class="home-typeset-row-file" data-file="reference">未選択</span>
            </div>
            <button class="home-typeset-pick-btn" data-pick="reference" type="button">選択</button>
          </div>
          <div class="home-typeset-row" data-slot="psd">
            <div class="home-typeset-row-main">
              <span class="home-typeset-row-title">PSD</span>
              <span class="home-typeset-row-desc">複数選択できます</span>
              <span class="home-typeset-row-file" data-file="psd">未選択</span>
            </div>
            <button class="home-typeset-pick-btn" data-pick="psd" type="button">選択</button>
          </div>
          <div class="home-typeset-row optional" data-slot="txt">
            <div class="home-typeset-row-main">
              <span class="home-typeset-row-title">テキスト</span>
              <span class="home-typeset-row-desc">未選択の場合は画像スキャン結果を使用</span>
              <span class="home-typeset-row-file" data-file="txt">未選択</span>
            </div>
            <button class="home-typeset-pick-btn" data-pick="txt" type="button">選択</button>
          </div>
        </div>
        <div class="home-typeset-actions">
          <button class="page-jump-btn home-typeset-cancel" type="button">キャンセル</button>
          <button class="page-jump-btn page-jump-btn-primary home-typeset-start" type="button" disabled>開始</button>
        </div>
      </div>
    `;
    modal.innerHTML = `
      <div class="home-typeset-card" role="dialog" aria-modal="true" aria-labelledby="home-typeset-title">
        <div class="home-typeset-header">
          <span class="home-typeset-title" id="home-typeset-title">写植用ファイルを選択</span>
          <button class="home-typeset-close" type="button" aria-label="閉じる">×</button>
        </div>
        <div class="home-typeset-list">
          <div class="home-typeset-row" data-slot="reference">
            <span class="home-typeset-check" aria-hidden="true">✓</span>
            <div class="home-typeset-row-main">
              <span class="home-typeset-row-title">見本</span>
              <span class="home-typeset-row-desc">PDF / JPEG / PNG</span>
              <span class="home-typeset-row-file" data-file="reference">未選択</span>
            </div>
            <button class="home-typeset-pick-btn" data-pick="reference" type="button">選択</button>
          </div>
          <div class="home-typeset-row" data-slot="psd">
            <span class="home-typeset-check" aria-hidden="true">✓</span>
            <div class="home-typeset-row-main">
              <span class="home-typeset-row-title">PSD</span>
              <span class="home-typeset-row-desc">複数選択できます</span>
              <span class="home-typeset-row-file" data-file="psd">未選択</span>
            </div>
            <button class="home-typeset-pick-btn" data-pick="psd" type="button">選択</button>
          </div>
          <div class="home-typeset-row optional" data-slot="txt">
            <span class="home-typeset-check" aria-hidden="true">✓</span>
            <div class="home-typeset-row-main">
              <span class="home-typeset-row-title">テキスト</span>
              <span class="home-typeset-row-desc">未選択の場合は画像スキャン結果を使用</span>
              <span class="home-typeset-row-file" data-file="txt">未選択</span>
            </div>
            <button class="home-typeset-pick-btn" data-pick="txt" type="button">選択</button>
          </div>
        </div>
        <div class="home-typeset-actions">
          <button class="page-jump-btn home-typeset-cancel" type="button">キャンセル</button>
          <button class="page-jump-btn page-jump-btn-primary home-typeset-start" type="button" disabled>開姁E/button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.querySelector(".home-typeset-title")?.insertAdjacentHTML(
      "afterend",
      '<span class="home-typeset-subtitle">ドラッグ＆ドロップ可能</span>'
    );
    const homeTypeSetLabels = {
      reference: { title: "見本", desc: "PDF / JPEG / PNG", icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><circle cx="10" cy="12" r="2"/><path d="m20 17-1.296-1.296a2.41 2.41 0 0 0-3.408 0L9 22"/></svg>' },
      psd: { title: "PSD", desc: "複数選択できます", icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/><text x="12" y="17" font-size="7" text-anchor="middle" fill="currentColor" stroke="none" style="font-family: var(--ui-font); font-weight: 700;">PSD</text></svg>' },
      txt: { title: "テキスト", desc: "未選択の場合は画像スキャン結果を使用", icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5z"/><polyline points="14 2 14 8 20 8"/><text x="12" y="19" font-size="7" text-anchor="middle" fill="currentColor" stroke="none" style="font-family: var(--ui-font); font-weight: 700;">TXT</text></svg>' },
    };
    modal.querySelector(".home-typeset-title").textContent = "写植用ファイルを選択";
    modal.querySelector(".home-typeset-close").textContent = "×";
    modal.querySelector(".home-typeset-close").setAttribute("aria-label", "閉じる");
    modal.querySelector(".home-typeset-cancel").textContent = "キャンセル";
    modal.querySelector(".home-typeset-start").textContent = "開始";
    for (const row of modal.querySelectorAll(".home-typeset-row")) {
      const info = homeTypeSetLabels[row.dataset.slot];
      if (!info) continue;
      const check = row.querySelector(".home-typeset-check");
      if (check && !row.querySelector(".home-typeset-count")) {
        check.insertAdjacentHTML("afterend", '<span class="home-typeset-count" aria-hidden="true" hidden></span>');
      }
      if (check) check.textContent = "✓";
      const title = row.querySelector(".home-typeset-row-title");
      const desc = row.querySelector(".home-typeset-row-desc");
      const file = row.querySelector(".home-typeset-row-file");
      const pick = row.querySelector(".home-typeset-pick-btn");
      if (title) title.textContent = info.title;
      if (desc) desc.textContent = info.desc;
      if (file) file.textContent = "未選択";
      if (pick) pick.textContent = "選択";
      row.querySelector(".home-typeset-row-icon")?.remove();
      row.insertAdjacentHTML("afterbegin", `<span class="home-typeset-row-icon">${info.icon}</span>`);
    }
    const referenceRow = modal.querySelector('.home-typeset-row[data-slot="reference"]');
    referenceRow?.insertAdjacentHTML(
      "beforeend",
      '<div class="home-typeset-progress" aria-hidden="true"><span></span></div>'
    );
    referenceRow?.querySelector('.home-typeset-pick-btn[data-pick="reference"]')?.insertAdjacentHTML(
      "beforebegin",
      '<button class="home-typeset-pick-btn home-typeset-hide-btn" data-reference-hide type="button" disabled>非表示選択</button>'
    );

    const startBtn = modal.querySelector(".home-typeset-start");
    const getReferenceDisplayCount = () => Number.isFinite(referencePageCount) ? referencePageCount : referencePaths.length;
    const refreshReferencePageCount = async () => {
      const token = ++referenceCountToken;
      const paths = [...referencePaths];
      referenceCounting = paths.length > 0;
      update();
      try {
        const count = await countReferencePages(paths, {
          skipFirstBlankPage: excludeFirstReferencePage,
          excludedPages: hiddenReferencePages,
        });
        if (token !== referenceCountToken) return getReferenceDisplayCount();
        referencePageCount = Number.isFinite(count) ? count : paths.length;
      } catch (e) {
        console.error("countReferencePages failed:", e);
        if (token !== referenceCountToken) return getReferenceDisplayCount();
        referencePageCount = paths.length;
      } finally {
        if (token === referenceCountToken) {
          referenceCounting = false;
          update();
        }
      }
      return getReferenceDisplayCount();
    };
    const update = () => {
      const refEl = modal.querySelector('[data-file="reference"]');
      const psdEl = modal.querySelector('[data-file="psd"]');
      const txtEl = modal.querySelector('[data-file="txt"]');
      if (refEl) refEl.textContent = homeFlowFileSummary(referencePaths, "未選択");
      if (psdEl) psdEl.textContent = homeFlowFileSummary(psdPaths, "未選択");
      if (txtEl) txtEl.textContent = homeFlowFileSummary(txtPath, "未選択");
      if (refEl && referencePaths.length === 0) refEl.textContent = "未選択";
      if (psdEl && psdPaths.length === 0) psdEl.textContent = "未選択";
      if (txtEl && !txtPath) txtEl.textContent = "未選択";
      for (const row of modal.querySelectorAll(".home-typeset-row")) {
        const slot = row.dataset.slot;
        const active =
          slot === "reference" ? referencePaths.length > 0 :
          slot === "psd" ? psdPaths.length > 0 :
          !!txtPath;
        const count =
          slot === "reference" ? getReferenceDisplayCount() :
          slot === "psd" ? psdPaths.length :
          txtPath ? 1 : 0;
        const countEl = row.querySelector(".home-typeset-count");
        if (countEl) {
          countEl.textContent = count > 0 ? String(count) : "";
          countEl.hidden = count === 0;
        }
        row.classList.toggle("loading", slot === "reference" && referenceCounting);
        row.classList.toggle("selected", active);
      }
      const hideBtn = modal.querySelector("[data-reference-hide]");
      if (hideBtn) {
        hideBtn.disabled = referencePaths.length === 0 || referenceCounting;
        hideBtn.classList.toggle("selected", hiddenReferencePages.size > 0 || excludeFirstReferencePage);
        if (hiddenReferencePages.size > 0 && excludeFirstReferencePage) {
          hideBtn.textContent = `非表示 ${hiddenReferencePages.size} / 白紙除外`;
        } else if (hiddenReferencePages.size > 0) {
          hideBtn.textContent = `非表示 ${hiddenReferencePages.size}`;
        } else if (excludeFirstReferencePage) {
          hideBtn.textContent = "白紙除外";
        } else {
          hideBtn.textContent = "非表示選択";
        }
      }
      if (startBtn) startBtn.disabled = referencePaths.length === 0 || psdPaths.length === 0;
    };

    const applyDroppedPaths = async (paths, slot = null) => {
      if (!Array.isArray(paths) || paths.length === 0) return false;
      let handled = false;
      const applyToSlot = async (kind) => {
        const filtered = await homeFlowResolveDroppedPaths(paths, kind);
        if (filtered.length === 0) return;
        if (kind === "reference") {
          referencePaths = filtered;
          hiddenReferencePages = new Set();
          excludeFirstReferencePage = false;
          referencePageCount = null;
          void refreshReferencePageCount();
        }
        else if (kind === "psd") psdPaths = filtered;
        else if (kind === "txt") txtPath = filtered[0] ?? null;
        handled = true;
      };
      if (slot) {
        await applyToSlot(slot);
      } else {
        await applyToSlot("reference");
        await applyToSlot("psd");
        await applyToSlot("txt");
      }
      if (handled) {
        update();
        clearDragOverRows();
      } else {
        toast("対応しているファイルをドロップしてください", { kind: "warning", duration: 2200 });
      }
      return handled;
    };

    const clearDragOverRows = () => {
      for (const row of modal.querySelectorAll(".home-typeset-row.drag-over")) {
        row.classList.remove("drag-over");
      }
    };

    const slotFromPaths = (paths) => {
      const list = (Array.isArray(paths) ? paths : [paths])
        .filter((p) => typeof p === "string" && p.length > 0);
      if (list.some((p) => /\.psd$/i.test(p))) return "psd";
      if (list.some((p) => /\.(pdf|jpe?g|png)$/i.test(p))) return "reference";
      if (list.some((p) => /\.txt$/i.test(p))) return "txt";
      return list.length > 0 ? "psd" : null;
    };

    const rowFromClientPoint = (x, y) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      const direct = document.elementFromPoint(x, y)?.closest?.(".home-typeset-row");
      if (direct && modal.contains(direct)) return direct;
      for (const row of modal.querySelectorAll(".home-typeset-row")) {
        const rect = row.getBoundingClientRect();
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return row;
      }
      return null;
    };

    const slotFromDropPayload = (payload) => {
      const positions = [
        payload?.logicalPosition,
        payload?.position,
        payload?.physicalPosition,
      ];
      const dpr = window.devicePixelRatio || 1;
      for (const position of positions) {
        const x = Number(position?.x ?? position?.[0]);
        const y = Number(position?.y ?? position?.[1]);
        const row = rowFromClientPoint(x, y) || (dpr !== 1 ? rowFromClientPoint(x / dpr, y / dpr) : null);
        if (row) return row.dataset.slot || null;
      }
      return modal.querySelector(".home-typeset-row.drag-over")?.dataset?.slot
        || slotFromPaths(payload?.paths);
    };

    const handleHomeTypesetDragOver = (payload) => {
      if (settled || pickingFile || modal.hidden) return false;
      const slot = slotFromDropPayload(payload);
      let matched = false;
      for (const row of modal.querySelectorAll(".home-typeset-row")) {
        const active = row.dataset.slot === slot;
        row.classList.toggle("drag-over", active);
        matched = matched || active;
      }
      return matched;
    };

    const handleHomeTypesetDrop = (paths, payload) => {
      if (settled || pickingFile || modal.hidden) return false;
      void applyDroppedPaths(paths, slotFromDropPayload(payload));
      return true;
    };

    const cleanup = (value) => {
      if (settled) return;
      settled = true;
      if (homeTypesetDropHandler === handleHomeTypesetDrop) homeTypesetDropHandler = null;
      if (homeTypesetDragOverHandler === handleHomeTypesetDragOver) homeTypesetDragOverHandler = null;
      if (homeTypesetDragLeaveHandler === clearDragOverRows) homeTypesetDragLeaveHandler = null;
      window.removeEventListener("keydown", onKeyDown, true);
      hideModalAnimated(modal);
      setTimeout(() => modal.remove(), 260);
      resolve(value);
    };
    const onKeyDown = (e) => {
      if (pickingFile) return;
      if (e.key === "Escape") cleanup(null);
    };
    const pickWithHomeDialogHidden = async (pickFn) => {
      pickingFile = true;
      modal.classList.remove("visible");
      modal.hidden = true;
      try {
        return await pickFn();
      } finally {
        pickingFile = false;
        if (!settled) showModalAnimated(modal);
      }
    };

    modal.querySelector(".home-typeset-close")?.addEventListener("click", () => cleanup(null));
    modal.querySelector(".home-typeset-cancel")?.addEventListener("click", () => cleanup(null));
    modal.querySelector("[data-reference-hide]")?.addEventListener("click", async () => {
      if (referencePaths.length === 0 || referenceCounting) return;
      const next = await openReferenceHiddenPicker(referencePaths, hiddenReferencePages, excludeFirstReferencePage);
      if (!next) return;
      hiddenReferencePages = next.hiddenPages instanceof Set ? next.hiddenPages : new Set(next.hiddenPages || []);
      excludeFirstReferencePage = !!next.skipFirstBlankPage;
      referencePageCount = null;
      update();
      void refreshReferencePageCount();
    });
    modal.addEventListener("mousedown", (e) => {
      if (pickingFile) return;
      if (e.target === modal) cleanup(null);
    });
    modal.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-pick]");
      if (!btn) return;
      const kind = btn.dataset.pick;
      btn.disabled = true;
      try {
        if (kind === "reference") {
          referencePaths = await pickWithHomeDialogHidden(() => pickReferenceFiles());
          hiddenReferencePages = new Set();
          excludeFirstReferencePage = false;
          referencePageCount = null;
          void refreshReferencePageCount();
        } else if (kind === "psd") {
          psdPaths = await pickWithHomeDialogHidden(() => pickPsdFiles());
        } else if (kind === "txt") {
          txtPath = await pickWithHomeDialogHidden(() => pickTxtPath());
        }
        update();
      } catch (err) {
        console.error(err);
        toast(`ファイル選択に失敗しました: ${err?.message ?? err}`, { kind: "error", duration: 3500 });
      } finally {
        if (!settled) btn.disabled = false;
      }
    });
    for (const row of modal.querySelectorAll(".home-typeset-row")) {
      row.addEventListener("dragenter", (e) => {
        e.preventDefault();
        row.classList.add("drag-over");
      });
      row.addEventListener("dragover", (e) => {
        e.preventDefault();
        row.classList.add("drag-over");
      });
      row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
      row.addEventListener("drop", (e) => {
        e.preventDefault();
        row.classList.remove("drag-over");
        const paths = Array.from(e.dataTransfer?.files ?? [])
          .map((file) => file.path || file.name)
          .filter(Boolean);
        void applyDroppedPaths(paths, row.dataset.slot);
      });
    }
    startBtn?.addEventListener("click", async () => {
      if (referencePaths.length === 0 || psdPaths.length === 0) return;
      const referenceCount = await refreshReferencePageCount();
      if (referenceCount !== psdPaths.length) {
        await notifyDialog({
          title: "ファイル数が一致しません",
          message: `見本は${referenceCount}件、PSDは${psdPaths.length}件です。ファイル数を揃えてから開始してください。`,
          okLabel: "OK",
          kind: "warning",
        });
        return;
      }
      cleanup({ referencePaths, psdPaths, txtPath, excludeFirstReferencePage, hiddenReferencePages: [...hiddenReferencePages] });
    });
    window.addEventListener("keydown", onKeyDown, true);
    homeTypesetDropHandler = handleHomeTypesetDrop;
    homeTypesetDragOverHandler = handleHomeTypesetDragOver;
    homeTypesetDragLeaveHandler = clearDragOverRows;
    update();
    showModalAnimated(modal);
  });
}

async function transitionFromHome() {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  document.body.classList.add("home-starting");
  await wait(360);
  hideHomeScreen();
  document.body.classList.remove("home-starting");
  await new Promise((resolve) => requestAnimationFrame(resolve));
}

async function startHomeTypesetFlow() {
  const picked = await openHomeTypesetDialog();
  if (!picked) return;
  await transitionFromHome();
  try {
    clearAiOcrDoc();
    await loadReferenceFiles(picked.referencePaths, {
      skipFirstBlankPage: !!picked.excludeFirstReferencePage,
      excludedPages: picked.hiddenReferencePages,
    });
    await loadPsdFilesByPaths(picked.psdPaths, { icon: PLACE_ICON_SVG, label: "自動配置中…" });
    if (!getPages().length) return;
    if (picked.txtPath) await loadTxtFromPath(picked.txtPath);
    await runAutoPlace({
      allowOcrText: true,
      preserveTxtDuringOcr: !!picked.txtPath,
    });
  } catch (e) {
    console.error(e);
    await notifyDialog({
      title: "写植を開始できません",
      message: String(e?.message ?? e ?? "不明なエラー"),
    });
  }
}

async function startHomeTranscribeFlow() {
  let files = [];
  try {
    files = await pickReferenceFiles();
  } catch (e) {
    console.error(e);
    toast(`ファイル選択に失敗しました: ${e?.message ?? e}`, { kind: "error", duration: 3500 });
    return;
  }
  if (!files.length) return;

  await transitionFromHome();
  try {
    clearAiOcrDoc();
    await loadReferenceFiles(files);
    await runAiOcrForTranscription(files);
    setParallelViewMode("editor");
    setEditorLeftPaneMode("pdf");
    setActivePane("pdf");
    requestAnimationFrame(() => focusEditor());
  } catch (e) {
    console.error(e);
    await notifyDialog({
      title: "書き起こしを開始できません",
      message: String(e?.message ?? e ?? "不明なエラー"),
    });
  }
}

function bindHomeScreen() {
  document.getElementById("home-transcribe-start-btn")?.addEventListener("click", () => { void startHomeTranscribeFlow(); });
  document.getElementById("home-typeset-start-btn")?.addEventListener("click", () => { void startHomeTypesetFlow(); });
  showHomeScreen();
}

async function syncHomeVersionLabel() {
  const el = document.getElementById("home-version");
  if (!el) return;
  let version = packageInfo?.version;
  try {
    version = await getVersion();
  } catch (_) {
    // Browser-only dev falls back to package.json.
  }
  el.textContent = version ? `Ver ${version}` : "Ver -";
}

async function closeStartupSplash() {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("close_splash");
  } catch (e) {
    // Browser-only dev and already-visible windows do not have the splash command.
    console.debug("close_splash skipped:", e);
  }
}

function init() {
  void syncHomeVersionLabel();
  document.getElementById("open-folder-btn").addEventListener("click", handleOpenFiles);
  document.getElementById("open-pdf-btn")?.addEventListener("click", handleOpenPdf);
  bindSaveMenu();
  bindHistoryButtons();
  initHamburgerMenu();
  bindTools();
  bindSizeTool();
  bindLeadingTool();
  bindBoldToggle();
  bindRubyTool();
  bindZoomTool();
  bindPageChange();
  bindStylePalette();
  initFontBookPanel();
  bindEditorEvents();
  bindWindowControls();
  bindHomeScreen();
  bindPageJumpDialog();
  initTxtSource();
  bindAiInstallMenu();
  bindFirstRunSetup();
  bindAiOcrButton();
  bindAiPlaceButton();
  bindPositionAdjustButton();
  bindProofreadUi();
  bindAutoUpdater();
  bindPageNav();
  bindCollapseToggles();
  bindSidePanelTabs();
  bindLayersDrawer();
  bindPdfWorkspaceToggle();
  bindPdfRotate();
  bindPsdRotate();
  updatePsdRotateVisibility();
  bindPsdGuidesLock();
  updatePsdGuidesLockVisibility();
  bindPsdGuidesApply();
  updatePsdGuidesApplyVisibility();
  mountPdfView();
  setupTauriDragDrop();
  bindParallelSync();
  bindWheelPageNav();
  bindActivePaneTracking();
  bindResyncModal();
  bindViewModeControls();
  // editor pane の初期化を view-mode 刁E��より先に行う、E
  // bindParallelViewMode の sync() ぁEeditor モードで focusEditor() を呼ぶ前に
  // textarea めEsyncFromState() で正しい状態にしておく、E
  bindEditorPane();
  bindParallelViewMode();
  initSettingsUi();
  // 環墁E��定�E「デフォルト」（文字サイズ・行間・フチ太さ�Eフォント）をチE�Eル初期値に反映、E
  applyToolDefaults();
  // 【v1.29.0】ルビあり行間 (%) めECSS variable で全体に伝達、E
  //   styles.css の .ruby-text transform で「親斁E��行と前�E行�EちめE��ど中間」位置を計算する、E
  //   設宁E(写植設定タチEↁEルビあり行間) を変えると即時更新、E
  // 【v1.29.x】さらに --ruby-parent-offset-em (UI 親寁E�� em) も同期する、E
  //   これにより設定値の変更がビューアー上�Eルビ位置に即時反映される、E
  //   Photoshop 側の親寁E�� em / 親離ぁEpx は exportEdits 経由で payload に乗る (後段)、E
  const applyRubyCssVars = () => {
    const pct = Number(getDefault("rubyLeadingPct")) || 150;
    document.documentElement.style.setProperty("--ruby-row-leading-pct", String(pct));
    const uiOffsetEm = Number(getDefault("rubyParentOffsetEm"));
    document.documentElement.style.setProperty(
      "--ruby-parent-offset-em",
      Number.isFinite(uiOffsetEm) ? String(uiOffsetEm) : "0",
    );
    // 既存レイヤーの ruby-text 位置を即時�E描画 (CSS variable 更新だけでは
    // 一部のブラウザで親要素の inline-block ボックス計算が遁E��するため明示皁E��再描画)、E
    try { refreshAllOverlays(); } catch (_) {}
  };
  applyRubyCssVars();
  onSettingsChange(applyRubyCssVars);
  renderAllSpreads();
  loadFontsFromBackend();
  // フォントが非同期で登録されるたびにオーバ�Eレイを�E描画して反映、E
  onFontsRegistered(() => refreshAllOverlays());
  bindGlobalBlurOnOutsideClick();
  initRulers();
  bindRulerToggle();
  bindNewTextDirectionToggle();
  bindViewerMode();
  // services/psd-load.js から読込フェーズの節目で投げられるイベントを購読し、E
  // ペ�Eジバ�E / 回転ボタン / ガイドロチE��ボタンの可視状態を同期する、E
  // psd-load.js 側は main.js を直接 import しなぁE�Eで、循環参�Eを避けつつ
  // UI 更新フックを差し込めるようにこ�E 1 箁E��に雁E��E��てぁE��、E
  window.addEventListener("psdesign:psd-loaded", () => {
    updatePageNav();
    updatePsdRotateVisibility();
    updatePsdGuidesLockVisibility();
    updatePsdGuidesApplyVisibility();
  });
  // 初回起動セチE��アチE�E画面: AI 未インスト�Eル かつ 未スキチE�Eの初回のみ表示、E
  // await しなぁE 冁E��の checkAiModelsStatus は非同期だが他�E起動�E琁E��遁E��せなぁE��E
  maybeShowFirstRunSetup();
  void closeStartupSplash();
}

// INPUT/TEXTAREA/contenteditable 以外をクリチE��したら、現在フォーカス中のチE��スト�E力かめE
// フォーカスを外す。Space でパンを�Eり替えた際に入力欁E��斁E��が入る事故を防ぐ、E
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
    // 入力欁E�E身めE��れに紐づぁEUI�E�コンボ�EチE��ス・ドロチE�Eダウン等）�E中をクリチE��したとき�E維持E
    if (target === active || active.contains(target)) return;
    // editor パネル冁E�EクリチE��も安�Eゾーンに含める。in-place 編雁Etextarea ぁEactive な
    // ときに行間 input / +/- / ルビ�Eタンを触っても勝手に textarea ぁEblur しなぁE��ぁE��する、E
    const near = target.closest?.("input, textarea, [contenteditable], .style-palette, .save-menu, .layer-box.editing, .editor");
    if (near) return;
    active.blur();
  }, true);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
