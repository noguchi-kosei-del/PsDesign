import { buildReferencePageCards, countReferencePages, loadReferenceFiles, pickReferenceFiles } from "./pdf-loader.js";
import { getVersion } from "@tauri-apps/api/app";
import packageInfo from "../package.json";
import { capturePdfViewportCenter, mountPdfView, PDF_FIT_BASE_SCALE, PDF_FIT_ZOOM, resetPdfViewportToStart, schedulePdfStageLayoutRefresh } from "./pdf-view.js";
import {
  cycleLayerSelection,
  deleteSelectedLayers,
  commitActiveInPlaceEdit,
  nudgeSelectedLayers,
  showRotationHandlesForSelectedLayers,
  refreshAllOverlays,
  snapNextSize,
  getLastInplaceSelection,
  onInplaceSelectionChange,
  applyEditModeStyleToRange,
  restoreInplaceSelection,
  applyEditModeRubyToRange,
  removeEditModeRubyFromRange,
  getExistingLayerEffectiveSizePt,
  toggleSelectionAdornmentsVisible,
} from "./canvas-tools.js";
import { onFontsRegistered } from "./font-loader.js";
import { capturePsdViewportCenter, PSD_FIT_BASE_SCALE, PSD_FIT_ZOOM, renderAllSpreads, resetPsdViewportToStart, schedulePsdStageLayoutRefresh } from "./spread-view.js";
import {
  bindEditorEvents,
  commitBoldToSelections,
  commitItalicToSelections,
  commitLeadingToSelections,
  commitSelectedLayerField,
  commitSizeToSelections,
  computeCommonBold,
  hasSelection,
  rebuildLayerList,
  syncBoldToggle,
  syncItalicToggle,
  unifySelectedTextSize,
} from "./text-editor.js";
import { cycleTxtBlockSelection, deleteSelectedTxtBlock, getTxtPageCount, initTxtSource, loadTxtFromPath, pickTxtPath } from "./txt-source.js";
import { bindScanInstallMenu } from "./scan-install.js";
import { bindFirstRunSetup, maybeShowFirstRunSetup } from "./first-run-setup.js";
import { bindScanExtractButton, PLACE_ICON_SVG, runScanExtractForTranscription } from "./scan-extract.js";
import {
  bindScanPlaceButton,
  bindPositionAdjustButton,
  choosePositionAdjustMode,
  runAutoPlace,
  runSelectedPositionAdjust,
} from "./auto-place.js";
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
  clearScanExtractDoc,
  clearPages,
  getActivePane,
  getCurrentPageIndex,
  getNewLayersForPsd,
  getPages,
  getParallelSyncMode,
  getParallelViewMode,
  getPdfDoc,
  getPdfExcludedReferencePages,
  getPdfPageIndex,
  getPdfPaths,
  getPdfRotation,
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
  setPdfExcludedReferencePages,
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
  setCharSizesRange,
  setCharBoldsRange,
  setCharItalicsRange,
  setCharRubiesRange,
  removeCharRubyAt,
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
  const syncDisabled = () => {
    btn.disabled = getPages().length === 0 || !hasAnyGuide();
  };
  btn.addEventListener("click", () => toggleGuidesLocked());
  onGuidesLockedChange(syncPressed);
  onGuidesChange(syncDisabled);
  onPageIndexChange(syncDisabled);
  syncPressed();
  syncDisabled();
  const updateVis = () => {
    btn.hidden = !getRulersVisible();
  };
  onRulersVisibleChange(updateVis);
  updateVis();
}

function updatePsdGuidesLockVisibility() {
  const btn = document.getElementById("psd-guides-lock-btn");
  if (!btn) return;
  btn.hidden = !getRulersVisible();
  btn.disabled = getPages().length === 0 || !hasAnyGuide();
}

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
  btn.hidden = !getRulersVisible();
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
        ? "現在のページにガイドがありません"
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
    console.warn("フォント一覧の取得に失敗", e);
  }
}

let panPreviousTool = null;
let panSpaceActive = false;
let selectionAdornmentChordActive = false;
let selectionAdornmentChordHadOtherKey = false;

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

function isCtrlLikeKey(e) {
  return e.key === "Control" || e.code === "ControlLeft" || e.code === "ControlRight";
}

function isMetaKey(e) {
  return e.key === "Meta" || e.code === "MetaLeft" || e.code === "MetaRight";
}

function isShiftKey(e) {
  return e.key === "Shift" || e.code === "ShiftLeft" || e.code === "ShiftRight";
}

function isCtrlShiftAdornmentChord(e) {
  return e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey;
}

function handleSelectionAdornmentChordKeydown(e) {
  if (selectionAdornmentChordActive) {
    if (isMetaKey(e) || !isCtrlShiftAdornmentChord(e) || (!isCtrlLikeKey(e) && !isShiftKey(e))) {
      selectionAdornmentChordHadOtherKey = true;
    }
  }

  if (!isCtrlShiftAdornmentChord(e) || (!isCtrlLikeKey(e) && !isShiftKey(e))) {
    return false;
  }

  if (!selectionAdornmentChordActive) {
    selectionAdornmentChordActive = true;
    selectionAdornmentChordHadOtherKey = false;
  }
  e.preventDefault();
  return true;
}

