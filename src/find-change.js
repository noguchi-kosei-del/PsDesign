import {
  getEdit,
  getCurrentFont,
  getFillColor,
  getFontDisplayName,
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
import {
  createFontCombobox,
  normalizeFontSearchText,
  resolveFontFromInput as resolveComboboxFontFromInput,
} from "./font-combobox.js";

const MODAL_ID = "find-change-modal";
const lastReplacementBySearch = new Map();
let modalDefaultsSynced = false;
let fontCombo = null;
let sourceFontCombo = null;

function $(id) { return document.getElementById(id); }

function showFindChangeMessage(message, kind = "info") {
  const el = $("find-change-summary");
  if (!el) return;
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = false;
}

function clearFindChangeMessage() {
  const el = $("find-change-summary");
  if (!el) return;
  el.textContent = "";
  delete el.dataset.kind;
  el.hidden = true;
}

function searchMemoryKey(query, caseSensitive) {
  return `${caseSensitive ? "case" : "nocase"}\u0000${query}`;
}

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
    // 太字 / 斜体は相互排他チェックボックス（ON のときだけ true、OFF は変更しない）。
    // 旧仕様: 専用の「太字にする / 通常にする」select があり enable + value で制御。
    // 新仕様: チェックボックス自体が「太字にする」を表し、両方 ON にはできない。
    boldEnabled: readEnabled("find-change-bold"),
    syntheticBold: readEnabled("find-change-bold"),
    italicEnabled: readEnabled("find-change-italic"),
    syntheticItalic: readEnabled("find-change-italic"),
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

function shiftCharMap(map, matches, replacementLength, { preserveMatchedValues = false } = {}) {
  const source = cloneMap(map);
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0) continue;
    const next = mapIndexAfterReplace(index, matches, replacementLength);
    if (next == null || next < 0) continue;
    out[String(next)] = value;
  }
  if (preserveMatchedValues) {
    let offset = 0;
    for (const match of matches) {
      const sourceLength = Math.max(1, match.end - match.start);
      const targetStart = match.start + offset;
      for (let i = 0; i < replacementLength; i++) {
        const sourceIndex = match.start + Math.min(i, sourceLength - 1);
        const sourceKey = String(sourceIndex);
        if (Object.prototype.hasOwnProperty.call(source, sourceKey)) {
          out[String(targetStart + i)] = source[sourceKey];
        }
      }
      offset += replacementLength - (match.end - match.start);
    }
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
        <div id="find-change-title" class="find-change-title">検索・置換 / 文字変換 / フォント変換</div>
      </div>
      <div class="find-change-tabs" role="tablist">
        <button id="find-change-tab-replace" class="find-change-tab active" data-tab="replace" type="button" role="tab" aria-selected="true">検索・置換</button>
        <button id="find-change-tab-convert" class="find-change-tab" data-tab="convert" type="button" role="tab" aria-selected="false">文字変換</button>
        <button id="find-change-tab-font" class="find-change-tab" data-tab="font" type="button" role="tab" aria-selected="false">フォント変換</button>
      </div>
      <div class="find-change-body">
        <!-- 共有: 検索文字 + 大文字/小文字区別 -->
        <label id="find-change-query-field" class="find-change-field">
          <span>検索文字</span>
          <input id="find-change-query" class="find-change-input" type="text" autocomplete="off" spellcheck="false">
        </label>
        <label id="find-change-case-row" class="find-change-checkrow">
          <input id="find-change-case" type="checkbox">
          <span>大文字 / 小文字を区別</span>
        </label>
        <!-- 検索置換タブ専用 -->
        <div class="find-change-tab-panel" data-tab-panel="replace">
          <label class="find-change-checkrow">
            <input id="find-change-replace-enabled" type="checkbox" checked>
            <span>文字を置換</span>
          </label>
          <label class="find-change-field">
            <span>置換文字</span>
            <input id="find-change-replace" class="find-change-input" type="text" autocomplete="off" spellcheck="false">
          </label>
        </div>
        <!-- 文字変換 / フォント変換タブ専用 -->
        <div class="find-change-tab-panel" data-tab-panel="convert" hidden>
          <div id="find-change-source-font-row" class="find-change-grid" hidden>
            <label class="find-change-checkrow">
              <input id="find-change-source-font-enabled" type="checkbox">
              <span>変換元フォントを指定</span>
            </label>
            <div id="find-change-source-font-combobox" class="font-combobox find-change-font-combobox">
              <input id="find-change-source-font" type="hidden">
              <input id="find-change-source-font-search" class="find-change-input font-input" type="text" autocomplete="off" spellcheck="false" data-enables="find-change-source-font-enabled">
              <button id="find-change-source-font-toggle" class="font-combobox-toggle" type="button" aria-label="フォント一覧" title="フォント一覧">▼</button>
              <ul id="find-change-source-font-list" class="font-combobox-list find-change-font-list" role="listbox" hidden></ul>
            </div>
          </div>
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
            <div id="find-change-font-combobox" class="font-combobox find-change-font-combobox">
              <input id="find-change-font" type="hidden">
              <input id="find-change-font-search" class="find-change-input font-input" type="text" autocomplete="off" spellcheck="false" data-enables="find-change-font-enabled">
              <button id="find-change-font-toggle" class="font-combobox-toggle" type="button" aria-label="フォント一覧" title="フォント一覧">▼</button>
              <ul id="find-change-font-list" class="font-combobox-list find-change-font-list" role="listbox" hidden></ul>
            </div>
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
            <!-- 太字 / 斜体: 相互排他のチェックボックス（ON 一方のみ） -->
            <label class="find-change-checkrow">
              <input id="find-change-bold" type="checkbox">
              <span>太字にする</span>
            </label>
            <label class="find-change-checkrow">
              <input id="find-change-italic" type="checkbox">
              <span>斜体にする</span>
            </label>
          </div>
        </div>
        <div id="find-change-summary" class="find-change-summary" role="status" aria-live="polite" hidden></div>
      </div>
      <div class="find-change-footer">
        <button id="find-change-cancel" class="find-change-btn" type="button">キャンセル</button>
        <button id="find-change-apply" class="find-change-btn find-change-btn-primary" type="button">置換</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  return modal;
}

