import {
  addEditOffset,
  addNewLayer,
  getCurrentFont,
  getEdit,
  getFontDisplayName,
  getNewLayersForPsd,
  getSelectedLayer,
  getTextSize,
  getTool,
  onToolChange,
  setEdit,
  setSelectedLayer,
  updateNewLayer,
} from "./state.js";
import { rebuildLayerList } from "./text-editor.js";
import { advanceTxtSelection, getActiveTxtSelection } from "./txt-source.js";

const mounts = new Map();
const resizeObservers = new Set();
let toolListenerBound = false;

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

function applyToolAttrs(ctx) {
  const tool = getTool();
  ctx.overlay.dataset.tool = tool;
  ctx.canvas.style.cursor =
    tool === "text" ? "text" :
    tool === "pan" ? "grab" : "default";
}

function renderOverlay(ctx) {
  const { overlay, page, pageIndex } = ctx;
  overlay.innerHTML = "";

  const sel = getSelectedLayer();
  const selOnThisPage = sel && sel.pageIndex === pageIndex ? sel : null;
  const dpi = page.dpi ?? 72;
  const pxPerPsd = ctx.canvas.clientWidth > 0 ? ctx.canvas.clientWidth / page.width : 0;

  for (const layer of page.textLayers) {
    const edit = getEdit(page.path, layer.id) ?? {};
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
    const box = createBox(page, left, top, width, height, "existing");
    box.dataset.layerId = String(layer.id);
    box.dataset.direction = isVertical ? "vertical" : "horizontal";
    box.title = previewText.length > 60 ? previewText.slice(0, 60) + "…" : previewText;

    const inner = document.createElement("div");
    inner.className = "existing-layer-text";
    inner.textContent = previewText;
    if (pxPerPsd > 0) {
      inner.style.fontSize = `${ptInPsdPx * pxPerPsd}px`;
      inner.style.lineHeight = "1.05";
    }
    const existingFontCss = cssFontFamily(edit.fontPostScriptName ?? layer.font);
    if (existingFontCss) inner.style.fontFamily = existingFontCss;
    box.appendChild(inner);

    if (selOnThisPage && selOnThisPage.layerId === layer.id) {
      box.classList.add("selected");
    }
    box.addEventListener("mousedown", (e) => onExistingLayerMouseDown(e, ctx, layer));
    overlay.appendChild(box);
  }

  const newLayers = getNewLayersForPsd(page.path);
  for (const nl of newLayers) {
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
    const box = createBox(page, nl.x, nl.y, width, height, "new");
    box.dataset.tempId = nl.tempId;
    box.dataset.direction = isVertical ? "vertical" : "horizontal";
    box.classList.add("text-box-preview");
    const inner = document.createElement("div");
    inner.className = "new-layer-text";
    inner.textContent = nl.contents;
    if (pxPerPsd > 0) {
      inner.style.fontSize = `${ptInPsdPx * pxPerPsd}px`;
      inner.style.lineHeight = "1.25";
    }
    const newFontCss = cssFontFamily(nl.fontPostScriptName);
    if (newFontCss) inner.style.fontFamily = newFontCss;
    box.appendChild(inner);
    if (selOnThisPage && selOnThisPage.layerId === nl.tempId) {
      box.classList.add("selected");
    }
    box.addEventListener("mousedown", (e) => onNewLayerMouseDown(e, ctx, nl));
    overlay.appendChild(box);
  }
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
    e.preventDefault();
    beginPan(e, ctx);
    return;
  }
  if (tool === "text") {
    const { x, y } = canvasCoordsFromEvent(e, ctx);
    const txtSel = getActiveTxtSelection();
    if (txtSel) {
      placeTxtSelectionAt(ctx, x, y, txtSel);
    } else {
      startTextInput(ctx, x, y);
    }
    return;
  }
  if (tool === "move") {
    setSelectedLayer(null);
    renderOverlay(ctx);
    rebuildLayerList();
  }
}

function placeTxtSelectionAt(ctx, x, y, text) {
  const { page, pageIndex } = ctx;
  const created = addNewLayer({
    psdPath: page.path,
    x,
    y,
    contents: text,
    fontPostScriptName: getCurrentFont(),
    sizePt: getTextSize(),
    direction: "vertical",
  });
  setSelectedLayer(pageIndex, created.tempId);
  refreshAllOverlays();
  rebuildLayerList();
  advanceTxtSelection();
}

