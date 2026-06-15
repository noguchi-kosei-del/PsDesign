import {
  abortHistoryTransient,
  addEditOffset,
  addNewLayer,
  beginHistoryTransient,
  commitHistoryTransient,
  withHistoryTransient,
  getCurrentFont,
  getCurrentPageIndex,
  getEdit,
  getFillColor,
  getFontDisplayName,
  getFontPickerStuck,
  getFonts,
  getLeadingPct,
  getNewLayersForPsd,
  getNewTextDirection,
  getPages,
  getPsdRotation,
  getSelectedLayers,
  getStrokeColor,
  getStrokeWidthPx,
  getTextSize,
  getTxtSource,
  getTool,
  isLayerSelected,
  onToolChange,
  removeNewLayer,
  setEdit,
  setEditingContext,
  setSelectedLayer,
  setSelectedLayers,
  setTxtSource,
  toDisplaySizePt,
  toggleLayerSelected,
  updateNewLayer,
  // 【v1.29.x UI-coord】ルビ wrap の実描画位置を PSD 座標で state に書き戻すため
  setCharRubyOffset,
  setCharRubyVisualOffset,
} from "./state.js";
import { ensureFontLoaded } from "./font-loader.js";
import { getDefault, onSettingsChange } from "./settings.js";
import { commitFontToSelections, openLayerFontPanel, openLayerSizePanel, openLayerStrokePanel, rebuildLayerList } from "./text-editor.js";
import {
  formatTextSizePt,
  getTextSizeUnit,
  normalizeTextSizeUnit,
  textSizePtToUnitValue,
  textSizeUnitValueToPt,
} from "./text-size-unit.js";
import {
  appendBlockToCurrentPageContent,
  cascadeRemoveTxtForLayers,
  renderTxtSourceViewer,
  syncPlacedLayerTextToSource,
} from "./txt-source.js";

const mounts = new Map();
const resizeObservers = new Set();
let toolListenerBound = false;
const RUBY_TOWARD_PARENT_RATIO = 1.60;
const TEXT_BBOX_THICK_SAFETY_EM = 0;
// Keep vertical thick safety in sync with auto-place.js estimateLayerSize()
// and src-tauri/src/jsx_gen.rs _thickSafetyEm. See RDD.md REQ-G4.5/G10.7.
const TEXT_BBOX_VERTICAL_THICK_SAFETY_EM = 0;
const TEXT_BBOX_MULTI_LINE_THICK_SAFETY_EM = 0.4;
const TEXT_BBOX_LONG_SAFETY_EM = 0.4;
const TEXT_BBOX_HEURISTIC_LONG_SCALE = 1.05;
const LAYER_DRAG_THRESHOLD_PX = 5;
let hideSelectedLayerBadges = false;
let userHiddenLayerBadges = false;
let temporaryMultiSelectionAdornmentsVisible = false;
let temporarySizeOnlyBadgesVisible = false;
let rotateHandlesVisible = false;
let selectionAdornmentsVisible = true;
const SELECTION_CENTER_ONLY_MODE_KEY = "psdesign_selection_center_only_mode";

function readSelectionCenterOnlyMode() {
  try {
    const saved = localStorage.getItem(SELECTION_CENTER_ONLY_MODE_KEY);
    if (saved === "0") return false;
    if (saved === "1") return true;
  } catch (_) {}
  return false;
}

function writeSelectionCenterOnlyMode(value) {
  try { localStorage.setItem(SELECTION_CENTER_ONLY_MODE_KEY, value ? "1" : "0"); } catch (_) {}
}

let selectionCenterOnlyMode = readSelectionCenterOnlyMode();

// 【方眼表示モード（Shift+D）】選択中テキストを MojiQ のセリフ見本のように方眼（文字セルのグリッド）で
// 表示し、グリフ自体は隠す。中心点モードと同型（状態 + localStorage + .page-overlay クラス）。既定 OFF。
const SELECTION_GRID_MODE_KEY = "psdesign_selection_grid_mode";

function readSelectionGridMode() {
  try { return localStorage.getItem(SELECTION_GRID_MODE_KEY) === "1"; } catch (_) { return false; }
}

function writeSelectionGridMode(value) {
  try { localStorage.setItem(SELECTION_GRID_MODE_KEY, value ? "1" : "0"); } catch (_) {}
}

let selectionGridMode = readSelectionGridMode();

// 方眼表示モード（Shift+D）: 選択中レイヤーの box を「最長行の文字数 × 行数」（縦書きは転置）の
// マス目に分割し、1 文字 = 1 マスの方眼セル DOM を作る（グリフ自体は CSS で非表示）。
// CSS の background グラデーション方式は WebView2 で background-size の calc/% が安定せず線が出ない
// ため、実セル DOM（.layer-grid-cells > .grid-cell）を gap で区切る確実な方式に切り替える。
function buildGridCells(box, text, isVertical, page = null, rect = null) {
  if (page && rect && page.width > 0 && page.height > 0) {
    const pageArea = page.width * page.height;
    const rectArea = Math.max(0, rect.width) * Math.max(0, rect.height);
    // 方眼は文字ボックス確認用。誤った巨大 bbox でページ全体を暗く覆う場合は出さない。
    if (pageArea > 0 && rectArea / pageArea > 0.25) return;
  }
  const lines = String(text ?? "").split(/\r\n|\r|\n/);
  const lineCount = Math.max(1, lines.length);
  let maxChars = 1;
  for (const ln of lines) { const n = [...ln].length; if (n > maxChars) maxChars = n; }
  const cols = Math.max(1, isVertical ? lineCount : maxChars);
  const rows = Math.max(1, isVertical ? maxChars : lineCount);
  const total = cols * rows;
  if (total > 4000) return; // 点検用途の安全上限（極端な文字数での DOM 爆発を防ぐ）
  const grid = document.createElement("div");
  grid.className = "layer-grid-cells";
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < total; i++) {
    const cell = document.createElement("div");
    cell.className = "grid-cell";
    frag.appendChild(cell);
  }
  grid.appendChild(frag);
  box.appendChild(grid);
}

function showSelectedLayerBadges() {
  const wasHidden = hideSelectedLayerBadges;
  hideSelectedLayerBadges = false;
  return wasHidden;
}

function handleSelectedLayerBadgeVisibilityClick(e) {
  if (!e?.ctrlKey || e.shiftKey || e.metaKey || e.altKey) return false;
  temporaryMultiSelectionAdornmentsVisible = false;
  temporarySizeOnlyBadgesVisible = false;
  setSelectionAdornmentsVisible(false);
  userHiddenLayerBadges = true;
  hideSelectedLayerBadges = false;
  return true;
}

export function setSelectedLayerBadgesUserHidden(hidden) {
  userHiddenLayerBadges = hidden === true;
  temporaryMultiSelectionAdornmentsVisible = false;
  temporarySizeOnlyBadgesVisible = false;
  hideSelectedLayerBadges = false;
  refreshAllOverlays();
}

export function clearTemporaryMultiSelectionAdornments() {
  if (!temporaryMultiSelectionAdornmentsVisible) return false;
  temporaryMultiSelectionAdornmentsVisible = false;
  temporarySizeOnlyBadgesVisible = false;
  refreshAllOverlays();
  return true;
}

export function revealSelectedLayerSizeOnlyBadges() {
  if (getSelectedLayers().length <= 0) return false;
  temporaryMultiSelectionAdornmentsVisible = false;
  temporarySizeOnlyBadgesVisible = true;
  hideSelectedLayerBadges = false;
  refreshAllOverlays();
  return true;
}

export function revealLayerAdornmentsForTemporaryMultiSelection() {
  if (getSelectedLayers().length <= 1) return false;
  temporaryMultiSelectionAdornmentsVisible = true;
  temporarySizeOnlyBadgesVisible = false;
  hideSelectedLayerBadges = false;
  refreshAllOverlays();
  return true;
}

export function restoreSelectedLayerBadges() {
  if (!showSelectedLayerBadges()) return false;
  refreshAllOverlays();
  return true;
}

function clearAutoFontMarkerForNewLayer(tempId, layer) {
  if (!tempId || !layer?.autoFontSwitched) return false;
  updateNewLayer(tempId, {
    autoFontSwitched: false,
    autoFontSwitchBucket: -1,
  });
  return true;
}

export function getSelectionAdornmentsVisible() {
  return selectionAdornmentsVisible;
}

export function setSelectionAdornmentsVisible(visible) {
  const next = visible !== false;
  if (selectionAdornmentsVisible === next) return next;
  temporarySizeOnlyBadgesVisible = false;
  selectionAdornmentsVisible = next;
  refreshAllOverlays();
  return next;
}

export function toggleSelectionAdornmentsVisible() {
  return setSelectionAdornmentsVisible(!selectionAdornmentsVisible);
}

export function toggleSelectionCenterOnlyMode() {
  selectionCenterOnlyMode = !selectionCenterOnlyMode;
  temporarySizeOnlyBadgesVisible = false;
  writeSelectionCenterOnlyMode(selectionCenterOnlyMode);
  // 中心点と方眼は両方ともテキストを隠すため相互排他。
  if (selectionCenterOnlyMode && selectionGridMode) {
    selectionGridMode = false;
    writeSelectionGridMode(false);
  }
  refreshAllOverlays();
  return selectionCenterOnlyMode;
}

export function toggleSelectionGridDisplayMode() {
  selectionGridMode = !selectionGridMode;
  temporarySizeOnlyBadgesVisible = false;
  writeSelectionGridMode(selectionGridMode);
  // 方眼と中心点は両方ともテキストを隠すため相互排他。
  if (selectionGridMode && selectionCenterOnlyMode) {
    selectionCenterOnlyMode = false;
    writeSelectionCenterOnlyMode(false);
  }
  refreshAllOverlays();
  return selectionGridMode;
}

function hideRotateHandles(ctx = null) {
  if (!rotateHandlesVisible) return false;
  rotateHandlesVisible = false;
  if (ctx) renderOverlay(ctx);
  else refreshAllOverlays();
  return true;
}

// 【v1.16.0】in-place 編集 textarea 上の文字選択範囲のキャッシュ。
// reportCursor の発火点で必ずモジュール変数に保存しておくことで、focus 変動の影響を回避。
// editingContext は select イベントのタイミングで更新するが、フォーカスが他の input
// (size / font 入力欄など) に移ったときに古い値が残ることがある。これを補うため、
// reportCursor が走るたびに module-level でも選択範囲を保持する。サイドバーから直接
// 参照できるよう listener API で通知する。
let _lastInplaceSelection = null;
const _selectionChangeListeners = new Set();
let lastPointerDownTarget = null;
if (typeof document !== "undefined") {
  document.addEventListener("pointerdown", (e) => {
    lastPointerDownTarget = e.target;
  }, true);
}
export function getLastInplaceSelection() { return _lastInplaceSelection; }
export function clearInplaceSelection() { setLastInplaceSelection(null); }
export function onInplaceSelectionChange(fn) {
  _selectionChangeListeners.add(fn);
  return () => _selectionChangeListeners.delete(fn);
}
function setLastInplaceSelection(v) {
  // 値が同じなら listener を発火しない（連続 keystroke で大量発火を抑止）
  const a = _lastInplaceSelection;
  const b = v;
  if (a === b) return;
  if (a && b && a.start === b.start && a.end === b.end
      && a.psdPath === b.psdPath
      && a.layerId === b.layerId && a.tempId === b.tempId
      && !!a.rubyOnly === !!b.rubyOnly
      && !!a.rubyOverlay === !!b.rubyOverlay
      && (a.rubyText ?? "") === (b.rubyText ?? "")) return;
  _lastInplaceSelection = b;
  syncInplaceSelectionHighlight(b);
  for (const fn of _selectionChangeListeners) fn(b);
}

// MojiQ 流パン状態：モジュールレベルで保持し、canvas に常設リスナーで扱う。
function clearInplaceSelectionHighlight() {
  try {
    if (window.CSS?.highlights) CSS.highlights.delete("opus-inplace-selection");
  } catch (_) {}
  try {
    document.querySelectorAll(".ruby-text-selected").forEach((el) => el.classList.remove("ruby-text-selected"));
  } catch (_) {}
}

function findRubySelectionElement(sel) {
  if (!sel?.rubyOnly) return null;
  const roots = [];
  const seen = new Set();
  const addRoot = (root) => {
    if (!root || seen.has(root)) return;
    seen.add(root);
    roots.push(root);
  };
  addRoot(document.querySelector(".layer-box.editing"));
  document.querySelectorAll(".layer-box.selected").forEach(addRoot);
  document.querySelectorAll(".layer-box").forEach(addRoot);
  for (const root of roots) for (const rt of root.querySelectorAll(".ruby-text")) {
    const box = rt.closest(".layer-box");
    if (sel.layerId != null && box?.dataset.layerId !== String(sel.layerId)) continue;
    if (sel.tempId != null && box?.dataset.tempId !== String(sel.tempId)) continue;
    const start = Number(rt.dataset.rubyStart);
    const end = Number(rt.dataset.rubyEnd);
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
    if (start !== sel.start || end !== sel.end) continue;
    if ((rt.dataset.rubyText ?? rt.textContent ?? "") !== (sel.rubyText ?? "")) continue;
    if ((rt.dataset.rubyOverlay === "true") !== (sel.rubyOverlay === true)) continue;
    return rt;
  }
  return null;
}

function syncRubySelectionHighlight(sel) {
  const rt = findRubySelectionElement(sel);
  if (!rt) return false;
  rt.classList.add("ruby-text-selected");
  return true;
}

function syncInplaceSelectionHighlight(sel) {
  clearInplaceSelectionHighlight();
  if (!sel || !Number.isInteger(sel.start) || !Number.isInteger(sel.end) || sel.end <= sel.start) return false;
  if (sel.rubyOnly) return syncRubySelectionHighlight(sel);
  if (!window.CSS?.highlights || typeof Highlight === "undefined") return false;
  const editing = document.querySelector(".layer-box.editing");
  if (!editing) return false;
  const inner = editing.querySelector(".existing-layer-text:not(.stroke-preview-underlay), .new-layer-text:not(.stroke-preview-underlay)");
  if (!inner) return false;
  const startPos = charIndexToNodeOffset(inner, sel.start);
  const endPos = charIndexToNodeOffset(inner, sel.end);
  if (!startPos || !endPos) return false;
  try {
    const range = document.createRange();
    range.setStart(startPos.node, startPos.offset);
    range.setEnd(endPos.node, endPos.offset);
    CSS.highlights.set("opus-inplace-selection", new Highlight(range));
    return true;
  } catch (_) {
    return false;
  }
}

export function restoreInplaceSelection(sel) {
  if (!sel || !Number.isInteger(sel.start) || !Number.isInteger(sel.end) || sel.end <= sel.start) return false;
  const editing = document.querySelector(".layer-box.editing");
  if (!editing) return false;
  const inner = editing.querySelector(".existing-layer-text:not(.stroke-preview-underlay), .new-layer-text:not(.stroke-preview-underlay)");
  if (!inner) return false;
  if (sel.rubyOnly) {
    const selection = window.getSelection();
    inner.focus({ preventScroll: true });
    selection?.removeAllRanges?.();
    syncInplaceSelectionHighlight(sel);
    setLastInplaceSelection({ ...sel });
    return true;
  }
  const startPos = charIndexToNodeOffset(inner, sel.start);
  const endPos = charIndexToNodeOffset(inner, sel.end);
  if (!startPos || !endPos) return false;
  try {
    const range = document.createRange();
    range.setStart(startPos.node, startPos.offset);
    range.setEnd(endPos.node, endPos.offset);
    const selection = window.getSelection();
    if (!selection) return false;
    inner.focus({ preventScroll: true });
    selection.removeAllRanges();
    selection.addRange(range);
    syncInplaceSelectionHighlight(sel);
    setLastInplaceSelection({ ...sel });
    return true;
  } catch (_) {
    return false;
  }
}

export function getInplaceSelectionRect(sel = _lastInplaceSelection) {
  if (!sel || !Number.isInteger(sel.start) || !Number.isInteger(sel.end) || sel.end <= sel.start) return null;
  if (sel.rubyOnly) {
    const rt = findRubySelectionElement(sel);
    const rect = rt?.getBoundingClientRect?.();
    if (rect && rect.width > 0 && rect.height > 0) return rect;
  }
  const editing = document.querySelector(".layer-box.editing");
  if (!editing) return null;
  const inner = editing.querySelector(".existing-layer-text:not(.stroke-preview-underlay), .new-layer-text:not(.stroke-preview-underlay)");
  if (!inner) return null;
  const startPos = charIndexToNodeOffset(inner, sel.start);
  const endPos = charIndexToNodeOffset(inner, sel.end);
  if (!startPos || !endPos) return null;
  let range = null;
  try {
    range = document.createRange();
    range.setStart(startPos.node, startPos.offset);
    range.setEnd(endPos.node, endPos.offset);
    const rects = Array.from(range.getClientRects())
      .filter((rect) => rect && rect.width > 0 && rect.height > 0);
    const source = rects.length ? rects : [range.getBoundingClientRect()]
      .filter((rect) => rect && rect.width > 0 && rect.height > 0);
    if (!source.length) return null;
    return source.reduce((acc, rect) => ({
      left: Math.min(acc.left, rect.left),
      top: Math.min(acc.top, rect.top),
      right: Math.max(acc.right, rect.right),
      bottom: Math.max(acc.bottom, rect.bottom),
      width: Math.max(acc.right, rect.right) - Math.min(acc.left, rect.left),
      height: Math.max(acc.bottom, rect.bottom) - Math.min(acc.top, rect.top),
    }));
  } catch (_) {
    return null;
  } finally {
    range?.detach?.();
  }
}

function shouldKeepInPlaceEditForTarget(target) {
  return !!(target && typeof target.closest === "function"
    && target.closest(".editor, .side-panel .editor, .ruby-panel-floating, .ruby-parent-dialog, .font-panel-floating, .size-panel-floating, .stroke-panel-floating, .side-panel-tabs, .side-panel-tab"));
}

export function showInplaceSelectionHighlightOnly(sel = _lastInplaceSelection) {
  const selection = window.getSelection?.();
  selection?.removeAllRanges?.();
  return syncInplaceSelectionHighlight(sel);
}

export function refreshActiveInPlaceEditPreview(sel = _lastInplaceSelection) {
  const editing = document.querySelector(".layer-box.editing");
  if (!editing) return false;
  const inner = editing.querySelector(".existing-layer-text:not(.stroke-preview-underlay), .new-layer-text:not(.stroke-preview-underlay)");
  if (!inner) return false;
  const pages = getPages();
  const page = pages.find((p) => p.path === sel?.psdPath) ?? pages[getCurrentPageIndex()];
  if (!page) return false;

  if (sel?.layerId != null) {
    const layerId = Number(sel.layerId);
    const layer = page.textLayers?.find((l) => Number(l.id) === layerId);
    if (!layer) return false;
    const edit = getEdit(page.path, layer.id) ?? {};
    const rect = layerRectForExisting(page, layer, edit);
    const defaultLeadPct = Number.isFinite(edit.leadingPct) ? edit.leadingPct : 105;
    const tcyEnabled = getDefault("tateChuYokoEnabled") !== false;
    const symbolFontPS = getDefault("symbolFontReplaceEnabled") !== false
      ? String(getDefault("symbolFontPostScriptName") || "")
      : "";
    const punctTsumePct = Number(getDefault("punctuationTsumePercent")) || 0;
    const existingSizePt = getExistingLayerEffectiveSizePt(page, layer, edit);
    renderInnerText(
      inner, rect.previewText, defaultLeadPct, edit.lineLeadings, 0, 0,
      tcyEnabled && rect.isVertical,
      rect.isVertical,
      { ...(layer.charSizes ?? {}), ...(edit.charSizes ?? {}) }, existingSizePt, edit.charFonts ?? layer.charFonts,
      symbolFontPS,
      edit.charBolds,
      edit.charItalics,
      punctTsumePct,
      edit.charRubies,
      { ...(layer.charHorizontalScales ?? {}), ...(edit.charHorizontalScales ?? {}) },
      { ...(layer.charVerticalScales ?? {}), ...(edit.charVerticalScales ?? {}) },
      edit.trackingMille ?? layer.trackingMille ?? 0,
      edit.kerningMille ?? layer.kerningMille ?? 0,
      { ...(layer.charTrackings ?? {}), ...(edit.charTrackings ?? {}) },
      { ...(layer.charKernings ?? {}), ...(edit.charKernings ?? {}) },
      { ...(layer.charTateChuYokos ?? {}), ...(edit.charTateChuYokos ?? {}) },
      { ...(layer.charFillColors ?? {}), ...(edit.charFillColors ?? {}) },
      edit.horizontalScale ?? layer.horizontalScale ?? 100,
      edit.verticalScale ?? layer.verticalScale ?? 100,
    );
    inner.contentEditable = "true";
    return syncInplaceSelectionHighlight(sel);
  }

  if (sel?.tempId != null) {
    const nl = getNewLayersForPsd(page.path).find((l) => l.tempId === sel.tempId);
    if (!nl) return false;
    const rect = layerRectForNew(page, nl);
    const dashMille = Number(getDefault("dashRunTrackingMille")) || 0;
    const tildeMille = Number(getDefault("tildeRunKerningMille")) || 0;
    const tcyEnabledNew = getDefault("tateChuYokoEnabled") !== false;
    const symbolFontPSNew = getDefault("symbolFontReplaceEnabled") !== false
      ? String(getDefault("symbolFontPostScriptName") || "")
      : "";
    const punctTsumePctNew = Number(getDefault("punctuationTsumePercent")) || 0;
    renderInnerText(
      inner, nl.contents, nl.leadingPct ?? 125, nl.lineLeadings, dashMille, tildeMille,
      tcyEnabledNew && rect.isVertical,
      rect.isVertical,
      nl.charSizes, nl.sizePt ?? 24, nl.charFonts,
      symbolFontPSNew,
      nl.charBolds,
      nl.charItalics,
      punctTsumePctNew,
      nl.charRubies,
      nl.charHorizontalScales,
      nl.charVerticalScales,
      nl.trackingMille ?? 0,
      nl.kerningMille ?? 0,
      nl.charTrackings,
      nl.charKernings,
      nl.charTateChuYokos,
      nl.charFillColors,
      nl.horizontalScale ?? 100,
      nl.verticalScale ?? 100,
    );
    inner.contentEditable = "true";
    return syncInplaceSelectionHighlight(sel);
  }
  return false;
}

function rectFromEditingBoxStyle(box, page, fallbackRect) {
  if (!box || !page?.width || !page?.height) return fallbackRect;
  const leftPct = Number.parseFloat(box.style.left);
  const topPct = Number.parseFloat(box.style.top);
  const widthPct = Number.parseFloat(box.style.width);
  const heightPct = Number.parseFloat(box.style.height);
  if (![leftPct, topPct, widthPct, heightPct].every(Number.isFinite)) return fallbackRect;
  return {
    left: (leftPct / 100) * page.width,
    top: (topPct / 100) * page.height,
    width: (widthPct / 100) * page.width,
    height: (heightPct / 100) * page.height,
  };
}

function applyEditingBoxRect(box, page, rect) {
  if (!box || !page?.width || !page?.height || !rect) return;
  box.style.left = `${(rect.left / page.width) * 100}%`;
  box.style.top = `${(rect.top / page.height) * 100}%`;
  box.style.width = `${(rect.width / page.width) * 100}%`;
  box.style.height = `${(rect.height / page.height) * 100}%`;
}

export function recenterActiveInPlaceEditBox(sel = _lastInplaceSelection) {
  const editing = document.querySelector(".layer-box.editing");
  if (!editing || !sel) return false;
  const pages = getPages();
  const page = pages.find((p) => p.path === sel.psdPath) ?? pages[getCurrentPageIndex()];
  if (!page) return false;

  if (sel.layerId != null) {
    const layerId = Number(sel.layerId);
    const layer = page.textLayers?.find((l) => Number(l.id) === layerId);
    if (!layer) return false;
    const edit = getEdit(page.path, layer.id) ?? {};
    const newRect = layerRectForExisting(page, layer, edit);
    const currentRect = rectFromEditingBoxStyle(editing, page, newRect);
    const centerX = currentRect.left + currentRect.width / 2;
    const centerY = currentRect.top + currentRect.height / 2;
    const left = centerX - newRect.width / 2;
    const top = centerY - newRect.height / 2;
    setEdit(page.path, layer.id, { dx: left - (layer.left ?? 0), dy: top - (layer.top ?? 0) });
    applyEditingBoxRect(editing, page, { left, top, width: newRect.width, height: newRect.height });
    return true;
  }

  if (sel.tempId != null) {
    const nl = getNewLayersForPsd(page.path).find((l) => l.tempId === sel.tempId);
    if (!nl) return false;
    const newRect = layerRectForNew(page, nl);
    const currentRect = rectFromEditingBoxStyle(editing, page, newRect);
    const centerX = currentRect.left + currentRect.width / 2;
    const centerY = currentRect.top + currentRect.height / 2;
    const left = centerX - newRect.width / 2;
    const top = centerY - newRect.height / 2;
    updateNewLayer(nl.tempId, { x: left, y: top });
    applyEditingBoxRect(editing, page, { left, top, width: newRect.width, height: newRect.height });
    return true;
  }
  return false;
}

export function resizeActiveInPlaceEditBoxToState(sel = _lastInplaceSelection) {
  const editing = document.querySelector(".layer-box.editing");
  if (!editing || !sel) return false;
  const pages = getPages();
  const page = pages.find((p) => p.path === sel.psdPath) ?? pages[getCurrentPageIndex()];
  if (!page) return false;

  if (sel.layerId != null) {
    const layerId = Number(sel.layerId);
    const layer = page.textLayers?.find((l) => Number(l.id) === layerId);
    if (!layer) return false;
    const edit = getEdit(page.path, layer.id) ?? {};
    const rect = layerRectForExisting(page, layer, edit);
    applyEditingBoxRect(editing, page, rect);
    return true;
  }

  if (sel.tempId != null) {
    const nl = getNewLayersForPsd(page.path).find((l) => l.tempId === sel.tempId);
    if (!nl) return false;
    const rect = layerRectForNew(page, nl);
    applyEditingBoxRect(editing, page, rect);
    return true;
  }
  return false;
}

let panState = null;
// マーキー（V ツールの矩形選択）状態。
let marqueeState = null;

// キャンバス外でリリースされた場合のセーフティネット（window level）
if (typeof window !== "undefined") {
  window.addEventListener("mouseup", () => { if (panState) endPan(); });
  window.addEventListener("blur", () => { if (panState) endPan(); });
  document.addEventListener("mousedown", (e) => {
    if (!rotateHandlesVisible) return;
    const target = e.target;
    if (target?.closest?.(".layer-box")) return;
    hideRotateHandles();
  });
}

export function mountPageInteraction({ pageEl, canvas, overlay, page, pageIndex }) {
  mounts.set(pageIndex, { pageEl, canvas, overlay, page, pageIndex });
  if (!toolListenerBound) {
    onToolChange(() => {
      for (const m of mounts.values()) {
        applyToolAttrs(m);
        renderOverlay(m);
      }
    });
    toolListenerBound = true;
  }
  canvas.addEventListener("mousedown", (e) => onCanvasMouseDown(e, mounts.get(pageIndex)));
  canvas.addEventListener("mousemove", (e) => onCanvasMouseMove(e, mounts.get(pageIndex)));
  canvas.addEventListener("mouseup", (e) => onCanvasMouseUp(e, mounts.get(pageIndex)));
  pageEl.addEventListener("wheel", (e) => onPageWheel(e, mounts.get(pageIndex)), { passive: false });
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => {
      const m = mounts.get(pageIndex);
      if (m) renderOverlay(m);
    });
    ro.observe(canvas);
    resizeObservers.add(ro);
  }
  applyToolAttrs(mounts.get(pageIndex));
  renderOverlay(mounts.get(pageIndex));
}

export function unmountAll() {
  rotateHandlesVisible = false;
  hideSelectedLayerBadges = false;
  userHiddenLayerBadges = false;
  temporaryMultiSelectionAdornmentsVisible = false;
  temporarySizeOnlyBadgesVisible = false;
  mounts.clear();
  for (const ro of resizeObservers) ro.disconnect();
  resizeObservers.clear();
}

export function refreshAllOverlays() {
  for (const m of mounts.values()) renderOverlay(m);
}

export function commitActiveInPlaceEdit() {
  const editing = document.querySelector(".layer-box.editing");
  if (editing && typeof editing.__finalize === "function") {
    editing.__finalize(true);
    return true;
  }
  return false;
}

// 【v1.21.0】編集中レイヤーの inner で、char index 範囲 [start, end) を <span> でラップして
// CSS スタイルを直接適用する。サイドバーから per-char サイズ・フォントを変更したときに
// 編集中の DOM へリアルタイムに視覚反映するために使う。
//
// 引数:
//   start, end : char 位置（state.contents 上の絶対 index、innerText 順）
//   styleProps : { fontFamily, fontSize, ... } の CSS プロパティオブジェクト
//
// 戻り値: 適用に成功したら true、編集中レイヤーが無い / 範囲解決失敗で false。
//
// 注意: ネストした span が同じ styleProp を持つと em 系単位は乗算されるため、size 系は
// 「em 比 = sigSize / layerDefaultSizePt」で指定しつつ、ネスト時は親 span の em を打ち消す
// よう既存 fontSize span を range 内から事前に剥がす（unwrapStyleSpansInRange）。
export function applyEditModeStyleToRange(start, end, styleProps) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) return false;
  const editing = document.querySelector(".layer-box.editing");
  if (!editing) return false;
  const inner = editing.querySelector(".existing-layer-text:not(.stroke-preview-underlay), .new-layer-text:not(.stroke-preview-underlay)");
  if (!inner) return false;

  const startPos = charIndexToNodeOffset(inner, start);
  const endPos = charIndexToNodeOffset(inner, end);
  if (!startPos || !endPos) return false;

  const range = document.createRange();
  try {
    range.setStart(startPos.node, startPos.offset);
    range.setEnd(endPos.node, endPos.offset);
  } catch { return false; }

  // ネスト span による em 乗算事故を避けるため、上書きされる styleProp を持つ span を
  // 範囲内から剥がす（unwrap）。子の text node はそのまま残る。
  for (const prop of Object.keys(styleProps)) {
    unwrapStyleSpansInRange(inner, range, prop);
  }
  // 範囲は unwrap 後に invalid になることがあるので char index から再計算。
  const startPos2 = charIndexToNodeOffset(inner, start);
  const endPos2 = charIndexToNodeOffset(inner, end);
  if (!startPos2 || !endPos2) return false;
  const range2 = document.createRange();
  try {
    range2.setStart(startPos2.node, startPos2.offset);
    range2.setEnd(endPos2.node, endPos2.offset);
  } catch { return false; }

  // 新規 span でラップ
  const span = document.createElement("span");
  for (const [k, v] of Object.entries(styleProps)) {
    if (v == null || v === "") continue;
    if (k === "fontSize") {
      span.style[k] = normalizeEditFontSize(inner, v);
    } else {
      span.style[k] = v;
    }
  }
  try {
    range2.surroundContents(span);
  } catch (e) {
    // surroundContents は range が要素境界を跨ぐと NotSupportedError。
    // extractContents + insertNode で fallback。
    try {
      const contents = range2.extractContents();
      span.appendChild(contents);
      range2.insertNode(span);
    } catch {
      return false;
    }
  }

  // 選択を span 全体に再設定（連続して別 styleProp を当てたいときの利便性）
  for (const rt of Array.from(inner.querySelectorAll(".ruby-text"))) {
    const rubyStart = Number(rt.dataset.rubyStart);
    const rubyEnd = Number(rt.dataset.rubyEnd);
    if (!Number.isFinite(rubyStart) || !Number.isFinite(rubyEnd)) continue;
    if (rubyStart >= end || rubyEnd <= start) continue;
    for (const [k, v] of Object.entries(styleProps)) {
      if (v == null || v === "" || k === "fontSize") continue;
      rt.style[k] = v;
    }
  }

  const sel = window.getSelection();
  sel.removeAllRanges();
  const newRange = document.createRange();
  newRange.selectNodeContents(span);
  sel.addRange(newRange);
  return true;
}

// 【v1.27.0】in-place 編集中のレイヤーで「ルビプレビュー」を表示する。
// 旧 v1.26.0 では `<span class="ruby-edit-pending" data-ruby-text="rt">親文字</span>` +
// CSS `::after { content: attr(data-ruby-text) }` の疑似要素方式でプレビューしていたが、
// contenteditable 内で caret 移動 / 文字選択を解除すると Chromium が ::after の描画を
// 破棄するケースが発生し、「文字選択を解除した瞬間にルビが消える」不具合が出ていた。
//
// これを解消するため、finalize 後の `renderInnerText` が使う本番の実 DOM 構造をそのまま
// 編集中プレビューでも使う:
//   <span class="ruby-wrap ruby-edit-pending">
//     <span class="ruby-base">親文字 (or per-char 装飾 span)</span>
//     <span class="ruby-text" contenteditable="false">rt</span>
//   </span>
// .ruby-text は contenteditable="false" にして caret の進入と readContents による
// state.contents 破壊を両方とも防ぐ（readContents 側でも .ruby-text の text node を skip）。
//
// finalize 後の renderInnerText 再構築でも同じ DOM 構造に置き換わるため、編集中 → finalize
// での「見た目の連続性」も担保される。
//
// 引数: start, end (char 範囲)、rubyText, rubyType, rubyScale
// 戻り値: 編集中レイヤーが無い / range 解決失敗で false。
export function applyEditModeRubyToRange(start, end, rubyText, rubyType, rubyScale, options = {}) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) return false;
  const editing = document.querySelector(".layer-box.editing");
  if (!editing) return false;
  const inner = editing.querySelector(".existing-layer-text:not(.stroke-preview-underlay), .new-layer-text:not(.stroke-preview-underlay)");
  if (!inner) return false;
  if (typeof rubyText !== "string" || rubyText.length === 0) return false;
  const isNakaguroRubyText = (value) => {
    const chars = Array.from(String(value ?? ""));
    return chars.length > 0 && chars.every((ch) => {
      const code = ch.charCodeAt(0);
      return code === 0x30fb || code === 0xff65;
    });
  };
  const isDakutenRubyText = (value) => {
    const chars = Array.from(String(value ?? ""));
    return chars.length > 0 && chars.every((ch) => {
      const code = ch.charCodeAt(0);
      return code === 0x309b || code === 0xff9e || code === 0x3099;
    });
  };
  const isSpecialRubyText = (value) => isNakaguroRubyText(value) || isDakutenRubyText(value);
  const applyDefaultRubyFont = () => {
    // ルビは親文字（レイヤー）のフォントを CSS 継承させるため、font-family を設定しない。
    // 以前は環境設定の既定フォント (F910) を明示適用しており、フレーム全体のフォントを
    // 変えても in-place 編集中のルビプレビューだけ F910 になる原因だった。
    // （確定後の描画は effectiveRubyFontForChar 側で同じく継承する。）
  };
  const rubyTextMatches = (value, target) => {
    if (typeof value !== "string" || typeof target !== "string" || !target) return false;
    if (value === target) return true;
    const chars = Array.from(value);
    return chars.length > 0 && chars.every((ch) => ch === target);
  };
  const rubyMarkerTextMatches = (a, b) => {
    if (rubyTextMatches(a, b) || rubyTextMatches(b, a)) return true;
    if (!isSpecialRubyText(a) || !isSpecialRubyText(b)) return false;
    const aChars = Array.from(a);
    const bChars = Array.from(b);
    return aChars.length > 0
      && bChars.length > 0
      && aChars.every((ch) => ch === aChars[0])
      && bChars.every((ch) => ch === bChars[0])
      && aChars[0] === bChars[0];
  };
  const isFirstLineRange = (idx) => {
    const before = String(inner?.textContent ?? "").slice(0, Math.max(0, Number(idx) || 0));
    return !/[\r\n]/.test(before);
  };
  const positionOverlayWithinWrap = (rt, wrap, overlayStart, overlayEnd) => {
    const wrapStart = Number(wrap?.dataset?.rubyStart);
    const wrapEnd = Number(wrap?.dataset?.rubyEnd);
    if (!Number.isFinite(wrapStart) || !Number.isFinite(wrapEnd) || wrapEnd <= wrapStart) return;
    const from = Math.max(wrapStart, Math.min(wrapEnd, Number(overlayStart)));
    const to = Math.max(wrapStart, Math.min(wrapEnd, Number(overlayEnd)));
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return;
    const pct = ((from + to) / 2 - wrapStart) / (wrapEnd - wrapStart) * 100;
    if (!Number.isFinite(pct)) return;
    if (editing.dataset.direction === "vertical") rt.style.top = `${pct}%`;
    else rt.style.left = `${pct}%`;
  };
  const appendSpecialOverlayToHost = (host, text, from, to, scale, stackIndex = 1) => {
    for (const existing of Array.from(host.querySelectorAll(":scope > .ruby-text-overlay"))) {
      const existingStart = Number(existing.dataset.rubyStart);
      const existingEnd = Number(existing.dataset.rubyEnd);
      const existingText = existing.dataset.rubyText ?? existing.textContent ?? "";
      if (Number.isFinite(existingStart)
        && Number.isFinite(existingEnd)
        && from < existingEnd
        && to > existingStart
        && rubyMarkerTextMatches(existingText, text)) {
        existing.remove();
      }
    }
    const rt = document.createElement("span");
    rt.className = `ruby-text ruby-text-overlay${isNakaguroRubyText(text) ? " ruby-text-nakaguro" : ""}${isSpecialRubyText(text) ? " ruby-text-overlay-same-position" : ""}`;
    if (isFirstLineRange(from)) rt.classList.add("ruby-text-first-line");
    rt.contentEditable = "false";
    rt.setAttribute("aria-hidden", "true");
    rt.dataset.rubyStart = String(from);
    rt.dataset.rubyEnd = String(to);
    rt.dataset.rubyText = text;
    rt.dataset.rubyOverlay = "true";
    rt.textContent = text;
    rt.style.setProperty("--ruby-scale", `${((Number(scale) || 50) / 100)}em`);
    rt.style.setProperty("--ruby-stack-index", String(stackIndex));
    applyDefaultRubyFont(rt);
    positionOverlayWithinWrap(rt, host, from, to);
    host.appendChild(rt);
    return rt;
  };
  if (options?.appendOverlay) {
    const targets = Array.from(inner.querySelectorAll(".ruby-wrap")).filter((wrap) => {
      const rubyStart = Number(wrap.dataset.rubyStart);
      const rubyEnd = Number(wrap.dataset.rubyEnd);
      return Number.isFinite(rubyStart)
        && Number.isFinite(rubyEnd)
        && start < rubyEnd
        && end > rubyStart;
    });
    if (targets.length > 0) {
      if (rubyType === "group" && isSpecialRubyText(rubyText) && targets.length > 1) {
        const hostStart = Math.min(...targets.map((wrap) => Number(wrap.dataset.rubyStart)).filter(Number.isFinite));
        const hostEnd = Math.max(...targets.map((wrap) => Number(wrap.dataset.rubyEnd)).filter(Number.isFinite));
        let host = targets[0].closest(".ruby-mono-group");
        const hostContainsAll = host && targets.every((wrap) => host.contains(wrap));
        if (!hostContainsAll) {
          host = document.createElement("span");
          host.className = "ruby-mono-group ruby-edit-pending";
          host.dataset.rubyStart = String(hostStart);
          host.dataset.rubyEnd = String(hostEnd);
          targets[0].parentNode?.insertBefore(host, targets[0]);
          for (const wrap of targets) host.appendChild(wrap);
        } else {
          host.dataset.rubyStart = String(hostStart);
          host.dataset.rubyEnd = String(hostEnd);
        }
        appendSpecialOverlayToHost(host, rubyText, start, end, rubyScale, 1);
        inner.classList.add("has-ruby");
        return true;
      }
      const overlayTargets = rubyType === "group" ? targets.slice(0, 1) : targets;
      for (const wrap of overlayTargets) {
        const baseRuby = wrap.querySelector(":scope > .ruby-text:not(.ruby-text-overlay)");
        const baseRubyText = baseRuby?.dataset?.rubyText ?? baseRuby?.textContent ?? "";
        if (rubyMarkerTextMatches(baseRubyText, rubyText)) continue;
        for (const existing of Array.from(wrap.querySelectorAll(":scope > .ruby-text-overlay"))) {
          const existingStart = Number(existing.dataset.rubyStart);
          const existingEnd = Number(existing.dataset.rubyEnd);
          const existingText = existing.dataset.rubyText ?? existing.textContent ?? "";
          if (Number.isFinite(existingStart)
            && Number.isFinite(existingEnd)
            && start < existingEnd
            && end > existingStart
            && rubyMarkerTextMatches(existingText, rubyText)) {
            existing.remove();
          }
        }
        appendSpecialOverlayToHost(wrap, rubyText, start, end, rubyScale, wrap.querySelectorAll(".ruby-text-overlay").length + 1);
      }
      inner.classList.add("has-ruby");
      return true;
    }
  }

  const startPos = charIndexToNodeOffset(inner, start);
  const endPos = charIndexToNodeOffset(inner, end);
  if (!startPos || !endPos) return false;

  const range = document.createRange();
  try {
    range.setStart(startPos.node, startPos.offset);
    range.setEnd(endPos.node, endPos.offset);
  } catch { return false; }

  // 既存の `.ruby-wrap` が範囲に交差する場合は事前に unwrap（親の中身を外に出して
  // wrap 要素自体を削除）して、新規 wrap を nest させない。state.charRubies 側は
  // setCharRubiesRange の dropOverlapping で既にクリーンになっているので、DOM 側
  // だけ揃える必要がある。
  unwrapRubyInRange(inner, range);
  // 範囲が unwrap で text node の状態が変わった可能性があるため char index から
  // 再解決する（unwrap は文字を消さないので start/end char index は不変）。
  const startPos2 = charIndexToNodeOffset(inner, start);
  const endPos2 = charIndexToNodeOffset(inner, end);
  if (!startPos2 || !endPos2) return false;
  try {
    range.setStart(startPos2.node, startPos2.offset);
    range.setEnd(endPos2.node, endPos2.offset);
  } catch { return false; }

  // 本番と同じ DOM 構造を組む:
  //   <span class="ruby-wrap ruby-edit-pending">
  //     <span class="ruby-base">親文字 (or 既存の per-char 装飾 span)</span>
  //     <span class="ruby-text" contenteditable="false">rt</span>
  //   </span>
  // ruby-edit-pending クラスを併記する理由: 既存の `inner.querySelector(".ruby-edit-pending")`
  // ガード（applyConversionToInner 内）と互換性を保つため。
  const wrap = document.createElement("span");
  wrap.className = "ruby-wrap ruby-edit-pending";
  // 【v1.29.x UI-coord】後段の measureRubyOffsets が「どの charRubies エントリに対応するか」
  // 特定できるように、絶対 char start を data 属性で持たせる。
  wrap.dataset.rubyStart = String(start);
  wrap.dataset.rubyEnd = String(end);
  if (rubyType === "mono" || rubyType === "group") {
    wrap.setAttribute("data-ruby-type", rubyType);
  }
  if (Number.isFinite(rubyScale) && rubyScale > 0) {
    wrap.style.setProperty("--ruby-scale", `${rubyScale / 100}em`);
  }
  // 親文字部分: range の内容を extractContents で取り出して .ruby-base に詰める。
  const base = document.createElement("span");
  base.className = "ruby-base";
  try {
    const contents = range.extractContents();
    base.appendChild(contents);
    wrap.appendChild(base);
  } catch { return false; }
  // ふりがな部分: 実 DOM の <span class="ruby-text"> として追加。
  // contenteditable="false" で caret 進入を禁止 + readContents 側で除外する。
  const rt = document.createElement("span");
  rt.className = `ruby-text${isNakaguroRubyText(rubyText) ? " ruby-text-nakaguro" : ""}${isSpecialRubyText(rubyText) ? " ruby-text-overlay-same-position" : ""}`;
  if (isFirstLineRange(start)) rt.classList.add("ruby-text-first-line");
  rt.contentEditable = "false";
  rt.setAttribute("aria-hidden", "true");
  rt.dataset.rubyStart = String(start);
  rt.dataset.rubyEnd = String(end);
  rt.dataset.rubyText = rubyText;
  rt.dataset.rubyOverlay = "false";
  rt.textContent = rubyText;
  applyDefaultRubyFont(rt);
  wrap.appendChild(rt);
  try {
    range.insertNode(wrap);
  } catch { return false; }
  // 親 inner の overflow:hidden が .ruby-text の絶対配置を切り取らないように has-ruby クラスを付ける。
  inner.classList.add("has-ruby");
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => {
      const overlay = inner.closest(".page-overlay");
      if (overlay) placeRubyAtLineMidpointsForOverlay(overlay, { towardParentRatio: 0 });
    });
  }
  return true;
}

