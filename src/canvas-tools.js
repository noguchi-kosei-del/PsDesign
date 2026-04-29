import {
  abortHistoryTransient,
  addEditOffset,
  addNewLayer,
  beginHistoryTransient,
  commitHistoryTransient,
  getCurrentFont,
  getCurrentPageIndex,
  getEdit,
  getFillColor,
  getFontDisplayName,
  getFontPickerStuck,
  getLeadingPct,
  getNewLayersForPsd,
  getPages,
  getPsdRotation,
  getSelectedLayer,
  getSelectedLayers,
  getStrokeColor,
  getStrokeWidthPx,
  getTextSize,
  getTool,
  isLayerSelected,
  onToolChange,
  removeNewLayer,
  setCurrentPageIndex,
  setEdit,
  setEditingContext,
  setSelectedLayer,
  setSelectedLayers,
  setTool,
  toDisplaySizePt,
  toggleLayerSelected,
  updateNewLayer,
} from "./state.js";
import { ensureFontLoaded } from "./font-loader.js";
import { getDefault } from "./settings.js";
import { commitFontToSelections, rebuildLayerList } from "./text-editor.js";
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

export function nudgeSelectedLayers(dx, dy) {
  const selections = getSelectedLayers();
  if (selections.length === 0) return false;
  const pages = getPages();
  let moved = false;
  beginHistoryTransient();
  try {
    for (const sel of selections) {
      const page = pages[sel.pageIndex];
      if (!page) continue;
      if (typeof sel.layerId === "string") {
        const nl = getNewLayersForPsd(page.path).find((l) => l.tempId === sel.layerId);
        if (!nl) continue;
        updateNewLayer(sel.layerId, { x: nl.x + dx, y: nl.y + dy });
        moved = true;
      } else {
        const layer = page.textLayers.find((l) => l.id === sel.layerId);
        if (!layer) continue;
        addEditOffset(page.path, sel.layerId, dx, dy);
        moved = true;
      }
    }
  } finally {
    if (moved) commitHistoryTransient(); else abortHistoryTransient();
  }
  if (moved) {
    refreshAllOverlays();
    rebuildLayerList();
  }
  return moved;
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
  beginHistoryTransient();
  for (const id of tempIds) removeNewLayer(id);
  commitHistoryTransient();
  // 既存 PSD レイヤーの選択は維持し、新規分のみ選択から外す。
  setSelectedLayers(selections.filter((s) => typeof s.layerId !== "string"));
  refreshAllOverlays();
  rebuildLayerList();
  return true;
}

function clampSizePt(v) {
  const rounded = Math.round(v * 10) / 10;
  return Math.max(6, Math.min(999, rounded));
}

// 現在値 cur から baseStep グリッド上の「次の」値を返す。
// - グリッド上ぴったりなら sign 方向に 1 ステップ
// - グリッド外（例：0.5 刻み設定で 12.3）なら sign 方向の最寄りグリッドへスナップ
//   （+1 は ceil、-1 は floor）。これにより 12.3 + 0.5 step → 12.5（13.0 ではない）
// - multiplier > 1（Shift+wheel 等）はスナップ後に追加でグリッドを進む。
export function snapNextSize(cur, baseStep, sign, multiplier = 1) {
  if (!Number.isFinite(cur) || !Number.isFinite(baseStep) || baseStep <= 0) return cur;
  const ratio = cur / baseStep;
  const onGrid = Math.abs(ratio - Math.round(ratio)) < 1e-9;
  const firstStep = onGrid
    ? Math.round(ratio) + sign
    : (sign > 0 ? Math.ceil(ratio) : Math.floor(ratio));
  const finalGrid = firstStep + sign * (Math.max(1, multiplier) - 1);
  return Math.round(finalGrid * baseStep * 10) / 10;
}