function handleSelectionAdornmentChordKeyup(e) {
  if (!selectionAdornmentChordActive) return false;
  if (isMetaKey(e)) {
    selectionAdornmentChordHadOtherKey = true;
    return false;
  }
  if (!isCtrlLikeKey(e) && !isShiftKey(e)) return false;

  const shouldToggle = !selectionAdornmentChordHadOtherKey && getSelectedLayers().length > 0;
  if (!e.ctrlKey || !e.shiftKey || e.metaKey) {
    selectionAdornmentChordActive = false;
    selectionAdornmentChordHadOtherKey = false;
  }
  if (!shouldToggle) return false;

  const visible = toggleSelectionAdornmentsVisible();
  toast(visible ? "選択表示を表示しました" : "選択表示を非表示にしました", {
    kind: "info",
    duration: 1200,
  });
  e.preventDefault();
  return true;
}

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
    title: "編集をすべて削除",
    message: "現在の編集内容をすべて削除します。",
    confirmLabel: "すべて削除",
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
  onHistoryChange(() => {
    updateHistoryButtons();
    refreshAllOverlays();
    rebuildLayerList();
  });
  updateHistoryButtons();
}

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

  const suppressAltMenuActivation = (e) => {
    if (e.key === "Alt" || e.code === "AltLeft" || e.code === "AltRight") {
      e.preventDefault();
    }
  };
  window.addEventListener("keydown", suppressAltMenuActivation);
  window.addEventListener("keyup", suppressAltMenuActivation);

  window.addEventListener("keydown", (e) => {
    if (handleSelectionAdornmentChordKeydown(e)) return;

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

    const target = e.target;
    const isTextInput =
      target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

    if (
      !isTextInput &&
      (e.ctrlKey || e.metaKey) &&
      !e.altKey &&
      String(e.key).toLowerCase() === "t"
    ) {
      if (showRotationHandlesForSelectedLayers()) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }

    const isArrowKey =
      e.key === "ArrowLeft" || e.key === "ArrowRight" ||
      e.key === "ArrowUp" || e.key === "ArrowDown";

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
          const delta = e.key === "ArrowDown" ? +1 : -1;
          cycleLayerSelection(delta);
          e.preventDefault();
          return;
        }
      }
    }

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

    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        if (undo()) { /* UI updates via listener */ }
        return;
      }
      if (k === "y" || (k === "z" && e.shiftKey)) {
        e.preventDefault();
        if (redo()) { /* UI updates via listener */ }
        return;
      }
      if (e.key === "Delete" || e.code === "Delete") {
        e.preventDefault();
        handleClearAllEdits();
        return;
      }
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

    const id = findShortcutMatch(e);
    if (!id) return;
    if (isShortcutBlockedInInput(id, e.target)) return;
    if (e.repeat && isPageNavShortcut(id) && !canAdvancePageNow()) return;
    e.preventDefault();
    runShortcut(id, e);
  });

  window.addEventListener("keyup", (e) => {
    if (handleSelectionAdornmentChordKeyup(e)) return;

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
    selectionAdornmentChordActive = false;
    selectionAdornmentChordHadOtherKey = false;
  });
}

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
  onTxtSourceChange(() => {
    if (getPages().length === 0 && getPdfVirtualPageCount() === 0) {
      const total = getTxtPageCount();
      if (total > 0 && getPdfPageIndex() > total - 1) setPdfPageIndex(0);
    }
    updatePageNav();
  });
}

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

const SIDE_PANEL_TAB_KEY = "psdesign_side_panel_tab";
function loadSidePanelTab() {
  try {
    const v = localStorage.getItem(SIDE_PANEL_TAB_KEY);
    if (v === "txt" || v === "editor") return v;
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
  if (tab !== "txt" && tab !== "editor") tab = "txt";
  if (tab === "editor" && !hasTextForEditorTab()) tab = "txt";
  for (const btn of document.querySelectorAll(".side-panel-tab")) {
    const isActive = btn.dataset.tab === tab;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-selected", isActive ? "true" : "false");
  }
  for (const sec of document.querySelectorAll(".side-panel .panel-section")) {
    sec.hidden = sec.dataset.section !== tab;
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
      e.stopPropagation();
      toggleLayersDrawer();
    });
  }
  const closeBtn = document.getElementById("layers-drawer-close-btn");
  if (closeBtn) closeBtn.addEventListener("click", closeLayersDrawer);
  document.addEventListener("mousedown", (e) => {
    if (!isLayersDrawerOpen()) return;
    const drawer = document.getElementById("layers-drawer");
    const triggerBtn = document.getElementById("layers-toggle-btn");
    if (drawer && drawer.contains(e.target)) return;
    if (triggerBtn && triggerBtn.contains(e.target)) return;
    closeLayersDrawer();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isLayersDrawerOpen()) {
      closeLayersDrawer();
    }
  });
}

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