// 【v1.27.0】range と交差する既存 `.ruby-wrap` を inner DOM から unwrap する。
// 「unwrap」= wrap 自身を外して .ruby-base の子要素を wrap の位置に移動 + .ruby-text を削除。
// 結果として親文字（plain text もしくは per-char スタイル付き span）だけが残り、
// その後の extractContents が予想通りに動作する。
//
// 「交差する wrap」の検出: wrap の bounding range (wrap 全体を覆う Range) と引数 range が
// 交差する場合に unwrap 対象とする。range が wrap の内側に完全に収まっているケースも
// 含まれる（user が既存 ruby を再適用するケース）。
function unwrapRubyInRange(inner, range) {
  if (!inner || !range) return [];
  const removed = [];
  const wraps = Array.from(inner.querySelectorAll(".ruby-wrap"));
  for (const wrap of wraps) {
    const wrapRange = document.createRange();
    try { wrapRange.selectNode(wrap); } catch { continue; }
    // range と wrapRange が交差するか
    const intersects =
      range.compareBoundaryPoints(Range.END_TO_START, wrapRange) > 0
      && range.compareBoundaryPoints(Range.START_TO_END, wrapRange) < 0;
    if (!intersects) { wrapRange.detach?.(); continue; }
    const rubyStart = Number(wrap.dataset.rubyStart);
    const rubyEnd = Number(wrap.dataset.rubyEnd);
    if (Number.isInteger(rubyStart) && Number.isInteger(rubyEnd) && rubyEnd > rubyStart) {
      removed.push({ start: rubyStart, end: rubyEnd });
    }
    // .ruby-base の中身を wrap の親に移動（wrap 位置に挿入）して wrap を削除。
    const parent = wrap.parentNode;
    if (!parent) continue;
    const base = wrap.querySelector(":scope > .ruby-base");
    if (base) {
      while (base.firstChild) parent.insertBefore(base.firstChild, wrap);
    }
    parent.removeChild(wrap);
  }
  // unwrap 後に隣接 text node の正規化（merge）を行う。range の boundary 位置が
  // text node 内 offset に正しく解決されるようにするため。
  inner.normalize();
  return removed;
}

export function removeEditModeRubyTextFromRange(start, end, rubyText) {
  const editing = document.querySelector(".layer-box.editing");
  if (!editing) return false;
  const inner = editing.querySelector(".existing-layer-text:not(.stroke-preview-underlay), .new-layer-text:not(.stroke-preview-underlay)");
  if (!inner || typeof rubyText !== "string" || !rubyText) return false;
  const isDakutenText = (value) => {
    const chars = Array.from(String(value ?? ""));
    return chars.length > 0 && chars.every((ch) => {
      const code = ch.charCodeAt(0);
      return code === 0x309b || code === 0xff9e || code === 0x3099;
    });
  };
  const isNakaguroText = (value) => {
    const chars = Array.from(String(value ?? ""));
    return chars.length > 0 && chars.every((ch) => {
      const code = ch.charCodeAt(0);
      return code === 0x30fb || code === 0xff65;
    });
  };
  const matchesRubyText = (value) => {
    if (typeof value !== "string" || !value) return false;
    if (value === rubyText) return true;
    if (isNakaguroText(value) && isNakaguroText(rubyText)) return true;
    if (isDakutenText(value) && isDakutenText(rubyText)) return true;
    const chars = Array.from(value);
    return chars.length > 0 && chars.every((ch) => ch === rubyText);
  };
  let changed = false;
  const cleanupEmptyRubyGroups = () => {
    for (const group of Array.from(inner.querySelectorAll(".ruby-mono-group"))) {
      if (group.querySelector(":scope > .ruby-text-overlay")) continue;
      const parent = group.parentNode;
      if (!parent) continue;
      while (group.firstChild) parent.insertBefore(group.firstChild, group);
      parent.removeChild(group);
    }
  };
  for (const group of Array.from(inner.querySelectorAll(".ruby-mono-group"))) {
    const rubyStart = Number(group.dataset.rubyStart);
    const rubyEnd = Number(group.dataset.rubyEnd);
    if (!Number.isFinite(rubyStart) || !Number.isFinite(rubyEnd) || !(start < rubyEnd && end > rubyStart)) continue;
    for (const rt of Array.from(group.querySelectorAll(":scope > .ruby-text-overlay"))) {
      if (matchesRubyText(rt.textContent)) {
        rt.remove();
        changed = true;
      }
    }
  }
  cleanupEmptyRubyGroups();
  for (const wrap of Array.from(inner.querySelectorAll(".ruby-wrap"))) {
    const rubyStart = Number(wrap.dataset.rubyStart);
    const rubyEnd = Number(wrap.dataset.rubyEnd);
    if (!Number.isFinite(rubyStart) || !Number.isFinite(rubyEnd) || !(start < rubyEnd && end > rubyStart)) continue;
    const baseRuby = wrap.querySelector(":scope > .ruby-text:not(.ruby-text-overlay)");
    if (matchesRubyText(baseRuby?.textContent)) {
      const parent = wrap.parentNode;
      const base = wrap.querySelector(":scope > .ruby-base");
      if (parent && base) {
        while (base.firstChild) parent.insertBefore(base.firstChild, wrap);
        parent.removeChild(wrap);
        changed = true;
      }
      continue;
    }
    for (const rt of Array.from(wrap.querySelectorAll(":scope > .ruby-text-overlay"))) {
      if (matchesRubyText(rt.textContent)) {
        rt.remove();
        changed = true;
      }
    }
  }
  cleanupEmptyRubyGroups();
  inner.normalize();
  inner.classList.toggle("has-ruby", !!inner.querySelector(".ruby-wrap"));
  return changed;
}

export function removeEditModeRubyFromRange(start, end) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) return [];
  const editing = document.querySelector(".layer-box.editing");
  if (!editing) return [];
  const inner = editing.querySelector(".existing-layer-text:not(.stroke-preview-underlay), .new-layer-text:not(.stroke-preview-underlay)");
  if (!inner) return [];
  const startPos = charIndexToNodeOffset(inner, start);
  const endPos = charIndexToNodeOffset(inner, end);
  if (!startPos || !endPos) return [];
  const range = document.createRange();
  try {
    range.setStart(startPos.node, startPos.offset);
    range.setEnd(endPos.node, endPos.offset);
  } catch {
    return [];
  }
  const removed = unwrapRubyInRange(inner, range);
  inner.classList.toggle("has-ruby", !!inner.querySelector(".ruby-wrap"));
  return removed;
}

// inner 内の text node を順に走査し、char index に対応する (text node, offset) を返す。
function isEditableLineBlock(node) {
  return node?.nodeType === Node.ELEMENT_NODE
    && (node.tagName === "DIV" || node.tagName === "P");
}

function isRubyTextElement(node) {
  return node?.nodeType === Node.ELEMENT_NODE
    && node.classList?.contains("ruby-text");
}

function isInsideRubyText(node, rootEl) {
  let p = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  while (p && p !== rootEl) {
    if (isRubyTextElement(p)) return true;
    p = p.parentElement;
  }
  return false;
}

function normalizedEditableText(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").replace(/\u200b/g, "");
}

function rawOffsetForNormalizedIndex(value, targetIndex) {
  const raw = String(value ?? "");
  const target = Math.max(0, targetIndex);
  let seen = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "\u200b") continue;
    if (ch === "\r") {
      if (seen >= target) return i;
      seen++;
      if (raw[i + 1] === "\n") i++;
      continue;
    }
    if (seen >= target) return i;
    seen++;
  }
  return raw.length;
}

function childOffsetInParent(node) {
  const parent = node?.parentNode;
  if (!parent) return 0;
  return Array.prototype.indexOf.call(parent.childNodes, node);
}

function firstEditableTextPosition(node, rootEl, fallbackOffset = 0) {
  if (!node) return { node: rootEl, offset: fallbackOffset };
  if (node.nodeType === Node.TEXT_NODE && !isInsideRubyText(node, rootEl)) {
    return { node, offset: 0 };
  }
  if (isRubyTextElement(node)) return { node: rootEl, offset: fallbackOffset };
  for (const child of Array.from(node.childNodes ?? [])) {
    const pos = firstEditableTextPosition(child, rootEl, fallbackOffset);
    if (pos && pos.node !== rootEl) return pos;
  }
  return { node: rootEl, offset: fallbackOffset };
}

function appendVirtualLineBreak(parts) {
  for (let i = parts.length - 1; i >= 0; i--) {
    if (!parts[i]) continue;
    if (parts[i].endsWith("\n")) return;
    break;
  }
  parts.push("\n");
}

function serializeEditableText(rootEl, stopContainer = null, stopOffset = null) {
  const parts = [];
  let done = false;

  const appendNode = (node) => {
    if (!node || done) return;
    if (node === stopContainer) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (!isInsideRubyText(node, rootEl)) {
          parts.push(String(node.nodeValue ?? "").slice(0, Math.max(0, stopOffset ?? 0)));
        }
        done = true;
        return;
      }
      if (node.nodeType === Node.ELEMENT_NODE || node === rootEl) {
        appendChildren(node, Math.max(0, stopOffset ?? 0));
        done = true;
        return;
      }
    }
    if (node.nodeType === Node.TEXT_NODE) {
      if (!isInsideRubyText(node, rootEl)) parts.push(node.textContent ?? "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (isRubyTextElement(node)) return;
    if (node.tagName === "BR") {
      parts.push("\n");
      return;
    }
    appendChildren(node);
  };

  const appendChildren = (parent, limit = null) => {
    const children = Array.from(parent.childNodes ?? []);
    const end = limit == null ? children.length : Math.min(limit, children.length);
    let sawLineBlock = false;
    for (let i = 0; i < end && !done; i++) {
      const child = children[i];
      if (parent === rootEl && isEditableLineBlock(child)) {
        if (sawLineBlock) appendVirtualLineBreak(parts);
        sawLineBlock = true;
      }
      appendNode(child);
    }
  };

  appendChildren(rootEl);
  return normalizedEditableText(parts.join(""));
}

function textLengthToDomPoint(rootEl, container, offset) {
  return serializeEditableText(rootEl, container, offset).length;
}

function charIndexToNodeOffset(rootEl, charIndex) {
  const target = Math.max(0, charIndex);
  let index = 0;
  let best = { node: rootEl, offset: 0 };
  let lastChar = "";

  const consumeVirtualLineBreak = (nextNode, nextOffset) => {
    if (target <= index) return best;
    if (lastChar !== "\n") {
      if (target === index + 1) {
        return firstEditableTextPosition(nextNode, rootEl, nextOffset);
      }
      index += 1;
      lastChar = "\n";
      best = firstEditableTextPosition(nextNode, rootEl, nextOffset);
    }
    return null;
  };

  const visit = (node) => {
    if (!node) return null;
    if (node.nodeType === Node.TEXT_NODE) {
      if (isInsideRubyText(node, rootEl)) return null;
      const text = normalizedEditableText(node.nodeValue);
      const len = text.length;
      if (target <= index + len) {
        return { node, offset: rawOffsetForNormalizedIndex(node.nodeValue, target - index) };
      }
      index += len;
      if (len > 0) lastChar = text[text.length - 1];
      best = { node, offset: node.nodeValue.length };
      return null;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    if (isRubyTextElement(node)) return null;
    if (node.tagName === "BR") {
      if (target <= index) return best;
      const parent = node.parentNode ?? rootEl;
      const offset = childOffsetInParent(node) + 1;
      if (target === index + 1) return { node: parent, offset };
      index += 1;
      lastChar = "\n";
      best = { node: parent, offset };
      return null;
    }
    for (const child of Array.from(node.childNodes)) {
      const hit = visit(child);
      if (hit) return hit;
    }
    return null;
  };

  let sawLineBlock = false;
  const children = Array.from(rootEl.childNodes);
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (isEditableLineBlock(child)) {
      if (sawLineBlock) {
        const hit = consumeVirtualLineBreak(child, i);
        if (hit) return hit;
      }
      sawLineBlock = true;
    }
    const hit = visit(child);
    if (hit) return hit;
  }
  return best;
}

// 範囲内の span で指定 styleProp を持つものを unwrap（中身の child を親に展開して span を削除）。
// ネスト span による em 乗算を防ぐ目的。fully-inside の span のみが対象（partial overlap は
// 触らない）。range は unwrap 後に invalid になり得るので、呼び出し側で再構築する想定。
function unwrapStyleSpansInRange(rootEl, range, styleProp) {
  const targets = [];
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode();
  while (node) {
    if (node.tagName === "SPAN" && node.style[styleProp]) {
      const elRange = document.createRange();
      elRange.selectNode(node);
      // span 全体が range に内包されているなら unwrap 対象。
      const startsAfterRange = range.compareBoundaryPoints(Range.START_TO_START, elRange) <= 0;
      const endsBeforeRange = range.compareBoundaryPoints(Range.END_TO_END, elRange) >= 0;
      if (startsAfterRange && endsBeforeRange) targets.push(node);
    }
    node = walker.nextNode();
  }
  for (const span of targets) {
    const parent = span.parentNode;
    if (!parent) continue;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
  }
}

// 環境設定（フォント名表示 / サイズ表示の切替など）が変わったらオーバーレイを再描画して
// 選択中のバッジに即時反映する。
let settingsListenerBound = false;
function applyInPlaceEditZoomClass(box = document.querySelector(".layer-box.editing")) {
  if (!box) return;
  box.classList.toggle("editing-zoomed", getDefault("inPlaceEditZoomEnabled") !== false);
}

function bindSettingsListener() {
  if (settingsListenerBound) return;
  settingsListenerBound = true;
  onSettingsChange(() => {
    applyInPlaceEditZoomClass();
    refreshAllOverlays();
  });
}
bindSettingsListener();

export function nudgeSelectedLayers(dx, dy) {
  const selections = getSelectedLayers();
  if (selections.length === 0) return false;
  const pages = getPages();
  const moved = withHistoryTransient(() => {
    let any = false;
    for (const sel of selections) {
      const page = pages[sel.pageIndex];
      if (!page) continue;
      if (typeof sel.layerId === "string") {
        const nl = getNewLayersForPsd(page.path).find((l) => l.tempId === sel.layerId);
        if (!nl) continue;
        updateNewLayer(sel.layerId, { x: nl.x + dx, y: nl.y + dy });
        any = true;
      } else {
        const layer = page.textLayers.find((l) => l.id === sel.layerId);
        if (!layer) continue;
        addEditOffset(page.path, sel.layerId, dx, dy);
        any = true;
      }
    }
    return any || false;
  });
  if (moved) {
    hideSelectedLayerBadges = true;
    refreshAllOverlays();
    rebuildLayerList();
  }
  return !!moved;
}

function normalizedRotation(deg) {
  return ((deg + 180) % 360 + 360) % 360 - 180;
}

function setLayerRotationForPage(page, layerId, deg) {
  const normalized = normalizedRotation(deg);
  if (typeof layerId === "string") {
    updateNewLayer(layerId, { rotation: normalized });
  } else {
    setEdit(page.path, layerId, { rotation: normalized });
  }
}

export function rotateSelectedLayers(deltaDeg = 90) {
  const selections = getSelectedLayers();
  if (selections.length === 0) return false;
  const pages = getPages();
  const rotated = withHistoryTransient(() => {
    let any = false;
    for (const sel of selections) {
      const page = pages[sel.pageIndex];
      if (!page) continue;
      if (typeof sel.layerId === "string") {
        const nl = getNewLayersForPsd(page.path).find((l) => l.tempId === sel.layerId);
        if (!nl) continue;
        setLayerRotationForPage(page, sel.layerId, (nl.rotation ?? 0) + deltaDeg);
        any = true;
      } else {
        const layer = page.textLayers.find((l) => l.id === sel.layerId);
        if (!layer) continue;
        const edit = getEdit(page.path, sel.layerId) ?? {};
        setLayerRotationForPage(page, sel.layerId, (edit.rotation ?? 0) + deltaDeg);
        any = true;
      }
    }
    return any || false;
  });
  if (rotated) {
    showSelectedLayerBadges();
    refreshAllOverlays();
    rebuildLayerList();
  }
  return !!rotated;
}

export function showRotationHandlesForSelectedLayers() {
  if (getSelectedLayers().length === 0) return false;
  rotateHandlesVisible = true;
  refreshAllOverlays();
  return true;
}

function normalizeEditFontSize(inner, value) {
  if (typeof value !== "string" || !value.trim().endsWith("em")) return value;
  const ratio = Number.parseFloat(value);
  const basePx = Number.parseFloat(window.getComputedStyle(inner).fontSize);
  if (!Number.isFinite(ratio) || !Number.isFinite(basePx) || basePx <= 0) return value;
  return `${ratio * basePx}px`;
}

// 選択中のレイヤーを削除する（Delete / Backspace から呼ばれる想定）。
// 新規追加レイヤーのみ削除可能。PSD 既存テキストレイヤーは選択から外すだけで残す
// （PSD バイナリからの削除は edit モデル外のため未対応）。
// 何かを削除した場合 true、対象がなく no-op の場合 false を返す。
export function deleteSelectedLayers() {
  const selections = getSelectedLayers();
  const tempIds = selections
    .filter((s) => typeof s.layerId === "string")
    .map((s) => s.layerId);
  if (tempIds.length === 0) return false;

  // 削除前のレイヤースナップショットを取り、sourceTxtRef を持つものは TXT 側からも消す
  // ための情報として保持する（自動配置レイヤー → 原稿テキスト の cascade）。
  const tempIdSet = new Set(tempIds);
  const deletedLayerSnapshots = [];
  for (const sel of selections) {
    if (typeof sel.layerId !== "string") continue;
    const page = getPages()[sel.pageIndex];
    if (!page) continue;
    const nl = getNewLayersForPsd(page.path).find((l) => l.tempId === sel.layerId);
    if (nl) deletedLayerSnapshots.push(nl);
  }

  withHistoryTransient(() => {
    for (const id of tempIds) removeNewLayer(id);
    // 削除されたレイヤーが原稿テキストの段落に紐付いていれば、その段落も TXT 側から取り除く。
    // editor-textarea / txt-source-viewer は state.txtSource の listener 経由で自動更新される。
    cascadeRemoveTxtForLayers(deletedLayerSnapshots, tempIdSet);
  });
  // 既存 PSD レイヤーの選択は維持し、新規分のみ選択から外す。
  setSelectedLayers(selections.filter((s) => typeof s.layerId !== "string"));
  refreshAllOverlays();
  rebuildLayerList();
  return true;
}

let layerClipboard = [];

function cloneMap(value) {
  if (!value || typeof value !== "object") return {};
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return { ...value };
  }
}

function selectedLayerToClipboardItem(sel) {
  const page = getPages()[sel.pageIndex];
  if (!page) return null;

  if (typeof sel.layerId === "string") {
    const nl = getNewLayersForPsd(page.path).find((l) => l.tempId === sel.layerId);
    if (!nl) return null;
    return {
      x: nl.x,
      y: nl.y,
      contents: nl.contents ?? "",
      fontPostScriptName: nl.fontPostScriptName ?? null,
      sizePt: nl.sizePt ?? null,
      direction: nl.direction ?? "vertical",
      strokeColor: nl.strokeColor ?? "none",
      strokeWidthPx: nl.strokeWidthPx ?? 20,
      fillColor: nl.fillColor ?? "default",
      rotation: nl.rotation ?? 0,
      leadingPct: nl.leadingPct ?? 125,
      horizontalScale: nl.horizontalScale ?? 100,
      verticalScale: nl.verticalScale ?? 100,
      trackingMille: nl.trackingMille ?? 0,
      kerningMille: nl.kerningMille ?? 0,
      syntheticBold: nl.syntheticBold === true,
      syntheticItalic: nl.syntheticItalic === true,
      lineLeadings: cloneMap(nl.lineLeadings),
      charRubies: cloneMap(nl.charRubies),
      charSizes: cloneMap(nl.charSizes),
      charFonts: cloneMap(nl.charFonts),
      charBolds: cloneMap(nl.charBolds),
      charItalics: cloneMap(nl.charItalics),
      charHorizontalScales: cloneMap(nl.charHorizontalScales),
      charVerticalScales: cloneMap(nl.charVerticalScales),
      charTrackings: cloneMap(nl.charTrackings),
      charKernings: cloneMap(nl.charKernings),
      charTateChuYokos: cloneMap(nl.charTateChuYokos),
      charFillColors: cloneMap(nl.charFillColors),
      autoFontSwitched: nl.autoFontSwitched === true,
      autoFontSwitchBucket: Number.isInteger(nl.autoFontSwitchBucket) ? nl.autoFontSwitchBucket : -1,
      lowExtractTextMatch: nl.lowExtractTextMatch === true,
      extractMatchScore: Number.isFinite(nl.extractMatchScore) ? nl.extractMatchScore : null,
      reuseTightThick: nl.reuseTightThick === true,
    };
  }

  const layer = page.textLayers.find((l) => l.id === sel.layerId);
  if (!layer) return null;
  const edit = getEdit(page.path, sel.layerId) ?? {};
  if (edit.deleted === true) return null;
  return {
    x: (layer.left ?? 0) + (edit.dx ?? 0),
    y: (layer.top ?? 0) + (edit.dy ?? 0),
    contents: edit.contents ?? layer.text ?? "",
    fontPostScriptName: edit.fontPostScriptName ?? layer.font ?? null,
    sizePt: edit.sizePt ?? layer.fontSize ?? null,
    direction: edit.direction ?? layer.direction ?? "horizontal",
    strokeColor: edit.strokeColor ?? layer.strokeColor ?? "none",
    strokeWidthPx: edit.strokeWidthPx ?? layer.strokeWidthPx ?? 20,
    fillColor: edit.fillColor ?? layer.fillColor ?? "default",
    rotation: edit.rotation ?? 0,
    leadingPct: edit.leadingPct ?? 125,
    horizontalScale: edit.horizontalScale ?? layer.horizontalScale ?? 100,
    verticalScale: edit.verticalScale ?? layer.verticalScale ?? 100,
    trackingMille: edit.trackingMille ?? layer.trackingMille ?? 0,
    kerningMille: edit.kerningMille ?? layer.kerningMille ?? 0,
    syntheticBold: edit.syntheticBold === true,
    syntheticItalic: edit.syntheticItalic === true,
    lineLeadings: cloneMap(edit.lineLeadings),
    charRubies: cloneMap(edit.charRubies),
    charSizes: { ...(layer.charSizes ?? {}), ...(edit.charSizes ?? {}) },
    charFonts: { ...(layer.charFonts ?? {}), ...(edit.charFonts ?? {}) },
    charBolds: cloneMap(edit.charBolds),
    charItalics: cloneMap(edit.charItalics),
    charHorizontalScales: { ...(layer.charHorizontalScales ?? {}), ...(edit.charHorizontalScales ?? {}) },
    charVerticalScales: { ...(layer.charVerticalScales ?? {}), ...(edit.charVerticalScales ?? {}) },
    charTrackings: { ...(layer.charTrackings ?? {}), ...(edit.charTrackings ?? {}) },
    charKernings: { ...(layer.charKernings ?? {}), ...(edit.charKernings ?? {}) },
    charTateChuYokos: { ...(layer.charTateChuYokos ?? {}), ...(edit.charTateChuYokos ?? {}) },
    charFillColors: { ...(layer.charFillColors ?? {}), ...(edit.charFillColors ?? {}) },
  };
}

function addClipboardItemToPage(item, page, sourceTxtRef = null) {
  const created = addNewLayer({
    psdPath: page.path,
    x: item.x,
    y: item.y,
    contents: item.contents,
    fontPostScriptName: item.fontPostScriptName,
    sizePt: item.sizePt,
    direction: item.direction,
    strokeColor: item.strokeColor,
    strokeWidthPx: item.strokeWidthPx,
    fillColor: item.fillColor,
    rotation: item.rotation ?? 0,
    leadingPct: item.leadingPct ?? 125,
    horizontalScale: item.horizontalScale ?? 100,
    verticalScale: item.verticalScale ?? 100,
    trackingMille: item.trackingMille ?? 0,
    kerningMille: item.kerningMille ?? 0,
    syntheticBold: item.syntheticBold === true,
    syntheticItalic: item.syntheticItalic === true,
    lineLeadings: item.lineLeadings,
    charRubies: item.charRubies,
    sourceTxtRef,
    autoFontSwitched: item.autoFontSwitched,
    autoFontSwitchBucket: item.autoFontSwitchBucket,
    lowExtractTextMatch: item.lowExtractTextMatch,
    extractMatchScore: item.extractMatchScore,
    reuseTightThick: item.reuseTightThick,
  });
  updateNewLayer(created.tempId, {
    charSizes: cloneMap(item.charSizes),
    charFonts: cloneMap(item.charFonts),
    charBolds: cloneMap(item.charBolds),
    charItalics: cloneMap(item.charItalics),
    charHorizontalScales: cloneMap(item.charHorizontalScales),
    charVerticalScales: cloneMap(item.charVerticalScales),
    charTrackings: cloneMap(item.charTrackings),
    charKernings: cloneMap(item.charKernings),
    charTateChuYokos: cloneMap(item.charTateChuYokos),
    charFillColors: cloneMap(item.charFillColors),
  });
  return created;
}

export function cutSelectedLayersToClipboard() {
  const selections = getSelectedLayers();
  if (selections.length === 0) return false;
  const items = selections.map(selectedLayerToClipboardItem).filter(Boolean);
  if (items.length === 0) return false;

  layerClipboard = items.map((item) => ({ ...item }));
  const tempIds = [];
  const hiddenExisting = [];
  const deletedLayerSnapshots = [];
  for (const sel of selections) {
    const page = getPages()[sel.pageIndex];
    if (!page) continue;
    if (typeof sel.layerId === "string") {
      const nl = getNewLayersForPsd(page.path).find((l) => l.tempId === sel.layerId);
      if (!nl) continue;
      tempIds.push(sel.layerId);
      deletedLayerSnapshots.push(nl);
    } else {
      const layer = page.textLayers.find((l) => l.id === sel.layerId);
      if (!layer) continue;
      hiddenExisting.push({ page, layerId: sel.layerId });
    }
  }
  if (tempIds.length === 0 && hiddenExisting.length === 0) return false;

  withHistoryTransient(() => {
    for (const id of tempIds) removeNewLayer(id);
    for (const { page, layerId } of hiddenExisting) setEdit(page.path, layerId, { deleted: true });
    cascadeRemoveTxtForLayers(deletedLayerSnapshots, new Set(tempIds));
  });
  setSelectedLayers([]);
  refreshAllOverlays();
  rebuildLayerList();
  return true;
}

export function pasteClipboardLayersToCurrentPage() {
  if (layerClipboard.length === 0) return false;
  const pageIndex = getCurrentPageIndex();
  const page = getPages()[pageIndex];
  if (!page) return false;

  let created = [];
  withHistoryTransient(() => {
    const pageNumber = pageIndex + 1;
    let source = getTxtSource() ?? { name: "new-text.txt", content: "" };
    created = [];
    for (const item of layerClipboard) {
      let sourceTxtRef = null;
      const appended = appendBlockToCurrentPageContent(source.content, pageNumber, item.contents);
      if (Number.isInteger(appended?.paragraphIndex) && appended.paragraphIndex >= 0) {
        source = { name: source.name, content: appended.content };
        sourceTxtRef = { pageNumber, paragraphIndex: appended.paragraphIndex };
      }
      const layer = addClipboardItemToPage(item, page, sourceTxtRef);
      if (layer) created.push(layer);
    }
    if (created.length > 0) setTxtSource(source);
    return created.length > 0;
  });
  if (created.length === 0) return false;
  setSelectedLayers(created.map((layer) => ({ pageIndex, layerId: layer.tempId })));
  refreshAllOverlays();
  rebuildLayerList();
  renderTxtSourceViewer();
  return true;
}

function clampSizePt(v) {
  const rounded = Math.round(v * 100) / 100;
  return Math.max(6, Math.min(999, rounded));
}

// 現在値 cur から baseStep グリッド上の「次の」値を返す。
// - グリッド上ぴったりなら sign 方向に 1 ステップ
// - グリッド外（例：0.5 刻み設定で 12.3）なら sign 方向の最寄りグリッドへスナップ
//   （+1 は ceil、-1 は floor）。これにより 12.3 + 0.5 step → 12.5（13.0 ではない）
// - multiplier > 1（Shift+wheel 等）はスナップ後に追加でグリッドを進む。
export function snapNextSize(cur, baseStep, sign, multiplier = 1, tolerance = 1e-9) {
  if (!Number.isFinite(cur) || !Number.isFinite(baseStep) || baseStep <= 0) return cur;
  const ratio = cur / baseStep;
  const snapTolerance = Number.isFinite(tolerance) && tolerance > 0 ? tolerance : 1e-9;
  const onGrid = Math.abs(cur - Math.round(ratio) * baseStep) <= snapTolerance;
  const firstStep = onGrid
    ? Math.round(ratio) + sign
    : (sign > 0 ? Math.ceil(ratio) : Math.floor(ratio));
  const finalGrid = firstStep + sign * (Math.max(1, multiplier) - 1);
  return Math.round(finalGrid * baseStep * 100) / 100;
}

function sizeSnapToleranceForUnit(unit) {
  if (!unit) return 1e-9;
  const tolerance = Math.abs(textSizePtToUnitValue(0.011, unit));
  return Number.isFinite(tolerance) && tolerance > 0 ? tolerance : 1e-9;
}

// 選択中レイヤーをサイズ変更。sign（+1 / -1）と multiplier（Shift+wheel で 10）で
// 各レイヤーの現在 sizePt を snapNextSize で次の baseStep グリッドへ移動する。
// 中心固定のため矩形差の半分だけ x/y を補正するのは従来通り。
export function resizeSelectedLayers(baseStep, sign, multiplier = 1, options = {}) {
  const selections = getSelectedLayers();
  if (selections.length === 0) return false;
  const unit = options.unit ? normalizeTextSizeUnit(options.unit) : null;
  const pages = getPages();
  const targets = [];
  for (const sel of selections) {
    const page = pages[sel.pageIndex];
    if (!page) continue;
    if (typeof sel.layerId === "string") {
      const nl = getNewLayersForPsd(page.path).find((l) => l.tempId === sel.layerId);
      if (!nl) continue;
      const cur = Number(nl.sizePt ?? 24);
      if (!Number.isFinite(cur)) continue;
      targets.push({
        kind: "new",
        sel,
        page,
        nl,
        cur,
      });
    } else {
      const layer = page.textLayers.find((l) => l.id === sel.layerId);
      if (!layer) continue;
      const edit = getEdit(page.path, sel.layerId) ?? {};
      const cur = Number(edit.sizePt ?? layer.fontSize ?? 24);
      if (!Number.isFinite(cur)) continue;
      targets.push({
        kind: "existing",
        sel,
        page,
        layer,
        edit,
        cur,
      });
    }
  }
  const stepSizes = targets
    .map((t) => unit ? textSizePtToUnitValue(t.cur, unit) : t.cur)
    .filter((s) => Number.isFinite(s));
  if (stepSizes.length === 0) return false;
  const baseSize = sign > 0 ? Math.max(...stepSizes) : Math.min(...stepSizes);
  const snapTolerance = sizeSnapToleranceForUnit(unit);
  const allSameSize = stepSizes.every((s) => Math.abs(s - baseSize) <= snapTolerance);
  const nextStepSize = allSameSize
    ? snapNextSize(baseSize, baseStep, sign, multiplier, snapTolerance)
    : baseSize;
  const nextRaw = unit ? textSizeUnitValueToPt(nextStepSize, unit) : nextStepSize;
  if (!Number.isFinite(nextRaw)) return false;
  const next = clampSizePt(nextRaw);
  let clearedAutoFontMarker = false;
  const changed = withHistoryTransient(() => {
    let any = false;
    for (const target of targets) {
      if (target.kind === "new") {
        const { sel, page, nl, cur } = target;
        const shouldClearAutoFontMarker = nl.autoFontSwitched === true;
        if (Math.abs(next - cur) < 1e-9) {
          if (shouldClearAutoFontMarker) {
            updateNewLayer(sel.layerId, {
              autoFontSwitched: false,
              autoFontSwitchBucket: -1,
            });
            clearedAutoFontMarker = true;
            any = true;
          }
          continue;
        }
        const oldRect = layerRectForNew(page, nl);
        const newRect = layerRectForNew(page, { ...nl, sizePt: next });
        const dx = (oldRect.width - newRect.width) / 2;
        const dy = (oldRect.height - newRect.height) / 2;
        updateNewLayer(sel.layerId, {
          sizePt: next,
          x: nl.x + dx,
          y: nl.y + dy,
          autoFontSwitched: false,
          autoFontSwitchBucket: -1,
        });
        if (shouldClearAutoFontMarker) clearedAutoFontMarker = true;
        any = true;
      } else {
        const { sel, page, layer, edit, cur } = target;
        if (next === cur) continue;
        const oldRect = layerRectForExisting(page, layer, edit);
        const newRect = layerRectForExisting(page, layer, { ...edit, sizePt: next });
        const ddx = (oldRect.width - newRect.width) / 2;
        const ddy = (oldRect.height - newRect.height) / 2;
        setEdit(page.path, sel.layerId, {
          sizePt: next,
          dx: (edit.dx ?? 0) + ddx,
          dy: (edit.dy ?? 0) + ddy,
        });
        any = true;
      }
    }
    return any || false;
  });
  if (changed) {
    refreshAllOverlays();
    rebuildLayerList();
    if (clearedAutoFontMarker) renderTxtSourceViewer();
  }
  return !!changed;
}