// 選択中レイヤーをサイズ変更。sign（+1 / -1）と multiplier（Shift+wheel で 10）で
// 各レイヤーの現在 sizePt を snapNextSize で次の baseStep グリッドへ移動する。
// 中心固定のため矩形差の半分だけ x/y を補正するのは従来通り。
export function resizeSelectedLayers(baseStep, sign, multiplier = 1) {
  const selections = getSelectedLayers();
  if (selections.length === 0) return false;
  const pages = getPages();
  let changed = false;
  beginHistoryTransient();
  for (const sel of selections) {
    const page = pages[sel.pageIndex];
    if (!page) continue;
    if (typeof sel.layerId === "string") {
      const nl = getNewLayersForPsd(page.path).find((l) => l.tempId === sel.layerId);
      if (!nl) continue;
      const cur = nl.sizePt ?? 24;
      const next = clampSizePt(snapNextSize(cur, baseStep, sign, multiplier));
      if (next === cur) continue;
      const oldRect = layerRectForNew(page, nl);
      const newRect = layerRectForNew(page, { ...nl, sizePt: next });
      const dx = (oldRect.width - newRect.width) / 2;
      const dy = (oldRect.height - newRect.height) / 2;
      updateNewLayer(sel.layerId, { sizePt: next, x: nl.x + dx, y: nl.y + dy });
      changed = true;
    } else {
      const layer = page.textLayers.find((l) => l.id === sel.layerId);
      if (!layer) continue;
      const edit = getEdit(page.path, sel.layerId) ?? {};
      const cur = edit.sizePt ?? layer.fontSize ?? 24;
      const next = clampSizePt(snapNextSize(cur, baseStep, sign, multiplier));
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
      changed = true;
    }
  }
  if (changed) commitHistoryTransient(); else abortHistoryTransient();
  if (changed) {
    refreshAllOverlays();
    rebuildLayerList();
  }
  return changed;
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
    tool === "text-v" ? "vertical-text" :
    tool === "text-h" ? "text" :
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
  // 行間 (autoLeadingAmount %) を厚み（行スタック方向）の係数に反映。125% を最低値として
  // 設定しても既存の見た目より細くしないように clamp。
  const leadingFactor = Math.max(1.25, ((edit.leadingPct ?? 125) / 100));
  const fallbackThick = ptInPsdPx * leadingFactor * lineCount;
  const fallbackLong = ptInPsdPx * 1.05 * chars;
  const minThick = Math.max(ptInPsdPx * leadingFactor, 20);
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
  // 行間 (%) を厚み係数に反映。125 が既定。
  const leadingFactor = (nl.leadingPct ?? 125) / 100;
  const thick = Math.max(24, ptInPsdPx * leadingFactor * lineCount);
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

// fillColor === "default" はプレビュー上も編集前の表示を維持するため何も設定しない。
// white/black のときだけ CSS color を上書きする。
function applyFillPreview(inner, fillColor) {
  if (fillColor === "white") inner.style.color = "#fff";
  else if (fillColor === "black") inner.style.color = "#000";
}

function applyStrokePreview(inner, strokeColor, strokeWidthPx, pxPerPsd) {
  if (!strokeColor || strokeColor === "none" || !(strokeWidthPx > 0) || !(pxPerPsd > 0)) return;
  const cssColor = strokeColor === "white" ? "#fff" : "#000";
  // PSD px → screen px。最低 0.5px で visibility 確保。
  const w = Math.max(0.5, strokeWidthPx * pxPerPsd);
  inner.style.webkitTextStroke = `${w}px ${cssColor}`;
  // paint-order を指定して、塗りが上・ストロークが下（外側近似）。
  inner.style.paintOrder = "stroke fill";
}

function renderOverlay(ctx) {
  const { overlay, page, pageIndex } = ctx;
  overlay.innerHTML = "";

  const pxPerPsd = ctx.canvas.clientWidth > 0 ? ctx.canvas.clientWidth / page.width : 0;

  for (const layer of page.textLayers) {
    const edit = getEdit(page.path, layer.id) ?? {};
    const rect = layerRectForExisting(page, layer, edit);
    const rotation = edit.rotation ?? 0;
    const box = createBox(page, rect.left, rect.top, rect.width, rect.height, "existing");
    box.dataset.layerId = String(layer.id);
    box.dataset.direction = rect.isVertical ? "vertical" : "horizontal";
    if (rotation) box.style.transform = `rotate(${rotation}deg)`;
    box.title = rect.previewText.length > 60 ? rect.previewText.slice(0, 60) + "…" : rect.previewText;

    const inner = document.createElement("div");
    inner.className = "existing-layer-text";
    if (pxPerPsd > 0) {
      inner.style.fontSize = `${rect.ptInPsdPx * pxPerPsd}px`;
    }
    // 行間：edit.leadingPct があれば反映、なければ既定 1.05（既存表示と整合）。
    const defaultLeadPct = Number.isFinite(edit.leadingPct) ? edit.leadingPct : 105;
    renderInnerText(inner, rect.previewText, defaultLeadPct, edit.lineLeadings);
    const existingPs = edit.fontPostScriptName ?? layer.font;
    const existingFontCss = cssFontFamily(existingPs);
    if (existingFontCss) inner.style.fontFamily = existingFontCss;
    ensureFontLoaded(existingPs);
    applyFillPreview(inner, edit.fillColor ?? layer.fillColor ?? "default");
    applyStrokePreview(
      inner,
      edit.strokeColor ?? layer.strokeColor ?? "none",
      edit.strokeWidthPx ?? layer.strokeWidthPx ?? 20,
      pxPerPsd,
    );
    box.appendChild(inner);

    if (isLayerSelected(pageIndex, layer.id)) {
      box.classList.add("selected");
      box.appendChild(createRotateHandle(ctx, layer.id));
      box.appendChild(createSizeBadge(edit.sizePt ?? layer.fontSize ?? 24, page, edit.fontPostScriptName ?? layer.font ?? null));
    }
    box.addEventListener("mousedown", (e) => onExistingLayerMouseDown(e, ctx, layer));
    box.addEventListener("wheel", (e) => onLayerWheel(e, ctx, layer.id), { passive: false });
    overlay.appendChild(box);
  }

  for (const nl of getNewLayersForPsd(page.path)) {
    const rect = layerRectForNew(page, nl);
    const rotation = nl.rotation ?? 0;
    const box = createBox(page, rect.left, rect.top, rect.width, rect.height, "new");
    box.dataset.tempId = nl.tempId;
    box.dataset.direction = rect.isVertical ? "vertical" : "horizontal";
    if (rotation) box.style.transform = `rotate(${rotation}deg)`;
    box.classList.add("text-box-preview");
    const inner = document.createElement("div");
    inner.className = "new-layer-text";
    if (pxPerPsd > 0) {
      inner.style.fontSize = `${rect.ptInPsdPx * pxPerPsd}px`;
    }
    renderInnerText(inner, nl.contents, nl.leadingPct ?? 125, nl.lineLeadings);
    const newFontCss = cssFontFamily(nl.fontPostScriptName);
    if (newFontCss) inner.style.fontFamily = newFontCss;
    ensureFontLoaded(nl.fontPostScriptName);
    applyFillPreview(inner, nl.fillColor ?? "default");
    applyStrokePreview(
      inner,
      nl.strokeColor ?? "none",
      nl.strokeWidthPx ?? 20,
      pxPerPsd,
    );
    box.appendChild(inner);
    if (isLayerSelected(pageIndex, nl.tempId)) {
      box.classList.add("selected");
      box.appendChild(createRotateHandle(ctx, nl.tempId));
      box.appendChild(createSizeBadge(nl.sizePt ?? 24, page, nl.fontPostScriptName ?? null));
    }
    box.addEventListener("mousedown", (e) => onNewLayerMouseDown(e, ctx, nl));
    box.addEventListener("wheel", (e) => onLayerWheel(e, ctx, nl.tempId), { passive: false });
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

// inner にテキストを描画する。lineLeadings に override があれば 1 行ずつ <div> に
// 分けて per-line line-height を当てる。無ければ単一ブロックで描画（軽量）。
function renderInnerText(inner, text, defaultLeadingPct, lineLeadings) {
  inner.textContent = "";
  const overrides = lineLeadings && Object.keys(lineLeadings).length > 0 ? lineLeadings : null;
  const fallback = String((defaultLeadingPct ?? 125) / 100);
  if (!overrides) {
    inner.textContent = text ?? "";
    inner.style.lineHeight = fallback;
    return;
  }
  const lines = String(text ?? "").split(/\r?\n/);
  // 親自体の line-height はリセット（per-line div 側で個別に当てる）。
  inner.style.lineHeight = fallback;
  for (let i = 0; i < lines.length; i++) {
    const lineEl = document.createElement("div");
    const pct = Number.isFinite(overrides[i]) ? overrides[i] : (defaultLeadingPct ?? 125);
    lineEl.style.lineHeight = String(pct / 100);
    // 空行はゼロ幅スペースで高さ/幅を確保（CSS の writing-mode が縦書きでも有効）。
    lineEl.textContent = lines[i].length > 0 ? lines[i] : "​";
    inner.appendChild(lineEl);
  }
}

function createSizeBadge(sizePt, page, fontPostScriptName) {
  const el = document.createElement("div");
  el.className = "layer-size-badge";
  // 基準PSD 比で換算した pt を表示。基準が 1 ページ目（または未読込）の場合は素のまま。
  const display = toDisplaySizePt(sizePt ?? 0, page);
  const rounded = Math.round((display ?? 0) * 10) / 10;
  const fontName = fontPostScriptName ? (getFontDisplayName(fontPostScriptName) ?? fontPostScriptName) : "";
  el.textContent = fontName ? `${fontName} · ${rounded}pt` : `${rounded}pt`;
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
  const normalized = ((deg + 180) % 360 + 360) % 360 - 180;
  if (typeof layerId === "string") {
    updateNewLayer(layerId, { rotation: normalized });
  } else {
    setEdit(ctx.page.path, layerId, { rotation: normalized });
  }
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
  };
  const onUp = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    document.body.style.userSelect = prevUserSelect;
    document.body.style.cursor = prevCursor;
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
      return;
    }
    // 配置直後・編集直後の選択中レイヤーがあるとき、空所クリックは「まず選択解除」
    // を優先し、新規テキスト入力は開かない。次のクリックで新規入力が起動する。
    // txt セレクションが残っているときは段落配置を続行（rapid placement を妨げない）。
    if (getSelectedLayers().length > 0) {
      setSelectedLayers([]);
      refreshAllOverlays();
      rebuildLayerList();
      return;
    }
    startTextInput(ctx, x, y, direction);
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
function centerTopLeft(page, { contents, sizePt, direction }, clickX, clickY) {
  const r = layerRectForNew(page, { x: 0, y: 0, contents, sizePt, direction });
  return { x: clickX - r.width / 2, y: clickY - r.height / 2 };
}

function placeTxtSelectionAt(ctx, x, y, text, direction = "vertical") {
  const { page, pageIndex } = ctx;
  const sizePt = getTextSize();
  const { x: nx, y: ny } = centerTopLeft(page, { contents: text, sizePt, direction }, x, y);
  const created = addNewLayer({
    psdPath: page.path,
    x: nx,
    y: ny,
    contents: text,
    fontPostScriptName: getCurrentFont(),
    sizePt,
    direction,
    strokeColor: getStrokeColor(),
    strokeWidthPx: getStrokeWidthPx(),
    fillColor: getFillColor(),
    leadingPct: getLeadingPct(),
  });
  setSelectedLayer(pageIndex, created.tempId);
  refreshAllOverlays();
  rebuildLayerList();
  advanceTxtSelection();
}

function onLayerWheel(e, ctx, layerId) {
  // Alt+wheel はズーム、Ctrl/Meta+wheel はブラウザ既定（ページズーム等）に委ねる。
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const tool = getTool();
  if (tool !== "move" && !isTextTool(tool)) return;
  if (!isLayerSelected(ctx.pageIndex, layerId)) return;
  e.preventDefault();
  e.stopPropagation();
  // 環境設定の「文字サイズの刻み」（0.1 / 0.5）を baseStep に、Shift で 10 倍。
  // off-grid な値（例：0.5 刻み設定で 12.3）は最寄りグリッドにスナップする。
  const baseStep = Number(getDefault("textSizeStep")) === 0.5 ? 0.5 : 0.1;
  const sign = e.deltaY < 0 ? +1 : -1;
  const multiplier = e.shiftKey ? 10 : 1;
  resizeSelectedLayers(baseStep, sign, multiplier);
}

// edit-font 欄でユーザーがフォントを選んだ後（fontPickerStuck === true）、move ツールでの
// 単独クリック・shift クリック・マーキー選択など、選択集合が確定した直後に呼ぶ。
// 現在の選択リスト全体に currentFont を一括適用し、1 件以上書き込まれたら true。
// false（apply しなかった）の場合、呼び出し側が rebuildLayerList を行うこと。
function maybeApplyStickyFont() {
  if (!getFontPickerStuck()) return false;
  const ps = getCurrentFont();
  if (!ps) return false;
  return commitFontToSelections(ps);
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
    if (!maybeApplyStickyFont()) rebuildLayerList();
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
    for (const sel of selections) {
      if (typeof sel.layerId === "string") {
        const nl = getNewLayersForPsd(ctx.page.path).find((l) => l.tempId === sel.layerId);
        if (!nl) continue;
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
        });
        if (nl.lineLeadings && Object.keys(nl.lineLeadings).length > 0) {
          updateNewLayer(dup.tempId, { lineLeadings: { ...nl.lineLeadings } });
        }
        items.push({ kind: "new", nl: dup, startX: dup.x, startY: dup.y, rotation: dup.rotation ?? 0 });
        newSelections.push({ pageIndex: ctx.pageIndex, layerId: dup.tempId });
      } else {
        const layer = ctx.page.textLayers.find((l) => l.id === sel.layerId);
        if (!layer) continue;
        const edit = getEdit(ctx.page.path, sel.layerId) ?? {};
        const dupX = (layer.left ?? 0) + (edit.dx ?? 0);
        const dupY = (layer.top ?? 0) + (edit.dy ?? 0);
        const dup = addNewLayer({
          psdPath: ctx.page.path,
          x: dupX,
          y: dupY,
          contents: edit.contents ?? layer.text ?? "",
          fontPostScriptName: edit.fontPostScriptName ?? layer.font ?? null,
          sizePt: edit.sizePt ?? layer.fontSize ?? null,
          direction: edit.direction ?? layer.direction ?? "horizontal",
          strokeColor: edit.strokeColor ?? layer.strokeColor ?? "none",
          strokeWidthPx: edit.strokeWidthPx ?? layer.strokeWidthPx ?? 20,
          fillColor: edit.fillColor ?? layer.fillColor ?? "default",
          rotation: edit.rotation ?? 0,
          leadingPct: edit.leadingPct ?? 125,
        });
        if (edit.lineLeadings && Object.keys(edit.lineLeadings).length > 0) {
          updateNewLayer(dup.tempId, { lineLeadings: { ...edit.lineLeadings } });
        }
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
    const { ddx, ddy } = computePsdDelta(ev);
    applyPreview(ddx, ddy);
  };
  const onUp = (ev) => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    window.removeEventListener("dragstart", suppressDefault, true);
    window.removeEventListener("selectstart", suppressDefault, true);
    document.body.style.userSelect = prevUserSelect;
    if (isDuplicate) document.body.style.cursor = prevCursor;
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
  if (!maybeApplyStickyFont()) rebuildLayerList();
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
  onClose,
  onCursorChange,
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
    if (onClose) onClose(commit);
  };
  input.__finalize = finalize;
  // カーソル位置から現在行を算出して通知。selectionStart までの \n の数 = 0-based 行番号。
  const reportCursor = () => {
    if (!onCursorChange) return;
    const pos = input.selectionStart ?? 0;
    const before = input.value.slice(0, pos);
    const lineIndex = (before.match(/\n/g) ?? []).length;
    const totalLines = (input.value.match(/\n/g) ?? []).length + 1;
    onCursorChange({ lineIndex, totalLines, contents: input.value });
  };
  input.addEventListener("focus", () => { hasFocused = true; reportCursor(); });
  input.addEventListener("keyup", reportCursor);
  input.addEventListener("click", reportCursor);
  input.addEventListener("input", reportCursor);
  input.addEventListener("select", reportCursor);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      finalize(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finalize(false);
    }
  });
  input.addEventListener("blur", (e) => {
    if (!hasFocused) return;
    // 行間 input / +/- / ルビボタンなど editor パネル内に focus が移ったときは
    // commit せずに textarea を残す（per-line leading 変更後にカーソル行を維持するため）。
    const next = e.relatedTarget;
    if (next && typeof next.closest === "function" && next.closest(".editor, .side-panel .editor")) {
      return;
    }
    finalize(true);
  });
  return input;
}

