import {
  withHistoryTransient,
  getCurrentFont,
  getCurrentPageIndex,
  getEdit,
  getFillColor,
  getFontDisplayName,
  getFonts,
  getNewLayersForPsd,
  getPages,
  getSelectedLayer,
  getSelectedLayers,
  getStrokeColor,
  getStrokeWidthPx,
  onCurrentFontChange,
  onFillColorChange,
  removeNewLayer,
  setCurrentFont,
  setCharHorizontalScalesRange,
  setCharKerningsRange,
  setCharTateChuYokosRange,
  setCharTrackingsRange,
  setCharVerticalScalesRange,
  setCurrentPageIndex,
  setEdit,
  setFillColor,
  setFontPickerStuck,
  setLeadingPct,
  setSelectedLayer,
  setSelectedLayers,
  setStrokeColor,
  setStrokeWidthPx,
  setTextSize,
  toDisplaySizePt,
  toggleLayerSelected,
  updateNewLayer,
  // 【v1.16.0】per-char フォント編集
  setCharFontsRange,
  getCharFont,
  // 【v1.26.0 移植 (PsDesign-main v1.24.0)】commit 系の中心固定で position delta を加算
  addEditOffset,
} from "./state.js";
import {
  clearTemporaryMultiSelectionAdornments,
  refreshAllOverlays,
  getExistingLayerEffectiveSizePt,
  maybeApplyStickyFont,
  // 【v1.16.0】in-place 編集 textarea 上の文字選択キャッシュ
  getLastInplaceSelection,
  onInplaceSelectionChange,
  // 【v1.21.0】per-char フォント変更時の編集中 DOM リアルタイム反映
  applyEditModeStyleToRange,
  cssFontFamily,
  refreshActiveInPlaceEditPreview,
  restoreInplaceSelection,
  showInplaceSelectionHighlightOnly,
  // 【v1.26.0 移植 (PsDesign-main v1.24.0)】commit 系の中心固定で bbox 再計算用
  layerRectForExisting,
  layerRectForNew,
  setSelectedLayerBadgesUserHidden,
  setSelectionAdornmentsVisible,
} from "./canvas-tools.js";
import { ensureFontLoaded, onFontsRegistered } from "./font-loader.js";
import { getDefault, onSettingsChange, setDefault } from "./settings.js";
import { formatTextSizePt, getTextSizeUnit } from "./text-size-unit.js";
import { confirmDialog, toast } from "./ui-feedback.js";

const listEl = () => document.getElementById("layer-list");
const editorEl = () => document.getElementById("editor");
const fontEl = () => document.getElementById("edit-font");
const fontComboboxEl = () => document.getElementById("edit-font-combobox");
const fontToggleEl = () => document.getElementById("edit-font-toggle");
const fontListEl = () => document.getElementById("edit-font-list");
const favoriteStyleListEl = () => document.getElementById("favorite-style-list");
const favoriteStyleSaveBtnEl = () => document.getElementById("favorite-style-save-btn");
const sizeInputEl = () => document.getElementById("size-input");
const horizontalScaleInputEl = () => document.getElementById("horizontal-scale-input");
const verticalScaleInputEl = () => document.getElementById("vertical-scale-input");
const trackingInputEl = () => document.getElementById("tracking-input");
const kerningInputEl = () => document.getElementById("kerning-input");
const tcyApplyBtnEl = () => document.getElementById("tcy-apply-btn");
const tcyRemoveBtnEl = () => document.getElementById("tcy-remove-btn");
const verticalHalfToFullSelectEl = () => document.getElementById("vertical-half-to-full-select");
const strokeNoneBtnEl = () => document.getElementById("stroke-none-btn");
const strokeWhiteBtnEl = () => document.getElementById("stroke-white-btn");
const strokeBlackBtnEl = () => document.getElementById("stroke-black-btn");
const convertWhiteStrokeBtnEl = () => document.getElementById("convert-white-stroke-btn");
const strokeWidthInputEl = () => document.getElementById("stroke-width-input");
const fillCustomBtnEl = () => document.getElementById("fill-custom-swatch");
const fillColorPickerEl = () => document.getElementById("fill-color-picker");
const fillButtonEls = () => Array.from(new Set([
  ...document.querySelectorAll(".toolbar-fill-swatch[data-fill]"),
  fillCustomBtnEl(),
].filter(Boolean)));
const HEX_FILL_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function normalizeFillChoice(color) {
  if (color === "white" || color === "black" || color === "default") return color;
  if (typeof color === "string" && HEX_FILL_COLOR_RE.test(color)) {
    const hex = color.toLowerCase();
    if (hex === "#ffffff") return "white";
    if (hex === "#000000") return "black";
    return hex;
  }
  return "default";
}

// color === null は「複数選択で値が混在している」状態。全ボタン非アクティブ。
function syncStrokeToggle(color) {
  const n = strokeNoneBtnEl();
  const w = strokeWhiteBtnEl();
  const b = strokeBlackBtnEl();
  if (n) n.classList.toggle("active", color === "none");
  if (w) w.classList.toggle("active", color === "white");
  if (b) b.classList.toggle("active", color === "black");
}

// color === null / default は混在または「そのまま」。見えるスウォッチは全て非アクティブにする。
function syncFillToggle(color) {
  const normalized = color == null ? null : normalizeFillChoice(color);
  syncCustomFillSwatch(normalized);
  for (const btn of fillButtonEls()) {
    const active = normalized != null && btn.dataset.fill === normalized;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  }
}

function syncCustomFillSwatch(color) {
  const btn = fillCustomBtnEl();
  const picker = fillColorPickerEl();
  if (!btn) return;
  const presetMatched = color != null && Array.from(document.querySelectorAll(".toolbar-fill-swatch[data-fill]"))
    .some((swatch) => swatch !== btn && swatch.dataset.fill === color);
  if (typeof color === "string" && HEX_FILL_COLOR_RE.test(color) && !presetMatched) {
    btn.dataset.fill = color;
    btn.style.background = color;
    btn.classList.add("has-color");
    if (picker) picker.value = color;
  }
}

function displayFontName(psName) {
  return getFontDisplayName(psName) ?? psName ?? "";
}

function normalizeFontSearchText(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("ja");
}

function fontSearchHaystack(font) {
  const aliases = Array.isArray(font?.aliases) ? font.aliases : [];
  return normalizeFontSearchText([
    font?.name,
    font?.postScriptName,
    ...aliases,
  ].filter(Boolean).join("\n"));
}

function layerDefaultFont(ref) {
  if (!ref) return null;
  return ref.kind === "existing"
    ? (getEdit(ref.page.path, ref.layer.id)?.fontPostScriptName ?? ref.layer.font ?? null)
    : (ref.newLayer.fontPostScriptName ?? null);
}

function charFontAt(ref, index) {
  if (!ref || !Number.isInteger(index)) return layerDefaultFont(ref);
  if (ref.kind === "existing") {
    const edit = getEdit(ref.page.path, ref.layer.id) ?? {};
    return edit.charFonts?.[index] ?? ref.layer.charFonts?.[index] ?? layerDefaultFont(ref);
  }
  return ref.newLayer.charFonts?.[index] ?? layerDefaultFont(ref);
}

function collectFontsForRange(ref, start, end) {
  const fonts = [];
  const seen = new Set();
  const add = (ps) => {
    if (!ps || seen.has(ps)) return;
    seen.add(ps);
    fonts.push(ps);
  };
  const text = ref?.kind === "existing"
    ? (getEdit(ref.page.path, ref.layer.id)?.contents ?? ref.layer.text ?? "")
    : (ref?.newLayer?.contents ?? "");
  const len = text.length;
  const from = Math.max(0, Math.min(len, Number.isInteger(start) ? start : 0));
  const to = Math.max(from, Math.min(len, Number.isInteger(end) ? end : len));
  if (to === from) {
    add(charFontAt(ref, Math.max(0, Math.min(len - 1, from))));
  } else {
    for (let i = from; i < to; i++) add(charFontAt(ref, i));
  }
  return fonts;
}

function layerDefaultSize(ref, page, layer, edit) {
  if (!ref) return null;
  if (ref.kind === "existing") return getExistingLayerEffectiveSizePt(page, layer, edit ?? {}) ?? null;
  return ref.newLayer.sizePt ?? null;
}

function charSizeAt(ref, index, defaultSizePt) {
  if (!ref || !Number.isInteger(index)) return defaultSizePt;
  if (ref.kind === "existing") {
    const edit = getEdit(ref.page.path, ref.layer.id) ?? {};
    const v = { ...(ref.layer.charSizes ?? {}), ...(edit.charSizes ?? {}) }[index];
    return Number.isFinite(v) ? v : defaultSizePt;
  }
  const v = ref.newLayer.charSizes?.[index];
  return Number.isFinite(v) ? v : defaultSizePt;
}

function collectSizesForRange(ref, start, end, defaultSizePt) {
  const sizes = [];
  const seen = new Set();
  const add = (pt) => {
    const n = Number(pt);
    if (!Number.isFinite(n)) return;
    const key = String(Math.round(n * 100) / 100);
    if (seen.has(key)) return;
    seen.add(key);
    sizes.push(n);
  };
  const text = ref?.kind === "existing"
    ? (getEdit(ref.page.path, ref.layer.id)?.contents ?? ref.layer.text ?? "")
    : (ref?.newLayer?.contents ?? "");
  const len = text.length;
  const from = Math.max(0, Math.min(len, Number.isInteger(start) ? start : 0));
  const to = Math.max(from, Math.min(len, Number.isInteger(end) ? end : len));
  if (to === from) {
    add(charSizeAt(ref, Math.max(0, Math.min(len - 1, from)), defaultSizePt));
  } else {
    for (let i = from; i < to; i++) add(charSizeAt(ref, i, defaultSizePt));
  }
  return sizes;
}

function scaleAt(ref, index, field, defaultValue = 100) {
  if (!ref || !Number.isInteger(index)) return defaultValue;
  if (ref.kind === "existing") {
    const edit = getEdit(ref.page.path, ref.layer.id) ?? {};
    const charField = field === "horizontalScale" ? "charHorizontalScales" : "charVerticalScales";
    const v = { ...(ref.layer[charField] ?? {}), ...(edit[charField] ?? {}) }[index];
    return Number.isFinite(v) ? v : (edit[field] ?? ref.layer[field] ?? defaultValue);
  }
  const charField = field === "horizontalScale" ? "charHorizontalScales" : "charVerticalScales";
  const v = ref.newLayer[charField]?.[index];
  return Number.isFinite(v) ? v : (ref.newLayer[field] ?? defaultValue);
}

function collectScalesForRange(ref, start, end, field) {
  const values = [];
  const seen = new Set();
  const add = (pct) => {
    const n = clampTextScalePercent(pct);
    if (!Number.isFinite(n)) return;
    if (seen.has(n)) return;
    seen.add(n);
    values.push(n);
  };
  const text = ref?.kind === "existing"
    ? (getEdit(ref.page.path, ref.layer.id)?.contents ?? ref.layer.text ?? "")
    : (ref?.newLayer?.contents ?? "");
  const len = text.length;
  const from = Math.max(0, Math.min(len, Number.isInteger(start) ? start : 0));
  const to = Math.max(from, Math.min(len, Number.isInteger(end) ? end : len));
  if (to === from) {
    add(scaleAt(ref, Math.max(0, Math.min(len - 1, from)), field));
  } else {
    for (let i = from; i < to; i++) add(scaleAt(ref, i, field));
  }
  return values;
}

function spacingAt(ref, index, field, defaultValue = 0) {
  if (!ref || !Number.isInteger(index)) return defaultValue;
  if (ref.kind === "existing") {
    const edit = getEdit(ref.page.path, ref.layer.id) ?? {};
    const charField = field === "trackingMille" ? "charTrackings" : "charKernings";
    const v = { ...(ref.layer[charField] ?? {}), ...(edit[charField] ?? {}) }[index];
    return Number.isFinite(v) ? v : (edit[field] ?? ref.layer[field] ?? defaultValue);
  }
  const charField = field === "trackingMille" ? "charTrackings" : "charKernings";
  const v = ref.newLayer[charField]?.[index];
  return Number.isFinite(v) ? v : (ref.newLayer[field] ?? defaultValue);
}

function collectSpacingsForRange(ref, start, end, field) {
  const values = [];
  const seen = new Set();
  const add = (mille) => {
    const n = clampTextSpacingMille(mille);
    if (!Number.isFinite(n)) return;
    if (seen.has(n)) return;
    seen.add(n);
    values.push(n);
  };
  const text = ref?.kind === "existing"
    ? (getEdit(ref.page.path, ref.layer.id)?.contents ?? ref.layer.text ?? "")
    : (ref?.newLayer?.contents ?? "");
  const len = text.length;
  const from = Math.max(0, Math.min(len, Number.isInteger(start) ? start : 0));
  const to = Math.max(from, Math.min(len, Number.isInteger(end) ? end : len));
  if (to === from) {
    add(spacingAt(ref, Math.max(0, Math.min(len - 1, from - 1)), field));
  } else {
    for (let i = from; i < to; i++) add(spacingAt(ref, i, field));
  }
  return values;
}

function getTcyContext(sel = getLastInplaceSelection()) {
  if (!sel || !Number.isInteger(sel.start) || !Number.isInteger(sel.end)) return null;
  const targetId = sel.tempId ?? sel.layerId;
  const page = getPages().find((p) => p.path === sel.psdPath);
  if (!page) return null;
  if (typeof targetId === "string") {
    const nl = getNewLayersForPsd(page.path).find((l) => l.tempId === targetId);
    if (!nl) return null;
    return {
      sel,
      targetId,
      text: String(nl.contents ?? ""),
      direction: nl.direction ?? "vertical",
      charTateChuYokos: nl.charTateChuYokos ?? {},
    };
  }
  const layer = page.textLayers?.find((l) => l.id === targetId);
  if (!layer) return null;
  const edit = getEdit(page.path, targetId) ?? {};
  return {
    sel,
    targetId,
    text: String(edit.contents ?? layer.text ?? ""),
    direction: edit.direction ?? layer.direction ?? "horizontal",
    charTateChuYokos: { ...(layer.charTateChuYokos ?? {}), ...(edit.charTateChuYokos ?? {}) },
  };
}