function applyToolAttrs(ctx) {
  const tool = getTool();
  ctx.overlay.dataset.tool = tool;
  ctx.canvas.style.cursor = tool === "pan" ? "grab" : "default";
}

// 既存テキストレイヤーの「実描画 fontSize（pt）」を返す。
// 写植テキストは Photoshop で「100pt → 0.2× scale」のように transform で縮められて
// 配置されることがあり、ag-psd の style.fontSize は scale 前の生値を返すため、
// 単純に layer.fontSize を採用すると frame / 内文が実描画サイズの数倍に膨れる。
// bounds (layer.left/right/top/bottom) はラスタライズ後の実描画範囲を反映するので、
// 「厚み軸長 / em-box 列数係数」で em-box pt を逆算する。
// ユーザーが明示的にサイズを編集している場合は edit.sizePt を優先、それ以外は
// declared と bounds-derived の小さい方を採用（過大値を抑える）。
export function getExistingLayerEffectiveSizePt(page, layer, edit) {
  if (edit && Number.isFinite(edit.sizePt) && edit.sizePt > 0) return edit.sizePt;
  const declaredSizePt = layer?.fontSize ?? null;
  const dpi = page?.dpi ?? 72;
  const rawWidth = Math.max(0, (layer?.right ?? 0) - (layer?.left ?? 0));
  const rawHeight = Math.max(0, (layer?.bottom ?? 0) - (layer?.top ?? 0));
  if (rawWidth > 0 && rawHeight > 0) {
    const direction = edit?.direction ?? layer?.direction ?? "horizontal";
    const isVertical = direction === "vertical";
    const text = edit?.contents ?? layer?.text ?? "";
    const lineCount = Math.max(1, countLines(text));
    const thickPsdPx = isVertical ? rawWidth : rawHeight;
    // tight bounds 想定: thick = em × (1 + (n-1) × leading_default)
    // leading_default は写植系の慣例で 1.25 を仮定（autoLeading 125% と整合）。
    const tightDenom = 1 + Math.max(0, lineCount - 1) * 1.25;
    if (tightDenom > 0) {
      const ptPsdPx = thickPsdPx / tightDenom;
      const sizeFromBounds = (ptPsdPx * 72) / dpi;
      if (sizeFromBounds > 0) {
        // bounds が padded で大きめに出ているケースでは declared を尊重するため、
        // 必ず小さい方を選ぶ（過大化を防ぐのが目的）。
        return declaredSizePt > 0
          ? Math.min(declaredSizePt, sizeFromBounds)
          : sizeFromBounds;
      }
    }
  }
  return declaredSizePt ?? 24;
}

export function layerRectForExisting(page, layer, edit) {
  const dpi = page.dpi ?? 72;
  const left0 = layer.left ?? 0;
  const top0 = layer.top ?? 0;
  const rawWidth = Math.max(0, (layer.right ?? 0) - left0);
  const rawHeight = Math.max(0, (layer.bottom ?? 0) - top0);

  const direction = edit.direction ?? layer.direction ?? "horizontal";
  const isVertical = direction === "vertical";
  const previewText = edit.contents ?? layer.text ?? "";
  const lineCount = Math.max(1, countLines(previewText));
  // 【v1.16.0】枠の自動調整 — フォント実描画幅 + per-char サイズ/フォント override で long を再算出。
  // 測定失敗 / 未ロード時は null → ツメ反映後のセル数推定にフォールバック。
  const fontPs = edit.fontPostScriptName ?? layer.font ?? null;
  // 行間 (autoLeadingAmount %) を厚み（行スタック方向）の係数に反映。125% を最低値として
  // 設定しても既存の見た目より細くしないように clamp。
  const leadingFactor = Math.max(1.25, ((edit.leadingPct ?? 125) / 100));

  const sizePt = getExistingLayerEffectiveSizePt(page, layer, edit);
  const ptInPsdPx = sizePt * (dpi / 72);
  // 【v1.x.0】句読点ツメも bbox 幅に反映（、 / 。 の個数 × tsume% × em ぶん長さが縮む）。
  const punctTsumePctExisting = Number(getDefault("punctuationTsumePercent")) || 0;
  // 【v1.x.0】縦中横（!!/!?/！！/！？）も bbox 長軸に反映（TCY ペアごとに 1em 縮む）。
  // 設定 ON かつ縦書きレイヤーのときのみ。
  const tcyEnabledExisting = (getDefault("tateChuYokoEnabled") !== false) && isVertical;
  // 【v1.16.0】measureMaxLineExtentEm はここで sizePt が確定してから呼ぶ（per-char override も反映）。
  const charFontsExisting = edit.charFonts ?? layer.charFonts ?? {};
  const existingCharSizes = { ...(layer.charSizes ?? {}), ...(edit.charSizes ?? {}) };
  const existingCharHorizontalScales = { ...(layer.charHorizontalScales ?? {}), ...(edit.charHorizontalScales ?? {}) };
  const existingCharVerticalScales = { ...(layer.charVerticalScales ?? {}), ...(edit.charVerticalScales ?? {}) };
  const existingHorizontalScale = edit.horizontalScale ?? layer.horizontalScale ?? 100;
  const existingVerticalScale = edit.verticalScale ?? layer.verticalScale ?? 100;
  const measuredEm = measureMaxLineExtentEm(
    previewText, fontPs, sizePt, existingCharSizes, charFontsExisting, punctTsumePctExisting, tcyEnabledExisting,
    isVertical, existingCharHorizontalScales, existingCharVerticalScales, existingHorizontalScale, existingVerticalScale,
  );
  const spacingEmExisting = estimateMaxPositiveSpacingEm(
    previewText,
    edit.trackingMille ?? layer.trackingMille ?? 0,
    edit.kerningMille ?? layer.kerningMille ?? 0,
    { ...(layer.charTrackings ?? {}), ...(edit.charTrackings ?? {}) },
    { ...(layer.charKernings ?? {}), ...(edit.charKernings ?? {}) },
  );
  // 縦書きは content が右端 (block-start) に寄り、box 左端は固定されるため大きな thick safety を
  // 足すと余白が溜まる。ただし 0em だと単位変換後の丸めや実フォントの ink overhang で
  // 文字端が切れるため、縦方向専用のごく小さな保険だけ入れる。
  const THICK_SAFETY = isVertical
    ? TEXT_BBOX_VERTICAL_THICK_SAFETY_EM
    : (lineCount > 1 ? TEXT_BBOX_MULTI_LINE_THICK_SAFETY_EM : TEXT_BBOX_THICK_SAFETY_EM);
  const LONG_SAFETY = TEXT_BBOX_LONG_SAFETY_EM;
  const LONG_SCALE = isVertical ? 1 : TEXT_BBOX_HEURISTIC_LONG_SCALE;
  // 【v1.16.0】行ごとに leading override + per-char サイズ override を反映して厚みを合算。
  // 行 N の override = 行 N-1 と行 N の隙間（marginBlockStart）。行 0 は「前の行」がないので無視。
  // per-char サイズ override がある行はその行の最大文字サイズで line-height をスケール。
  const lineLeadings = edit.lineLeadings ?? {};
  const charSizesMap = { ...(layer.charSizes ?? {}), ...(edit.charSizes ?? {}) };
  const charHorizontalScalesMap = existingCharHorizontalScales;
  const charVerticalScalesMap = existingCharVerticalScales;
  const linesArrE = previewText.split(/\r\n|\r|\n/);
  const lineStartsE = getLineStartOffsets(previewText);
  let thickSum = 0;
  for (let i = 0; i < lineCount; i++) {
    // lineLeadings[N] is the leading of line N, so it opens the gap before line N + 1.
    const v = (i > 0 && Number.isFinite(lineLeadings[i - 1])) ? lineLeadings[i - 1] / 100 : leadingFactor;
    const leading = Math.max(1.25, v);
    let lineMaxRatio = 1;
    const line = linesArrE[i] ?? "";
    const startIdx = lineStartsE[i] ?? 0;
    for (let k = 0; k < line.length; k++) {
      const cs = charSizesMap[startIdx + k];
      const sizeRatio = Number.isFinite(cs) && cs > 0 ? cs / sizePt : 1;
      const hs = Number.isFinite(charHorizontalScalesMap[startIdx + k]) ? charHorizontalScalesMap[startIdx + k] : existingHorizontalScale;
      const vs = Number.isFinite(charVerticalScalesMap[startIdx + k]) ? charVerticalScalesMap[startIdx + k] : existingVerticalScale;
      const ratio = sizeRatio * textAxisScaleRatio(isVertical, hs, vs, "thick");
      if (ratio > lineMaxRatio) lineMaxRatio = ratio;
    }
    thickSum += leading * lineMaxRatio;
  }
  const fallbackThick = ptInPsdPx * (thickSum + THICK_SAFETY);
  // long 軸: 実測 em があればそれ、無ければツメ/縦中横反映後のセル数にフォールバック。
  // CJK 縦書き等はセル数と em がほぼ等価、Latin 系では em < セル数になるので bbox が縮む。
  const heuristicLong = (LONG_SCALE * estimateMaxLineExtentCells(previewText, punctTsumePctExisting, tcyEnabledExisting)) + spacingEmExisting;
  const longChars = Number.isFinite(measuredEm) && measuredEm > heuristicLong ? measuredEm : heuristicLong;
  const fallbackLong = ptInPsdPx * (longChars + LONG_SAFETY);
  const minThick = Math.max(ptInPsdPx * (leadingFactor + THICK_SAFETY), 20);
  const minLong = Math.max(ptInPsdPx * 2, 48);

  let width;
  let height;
  if (isVertical) {
    width = Math.max(rawWidth, fallbackThick, minThick);
    height = Math.max(rawHeight, fallbackLong, minLong);
  } else {
    width = Math.max(rawWidth, fallbackLong, minLong);
    height = Math.max(rawHeight, fallbackThick, minThick);
  }

  const left = left0 + (edit.dx ?? 0);
  const top = top0 + (edit.dy ?? 0);
  return { left, top, right: left + width, bottom: top + height, width, height, isVertical, ptInPsdPx, previewText };
}

export function layerRectForNew(page, nl) {
  const dpi = page.dpi ?? 72;
  const isVertical = nl.direction !== "horizontal";
  const sizePt = nl.sizePt ?? 24;
  const ptInPsdPx = sizePt * (dpi / 72);
  const contents = nl.contents ?? "";
  const lineCount = Math.max(1, countLines(contents));
  // 【v1.x.0】句読点ツメも bbox 幅に反映（、 / 。 の個数 × tsume% × em ぶん長さが縮む）。
  const punctTsumePctNew = Number(getDefault("punctuationTsumePercent")) || 0;
  // 【v1.x.0】縦中横（!!/!?/！！/！？）も bbox 長軸に反映（TCY ペアごとに 1em 縮む）。
  const tcyEnabledNew = (getDefault("tateChuYokoEnabled") !== false) && isVertical;
  // 【v1.16.0】枠の自動調整 — 実描画幅で long を auto-fit（フォント変更 + per-char サイズ/フォント変更で bbox 自動更新）。
  const newHorizontalScale = nl.horizontalScale ?? 100;
  const newVerticalScale = nl.verticalScale ?? 100;
  const measuredEm = measureMaxLineExtentEm(
    contents, nl.fontPostScriptName, sizePt, nl.charSizes, nl.charFonts, punctTsumePctNew, tcyEnabledNew,
    isVertical, nl.charHorizontalScales, nl.charVerticalScales, newHorizontalScale, newVerticalScale,
  );
  const spacingEmNew = estimateMaxPositiveSpacingEm(
    contents,
    nl.trackingMille ?? 0,
    nl.kerningMille ?? 0,
    nl.charTrackings,
    nl.charKernings,
  );
  // 行間 (%) を厚み係数に反映。125 が既定。
  const leadingFactor = (nl.leadingPct ?? 125) / 100;
  // 【v1.16.0】行ごとに leading override + per-char サイズ override を反映して厚みを合算。
  const lineLeadings = nl.lineLeadings ?? {};
  const charSizesMap = nl.charSizes ?? {};
  const charHorizontalScalesMap = nl.charHorizontalScales ?? {};
  const charVerticalScalesMap = nl.charVerticalScales ?? {};
  const linesArrN = contents.split(/\r\n|\r|\n/);
  const lineStartsN = getLineStartOffsets(contents);
  let thickSum = 0;
  for (let i = 0; i < lineCount; i++) {
    // 1 行目の厚みは 1em。leading は「前行から次行への送り」なので 2 行目以降にだけ足す。
    // ここで 1 行目にも 125% を掛けると、縦書きでは余分な幅が box 左側に溜まる。
    const v = i === 0
      ? 1
      : (Number.isFinite(lineLeadings[i - 1]) ? lineLeadings[i - 1] / 100 : leadingFactor);
    let lineMaxRatio = 1;
    const line = linesArrN[i] ?? "";
    const startIdx = lineStartsN[i] ?? 0;
    for (let k = 0; k < line.length; k++) {
      const cs = charSizesMap[startIdx + k];
      const sizeRatio = Number.isFinite(cs) && cs > 0 ? cs / sizePt : 1;
      const hs = Number.isFinite(charHorizontalScalesMap[startIdx + k]) ? charHorizontalScalesMap[startIdx + k] : newHorizontalScale;
      const vs = Number.isFinite(charVerticalScalesMap[startIdx + k]) ? charVerticalScalesMap[startIdx + k] : newVerticalScale;
      const ratio = sizeRatio * textAxisScaleRatio(isVertical, hs, vs, "thick");
      if (ratio > lineMaxRatio) lineMaxRatio = ratio;
    }
    thickSum += v * lineMaxRatio;
  }
  // 縦書き (vertical-rl) は content が block-start = 右端に寄り、box 左端 = nl.x は固定
  // （ドラッグ基準のため scheduleBoxAutoFit も left/top は触らない）。大きな余白は位置ズレに
  // 見えるが、0em ではサイズ単位変換後の丸めで文字が切れるため最小限の保険を残す。
  // 【写植再利用】reuseTightThick=true のレイヤーは厚み方向の安全余白を 0 にして、枠を
  // 実テキスト列幅ぴったりに詰める（複数列で左側に余白＝右ずれに見える問題を解消）。
  const thickSafety = nl.reuseTightThick === true
    ? 0
    : (isVertical ? TEXT_BBOX_VERTICAL_THICK_SAFETY_EM : (lineCount > 1 ? TEXT_BBOX_MULTI_LINE_THICK_SAFETY_EM : TEXT_BBOX_THICK_SAFETY_EM));
  const longSafety = isVertical ? 0 : TEXT_BBOX_LONG_SAFETY_EM;
  const longScale = isVertical ? 1 : TEXT_BBOX_HEURISTIC_LONG_SCALE;
  const minThick = nl.reuseTightThick === true ? Math.max(1, ptInPsdPx) : 24;
  const thick = Math.max(minThick, ptInPsdPx * (thickSum + thickSafety));
  const heuristicLong = (longScale * estimateMaxLineExtentCells(contents, punctTsumePctNew, tcyEnabledNew)) + spacingEmNew;
  const longChars = Number.isFinite(measuredEm) && measuredEm > heuristicLong ? measuredEm : heuristicLong;
  const hasContent = String(contents ?? "").length > 0;
  const minLongPx = isVertical && hasContent ? ptInPsdPx : ptInPsdPx * 2;
  const longRaw = Math.max(minLongPx, ptInPsdPx * (longChars + longSafety));
  const maxLong = isVertical ? page.height * 0.95 : page.width * 0.95;
  const long = Math.min(longRaw, maxLong);
  const sourceBounds = reuseSourceBoundsForNewLayer(nl, sizePt);
  const width = sourceBounds ? sourceBounds.width : (isVertical ? thick : long);
  const height = sourceBounds ? sourceBounds.height : (isVertical ? long : thick);
  // 実テキストの描画寸法（PSD px）。枠は安全余白で大きめに出るので、中心合わせ用に
  // 「実テキスト長（長軸）= measureText 由来 measuredEm」「実テキスト厚み = thickSum」を別途返す。
  const textLongPx = (Number.isFinite(measuredEm) && measuredEm > 0 ? measuredEm : longChars) * ptInPsdPx;
  const textThickPx = thickSum * ptInPsdPx;
  return {
    left: nl.x, top: nl.y, right: nl.x + width, bottom: nl.y + height,
    width, height, isVertical, ptInPsdPx, textLongPx, textThickPx,
  };
}

function rectsIntersect(a, b) {
  return !(b.left >= a.right || b.right <= a.left || b.top >= a.bottom || b.bottom <= a.top);
}

const HEX_FILL_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function cssFillColor(fillColor) {
  if (fillColor === "white") return "#fff";
  if (fillColor === "black") return "#000";
  if (typeof fillColor === "string" && HEX_FILL_COLOR_RE.test(fillColor)) return fillColor;
  return "";
}

// fillColor === "default" はプレビュー上も編集前の表示を維持するため何も設定しない。
// white/black/HEX のときだけ CSS color を上書きする。
function applyFillPreview(inner, fillColor) {
  inner.classList.add("text-preview-no-white-shadow");
  const color = cssFillColor(fillColor);
  if (color) inner.style.color = color;
}

// 白フチ／黒フチを round-join で表示するための text-shadow ダイレーション。
// -webkit-text-stroke は Chromium 仕様で miter join 固定 → 明朝の起筆や
// 「ー」「！」等の鋭角端で角スパイクが出る。SVG filter (feGaussianBlur+threshold)
// 案は色補間 / 閾値の挙動が環境依存で安定しないので採用しない。
// 円周方向に文字のコピーを並べると union が disk 構造化要素との Minkowski sum
// （= 数学的に round-join dilation）となり、Photoshop の Stroke Effect
// (outsetFrame) と同等の絵が確実に得られる。
//
// w (screen px) ごとに方向数と stop 数を調整しキャッシュする。
const strokeShadowCache = new Map();
function buildRoundStrokeShadows(w, color) {
  // 0.5px 単位で量子化（視覚差なし）してキャッシュキーを安定化。
  const ww = Math.max(0.5, Math.round(w * 2) / 2);
  const key = `${ww}|${color}`;
  const hit = strokeShadowCache.get(key);
  if (hit) return hit;

  // 方向数 N: w が大きいほど密に。disk 境界のサンプリング密度。
  const N = ww <= 1.5 ? 12 : ww <= 4 ? 16 : ww <= 10 ? 24 : 32;
  // 半径 stop: disk 内部を塗りつぶし、stair-step が見えない粒度（0.6px 刻み）。
  const stopStep = 0.6;
  const stops = [];
  for (let r = stopStep; r <= ww + 1e-3; r += stopStep) stops.push(r);
  if (stops.length === 0 || stops[stops.length - 1] < ww - 1e-3) stops.push(ww);

  const parts = new Array(N * stops.length);
  let p = 0;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const cx = Math.cos(a);
    const sy = Math.sin(a);
    for (let s = 0; s < stops.length; s++) {
      const r = stops[s];
      parts[p++] = `${(cx * r).toFixed(2)}px ${(sy * r).toFixed(2)}px 0 ${color}`;
    }
  }
  const out = parts.join(", ");
  strokeShadowCache.set(key, out);
  return out;
}

function appendStrokePreviewUnderlay(box, inner, strokeColor, strokeWidthPx, pxPerPsd) {
  if (!box || !inner || !strokeColor || strokeColor === "none" || !(strokeWidthPx > 0) || !(pxPerPsd > 0)) return;
  const cssColor = strokeColor === "white" ? "#fff" : "#000";
  // PSD px → screen px。最低 0.5px で可視性確保。
  const w = Math.max(0.5, strokeWidthPx * pxPerPsd);
  const underlay = inner.cloneNode(true);
  underlay.classList.add("stroke-preview-underlay");
  underlay.setAttribute("aria-hidden", "true");
  underlay.style.webkitTextStroke = "0";
  underlay.style.color = cssColor;
  underlay.style.textShadow = buildRoundStrokeShadows(w, cssColor);
  // SVG filter 経路で残っていた可能性のある filter を確実に解除。
  underlay.style.filter = "";
  inner.classList.add("stroke-preview-fill");
  box.appendChild(underlay);
}

function applyEditableStrokePreview(inner, strokeColor, strokeWidthPx, pxPerPsd) {
  if (!inner) return;
  inner.style.textShadow = "";
  if (!strokeColor || strokeColor === "none" || !(strokeWidthPx > 0) || !(pxPerPsd > 0)) return;
  const cssColor = strokeColor === "white" ? "#fff" : "#000";
  const w = Math.max(0.5, strokeWidthPx * pxPerPsd);
  inner.style.webkitTextStroke = "0";
  inner.style.textShadow = buildRoundStrokeShadows(w, cssColor);
}

function renderOverlay(ctx) {
  const { overlay, page, pageIndex } = ctx;
  // 【v1.21.0】編集中 (.editing) のレイヤーは contenteditable のキャレット・選択範囲を
  // 持っているので破壊しない（再構築するとキャレット消失 + selectionchange が走って
  // editingContext が壊れる）。マーキー矩形は marqueeState の復元コードが drawMarquee() で再描画する。
  // 【v1.16.0】innerHTML = "" を撤廃し layer-box / marquee-rect だけ削除する。
  for (const el of overlay.querySelectorAll(".layer-box, .marquee-rect")) {
    if (el.classList.contains("editing")) continue;
    el.remove();
  }

  // 編集中レイヤーがあればその layerKey を控えておき、下のループで二重生成を回避する。
  const editingExistingId = (() => {
    const el = overlay.querySelector(".layer-box-existing.editing");
    return el ? Number(el.dataset.layerId) : null;
  })();
  const editingNewTempId = (() => {
    const el = overlay.querySelector(".layer-box-new.editing");
    return el ? el.dataset.tempId : null;
  })();

  const pxPerPsd = ctx.canvas.clientWidth > 0 ? ctx.canvas.clientWidth / page.width : 0;
  // 複数選択 (2 件以上) の判定。.multi-selected クラスで CSS 側が水色点線 + 青バッジに切替える。
  const isMultiSelect = getSelectedLayers().length > 1;
  // 方眼/中心点表示は文字とプロパティバッジを隠すため、複数選択では一時的に通常表示へ戻す。
  const effectiveSelectionCenterOnlyMode = selectionCenterOnlyMode && !isMultiSelect;
  const effectiveSelectionGridMode = selectionGridMode && !isMultiSelect;
  const hasTemporaryMultiAdornments = userHiddenLayerBadges
    && temporaryMultiSelectionAdornmentsVisible
    && getSelectedLayers().length > 1;
  const showSizeOnlyBadges = temporarySizeOnlyBadgesVisible && getSelectedLayers().length > 0;
  const showSelectionAdornments = selectionAdornmentsVisible || hasTemporaryMultiAdornments || showSizeOnlyBadges;
  overlay.classList.toggle("selection-adornments-hidden", !showSelectionAdornments);
  overlay.classList.toggle("selection-size-only-properties", showSizeOnlyBadges);
  overlay.classList.toggle("selection-center-only", effectiveSelectionCenterOnlyMode);
  overlay.classList.toggle("selection-grid-display", effectiveSelectionGridMode);

  for (const layer of page.textLayers) {
    // 編集中レイヤーは既存 DOM を温存（contenteditable キャレットを破壊しない）
    if (editingExistingId !== null && layer.id === editingExistingId) continue;
    const edit = getEdit(page.path, layer.id) ?? {};
    if (edit.deleted === true) continue;
    const rect = layerRectForExisting(page, layer, edit);
    const rotation = edit.rotation ?? 0;
    const box = createBox(page, rect.left, rect.top, rect.width, rect.height, "existing");
    box.dataset.layerId = String(layer.id);
    box.dataset.direction = rect.isVertical ? "vertical" : "horizontal";
    applyLayerBoxRotation(box, rotation);
    box.title = rect.previewText.length > 60 ? rect.previewText.slice(0, 60) + "…" : rect.previewText;

    const inner = document.createElement("div");
    inner.className = "existing-layer-text";
    if (pxPerPsd > 0) {
      inner.style.fontSize = `${rect.ptInPsdPx * pxPerPsd}px`;
    }
    // 行間：edit.leadingPct があれば反映、なければ既定 1.05（既存表示と整合）。
    // tracking は既存レイヤーには適用しない（PS 側に書き戻さない方針と整合させ、保存後の見た目とプレビューを一致させる）。
    // tcy（縦中横）は「見た目の確認」用途で縦書きの既存レイヤープレビューにも反映する（PS 側の実値とは独立）。
    const defaultLeadPct = Number.isFinite(edit.leadingPct) ? edit.leadingPct : 105;
    const tcyEnabled = getDefault("tateChuYokoEnabled") !== false;
    // 【v1.22.0】記号フォント置換（♡♥★☆♪ 等）。新規 + 既存両方に適用、ユーザー手動指定は尊重。
    const symbolReplaceOn = getDefault("symbolFontReplaceEnabled") !== false;
    const symbolFontPS = symbolReplaceOn ? String(getDefault("symbolFontPostScriptName") || "") : "";
    if (symbolFontPS) ensureFontLoaded(symbolFontPS);
    // 【v1.x.0】句読点ツメ（、 / 。 を mojiZume N% で詰める）。新規 + 既存両方の preview に反映。
    const punctTsumePct = Number(getDefault("punctuationTsumePercent")) || 0;
    // 【v1.16.0】per-char サイズ/フォント override + sizePt を渡して per-line bbox / 文字描画を反映。
    const existingSizePt = getExistingLayerEffectiveSizePt(page, layer, edit);
    renderInnerText(
      inner, rect.previewText, defaultLeadPct, edit.lineLeadings, 0, 0,
      tcyEnabled && rect.isVertical,
      rect.isVertical,
      { ...(layer.charSizes ?? {}), ...(edit.charSizes ?? {}) }, existingSizePt, edit.charFonts ?? layer.charFonts,
      symbolFontPS,
      edit.charBolds,
      edit.charItalics,
      punctTsumePct,
      edit.charRubies,
      { ...(layer.charHorizontalScales ?? {}), ...(edit.charHorizontalScales ?? {}) },
      { ...(layer.charVerticalScales ?? {}), ...(edit.charVerticalScales ?? {}) },
      edit.trackingMille ?? layer.trackingMille ?? 0,
      edit.kerningMille ?? layer.kerningMille ?? 0,
      { ...(layer.charTrackings ?? {}), ...(edit.charTrackings ?? {}) },
      { ...(layer.charKernings ?? {}), ...(edit.charKernings ?? {}) },
      { ...(layer.charTateChuYokos ?? {}), ...(edit.charTateChuYokos ?? {}) },
      { ...(layer.charFillColors ?? {}), ...(edit.charFillColors ?? {}) },
      edit.horizontalScale ?? layer.horizontalScale ?? 100,
      edit.verticalScale ?? layer.verticalScale ?? 100,
    );
    const existingPs = edit.fontPostScriptName ?? layer.font;
    const existingFontCss = cssFontFamily(existingPs);
    if (existingFontCss) inner.style.fontFamily = existingFontCss;
    ensureFontLoaded(existingPs);
    // 【v1.22.0】layer 全体の合成太字（faux bold）。per-char (charBolds) があれば
    // span が override する。
    if (edit.syntheticBold === true) inner.style.fontWeight = "700";
    if (edit.syntheticItalic === true) inner.style.fontStyle = "italic";
    applyFillPreview(inner, edit.fillColor ?? layer.fillColor ?? "default");
    box.appendChild(inner);
    appendStrokePreviewUnderlay(
      box,
      inner,
      edit.strokeColor ?? layer.strokeColor ?? "none",
      edit.strokeWidthPx ?? layer.strokeWidthPx ?? 20,
      pxPerPsd,
    );

    if (isLayerSelected(pageIndex, layer.id)) {
      box.classList.add("selected");
      if (isMultiSelect) box.classList.add("multi-selected");
      if (effectiveSelectionGridMode) buildGridCells(box, rect.previewText, rect.isVertical, page, rect);
      if (!showSizeOnlyBadges && showSelectionAdornments && rotateHandlesVisible) box.appendChild(createRotateHandle(ctx, layer.id));
      // バッジは bounds 逆算後の実効 pt（layerRectForExisting が rect.ptInPsdPx に反映済み）を表示。
      // 環境設定でフォント/サイズ両方とも非表示の場合 createSizeBadge は null を返す。
      if (showSizeOnlyBadges || (showSelectionAdornments && !hideSelectedLayerBadges && (!userHiddenLayerBadges || hasTemporaryMultiAdornments))) {
        const effectivePt = edit.sizePt ?? (rect.ptInPsdPx * 72 / (page.dpi ?? 72));
        const charSizes = { ...(layer.charSizes ?? {}), ...(edit.charSizes ?? {}) };
        const charFontsMerged = { ...(layer.charFonts ?? {}), ...(edit.charFonts ?? {}) };
        const symbolReplaceOnExisting = getDefault("symbolFontReplaceEnabled") !== false;
        const symbolFontPSExisting = symbolReplaceOnExisting ? String(getDefault("symbolFontPostScriptName") || "") : "";
        const layerContentsExisting = edit.contents ?? layer.contents ?? "";
        const fontList = collectLayerFontValues(
          edit.fontPostScriptName ?? layer.font ?? null,
          charFontsMerged,
          layerContentsExisting,
          symbolFontPSExisting,
        );
        const badge = createSizeBadge(
          collectLayerSizeValues(effectivePt, charSizes),
          page,
          fontList,
          edit.strokeColor ?? layer.strokeColor ?? "none",
          edit.strokeWidthPx ?? layer.strokeWidthPx ?? 20,
          {
            forceVisible: showSizeOnlyBadges,
            sizeOnly: showSizeOnlyBadges,
            rubyRemove: showSizeOnlyBadges ? null : {
              psdPath: page.path,
              layerId: layer.id,
              hasRuby: Object.keys(edit.charRubies ?? layer.charRubies ?? {}).length > 0,
            },
          },
        );
        if (badge) box.appendChild(badge);
      }
    }
    bindHoverSelect(box, ctx, layer.id);
    box.addEventListener("mousedown", (e) => onExistingLayerMouseDown(e, ctx, layer));
    box.addEventListener("wheel", (e) => onLayerWheel(e, ctx, layer.id), { passive: false });
    overlay.appendChild(box);
  }

  for (const nl of getNewLayersForPsd(page.path)) {
    // 編集中レイヤーは既存 DOM を温存（contenteditable キャレットを破壊しない）
    if (editingNewTempId !== null && nl.tempId === editingNewTempId) continue;
    const rect = layerRectForNew(page, nl);
    const rotation = nl.rotation ?? 0;
    const box = createBox(page, rect.left, rect.top, rect.width, rect.height, "new");
    box.dataset.tempId = nl.tempId;
    box.dataset.direction = rect.isVertical ? "vertical" : "horizontal";
    applyLayerBoxRotation(box, rotation);
    box.classList.add("text-box-preview");
    // 【写植再利用】詰め枠は明示サイズ・明示位置なので autofit（はみ出し検知で枠を広げる）対象外にする。
    // autofit が白フチのにじみ等を含めて右へ広げ、右アンカーの縦書きテキストが右へずれるのを防ぐ。
    if (nl.reuseTightThick === true) box.classList.add("layer-box-reuse-tight");
    // 【v1.26.0 移植 (PsDesign-main v1.24.0)】自動配置で背景/ウニ判定によりフォント切替された印
    // (UI 色強調用)。bucket = 0..5 の 10% 刻みでスコア帯ごとに別色 (青→緑→黄→橙→赤→濃赤)。
    if (nl.autoFontSwitched) {
      box.classList.add("auto-font-switched");
      if (Number.isInteger(nl.autoFontSwitchBucket) && nl.autoFontSwitchBucket >= 0) {
        box.classList.add(`auto-font-bucket-${nl.autoFontSwitchBucket}`);
      }
    }
    const inner = document.createElement("div");
    inner.className = "new-layer-text";
    if (pxPerPsd > 0) {
      inner.style.fontSize = `${rect.ptInPsdPx * pxPerPsd}px`;
    }
    // 新規レイヤーには環境設定の連続記号ツメ（dash/tilde グループ別）を適用。PS 保存にも同じ値を書き戻す。
    // tcy（縦中横）も新規かつ縦書きレイヤーに適用、PS 保存でも textStyleRange の tcy 属性を立てる。
    const dashMille = Number(getDefault("dashRunTrackingMille")) || 0;
    const tildeMille = Number(getDefault("tildeRunKerningMille")) || 0;
    const tcyEnabledNew = getDefault("tateChuYokoEnabled") !== false;
    // 【v1.22.0】記号フォント置換（♡♥★☆♪ 等）。新規 + 既存両方に適用、ユーザー手動指定は尊重。
    const symbolReplaceOnNew = getDefault("symbolFontReplaceEnabled") !== false;
    const symbolFontPSNew = symbolReplaceOnNew ? String(getDefault("symbolFontPostScriptName") || "") : "";
    if (symbolFontPSNew) ensureFontLoaded(symbolFontPSNew);
    // 【v1.x.0】句読点ツメ（、 / 。 を mojiZume N% で詰める）。新規 + 既存両方の preview に反映。
    const punctTsumePctNew = Number(getDefault("punctuationTsumePercent")) || 0;
    // 【v1.16.0】per-char サイズ/フォント override + sizePt を渡して per-line bbox / 文字描画を反映。
    renderInnerText(
      inner, nl.contents, nl.leadingPct ?? 125, nl.lineLeadings, dashMille, tildeMille,
      tcyEnabledNew && rect.isVertical,
      rect.isVertical,
      nl.charSizes, nl.sizePt ?? 24, nl.charFonts,
      symbolFontPSNew,
      nl.charBolds,
      nl.charItalics,
      punctTsumePctNew,
      nl.charRubies,
      nl.charHorizontalScales,
      nl.charVerticalScales,
      nl.trackingMille ?? 0,
      nl.kerningMille ?? 0,
      nl.charTrackings,
      nl.charKernings,
      nl.charTateChuYokos,
      nl.charFillColors,
      nl.horizontalScale ?? 100,
      nl.verticalScale ?? 100,
    );
    if (rect.isVertical && nl.reuseTightThick === true && countLines(nl.contents ?? "") <= 1) {
      inner.style.lineHeight = "1";
    }
    const newFontCss = cssFontFamily(nl.fontPostScriptName);
    if (newFontCss) inner.style.fontFamily = newFontCss;
    ensureFontLoaded(nl.fontPostScriptName);
    // 【v1.22.0】layer 全体の合成太字。
    if (nl.syntheticBold === true) inner.style.fontWeight = "700";
    if (nl.syntheticItalic === true) inner.style.fontStyle = "italic";
    applyFillPreview(inner, nl.fillColor ?? "default");
    box.appendChild(inner);
    appendStrokePreviewUnderlay(
      box,
      inner,
      nl.strokeColor ?? "none",
      nl.strokeWidthPx ?? 20,
      pxPerPsd,
    );
    if (isLayerSelected(pageIndex, nl.tempId)) {
      box.classList.add("selected");
      if (isMultiSelect) box.classList.add("multi-selected");
      // layerRectForNew は previewText を返さないため、新規レイヤーは nl.contents を渡す。
      if (effectiveSelectionGridMode) buildGridCells(box, nl.contents, rect.isVertical, page, rect);
      if (!showSizeOnlyBadges && showSelectionAdornments && rotateHandlesVisible) box.appendChild(createRotateHandle(ctx, nl.tempId));
      if (showSizeOnlyBadges || (showSelectionAdornments && !hideSelectedLayerBadges && (!userHiddenLayerBadges || hasTemporaryMultiAdornments))) {
        const fontListNew = collectLayerFontValues(
          nl.fontPostScriptName ?? null,
          nl.charFonts ?? {},
          nl.contents ?? "",
          symbolFontPSNew,
        );
        const newBadge = createSizeBadge(
          collectLayerSizeValues(nl.sizePt ?? 24, nl.charSizes),
          page,
          fontListNew,
          nl.strokeColor ?? "none",
          nl.strokeWidthPx ?? 20,
          {
            forceVisible: showSizeOnlyBadges,
            sizeOnly: showSizeOnlyBadges,
            rubyRemove: showSizeOnlyBadges ? null : {
              psdPath: page.path,
              tempId: nl.tempId,
              hasRuby: Object.keys(nl.charRubies ?? {}).length > 0,
            },
          },
        );
        if (newBadge) box.appendChild(newBadge);
      }
    }
    bindHoverSelect(box, ctx, nl.tempId);
    box.addEventListener("mousedown", (e) => onNewLayerMouseDown(e, ctx, nl));
    box.addEventListener("wheel", (e) => onLayerWheel(e, ctx, nl.tempId), { passive: false });
    overlay.appendChild(box);
  }

  // マーキー矩形を復元（ドラッグ中に renderOverlay が走った場合に消えないように）
  if (marqueeState && marqueeState.ctx === ctx) drawMarquee();

  // 【v1.16.0】枠の自動調整（後置の保険）— 実描画後に各 box の inner overflow を検査して、
  // もし内容が box を超えているなら box を伸ばす（フォント/per-char サイズ変更で
  // measureText の予測がズレた際の最終フォールバック）。
  scheduleBoxAutoFit(ctx);
  scheduleVerticalSingleLineAnchor(ctx);

  // 【v1.x.0】複数選択時のバッジ重なり解決。近接する選択フレームの青バッジ同士が
  // 縦に重なるケースがあるため、後で重なりを検出して該当バッジを上向き反転する。
  scheduleBadgeOverlapResolution(ctx);

  // ルビを、属する行と前の行の実測中点へ配置してから PSD 座標で state に書き戻す。
  // これにより Photoshop 保存時 (jsx_gen.rs createRubyLayer) が「ビューアーで見えている位置」を
  // そのまま使え、CSS/JSX の計算ズレが排除される。rAF で layout 確定後に測定する。
  scheduleRubyOffsetMeasure(ctx);
}