function startInPlaceEdit(ctx, target, options = {}) {
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

  // editingContext を立てて、サイドパネルの行間コントロールが per-line override に
  // 書き込めるようにする。target に応じて layerId / tempId を埋める。
  const editTargetMeta = target.kind === "existing"
    ? { psdPath: page.path, layerId: target.layer.id }
    : { psdPath: page.path, tempId: target.nl.tempId };

  createTextFloater(ctx, {
    x, y, direction,
    initialText,
    selectAll: true,
    onCursorChange: ({ lineIndex, totalLines, contents }) => {
      setEditingContext({ ...editTargetMeta, currentLineIndex: lineIndex, totalLines, contents });
    },
    onCommit: (value) => {
      // afterCommit 付き（原稿テキスト dblclick 経由など）はレイヤー編集と
      // afterCommit 内の状態変更（setTxtSource など）を 1 つの history snapshot に
      // 束ねる。これがないと Ctrl+Z で片方だけ巻き戻り原稿表示と乖離する。
      const hasAfter = typeof options.afterCommit === "function";
      if (hasAfter) beginHistoryTransient();
      if (target.kind === "existing") {
        setEdit(page.path, target.layer.id, { contents: value });
      } else {
        updateNewLayer(target.nl.tempId, { contents: value });
      }
      if (hasAfter) {
        try { options.afterCommit(value); } catch (e) { console.error("afterCommit error", e); }
        commitHistoryTransient();
      }
      refreshAllOverlays();
      rebuildLayerList();
    },
    onClose: () => setEditingContext(null),
  });
}