function onExistingLayerMouseDown(e, ctx, layer) {
  const tool = getTool();
  if (tool === "text") {
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
  setSelectedLayer(ctx.pageIndex, layer.id);
  renderOverlay(ctx);
  rebuildLayerList();
  beginDrag(e, ctx, (ddxPsd, ddyPsd, commit) => {
    const boxEl = ctx.overlay.querySelector(`.layer-box-existing[data-layer-id="${layer.id}"]`);
    if (boxEl) {
      const rect = ctx.canvas.getBoundingClientRect();
      const scaleX = rect.width / ctx.page.width;
      const scaleY = rect.height / ctx.page.height;
      boxEl.style.transform = `translate(${ddxPsd * scaleX}px, ${ddyPsd * scaleY}px)`;
    }
    if (commit) {
      if (ddxPsd !== 0 || ddyPsd !== 0) {
        addEditOffset(ctx.page.path, layer.id, ddxPsd, ddyPsd);
      }
      refreshAllOverlays();
      rebuildLayerList();
    }
  });
}

function onNewLayerMouseDown(e, ctx, nl) {
  const tool = getTool();
  if (tool === "text") {
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
  setSelectedLayer(ctx.pageIndex, nl.tempId);
  renderOverlay(ctx);
  const startX = nl.x;
  const startY = nl.y;
  beginDrag(e, ctx, (ddxPsd, ddyPsd, commit) => {
    updateNewLayer(nl.tempId, { x: startX + ddxPsd, y: startY + ddyPsd });
    if (commit) refreshAllOverlays();
    else {
      const boxEl = ctx.overlay.querySelector(`.layer-box-new[data-temp-id="${nl.tempId}"]`);
      if (boxEl) {
        boxEl.style.left = `${((startX + ddxPsd) / ctx.page.width) * 100}%`;
        boxEl.style.top = `${((startY + ddyPsd) / ctx.page.height) * 100}%`;
      }
    }
  });
}

function beginPan(e, ctx) {
  const scroller = document.getElementById("spreads-container");
  if (!scroller) return;
  const startClientX = e.clientX;
  const startClientY = e.clientY;
  const startScrollX = scroller.scrollLeft;
  const startScrollY = scroller.scrollTop;
  ctx.canvas.style.cursor = "grabbing";
  const prevUserSelect = document.body.style.userSelect;
  document.body.style.userSelect = "none";

  const onMove = (ev) => {
    scroller.scrollLeft = startScrollX - (ev.clientX - startClientX);
    scroller.scrollTop = startScrollY - (ev.clientY - startClientY);
  };
  const onUp = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    document.body.style.userSelect = prevUserSelect;
    if (getTool() === "pan") ctx.canvas.style.cursor = "grab";
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

function beginDrag(e, ctx, onDelta) {
  const startClientX = e.clientX;
  const startClientY = e.clientY;
  const rect = ctx.canvas.getBoundingClientRect();
  const scaleX = ctx.page.width / rect.width;
  const scaleY = ctx.page.height / rect.height;

  const onMove = (ev) => {
    const ddxPsd = (ev.clientX - startClientX) * scaleX;
    const ddyPsd = (ev.clientY - startClientY) * scaleY;
    onDelta(ddxPsd, ddyPsd, false);
  };
  const onUp = (ev) => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    const ddxPsd = (ev.clientX - startClientX) * scaleX;
    const ddyPsd = (ev.clientY - startClientY) * scaleY;
    onDelta(ddxPsd, ddyPsd, true);
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
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
  if (existing) existing.remove();

  const input = document.createElement("textarea");
  input.className = "text-input-floater";
  input.dataset.direction = direction === "vertical" ? "vertical" : "horizontal";
  input.value = initialText;
  input.placeholder = direction === "vertical"
    ? "テキスト（縦書き）：Ctrl+Enterで確定 / Escで破棄"
    : "テキスト（横書き）：Ctrl+Enterで確定 / Escで破棄";
  input.style.left = `${(x / page.width) * 100}%`;
  input.style.top = `${(y / page.height) * 100}%`;
  ctx.overlay.appendChild(input);
  input.focus();
  input.select();

  let finished = false;
  const finalize = (commit) => {
    if (finished) return;
    finished = true;
    const value = input.value.replace(/\s+$/, "");
    input.remove();
    if (!commit) return;
    if (target.kind === "existing") {
      setEdit(page.path, target.layer.id, { contents: value });
    } else {
      updateNewLayer(target.nl.tempId, { contents: value });
    }
    refreshAllOverlays();
    rebuildLayerList();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      finalize(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finalize(false);
    }
  });
  input.addEventListener("blur", () => finalize(true));
}

function startTextInput(ctx, x, y) {
  const { page } = ctx;
  const input = document.createElement("textarea");
  input.className = "text-input-floater";
  input.dataset.direction = "vertical";
  input.rows = 1;
  input.placeholder = "テキスト（縦書き）：Ctrl+Enterで確定 / Escで破棄";
  input.style.left = `${(x / page.width) * 100}%`;
  input.style.top = `${(y / page.height) * 100}%`;
  ctx.overlay.appendChild(input);
  input.focus();

  let finished = false;
  const finalize = (commit) => {
    if (finished) return;
    finished = true;
    const value = input.value.replace(/\s+$/, "");
    input.remove();
    if (commit && value) {
      const created = addNewLayer({
        psdPath: page.path,
        x,
        y,
        contents: value,
        fontPostScriptName: getCurrentFont(),
        sizePt: getTextSize(),
        direction: "vertical",
      });
      setSelectedLayer(ctx.pageIndex, created.tempId);
      refreshAllOverlays();
      rebuildLayerList();
    }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      finalize(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finalize(false);
    }
  });
  input.addEventListener("blur", () => finalize(true));
}