function rubyFallbackAdvancePx(box, rt) {
  const rootStyle = getComputedStyle(document.documentElement);
  const pct = Number(rootStyle.getPropertyValue("--ruby-row-leading-pct")) || Number(getDefault("rubyLeadingPct")) || 150;
  const wrap = rt?.closest?.(".ruby-wrap");
  const base = wrap?.querySelector?.(".ruby-base");
  const basis = base || wrap || rt;
  const st = basis ? getComputedStyle(basis) : null;
  const fontPx = st ? Number.parseFloat(st.fontSize) : 0;
  const boxStyle = box ? getComputedStyle(box) : null;
  const boxFontPx = boxStyle ? Number.parseFloat(boxStyle.fontSize) : 0;
  const px = Number.isFinite(fontPx) && fontPx > 0 ? fontPx : boxFontPx;
  return (Number.isFinite(px) && px > 0 ? px : 16) * (pct / 100);
}

function centerOfRect(rect) {
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
}

function isParentMarkRubyElement(rt) {
  return rt?.classList?.contains("ruby-text-nakaguro")
    || rt?.classList?.contains("ruby-text-overlay-same-position");
}

function isFixedSideRubyElement(rt) {
  return isParentMarkRubyElement(rt)
    || rt?.classList?.contains("ruby-text-first-line");
}

function resetRubyTextInlinePosition(rt) {
  if (!rt) return;
  rt.style.left = "";
  rt.style.top = "";
  rt.style.bottom = "";
  rt.style.transform = "";
}

function layoutRectWithoutRuby(element) {
  if (!element?.getBoundingClientRect) return null;
  const rubyTexts = Array.from(element.querySelectorAll?.(".ruby-text") ?? []);
  const prevDisplays = rubyTexts.map((rt) => rt.style.display);
  try {
    for (const rt of rubyTexts) rt.style.display = "none";
    const rect = element.getBoundingClientRect();
    return rect && rect.width > 0 && rect.height > 0 ? rect : null;
  } finally {
    rubyTexts.forEach((rt, i) => { rt.style.display = prevDisplays[i]; });
  }
}

function rubyBaseRect(wrap) {
  const base = wrap?.querySelector?.(":scope > .ruby-base");
  const rect = layoutRectWithoutRuby(base || wrap) || (base || wrap)?.getBoundingClientRect?.();
  return rect && rect.width > 0 && rect.height > 0 ? rect : null;
}

function rubyPlacementBaseRect(wrap, box, vertical) {
  const baseRect = rubyBaseRect(wrap);
  if (!baseRect) return null;
  const lineEl = lineElementForRubyWrap(wrap, box);
  const lineRect = layoutRectWithoutRuby(lineEl);
  if (lineRect) {
    if (vertical) {
      return {
        left: lineRect.left,
        right: lineRect.right,
        top: baseRect.top,
        bottom: baseRect.bottom,
        width: lineRect.width,
        height: baseRect.height,
      };
    }
    return {
      left: baseRect.left,
      right: baseRect.right,
      top: lineRect.top,
      bottom: lineRect.bottom,
      width: baseRect.width,
      height: lineRect.height,
    };
  }
  const rt = wrap.querySelector(".ruby-text");
  if (!rt) return baseRect;
  const rubyPct = Number(getDefault("rubyLeadingPct")) || 150;
  const layerPct = Number(getDefault("leadingPct")) || 125;
  const fontPx = rubyPct > 0 ? rubyFallbackAdvancePx(box, rt) / (rubyPct / 100) : 0;
  if (fontPx <= 0) return baseRect;
  const lineWidth = fontPx * (layerPct / 100);
  const rightExtra = fontPx * 0.075;
  const leftExtra = Math.max(0, lineWidth - baseRect.width - rightExtra);
  if (vertical) {
    return {
      left: baseRect.left - leftExtra,
      right: baseRect.right + rightExtra,
      top: baseRect.top,
      bottom: baseRect.bottom,
      width: lineWidth,
      height: baseRect.height,
    };
  }
  return {
    left: baseRect.left,
    right: baseRect.right,
    top: baseRect.top - leftExtra,
    bottom: baseRect.bottom + rightExtra,
    width: baseRect.width,
    height: lineWidth,
  };
}

function lineRangesForEditableText(text) {
  const full = String(text ?? "");
  const ranges = [];
  const re = /\r\n|\r|\n/g;
  let start = 0;
  let m;
  while ((m = re.exec(full)) !== null) {
    ranges.push({ start, end: m.index });
    start = m.index + m[0].length;
  }
  ranges.push({ start, end: full.length });
  return ranges;
}

function lineIndexForEditableOffset(ranges, index) {
  const idx = Math.max(0, Number(index) || 0);
  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i];
    const next = ranges[i + 1];
    if (idx >= range.start && (!next || idx < next.start)) return i;
  }
  return Math.max(0, ranges.length - 1);
}

function textRangeRectWithoutRuby(rootEl, start, end) {
  if (!rootEl || end <= start) return null;
  const startPos = charIndexToNodeOffset(rootEl, start);
  const endPos = charIndexToNodeOffset(rootEl, end);
  if (!startPos || !endPos) return null;
  const rubyTexts = Array.from(rootEl.querySelectorAll?.(".ruby-text") ?? []);
  const prevDisplays = rubyTexts.map((rt) => rt.style.display);
  let range = null;
  try {
    for (const rt of rubyTexts) rt.style.display = "none";
    range = document.createRange();
    range.setStart(startPos.node, startPos.offset);
    range.setEnd(endPos.node, endPos.offset);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5);
    if (rects.length === 0) return null;
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const rect of rects) {
      if (rect.left < left) left = rect.left;
      if (rect.top < top) top = rect.top;
      if (rect.right > right) right = rect.right;
      if (rect.bottom > bottom) bottom = rect.bottom;
    }
    if (!Number.isFinite(left) || !Number.isFinite(top) || right <= left || bottom <= top) return null;
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  } catch (_) {
    return null;
  } finally {
    rubyTexts.forEach((rt, i) => { rt.style.display = prevDisplays[i]; });
    try { range?.detach?.(); } catch (_) {}
  }
}

function previousEditableLineRectForRubyWrap(wrap, box) {
  const inner = box?.querySelector?.(".new-layer-text:not(.stroke-preview-underlay), .existing-layer-text:not(.stroke-preview-underlay)");
  if (!inner) return null;
  const start = Number(wrap?.dataset?.rubyStart);
  if (!Number.isInteger(start)) return null;
  const text = serializeEditableText(inner);
  const ranges = lineRangesForEditableText(text);
  if (ranges.length <= 1) return null;
  const lineIndex = lineIndexForEditableOffset(ranges, start);
  if (lineIndex <= 0) return null;
  const prev = ranges[lineIndex - 1];
  return textRangeRectWithoutRuby(inner, prev.start, prev.end);
}

function screenPointToPsd(canvasRect, page, screenX, screenY) {
  const rotation = getPsdRotation();
  const rotated90 = rotation === 90 || rotation === 270;
  const visualW = rotated90 ? canvasRect.height : canvasRect.width;
  const visualH = rotated90 ? canvasRect.width : canvasRect.height;
  const cx = canvasRect.left + canvasRect.width / 2;
  const cy = canvasRect.top + canvasRect.height / 2;
  const { dx: dxLocal, dy: dyLocal } = inverseRotateDelta(screenX - cx, screenY - cy, rotation);
  const scaleX = page.width / visualW;
  const scaleY = page.height / visualH;
  return {
    x: (visualW / 2 + dxLocal) * scaleX,
    y: (visualH / 2 + dyLocal) * scaleY,
  };
}

function lineElementForRubyWrap(wrap, box) {
  const parent = wrap?.parentElement;
  if (!parent || parent === box) return null;
  const inner = box?.querySelector?.(".new-layer-text:not(.stroke-preview-underlay), .existing-layer-text:not(.stroke-preview-underlay)");
  if (parent === inner) return null;
  return parent instanceof HTMLElement ? parent : null;
}

function rectsOverlapOnCrossAxis(a, b, vertical) {
  if (vertical) {
    const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return overlap > Math.min(a.height, b.height) * 0.2;
  }
  const overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  return overlap > Math.min(a.width, b.width) * 0.2;
}

function findNeighborLineRect(overlay, box, wrap, baseRect, vertical) {
  const previousLineRect = previousEditableLineRectForRubyWrap(wrap, box);
  if (previousLineRect) return previousLineRect;

  const wrapCenter = centerOfRect(baseRect);
  let best = null;
  const candidates = [];
  const inner = box?.querySelector?.(".new-layer-text:not(.stroke-preview-underlay), .existing-layer-text:not(.stroke-preview-underlay)");
  if (!inner) return null;
  const lineChildren = Array.from(inner.children).filter((el) => el instanceof HTMLElement && isEditableLineBlock(el));
  if (lineChildren.length > 0) {
    for (const child of lineChildren) candidates.push(child);
  } else {
    return null;
  }
  for (const el of candidates) {
    if (el.contains(wrap)) continue;
    const rect = layoutRectWithoutRuby(el) || el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (!rectsOverlapOnCrossAxis(baseRect, rect, vertical)) continue;
    const center = centerOfRect(rect);
    // vertical-rl の「前の行」は右側。横書きは上側。
    const forward = vertical ? center.x > wrapCenter.x : center.y < wrapCenter.y;
    if (!forward) continue;
    const distance = vertical ? (center.x - wrapCenter.x) : (wrapCenter.y - center.y);
    if (distance <= 0) continue;
    if (!best || distance < best.distance) best = { rect, distance };
  }
  return best?.rect ?? null;
}

function placeRubyAtLineMidpointsForOverlay(overlay, options = {}) {
  if (!overlay) return;
  const towardParentRatio = Number.isFinite(Number(options.towardParentRatio))
    ? Number(options.towardParentRatio)
    : RUBY_TOWARD_PARENT_RATIO;
  const boxes = overlay.querySelectorAll(".layer-box");
  for (const box of boxes) {
    const vertical = box.dataset.direction === "vertical";
    const wraps = box.querySelectorAll(".ruby-wrap");
    for (const wrap of wraps) {
      const rt = wrap.querySelector(".ruby-text");
      if (!rt) continue;
      if (isFixedSideRubyElement(rt)) {
        resetRubyTextInlinePosition(rt);
        continue;
      }
      const anchorRect = rubyBaseRect(wrap);
      const baseRect = rubyPlacementBaseRect(wrap, box, vertical);
      if (!anchorRect || !baseRect) continue;
      const anchorCenter = centerOfRect(anchorRect);
      const baseCenter = centerOfRect(baseRect);
      let targetX = baseCenter.x;
      let targetY = baseCenter.y;
      let neighbor = findNeighborLineRect(overlay, box, wrap, baseRect, vertical);
      if (!neighbor) {
        resetRubyTextInlinePosition(rt);
        continue;
      }
      if (vertical) {
        const middleX = (baseRect.right + neighbor.left) / 2;
        targetX = middleX + (baseRect.right - middleX) * towardParentRatio;
        targetY = baseCenter.y;
      } else {
        targetX = baseCenter.x;
        const middleY = (baseRect.top + neighbor.bottom) / 2;
        targetY = middleY + (baseRect.top - middleY) * towardParentRatio;
      }
      const dx = targetX - anchorCenter.x;
      const dy = targetY - anchorCenter.y;
      rt.style.left = "50%";
      rt.style.top = "50%";
      rt.style.bottom = "auto";
      rt.style.transform = `translate(calc(-50% + ${dx.toFixed(3)}px), calc(-50% + ${dy.toFixed(3)}px))`;
    }
  }
}

function uiTextBasisRectForBox(box) {
  const inner = box?.querySelector?.(".new-layer-text:not(.stroke-preview-underlay), .existing-layer-text:not(.stroke-preview-underlay)");
  if (!inner) return box?.getBoundingClientRect?.() ?? null;
  const rect = inner.getBoundingClientRect();
  const st = getComputedStyle(inner);
  const pl = Number.parseFloat(st.paddingLeft) || 0;
  const pr = Number.parseFloat(st.paddingRight) || 0;
  const pt = Number.parseFloat(st.paddingTop) || 0;
  const pb = Number.parseFloat(st.paddingBottom) || 0;
  return {
    left: rect.left + pl,
    top: rect.top + pt,
    right: rect.right - pr,
    bottom: rect.bottom - pb,
    width: Math.max(0, rect.width - pl - pr),
    height: Math.max(0, rect.height - pt - pb),
  };
}

// 【写植再利用】再生成テキストの中心を、元レイヤーの bbox 中心に合わせる（決定論的）。
// targets: [{ psdPath, tempId, cx, cy }]（cx/cy = 元レイヤー bbox 中心の PSD px）。
// pages: 全ページ配列。フォントロード完了後（measureText 確定）に呼ぶ。DOM 非依存・全ページ一括。
//
// .new-layer-text は padding なし・始端アンカー。実テキスト寸法（textLongPx/textThickPx）で中央に置く:
//   - 厚み軸（横=Y / 縦=X）: textThickPx を中央配置（横=上アンカー / 縦 vertical-rl=右アンカー）。
//   - 長軸: textLongPx を中央配置（始端アンカー）。
// ※注: DOM 測定（uiTextBasisRectForBox）は内側要素＝枠を測ってしまい実グリフではないため使わない。
export function alignReuseLayersToSourceCenters(targets, pages) {
  if (!Array.isArray(targets) || targets.length === 0) return 0;
  const pageByPath = new Map();
  for (const p of (Array.isArray(pages) ? pages : [])) {
    if (p && p.path) pageByPath.set(p.path, p);
  }
  let moved = 0;
  for (const t of targets) {
    if (!t || !Number.isFinite(t.cx) || !Number.isFinite(t.cy)) continue;
    const page = pageByPath.get(t.psdPath);
    if (!page) continue;
    const nl = getNewLayersForPsd(t.psdPath).find((l) => l.tempId === t.tempId);
    if (!nl) continue;
    const rect = layerRectForNew(page, nl);
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) continue;
    const longPx = Number.isFinite(rect.textLongPx) && rect.textLongPx > 0
      ? rect.textLongPx : (rect.isVertical ? rect.height : rect.width);
    const thickPx = Number.isFinite(rect.textThickPx) && rect.textThickPx > 0
      ? rect.textThickPx : (rect.isVertical ? rect.width : rect.height);
    let x;
    let y;
    if (rect.isVertical) {
      x = t.cx - rect.width + thickPx / 2;
      y = t.cy - longPx / 2;
    } else {
      x = t.cx - longPx / 2;
      y = t.cy - thickPx / 2;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (Math.abs((nl.x ?? 0) - x) < 0.25 && Math.abs((nl.y ?? 0) - y) < 0.25) continue;
    updateNewLayer(t.tempId, { x, y });
    moved += 1;
  }
  return moved;
}

// 1 ctx 分の ruby 位置測定 (同期、副作用は state 書き戻しのみ)。
// rAF 版と save-time 同期版から共有する内部実装。
function measureRubyOffsetsForOverlay(overlay, canvas, page) {
  if (!overlay || !canvas || !page) return;
  const canvasRect = canvas.getBoundingClientRect();
  if (canvasRect.width <= 0 || canvasRect.height <= 0) return;
  const pxPerPsd = canvasRect.width / page.width;
  if (!Number.isFinite(pxPerPsd) || pxPerPsd <= 0) return;
  // overlay 内の全 layer-box (.editing 含む) を走査。
  const boxes = overlay.querySelectorAll(".layer-box");
  for (const box of boxes) {
    const wraps = box.querySelectorAll(".ruby-wrap[data-ruby-start], .ruby-mono-group[data-ruby-start]");
    if (wraps.length === 0) continue;
    const basisRect = uiTextBasisRectForBox(box);
    if (!basisRect || basisRect.width <= 0 || basisRect.height <= 0) continue;
    const psdPath = page.path;
    const isNew = box.classList.contains("layer-box-new");
    const layerKey = isNew ? box.dataset.tempId : Number(box.dataset.layerId);
    if (!psdPath || layerKey === null || layerKey === undefined || layerKey === "" || (typeof layerKey === "number" && !Number.isFinite(layerKey))) continue;
    // 同じ data-ruby-start を持つ base wrap が複数あれば (モノルビ)、最初の wrap だけ測る。
    const seenBaseStarts = new Set();
    const seenOverlays = new Set();
    for (const wrap of wraps) {
      const rubyTexts = Array.from(wrap.querySelectorAll(":scope > .ruby-text"));
      for (const rt of rubyTexts) {
        const isOverlayRuby = rt.dataset.rubyOverlay === "true";
        const startStr = rt.dataset.rubyStart || wrap.dataset.rubyStart;
        if (!startStr) continue;
        const start = Number(startStr);
        const end = Number(rt.dataset.rubyEnd || wrap.dataset.rubyEnd);
        if (!Number.isInteger(start)) continue;
        if (isOverlayRuby) {
          const overlayKey = `${startStr}\u0001${rt.dataset.rubyEnd || ""}\u0001${rt.dataset.rubyText || rt.textContent || ""}`;
          if (seenOverlays.has(overlayKey)) continue;
          seenOverlays.add(overlayKey);
        } else {
          if (seenBaseStarts.has(startStr)) continue;
          seenBaseStarts.add(startStr);
        }
      const rtRect = rt.getBoundingClientRect();
      if (rtRect.width <= 0 || rtRect.height <= 0) continue;
      // .ruby-text のスクリーン中心 → UI 上の実テキスト領域からの screen 相対座標 → PSD 座標に換算。
      // 縦書きは親文字の右側が前行側なので、UI/Photoshop ともに右端基準の offsetX にする。
      // 横書きは従来通り左上基準。
      const rtCenterScreenX = rtRect.left + rtRect.width / 2;
      const rtCenterScreenY = rtRect.top + rtRect.height / 2;
      const vertical = box.dataset.direction === "vertical";
      const offsetX = vertical
        ? (rtCenterScreenX - basisRect.right) / pxPerPsd
        : (rtCenterScreenX - basisRect.left) / pxPerPsd;
      const offsetY = (rtCenterScreenY - basisRect.top) / pxPerPsd;
      const abs = screenPointToPsd(canvasRect, page, rtCenterScreenX, rtCenterScreenY);
      const absX = abs.x;
      const absY = abs.y;
      if (!Number.isFinite(offsetX) || !Number.isFinite(offsetY) || !Number.isFinite(absX) || !Number.isFinite(absY)) continue;
      try {
        if (isOverlayRuby) {
          setCharRubyVisualOffset(psdPath, layerKey, start, end, rt.dataset.rubyText ?? rt.textContent ?? "", true, offsetX, offsetY, absX, absY);
        } else {
          setCharRubyOffset(psdPath, layerKey, start, offsetX, offsetY, absX, absY);
        }
      } catch (_) { /* state 未整合の場合は無視 */ }
      }
    }
  }
}

// rAF で 1 フレーム遅延させて layout 確定後に走る (renderOverlay 末尾から呼ばれる)。
function scheduleRubyOffsetMeasure(ctx) {
  if (typeof requestAnimationFrame !== "function") return;
  if (ctx._rubyOffsetScheduled) return;
  ctx._rubyOffsetScheduled = true;
  requestAnimationFrame(() => {
    ctx._rubyOffsetScheduled = false;
    placeRubyAtLineMidpointsForOverlay(ctx.overlay);
    measureRubyOffsetsForOverlay(ctx.overlay, ctx.canvas, ctx.page);
    placeRubyAtLineMidpointsForOverlay(ctx.overlay, { towardParentRatio: 0 });
  });
}

// 【v1.29.x UI-coord 保存時同期】保存ボタン押下の瞬間に全 page の overlay を DOM から
// 拾って同期測定する。これにより rAF 遅延を待たずに最新のルビ位置を state に書き戻せる。
// exportEdits を呼ぶ前にこの関数を呼ぶ運用 (bind/save.js の runSaveWithMode で利用)。
//
// DOM 構造: spread-view.js が各ページを以下のように構築する:
//   .canvas-wrap > canvas[data-page-index="N"] + .page-overlay
// これを利用して overlay の親 (.canvas-wrap) から canvas を辿り、data-page-index で page を引く。
export function measureAllRubyOffsetsSync() {
  const pages = getPages();
  if (!pages || pages.length === 0) return;
  const overlays = document.querySelectorAll(".page-overlay");
  for (const overlay of overlays) {
    // overlay の兄弟に canvas (data-page-index 付き) があるはず。
    const parent = overlay.parentElement;
    if (!parent) continue;
    const canvas = parent.querySelector("canvas[data-page-index]");
    if (!canvas) continue;
    const pageIndex = Number(canvas.dataset.pageIndex);
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pages.length) continue;
    const page = pages[pageIndex];
    if (!page) continue;
    placeRubyAtLineMidpointsForOverlay(overlay);
    measureRubyOffsetsForOverlay(overlay, canvas, page);
    placeRubyAtLineMidpointsForOverlay(overlay, { towardParentRatio: 0 });
  }
}

// バッジ重なり解決パス。rAF で 1 フレーム遅延させて DOM レイアウトが確定してから走る。
// 各バッジの getBoundingClientRect を比較し、すでに配置済みのバッジと縦方向で交差する
// なら .layer-size-badge--above を付けて上向きに反転する。
function scheduleBadgeOverlapResolution(ctx) {
  if (typeof requestAnimationFrame !== "function") return;
  if (ctx._badgeOverlapScheduled) return;
  ctx._badgeOverlapScheduled = true;
  requestAnimationFrame(() => {
    ctx._badgeOverlapScheduled = false;
    if (!ctx.overlay) return;
    const badges = Array.from(ctx.overlay.querySelectorAll(".layer-size-badge"));
    if (badges.length < 2) {
      // 1 個以下なら重なりが発生しない。クラスをクリアして default 下向きに戻す。
      for (const b of badges) b.classList.remove("layer-size-badge--above");
      return;
    }
    // 一旦すべて下向きにリセットしてから検出（前回の反転が残留しないよう）。
    for (const b of badges) b.classList.remove("layer-size-badge--above");
    // 左上 (top, left) 順にソートしてバッジを 1 つずつ「配置」していく。
    // 後から配置するバッジが既存バッジと交差したら上向きに反転する。
    const placed = [];
    badges.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      if (ra.top !== rb.top) return ra.top - rb.top;
      return ra.left - rb.left;
    });
    for (const badge of badges) {
      const r = badge.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (rectsOverlapPlaced(r, placed)) {
        badge.classList.add("layer-size-badge--above");
        const r2 = badge.getBoundingClientRect();
        // 反転後も重なる場合は諦めて下向きに戻す（多重重なりの極端ケース）。
        if (rectsOverlapPlaced(r2, placed)) {
          badge.classList.remove("layer-size-badge--above");
          placed.push(r);
        } else {
          placed.push(r2);
        }
      } else {
        placed.push(r);
      }
    }
  });
}

function rectsOverlapPlaced(r, placed) {
  for (const p of placed) {
    if (
      r.left < p.right - 1 &&
      r.right > p.left + 1 &&
      r.top < p.bottom - 1 &&
      r.bottom > p.top + 1
    ) return true;
  }
  return false;
}

function measureInnerContentRect(inner) {
  if (!inner || !inner.textContent) return null;
  let range = null;
  const rubyTexts = Array.from(inner.querySelectorAll?.(".ruby-text") ?? []);
  const previousRubyDisplays = rubyTexts.map((rt) => rt.style.display);
  try {
    // Ruby is positioned outside the parent glyphs and must not expand the
    // layer box. Measure only the parent text when doing the auto-fit pass.
    for (const rt of rubyTexts) rt.style.display = "none";
    range = document.createRange();
    range.selectNodeContents(inner);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5);
    if (rects.length === 0) return null;
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const r of rects) {
      if (r.left < left) left = r.left;
      if (r.top < top) top = r.top;
      if (r.right > right) right = r.right;
      if (r.bottom > bottom) bottom = r.bottom;
    }
    if (!Number.isFinite(left) || !Number.isFinite(top) || right <= left || bottom <= top) return null;
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  } catch (_) {
    return null;
  } finally {
    rubyTexts.forEach((rt, i) => { rt.style.display = previousRubyDisplays[i]; });
    try { range?.detach?.(); } catch (_) {}
  }
}

// 【v1.16.0】枠の自動調整（後置の保険）— measureText の予測がズレた場合の最終フォールバック。
// 各 layer-box の実描画文字範囲を測って、選択枠のサイズを文字に合わせる。
// left/top は state 座標の基準なので触らない。ここを書き換えるとドラッグ開始時の
// 座標基準と表示位置がズレ、移動完了時にレイヤーが少し飛ぶ。
// PSD 座標 → % 換算で指定。直接的な auto-fit 保険として動作する。
function scheduleBoxAutoFit(ctx) {
  if (typeof requestAnimationFrame !== "function") return;
  if (ctx._autoFitScheduled) return;
  ctx._autoFitScheduled = true;
  requestAnimationFrame(() => {
    ctx._autoFitScheduled = false;
    if (!ctx.overlay || !ctx.canvas) return;
    const overlayRect = ctx.overlay.getBoundingClientRect();
    const overlayW = overlayRect.width;
    const overlayH = overlayRect.height;
    if (overlayW <= 0 || overlayH <= 0) return;
    for (const box of ctx.overlay.querySelectorAll(".layer-box")) {
      if (box.classList.contains("editing")) continue;
      // 写植再利用の詰め枠は明示サイズのため autofit しない（右ずれ防止）。
      if (box.classList.contains("layer-box-reuse-tight")) continue;
      // 回転済みの box は getClientRects() が回転後の外接矩形を返すため、
      // その値で幅/高さを書き戻すと縦書きテキストが再流し込みされて崩れる。
      if (box.style.transform && box.style.transform !== "none") continue;
      const inner = box.querySelector(".existing-layer-text:not(.stroke-preview-underlay), .new-layer-text:not(.stroke-preview-underlay)");
      if (!inner) continue;
      const contentRect = measureInnerContentRect(inner);
      if (!contentRect) continue;
      const boxRect = box.getBoundingClientRect();
      const fitPad = 1;
      const boxLeft = Math.max(0, boxRect.left - overlayRect.left);
      const boxTop = Math.max(0, boxRect.top - overlayRect.top);
      const currentRight = Math.max(boxLeft + 1, boxRect.right - overlayRect.left);
      const currentBottom = Math.max(boxTop + 1, boxRect.bottom - overlayRect.top);
      const right = Math.min(overlayW, Math.max(currentRight, contentRect.right - overlayRect.left + fitPad));
      const bottom = Math.min(overlayH, Math.max(currentBottom, contentRect.bottom - overlayRect.top + fitPad));
      const width = Math.max(1, right - boxLeft);
      const height = Math.max(1, bottom - boxTop);
      box.style.width = `${(width / overlayW) * 100}%`;
      box.style.height = `${(height / overlayH) * 100}%`;
    }
  });
}

// 【v1.16.0】非対応フォントの対応 — 常に引用で数字始まり / 非 ASCII 名 / 予約語衝突を一括対処。
// 旧: `[\s,'"()]` を含むときだけ引用 → `851チカラヅヨク` のような数字始まり PS 名や
// 非 ASCII 名フォントが unquoted で CSS parse error を起こし、font-family 全体が
// 無効化される事故が発生していた。常時引用にすればこれらを完全に防げる。
function quoteFontFamily(name) {
  if (!name) return null;
  if (/^(regular|bold|italic|bold italic|light|medium|heavy|ultra|demi ?bold|semi ?bold|extra ?light|ex ?light|black)$/i.test(String(name).trim())) {
    return null;
  }
  const escaped = String(name).replace(/["\\]/g, "\\$&");
  return `"${escaped}"`;
}

// Align Chromium's single-column vertical preview with Photoshop's
// top-right text bounds without changing saved PSD coordinates.
function primaryTextPreviewInner(box) {
  return box?.querySelector?.(".new-layer-text:not(.stroke-preview-underlay), .existing-layer-text:not(.stroke-preview-underlay)") ?? null;
}

function setTextPreviewTransform(box, dxPx) {
  const value = Math.abs(dxPx) > 0.25 ? `translateX(${dxPx.toFixed(3)}px)` : "";
  for (const inner of box.querySelectorAll(".new-layer-text, .existing-layer-text")) {
    inner.style.transformOrigin = value ? "top right" : "";
    inner.style.transform = value;
  }
}

function resetTextPreviewTransform(box) {
  for (const inner of box.querySelectorAll(".new-layer-text, .existing-layer-text")) {
    inner.style.transformOrigin = "";
    inner.style.transform = "";
  }
}

function scheduleVerticalSingleLineAnchor(ctx) {
  if (typeof requestAnimationFrame !== "function") return;
  if (ctx._verticalSingleLineAnchorScheduled) return;
  ctx._verticalSingleLineAnchorScheduled = true;
  requestAnimationFrame(() => {
    ctx._verticalSingleLineAnchorScheduled = false;
    if (!ctx.overlay) return;
    for (const box of ctx.overlay.querySelectorAll('.layer-box[data-direction="vertical"]')) {
      if (box.classList.contains("editing")) continue;
      if (box.classList.contains("layer-box-reuse-tight")) continue;
      if (box.style.transform && box.style.transform !== "none") continue;
      const inner = primaryTextPreviewInner(box);
      if (!inner) continue;
      resetTextPreviewTransform(box);
      if (countLines(inner.textContent ?? "") !== 1) continue;
      const contentRect = measureInnerContentRect(inner);
      const boxRect = box.getBoundingClientRect();
      if (!contentRect || !boxRect || boxRect.width <= 0 || boxRect.height <= 0) continue;
      setTextPreviewTransform(box, boxRect.right - contentRect.right);
    }
  });
}

function reuseSourceBoundsForNewLayer(nl, sizePt) {
  if (nl?.reuseTightThick !== true) return null;
  const sourceContents = nl.reuseSourceContents;
  if (sourceContents == null) return null;
  if (String(nl.contents ?? "").replace(/\r\n?/g, "\n") !== String(sourceContents).replace(/\r\n?/g, "\n")) return null;
  const left = Number(nl.reuseSrcLeft);
  const top = Number(nl.reuseSrcTop);
  const right = Number(nl.reuseSrcRight);
  const bottom = Number(nl.reuseSrcBottom);
  if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) return null;
  const sourceSize = Number(nl.reuseSourceSizePt);
  const scale = Number.isFinite(sourceSize) && sourceSize > 0 && Number.isFinite(sizePt) && sizePt > 0
    ? sizePt / sourceSize
    : 1;
  return { width: (right - left) * scale, height: (bottom - top) * scale };
}

export function cssFontFamily(psName) {
  if (!psName) return null;
  const font = getFonts().find((f) => f.postScriptName === psName);
  const display = getFontDisplayName(psName);
  const parts = [];
  const add = (name) => {
    const q = quoteFontFamily(name);
    if (q && !parts.includes(q)) parts.push(q);
  };
  add(display);
  add(font?.name);
  for (const alias of Array.isArray(font?.aliases) ? font.aliases : []) {
    add(alias);
  }
  add(psName);
  parts.push("sans-serif");
  return parts.join(", ");
}

function countLines(s) {
  if (!s) return 0;
  return String(s).split(/\r\n|\r|\n/).length;
}

function countLineBreaks(s) {
  return (String(s ?? "").match(/\r\n|\r|\n/g) ?? []).length;
}

// fullText の各行の絶対開始 index を返す（textarea selectionStart と同じインデックス系）。
// 【v1.16.0】per-char サイズ/フォント機能で行内 i 番目の char の絶対 index を引くために使う。
function getLineStartOffsets(fullText) {
  const offsets = [0];
  const regex = /\r\n|\r|\n/g;
  let m;
  while ((m = regex.exec(fullText))) {
    offsets.push(m.index + m[0].length);
  }
  return offsets;
}

// 【v1.16.0】枠の自動調整 — canvas.measureText で実描画幅を測って bbox を auto-fit。
// canvas.measureText 用のオフスクリーン context（モジュール singleton）。
// 各行の実描画幅を em で返す。フォントが未ロードのときは fallback フォントで測定されるが、
// font-loader が登録完了時に refreshAllOverlays を呼ぶので次の render で正確な値に更新される。
let _measureCanvas = null;
function getMeasureContext() {
  if (!_measureCanvas) _measureCanvas = document.createElement("canvas");
  return _measureCanvas.getContext("2d");
}

// 【v1.16.0】枠の自動調整 — per-char サイズ/フォント override を反映した実描画幅を返す。
// 1 行の実描画幅を「layer のフォントサイズ単位」の em で返す。
// charSizes / charFonts による per-char オーバーライドを反映する。
// 連続する同じ (font, size) の文字を 1 セグメントにまとめて canvas.measureText で測り、
// セグメントの寸法を「(layer.sizePt) を 1 とした比率」に換算して合算する。
// charSize がオーバーライドされている文字は、その文字のサイズで測ったうえで
// (charSize / layerSize) 倍してから加算する → bbox が大きい文字に応じて伸びる。
//
// 戻り値: 0 〜 ∞（layer.sizePt em 単位）。空行は 0。測定不能なら null。
function normalizeScaleRatio(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n / 100 : 1;
}

function textAxisScaleRatio(isVertical, horizontalScale, verticalScale, axis) {
  const sx = normalizeScaleRatio(horizontalScale);
  const sy = normalizeScaleRatio(verticalScale);
  if (axis === "long") return isVertical ? sy : sx;
  return isVertical ? sx : sy;
}

function measureLineExtentEmWithOverrides(line, lineStartIdx, charSizes, charFonts, layerSizePt, layerFontPs, punctTsumePct, tcyEnabled, isVertical = false, charHorizontalScales = null, charVerticalScales = null, layerHorizontalScale = 100, layerVerticalScale = 100) {
  if (!line) return 0;
  if (!Number.isFinite(layerSizePt) || layerSizePt <= 0) return null;
  let ctx;
  try { ctx = getMeasureContext(); } catch { return null; }
  const refSizePx = 100;
  let totalEm = 0;
  // 【v1.x.0】句読点ツメ: 、 / 。 の数だけ tsume% × (charSize / layerSize) を差し引く。
  // measureText 自体は letter-spacing を反映しないので、ここで em 換算した差分を引く。
  const tsumeMag = Number.isFinite(punctTsumePct) && punctTsumePct > 0 ? punctTsumePct / 100 : 0;
  let tsumeReductionEm = 0;
  if (tsumeMag > 0) {
    for (let k = 0; k < line.length; k++) {
      const cc = line.charCodeAt(k);
      if (PUNCT_TSUME_CHAR_CODES.has(cc)) {
        const charSz = Number.isFinite(charSizes?.[lineStartIdx + k]) ? charSizes[lineStartIdx + k] : layerSizePt;
        const hs = Number.isFinite(charHorizontalScales?.[lineStartIdx + k]) ? charHorizontalScales[lineStartIdx + k] : layerHorizontalScale;
        const vs = Number.isFinite(charVerticalScales?.[lineStartIdx + k]) ? charVerticalScales[lineStartIdx + k] : layerVerticalScale;
        tsumeReductionEm += tsumeMag * (charSz / layerSizePt) * textAxisScaleRatio(isVertical, hs, vs, "long");
      }
    }
  }
  // 縦中横ペアは 2 文字を 1 セル幅 (CJK 全角 1em) に圧縮して描画される。
  // measureText が返す元の 2 文字幅は半角/全角でかなり異なる:
  //   - 半角 !! / !? : measureText ≈ 0.4em（ASCII proportional は細い）
  //   - 全角 ！！ / ！？: measureText ≈ 2em（CJK 全角 1em × 2）
  // どちらの場合も TCY 後の bbox は 1em に正規化される必要があるため、
  // ペアごとに「元の measureText 幅を引き、代わりに 1em を足す」差分補正を行う。
  //   - 半角ペア: 元 0.4em → 1em で +0.6em（広げる）
  //   - 全角ペア: 元 2em → 1em で -1em（縮める）
  // これがないと半角ペア入力時に bbox が不足して `!!` がフレームから溢れる。
  // tcyEnabled=true は呼び出し側で「設定 ON かつ縦書きレイヤー」の合成済みフラグを期待。
  let tcyAdjustEm = 0;
  if (tcyEnabled && line.length >= 2) {
    // TCY ペアの font-family は layer フォントを採用（TCY span 内は per-char font override 対象外）。
    const tcyFam = cssFontFamily(layerFontPs) || "sans-serif";
    for (let k = 0; k < line.length - 1; ) {
      const two = line.slice(k, k + 2);
      if (isTcyPunctuationPair(two)) {
        let pairOrigEm = 0;
        try {
          ctx.font = `${refSizePx}px ${tcyFam}`;
          const w = ctx.measureText(two).width;
          pairOrigEm = w / refSizePx;
        } catch { pairOrigEm = 0; }
        // 元の幅 (totalEm に既に含まれている) を引き、TCY 後の 1em を足す。
        // text scale がある場合は長軸方向の倍率も同じように効く。
        const absIdx = lineStartIdx + k;
        const hs = Number.isFinite(charHorizontalScales?.[absIdx]) ? charHorizontalScales[absIdx] : layerHorizontalScale;
        const vs = Number.isFinite(charVerticalScales?.[absIdx]) ? charVerticalScales[absIdx] : layerVerticalScale;
        tcyAdjustEm += (1 - pairOrigEm) * textAxisScaleRatio(isVertical, hs, vs, "long");
        k += 2;
      } else {
        k += 1;
      }
    }
  }
  let i = 0;
  while (i < line.length) {
    const sizeStart = Number.isFinite(charSizes?.[lineStartIdx + i]) ? charSizes[lineStartIdx + i] : layerSizePt;
    const fontStart = (typeof charFonts?.[lineStartIdx + i] === "string" && charFonts[lineStartIdx + i].length > 0)
      ? charFonts[lineStartIdx + i] : layerFontPs;
    const hScaleStart = Number.isFinite(charHorizontalScales?.[lineStartIdx + i]) ? charHorizontalScales[lineStartIdx + i] : layerHorizontalScale;
    const vScaleStart = Number.isFinite(charVerticalScales?.[lineStartIdx + i]) ? charVerticalScales[lineStartIdx + i] : layerVerticalScale;
    let j = i + 1;
    while (j < line.length) {
      const sz = Number.isFinite(charSizes?.[lineStartIdx + j]) ? charSizes[lineStartIdx + j] : layerSizePt;
      const fn = (typeof charFonts?.[lineStartIdx + j] === "string" && charFonts[lineStartIdx + j].length > 0)
        ? charFonts[lineStartIdx + j] : layerFontPs;
      const hs = Number.isFinite(charHorizontalScales?.[lineStartIdx + j]) ? charHorizontalScales[lineStartIdx + j] : layerHorizontalScale;
      const vs = Number.isFinite(charVerticalScales?.[lineStartIdx + j]) ? charVerticalScales[lineStartIdx + j] : layerVerticalScale;
      if (sz !== sizeStart || fn !== fontStart || hs !== hScaleStart || vs !== vScaleStart) break;
      j++;
    }
    const segText = line.slice(i, j);
    const fam = cssFontFamily(fontStart) || "sans-serif";
    // bbox 計算で参照する font を先読み開始（ロード完了後に onFontsRegistered →
    // refreshAllOverlays で再描画されて bbox が確定する）。
    if (fontStart) ensureFontLoaded(fontStart);
    const fontShorthand = `${refSizePx}px ${fam}`;
    // フォント未ロード時は measureText が fallback フォントで誤った値を返す。
    // それを使うと bbox が一時的に小さく計算されて、CSS 側の `white-space: pre` で
    // 改行が走り「フォント変更で改行位置が変わる」事故になるため、未ロード時は
    // 保守的な 1em per char にフォールバックする（CJK で正確、Latin で大きめ）。
    //
    // 注意: `document.fonts.check(fontShorthand)` は font shorthand 全体に sans-serif が
    // 含まれているため常に true を返す（sans-serif は常時利用可能）。これでは未ロード時の
    // フォールバックが発動しない。primary の family 名だけで check する必要がある。
    let fontReady = true;
    if (typeof document !== "undefined" && document.fonts && fontStart) {
      try {
        const display = getFontDisplayName(fontStart);
        const primary = quoteFontFamily(display) || quoteFontFamily(fontStart);
        if (primary) {
          fontReady = document.fonts.check(`${refSizePx}px ${primary}`);
        }
      } catch { fontReady = false; }
    }
    let w;
    if (fontReady) {
      ctx.font = fontShorthand;
      try {
        const metrics = ctx.measureText(segText);
        w = metrics.width;
        const inkWidth = Number(metrics.actualBoundingBoxLeft) + Number(metrics.actualBoundingBoxRight);
        if (Number.isFinite(inkWidth) && inkWidth > w) w = inkWidth;
      } catch { return null; }
      if (!Number.isFinite(w) || w <= 0) {
        w = segText.length * refSizePx;
      }
    } else {
      // フォント未ロード → 1em per char で大きめの bbox を確保
      w = segText.length * refSizePx;
    }
    // refSizePx font-size での実幅（CSS px）→ そのセグメントの「sizeStart pt」での幅に正規化
    // → さらに「layerSizePt em」に換算（layer サイズを 1 とした比率）
    const segWidthAtCharSizeEm = w / refSizePx;
    const scaleRatio = textAxisScaleRatio(isVertical, hScaleStart, vScaleStart, "long");
    const segWidthAtLayerEm = segWidthAtCharSizeEm * (sizeStart / layerSizePt) * scaleRatio;
    totalEm += segWidthAtLayerEm;
    i = j;
  }
  // 句読点ツメぶんを引き、縦中横ぶん（半角は加算 / 全角は減算の符号付き差分）を足し合わせる。
  // 負にならないようガード。
  const adjusted = totalEm - tsumeReductionEm + tcyAdjustEm;
  return adjusted > 0 ? adjusted : 0;
}

// 全行の最大行幅を「layer.sizePt em 単位」で返す。
// charSizes / charFonts に override があれば反映、なければ layer フォント単一で測定。
// punctTsumePct: 句読点ツメ%。0 のとき無効。各行の measureLineExtentEmWithOverrides に伝搬。
// tcyEnabled: 縦中横を bbox 計算に反映するか。true なら !!/!?/！！/！？ ペアの 1 文字幅ぶんを減算。
function measureMaxLineExtentEm(text, postScriptName, layerSizePt, charSizes, charFonts, punctTsumePct, tcyEnabled, isVertical = false, charHorizontalScales = null, charVerticalScales = null, layerHorizontalScale = 100, layerVerticalScale = 100) {
  if (!text) return 0;
  if (!Number.isFinite(layerSizePt) || layerSizePt <= 0) return null;
  const fullText = String(text);
  const linesArr = fullText.split(/\r\n|\r|\n/);
  const lineStarts = getLineStartOffsets(fullText);
  let maxEm = 0;
  for (let li = 0; li < linesArr.length; li++) {
    const em = measureLineExtentEmWithOverrides(
      linesArr[li], lineStarts[li], charSizes, charFonts, layerSizePt, postScriptName, punctTsumePct, tcyEnabled,
      isVertical, charHorizontalScales, charVerticalScales, layerHorizontalScale, layerVerticalScale,
    );
    if (em == null) continue;
    if (em > maxEm) maxEm = em;
  }
  return maxEm;
}

// 連続したとき自動でツメる対象記号 2 グループ。Photoshop 側でも同じ char code 集合を使う。
// dash:  — U+2014 EM DASH / ― U+2015 HORIZONTAL BAR / – U+2013 EN DASH / ‒ U+2012 FIGURE DASH /
//        ‐ U+2010 HYPHEN / ‑ U+2011 NON-BREAKING HYPHEN / ー U+30FC 長音記号 / － U+FF0D 全角ハイフン
// tilde: 〜 U+301C WAVE DASH / ～ U+FF5E FULLWIDTH TILDE
// 【v1.30.x】罫線素片 (─ U+2500 / ━ U+2501) や hyphen-bullet (⁃) など、Photoshop で
// ダッシュ風に使われる文字も dash 系として扱う。tilde 系は ASCII チルダ (~) と
// SMALL TILDE (˜) を追加。jsx_gen.rs charGroup と同期。
const DASH_CHARS = new Set(["—", "―", "–", "‒", "‐", "‑", "ー", "－", "─", "━", "−", "⁃", "﹘", "﹣"]);
const TILDE_CHARS = new Set(["〜", "～", "~", "˜"]);
const REPEATED_TARGET_REGEX = /[—―–‒‐‑ー－─━−⁃﹘﹣〜～~˜]/;

// 【v1.22.0】記号フォント置換の対象 char code 集合（プレビュー / Photoshop 両側で同一定義）。
// ハードコード固定セット。漫画写植慣例の「写植本体フォントが対応していない記号類」をカバー。
// ハート ♡♥ / 星 ★☆ / 音符 ♪♫♬♩♯♭ / 矢印 →←↑↓ / 丸 ○●〇◎ /
// 三角 △▲▽▼ / 四角 □■ / 菱形 ◇◆ / トランプ ♠♣♦
const SYMBOL_CHAR_CODES = new Set([
  0x2661, 0x2665, 0x2764,           // ♡ ♥ ❤
  0x2605, 0x2606,                   // ★ ☆
  0x266A, 0x266B, 0x266C, 0x2669,   // ♪ ♫ ♬ ♩
  0x266F, 0x266D,                   // ♯ ♭
  0x2192, 0x2190, 0x2191, 0x2193,   // → ← ↑ ↓
  0x25CB, 0x25CF, 0x3007, 0x25CE,   // ○ ● 〇 ◎
  0x25B3, 0x25B2, 0x25BD, 0x25BC,   // △ ▲ ▽ ▼
  0x25A1, 0x25A0,                   // □ ■
  0x25C7, 0x25C6,                   // ◇ ◆
  0x2660, 0x2663, 0x2666,           // ♠ ♣ ♦
]);
function lineHasSymbolChar(s) {
  if (typeof s !== "string") return false;
  for (let i = 0; i < s.length; i++) {
    if (SYMBOL_CHAR_CODES.has(s.charCodeAt(i))) return true;
  }
  return false;
}

// 【v1.x.0】句読点ツメ（mojiZume）の対象。
// Photoshop 側 (jsx_gen.rs applyPunctuationTsume) と同じ char code 集合。
// 環境設定 `punctuationTsumePercent` (0/50%) に従って、対象文字まわりの空白を tsume% ぶん詰める。
// CSS では後ろ詰めは letter-spacing、前詰めは margin-inline-start で表現する。
const PUNCT_TSUME_CHAR_CODES = new Set([
  0x3001, // 、
  0x3002, // 。
  0x300C, // 「
  0x300D, // 」
  0x301D, // 〝
  0x301F, // 〟
]);
const OPENING_PUNCT_TSUME_CHAR_CODES = new Set([
  0x300C, // 「
  0x301D, // 〝
]);
function lineHasPunctTsumeChar(s) {
  if (typeof s !== "string") return false;
  for (let i = 0; i < s.length; i++) {
    if (PUNCT_TSUME_CHAR_CODES.has(s.charCodeAt(i))) return true;
  }
  return false;
}

function estimateMaxLineExtentCells(text, punctTsumePct, tcyEnabled) {
  const tsumeMag = Number.isFinite(punctTsumePct) && punctTsumePct > 0 ? punctTsumePct / 100 : 0;
  let maxCells = 1;
  for (const line of String(text ?? "").split(/\r\n|\r|\n/)) {
    let punctReduction = 0;
    if (tsumeMag > 0) {
      for (let i = 0; i < line.length; i++) {
        if (PUNCT_TSUME_CHAR_CODES.has(line.charCodeAt(i))) punctReduction += tsumeMag;
      }
    }
    const tcyReduction = tcyEnabled ? findTcyPairs(line).length : 0;
    const cells = line.length - punctReduction - tcyReduction;
    if (cells > maxCells) maxCells = cells;
  }
  return maxCells;
}

function estimateMaxPositiveSpacingEm(text, trackingMille = 0, kerningMille = 0, charTrackings = null, charKernings = null) {
  const baseTracking = Number.isFinite(Number(trackingMille)) ? Number(trackingMille) : 0;
  const baseKerning = Number.isFinite(Number(kerningMille)) ? Number(kerningMille) : 0;
  const hasCharTrackings = charTrackings && Object.keys(charTrackings).length > 0;
  const hasCharKernings = charKernings && Object.keys(charKernings).length > 0;
  const full = String(text ?? "");
  const lineStarts = getLineStartOffsets(full);
  const lines = full.split(/\r\n|\r|\n/);
  let max = 0;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li] ?? "";
    const start = lineStarts[li] ?? 0;
    let total = 0;
    for (let i = 0; i < line.length; i++) {
      const absIdx = start + i;
      const tr = hasCharTrackings && Number.isFinite(charTrackings[absIdx]) ? charTrackings[absIdx] : baseTracking;
      const kr = hasCharKernings && Number.isFinite(charKernings[absIdx]) ? charKernings[absIdx] : baseKerning;
      total += Math.max(0, (tr + kr) / 1000);
    }
    if (total > max) max = total;
  }
  return max;
}