function isTcyTargetChar(ch) {
  return ch !== "\n" && ch !== "\r";
}

function rangesForTcy(text, start, end) {
  const len = text.length;
  if (len <= 0) return [];
  const runs = [];
  const pushSelectedRuns = (from, to) => {
    let i = from;
    while (i < to) {
      if (isTcyTargetChar(text[i])) {
        let j = i + 1;
        while (j < to && isTcyTargetChar(text[j])) j++;
        if (j - i >= 2) runs.push({ start: i, end: j });
        i = j;
      } else {
        i++;
      }
    }
  };
  const from = Math.max(0, Math.min(len, Number.isInteger(start) ? start : 0));
  const to = Math.max(from, Math.min(len, Number.isInteger(end) ? end : from));
  if (to > from) {
    pushSelectedRuns(from, to);
    return runs;
  }
  let pos = Math.max(0, Math.min(len - 1, from));
  if (!isTcyTargetChar(text[pos]) && from > 0 && isTcyTargetChar(text[from - 1])) {
    pos = from - 1;
  }
  if (!isTcyTargetChar(text[pos])) return [];
  return [];
}

function tcyRunsActive(runs, map) {
  if (!runs.length) return false;
  for (const run of runs) {
    for (let i = run.start; i < run.end; i++) {
      if (map?.[i] !== true) return false;
    }
  }
  return true;
}

function syncTcyControls(sel = getLastInplaceSelection()) {
  const applyBtn = tcyApplyBtnEl();
  const removeBtn = tcyRemoveBtnEl();
  if (!applyBtn && !removeBtn) return;
  const ctx = getTcyContext(sel);
  const runs = ctx && ctx.direction === "vertical"
    ? rangesForTcy(ctx.text, ctx.sel.start, ctx.sel.end)
    : [];
  const enabled = !!ctx && ctx.direction === "vertical" && runs.length > 0;
  const active = enabled && tcyRunsActive(runs, ctx.charTateChuYokos);
  if (applyBtn) {
    applyBtn.disabled = !enabled;
    applyBtn.setAttribute("aria-pressed", active ? "true" : "false");
  }
  if (removeBtn) {
    removeBtn.disabled = !enabled;
    removeBtn.setAttribute("aria-pressed", enabled && !active ? "true" : "false");
  }
}

function syncVerticalHalfToFullSelect() {
  const select = verticalHalfToFullSelectEl();
  if (!select) return;
  select.value = getDefault("verticalHalfToFullEnabled") === false ? "off" : "on";
}

function convertHalfWidthAsciiToFullWidth(text) {
  return String(text ?? "").replace(/[\x21-\x7E]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) + 0xFEE0),
  );
}

function applyVerticalHalfToFullToSelectedLayers() {
  const selections = getSelectedLayers();
  if (selections.length === 0) return false;
  let mutated = false;
  withHistoryTransient(() => {
    for (const sel of selections) {
      const ref = resolveLayerRef(sel);
      if (!ref) continue;
      const direction = ref.kind === "existing"
        ? ((getEdit(ref.page.path, ref.layer.id) ?? {}).direction ?? ref.layer.direction ?? "horizontal")
        : (ref.newLayer.direction ?? "vertical");
      if (direction !== "vertical") continue;
      const current = ref.kind === "existing"
        ? ((getEdit(ref.page.path, ref.layer.id) ?? {}).contents ?? ref.layer.text ?? "")
        : (ref.newLayer.contents ?? "");
      const converted = convertHalfWidthAsciiToFullWidth(current);
      if (converted === current) continue;
      const oldCenter = getLayerCenter(ref);
      if (ref.kind === "existing") {
        setEdit(ref.page.path, ref.layer.id, { contents: converted });
      } else {
        updateNewLayer(ref.newLayer.tempId, { contents: converted });
      }
      const fresh = resolveLayerRef(sel);
      if (fresh) recenterLayerToCenter(fresh, oldCenter);
      mutated = true;
    }
    return mutated;
  });
  if (mutated) {
    rebuildLayerList();
    refreshAllOverlays();
  }
  return mutated;
}

function syncSizeInputMixedDisplay(sizes, page) {
  const input = sizeInputEl();
  if (!input || document.activeElement === input) return;
  const values = (sizes ?? []).filter(Number.isFinite);
  if (values.length <= 1) return;
  input.value = values.map((pt) => formatDisplayPt(pt, page)).filter(Boolean).join("/");
}

function clampTextScalePercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(10, Math.min(400, Math.round(n)));
}

function clampTextSpacingMille(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(-1000, Math.min(1000, Math.round(n)));
}

function syncTextScaleInput(input, value) {
  if (!input || document.activeElement === input) return;
  if (value == null) {
    input.value = "";
    input.placeholder = "混在";
    return;
  }
  input.value = String(value);
  input.placeholder = "";
}

function refreshTextStyleMarkerViews() {
  import("./txt-source.js").then((mod) => mod.renderTxtSourceViewer?.()).catch(() => {});
  import("./bind/editor-pane.js").then((mod) => mod.refreshEditorPaneViewer?.()).catch(() => {});
}

// widthPx === null は混在。input を空にして placeholder で示す。
function syncStrokeWidthInput(widthPx) {
  const input = strokeWidthInputEl();
  if (!input) return;
  if (document.activeElement === input) return;
  if (widthPx == null) {
    input.value = "";
    input.placeholder = "混在";
    return;
  }
  input.value = String(widthPx);
  input.placeholder = "";
}

// 実 pt を「基準PSD 換算 pt」表示文字列にする。値が無いときは空文字。
// 基準PSD（getPages()[0]）と同じ page なら素のまま。
function formatDisplayPt(actualPt, page) {
  if (actualPt == null || actualPt === "") return "";
  const num = typeof actualPt === "number" ? actualPt : Number(actualPt);
  if (!Number.isFinite(num)) return "";
  const display = toDisplaySizePt(num, page);
  return formatTextSizePt(display ?? 0, getTextSizeUnit(), true);
}

// per-layer 縦／横トグルの SVG（lucide 由来、既存サイドバー版と同形）。
export const DIR_VERT_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="2 6 2 3 12 3 12 6"/><line x1="4" y1="20" x2="10" y2="20"/><line x1="7" y1="3" x2="7" y2="20"/><line x1="18" y1="5" x2="18" y2="19"/><polyline points="14 15 18 19 22 15"/></svg>`;
export const DIR_HORZ_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="2 6 2 3 12 3 12 6"/><line x1="4" y1="20" x2="10" y2="20"/><line x1="7" y1="3" x2="7" y2="20"/><line x1="13" y1="12" x2="22" y2="12"/><polyline points="18 8 22 12 18 16"/></svg>`;

function dirToggleHtml(direction) {
  const v = direction === "vertical" ? " active" : "";
  const h = direction === "horizontal" ? " active" : "";
  return `<div class="layer-dir-toggle" role="group" aria-label="組方向">`
    + `<button type="button" class="layer-dir-btn${v}" data-direction="vertical" title="縦組み" aria-label="縦組み">${DIR_VERT_SVG}</button>`
    + `<button type="button" class="layer-dir-btn${h}" data-direction="horizontal" title="横組み" aria-label="横組み">${DIR_HORZ_SVG}</button>`
    + `</div>`;
}

// li 内 direction トグルのクリックは li 自身の選択ハンドラに伝播させない
// （toggle 操作は選択変更を伴わず、対象レイヤーの direction のみ更新する）。
function bindLayerDirToggle(li, kind, page, layerOrNl) {
  for (const btn of li.querySelectorAll(".layer-dir-btn")) {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const direction = btn.dataset.direction;
      if (kind === "existing") {
        setEdit(page.path, layerOrNl.id, { direction });
      } else {
        updateNewLayer(layerOrNl.tempId, { direction });
      }
      rebuildLayerList();
      refreshAllOverlays();
    });
  }
}

export function rebuildLayerList() {
  const ul = listEl();
  ul.innerHTML = "";
  const pages = getPages();
  if (pages.length === 0) {
    applySelectionHighlight();
    populateEditor();
    return;
  }

  const pageIndex = Math.max(0, Math.min(pages.length - 1, getCurrentPageIndex()));
  const page = pages[pageIndex];

  const header = document.createElement("li");
  header.className = "layer-list-header";
  header.textContent = `— ${fileName(page.path)} —`;
  header.style.pointerEvents = "none";
  header.style.color = "var(--text-muted)";
  header.style.fontWeight = "600";
  ul.appendChild(header);

  for (const layer of page.textLayers) {
    const li = document.createElement("li");
    li.dataset.pageIndex = String(pageIndex);
    li.dataset.layerId = String(layer.id);
    li.dataset.layerKind = "existing";
    const edit = getEdit(page.path, layer.id);
    const displayText = edit?.contents ?? layer.text;
    const movedMark = edit && (edit.dx || edit.dy) ? "・移動" : "";
    const editedMark = edit ? `• 編集済${movedMark}` : "";
    const direction = edit?.direction ?? layer.direction ?? "horizontal";
    // bounds 逆算後の実効 pt（transform で縮められた写植テキストでも実描画サイズを表示）
    const effectivePt = getExistingLayerEffectiveSizePt(page, layer, edit ?? {});
    li.innerHTML = `
      <div class="layer-item-body">
        <div class="layer-text">${escapeHtml(truncate(displayText, 40))}</div>
        <div class="layer-meta">${escapeHtml(layer.font || "")} ${formatDisplayPt(effectivePt, page)} ${editedMark}</div>
      </div>
      ${dirToggleHtml(direction)}
    `;
    li.addEventListener("click", (e) => selectLayer(pageIndex, layer.id, e));
    bindLayerDirToggle(li, "existing", page, layer);
    ul.appendChild(li);
  }

  const newLayers = getNewLayersForPsd(page.path);
  for (const nl of newLayers) {
    const li = document.createElement("li");
    li.dataset.pageIndex = String(pageIndex);
    li.dataset.layerId = nl.tempId;
    li.dataset.layerKind = "new";
    // 【v1.26.0 移植 (PsDesign-main v1.24.0)】自動配置で背景/ウニ判定によりフォント切替された印
    // (CSS で色強調)。bucket = 0..5 の 10% 刻みでスコア帯ごとに別色 (青→緑→黄→橙→赤→濃赤)。
    if (nl.autoFontSwitched) {
      li.classList.add("auto-font-switched");
      if (Number.isInteger(nl.autoFontSwitchBucket) && nl.autoFontSwitchBucket >= 0) {
        li.classList.add(`auto-font-bucket-${nl.autoFontSwitchBucket}`);
      }
    }
    const direction = nl.direction ?? "vertical";
    li.innerHTML = `
      <div class="layer-item-body">
        <div class="layer-text">${escapeHtml(truncate(nl.contents, 40))}</div>
      </div>
      ${dirToggleHtml(direction)}
    `;
    li.addEventListener("click", (e) => selectLayer(pageIndex, nl.tempId, e));
    bindLayerDirToggle(li, "new", page, nl);
    ul.appendChild(li);
  }

  applySelectionHighlight();
  populateEditor();
}

function selectLayer(pageIndex, layerId, event) {
  if (getCurrentPageIndex() !== pageIndex) {
    setCurrentPageIndex(pageIndex);
  }
  const handledBadgeVisibility = event?.ctrlKey && !event.shiftKey && !event.metaKey && !event.altKey;
  if (handledBadgeVisibility) {
    setSelectionAdornmentsVisible(false);
    setSelectedLayerBadgesUserHidden(true);
    setSelectedLayer(pageIndex, layerId);
  } else if (event?.shiftKey) {
    toggleLayerSelected(pageIndex, layerId);
  } else {
    clearTemporaryMultiSelectionAdornments();
    setSelectedLayer(pageIndex, layerId);
  }
  // ブラシモード（fontPickerStuck）: スタイルパレットや edit-font で選んだフォントを
  // 新しい選択にも自動適用する。canvas-tools.js の onExistingLayerMouseDown と同じ仕様。
  // commitFontToSelections は内部で rebuildLayerList + refreshAllOverlays を呼ぶので
  // apply 成功時は明示的な再描画は不要。
  if (maybeApplyStickyFont()) return;
  applySelectionHighlight();
  populateEditor();
  refreshAllOverlays();
}

function applySelectionHighlight() {
  const selections = getSelectedLayers();
  for (const li of listEl().querySelectorAll("li[data-layer-id]")) {
    const match = selections.some(
      (s) =>
        li.dataset.pageIndex === String(s.pageIndex) &&
        li.dataset.layerId === String(s.layerId),
    );
    li.classList.toggle("selected", match);
  }
  window.dispatchEvent(new CustomEvent("psdesign:selection-changed"));
}

function resolveSelection() {
  const sel = getSelectedLayer();
  if (!sel) return null;
  const page = getPages()[sel.pageIndex];
  if (!page) return null;
  if (typeof sel.layerId === "string") {
    const nl = getNewLayersForPsd(page.path).find((l) => l.tempId === sel.layerId);
    if (!nl) return null;
    return { kind: "new", page, newLayer: nl };
  }
  const layer = page.textLayers.find((l) => l.id === sel.layerId);
  if (!layer) return null;
  return { kind: "existing", page, layer };
}

function updateDeleteButtonVisibility() {
  const deleteBtn = document.getElementById("delete-new-layer-btn");
  if (!deleteBtn) return;
  const anyNew = getSelectedLayers().some((s) => typeof s.layerId === "string");
  // 削除ボタンは常時表示。新規レイヤーが選択されていないときは disabled でグレーアウト。
  deleteBtn.disabled = !anyNew;
}

// 選択中レイヤー集合からフチ（color/width）の共通値を算出する。
// 全て同値なら値、混在なら null、選択 0 件なら既定値（none/2）。
// 選択中レイヤー集合から文字色の共通値を算出する。
// 全て同値なら値、混在なら null、選択 0 件なら既定値 ("default")。
function computeCommonFill(selections) {
  if (selections.length === 0) return "default";
  let color;
  for (const s of selections) {
    const resolved = resolveLayerRef(s);
    if (!resolved) continue;
    let c;
    if (resolved.kind === "existing") {
      const { page, layer } = resolved;
      const edit = getEdit(page.path, layer.id) ?? {};
      c = edit.fillColor ?? layer.fillColor ?? "default";
    } else {
      c = resolved.newLayer.fillColor ?? "default";
    }
    if (color === undefined) color = c; else if (color !== c) color = null;
  }
  return color === undefined ? "default" : color;
}