// 指定ページのレイヤー（既存 = 数値 layer.id / 新規 = 文字列 tempId）に対して
// in-place 編集を起動する。原稿テキストパネルの dblclick ハンドラ等から呼ぶ。
//
// - ページが現在表示中でなければ setCurrentPageIndex で切替し、`mounts` Map に
//   ctx が現れるまで rAF ポーリング（最大 ~10 frame）。spread-view の rAF debounce で
//   レンダーが何 frame 後になるかは決め打ちできないため固定 rAF×N より polling が安全。
// - direction（縦/横）に合わせて T/Y ツールへスイッチ（in-place 編集 textarea の見え方や
//   その後のキャンバス操作の予測可能性のため。既存の startInPlaceEdit と同じく commit 後は
//   ツールを戻さない＝既存挙動と一致）。
//
// options.afterCommit?: (value: string) => void — 編集確定（Ctrl+Enter / 外側クリック）後に
//   新しい値で呼ばれる。Esc キャンセル時は呼ばれない。原稿テキストパネルからの呼び出し時に
//   manuscript 側を同期するためのフック。
//
// 戻り値: 成功で true、ctx 取得失敗 / レイヤー不在 / page 不在で false。
export async function enterInPlaceEditForLayer(pageIndex, layerKey, options = {}) {
  if (!Number.isInteger(pageIndex) || pageIndex < 0) return false;

  if (getCurrentPageIndex() !== pageIndex) {
    setCurrentPageIndex(pageIndex);
  }

  const ctx = await waitForMountedCtx(pageIndex);
  if (!ctx) return false;

  const page = getPages()[pageIndex];
  if (!page) return false;

  let target;
  let direction;
  if (typeof layerKey === "string") {
    const nl = getNewLayersForPsd(page.path).find((l) => l.tempId === layerKey);
    if (!nl) return false;
    target = { kind: "new", nl };
    direction = nl.direction ?? "vertical";
  } else {
    const layer = page.textLayers.find((l) => l.id === layerKey);
    if (!layer) return false;
    const edit = getEdit(page.path, layerKey);
    target = { kind: "existing", layer };
    // edit override 無しの既存レイヤーは layer.direction を採用。
    // ag-psd 側で direction 不明だと "horizontal" が既定値になる仕様（縦書き想定でも
    // text-h ツールへ遷移することがある）— 編集対象レイヤー自身の direction に従う方針。
    direction = edit?.direction ?? layer.direction ?? "horizontal";
  }

  setTool(direction === "vertical" ? "text-v" : "text-h");
  setSelectedLayer(pageIndex, layerKey);

  startInPlaceEdit(ctx, target, { afterCommit: options.afterCommit });
  return true;
}