function repeatedTargetGroup(ch) {
  if (DASH_CHARS.has(ch)) return "dash";
  if (TILDE_CHARS.has(ch)) return "tilde";
  return null;
}
// 1 行を [{text, group}] のセグメント列に分解する。
// 例: "あ―――い" → [{text:"あ", group:null}, {text:"―――", group:"dash"}, {text:"い", group:null}]
// 例: "―〜―あ" → dash / tilde / dash を別ラン扱い。
function findRepeatedTargetRuns(line) {
  const out = [];
  let i = 0;
  while (i < line.length) {
    const group = repeatedTargetGroup(line[i]);
    let j = i;
    while (j < line.length && repeatedTargetGroup(line[j]) === group) j++;
    out.push({ text: line.slice(i, j), group });
    i = j;
  }
  return out;
}

// 縦中横 (TCY) の自動検出対象:
//   1) 半角数字 2 桁の連続 (例: "12", "85") — 縦書き写植の標準慣行
//   2) 半角「!!」「!?」ペア
//   3) 全角「！！」「！？」ペア (jsx_gen.rs と同様、Photoshop 側で半角化されるが
//      プレビュー側でも視覚的に TCY 表示にしないと「アプリで反映されない」と感じるため)
// 先頭から貪欲に消費するので、"!!!" → [(0,2)]（末尾 ! は単独）など。
function isHalfWidthDigitForTcy(ch) {
  return ch >= "0" && ch <= "9";
}

const FW_EXCLAMATION = "\uFF01";
const FW_QUESTION = "\uFF1F";

function isTcyPunctuationChar(ch) {
  return ch === "!" || ch === "?" || ch === FW_EXCLAMATION || ch === FW_QUESTION;
}

function isTcyPunctuationPair(text) {
  return text.length === 2 && isTcyPunctuationChar(text[0]) && isTcyPunctuationChar(text[1]);
}

function normalizeTcyPunctuationPair(text) {
  if (!isTcyPunctuationPair(text)) return text;
  return text.replace(/\uFF01/g, "!").replace(/\uFF1F/g, "?");
}

function normalizeTcyPunctuationPairs(text) {
  return String(text ?? "").replace(/[\u0021\u003F\uFF01\uFF1F]{2}/g, normalizeTcyPunctuationPair);
}

function findTcyPairs(line) {
  const pairs = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    // 数字 2 桁検出
    if (isHalfWidthDigitForTcy(ch)) {
      let j = i + 1;
      while (j < line.length && isHalfWidthDigitForTcy(line[j])) j++;
      if (j - i === 2) pairs.push({ start: i, end: j });
      i = j;
      continue;
    }
    // 半角/全角の ! ? は 2 文字ペアだけ TCY 対象。単独の「！」/「？」は通常の縦組みのまま。
    if (i + 1 < line.length && isTcyPunctuationPair(line.slice(i, i + 2))) {
      pairs.push({ start: i, end: i + 2 });
      i += 2;
      continue;
    }
    i += 1;
  }
  return pairs;
}

// 【v1.16.0】per-char サイズ/フォント描画 + 連続記号ツメ + TCY 統合ヘルパー。
// 4 要素 (TCY + DASH/TILDE 連続記号ツメ + per-char-size + per-char-font) を 1 関数で処理する。
//
// 1 行を parentEl に追加する。
// - tcyOn のとき、!! / !? のペアを <span class="tcy-span"> でラップ（CSS の text-combine-upright で
//   2 文字を 1 文字幅に詰めて縦書き 1 セルに収める）。tcy 内では per-char サイズ/フォントは適用しない。
// - 連続対象記号ラン (dash / tilde) は per-char letter-spacing を当ててツメ表示（最後の 1 文字は除外）。
// - charSizes: contents 文字列の絶対 index をキーとする pt サポート。layer の defaultSizePt との
//   比率を em で指定して inner の font-size に対する相対サイズに変換する。
// - charFonts: 絶対 index をキーとする PostScript 名。inner の font-family を上書きする。
//
// lineStartIdx: この行が full contents 文字列のどの位置から始まるか（0-based）。
// dashMille / tildeMille は写植設定の tracking 値をそのまま使う（例: -100 → -0.1em）。
// tcyOn は呼び出し側で「設定 ON かつ縦書きレイヤー」の合成済みフラグを期待する。
//
// 連続する同 signature (size, tracking, font) の文字を 1 span にまとめて DOM 軽量化。
function appendLineWithTracking(parentEl, line, lineStartIdx, dashMille, tildeMille, tcyOn, charSizes, defaultSizePt, charFonts, symbolFontPS, charBolds, charItalics, punctTsumeMag, charRubies, charHorizontalScales = null, charVerticalScales = null, trackingMille = 0, kerningMille = 0, charTrackings = null, charKernings = null, charTateChuYokos = null, charFillColors = null, layerHorizontalScale = 100, layerVerticalScale = 100) {
  if (!line.length) {
    // 空行は zero-width space で line-box を維持（縦書きで列が消えないように）。
    parentEl.appendChild(document.createTextNode("​"));
    return;
  }
  // 【v2.x】TCY 有効時、全角「！！」「！？」を半角「!!」「!?」に変換してから描画する。
  // CSS の text-combine-upright は半角 ASCII ペアでないと Chromium が合成 glyph 化しない
  // ため、全角のままだと「アプリで縦中横が反映されない」現象になる。
  // 1:1 char 置換なので lineStartIdx + i の char index も維持され、per-char 属性 (charSizes,
  // charFonts, charBolds 等) の参照も壊れない。jsx_gen.rs applyTateChuYoko も同じ変換を
  // するので、プレビューと PSD 保存後の見た目が一致する。
  if (tcyOn) {
    line = normalizeTcyPunctuationPairs(line);
  }
  const dashTrack = Number.isFinite(Number(dashMille)) ? Number(dashMille) : 0;
  const tildeTrack = Number.isFinite(Number(tildeMille)) ? Number(tildeMille) : 0;
  const manualTcyRanges = [];
  if (charTateChuYokos && Object.keys(charTateChuYokos).length > 0) {
    let i = 0;
    while (i < line.length) {
      const absIdx = lineStartIdx + i;
      if (charTateChuYokos[absIdx] === true) {
        let j = i + 1;
        while (j < line.length && charTateChuYokos[lineStartIdx + j] === true) j++;
        if (j - i >= 2) manualTcyRanges.push({ start: i, end: j });
        i = j;
      } else {
        i++;
      }
    }
  }
  let tcyPairs = [...(tcyOn ? findTcyPairs(line) : []), ...manualTcyRanges]
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .reduce((acc, r) => {
      const last = acc[acc.length - 1];
      if (last && r.start <= last.end) {
        last.end = Math.max(last.end, r.end);
      } else {
        acc.push({ ...r });
      }
      return acc;
    }, []);
  const hasCharSizes = charSizes && Object.keys(charSizes).length > 0;
  const hasCharFonts = charFonts && Object.keys(charFonts).length > 0;
  const hasCharBolds = charBolds && Object.keys(charBolds).length > 0;
  const hasCharItalics = charItalics && Object.keys(charItalics).length > 0;
  const hasCharFillColors = charFillColors && Object.keys(charFillColors).length > 0;
  const hasCharHorizontalScales = charHorizontalScales && Object.keys(charHorizontalScales).length > 0;
  const hasCharVerticalScales = charVerticalScales && Object.keys(charVerticalScales).length > 0;
  const baseTracking = Number.isFinite(Number(trackingMille)) ? Number(trackingMille) : 0;
  const baseKerning = Number.isFinite(Number(kerningMille)) ? Number(kerningMille) : 0;
  const hasCharTrackings = charTrackings && Object.keys(charTrackings).length > 0;
  const hasCharKernings = charKernings && Object.keys(charKernings).length > 0;
  const hasLetterSpacing = baseTracking !== 0 || baseKerning !== 0 || hasCharTrackings || hasCharKernings;
  const trackingActive = (dashTrack !== 0 || tildeTrack !== 0) && REPEATED_TARGET_REGEX.test(line);
  const symbolActive = (typeof symbolFontPS === "string" && symbolFontPS.length > 0) && lineHasSymbolChar(line);
  // 【v1.x.0】句読点ツメ（、 / 。 を tsume% で詰める）。0..1 の em 量。
  const tsumeMag = Number.isFinite(punctTsumeMag) && punctTsumeMag > 0 ? punctTsumeMag : 0;
  const punctActive = tsumeMag > 0 && lineHasPunctTsumeChar(line);

  // 【v1.26.0】ruby 範囲を line 内で抽出（line 内の local index に変換）。
  // ruby 範囲は最優先で line を分割し、ruby 内の文字は <ruby> 構造で別出力する。
  const lineEnd = lineStartIdx + line.length;
  const rubySegmentsInLine = [];
  if (charRubies) {
    for (const k of Object.keys(charRubies)) {
      const s = Number(k);
      const entry = charRubies[k];
      if (!Number.isFinite(s) || !entry) continue;
      const e = Number(entry.end);
      if (e <= lineStartIdx || s >= lineEnd) continue;
      // line 範囲内に clipping（ruby が複数行に跨ぐケースは Phase A では line 末まで truncate）
      const localStart = Math.max(s, lineStartIdx) - lineStartIdx;
      const localEnd = Math.min(e, lineEnd) - lineStartIdx;
      rubySegmentsInLine.push({ start: localStart, end: localEnd, entry });
    }
    rubySegmentsInLine.sort((a, b) => a.start - b.start);
  }
  const hasRuby = rubySegmentsInLine.length > 0;
  // ruby 範囲内の tcy ペアは抑止（ruby のふりがな上で縦中横が当たると見た目が崩れる）。
  if (hasRuby && tcyPairs.length > 0) {
    tcyPairs = tcyPairs.filter((p) =>
      !rubySegmentsInLine.some((r) => p.start < r.end && p.end > r.start));
  }

  // 高速パス：何も装飾なし → 単純テキストノード 1 つで終わり
  if (!trackingActive && !hasLetterSpacing && tcyPairs.length === 0 && !hasCharSizes && !hasCharFonts && !symbolActive && !hasCharBolds && !hasCharItalics && !hasCharFillColors && !hasCharHorizontalScales && !hasCharVerticalScales && !punctActive && !hasRuby) {
    parentEl.appendChild(document.createTextNode(line));
    return;
  }
  // 各文字の tracking 値（em 単位、負）を事前計算。連続ランの最後の文字は 0。
  const trackings = new Array(line.length).fill(0);
  if (hasLetterSpacing) {
    for (let i = 0; i < line.length; i++) {
      const absIdx = lineStartIdx + i;
      const tr = hasCharTrackings && Number.isFinite(charTrackings[absIdx]) ? charTrackings[absIdx] : baseTracking;
      const kr = hasCharKernings && Number.isFinite(charKernings[absIdx]) ? charKernings[absIdx] : baseKerning;
      trackings[i] = (tr + kr) / 1000;
    }
  }
  if (trackingActive) {
    const segments = findRepeatedTargetRuns(line);
    let pos = 0;
    for (const seg of segments) {
      if (seg.group && seg.text.length >= 2) {
        for (let k = 0; k < seg.text.length - 1; k++) {
          const value = seg.group === "dash" ? dashTrack : seg.group === "tilde" ? tildeTrack : 0;
          if (value !== 0) trackings[pos + k] += value / 1000;
        }
      }
      pos += seg.text.length;
    }
  }
  // tcy ペア境界で分割し、各セグメントを「tcy 内」(text-combine-upright) または
  // 「tcy 外」(per-char signature 統合) として出力する。
  // 句読点ツメは punctActive のときだけ tsumeMag を append... に渡す（高速パス判定とも整合）。
  const tsumeArg = punctActive ? tsumeMag : 0;

  // 【v1.26.0】ruby 範囲があれば、まず line を「ruby 範囲ぶん」「それ以外（既存 tcy + styled）」
  // で分割して出力する。これにより ruby は最優先で <ruby><rb>...<rt>...</rt></ruby> 構造化される。
  const emitNonRubyRange = (fromLocal, toLocal) => {
    if (toLocal <= fromLocal) return;
    const sub = line.slice(fromLocal, toLocal);
    // tcyPairs を sub の範囲に限定し、local index を sub 基準に再オフセット
    const pairsInSub = tcyPairs
      .filter((p) => p.start >= fromLocal && p.end <= toLocal)
      .map((p) => ({ start: p.start - fromLocal, end: p.end - fromLocal }));
    let pos = 0;
    for (const pair of pairsInSub) {
      if (pair.start > pos) {
        appendStyledSegment(parentEl, sub.slice(pos, pair.start),
          fromLocal + pos, lineStartIdx, trackings, charSizes, defaultSizePt, charFonts,
          hasCharSizes, hasCharFonts, symbolActive ? symbolFontPS : null, charBolds, charItalics, hasCharBolds, hasCharItalics, tsumeArg,
          charHorizontalScales, charVerticalScales, hasCharHorizontalScales, hasCharVerticalScales,
          charFillColors, hasCharFillColors, layerHorizontalScale, layerVerticalScale);
      }
      const span = document.createElement("span");
      span.className = "tcy-span";
      const innerSpan = document.createElement("span");
      innerSpan.className = "tcy-inner";
      span.textContent = sub
        .slice(pair.start, pair.end);
      span.textContent = normalizeTcyPunctuationPair(span.textContent);
      innerSpan.textContent = span.textContent;
      span.textContent = "";
      span.dataset.tcyLength = String(innerSpan.textContent.length);
      span.appendChild(innerSpan);
      parentEl.appendChild(span);
      pos = pair.end;
    }
    if (pos < sub.length) {
      appendStyledSegment(parentEl, sub.slice(pos),
          fromLocal + pos, lineStartIdx, trackings, charSizes, defaultSizePt, charFonts,
          hasCharSizes, hasCharFonts, symbolActive ? symbolFontPS : null, charBolds, charItalics, hasCharBolds, hasCharItalics, tsumeArg,
          charHorizontalScales, charVerticalScales, hasCharHorizontalScales, hasCharVerticalScales,
          charFillColors, hasCharFillColors, layerHorizontalScale, layerVerticalScale);
    }
  };

  if (hasRuby) {
    let cursor = 0;
    for (const seg of rubySegmentsInLine) {
      if (seg.start > cursor) emitNonRubyRange(cursor, seg.start);
      appendRubySegment(parentEl,
        line.slice(seg.start, seg.end), seg.start, lineStartIdx, seg.entry,
        trackings, charSizes, defaultSizePt, charFonts,
        symbolActive ? symbolFontPS : null, charBolds, charItalics,
        hasCharSizes, hasCharFonts, hasCharBolds, hasCharItalics, tsumeArg,
        charHorizontalScales, charVerticalScales, hasCharHorizontalScales, hasCharVerticalScales,
        charFillColors, hasCharFillColors, layerHorizontalScale, layerVerticalScale);
      cursor = seg.end;
    }
    if (cursor < line.length) emitNonRubyRange(cursor, line.length);
    return;
  }

  // ruby なし → 既存パス（tcy + styled）。
  emitNonRubyRange(0, line.length);
}

// 【v1.26.0】ruby segment を「親文字 wrap + 実 DOM のルビ span」構造で出力する。
// 旧 <ruby> タグ方式は Chromium の writing-mode: vertical-rl サポートが不安定。
// ::after 疑似要素方式も再描画後に消えるバグが残ったため、ルビを本物の <span class="ruby-text">
// として DOM に入れる構造に変更。これで描画が確実に行われる。
//
// 構造:
//   <span class="ruby-wrap">
//     <span class="ruby-base">親文字</span>
//     <span class="ruby-text">ふりがな</span>
//   </span>
// CSS で .ruby-text を absolute 配置（横書きは上、縦書きは右）。
//
// モノルビ（type === "mono" かつ スペース分割数 == parentText.length）は親文字 1 文字 + rt-pair
// を文字ごとに並べる。グループルビは親文字全体に 1 つの rt を付ける。
function appendRubySegment(parentEl, parentText, parentLocalStart, lineStartIdx, entry,
                            trackings, charSizes, defaultSizePt, charFonts,
                            symbolFontPS, charBolds, charItalics,
                            hasCharSizes, hasCharFonts, hasCharBolds, hasCharItalics, punctTsumeMag,
                            charHorizontalScales = null, charVerticalScales = null,
                            hasCharHorizontalScales = false, hasCharVerticalScales = false,
                            charFillColors = null, hasCharFillColors = false) {
  if (!parentText.length || !entry || typeof entry.text !== "string") return;
  const isNakaguroRubyText = (value) => {
    const chars = Array.from(String(value ?? ""));
    return chars.length > 0 && chars.every((ch) => {
      const code = ch.charCodeAt(0);
      return code === 0x30fb || code === 0xff65;
    });
  };
  const isDakutenRubyText = (value) => {
    const chars = Array.from(String(value ?? ""));
    return chars.length > 0 && chars.every((ch) => {
      const code = ch.charCodeAt(0);
      return code === 0x309b || code === 0xff9e || code === 0x3099;
    });
  };
  const isSpecialRubyText = (value) => isNakaguroRubyText(value) || isDakutenRubyText(value);
  const positionRubyTextWithinPair = (rt, overlayStart, overlayEnd, pairStart, pairEnd) => {
    if (!Number.isFinite(pairStart) || !Number.isFinite(pairEnd) || pairEnd <= pairStart) return;
    const from = Math.max(pairStart, Math.min(pairEnd, Number(overlayStart)));
    const to = Math.max(pairStart, Math.min(pairEnd, Number(overlayEnd)));
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return;
    const pct = ((from + to) / 2 - pairStart) / (pairEnd - pairStart) * 100;
    if (!Number.isFinite(pct)) return;
    const vertical = parentEl?.closest?.(".layer-box")?.dataset.direction === "vertical";
    if (vertical) rt.style.top = `${pct}%`;
    else rt.style.left = `${pct}%`;
  };
  const isMono = entry.type === "mono"
    && /[ 　]/.test(entry.text)
    && entry.text.split(/[ 　]+/).length === parentText.length;
  const scale = (Number.isFinite(entry.scale) && entry.scale > 0) ? entry.scale : 50;
  const absRubyStart = lineStartIdx + parentLocalStart;
  const entryEnd = Number(entry.end);
  const absRubyEnd = Number.isFinite(entryEnd) && entryEnd > absRubyStart
    ? entryEnd
    : absRubyStart + parentText.length;
  const entryOverlays = Array.isArray(entry.overlays) ? entry.overlays : [];
  const overlayOverlaps = (overlay, from, to) => {
    const overlayStart = Number(overlay?.start);
    const overlayEnd = Number(overlay?.end);
    return Number.isFinite(overlayStart)
      && Number.isFinite(overlayEnd)
      && overlayStart < to
      && overlayEnd > from
      && typeof overlay.text === "string"
      && overlay.text.length > 0;
  };
  const effectiveRubyFontForChar = (absIdx, ch) => {
    const explicit = hasCharFonts ? charFonts?.[absIdx] : undefined;
    if (typeof explicit === "string" && explicit.length > 0) return explicit;
    if (typeof symbolFontPS === "string" && symbolFontPS.length > 0 && SYMBOL_CHAR_CODES.has(ch.charCodeAt(0))) {
      return symbolFontPS;
    }
    // per-char フォントも記号フォントも無ければ null を返し、rt に font-family を設定しない。
    // → 親文字 (.ruby-base / inner) と同じくレイヤーのフォントを CSS 継承する。
    //   以前は環境設定の既定フォント (F910) を明示適用していたため、フレーム全体の
    //   フォントを変えてもルビだけ F910 のままになっていた。
    return null;
  };
  const rubyFontForParentSlice = (segText, segLocalStart) => {
    for (let i = 0; i < segText.length; i++) {
      const ps = effectiveRubyFontForChar(lineStartIdx + segLocalStart + i, segText[i]);
      if (ps) return ps;
    }
    return null;
  };
  const rubyFontForAbsRange = (from, to) => {
    for (let i = 0; i < parentText.length; i++) {
      const absIdx = absRubyStart + i;
      if (absIdx < from || absIdx >= to) continue;
      const ps = effectiveRubyFontForChar(absIdx, parentText[i]);
      if (ps) return ps;
    }
    return rubyFontForParentSlice(parentText, parentLocalStart);
  };
  const applyRubyFont = (el, ps) => {
    if (typeof ps !== "string" || ps.length === 0) return;
    const fam = cssFontFamily(ps);
    if (fam) el.style.fontFamily = fam;
    ensureFontLoaded(ps);
  };
  const appendOverlayRubyText = (host, overlay, index, from, to) => {
    const overlayRt = document.createElement("span");
    overlayRt.className = `ruby-text ruby-text-overlay${isNakaguroRubyText(overlay.text) ? " ruby-text-nakaguro" : ""}${isSpecialRubyText(overlay.text) ? " ruby-text-overlay-same-position" : ""}`;
    if (lineStartIdx === 0) overlayRt.classList.add("ruby-text-first-line");
    overlayRt.contentEditable = "false";
    overlayRt.setAttribute("aria-hidden", "true");
    overlayRt.dataset.rubyStart = String(overlay.start);
    overlayRt.dataset.rubyEnd = String(overlay.end);
    overlayRt.dataset.rubyText = overlay.text;
    overlayRt.dataset.rubyOverlay = "true";
    overlayRt.textContent = overlay.text;
    overlayRt.style.setProperty("--ruby-scale", `${((Number(overlay.scale) || scale) / 100)}em`);
    overlayRt.style.setProperty("--ruby-stack-index", String(index + 1));
    applyRubyFont(overlayRt, rubyFontForAbsRange(Number(overlay.start), Number(overlay.end)));
    positionRubyTextWithinPair(overlayRt, Number(overlay.start), Number(overlay.end), from, to);
    host.appendChild(overlayRt);
  };

  const makePair = (segText, segLocalStart, rubyText, absStartForThisPair, options = {}) => {
    const absEndForThisPair = absStartForThisPair + segText.length;
    const wrap = document.createElement("span");
    wrap.className = "ruby-wrap";
    wrap.style.setProperty("--ruby-scale", `${scale / 100}em`);
    wrap.dataset.rubyStart = String(absStartForThisPair);
    wrap.dataset.rubyEnd = String(entry.end);
    const base = document.createElement("span");
    base.className = "ruby-base";
    appendStyledSegment(base, segText,
      segLocalStart, lineStartIdx, trackings, charSizes, defaultSizePt, charFonts,
      hasCharSizes, hasCharFonts, symbolFontPS, charBolds, charItalics, hasCharBolds, hasCharItalics, punctTsumeMag,
      charHorizontalScales, charVerticalScales, hasCharHorizontalScales, hasCharVerticalScales,
      charFillColors, hasCharFillColors);
    wrap.appendChild(base);
    const rt = document.createElement("span");
    rt.className = `ruby-text${isNakaguroRubyText(rubyText) ? " ruby-text-nakaguro" : ""}${isSpecialRubyText(rubyText) ? " ruby-text-overlay-same-position" : ""}`;
    if (lineStartIdx === 0) rt.classList.add("ruby-text-first-line");
    rt.contentEditable = "false";
    rt.setAttribute("aria-hidden", "true");
    rt.dataset.rubyStart = String(absStartForThisPair);
    rt.dataset.rubyEnd = String(entry.end);
    rt.dataset.rubyText = entry.text;
    rt.dataset.rubyOverlay = "false";
    rt.textContent = rubyText;
    applyRubyFont(rt, rubyFontForParentSlice(segText, segLocalStart));
    wrap.appendChild(rt);
    entryOverlays
      .filter((overlay) => overlayOverlaps(overlay, absStartForThisPair, absEndForThisPair))
      .filter((overlay) => !(options.skipSpecialOverlays && isSpecialRubyText(overlay.text)))
      .forEach((overlay, index) => {
        appendOverlayRubyText(wrap, overlay, index, absStartForThisPair, absEndForThisPair);
      });
    return wrap;
  };

  if (isMono) {
    const parts = entry.text.split(/[ 　]+/);
    const specialOverlays = entryOverlays
      .filter((overlay) => isSpecialRubyText(overlay.text))
      .filter((overlay) => overlayOverlaps(overlay, absRubyStart, absRubyEnd));
    if (specialOverlays.length > 0) {
      const group = document.createElement("span");
      group.className = "ruby-mono-group";
      group.dataset.rubyStart = String(absRubyStart);
      group.dataset.rubyEnd = String(absRubyEnd);
      group.style.setProperty("--ruby-scale", `${scale / 100}em`);
      for (let i = 0; i < parentText.length; i++) {
        group.appendChild(makePair(parentText[i], parentLocalStart + i, parts[i], absRubyStart, { skipSpecialOverlays: true }));
      }
      specialOverlays.forEach((overlay, index) => {
        appendOverlayRubyText(group, overlay, index, absRubyStart, absRubyEnd);
      });
      parentEl.appendChild(group);
      return;
    }
    for (let i = 0; i < parentText.length; i++) {
      parentEl.appendChild(makePair(parentText[i], parentLocalStart + i, parts[i], absRubyStart));
    }
  } else {
    parentEl.appendChild(makePair(parentText, parentLocalStart, entry.text, absRubyStart));
  }
}