function computeCommonStroke(selections) {
  if (selections.length === 0) {
    return { strokeColor: "none", strokeWidthPx: 20 };
  }
  let color;
  let width;
  for (const s of selections) {
    const resolved = resolveLayerRef(s);
    if (!resolved) continue;
    let c, w;
    if (resolved.kind === "existing") {
      const { page, layer } = resolved;
      const edit = getEdit(page.path, layer.id) ?? {};
      c = edit.strokeColor ?? layer.strokeColor ?? "none";
      w = edit.strokeWidthPx ?? layer.strokeWidthPx ?? 20;
    } else {
      c = resolved.newLayer.strokeColor ?? "none";
      w = resolved.newLayer.strokeWidthPx ?? 20;
    }
    if (color === undefined) color = c; else if (color !== c) color = null;
    if (width === undefined) width = w; else if (width !== w) width = null;
  }
  return {
    strokeColor: color === undefined ? "none" : color,
    strokeWidthPx: width === undefined ? 20 : width,
  };
}

function resolveLayerRef(sel) {
  const page = getPages()[sel.pageIndex];
  if (!page) return null;
  if (typeof sel.layerId === "string") {
    const nl = getNewLayersForPsd(page.path).find((l) => l.tempId === sel.layerId);
    if (!nl) return null;
    return { kind: "new", page, newLayer: nl };
  }
  const layer = page.textLayers.find((l) => l.id === sel.layerId);
  if (!layer) return null;
  return { kind: "existing", page, layer };
}

function populateEditor() {
  const editor = editorEl();
  const selections = getSelectedLayers();
  updateDeleteButtonVisibility();
  if (!editor) return;

  // 編集パネルは選択の有無に関わらず常時表示。
  // 選択 0 件のときは「次に配置するテキストの既定値」を編集する UI として機能する。
  editor.hidden = false;

  // [data-editor-scope="single"] が付いている要素は単独選択時のみ表示。
  // font-combobox-label / editor-tabs-section はテキスト編集セクション内 (#editor) に格納。
  // サイズ/行間/フチタブは選択数に関わらず常に表示し、入力値は単独選択時のみレイヤー値に追従、
  // 0 件 / 複数選択時はツール状態（state.textSize / state.leadingPct 等）を表示する。
  const singleOnly = editor.querySelectorAll("[data-editor-scope='single']");
  for (const el of singleOnly) el.hidden = selections.length > 1;

  if (selections.length === 0) {
    // 選択なし時は state（次に配置する既定値）を UI に反映するだけ。値は触らない。
    rebuildFontOptions(getCurrentFont() ?? "");
    syncStrokeToggle(getStrokeColor());
    syncStrokeWidthInput(getStrokeWidthPx());
    syncFillToggle(getFillColor());
    syncTextScaleInput(horizontalScaleInputEl(), 100);
    syncTextScaleInput(verticalScaleInputEl(), 100);
    syncTextScaleInput(trackingInputEl(), 0);
    syncTextScaleInput(kerningInputEl(), 0);
    syncTcyControls(null);
    syncVerticalHalfToFullSelect();
    // 【v1.22.0】B トグルは選択 0 件で disabled。
    syncBoldToggle(undefined);
    syncItalicToggle(undefined);
    return;
  }

  if (selections.length === 1) {
    const resolved = resolveSelection();
    if (resolved) {
      let effectiveSize = null;
      let effectiveFont = null;
      let effectiveLeading = null;
      let effectiveHorizontalScale = 100;
      let effectiveVerticalScale = 100;
      let effectiveTrackingMille = 0;
      let effectiveKerningMille = 0;
      let mixedSizes = [];
      let mixedSizesPage = null;
      if (resolved.kind === "existing") {
        const { page, layer } = resolved;
        const edit = getEdit(page.path, layer.id) ?? {};
        // bounds 逆算後の実効 pt をサイズ入力にも反映（transform で縮められた写植テキスト対応）
        effectiveSize = layerDefaultSize(resolved, page, layer, edit);
        effectiveFont = edit.fontPostScriptName ?? layer.font ?? null;
        effectiveHorizontalScale = edit.horizontalScale ?? layer.horizontalScale ?? 100;
        effectiveVerticalScale = edit.verticalScale ?? layer.verticalScale ?? 100;
        effectiveTrackingMille = edit.trackingMille ?? layer.trackingMille ?? 0;
        effectiveKerningMille = edit.kerningMille ?? layer.kerningMille ?? 0;
        // 既存レイヤーは PSD から行間を読み戻していないため、edit に明示があれば
        // それを使い、なければ既定 125% として表示（実 PSD と乖離する可能性あり）。
        effectiveLeading = edit.leadingPct ?? 125;
        rebuildFontOptions(effectiveFont);
        mixedSizes = collectSizesForRange(resolved, 0, (edit.contents ?? layer.text ?? "").length, effectiveSize);
        mixedSizesPage = page;
      } else {
        const { newLayer } = resolved;
        effectiveSize = layerDefaultSize(resolved);
        effectiveFont = newLayer.fontPostScriptName ?? null;
        effectiveLeading = newLayer.leadingPct ?? 125;
        effectiveHorizontalScale = newLayer.horizontalScale ?? 100;
        effectiveVerticalScale = newLayer.verticalScale ?? 100;
        effectiveTrackingMille = newLayer.trackingMille ?? 0;
        effectiveKerningMille = newLayer.kerningMille ?? 0;
        rebuildFontOptions(effectiveFont ?? "");
        mixedSizes = collectSizesForRange(resolved, 0, (newLayer.contents ?? "").length, effectiveSize);
        mixedSizesPage = getPages()[resolved.pageIndex] ?? null;
      }

      if (effectiveSize != null && Number.isFinite(effectiveSize)) setTextSize(effectiveSize);
      if (effectiveFont) setCurrentFont(effectiveFont);
      if (Number.isFinite(effectiveLeading)) setLeadingPct(effectiveLeading);
      syncTextScaleInput(horizontalScaleInputEl(), clampTextScalePercent(effectiveHorizontalScale) ?? 100);
      syncTextScaleInput(verticalScaleInputEl(), clampTextScalePercent(effectiveVerticalScale) ?? 100);
      syncTextScaleInput(trackingInputEl(), clampTextSpacingMille(effectiveTrackingMille) ?? 0);
      syncTextScaleInput(kerningInputEl(), clampTextSpacingMille(effectiveKerningMille) ?? 0);
      syncSizeInputMixedDisplay(mixedSizes, mixedSizesPage);
    }
  } else {
  }

  // フチ/文字色は単独/複数いずれでも共通値を表示。
  const { strokeColor, strokeWidthPx } = computeCommonStroke(selections);
  if (strokeColor != null) setStrokeColor(strokeColor);
  if (strokeWidthPx != null) setStrokeWidthPx(strokeWidthPx);
  syncStrokeToggle(strokeColor);
  syncStrokeWidthInput(strokeWidthPx);

  const fillColor = computeCommonFill(selections);
  if (fillColor != null) setFillColor(fillColor);
  syncFillToggle(fillColor);

  // 【v1.22.0】合成太字（faux bold）ボタンの aria-pressed を共通値に同期。
  // 混在 (null) のときはニュートラル表示（aria-pressed="false"）。
  const commonBold = computeCommonBold(selections);
  syncBoldToggle(commonBold);
  const commonItalic = computeCommonItalic(selections);
  syncItalicToggle(commonItalic);

  if (selections.length > 1) {
    syncTextScaleInput(horizontalScaleInputEl(), computeCommonTextScale(selections, "horizontalScale"));
    syncTextScaleInput(verticalScaleInputEl(), computeCommonTextScale(selections, "verticalScale"));
    syncTextScaleInput(trackingInputEl(), computeCommonTextSpacing(selections, "trackingMille"));
    syncTextScaleInput(kerningInputEl(), computeCommonTextSpacing(selections, "kerningMille"));
  }
  syncTcyControls();
  syncVerticalHalfToFullSelect();
}

// 【v1.22.0】B トグルボタンの aria-pressed と disabled を更新。
// value === undefined → 未選択 (disabled)、null → 混在 (inactive)、true/false → 反映。
function syncBoldToggle(value) {
  const buttons = document.querySelectorAll(".bold-toggle-btn");
  if (!buttons.length) return;
  buttons.forEach((btn) => {
    if (value === undefined) {
    btn.disabled = true;
    btn.setAttribute("aria-pressed", "false");
    } else {
    btn.disabled = false;
    btn.setAttribute("aria-pressed", value === true ? "true" : "false");
    }
  });
}

function syncItalicToggle(value) {
  const buttons = document.querySelectorAll(".italic-toggle-btn");
  if (!buttons.length) return;
  buttons.forEach((btn) => {
    if (value === undefined) {
    btn.disabled = true;
    btn.setAttribute("aria-pressed", "false");
    } else {
    btn.disabled = false;
    btn.setAttribute("aria-pressed", value === true ? "true" : "false");
    }
  });
}

// ========== フォント検索コンボボックス ==========
// editor-tabs-section の上に配置されたインストール済み全フォント検索 UI。
// スタイルパレットは社内 curated プリセット用で、こちらは検索代替経路。
let comboItems = [];
let comboHighlighted = -1;
let comboOpen = false;
let fontPreviewObserver = null;
let comboSuppressAutoOpenUntil = 0;

function suppressComboAutoOpen(ms = 300) {
  comboSuppressAutoOpenUntil = performance.now() + ms;
}

function shouldSuppressComboAutoOpen() {
  return performance.now() < comboSuppressAutoOpenUntil;
}

function ensureComboBuilt() {
  const list = fontListEl();
  if (!list || comboItems.length) return;
  const fonts = getFonts();
  if (!fonts.length) return;
  list.innerHTML = "";
  comboItems = fonts.map((font) => {
    const li = document.createElement("li");
    li.className = "font-combobox-item";
    li.setAttribute("role", "option");
    const main = document.createElement("span");
    main.className = "font-combobox-name";
    main.textContent = font.name || font.postScriptName;
    li.appendChild(main);
    if (font.name && font.postScriptName && font.name !== font.postScriptName) {
      const sub = document.createElement("span");
      sub.className = "font-combobox-sub";
      sub.textContent = font.postScriptName;
      li.appendChild(sub);
    }
    li.addEventListener("mousedown", (e) => e.preventDefault());
    li.addEventListener("click", () => commitFont(font));
    list.appendChild(li);
    return { el: li, font, main, styled: false };
  });
  attachFontPreviewObserver(list);
}

function attachFontPreviewObserver(list) {
  if (fontPreviewObserver) {
    fontPreviewObserver.disconnect();
    fontPreviewObserver = null;
  }
  if (typeof IntersectionObserver === "undefined") return;
  fontPreviewObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const item = comboItems.find((c) => c.el === entry.target);
      if (!item || item.styled) continue;
      item.styled = true;
      const { font, main } = item;
      const parts = [];
      const add = (name) => {
        const trimmed = String(name ?? "").trim();
        if (!trimmed) return;
        if (/^(regular|bold|italic|bold italic|light|medium|heavy|ultra|demi ?bold|semi ?bold|extra ?light|ex ?light|black)$/i.test(trimmed)) return;
        const q = `"${trimmed.replace(/["\\]/g, "\\$&")}"`;
        if (!parts.includes(q)) parts.push(q);
      };
      add(font.name);
      for (const alias of Array.isArray(font.aliases) ? font.aliases : []) add(alias);
      add(font.postScriptName);
      parts.push("sans-serif");
      main.style.fontFamily = parts.join(", ");
      ensureFontLoaded(font.postScriptName);
      fontPreviewObserver.unobserve(entry.target);
    }
  }, { root: list, rootMargin: "80px 0px" });
  for (const { el } of comboItems) {
    fontPreviewObserver.observe(el);
  }
}

function filterCombo(query) {
  const q = normalizeFontSearchText(query).trim();
  let firstVisible = -1;
  for (let i = 0; i < comboItems.length; i++) {
    const { el, font } = comboItems[i];
    const hay = fontSearchHaystack(font);
    const match = q === "" || hay.includes(q);
    el.style.display = match ? "" : "none";
    if (match && firstVisible < 0) firstVisible = i;
  }
  setComboHighlight(firstVisible);
}

function setComboHighlight(idx) {
  if (comboHighlighted >= 0 && comboItems[comboHighlighted]) {
    comboItems[comboHighlighted].el.classList.remove("highlight");
  }
  comboHighlighted = idx;
  if (idx >= 0 && comboItems[idx]) {
    comboItems[idx].el.classList.add("highlight");
    comboItems[idx].el.scrollIntoView({ block: "nearest" });
  }
}

// position: fixed なので親 (.panel-section の overflow: hidden) に左右されず、
// input の直下に絶対座標で表示。スクロール / リサイズで openCombo 中の場合は再計算。
function positionCombo() {
  const list = fontListEl();
  const combo = fontComboboxEl();
  if (!list || !combo) return;
  const r = combo.getBoundingClientRect();
  list.style.top = `${r.bottom + 2}px`;
  list.style.left = `${r.left}px`;
  list.style.width = `${r.width}px`;
}

let comboReposBound = false;
function bindComboRepositionWhileOpen() {
  if (comboReposBound) return;
  comboReposBound = true;
  const repos = () => { if (comboOpen) positionCombo(); };
  window.addEventListener("scroll", repos, true);
  window.addEventListener("resize", repos);
}