const ARROW_REPEAT_THROTTLE_MS = 80;
let lastArrowAdvanceAt = 0;
function canAdvancePageNow() {
  const now = performance.now();
  if (now - lastArrowAdvanceAt < ARROW_REPEAT_THROTTLE_MS) return false;
  lastArrowAdvanceAt = now;
  return true;
}

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
  else setPdfPageIndex(idx);
}

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
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (pane === "pdf" && e.target?.closest?.(".pdf-font-book-stage")) return;
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
  setParallelSyncMode(true);
  setActivePane("psd");
}

const VIEW_MODE_LS_KEY = "psdesign_parallel_view_mode";
const EDITOR_LEFT_PANE_LS_KEY = "psdesign_editor_left_pane_mode";

function bindParallelViewMode() {
  const parallelBtn = document.getElementById("view-parallel-btn");
  const proofreadBtn = document.getElementById("view-proofread-btn");
  const editorBtn = document.getElementById("view-editor-btn");
  const proofreadArea = document.getElementById("spreads-proofread-area");
  const editorArea = document.getElementById("spreads-editor-area");
  const proofreadPanel = document.getElementById("proofread-panel");
  const leftProofreadBtn = document.getElementById("editor-left-proofread-btn");
  const leftPdfBtn = document.getElementById("editor-left-pdf-btn");
  if (!parallelBtn || !proofreadBtn || !editorBtn || !proofreadArea || !editorArea || !proofreadPanel) return;

  try {
    const saved = localStorage.getItem(VIEW_MODE_LS_KEY);
    if (saved === "parallel" || saved === "proofread" || saved === "editor") {
      setParallelViewMode(saved);
    }
  } catch {}

  try {
    const savedLeft = localStorage.getItem(EDITOR_LEFT_PANE_LS_KEY);
    if (savedLeft === "proofread" || savedLeft === "pdf") {
      setEditorLeftPaneMode(savedLeft);
    }
  } catch {}

  let pendingPsdViewportCenter = null;
  let lastParallelPsdViewportCenter = null;
  let pendingPdfViewportCenter = null;
  let lastParallelPdfViewportCenter = null;
  const switchViewMode = (mode) => {
    const currentMode = getParallelViewMode();
    const visiblePsdCenter = currentMode === "parallel"
      ? capturePsdViewportCenter()
      : lastParallelPsdViewportCenter;
    const visiblePdfCenter = currentMode === "parallel"
      ? capturePdfViewportCenter()
      : lastParallelPdfViewportCenter;
    if (currentMode === "parallel" && mode !== "parallel") {
      lastParallelPsdViewportCenter = visiblePsdCenter;
      lastParallelPdfViewportCenter = visiblePdfCenter;
    }
    pendingPsdViewportCenter = mode === "parallel"
      ? (lastParallelPsdViewportCenter ?? visiblePsdCenter)
      : visiblePsdCenter;
    pendingPdfViewportCenter = mode === "parallel"
      ? (lastParallelPdfViewportCenter ?? visiblePdfCenter)
      : visiblePdfCenter;
    setParallelViewMode(mode);
  };
  parallelBtn.addEventListener("click", () => switchViewMode("parallel"));
  proofreadBtn.addEventListener("click", () => switchViewMode("proofread"));
  editorBtn.addEventListener("click", () => switchViewMode("editor"));
  if (leftProofreadBtn) {
    leftProofreadBtn.addEventListener("click", () => setEditorLeftPaneMode("proofread"));
  }
  if (leftPdfBtn) {
    leftPdfBtn.addEventListener("click", () => setEditorLeftPaneMode("pdf"));
  }

  //
  const workspace = document.querySelector(".workspace");
  const stage = document.getElementById("spreads-stage");
  const applyEditorLeftPaneClass = () => {
    if (!workspace) return;
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
    applyEditorLeftPaneClass();

    if (showProofread || showEditor) openProofread();

    if (showEditor) focusEditor();

    const viewportCenter = pendingPsdViewportCenter;
    pendingPsdViewportCenter = null;
    schedulePsdStageLayoutRefresh({ recenter: !viewportCenter, viewportCenter });
    const pdfViewportCenter = pendingPdfViewportCenter;
    pendingPdfViewportCenter = null;
    schedulePdfStageLayoutRefresh({ recenter: !pdfViewportCenter, viewportCenter: pdfViewportCenter });
  };
  onParallelViewModeChange(sync);

  const PANEL_PADDING = 32;
  const HEADER_OFFSET = 34; // proofread-panel-header height
  const MIN_PANEL_WIDTH = 240;
  const MAX_PANEL_RATIO = 0.85;
  let leftPdfRecomputeRaf = 0;
  let leftPdfRecomputeSeq = 0;

  const clearLeftPdfWidth = () => {
    if (workspace) workspace.style.removeProperty("--left-pdf-width");
  };

  const recomputeLeftPdfWidth = async () => {
    if (!workspace) return;
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
    if (seq !== leftPdfRecomputeSeq) return;
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

  onPdfChange(requestRecomputeLeftPdfWidth);
  onPdfPageIndexChange(requestRecomputeLeftPdfWidth);
  onPdfRotationChange(requestRecomputeLeftPdfWidth);
  onParallelViewModeChange(requestRecomputeLeftPdfWidth);
  if (typeof ResizeObserver !== "undefined" && stage) {
    const ro = new ResizeObserver(requestRecomputeLeftPdfWidth);
    ro.observe(stage);
  }
  requestRecomputeLeftPdfWidth();

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

function applyTextSize(n) {
  const sel = getLastInplaceSelection();
  if (sel && sel.end > sel.start) {
    const v = clampSize(n);
    const targetId = sel.tempId ?? sel.layerId;
    setCharSizesRange(sel.psdPath, targetId, sel.start, sel.end, v);
    const defaultSizePt = resolveLayerDefaultSizePt(sel);
    if (defaultSizePt > 0) {
      const ratio = v / defaultSizePt;
      applyEditModeStyleToRange(sel.start, sel.end, { fontSize: `${ratio}em` });
    }
    refreshAllOverlays();
    rebuildLayerList();
    restoreInplaceSelection(sel);
    requestAnimationFrame(() => restoreInplaceSelection(sel));
    setTextSize(v);
    return;
  }
  setTextSize(n);
  commitSizeToSelections(getTextSize());
}

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
      return getExistingLayerEffectiveSizePt(page, layer, edit) || 0;
    }
    if (typeof sel.tempId === "string") {
      const nl = page.textLayers;
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

function stepTextSize(sign, multiplier = 1) {
  const baseStep = getSizeStep();
  const next = snapNextSize(getTextSize(), baseStep, sign, multiplier);
  applyTextSize(next);
}

function bindBoldToggle() {
  const btn = document.getElementById("bold-toggle-btn");
  if (!btn) return;
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", () => {
    if (btn.disabled) return;
    const newValue = btn.getAttribute("aria-pressed") !== "true";
    const sel = getLastInplaceSelection();
    if (sel && sel.end > sel.start) {
      const targetId = sel.tempId ?? sel.layerId;
      setCharBoldsRange(sel.psdPath, targetId, sel.start, sel.end, newValue);
      applyEditModeStyleToRange(sel.start, sel.end, { fontWeight: newValue ? "700" : "400" });
      refreshAllOverlays();
      rebuildLayerList();
      btn.setAttribute("aria-pressed", newValue ? "true" : "false");
      return;
    }
    if (commitBoldToSelections(newValue)) {
      btn.setAttribute("aria-pressed", newValue ? "true" : "false");
    }
  });
}