// 【v1.16.0】tcy 外セグメントを per-char signature (size, tracking, font) 統合で append。
// segStartInLine: このセグメントが line のどの位置から始まるか（trackings 配列の index 算出用）
// lineStartIdx: line が full contents のどの位置から始まるか（charSizes / charFonts の絶対 index 算出用）
// 【v1.x.0】punctTsumeMag (0..1) で句読点/括弧を縮める。例: 0.5 で 0.5em 詰める。
//   始め括弧（「/〝）は前側、その他は後ろ側を詰める。
function appendStyledSegment(parentEl, segText, segStartInLine, lineStartIdx, trackings, charSizes, defaultSizePt, charFonts, hasCharSizes, hasCharFonts, symbolFontPS, charBolds, charItalics, hasCharBolds, hasCharItalics, punctTsumeMag, charHorizontalScales = null, charVerticalScales = null, hasCharHorizontalScales = false, hasCharVerticalScales = false, charFillColors = null, hasCharFillColors = false, layerHorizontalScale = 100, layerVerticalScale = 100) {
  if (!segText.length) return;
  // 【v1.22.0】per-char font 解決: ユーザー手動指定 (charFonts[idx]) があれば最優先、
  // 無ければ symbol char に対しては symbolFontPS で自動置換、それでも無ければ undefined（layer 既定）。
  const symbolReplaceActive = typeof symbolFontPS === "string" && symbolFontPS.length > 0;
  const tsumeActive = Number.isFinite(punctTsumeMag) && punctTsumeMag > 0;
  function effectiveFontAt(absIdx, ch) {
    const explicit = hasCharFonts ? charFonts[absIdx] : undefined;
    if (typeof explicit === "string" && explicit.length > 0) return explicit;
    if (symbolReplaceActive && SYMBOL_CHAR_CODES.has(ch.charCodeAt(0))) return symbolFontPS;
    return undefined;
  }
  // 各 char の tsume em 値。始め括弧は前側、それ以外の対象文字は後ろ側を詰める。
  function tsumeForChar(ch) {
    if (!tsumeActive) return { before: 0, after: 0 };
    const cc = ch.charCodeAt(0);
    if (!PUNCT_TSUME_CHAR_CODES.has(cc)) return { before: 0, after: 0 };
    return OPENING_PUNCT_TSUME_CHAR_CODES.has(cc)
      ? { before: punctTsumeMag, after: 0 }
      : { before: 0, after: punctTsumeMag };
  }
  let i = 0;
  while (i < segText.length) {
    const absIdx = lineStartIdx + segStartInLine + i;
    const sigSize = hasCharSizes ? charSizes[absIdx] : undefined;
    const sigTrack = trackings[segStartInLine + i];
    const sigFont = effectiveFontAt(absIdx, segText[i]);
    // 【v1.22.0】per-char 合成太字 (charBolds[absIdx])。boolean があれば signature に含める。
    const sigBold = hasCharBolds ? charBolds[absIdx] : undefined;
    const sigItalic = hasCharItalics ? charItalics[absIdx] : undefined;
    const sigFill = hasCharFillColors ? charFillColors[absIdx] : undefined;
    const sigHScale = hasCharHorizontalScales && Number.isFinite(charHorizontalScales[absIdx]) ? charHorizontalScales[absIdx] : layerHorizontalScale;
    const sigVScale = hasCharVerticalScales && Number.isFinite(charVerticalScales[absIdx]) ? charVerticalScales[absIdx] : layerVerticalScale;
    // 【v1.x.0】句読点ツメ。signature に含めて同じ詰め方向の連続文字を 1 span にまとめる。
    const sigTsume = tsumeForChar(segText[i]);
    let j = i + 1;
    while (j < segText.length) {
      const absJ = lineStartIdx + segStartInLine + j;
      const s = hasCharSizes ? charSizes[absJ] : undefined;
      const t = trackings[segStartInLine + j];
      const f = effectiveFontAt(absJ, segText[j]);
      const b = hasCharBolds ? charBolds[absJ] : undefined;
      const it = hasCharItalics ? charItalics[absJ] : undefined;
      const fl = hasCharFillColors ? charFillColors[absJ] : undefined;
      const hs = hasCharHorizontalScales && Number.isFinite(charHorizontalScales[absJ]) ? charHorizontalScales[absJ] : layerHorizontalScale;
      const vs = hasCharVerticalScales && Number.isFinite(charVerticalScales[absJ]) ? charVerticalScales[absJ] : layerVerticalScale;
      const tu = tsumeForChar(segText[j]);
      if (
        s !== sigSize || t !== sigTrack || f !== sigFont || b !== sigBold || it !== sigItalic ||
        fl !== sigFill ||
        hs !== sigHScale || vs !== sigVScale ||
        tu.before !== sigTsume.before || tu.after !== sigTsume.after
      ) break;
      j++;
    }
    const text = segText.slice(i, j);
    // 後ろ詰めは letter-spacing、前詰めは margin-inline-start。連続記号ツメは letter-spacing に合算する。
    const effectiveLetterSpacingEm = sigTrack + (sigTsume.after > 0 ? -sigTsume.after : 0);
    const effectiveMarginInlineStartEm = sigTsume.before > 0 ? -sigTsume.before : 0;
    const fillCss = cssFillColor(sigFill);
    const needsSpan = Number.isFinite(sigSize) || effectiveLetterSpacingEm !== 0 || effectiveMarginInlineStartEm !== 0
      || (typeof sigFont === "string" && sigFont.length > 0)
      || typeof sigBold === "boolean"
      || typeof sigItalic === "boolean"
      || !!fillCss
      || (Number.isFinite(sigHScale) && sigHScale !== 100)
      || (Number.isFinite(sigVScale) && sigVScale !== 100);
    if (needsSpan) {
      const span = document.createElement("span");
      if (Number.isFinite(sigSize) && Number.isFinite(defaultSizePt) && defaultSizePt > 0) {
        // sigSize は pt 単位。inner の font-size は layer default を screen px で持つので
        // (sigSize / defaultSizePt) em 表記で相対指定する。
        span.style.fontSize = `${sigSize / defaultSizePt}em`;
      }
      if (effectiveLetterSpacingEm !== 0) {
        span.style.letterSpacing = `${effectiveLetterSpacingEm}em`;
      }
      if (effectiveMarginInlineStartEm !== 0) {
        span.style.marginInlineStart = `${effectiveMarginInlineStartEm}em`;
      }
      if (typeof sigFont === "string" && sigFont.length > 0) {
        // PostScript 名から family-name 解決 → font-family を上書き。
        const fam = cssFontFamily(sigFont);
        if (fam) span.style.fontFamily = fam;
        ensureFontLoaded(sigFont);
      }
      if (typeof sigBold === "boolean") {
        // per-char 合成太字。layer 全体の inner.style.fontWeight より span が優先（CSS specificity）。
        span.style.fontWeight = sigBold ? "700" : "400";
      }
      if (typeof sigItalic === "boolean") {
        span.style.fontStyle = sigItalic ? "italic" : "normal";
      }
      if (fillCss) {
        span.style.color = fillCss;
        span.style.textShadow = "none";
      }
      if ((Number.isFinite(sigHScale) && sigHScale !== 100) || (Number.isFinite(sigVScale) && sigVScale !== 100)) {
        const sx = Number.isFinite(sigHScale) ? sigHScale / 100 : 1;
        const sy = Number.isFinite(sigVScale) ? sigVScale / 100 : 1;
        span.style.display = "inline-block";
        span.style.transform = `scale(${sx}, ${sy})`;
        span.style.transformOrigin = "center center";
      }
      span.textContent = text;
      parentEl.appendChild(span);
    } else {
      parentEl.appendChild(document.createTextNode(text));
    }
    i = j;
  }
}

// 【v1.16.0】行間/サイズ/フォントの per-line・per-char 描画統合。
// inner にテキストを描画する。
// - lineLeadings に override があれば 1 行ずつ <div> に分けて margin-block-start で per-line の
//   行間を表現する（行 N の値 = 行 N-1 と行 N の間隔のみ。CSS line-height ではなく
//   margin-block-start を使うことで「行自身のサイズや次の行との間隔は不変」を実現）。
// - charSizes / charFonts に override があれば各行内で文字ごとに span を作って per-char の
//   サイズ / フォントを反映する。
// - dashMille / tildeMille は連続記号のツメ（letter-spacing）を制御する。
// - tcyOn が ON かつ縦書きで !! / !? が含まれる場合は <span class="tcy-span"> でラップ。
// それ以外は単一テキストノードで描画（最軽量）。
// isVertical: true なら writing-mode: vertical-rl 想定で per-line の幅 (列幅) を切替える。
// defaultSizePt: layer 全体の sizePt（charSizes の em 換算に使う）。
function renderInnerText(inner, text, defaultLeadingPct, lineLeadings, dashMille, tildeMille, tcyOn, isVertical, charSizes, defaultSizePt, charFonts, symbolFontPS, charBolds, charItalics, punctTsumePct, charRubies, charHorizontalScales = null, charVerticalScales = null, trackingMille = 0, kerningMille = 0, charTrackings = null, charKernings = null, charTateChuYokos = null, charFillColors = null, layerHorizontalScale = 100, layerVerticalScale = 100) {
  inner.textContent = "";
  const overrides = lineLeadings && Object.keys(lineLeadings).length > 0 ? lineLeadings : null;
  const hasCharSizes = charSizes && Object.keys(charSizes).length > 0;
  const hasCharFonts = charFonts && Object.keys(charFonts).length > 0;
  const hasCharBolds = charBolds && Object.keys(charBolds).length > 0;
  const hasCharItalics = charItalics && Object.keys(charItalics).length > 0;
  const hasCharFillColors = charFillColors && Object.keys(charFillColors).length > 0;
  const hasCharScales = (charHorizontalScales && Object.keys(charHorizontalScales).length > 0)
    || (charVerticalScales && Object.keys(charVerticalScales).length > 0)
    || (Number.isFinite(layerHorizontalScale) && layerHorizontalScale !== 100)
    || (Number.isFinite(layerVerticalScale) && layerVerticalScale !== 100);
  const hasCharTateChuYokos = charTateChuYokos && Object.keys(charTateChuYokos).length > 0;
  const hasCharSpacings = (charTrackings && Object.keys(charTrackings).length > 0)
    || (charKernings && Object.keys(charKernings).length > 0);
  // 【v1.26.0】ruby 範囲 array に変換しておくと、appendLineWithTracking で line ごとに filter しやすい。
  const hasCharRubies = charRubies && Object.keys(charRubies).length > 0;
  // 【v1.26.0】親文字の `overflow: hidden`（new-layer-text / existing-layer-text 既定）が <ruby> の
  // <rt> 部分を切り取ってしまうため、ruby ある時は `.has-ruby` クラスを付けて overflow: visible に。
  const fullText = String(text ?? "");
  const lineCount = Math.max(1, countLines(fullText));
  const fallback = String(isVertical && lineCount <= 1 ? 1 : ((defaultLeadingPct ?? 125) / 100));
  const dashTrack = Number.isFinite(Number(dashMille)) ? Number(dashMille) : 0;
  const tildeTrack = Number.isFinite(Number(tildeMille)) ? Number(tildeMille) : 0;
  const baseTracking = Number.isFinite(Number(trackingMille)) ? Number(trackingMille) : 0;
  const baseKerning = Number.isFinite(Number(kerningMille)) ? Number(kerningMille) : 0;
  const trackingHits = (dashTrack !== 0 || tildeTrack !== 0) && REPEATED_TARGET_REGEX.test(fullText);
  const spacingHits = baseTracking !== 0 || baseKerning !== 0 || hasCharSpacings;
  const tcyHits = isVertical && ((!!tcyOn && fullText.split(/\r\n|\r|\n/).some((line) => findTcyPairs(line).length > 0)) || hasCharTateChuYokos);
  inner.classList.toggle("has-ruby", hasCharRubies);
  inner.classList.toggle("has-tcy", tcyHits);
  inner.classList.toggle("has-scale", hasCharScales);
  // 【v1.22.0】記号フォント置換: symbolFontPS が指定されており、対象記号が contents に含まれるとき適用。
  const symbolHits = (typeof symbolFontPS === "string" && symbolFontPS.length > 0) && lineHasSymbolChar(fullText);
  // 【v1.x.0】句読点ツメ（、 / 。 を tsume% で詰める）。punctTsumePct (0..100) → em 量に換算。
  const punctTsumeMag = Number.isFinite(punctTsumePct) && punctTsumePct > 0 ? punctTsumePct / 100 : 0;
  const punctHits = punctTsumeMag > 0 && lineHasPunctTsumeChar(fullText);
  // 高速パス：何も装飾なし（charBolds / 句読点ツメ / charRubies も含めて全部空のときだけ通る）
  if (!overrides && !trackingHits && !spacingHits && !tcyHits && !hasCharSizes && !hasCharFonts && !symbolHits && !hasCharBolds && !hasCharItalics && !hasCharFillColors && !hasCharScales && !punctHits && !hasCharRubies) {
    inner.textContent = fullText;
    inner.style.lineHeight = fallback;
    return;
  }
  const lines = fullText.split(/\r\n|\r|\n/);
  const lineStarts = getLineStartOffsets(fullText);
  inner.style.lineHeight = fallback;
  // Ruby alone must keep the newline text-node path. In vertical writing,
  // wrapping every line in block elements can hide later columns.
  if (overrides) {
    const layerFactor = (defaultLeadingPct ?? 125) / 100;
    for (let i = 0; i < lines.length; i++) {
      const lineEl = document.createElement("div");
      // この行の最大文字サイズ ratio（per-char override 反映）。layer サイズを 1 とした倍率。
      let lineMaxRatio = 1;
      if (hasCharSizes && Number.isFinite(defaultSizePt) && defaultSizePt > 0) {
        const startIdx = lineStarts[i] ?? 0;
        for (let k = 0; k < lines[i].length; k++) {
          const cs = charSizes[startIdx + k];
          if (Number.isFinite(cs) && cs > 0) {
            const ratio = cs / defaultSizePt;
            if (ratio > lineMaxRatio) lineMaxRatio = ratio;
          }
        }
      }
      const effectiveLineSize = layerFactor * lineMaxRatio;
      lineEl.style.lineHeight = String(effectiveLineSize);
      lineEl.style.display = "block";
      lineEl.style.boxSizing = "border-box";
      if (isVertical) {
        lineEl.style.width = `${effectiveLineSize}em`;
      } else {
        lineEl.style.minHeight = `${effectiveLineSize}em`;
      }
      // 行 i の override 値 = 行 i-1 と 行 i の隙間のみ（margin-block-start で表現）。
      // layer 全体の leadingFactor との差分だけを margin に追加する。
      // 行 0 は「前の行」が無いので override を無視。
      // lineLeadings[N] is stored on the previous line, matching Photoshop leading.
      if (i > 0 && Number.isFinite(overrides[i - 1])) {
        const overrideFactor = overrides[i - 1] / 100;
        const extra = overrideFactor - layerFactor;
        if (Math.abs(extra) > 0.001) {
          lineEl.style.marginBlockStart = `${extra}em`;
        }
      }
      appendLineWithTracking(lineEl, lines[i], lineStarts[i], dashTrack, tildeTrack, tcyOn, charSizes, defaultSizePt, charFonts, symbolFontPS, charBolds, charItalics, punctTsumeMag, charRubies, charHorizontalScales, charVerticalScales, baseTracking, baseKerning, charTrackings, charKernings, charTateChuYokos, charFillColors, layerHorizontalScale, layerVerticalScale);
      inner.appendChild(lineEl);
    }
  } else {
    // 【v1.21.0】<br> ではなく \n text node でセパレートする。WebView2 (Chromium) の
    // writing-mode: vertical-rl + text-orientation: mixed で <br> の column break が
    // 期待通り発火しないケース（行が前の column に続いてしまう）があるため、
    // white-space: pre が必ず尊重する \n text node に統一する。
    // 【v1.27.0】charRubies 引数の渡し忘れバグ修正: 旧コードはこの経路で第 13 引数を
    // 省略していたため、per-line leadingPct override 無しのレイヤー（大多数）で finalize
    // 後の rebuild 時にルビが描画されない不具合があった。上の overrides 経路と同じく
    // charRubies を渡すように修正。
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) inner.appendChild(document.createTextNode("\n"));
      appendLineWithTracking(inner, lines[i], lineStarts[i], dashTrack, tildeTrack, tcyOn, charSizes, defaultSizePt, charFonts, symbolFontPS, charBolds, charItalics, punctTsumeMag, charRubies, charHorizontalScales, charVerticalScales, baseTracking, baseKerning, charTrackings, charKernings, charTateChuYokos, charFillColors, layerHorizontalScale, layerVerticalScale);
    }
  }
}

function createStrokeBadgeSwatches(strokeColor, strokeWidthPx) {
  const activeColor = strokeColor === "white" || strokeColor === "black" ? strokeColor : "none";
  const hasStroke = activeColor !== "none" && Number(strokeWidthPx) > 0;
  const wrap = document.createElement("div");
  wrap.className = `layer-size-badge-stroke size-row${hasStroke ? "" : " layer-size-badge-stroke-empty"}`;
  wrap.setAttribute("role", "button");
  wrap.tabIndex = 0;
  wrap.setAttribute("aria-label", "フチ");
  wrap.title = "フチを変更";
  wrap.addEventListener("mousedown", onBadgeStrokeMouseDown);
  wrap.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    e.stopPropagation();
    const anchorRect = e.currentTarget.getBoundingClientRect();
    openLayerStrokePanel({ getBoundingClientRect: () => anchorRect });
  });
  const dot = document.createElement("span");
  dot.className = `stroke-dot stroke-dot-${activeColor} layer-size-badge-stroke-dot active`;
  dot.dataset.stroke = activeColor;
  wrap.appendChild(dot);
  return wrap;
}

function collectLayerSizeValues(defaultSizePt, charSizes) {
  const values = [];
  const seen = new Set();
  const add = (pt) => {
    const n = Number(pt);
    if (!Number.isFinite(n)) return;
    const key = String(Math.round(n * 100) / 100);
    if (seen.has(key)) return;
    seen.add(key);
    values.push(n);
  };
  add(defaultSizePt);
  for (const value of Object.values(charSizes ?? {})) add(value);
  return values;
}

// layer 内で実効的に使われるフォント (PostScript 名) のユニーク列を返す。
// 優先順は appendStyledSegment の effectiveFontAt と一致:
//   1. ユーザー手動の charFonts[i]
//   2. 記号自動置換 (SYMBOL_CHAR_CODES) で symbolFontPS が設定されていれば
//   3. layer 既定 (defaultFont)
// contents が空 / 未定義の場合は defaultFont のみ返す。
function collectLayerFontValues(defaultFont, charFonts, contents, symbolFontPS) {
  const seen = new Set();
  const result = [];
  const add = (font) => {
    if (typeof font !== "string" || !font) return;
    if (seen.has(font)) return;
    seen.add(font);
    result.push(font);
  };
  const text = typeof contents === "string" ? contents : "";
  if (!text) {
    add(defaultFont);
    return result;
  }
  const useSymbol = typeof symbolFontPS === "string" && !!symbolFontPS;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n" || ch === "\r") continue;
    const userFont = charFonts ? charFonts[String(i)] : null;
    if (typeof userFont === "string" && userFont) add(userFont);
    else if (useSymbol && SYMBOL_CHAR_CODES.has(text.charCodeAt(i))) add(symbolFontPS);
    else add(defaultFont);
  }
  // contents が改行のみ等で何も追加されなかった場合に保険として既定を追加。
  if (result.length === 0) add(defaultFont);
  return result;
}

function formatBadgeSizeLabel(sizePtOrValues, page) {
  const values = Array.isArray(sizePtOrValues) ? sizePtOrValues : [sizePtOrValues];
  return values
    .filter((pt) => Number.isFinite(Number(pt)))
    .map((pt) => {
      const display = toDisplaySizePt(Number(pt), page);
      return formatTextSizePt(display ?? 0, getTextSizeUnit(), true);
    })
    .join("/");
}

function onBadgeFontMouseDown(e, fontPostScriptName) {
  if (e.button !== 0 || !fontPostScriptName) return;
  e.preventDefault();
  e.stopPropagation();
  const anchorRect = e.currentTarget.getBoundingClientRect();
  commitFontToSelections(fontPostScriptName);
  openLayerFontPanel({ getBoundingClientRect: () => anchorRect }, fontPostScriptName);
}

function onBadgeSizeMouseDown(e) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const anchorRect = e.currentTarget.getBoundingClientRect();
  openLayerSizePanel({ getBoundingClientRect: () => anchorRect });
}

function onBadgeStrokeMouseDown(e) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const anchorRect = e.currentTarget.getBoundingClientRect();
  openLayerStrokePanel({ getBoundingClientRect: () => anchorRect });
}

function createSizeBadge(sizePt, page, fontPostScriptName, strokeColor = "none", strokeWidthPx = 20, options = {}) {
  // 環境設定（デフォルトタブ）でフォント名・文字サイズの表示/非表示を一括切替。
  // OFF の場合はバッジ自体を生成せず null を返し、呼び出し側で append をスキップする。
  const sizeOnly = options.sizeOnly === true;
  if (!options.forceVisible && getDefault("showBadge") === false) return null;

  const el = document.createElement("div");
  el.className = "layer-size-badge";
  if (sizeOnly) el.classList.add("layer-size-badge-size-only");
  // 基準PSD 比で換算した pt を表示。複数サイズ混在時は 13pt/15pt のように列挙する。
  const sizeLabel = formatBadgeSizeLabel(sizePt, page);
  // フォントは配列（複数フォント混在）と単一文字列の両方を受け付ける。
  // 混在ケース: layer 既定 + per-char overrides + 自動記号置換（♡ → 小塚ゴシック等）。
  const fontList = (Array.isArray(fontPostScriptName)
    ? fontPostScriptName
    : (fontPostScriptName ? [fontPostScriptName] : []))
    .filter((f) => typeof f === "string" && f);
  // フォント名と文字サイズを 2 行に分けて表示（フォント上 / サイズ下）。
  if (!sizeOnly && fontList.length > 0) {
    const fontEl = document.createElement("div");
    fontEl.className = "layer-size-badge-font";
    const labels = fontList.map((f) => getFontDisplayName(f) ?? f);
    if (fontList.length === 1) {
      fontEl.textContent = labels[0];
      fontEl.title = "フォントを変更";
      fontEl.addEventListener("mousedown", (e) => onBadgeFontMouseDown(e, fontList[0]));
    } else {
      // 複数フォント混在: 各フォントを行 <div> として並べる。バッジが縦長に
      // ならず横書きで読める。各行は個別にクリック可能 → その oldFont を持つ
      // 文字だけを新フォントに置換する起点に使える（案 A）。
      fontEl.classList.add("layer-size-badge-font-multi");
      fontEl.title = `フォント混在 (${labels.length}): ${labels.join(" / ")}`;
      labels.forEach((label, idx) => {
        const row = document.createElement("div");
        row.className = "layer-size-badge-font-row";
        row.textContent = label;
        row.title = label;
        const ps = fontList[idx];
        row.addEventListener("mousedown", (e) => onBadgeFontMouseDown(e, ps));
        fontEl.appendChild(row);
      });
    }
    el.appendChild(fontEl);
  }
  const sizeEl = document.createElement("div");
  sizeEl.className = "layer-size-badge-size";
  sizeEl.textContent = sizeLabel;
  sizeEl.title = "文字サイズを変更";
  sizeEl.addEventListener("mousedown", onBadgeSizeMouseDown);
  el.appendChild(sizeEl);
  if (!sizeOnly && options.rubyRemove?.hasRuby) {
    const rubyBtn = document.createElement("button");
    rubyBtn.type = "button";
    rubyBtn.className = "layer-size-badge-ruby-remove";
    rubyBtn.textContent = "ルビ削除";
    rubyBtn.title = "このテキストのルビを削除";
    rubyBtn.setAttribute("aria-label", "このテキストのルビを削除");
    rubyBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    rubyBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.dispatchEvent(new CustomEvent("psdesign:remove-ruby-from-property", {
        detail: options.rubyRemove,
      }));
    });
    el.appendChild(rubyBtn);
  }
  if (!sizeOnly) {
    const strokeBadge = createStrokeBadgeSwatches(strokeColor, strokeWidthPx);
    if (strokeBadge) el.appendChild(strokeBadge);
  }
  return el;
}

function createRotateHandle(ctx, layerId) {
  const el = document.createElement("div");
  el.className = "layer-rotate-handle";
  el.title = "ドラッグで回転（Shift で 15° スナップ）";
  el.addEventListener("mousedown", (e) => beginRotateDrag(e, ctx, layerId));
  return el;
}

function getLayerRotation(ctx, layerId) {
  if (typeof layerId === "string") {
    const nl = getNewLayersForPsd(ctx.page.path).find((l) => l.tempId === layerId);
    return nl?.rotation ?? 0;
  }
  const edit = getEdit(ctx.page.path, layerId) ?? {};
  return edit.rotation ?? 0;
}

function setLayerRotation(ctx, layerId, deg) {
  setLayerRotationForPage(ctx.page, layerId, deg);
}

function beginRotateDrag(e, ctx, layerId) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();

  const box = e.currentTarget.parentElement;
  if (!box) return;
  // CSS rotate は要素中心を保つ（変換中心は中心）。getBoundingClientRect は
  // 回転後の AABB を返すが、その中心は回転中心と一致する（rect 中心 = 元の中心）。
  const rect = box.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  const startRotation = getLayerRotation(ctx, layerId);
  const startAngle = Math.atan2(e.clientY - cy, e.clientX - cx) * 180 / Math.PI;

  const prevUserSelect = document.body.style.userSelect;
  const prevCursor = document.body.style.cursor;
  document.body.style.userSelect = "none";
  document.body.style.cursor = "grabbing";

  // 【v1.21.0】回転中の度数表示インジケータ。マウスカーソルの近くにフロート表示し、
  // ドラッグ中の現在角度（normalized: -180..180）を更新。Shift スナップ中は 15° 単位。
  const indicator = document.createElement("div");
  indicator.className = "rotate-degree-indicator";
  document.body.appendChild(indicator);
  const formatDeg = (deg) => {
    const normalized = ((deg + 180) % 360 + 360) % 360 - 180;
    return `${Math.round(normalized)}°`;
  };
  const updateIndicator = (deg, mouseX, mouseY) => {
    indicator.textContent = formatDeg(deg);
    // マウスカーソルの右下 16px オフセットに表示。画面端でクリッピングしないよう
    // 右端 / 下端近くは左側 / 上側に切替。
    const padding = 16;
    const rect = indicator.getBoundingClientRect();
    const w = rect.width || 60;
    const h = rect.height || 24;
    let x = mouseX + padding;
    let y = mouseY + padding;
    if (x + w > window.innerWidth) x = mouseX - w - padding;
    if (y + h > window.innerHeight) y = mouseY - h - padding;
    indicator.style.left = `${x}px`;
    indicator.style.top = `${y}px`;
  };
  updateIndicator(startRotation, e.clientX, e.clientY);

  let moved = false;
  beginHistoryTransient();
  const onMove = (ev) => {
    ev.preventDefault();
    const a = Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180 / Math.PI;
    let next = startRotation + (a - startAngle);
    if (ev.shiftKey) next = Math.round(next / 15) * 15;
    if (next !== startRotation) moved = true;
    setLayerRotation(ctx, layerId, next);
    refreshAllOverlays();
    updateIndicator(next, ev.clientX, ev.clientY);
  };
  const onUp = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    document.body.style.userSelect = prevUserSelect;
    document.body.style.cursor = prevCursor;
    indicator.remove();
    if (moved) commitHistoryTransient(); else abortHistoryTransient();
    rebuildLayerList();
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

function createBox(page, left, top, width, height, kind) {
  const el = document.createElement("div");
  el.className = `layer-box layer-box-${kind}`;
  el.style.left = `${(left / page.width) * 100}%`;
  el.style.top = `${(top / page.height) * 100}%`;
  el.style.width = `${(width / page.width) * 100}%`;
  el.style.height = `${(height / page.height) * 100}%`;
  return el;
}

function applyLayerBoxRotation(box, rotation) {
  const angle = Number(rotation) || 0;
  if (!box || angle === 0) return;
  box.style.transform = `rotate(${angle}deg) scale(var(--layer-edit-scale, 1))`;
}

// スクリーン空間の delta (dxS, dyS) を回転逆変換して「回転前のローカル空間」の delta に変換。
// rotation は CSS の rotate() 方向（時計回り正）。CSS 座標は y 下向きのため、90° 回転で
// ローカル (+x) は画面 (+y) に、ローカル (+y) は画面 (-x) に対応する。
function inverseRotateDelta(dxS, dyS, rotation) {
  switch (rotation) {
    case 90:  return { dx:  dyS, dy: -dxS };
    case 180: return { dx: -dxS, dy: -dyS };
    case 270: return { dx: -dyS, dy:  dxS };
    default:  return { dx:  dxS, dy:  dyS };
  }
}

function canvasCoordsFromEvent(e, ctx) {
  const rect = ctx.canvas.getBoundingClientRect();
  const rotation = getPsdRotation();
  const rotated90 = rotation === 90 || rotation === 270;
  // getBoundingClientRect は回転後の視覚 bbox を返すため、90/270 では W/H をスワップ。
  const W = rotated90 ? rect.height : rect.width;
  const H = rotated90 ? rect.width : rect.height;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const { dx: dxL, dy: dyL } = inverseRotateDelta(e.clientX - cx, e.clientY - cy, rotation);
  const scaleX = ctx.page.width / W;
  const scaleY = ctx.page.height / H;
  return {
    x: (W / 2 + dxL) * scaleX,
    y: (H / 2 + dyL) * scaleY,
    scaleX,
    scaleY,
  };
}

function onCanvasMouseDown(e, ctx) {
  const tool = getTool();
  if (tool === "pan") {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    // スクロールは #psd-stage に閉じている（ペイン本体は overflow:hidden で回転ボタンを固定）。
    const scroller = ctx.canvas.closest(".psd-stage");
    if (!scroller) return;
    panState = {
      canvas: ctx.canvas,
      scroller,
      startX: e.clientX,
      startY: e.clientY,
      scrollStart: { left: scroller.scrollLeft, top: scroller.scrollTop },
      prevUserSelect: document.body.style.userSelect,
    };
    document.body.style.userSelect = "none";
    ctx.canvas.style.cursor = "grabbing";
    return;
  }
  if (e.button !== 0) return;
  if (tool === "move") {
    if (rotateHandlesVisible) {
      e.preventDefault();
      hideRotateHandles(ctx);
      return;
    }
    // 1) アクティブな contenteditable 編集中レイヤーがあれば、外側クリックなら finalize。
    //    内側 (.editing 内) のクリックは contenteditable の caret 移動に委ねる
    //    （preventDefault しない／finalize しない）。
    const openEdit = document.querySelector(".layer-box.editing");
    if (openEdit) {
      // クリック対象が編集中レイヤー自身またはその子孫なら caret 移動に委ねる。
      if (openEdit === e.target || openEdit.contains(e.target)) return;
      // 外側クリック → 編集確定
      e.preventDefault();
      if (typeof openEdit.__finalize === "function") openEdit.__finalize(true);
      else openEdit.classList.remove("editing");
      return;
    }
    e.preventDefault();
    // 2) 原稿テキストブロック選択中のクリック配置は廃止。空所への 350ms 以内の
    //    2 回目クリック → 新規テキスト入力欄を開く。
    const { x, y } = canvasCoordsFromEvent(e, ctx);
    const now = Date.now();
    if (isCanvasDoubleClick(now, x, y)) {
      lastCanvasClickAt = 0; // 連続トリガを抑止（次の click は単独扱い）
      startTextInput(ctx, x, y, getNewTextDirection());
      return;
    }
    // 3) シングルクリック: 次回 dblclick 検出のため記録 + マーキー開始。
    lastCanvasClickAt = now;
    lastCanvasClickPos = { x, y };
    startMarquee(e, ctx);
  }
}

// canvas 上の同位置への 350ms 以内 + 5px 以内の 2 回目クリックを double-click と判定。
// 既存 `isLayerDoubleClick` の方針を踏襲し、レイヤー外（空所）専用に独立して持つ。
let lastCanvasClickAt = 0;
let lastCanvasClickPos = { x: 0, y: 0 };
function isCanvasDoubleClick(now, x, y) {
  if (lastCanvasClickAt === 0) return false;
  if (now - lastCanvasClickAt > 350) return false;
  const dx = x - lastCanvasClickPos.x;
  const dy = y - lastCanvasClickPos.y;
  if (dx * dx + dy * dy > 25) return false; // 5px^2
  return true;
}

function onCanvasMouseMove(e, ctx) {
  if (!panState) return;
  e.preventDefault();
  e.stopPropagation();
  const scroller = panState.scroller;
  if (!scroller) return;
  const dx = e.clientX - panState.startX;
  const dy = e.clientY - panState.startY;
  scroller.scrollLeft = panState.scrollStart.left - dx;
  scroller.scrollTop = panState.scrollStart.top - dy;
}

function onCanvasMouseUp(e, ctx) {
  if (!panState) return;
  e.preventDefault();
  e.stopPropagation();
  endPan();
}

function endPan() {
  if (!panState) return;
  const { canvas, prevUserSelect } = panState;
  document.body.style.userSelect = prevUserSelect;
  if (getTool() === "pan") canvas.style.cursor = "grab";
  panState = null;
}

// クリック位置がレイヤー矩形の中央になるよう top-left をオフセットする。
export function centerTopLeft(page, { contents, sizePt, direction, leadingPct, ...rest }, clickX, clickY) {
  const r = layerRectForNew(page, { x: 0, y: 0, contents, sizePt, direction, leadingPct, ...rest });
  return { x: clickX - r.width / 2, y: clickY - r.height / 2 };
}

function onLayerWheel(e, ctx, layerId) {
  // Alt+wheel はズーム、Ctrl/Meta+wheel はブラウザ既定（ページズーム等）に委ねる。
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const tool = getTool();
  if (tool !== "move") return;
  if (!isLayerSelected(ctx.pageIndex, layerId)) return;
  if (!resizeSelectedLayersFromWheel(e)) return;
  e.preventDefault();
  e.stopPropagation();
}

function onPageWheel(e, ctx) {
  if (!ctx) return;
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  if (getTool() !== "move") return;
  if (!getSelectedLayers().some((s) => s.pageIndex === ctx.pageIndex)) return;
  if (!resizeSelectedLayersFromWheel(e)) return;
  e.preventDefault();
  e.stopPropagation();
}

function resizeSelectedLayersFromWheel(e) {
  // 環境設定の「文字サイズの刻み」（0.1 / 0.5）を baseStep に、Shift で 10 倍。
  // off-grid な値（例：0.5 刻み設定で 12.3）は最寄りグリッドにスナップする。
  const configuredStep = Number(getDefault("textSizeStep"));
  const baseStep = configuredStep === 0.25 || configuredStep === 0.5 ? configuredStep : 0.1;
  const sign = e.deltaY < 0 ? +1 : -1;
  const multiplier = e.shiftKey ? 10 : 1;
  return resizeSelectedLayers(baseStep, sign, multiplier);
}

// edit-font 欄 / スタイルパレットでユーザーがフォントを選んだ後（fontPickerStuck === true）、
// move ツールでの単独クリック・shift クリック・マーキー選択や、サイド「レイヤー」一覧での
// 行クリック等、選択集合が確定した直後に呼ぶ。現在の選択リスト全体に currentFont を一括適用し、
// 1 件以上書き込まれたら true。false（apply しなかった）の場合、呼び出し側が
// rebuildLayerList / overlay 更新を行うこと。
export function maybeApplyStickyFont() {
  if (!getFontPickerStuck()) return false;
  const ps = getCurrentFont();
  if (!ps) return false;
  return commitFontToSelections(ps);
}

// 直近 mousedown のタイムスタンプとレイヤーキーで「同じレイヤーへの 2 連クリック」を検出する。
// 1 回目の mousedown で renderOverlay が走り box DOM が差し替わるため、ブラウザ既定の dblclick
// は発火しない（mousedown と mouseup のターゲットが食い違って click 自体が出ない）。タイミング
// での自前検出に切替える。
const DBLCLICK_THRESHOLD_MS = 350;
let lastLayerClickAt = 0;
let lastLayerClickKey = null;
const HOVER_SELECT_DELAY_MS = 400;
let hoverSelectTimer = null;
let hoverSelectToken = 0;

function isLayerDoubleClick(pageIndex, layerKey) {
  const now = performance.now();
  const composite = `${pageIndex}::${layerKey}`;
  const isDouble = (now - lastLayerClickAt) < DBLCLICK_THRESHOLD_MS && lastLayerClickKey === composite;
  lastLayerClickAt = now;
  lastLayerClickKey = composite;
  return isDouble;
}

function cancelHoverSelect() {
  hoverSelectToken += 1;
  if (hoverSelectTimer !== null) {
    clearTimeout(hoverSelectTimer);
    hoverSelectTimer = null;
  }
}

function scheduleHoverSelect(box, ctx, layerId) {
  if (getDefault("hoverSelectEnabled") === false) return;
  if (getTool() !== "move") return;
  if (box?.classList?.contains("editing")) return;
  if (isLayerSelected(ctx.pageIndex, layerId)) return;
  cancelHoverSelect();
  const token = hoverSelectToken;
  hoverSelectTimer = window.setTimeout(() => {
    hoverSelectTimer = null;
    if (token !== hoverSelectToken) return;
    if (!box.isConnected || !box.matches(":hover")) return;
    if (getDefault("hoverSelectEnabled") === false) return;
    if (getTool() !== "move") return;
    if (document.querySelector(".layer-box.editing")) return;
    if (isLayerSelected(ctx.pageIndex, layerId)) return;
    temporaryMultiSelectionAdornmentsVisible = false;
    temporarySizeOnlyBadgesVisible = false;
    showSelectedLayerBadges();
    setSelectedLayer(ctx.pageIndex, layerId);
    renderOverlay(ctx);
    rebuildLayerList();
  }, HOVER_SELECT_DELAY_MS);
}

function bindHoverSelect(box, ctx, layerId) {
  box.addEventListener("mouseenter", () => scheduleHoverSelect(box, ctx, layerId));
  box.addEventListener("mouseleave", cancelHoverSelect);
  box.addEventListener("mousedown", cancelHoverSelect);
}

// V（選択）ツール選択中にテキストフレームをダブルクリックすると、in-place 編集を開始する。
// T/Y ツールが廃止され V に統合された後は、ツール切替は不要（V に居続ける）。
// direction は対象レイヤー自身の direction に従って floater の見え方が決まる。
function enterInPlaceEditFromMove(ctx, target) {
  showSelectedLayerBadges();
  const layerKey = target.kind === "existing" ? target.layer.id : target.nl.tempId;
  const clearedAutoFontMarker = target.kind === "new"
    ? clearAutoFontMarkerForNewLayer(target.nl.tempId, target.nl)
    : false;
  setSelectedLayer(ctx.pageIndex, layerKey);
  renderOverlay(ctx);
  rebuildLayerList();
  if (clearedAutoFontMarker) renderTxtSourceViewer();
  startInPlaceEdit(ctx, target);
}

function lineIndexAtChar(text, index) {
  const head = String(text ?? "").slice(0, Math.max(0, index));
  return head.split(/\r\n|\r|\n/).length - 1;
}

function handleRenderedRubyMouseDown(e, ctx, target) {
  const rawTarget = e.target?.nodeType === Node.TEXT_NODE ? e.target.parentElement : e.target;
  const rt = rawTarget?.closest?.(".ruby-text");
  if (!rt || !e.currentTarget?.contains(rt)) return false;
  const start = Number(rt.dataset.rubyStart);
  const end = Number(rt.dataset.rubyEnd);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) return false;

  e.stopPropagation();
  e.preventDefault();
  temporaryMultiSelectionAdornmentsVisible = false;
  temporarySizeOnlyBadgesVisible = false;
  showSelectedLayerBadges();

  const isExisting = target.kind === "existing";
  const edit = isExisting ? (getEdit(ctx.page.path, target.layer.id) ?? {}) : {};
  const contents = isExisting
    ? String(edit.contents ?? target.layer.contents ?? target.layer.text ?? "")
    : String(target.nl.contents ?? "");
  const direction = isExisting
    ? (edit.direction ?? target.layer.direction ?? "horizontal")
    : (target.nl.direction ?? "vertical");
  const layerMeta = isExisting
    ? { psdPath: ctx.page.path, layerId: target.layer.id, direction: direction === "horizontal" ? "horizontal" : "vertical" }
    : { psdPath: ctx.page.path, tempId: target.nl.tempId, direction: direction === "horizontal" ? "horizontal" : "vertical" };
  const rubySel = {
    ...layerMeta,
    start,
    end,
    rubyOnly: true,
    rubyText: rt.dataset.rubyText ?? rt.textContent ?? "",
    rubyOverlay: rt.dataset.rubyOverlay === "true",
  };
  const layerKey = isExisting ? target.layer.id : target.nl.tempId;
  setSelectedLayer(ctx.pageIndex, layerKey);
  renderOverlay(ctx);
  rebuildLayerList();

  const lineIndex = lineIndexAtChar(contents, start);
  const totalLines = countLineBreaks(contents) + 1;
  setEditingContext({
    ...layerMeta,
    currentLineIndex: lineIndex,
    totalLines,
    contents,
    selectionStart: start,
    selectionEnd: end,
  });
  setLastInplaceSelection(null);
  setLastInplaceSelection(rubySel);
  window.dispatchEvent(new CustomEvent("psdesign:ruby-edit-request", { detail: rubySel }));
  return true;
}

