import {
  getEdit,
  getCurrentFont,
  getFillColor,
  getFonts,
  getNewLayersForPsd,
  getPages,
  getStrokeColor,
  getStrokeWidthPx,
  getTextSize,
  setEdit,
  updateNewLayer,
  withHistoryTransient,
} from "./state.js";
import { refreshAllOverlays } from "./canvas-tools.js";
import { rebuildLayerList } from "./text-editor.js";
import {
  hideModalAnimated,
  showModalAnimated,
  toast,
} from "./ui-feedback.js";

const MODAL_ID = "find-change-modal";

function $(id) { return document.getElementById(id); }

function cloneMap(map) {
  return map && typeof map === "object" ? { ...map } : {};
}

function normalizeSizePt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(1, Math.min(999, Math.round(n * 100) / 100));
}

function normalizeScalePercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(10, Math.min(400, Math.round(n)));
}

function normalizeSpacingMille(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(-1000, Math.min(1000, Math.round(n)));
}

function normalizeStrokeWidth(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(999, Math.round(n * 10) / 10));
}

function normalizeFillColor(value) {
  if (value === "default" || value === "black" || value === "white") return value;
  if (typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value)) {
    const hex = value.toLowerCase();
    if (hex === "#000000") return "black";
    if (hex === "#ffffff") return "white";
    return hex;
  }
  return "default";
}

function normalizeStrokeColor(value) {
  return value === "white" || value === "black" ? value : "none";
}

function readNumberInput(id, fallback) {
  const el = $(id);
  const value = el?.value;
  if (value !== "" && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

function readEnabled(id) {
  return $(id)?.checked === true;
}

function readDialogStyle() {
  const fillChoice = $("find-change-fill")?.value ?? "default";
  const fillColor = fillChoice === "custom"
    ? normalizeFillColor($("find-change-fill-custom")?.value)
    : normalizeFillColor(fillChoice);
  return {
    fillEnabled: readEnabled("find-change-fill-enabled"),
    fillColor,
    strokeEnabled: readEnabled("find-change-stroke-enabled"),
    strokeColor: normalizeStrokeColor($("find-change-stroke-color")?.value),
    strokeWidthPx: normalizeStrokeWidth($("find-change-stroke-width")?.value),
    horizontalScaleEnabled: readEnabled("find-change-horizontal-scale-enabled"),
    horizontalScale: normalizeScalePercent($("find-change-horizontal-scale")?.value),
    verticalScaleEnabled: readEnabled("find-change-vertical-scale-enabled"),
    verticalScale: normalizeScalePercent($("find-change-vertical-scale")?.value),
    kerningEnabled: readEnabled("find-change-kerning-enabled"),
    kerningMille: normalizeSpacingMille($("find-change-kerning")?.value),
    trackingEnabled: readEnabled("find-change-tracking-enabled"),
    trackingMille: normalizeSpacingMille($("find-change-tracking")?.value),
    boldEnabled: readEnabled("find-change-bold-enabled"),
    syntheticBold: $("find-change-bold")?.value === "true",
    italicEnabled: readEnabled("find-change-italic-enabled"),
    syntheticItalic: $("find-change-italic")?.value === "true",
  };
}

function findLiteralMatches(text, needle, caseSensitive) {
  if (!needle) return [];
  const source = caseSensitive ? text : text.toLocaleLowerCase();
  const query = caseSensitive ? needle : needle.toLocaleLowerCase();
  const matches = [];
  let cursor = 0;
  while (cursor <= source.length) {
    const index = source.indexOf(query, cursor);
    if (index < 0) break;
    matches.push({ start: index, end: index + needle.length });
    cursor = index + Math.max(needle.length, 1);
  }
  return matches;
}

function buildReplacedText(text, matches, replacement) {
  let out = "";
  let cursor = 0;
  const ranges = [];
  for (const match of matches) {
    out += text.slice(cursor, match.start);
    const start = out.length;
    out += replacement;
    const end = out.length;
    ranges.push({ start, end });
    cursor = match.end;
  }
  out += text.slice(cursor);
  return { text: out, ranges };
}

function mapIndexAfterReplace(index, matches, replacementLength) {
  let offset = 0;
  for (const match of matches) {
    if (index < match.start) break;
    if (index >= match.start && index < match.end) return null;
    offset += replacementLength - (match.end - match.start);
  }
  return index + offset;
}

function shiftCharMap(map, matches, replacementLength) {
  const out = {};
  for (const [key, value] of Object.entries(cloneMap(map))) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0) continue;
    const next = mapIndexAfterReplace(index, matches, replacementLength);
    if (next == null || next < 0) continue;
    out[String(next)] = value;
  }
  return out;
}