// showAll=true: 入力欄の値を無視して全フォントを表示（▾ トグルボタン専用）。
// 通常 (focus / input イベント) は入力欄の値で絞り込む。
function openCombo(showAll = false, options = {}) {
  if (!options.force && shouldSuppressComboAutoOpen()) return;
  ensureComboBuilt();
  const list = fontListEl();
  if (!list || !comboItems.length) return;
  list.hidden = false;
  comboOpen = true;
  positionCombo();
  bindComboRepositionWhileOpen();
  filterCombo(showAll ? "" : fontEl().value);
  const currentPs = fontEl().dataset.ps || "";
  if (currentPs) {
    const idx = comboItems.findIndex(({ font, el }) =>
      el.style.display !== "none" && font.postScriptName === currentPs);
    if (idx >= 0) setComboHighlight(idx);
  }
}

function closeCombo() {
  const list = fontListEl();
  if (list) list.hidden = true;
  comboOpen = false;
}

let layerFontPanel = null;
let layerFontPanelAnchor = null;
let layerFontPanelBound = false;
let layerFontPanelPlaceholder = null;
let layerFontPanelSidebarPlaceholder = null;
let layerFontSourceNodes = [];
let layerFontPanelSelectionRef = null;
let layerFontPanelSelectionSyncRaf = 0;
let layerFontPanelLastAnchorRect = null;
let layerFontLabelWasHidden = null;
let layerSizePanel = null;
let layerSizePanelAnchor = null;
let layerSizePanelPlaceholder = null;
let layerStrokePanel = null;
let layerStrokePanelAnchor = null;
let layerStrokePanelPlaceholder = null;

function fontSourceNodes() {
  const editor = document.querySelector(".side-panel .editor");
  const tabs = editor?.querySelector(":scope > .font-source-tabs");
  const panels = editor ? Array.from(editor.querySelectorAll(":scope > .font-source-panel")) : [];
  return tabs && panels.length ? [tabs, ...panels] : [];
}

function scrubFontSourcePlaceholder(root) {
  root.removeAttribute("id");
  root.removeAttribute("for");
  root.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
  root.querySelectorAll("[for]").forEach((el) => el.removeAttribute("for"));
  root.querySelectorAll("input, button, select, textarea, a").forEach((el) => {
    el.setAttribute("tabindex", "-1");
  });
  root.querySelectorAll(".font-combobox-list").forEach((el) => {
    el.hidden = true;
  });
}

function createFontSourceSidebarPlaceholder(nodes) {
  const placeholder = document.createElement("div");
  placeholder.className = "font-source-sidebar-placeholder";
  placeholder.setAttribute("aria-hidden", "true");
  placeholder.inert = true;
  for (const node of nodes) {
    const clone = node.cloneNode(true);
    scrubFontSourcePlaceholder(clone);
    placeholder.appendChild(clone);
  }
  return placeholder;
}

function currentSelectionRef() {
  const selections = getSelectedLayers();
  if (selections.length !== 1) return null;
  const sel = selections[0];
  return { pageIndex: sel.pageIndex, layerId: sel.layerId };
}

function sameSelectionRef(a, b) {
  return !!a && !!b && a.pageIndex === b.pageIndex && a.layerId === b.layerId;
}

function cssEscape(value) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(String(value));
  return String(value).replace(/["\\]/g, "\\$&");
}

function resolveLayerFontAnchorElement(ref = layerFontPanelSelectionRef) {
  if (!ref) return null;
  const layerId = ref.layerId;
  const selector = typeof layerId === "string"
    ? `.layer-box-new[data-temp-id="${cssEscape(layerId)}"]`
    : `.layer-box-existing[data-layer-id="${cssEscape(layerId)}"]`;
  const boxes = Array.from(document.querySelectorAll(selector));
  const box = boxes.find((el) => el.classList.contains("selected")) ?? boxes[0] ?? null;
  if (!box) return null;
  const candidates = [
    box.querySelector(".layer-size-badge-font"),
    box.querySelector(".layer-size-badge"),
    box,
  ].filter(Boolean);
  return candidates.find((el) => usableRectSnapshot(el.getBoundingClientRect?.())) ?? box;
}

function usableRectSnapshot(rect) {
  if (!rect) return null;
  const values = [rect.left, rect.top, rect.right, rect.bottom, rect.width, rect.height];
  if (!values.every(Number.isFinite)) return null;
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

function createLayerFontPanelAnchor(ref, fallbackRect) {
  return {
    getBoundingClientRect: () => {
      const el = resolveLayerFontAnchorElement(ref);
      const rect = usableRectSnapshot(el?.getBoundingClientRect?.());
      if (rect) {
        layerFontPanelLastAnchorRect = rect;
        return rect;
      }
      return fallbackRect ?? layerFontPanelLastAnchorRect;
    },
    contains: (target) => {
      const el = resolveLayerFontAnchorElement(ref);
      return !!el?.contains?.(target);
    },
  };
}

function fontForSelectionRef(ref) {
  if (!ref) return "";
  const resolved = resolveLayerRef(ref);
  if (!resolved) return "";
  if (resolved.kind === "existing") {
    const edit = getEdit(resolved.page.path, resolved.layer.id) ?? {};
    return edit.fontPostScriptName ?? resolved.layer.font ?? "";
  }
  return resolved.newLayer.fontPostScriptName ?? "";
}

function restoreFontSourceNodes() {
  if (!layerFontPanelPlaceholder?.parentNode) return;
  const nodes = layerFontSourceNodes;
  layerFontPanelSidebarPlaceholder?.remove();
  layerFontPanelSidebarPlaceholder = null;
  for (const node of nodes) {
    layerFontPanelPlaceholder.parentNode.insertBefore(node, layerFontPanelPlaceholder);
  }
  layerFontPanelPlaceholder.remove();
  layerFontPanelPlaceholder = null;
  layerFontSourceNodes = [];
  const label = document.querySelector(".font-combobox-label");
  if (label && layerFontLabelWasHidden != null) {
    label.hidden = layerFontLabelWasHidden;
  }
  layerFontLabelWasHidden = null;
}

function closeLayerSizePanel() {
  const panel = layerSizePanel;
  if (layerSizePanelPlaceholder?.parentNode && panel) {
    layerSizePanelPlaceholder.parentNode.insertBefore(panel, layerSizePanelPlaceholder);
    layerSizePanelPlaceholder.remove();
  }
  if (panel) {
    panel.classList.remove("size-panel-floating");
    panel.style.left = "";
    panel.style.top = "";
    panel.style.maxHeight = "";
  }
  layerSizePanel = null;
  layerSizePanelAnchor = null;
  layerSizePanelPlaceholder = null;
}

function closeLayerStrokePanel() {
  const panel = layerStrokePanel;
  if (layerStrokePanelPlaceholder?.parentNode && panel) {
    layerStrokePanelPlaceholder.parentNode.insertBefore(panel, layerStrokePanelPlaceholder);
    layerStrokePanelPlaceholder.remove();
  }
  if (panel) {
    panel.classList.remove("stroke-panel-floating");
    panel.style.left = "";
    panel.style.top = "";
    panel.style.maxHeight = "";
  }
  layerStrokePanel = null;
  layerStrokePanelAnchor = null;
  layerStrokePanelPlaceholder = null;
}

function closeLayerFontPanel() {
  closeCombo();
  restoreFontSourceNodes();
  if (layerFontPanel) layerFontPanel.remove();
  layerFontPanel = null;
  layerFontPanelAnchor = null;
  layerFontPanelSelectionRef = null;
  layerFontPanelLastAnchorRect = null;
}

function positionLayerFontPanel() {
  const panel = layerFontPanel;
  const anchor = layerFontPanelAnchor;
  if (!panel || !anchor?.getBoundingClientRect) return;
  const gap = 8;
  const margin = 8;
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;
  panel.style.maxHeight = `${Math.max(160, viewportH - margin * 2)}px`;
  const r = usableRectSnapshot(anchor.getBoundingClientRect()) ?? layerFontPanelLastAnchorRect;
  if (!r) return;
  layerFontPanelLastAnchorRect = r;
  const measured = panel.getBoundingClientRect();
  const panelW = Math.max(250, Math.min(320, measured.width || panel.offsetWidth || 280));
  const panelH = Math.max(180, measured.height || panel.offsetHeight || 320);
  const clamp = (v, min, max) => Math.max(min, Math.min(Math.max(min, max), v));
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
  const fitLeftMax = viewportW - panelW - margin;
  const fitTopMax = viewportH - panelH - margin;
  const candidates = [
    { left: r.right + gap, top: r.top },
    { left: r.left - gap - panelW, top: r.top },
    { left: r.left, top: r.bottom + gap },
    { left: r.left, top: r.top - gap - panelH },
    { left: r.left + (r.right - r.left - panelW) / 2, top: r.bottom + gap },
    { left: r.left + (r.right - r.left - panelW) / 2, top: r.top - gap - panelH },
  ].map((p) => {
    const left = clamp(p.left, margin, fitLeftMax);
    const top = clamp(p.top, margin, fitTopMax);
    const rect = { left, top, right: left + panelW, bottom: top + panelH };
    return {
      left,
      top,
      obstacleOverlap: obstacleOverlap(rect),
      anchorOverlap: overlapArea(rect, r),
      distance: Math.abs(left - (r.right + gap)) + Math.abs(top - r.top),
    };
  });
  candidates.sort((a, b) => (a.obstacleOverlap - b.obstacleOverlap) || (a.anchorOverlap - b.anchorOverlap) || (a.distance - b.distance));
  panel.style.left = `${Math.round(candidates[0].left)}px`;
  panel.style.top = `${Math.round(candidates[0].top)}px`;
}

function ensureLayerFontPanelGlobalHandlers() {
  if (layerFontPanelBound) return;
  layerFontPanelBound = true;
  document.addEventListener("mousedown", (e) => {
    if (layerFontPanel) {
      if (layerFontPanel.contains(e.target)) return;
      if (layerFontPanelAnchor?.contains?.(e.target)) return;
      closeLayerFontPanel();
    }
    if (layerSizePanel) {
      if (layerSizePanel.contains(e.target)) return;
      if (layerSizePanelAnchor?.contains?.(e.target)) return;
      closeLayerSizePanel();
    }
    if (layerStrokePanel) {
      if (layerStrokePanel.contains(e.target)) return;
      if (layerStrokePanelAnchor?.contains?.(e.target)) return;
      closeLayerStrokePanel();
    }
  });
  const repos = () => {
    positionLayerFontPanel();
    positionFloatingPanel(layerSizePanel, layerSizePanelAnchor, 230, 96);
    positionFloatingPanel(layerStrokePanel, layerStrokePanelAnchor, 220, 104);
  };
  window.addEventListener("resize", repos);
  window.addEventListener("scroll", repos, true);
  window.addEventListener("psdesign:selection-changed", () => {
    if (!layerFontPanel || layerFontPanelSelectionSyncRaf) return;
    layerFontPanelSelectionSyncRaf = requestAnimationFrame(() => {
      layerFontPanelSelectionSyncRaf = 0;
      syncLayerFontPanelToSelection();
    });
  });
}

function syncLayerFontPanelToSelection() {
  if (!layerFontPanel) return;
  const ref = currentSelectionRef();
  if (!ref) {
    closeLayerFontPanel();
    return;
  }
  if (!sameSelectionRef(ref, layerFontPanelSelectionRef)) {
    layerFontPanelSelectionRef = ref;
    const anchorEl = resolveLayerFontAnchorElement(ref);
    const fallbackRect = usableRectSnapshot(anchorEl?.getBoundingClientRect?.()) ?? layerFontPanelLastAnchorRect;
    layerFontPanelAnchor = createLayerFontPanelAnchor(ref, fallbackRect);
    closeCombo();
  }
  const fontPs = fontForSelectionRef(ref);
  if (fontPs) {
    setCurrentFont(fontPs);
    ensureFontLoaded(fontPs);
    rebuildFontOptions(fontPs, { force: true });
  }
  positionLayerFontPanel();
  requestAnimationFrame(positionLayerFontPanel);
}

function positionFloatingPanel(panel, anchor, widthFallback = 280, heightFallback = 140) {
  if (!panel || !anchor?.getBoundingClientRect) return;
  const gap = 8;
  const margin = 8;
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;
  panel.style.maxHeight = `${Math.max(120, viewportH - margin * 2)}px`;
  const r = anchor.getBoundingClientRect();
  const measured = panel.getBoundingClientRect();
  const panelW = Math.max(220, Math.min(340, measured.width || panel.offsetWidth || widthFallback));
  const panelH = Math.max(90, measured.height || panel.offsetHeight || heightFallback);
  const clamp = (v, min, max) => Math.max(min, Math.min(Math.max(min, max), v));
  const fitLeftMax = viewportW - panelW - margin;
  const fitTopMax = viewportH - panelH - margin;
  const candidates = [
    { left: r.right + gap, top: r.top },
    { left: r.left - gap - panelW, top: r.top },
    { left: r.left, top: r.bottom + gap },
    { left: r.left, top: r.top - gap - panelH },
  ].map((p) => ({
    left: clamp(p.left, margin, fitLeftMax),
    top: clamp(p.top, margin, fitTopMax),
  }));
  panel.style.left = `${Math.round(candidates[0].left)}px`;
  panel.style.top = `${Math.round(candidates[0].top)}px`;
}

export function openLayerFontPanel(anchor, currentPs = "") {
  if (!anchor || !getFonts().length) return false;
  closeLayerSizePanel();
  closeLayerStrokePanel();
  closeLayerFontPanel();
  ensureLayerFontPanelGlobalHandlers();
  const nodes = fontSourceNodes();
  if (!nodes.length) return false;
  layerFontPanelAnchor = anchor;
  const panel = document.createElement("div");
  panel.className = "font-panel-floating layer-font-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "フォントを変更");
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeLayerFontPanel();
    }
  });
  document.body.appendChild(panel);
  layerFontPanel = panel;
  const originalParent = nodes[0].parentNode;
  layerFontPanelSelectionRef = currentSelectionRef();
  const fallbackRect = usableRectSnapshot(anchor.getBoundingClientRect?.());
  layerFontPanelLastAnchorRect = fallbackRect;
  if (layerFontPanelSelectionRef) {
    layerFontPanelAnchor = createLayerFontPanelAnchor(layerFontPanelSelectionRef, fallbackRect);
  }
  layerFontSourceNodes = nodes;
  layerFontPanelPlaceholder = document.createComment("font-source-home");
  originalParent.insertBefore(layerFontPanelPlaceholder, nodes[0]);
  layerFontPanelSidebarPlaceholder = createFontSourceSidebarPlaceholder(nodes);
  originalParent.insertBefore(layerFontPanelSidebarPlaceholder, layerFontPanelPlaceholder);
  for (const node of nodes) panel.appendChild(node);
  const label = panel.querySelector(".font-combobox-label");
  if (label) {
    layerFontLabelWasHidden = label.hidden;
    label.hidden = false;
  }
  if (currentPs) {
    setCurrentFont(currentPs);
    ensureFontLoaded(currentPs);
    rebuildFontOptions(currentPs, { force: true });
  }
  setFontSourceTab("palette");
  positionLayerFontPanel();
  const input = fontEl();
  closeCombo();
  input?.blur();
  return true;
}