function onExistingLayerMouseDown(e, ctx, layer) {
  const tool = getTool();
  if (tool !== "move") return;
  if (!e.currentTarget?.classList?.contains("editing") && handleRenderedRubyMouseDown(e, ctx, { kind: "existing", layer })) return;
  // 【v1.21.0】編集中レイヤー (.editing) のクリックは contenteditable のキャレット移動に
  // 委ねる。preventDefault しないことで「全選択中に文字の途中をクリック → キャレット移動」
  // という Photoshop / 通常 textarea と同じ挙動を取り戻す。
  if (e.currentTarget && e.currentTarget.classList.contains("editing")) return;
  e.stopPropagation();
  e.preventDefault();
  if (handleSelectedLayerBadgeVisibilityClick(e)) {
    setSelectedLayer(ctx.pageIndex, layer.id);
    renderOverlay(ctx);
    if (!maybeApplyStickyFont()) rebuildLayerList();
    return;
  }
  temporaryMultiSelectionAdornmentsVisible = false;
  temporarySizeOnlyBadgesVisible = false;
  showSelectedLayerBadges();
  if (isLayerDoubleClick(ctx.pageIndex, layer.id)) {
    enterInPlaceEditFromMove(ctx, { kind: "existing", layer });
    return;
  }
  if (e.shiftKey) {
    toggleLayerSelected(ctx.pageIndex, layer.id);
    renderOverlay(ctx);
    rebuildLayerList();
    return;
  }
  if (!isLayerSelected(ctx.pageIndex, layer.id)) {
    setSelectedLayer(ctx.pageIndex, layer.id);
    renderOverlay(ctx);
    if (!maybeApplyStickyFont()) rebuildLayerList();
  }
  beginMultiLayerDrag(e, ctx);
}

function onNewLayerMouseDown(e, ctx, nl) {
  const tool = getTool();
  if (tool !== "move") return;
  if (!e.currentTarget?.classList?.contains("editing") && handleRenderedRubyMouseDown(e, ctx, { kind: "new", nl })) return;
  // 編集中レイヤーのクリックは contenteditable に委ねる（上記 onExistingLayerMouseDown と同パターン）。
  if (e.currentTarget && e.currentTarget.classList.contains("editing")) return;
  e.stopPropagation();
  e.preventDefault();
  if (handleSelectedLayerBadgeVisibilityClick(e)) {
    setSelectedLayer(ctx.pageIndex, nl.tempId);
    renderOverlay(ctx);
    if (!maybeApplyStickyFont()) rebuildLayerList();
    return;
  }
  temporaryMultiSelectionAdornmentsVisible = false;
  temporarySizeOnlyBadgesVisible = false;
  showSelectedLayerBadges();
  if (isLayerDoubleClick(ctx.pageIndex, nl.tempId)) {
    enterInPlaceEditFromMove(ctx, { kind: "new", nl });
    return;
  }
  if (e.shiftKey) {
    toggleLayerSelected(ctx.pageIndex, nl.tempId);
    renderOverlay(ctx);
    rebuildLayerList();
    return;
  }
  if (!isLayerSelected(ctx.pageIndex, nl.tempId)) {
    setSelectedLayer(ctx.pageIndex, nl.tempId);
    renderOverlay(ctx);
    if (!maybeApplyStickyFont()) rebuildLayerList();
  }
  beginMultiLayerDrag(e, ctx);
}

function beginMultiLayerDrag(e, ctx) {
  const selections = getSelectedLayers().filter((s) => s.pageIndex === ctx.pageIndex);
  if (selections.length === 0) return;

  // Photoshop と同じ Alt+ドラッグ複製。ドラッグ開始時に各選択レイヤーの複製を
  // 同位置に作成し、items をその複製（kind:"new"）に差し替えて以降のプレビュー
  // と確定処理に乗せる。元レイヤーはそのまま残る。
  const isDuplicate = !!e.altKey;

  const items = [];
  if (isDuplicate) {
    beginHistoryTransient();
    const newSelections = [];
    const pageNumber = ctx.pageIndex + 1;
    const appendDuplicateToTxt = (text) => {
      const src = getTxtSource() ?? { name: "new-text.txt", content: "" };
      const { content, paragraphIndex } = appendBlockToCurrentPageContent(src.content, pageNumber, text);
      if (!Number.isInteger(paragraphIndex) || paragraphIndex < 0) return null;
      setTxtSource({ name: src.name, content });
      return { pageNumber, paragraphIndex };
    };
    for (const sel of selections) {
      if (typeof sel.layerId === "string") {
        const nl = getNewLayersForPsd(ctx.page.path).find((l) => l.tempId === sel.layerId);
        if (!nl) continue;
        const sourceTxtRef = appendDuplicateToTxt(nl.contents);
        const dup = addNewLayer({
          psdPath: nl.psdPath,
          x: nl.x,
          y: nl.y,
          contents: nl.contents,
          fontPostScriptName: nl.fontPostScriptName,
          sizePt: nl.sizePt,
          direction: nl.direction,
          strokeColor: nl.strokeColor,
          strokeWidthPx: nl.strokeWidthPx,
          fillColor: nl.fillColor,
          rotation: nl.rotation ?? 0,
          leadingPct: nl.leadingPct,
          horizontalScale: nl.horizontalScale ?? 100,
          verticalScale: nl.verticalScale ?? 100,
          trackingMille: nl.trackingMille ?? 0,
          kerningMille: nl.kerningMille ?? 0,
          syntheticBold: nl.syntheticBold === true,
          syntheticItalic: nl.syntheticItalic === true,
          sourceTxtRef,
          lineLeadings: nl.lineLeadings,
          charRubies: nl.charRubies,
          autoFontSwitched: nl.autoFontSwitched,
          autoFontSwitchBucket: nl.autoFontSwitchBucket,
          lowExtractTextMatch: nl.lowExtractTextMatch,
          extractMatchScore: nl.extractMatchScore,
          reuseTightThick: nl.reuseTightThick === true,
        });
        updateNewLayer(dup.tempId, {
          charSizes: { ...(nl.charSizes ?? {}) },
          charFonts: { ...(nl.charFonts ?? {}) },
          charBolds: { ...(nl.charBolds ?? {}) },
          charItalics: { ...(nl.charItalics ?? {}) },
          charHorizontalScales: { ...(nl.charHorizontalScales ?? {}) },
          charVerticalScales: { ...(nl.charVerticalScales ?? {}) },
          charTrackings: { ...(nl.charTrackings ?? {}) },
          charKernings: { ...(nl.charKernings ?? {}) },
          charTateChuYokos: { ...(nl.charTateChuYokos ?? {}) },
          charFillColors: { ...(nl.charFillColors ?? {}) },
        });
        items.push({ kind: "new", nl: dup, startX: dup.x, startY: dup.y, rotation: dup.rotation ?? 0 });
        newSelections.push({ pageIndex: ctx.pageIndex, layerId: dup.tempId });
      } else {
        const layer = ctx.page.textLayers.find((l) => l.id === sel.layerId);
        if (!layer) continue;
        const edit = getEdit(ctx.page.path, sel.layerId) ?? {};
        const dupX = (layer.left ?? 0) + (edit.dx ?? 0);
        const dupY = (layer.top ?? 0) + (edit.dy ?? 0);
        const contents = edit.contents ?? layer.text ?? "";
        const sourceTxtRef = appendDuplicateToTxt(contents);
        const dup = addNewLayer({
          psdPath: ctx.page.path,
          x: dupX,
          y: dupY,
          contents,
          fontPostScriptName: edit.fontPostScriptName ?? layer.font ?? null,
          sizePt: edit.sizePt ?? layer.fontSize ?? null,
          direction: edit.direction ?? layer.direction ?? "horizontal",
          strokeColor: edit.strokeColor ?? layer.strokeColor ?? "none",
          strokeWidthPx: edit.strokeWidthPx ?? layer.strokeWidthPx ?? 20,
          fillColor: edit.fillColor ?? layer.fillColor ?? "default",
          rotation: edit.rotation ?? 0,
          leadingPct: edit.leadingPct ?? 125,
          horizontalScale: edit.horizontalScale ?? layer.horizontalScale ?? 100,
          verticalScale: edit.verticalScale ?? layer.verticalScale ?? 100,
          trackingMille: edit.trackingMille ?? layer.trackingMille ?? 0,
          kerningMille: edit.kerningMille ?? layer.kerningMille ?? 0,
          syntheticBold: edit.syntheticBold === true,
          syntheticItalic: edit.syntheticItalic === true,
          sourceTxtRef,
          lineLeadings: edit.lineLeadings,
          charRubies: edit.charRubies,
        });
        updateNewLayer(dup.tempId, {
          charSizes: { ...(layer.charSizes ?? {}), ...(edit.charSizes ?? {}) },
          charFonts: { ...(edit.charFonts ?? layer.charFonts ?? {}) },
          charBolds: { ...(edit.charBolds ?? {}) },
          charItalics: { ...(edit.charItalics ?? {}) },
          charHorizontalScales: { ...(layer.charHorizontalScales ?? {}), ...(edit.charHorizontalScales ?? {}) },
          charVerticalScales: { ...(layer.charVerticalScales ?? {}), ...(edit.charVerticalScales ?? {}) },
          charTrackings: { ...(layer.charTrackings ?? {}), ...(edit.charTrackings ?? {}) },
          charKernings: { ...(layer.charKernings ?? {}), ...(edit.charKernings ?? {}) },
          charTateChuYokos: { ...(layer.charTateChuYokos ?? {}), ...(edit.charTateChuYokos ?? {}) },
          charFillColors: { ...(layer.charFillColors ?? {}), ...(edit.charFillColors ?? {}) },
        });
        items.push({ kind: "new", nl: dup, startX: dup.x, startY: dup.y, rotation: dup.rotation ?? 0 });
        newSelections.push({ pageIndex: ctx.pageIndex, layerId: dup.tempId });
      }
    }
    if (items.length === 0) {
      abortHistoryTransient();
      return;
    }
    setSelectedLayers(newSelections);
    renderOverlay(ctx);
    rebuildLayerList();
  } else {
    for (const sel of selections) {
      if (typeof sel.layerId === "string") {
        const nl = getNewLayersForPsd(ctx.page.path).find((l) => l.tempId === sel.layerId);
        if (nl) items.push({ kind: "new", nl, startX: nl.x, startY: nl.y, rotation: nl.rotation ?? 0 });
      } else {
        const layer = ctx.page.textLayers.find((l) => l.id === sel.layerId);
        if (layer) {
          const edit = getEdit(ctx.page.path, sel.layerId) ?? {};
          items.push({ kind: "existing", layer, rotation: edit.rotation ?? 0 });
        }
      }
    }
    if (items.length === 0) return;
  }

  const startClientX = e.clientX;
  const startClientY = e.clientY;
  const rect = ctx.canvas.getBoundingClientRect();
  const rotation = getPsdRotation();
  const rotated90 = rotation === 90 || rotation === 270;
  // 回転前の canvas CSS 寸法。
  const W = rotated90 ? rect.height : rect.width;
  const H = rotated90 ? rect.width : rect.height;
  const scaleX = ctx.page.width / W;
  const scaleY = ctx.page.height / H;
  const pxScaleX = W / ctx.page.width;
  const pxScaleY = H / ctx.page.height;
  const prevUserSelect = document.body.style.userSelect;
  const prevCursor = document.body.style.cursor;
  document.body.style.userSelect = "none";
  if (isDuplicate) document.body.style.cursor = "copy";
  ctx.overlay.classList.add("layers-moving");

  // swap モード判定用：単一選択 + Alt 複製でないときのみ swap 可能。
  const isSingleMoveDrag = !isDuplicate && items.length === 1;
  const dragged = isSingleMoveDrag ? items[0] : null;
  // ドラッグ開始時点の被ドラッグレイヤーの絶対 PSD rect（aStart）。
  // 既存レイヤーの edit.dx/dy は開始時の値で固定される（layerRectForExisting が反映済み）。
  const aStartRect = dragged
    ? (dragged.kind === "existing"
      ? layerRectForExisting(ctx.page, dragged.layer, getEdit(ctx.page.path, dragged.layer.id) ?? {})
      : layerRectForNew(ctx.page, dragged.nl))
    : null;
  const draggedKey = dragged
    ? (dragged.kind === "existing"
      ? { kind: "existing", id: dragged.layer.id }
      : { kind: "new", id: dragged.nl.tempId })
    : null;
  let lastSwapTarget = null;
  let swapGhostEl = null;
  let dragActivated = false;
  const swapTargetKey = (t) => (
    t ? `${t.kind}:${t.kind === "existing" ? t.layer.id : t.nl.tempId}` : null
  );

  // 入れ替え対象 B が存在するときの視覚フィードバックを適用/解除。
  //   - 既存の `.swap-target` リング（緑）を B 側に付ける
  //   - A の元位置中心 + B のサイズで点線 ghost を表示（B の入れ替え後 着地位置）
  const applySwapVisuals = (target) => {
    setSwapTargetHighlight(ctx, target);
    if (target) {
      const bRect = target.kind === "existing"
        ? layerRectForExisting(ctx.page, target.layer, getEdit(ctx.page.path, target.layer.id) ?? {})
        : layerRectForNew(ctx.page, target.nl);
      const aCenterX = aStartRect.left + aStartRect.width / 2;
      const aCenterY = aStartRect.top + aStartRect.height / 2;
      const ghostLeft = aCenterX - bRect.width / 2;
      const ghostTop = aCenterY - bRect.height / 2;
      if (!swapGhostEl) {
        swapGhostEl = document.createElement("div");
        swapGhostEl.className = "swap-ghost";
        ctx.overlay.appendChild(swapGhostEl);
      }
      swapGhostEl.style.left = `${(ghostLeft / ctx.page.width) * 100}%`;
      swapGhostEl.style.top = `${(ghostTop / ctx.page.height) * 100}%`;
      swapGhostEl.style.width = `${(bRect.width / ctx.page.width) * 100}%`;
      swapGhostEl.style.height = `${(bRect.height / ctx.page.height) * 100}%`;
    } else if (swapGhostEl) {
      swapGhostEl.remove();
      swapGhostEl = null;
    }
  };

  const computePsdDelta = (ev) => {
    const { dx, dy } = inverseRotateDelta(
      ev.clientX - startClientX,
      ev.clientY - startClientY,
      rotation,
    );
    return { ddx: dx * scaleX, ddy: dy * scaleY };
  };

  const suppressDefault = (ev) => ev.preventDefault();
  // overlay 自体が回転済みのため、translate() は PSD 空間（= 回転前ローカル）ピクセル量で与える。
  const applyPreview = (ddx, ddy) => {
    for (const item of items) {
      if (item.kind === "existing") {
        const boxEl = ctx.overlay.querySelector(`.layer-box-existing[data-layer-id="${item.layer.id}"]`);
        if (boxEl) {
          const rot = item.rotation ? ` rotate(${item.rotation}deg)` : "";
          boxEl.style.transform = `translate(${ddx * pxScaleX}px, ${ddy * pxScaleY}px)${rot}`;
        }
      } else {
        const boxEl = ctx.overlay.querySelector(`.layer-box-new[data-temp-id="${item.nl.tempId}"]`);
        if (boxEl) {
          boxEl.style.left = `${((item.startX + ddx) / ctx.page.width) * 100}%`;
          boxEl.style.top = `${((item.startY + ddy) / ctx.page.height) * 100}%`;
        }
      }
    }
  };
  const onMove = (ev) => {
    ev.preventDefault();
    const movedScreenX = ev.clientX - startClientX;
    const movedScreenY = ev.clientY - startClientY;
    if (!dragActivated) {
      if ((movedScreenX * movedScreenX + movedScreenY * movedScreenY) < (LAYER_DRAG_THRESHOLD_PX * LAYER_DRAG_THRESHOLD_PX)) {
        return;
      }
      dragActivated = true;
    }
    const { ddx, ddy } = computePsdDelta(ev);
    applyPreview(ddx, ddy);
    if (!isSingleMoveDrag) return;
    const cx = aStartRect.left + aStartRect.width / 2 + ddx;
    const cy = aStartRect.top + aStartRect.height / 2 + ddy;
    const next = findSwapTarget(ctx, draggedKey, cx, cy);
    if (swapTargetKey(next) !== swapTargetKey(lastSwapTarget)) {
      applySwapVisuals(next);
      document.body.style.cursor = next ? "alias" : prevCursor;
      lastSwapTarget = next;
    }
  };
  const onUp = (ev) => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    window.removeEventListener("dragstart", suppressDefault, true);
    window.removeEventListener("selectstart", suppressDefault, true);
    document.body.style.userSelect = prevUserSelect;
    ctx.overlay.classList.remove("layers-moving");
    if (isDuplicate || lastSwapTarget) document.body.style.cursor = prevCursor;
    // swap モード中の hover ハイライト残骸を必ず掃除（refreshAllOverlays でも再構築されるが
    // 通常移動分岐では DOM が再生成されないため明示的に外す）。
    applySwapVisuals(null);
    if (!dragActivated) {
      refreshAllOverlays();
      rebuildLayerList();
      return;
    }
    const { ddx, ddy } = computePsdDelta(ev);
    if (isDuplicate) {
      // 複製は開始時点で beginHistoryTransient 済み。移動量があれば位置も確定し、
      // 移動量ゼロでも複製自体は残るため必ず commit して 1 つの履歴ステップにする。
      if (ddx !== 0 || ddy !== 0) {
        for (const item of items) {
          // 複製はすべて kind:"new"。
          updateNewLayer(item.nl.tempId, { x: item.startX + ddx, y: item.startY + ddy });
        }
      }
      commitHistoryTransient();
    } else if (isSingleMoveDrag && (ddx !== 0 || ddy !== 0)) {
      // mouseup 時点で再判定（mousemove 最終フレームと mouseup の差を吸収）。
      const cx = aStartRect.left + aStartRect.width / 2 + ddx;
      const cy = aStartRect.top + aStartRect.height / 2 + ddy;
      const target = findSwapTarget(ctx, draggedKey, cx, cy);
      if (target) {
        performSwap(ctx, dragged, aStartRect, target);
      } else {
        beginHistoryTransient();
        if (dragged.kind === "existing") {
          addEditOffset(ctx.page.path, dragged.layer.id, ddx, ddy);
        } else {
          updateNewLayer(dragged.nl.tempId, { x: dragged.startX + ddx, y: dragged.startY + ddy });
        }
        commitHistoryTransient();
      }
    } else if (ddx !== 0 || ddy !== 0) {
      beginHistoryTransient();
      for (const item of items) {
        if (item.kind === "existing") {
          addEditOffset(ctx.page.path, item.layer.id, ddx, ddy);
        } else {
          updateNewLayer(item.nl.tempId, { x: item.startX + ddx, y: item.startY + ddy });
        }
      }
      commitHistoryTransient();
    }
    refreshAllOverlays();
    rebuildLayerList();
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  window.addEventListener("dragstart", suppressDefault, true);
  window.addEventListener("selectstart", suppressDefault, true);
}

function startMarquee(e, ctx) {
  const { x, y } = canvasCoordsFromEvent(e, ctx);
  const additive = e.shiftKey;
  const initialSelection = additive ? getSelectedLayers().slice() : [];
  if (!additive) {
    setSelectedLayers([]);
    renderOverlay(ctx);
    rebuildLayerList();
  }
  marqueeState = { ctx, startX: x, startY: y, currentX: x, currentY: y, additive, initialSelection };
  drawMarquee();

  const prevUserSelect = document.body.style.userSelect;
  document.body.style.userSelect = "none";

  const suppressDefault = (ev) => ev.preventDefault();
  const onMove = (ev) => {
    if (!marqueeState) return;
    ev.preventDefault();
    const pos = canvasCoordsFromEvent(ev, ctx);
    marqueeState.currentX = pos.x;
    marqueeState.currentY = pos.y;
    drawMarquee();
  };
  const onUp = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    window.removeEventListener("dragstart", suppressDefault, true);
    window.removeEventListener("selectstart", suppressDefault, true);
    document.body.style.userSelect = prevUserSelect;
    finalizeMarquee();
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  window.addEventListener("dragstart", suppressDefault, true);
  window.addEventListener("selectstart", suppressDefault, true);
}

function drawMarquee() {
  if (!marqueeState) return;
  const { ctx, startX, startY, currentX, currentY } = marqueeState;
  let el = ctx.overlay.querySelector(".marquee-rect");
  if (!el) {
    el = document.createElement("div");
    el.className = "marquee-rect";
    ctx.overlay.appendChild(el);
  }
  const left = Math.min(startX, currentX);
  const top = Math.min(startY, currentY);
  const w = Math.abs(currentX - startX);
  const h = Math.abs(currentY - startY);
  el.style.left = `${(left / ctx.page.width) * 100}%`;
  el.style.top = `${(top / ctx.page.height) * 100}%`;
  el.style.width = `${(w / ctx.page.width) * 100}%`;
  el.style.height = `${(h / ctx.page.height) * 100}%`;
}

function finalizeMarquee() {
  if (!marqueeState) return;
  const { ctx, startX, startY, currentX, currentY, additive, initialSelection } = marqueeState;
  marqueeState = null;
  const existingEl = ctx.overlay.querySelector(".marquee-rect");
  if (existingEl) existingEl.remove();

  const tinyClick = Math.abs(currentX - startX) < 2 && Math.abs(currentY - startY) < 2;
  if (tinyClick) {
    temporaryMultiSelectionAdornmentsVisible = false;
    temporarySizeOnlyBadgesVisible = false;
    if (!additive) {
      setSelectedLayers([]);
      renderOverlay(ctx);
      rebuildLayerList();
    }
    return;
  }

  const selRect = {
    left: Math.min(startX, currentX),
    top: Math.min(startY, currentY),
    right: Math.max(startX, currentX),
    bottom: Math.max(startY, currentY),
  };
  const hits = collectLayerHits(ctx, selRect);
  let final;
  if (additive) {
    final = initialSelection.slice();
    for (const h of hits) {
      if (!final.some((s) => s.pageIndex === h.pageIndex && s.layerId === h.layerId)) {
        final.push(h);
      }
    }
  } else {
    final = hits;
  }
  setSelectedLayers(final);
  if (final.length > 1) {
    revealLayerAdornmentsForTemporaryMultiSelection();
  } else {
    temporaryMultiSelectionAdornmentsVisible = false;
    temporarySizeOnlyBadgesVisible = false;
  }
  renderOverlay(ctx);
  if (!maybeApplyStickyFont()) rebuildLayerList();
}

function collectLayerHits(ctx, selRect) {
  const { page, pageIndex } = ctx;
  const hits = [];
  for (const layer of page.textLayers) {
    const edit = getEdit(page.path, layer.id) ?? {};
    if (edit.deleted === true) continue;
    const lrect = layerRectForExisting(page, layer, edit);
    if (rectsIntersect(selRect, lrect)) hits.push({ pageIndex, layerId: layer.id });
  }
  for (const nl of getNewLayersForPsd(page.path)) {
    const lrect = layerRectForNew(page, nl);
    if (rectsIntersect(selRect, lrect)) hits.push({ pageIndex, layerId: nl.tempId });
  }
  return hits;
}

// V ツールでテキストフレームを別フレームの上にドロップしたとき、両者の位置を
// 入れ替える（swap）ためのヘルパ群。単一選択ドラッグ（Alt 複製ではない）の
// ときだけ有効化される。

// ドラッグ中レイヤーの中心点 (centerXPsd, centerYPsd) を含むレイヤーを探す。
// draggedKey と一致するレイヤーは自己除外。最初のヒット 1 件を返す（既存→新規の順）。
function findSwapTarget(ctx, draggedKey, centerXPsd, centerYPsd) {
  const tinyRect = {
    left: centerXPsd - 0.5,
    top: centerYPsd - 0.5,
    right: centerXPsd + 0.5,
    bottom: centerYPsd + 0.5,
  };
  for (const layer of ctx.page.textLayers) {
    if (draggedKey.kind === "existing" && layer.id === draggedKey.id) continue;
    const edit = getEdit(ctx.page.path, layer.id) ?? {};
    if (edit.deleted === true) continue;
    const lrect = layerRectForExisting(ctx.page, layer, edit);
    if (rectsIntersect(tinyRect, lrect)) return { kind: "existing", layer };
  }
  for (const nl of getNewLayersForPsd(ctx.page.path)) {
    if (draggedKey.kind === "new" && nl.tempId === draggedKey.id) continue;
    const lrect = layerRectForNew(ctx.page, nl);
    if (rectsIntersect(tinyRect, lrect)) return { kind: "new", nl };
  }
  return null;
}

// hover 中の swap ターゲットに `.swap-target` クラスを付ける/外す。
// refreshAllOverlays は呼ばず、対象 box の DOM だけを直接触る。
function setSwapTargetHighlight(ctx, target) {
  const prev = ctx.overlay.querySelector(".layer-box.swap-target");
  if (prev) prev.classList.remove("swap-target");
  if (!target) return;
  let el = null;
  if (target.kind === "existing") {
    el = ctx.overlay.querySelector(`.layer-box-existing[data-layer-id="${target.layer.id}"]`);
  } else {
    el = ctx.overlay.querySelector(`.layer-box-new[data-temp-id="${target.nl.tempId}"]`);
  }
  if (el) el.classList.add("swap-target");
}

// 被ドラッグレイヤー A とターゲット B の位置を交換する。
// aStartRect は A のドラッグ開始時点の絶対 PSD rect、target は最新の B 情報。
// A と B でサイズ（幅・高さ）が異なる場合、左上 (left/top) ではなく
// **中心 (center)** を入れ替える。これによりサイズ差があっても各フレームが
// 元々あった位置の中央に収まる（吹き出し中央同士のスワップとして自然）。
// 既存レイヤーは差分加算 (addEditOffset)、新規レイヤーは絶対値上書き (updateNewLayer)
// を用い、begin/commitHistoryTransient で 1 history snapshot に集約する。
function performSwap(ctx, dragged, aStartRect, target) {
  const path = ctx.page.path;
  // ターゲット B の現在 rect（最新の絶対座標 + 幅高さ）を取得。
  let bRect;
  if (target.kind === "existing") {
    const bEdit = getEdit(path, target.layer.id) ?? {};
    bRect = layerRectForExisting(ctx.page, target.layer, bEdit);
  } else {
    bRect = layerRectForNew(ctx.page, target.nl);
  }
  // 中心点（A は開始時、B は現在）。
  const aCenterX = aStartRect.left + aStartRect.width / 2;
  const aCenterY = aStartRect.top + aStartRect.height / 2;
  const bCenterX = bRect.left + bRect.width / 2;
  const bCenterY = bRect.top + bRect.height / 2;
  // A の新 left/top（中心を B の中心に揃える → A 自身の半サイズを引く）。
  const aNewLeft = bCenterX - aStartRect.width / 2;
  const aNewTop = bCenterY - aStartRect.height / 2;
  // B の新 left/top（中心を A の元中心に揃える → B 自身の半サイズを引く）。
  const bNewLeft = aCenterX - bRect.width / 2;
  const bNewTop = aCenterY - bRect.height / 2;

  beginHistoryTransient();
  // A → B の中心へ
  if (dragged.kind === "existing") {
    addEditOffset(path, dragged.layer.id, aNewLeft - aStartRect.left, aNewTop - aStartRect.top);
  } else {
    updateNewLayer(dragged.nl.tempId, { x: aNewLeft, y: aNewTop });
  }
  // B → A の元中心へ
  if (target.kind === "existing") {
    addEditOffset(path, target.layer.id, bNewLeft - bRect.left, bNewTop - bRect.top);
  } else {
    updateNewLayer(target.nl.tempId, { x: bNewLeft, y: bNewTop });
  }
  commitHistoryTransient();
}

