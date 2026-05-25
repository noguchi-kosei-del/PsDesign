import {
  getEdit,
  getFonts,
  getNewLayersForPsd,
  getPages,
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
        <button id="find-change-close" class="find-change-close" type="button" aria-label="閉じる">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">
            <path d="M18 6 6 18"/>
            <path d="m6 6 12 12"/>
          </svg>
        </button>
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
          <input id="find-change-size" class="find-change-input" type="number" min="1" max="999" step="0.5" value="24">
        </div>
        <div class="find-change-grid">
          <label class="find-change-checkrow">
            <input id="find-change-font-enabled" type="checkbox">
            <span>フォント</span>
          </label>
          <select id="find-change-font" class="find-change-input"></select>
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

function readOptions() {
  const query = $("find-change-query")?.value ?? "";
  const replaceEnabled = $("find-change-replace-enabled")?.checked === true;
  const sizeEnabled = $("find-change-size-enabled")?.checked === true;
  const fontEnabled = $("find-change-font-enabled")?.checked === true;
  const sizePt = normalizeSizePt($("find-change-size")?.value);
  const fontPostScriptName = $("find-change-font")?.value ?? "";
  return {
    query,
    caseSensitive: $("find-change-case")?.checked === true,
    replaceEnabled,
    replacement: $("find-change-replace")?.value ?? "",
    sizeEnabled,
    sizePt,
    fontEnabled,
    fontPostScriptName,
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
  maps,
}) {
  const replacementLength = replacement.length;
  const replaced = replaceEnabled ? buildReplacedText(text, matches, replacement) : null;
  const nextText = replaced?.text ?? text;
  const styleRanges = replaced?.ranges ?? matches;
  const changedText = replaceEnabled && nextText !== text;

  let charSizes = replaceEnabled ? shiftCharMap(maps.charSizes, matches, replacementLength) : cloneMap(maps.charSizes);
  let charFonts = replaceEnabled ? shiftCharMap(maps.charFonts, matches, replacementLength) : cloneMap(maps.charFonts);
  const charBolds = replaceEnabled ? shiftCharMap(maps.charBolds, matches, replacementLength) : cloneMap(maps.charBolds);
  const charItalics = replaceEnabled ? shiftCharMap(maps.charItalics, matches, replacementLength) : cloneMap(maps.charItalics);
  const charRubies = replaceEnabled ? shiftRubyMap(maps.charRubies, matches, replacementLength) : cloneMap(maps.charRubies);

  if (sizeEnabled) charSizes = applyStyleRanges(charSizes, styleRanges, sizePt);
  if (fontEnabled) charFonts = applyStyleRanges(charFonts, styleRanges, fontPostScriptName);

  const remapNeeded = changedText;
  return {
    changedText,
    nextText,
    changes: {
      ...(changedText ? { contents: nextText } : {}),
      ...((remapNeeded || sizeEnabled) ? { charSizes } : {}),
      ...((remapNeeded || fontEnabled) ? { charFonts } : {}),
      ...(remapNeeded ? {
        charBolds,
        charItalics,
        charRubies,
      } : {}),
    },
  };
}

function applyFindChange(options) {
  if (!options.query) {
    toast("検索文字を入力してください", { kind: "info", duration: 2200 });
    return;
  }
  if (!options.replaceEnabled && !options.sizeEnabled && !options.fontEnabled) {
    toast("置換、文字サイズ、フォントのいずれかを有効にしてください", { kind: "info", duration: 2600 });
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
            charSizes: edit.charSizes,
            charFonts: edit.charFonts ?? layer.charFonts,
            charBolds: edit.charBolds,
            charItalics: edit.charItalics,
            charRubies: edit.charRubies,
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
          },
        });
        if (Object.keys(result.changes).length === 0) continue;
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
  $("find-change-close")?.addEventListener("click", closeModal);
  $("find-change-cancel")?.addEventListener("click", closeModal);
  $("find-change-apply")?.addEventListener("click", () => {
    applyFindChange(readOptions());
  });
  replaceInput?.addEventListener("input", () => { if (replaceEnabled) replaceEnabled.checked = true; });
  replaceInput?.addEventListener("focus", () => { if (replaceEnabled) replaceEnabled.checked = true; });
  sizeInput?.addEventListener("input", () => { if (sizeEnabled) sizeEnabled.checked = true; });
  sizeInput?.addEventListener("focus", () => { if (sizeEnabled) sizeEnabled.checked = true; });
  fontSelect?.addEventListener("change", () => { if (fontEnabled) fontEnabled.checked = true; });
  fontSelect?.addEventListener("focus", () => { if (fontEnabled) fontEnabled.checked = true; });
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