function sortedFonts() {
  return [...getFonts()].sort((a, b) => {
    const an = (a.name || a.postScriptName || "").toLocaleLowerCase();
    const bn = (b.name || b.postScriptName || "").toLocaleLowerCase();
    return an.localeCompare(bn);
  });
}

function getFontCombo() {
  const input = $("find-change-font-search");
  const list = $("find-change-font-list");
  const combo = $("find-change-font-combobox");
  if (!input || !list || !combo) return null;
  if (fontCombo) return fontCombo;
  fontCombo = createFontCombobox({
    input,
    list,
    combo,
    getFonts: sortedFonts,
    getCurrentPostScriptName: () => $("find-change-font")?.value ?? "",
    onOpen: () => closeSourceFontCombo(),
    onCommit: (font) => setFindChangeFont(font, { enable: true }),
    positionMode: "fixed",
    appendToBody: true,
    blurOnCommit: true,
  });
  return fontCombo;
}

function getSourceFontCombo() {
  const input = $("find-change-source-font-search");
  const list = $("find-change-source-font-list");
  const combo = $("find-change-source-font-combobox");
  if (!input || !list || !combo) return null;
  if (sourceFontCombo) return sourceFontCombo;
  sourceFontCombo = createFontCombobox({
    input,
    list,
    combo,
    getFonts: sortedFonts,
    getCurrentPostScriptName: () => $("find-change-source-font")?.value ?? "",
    onOpen: () => closeFontCombo(),
    onCommit: (font) => setFindChangeSourceFont(font, { enable: getFindChangeActiveTab() === "convert" }),
    positionMode: "fixed",
    appendToBody: true,
    blurOnCommit: true,
  });
  return sourceFontCombo;
}

function populateFontSelect() {
  const current = $("find-change-font")?.value ?? "";
  getFontCombo()?.rebuild();
  if (current) syncFindChangeFontDisplay();
}

function populateSourceFontSelect() {
  const typed = $("find-change-source-font-search")?.value ?? "";
  const current = $("find-change-source-font")?.value || (!typed ? getCurrentFont() || "" : "");
  getSourceFontCombo()?.rebuild();
  if (current) setFindChangeSourceFont(current);
}

function fontDisplayName(font) {
  return font?.name || font?.postScriptName || "";
}

function findFontByPostScriptName(ps) {
  if (!ps) return null;
  return getFonts().find((font) => font.postScriptName === ps) ?? null;
}

function resolveFindChangeFontFromInput(value) {
  return resolveComboboxFontFromInput(getFonts(), value);
}

function normalizeFontIdentity(value) {
  return normalizeFontSearchText(value).replace(/\s+/g, "");
}

function addFontIdentityKey(keys, value) {
  const key = normalizeFontIdentity(value);
  if (key) keys.add(key);
}

function addFontAliases(keys, font) {
  if (!font) return;
  addFontIdentityKey(keys, font.postScriptName);
  addFontIdentityKey(keys, font.name);
  addFontIdentityKey(keys, font.label);
  addFontIdentityKey(keys, getFontDisplayName(font.postScriptName));
  for (const alias of Array.isArray(font.aliases) ? font.aliases : []) {
    addFontIdentityKey(keys, alias);
  }
}

function fontIdentityKeys(value) {
  const keys = new Set();
  const raw = String(value ?? "").trim();
  if (!raw) return keys;
  addFontIdentityKey(keys, raw);
  addFontIdentityKey(keys, getFontDisplayName(raw));
  addFontAliases(keys, findFontByPostScriptName(raw));
  addFontAliases(keys, resolveFindChangeFontFromInput(raw));
  return keys;
}

function fontMatchesIdentity(value, targetKeys) {
  if (!value || !(targetKeys?.size > 0)) return false;
  for (const key of fontIdentityKeys(value)) {
    if (targetKeys.has(key)) return true;
  }
  return false;
}

function fontValuesEquivalent(a, b) {
  const aKeys = fontIdentityKeys(a);
  if (!(aKeys.size > 0)) return false;
  return fontMatchesIdentity(b, aKeys);
}