function bindItalicToggle() {
  const btn = document.getElementById("italic-toggle-btn");
  if (!btn) return;
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", () => {
    if (btn.disabled) return;
    const newValue = btn.getAttribute("aria-pressed") !== "true";
    const sel = getLastInplaceSelection();
    if (sel && sel.end > sel.start) {
      const targetId = sel.tempId ?? sel.layerId;
      setCharItalicsRange(sel.psdPath, targetId, sel.start, sel.end, newValue);
      applyEditModeStyleToRange(sel.start, sel.end, { fontStyle: newValue ? "italic" : "normal" });
      refreshAllOverlays();
      rebuildLayerList();
      btn.setAttribute("aria-pressed", newValue ? "true" : "false");
      return;
    }
    if (commitItalicToSelections(newValue)) {
      btn.setAttribute("aria-pressed", newValue ? "true" : "false");
    }
  });
}

function bindRubyTool() {
  const panelEl = document.querySelector(".editor-tab-panel[data-tab-panel='ruby']");
  const parentEl = document.getElementById("ruby-parent-display");
  const inputEl = document.getElementById("ruby-text-input");
  const scaleEl = document.getElementById("ruby-scale-input");
  const applyBtn = document.getElementById("ruby-apply-btn");
  const removeBtn = document.getElementById("ruby-remove-btn");
  const modeAuto = document.getElementById("ruby-mode-auto-btn");
  const modeMono = document.getElementById("ruby-mode-mono-btn");
  const modeGroup = document.getElementById("ruby-mode-group-btn");
  if (!panelEl || !parentEl || !inputEl || !applyBtn || !removeBtn) return;

  let currentMode = "auto"; // "auto" | "mono" | "group"
  const panelHome = panelEl.parentElement;
  const panelPlaceholder = document.createComment("ruby-panel-home");
  if (panelHome) panelHome.insertBefore(panelPlaceholder, panelEl);
  panelEl.hidden = true;
  if (panelEl.parentElement !== document.body) document.body.appendChild(panelEl);

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
    if (/[ \u3000]/.test(text)) {
      const parts = text.split(/[ \u3000]+/);
      if (parts.length === parentText.length) return "mono";
    }
    return "group";
  };

  const currentRubyTarget = () => {
    const sel = getLastInplaceSelection();
    if (sel && sel.end > sel.start) {
      const ec = getEditingContext();
      return { ...sel, contents: String(ec?.contents ?? ""), objectSelection: false };
    }
    return null;
  };

  const restoreRubyPanelHome = () => {
    panelEl.classList.remove("ruby-panel-floating");
    panelEl.style.left = "";
    panelEl.style.top = "";
    panelEl.style.maxHeight = "";
    panelEl.style.overflowY = "";
    panelEl.hidden = true;
    if (panelEl.parentElement !== document.body) document.body.appendChild(panelEl);
  };

  const placeRubyPanelNearText = () => {
    const target = currentRubyTarget();
    if (!target) {
      restoreRubyPanelHome();
      return;
    }
    const anchor = document.querySelector(".layer-box.editing");
    if (!anchor) {
      restoreRubyPanelHome();
      return;
    }
    if (panelEl.parentElement !== document.body) document.body.appendChild(panelEl);
    panelEl.hidden = false;
    panelEl.classList.add("ruby-panel-floating");
    const gap = 10;
    const margin = 8;
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    panelEl.style.maxHeight = `${Math.max(120, viewportH - margin * 2)}px`;
    panelEl.style.overflowY = "auto";
    const r = anchor.getBoundingClientRect();
    const measuredPanel = panelEl.getBoundingClientRect();
    const panelW = Math.max(230, Math.min(270, measuredPanel.width || panelEl.offsetWidth || 250));
    const panelH = Math.max(120, measuredPanel.height || panelEl.offsetHeight || 156);
    const clamp = (v, min, max) => {
      const safeMax = Math.max(min, max);
      return Math.max(min, Math.min(safeMax, v));
    };
    const unionRect = (rects) => rects.reduce((acc, rect) => ({
      left: Math.min(acc.left, rect.left),
      top: Math.min(acc.top, rect.top),
      right: Math.max(acc.right, rect.right),
      bottom: Math.max(acc.bottom, rect.bottom),
    }));
    const overlapArea = (a, b) => {
      const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
      const h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      return w * h;
    };
    const badge = anchor.querySelector(".layer-size-badge");
    const handle = anchor.querySelector(".layer-rotate-handle");
    const avoid = unionRect([r, badge, handle]
      .filter(Boolean)
      .map((el) => (typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : el)));
    const fitLeftMax = viewportW - panelW - margin;
    const fitTopMax = viewportH - panelH - margin;
    const candidates = [
      { left: avoid.right + gap, top: avoid.top },
      { left: avoid.left - gap - panelW, top: avoid.top },
      { left: avoid.left, top: avoid.bottom + gap },
      { left: avoid.left, top: avoid.top - gap - panelH },
      { left: avoid.left + (avoid.right - avoid.left - panelW) / 2, top: avoid.top - gap - panelH },
      { left: avoid.left + (avoid.right - avoid.left - panelW) / 2, top: avoid.bottom + gap },
      { left: r.right + gap, top: r.top },
    ].map((p) => {
      const left = clamp(p.left, margin, fitLeftMax);
      const top = clamp(p.top, margin, fitTopMax);
      const rect = { left, top, right: left + panelW, bottom: top + panelH };
      return {
        left,
        top,
        overlap: overlapArea(rect, avoid),
        distance: Math.abs(left - (r.right + gap)) + Math.abs(top - r.top),
      };
    });
    candidates.sort((a, b) => (a.overlap - b.overlap) || (a.distance - b.distance));
    panelEl.style.left = `${Math.round(candidates[0].left)}px`;
    panelEl.style.top = `${Math.round(candidates[0].top)}px`;
  };

  const updateSelection = () => {
    const sel = currentRubyTarget();
    if (sel && sel.end > sel.start) {
      const targetId = sel.tempId ?? sel.layerId;
      const contents = sel.contents ?? "";
      const parentText = contents.substring(sel.start, sel.end);
      parentEl.textContent = parentText || "（選択範囲）";
      inputEl.disabled = false;
      applyBtn.disabled = false;
      const existing = getCharRubyAt(sel.psdPath, targetId, sel.start);
      if (existing && existing.end === sel.end) {
        inputEl.value = existing.text;
        if (existing.scale) scaleEl.value = String(existing.scale);
        if (existing.type) setMode(existing.type);
        removeBtn.disabled = false;
      } else {
        inputEl.value = "";
        scaleEl.value = "50";
        setMode("auto");
        removeBtn.disabled = !rangeHasAnyRuby(sel.psdPath, targetId, sel.start, sel.end);
      }
    } else {
      parentEl.innerHTML = '<span class="ruby-parent-empty">文字を選択</span>';
      inputEl.disabled = true;
      applyBtn.disabled = true;
      removeBtn.disabled = true;
      inputEl.value = "";
      scaleEl.value = "50";
      setMode("auto");
    }
    placeRubyPanelNearText();
  };
  onInplaceSelectionChange(updateSelection);
  window.addEventListener("psdesign:selection-changed", updateSelection);
  window.addEventListener("resize", placeRubyPanelNearText);
  window.addEventListener("scroll", placeRubyPanelNearText, true);
  updateSelection();

  const doApply = () => {
    const sel = currentRubyTarget();
    if (!sel || sel.end <= sel.start) return;
    const text = inputEl.value.trim();
    if (!text) return;
    const targetId = sel.tempId ?? sel.layerId;
    const parentText = parentEl.textContent || "";
    const scale = clampRubyScale(scaleEl.value);
    const type = decideRubyType(currentMode, text, parentText);
    const contents = sel.contents ?? "";
    const rubyLeadingPct = Number(getDefault("rubyLeadingPct")) || 150;
    const lineIndexAt = (index) => {
      const head = contents.slice(0, Math.max(0, index));
      return head.split(/\r\n|\r|\n/).length - 1;
    };
    const startLine = lineIndexAt(sel.start);
    const endLine = lineIndexAt(Math.max(sel.start, sel.end - 1));
    withHistoryTransient(() => {
      setCharRubiesRange(sel.psdPath, targetId, sel.start, sel.end, text, type, scale);
      for (let li = startLine; li <= endLine; li++) {
        setLineLeading(sel.psdPath, targetId, li, rubyLeadingPct);
      }
    });
    const editingBox = document.querySelector(".layer-box.editing");
    if (editingBox) {
      const inner = editingBox.querySelector(".existing-layer-text, .new-layer-text");
      if (inner) {
        inner.style.lineHeight = String(rubyLeadingPct / 100);
      }
    }
    if (!sel.objectSelection) applyEditModeRubyToRange(sel.start, sel.end, text, type, scale);
    refreshAllOverlays();
    rebuildLayerList();
    if (!sel.objectSelection) {
      restoreInplaceSelection(sel);
      requestAnimationFrame(() => restoreInplaceSelection(sel));
    }
    removeBtn.disabled = false;
    requestAnimationFrame(updateSelection);
  };
  applyBtn.addEventListener("click", doApply);

  // 蜑企勁
  removeBtn.addEventListener("click", () => {
    const sel = currentRubyTarget();
    if (!sel || sel.end <= sel.start) return;
    const targetId = sel.tempId ?? sel.layerId;
    const contents = sel.contents ?? "";
    const lineIndexAt = (index) => {
      const head = contents.slice(0, Math.max(0, index));
      return head.split(/\r\n|\r|\n/).length - 1;
    };
    const lineRangeAt = (lineIndex) => {
      let start = 0;
      let current = 0;
      const re = /\r\n|\r|\n/g;
      let m;
      while ((m = re.exec(contents))) {
        if (current === lineIndex) return { start, end: m.index };
        current += 1;
        start = m.index + m[0].length;
      }
      return current === lineIndex ? { start, end: contents.length } : null;
    };
    const clearRubyLineLeadingIfEmpty = (from, to) => {
      const startLine = lineIndexAt(from);
      const endLine = lineIndexAt(Math.max(from, to - 1));
      for (let li = startLine; li <= endLine; li++) {
        const range = lineRangeAt(li);
        if (!range) continue;
        if (!rangeHasAnyRuby(sel.psdPath, targetId, range.start, range.end)) {
          setLineLeading(sel.psdPath, targetId, li, null);
        }
      }
    };
    const rubyAtStart = getCharRubyAt(sel.psdPath, targetId, sel.start);
    const rubyAtEnd = getCharRubyAt(sel.psdPath, targetId, Math.max(sel.start, sel.end - 1));
    const rubyToRemove = rubyAtStart ?? rubyAtEnd ?? null;
    const removeStart = rubyToRemove?.start ?? sel.start;
    const removeEnd = rubyToRemove?.end ?? sel.end;
    const removedRubies = !sel.objectSelection ? removeEditModeRubyFromRange(sel.start, sel.end) : [];
    withHistoryTransient(() => {
      removeCharRubyAt(sel.psdPath, targetId, removeStart);
      setCharRubiesRange(sel.psdPath, targetId, removeStart, removeEnd, "", "group", 50);
      clearRubyLineLeadingIfEmpty(removeStart, removeEnd);
      for (const r of removedRubies) {
        removeCharRubyAt(sel.psdPath, targetId, r.start);
        setCharRubiesRange(sel.psdPath, targetId, r.start, r.end, "", "group", 50);
        clearRubyLineLeadingIfEmpty(r.start, r.end);
      }
    });
    refreshAllOverlays();
    rebuildLayerList();
    if (!sel.objectSelection) {
      restoreInplaceSelection(sel);
      requestAnimationFrame(() => restoreInplaceSelection(sel));
    }
    inputEl.value = "";
    removeBtn.disabled = true;
    requestAnimationFrame(updateSelection);
  });

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
    const ec = getEditingContext();
    if (ec) {
      const targetId = ec.tempId ?? ec.layerId;
      const v = getLineLeading(ec.psdPath, targetId, ec.currentLineIndex ?? 0) ?? getLeadingPct();
      input.value = String(v);
      return;
    }
    input.value = String(getLeadingPct());
  });
  const keepFocus = (el) => el && el.addEventListener("mousedown", (e) => e.preventDefault());
  keepFocus(dec); keepFocus(inc);
  dec.addEventListener("click", () => adjustLeading(-5));
  inc.addEventListener("click", () => adjustLeading(+5));

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
  const pdfFiles = [];
  const unknowns = [];
  for (const p of paths) {
    if (/\.psd$/i.test(p)) psdFiles.push(p);
    else if (/\.txt$/i.test(p)) txtFiles.push(p);
    else if (/\.(pdf|jpe?g|png)$/i.test(p)) pdfFiles.push(p);
    else unknowns.push(p);
  }
  for (const folder of unknowns) {
    try {
      const files = await listPsdFilesInFolder(folder);
      if (Array.isArray(files) && files.length) psdFiles.push(...files);
    } catch (e) {
      console.warn("フォルダ展開に失敗", folder, e);
    }
  }
  if (psdFiles.length > 0) {
    await loadPsdFilesByPaths(psdFiles);
  }
  for (const t of txtFiles) {
    await loadTxtFromPath(t);
  }
  if (pdfFiles.length > 0) {
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
  if (pane === "pdf") {
    resetPdfViewportToStart();
    setPdfZoom(PDF_FIT_ZOOM);
  } else {
    resetPsdViewportToStart();
    setPsdZoom(PSD_FIT_ZOOM);
  }
}
function displayZoomPercent(pane) {
  const z = pane === "pdf" ? getPdfZoom() : getPsdZoom();
  const base = pane === "pdf" ? PDF_FIT_BASE_SCALE : PSD_FIT_BASE_SCALE;
  return Math.round(z * base * 100);
}

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

