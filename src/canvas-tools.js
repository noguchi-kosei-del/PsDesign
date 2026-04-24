import {
  addEditOffset,
  addNewLayer,
  getCurrentFont,
  getEdit,
  getFontDisplayName,
  getNewLayersForPsd,
  getSelectedLayer,
  getSelectedLayers,
  getTextSize,
  getTool,
  isLayerSelected,
  onToolChange,
  setEdit,
  setSelectedLayer,
  setSelectedLayers,
  toggleLayerSelected,
  updateNewLayer,
} from "./state.js";
import { rebuildLayerList } from "./text-editor.js";
import { advanceTxtSelection, getActiveTxtSelection } from "./txt-source.js";

const mounts = new Map();
const resizeObservers = new Set();
let toolListenerBound = false;

// MojiQ 流パン状態：モジュールレベルで保持し、canvas に常設リスナーで扱う。
let panState = null;
// マーキー（V ツールの矩形選択）状態。
let marqueeState = null;

// キャンバス外でリリースされた場合のセーフティネット（window level）
if (typeof window !== "undefined") {
  window.addEventListener("mouseup", () => { if (panState) endPan(); });
  window.addEventListener("blur", () => { if (panState) endPan(); });
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
  mounts.clear();
  for (const ro of resizeObservers) ro.disconnect();
  resizeObservers.clear();
}

export function refreshAllOverlays() {
  for (const m of mounts.values()) renderOverlay(m);
}

function isTextTool(tool) {
  return tool === "text-v" || tool === "text-h";
}

function textToolDirection(tool) {
  return tool === "text-h" ? "horizontal" : "vertical";
}

function applyToolAttrs(ctx) {
  const tool = getTool();
  ctx.overlay.dataset.tool = tool;
  ctx.canvas.style.cursor =
    isTextTool(tool) ? "text" :
    tool === "pan" ? "grab" : "default";
}