function setFindChangeFont(fontOrPs, { enable = false } = {}) {
  const hidden = $("find-change-font");
  const input = $("find-change-font-search");
  if (!hidden || !input) return;
  const font = typeof fontOrPs === "string"
    ? findFontByPostScriptName(fontOrPs) ?? { postScriptName: fontOrPs, name: fontOrPs }
    : fontOrPs;
  hidden.value = font?.postScriptName ?? "";
  input.value = fontDisplayName(font);
  input.dataset.ps = hidden.value;
  if (enable) {
    const checkbox = $("find-change-font-enabled");
    if (checkbox) checkbox.checked = true;
  }
}

function syncFindChangeFontDisplay() {
  const hidden = $("find-change-font");
  if (!hidden?.value) return;
  setFindChangeFont(hidden.value);
}

function setFindChangeSourceFont(fontOrPs, { enable = false } = {}) {
  const hidden = $("find-change-source-font");
  const input = $("find-change-source-font-search");
  if (!hidden || !input) return;
  const font = typeof fontOrPs === "string"
    ? findFontByPostScriptName(fontOrPs) ?? { postScriptName: fontOrPs, name: fontOrPs }
    : fontOrPs;
  hidden.value = font?.postScriptName ?? "";
  input.value = fontDisplayName(font);
  input.dataset.ps = hidden.value;
  if (enable) {
    const checkbox = $("find-change-source-font-enabled");
    if (checkbox) checkbox.checked = true;
  }
  syncSourceFontControls();
}

function syncFindChangeSourceFontDisplay() {
  const hidden = $("find-change-source-font");
  if (!hidden?.value) return;
  setFindChangeSourceFont(hidden.value);
}

function filterFontCombo(query) {
  getFontCombo()?.filter(query);
}

function positionFontCombo() {
  getFontCombo()?.position();
}

function openFontCombo(showAll = false) {
  getFontCombo()?.open({ showAll, rebuild: true });
}

function closeFontCombo() {
  getFontCombo()?.close();
}

function moveFontComboHighlight(delta) {
  getFontCombo()?.moveHighlight(delta, { showAll: true });
}

function filterSourceFontCombo(query) {
  getSourceFontCombo()?.filter(query);
}

function positionSourceFontCombo() {
  getSourceFontCombo()?.position();
}

function openSourceFontCombo(showAll = false) {
  getSourceFontCombo()?.open({ showAll, rebuild: true });
}

function closeSourceFontCombo() {
  getSourceFontCombo()?.close();
}

function moveSourceFontComboHighlight(delta) {
  getSourceFontCombo()?.moveHighlight(delta, { showAll: true });
}

function syncModalStyleDefaults() {
  const sizeInput = $("find-change-size");
  const currentSize = normalizeSizePt(getTextSize());
  if (sizeInput && Number.isFinite(currentSize)) sizeInput.value = String(currentSize);

  const currentFont = getCurrentFont();
  if (currentFont) setFindChangeFont(currentFont);
  if (currentFont) setFindChangeSourceFont(currentFont);

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
  if (boldSelect) boldSelect.checked = bold;
  if (italicSelect) italicSelect.checked = italic;
}

