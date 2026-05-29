import { buildReferencePageCards, loadReferenceFiles, pickReferenceFiles } from "./pdf-loader.js";
import { getVersion } from "@tauri-apps/api/app";
import packageInfo from "../package.json";
import { capturePdfViewportCenter, mountPdfView, PDF_FIT_BASE_SCALE, PDF_FIT_ZOOM, resetPdfViewportToStart, schedulePdfStageLayoutRefresh, setNextPdfZoomAnchorFromClientPoint } from "./pdf-view.js";
import {
  clearTemporaryMultiSelectionAdornments,
  deleteSelectedLayers,
  commitActiveInPlaceEdit,
  nudgeSelectedLayers,
  resizeSelectedLayers,
  showRotationHandlesForSelectedLayers,
  refreshAllOverlays,
  revealLayerAdornmentsForTemporaryMultiSelection,
  restoreSelectedLayerBadges,
  setSelectedLayerBadgesUserHidden,
  toggleSelectionAdornmentsVisible,
  snapNextSize,
  getLastInplaceSelection,
  getInplaceSelectionRect,
  getExistingLayerEffectiveSizePt,
  onInplaceSelectionChange,
  applyEditModeStyleToRange,
  recenterActiveInPlaceEditBox,
  resizeActiveInPlaceEditBoxToState,
  refreshActiveInPlaceEditPreview,
  restoreInplaceSelection,
  showInplaceSelectionHighlightOnly,
  applyEditModeRubyToRange,
  removeEditModeRubyFromRange,
  removeEditModeRubyTextFromRange,
} from "./canvas-tools.js";
import { ensureFontLoaded, onFontsRegistered } from "./font-loader.js";
import { capturePsdViewportCenter, PSD_FIT_BASE_SCALE, PSD_FIT_ZOOM, renderAllSpreads, resetPsdViewportToStart, schedulePsdStageLayoutRefresh, setNextPsdZoomAnchorFromClientPoint } from "./spread-view.js";
import {
  bindEditorEvents,
  commitBoldToSelections,
  commitItalicToSelections,
  commitLeadingToSelections,
  commitSizeToSelections,
  getLayerCenter,
  hasSelection,
  rebuildLayerList,
  recenterLayerToCenter,
  unifySelectedTextSize,
} from "./text-editor.js";
import { cycleTxtBlockSelection, deleteSelectedTxtBlock, getTxtPageCount, initTxtSource, loadTxtFromPath, pickTxtPath } from "./txt-source.js";
import { bindScanInstallMenu, checkScanModelsStatus } from "./scan-install.js";
import { bindFirstRunSetup, maybeShowFirstRunSetup } from "./first-run-setup.js";
import { bindScanExtractButton, PLACE_ICON_SVG, runScanExtractForTranscription } from "./scan-extract.js";
import {
  bindScanPlaceButton,
  bindPositionAdjustButton,
  choosePositionAdjustMode,
  closePositionAdjustModalExternal,
  runAutoPlace,
  runSelectedPositionAdjust,
} from "./auto-place.js";
import { bindViewerMode, toggleViewerMode } from "./viewer-mode.js";
import { bindAutoUpdater } from "./auto-updater.js";
import { bindProofreadUi, openProofread } from "./proofread.js";
import { initHamburgerMenu } from "./hamburger-menu.js";
import { bindStylePalette } from "./style-palette.js";
import { bindFindChangeMode } from "./find-change.js";
import { initFontBookPanel } from "./font-book.js";
import {
  confirmDialog,
  hideModalAnimated,
  hideProgress,
  notifyDialog,
  showOpusProgressComplete,
  OPUS_SUCCESS_HOLD_DURATION,
  showProgress,
  showModalAnimated,
  toast,
} from "./ui-feedback.js";
import {
  clearProgressFlow,
  createHomeTypesetSteps,
  startProgressFlow,
} from "./progress-flow.js";
import { bindEditorPane, focusEditor, refreshEditorPaneViewer } from "./bind/editor-pane.js";
import {
  listPsdFilesInFolder,
  loadPsdFilesByPaths,
  pickPsdFiles,
} from "./services/psd-load.js";
import { bindSaveMenu, handleSave } from "./bind/save.js";
import { bindProjectButtons, openProject, openProjectFromPath, saveProject } from "./services/project.js";
import {
  findShortcutMatch,
  applyThemeColor,
  getArrowKeyMoveDistance,
  getDefault,
  getPageDirectionInverted,
  getShortcut,
  matchShortcut,
  onSettingsChange,
  setDefault,
} from "./settings.js";
import { initSettingsUi } from "./settings-ui.js";
import {
  initRulers,
  toggleRulersVisible,
  getRulersVisible,
  onRulersVisibleChange,
} from "./rulers.js";
import {
  canRedo,
  canUndo,
  clearAllEdits,
  clearScanExtractDoc,
  getActivePane,
  getCurrentPageIndex,
  getEdit,
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
  hasEdits,
  getEditorLeftPaneMode,
  getCurrentFont,
  getFontDisplayName,
  getFonts,
  setEditorLeftPaneMode,
  setCurrentFont,
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
  setCharRubyScale,
  getCharRubies,
  getCharRubyForRange,
  removeCharRubyAt,
  getCharRubyAt,
  rangeHasAnyRuby,
  rangeHasRubyText,
  removeRubyTextRange,
  withHistoryTransient,
  getSelectedLayers,
  getNewTextDirection,
  setNewTextDirection,
  onNewTextDirectionChange,
  applyToolDefaults,
} from "./state.js";
import {
  getPdfVirtualPageAt,
  getPdfVirtualPageCount,
} from "./pdf-pages.js";

let homeTypesetDropHandler = null;
let homeTypesetDragOverHandler = null;
let homeTypesetDragLeaveHandler = null;
let homeScanEngineAvailable = null;

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
let ctrlShiftBadgeChordActive = false;
let ctrlShiftBadgeChordCancelled = false;
let selectedLayerBadgeRestoreTimer = null;

function cancelSelectedLayerBadgeRestore() {
  if (selectedLayerBadgeRestoreTimer == null) return;
  clearTimeout(selectedLayerBadgeRestoreTimer);
  selectedLayerBadgeRestoreTimer = null;
}

function scheduleSelectedLayerBadgeRestore() {
  cancelSelectedLayerBadgeRestore();
  selectedLayerBadgeRestoreTimer = window.setTimeout(() => {
    selectedLayerBadgeRestoreTimer = null;
    restoreSelectedLayerBadges();
  }, 180);
}

function restoreSelectedLayerBadgesNow() {
  cancelSelectedLayerBadgeRestore();
  restoreSelectedLayerBadges();
}

// 選択中テキストのサイズを既定の文字サイズに統一する。
// サイドツールバーの「統一」ボタンと Shift+S ショートカットの共通処理。
function runUnifyTextSize() {
  if (!hasSelection()) {
    toast("サイズを統一するテキストを選択してください", { kind: "info", duration: 2400 });
    return;
  }
  const defaultSize = Number(getDefault("textSize"));
  const changed = unifySelectedTextSize(defaultSize);
  if (!changed && !hasSelection()) {
    toast("サイズを統一するテキストを2つ以上選択してください", { kind: "info", duration: 2400 });
  }
}

function runShortcut(id) {
  const inv = getPageDirectionInverted();
  switch (id) {
    case "save":       saveProject(); break;
    case "saveAs":     handleSave(); break;
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
    case "unifyTextSize": runUnifyTextSize(); break;
    case "toggleRulers": toggleRulersVisible(); break;
    case "viewerMode":   toggleViewerMode(); break;
  }
}

function isCtrlLikeKey(e) {
  return e.key === "Control" || e.code === "ControlLeft" || e.code === "ControlRight";
}

function isShiftKey(e) {
  return e.key === "Shift" || e.code === "ShiftLeft" || e.code === "ShiftRight";
}

function isCtrlShiftAdornmentChord(e) {
  return e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey;
}

function handleSelectionAdornmentChordKeydown(e) {
  if (ctrlShiftBadgeChordActive && isCtrlShiftAdornmentChord(e) && !isCtrlLikeKey(e) && !isShiftKey(e)) {
    ctrlShiftBadgeChordCancelled = true;
    return false;
  }
  if (!isCtrlShiftAdornmentChord(e) || (!isCtrlLikeKey(e) && !isShiftKey(e))) {
    return false;
  }

  if (!e.repeat && !ctrlShiftBadgeChordActive) {
    ctrlShiftBadgeChordActive = true;
    ctrlShiftBadgeChordCancelled = false;
  }
  e.preventDefault();
  return true;
}