function layerRectForExisting(page, layer, edit) {
  const dpi = page.dpi ?? 72;
  const left0 = layer.left ?? 0;
  const top0 = layer.top ?? 0;
  const rawWidth = Math.max(0, (layer.right ?? 0) - left0);
  const rawHeight = Math.max(0, (layer.bottom ?? 0) - top0);

  const direction = edit.direction ?? layer.direction ?? "horizontal";
  const isVertical = direction === "vertical";
  const sizePt = edit.sizePt ?? layer.fontSize ?? 24;
  const ptInPsdPx = sizePt * (dpi / 72);
  const previewText = edit.contents ?? layer.text ?? "";
  const chars = Math.max(1, longestLine(previewText));
  const lineCount = Math.max(1, countLines(previewText));
  const fallbackThick = ptInPsdPx * 1.4 * lineCount;
  const fallbackLong = ptInPsdPx * 1.05 * chars;
  const minThick = Math.max(ptInPsdPx * 1.2, 20);
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

function layerRectForNew(page, nl) {
  const dpi = page.dpi ?? 72;
  const isVertical = nl.direction !== "horizontal";
  const sizePt = nl.sizePt ?? 24;
  const ptInPsdPx = sizePt * (dpi / 72);
  const contents = nl.contents ?? "";
  const chars = Math.max(1, longestLine(contents));
  const lineCount = Math.max(1, countLines(contents));
  const thick = Math.max(24, ptInPsdPx * 1.25 * lineCount);
  const longRaw = Math.max(ptInPsdPx * 2, ptInPsdPx * 1.05 * chars);
  const maxLong = isVertical ? page.height * 0.95 : page.width * 0.95;
  const long = Math.min(longRaw, maxLong);
  const width = isVertical ? thick : long;
  const height = isVertical ? long : thick;
  return { left: nl.x, top: nl.y, right: nl.x + width, bottom: nl.y + height, width, height, isVertical, ptInPsdPx };
}

function rectsIntersect(a, b) {
  return !(b.left >= a.right || b.right <= a.left || b.top >= a.bottom || b.bottom <= a.top);
}

function renderOverlay(ctx) {
  const { overlay, page, pageIndex } = ctx;
  overlay.innerHTML = "";

  const pxPerPsd = ctx.canvas.clientWidth > 0 ? ctx.canvas.clientWidth / page.width : 0;

  for (const layer of page.textLayers) {
    const edit = getEdit(page.path, layer.id) ?? {};
    const rect = layerRectForExisting(page, layer, edit);
    const box = createBox(page, rect.left, rect.top, rect.width, rect.height, "existing");
    box.dataset.layerId = String(layer.id);
    box.dataset.direction = rect.isVertical ? "vertical" : "horizontal";
    box.title = rect.previewText.length > 60 ? rect.previewText.slice(0, 60) + "…" : rect.previewText;

    const inner = document.createElement("div");
    inner.className = "existing-layer-text";
    inner.textContent = rect.previewText;
    if (pxPerPsd > 0) {
      inner.style.fontSize = `${rect.ptInPsdPx * pxPerPsd}px`;
      inner.style.lineHeight = "1.05";
    }
    const existingFontCss = cssFontFamily(edit.fontPostScriptName ?? layer.font);
    if (existingFontCss) inner.style.fontFamily = existingFontCss;
    box.appendChild(inner);

    if (isLayerSelected(pageIndex, layer.id)) {
      box.classList.add("selected");
    }
    box.addEventListener("mousedown", (e) => onExistingLayerMouseDown(e, ctx, layer));
    overlay.appendChild(box);
  }

  for (const nl of getNewLayersForPsd(page.path)) {
    const rect = layerRectForNew(page, nl);
    const box = createBox(page, rect.left, rect.top, rect.width, rect.height, "new");
    box.dataset.tempId = nl.tempId;
    box.dataset.direction = rect.isVertical ? "vertical" : "horizontal";
    box.classList.add("text-box-preview");
    const inner = document.createElement("div");
    inner.className = "new-layer-text";
    inner.textContent = nl.contents;
    if (pxPerPsd > 0) {
      inner.style.fontSize = `${rect.ptInPsdPx * pxPerPsd}px`;
      inner.style.lineHeight = "1.25";
    }
    const newFontCss = cssFontFamily(nl.fontPostScriptName);
    if (newFontCss) inner.style.fontFamily = newFontCss;
    box.appendChild(inner);
    if (isLayerSelected(pageIndex, nl.tempId)) {
      box.classList.add("selected");
    }
    box.addEventListener("mousedown", (e) => onNewLayerMouseDown(e, ctx, nl));
    overlay.appendChild(box);
  }

  // マーキー矩形を復元（ドラッグ中に renderOverlay が走った場合に消えないように）
  if (marqueeState && marqueeState.ctx === ctx) drawMarquee();
}

function quoteFontFamily(name) {
  if (!name) return null;
  const needsQuote = /[\s,'"()]/.test(name);
  const escaped = String(name).replace(/["\\]/g, "\\$&");
  return needsQuote ? `"${escaped}"` : escaped;
}

function cssFontFamily(psName) {
  if (!psName) return null;
  const display = getFontDisplayName(psName);
  const parts = [];
  const q1 = quoteFontFamily(display);
  const q2 = quoteFontFamily(psName);
  if (q1) parts.push(q1);
  if (q2 && q2 !== q1) parts.push(q2);
  parts.push("sans-serif");
  return parts.join(", ");
}

function longestLine(s) {
  if (!s) return 0;
  const lines = String(s).split(/\r?\n/);
  let max = 0;
  for (const line of lines) if (line.length > max) max = line.length;
  return max;
}

function countLines(s) {
  if (!s) return 0;
  return String(s).split(/\r?\n/).length;
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

function canvasCoordsFromEvent(e, ctx) {
  const rect = ctx.canvas.getBoundingClientRect();
  const scaleX = ctx.page.width / rect.width;
  const scaleY = ctx.page.height / rect.height;
  const x = (e.clientX - rect.left) * scaleX;
  const y = (e.clientY - rect.top) * scaleY;
  return { x, y, scaleX, scaleY };
}

function onCanvasMouseDown(e, ctx) {
  const tool = getTool();
  if (tool === "pan") {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const scroller = document.getElementById("spreads-container");
    if (!scroller) return;
    panState = {
      canvas: ctx.canvas,
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
  if (isTextTool(tool)) {
    e.preventDefault();
    e.stopPropagation();
    const openFloater = document.querySelector(".text-input-floater");
    if (openFloater) {
      if (typeof openFloater.__finalize === "function") openFloater.__finalize(true);
      else openFloater.remove();
      return;
    }
    const { x, y } = canvasCoordsFromEvent(e, ctx);
    const direction = textToolDirection(tool);
    const txtSel = getActiveTxtSelection();
    if (txtSel) {
      placeTxtSelectionAt(ctx, x, y, txtSel, direction);
    } else {
      startTextInput(ctx, x, y, direction);
    }
    return;
  }
  if (tool === "move") {
    e.preventDefault();
    startMarquee(e, ctx);
  }
}

function onCanvasMouseMove(e, ctx) {
  if (!panState) return;
  e.preventDefault();
  e.stopPropagation();
  const scroller = document.getElementById("spreads-container");
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

function placeTxtSelectionAt(ctx, x, y, text, direction = "vertical") {
  const { page, pageIndex } = ctx;
  const created = addNewLayer({
    psdPath: page.path,
    x,
    y,
    contents: text,
    fontPostScriptName: getCurrentFont(),
    sizePt: getTextSize(),
    direction,
  });
  setSelectedLayer(pageIndex, created.tempId);
  refreshAllOverlays();
  rebuildLayerList();
  advanceTxtSelection();
}

function onExistingLayerMouseDown(e, ctx, layer) {
  const tool = getTool();
  if (isTextTool(tool)) {
    e.stopPropagation();
    e.preventDefault();
    setSelectedLayer(ctx.pageIndex, layer.id);
    renderOverlay(ctx);
    rebuildLayerList();
    startInPlaceEdit(ctx, { kind: "existing", layer });
    return;
  }
  if (tool !== "move") return;
  e.stopPropagation();
  e.preventDefault();
  if (e.shiftKey) {
    toggleLayerSelected(ctx.pageIndex, layer.id);
    renderOverlay(ctx);
    rebuildLayerList();
    return;
  }
  if (!isLayerSelected(ctx.pageIndex, layer.id)) {
    setSelectedLayer(ctx.pageIndex, layer.id);
    renderOverlay(ctx);
    rebuildLayerList();
  }
  beginMultiLayerDrag(e, ctx);
}

function onNewLayerMouseDown(e, ctx, nl) {
  const tool = getTool();
  if (isTextTool(tool)) {
    e.stopPropagation();
    e.preventDefault();
    setSelectedLayer(ctx.pageIndex, nl.tempId);
    renderOverlay(ctx);
    rebuildLayerList();
    startInPlaceEdit(ctx, { kind: "new", nl });
    return;
  }
  if (tool !== "move") return;
  e.stopPropagation();
  e.preventDefault();
  if (e.shiftKey) {
    toggleLayerSelected(ctx.pageIndex, nl.tempId);
    renderOverlay(ctx);
    rebuildLayerList();
    return;
  }
  if (!isLayerSelected(ctx.pageIndex, nl.tempId)) {
    setSelectedLayer(ctx.pageIndex, nl.tempId);
    renderOverlay(ctx);
    rebuildLayerList();
  }
  beginMultiLayerDrag(e, ctx);
}

function beginMultiLayerDrag(e, ctx) {
  const selections = getSelectedLayers().filter((s) => s.pageIndex === ctx.pageIndex);
  if (selections.length === 0) return;

  const items = [];
  for (const sel of selections) {
    if (typeof sel.layerId === "string") {
      const nl = getNewLayersForPsd(ctx.page.path).find((l) => l.tempId === sel.layerId);
      if (nl) items.push({ kind: "new", nl, startX: nl.x, startY: nl.y });
    } else {
      const layer = ctx.page.textLayers.find((l) => l.id === sel.layerId);
      if (layer) items.push({ kind: "existing", layer });
    }
  }
  if (items.length === 0) return;

  const startClientX = e.clientX;
  const startClientY = e.clientY;
  const rect = ctx.canvas.getBoundingClientRect();
  const scaleX = ctx.page.width / rect.width;
  const scaleY = ctx.page.height / rect.height;
  const pxScaleX = rect.width / ctx.page.width;
  const pxScaleY = rect.height / ctx.page.height;
  const prevUserSelect = document.body.style.userSelect;
  document.body.style.userSelect = "none";

  const suppressDefault = (ev) => ev.preventDefault();
  const applyPreview = (ddx, ddy) => {
    for (const item of items) {
      if (item.kind === "existing") {
        const boxEl = ctx.overlay.querySelector(`.layer-box-existing[data-layer-id="${item.layer.id}"]`);
        if (boxEl) boxEl.style.transform = `translate(${ddx * pxScaleX}px, ${ddy * pxScaleY}px)`;
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
    const ddx = (ev.clientX - startClientX) * scaleX;
    const ddy = (ev.clientY - startClientY) * scaleY;
    applyPreview(ddx, ddy);
  };
  const onUp = (ev) => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    window.removeEventListener("dragstart", suppressDefault, true);
    window.removeEventListener("selectstart", suppressDefault, true);
    document.body.style.userSelect = prevUserSelect;
    const ddx = (ev.clientX - startClientX) * scaleX;
    const ddy = (ev.clientY - startClientY) * scaleY;
    if (ddx !== 0 || ddy !== 0) {
      for (const item of items) {
        if (item.kind === "existing") {
          addEditOffset(ctx.page.path, item.layer.id, ddx, ddy);
        } else {
          updateNewLayer(item.nl.tempId, { x: item.startX + ddx, y: item.startY + ddy });
        }
      }
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
  renderOverlay(ctx);
  rebuildLayerList();
}

function collectLayerHits(ctx, selRect) {
  const { page, pageIndex } = ctx;
  const hits = [];
  for (const layer of page.textLayers) {
    const edit = getEdit(page.path, layer.id) ?? {};
    const lrect = layerRectForExisting(page, layer, edit);
    if (rectsIntersect(selRect, lrect)) hits.push({ pageIndex, layerId: layer.id });
  }
  for (const nl of getNewLayersForPsd(page.path)) {
    const lrect = layerRectForNew(page, nl);
    if (rectsIntersect(selRect, lrect)) hits.push({ pageIndex, layerId: nl.tempId });
  }
  return hits;
}

// テキスト入力 textarea の共通生成ヘルパ。
// DOM 生成・配置・keydown/focus/blur 配線・`__finalize` 付与を集約し、
// commit 時のアクションだけ `onCommit(value)` で呼び出し元に委ねる。
function createTextFloater(ctx, {
  x, y, direction,
  initialText = "",
  selectAll = false,
  guardBlurUntilFocused = false,
  onCommit,
}) {
  const { page } = ctx;
  const isVertical = direction !== "horizontal";
  const input = document.createElement("textarea");
  input.className = "text-input-floater";
  input.dataset.direction = isVertical ? "vertical" : "horizontal";
  input.placeholder = isVertical
    ? "テキスト（縦書き）：Ctrl+Enterで確定 / Escで破棄"
    : "テキスト（横書き）：Ctrl+Enterで確定 / Escで破棄";
  input.style.left = `${(x / page.width) * 100}%`;
  input.style.top = `${(y / page.height) * 100}%`;
  if (initialText) input.value = initialText;
  else input.rows = 1;
  ctx.overlay.appendChild(input);
  input.focus();
  if (selectAll && initialText) input.select();

  let finished = false;
  let hasFocused = !guardBlurUntilFocused;
  const finalize = (commit) => {
    if (finished) return;
    finished = true;
    const value = input.value.replace(/\s+$/, "");
    input.remove();
    if (commit) onCommit(value);
  };
  input.__finalize = finalize;
  input.addEventListener("focus", () => { hasFocused = true; });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      finalize(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finalize(false);
    }
  });
  input.addEventListener("blur", () => {
    if (!hasFocused) return;
    finalize(true);
  });
  return input;
}

function startInPlaceEdit(ctx, target) {
  const { page } = ctx;
  let initialText = "";
  let x = 0;
  let y = 0;
  let direction = "vertical";

  if (target.kind === "existing") {
    const layer = target.layer;
    const edit = getEdit(page.path, layer.id) ?? {};
    initialText = edit.contents ?? layer.text ?? "";
    x = (layer.left ?? 0) + (edit.dx ?? 0);
    y = (layer.top ?? 0) + (edit.dy ?? 0);
    direction = edit.direction ?? layer.direction ?? "horizontal";
  } else {
    const nl = target.nl;
    initialText = nl.contents ?? "";
    x = nl.x;
    y = nl.y;
    direction = nl.direction ?? "vertical";
  }

  const existing = ctx.overlay.querySelector(".text-input-floater");
  if (existing) {
    if (typeof existing.__finalize === "function") existing.__finalize(true);
    else existing.remove();
  }

  createTextFloater(ctx, {
    x, y, direction,
    initialText,
    selectAll: true,
    onCommit: (value) => {
      if (target.kind === "existing") {
        setEdit(page.path, target.layer.id, { contents: value });
      } else {
        updateNewLayer(target.nl.tempId, { contents: value });
      }
      refreshAllOverlays();
      rebuildLayerList();
    },
  });
}

function startTextInput(ctx, x, y, direction = "vertical") {
  const { page } = ctx;
  createTextFloater(ctx, {
    x, y, direction,
    guardBlurUntilFocused: true,
    onCommit: (value) => {
      if (!value) return;
      addNewLayer({
        psdPath: page.path,
        x,
        y,
        contents: value,
        fontPostScriptName: getCurrentFont(),
        sizePt: getTextSize(),
        direction: direction === "horizontal" ? "horizontal" : "vertical",
      });
      setSelectedLayers([]);
      refreshAllOverlays();
      rebuildLayerList();
    },
  });
}