function readOptions() {
  const query = $("find-change-query")?.value ?? "";
  // 検索置換タブのとき: replace 関連のみ動作、文字変換項目 (size/font/style) は無視。
  // 文字変換/フォント変換タブのとき: replace を無効化、それ以外をスタイル変換として送る。
  const activeTab = getFindChangeActiveTab();
  const replaceEnabled = activeTab === "replace"
    && $("find-change-replace-enabled")?.checked === true;
  const styleAllowed = activeTab === "convert" || activeTab === "font";
  const sourceFontEnabled = activeTab === "font"
    || (activeTab === "convert" && $("find-change-source-font-enabled")?.checked === true);
  const sizeEnabled = styleAllowed && $("find-change-size-enabled")?.checked === true;
  const fontEnabled = styleAllowed && (
    activeTab === "font"
    || $("find-change-font-enabled")?.checked === true
  );
  const sizePt = normalizeSizePt($("find-change-size")?.value);
  const sourceFontPostScriptName = $("find-change-source-font")?.value
    || resolveFindChangeFontFromInput($("find-change-source-font-search")?.value)?.postScriptName
    || "";
  const fontPostScriptName = $("find-change-font")?.value
    || resolveFindChangeFontFromInput($("find-change-font-search")?.value)?.postScriptName
    || "";
  const dialogStyle = styleAllowed
    ? readDialogStyle()
    : Object.fromEntries(Object.entries(readDialogStyle()).map(([k, v]) =>
        k.endsWith("Enabled") ? [k, false] : [k, v]));
  return {
    activeTab,
    query,
    caseSensitive: $("find-change-case")?.checked === true,
    replaceEnabled,
    replacement: $("find-change-replace")?.value ?? "",
    sourceFontEnabled,
    sourceFontPostScriptName: sourceFontEnabled ? sourceFontPostScriptName : "",
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

function countMatchesAcrossLayers(needle, caseSensitive) {
  if (!needle) return 0;
  let count = 0;
  for (const page of getPages()) {
    for (const layer of page.textLayers ?? []) {
      count += findLiteralMatches(layerText(page, layer), needle, caseSensitive).length;
    }
    for (const nl of getNewLayersForPsd(page.path)) {
      count += findLiteralMatches(String(nl.contents ?? ""), needle, caseSensitive).length;
    }
  }
  return count;
}

function wholeTextRange(text) {
  return [{ start: 0, end: String(text ?? "").length }];
}

function rangesCoverWholeText(ranges, text) {
  const len = String(text ?? "").length;
  if (!Array.isArray(ranges) || ranges.length === 0) return false;
  if (len === 0) return ranges.some((r) => r.start === 0 && r.end === 0);
  let cursor = 0;
  for (const range of [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const start = Math.max(0, Math.min(len, Number(range.start)));
    const end = Math.max(0, Math.min(len, Number(range.end)));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    if (start > cursor) return false;
    cursor = Math.max(cursor, end);
    if (cursor >= len) return true;
  }
  return cursor >= len;
}

function findFontStyleRanges(text, charFonts, defaultFont, sourceFont) {
  if (!sourceFont) return [];
  const len = String(text ?? "").length;
  const fonts = charFonts && typeof charFonts === "object" ? charFonts : {};
  const sourceKeys = fontIdentityKeys(sourceFont);
  if (sourceKeys.size === 0) return [];
  const ranges = [];
  let start = null;
  for (let i = 0; i < len; i++) {
    const font = fonts[String(i)] ?? defaultFont ?? "";
    if (fontMatchesIdentity(font, sourceKeys)) {
      if (start == null) start = i;
    } else if (start != null) {
      ranges.push({ start, end: i });
      start = null;
    }
  }
  if (start != null) ranges.push({ start, end: len });
  return ranges;
}

function intersectRanges(a, b) {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i].start, b[j].start);
    const end = Math.min(a[i].end, b[j].end);
    if (start < end) out.push({ start, end });
    if (a[i].end < b[j].end) i++;
    else j++;
  }
  return out;
}

function findConvertRanges(text, baseRanges, charFonts, defaultFont, options) {
  if (!options.sourceFontEnabled) return baseRanges;
  const fontRanges = findFontStyleRanges(text, charFonts, defaultFont, options.sourceFontPostScriptName);
  return intersectRanges(baseRanges, fontRanges);
}

function findFallbackNeedle(options) {
  const candidates = [];
  const remembered = lastReplacementBySearch.get(searchMemoryKey(options.query, options.caseSensitive));
  if (remembered && remembered !== options.query) candidates.push(remembered);
  if (options.replacement && options.replacement !== options.query) candidates.push(options.replacement);

  const seen = new Set();
  for (const needle of candidates) {
    if (seen.has(needle)) continue;
    seen.add(needle);
    const count = countMatchesAcrossLayers(needle, options.caseSensitive);
    if (count > 0) return { needle, count };
  }
  return null;
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
  const wholeLayerStyle = rangesCoverWholeText(styleRanges, nextText);

  const preserveReplacementStyle = { preserveMatchedValues: true };
  let charSizes = replaceEnabled ? shiftCharMap(maps.charSizes, matches, replacementLength, preserveReplacementStyle) : cloneMap(maps.charSizes);
  let charFonts = replaceEnabled ? shiftCharMap(maps.charFonts, matches, replacementLength, preserveReplacementStyle) : cloneMap(maps.charFonts);
  let charBolds = replaceEnabled ? shiftCharMap(maps.charBolds, matches, replacementLength, preserveReplacementStyle) : cloneMap(maps.charBolds);
  let charItalics = replaceEnabled ? shiftCharMap(maps.charItalics, matches, replacementLength, preserveReplacementStyle) : cloneMap(maps.charItalics);
  const charRubies = replaceEnabled ? shiftRubyMap(maps.charRubies, matches, replacementLength) : cloneMap(maps.charRubies);
  let charHorizontalScales = replaceEnabled ? shiftCharMap(maps.charHorizontalScales, matches, replacementLength, preserveReplacementStyle) : cloneMap(maps.charHorizontalScales);
  let charVerticalScales = replaceEnabled ? shiftCharMap(maps.charVerticalScales, matches, replacementLength, preserveReplacementStyle) : cloneMap(maps.charVerticalScales);
  let charTrackings = replaceEnabled ? shiftCharMap(maps.charTrackings, matches, replacementLength, preserveReplacementStyle) : cloneMap(maps.charTrackings);
  let charKernings = replaceEnabled ? shiftCharMap(maps.charKernings, matches, replacementLength, preserveReplacementStyle) : cloneMap(maps.charKernings);
  const charTateChuYokos = replaceEnabled ? shiftCharMap(maps.charTateChuYokos, matches, replacementLength, preserveReplacementStyle) : cloneMap(maps.charTateChuYokos);
  let charFillColors = replaceEnabled ? shiftCharMap(maps.charFillColors, matches, replacementLength, preserveReplacementStyle) : cloneMap(maps.charFillColors);

  if (sizeEnabled) charSizes = applyStyleRanges(charSizes, styleRanges, sizePt);
  if (fontEnabled) charFonts = applyStyleRanges(charFonts, styleRanges, fontPostScriptName);

  const remapNeeded = changedText;
  const changes = {
    ...(changedText ? { contents: nextText } : {}),
    ...((sizeEnabled && wholeLayerStyle) ? { sizePt } : {}),
    ...((fontEnabled && wholeLayerStyle) ? { fontPostScriptName } : {}),
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
      charFillColors,
    } : {}),
  };

  if (dialogStyle) {
    if (dialogStyle.fillEnabled && dialogStyle.fillColor !== "default") {
      charFillColors = applyStyleRanges(charFillColors, styleRanges, dialogStyle.fillColor);
      changes.charFillColors = charFillColors;
    }
    if (dialogStyle.strokeEnabled) {
      changes.strokeColor = dialogStyle.strokeColor;
      changes.strokeWidthPx = dialogStyle.strokeWidthPx;
    }
    if (dialogStyle.horizontalScaleEnabled && Number.isFinite(dialogStyle.horizontalScale)) {
      charHorizontalScales = applyStyleRanges(charHorizontalScales, styleRanges, dialogStyle.horizontalScale);
      changes.charHorizontalScales = charHorizontalScales;
    }
    if (dialogStyle.verticalScaleEnabled && Number.isFinite(dialogStyle.verticalScale)) {
      charVerticalScales = applyStyleRanges(charVerticalScales, styleRanges, dialogStyle.verticalScale);
      changes.charVerticalScales = charVerticalScales;
    }
    if (dialogStyle.kerningEnabled && Number.isFinite(dialogStyle.kerningMille)) {
      charKernings = applyStyleRanges(charKernings, styleRanges, dialogStyle.kerningMille);
      changes.charKernings = charKernings;
    }
    if (dialogStyle.trackingEnabled && Number.isFinite(dialogStyle.trackingMille)) {
      charTrackings = applyStyleRanges(charTrackings, styleRanges, dialogStyle.trackingMille);
      changes.charTrackings = charTrackings;
    }
    if (dialogStyle.boldEnabled) {
      charBolds = applyStyleRanges(charBolds, styleRanges, dialogStyle.syntheticBold === true);
      changes.charBolds = charBolds;
    }
    if (dialogStyle.italicEnabled) {
      charItalics = applyStyleRanges(charItalics, styleRanges, dialogStyle.syntheticItalic === true);
      changes.charItalics = charItalics;
    }
  }

  return { changedText, nextText, changes };
}