function rubyOverlapsMatch(start, end, matches) {
  return matches.some((match) => start < match.end && end > match.start);
}

function shiftRubyMap(map, matches, replacementLength) {
  const out = {};
  for (const [key, entry] of Object.entries(cloneMap(map))) {
    const start = Number(key);
    const end = Number(entry?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || !entry) continue;
    if (rubyOverlapsMatch(start, end, matches)) continue;
    const nextStart = mapIndexAfterReplace(start, matches, replacementLength);
    const nextEnd = mapIndexAfterReplace(end, matches, replacementLength);
    if (nextStart == null || nextEnd == null || nextEnd <= nextStart) continue;
    out[String(nextStart)] = { ...entry, end: nextEnd };
  }
  return out;
}

function applyStyleRanges(map, ranges, value) {
  const out = cloneMap(map);
  for (const range of ranges) {
    for (let i = range.start; i < range.end; i++) out[String(i)] = value;
  }
  return out;
}

function addIfDefined(changes, key, value) {
  if (value === null || value === undefined) return;
  if (typeof value === "number" && !Number.isFinite(value)) return;
  changes[key] = value;
}

function createModal() {
  const existing = $(MODAL_ID);
  if (existing) return existing;

  const modal = document.createElement("div");
  modal.id = MODAL_ID;
  modal.className = "find-change-modal";
  modal.hidden = true;
  modal.innerHTML = `
    <div class="find-change-card" role="dialog" aria-modal="true" aria-labelledby="find-change-title">
      <div class="find-change-header">
        <div id="find-change-title" class="find-change-title">検索置換 / 全変換</div>
      </div>
      <div class="find-change-body">
        <label class="find-change-field">
          <span>検索文字</span>
          <input id="find-change-query" class="find-change-input" type="text" autocomplete="off" spellcheck="false">
        </label>
        <label class="find-change-checkrow">
          <input id="find-change-case" type="checkbox">
          <span>大文字 / 小文字を区別</span>
        </label>
        <label class="find-change-checkrow">
          <input id="find-change-replace-enabled" type="checkbox" checked>
          <span>文字を置換</span>
        </label>
        <label class="find-change-field">
          <span>置換文字</span>
          <input id="find-change-replace" class="find-change-input" type="text" autocomplete="off" spellcheck="false">
        </label>
        <div class="find-change-grid">
          <label class="find-change-checkrow">
            <input id="find-change-size-enabled" type="checkbox">
            <span>文字サイズ</span>
          </label>
          <input id="find-change-size" class="find-change-input" type="number" min="1" max="999" step="0.5" value="24" data-enables="find-change-size-enabled">
        </div>
        <div class="find-change-grid">
          <label class="find-change-checkrow">
            <input id="find-change-font-enabled" type="checkbox">
            <span>フォント</span>
          </label>
          <select id="find-change-font" class="find-change-input" data-enables="find-change-font-enabled"></select>
        </div>
        <div class="find-change-style-panel">
          <div class="find-change-style-title">基本スタイル</div>
          <div class="find-change-grid">
            <label class="find-change-checkrow">
              <input id="find-change-fill-enabled" type="checkbox">
              <span>文字色</span>
            </label>
            <div class="find-change-inline">
              <select id="find-change-fill" class="find-change-input" data-enables="find-change-fill-enabled">
                <option value="default">そのまま</option>
                <option value="black">黒</option>
                <option value="white">白</option>
                <option value="#ff0000">赤</option>
                <option value="#0000ff">青</option>
                <option value="custom">カスタム</option>
              </select>
              <input id="find-change-fill-custom" class="find-change-color-input" type="color" value="#ff0000" data-enables="find-change-fill-enabled">
            </div>
          </div>
          <div class="find-change-grid">
            <label class="find-change-checkrow">
              <input id="find-change-stroke-enabled" type="checkbox">
              <span>フチ</span>
            </label>
            <div class="find-change-inline">
              <select id="find-change-stroke-color" class="find-change-input" data-enables="find-change-stroke-enabled">
                <option value="none">なし</option>
                <option value="white">白</option>
                <option value="black">黒</option>
              </select>
              <input id="find-change-stroke-width" class="find-change-input find-change-compact-input" type="number" min="0" max="999" step="0.5" value="20" data-enables="find-change-stroke-enabled">
              <span class="find-change-unit">px</span>
            </div>
          </div>
          <div class="find-change-style-title">文字詳細</div>
          <div class="find-change-grid">
            <label class="find-change-checkrow">
              <input id="find-change-horizontal-scale-enabled" type="checkbox">
              <span>長体</span>
            </label>
            <div class="find-change-inline">
              <input id="find-change-horizontal-scale" class="find-change-input find-change-compact-input" type="number" min="10" max="400" step="1" value="100" data-enables="find-change-horizontal-scale-enabled">
              <span class="find-change-unit">%</span>
            </div>
          </div>
          <div class="find-change-grid">
            <label class="find-change-checkrow">
              <input id="find-change-vertical-scale-enabled" type="checkbox">
              <span>平体</span>
            </label>
            <div class="find-change-inline">
              <input id="find-change-vertical-scale" class="find-change-input find-change-compact-input" type="number" min="10" max="400" step="1" value="100" data-enables="find-change-vertical-scale-enabled">
              <span class="find-change-unit">%</span>
            </div>
          </div>
          <div class="find-change-grid">
            <label class="find-change-checkrow">
              <input id="find-change-kerning-enabled" type="checkbox">
              <span>カーニング</span>
            </label>
            <input id="find-change-kerning" class="find-change-input" type="number" min="-1000" max="1000" step="10" value="0" data-enables="find-change-kerning-enabled">
          </div>
          <div class="find-change-grid">
            <label class="find-change-checkrow">
              <input id="find-change-tracking-enabled" type="checkbox">
              <span>トラッキング</span>
            </label>
            <input id="find-change-tracking" class="find-change-input" type="number" min="-1000" max="1000" step="10" value="0" data-enables="find-change-tracking-enabled">
          </div>
          <div class="find-change-grid">
            <label class="find-change-checkrow">
              <input id="find-change-bold-enabled" type="checkbox">
              <span>太字</span>
            </label>
            <select id="find-change-bold" class="find-change-input" data-enables="find-change-bold-enabled">
              <option value="true">太字にする</option>
              <option value="false">通常にする</option>
            </select>
          </div>
          <div class="find-change-grid">
            <label class="find-change-checkrow">
              <input id="find-change-italic-enabled" type="checkbox">
              <span>斜体</span>
            </label>
            <select id="find-change-italic" class="find-change-input" data-enables="find-change-italic-enabled">
              <option value="true">斜体にする</option>
              <option value="false">通常にする</option>
            </select>
          </div>
        </div>
        <div id="find-change-summary" class="find-change-summary">全PSDのテキストレイヤーを対象にします。</div>
      </div>
      <div class="find-change-footer">
        <button id="find-change-cancel" class="find-change-btn" type="button">キャンセル</button>
        <button id="find-change-apply" class="find-change-btn find-change-btn-primary" type="button">全変換</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  return modal;
}

function populateFontSelect() {
  const select = $("find-change-font");
  if (!select) return;
  const current = select.value;
  select.textContent = "";
  const fonts = [...getFonts()].sort((a, b) => {
    const an = (a.name || a.postScriptName || "").toLocaleLowerCase();
    const bn = (b.name || b.postScriptName || "").toLocaleLowerCase();
    return an.localeCompare(bn);
  });
  for (const font of fonts) {
    if (!font?.postScriptName) continue;
    const opt = document.createElement("option");
    opt.value = font.postScriptName;
    opt.textContent = font.name && font.name !== font.postScriptName
      ? `${font.name} (${font.postScriptName})`
      : font.postScriptName;
    select.appendChild(opt);
  }
  if (current && [...select.options].some((opt) => opt.value === current)) select.value = current;
}

function syncModalStyleDefaults() {
  const sizeInput = $("find-change-size");
  const currentSize = normalizeSizePt(getTextSize());
  if (sizeInput && Number.isFinite(currentSize)) sizeInput.value = String(currentSize);

  const select = $("find-change-font");
  const currentFont = getCurrentFont();
  if (select && currentFont && [...select.options].some((opt) => opt.value === currentFont)) {
    select.value = currentFont;
  }

  const fill = normalizeFillColor(getFillColor());
  const fillSelect = $("find-change-fill");
  const fillCustom = $("find-change-fill-custom");
  if (fillSelect) {
    const preset = ["default", "black", "white", "#ff0000", "#0000ff"].includes(fill);
    fillSelect.value = preset ? fill : "custom";
  }
  if (fillCustom && /^#[0-9a-f]{6}$/.test(fill)) fillCustom.value = fill;

  const strokeColor = normalizeStrokeColor(getStrokeColor());
  const strokeSelect = $("find-change-stroke-color");
  if (strokeSelect) strokeSelect.value = strokeColor;
  const strokeWidth = normalizeStrokeWidth(getStrokeWidthPx());
  const strokeWidthInput = $("find-change-stroke-width");
  if (strokeWidthInput && Number.isFinite(strokeWidth)) strokeWidthInput.value = String(strokeWidth);

  const setNumeric = (id, value) => {
    const input = $(id);
    if (input && Number.isFinite(value)) input.value = String(value);
  };
  setNumeric("find-change-horizontal-scale", normalizeScalePercent(readNumberInput("horizontal-scale-input", 100)));
  setNumeric("find-change-vertical-scale", normalizeScalePercent(readNumberInput("vertical-scale-input", 100)));
  setNumeric("find-change-kerning", normalizeSpacingMille(readNumberInput("kerning-input", 0)));
  setNumeric("find-change-tracking", normalizeSpacingMille(readNumberInput("tracking-input", 0)));

  const bold = document.querySelector(".bold-toggle-btn")?.getAttribute("aria-pressed") === "true";
  const italic = document.querySelector(".italic-toggle-btn")?.getAttribute("aria-pressed") === "true";
  const boldSelect = $("find-change-bold");
  const italicSelect = $("find-change-italic");
  if (boldSelect) boldSelect.value = bold ? "true" : "false";
  if (italicSelect) italicSelect.value = italic ? "true" : "false";
}

function readOptions() {
  const query = $("find-change-query")?.value ?? "";
  const replaceEnabled = $("find-change-replace-enabled")?.checked === true;
  const sizeEnabled = $("find-change-size-enabled")?.checked === true;
  const fontEnabled = $("find-change-font-enabled")?.checked === true;
  const sizePt = normalizeSizePt($("find-change-size")?.value);
  const fontPostScriptName = $("find-change-font")?.value ?? "";
  const dialogStyle = readDialogStyle();
  return {
    query,
    caseSensitive: $("find-change-case")?.checked === true,
    replaceEnabled,
    replacement: $("find-change-replace")?.value ?? "",
    sizeEnabled,
    sizePt,
    fontEnabled,
    fontPostScriptName,
    dialogStyle,
  };
}

function layerText(page, layer) {
  const edit = getEdit(page.path, layer.id) ?? {};
  return String(edit.contents ?? layer.text ?? "");
}

function transformLayer({
  text,
  matches,
  replaceEnabled,
  replacement,
  sizeEnabled,
  sizePt,
  fontEnabled,
  fontPostScriptName,
  dialogStyle,
  maps,
}) {
  const replacementLength = replacement.length;
  const replaced = replaceEnabled ? buildReplacedText(text, matches, replacement) : null;
  const nextText = replaced?.text ?? text;
  const styleRanges = replaced?.ranges ?? matches;
  const changedText = replaceEnabled && nextText !== text;

  let charSizes = replaceEnabled ? shiftCharMap(maps.charSizes, matches, replacementLength) : cloneMap(maps.charSizes);
  let charFonts = replaceEnabled ? shiftCharMap(maps.charFonts, matches, replacementLength) : cloneMap(maps.charFonts);
  let charBolds = replaceEnabled ? shiftCharMap(maps.charBolds, matches, replacementLength) : cloneMap(maps.charBolds);
  let charItalics = replaceEnabled ? shiftCharMap(maps.charItalics, matches, replacementLength) : cloneMap(maps.charItalics);
  const charRubies = replaceEnabled ? shiftRubyMap(maps.charRubies, matches, replacementLength) : cloneMap(maps.charRubies);
  let charHorizontalScales = replaceEnabled ? shiftCharMap(maps.charHorizontalScales, matches, replacementLength) : cloneMap(maps.charHorizontalScales);
  let charVerticalScales = replaceEnabled ? shiftCharMap(maps.charVerticalScales, matches, replacementLength) : cloneMap(maps.charVerticalScales);
  let charTrackings = replaceEnabled ? shiftCharMap(maps.charTrackings, matches, replacementLength) : cloneMap(maps.charTrackings);
  let charKernings = replaceEnabled ? shiftCharMap(maps.charKernings, matches, replacementLength) : cloneMap(maps.charKernings);
  const charTateChuYokos = replaceEnabled ? shiftCharMap(maps.charTateChuYokos, matches, replacementLength) : cloneMap(maps.charTateChuYokos);

  if (sizeEnabled) charSizes = applyStyleRanges(charSizes, styleRanges, sizePt);
  if (fontEnabled) charFonts = applyStyleRanges(charFonts, styleRanges, fontPostScriptName);

  const remapNeeded = changedText;
  const changes = {
    ...(changedText ? { contents: nextText } : {}),
    ...((remapNeeded || sizeEnabled) ? { charSizes } : {}),
    ...((remapNeeded || fontEnabled) ? { charFonts } : {}),
    ...(remapNeeded ? {
      charBolds,
      charItalics,
      charRubies,
      charHorizontalScales,
      charVerticalScales,
      charTrackings,
      charKernings,
      charTateChuYokos,
    } : {}),
  };

  if (dialogStyle) {
    if (dialogStyle.fillEnabled) {
      addIfDefined(changes, "fillColor", dialogStyle.fillColor);
    }
    if (dialogStyle.strokeEnabled) {
      addIfDefined(changes, "strokeColor", dialogStyle.strokeColor);
      addIfDefined(changes, "strokeWidthPx", dialogStyle.strokeWidthPx);
    }
    if (dialogStyle.horizontalScaleEnabled && Number.isFinite(dialogStyle.horizontalScale)) {
      addIfDefined(changes, "horizontalScale", dialogStyle.horizontalScale);
      charHorizontalScales = applyStyleRanges(charHorizontalScales, styleRanges, dialogStyle.horizontalScale);
      changes.charHorizontalScales = charHorizontalScales;
    }
    if (dialogStyle.verticalScaleEnabled && Number.isFinite(dialogStyle.verticalScale)) {
      addIfDefined(changes, "verticalScale", dialogStyle.verticalScale);
      charVerticalScales = applyStyleRanges(charVerticalScales, styleRanges, dialogStyle.verticalScale);
      changes.charVerticalScales = charVerticalScales;
    }
    if (dialogStyle.kerningEnabled && Number.isFinite(dialogStyle.kerningMille)) {
      addIfDefined(changes, "kerningMille", dialogStyle.kerningMille);
      charKernings = applyStyleRanges(charKernings, styleRanges, dialogStyle.kerningMille);
      changes.charKernings = charKernings;
    }
    if (dialogStyle.trackingEnabled && Number.isFinite(dialogStyle.trackingMille)) {
      addIfDefined(changes, "trackingMille", dialogStyle.trackingMille);
      charTrackings = applyStyleRanges(charTrackings, styleRanges, dialogStyle.trackingMille);
      changes.charTrackings = charTrackings;
    }
    if (dialogStyle.boldEnabled) {
      changes.syntheticBold = dialogStyle.syntheticBold === true;
      charBolds = applyStyleRanges(charBolds, styleRanges, dialogStyle.syntheticBold === true);
      changes.charBolds = charBolds;
    }
    if (dialogStyle.italicEnabled) {
      changes.syntheticItalic = dialogStyle.syntheticItalic === true;
      charItalics = applyStyleRanges(charItalics, styleRanges, dialogStyle.syntheticItalic === true);
      changes.charItalics = charItalics;
    }
  }

  return { changedText, nextText, changes };
}

function hasDialogStyleEdits(style) {
  return !!style && (
    style.fillEnabled
    || style.strokeEnabled
    || style.horizontalScaleEnabled
    || style.verticalScaleEnabled
    || style.kerningEnabled
    || style.trackingEnabled
    || style.boldEnabled
    || style.italicEnabled
  );
}

function applyFindChange(options) {
  if (!options.query) {
    toast("検索文字を入力してください", { kind: "info", duration: 2200 });
    return;
  }
  if (!options.replaceEnabled && !options.sizeEnabled && !options.fontEnabled && !hasDialogStyleEdits(options.dialogStyle)) {
    toast("置換、文字サイズ、フォント、文字詳細のいずれかを有効にしてください", { kind: "info", duration: 2600 });
    return;
  }
  if (options.sizeEnabled && options.sizePt == null) {
    toast("文字サイズを 1〜999 pt で指定してください", { kind: "warning", duration: 2600 });
    return;
  }
  if (options.fontEnabled && !options.fontPostScriptName) {
    toast("変換先フォントを選択してください", { kind: "warning", duration: 2600 });
    return;
  }
  const s = options.dialogStyle;
  if (s?.strokeEnabled && s.strokeWidthPx == null) {
    toast("フチ太さを 0〜999 px で指定してください", { kind: "warning", duration: 2600 });
    return;
  }
  if (s?.horizontalScaleEnabled && s.horizontalScale == null) {
    toast("長体を 10〜400% で指定してください", { kind: "warning", duration: 2600 });
    return;
  }
  if (s?.verticalScaleEnabled && s.verticalScale == null) {
    toast("平体を 10〜400% で指定してください", { kind: "warning", duration: 2600 });
    return;
  }
  if ((s?.kerningEnabled && s.kerningMille == null) || (s?.trackingEnabled && s.trackingMille == null)) {
    toast("字間を -1000〜1000 で指定してください", { kind: "warning", duration: 2600 });
    return;
  }

  let layerCount = 0;
  let matchCount = 0;
  const mutated = withHistoryTransient(() => {
    let any = false;
    for (const page of getPages()) {
      for (const layer of page.textLayers ?? []) {
        const text = layerText(page, layer);
        const matches = findLiteralMatches(text, options.query, options.caseSensitive);
        if (matches.length === 0) continue;
        const edit = getEdit(page.path, layer.id) ?? {};
        const result = transformLayer({
          ...options,
          text,
          matches,
          maps: {
            charSizes: edit.charSizes ?? layer.charSizes,
            charFonts: edit.charFonts ?? layer.charFonts,
            charBolds: edit.charBolds ?? layer.charBolds,
            charItalics: edit.charItalics ?? layer.charItalics,
            charRubies: edit.charRubies ?? layer.charRubies,
            charHorizontalScales: edit.charHorizontalScales ?? layer.charHorizontalScales,
            charVerticalScales: edit.charVerticalScales ?? layer.charVerticalScales,
            charTrackings: edit.charTrackings ?? layer.charTrackings,
            charKernings: edit.charKernings ?? layer.charKernings,
            charTateChuYokos: edit.charTateChuYokos ?? layer.charTateChuYokos,
          },
        });
        if (Object.keys(result.changes).length === 0) continue;
        setEdit(page.path, layer.id, result.changes);
        layerCount++;
        matchCount += matches.length;
        any = true;
      }

      for (const nl of getNewLayersForPsd(page.path)) {
        const text = String(nl.contents ?? "");
        const matches = findLiteralMatches(text, options.query, options.caseSensitive);
        if (matches.length === 0) continue;
        const result = transformLayer({
          ...options,
          text,
          matches,
          maps: {
            charSizes: nl.charSizes,
            charFonts: nl.charFonts,
            charBolds: nl.charBolds,
            charItalics: nl.charItalics,
            charRubies: nl.charRubies,
            charHorizontalScales: nl.charHorizontalScales,
            charVerticalScales: nl.charVerticalScales,
            charTrackings: nl.charTrackings,
            charKernings: nl.charKernings,
            charTateChuYokos: nl.charTateChuYokos,
          },
        });
        if (Object.keys(result.changes).length === 0) continue;
        if (options.sizeEnabled || options.fontEnabled) {
          result.changes.autoFontSwitched = false;
          result.changes.autoFontSwitchBucket = -1;
        }
        updateNewLayer(nl.tempId, result.changes);
        layerCount++;
        matchCount += matches.length;
        any = true;
      }
    }
    return any || false;
  });

  if (!mutated) {
    toast("一致するテキストが見つかりませんでした", { kind: "info", duration: 2400 });
    return;
  }

  rebuildLayerList();
  refreshAllOverlays();
  import("./txt-source.js").then((mod) => mod.renderTxtSourceViewer?.()).catch(() => {});
  closeModal();
  toast(`${layerCount} レイヤー / ${matchCount} 箇所を全変換しました`, { kind: "success", duration: 2600 });
}

function openModal() {
  const modal = createModal();
  populateFontSelect();
  syncModalStyleDefaults();
  showModalAnimated(modal);
  requestAnimationFrame(() => $("find-change-query")?.focus());
}

function closeModal() {
  hideModalAnimated($(MODAL_ID));
}

function bindModalEvents() {
  const modal = createModal();
  const replaceEnabled = $("find-change-replace-enabled");
  const sizeEnabled = $("find-change-size-enabled");
  const fontEnabled = $("find-change-font-enabled");
  const replaceInput = $("find-change-replace");
  const sizeInput = $("find-change-size");
  const fontSelect = $("find-change-font");
  const fillSelect = $("find-change-fill");
  const fillCustom = $("find-change-fill-custom");
  $("find-change-cancel")?.addEventListener("click", closeModal);
  $("find-change-apply")?.addEventListener("click", () => {
    applyFindChange(readOptions());
  });
  replaceInput?.addEventListener("input", () => { if (replaceEnabled) replaceEnabled.checked = true; });
  replaceInput?.addEventListener("focus", () => { if (replaceEnabled) replaceEnabled.checked = true; });
  sizeInput?.addEventListener("input", () => { if (sizeEnabled) sizeEnabled.checked = true; });
  fontSelect?.addEventListener("change", () => { if (fontEnabled) fontEnabled.checked = true; });
  fillCustom?.addEventListener("input", () => { if (fillSelect) fillSelect.value = "custom"; });
  fillCustom?.addEventListener("change", () => { if (fillSelect) fillSelect.value = "custom"; });
  modal.querySelectorAll("[data-enables]").forEach((control) => {
    const targetId = control.getAttribute("data-enables");
    const enable = () => {
      const checkbox = $(targetId);
      if (checkbox) checkbox.checked = true;
    };
    control.addEventListener("input", enable);
    control.addEventListener("change", enable);
  });
  modal.addEventListener("mousedown", (e) => {
    if (e.target === modal) closeModal();
  });
  modal.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeModal();
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      applyFindChange(readOptions());
    }
  });
}

export function bindFindChangeMode() {
  const btn = $("find-change-btn");
  if (!btn) return;
  bindModalEvents();
  btn.addEventListener("click", openModal);
}