export function openLayerSizePanel(anchor) {
  if (!anchor) return false;
  closeLayerFontPanel();
  closeLayerStrokePanel();
  closeLayerSizePanel();
  ensureLayerFontPanelGlobalHandlers();
  const panel = document.querySelector(".editor-tab-panel[data-tab-panel='size']");
  if (!panel?.parentNode) return false;
  layerSizePanelAnchor = anchor;
  layerSizePanelPlaceholder = document.createComment("size-panel-home");
  panel.parentNode.insertBefore(layerSizePanelPlaceholder, panel);
  document.body.appendChild(panel);
  panel.hidden = false;
  panel.classList.add("size-panel-floating");
  layerSizePanel = panel;
  positionFloatingPanel(panel, anchor, 230, 96);
  return true;
}

export function openLayerStrokePanel(anchor) {
  if (!anchor) return false;
  closeLayerFontPanel();
  closeLayerSizePanel();
  closeLayerStrokePanel();
  ensureLayerFontPanelGlobalHandlers();
  const panel = document.querySelector(".editor-tab-panel[data-tab-panel='stroke']");
  if (!panel?.parentNode) return false;
  const { strokeColor, strokeWidthPx } = computeCommonStroke(getSelectedLayers());
  syncStrokeToggle(strokeColor);
  syncStrokeWidthInput(strokeWidthPx);
  layerStrokePanelAnchor = anchor;
  layerStrokePanelPlaceholder = document.createComment("stroke-panel-home");
  panel.parentNode.insertBefore(layerStrokePanelPlaceholder, panel);
  document.body.appendChild(panel);
  panel.hidden = false;
  panel.classList.add("stroke-panel-floating");
  layerStrokePanel = panel;
  positionFloatingPanel(panel, anchor, 220, 104);
  return true;
}

function moveComboHighlight(dir) {
  if (!comboOpen) { openCombo(); return; }
  const visible = [];
  for (let i = 0; i < comboItems.length; i++) {
    if (comboItems[i].el.style.display !== "none") visible.push(i);
  }
  if (!visible.length) return;
  let pos = visible.indexOf(comboHighlighted);
  if (pos < 0) pos = 0;
  else pos = (pos + dir + visible.length) % visible.length;
  setComboHighlight(visible[pos]);
}

// 【v1.16.0】フォント変更 — 選択範囲があれば per-char、無ければ layer 全体に適用。
function commitFont(font) {
  const input = fontEl();
  if (!input) return;
  suppressComboAutoOpen();
  input.value = font.name || font.postScriptName;
  input.dataset.ps = font.postScriptName;
  input.dataset.fontSearchCleared = "false";
  input.dataset.fontSearchDirty = "false";
  // フォントロードは非同期で開始（fire-and-forget）。await はしない。
  // 未ロード状態で renderOverlay が走ると bbox は「1em per char」の保守的フォールバックで
  // 計算されるので改行は起きず、ロード完了後に onFontsRegistered → refreshAllOverlays で
  // 再描画されて bbox が確定する。
  ensureFontLoaded(font.postScriptName);
  // in-place 編集中で文字選択がある → per-char フォント適用。
  // 選択範囲は canvas-tools の module-level キャッシュから読む（select イベント発火時に
  // 必ず保存される。textarea の focus/blur 変動の影響を受けない）。
  const sel = getLastInplaceSelection();
  if (sel && sel.end > sel.start) {
    const targetId = sel.tempId ?? sel.layerId;
    setCharFontsRange(sel.psdPath, targetId, sel.start, sel.end, font.postScriptName);
    // 【v1.21.0】編集中の DOM にも即時反映: span でラップして fontFamily を当てる。
    const fam = cssFontFamily(font.postScriptName);
    if (fam) applyEditModeStyleToRange(sel.start, sel.end, { fontFamily: fam });
    refreshAllOverlays();
    rebuildLayerList();
    rebuildFontOptions(font.postScriptName);
    refreshTextStyleMarkerViews();
  } else {
    setCurrentFont(font.postScriptName);
    setFontPickerStuck(true);
    // 選択中レイヤーへ即時適用 (ブラシモード起動)。layer 選択がない場合は「次に
    // 配置するテキスト」の既定フォントとして state に残る。
    commitFontToSelections(font.postScriptName);
  }
  closeCombo();
  rebuildFontOptions(font.postScriptName, { force: true });
  requestAnimationFrame(() => {
    closeCombo();
    rebuildFontOptions(font.postScriptName, { force: true });
  });
  // 選択直後は input からフォーカスを外して Space などのキーがキャンバス側に届くようにする。
  // ただし per-char 適用時は textarea のフォーカスを保持したいので blur しない。
  if (!(sel && sel.end > sel.start)) input.blur();
  rebuildWeightSelector();
}

// ========== フォント太さ (W) セレクタ ==========
// 「A-OTF 新ゴ Pro W3」のような W 番号付きフォントを選択中なら、同じファミリーで
// インストール済みの全 W 番号バリアントをボタン化する。
// バリアントが見つからない / 現在のフォントに W が無い場合も UI 一貫性のため
// プレースホルダの disabled ボタンを描画して常時表示する。

// プレースホルダとして表示する代表的な日本語書体ウェイト（regular / bold）。
const FONT_WEIGHT_PLACEHOLDERS = [3, 6];

function extractWeight(displayName) {
  if (!displayName) return null;
  const m = String(displayName).match(/\bW(\d+)\b/);
  return m ? parseInt(m[1], 10) : null;
}

// W\d+ を取り除いてファミリー名の根を返す（前後余白も整理）。
function familyRoot(displayName) {
  if (!displayName) return null;
  return String(displayName).replace(/\s*\bW\d+\b\s*/g, " ").replace(/\s+/g, " ").trim();
}

function findWeightVariants(currentFont) {
  if (!currentFont) return [];
  const baseName = currentFont.name || currentFont.postScriptName || "";
  const root = familyRoot(baseName);
  if (!root) return [];
  if (extractWeight(baseName) === null) return []; // current font has no W
  const seen = new Map(); // weight -> font (最初に見つけた一件を採用)
  for (const f of getFonts()) {
    const name = f.name || f.postScriptName || "";
    if (familyRoot(name) !== root) continue;
    const w = extractWeight(name);
    if (w === null) continue;
    if (!seen.has(w)) seen.set(w, f);
  }
  return [...seen.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([weight, font]) => ({ weight, font }));
}

function rebuildWeightSelector() {
  const el = document.getElementById("font-weight-selector");
  if (!el) return;
  const input = fontEl();
  const psName = input?.dataset.ps || "";
  const currentFont = psName
    ? getFonts().find((f) => f.postScriptName === psName)
    : null;
  const variants = currentFont ? findWeightVariants(currentFont) : [];
  el.innerHTML = "";
  el.hidden = false;

  if (variants.length >= 2) {
    // 複数のバリアントが見つかったケース: 連結 pill トグル群として表示
    const currentW = extractWeight(currentFont.name || currentFont.postScriptName);
    for (const { weight, font } of variants) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "font-weight-btn";
      btn.textContent = `W${weight}`;
      btn.title = font.name || font.postScriptName;
      const isActive = weight === currentW;
      if (isActive) btn.classList.add("active");
      // aria-pressed: 排他的トグル (radio-like) の semantics。"true" / "false" を必ず両方明示する。
      btn.setAttribute("aria-pressed", isActive ? "true" : "false");
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("click", () => commitFont(font));
      el.appendChild(btn);
    }
    return;
  }

  // バリアントなし / 現在のフォントに W 番号なし: プレースホルダを disabled で表示
  const placeholderTitle = currentFont
    ? "このフォントには W ウェイトのバリエーションがありません"
    : "フォントを選択するとウェイトを切替できます";
  for (const w of FONT_WEIGHT_PLACEHOLDERS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "font-weight-btn";
    btn.textContent = `W${w}`;
    btn.disabled = true;
    btn.setAttribute("aria-pressed", "false");
    btn.title = placeholderTitle;
    el.appendChild(btn);
  }
}

function resolveFontFromInput(typed) {
  const trimmed = (typed ?? "").trim();
  if (!trimmed) return null;
  const fonts = getFonts();
  const exactDisplay = fonts.find((f) => (f.name ?? "") === trimmed);
  if (exactDisplay) return exactDisplay;
  const exactPs = fonts.find((f) => (f.postScriptName ?? "") === trimmed);
  if (exactPs) return exactPs;
  const lower = trimmed.toLowerCase();
  const ciDisplay = fonts.find((f) => (f.name ?? "").toLowerCase() === lower);
  if (ciDisplay) return ciDisplay;
  const ciPs = fonts.find((f) => (f.postScriptName ?? "").toLowerCase() === lower);
  if (ciPs) return ciPs;
  return null;
}

function rebuildFontOptions(currentValue, options = {}) {
  const input = fontEl();
  if (!input) return;
  // ユーザーがフォント名を入力中（input が active）なら、入力中の文字列を
  // populateEditor / rebuildLayerList などの再描画で上書きしないようにする。
  // dataset.ps だけは更新して、確定時の resolveFontFromInput が壊れないようにする。
  const isTypingHere = !options.force && document.activeElement === input;
  const fonts = getFonts();
  let displayText = "";
  let ps = "";
  if (currentValue) {
    const hit =
      fonts.find((f) => f.postScriptName === currentValue) ??
      fonts.find((f) => f.name === currentValue);
    if (hit) {
      displayText = hit.name || hit.postScriptName;
      ps = hit.postScriptName;
    } else {
      displayText = currentValue;
      ps = currentValue;
    }
  }
  if (!isTypingHere) input.value = displayText;
  input.dataset.ps = ps;
  rebuildWeightSelector();
}

function syncFontInputFromRangeFonts(fonts) {
  const input = fontEl();
  if (!input) return;
  const values = (fonts ?? []).filter(Boolean);
  if (values.length === 1) {
    rebuildFontOptions(values[0], { force: true });
    return;
  }
  if (values.length > 1) {
    input.value = values.map((ps) => displayFontName(ps)).join(" / ");
    input.dataset.ps = "";
    rebuildWeightSelector();
  }
}

function syncFontInputFromState() {
  rebuildFontOptions(getCurrentFont() ?? "");
}

// 【v1.16.0】per-char 編集用の文字選択インジケータ。
// 編集パネル先頭に「選択: N 文字」インジケータを差し込む。in-place 編集中に textarea で
// 文字選択があるときだけ表示し、サイドバーから per-char 操作対象が認識できているかを
// ユーザーが視認できるようにする。
function setupCharSelectionIndicator() {
  const editor = editorEl();
  if (!editor) return;
  if (editor.querySelector(".char-selection-indicator")) return;
  const el = document.createElement("div");
  el.className = "char-selection-indicator";
  el.hidden = true;
  el.textContent = "";
  editor.insertBefore(el, editor.firstChild);
}

