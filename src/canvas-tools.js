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
  getLeadingPct,
  getNewLayersForPsd,
  getNewTextDirection,
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
import { getDefault, onSettingsChange } from "./settings.js";
import { commitFontToSelections, rebuildLayerList } from "./text-editor.js";
import { advanceTxtSelection, cascadeRemoveTxtForLayers, getActiveTxtSelection } from "./txt-source.js";

const mounts = new Map();
const resizeObservers = new Set();
let toolListenerBound = false;

// 【v1.16.0】in-place 編集 textarea 上の文字選択範囲のキャッシュ。
// reportCursor の発火点で必ずモジュール変数に保存しておくことで、focus 変動の影響を回避。
// editingContext は select イベントのタイミングで更新するが、フォーカスが他の input
// (size / font 入力欄など) に移ったときに古い値が残ることがある。これを補うため、
// reportCursor が走るたびに module-level でも選択範囲を保持する。サイドバーから直接
// 参照できるよう listener API で通知する。
let _lastInplaceSelection = null;
const _selectionChangeListeners = new Set();
export function getLastInplaceSelection() { return _lastInplaceSelection; }
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
      && a.layerId === b.layerId && a.tempId === b.tempId) return;
  _lastInplaceSelection = b;
  for (const fn of _selectionChangeListeners) fn(b);
}

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