const NEW_TEXT_DIR_LS_KEY = "psdesign_new_text_direction";
function bindNewTextDirectionToggle() {
  const sw = document.getElementById("new-text-dir-switch");
  if (!sw) return;

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
    level.textContent = `${paneLabel(pane)} ${displayZoomPercent(pane)}%`;
    level.title = `${paneLabel(pane)} を100% にリセット`;
  };
  updateLevel();
  onPdfZoomChange(updateLevel);
  onPsdZoomChange(updateLevel);
  onActivePaneChange(updateLevel);

  out.addEventListener("click", () => zoomActivePaneBy(1 / 1.15));
  inn.addEventListener("click", () => zoomActivePaneBy(1.15));
  level.addEventListener("click", () => resetActivePaneZoom());

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
  if (hint) hint.textContent = `${target.label} ページ: 1〜${target.total} を入力してください`;
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
  return `${homeFlowBaseName(list[0])} ほか${list.length - 1}件`;
}

function homeFlowFilterPaths(paths, kind) {
  const list = (Array.isArray(paths) ? paths : [paths])
    .filter((p) => typeof p === "string" && p.length > 0);
  if (kind === "reference") return list.filter((p) => /\.(pdf|jpe?g|png)$/i.test(p));
  if (kind === "psd") return list.filter((p) => /\.psd$/i.test(p));
  if (kind === "txt") return list.filter((p) => /\.txt$/i.test(p)).slice(0, 1);
  return [];
}