// 【v1.21.0】contenteditable ベースの in-place 編集ヘルパ。
// 旧 createTextFloater (textarea) を置換し、レイヤーの text element 自身を直接編集対象にする。
// Photoshop ポイントテキスト同様に「テキスト本体にカーソルが入って打ち換える」UX を実現。
//
// 戦略:
//   1. text element に contenteditable=true + .editing class を付ける
//   2. per-char span 構造を解除して plain text 化（IME / 削除挿入による DOM 破壊リスクを排除）
//   3. Enter は <br>/<div> 自動挿入を抑止して \n text node を手動挿入
//   4. paste は plain text 限定
//   5. input イベントで文字列差分を計算し charSizes/charFonts/lineLeadings の index を re-map
//   6. 確定時に既存の renderInnerText で per-char span を再構築
//
// target = { kind: "existing"|"new", layer? | nl? } は startInPlaceEdit と同形式。
// options:
//   selectAll: 開始時に全選択（既存編集打ち換え向け）
//   onCommit(newContents): 確定時のフック（center-fix 補正等を行う）
//   onCancel(): Esc / blur で finalize されたが commit しないときのフック（新規空レイヤー削除等）
//   afterCommit(newContents): commit 後に呼ばれる外部同期フック（原稿テキスト書換等）
function startContentEditableEdit(ctx, target, options = {}) {
  const { page } = ctx;
  const isExisting = target.kind === "existing";

  // 1. レイヤー DOM (.layer-box-existing[data-layer-id] / .layer-box-new[data-temp-id]) を解決
  const layerKey = isExisting ? String(target.layer.id) : String(target.nl.tempId);
  const escapedKey = (typeof CSS !== "undefined" && CSS.escape) ? CSS.escape(layerKey) : layerKey;
  const boxSelector = isExisting
    ? `.layer-box-existing[data-layer-id="${escapedKey}"]`
    : `.layer-box-new[data-temp-id="${escapedKey}"]`;
  const box = ctx.overlay.querySelector(boxSelector);
  if (!box) return null;
  const inner = box.querySelector(".existing-layer-text:not(.stroke-preview-underlay), .new-layer-text:not(.stroke-preview-underlay)");
  if (!inner) return null;
  // Preview-only vertical anchoring uses a transform on single-column text.
  // Clear it before contenteditable starts so caret geometry is not shifted.
  resetTextPreviewTransform(box);
  for (const underlay of Array.from(box.querySelectorAll(".stroke-preview-underlay"))) {
    underlay.remove();
  }
  inner.classList.remove("stroke-preview-fill");

  // 2. 開始時点のスナップショット（cancel 時の復元用）
  const startEdit = isExisting ? (getEdit(page.path, target.layer.id) ?? {}) : null;
  const startContents = normalizedEditableText(isExisting
    ? (startEdit.contents ?? target.layer.text ?? "")
    : (target.nl.contents ?? ""));
  const editStrokeColor = isExisting
    ? (startEdit.strokeColor ?? target.layer.strokeColor ?? "none")
    : (target.nl.strokeColor ?? "none");
  const editStrokeWidthPx = isExisting
    ? (startEdit.strokeWidthPx ?? target.layer.strokeWidthPx ?? 20)
    : (target.nl.strokeWidthPx ?? 20);

  // 縦書きレイヤーの半角→全角自動変換 direction（edit 開始時に一度だけ確定。
  // edit 中の direction 変更は対象外）。readContents 内で maybeConvert に渡される。
  const editDirection = isExisting
    ? ((startEdit?.direction) ?? target.layer.direction ?? "horizontal")
    : (target.nl.direction ?? "vertical");
  const startLineLeadings = isExisting
    ? { ...(startEdit.lineLeadings ?? {}) }
    : { ...(target.nl.lineLeadings ?? {}) };
  const startCharSizes = isExisting
    ? { ...(target.layer.charSizes ?? {}), ...(startEdit.charSizes ?? {}) }
    : { ...(target.nl.charSizes ?? {}) };
  const startCharFonts = isExisting
    ? { ...(startEdit.charFonts ?? target.layer.charFonts ?? {}) }
    : { ...(target.nl.charFonts ?? {}) };
  const startCharBolds = isExisting
    ? { ...(startEdit.charBolds ?? {}) }
    : { ...(target.nl.charBolds ?? {}) };
  const startCharItalics = isExisting
    ? { ...(startEdit.charItalics ?? {}) }
    : { ...(target.nl.charItalics ?? {}) };
  const startCharRubies = isExisting
    ? { ...(startEdit.charRubies ?? {}) }
    : { ...(target.nl.charRubies ?? {}) };
  const startCharHorizontalScales = isExisting
    ? { ...(target.layer.charHorizontalScales ?? {}), ...(startEdit.charHorizontalScales ?? {}) }
    : { ...(target.nl.charHorizontalScales ?? {}) };
  const startCharVerticalScales = isExisting
    ? { ...(target.layer.charVerticalScales ?? {}), ...(startEdit.charVerticalScales ?? {}) }
    : { ...(target.nl.charVerticalScales ?? {}) };
  const startCharTrackings = isExisting
    ? { ...(target.layer.charTrackings ?? {}), ...(startEdit.charTrackings ?? {}) }
    : { ...(target.nl.charTrackings ?? {}) };
  const startCharKernings = isExisting
    ? { ...(target.layer.charKernings ?? {}), ...(startEdit.charKernings ?? {}) }
    : { ...(target.nl.charKernings ?? {}) };
  const startCharTateChuYokos = isExisting
    ? { ...(target.layer.charTateChuYokos ?? {}), ...(startEdit.charTateChuYokos ?? {}) }
    : { ...(target.nl.charTateChuYokos ?? {}) };
  const startCharFillColors = isExisting
    ? { ...(target.layer.charFillColors ?? {}), ...(startEdit.charFillColors ?? {}) }
    : { ...(target.nl.charFillColors ?? {}) };
  // 位置（x,y / dx,dy）も snapshot。recenterBox が edit 中に書き換えるので、
  // cancel 時に元の位置に戻すために必要。
  const startDx = isExisting ? (startEdit.dx ?? 0) : null;
  const startDy = isExisting ? (startEdit.dy ?? 0) : null;
  const startX = isExisting ? null : (target.nl.x ?? 0);
  const startY = isExisting ? null : (target.nl.y ?? 0);

  // 3. per-char span 構造を解除し plain text 化
  if (isExisting) {
    const defaultLeadPct = Number.isFinite(startEdit.leadingPct) ? startEdit.leadingPct : 105;
    const tcyEnabled = getDefault("tateChuYokoEnabled") !== false;
    const symbolFontPS = getDefault("symbolFontReplaceEnabled") !== false
      ? String(getDefault("symbolFontPostScriptName") || "")
      : "";
    const punctTsumePct = Number(getDefault("punctuationTsumePercent")) || 0;
    const existingSizePt = getExistingLayerEffectiveSizePt(page, target.layer, startEdit);
    renderInnerText(
      inner, startContents, defaultLeadPct, startLineLeadings, 0, 0,
      tcyEnabled && editDirection === "vertical",
      editDirection === "vertical",
      startCharSizes, existingSizePt, startCharFonts,
      symbolFontPS,
      startCharBolds,
      startCharItalics,
      punctTsumePct,
      startCharRubies,
      startCharHorizontalScales,
      startCharVerticalScales,
      startEdit.trackingMille ?? target.layer.trackingMille ?? 0,
      startEdit.kerningMille ?? target.layer.kerningMille ?? 0,
      startCharTrackings,
      startCharKernings,
      startCharTateChuYokos,
      startCharFillColors,
      startEdit.horizontalScale ?? target.layer.horizontalScale ?? 100,
      startEdit.verticalScale ?? target.layer.verticalScale ?? 100,
    );
  } else {
    const dashMille = Number(getDefault("dashRunTrackingMille")) || 0;
    const tildeMille = Number(getDefault("tildeRunKerningMille")) || 0;
    const tcyEnabled = getDefault("tateChuYokoEnabled") !== false;
    const symbolFontPS = getDefault("symbolFontReplaceEnabled") !== false
      ? String(getDefault("symbolFontPostScriptName") || "")
      : "";
    const punctTsumePct = Number(getDefault("punctuationTsumePercent")) || 0;
    renderInnerText(
      inner, startContents, target.nl.leadingPct ?? 125, startLineLeadings, dashMille, tildeMille,
      tcyEnabled && editDirection === "vertical",
      editDirection === "vertical",
      startCharSizes, target.nl.sizePt ?? 24, startCharFonts,
      symbolFontPS,
      startCharBolds,
      startCharItalics,
      punctTsumePct,
      startCharRubies,
      startCharHorizontalScales,
      startCharVerticalScales,
      target.nl.trackingMille ?? 0,
      target.nl.kerningMille ?? 0,
      startCharTrackings,
      startCharKernings,
      startCharTateChuYokos,
      startCharFillColors,
      target.nl.horizontalScale ?? 100,
      target.nl.verticalScale ?? 100,
    );
  }
  const pxPerPsd = ctx.canvas.clientWidth > 0 && page.width > 0
    ? ctx.canvas.clientWidth / page.width
    : 0;
  applyEditableStrokePreview(inner, editStrokeColor, editStrokeWidthPx, pxPerPsd);

  // 【v1.21.0】編集前の bbox 中心を握っておく。文字数変化（特に改行追加）で bbox の
  // 幅・高さが伸びると、左上 anchor 固定の box は右下方向にだけ伸びるため
  // vertical-rl では「既存テキストが右にずれた」ように見える。これを防ぐため、
  // edit 中は毎 input イベントで box の left/top/width/height を中心固定で再計算する。
  const oldRect = isExisting
    ? layerRectForExisting(page, target.layer, getEdit(page.path, target.layer.id) ?? {})
    : layerRectForNew(page, target.nl);
  const oldCenterX = oldRect.left + oldRect.width / 2;
  const oldCenterY = oldRect.top + oldRect.height / 2;

  // 4. 編集モード ON
  box.classList.add("editing");
  applyInPlaceEditZoomClass(box);
  inner.contentEditable = "true";
  inner.spellcheck = false;

  // 【v1.21.0】edit セッション全体を 1 つの history snapshot に集約する。
  // これがないと keystroke ごとに setEdit/updateNewLayer → pushHistorySnapshot →
  // onHistoryChange リスナーが refreshAllOverlays + rebuildLayerList を発火し、
  // sidebar 再描画が頻繁に起きてキャレットが破壊される（特に縦書きで顕著）。
  beginHistoryTransient();

  // 5. フォーカス + 全選択 / 末尾カーソル
  inner.focus();
  const sel0 = window.getSelection();
  if (sel0) {
    sel0.removeAllRanges();
    const r0 = document.createRange();
    if (options.selectAll && startContents) {
      r0.selectNodeContents(inner);
    } else {
      r0.selectNodeContents(inner);
      r0.collapse(false); // 末尾
    }
    sel0.addRange(r0);
  }

  const layerMeta = isExisting
    ? { psdPath: page.path, layerId: target.layer.id, direction: editDirection }
    : { psdPath: page.path, tempId: target.nl.tempId, direction: editDirection };

  // === 内部 state ===
  let lastContents = startContents;
  let imeComposing = false;
  let finished = false;

  const lineIndexAtChar = (text, index) => {
    const head = String(text ?? "").slice(0, Math.max(0, index));
    return head.split(/\r\n|\r|\n/).length - 1;
  };

  const onRubyMouseDown = (e) => {
    const rawTarget = e.target?.nodeType === Node.TEXT_NODE ? e.target.parentElement : e.target;
    const rt = rawTarget?.closest?.(".ruby-text");
    if (!rt || !inner.contains(rt)) return;
    const start = Number(rt.dataset.rubyStart);
    const end = Number(rt.dataset.rubyEnd);
    if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) return;
    e.preventDefault();
    e.stopPropagation();
    inner.focus({ preventScroll: true });
    window.getSelection?.()?.removeAllRanges?.();
    const rubySel = {
      ...layerMeta,
      start,
      end,
      rubyOnly: true,
      rubyText: rt.dataset.rubyText ?? rt.textContent ?? "",
      rubyOverlay: rt.dataset.rubyOverlay === "true",
    };
    setLastInplaceSelection(rubySel);
    const lineIndex = lineIndexAtChar(lastContents, start);
    const totalLines = countLineBreaks(lastContents) + 1;
    setEditingContext({
      ...layerMeta,
      currentLineIndex: lineIndex,
      totalLines,
      contents: lastContents,
      selectionStart: start,
      selectionEnd: end,
    });
    window.dispatchEvent(new CustomEvent("psdesign:ruby-edit-request", { detail: rubySel }));
  };
  inner.addEventListener("mousedown", onRubyMouseDown, true);

  // 現在のレイヤー state から最新の per-char/line override を取り出す
  // 【v1.26.0】charBolds / charRubies も含めて取得 → 編集時の index shift で全て同期。
  const readCurrentMaps = () => {
    if (isExisting) {
      const e = getEdit(page.path, target.layer.id) ?? {};
      return {
        charSizes: { ...(target.layer.charSizes ?? {}), ...(e.charSizes ?? {}) },
        charFonts: e.charFonts ?? target.layer.charFonts ?? {},
        charBolds: e.charBolds ?? {},
        charItalics: e.charItalics ?? {},
        charRubies: e.charRubies ?? {},
        charHorizontalScales: { ...(target.layer.charHorizontalScales ?? {}), ...(e.charHorizontalScales ?? {}) },
        charVerticalScales: { ...(target.layer.charVerticalScales ?? {}), ...(e.charVerticalScales ?? {}) },
        charTrackings: { ...(target.layer.charTrackings ?? {}), ...(e.charTrackings ?? {}) },
        charKernings: { ...(target.layer.charKernings ?? {}), ...(e.charKernings ?? {}) },
        charTateChuYokos: { ...(target.layer.charTateChuYokos ?? {}), ...(e.charTateChuYokos ?? {}) },
        charFillColors: { ...(target.layer.charFillColors ?? {}), ...(e.charFillColors ?? {}) },
        lineLeadings: e.lineLeadings ?? {},
      };
    }
    const list = getNewLayersForPsd(page.path);
    const nl = list.find((l) => l.tempId === target.nl.tempId) ?? target.nl;
    return {
      charSizes: nl.charSizes ?? {},
      charFonts: nl.charFonts ?? {},
      charBolds: nl.charBolds ?? {},
      charItalics: nl.charItalics ?? {},
      charRubies: nl.charRubies ?? {},
      charHorizontalScales: nl.charHorizontalScales ?? {},
      charVerticalScales: nl.charVerticalScales ?? {},
      charTrackings: nl.charTrackings ?? {},
      charKernings: nl.charKernings ?? {},
      charTateChuYokos: nl.charTateChuYokos ?? {},
      charFillColors: nl.charFillColors ?? {},
      lineLeadings: nl.lineLeadings ?? {},
    };
  };

  // contenteditable 上の selection を root 内の char index range に変換。
  // selectNodeContents + setEnd の Range を作って toString().length で全長カウント。
  const getSelRange = () => {
    const s = window.getSelection();
    if (!s || s.rangeCount === 0) return null;
    const r = s.getRangeAt(0);
    if (!inner.contains(r.startContainer) && r.startContainer !== inner) return null;
    try {
      const startIdx = textLengthToDomPoint(inner, r.startContainer, r.startOffset);
      const endIdx = textLengthToDomPoint(inner, r.endContainer, r.endOffset);
      return { start: Math.min(startIdx, endIdx), end: Math.max(startIdx, endIdx) };
    } catch (e) {
      return null;
    }
  };

  // 縦書きレイヤーで半角英数字 (0-9 / A-Z / a-z) を全角に自動変換する。
  // direction === "vertical" かつ環境設定 verticalHalfToFullEnabled が true の
  // ときだけ動作（横書き / OFF は素通し）。冪等動作（全角入力は対象外）。
  // 1:1 文字対応（UTF-16 1 code unit → 1 code unit）なので contenteditable の
  // caret 位置や computeStringDiff のインデックス計算には影響しない。
  // txt-source.js の convertHalfToFullForVertical と同じロジックを inline 化
  // （canvas-tools.js → txt-source.js の import は循環参照になるため避ける）。
  // 既存テキストにある半角は触らないため、input イベントで「ユーザーが新規に
  // 打ち込んだ差分」のみ変換する設計（writeStateContents 経由）。
  const maybeConvertHalfToFull = (s) => {
    if (editDirection !== "vertical") return s;
    if (getDefault("verticalHalfToFullEnabled") === false) return s;
    return s.replace(/[\x21-\x7E]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) + 0xFEE0),
    );
  };

  const maybeReplacePunctuationWithHalfSpace = (s) => {
    if (getDefault("punctuationSpaceReplacementEnabled") === false) return String(s ?? "");
    return String(s ?? "").replace(/、/g, " ");
  };

  // contenteditable の現在テキスト読み取り。
  // 【設計判断】TreeWalker で text node を直接連結する方式を採用。理由:
  //   - innerText だと <br> / <div> 境界 / display:block 子要素の境界が暗黙的に
  //     "\n" として現れる。半角 "!!" 等を打ち直した際に Chromium が自動的に
  //     <div> 内に文字を wrap するケースがあり、 "!!" が "!\n!" として contents
  //     に保存されてしまい、TCY (縦中横) のペア検出が走らず縦に並ぶ事故が起きる。
  //   - 一方で Enter キー押下は keydown ハンドラ (preventDefault) で
  //     "\n" text node を直接挿入するため、TreeWalker で順次連結すれば取得できる。
  //     beforeinput の insertParagraph / insertLineBreak フォールバックも同様に
  //     "\n" text node 経路を使用。
  //   - つまり「browser 自動挿入の DOM 構造」は無視し、「明示的な \n text node」
  //     だけを拾うことで、視覚と内部状態の乖離を Enter 由来に限定できる。
  // ​ (zero-width space) は insertTextAtCursor が caret anchor として
  // 末尾に追加する不可視文字。state.contents には残さないよう strip する。
  // 注: 変換は呼び出し側で applyConversionToInner / maybeConvertHalfToFull を
  // 経由する。readContents 自身は変換せず DOM の生テキストを返す（diff 計算が
  // 一致する必要があるため）。
  const readContents = () => {
    // 【v1.27.0】.ruby-text（編集中プレビューのふりがな）の text node は state.contents から除外。
    // これがないと「親（ふりがな）」のふりがな文字が contents に紛れ込み、その後の onInput で
    // 巨大な textShift 差分として誤検出 → shiftCharMap が壊れて per-char 属性が崩壊する。
    // .ruby-text は contenteditable="false" なので caret も入らない（ユーザーが触れない）。
    return serializeEditableText(inner);
  };

  // 編集中の inner DOM を「plain text の text node 1 個」構造に正規化する。
  // 1. 縦書き + 設定 ON のとき半角英数字を全角に変換（Photoshop 縦中横自動入力風の UX）
  // 2. browser が <div> / <br> を自動挿入してしまったケースを必ず除去
  //
  // 1:1 文字対応なので既存の caret 位置（Selection の char offset）は保持される。
  // 呼び出しタイミング: input イベント / compositionend / commit。
  //
  // 設計判断（v1.24.0 後の TCY バグ修正）: 旧実装は「変換が必要なときだけ DOM を書換」
  // していたが、それだと browser 自動挿入の <div>/<br> が残ってしまう。具体的には
  // 半角 "!!" を打ち直したときに `<div>!</div><div>!</div>` 構造が作られ、commit 後の
  // renderOverlay で innerText が "!\n!" として state.contents に保存されて TCY ペア
  // 検出が走らなくなる（結果 "!" が縦に並ぶ）。これを防ぐため、変換不要時も毎 input
  // で textContent を書換えて DOM 構造を強制的にリセットする。
  const applyConversionToInner = () => {
    const raw = readContents();
    let converted = (
      editDirection === "vertical" && getDefault("verticalHalfToFullEnabled") !== false
    ) ? maybeConvertHalfToFull(raw) : raw;
    converted = maybeReplacePunctuationWithHalfSpace(converted);
    // 「全 child が text node」のときは zwsp anchor (Enter 後の caret anchor、v1.21.0
    // C4-4) を維持するため書換しない。一方 <div> / <br> 等 element node が混入して
    // いれば必ず plain text に書換える。比較は zwsp を strip した形で行う（converted
    // 側は readContents で strip 済み、inner.textContent には zwsp が残るため）。
    // 【v1.26.0】ruby-edit-pending span（applyEditModeRubyToRange が挿入）は許容
    // non-text node として扱う。これがないと ruby を振った直後に textContent 書換で
    // span が破壊され、ルビプレビューが消える。
    // 【v1.27.0】ruby を実 DOM 化（.ruby-wrap）に変更。互換のため .ruby-edit-pending と
    // .ruby-wrap の両方を許容ノードとして扱う（applyEditModeRubyToRange は両方の class
    // を併記して挿入する）。
    const allAllowedNodes = Array.from(inner.childNodes).every(
      (n) => n.nodeType === Node.TEXT_NODE
        || (n.nodeType === Node.ELEMENT_NODE && n.classList
            && (n.classList.contains("ruby-edit-pending")
                || n.classList.contains("ruby-wrap"))),
    );
    const innerTextStripped = inner.textContent.replace(/​/g, "");
    // ruby を持つ inner は plain text 化を完全 skip（変換は ruby 削除後に再実行可能）。
    const hasRubyPending = inner.querySelector(".ruby-edit-pending, .ruby-wrap");
    if (hasRubyPending) return false;
    if (allAllowedNodes && innerTextStripped === converted) return false;
    // caret 位置を char offset で保持してから DOM を書換える
    const sel = window.getSelection();
    let savedStart = null;
    let savedEnd = null;
    if (sel && sel.rangeCount > 0) {
      const r = sel.getRangeAt(0);
      if (inner.contains(r.startContainer) || r.startContainer === inner) {
        try {
          const a = document.createRange();
          a.selectNodeContents(inner);
          a.setEnd(r.startContainer, r.startOffset);
          savedStart = a.toString().length;
          const b = document.createRange();
          b.selectNodeContents(inner);
          b.setEnd(r.endContainer, r.endOffset);
          savedEnd = b.toString().length;
        } catch (_) { /* fallthrough */ }
      }
    }
    inner.textContent = converted;
    // caret 復元: textContent 書換後は inner の child は単一 text node のみ
    if (savedStart != null && sel) {
      try {
        const tn = inner.firstChild ?? inner;
        const r = document.createRange();
        const len = (tn.nodeType === 3 ? tn.length : converted.length);
        r.setStart(tn, Math.min(savedStart, len));
        r.setEnd(tn, Math.min(savedEnd ?? savedStart, len));
        sel.removeAllRanges();
        sel.addRange(r);
      } catch (_) { /* ignore */ }
    }
    return true;
  };

  // 単純差分: 共通接頭辞・接尾辞の外側を 1 つの編集領域とみなす（input 1 回 = 1 操作前提）
  const computeStringDiff = (a, b) => {
    let prefix = 0;
    const minLen = Math.min(a.length, b.length);
    while (prefix < minLen && a[prefix] === b[prefix]) prefix++;
    let suffix = 0;
    while (suffix < a.length - prefix && suffix < b.length - prefix
           && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
    return { pos: prefix, deleted: a.length - prefix - suffix, inserted: b.length - prefix - suffix };
  };

  // per-char index map のシフト（{ "10": 18 } 形式の charSizes / charFonts）
  const shiftCharMap = (map, pos, deleted, inserted) => {
    if (!map || typeof map !== "object") return {};
    const result = {};
    const delta = inserted - deleted;
    for (const k of Object.keys(map)) {
      const idx = Number(k);
      if (!Number.isFinite(idx)) continue;
      if (idx < pos) result[idx] = map[k];
      else if (idx >= pos + deleted) result[idx + delta] = map[k];
      // pos <= idx < pos+deleted は削除文字なので drop
    }
    return result;
  };

  const countNewlinesBefore = (str, idx) => {
    let n = 0;
    const limit = Math.min(idx, str.length);
    for (let i = 0; i < limit; i++) {
      if (str[i] === "\r") {
        n++;
        if (str[i + 1] === "\n" && i + 1 < limit) i++;
      } else if (str[i] === "\n") {
        n++;
      }
    }
    return n;
  };

  // 【v1.26.0】charRubies map のシフト。{"<start>": {end, text, type, scale}} 形式で
  // 値が range を持つため、shiftCharMap とは扱いが異なる。
  //   - 編集範囲が ruby を完全に含む (pos <= start && pos+deleted >= end) → drop
  //   - 部分重複 (pos < end && pos+deleted > start, ただし完全包含ではない) → drop（安全側）
  //   - ruby の end <= pos (前方は未変化) → unchanged
  //   - ruby の start >= pos + deleted (後方) → start/end を delta シフト
  const shiftRubyMap = (map, pos, deleted, inserted) => {
    if (!map || typeof map !== "object") return {};
    const result = {};
    const delta = inserted - deleted;
    const shiftOverlays = (entry, entryDelta) => {
      if (!Array.isArray(entry.overlays)) return entry;
      return {
        ...entry,
        overlays: entry.overlays.map((overlay) => ({
          ...overlay,
          start: Number(overlay.start) + entryDelta,
          end: Number(overlay.end) + entryDelta,
        })),
      };
    };
    for (const k of Object.keys(map)) {
      const start = Number(k);
      const entry = map[k];
      if (!Number.isFinite(start) || !entry) continue;
      const end = Number(entry.end);
      if (!Number.isFinite(end)) continue;
      const editEnd = pos + deleted;
      if (pos < end && editEnd > start) continue;
      if (start >= editEnd) {
        result[String(start + delta)] = shiftOverlays({ ...entry, end: end + delta }, delta);
      } else {
        result[String(start)] = shiftOverlays({ ...entry }, 0);
      }
    }
    return result;
  };

  // per-line leading map のシフト（{ "2": 130 } 形式、行番号は 0-based）
  const shiftLineMap = (map, oldContents, newContents, pos, deleted, inserted) => {
    if (!map || typeof map !== "object") return {};
    const oldDeletedSegment = oldContents.slice(pos, pos + deleted);
    const newInsertedSegment = newContents.slice(pos, pos + inserted);
    const oldNL = countLineBreaks(oldDeletedSegment);
    const newNL = countLineBreaks(newInsertedSegment);
    const delta = newNL - oldNL;
    if (delta === 0) {
      const out = {};
      for (const k of Object.keys(map)) out[k] = map[k];
      return out;
    }
    const linesBeforeEdit = countNewlinesBefore(oldContents, pos);
    const result = {};
    for (const k of Object.keys(map)) {
      const idx = Number(k);
      if (!Number.isFinite(idx)) continue;
      if (idx <= linesBeforeEdit) {
        result[idx] = map[k];
      } else {
        const newIdx = idx + delta;
        if (newIdx >= 0) result[newIdx] = map[k];
      }
    }
    return result;
  };

  // カーソル位置と選択範囲を _lastInplaceSelection / editingContext に反映
  const reportCursor = () => {
    const range = getSelRange();
    if (!range) return;
    const { start, end } = range;
    if (end > start) {
      setLastInplaceSelection({
        start, end,
        psdPath: layerMeta.psdPath,
        layerId: layerMeta.layerId ?? null,
        tempId: layerMeta.tempId ?? null,
      });
    }
    // 【v2.2.x】collapse 時の setLastInplaceSelection(null) は撤去。
    // v1.20.0 設計の「_lastInplaceSelection は明示的にクリアされるまで保持」
    // (CLAUDE.md B2) を尊重する。撤去理由: ユーザーが contenteditable で文字選択
    // → サイドバーのフォント検索 input にフォーカスを移すと、ブラウザ既定で
    // selection が一時的に collapse → reportCursor が null をセット → commitFont
    // が selection なしと判定し layer 全体変更に陥る現象があった。明示的なクリアは
    // finalize / ruby mousedown 経路だけに任せ、focus 移動による collapse は無視する。
    const lineIndex = countNewlinesBefore(lastContents, start);
    const totalLines = countLineBreaks(lastContents) + 1;
    setEditingContext({
      ...layerMeta,
      currentLineIndex: lineIndex,
      totalLines,
      contents: lastContents,
      selectionStart: start,
      selectionEnd: end,
    });
  };

  // selectionchange は document スコープでしか発火しないので、edit セッション中だけ register。
  const onSelChange = () => {
    if (!inner.isConnected) return;
    const a = document.activeElement;
    if (a !== inner && !inner.contains(a)) return;
    reportCursor();
  };
  // 初回 selection（startContentEditableEdit 冒頭の selectAll / collapse）は
  // listener 登録より前に確定するため selectionchange イベントを捉えられない。
  // selectAll: true のときは DOM 走査に頼らず明示的に全範囲の selection state を
  // 注入する（getSelRange は inner.focus 直後のブラウザ内部状態によって
  // range が collapse として返ってくることがあり不安定）。
  let initialSelectAllPending = !!(options.selectAll && startContents && startContents.length > 0);
  if (initialSelectAllPending) {
    setLastInplaceSelection({
      start: 0,
      end: startContents.length,
      psdPath: layerMeta.psdPath,
      layerId: layerMeta.layerId ?? null,
      tempId: layerMeta.tempId ?? null,
    });
    setEditingContext({
      ...layerMeta,
      currentLineIndex: 0,
      totalLines: countLineBreaks(startContents) + 1,
      contents: startContents,
      selectionStart: 0,
      selectionEnd: startContents.length,
    });
  } else {
    // 末尾カーソル等の通常経路は reportCursor で同期する。
    reportCursor();
  }

  // ★ initialSelectAllPending を保護した wrapper として onSelChange を上書き定義。
  //   listener が即発火するブラウザ実装で、selectAll 直後に collapse 状態が
  //   報告されて _lastInplaceSelection が null に潰されるのを防ぐ。ユーザーの
  //   実操作 (マウスドラッグ / 矢印キー / Ctrl+A) で selection が変わった瞬間
  //   フラグを下ろす。
  const onSelChangeGuarded = () => {
    if (!inner.isConnected) return;
    const a = document.activeElement;
    if (a !== inner && !inner.contains(a)) return;
    if (initialSelectAllPending) {
      // 初回 selectionchange の発火が初期 selectNodeContents 由来かを判定する。
      // getSelRange が end > start を返したらまだ selectAll 状態と一致しているので
      // 何もしない。collapse なら pending を解除して通常の reportCursor フローに戻す。
      const range = getSelRange();
      if (!range || range.end <= range.start) {
        // ブラウザ一時的な collapse — 無視
        return;
      }
      // 全選択がそのまま保持されていれば pending を保ったまま通常 update
      if (range.start === 0 && range.end === startContents.length) {
        return;
      }
      // ユーザー操作で選択範囲が変化した。pending を下ろして reportCursor 経路に戻す。
      initialSelectAllPending = false;
    }
    reportCursor();
  };
  document.addEventListener("selectionchange", onSelChangeGuarded);
  // onSelChange の元 listener を流用したい呼び出し元がある場合に備えて参照は残す。
  void onSelChange;

  // IME 中は input イベントを無視（中間文字を contents に書き込まない）
  const onCompStart = () => { imeComposing = true; };
  const onCompEnd = () => { imeComposing = false; onInput(); };
  inner.addEventListener("compositionstart", onCompStart);
  inner.addEventListener("compositionend", onCompEnd);

  // text をカーソル位置に挿入する共通ヘルパ。
  // Enter / paste / 他経路で再利用するため切り出し。
  //
  // 重要 (Chromium / WebView2 既知挙動への対処):
  //   末尾 \n だけだと caret が「新行の先頭」を anchor として持てず、
  //   視覚的に前の行末に残ったままになる現象がある（特に縦書き contenteditable）。
  //   結果として「Enter 1 回押下で box は 1 行広がるが cursor は移動しない」
  //   「Enter 2 回押下で初めて caret が新行へ移る」というズレが発生。
  //
  //   fix: 挿入後、tn の直後に内容物 (text や element) が無いとき
  //   zero-width space (U+200B) の text node を anchor として追加し、
  //   その offset 0 にカーソルを置く。これにより caret が確実に新行先頭にレンダリングされる。
  //   読み取り側 (readContents) は ​ を strip するので state.contents には残らない。
  const insertTextAtCursor = (text) => {
    const s = window.getSelection();
    if (!s || !s.rangeCount) return false;
    const r = s.getRangeAt(0);
    let tn;
    if (!inner.contains(r.startContainer) && r.startContainer !== inner) {
      // selection が inner 外に逃げているケース（フォーカス移動直後など）。末尾に挿入。
      const fallback = document.createRange();
      fallback.selectNodeContents(inner);
      fallback.collapse(false);
      tn = document.createTextNode(text);
      fallback.insertNode(tn);
    } else {
      r.deleteContents();
      tn = document.createTextNode(text);
      r.insertNode(tn);
    }

    // 挿入した tn の後ろに caret を置きたいが、tn が \n 末尾のときは anchor が必要。
    // 後続に visible 内容があれば不要、なければ zero-width space を追加する。
    const hasFollowingContent = (() => {
      let n = tn.nextSibling;
      while (n) {
        if (n.nodeType === Node.TEXT_NODE && n.textContent.length > 0) return true;
        if (n.nodeType === Node.ELEMENT_NODE) return true;
        n = n.nextSibling;
      }
      return false;
    })();

    s.removeAllRanges();
    const newR = document.createRange();
    if (text.endsWith("\n") && !hasFollowingContent) {
      // \n の後ろに anchor 用の zwsp を追加し、その先頭に caret を置く。
      // 視覚的には新行の先頭に caret がレンダリングされる（zwsp は不可視）。
      const anchor = document.createTextNode("​");
      tn.parentNode.insertBefore(anchor, tn.nextSibling);
      newR.setStart(anchor, 0);
    } else {
      // 通常: text node 末尾内部にカーソルを置く。
      newR.setStart(tn, tn.length);
    }
    newR.collapse(true);
    s.addRange(newR);
    return true;
  };

  // Enter は <br>/<div> 自動挿入を抑止して \n text node を手動挿入。
  // beforeinput は WebView2 で inputType が一致しないケースがあるため keydown を主経路とし、
  // beforeinput は補助（virtual keyboard / 音声入力 / IME 挿入経由）として残す。
  // 二重挿入を防ぐため keydown ハンドラ側で _enterHandled フラグを立て、
  // beforeinput でフラグ true なら no-op にする。
  let _enterHandled = false;
  const onBeforeInput = (e) => {
    if (_enterHandled) { _enterHandled = false; return; }
    if (e.inputType === "insertParagraph" || e.inputType === "insertLineBreak") {
      e.preventDefault();
      if (insertTextAtCursor("\n")) onInput();
    }
  };
  inner.addEventListener("beforeinput", onBeforeInput);

  // paste は plain text のみ受け付け（HTML 構造を持ち込ませない）
  const onPaste = (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData)?.getData("text/plain") ?? "";
    if (!text) return;
    if (insertTextAtCursor(text)) onInput();
  };
  inner.addEventListener("paste", onPaste);

  // 【v1.21.0】中心固定: state と DOM box の位置・サイズを oldCenter 起点で再計算。
  // 改行追加で bbox が伸びても、視覚的には edit 開始時の中心位置から左右上下に均等に広がる。
  // state も同時に更新するので commit 時の補正は不要（startInPlaceEdit / startTextInput の
  // onCommit ロジックは no-op になる）。
  //
  // virtualContents が指定されたとき (= IME 候補表示中) は state を書き換えず、
  // 視覚的な box サイズだけを virtualContents の bbox に合わせて更新する。
  // これにより IME 入力中でも box が visible text に追従して広がる。
  const recenterBox = (virtualContents = null) => {
    const useVirtual = typeof virtualContents === "string";
    let newRect;
    if (isExisting) {
      const editObj = getEdit(page.path, target.layer.id) ?? {};
      const merged = useVirtual ? { ...editObj, contents: virtualContents } : editObj;
      newRect = layerRectForExisting(page, target.layer, merged);
    } else {
      const list = getNewLayersForPsd(page.path);
      const nl = list.find((l) => l.tempId === target.nl.tempId) ?? target.nl;
      const merged = useVirtual ? { ...nl, contents: virtualContents } : nl;
      newRect = layerRectForNew(page, merged);
    }
    // 中心を oldCenter に固定する新 top-left
    const newLeft = oldCenterX - newRect.width / 2;
    const newTop = oldCenterY - newRect.height / 2;
    // state を新位置に書き込む（transient 内なので push されない）。
    // ただし virtualContents 経由（IME 中）は state を触らず DOM だけ更新する。
    if (!useVirtual) {
      if (isExisting) {
        const dx = newLeft - target.layer.left;
        const dy = newTop - target.layer.top;
        setEdit(page.path, target.layer.id, { dx, dy });
      } else {
        updateNewLayer(target.nl.tempId, { x: newLeft, y: newTop });
      }
    }
    // box CSS を直接更新（renderOverlay は editing layer をスキップするため自前更新）
    if (page.width > 0 && page.height > 0) {
      box.style.left = `${(newLeft / page.width) * 100}%`;
      box.style.top = `${(newTop / page.height) * 100}%`;
      box.style.width = `${(newRect.width / page.width) * 100}%`;
      box.style.height = `${(newRect.height / page.height) * 100}%`;
    }
  };

  // input ハンドラ: 差分を計算 → state に反映 + per-char index re-mapping
  const onInput = () => {
    if (imeComposing) {
      // IME 候補表示中は state.contents を書き換えない（preedit が確定値として残ってしまうため）。
      // ただし visible text を使って bbox は visual update する。これにより IME で長文を
      // 入力してもテキストボックスが表示中の text に追従して広がる。
      // 半角→全角の自動変換も IME 確定後 (compositionend → onInput 再呼出) に走らせる。
      const visibleText = readContents();
      recenterBox(visibleText);
      return;
    }
    // 縦書き + 設定 ON のとき、ユーザーが新規に打ち込んだ半角英数字を即座に
    // 全角化（DOM 自体を書換、caret 位置は 1:1 文字対応で維持）。Photoshop の
    // 「縦中横自動入力」と類似の感覚で、編集中もリアルタイムに全角表示される。
    applyConversionToInner();
    const newContents = readContents();
    if (newContents === lastContents) {
      reportCursor();
      return;
    }
    const diff = computeStringDiff(lastContents, newContents);
    const { charSizes, charFonts, charBolds, charItalics, charRubies, charHorizontalScales, charVerticalScales, charTrackings, charKernings, charTateChuYokos, charFillColors, lineLeadings } = readCurrentMaps();
    const newCharSizes = shiftCharMap(charSizes, diff.pos, diff.deleted, diff.inserted);
    const newCharFonts = shiftCharMap(charFonts, diff.pos, diff.deleted, diff.inserted);
    // 【v1.26.0】charBolds も同じ shiftCharMap を適用（v1.22.0 で抜けていた既存バグ修正）。
    const newCharBolds = shiftCharMap(charBolds, diff.pos, diff.deleted, diff.inserted);
    const newCharItalics = shiftCharMap(charItalics, diff.pos, diff.deleted, diff.inserted);
    const newCharHorizontalScales = shiftCharMap(charHorizontalScales, diff.pos, diff.deleted, diff.inserted);
    const newCharVerticalScales = shiftCharMap(charVerticalScales, diff.pos, diff.deleted, diff.inserted);
    const newCharTrackings = shiftCharMap(charTrackings, diff.pos, diff.deleted, diff.inserted);
    const newCharKernings = shiftCharMap(charKernings, diff.pos, diff.deleted, diff.inserted);
    const newCharTateChuYokos = shiftCharMap(charTateChuYokos, diff.pos, diff.deleted, diff.inserted);
    const newCharFillColors = shiftCharMap(charFillColors, diff.pos, diff.deleted, diff.inserted);
    // 【v1.26.0】charRubies はキーが range の start なので shiftRubyMap を使う。
    const newCharRubies = shiftRubyMap(charRubies, diff.pos, diff.deleted, diff.inserted);
    const newLineLeadings = shiftLineMap(
      lineLeadings, lastContents, newContents,
      diff.pos, diff.deleted, diff.inserted,
    );

    if (isExisting) {
      setEdit(page.path, target.layer.id, {
        contents: newContents,
        charSizes: newCharSizes,
        charFonts: newCharFonts,
        charBolds: newCharBolds,
        charItalics: newCharItalics,
        charHorizontalScales: newCharHorizontalScales,
        charVerticalScales: newCharVerticalScales,
        charTrackings: newCharTrackings,
        charKernings: newCharKernings,
        charTateChuYokos: newCharTateChuYokos,
        charFillColors: newCharFillColors,
        charRubies: newCharRubies,
        lineLeadings: newLineLeadings,
      });
    } else {
      updateNewLayer(target.nl.tempId, {
        contents: newContents,
        charSizes: newCharSizes,
        charFonts: newCharFonts,
        charBolds: newCharBolds,
        charItalics: newCharItalics,
        charHorizontalScales: newCharHorizontalScales,
        charVerticalScales: newCharVerticalScales,
        charTrackings: newCharTrackings,
        charKernings: newCharKernings,
        charTateChuYokos: newCharTateChuYokos,
        charFillColors: newCharFillColors,
        charRubies: newCharRubies,
        lineLeadings: newLineLeadings,
      });
    }
    lastContents = newContents;
    // 中心固定で box の位置・サイズを更新（state.x/y or edit.dx/dy も同期）
    recenterBox();
    reportCursor();
  };
  inner.addEventListener("input", onInput);

  // Esc / Ctrl+Enter / 通常 Enter
  const onKeydown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finalize(false);
      return;
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      finalize(true);
      return;
    }
    // 通常 Enter / Shift+Enter: WebView2 / Chromium の既定 (<div><br></div> 挿入) を抑止して
    // \n text node を直接挿入。beforeinput のフォールバック・確実経路として keydown を使う。
    // beforeinput がうまく発火しないケース（縦書き contenteditable 等）でも改行が入る。
    // stopImmediatePropagation で他の listener（window グローバルのショートカット dispatch 等）
    // を確実にブロックする。
    if (e.key === "Enter" && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      _enterHandled = true; // beforeinput 側で二重挿入しないようにフラグを立てる
      if (insertTextAtCursor("\n")) onInput();
      return;
    }
  };
  inner.addEventListener("keydown", onKeydown);

  // blur: editor パネル内クリックなら維持、それ以外なら commit
  const onBlur = (e) => {
    const next = e.relatedTarget;
    if (shouldKeepInPlaceEditForTarget(next) || shouldKeepInPlaceEditForTarget(lastPointerDownTarget)) {
      return;
    }
    finalize(true);
  };
  inner.addEventListener("blur", onBlur);

  // ===== finalize =====
  function finalize(commit) {
    if (finished) return;
    finished = true;

    document.removeEventListener("selectionchange", onSelChangeGuarded);
    inner.removeEventListener("compositionstart", onCompStart);
    inner.removeEventListener("compositionend", onCompEnd);
    inner.removeEventListener("beforeinput", onBeforeInput);
    inner.removeEventListener("paste", onPaste);
    inner.removeEventListener("input", onInput);
    inner.removeEventListener("keydown", onKeydown);
    inner.removeEventListener("blur", onBlur);
    inner.removeEventListener("mousedown", onRubyMouseDown, true);

    box.classList.remove("editing", "editing-zoomed");
    inner.removeAttribute("contenteditable");
    inner.removeAttribute("spellcheck");
    box.__finalize = null;

    setEditingContext(null);
    setLastInplaceSelection(null);

    const finalContents = readContents();

    if (commit) {
      let abortRequested = false;
      if (typeof options.onCommit === "function") {
        try {
          // onCommit が false を返すと「履歴に残さず abort」として扱う。
          // 用途: 新規入力で何も打たずに Ctrl+Enter したケース（空レイヤー作成 → 削除）。
          const r = options.onCommit(finalContents);
          if (r === false) abortRequested = true;
        } catch (err) { console.error("onCommit error", err); }
      }
      if (typeof options.afterCommit === "function") {
        try { options.afterCommit(finalContents); } catch (err) { console.error("afterCommit error", err); }
      }
      if (!isExisting && finalContents !== startContents) {
        syncPlacedLayerTextToSource(target.nl, finalContents);
        updateNewLayer(target.nl.tempId, {
          autoFontSwitched: false,
          autoFontSwitchBucket: -1,
        });
      }
      if (abortRequested) abortHistoryTransient();
      else commitHistoryTransient(); // edit セッション全体を 1 history snapshot にまとめる
    } else {
      // Esc キャンセル: 編集前の state に巻き戻し → transient abort（履歴に何も残さない）。
      // 復元書込・onCancel 内の操作（新規入力時の removeNewLayer 等）はすべて transient 内
      // （depth > 0）で行うので push されず、最後に abort で depth-- して終了。
      // これにより Esc 後は history に編集セッションの痕跡なし。
      // contents だけでなく、recenterBox が書き換えた x/y / dx/dy も元の値に戻す。
      if (isExisting) {
        setEdit(page.path, target.layer.id, {
          contents: startContents,
          lineLeadings: startLineLeadings,
          charSizes: startCharSizes,
          charFonts: startCharFonts,
          charHorizontalScales: startCharHorizontalScales,
          charVerticalScales: startCharVerticalScales,
          charTrackings: startCharTrackings,
          charKernings: startCharKernings,
          charTateChuYokos: startCharTateChuYokos,
          charFillColors: startCharFillColors,
          dx: startDx,
          dy: startDy,
        });
      } else {
        updateNewLayer(target.nl.tempId, {
          contents: startContents,
          lineLeadings: startLineLeadings,
          charSizes: startCharSizes,
          charFonts: startCharFonts,
          charHorizontalScales: startCharHorizontalScales,
          charVerticalScales: startCharVerticalScales,
          charTrackings: startCharTrackings,
          charKernings: startCharKernings,
          charTateChuYokos: startCharTateChuYokos,
          charFillColors: startCharFillColors,
          x: startX,
          y: startY,
        });
      }
      if (typeof options.onCancel === "function") {
        try { options.onCancel(); } catch (err) { console.error("onCancel error", err); }
      }
      abortHistoryTransient();
    }

    refreshAllOverlays();
    rebuildLayerList();
  }

  box.__finalize = finalize;

  // selectAll が pending な間は reportCursor を呼ばない（ブラウザの一時 collapse 状態で
  // _lastInplaceSelection が null に上書きされる事故を防ぐ）。pending でなければ
  // 通常通り initial cursor 状態を listener へ通知する。
  if (!initialSelectAllPending) reportCursor();
  return { finalize, box, inner };
}

// 【v1.21.0】既存・新規レイヤーの打ち換え in-place 編集。
// レイヤー DOM の text element を直接 contenteditable 化し、Photoshop 風 UX を実現。
// レイヤーの DOM が overlay に存在することを前提とするので、呼び出し側は
// 必要なら refreshAllOverlays() を先に走らせて DOM を確保しておく。
function startInPlaceEdit(ctx, target, options = {}) {
  const { page } = ctx;

  // 既に編集中レイヤーがあれば finalize（多重編集を抑止）
  const existing = ctx.overlay.querySelector(".layer-box.editing");
  if (existing && typeof existing.__finalize === "function") {
    existing.__finalize(true);
  }

  // contents / x,y / dx,dy は startContentEditableEdit の input 経路で edit 中に
  // 中心固定 (recenterBox) で連続更新されているので、ここでの commit-time 補正は不要。
  // 原稿テキスト dblclick 経由の afterCommit (TXT 同期) もそのまま startContentEditableEdit
  // 側の afterCommit に委ねる（同 transient 内で実行されるので 1 history snapshot に収まる）。
  startContentEditableEdit(ctx, target, {
    selectAll: true,
    afterCommit: options.afterCommit,
  });
}

// 【v1.21.0】V ツール空所 dblclick の新規入力。Photoshop 流: 先にレイヤーを作成して
// クリック点に置き、その text element を直接 contenteditable 化。
// 何も打たずに Esc または空のまま blur したらレイヤーを削除（Photoshop と同じ）。
function startTextInput(ctx, x, y, direction = "vertical") {
  const { page } = ctx;
  // 既に編集中があればまずそれを finalize
  const existing = ctx.overlay.querySelector(".layer-box.editing");
  if (existing && typeof existing.__finalize === "function") {
    existing.__finalize(true);
  }

  const sizePt = getTextSize();
  const layerDir = direction === "horizontal" ? "horizontal" : "vertical";
  // 空 contents での bbox 中心 = クリック点になるよう top-left を計算
  const { x: nx, y: ny } = centerTopLeft(page, { contents: "", sizePt, direction: layerDir }, x, y);
  const created = addNewLayer({
    psdPath: page.path,
    x: nx,
    y: ny,
    contents: "",
    fontPostScriptName: getCurrentFont(),
    sizePt,
    direction: layerDir,
    strokeColor: getStrokeColor(),
    strokeWidthPx: getStrokeWidthPx(),
    fillColor: getFillColor(),
    leadingPct: getLeadingPct(),
  });
  setSelectedLayer(ctx.pageIndex, created.tempId);
  // レイヤー DOM を overlay に同期生成（startContentEditableEdit が DOM を要求するため）
  refreshAllOverlays();
  rebuildLayerList();

  startContentEditableEdit(ctx, { kind: "new", nl: created }, {
    selectAll: false,
    onCommit: (value) => {
      // 中心固定 (recenterBox) は startContentEditableEdit の input 経路で連続適用済み。
      // commit-time にはここで「空コミットならレイヤー削除 + 履歴に残さない」判定だけ行う。
      if (!value) {
        removeNewLayer(created.tempId);
        return false; // abort: 履歴に残さない
      }
    },
    onCancel: () => {
      // Esc: 編集前の startContents (空) に巻き戻った後の onCancel。
      // 元々この edit セッションでレイヤーが作られた経緯なので破棄して終了。
      removeNewLayer(created.tempId);
    },
  });
}