// 環境設定（フォント名表示 / サイズ表示の切替など）が変わったらオーバーレイを再描画して
// 選択中のバッジに即時反映する。
let settingsListenerBound = false;
function bindSettingsListener() {
  if (settingsListenerBound) return;
  settingsListenerBound = true;
  onSettingsChange(() => refreshAllOverlays());
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
    refreshAllOverlays();
    rebuildLayerList();
  }
  return !!moved;
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
  const newLayersAll = (typeof window !== "undefined" ? null : null) || [];
  // モジュールスコープに getNewLayers が無いので getNewLayersForPsd 経由で取得する代わりに、
  // selection の page から layer を解決する。
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
  const changed = withHistoryTransient(() => {
    let any = false;
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
        any = true;
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
        any = true;
      }
    }
    return any || false;
  });
  if (changed) {
    refreshAllOverlays();
    rebuildLayerList();
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

function layerRectForExisting(page, layer, edit) {
  const dpi = page.dpi ?? 72;
  const left0 = layer.left ?? 0;
  const top0 = layer.top ?? 0;
  const rawWidth = Math.max(0, (layer.right ?? 0) - left0);
  const rawHeight = Math.max(0, (layer.bottom ?? 0) - top0);

  const direction = edit.direction ?? layer.direction ?? "horizontal";
  const isVertical = direction === "vertical";
  const previewText = edit.contents ?? layer.text ?? "";
  const chars = Math.max(1, longestLine(previewText));
  const lineCount = Math.max(1, countLines(previewText));
  // 【v1.16.0】枠の自動調整 — フォント実描画幅 + per-char サイズ/フォント override で long を再算出。
  // 測定失敗 / 未ロード時は null → 従来の chars 推定にフォールバック。
  const fontPs = edit.fontPostScriptName ?? layer.font ?? null;
  // 行間 (autoLeadingAmount %) を厚み（行スタック方向）の係数に反映。125% を最低値として
  // 設定しても既存の見た目より細くしないように clamp。
  const leadingFactor = Math.max(1.25, ((edit.leadingPct ?? 125) / 100));

  const sizePt = getExistingLayerEffectiveSizePt(page, layer, edit);
  const ptInPsdPx = sizePt * (dpi / 72);
  // 【v1.16.0】measureMaxLineExtentEm はここで sizePt が確定してから呼ぶ（per-char override も反映）。
  const measuredEm = measureMaxLineExtentEm(previewText, fontPs, sizePt, edit.charSizes, edit.charFonts);
  // CJK 縦書きで小書き仮名（ょ・っ・ゃ等）や glyph の line-box overhang、
  // text-stroke の outset 半分（stroke 既定 20 PSD px → ~0.16em）を吸収するため
  // 列方向に 0.4em の安全余白を足す。テキスト本体は CSS で bbox 中央に配置するので
  // bbox が広がっても視覚位置は不変。
  // LONG 軸（流し方向）にも display 系フォントの ascender/descender が em-box を
  // 超えてはみ出すぶんの安全余白を 0.4em 加える。
  const THICK_SAFETY = 0.4;
  const LONG_SAFETY = 0.4;
  // 【v1.16.0】行ごとに leading override + per-char サイズ override を反映して厚みを合算。
  // 行 N の override = 行 N-1 と行 N の隙間（marginBlockStart）。行 0 は「前の行」がないので無視。
  // per-char サイズ override がある行はその行の最大文字サイズで line-height をスケール。
  const lineLeadings = edit.lineLeadings ?? {};
  const charSizesMap = edit.charSizes ?? {};
  const linesArrE = previewText.split(/\r?\n/);
  const lineStartsE = getLineStartOffsets(previewText);
  let thickSum = 0;
  for (let i = 0; i < lineCount; i++) {
    const v = (i > 0 && Number.isFinite(lineLeadings[i])) ? lineLeadings[i] / 100 : leadingFactor;
    const leading = Math.max(1.25, v);
    let lineMaxRatio = 1;
    const line = linesArrE[i] ?? "";
    const startIdx = lineStartsE[i] ?? 0;
    for (let k = 0; k < line.length; k++) {
      const cs = charSizesMap[startIdx + k];
      if (Number.isFinite(cs) && cs > 0) {
        const ratio = cs / sizePt;
        if (ratio > lineMaxRatio) lineMaxRatio = ratio;
      }
    }
    thickSum += leading * lineMaxRatio;
  }
  const fallbackThick = ptInPsdPx * (thickSum + THICK_SAFETY);
  // long 軸: 実測 em があればそれ、無ければ chars × 1.05 のヒューリスティック。
  // CJK 縦書き等は chars と em がほぼ等価、Latin 系では em < chars になるので bbox が縮む。
  const longChars = Number.isFinite(measuredEm) && measuredEm > 0 ? measuredEm : 1.05 * chars;
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

function layerRectForNew(page, nl) {
  const dpi = page.dpi ?? 72;
  const isVertical = nl.direction !== "horizontal";
  const sizePt = nl.sizePt ?? 24;
  const ptInPsdPx = sizePt * (dpi / 72);
  const contents = nl.contents ?? "";
  const chars = Math.max(1, longestLine(contents));
  const lineCount = Math.max(1, countLines(contents));
  // 【v1.16.0】枠の自動調整 — 実描画幅で long を auto-fit（フォント変更 + per-char サイズ/フォント変更で bbox 自動更新）。
  const measuredEm = measureMaxLineExtentEm(contents, nl.fontPostScriptName, sizePt, nl.charSizes, nl.charFonts);
  // 行間 (%) を厚み係数に反映。125 が既定。
  // 小書き仮名 + stroke overhang を吸収する 0.4em の安全余白を THICK 軸に加算。テキスト本体は
  // CSS padding で bbox 中央に配置されるので、bbox が広がっても視覚位置は変わらない。
  // LONG 軸（流し方向）にも display 系フォントの ascender/descender overshoot 用に 0.4em 加える。
  const leadingFactor = (nl.leadingPct ?? 125) / 100;
  // 【v1.16.0】行ごとに leading override + per-char サイズ override を反映して厚みを合算。
  const lineLeadings = nl.lineLeadings ?? {};
  const charSizesMap = nl.charSizes ?? {};
  const linesArrN = contents.split(/\r?\n/);
  const lineStartsN = getLineStartOffsets(contents);
  let thickSum = 0;
  for (let i = 0; i < lineCount; i++) {
    const v = (i > 0 && Number.isFinite(lineLeadings[i])) ? lineLeadings[i] / 100 : leadingFactor;
    let lineMaxRatio = 1;
    const line = linesArrN[i] ?? "";
    const startIdx = lineStartsN[i] ?? 0;
    for (let k = 0; k < line.length; k++) {
      const cs = charSizesMap[startIdx + k];
      if (Number.isFinite(cs) && cs > 0) {
        const ratio = cs / sizePt;
        if (ratio > lineMaxRatio) lineMaxRatio = ratio;
      }
    }
    thickSum += v * lineMaxRatio;
  }
  const thick = Math.max(24, ptInPsdPx * (thickSum + 0.4));
  const longChars = Number.isFinite(measuredEm) && measuredEm > 0 ? measuredEm : 1.05 * chars;
  const longRaw = Math.max(ptInPsdPx * 2, ptInPsdPx * (longChars + 0.4));
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
  // 【v1.16.0】innerHTML = "" を撤廃し layer-box / marquee-rect だけ削除する。
  // これにより in-place 編集の textarea (.text-input-floater) が overlay 内に残り、
  // フォントロード完了 → onFontsRegistered → refreshAllOverlays の連鎖で
  // 編集中 textarea が消失する事故を防ぐ。マーキー矩形は marqueeState の復元コードが
  // drawMarquee() で再描画する。
  for (const el of overlay.querySelectorAll(".layer-box, .marquee-rect")) el.remove();

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
    // tracking は既存レイヤーには適用しない（PS 側に書き戻さない方針と整合させ、保存後の見た目とプレビューを一致させる）。
    // tcy（縦中横）は「見た目の確認」用途で縦書きの既存レイヤープレビューにも反映する（PS 側の実値とは独立）。
    const defaultLeadPct = Number.isFinite(edit.leadingPct) ? edit.leadingPct : 105;
    const tcyEnabled = getDefault("tateChuYokoEnabled") !== false;
    // 【v1.16.0】per-char サイズ/フォント override + sizePt を渡して per-line bbox / 文字描画を反映。
    const existingSizePt = getExistingLayerEffectiveSizePt(page, layer, edit);
    renderInnerText(
      inner, rect.previewText, defaultLeadPct, edit.lineLeadings, 0, 0,
      tcyEnabled && rect.isVertical,
      rect.isVertical,
      edit.charSizes, existingSizePt, edit.charFonts,
    );
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
      // バッジは bounds 逆算後の実効 pt（layerRectForExisting が rect.ptInPsdPx に反映済み）を表示。
      // 環境設定でフォント/サイズ両方とも非表示の場合 createSizeBadge は null を返す。
      const effectivePt = edit.sizePt ?? (rect.ptInPsdPx * 72 / (page.dpi ?? 72));
      const badge = createSizeBadge(effectivePt, page, edit.fontPostScriptName ?? layer.font ?? null);
      if (badge) box.appendChild(badge);
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
    // 新規レイヤーには環境設定の連続記号ツメ（dash/tilde グループ別）を適用。PS 保存にも同じ値を書き戻す。
    // tcy（縦中横）も新規かつ縦書きレイヤーに適用、PS 保存でも textStyleRange の tcy 属性を立てる。
    const dashMille = Number(getDefault("dashTrackingMille")) || 0;
    const tildeMille = Number(getDefault("tildeTrackingMille")) || 0;
    const tcyEnabledNew = getDefault("tateChuYokoEnabled") !== false;
    // 【v1.16.0】per-char サイズ/フォント override + sizePt を渡して per-line bbox / 文字描画を反映。
    renderInnerText(
      inner, nl.contents, nl.leadingPct ?? 125, nl.lineLeadings, dashMille, tildeMille,
      tcyEnabledNew && rect.isVertical,
      rect.isVertical,
      nl.charSizes, nl.sizePt ?? 24, nl.charFonts,
    );
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
      const newBadge = createSizeBadge(nl.sizePt ?? 24, page, nl.fontPostScriptName ?? null);
      if (newBadge) box.appendChild(newBadge);
    }
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
}

// 【v1.16.0】枠の自動調整（後置の保険）— measureText の予測がズレた場合の最終フォールバック。
// 各 layer-box の inner.scrollWidth/Height を測って、box を超えていたら box CSS を伸ばす。
// PSD 座標 → % 換算で指定。直接的な auto-fit 保険として動作する。
function scheduleBoxAutoFit(ctx) {
  if (typeof requestAnimationFrame !== "function") return;
  if (ctx._autoFitScheduled) return;
  ctx._autoFitScheduled = true;
  requestAnimationFrame(() => {
    ctx._autoFitScheduled = false;
    if (!ctx.overlay || !ctx.canvas) return;
    const overlayW = ctx.overlay.clientWidth;
    const overlayH = ctx.overlay.clientHeight;
    if (overlayW <= 0 || overlayH <= 0) return;
    for (const box of ctx.overlay.querySelectorAll(".layer-box")) {
      const inner = box.querySelector(".existing-layer-text, .new-layer-text");
      if (!inner) continue;
      const sw = inner.scrollWidth;
      const sh = inner.scrollHeight;
      const cw = inner.clientWidth;
      const ch = inner.clientHeight;
      const overflowW = sw - cw;
      const overflowH = sh - ch;
      if (overflowW > 1) {
        const newW = (box.offsetWidth + overflowW + 4); // 4px 余裕
        box.style.width = `${(newW / overlayW) * 100}%`;
      }
      if (overflowH > 1) {
        const newH = (box.offsetHeight + overflowH + 4);
        box.style.height = `${(newH / overlayH) * 100}%`;
      }
    }
  });
}

// 【v1.16.0】非対応フォントの対応 — 常に引用で数字始まり / 非 ASCII 名 / 予約語衝突を一括対処。
// 旧: `[\s,'"()]` を含むときだけ引用 → `851チカラヅヨク` のような数字始まり PS 名や
// 非 ASCII 名フォントが unquoted で CSS parse error を起こし、font-family 全体が
// 無効化される事故が発生していた。常時引用にすればこれらを完全に防げる。
function quoteFontFamily(name) {
  if (!name) return null;
  const escaped = String(name).replace(/["\\]/g, "\\$&");
  return `"${escaped}"`;
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

// fullText の各行の絶対開始 index を返す（textarea selectionStart と同じインデックス系）。
// 【v1.16.0】per-char サイズ/フォント機能で行内 i 番目の char の絶対 index を引くために使う。
function getLineStartOffsets(fullText) {
  const offsets = [0];
  const regex = /\r?\n/g;
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
function measureLineExtentEmWithOverrides(line, lineStartIdx, charSizes, charFonts, layerSizePt, layerFontPs) {
  if (!line) return 0;
  if (!Number.isFinite(layerSizePt) || layerSizePt <= 0) return null;
  let ctx;
  try { ctx = getMeasureContext(); } catch { return null; }
  const refSizePx = 100;
  let totalEm = 0;
  let i = 0;
  while (i < line.length) {
    const sizeStart = Number.isFinite(charSizes?.[lineStartIdx + i]) ? charSizes[lineStartIdx + i] : layerSizePt;
    const fontStart = (typeof charFonts?.[lineStartIdx + i] === "string" && charFonts[lineStartIdx + i].length > 0)
      ? charFonts[lineStartIdx + i] : layerFontPs;
    let j = i + 1;
    while (j < line.length) {
      const sz = Number.isFinite(charSizes?.[lineStartIdx + j]) ? charSizes[lineStartIdx + j] : layerSizePt;
      const fn = (typeof charFonts?.[lineStartIdx + j] === "string" && charFonts[lineStartIdx + j].length > 0)
        ? charFonts[lineStartIdx + j] : layerFontPs;
      if (sz !== sizeStart || fn !== fontStart) break;
      j++;
    }
    const segText = line.slice(i, j);
    const fam = cssFontFamily(fontStart) || "sans-serif";
    // bbox 計算で参照する font を先読み開始（ロード完了後に onFontsRegistered →
    // refreshAllOverlays で再描画されて bbox が確定する）。
    if (fontStart) ensureFontLoaded(fontStart);
    const fontShorthand = `${refSizePx}px ${fam}`;
    // フォント未ロード時は measureText が fallback フォントで誤った値を返す。
    // それを使うと bbox が一時的に小さく計算されて、CSS 側の `white-space: pre-wrap` で
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
      try { w = ctx.measureText(segText).width; } catch { return null; }
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
    const segWidthAtLayerEm = segWidthAtCharSizeEm * (sizeStart / layerSizePt);
    totalEm += segWidthAtLayerEm;
    i = j;
  }
  return totalEm;
}

// 全行の最大行幅を「layer.sizePt em 単位」で返す。
// charSizes / charFonts に override があれば反映、なければ layer フォント単一で測定。
function measureMaxLineExtentEm(text, postScriptName, layerSizePt, charSizes, charFonts) {
  if (!text) return 0;
  if (!Number.isFinite(layerSizePt) || layerSizePt <= 0) return null;
  const fullText = String(text);
  const linesArr = fullText.split(/\r?\n/);
  const lineStarts = getLineStartOffsets(fullText);
  let maxEm = 0;
  for (let li = 0; li < linesArr.length; li++) {
    const em = measureLineExtentEmWithOverrides(
      linesArr[li], lineStarts[li], charSizes, charFonts, layerSizePt, postScriptName,
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
const DASH_CHARS = new Set(["—", "―", "–", "‒", "‐", "‑", "ー", "－"]);
const TILDE_CHARS = new Set(["〜", "～"]);
const REPEATED_TARGET_REGEX = /[—―–‒‐‑ー－〜～]/;

// 縦中横（tate-chu-yoko）対象の半角ペア。先頭から 2 文字単位で探索し、3 文字以上連続のとき
// 余り 1 文字は単独扱い（ユーザー仕様）。Photoshop 側 (jsx_gen.rs) でも同じ判定を行う。
const TCY_PAIR_REGEX = /!!|!\?/;

function repeatedTargetGroup(ch) {
  if (DASH_CHARS.has(ch)) return "dash";
  if (TILDE_CHARS.has(ch)) return "tilde";
  return null;
}
function isRepeatedTargetChar(ch) {
  return repeatedTargetGroup(ch) !== null;
}

// 1 行を [{text, isTargetRun}] のセグメント列に分解する。
// 例: "あ―――い" → [{あ, false}, {―――, true}, {い, false}]
// 例: "―〜―あ" → [{―〜―, true}, {あ, false}]（混在連続も同じラン扱い）
function findRepeatedTargetRuns(line) {
  const out = [];
  let i = 0;
  while (i < line.length) {
    const inRun = isRepeatedTargetChar(line[i]);
    let j = i;
    while (j < line.length && isRepeatedTargetChar(line[j]) === inRun) j++;
    out.push({ text: line.slice(i, j), isTargetRun: inRun });
    i = j;
  }
  return out;
}

// 半角 !! / !? の出現位置を 2 文字ペアとして列挙する。先頭から貪欲に消費するので
// "!!!" → [(0,2)]（末尾 ! は単独）、"!!?!" → [(0,2)] (! 単独 + ! 単独)、
// "!!!!?" → [(0,2), (2,4)]（末尾 ? は単独）。
function findTcyPairs(line) {
  const pairs = [];
  for (let i = 0; i < line.length - 1; ) {
    const two = line.slice(i, i + 2);
    if (two === "!!" || two === "!?") {
      pairs.push({ start: i, end: i + 2 });
      i += 2;
    } else {
      i += 1;
    }
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
// dashMille / tildeMille は正負どちらの符号でも「絶対値ぶん詰める」セマンティクスに統一。
// tcyOn は呼び出し側で「設定 ON かつ縦書きレイヤー」の合成済みフラグを期待する。
//
// 連続する同 signature (size, tracking, font) の文字を 1 span にまとめて DOM 軽量化。
function appendLineWithTracking(parentEl, line, lineStartIdx, dashMille, tildeMille, tcyOn, charSizes, defaultSizePt, charFonts) {
  if (!line.length) {
    // 空行は zero-width space で line-box を維持（縦書きで列が消えないように）。
    parentEl.appendChild(document.createTextNode("​"));
    return;
  }
  const dashMag = Math.abs(Number(dashMille) || 0);
  const tildeMag = Math.abs(Number(tildeMille) || 0);
  const tcyPairs = tcyOn ? findTcyPairs(line) : [];
  const hasCharSizes = charSizes && Object.keys(charSizes).length > 0;
  const hasCharFonts = charFonts && Object.keys(charFonts).length > 0;
  const trackingActive = (dashMag > 0 || tildeMag > 0) && REPEATED_TARGET_REGEX.test(line);
  // 高速パス：何も装飾なし → 単純テキストノード 1 つで終わり
  if (!trackingActive && tcyPairs.length === 0 && !hasCharSizes && !hasCharFonts) {
    parentEl.appendChild(document.createTextNode(line));
    return;
  }
  // 各文字の tracking 値（em 単位、負）を事前計算。連続ランの最後の文字は 0。
  const trackings = new Array(line.length).fill(0);
  if (trackingActive) {
    const segments = findRepeatedTargetRuns(line);
    let pos = 0;
    for (const seg of segments) {
      if (seg.isTargetRun && seg.text.length >= 2) {
        for (let k = 0; k < seg.text.length - 1; k++) {
          const grp = repeatedTargetGroup(seg.text[k]);
          const mag = grp === "dash" ? dashMag : grp === "tilde" ? tildeMag : 0;
          if (mag > 0) trackings[pos + k] = -mag / 1000;
        }
      }
      pos += seg.text.length;
    }
  }
  // tcy ペア境界で分割し、各セグメントを「tcy 内」(text-combine-upright) または
  // 「tcy 外」(per-char signature 統合) として出力する。
  let pos = 0;
  for (const pair of tcyPairs) {
    if (pair.start > pos) {
      appendStyledSegment(parentEl, line.slice(pos, pair.start), pos, lineStartIdx, trackings, charSizes, defaultSizePt, charFonts, hasCharSizes, hasCharFonts);
    }
    const span = document.createElement("span");
    span.className = "tcy-span";
    span.textContent = line.slice(pair.start, pair.end);
    parentEl.appendChild(span);
    pos = pair.end;
  }
  if (pos < line.length) {
    appendStyledSegment(parentEl, line.slice(pos), pos, lineStartIdx, trackings, charSizes, defaultSizePt, charFonts, hasCharSizes, hasCharFonts);
  }
}

// 【v1.16.0】tcy 外セグメントを per-char signature (size, tracking, font) 統合で append。
// segStartInLine: このセグメントが line のどの位置から始まるか（trackings 配列の index 算出用）
// lineStartIdx: line が full contents のどの位置から始まるか（charSizes / charFonts の絶対 index 算出用）
function appendStyledSegment(parentEl, segText, segStartInLine, lineStartIdx, trackings, charSizes, defaultSizePt, charFonts, hasCharSizes, hasCharFonts) {
  if (!segText.length) return;
  let i = 0;
  while (i < segText.length) {
    const absIdx = lineStartIdx + segStartInLine + i;
    const sigSize = hasCharSizes ? charSizes[absIdx] : undefined;
    const sigTrack = trackings[segStartInLine + i];
    const sigFont = hasCharFonts ? charFonts[absIdx] : undefined;
    let j = i + 1;
    while (j < segText.length) {
      const absJ = lineStartIdx + segStartInLine + j;
      const s = hasCharSizes ? charSizes[absJ] : undefined;
      const t = trackings[segStartInLine + j];
      const f = hasCharFonts ? charFonts[absJ] : undefined;
      if (s !== sigSize || t !== sigTrack || f !== sigFont) break;
      j++;
    }
    const text = segText.slice(i, j);
    const needsSpan = Number.isFinite(sigSize) || sigTrack !== 0 || (typeof sigFont === "string" && sigFont.length > 0);
    if (needsSpan) {
      const span = document.createElement("span");
      if (Number.isFinite(sigSize) && Number.isFinite(defaultSizePt) && defaultSizePt > 0) {
        // sigSize は pt 単位。inner の font-size は layer default を screen px で持つので
        // (sigSize / defaultSizePt) em 表記で相対指定する。
        span.style.fontSize = `${sigSize / defaultSizePt}em`;
      }
      if (sigTrack !== 0) {
        span.style.letterSpacing = `${sigTrack}em`;
      }
      if (typeof sigFont === "string" && sigFont.length > 0) {
        // PostScript 名から family-name 解決 → font-family を上書き。
        const fam = cssFontFamily(sigFont);
        if (fam) span.style.fontFamily = fam;
        ensureFontLoaded(sigFont);
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
function renderInnerText(inner, text, defaultLeadingPct, lineLeadings, dashMille, tildeMille, tcyOn, isVertical, charSizes, defaultSizePt, charFonts) {
  inner.textContent = "";
  const overrides = lineLeadings && Object.keys(lineLeadings).length > 0 ? lineLeadings : null;
  const hasCharSizes = charSizes && Object.keys(charSizes).length > 0;
  const hasCharFonts = charFonts && Object.keys(charFonts).length > 0;
  const fallback = String((defaultLeadingPct ?? 125) / 100);
  const dashMag = Math.abs(Number(dashMille) || 0);
  const tildeMag = Math.abs(Number(tildeMille) || 0);
  const fullText = String(text ?? "");
  const trackingHits = (dashMag > 0 || tildeMag > 0) && REPEATED_TARGET_REGEX.test(fullText);
  const tcyHits = !!tcyOn && TCY_PAIR_REGEX.test(fullText);
  // 高速パス：何も装飾なし
  if (!overrides && !trackingHits && !tcyHits && !hasCharSizes && !hasCharFonts) {
    inner.textContent = fullText;
    inner.style.lineHeight = fallback;
    return;
  }
  const lines = fullText.split(/\r?\n/);
  const lineStarts = getLineStartOffsets(fullText);
  inner.style.lineHeight = fallback;
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
      if (i > 0 && Number.isFinite(overrides[i])) {
        const overrideFactor = overrides[i] / 100;
        const extra = overrideFactor - layerFactor;
        if (Math.abs(extra) > 0.001) {
          lineEl.style.marginBlockStart = `${extra}em`;
        }
      }
      appendLineWithTracking(lineEl, lines[i], lineStarts[i], dashMag, tildeMag, tcyOn, charSizes, defaultSizePt, charFonts);
      inner.appendChild(lineEl);
    }
  } else {
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) inner.appendChild(document.createElement("br"));
      appendLineWithTracking(inner, lines[i], lineStarts[i], dashMag, tildeMag, tcyOn, charSizes, defaultSizePt, charFonts);
    }
  }
}

function createSizeBadge(sizePt, page, fontPostScriptName) {
  // 環境設定（デフォルトタブ）でフォント名・文字サイズの表示/非表示を一括切替。
  // OFF の場合はバッジ自体を生成せず null を返し、呼び出し側で append をスキップする。
  if (getDefault("showBadge") === false) return null;

  const el = document.createElement("div");
  el.className = "layer-size-badge";
  // 基準PSD 比で換算した pt を表示。基準が 1 ページ目（または未読込）の場合は素のまま。
  const display = toDisplaySizePt(sizePt ?? 0, page);
  const rounded = Math.round((display ?? 0) * 10) / 10;
  const fontName = fontPostScriptName ? (getFontDisplayName(fontPostScriptName) ?? fontPostScriptName) : "";
  // フォント名と文字サイズを 2 行に分けて表示（フォント上 / サイズ下）。
  if (fontName) {
    const fontEl = document.createElement("div");
    fontEl.className = "layer-size-badge-font";
    fontEl.textContent = fontName;
    el.appendChild(fontEl);
  }
  const sizeEl = document.createElement("div");
  sizeEl.className = "layer-size-badge-size";
  sizeEl.textContent = `${rounded}pt`;
  el.appendChild(sizeEl);
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
  if (tool === "move") {
    e.preventDefault();
    // 1) アクティブな text-input floater があれば finalize して終了。
    const openFloater = document.querySelector(".text-input-floater");
    if (openFloater) {
      if (typeof openFloater.__finalize === "function") openFloater.__finalize(true);
      else openFloater.remove();
      return;
    }
    // 2) 原稿テキストブロックが選択中ならクリック点に配置（既存挙動維持）。
    const { x, y } = canvasCoordsFromEvent(e, ctx);
    const txtSel = getActiveTxtSelection();
    if (txtSel) {
      placeTxtSelectionAt(ctx, x, y, txtSel, getNewTextDirection());
      return;
    }
    // 3) 空所への 350ms 以内の 2 回目クリック → 新規テキスト入力欄を開く。
    const now = Date.now();
    if (isCanvasDoubleClick(now, x, y)) {
      lastCanvasClickAt = 0; // 連続トリガを抑止（次の click は単独扱い）
      startTextInput(ctx, x, y, getNewTextDirection());
      return;
    }
    // 4) シングルクリック: 次回 dblclick 検出のため記録 + マーキー開始。
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
export function centerTopLeft(page, { contents, sizePt, direction, leadingPct }, clickX, clickY) {
  const r = layerRectForNew(page, { x: 0, y: 0, contents, sizePt, direction, leadingPct });
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
  if (tool !== "move") return;
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

function isLayerDoubleClick(pageIndex, layerKey) {
  const now = performance.now();
  const composite = `${pageIndex}::${layerKey}`;
  const isDouble = (now - lastLayerClickAt) < DBLCLICK_THRESHOLD_MS && lastLayerClickKey === composite;
  lastLayerClickAt = now;
  lastLayerClickKey = composite;
  return isDouble;
}

// V（選択）ツール選択中にテキストフレームをダブルクリックすると、in-place 編集を開始する。
// T/Y ツールが廃止され V に統合された後は、ツール切替は不要（V に居続ける）。
// direction は対象レイヤー自身の direction に従って floater の見え方が決まる。
function enterInPlaceEditFromMove(ctx, target) {
  const layerKey = target.kind === "existing" ? target.layer.id : target.nl.tempId;
  setSelectedLayer(ctx.pageIndex, layerKey);
  renderOverlay(ctx);
  rebuildLayerList();
  startInPlaceEdit(ctx, target);
}

function onExistingLayerMouseDown(e, ctx, layer) {
  const tool = getTool();
  if (tool !== "move") return;
  e.stopPropagation();
  e.preventDefault();
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
  e.stopPropagation();
  e.preventDefault();
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
    if (isDuplicate || lastSwapTarget) document.body.style.cursor = prevCursor;
    // swap モード中の hover ハイライト残骸を必ず掃除（refreshAllOverlays でも再構築されるが
    // 通常移動分岐では DOM が再生成されないため明示的に外す）。
    applySwapVisuals(null);
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

// テキスト入力 textarea の共通生成ヘルパ。
// DOM 生成・配置・keydown/focus/blur 配線・`__finalize` 付与を集約し、
// commit 時のアクションだけ `onCommit(value)` で呼び出し元に委ねる。
function createTextFloater(ctx, {
  x, y, direction,
  width = null,
  height = null,
  fontSizePsd = null,
  initialText = "",
  selectAll = false,
  guardBlurUntilFocused = false,
  anchor = "top-left",
  onCommit,
  onClose,
  onCursorChange,
  // 【v1.16.0】per-char 編集対象を識別するためのレイヤー情報。
  // { psdPath, layerId | tempId }。これがあれば textarea 上の文字選択を
  // _lastInplaceSelection キャッシュに保存し、サイドバーの commitFont /
  // applyTextSize から参照できるようにする（focus 移動の影響を回避）。
  layerMeta = null,
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
  // 既存テキストフレームの打ち換え（startInPlaceEdit）では rect の中央から
  // 展開するよう transform で自身を中心合わせ。新規テキスト配置（startTextInput）は
  // クリック点を左上に固定したいので既定の "top-left" のまま。
  if (anchor === "center") {
    input.style.transform = "translate(-50%, -50%)";
  }
  // 打ち換え時は frame サイズに合わせて textarea を縮める（CSS の min-height: 160px を上書き）。
  // PSD 座標を page 寸法比の % に変換して反映、CSS の min-* を 0 に倒して content にぴったり寄せる。
  if (width != null && height != null) {
    input.style.width = `${(width / page.width) * 100}%`;
    input.style.height = `${(height / page.height) * 100}%`;
    input.style.minWidth = "0";
    input.style.minHeight = "0";
    input.style.boxSizing = "border-box";
  }
  // textarea 内の文字を frame と同じ pt サイズで表示する。CSS 既定の 16px のままだと
  // frame に対して文字が小さすぎ「textarea が小さく見える」原因になる。
  // PSD px → screen px の換算は canvas.clientWidth / page.width で取得。
  if (fontSizePsd != null && fontSizePsd > 0) {
    const pxPerPsd = ctx.canvas.clientWidth > 0 ? ctx.canvas.clientWidth / page.width : 0;
    if (pxPerPsd > 0) {
      input.style.fontSize = `${fontSizePsd * pxPerPsd}px`;
      input.style.lineHeight = "1.25";
      input.style.padding = "0";
    }
  }
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
    // 【v1.16.0】floater が消えるタイミングで選択キャッシュもクリア。
    setLastInplaceSelection(null);
    if (commit) onCommit(value);
    if (onClose) onClose(commit);
  };
  input.__finalize = finalize;
  // カーソル位置から現在行を算出して通知。selectionStart までの \n の数 = 0-based 行番号。
  // selectionStart === selectionEnd の場合は単純カーソル、異なれば文字選択中。
  const reportCursor = () => {
    const start = input.selectionStart ?? 0;
    const end = input.selectionEnd ?? start;
    // 【v1.16.0】module-level の選択範囲キャッシュも同時に更新。サイドバー側の
    // commitFont / applyTextSize はこちらから読むので focus 移動の影響を受けない。
    if (layerMeta) {
      if (end > start) {
        setLastInplaceSelection({
          start, end,
          psdPath: layerMeta.psdPath,
          layerId: layerMeta.layerId ?? null,
          tempId: layerMeta.tempId ?? null,
        });
      } else {
        setLastInplaceSelection(null);
      }
    }
    if (!onCursorChange) return;
    const before = input.value.slice(0, start);
    const lineIndex = (before.match(/\n/g) ?? []).length;
    const totalLines = (input.value.match(/\n/g) ?? []).length + 1;
    onCursorChange({
      lineIndex,
      totalLines,
      contents: input.value,
      selectionStart: start,
      selectionEnd: end,
    });
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
  let width = 0;
  let height = 0;
  let fontSizePsd = 0;

  // 打ち換え時は textarea を rect の中央から展開し、サイズも frame に合わせる。
  // layerRectFor* で frame の中心と寸法、内部 pt サイズを算出し createTextFloater に渡す。
  // 入力欄と文字を視認しやすくするため、frame の 2 倍に拡大して表示する（中心固定）。
  const EDIT_SCALE = 2;
  if (target.kind === "existing") {
    const layer = target.layer;
    const edit = getEdit(page.path, layer.id) ?? {};
    initialText = edit.contents ?? layer.text ?? "";
    direction = edit.direction ?? layer.direction ?? "horizontal";
    const rect = layerRectForExisting(page, layer, edit);
    x = rect.left + rect.width / 2;
    y = rect.top + rect.height / 2;
    width = rect.width * EDIT_SCALE;
    height = rect.height * EDIT_SCALE;
    fontSizePsd = rect.ptInPsdPx * EDIT_SCALE;
  } else {
    const nl = target.nl;
    initialText = nl.contents ?? "";
    direction = nl.direction ?? "vertical";
    const rect = layerRectForNew(page, nl);
    x = rect.left + rect.width / 2;
    y = rect.top + rect.height / 2;
    width = rect.width * EDIT_SCALE;
    height = rect.height * EDIT_SCALE;
    fontSizePsd = rect.ptInPsdPx * EDIT_SCALE;
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
    width, height,
    fontSizePsd,
    initialText,
    selectAll: true,
    anchor: "center",
    // 【v1.16.0】in-place 編集中の textarea 上の文字選択を _lastInplaceSelection に
    // キャッシュさせる。サイドバーの commitFont / applyTextSize はそちらを参照する。
    layerMeta: editTargetMeta,
    onCursorChange: ({ lineIndex, totalLines, contents, selectionStart, selectionEnd }) => {
      setEditingContext({
        ...editTargetMeta,
        currentLineIndex: lineIndex,
        totalLines,
        contents,
        selectionStart,
        selectionEnd,
      });
    },
    onCommit: (value) => {
      // afterCommit 付き（原稿テキスト dblclick 経由など）はレイヤー編集と
      // afterCommit 内の状態変更（setTxtSource など）を 1 つの history snapshot に
      // 束ねる。これがないと Ctrl+Z で片方だけ巻き戻り原稿表示と乖離する。
      const hasAfter = typeof options.afterCommit === "function";
      const writeLayer = () => {
        // 文字数変化で bbox サイズが変わると、top-left 固定では中心がずれて
        // ユーザーには「frame が動いた」ように見える。`resizeSelectedLayers` と同じ
        // パターンで old/new rect の差分を取り、中心固定になるよう位置を補正する。
        if (target.kind === "existing") {
          const layer = target.layer;
          const edit = getEdit(page.path, layer.id) ?? {};
          const oldRect = layerRectForExisting(page, layer, edit);
          const newRect = layerRectForExisting(page, layer, { ...edit, contents: value });
          const ddx = (oldRect.width - newRect.width) / 2;
          const ddy = (oldRect.height - newRect.height) / 2;
          setEdit(page.path, layer.id, {
            contents: value,
            dx: (edit.dx ?? 0) + ddx,
            dy: (edit.dy ?? 0) + ddy,
          });
        } else {
          const nl = target.nl;
          const oldRect = layerRectForNew(page, nl);
          const newRect = layerRectForNew(page, { ...nl, contents: value });
          const dx = (oldRect.width - newRect.width) / 2;
          const dy = (oldRect.height - newRect.height) / 2;
          updateNewLayer(nl.tempId, {
            contents: value,
            x: nl.x + dx,
            y: nl.y + dy,
          });
        }
        if (hasAfter) {
          try { options.afterCommit(value); } catch (e) { console.error("afterCommit error", e); }
        }
      };
      if (hasAfter) withHistoryTransient(writeLayer);
      else writeLayer();
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
  if (typeof layerKey === "string") {
    const nl = getNewLayersForPsd(page.path).find((l) => l.tempId === layerKey);
    if (!nl) return false;
    target = { kind: "new", nl };
  } else {
    const layer = page.textLayers.find((l) => l.id === layerKey);
    if (!layer) return false;
    target = { kind: "existing", layer };
  }

  // T/Y ツール廃止後は V のまま in-place 編集を開始する。direction は対象レイヤー自身の
  // direction を startInPlaceEdit が読み取って floater の見え方を決定する。
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
    // クリック点を frame の中心として扱う。floater も中央 anchor で展開するので
    // 「入力欄の中心 = 確定後のレイヤー中心 = クリックした位置」が一貫する。
    // (旧仕様では floater は top-left anchor、layer は中心配置で視覚と最終位置がずれていた)
    anchor: "center",
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