function normalizeHomeFlowPaths(value) {
  return (Array.isArray(value) ? value : value ? [value] : [])
    .map((p) => (typeof p === "string" ? p : p?.path ?? null))
    .filter(Boolean);
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
      console.warn("写植フォルダ展開に失敗", folder, e);
    }
  }
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const resolved = [...direct, ...fromFolders].sort((a, b) => collator.compare(homeFlowBaseName(a), homeFlowBaseName(b)));
  return kind === "txt" ? resolved.slice(0, 1) : resolved;
}

function openReferenceHiddenPicker(paths, selectedPages = new Set()) {
  return new Promise(async (resolve) => {
    let settled = false;
    let cards = [];
    let lastSelectedIndex = null;
    const selected = new Set(selectedPages);
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
    const updateCount = () => {
      if (count) {
        const parts = [];
        parts.push(selected.size ? `${selected.size}ページを非表示` : "非表示なし");
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
        btn.addEventListener("click", (e) => {
          const index = Number(btn.dataset.index);
          if (e.shiftKey && Number.isInteger(lastSelectedIndex)) {
            const from = Math.min(lastSelectedIndex, index);
            const to = Math.max(lastSelectedIndex, index);
            const shouldSelect = !selected.has(index);
            for (const card of cards) {
              if (card.index < from || card.index > to) continue;
              if (shouldSelect) selected.add(card.index);
              else selected.delete(card.index);
            }
          } else if (selected.has(index)) {
            selected.delete(index);
          } else {
            selected.add(index);
          }
          lastSelectedIndex = index;
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
    modal.querySelector(".reference-hidden-apply")?.addEventListener("click", async () => {
      if (cards.length > 0 && selected.size >= cards.length) {
        await notifyDialog({
          title: "すべて非表示になっています",
          message: "少なくとも1ページは表示するように選択を解除してください。",
          okLabel: "OK",
          kind: "warning",
        });
        return;
      }
      cleanup({
        hiddenPages: new Set(selected),
      });
    });
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
          <button class="page-jump-btn page-jump-btn-primary home-typeset-start" type="button" disabled>開始</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.querySelector(".home-typeset-title")?.insertAdjacentHTML(
      "afterend",
      '<span class="home-typeset-subtitle">ドラッグ＆ドロップできます</span>'
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
          skipFirstBlankPage: false,
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
        hideBtn.classList.toggle("selected", hiddenReferencePages.size > 0);
        if (hiddenReferencePages.size > 0) {
          hideBtn.textContent = `非表示 ${hiddenReferencePages.size}`;
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
      const next = await openReferenceHiddenPicker(referencePaths, hiddenReferencePages);
      if (!next) return;
      hiddenReferencePages = next.hiddenPages instanceof Set ? next.hiddenPages : new Set(next.hiddenPages || []);
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
          referencePaths = normalizeHomeFlowPaths(await pickWithHomeDialogHidden(() => pickReferenceFiles()));
          hiddenReferencePages = new Set();
          referencePageCount = null;
          void refreshReferencePageCount();
        } else if (kind === "psd") {
          psdPaths = normalizeHomeFlowPaths(await pickWithHomeDialogHidden(() => pickPsdFiles()));
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
      if (referenceCount < psdPaths.length) {
        await notifyDialog({
          title: "見本が不足しています",
          message: `見本は${referenceCount}件、PSDは${psdPaths.length}件です。PSDの枚数分の見本を指定してください。`,
          okLabel: "OK",
          kind: "warning",
        });
        return;
      }
      cleanup({ referencePaths, psdPaths, txtPath, hiddenReferencePages: [...hiddenReferencePages] });
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
  const positionAdjustMode = await choosePositionAdjustMode();
  if (positionAdjustMode == null) return;
  await transitionFromHome();
  try {
    clearScanExtractDoc();
    await loadReferenceFiles(picked.referencePaths, {
      skipFirstBlankPage: false,
      excludedPages: picked.hiddenReferencePages,
      keepProgressOpen: true,
    });
    await loadPsdFilesByPaths(picked.psdPaths, { icon: PLACE_ICON_SVG, label: "自動配置中…", keepProgressOpen: true });
    if (!getPages().length) {
      await hideProgress();
      return;
    }
    if (picked.txtPath) await loadTxtFromPath(picked.txtPath);
    const placed = await runAutoPlace({
      allowExtractText: true,
      preserveTxtDuringExtract: !!picked.txtPath,
      positionAdjustMode,
    });
    if (!placed) {
      await hideProgress();
      return;
    }
    if (placed?.positionAdjusted !== true) {
      await runSelectedPositionAdjust(positionAdjustMode, { automatic: true });
    }
  } catch (e) {
    console.error(e);
    await hideProgress();
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
    clearScanExtractDoc();
    await loadReferenceFiles(files);
    await runScanExtractForTranscription(files);
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
  document.getElementById("open-folder-btn")?.addEventListener("click", handleOpenFiles);
  document.getElementById("open-pdf-btn")?.addEventListener("click", handleOpenPdf);
  bindSaveMenu();
  bindHistoryButtons();
  initHamburgerMenu();
  bindTools();
  bindSizeTool();
  bindLeadingTool();
  bindBoldToggle();
  bindItalicToggle();
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
  bindScanInstallMenu();
  bindFirstRunSetup();
  bindScanExtractButton();
  bindScanPlaceButton();
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
  bindEditorPane();
  bindParallelViewMode();
  initSettingsUi();
  applyToolDefaults();
  const applyRubyCssVars = () => {
    const pct = Number(getDefault("rubyLeadingPct")) || 150;
    document.documentElement.style.setProperty("--ruby-row-leading-pct", String(pct));
    const uiOffsetEm = Number(getDefault("rubyParentOffsetEm"));
    document.documentElement.style.setProperty(
      "--ruby-parent-offset-em",
      Number.isFinite(uiOffsetEm) ? String(uiOffsetEm) : "0",
    );
    try { refreshAllOverlays(); } catch (_) {}
  };
  applyRubyCssVars();
  onSettingsChange(applyRubyCssVars);
  renderAllSpreads();
  loadFontsFromBackend();
  onFontsRegistered(() => refreshAllOverlays());
  bindGlobalBlurOnOutsideClick();
  initRulers();
  bindRulerToggle();
  bindNewTextDirectionToggle();
  bindViewerMode();
  window.addEventListener("psdesign:psd-loaded", () => {
    updatePageNav();
    updatePsdRotateVisibility();
    updatePsdGuidesLockVisibility();
    updatePsdGuidesApplyVisibility();
  });
  maybeShowFirstRunSetup();
  void closeStartupSplash();
}

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
    if (target === active || active.contains(target)) return;
    const near = target.closest?.("input, textarea, [contenteditable], .style-palette, .save-menu, .layer-box.editing, .editor, .ruby-panel-floating");
    if (near) return;
    active.blur();
  }, true);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