// `mounts.get(pageIndex)` が non-null になるまで rAF を最大 maxFrames 回待つ。
// 同期的にすでに mount 済みなら 0 frame で返る。
function waitForMountedCtx(pageIndex, maxFrames = 10) {
  return new Promise((resolve) => {
    let frames = 0;
    const tick = () => {
      const ctx = mounts.get(pageIndex);
      if (ctx) { resolve(ctx); return; }
      if (frames++ >= maxFrames) { resolve(null); return; }
      requestAnimationFrame(tick);
    };
    tick();
  });
}

function startTextInput(ctx, x, y, direction = "vertical") {
  const { page } = ctx;
  createTextFloater(ctx, {
    x, y, direction,
    guardBlurUntilFocused: true,
    onCommit: (value) => {
      if (!value) return;
      const sizePt = getTextSize();
      const layerDir = direction === "horizontal" ? "horizontal" : "vertical";
      const { x: nx, y: ny } = centerTopLeft(page, { contents: value, sizePt, direction: layerDir }, x, y);
      const created = addNewLayer({
        psdPath: page.path,
        x: nx,
        y: ny,
        contents: value,
        fontPostScriptName: getCurrentFont(),
        sizePt,
        direction: layerDir,
        strokeColor: getStrokeColor(),
        strokeWidthPx: getStrokeWidthPx(),
        fillColor: getFillColor(),
        leadingPct: getLeadingPct(),
      });
      setSelectedLayer(ctx.pageIndex, created.tempId);
      refreshAllOverlays();
      rebuildLayerList();
    },
  });
}