function updateCharSelectionIndicator(sel) {
  const el = document.querySelector(".char-selection-indicator");
  if (!el) return;
  if (sel && sel.end > sel.start) {
    const len = sel.end - sel.start;
    el.textContent = `選択中: ${len} 文字（サイズ・フォント変更が選択範囲に適用されます）`;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

// 【v1.22.0】editor タブ（サイズ / 行間 / フチ）は撤去し、3 panel を縦並びで全表示する
// 仕様に変更。タブ切替の bindEditorTabs / setEditorTab / editorTabsSectionEl は不要に。

// font-source タブ：edit-font-combobox（フォント検索）と style-palette（プリセット）を
// 排他切替する。ユーザーの選択は localStorage に永続化。
const FONT_SOURCE_KEY = "psdesign_font_source_v2";
const FAVORITE_STYLES_KEY = "psdesign_favorite_text_styles";

function readFavoriteStyles() {
  try {
    const raw = localStorage.getItem(FAVORITE_STYLES_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((s) => s && typeof s === "object") : [];
  } catch {
    return [];
  }
}

function writeFavoriteStyles(styles) {
  try {
    localStorage.setItem(FAVORITE_STYLES_KEY, JSON.stringify(styles));
  } catch (e) {
    console.error("[favorite-style] failed to save:", e);
  }
}

function currentStyleSnapshot() {
  const fontPs = fontEl()?.dataset.ps || getCurrentFont() || "";
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: "",
    fontPostScriptName: fontPs,
    createdAt: Date.now(),
  };
}

function favoriteStyleDefaultName(style) {
  return displayFontName(style.fontPostScriptName) || "Font";
}

function normalizeFavoriteStyle(style) {
  return {
    id: style.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: String(style.name || "").trim() || favoriteStyleDefaultName(style),
    fontPostScriptName: style.fontPostScriptName || "",
    createdAt: Number(style.createdAt) || Date.now(),
  };
}

function styleSummary(style) {
  return displayFontName(style.fontPostScriptName) || style.fontPostScriptName || "";
}

function renderFavoriteStyles() {
  const list = favoriteStyleListEl();
  if (!list) return;
  const styles = readFavoriteStyles().map(normalizeFavoriteStyle);
  if (!styles.length) {
    list.innerHTML = '<div class="favorite-style-empty">保存したスタイルはありません</div>';
    return;
  }
  list.innerHTML = "";
  for (const style of styles) {
    const row = document.createElement("div");
    row.className = "favorite-style-item";
    row.title = "クリックでスタイルを適用";

    const body = document.createElement("button");
    body.type = "button";
    body.className = "favorite-style-apply";
    body.addEventListener("click", () => applyFavoriteStyle(style));

    const name = document.createElement("span");
    name.className = "favorite-style-name";
    name.textContent = style.name;
    if (style.fontPostScriptName) {
      const fam = cssFontFamily(style.fontPostScriptName);
      if (fam) name.style.fontFamily = fam;
      ensureFontLoaded(style.fontPostScriptName);
    }
    body.appendChild(name);

    const meta = document.createElement("span");
    meta.className = "favorite-style-meta";
    meta.textContent = styleSummary(style);
    body.appendChild(meta);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "favorite-style-delete";
    del.title = "削除";
    del.setAttribute("aria-label", `${style.name} を削除`);
    del.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M3 6h18"/>
        <path d="M8 6V4h8v2"/>
        <path d="M19 6l-1 14H6L5 6"/>
        <path d="M10 11v5"/>
        <path d="M14 11v5"/>
      </svg>
    `;
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      writeFavoriteStyles(readFavoriteStyles().filter((s) => s.id !== style.id));
      renderFavoriteStyles();
    });

    row.appendChild(body);
    row.appendChild(del);
    list.appendChild(row);
  }
}

function saveCurrentFavoriteStyle() {
  const style = normalizeFavoriteStyle(currentStyleSnapshot());
  const styles = readFavoriteStyles().map(normalizeFavoriteStyle);
  if (style.fontPostScriptName && styles.some((s) => s.fontPostScriptName === style.fontPostScriptName)) {
    toast("このフォントはすでにお気に入りに登録されています");
    return;
  }
  styles.unshift(style);
  writeFavoriteStyles(styles.slice(0, 30));
  renderFavoriteStyles();
}

function applyFavoriteStyle(style) {
  const s = normalizeFavoriteStyle(style);
  if (s.fontPostScriptName) {
    const font = getFonts().find((f) => f.postScriptName === s.fontPostScriptName)
      ?? { postScriptName: s.fontPostScriptName, name: displayFontName(s.fontPostScriptName) };
    commitFont(font);
  }
  renderFavoriteStyles();
}

function bindFavoriteStyles() {
  renderFavoriteStyles();
  const saveBtn = favoriteStyleSaveBtnEl();
  if (saveBtn) saveBtn.addEventListener("click", () => {
    saveCurrentFavoriteStyle();
  });
}

function setFontSourceTab(source) {
  if (source !== "combobox") closeCombo();
  const tabs = document.querySelectorAll(".font-source-tab");
  const panels = document.querySelectorAll(".font-source-panel");
  for (const btn of tabs) {
    const isActive = btn.dataset.source === source;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-selected", isActive ? "true" : "false");
  }
  for (const panel of panels) {
    panel.hidden = panel.dataset.sourcePanel !== source;
  }
  try { localStorage.setItem(FONT_SOURCE_KEY, source); } catch (_) {}
}

function bindFontSourceTabs() {
  const tabs = document.querySelectorAll(".font-source-tab");
  if (!tabs.length) return;
  for (const btn of tabs) {
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", () => setFontSourceTab(btn.dataset.source));
  }
  // 初期状態を localStorage から復元（既定: palette）
  let initial = "palette";
  try {
    const saved = localStorage.getItem(FONT_SOURCE_KEY);
    if (saved === "combobox" || saved === "palette") initial = saved;
  } catch (_) {}
  setFontSourceTab(initial);
}

export function bindEditorEvents() {
  bindFontSourceTabs();
  bindFavoriteStyles();

  // フォント検索コンボボックスの配線。
  const input = fontEl();
  if (input) {
    const resetFontSearchForTyping = () => {
      if (input.dataset.fontSearchCleared === "true") return;
      input.dataset.fontSearchRestoreValue = input.value || "";
      input.dataset.fontSearchCleared = "true";
      input.dataset.fontSearchDirty = "false";
      input.value = "";
      if (comboOpen) filterCombo("");
    };
    input.addEventListener("focus", () => {
      if (shouldSuppressComboAutoOpen()) {
        closeCombo();
        return;
      }
      resetFontSearchForTyping();
      openCombo(true);
    });
    input.addEventListener("mousedown", () => {
      if (shouldSuppressComboAutoOpen()) return;
      if (document.activeElement === input) resetFontSearchForTyping();
    });
    input.addEventListener("input", () => {
      input.dataset.fontSearchDirty = "true";
      if (!comboOpen) openCombo();
      else filterCombo(input.value);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        moveComboHighlight(+1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        moveComboHighlight(-1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (comboOpen && comboHighlighted >= 0) {
          commitFont(comboItems[comboHighlighted].font);
        } else {
          const font = resolveFontFromInput(input.value);
          if (font) commitFont(font);
        }
        input.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeCombo();
        input.blur();
      }
    });
    input.addEventListener("blur", () => {
      setTimeout(() => {
        const active = document.activeElement;
        if (!active || !fontComboboxEl()?.contains(active)) closeCombo();
        if (
          document.activeElement !== input
          && input.dataset.fontSearchCleared === "true"
          && input.dataset.fontSearchDirty !== "true"
          && input.value === ""
        ) {
          input.value = input.dataset.fontSearchRestoreValue || "";
        }
        input.dataset.fontSearchCleared = "false";
        input.dataset.fontSearchDirty = "false";
      }, 120);
    });
    const toggleBtn = fontToggleEl();
    if (toggleBtn) {
      toggleBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        if (comboOpen) {
          closeCombo();
        } else {
          // ▾ トグル経由は入力欄のフィルタを無視してインストール済み全フォントを一覧表示。
          // input.focus() は input イベントを発火しないので showAll=true のまま維持される。
          input.focus();
          openCombo(true, { force: true });
        }
      });
    }
    document.addEventListener("mousedown", (e) => {
      if (!comboOpen) return;
      if (!fontComboboxEl()?.contains(e.target)) closeCombo();
    });

    // 起動時 / 環境設定変更時に、選択 0 件でも state.currentFont を入力欄に表示。
    // フォント一覧は font-loader が非同期で揃えるので、登録完了後にも再同期する。
    syncFontInputFromState();
    onCurrentFontChange(() => {
      if (getSelectedLayers().length === 0) syncFontInputFromState();
    });
    onFontsRegistered(() => {
      if (getSelectedLayers().length === 0) syncFontInputFromState();
    });
    window.addEventListener("psdesign:fonts-loaded", () => {
      if (getSelectedLayers().length === 0) syncFontInputFromState();
      else rebuildFontOptions(fontEl()?.dataset.ps || "");
    });
    // 【v1.16.0】per-char フォント編集の UI 連動 — 選択範囲のキャッシュ変化に追従。
    // in-place 編集の選択範囲変化（module-level キャッシュ）に追従してフォント入力欄を更新。
    // 加えて、editor 上部に「選択: N 文字」のインジケータを出してユーザーに現状を伝える。
    setupCharSelectionIndicator();
    onInplaceSelectionChange((sel) => {
      updateCharSelectionIndicator(sel);
      if (!sel) {
        populateEditor();
        return;
      }
      const targetId = sel.tempId ?? sel.layerId;
      const pageIndex = getPages().findIndex((p) => p.path === sel.psdPath);
      const ref = pageIndex >= 0 ? resolveLayerRef({ pageIndex, layerId: targetId }) : null;
      const rangeDefaultSize = ref?.kind === "existing"
        ? layerDefaultSize(ref, ref.page, ref.layer, getEdit(ref.page.path, ref.layer.id) ?? {})
        : layerDefaultSize(ref);
      const rangeSizes = ref ? collectSizesForRange(ref, sel.start, sel.end, rangeDefaultSize) : [];
      const rangePage = ref?.page ?? getPages()[pageIndex] ?? null;
      if (rangeSizes.length === 1) setTextSize(rangeSizes[0]);
      syncSizeInputMixedDisplay(rangeSizes, rangePage);
      const horizontalScales = ref ? collectScalesForRange(ref, sel.start, sel.end, "horizontalScale") : [];
      const verticalScales = ref ? collectScalesForRange(ref, sel.start, sel.end, "verticalScale") : [];
      const trackings = ref ? collectSpacingsForRange(ref, sel.start, sel.end, "trackingMille") : [];
      const kernings = ref ? collectSpacingsForRange(ref, sel.start, sel.end, "kerningMille") : [];
      syncTextScaleInput(horizontalScaleInputEl(), horizontalScales.length === 1 ? horizontalScales[0] : null);
      syncTextScaleInput(verticalScaleInputEl(), verticalScales.length === 1 ? verticalScales[0] : null);
      syncTextScaleInput(trackingInputEl(), trackings.length === 1 ? trackings[0] : null);
      syncTextScaleInput(kerningInputEl(), kernings.length === 1 ? kernings[0] : null);
      syncTcyControls(sel);
      const fonts = ref ? collectFontsForRange(ref, sel.start, sel.end) : [];
      if (fonts.length === 1) {
        syncFontInputFromRangeFonts(fonts);
      } else if (fonts.length > 1) {
        syncFontInputFromRangeFonts(fonts);
      } else {
        const ps = getCharFont(sel.psdPath, targetId, sel.start);
        // override がある → そのフォントを表示
        rebuildFontOptions(ps, { force: true });
      }
    });
  }

  bindTextScaleControls();
  bindTextSpacingControls();
  bindTateChuYokoControl();
  bindVerticalHalfToFullSelect();

  const deleteBtn = document.getElementById("delete-new-layer-btn");
  if (deleteBtn) {
    deleteBtn.addEventListener("click", async () => {
      const selections = getSelectedLayers();
      const tempIds = selections
        .filter((s) => typeof s.layerId === "string")
        .map((s) => s.layerId);
      if (tempIds.length === 0) return;
      const ok = await confirmDialog({
        title: "レイヤー削除",
        message: "レイヤーを削除します。よろしいですか？",
        confirmLabel: "削除",
      });
      if (!ok) return;
      withHistoryTransient(() => {
        for (const id of tempIds) removeNewLayer(id);
      });
      // 既存レイヤーは残し、新規分だけを選択から除外。
      setSelectedLayers(selections.filter((s) => typeof s.layerId !== "string"));
      rebuildLayerList();
      refreshAllOverlays();
    });
  }
  const bindStrokeButton = (btn, color) => {
    if (!btn) return;
    btn.addEventListener("click", () => {
      setStrokeColor(color);
      syncStrokeToggle(color);
      // 色と太さはセットで書き込む（片方だけだと既存レイヤーの他方が失われる）。
      // 幅が混在しているときは各レイヤーの幅を保持（null）。
      commitStrokeFields(color, currentWidthForCommit());
    });
  };
  bindStrokeButton(strokeNoneBtnEl(), "none");
  bindStrokeButton(strokeWhiteBtnEl(), "white");
  bindStrokeButton(strokeBlackBtnEl(), "black");
  const convertWhiteStrokeBtn = convertWhiteStrokeBtnEl();
  if (convertWhiteStrokeBtn) {
    convertWhiteStrokeBtn.addEventListener("click", () => {
      convertAllLayersToCurrentStrokeSpec();
    });
  }

  // スウォッチ再クリックで「そのまま（default）」に戻せる：
  // アクティブ中の色を再押下すると default（色を触らない）状態に復帰する。
  const applyFillChoice = (color, { toggle = true } = {}) => {
    const normalized = normalizeFillChoice(color);
    const next = toggle && normalized !== "default" && getFillColor() === normalized
      ? "default"
      : normalized;
    setFillColor(next);
    syncFillToggle(next);
    commitFillField(next);
  };
  const bindFillButton = (btn) => {
    if (!btn) return;
    if (btn.dataset.fillBound === "true") return;
    btn.dataset.fillBound = "true";
    btn.addEventListener("click", () => {
      if (btn.id === "fill-custom-swatch") {
        const color = normalizeFillChoice(btn.dataset.fill);
        if (HEX_FILL_COLOR_RE.test(color)) applyFillChoice(color, { toggle: false });
        fillColorPickerEl()?.click();
        return;
      }
      applyFillChoice(btn.dataset.fill);
    });
  };
  for (const btn of fillButtonEls()) bindFillButton(btn);
  const picker = fillColorPickerEl();
  if (picker && picker.dataset.fillBound !== "true") {
    picker.dataset.fillBound = "true";
    const applyPickerColor = () => {
      const color = normalizeFillChoice(picker.value);
      const custom = fillCustomBtnEl();
      if (custom && HEX_FILL_COLOR_RE.test(color)) {
        custom.dataset.fill = color;
        custom.style.background = color;
        custom.classList.add("has-color");
      }
      applyFillChoice(color, { toggle: false });
    };
    picker.addEventListener("input", applyPickerColor);
    picker.addEventListener("change", applyPickerColor);
  }

  // ツールバー常駐のフィルスウォッチは、外部の setFillColor（clearPages など）にも追従させる。
  syncFillToggle(getFillColor());
  onFillColorChange((c) => syncFillToggle(c));

  const widthInput = strokeWidthInputEl();
  if (widthInput) {
    widthInput.addEventListener("input", () => {
      const raw = widthInput.value;
      if (raw === "") return;
      const n = Number(raw);
      if (!Number.isFinite(n)) return;
      setStrokeWidthPx(n);
      commitStrokeFields(null, getStrokeWidthPx());
    });
    widthInput.addEventListener("blur", () => {
      if (widthInput.value === "" || !Number.isFinite(Number(widthInput.value))) {
        setStrokeWidthPx(20);
        widthInput.value = "20";
        commitStrokeFields(null, 20);
      }
    });
  }

  // 太さの ± ボタン（0.5px ステップ、setStrokeWidthPx で 0〜999 にクランプ）。
  const adjustStrokeWidth = (delta) => {
    setStrokeWidthPx(getStrokeWidthPx() + delta);
    const next = getStrokeWidthPx();
    if (widthInput) {
      widthInput.value = String(next);
      widthInput.placeholder = "";
    }
    commitStrokeFields(null, next);
  };
  const widthDec = document.getElementById("stroke-width-dec-btn");
  const widthInc = document.getElementById("stroke-width-inc-btn");
  if (widthDec) widthDec.addEventListener("click", () => adjustStrokeWidth(-0.5));
  if (widthInc) widthInc.addEventListener("click", () => adjustStrokeWidth(+0.5));
}

function commitTextScaleField(field, percent) {
  const value = clampTextScalePercent(percent);
  if (!Number.isFinite(value)) return false;
  const sel = getLastInplaceSelection();
  if (sel && sel.end > sel.start) {
    const targetId = sel.tempId ?? sel.layerId;
    withHistoryTransient(() => {
      if (field === "horizontalScale") {
        setCharHorizontalScalesRange(sel.psdPath, targetId, sel.start, sel.end, value);
      } else {
        setCharVerticalScalesRange(sel.psdPath, targetId, sel.start, sel.end, value);
      }
      return true;
    });
    refreshActiveInPlaceEditPreview(sel);
    const active = document.activeElement;
    const activeIsScaleInput = active === horizontalScaleInputEl() || active === verticalScaleInputEl();
    if (activeIsScaleInput) {
      showInplaceSelectionHighlightOnly(sel);
      requestAnimationFrame(() => showInplaceSelectionHighlightOnly(sel));
    } else {
      restoreInplaceSelection(sel);
      requestAnimationFrame(() => restoreInplaceSelection(sel));
    }
    return true;
  }
  return commitSingleFieldToSelections(field, value);
}

function commitTextSpacingField(field, mille) {
  const value = clampTextSpacingMille(mille);
  if (!Number.isFinite(value)) return false;
  const sel = getLastInplaceSelection();
  if (sel && Number.isInteger(sel.start) && Number.isInteger(sel.end) && sel.end >= sel.start) {
    const targetId = sel.tempId ?? sel.layerId;
    const textLength = (() => {
      const page = getPages().find((p) => p.path === sel.psdPath);
      if (!page) return 0;
      if (typeof targetId === "string") {
        const nl = getNewLayersForPsd(page.path).find((l) => l.tempId === targetId);
        return String(nl?.contents ?? "").length;
      }
      const layer = page.textLayers?.find((l) => l.id === targetId);
      const edit = getEdit(page.path, targetId) ?? {};
      return String(edit.contents ?? layer?.text ?? "").length;
    })();
    if (textLength <= 0) return false;
    const from = sel.end > sel.start
      ? Math.max(0, Math.min(textLength, sel.start))
      : Math.max(0, Math.min(textLength - 1, sel.start - 1));
    const to = sel.end > sel.start
      ? Math.max(from, Math.min(textLength, sel.end))
      : Math.min(textLength, from + 1);
    if (to <= from) return false;
    withHistoryTransient(() => {
      if (typeof targetId === "string") {
        updateNewLayer(targetId, { [field]: 0 });
      } else {
        setEdit(sel.psdPath, targetId, { [field]: undefined });
      }
      if (field === "trackingMille") {
        setCharTrackingsRange(sel.psdPath, targetId, from, to, value);
      } else {
        setCharKerningsRange(sel.psdPath, targetId, from, to, value);
      }
      return true;
    });
    refreshActiveInPlaceEditPreview(sel);
    const active = document.activeElement;
    const activeIsSpacingInput = active === trackingInputEl() || active === kerningInputEl();
    if (activeIsSpacingInput) {
      showInplaceSelectionHighlightOnly(sel);
      requestAnimationFrame(() => showInplaceSelectionHighlightOnly(sel));
    } else {
      restoreInplaceSelection(sel);
      requestAnimationFrame(() => restoreInplaceSelection(sel));
    }
    return true;
  }
  return false;
}

function commitTateChuYokoSelection(enabled) {
  const ctx = getTcyContext();
  if (!ctx) return false;
  if (ctx.direction !== "vertical") {
    toast("縦書きテキストでのみ使用できます");
    return false;
  }
  const runs = rangesForTcy(ctx.text, ctx.sel.start, ctx.sel.end);
  if (runs.length === 0) {
    toast("縦中横にする文字を選択してください");
    syncTcyControls(ctx.sel);
    return false;
  }
  withHistoryTransient(() => {
    for (const run of runs) {
      setCharTateChuYokosRange(ctx.sel.psdPath, ctx.targetId, run.start, run.end, enabled);
    }
    return true;
  });
  refreshActiveInPlaceEditPreview(ctx.sel);
  showInplaceSelectionHighlightOnly(ctx.sel);
  requestAnimationFrame(() => showInplaceSelectionHighlightOnly(ctx.sel));
  syncTcyControls(ctx.sel);
  return true;
}

function bindTateChuYokoControl() {
  const applyBtn = tcyApplyBtnEl();
  const removeBtn = tcyRemoveBtnEl();
  const bind = (btn, enabled) => {
    if (!btn || btn.dataset.tcyBound === "true") return;
    btn.dataset.tcyBound = "true";
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", () => commitTateChuYokoSelection(enabled));
  };
  bind(applyBtn, true);
  bind(removeBtn, false);
  syncTcyControls();
}

function bindVerticalHalfToFullSelect() {
  const select = verticalHalfToFullSelectEl();
  if (!select || select.dataset.halfToFullBound === "true") return;
  select.dataset.halfToFullBound = "true";
  syncVerticalHalfToFullSelect();
  select.addEventListener("change", () => {
    const enabled = select.value !== "off";
    setDefault("verticalHalfToFullEnabled", enabled);
    if (enabled) applyVerticalHalfToFullToSelectedLayers();
    syncVerticalHalfToFullSelect();
  });
  select.addEventListener("click", () => {
    if (select.value !== "off") applyVerticalHalfToFullToSelectedLayers();
  });
  onSettingsChange(() => syncVerticalHalfToFullSelect());
}

function bindTextScaleControls() {
  const bind = (field, input, decBtn, incBtn) => {
    if (!input) return;
    const applyValue = () => {
      const value = clampTextScalePercent(input.value);
      if (!Number.isFinite(value)) return;
      input.value = String(value);
      commitTextScaleField(field, value);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      applyValue();
      input.select();
    });
    input.addEventListener("change", applyValue);
    input.addEventListener("blur", () => {
      if (input.value === "" || !Number.isFinite(Number(input.value))) input.value = "100";
      applyValue();
    });
    const adjust = (delta) => {
      const cur = clampTextScalePercent(input.value || 100) ?? 100;
      const next = clampTextScalePercent(cur + delta) ?? 100;
      input.value = String(next);
      commitTextScaleField(field, next);
    };
    if (decBtn) {
      decBtn.addEventListener("mousedown", (e) => e.preventDefault());
      decBtn.addEventListener("click", () => adjust(-1));
    }
    if (incBtn) {
      incBtn.addEventListener("mousedown", (e) => e.preventDefault());
      incBtn.addEventListener("click", () => adjust(+1));
    }
  };
  bind(
    "horizontalScale",
    horizontalScaleInputEl(),
    document.getElementById("horizontal-scale-dec-btn"),
    document.getElementById("horizontal-scale-inc-btn"),
  );
  bind(
    "verticalScale",
    verticalScaleInputEl(),
    document.getElementById("vertical-scale-dec-btn"),
    document.getElementById("vertical-scale-inc-btn"),
  );
}

function bindTextSpacingControls() {
  const bind = (field, input, decBtn, incBtn) => {
    if (!input) return;
    const applyValue = () => {
      const value = clampTextSpacingMille(input.value);
      if (!Number.isFinite(value)) return;
      input.value = String(value);
      commitTextSpacingField(field, value);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      applyValue();
      input.select();
    });
    input.addEventListener("change", applyValue);
    input.addEventListener("blur", () => {
      if (input.value === "" || !Number.isFinite(Number(input.value))) input.value = "0";
      applyValue();
    });
    const adjust = (delta) => {
      const cur = clampTextSpacingMille(input.value || 0) ?? 0;
      const next = clampTextSpacingMille(cur + delta) ?? 0;
      input.value = String(next);
      commitTextSpacingField(field, next);
    };
    if (decBtn) {
      decBtn.addEventListener("mousedown", (e) => e.preventDefault());
      decBtn.addEventListener("click", () => adjust(-10));
    }
    if (incBtn) {
      incBtn.addEventListener("mousedown", (e) => e.preventDefault());
      incBtn.addEventListener("click", () => adjust(+10));
    }
  };
  bind(
    "kerningMille",
    kerningInputEl(),
    document.getElementById("kerning-dec-btn"),
    document.getElementById("kerning-inc-btn"),
  );
  bind(
    "trackingMille",
    trackingInputEl(),
    document.getElementById("tracking-dec-btn"),
    document.getElementById("tracking-inc-btn"),
  );
}

// colorOrNull / widthOrNull に null を渡すと「各レイヤーの現在値を保持」の意味。
// 複数選択でフチ色/幅が混在している状態で片方だけを編集したとき、
// 他方がグローバル state で上書きされて本来の値が失われるのを避ける。
// 色と太さは JSX 側で必ずセットで評価されるため、ここで常に両フィールドを書き込む。
function commitStrokeFields(colorOrNull, widthOrNull) {
  const selections = getSelectedLayers();
  if (selections.length === 0) return;
  withHistoryTransient(() => {
    let mutated = false;
    for (const sel of selections) {
      const ref = resolveLayerRef(sel);
      if (!ref) continue;
      let curColor, curWidth;
      if (ref.kind === "existing") {
        const edit = getEdit(ref.page.path, ref.layer.id) ?? {};
        curColor = edit.strokeColor ?? ref.layer.strokeColor ?? "none";
        curWidth = edit.strokeWidthPx ?? ref.layer.strokeWidthPx ?? 20;
      } else {
        curColor = ref.newLayer.strokeColor ?? "none";
        curWidth = ref.newLayer.strokeWidthPx ?? 20;
      }
      const changes = {
        strokeColor: colorOrNull !== null ? colorOrNull : curColor,
        strokeWidthPx: widthOrNull !== null ? widthOrNull : curWidth,
      };
      if (ref.kind === "existing") {
        setEdit(ref.page.path, ref.layer.id, changes);
      } else {
        updateNewLayer(ref.newLayer.tempId, changes);
      }
      mutated = true;
    }
    return mutated || false;
  });
  rebuildLayerList();
  refreshAllOverlays();
}

// Converts stroke-bearing text layers to the currently selected Photoshop-compatible stroke payload.
async function convertAllLayersToCurrentStrokeSpec() {
  const pages = getPages();
  if (pages.length === 0) {
    toast("PSDを開いてからフチ仕様に変換してください", { kind: "info", duration: 2400 });
    return;
  }
  const color = getStrokeColor();
  const width = getBulkStrokeWidth();
  if (!Number.isFinite(width)) {
    toast("フチ太さを 0〜999 px で指定してください", { kind: "warning", duration: 2600 });
    return;
  }
  const specLabel = strokeSpecLabel(color, width);
  const layerCount = countStrokeBearingLayers(pages);
  if (layerCount === 0) {
    toast("フチが付いているテキストレイヤーがありません", { kind: "info", duration: 2400 });
    return;
  }

  const ok = await confirmDialog({
    title: "フチ仕様に一括変換",
    message: `フチが付いているテキストレイヤー (${layerCount} 件) を ${specLabel} に変換します。対象レイヤーの現在のフチ設定は上書きされます。`,
    confirmLabel: "変換",
  });
  if (!ok) return;

  const changed = withHistoryTransient(() => {
    let count = 0;
    for (const page of pages) {
      for (const layer of page.textLayers ?? []) {
        const edit = getEdit(page.path, layer.id) ?? {};
        const currentColor = edit.strokeColor ?? layer.strokeColor ?? "none";
        const currentWidth = edit.strokeWidthPx ?? layer.strokeWidthPx ?? 20;
        if (!hasVisibleStroke(currentColor, currentWidth)) continue;
        if (currentColor === color && currentWidth === width) continue;
        setEdit(page.path, layer.id, { strokeColor: color, strokeWidthPx: width });
        count++;
      }
      for (const nl of getNewLayersForPsd(page.path)) {
        const currentColor = nl.strokeColor ?? "none";
        const currentWidth = nl.strokeWidthPx ?? 20;
        if (!hasVisibleStroke(currentColor, currentWidth)) continue;
        if (currentColor === color && currentWidth === width) continue;
        updateNewLayer(nl.tempId, { strokeColor: color, strokeWidthPx: width });
        count++;
      }
    }
    return count > 0 ? count : false;
  });

  if (!changed) {
    toast("すでに現在のフチ仕様に揃っています", { kind: "info", duration: 2400 });
    return;
  }
  setStrokeColor(color);
  setStrokeWidthPx(width);
  syncStrokeToggle(color);
  syncStrokeWidthInput(width);
  rebuildLayerList();
  refreshAllOverlays();
  toast(`${changed} 件を ${specLabel} に変換しました`, { kind: "success", duration: 2600 });
}

// Returns the current center point of a layer, including pending edit offsets.
export function getLayerCenter(ref) {
  if (ref.kind === "existing") {
    const edit = getEdit(ref.page.path, ref.layer.id) ?? {};
    const rect = layerRectForExisting(ref.page, ref.layer, edit);
    return { cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2 };
  } else {
    const rect = layerRectForNew(ref.page, ref.newLayer);
    return { cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2 };
  }
}

// 【v1.26.0 移植 (PsDesign-main v1.24.0)】
// レイヤーを oldCenter (= 変更前の中心) に来るように left/top (or dx/dy) を再計算。
// commitFontToSelections / commitSingleFieldToSelections から呼ばれる。
export function recenterLayerToCenter(ref, oldCenter) {
  if (!oldCenter) return;
  if (ref.kind === "existing") {
    // 既存: 新 rect の中心と oldCenter の差分を addEditOffset で加算する。
    // state から最新の edit を再取得（commit 系で既に書き込まれている）して bbox 計算。
    const edit = getEdit(ref.page.path, ref.layer.id) ?? {};
    const newRect = layerRectForExisting(ref.page, ref.layer, edit);
    const newCx = newRect.left + newRect.width / 2;
    const newCy = newRect.top + newRect.height / 2;
    const ddx = oldCenter.cx - newCx;
    const ddy = oldCenter.cy - newCy;
    if (ddx !== 0 || ddy !== 0) {
      addEditOffset(ref.page.path, ref.layer.id, ddx, ddy);
    }
  } else {
    // 新規: 新 rect.width/height で oldCenter から逆算した top-left を直接書き込む。
    // state から最新の newLayer を再取得（commit 系で既に書き込まれている）。
    const list = getNewLayersForPsd(ref.page.path);
    const latest = list.find((l) => l.tempId === ref.newLayer.tempId) ?? ref.newLayer;
    const newRect = layerRectForNew(ref.page, latest);
    const newX = oldCenter.cx - newRect.width / 2;
    const newY = oldCenter.cy - newRect.height / 2;
    updateNewLayer(ref.newLayer.tempId, { x: newX, y: newY });
  }
}

// edit-font ブラシモード用: 選択中の全レイヤーに同じ postScriptName を書き込む。
// 既に同フォントのレイヤーは skip して無駄な undo ステップを作らない。
// 1 件以上書き込まれた場合だけ rebuildLayerList / refreshAllOverlays を実行し true を
// 返す（呼び出し側が二重 rebuild を避けられるようにするため）。
//
// 【v1.26.0 移植 (PsDesign-main v1.24.0)】フォント変更で bbox サイズが変わるため、UI 上の中心
// を固定したまま box の left/top を再計算する。これがないと box が左上を起点に伸び、
// 視覚的に「テキストや白フチが左寄りに動く」現象になる。
export function commitFontToSelections(ps) {
  if (!ps) return false;
  const selections = getSelectedLayers();
  if (selections.length === 0) return false;
  const mutated = withHistoryTransient(() => {
    let any = false;
    for (const sel of selections) {
      const ref = resolveLayerRef(sel);
      if (!ref) continue;
      let cur;
      if (ref.kind === "existing") {
        const edit = getEdit(ref.page.path, ref.layer.id) ?? {};
        cur = edit.fontPostScriptName ?? ref.layer.font ?? null;
      } else {
        cur = ref.newLayer.fontPostScriptName ?? null;
      }
      if (cur === ps) {
        // フォント未変更（既に同じフォント）でも、新規レイヤーの自動配置色マーカーは解除する。
        // 複数選択でのフォント一括適用でも「一部だけ色が残る」のを防ぐ（size 経路と同方針）。
        if (ref.kind === "new" && ref.newLayer.autoFontSwitched === true) {
          updateNewLayer(ref.newLayer.tempId, { autoFontSwitched: false, autoFontSwitchBucket: -1 });
          any = true;
        }
        continue;
      }
      // 中心固定: 変更前の rect 中心を取得 → フィールド更新 → 新 rect 取得 → x/y 補正。
      const oldCenter = getLayerCenter(ref);
      if (ref.kind === "existing") {
        setEdit(ref.page.path, ref.layer.id, { fontPostScriptName: ps });
      } else {
        updateNewLayer(ref.newLayer.tempId, {
          fontPostScriptName: ps,
          autoFontSwitched: false,
          autoFontSwitchBucket: -1,
        });
      }
      recenterLayerToCenter(ref, oldCenter);
      any = true;
    }
    return any || false;
  });
  if (mutated) {
    rebuildLayerList();
    refreshAllOverlays();
    refreshTextStyleMarkerViews();
  }
  return !!mutated;
}

// 単一フィールド（sizePt / leadingPct など）を選択中の全レイヤーに書き込む。
// 値が変わらないレイヤーはスキップして余計な history snapshot を作らない。
//
// 【v1.26.0 移植 (PsDesign-main v1.24.0)】サイズ / 行間変更で bbox の幅・高さが変わるため、
// commitFontToSelections と同じく「中心固定」で box の left/top を再計算する。
// 視覚的に「中心位置を保ったまま box が広がる」自然な挙動になる。
function commitSingleFieldToSelections(field, value) {
  const selections = getSelectedLayers();
  if (selections.length === 0) return false;
  const mutated = withHistoryTransient(() => {
    let any = false;
    for (const sel of selections) {
      const ref = resolveLayerRef(sel);
      if (!ref) continue;
      let cur;
      if (ref.kind === "existing") {
        const edit = getEdit(ref.page.path, ref.layer.id) ?? {};
        cur = edit[field];
      } else {
        cur = ref.newLayer[field];
      }
      if (cur === value) {
        // 自動配置の色マーカー (autoFontSwitched) は「サイズを揃える一括変更」でも必ず解除する。
        // 既に目標サイズと同値の新規レイヤーは下の continue で skip され、wheel 経路
        // (canvas-tools.js resizeSelectedLayers) と違ってマーカーが残り「一部だけ色が消えない」
        // バグになる。サイズ未変更でもマーカーだけ先に解除する（位置再計算は不要）。
        if (field === "sizePt" && ref.kind === "new" && ref.newLayer.autoFontSwitched === true) {
          updateNewLayer(ref.newLayer.tempId, { autoFontSwitched: false, autoFontSwitchBucket: -1 });
          any = true;
        }
        continue;
      }
      const oldCenter = getLayerCenter(ref);
      if (ref.kind === "existing") {
        setEdit(ref.page.path, ref.layer.id, { [field]: value });
      } else {
        const changes = { [field]: value };
        if (field === "sizePt") {
          changes.autoFontSwitched = false;
          changes.autoFontSwitchBucket = -1;
        }
        updateNewLayer(ref.newLayer.tempId, changes);
      }
      recenterLayerToCenter(ref, oldCenter);
      any = true;
    }
    return any || false;
  });
  if (mutated) {
    rebuildLayerList();
    refreshAllOverlays();
    if (field === "sizePt") {
      refreshTextStyleMarkerViews();
    }
  }
  return !!mutated;
}

// サイズ（sizePt）を選択中の全レイヤーに書き込む。
export function commitSizeToSelections(sizePt) {
  if (!Number.isFinite(sizePt)) return false;
  return commitSingleFieldToSelections("sizePt", sizePt);
}

export function unifySelectedTextSize(sizePt) {
  const selections = getSelectedLayers();
  if (selections.length < 1) return false;
  const targetSize = Math.round(Number(sizePt) * 100) / 100;
  if (!Number.isFinite(targetSize)) return false;
  setTextSize(targetSize);
  return commitSizeToSelections(targetSize);
}

// 行間（leadingPct）を選択中の全レイヤーに書き込む。
export function commitLeadingToSelections(leadingPct) {
  if (!Number.isFinite(leadingPct)) return false;
  return commitSingleFieldToSelections("leadingPct", leadingPct);
}

// 【v1.22.0】合成太字（faux bold）を選択中の全レイヤーに書き込む。
// layer 全体に bold flag を当てる per-layer 適用。per-char (charBolds) で残っている
// オーバーライドはクリアして、layer 値が確実に効くようにする（ユーザーが Photoshop の
// B ボタン感覚で trigger したとき、選択範囲全体が均一に bold になることを期待するため）。
export function commitBoldToSelections(value) {
  const v = !!value;
  const selections = getSelectedLayers();
  if (selections.length === 0) return false;
  const mutated = withHistoryTransient(() => {
    let any = false;
    for (const sel of selections) {
      const ref = resolveLayerRef(sel);
      if (!ref) continue;
      let cur, hadCharBolds;
      if (ref.kind === "existing") {
        const edit = getEdit(ref.page.path, ref.layer.id) ?? {};
        cur = edit.syntheticBold === true;
        hadCharBolds = edit.charBolds && Object.keys(edit.charBolds).length > 0;
      } else {
        cur = ref.newLayer.syntheticBold === true;
        hadCharBolds = ref.newLayer.charBolds && Object.keys(ref.newLayer.charBolds).length > 0;
      }
      if (cur === v && !hadCharBolds) continue;
      const changes = { syntheticBold: v, charBolds: {} };
      if (ref.kind === "existing") {
        setEdit(ref.page.path, ref.layer.id, changes);
      } else {
        updateNewLayer(ref.newLayer.tempId, changes);
      }
      any = true;
    }
    return any || false;
  });
  if (mutated) {
    rebuildLayerList();
    refreshAllOverlays();
  }
  return !!mutated;
}

export function commitItalicToSelections(value) {
  const v = !!value;
  const selections = getSelectedLayers();
  if (selections.length === 0) return false;
  const mutated = withHistoryTransient(() => {
    let any = false;
    for (const sel of selections) {
      const ref = resolveLayerRef(sel);
      if (!ref) continue;
      let cur, hadCharItalics;
      if (ref.kind === "existing") {
        const edit = getEdit(ref.page.path, ref.layer.id) ?? {};
        cur = edit.syntheticItalic === true;
        hadCharItalics = edit.charItalics && Object.keys(edit.charItalics).length > 0;
      } else {
        cur = ref.newLayer.syntheticItalic === true;
        hadCharItalics = ref.newLayer.charItalics && Object.keys(ref.newLayer.charItalics).length > 0;
      }
      if (cur === v && !hadCharItalics) continue;
      const changes = { syntheticItalic: v, charItalics: {} };
      if (ref.kind === "existing") {
        setEdit(ref.page.path, ref.layer.id, changes);
      } else {
        updateNewLayer(ref.newLayer.tempId, changes);
      }
      any = true;
    }
    return any || false;
  });
  if (mutated) {
    rebuildLayerList();
    refreshAllOverlays();
  }
  return !!mutated;
}

// 【v1.22.0】複数選択レイヤーの bold 共通値を計算（混在は null）。
// 既存 computeCommonStroke / computeCommonFill と同型。
function computeCommonBold(selections) {
  let common;
  for (const sel of selections) {
    const ref = resolveLayerRef(sel);
    if (!ref) continue;
    let v;
    if (ref.kind === "existing") {
      const edit = getEdit(ref.page.path, ref.layer.id) ?? {};
      v = edit.syntheticBold === true;
    } else {
      v = ref.newLayer.syntheticBold === true;
    }
    if (common === undefined) common = v;
    else if (common !== v) return null;
  }
  return common ?? null;
}

function computeCommonItalic(selections) {
  let common;
  for (const sel of selections) {
    const ref = resolveLayerRef(sel);
    if (!ref) continue;
    let v;
    if (ref.kind === "existing") {
      const edit = getEdit(ref.page.path, ref.layer.id) ?? {};
      v = edit.syntheticItalic === true;
    } else {
      v = ref.newLayer.syntheticItalic === true;
    }
    if (common === undefined) common = v;
    else if (common !== v) return null;
  }
  return common ?? null;
}

// 文字色を選択中の全レイヤーに書き込む。
function commitFillField(color) {
  const normalized = normalizeFillChoice(color);
  const selections = getSelectedLayers();
  if (selections.length === 0) return;
  withHistoryTransient(() => {
    let mutated = false;
    for (const sel of selections) {
      const ref = resolveLayerRef(sel);
      if (!ref) continue;
      if (ref.kind === "existing") {
        setEdit(ref.page.path, ref.layer.id, { fillColor: normalized });
      } else {
        updateNewLayer(ref.newLayer.tempId, { fillColor: normalized });
      }
      mutated = true;
    }
    return mutated || false;
  });
  rebuildLayerList();
  refreshAllOverlays();
}

function computeCommonTextScale(selections, field) {
  let common;
  for (const sel of selections) {
    const ref = resolveLayerRef(sel);
    if (!ref) continue;
    let v;
    if (ref.kind === "existing") {
      const edit = getEdit(ref.page.path, ref.layer.id) ?? {};
      v = edit[field] ?? ref.layer[field] ?? 100;
    } else {
      v = ref.newLayer[field] ?? 100;
    }
    v = clampTextScalePercent(v) ?? 100;
    if (common === undefined) common = v;
    else if (common !== v) return null;
  }
  return common ?? 100;
}

function computeCommonTextSpacing(selections, field) {
  let common;
  for (const sel of selections) {
    const ref = resolveLayerRef(sel);
    if (!ref) continue;
    let v;
    if (ref.kind === "existing") {
      const edit = getEdit(ref.page.path, ref.layer.id) ?? {};
      v = edit[field] ?? ref.layer[field] ?? 0;
    } else {
      v = ref.newLayer[field] ?? 0;
    }
    v = clampTextSpacingMille(v) ?? 0;
    if (common === undefined) common = v;
    else if (common !== v) return null;
  }
  return common ?? 0;
}

function hasVisibleStroke(color, width) {
  return (color === "white" || color === "black") && Number(width) > 0;
}

function countStrokeBearingLayers(pages) {
  let count = 0;
  for (const page of pages) {
    for (const layer of page.textLayers ?? []) {
      const edit = getEdit(page.path, layer.id) ?? {};
      const color = edit.strokeColor ?? layer.strokeColor ?? "none";
      const width = edit.strokeWidthPx ?? layer.strokeWidthPx ?? 20;
      if (hasVisibleStroke(color, width)) count++;
    }
    for (const nl of getNewLayersForPsd(page.path)) {
      if (hasVisibleStroke(nl.strokeColor ?? "none", nl.strokeWidthPx ?? 20)) count++;
    }
  }
  return count;
}

function strokeSpecLabel(color, width) {
  if (color === "white") return `白フチ ${width}px`;
  if (color === "black") return `黒フチ ${width}px`;
  return "フチなし";
}

function getBulkStrokeWidth() {
  const input = strokeWidthInputEl();
  if (input && input.value !== "") {
    const n = Number(input.value);
    if (Number.isFinite(n)) return Math.max(0, Math.min(999, Math.round(n * 10) / 10));
  }
  const current = getStrokeWidthPx();
  if (Number.isFinite(current)) return current;
  const fallback = Number(getDefault("strokeWidthPx"));
  return Number.isFinite(fallback) ? Math.max(0, Math.min(999, Math.round(fallback * 10) / 10)) : 20;
}

function currentWidthForCommit() {
  const input = strokeWidthInputEl();
  // 混在表示（input が空）のときは null を返し、per-layer 保持モードにする。
  if (input && input.value === "") return null;
  return getStrokeWidthPx();
}

export function hasSelection() {
  return resolveSelection() != null;
}

function truncate(s, n) { return s && s.length > n ? s.slice(0, n) + "…" : s; }
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fileName(p) {
  if (!p) return "";
  const m = p.match(/[\\/]([^\\/]+)$/);
  return m ? m[1] : p;
}