function handleSelectionAdornmentChordKeyup(e) {
  if (!ctrlShiftBadgeChordActive) return false;
  if (!isCtrlLikeKey(e) && !isShiftKey(e)) return false;
  if (!ctrlShiftBadgeChordCancelled) {
    const visible = toggleSelectionAdornmentsVisible();
    setSelectedLayerBadgesUserHidden(!visible);
    if (visible) restoreSelectedLayerBadgesNow();
    else cancelSelectedLayerBadgeRestore();
  }
  ctrlShiftBadgeChordActive = false;
  ctrlShiftBadgeChordCancelled = false;
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
  const mods = sc.modifiers || [];
  const noMods = mods.length === 0;
  // Shift だけの修飾（例: Shift+S = 大文字 S 入力）は通常のタイピングや
  // Shift+矢印の範囲選択と衝突するため、入力欄・テキスト編集中は発火させない。
  const shiftOnly = mods.length === 1 && mods[0] === "shift";
  return isArrow || noMods || shiftOnly;
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
    if (selections.length > 1) {
      revealLayerAdornmentsForTemporaryMultiSelection();
    } else {
      clearTemporaryMultiSelectionAdornments();
    }
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
      runUnifyTextSize();
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

    if (
      isArrowKey &&
      (e.ctrlKey || e.metaKey) &&
      !e.altKey &&
      (e.key === "ArrowUp" || e.key === "ArrowDown")
    ) {
      const t = e.target;
      const isPlainInput = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");
      const sel = getLastInplaceSelection();
      const hasRangeSelection = !!(sel && sel.end > sel.start);
      if (!isPlainInput && (hasRangeSelection || getSelectedLayers().length > 0)) {
        const sign = e.key === "ArrowUp" ? +1 : -1;
        const multiplier = e.shiftKey ? 10 : 1;
        const changed = hasRangeSelection
          ? stepTextPointSize(sign, multiplier)
          : resizeSelectedLayers(1, sign, multiplier);
        if (changed) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }
    }

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
            cancelSelectedLayerBadgeRestore();
            e.preventDefault();
            return;
          }
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

    if (
      e.key === "ArrowLeft" || e.key === "ArrowRight" ||
      e.key === "ArrowUp" || e.key === "ArrowDown"
    ) {
      scheduleSelectedLayerBadgeRestore();
    }

    if (e.code === "Space" && panSpaceActive) {
      panSpaceActive = false;
      if (panPreviousTool) {
        setTool(panPreviousTool);
        panPreviousTool = null;
      }
    }
  });

  window.addEventListener("blur", () => {
    restoreSelectedLayerBadgesNow();
    if (panSpaceActive) {
      panSpaceActive = false;
      if (panPreviousTool) {
        setTool(panPreviousTool);
        panPreviousTool = null;
      }
    }
    ctrlShiftBadgeChordActive = false;
    ctrlShiftBadgeChordCancelled = false;
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

function bindPanelToggle(panelEl, btn, storageKey, expandedTitle, collapsedTitle, afterToggle = null) {
  if (!panelEl || !btn) return;
  let collapsed = false;
  try { collapsed = localStorage.getItem(storageKey) === "1"; } catch (_) {}
  applyPanelCollapsed(panelEl, collapsed, btn, expandedTitle, collapsedTitle);
  btn.addEventListener("click", () => {
    const beforeCenter = {
      psd: capturePsdViewportCenter(),
      pdf: capturePdfViewportCenter(),
    };
    collapsed = !collapsed;
    applyPanelCollapsed(panelEl, collapsed, btn, expandedTitle, collapsedTitle);
    try { localStorage.setItem(storageKey, collapsed ? "1" : "0"); } catch (_) {}
    afterToggle?.({ collapsed, beforeCenter });
  });
}

function bindCollapseToggles() {
  bindPanelToggle(
    document.querySelector(".side-toolbar"),
    document.getElementById("toggle-side-toolbar-btn"),
    SIDE_TOOLBAR_COLLAPSED_KEY,
    "ツールバーを折り畳む",
    "ツールバーを展開",
    ({ beforeCenter }) => {
      schedulePsdStageLayoutRefresh({ recenter: !beforeCenter.psd, viewportCenter: beforeCenter.psd });
      schedulePdfStageLayoutRefresh({ recenter: !beforeCenter.pdf, viewportCenter: beforeCenter.pdf });
    },
  );
  bindPanelToggle(
    document.querySelector(".side-panel"),
    document.getElementById("toggle-side-panel-btn"),
    SIDE_PANEL_COLLAPSED_KEY,
    "サイドバーを折り畳む",
    "サイドバーを展開",
    ({ beforeCenter }) => {
      schedulePsdStageLayoutRefresh({ recenter: !beforeCenter.psd, viewportCenter: beforeCenter.psd });
      schedulePdfStageLayoutRefresh({ recenter: !beforeCenter.pdf, viewportCenter: beforeCenter.pdf });
      setTimeout(() => {
        schedulePsdStageLayoutRefresh({ recenter: !beforeCenter.psd, viewportCenter: beforeCenter.psd });
        schedulePdfStageLayoutRefresh({ recenter: !beforeCenter.pdf, viewportCenter: beforeCenter.pdf });
      }, 320);
    },
  );
}

const SIDE_PANEL_TAB_KEY = "psdesign_side_panel_tab";
let pendingSidePanelInplaceSelection = null;
function loadSidePanelTab() {
  try {
    const v = localStorage.getItem(SIDE_PANEL_TAB_KEY);
    if (v === "txt" || v === "editor" || v === "style") return v;
  } catch (_) {}
  return "txt";
}
function setSidePanelTab(tab) {
  if (tab !== "txt" && tab !== "editor" && tab !== "style") tab = "txt";
  const inplaceSelection = pendingSidePanelInplaceSelection ?? getLastInplaceSelection();
  pendingSidePanelInplaceSelection = null;
  for (const btn of document.querySelectorAll(".side-panel-tab")) {
    const isActive = btn.dataset.tab === tab;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-selected", isActive ? "true" : "false");
  }
  for (const sec of document.querySelectorAll(".side-panel .panel-section")) {
    sec.hidden = sec.dataset.section !== tab;
  }
  try { localStorage.setItem(SIDE_PANEL_TAB_KEY, tab); } catch (_) {}
  if (inplaceSelection) {
    requestAnimationFrame(() => restoreInplaceSelection(inplaceSelection));
  }
}
function bindSidePanelTabs() {
  const tabs = document.querySelectorAll(".side-panel-tab");
  if (!tabs.length) return;
  for (const btn of tabs) {
    btn.addEventListener("mousedown", (e) => {
      const sel = getLastInplaceSelection();
      pendingSidePanelInplaceSelection = sel && sel.end >= sel.start ? { ...sel } : null;
      e.preventDefault();
    });
    btn.addEventListener("click", () => {
      setSidePanelTab(btn.dataset.tab);
    });
  }
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

function bindViewModeControls() {
  setParallelSyncMode(true);
  setActivePane("psd");
}

const VIEW_MODE_LS_KEY = "psdesign_parallel_view_mode";
const EDITOR_LEFT_PANE_LS_KEY = "psdesign_editor_left_pane_mode";

function bindParallelViewMode() {
  const parallelBtn = document.getElementById("view-parallel-btn");
  const proofreadBtn = document.getElementById("view-proofread-btn");
  const spreadEditBtn = document.getElementById("view-spread-edit-btn");
  const editorBtn = document.getElementById("view-editor-btn");
  const proofreadArea = document.getElementById("spreads-proofread-area");
  const editorArea = document.getElementById("spreads-editor-area");
  const proofreadPanel = document.getElementById("proofread-panel");
  const leftProofreadBtn = document.getElementById("editor-left-proofread-btn");
  const leftPdfBtn = document.getElementById("editor-left-pdf-btn");
  if (!parallelBtn || !proofreadBtn || !spreadEditBtn || !editorBtn || !proofreadArea || !editorArea || !proofreadPanel) return;

  try {
    const saved = localStorage.getItem(VIEW_MODE_LS_KEY);
    if (saved === "parallel" || saved === "proofread" || saved === "editor" || saved === "spreadEdit") {
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
  spreadEditBtn.addEventListener("click", () => switchViewMode("spreadEdit"));
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
    const showSpreadEdit = mode === "spreadEdit";
    if (workspace) {
      workspace.classList.toggle("editor-mode", showEditor);
      workspace.classList.toggle("proofread-mode", showProofread);
      workspace.classList.toggle("spread-edit-mode", showSpreadEdit);
    }
    if (stage) {
      stage.classList.toggle("proofread-visible", showProofread || showEditor);
      stage.classList.toggle("editor-visible", showEditor);
    }
    parallelBtn.classList.toggle("active", mode === "parallel");
    proofreadBtn.classList.toggle("active", mode === "proofread");
    spreadEditBtn.classList.toggle("active", mode === "spreadEdit");
    editorBtn.classList.toggle("active", mode === "editor");
    parallelBtn.setAttribute("aria-checked", mode === "parallel" ? "true" : "false");
    proofreadBtn.setAttribute("aria-checked", mode === "proofread" ? "true" : "false");
    spreadEditBtn.setAttribute("aria-checked", mode === "spreadEdit" ? "true" : "false");
    editorBtn.setAttribute("aria-checked", mode === "editor" ? "true" : "false");
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

  // 【v2.2.x】View ▾ ドロップダウン: trigger 開閉 + メニュー項目クリックで閉じる。
  // 既存の view-parallel-btn / view-proofread-btn / view-spread-edit-btn / view-editor-btn
  // の addEventListener (上記の switchViewMode) は維持。メニュー項目はこれらの ID を
  // そのまま使うので、click イベントは既存リスナーに届く。
  const dropdownTrigger = document.getElementById("view-mode-trigger");
  const dropdownMenu = document.getElementById("view-mode-menu");
  const fullscreenItem = document.getElementById("view-fullscreen-psd-btn");
  if (dropdownTrigger && dropdownMenu) {
    const closeDropdown = () => {
      dropdownMenu.hidden = true;
      dropdownTrigger.setAttribute("aria-expanded", "false");
    };
    const openDropdown = () => {
      dropdownMenu.hidden = false;
      dropdownTrigger.setAttribute("aria-expanded", "true");
    };
    dropdownTrigger.addEventListener("click", (e) => {
      e.stopPropagation();
      if (dropdownMenu.hidden) openDropdown();
      else closeDropdown();
    });
    document.addEventListener("mousedown", (e) => {
      if (dropdownMenu.hidden) return;
      if (dropdownTrigger.contains(e.target)) return;
      if (dropdownMenu.contains(e.target)) return;
      closeDropdown();
    });
    document.addEventListener("keydown", (e) => {
      if (!dropdownMenu.hidden && e.key === "Escape") {
        e.preventDefault();
        closeDropdown();
      }
    });
    // メニュー項目クリック後はドロップダウンを閉じる。
    dropdownMenu.querySelectorAll(".view-mode-menu-item").forEach((item) => {
      item.addEventListener("click", () => closeDropdown());
    });
    // 「PSD全画面モード」項目: viewer-mode を起動 (toggleViewerMode は起動のみ、終了は Esc / ×)。
    // PSD 未読込時は toggleViewerMode 内の getPages().length === 0 ガードで何もしない。
    if (fullscreenItem) {
      fullscreenItem.addEventListener("click", () => toggleViewerMode());
    }
  }

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

function rubyTargetId(sel) {
  return sel ? (sel.tempId ?? sel.layerId) : null;
}

function isDakutenRubyMarkerText(text) {
  const chars = Array.from(String(text ?? ""));
  return chars.length > 0 && chars.every((ch) => {
    const code = ch.charCodeAt(0);
    return code === 0x309b || code === 0xff9e || code === 0x3099;
  });
}

function isNakaguroRubyMarkerText(text) {
  const chars = Array.from(String(text ?? ""));
  return chars.length > 0 && chars.every((ch) => {
    const code = ch.charCodeAt(0);
    return code === 0x30fb || code === 0xff65;
  });
}

function isSpecialRubyMarkerText(text) {
  return isDakutenRubyMarkerText(text) || isNakaguroRubyMarkerText(text);
}

function clampRubyScalePercent(n, snapToFive = false) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 50;
  const scaled = snapToFive ? Math.round(v / 5) * 5 : Math.round(v * 100) / 100;
  return Math.max(20, Math.min(100, scaled));
}

function getRubyParentSizePt(sel) {
  if (!sel?.rubyOnly) return null;
  const targetId = rubyTargetId(sel);
  if (targetId == null) return null;
  const page = getPages().find((p) => p.path === sel.psdPath);
  if (!page) return null;
  if (typeof targetId === "string") {
    const nl = getNewLayersForPsd(page.path).find((l) => l.tempId === targetId);
    const size = Number(nl?.sizePt ?? 24);
    return Number.isFinite(size) && size > 0 ? size : null;
  }
  const layer = page.textLayers?.find((l) => Number(l.id) === Number(targetId));
  if (!layer) return null;
  const edit = getEdit(page.path, targetId) ?? {};
  const size = Number(getExistingLayerEffectiveSizePt(page, layer, edit));
  return Number.isFinite(size) && size > 0 ? size : null;
}

function getRubySelectionEntry(sel) {
  if (!sel?.rubyOnly) return null;
  const targetId = rubyTargetId(sel);
  if (targetId == null) return null;
  return getCharRubyForRange(sel.psdPath, targetId, sel.start, sel.end, sel.rubyText ?? "", {
    overlay: sel.rubyOverlay === true,
  });
}

function getRubySelectionSizePt(sel) {
  const parentSize = getRubyParentSizePt(sel);
  const entry = getRubySelectionEntry(sel);
  if (!Number.isFinite(parentSize) || !entry) return null;
  if (isSpecialRubyMarkerText(entry.text ?? sel?.rubyText ?? "")) {
    return Math.round(parentSize * 100) / 100;
  }
  const scale = Number(entry.scale ?? 50);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  return Math.round(parentSize * (scale / 100) * 100) / 100;
}

function syncTextSizeFromRubySelection(sel = getLastInplaceSelection()) {
  if (!sel?.rubyOnly) return false;
  const sizePt = getRubySelectionSizePt(sel);
  if (!Number.isFinite(sizePt)) return false;
  setTextSize(sizePt);
  return true;
}

function applyRubyScaleToSelection(sel, scale) {
  if (!sel?.rubyOnly) return false;
  const targetId = rubyTargetId(sel);
  if (targetId == null) return false;
  const entry = getRubySelectionEntry(sel);
  if (isSpecialRubyMarkerText(entry?.text ?? sel.rubyText)) {
    syncTextSizeFromRubySelection(sel);
    return false;
  }
  const nextScale = clampRubyScalePercent(scale);
  const changed = setCharRubyScale(sel.psdPath, targetId, sel.start, sel.end, sel.rubyText ?? "", nextScale, {
    overlay: sel.rubyOverlay === true,
  });
  syncTextSizeFromRubySelection(sel);
  if (!changed) return false;
  refreshActiveInPlaceEditPreview(sel);
  refreshAllOverlays();
  rebuildLayerList();
  import("./txt-source.js").then((mod) => mod.renderTxtSourceViewer?.()).catch(() => {});
  refreshEditorPaneViewer();
  showInplaceSelectionHighlightOnly(sel);
  requestAnimationFrame(() => showInplaceSelectionHighlightOnly(sel));
  return true;
}

function applyRubySizeToSelection(sel, sizePt) {
  const parentSize = getRubyParentSizePt(sel);
  const actual = Number(sizePt);
  if (!Number.isFinite(parentSize) || parentSize <= 0 || !Number.isFinite(actual)) return false;
  return applyRubyScaleToSelection(sel, (actual / parentSize) * 100);
}

function applyTextSize(n) {
  const sel = getLastInplaceSelection();
  if (sel?.rubyOnly) {
    applyRubySizeToSelection(sel, clampSize(n));
    return;
  }
  if (sel && sel.end > sel.start) {
    const v = clampSize(n);
    const targetId = sel.tempId ?? sel.layerId;
    setCharSizesRange(sel.psdPath, targetId, sel.start, sel.end, v);
    recenterActiveInPlaceEditBox(sel);
    refreshActiveInPlaceEditPreview(sel);
    refreshAllOverlays();
    rebuildLayerList();
    import("./txt-source.js").then((mod) => mod.renderTxtSourceViewer?.()).catch(() => {});
    refreshEditorPaneViewer();
    showInplaceSelectionHighlightOnly(sel);
    requestAnimationFrame(() => showInplaceSelectionHighlightOnly(sel));
    setTextSize(v);
    return;
  }
  setTextSize(n);
  commitSizeToSelections(getTextSize());
}

function clampSize(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return getTextSize();
  return Math.max(6, Math.min(999, Math.round(v * 100) / 100));
}

function getSizeStep() {
  return normalizeSizeStep(getDefault("textSizeStep"));
}

function normalizeSizeStep(value) {
  const v = Number(value);
  if (v === 0.25 || v === 0.5) return v;
  return 0.1;
}

function stepTextSize(sign, multiplier = 1) {
  const baseStep = getSizeStep();
  const next = snapNextSize(getTextSize(), baseStep, sign, multiplier);
  applyTextSize(next);
}

function stepTextPointSize(sign, multiplier = 1) {
  const next = snapNextSize(getTextSize(), 1, sign, multiplier);
  applyTextSize(next);
  return true;
}

function bindBoldToggle() {
  const buttons = document.querySelectorAll(".bold-toggle-btn");
  buttons.forEach((btn) => {
    if (btn.dataset.boldBound === "true") return;
    btn.dataset.boldBound = "true";
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", () => {
    if (btn.disabled) return;
    const newValue = btn.getAttribute("aria-pressed") !== "true";
    const sel = getLastInplaceSelection();
    if (sel?.rubyOnly) return;
    if (sel && sel.end > sel.start) {
      const targetId = sel.tempId ?? sel.layerId;
      setCharBoldsRange(sel.psdPath, targetId, sel.start, sel.end, newValue);
      applyEditModeStyleToRange(sel.start, sel.end, { fontWeight: newValue ? "700" : "400" });
      refreshAllOverlays();
      rebuildLayerList();
      buttons.forEach((item) => item.setAttribute("aria-pressed", newValue ? "true" : "false"));
      return;
    }
    if (commitBoldToSelections(newValue)) {
      buttons.forEach((item) => item.setAttribute("aria-pressed", newValue ? "true" : "false"));
    }
    });
  });
}

function bindItalicToggle() {
  const buttons = document.querySelectorAll(".italic-toggle-btn");
  buttons.forEach((btn) => {
    if (btn.dataset.italicBound === "true") return;
    btn.dataset.italicBound = "true";
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", () => {
    if (btn.disabled) return;
    const newValue = btn.getAttribute("aria-pressed") !== "true";
    const sel = getLastInplaceSelection();
    if (sel?.rubyOnly) return;
    if (sel && sel.end > sel.start) {
      const targetId = sel.tempId ?? sel.layerId;
      setCharItalicsRange(sel.psdPath, targetId, sel.start, sel.end, newValue);
      applyEditModeStyleToRange(sel.start, sel.end, { fontStyle: newValue ? "italic" : "normal" });
      refreshAllOverlays();
      rebuildLayerList();
      buttons.forEach((item) => item.setAttribute("aria-pressed", newValue ? "true" : "false"));
      return;
    }
    if (commitItalicToSelections(newValue)) {
      buttons.forEach((item) => item.setAttribute("aria-pressed", newValue ? "true" : "false"));
    }
    });
  });
}

function bindRubyTool() {
  const panelEl = document.querySelector(".editor-tab-panel[data-tab-panel='ruby']");
  const parentEl = document.getElementById("ruby-parent-display");
  const inputEl = document.getElementById("ruby-text-input");
  const scaleEl = document.getElementById("ruby-scale-input");
  const applyBtn = document.getElementById("ruby-apply-btn");
  const removeBtn = document.getElementById("ruby-remove-btn");
  const parentSelectBtn = document.getElementById("ruby-parent-select-btn");
  const dakutenBtn = document.getElementById("ruby-dakuten-btn");
  const nakaguroBtn = document.getElementById("ruby-nakaguro-btn");
  const modeAuto = document.getElementById("ruby-mode-auto-btn");
  const modeMono = document.getElementById("ruby-mode-mono-btn");
  const modeGroup = document.getElementById("ruby-mode-group-btn");
  const rubyFloatingTabs = panelEl?.querySelector(".ruby-floating-tabs");
  const rubyFloatingTabButtons = Array.from(panelEl?.querySelectorAll(".ruby-floating-tab[data-ruby-floating-tab]") ?? []);
  const rubyFloatingPanels = Array.from(panelEl?.querySelectorAll(".ruby-floating-tab-panel[data-ruby-floating-panel]") ?? []);
  const rubyDetailPanel = panelEl?.querySelector(".ruby-detail-panel");
  const detailControls = Array.from(document.querySelectorAll(".panel-section[data-section='style'] .style-controls-panel"));
  if (!panelEl || !parentEl || !inputEl || !applyBtn || !removeBtn) return;

  let currentMode = "auto"; // "auto" | "mono" | "group"
  let currentFloatingTab = "ruby";
  let detailControlsMounted = false;
  const detailControlPlaceholders = new Map();
  const panelHome = panelEl.parentElement;
  const panelPlaceholder = document.createComment("ruby-panel-home");
  if (panelHome) panelHome.insertBefore(panelPlaceholder, panelEl);
  panelEl.hidden = true;
  if (panelEl.parentElement !== document.body) document.body.appendChild(panelEl);

  const noFocusSteal = (el) => el && el.addEventListener("mousedown", (e) => e.preventDefault());
  [applyBtn, removeBtn, parentSelectBtn, dakutenBtn, nakaguroBtn, modeAuto, modeMono, modeGroup].forEach(noFocusSteal);

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

  const mountDetailControls = () => {
    if (!rubyDetailPanel || detailControlsMounted) return;
    for (const el of detailControls) {
      if (!el?.parentNode) continue;
      if (!detailControlPlaceholders.has(el)) {
        const placeholder = document.createComment(`ruby-detail-home:${el.dataset.tabPanel || ""}`);
        el.parentNode.insertBefore(placeholder, el);
        detailControlPlaceholders.set(el, placeholder);
      }
      rubyDetailPanel.appendChild(el);
    }
    detailControlsMounted = true;
  };

  const restoreDetailControls = () => {
    for (const el of detailControls) {
      const placeholder = detailControlPlaceholders.get(el);
      if (placeholder?.parentNode) {
        placeholder.parentNode.insertBefore(el, placeholder);
        placeholder.remove();
      }
    }
    detailControlPlaceholders.clear();
    detailControlsMounted = false;
  };

  const syncFloatingTabs = () => {
    const active = currentFloatingTab === "detail" ? "detail" : "ruby";
    panelEl.classList.toggle("ruby-detail-active", active === "detail");
    rubyFloatingTabs?.removeAttribute("hidden");
    rubyFloatingTabButtons.forEach((btn) => {
      const isActive = btn.dataset.rubyFloatingTab === active;
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-selected", isActive ? "true" : "false");
    });
    rubyFloatingPanels.forEach((panel) => {
      panel.hidden = panel.dataset.rubyFloatingPanel !== active;
    });
  };

  // panel が viewport の下端 / 上端からはみ出ていたら top を補正する。
  // 位置 (基準点) は変えず、min/max でクランプするだけの軽量フィッティング。
  // タブ切替などで panel のコンテンツが増えて下に伸びた場合の見切れを防ぐ。
  const fitRubyPanelToViewport = () => {
    if (!panelEl || panelEl.hidden) return;
    const margin = 8;
    const viewportH = window.innerHeight;
    const rect = panelEl.getBoundingClientRect();
    if (rect.height <= 0) return;
    let nextTop = rect.top;
    if (rect.bottom > viewportH - margin) {
      nextTop = Math.max(margin, viewportH - margin - rect.height);
    }
    if (nextTop < margin) nextTop = margin;
    if (Math.round(nextTop) !== Math.round(rect.top)) {
      panelEl.style.top = `${Math.round(nextTop)}px`;
    }
  };
  const setFloatingTab = (tab, options = {}) => {
    currentFloatingTab = tab === "detail" ? "detail" : "ruby";
    if (currentFloatingTab === "detail") mountDetailControls();
    else restoreDetailControls();
    syncFloatingTabs();
    if (options.reposition !== false) {
      requestAnimationFrame(placeRubyPanelNearText);
    } else {
      // 位置は維持するが、コンテンツ高さが変わって下端からはみ出る場合は補正する。
      // rAF を 2 段噛ませて mount 後のレイアウト確定値で計測する。
      requestAnimationFrame(() => requestAnimationFrame(fitRubyPanelToViewport));
    }
  };

  rubyFloatingTabButtons.forEach((btn) => {
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    // タブ切替（ルビ ↔ 文字詳細）でパネル位置が動くとユーザーが追跡しにくいため、
    // 切替時の再配置はスキップして現在位置を維持する。新規 mount は updateSelection /
    // placeRubyPanelNearText 側で初期配置されるので問題ない。
    btn.addEventListener("click", () => setFloatingTab(btn.dataset.rubyFloatingTab, { reposition: false }));
  });

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

  let manualParentRanges = [];

  const splitRubyTextParts = (text) => String(text ?? "")
    .split(/[,\s\u3000.、]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const isDakutenChar = (ch) => {
    const code = String(ch ?? "").charCodeAt(0);
    return code === 0x309b || code === 0xff9e || code === 0x3099;
  };
  const isNakaguroChar = (ch) => {
    const code = String(ch ?? "").charCodeAt(0);
    return code === 0x30fb || code === 0xff65;
  };
  const isSpecialRubyText = (text) => {
    const chars = Array.from(String(text ?? ""));
    return chars.length > 0 && chars.every((ch) => isDakutenChar(ch) || isNakaguroChar(ch));
  };
  const DAKUTEN_RUBY = "\u309b";
  const NAKAGURO_RUBY = "\u30fb";
  const SPECIAL_BUTTONS = [
    { button: dakutenBtn, text: DAKUTEN_RUBY },
    { button: nakaguroBtn, text: NAKAGURO_RUBY },
  ];
  const SMALL_KANA_RE = /[ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶｧｨｩｪｫｯｬｭｮ]/;

  const activeEditTarget = () => {
    const ec = getEditingContext();
    if (!ec?.psdPath) return null;
    const targetId = ec.tempId ?? ec.layerId;
    if (targetId == null) return null;
    return {
      psdPath: ec.psdPath,
      layerId: ec.layerId ?? null,
      tempId: ec.tempId ?? null,
      direction: ec.direction === "horizontal" ? "horizontal" : "vertical",
      start: Number(ec.selectionStart) || 0,
      end: Number(ec.selectionEnd) || 0,
      contents: String(ec.contents ?? ""),
      objectSelection: false,
    };
  };

  const normalizeManualRanges = (ranges, contents) => {
    const len = String(contents ?? "").length;
    return ranges
      .map((r) => ({
        start: Math.max(0, Math.min(len, Number(r.start))),
        end: Math.max(0, Math.min(len, Number(r.end))),
      }))
      .filter((r) => Number.isInteger(r.start) && Number.isInteger(r.end) && r.end > r.start)
      .sort((a, b) => a.start - b.start);
  };

  const currentRubyTarget = () => {
    const editTarget = activeEditTarget();
    if (editTarget && manualParentRanges.length > 0) {
      const ranges = normalizeManualRanges(manualParentRanges, editTarget.contents);
      if (ranges.length > 0) {
        return { ...editTarget, start: ranges[0].start, end: ranges[ranges.length - 1].end, manualRanges: ranges };
      }
    }
    const sel = getLastInplaceSelection();
    if (sel && sel.end > sel.start) {
      const ec = getEditingContext();
      manualParentRanges = [];
      return { ...sel, contents: String(ec?.contents ?? ""), objectSelection: false };
    }
    return null;
  };

  const restoreRubyPanelHome = () => {
    setFloatingTab("ruby", { reposition: false });
    rubyFloatingTabs?.setAttribute("hidden", "");
    panelEl.classList.remove("ruby-panel-floating");
    panelEl.classList.remove("ruby-detail-active");
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
    if (currentFloatingTab === "detail") mountDetailControls();
    syncFloatingTabs();
    const gap = 10;
    const margin = 8;
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    panelEl.style.maxHeight = `${Math.max(120, viewportH - margin * 2)}px`;
    panelEl.style.overflowY = "auto";
    const r = getInplaceSelectionRect(target) ?? anchor.getBoundingClientRect();
    const measuredPanel = panelEl.getBoundingClientRect();
    const maxPanelW = panelEl.classList.contains("ruby-detail-active") ? 340 : 300;
    const panelW = Math.max(230, Math.min(maxPanelW, measuredPanel.width || panelEl.offsetWidth || 250));
    const panelH = Math.max(120, measuredPanel.height || panelEl.offsetHeight || 156);
    const clamp = (v, min, max) => {
      const safeMax = Math.max(min, max);
      return Math.max(min, Math.min(safeMax, v));
    };
    const overlapArea = (a, b) => {
      const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
      const h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      return w * h;
    };
    const visibleRectFor = (el) => {
      if (!el || typeof el.getBoundingClientRect !== "function") return null;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return null;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      if (rect.right <= 0 || rect.left >= viewportW || rect.bottom <= 0 || rect.top >= viewportH) return null;
      return rect;
    };
    const obstacleRects = Array.from(document.querySelectorAll(".side-toolbar, .side-panel"))
      .map(visibleRectFor)
      .filter(Boolean);
    const obstacleOverlap = (rect) => obstacleRects.reduce((sum, obstacle) => sum + overlapArea(rect, obstacle), 0);
    const badge = anchor.querySelector(".layer-size-badge");
    const handle = anchor.querySelector(".layer-rotate-handle");
    const anchorRect = anchor.getBoundingClientRect();
    // テキストフレーム本体 (layer-box) + 文字選択 selection の両方を避けるべき領域として扱う。
    // 旧実装は selection rect のみを avoid にしていたため、selection が短い場合に
    // パネルがフレーム上の他の文字に被って読めなくなることがあった。
    const avoid = r;
    const avoidRects = [r, anchorRect];
    const decorationRects = [badge, handle]
      .filter(Boolean)
      .map((el) => (typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : el));
    const decorationOverlap = (rect) => decorationRects.reduce((sum, decoration) => sum + overlapArea(rect, decoration), 0);
    const avoidOverlapTotal = (rect) => avoidRects.reduce((sum, a) => sum + overlapArea(rect, a), 0);
    const fitLeftMax = viewportW - panelW - margin;
    const fitTopMax = viewportH - panelH - margin;
    // フレーム全体 (anchorRect) を起点に右側 / 左側 / 下 / 上の 4 方向を最優先候補とし、
    // どれもダメな場合のフォールバックとして selection 周辺の候補を補完する。
    const candidates = [
      // 1. フレームの右側（最も自然な押しやすい位置）
      { left: anchorRect.right + gap, top: anchorRect.top },
      { left: anchorRect.right + gap, top: anchorRect.top + (anchorRect.height - panelH) / 2 },
      // 2. フレームの左側
      { left: anchorRect.left - gap - panelW, top: anchorRect.top },
      { left: anchorRect.left - gap - panelW, top: anchorRect.top + (anchorRect.height - panelH) / 2 },
      // 3. フレームの下
      { left: anchorRect.left + (anchorRect.width - panelW) / 2, top: anchorRect.bottom + gap },
      // 4. フレームの上
      { left: anchorRect.left + (anchorRect.width - panelW) / 2, top: anchorRect.top - gap - panelH },
      // 5. selection 周辺（フォールバック）
      { left: avoid.right + gap, top: avoid.top },
      { left: avoid.left - gap - panelW, top: avoid.top },
      { left: avoid.left, top: avoid.bottom + gap },
      { left: avoid.left, top: avoid.top - gap - panelH },
    ].map((p, priority) => {
      const left = clamp(p.left, margin, fitLeftMax);
      const top = clamp(p.top, margin, fitTopMax);
      const rect = { left, top, right: left + panelW, bottom: top + panelH };
      return {
        left,
        top,
        priority,
        overlap: avoidOverlapTotal(rect),
        decorationOverlap: decorationOverlap(rect),
        obstacleOverlap: obstacleOverlap(rect),
        distance: Math.abs(left - (anchorRect.right + gap)) + Math.abs(top - anchorRect.top),
      };
    });
    // ソート優先順位: テキスト/フレーム被り → サイドバー被り → 装飾被り → 候補順位 → 距離
    // 旧: obstacleOverlap が最優先だったため、サイドバー被りが等価ならテキスト被り
    //   候補が選ばれて文字が読めなくなることがあった。テキスト被り 0 を最優先にする。
    candidates.sort((a, b) =>
      (a.overlap - b.overlap)
      || (a.obstacleOverlap - b.obstacleOverlap)
      || (a.decorationOverlap - b.decorationOverlap)
      || (a.priority - b.priority)
      || (a.distance - b.distance)
    );
    panelEl.style.left = `${Math.round(candidates[0].left)}px`;
    panelEl.style.top = `${Math.round(candidates[0].top)}px`;
    // panel コンテンツが大きく初期配置直後の clamp で下端をはみ出すケースに備えて、
    // rAF を 2 段噛ませてレイアウト確定値で再度フィット補正する。
    requestAnimationFrame(() => requestAnimationFrame(fitRubyPanelToViewport));
  };

  const textForRanges = (contents, ranges) => ranges
    .map((r) => String(contents ?? "").slice(r.start, r.end))
    .filter(Boolean)
    .join(" / ");

  const selectedRanges = (sel) => sel?.manualRanges ?? (sel ? [{ start: sel.start, end: sel.end }] : []);

  const selectionContainsSmallKana = (sel) => {
    if (!sel) return false;
    const contents = String(sel.contents ?? "");
    return selectedRanges(sel).some((range) => SMALL_KANA_RE.test(contents.slice(range.start, range.end)));
  };

  const rubyTextMatchesForButton = (value, buttonText) => {
    if (typeof value !== "string" || !value || typeof buttonText !== "string" || !buttonText) return false;
    if (value === buttonText) return true;
    if (isNakaguroRubyMarkerText(value) && isNakaguroRubyMarkerText(buttonText)) return true;
    if (isDakutenRubyMarkerText(value) && isDakutenRubyMarkerText(buttonText)) return true;
    const chars = Array.from(value);
    return chars.length > 0 && chars.every((ch) => ch === buttonText);
  };

  const rangeHasRubyButtonText = (sel, range, text) => {
    const targetId = sel?.tempId ?? sel?.layerId;
    if (!sel?.psdPath || targetId == null || !range || typeof text !== "string" || !text) return false;
    if (!isSpecialRubyText(text)) return rangeHasRubyText(sel.psdPath, targetId, range.start, range.end, text);
    const map = getCharRubies(sel.psdPath, targetId);
    for (const k of Object.keys(map)) {
      const start = Number(k);
      const entry = map[k];
      const end = Number(entry?.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || !(start < range.end && end > range.start)) continue;
      if (rubyTextMatchesForButton(entry?.text, text)) return true;
      if (Array.isArray(entry?.overlays)) {
        for (const overlay of entry.overlays) {
          const overlayStart = Number(overlay?.start);
          const overlayEnd = Number(overlay?.end);
          if (!Number.isFinite(overlayStart) || !Number.isFinite(overlayEnd)) continue;
          if (overlayStart < range.end && overlayEnd > range.start && rubyTextMatchesForButton(overlay?.text, text)) return true;
        }
      }
    }
    return false;
  };

  const splitRangeByLineBreaks = (contents, range) => {
    const text = String(contents ?? "");
    const len = text.length;
    const from = Math.max(0, Math.min(len, Number(range?.start) || 0));
    const to = Math.max(0, Math.min(len, Number(range?.end) || 0));
    const segments = [];
    let start = from;
    let i = from;
    while (i < to) {
      const ch = text[i];
      if (ch === "\r" || ch === "\n") {
        if (start < i) segments.push({ start, end: i });
        if (ch === "\r" && i + 1 < to && text[i + 1] === "\n") i += 1;
        start = i + 1;
      }
      i += 1;
    }
    if (start < to) segments.push({ start, end: to });
    return segments;
  };

  const selectionHasRubyText = (sel, text) => {
    if (!sel) return false;
    return selectedRanges(sel).some((range) => rangeHasRubyButtonText(sel, range, text));
  };

  const setSpecialButtonState = (sel) => {
    for (const { button, text } of SPECIAL_BUTTONS) {
      if (!button) continue;
      const active = !!sel && selectionHasRubyText(sel, text);
      const warning = active && text === NAKAGURO_RUBY && selectionContainsSmallKana(sel);
      button.classList.toggle("active", active);
      button.classList.toggle("ruby-special-warning", warning);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    }
  };

  const rangesFromSelectedCells = (grid) => {
    const indices = Array.from(grid.querySelectorAll(".ruby-parent-cell.selected"))
      .map((cell) => Number(cell.dataset.index))
      .filter(Number.isInteger)
      .sort((a, b) => a - b);
    if (indices.length === 0) return [];
    const dividerAfter = new Set(
      Array.from(grid.querySelectorAll(".ruby-parent-divider.active"))
        .map((el) => Number(el.dataset.after))
        .filter(Number.isInteger),
    );
    const ranges = [];
    let start = indices[0];
    let prev = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const cur = indices[i];
      if (cur !== prev + 1 || dividerAfter.has(prev)) {
        ranges.push({ start, end: prev + 1 });
        start = cur;
      }
      prev = cur;
    }
    ranges.push({ start, end: prev + 1 });
    return ranges;
  };

  const focusRubyInput = () => {
    requestAnimationFrame(() => {
      if (inputEl.disabled) return;
      inputEl.focus({ preventScroll: true });
      const caret = inputEl.value.length;
      inputEl.setSelectionRange?.(caret, caret);
    });
  };

  const openParentSelectDialog = (triggerEvent = null) => {
    const target = activeEditTarget();
    if (!target || !target.contents) return;
    const existing = [];
    const selected = new Set();
    const dividers = new Set();
    for (let i = 0; i < existing.length; i++) {
      const r = existing[i];
      for (let n = r.start; n < r.end; n++) selected.add(n);
      if (i + 1 < existing.length && existing[i + 1].start === r.end) dividers.add(r.end - 1);
    }

    const overlay = document.createElement("div");
    const isVertical = target.direction === "vertical";
    overlay.className = `ruby-parent-dialog ${isVertical ? "ruby-parent-dialog-vertical" : "ruby-parent-dialog-horizontal"}`;
    overlay.innerHTML = `
      <div class="ruby-parent-dialog-panel" role="dialog" aria-modal="true" aria-label="親文字指定">
        <div class="ruby-parent-dialog-head">
          <strong>親文字指定</strong>
          <button class="ruby-parent-dialog-close" type="button" aria-label="閉じる">×</button>
        </div>
        <div class="ruby-parent-grid" tabindex="0"></div>
        <div class="ruby-parent-dialog-actions">
          <button class="ruby-parent-clear-btn" type="button">クリア</button>
          <button class="ruby-parent-cancel-btn" type="button">キャンセル</button>
          <button class="ruby-parent-ok-btn" type="button">OK</button>
        </div>
      </div>`;
    const grid = overlay.querySelector(".ruby-parent-grid");
    const okBtn = overlay.querySelector(".ruby-parent-ok-btn");
    const applyLayerSizedGrid = () => {
      const inner = document.querySelector(".layer-box.editing .existing-layer-text:not(.stroke-preview-underlay), .layer-box.editing .new-layer-text:not(.stroke-preview-underlay)");
      const rect = inner?.getBoundingClientRect?.();
      const lines = String(target.contents ?? "").split(/\r\n|\r|\n/);
      const maxChars = Math.max(1, ...lines.map((lineText) => lineText.length));
      const lineCount = Math.max(1, lines.length);
      let cellSize = 36;
      if (rect && rect.width > 0 && rect.height > 0) {
        const inlineSize = isVertical ? rect.height / maxChars : rect.width / maxChars;
        const blockSize = isVertical ? rect.width / lineCount : rect.height / lineCount;
        const fitted = Math.min(inlineSize, blockSize);
        if (Number.isFinite(fitted) && fitted > 0) cellSize = Math.round(fitted);
      } else {
        const fontSize = Number.parseFloat(getComputedStyle(inner ?? document.documentElement).fontSize);
        if (Number.isFinite(fontSize) && fontSize > 0) cellSize = Math.round(fontSize);
      }
      // 親文字指定ダイアログの cell size。実テキストの 0.75 倍を目安に、
      // タップしやすい最小 22px〜画面圧迫しない最大 38px でクランプする。
      const scaledSize = Math.round(cellSize * 0.75);
      const finalCellSize = Math.max(22, Math.min(38, scaledSize));
      overlay.style.setProperty("--ruby-parent-cell-size", `${finalCellSize}px`);
    };
    applyLayerSizedGrid();
    const selectedCellCount = () => grid?.querySelectorAll(".ruby-parent-cell.selected").length ?? 0;
    const updateOkState = () => {
      if (okBtn) okBtn.disabled = selectedCellCount() === 0;
    };
    const dialogPoint = () => {
      let x = Number(triggerEvent?.clientX);
      let y = Number(triggerEvent?.clientY);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        const rect = parentSelectBtn?.getBoundingClientRect?.();
        x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
        y = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
      }
      return { x, y };
    };
    const positionDialog = () => {
      const panel = overlay.querySelector(".ruby-parent-dialog-panel");
      if (!panel) return;
      const rect = panel.getBoundingClientRect();
      const margin = 8;
      const maxLeft = window.innerWidth - rect.width - margin;
      const maxTop = window.innerHeight - rect.height - margin;
      const clamp = (value, min, max) => Math.max(min, Math.min(Math.max(min, max), value));
      const point = dialogPoint();
      const left = clamp(point.x - rect.width / 2, margin, maxLeft);
      const top = clamp(point.y - rect.height / 2, margin, maxTop);
      overlay.style.setProperty("--ruby-parent-dialog-left", `${Math.round(left)}px`);
      overlay.style.setProperty("--ruby-parent-dialog-top", `${Math.round(top)}px`);
    };
    let line = document.createElement("div");
    line.className = "ruby-parent-line";
    let lastCharIndex = -1;
    const addDivider = () => {
      const divider = document.createElement("button");
      divider.className = "ruby-parent-divider";
      divider.type = "button";
      divider.dataset.after = String(lastCharIndex);
      divider.title = "ここで親文字を分割";
      if (dividers.has(lastCharIndex)) divider.classList.add("active");
      divider.addEventListener("click", () => {
        divider.classList.toggle("active");
        updateOkState();
      });
      line.appendChild(divider);
    };
    const textIndices = Array.from({ length: target.contents.length }, (_, i) => i);
    for (const i of textIndices) {
      const ch = target.contents[i];
      if (ch === "\r" || ch === "\n") {
        if (ch === "\r" && target.contents[i + 1] === "\n") continue;
        grid.appendChild(line);
        line = document.createElement("div");
        line.className = "ruby-parent-line";
        lastCharIndex = -1;
        continue;
      }
      if (lastCharIndex >= 0) addDivider();
      const cell = document.createElement("button");
      cell.className = "ruby-parent-cell";
      cell.type = "button";
      cell.dataset.index = String(i);
      cell.textContent = ch;
      if (selected.has(i)) cell.classList.add("selected");
      cell.addEventListener("click", () => {
        cell.classList.toggle("selected");
        updateOkState();
      });
      line.appendChild(cell);
      lastCharIndex = i;
    }
    grid.appendChild(line);

    // 親文字セルを長押し → ドラッグで連続選択。
    // - 短いクリック (250ms 未満で同セル内で release): 個別 toggle (既存挙動)
    // - 長押し (250ms 以上 hold) からのドラッグ: カーソルが通過したセルを順次 selected に追加。
    //   既に selected のセルはそのまま (toggle ではなく add のみ)。取り消したい場合は
    //   単発クリックで個別 toggle する。
    // - 長押し成立前でも、押下したまま別のセルへ大きく動いたら即時ドラッグモードへ移行。
    const PARENT_CELL_LONG_PRESS_MS = 250;
    let dragSelectActive = false;
    let dragSelectTimer = null;
    let dragSelectAnchorCell = null;
    const dragSelectVisited = new Set();
    const cellAtPoint = (clientX, clientY) => {
      const el = document.elementFromPoint(clientX, clientY);
      return el?.closest?.(".ruby-parent-cell") ?? null;
    };
    const enterDragSelectMode = (initialCell) => {
      if (dragSelectActive) return;
      dragSelectActive = true;
      dragSelectVisited.clear();
      if (initialCell) {
        initialCell.classList.add("selected");
        dragSelectVisited.add(initialCell);
        updateOkState();
      }
    };
    const cancelLongPressTimer = () => {
      if (dragSelectTimer) {
        clearTimeout(dragSelectTimer);
        dragSelectTimer = null;
      }
    };
    const handleDragSelectMove = (clientX, clientY) => {
      if (!dragSelectActive) return;
      const cell = cellAtPoint(clientX, clientY);
      if (!cell || dragSelectVisited.has(cell)) return;
      cell.classList.add("selected");
      dragSelectVisited.add(cell);
      updateOkState();
    };
    const endDragSelect = () => {
      cancelLongPressTimer();
      const wasActive = dragSelectActive;
      dragSelectActive = false;
      dragSelectAnchorCell = null;
      dragSelectVisited.clear();
      if (wasActive) {
        // ドラッグ選択モードを使ったときは、後続の click が発火して
        // 同セルを toggle で外してしまわないよう、一度だけ捕捉して握りつぶす。
        const swallowClick = (clickEvent) => {
          clickEvent.preventDefault();
          clickEvent.stopPropagation();
          grid.removeEventListener("click", swallowClick, true);
        };
        grid.addEventListener("click", swallowClick, true);
        setTimeout(() => grid.removeEventListener("click", swallowClick, true), 80);
      }
    };
    grid.addEventListener("pointerdown", (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      const cell = e.target?.closest?.(".ruby-parent-cell");
      if (!cell) return;
      dragSelectAnchorCell = cell;
      cancelLongPressTimer();
      dragSelectTimer = setTimeout(() => {
        dragSelectTimer = null;
        enterDragSelectMode(dragSelectAnchorCell);
      }, PARENT_CELL_LONG_PRESS_MS);
    });
    grid.addEventListener("pointermove", (e) => {
      // マウスの場合はボタンが押されているときだけ反応。タッチ/ペンは常時。
      if (e.pointerType === "mouse" && (e.buttons ?? 0) === 0) return;
      if (!dragSelectActive && dragSelectAnchorCell && dragSelectTimer) {
        // 長押し成立前でも、別セルへ移動したら即ドラッグモードに突入
        const cellNow = cellAtPoint(e.clientX, e.clientY);
        if (cellNow && cellNow !== dragSelectAnchorCell) {
          cancelLongPressTimer();
          enterDragSelectMode(dragSelectAnchorCell);
        }
      }
      handleDragSelectMove(e.clientX, e.clientY);
    });
    grid.addEventListener("pointerup", endDragSelect);
    grid.addEventListener("pointercancel", endDragSelect);
    grid.addEventListener("pointerleave", () => {
      // grid 外にカーソルが出たらタイマーだけクリア (ドラッグモード自体は継続)
      if (!dragSelectActive) cancelLongPressTimer();
    });
    window.addEventListener("blur", endDragSelect);

    const close = () => overlay.remove();
    overlay.querySelector(".ruby-parent-dialog-close")?.addEventListener("click", close);
    overlay.querySelector(".ruby-parent-cancel-btn")?.addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    overlay.querySelector(".ruby-parent-clear-btn")?.addEventListener("click", () => {
      manualParentRanges = [];
      close();
      updateSelection();
    });
    okBtn?.addEventListener("click", () => {
      manualParentRanges = normalizeManualRanges(rangesFromSelectedCells(grid), target.contents);
      close();
      updateSelection();
      focusRubyInput();
    });
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      // Enter で OK 確定。1 文字以上のセルが選択されていれば確定し、
      // 何も選択されていない (OK が disabled の) ときは無視。
      if (e.key === "Enter" && !okBtn?.disabled) {
        e.preventDefault();
        okBtn?.click();
      }
    });
    updateOkState();
    overlay.style.visibility = "hidden";
    document.body.appendChild(overlay);
    positionDialog();
    overlay.style.visibility = "";
    requestAnimationFrame(positionDialog);
    grid.focus({ preventScroll: true });
  };

  // 親文字指定ボタンの長押し → 連続適用モード ("sticky" モード)。
  // - 通常クリック (500ms 未満で release): 1 回だけ親文字指定ダイアログを開く (従来挙動)
  // - 長押し (500ms 以上 hold): sticky モード ON。ダイアログを開きつつ、以降の
  //   doApply 完了時に再度ダイアログを自動的に開き続ける (連続適用)
  // - sticky モード中にもう一度クリック (短押し): sticky モード OFF
  // - パネル外クリック / Esc / 別レイヤー選択でも sticky モード OFF
  //
  // ※ TDZ 回避のため、updateSelection の前に宣言する必要がある
  //   (updateSelection 内で setStickyMode を参照しており、updateSelection は
  //    起動直後に直接呼ばれる)。
  const STICKY_LONG_PRESS_MS = 500;
  let stickyParentSelect = false;
  let longPressTimer = null;
  let longPressTriggered = false;
  let lastTriggerEvent = null;
  const setStickyMode = (on) => {
    stickyParentSelect = !!on;
    if (parentSelectBtn) {
      parentSelectBtn.classList.toggle("sticky-mode", stickyParentSelect);
      parentSelectBtn.setAttribute(
        "aria-pressed",
        stickyParentSelect ? "true" : "false"
      );
      parentSelectBtn.title = stickyParentSelect
        ? "親文字指定 (連続適用モード中 — クリックで解除)"
        : "親文字指定 (長押しで連続適用モード)";
    }
  };
  setStickyMode(false);
  const isStickyParentSelectActive = () => stickyParentSelect;
  const reopenParentSelectIfSticky = () => {
    if (!stickyParentSelect) return;
    // 連続適用: 適用直後は selection が解除されているケースもあるため、
    // 次フレームで activeEditTarget の有無を見て再開する。
    requestAnimationFrame(() => {
      if (!stickyParentSelect) return;
      if (!activeEditTarget()) {
        // 編集対象がなくなった (フォーカス外れ等) → sticky 解除
        setStickyMode(false);
        return;
      }
      openParentSelectDialog(lastTriggerEvent);
    });
  };
  const cancelLongPress = () => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  };

  const updateSelection = () => {
    const sel = currentRubyTarget();
    if (sel && sel.end > sel.start) {
      const targetId = sel.tempId ?? sel.layerId;
      const contents = sel.contents ?? "";
      const ranges = sel.manualRanges ?? [{ start: sel.start, end: sel.end }];
      const parentText = textForRanges(contents, ranges);
      parentEl.textContent = parentText || "（選択範囲）";
      inputEl.disabled = false;
      applyBtn.disabled = false;
      if (parentSelectBtn) parentSelectBtn.disabled = false;
      if (dakutenBtn) dakutenBtn.disabled = false;
      if (nakaguroBtn) nakaguroBtn.disabled = false;
      setSpecialButtonState(sel);
      const existing = sel.rubyOnly
        ? getCharRubyForRange(sel.psdPath, targetId, sel.start, sel.end, sel.rubyText ?? "", { overlay: sel.rubyOverlay === true })
        : getCharRubyAt(sel.psdPath, targetId, sel.start);
      if (existing && (sel.rubyOnly || existing.end === sel.end)) {
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
      if (parentSelectBtn) parentSelectBtn.disabled = !activeEditTarget();
      if (dakutenBtn) dakutenBtn.disabled = true;
      if (nakaguroBtn) nakaguroBtn.disabled = true;
      setSpecialButtonState(null);
      removeBtn.disabled = true;
      inputEl.value = "";
      scaleEl.value = "50";
      setMode("auto");
      // 編集対象自体が外れたら連続適用モードも解除する
      if (!activeEditTarget() && typeof setStickyMode === "function") {
        setStickyMode(false);
      }
    }
    placeRubyPanelNearText();
  };
  onInplaceSelectionChange(updateSelection);
  window.addEventListener("psdesign:selection-changed", updateSelection);
  window.addEventListener("resize", placeRubyPanelNearText);
  window.addEventListener("scroll", placeRubyPanelNearText, true);
  updateSelection();

  parentSelectBtn?.addEventListener("pointerdown", (e) => {
    if (parentSelectBtn.disabled) return;
    if (e.button !== 0 && e.pointerType === "mouse") return;
    longPressTriggered = false;
    lastTriggerEvent = e;
    cancelLongPress();
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      longPressTriggered = true;
      // 長押し成立: sticky モード ON + そのままダイアログを開く
      setStickyMode(true);
      openParentSelectDialog(e);
    }, STICKY_LONG_PRESS_MS);
  });
  parentSelectBtn?.addEventListener("pointerup", (e) => {
    cancelLongPress();
    if (longPressTriggered) {
      // 長押し成立済み: pointerup の後続 click は無視 (重複オープン防止)
      longPressTriggered = false;
      return;
    }
    if (parentSelectBtn.disabled) return;
    if (e.button !== 0 && e.pointerType === "mouse") return;
    lastTriggerEvent = e;
    if (stickyParentSelect) {
      // sticky モード中の短押し: モード解除のみ (ダイアログは開かない)
      setStickyMode(false);
      return;
    }
    openParentSelectDialog(e);
  });
  parentSelectBtn?.addEventListener("pointerleave", cancelLongPress);
  parentSelectBtn?.addEventListener("pointercancel", cancelLongPress);
  // 既存の click ハンドラは pointerup でカバーするので登録しない。
  // ただしキーボード操作 (Tab + Space/Enter) も拾えるように keydown を追加。
  parentSelectBtn?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (parentSelectBtn.disabled) return;
    e.preventDefault();
    if (stickyParentSelect) {
      setStickyMode(false);
      return;
    }
    openParentSelectDialog(e);
  });

  const buildRubyApplications = (sel, text, scale) => {
    const ranges = sel.manualRanges ?? [{ start: sel.start, end: sel.end }];
    if (isSpecialRubyText(text)) {
      const chars = Array.from(text);
      const apps = [];
      for (const range of ranges) {
        if (chars.length === 1 && isNakaguroChar(chars[0])) {
          for (const segment of splitRangeByLineBreaks(sel.contents ?? "", range)) {
            const parentText = String(sel.contents ?? "").slice(segment.start, segment.end);
            const count = Array.from(parentText).length;
            if (count <= 0) continue;
            apps.push({
              ...segment,
              text: NAKAGURO_RUBY.repeat(count),
              type: "group",
              scale: 100,
              adjustLeading: true,
              overlay: true,
            });
          }
          continue;
        }
        for (const segment of splitRangeByLineBreaks(sel.contents ?? "", range)) {
          for (let i = segment.start; i < segment.end; i++) {
            const ch = chars[(i - segment.start) % chars.length];
            apps.push({ start: i, end: i + 1, text: ch, type: "mono", scale: 100, adjustLeading: !isDakutenChar(ch), overlay: true });
          }
        }
      }
      return apps;
    }
    const parts = splitRubyTextParts(text);
    if (ranges.length > 1 && parts.length === ranges.length) {
      return ranges.map((range, i) => ({
        ...range,
        text: parts[i],
        type: decideRubyType(currentMode, parts[i], String(sel.contents ?? "").slice(range.start, range.end)),
        scale,
      }));
    }
    if (ranges.length > 1 && parts.length === 1) {
      return ranges.map((range) => ({
        ...range,
        text,
        type: decideRubyType(currentMode, text, String(sel.contents ?? "").slice(range.start, range.end)),
        scale,
      }));
    }
    const parentText = textForRanges(sel.contents ?? "", ranges);
    return [{ start: sel.start, end: sel.end, text, type: decideRubyType(currentMode, text, parentText), scale }];
  };

  const doApply = (rubyTextOverride = null, options = {}) => {
    const sel = currentRubyTarget();
    if (!sel || sel.end <= sel.start) return;
    const hasTextOverride = typeof rubyTextOverride === "string";
    const text = String(hasTextOverride ? rubyTextOverride : inputEl.value).trim();
    if (!text) return;
    if (!hasTextOverride && isSpecialRubyText(text) && selectionHasRubyText(sel, text)) return;
    const targetId = sel.tempId ?? sel.layerId;
    const scale = clampRubyScale(scaleEl.value);
    const contents = sel.contents ?? "";
    const applications = buildRubyApplications(sel, text, scale);
    if (applications.length === 0) return;
    const rubyLeadingPct = Number(getDefault("rubyLeadingPct")) || 150;
    const lineIndexAt = (index) => {
      const head = contents.slice(0, Math.max(0, index));
      return head.split(/\r\n|\r|\n/).length - 1;
    };
    // 【v2.2.x】ルビ適用で行間が広がる前の bbox 中心を取得しておく。withHistoryTransient
    // 完了後に recenterLayerToCenter で同じ中心に揃え直すと、フキダシ中央に置いた
    // テキストがルビ適用瞬間にズレる問題を解消できる。
    let layerRef = null;
    let oldCenter = null;
    try {
      const refPage = getPages().find((p) => p.path === sel.psdPath);
      if (refPage) {
        if (sel.layerId != null) {
          const layer = refPage.textLayers?.find((l) => Number(l.id) === Number(sel.layerId));
          if (layer) layerRef = { kind: "existing", page: refPage, layer };
        } else if (sel.tempId != null) {
          const nl = getNewLayersForPsd(refPage.path).find((l) => l.tempId === sel.tempId);
          if (nl) layerRef = { kind: "new", page: refPage, newLayer: nl };
        }
      }
      if (layerRef) oldCenter = getLayerCenter(layerRef);
    } catch (_) { /* recenter は best-effort */ }
    let didAdjustLeading = false;
    withHistoryTransient(() => {
      for (const app of applications) {
        setCharRubiesRange(sel.psdPath, targetId, app.start, app.end, app.text, app.type, app.scale, { appendOverlay: !!app.overlay });
        if (app.adjustLeading === false) continue;
        const startLine = lineIndexAt(app.start);
        const endLine = lineIndexAt(Math.max(app.start, app.end - 1));
        for (let li = startLine; li <= endLine; li++) {
          const targetLine = li - 1;
          if (targetLine < 0) continue;
          setLineLeading(sel.psdPath, targetId, targetLine, rubyLeadingPct);
          didAdjustLeading = true;
        }
      }
      // 行間を広げた直後は bbox の縦/横が変わって top-left 固定だと中心がズレる。
      // 同 transient 内で recenter まで実行することで Ctrl+Z 1 回ですべて巻き戻る。
      if (didAdjustLeading && layerRef && oldCenter) {
        try { recenterLayerToCenter(layerRef, oldCenter); } catch (_) { /* best-effort */ }
      }
    });
    if (!sel.objectSelection) {
      for (const app of applications) {
        applyEditModeRubyToRange(app.start, app.end, app.text, app.type, app.scale, { appendOverlay: !!app.overlay });
      }
      if (didAdjustLeading) resizeActiveInPlaceEditBoxToState(sel);
      refreshActiveInPlaceEditPreview(sel);
    }
    refreshAllOverlays();
    rebuildLayerList();
    if (!sel.objectSelection) {
      restoreInplaceSelection(sel);
      requestAnimationFrame(() => restoreInplaceSelection(sel));
    }
    removeBtn.disabled = false;
    requestAnimationFrame(() => {
      updateSelection();
      if (typeof options.preserveInputValue === "string") inputEl.value = options.preserveInputValue;
      // 連続適用 (sticky) モード中なら次の親文字選択ダイアログを自動で開き直す
      if (isStickyParentSelectActive()) reopenParentSelectIfSticky();
    });
  };

  const toggleSpecialRuby = (rubyText) => {
    const sel = currentRubyTarget();
    if (!sel || sel.end <= sel.start) return;
    const previousInputValue = inputEl.value;
    const targetId = sel.tempId ?? sel.layerId;
    const applications = buildRubyApplications(sel, rubyText, 100);
    const hasMatchingRuby = applications.some((app) => rangeHasRubyButtonText(sel, app, rubyText))
      || selectionHasRubyText(sel, rubyText);
    if (!hasMatchingRuby) {
      doApply(rubyText, { preserveInputValue: previousInputValue });
      return;
    }
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
    const rangeHasAnyLeadingRuby = (from, to) => {
      const map = getCharRubies(sel.psdPath, targetId);
      for (const k of Object.keys(map)) {
        const start = Number(k);
        const entry = map[k];
        const end = Number(entry?.end);
        if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
        if (start < to && end > from && !isDakutenRubyMarkerText(entry?.text)) return true;
        if (Array.isArray(entry?.overlays)) {
          for (const overlay of entry.overlays) {
            const overlayStart = Number(overlay?.start);
            const overlayEnd = Number(overlay?.end);
            if (!Number.isFinite(overlayStart) || !Number.isFinite(overlayEnd)) continue;
            if (overlayStart < to && overlayEnd > from && !isDakutenRubyMarkerText(overlay?.text)) return true;
          }
        }
      }
      return false;
    };
    const clearRubyLineLeadingIfEmpty = (from, to) => {
      const startLine = lineIndexAt(from);
      const endLine = lineIndexAt(Math.max(from, to - 1));
      for (let li = startLine; li <= endLine; li++) {
        const targetLine = li - 1;
        if (targetLine < 0) continue;
        const range = lineRangeAt(li);
        if (!range) continue;
        if (!rangeHasAnyLeadingRuby(range.start, range.end)) {
          setLineLeading(sel.psdPath, targetId, targetLine, null);
        }
      }
    };
    const ranges = applications.length > 0 ? applications : selectedRanges(sel);
    let didAdjustLeading = false;
    withHistoryTransient(() => {
      for (const range of ranges) {
        removeRubyTextRange(sel.psdPath, targetId, range.start, range.end, rubyText);
        if (range.adjustLeading !== false) {
          clearRubyLineLeadingIfEmpty(range.start, range.end);
          didAdjustLeading = true;
        }
      }
    });
    if (!sel.objectSelection) {
      for (const range of ranges) {
        removeEditModeRubyTextFromRange(range.start, range.end, rubyText);
      }
      if (didAdjustLeading) resizeActiveInPlaceEditBoxToState(sel);
      refreshActiveInPlaceEditPreview(sel);
    }
    refreshAllOverlays();
    rebuildLayerList();
    if (!sel.objectSelection) {
      restoreInplaceSelection(sel);
      requestAnimationFrame(() => restoreInplaceSelection(sel));
    }
    inputEl.value = previousInputValue === rubyText ? "" : previousInputValue;
    requestAnimationFrame(() => {
      updateSelection();
      if (previousInputValue && previousInputValue !== rubyText) inputEl.value = previousInputValue;
    });
  };

  applyBtn.addEventListener("click", doApply);
  scaleEl?.addEventListener("input", () => {
    const sel = currentRubyTarget();
    if (!sel?.rubyOnly) return;
    const scale = clampRubyScale(scaleEl.value);
    applyRubyScaleToSelection(sel, scale);
  });
  scaleEl?.addEventListener("blur", () => {
    const sel = currentRubyTarget();
    if (!sel?.rubyOnly) return;
    const entry = getRubySelectionEntry(sel);
    if (entry?.scale) scaleEl.value = String(entry.scale);
  });
  dakutenBtn?.addEventListener("click", () => {
    toggleSpecialRuby(DAKUTEN_RUBY);
  });
  nakaguroBtn?.addEventListener("click", () => {
    toggleSpecialRuby(NAKAGURO_RUBY);
  });

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
    const rangeHasAnyLeadingRuby = (from, to) => {
      const map = getCharRubies(sel.psdPath, targetId);
      for (const k of Object.keys(map)) {
        const start = Number(k);
        const entry = map[k];
        const end = Number(entry?.end);
        if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
        if (start < to && end > from && !isDakutenRubyMarkerText(entry?.text)) return true;
        if (Array.isArray(entry?.overlays)) {
          for (const overlay of entry.overlays) {
            const overlayStart = Number(overlay?.start);
            const overlayEnd = Number(overlay?.end);
            if (!Number.isFinite(overlayStart) || !Number.isFinite(overlayEnd)) continue;
            if (overlayStart < to && overlayEnd > from && !isDakutenRubyMarkerText(overlay?.text)) return true;
          }
        }
      }
      return false;
    };
    const clearRubyLineLeadingIfEmpty = (from, to) => {
      const startLine = lineIndexAt(from);
      const endLine = lineIndexAt(Math.max(from, to - 1));
      for (let li = startLine; li <= endLine; li++) {
        const targetLine = li - 1;
        if (targetLine < 0) continue;
        const range = lineRangeAt(li);
        if (!range) continue;
        if (!rangeHasAnyLeadingRuby(range.start, range.end)) {
          setLineLeading(sel.psdPath, targetId, targetLine, null);
        }
      }
    };
    if (sel.rubyOnly) {
      withHistoryTransient(() => {
        if (sel.rubyOverlay) {
          removeRubyTextRange(sel.psdPath, targetId, sel.start, sel.end, sel.rubyText ?? "");
        } else {
          removeCharRubyAt(sel.psdPath, targetId, sel.start);
          setCharRubiesRange(sel.psdPath, targetId, sel.start, sel.end, "", "group", 50);
        }
        clearRubyLineLeadingIfEmpty(sel.start, sel.end);
      });
      if (!sel.objectSelection) {
        if (sel.rubyOverlay) removeEditModeRubyTextFromRange(sel.start, sel.end, sel.rubyText ?? "");
        else removeEditModeRubyFromRange(sel.start, sel.end);
      }
      refreshAllOverlays();
      rebuildLayerList();
      inputEl.value = "";
      removeBtn.disabled = true;
      requestAnimationFrame(updateSelection);
      return;
    }
    const rubyAtStart = getCharRubyAt(sel.psdPath, targetId, sel.start);
    const rubyAtEnd = getCharRubyAt(sel.psdPath, targetId, Math.max(sel.start, sel.end - 1));
    const rubyToRemove = rubyAtStart ?? rubyAtEnd ?? null;
    const removeStart = sel.manualRanges ? sel.start : (rubyToRemove?.start ?? sel.start);
    const removeEnd = sel.manualRanges ? sel.end : (rubyToRemove?.end ?? sel.end);
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
  const stepButtons = Array.from(document.querySelectorAll(".size-step-btn[data-size-step]"));
  if (!input || !dec || !inc) return;

  const syncStepControls = () => {
    const step = getSizeStep();
    input.step = String(step);
    stepButtons.forEach((btn) => {
      const active = normalizeSizeStep(btn.dataset.sizeStep) === step;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
  };
  syncStepControls();
  onSettingsChange(syncStepControls);

  input.value = String(getTextSize());
  onTextSizeChange((v) => {
    if (document.activeElement !== input) input.value = String(v);
  });
  onInplaceSelectionChange((sel) => {
    if (sel?.rubyOnly) syncTextSizeFromRubySelection(sel);
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
  stepButtons.forEach((btn) => {
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", () => {
      setDefault("textSizeStep", normalizeSizeStep(btn.dataset.sizeStep));
      syncStepControls();
    });
  });
  dec.addEventListener("click", () => stepTextSize(-1));
  inc.addEventListener("click", () => stepTextSize(+1));
}

function applyLeading(n) {
  const v = clampLeading(n);
  const ec = getEditingContext();
  if (ec) {
    const targetId = ec.tempId ?? ec.layerId;
    const targetLines = leadingTargetLinesForEditingContext(ec);
    withHistoryTransient(() => {
      for (const lineIndex of targetLines) {
        setLineLeading(ec.psdPath, targetId, lineIndex, v);
      }
    });
    resizeActiveInPlaceEditBoxToState();
    refreshActiveInPlaceEditPreview();
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

function lineIndexAtTextOffset(text, index) {
  const head = String(text ?? "").slice(0, Math.max(0, index));
  return head.split(/\r\n|\r|\n/).length - 1;
}

function leadingTargetLinesForEditingContext(ec) {
  if (!ec) return [];
  const totalLines = Math.max(1, Number(ec.totalLines) || 1);
  const contents = String(ec.contents ?? "");
  const start = Math.max(0, Number(ec.selectionStart) || 0);
  const end = Math.max(start, Number(ec.selectionEnd) || start);
  if (end > start) {
    const startLine = lineIndexAtTextOffset(contents, start);
    const endLine = lineIndexAtTextOffset(contents, Math.max(start, end - 1));
    const targets = [];
    for (let line = startLine; line <= endLine; line++) {
      if (line > 0) targets.push(line - 1);
    }
    if (!targets.length && totalLines > 1) targets.push(0);
    return [...new Set(targets)];
  }
  const line = Math.max(0, Number(ec.currentLineIndex) || 0);
  if (line > 0) return [line - 1];
  return totalLines > 1 ? [0] : [0];
}

function leadingValueForEditingContext(ec) {
  if (!ec) return getLeadingPct();
  const targetId = ec.tempId ?? ec.layerId;
  const targets = leadingTargetLinesForEditingContext(ec);
  const first = targets[0] ?? 0;
  return getLineLeading(ec.psdPath, targetId, first) ?? getLeadingPct();
}

function adjustLeading(delta) {
  const ec = getEditingContext();
  if (ec) {
    const cur = leadingValueForEditingContext(ec);
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
  const v = leadingValueForEditingContext(ec);
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
      const v = leadingValueForEditingContext(ec);
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
  const projectFiles = [];
  const txtFiles = [];
  const pdfFiles = [];
  const unknowns = [];
  for (const p of paths) {
    if (/\.opus$/i.test(p)) projectFiles.push(p);
    else if (/\.psd$/i.test(p)) psdFiles.push(p);
    else if (/\.txt$/i.test(p)) txtFiles.push(p);
    else if (/\.(pdf|jpe?g|png)$/i.test(p)) pdfFiles.push(p);
    else unknowns.push(p);
  }
  if (projectFiles.length > 0) {
    await openProjectFromPath(projectFiles[0]);
    return;
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

function normalizeStartupProjectPath(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  if (!/^file:\/\//i.test(raw)) return raw;
  try {
    const url = new URL(raw);
    let path = decodeURIComponent(url.pathname);
    if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
    return path.replace(/\//g, "\\");
  } catch (_) {
    return raw;
  }
}

async function openStartupProjectFromArgs() {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const args = await invoke("startup_args");
    if (!Array.isArray(args)) return;
    const projectPath = args
      .map(normalizeStartupProjectPath)
      .find((path) => typeof path === "string" && /\.opus$/i.test(path));
    if (!projectPath) return;
    await openProjectFromPath(projectPath);
  } catch (e) {
    console.warn("startup project open skipped:", e);
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
  // 見開き編集時は spread-view.js 側で baseScale を 1.0 にしているので、
  // 表示倍率もそれに合わせて 100% を起点にする。
  const inSpreadEdit = pane !== "pdf" && getParallelViewMode() === "spreadEdit";
  const base = pane === "pdf"
    ? PDF_FIT_BASE_SCALE
    : (inSpreadEdit ? 1.0 : PSD_FIT_BASE_SCALE);
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
  // 見開き編集 ↔ 単ページ切替で base scale が変わるため zoom 表示も再計算する。
  onParallelViewModeChange(updateLevel);

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
        if (pane === "pdf") setNextPdfZoomAnchorFromClientPoint(e.clientX, e.clientY);
        else setNextPsdZoomAnchorFromClientPoint(e.clientX, e.clientY);
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
  let closeConfirmOpen = false;
  let allowWindowClose = false;
  const exitAppWithoutSaving = async (win) => {
    allowWindowClose = true;
    const fallbackTimer = window.setTimeout(() => {
      import("@tauri-apps/plugin-process")
        .then(({ exit }) => exit(0))
        .catch((e) => console.warn("process exit fallback failed:", e));
    }, 250);
    try {
      await win.destroy();
    } catch (e) {
      console.warn("window destroy failed, falling back to process exit:", e);
      try {
        const { exit } = await import("@tauri-apps/plugin-process");
        await exit(0);
      } catch (exitErr) {
        console.error("process exit failed:", exitErr);
      }
    } finally {
      window.clearTimeout(fallbackTimer);
    }
  };
  const confirmAndCloseWindow = async (win) => {
    if (closeConfirmOpen) return false;
    if (!hasEdits()) {
      await win.close();
      return true;
    }
    closeConfirmOpen = true;
    try {
      const ok = await confirmDialog({
        title: "未保存の編集があります",
        message: "保存していない編集内容があります。保存せずに終了しますか？",
        confirmLabel: "保存せずに終了",
        cancelLabel: "キャンセル",
        kind: "warning",
      });
      if (!ok) return false;
      await exitAppWithoutSaving(win);
      return true;
    } finally {
      closeConfirmOpen = false;
    }
  };
  min.addEventListener("click", async () => { (await getWin()).minimize(); });
  max.addEventListener("click", async () => { (await getWin()).toggleMaximize(); });
  close.addEventListener("click", async () => {
    console.log("[close-btn] clicked, hasEdits=", hasEdits(), "closeConfirmOpen=", closeConfirmOpen);
    try {
      const result = await confirmAndCloseWindow(await getWin());
      console.log("[close-btn] confirmAndCloseWindow result=", result);
    } catch (err) {
      console.error("[close-btn] error:", err);
    }
  });
  void getWin().then((win) => win.onCloseRequested(async (event) => {
    console.log("[close-req] received, allow=", allowWindowClose, "hasEdits=", hasEdits());
    if (allowWindowClose) return;
    if (!hasEdits()) return;
    event.preventDefault();
    await confirmAndCloseWindow(win);
  })).catch((e) => console.warn("close-request listener failed:", e));
}

function showHomeScreen() {
  document.body.classList.add("home-mode");
}

function hideHomeScreen() {
  document.body.classList.remove("home-mode");
}

function setHomeScanEngineState(available) {
  homeScanEngineAvailable = available;
  const missing = available === false;
  document.body.classList.toggle("home-scan-engine-missing", missing);
  const homeInner = document.querySelector("#home-screen .home-screen-inner");
  const grid = document.querySelector("#home-screen .home-start-grid");
  let warning = document.getElementById("home-scan-engine-warning");
  if (missing && homeInner && grid) {
    if (!warning) {
      warning = document.createElement("div");
      warning.id = "home-scan-engine-warning";
      warning.className = "home-scan-engine-warning";
      warning.setAttribute("role", "status");
      warning.innerHTML = `
        <span class="home-scan-engine-warning-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="6.25"/>
            <path d="M12 8.75v3.6"/>
            <path d="M12 15.3h.01"/>
          </svg>
        </span>
        <span class="home-scan-engine-warning-text">画像スキャンエンジンが未インストールです</span>
        <button type="button" class="home-scan-engine-install-btn">インストール</button>
      `;
      warning.querySelector(".home-scan-engine-install-btn")?.addEventListener("click", () => {
        document.getElementById("scan-install-btn")?.click();
      });
      homeInner.insertBefore(warning, grid);
    }
    warning.hidden = false;
  } else if (warning) {
    warning.hidden = true;
  }

  for (const id of ["home-transcribe-start-btn", "home-typeset-start-btn", "home-project-open-btn"]) {
    const btn = document.getElementById(id);
    const card = btn?.closest(".home-start-card");
    if (!btn || !card) continue;
    btn.disabled = missing;
    btn.setAttribute("aria-disabled", missing ? "true" : "false");
    btn.title = missing ? "画像スキャンエンジンをインストールしてください" : "";
    card.classList.toggle("engine-missing", missing);
  }
}

async function refreshHomeScanEngineState() {
  try {
    const status = await checkScanModelsStatus();
    setHomeScanEngineState(!!status?.available);
    return !!status?.available;
  } catch (e) {
    console.warn("scan engine status check failed:", e);
    setHomeScanEngineState(false);
    return false;
  }
}

async function ensureHomeScanEngineReady() {
  if (homeScanEngineAvailable === true) return true;
  const available = await refreshHomeScanEngineState();
  if (available) return true;
  await notifyDialog({
    title: "画像スキャンエンジンが未インストールです",
    message: "ホーム画面左下のメニューから画像スキャンエンジンをインストールしてください。",
    kind: "warning",
  });
  return false;
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

function samePathList(a, b) {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const sort = (list) => normalizeHomeFlowPaths(list)
    .sort((x, y) => collator.compare(homeFlowBaseName(x), homeFlowBaseName(y)));
  const aa = sort(a);
  const bb = sort(b);
  if (aa.length !== bb.length) return false;
  return aa.every((path, i) => path === bb[i]);
}

function sameNumberSet(a, b) {
  const aa = new Set(Array.from(a || []).map(Number).filter((v) => Number.isInteger(v)));
  const bb = new Set(Array.from(b || []).map(Number).filter((v) => Number.isInteger(v)));
  if (aa.size !== bb.size) return false;
  for (const v of aa) {
    if (!bb.has(v)) return false;
  }
  return true;
}

function referenceSelectionMatchesLoaded(paths, hiddenPages) {
  return !!getPdfDoc()
    && samePathList(getPdfPaths(), paths)
    && sameNumberSet(getPdfExcludedReferencePages(), hiddenPages);
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

function homeTypesetFontSearchText(font) {
  const aliases = Array.isArray(font?.aliases) ? font.aliases : [];
  return [
    font?.name,
    font?.postScriptName,
    ...aliases,
  ].filter(Boolean).join(" ").toLowerCase();
}

function homeTypesetDisplayFontName(psName) {
  return getFontDisplayName(psName) || psName || "";
}

function resolveHomeTypesetFont(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  return getFonts().find((font) => font.postScriptName === text)
    ?? getFonts().find((font) => font.name === text)
    ?? getFonts().find((font) => homeTypesetDisplayFontName(font.postScriptName).toLowerCase() === lower)
    ?? getFonts().find((font) => (font.postScriptName ?? "").toLowerCase() === lower)
    ?? getFonts().find((font) => (font.name ?? "").toLowerCase() === lower)
    ?? null;
}

function openHomeTypesetDialog() {
  return new Promise((resolve) => {
    let referencePaths = [];
    let psdPaths = [];
    let txtPath = null;
    let settled = false;
    let pickingFile = false;
    let referencePageCount = null;
    let hiddenReferencePages = new Set();
    let referenceLoading = false;
    let baseTextSize = clampSize(getDefault("textSize") ?? getTextSize());
    let baseFontPs = String(getDefault("fontPostScriptName") || getCurrentFont() || "");
    let fontComboOpen = false;
    const modal = document.createElement("div");
    modal.className = "home-typeset-modal";
    modal.hidden = true;
    modal.innerHTML = `
      <div class="home-typeset-card" role="dialog" aria-modal="true" aria-labelledby="home-typeset-title">
        <div class="home-typeset-header">
          <span class="home-typeset-title" id="home-typeset-title">写植用ファイルを選択</span>
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
        <div class="home-typeset-settings" aria-label="写植設定">
          <div class="home-typeset-setting home-typeset-size-setting">
            <span class="home-typeset-setting-label">基本ポイント数</span>
            <span class="home-typeset-size-field">
              <input id="home-typeset-size" class="home-typeset-size-input" type="number" min="6" max="999" step="0.5" inputmode="decimal" aria-label="基本ポイント数" />
              <span class="home-typeset-size-unit">pt</span>
            </span>
          </div>
          <div class="home-typeset-setting home-typeset-font-setting">
            <span class="home-typeset-setting-label">基本フォント</span>
            <span class="home-typeset-font-combo" id="home-typeset-font-combo">
              <input id="home-typeset-font" class="home-typeset-font-input" type="search" autocomplete="off" spellcheck="false" aria-label="基本フォント" />
              <button class="home-typeset-font-toggle" type="button" aria-label="フォント一覧を開く">⌃</button>
              <ul class="home-typeset-font-list" id="home-typeset-font-list" hidden></ul>
            </span>
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
      psd: { title: "PSD", desc: "複数選択できます", icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5z"/><polyline points="14 2 14 8 20 8"/><text x="12" y="19" font-size="7" text-anchor="middle" fill="currentColor" stroke="none" style="font-family: var(--ui-font); font-weight: 700;">PSD</text></svg>' },
      txt: { title: "テキスト", desc: "未選択の場合は画像スキャン結果を使用", icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5z"/><polyline points="14 2 14 8 20 8"/><text x="12" y="19" font-size="7" text-anchor="middle" fill="currentColor" stroke="none" style="font-family: var(--ui-font); font-weight: 700;">TXT</text></svg>' },
    };
    modal.querySelector(".home-typeset-title").textContent = "写植用ファイルを選択";
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
    const sizeInput = modal.querySelector("#home-typeset-size");
    const fontInput = modal.querySelector("#home-typeset-font");
    const fontCombo = modal.querySelector("#home-typeset-font-combo");
    const fontToggle = modal.querySelector(".home-typeset-font-toggle");
    const fontList = modal.querySelector("#home-typeset-font-list");
    const fontFamilyFor = (font) => {
      const parts = [];
      if (font?.name) parts.push(`"${String(font.name).replace(/"/g, '\\"')}"`);
      if (font?.postScriptName && font.postScriptName !== font.name) {
        parts.push(`"${String(font.postScriptName).replace(/"/g, '\\"')}"`);
      }
      parts.push("sans-serif");
      return parts.join(", ");
    };
    const syncSizeInput = () => {
      if (sizeInput) sizeInput.value = String(baseTextSize);
    };
    const syncFontInput = () => {
      if (!fontInput) return;
      fontInput.dataset.ps = baseFontPs;
      fontInput.value = homeTypesetDisplayFontName(baseFontPs);
      const font = getFonts().find((f) => f.postScriptName === baseFontPs);
      fontInput.style.fontFamily = font ? fontFamilyFor(font) : "";
    };
    const renderFontOptions = (query = "") => {
      if (!fontList) return;
      fontList.innerHTML = "";
      const q = String(query ?? "").trim().toLowerCase();
      const fonts = getFonts();
      const matches = fonts
        .filter((font) => !q || homeTypesetFontSearchText(font).includes(q) || homeTypesetDisplayFontName(font.postScriptName).toLowerCase().includes(q))
        .slice(0, 80);
      if (!matches.length) {
        const empty = document.createElement("li");
        empty.className = "home-typeset-font-empty";
        empty.textContent = fonts.length ? "該当するフォントがありません" : "フォント一覧を読み込み中です";
        fontList.appendChild(empty);
        return;
      }
      for (const font of matches) {
        const li = document.createElement("li");
        li.className = "home-typeset-font-item";
        li.dataset.ps = font.postScriptName || "";
        li.style.fontFamily = fontFamilyFor(font);
        li.textContent = homeTypesetDisplayFontName(font.postScriptName) || font.name || font.postScriptName || "";
        li.title = font.postScriptName || li.textContent;
        li.setAttribute("aria-selected", font.postScriptName === baseFontPs ? "true" : "false");
        li.addEventListener("mousedown", (e) => e.preventDefault());
        li.addEventListener("click", () => {
          if (!font.postScriptName) return;
          baseFontPs = font.postScriptName;
          ensureFontLoaded(baseFontPs);
          syncFontInput();
          closeFontCombo();
        });
        fontList.appendChild(li);
      }
    };
    const openFontCombo = (query = "") => {
      if (!fontList) return;
      fontComboOpen = true;
      renderFontOptions(query);
      fontList.hidden = false;
      fontCombo?.classList.add("open");
    };
    const closeFontCombo = () => {
      fontComboOpen = false;
      if (fontList) fontList.hidden = true;
      fontCombo?.classList.remove("open");
    };
    const commitFontInput = () => {
      if (!fontInput) return;
      const font = resolveHomeTypesetFont(fontInput.value);
      if (font?.postScriptName) {
        baseFontPs = font.postScriptName;
        ensureFontLoaded(baseFontPs);
      }
      syncFontInput();
      closeFontCombo();
    };
    const applyTypesetDefaults = () => {
      baseTextSize = clampSize(sizeInput?.value ?? baseTextSize);
      const font = resolveHomeTypesetFont(fontInput?.value) ?? getFonts().find((f) => f.postScriptName === baseFontPs);
      if (font?.postScriptName) baseFontPs = font.postScriptName;
      setDefault("textSize", baseTextSize);
      setTextSize(baseTextSize);
      if (baseFontPs) {
        setDefault("fontPostScriptName", baseFontPs);
        setCurrentFont(baseFontPs);
        ensureFontLoaded(baseFontPs);
      }
      syncSizeInput();
      syncFontInput();
    };
    const onFontsLoadedForTypeset = () => {
      syncFontInput();
      if (fontComboOpen) renderFontOptions(fontInput?.value ?? "");
    };
    syncSizeInput();
    syncFontInput();
    window.addEventListener("psdesign:fonts-loaded", onFontsLoadedForTypeset);
    sizeInput?.addEventListener("change", () => {
      baseTextSize = clampSize(sizeInput.value);
      syncSizeInput();
    });
    sizeInput?.addEventListener("blur", () => {
      baseTextSize = clampSize(sizeInput.value);
      syncSizeInput();
    });
    fontInput?.addEventListener("focus", () => openFontCombo(""));
    fontInput?.addEventListener("input", () => openFontCombo(fontInput.value));
    fontInput?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commitFontInput();
      } else if (e.key === "Escape" && fontComboOpen) {
        e.preventDefault();
        syncFontInput();
        closeFontCombo();
      }
    });
    fontInput?.addEventListener("blur", () => {
      window.setTimeout(() => {
        if (!fontCombo?.contains(document.activeElement)) commitFontInput();
      }, 0);
    });
    fontToggle?.addEventListener("click", () => {
      if (fontComboOpen) closeFontCombo();
      else {
        fontInput?.focus();
        openFontCombo("");
      }
    });
    modal.addEventListener("mousedown", (e) => {
      if (!fontCombo?.contains(e.target)) closeFontCombo();
    });
    const getReferenceDisplayCount = () => Number.isFinite(referencePageCount) ? referencePageCount : referencePaths.length;
    const loadSelectedReference = async () => {
      const paths = [...referencePaths];
      if (paths.length === 0) {
        referencePageCount = null;
        return 0;
      }
      if (referenceSelectionMatchesLoaded(paths, hiddenReferencePages)) {
        referencePageCount = Math.max(0, getPdfVirtualPageCount());
        update();
        return getReferenceDisplayCount();
      }
      referenceLoading = true;
      update();
      try {
        await loadReferenceFiles(paths, {
          skipFirstBlankPage: false,
          excludedPages: hiddenReferencePages,
          showProgress: false,
        });
        referencePageCount = referenceSelectionMatchesLoaded(paths, hiddenReferencePages)
          ? Math.max(0, getPdfVirtualPageCount())
          : paths.length;
      } catch (e) {
        console.error("loadReferenceFiles failed:", e);
        referencePageCount = paths.length;
      } finally {
        referenceLoading = false;
        update();
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
        row.classList.toggle("loading", slot === "reference" && referenceLoading);
        row.classList.toggle("selected", active);
      }
      const hideBtn = modal.querySelector("[data-reference-hide]");
      if (hideBtn) {
        hideBtn.disabled = referencePaths.length === 0 || referenceLoading;
        hideBtn.classList.toggle("selected", hiddenReferencePages.size > 0);
        if (hiddenReferencePages.size > 0) {
          hideBtn.textContent = `非表示 ${hiddenReferencePages.size}`;
        } else {
          hideBtn.textContent = "非表示選択";
        }
      }
      if (startBtn) startBtn.disabled = referencePaths.length === 0 || psdPaths.length === 0 || referenceLoading;
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
          await loadSelectedReference();
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
      window.removeEventListener("psdesign:fonts-loaded", onFontsLoadedForTypeset);
      hideModalAnimated(modal);
      setTimeout(() => modal.remove(), 260);
      resolve(value);
    };
    const onKeyDown = (e) => {
      if (pickingFile) return;
      if (e.key === "Escape" && fontComboOpen) {
        e.preventDefault();
        syncFontInput();
        closeFontCombo();
        return;
      }
      if (e.key === "Escape") cleanup(null);
    };
    const pickWithHomeDialogHidden = async (pickFn) => {
      // v2.2.x: file-picker-modal を home-typeset-modal より高い z-index (280) で
      // 重ねるようにしたため、typeset modal を hide する必要は無くなった。
      // (旧仕様: hide → show のあいだに一瞬ホーム画面が透ける flash が出ていた)
      pickingFile = true;
      try {
        return await pickFn();
      } finally {
        pickingFile = false;
      }
    };

    modal.querySelector(".home-typeset-cancel")?.addEventListener("click", () => cleanup(null));
    modal.querySelector("[data-reference-hide]")?.addEventListener("click", async () => {
      if (referencePaths.length === 0 || referenceLoading) return;
      const next = await openReferenceHiddenPicker(referencePaths, hiddenReferencePages);
      if (!next) return;
      hiddenReferencePages = next.hiddenPages instanceof Set ? next.hiddenPages : new Set(next.hiddenPages || []);
      referencePageCount = null;
      update();
      await loadSelectedReference();
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
          const picked = normalizeHomeFlowPaths(await pickWithHomeDialogHidden(() => pickReferenceFiles()));
          if (picked.length > 0) {
            const changed = !samePathList(referencePaths, picked);
            referencePaths = picked;
            if (changed) {
              hiddenReferencePages = new Set();
              referencePageCount = null;
              await loadSelectedReference();
            }
          }
        } else if (kind === "psd") {
          const picked = normalizeHomeFlowPaths(await pickWithHomeDialogHidden(() => pickPsdFiles()));
          if (picked.length > 0) psdPaths = picked;
        } else if (kind === "txt") {
          const picked = await pickWithHomeDialogHidden(() => pickTxtPath());
          if (picked) txtPath = picked;
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
      if (referencePaths.length === 0 || psdPaths.length === 0 || referenceLoading) return;
      const referenceCount = getReferenceDisplayCount();
      if (referenceCount < psdPaths.length) {
        await notifyDialog({
          title: "見本が不足しています",
          message: `見本は${referenceCount}件、PSDは${psdPaths.length}件です。PSDの枚数分の見本を指定してください。`,
          okLabel: "OK",
          kind: "warning",
        });
        return;
      }
      applyTypesetDefaults();
      cleanup({ referencePaths, psdPaths, txtPath, hiddenReferencePages: [...hiddenReferencePages], baseTextSize, baseFontPs });
    });
    window.addEventListener("keydown", onKeyDown, true);
    homeTypesetDropHandler = handleHomeTypesetDrop;
    homeTypesetDragOverHandler = handleHomeTypesetDragOver;
    homeTypesetDragLeaveHandler = clearDragOverRows;
    update();
    showModalAnimated(modal);
  });
}

// v2.2.x: 全画面の黒で覆う一瞬の暗転を発火するヘルパー。CSS の keyframe アニメで
// 100ms fade-in → 200ms 黒 hold → 100ms fade-out を進行させる。アニメ終了で要素を自動削除。
function playSceneFadeBlack() {
  const existing = document.querySelector(".scene-fade-black");
  if (existing) existing.remove();
  const el = document.createElement("div");
  el.className = "scene-fade-black";
  document.body.appendChild(el);
  el.addEventListener("animationend", () => el.remove(), { once: true });
}

// v2.2.x: 暗転の直後に「ゆっくり星空がディゾルブして現れ、そして消える」幻想的な veil を発火。
// 70 個の星を 0-1100ms の delay でばらつかせ、ちらほらと段階的に灯っていく演出に。
// 「なんだろうと思ったら星空が広がる」という印象的な reveal を作る。
function playSceneStarryVeil() {
  const existing = document.querySelector(".scene-starry-veil");
  if (existing) existing.remove();
  const veil = document.createElement("div");
  veil.className = "scene-starry-veil";
  const STAR_COUNT = 70;
  for (let i = 0; i < STAR_COUNT; i++) {
    const star = document.createElement("span");
    star.className = "scene-starry-star";
    star.style.left = `${Math.random() * 100}%`;
    star.style.top = `${Math.random() * 100}%`;
    const size = 0.9 + Math.random() * 2.4;
    star.style.width = `${size}px`;
    star.style.height = `${size}px`;
    // 0〜1100ms の delay で段階的に星が灯る。早い星はうっすら見え始め、
    // 遅い星は最後にきらめいて、夜空が完成していく印象。
    star.style.animationDelay = `${Math.floor(Math.random() * 1100)}ms`;
    // 個別の duration もばらつかせて自然な瞬き
    star.style.animationDuration = `${2300 + Math.floor(Math.random() * 600)}ms`;
    veil.appendChild(star);
  }
  document.body.appendChild(veil);
  veil.addEventListener("animationend", (e) => {
    // 子の star アニメ完了は無視。container 自身の fade 完了でだけ remove。
    if (e.target === veil) veil.remove();
  });
}

// v2.2.x: 進捗完了 → 完了した作業画面への「逆向き」シーン転換。
// 設定 → 進捗画面が黒 → 星空 → 進捗画面 だったのに対し、
// 完了 → 作業画面は 進捗 → 星空 → 作業画面 で対称化する (黒は無しで、進捗 modal 自体が
// 暗いので始点として機能する)。
// 星空 veil を被せて、その下で進捗 modal を silently close し、veil の fade-out で
// 完成した作業画面を reveal する。
async function transitionToWorkspaceWithStars() {
  // ① OPUS の 100% 完了演出を発火 (sparkle + 「完了」テキスト)。
  //    auto-place 内の hideProgress({success: true}) は skipFinalHide で省いているため、
  //    ここで明示的に success 演出だけを再現する (modal はまだ閉じない)。
  const opusCompleteShown = showOpusProgressComplete();
  // ② 完了演出の hold 時間 (OPUS_SUCCESS_HOLD_DURATION = 1500ms) を待つ。
  //    OPUS モードでない時は短めに 600ms だけ間を取る。
  await new Promise((resolve) => setTimeout(resolve, opusCompleteShown ? OPUS_SUCCESS_HOLD_DURATION : 600));
  // ③ 星空 veil を起動 (3000ms anim: 150ms fade-in / 2100ms hold / 750ms fade-out)
  playSceneStarryVeil();
  // ④ veil が完全 opaque (~200ms) になるまで待つ
  await new Promise((resolve) => setTimeout(resolve, 200));
  // ⑤ 進捗 modal を veil の裏側で close (curtain slide-out は不可視)
  await hideProgress();
  // ⑥ veil が完全に消えるまで待つ (合計 3000ms - 200ms = 2800ms)
  //    hideProgress (~500ms) は veil の hold 期間内で終わるので並行的に消化される
  await new Promise((resolve) => setTimeout(resolve, 2800));
}

async function transitionFromHome({ duringBlack, afterStarsPeak } = {}) {
  // v2.2.x: 「設定 → アニメーション画面」の 3 段シーン切替。
  // フェーズ 1 (0-400ms): 黒い暗転で modal swap を invisibly に済ませる。
  // フェーズ 2 (130-3130ms): 星空 veil 3000ms — ゆっくりディゾルブして印象的に reveal、
  //                          ホールド、そしてゆっくり消える。
  // フェーズ 3 (afterStarsPeak): 星空が peak のあと、progress modal の curtain が
  //                              1.4s かけて静かに立ち上がり、星と入れ替わるように姿を現す。
  // 体験: ボタン押下 → 一瞬黒 → なんだろう…と思った瞬間に星空が広がる → ゆっくり消えていき、
  //       その間に進捗画面が幻想的に立ち上がる。
  document.body.classList.add("home-starting");
  playSceneFadeBlack();
  // 黒が完全に画面を覆う peak (約 130ms 後) を待ってから swap を実行
  await new Promise((resolve) => setTimeout(resolve, 130));
  if (typeof duringBlack === "function") {
    try { duringBlack(); } catch (e) { console.error(e); }
  }
  hideHomeScreen();
  document.body.classList.remove("home-starting");
  // 星空 veil を起動。黒の fade-out (130→400ms) と重なってクロスディゾルブする。
  playSceneStarryVeil();
  // 星空 veil が完全 opaque な期間 (peak hold = veil 開始 + 150ms 〜 + 2250ms) 中に
  // curtain entrance を完全に終わらせたい (curtain が partial だと workspace が透けるため)。
  // curtain は 1.4s、veil peak 終了は t=130+2250=2380。
  // ⇒ afterStarsPeak を t=130+850=980 で発火 → curtain 980-2380 完成 → veil fade-out 開始時点で
  //    curtain は既に 100%、workspace は curtain (進捗 modal) の下に完全に隠れる。
  await new Promise((resolve) => setTimeout(resolve, 850));
  if (typeof afterStarsPeak === "function") {
    try { afterStarsPeak(); } catch (e) { console.error(e); }
  }
  // 残り 2150ms 待って星空 veil が完全に消える (合計 130 + 850 + 2150 = 3130ms = 3000ms veil + 開始遅延)
  await new Promise((resolve) => setTimeout(resolve, 2150));
}

async function startHomeTypesetFlow() {
  if (!(await ensureHomeScanEngineReady())) return;
  const picked = await openHomeTypesetDialog();
  if (!picked) return;
  // keepOpen: true で位置調整 modal を「OK 後も閉じない」状態にする。
  // その後 progress modal がフェードイン完了 → 位置調整 modal を閉じる、
  // という順序にすることで「位置調整 modal の閉じアニメ中にホーム画面が
  // 透けて見える」問題を解消する。
  const positionAdjustMode = await choosePositionAdjustMode({ keepOpen: true });
  if (positionAdjustMode == null) return;
  const progressFlowId = `home-typeset-${Date.now()}`;
  // v2.2.x: 暗転 → 星空ディゾルブ → 進捗画面立ち上がり の 3 段演出。
  // duringBlack: 黒の peak で位置調整 modal を invisibly に閉じる。
  // afterStarsPeak: 星空が peak のあと、progress modal の curtain (1.4s) を発火。
  //                 星が薄れていくのと重なり、画面が幻想的に立ち上がる。
  await transitionFromHome({
    duringBlack: () => closePositionAdjustModalExternal(),
    afterStarsPeak: () => {
      startProgressFlow({
        id: progressFlowId,
        title: "自動配置中…",
        variant: "place",
        icon: PLACE_ICON_SVG,
        steps: createHomeTypesetSteps({ positionAdjustMode }),
        detail: "自動配置を準備中…",
      });
    },
  });
  try {
    clearScanExtractDoc();
    if (!referenceSelectionMatchesLoaded(picked.referencePaths, picked.hiddenReferencePages)) {
      await loadReferenceFiles(picked.referencePaths, {
        skipFirstBlankPage: false,
        excludedPages: picked.hiddenReferencePages,
        keepProgressOpen: true,
        progressFlow: { id: progressFlowId, stepId: "reference-load" },
      });
    }
    await loadPsdFilesByPaths(picked.psdPaths, {
      icon: PLACE_ICON_SVG,
      label: "自動配置中…",
      keepProgressOpen: true,
      variant: "place",
      progressFlow: { id: progressFlowId, stepId: "psd-load" },
    });
    if (!getPages().length) {
      await hideProgress();
      return;
    }
    if (picked.txtPath) await loadTxtFromPath(picked.txtPath);
    // v2.2.x: 内部の hideProgress({success: true}) を skip して、startHomeTypesetFlow 側で
    // 「進捗 → 星空 → 作業画面」のディゾルブ転換 (transitionToWorkspaceWithStars) を担当する。
    // これにより workspace が一瞬チラ見えするタイミングを完全に消せる。
    const placed = await runAutoPlace({
      allowExtractText: true,
      preserveTxtDuringExtract: !!picked.txtPath,
      positionAdjustMode,
      progressFlowId,
      skipFinalHide: true,
    });
    if (!placed) {
      await hideProgress();
      return;
    }
    if (placed?.positionAdjusted !== true) {
      await runSelectedPositionAdjust(positionAdjustMode, {
        automatic: true,
        progressFlowId,
        skipFinalHide: true,  // mode3 の runOverlayAlign にも propagate
      });
    }
    // 全操作完了 → 星空ディゾルブで進捗 modal → 作業画面に転換
    await transitionToWorkspaceWithStars();
  } catch (e) {
    console.error(e);
    await hideProgress();
    await notifyDialog({
      title: "写植を開始できません",
      message: String(e?.message ?? e ?? "不明なエラー"),
    });
  } finally {
    clearProgressFlow(progressFlowId);
  }
}

async function startHomeTranscribeFlow() {
  if (!(await ensureHomeScanEngineReady())) return;
  let files = [];
  try {
    files = await pickReferenceFiles();
  } catch (e) {
    console.error(e);
    toast(`ファイル選択に失敗しました: ${e?.message ?? e}`, { kind: "error", duration: 3500 });
    return;
  }
  if (!files.length) return;

  // v2.2.x: 書き起こしフローも同じ 3 段演出 (暗転 → 星空 → 進捗立ち上がり) を使う。
  // showProgress は afterStarsPeak で発火し、星空 fade-out と curtain emerge を重ねる。
  await transitionFromHome({
    afterStarsPeak: () => {
      showProgress({
        title: "書き起こし中…",
        detail: "読み込み準備中…",
        current: 0,
        total: 1,
        showCount: false,
        variant: "scan",
      });
    },
  });
  try {
    clearScanExtractDoc();
    await loadReferenceFiles(files, { keepProgressOpen: true, variant: "scan" });
    // v2.2.x: scan-extract の内部 hideProgress を skip し、完了後に星空ディゾルブで close する
    await runScanExtractForTranscription(files, { keepProgressOpen: true });
    setParallelViewMode("editor");
    setEditorLeftPaneMode("pdf");
    setActivePane("pdf");
    requestAnimationFrame(() => focusEditor());
    // 全操作完了 → 星空ディゾルブで進捗 modal → エディタ画面に転換
    await transitionToWorkspaceWithStars();
  } catch (e) {
    console.error(e);
    await hideProgress();
    await notifyDialog({
      title: "書き起こしを開始できません",
      message: String(e?.message ?? e ?? "不明なエラー"),
    });
  }
}

function bindHomeScreen() {
  document.getElementById("home-transcribe-start-btn")?.addEventListener("click", () => { void startHomeTranscribeFlow(); });
  document.getElementById("home-typeset-start-btn")?.addEventListener("click", () => { void startHomeTypesetFlow(); });
  document.getElementById("home-project-open-btn")?.addEventListener("click", () => { void openProject(); });
  window.addEventListener("psdesign:scan-model-status", (e) => {
    setHomeScanEngineState(!!e.detail?.available);
  });
  void refreshHomeScanEngineState();
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
  applyThemeColor();
  void syncHomeVersionLabel();
  bindProjectButtons();
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
  bindFindChangeMode();
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
  mountPdfView();
  setupTauriDragDrop();
  bindParallelSync();
  bindWheelPageNav();
  bindActivePaneTracking();
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
  });
  maybeShowFirstRunSetup();
  void openStartupProjectFromArgs();
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
    const near = target.closest?.("input, textarea, [contenteditable], .style-palette, .save-menu, .layer-box.editing, .editor, .ruby-panel-floating, .font-panel-floating, .size-panel-floating, .stroke-panel-floating");
    if (near) return;
    active.blur();
  }, true);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