function hasDialogStyleEdits(style) {
  return !!style && (
    (style.fillEnabled && style.fillColor !== "default")
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
  clearFindChangeMessage();
  const applyWholeLayer = options.activeTab === "convert" && !options.query;
  const applyByFont = options.activeTab === "font";
  if (!options.query && !applyWholeLayer && !applyByFont) {
    showFindChangeMessage("検索文字を入力してください。", "info");
    return;
  }
  if (!options.replaceEnabled && !options.sizeEnabled && !options.fontEnabled && !hasDialogStyleEdits(options.dialogStyle)) {
    showFindChangeMessage("置換、文字サイズ、フォント、文字詳細のいずれかを有効にしてください。", "info");
    return;
  }
  if (options.sizeEnabled && options.sizePt == null) {
    showFindChangeMessage("文字サイズを 1〜999 pt で指定してください。", "warning");
    return;
  }
  if (options.fontEnabled && !options.fontPostScriptName) {
    showFindChangeMessage("変換先フォントを選択してください。", "warning");
    return;
  }
  if ((applyByFont || options.sourceFontEnabled) && !options.sourceFontPostScriptName) {
    showFindChangeMessage("変換元フォントを選択してください。", "warning");
    return;
  }
  if (
    options.fontEnabled
    && options.sourceFontEnabled
    && fontValuesEquivalent(options.fontPostScriptName, options.sourceFontPostScriptName)
    && !options.sizeEnabled
    && !hasDialogStyleEdits(options.dialogStyle)
  ) {
    showFindChangeMessage("変換元と変換先が同じフォントです。変換先フォントを変更してください。", "info");
    return;
  }
  const s = options.dialogStyle;
  if (s?.strokeEnabled && s.strokeWidthPx == null) {
    showFindChangeMessage("フチ太さを 0〜999 px で指定してください。", "warning");
    return;
  }
  if (s?.horizontalScaleEnabled && s.horizontalScale == null) {
    showFindChangeMessage("長体を 10〜400% で指定してください。", "warning");
    return;
  }
  if (s?.verticalScaleEnabled && s.verticalScale == null) {
    showFindChangeMessage("平体を 10〜400% で指定してください。", "warning");
    return;
  }
  if ((s?.kerningEnabled && s.kerningMille == null) || (s?.trackingEnabled && s.trackingMille == null)) {
    showFindChangeMessage("字間を -1000〜1000 で指定してください。", "warning");
    return;
  }

  const queryMatchCount = applyWholeLayer || applyByFont ? 1 : countMatchesAcrossLayers(options.query, options.caseSensitive);
  const fallback = !applyWholeLayer && !applyByFont && queryMatchCount === 0 ? findFallbackNeedle(options) : null;
  const activeQuery = fallback?.needle ?? options.query;
  const shouldReplaceFallback = !!fallback
    && options.replaceEnabled
    && options.replacement
    && options.replacement !== activeQuery;
  const transformOptions = fallback && !shouldReplaceFallback
    ? { ...options, replaceEnabled: false }
    : options;

  let layerCount = 0;
  let matchCount = 0;
  const mutated = withHistoryTransient(() => {
    let any = false;
    for (const page of getPages()) {
      for (const layer of page.textLayers ?? []) {
        const text = layerText(page, layer);
        const edit = getEdit(page.path, layer.id) ?? {};
        const maps = {
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
          charFillColors: edit.charFillColors ?? layer.charFillColors,
        };
        const defaultFont = edit.fontPostScriptName ?? layer.font ?? "";
        const baseMatches = applyWholeLayer ? wholeTextRange(text) : findLiteralMatches(text, activeQuery, options.caseSensitive);
        const matches = applyByFont
          ? findFontStyleRanges(text, maps.charFonts, defaultFont, options.sourceFontPostScriptName)
          : findConvertRanges(text, baseMatches, maps.charFonts, defaultFont, options);
        if (matches.length === 0) continue;
        const result = transformLayer({
          ...transformOptions,
          text,
          matches,
          maps,
        });
        if (Object.keys(result.changes).length === 0) continue;
        setEdit(page.path, layer.id, result.changes);
        layerCount++;
        matchCount += applyWholeLayer ? 1 : matches.length;
        any = true;
      }

      for (const nl of getNewLayersForPsd(page.path)) {
        const text = String(nl.contents ?? "");
        const maps = {
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
          charFillColors: nl.charFillColors,
        };
        const defaultFont = nl.fontPostScriptName ?? "";
        const baseMatches = applyWholeLayer ? wholeTextRange(text) : findLiteralMatches(text, activeQuery, options.caseSensitive);
        const matches = applyByFont
          ? findFontStyleRanges(text, maps.charFonts, defaultFont, options.sourceFontPostScriptName)
          : findConvertRanges(text, baseMatches, maps.charFonts, defaultFont, options);
        if (matches.length === 0) continue;
        const result = transformLayer({
          ...transformOptions,
          text,
          matches,
          maps,
        });
        if (Object.keys(result.changes).length === 0) continue;
        if (options.sizeEnabled || options.fontEnabled) {
          result.changes.autoFontSwitched = false;
          result.changes.autoFontSwitchBucket = -1;
        }
        updateNewLayer(nl.tempId, result.changes);
        layerCount++;
        matchCount += applyWholeLayer ? 1 : matches.length;
        any = true;
      }
    }
    return any || false;
  });

  if (!mutated) {
    showFindChangeMessage(
      applyByFont
        ? "一致するフォントのテキストが見つかりませんでした。"
        : "一致するテキストが見つかりませんでした。",
      "info",
    );
    return;
  }

  rebuildLayerList();
  refreshAllOverlays();
  import("./txt-source.js").then((mod) => mod.renderTxtSourceViewer?.()).catch(() => {});
  if (options.replaceEnabled && options.replacement && options.replacement !== options.query) {
    lastReplacementBySearch.set(searchMemoryKey(options.query, options.caseSensitive), options.replacement);
  }
  closeModal();
  const actionLabel = options.activeTab === "replace" ? "置換" : options.activeTab === "font" ? "フォント変換" : "文字変換";
  toast(`${layerCount} レイヤー / ${matchCount} 箇所を${actionLabel}しました`, { kind: "success", duration: 2600 });
}

function openModal() {
  const modal = createModal();
  clearFindChangeMessage();
  populateFontSelect();
  populateSourceFontSelect();
  if (!modalDefaultsSynced) {
    syncModalStyleDefaults();
    modalDefaultsSynced = true;
  } else {
    syncFindChangeFontDisplay();
    syncFindChangeSourceFontDisplay();
  }
  showModalAnimated(modal);
  requestAnimationFrame(() => $("find-change-query")?.focus());
}

function closeModal() {
  closeFontCombo();
  closeSourceFontCombo();
  hideModalAnimated($(MODAL_ID));
}

function getFindChangeActiveTab() {
  if ($("find-change-tab-font")?.classList.contains("active")) return "font";
  return $("find-change-tab-replace")?.classList.contains("active") ? "replace" : "convert";
}

function syncSourceFontControls(activeTab = getFindChangeActiveTab()) {
  const sourceFontRow = $("find-change-source-font-row");
  const sourceFontEnabled = $("find-change-source-font-enabled");
  const sourceFontInput = $("find-change-source-font-search");
  const sourceFontToggle = $("find-change-source-font-toggle");
  if (sourceFontRow) sourceFontRow.hidden = activeTab === "replace";
  if (sourceFontEnabled) {
    if (activeTab === "font") sourceFontEnabled.checked = true;
    sourceFontEnabled.disabled = activeTab === "font";
  }
  const disabled = activeTab === "replace"
    || (activeTab === "convert" && sourceFontEnabled?.checked !== true);
  if (sourceFontInput) sourceFontInput.disabled = disabled;
  if (sourceFontToggle) sourceFontToggle.disabled = disabled;
  if (disabled) closeSourceFontCombo();
  else if (getSourceFontCombo()?.isOpen()) positionSourceFontCombo();
}

function syncTargetFontControls(activeTab = getFindChangeActiveTab()) {
  const targetFontEnabled = $("find-change-font-enabled");
  if (!targetFontEnabled) return;
  if (activeTab === "font") targetFontEnabled.checked = true;
  targetFontEnabled.disabled = activeTab === "font";
}

function commitSourceFontInput({ blur = true } = {}) {
  const input = $("find-change-source-font-search");
  if (!input) return;
  getSourceFontCombo()?.commit({ fallbackValue: input.value, blur });
  if (blur) input.blur();
}

function enableSourceFontSearchFromInput() {
  const sourceFontEnabled = $("find-change-source-font-enabled");
  if (getFindChangeActiveTab() === "convert" && sourceFontEnabled) {
    sourceFontEnabled.checked = true;
  }
  syncSourceFontControls();
}

function setFindChangeActiveTab(tab) {
  const replaceTab = $("find-change-tab-replace");
  const convertTab = $("find-change-tab-convert");
  const fontTab = $("find-change-tab-font");
  if (!replaceTab || !convertTab || !fontTab) return;
  const active = tab === "font" ? "font" : tab === "convert" ? "convert" : "replace";
  replaceTab.classList.toggle("active", active === "replace");
  convertTab.classList.toggle("active", active === "convert");
  fontTab.classList.toggle("active", active === "font");
  replaceTab.setAttribute("aria-selected", active === "replace" ? "true" : "false");
  convertTab.setAttribute("aria-selected", active === "convert" ? "true" : "false");
  fontTab.setAttribute("aria-selected", active === "font" ? "true" : "false");
  // パネル切替
  document.querySelectorAll(".find-change-tab-panel").forEach((p) => {
    const panel = p.getAttribute("data-tab-panel");
    p.hidden = active === "font" ? panel !== "convert" : panel !== active;
  });
  clearFindChangeMessage();
  syncSourceFontControls(active);
  syncTargetFontControls(active);
  const queryField = $("find-change-query-field");
  const caseRow = $("find-change-case-row");
  if (queryField) {
    queryField.hidden = active === "font";
    queryField.style.display = active === "font" ? "none" : "";
  }
  if (caseRow) {
    caseRow.hidden = active === "font";
    caseRow.style.display = active === "font" ? "none" : "";
  }
  // 適用ボタンのラベル切替
  const applyBtn = $("find-change-apply");
  if (applyBtn) applyBtn.textContent = active === "replace" ? "置換" : active === "font" ? "フォント変換" : "文字変換";
}

function runFindChangeFromModal() {
  try {
    applyFindChange(readOptions());
  } catch (error) {
    console.error("[find-change] apply failed", error);
    showFindChangeMessage("変換中にエラーが発生しました。入力内容を確認してください。", "warning");
  }
}

function bindModalEvents() {
  const modal = createModal();
  const replaceEnabled = $("find-change-replace-enabled");
  const sourceFontEnabled = $("find-change-source-font-enabled");
  const sourceFontInput = $("find-change-source-font-search");
  const sourceFontToggle = $("find-change-source-font-toggle");
  const sizeEnabled = $("find-change-size-enabled");
  const fontEnabled = $("find-change-font-enabled");
  const replaceInput = $("find-change-replace");
  const sizeInput = $("find-change-size");
  const fontInput = $("find-change-font-search");
  const fontToggle = $("find-change-font-toggle");
  const fillSelect = $("find-change-fill");
  const fillCustom = $("find-change-fill-custom");
  const strokeEnabled = $("find-change-stroke-enabled");
  const strokeSelect = $("find-change-stroke-color");
  const strokeWidthInput = $("find-change-stroke-width");
  const boldCheckbox = $("find-change-bold");
  const italicCheckbox = $("find-change-italic");
  // 太字/斜体の相互排他: 一方を ON にしたら他方を OFF。
  // (ユーザー仕様: チェックボックスのみで「どちらか一方を選ぶ」を表現)
  boldCheckbox?.addEventListener("change", () => {
    if (boldCheckbox.checked && italicCheckbox) italicCheckbox.checked = false;
  });
  italicCheckbox?.addEventListener("change", () => {
    if (italicCheckbox.checked && boldCheckbox) boldCheckbox.checked = false;
  });
  // タブ切替
  $("find-change-tab-replace")?.addEventListener("click", () => setFindChangeActiveTab("replace"));
  $("find-change-tab-convert")?.addEventListener("click", () => setFindChangeActiveTab("convert"));
  $("find-change-tab-font")?.addEventListener("click", () => setFindChangeActiveTab("font"));
  // 初期表示は「検索置換」タブ
  setFindChangeActiveTab("replace");
  $("find-change-cancel")?.addEventListener("click", closeModal);
  $("find-change-apply")?.addEventListener("click", () => {
    runFindChangeFromModal();
  });
  replaceInput?.addEventListener("input", () => { if (replaceEnabled) replaceEnabled.checked = true; });
  replaceInput?.addEventListener("focus", () => { if (replaceEnabled) replaceEnabled.checked = true; });
  sourceFontEnabled?.addEventListener("change", () => {
    syncSourceFontControls();
    if (sourceFontEnabled.checked) sourceFontInput?.focus();
  });
  sourceFontInput?.addEventListener("focus", () => {
    if (!sourceFontInput.disabled) openSourceFontCombo(true);
  });
  sourceFontInput?.addEventListener("input", () => {
    enableSourceFontSearchFromInput();
    const hidden = $("find-change-source-font");
    if (hidden) hidden.value = "";
    if (!getSourceFontCombo()?.isOpen()) openSourceFontCombo();
    else filterSourceFontCombo(sourceFontInput.value);
  });
  sourceFontInput?.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!getSourceFontCombo()?.isOpen()) openSourceFontCombo(true);
      else moveSourceFontComboHighlight(+1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!getSourceFontCombo()?.isOpen()) openSourceFontCombo(true);
      else moveSourceFontComboHighlight(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      commitSourceFontInput();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeSourceFontCombo();
      syncFindChangeSourceFontDisplay();
      sourceFontInput.blur();
    }
  });
  sourceFontInput?.addEventListener("blur", () => {
    setTimeout(() => {
      const combo = $("find-change-source-font-combobox");
      if (!combo?.contains(document.activeElement)) closeSourceFontCombo();
      const hidden = $("find-change-source-font");
      if (hidden?.value) syncFindChangeSourceFontDisplay();
    }, 120);
  });
  sourceFontToggle?.addEventListener("mousedown", (e) => {
    e.preventDefault();
    if (sourceFontToggle.disabled) return;
    if (getSourceFontCombo()?.isOpen()) closeSourceFontCombo();
    else {
      sourceFontInput?.focus();
      openSourceFontCombo(true);
    }
  });
  sizeInput?.addEventListener("input", () => { if (sizeEnabled) sizeEnabled.checked = true; });
  fontInput?.addEventListener("focus", () => openFontCombo(true));
  fontInput?.addEventListener("input", () => {
    if (fontEnabled) fontEnabled.checked = true;
    const hidden = $("find-change-font");
    if (hidden) hidden.value = "";
    if (!getFontCombo()?.isOpen()) openFontCombo();
    else filterFontCombo(fontInput.value);
  });
  fontInput?.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!getFontCombo()?.isOpen()) openFontCombo(true);
      else moveFontComboHighlight(+1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!getFontCombo()?.isOpen()) openFontCombo(true);
      else moveFontComboHighlight(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      getFontCombo()?.commit({ fallbackValue: fontInput.value, blur: true });
      fontInput.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeFontCombo();
      syncFindChangeFontDisplay();
      fontInput.blur();
    }
  });
  fontInput?.addEventListener("blur", () => {
    setTimeout(() => {
      const combo = $("find-change-font-combobox");
      if (!combo?.contains(document.activeElement)) closeFontCombo();
      const hidden = $("find-change-font");
      if (hidden?.value) syncFindChangeFontDisplay();
    }, 120);
  });
  fontToggle?.addEventListener("mousedown", (e) => {
    e.preventDefault();
    if (getFontCombo()?.isOpen()) closeFontCombo();
    else {
      fontInput?.focus();
      openFontCombo(true);
    }
  });
  fillCustom?.addEventListener("input", () => { if (fillSelect) fillSelect.value = "custom"; });
  fillCustom?.addEventListener("change", () => { if (fillSelect) fillSelect.value = "custom"; });
  const enableWhiteStroke = () => {
    if (strokeEnabled) strokeEnabled.checked = true;
    if (strokeSelect && strokeSelect.value === "none") strokeSelect.value = "white";
  };
  strokeWidthInput?.addEventListener("input", enableWhiteStroke);
  strokeWidthInput?.addEventListener("focus", enableWhiteStroke);
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
    if (getFontCombo()?.isOpen() && !$("find-change-font-combobox")?.contains(e.target)) closeFontCombo();
    if (getSourceFontCombo()?.isOpen() && !$("find-change-source-font-combobox")?.contains(e.target)) closeSourceFontCombo();
    if (e.target === modal) closeModal();
  });
  modal.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeModal();
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      runFindChangeFromModal();
    }
  });
  const repositionFontList = () => {
    if (getFontCombo()?.isOpen()) positionFontCombo();
    if (getSourceFontCombo()?.isOpen()) positionSourceFontCombo();
  };
  modal.querySelector(".find-change-body")?.addEventListener("scroll", repositionFontList);
  window.addEventListener("resize", repositionFontList);
}

export function bindFindChangeMode() {
  const btn = $("find-change-btn");
  if (!btn) return;
  bindModalEvents();
  btn.addEventListener("click", openModal);
}
