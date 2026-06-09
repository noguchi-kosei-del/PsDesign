import {
  addNewLayer,
  getCurrentFont,
  getCurrentPageIndex,
  getFillColor,
  getLeadingPct,
  getNewLayers,
  getNewLayersForPsd,
  getScanExtractTextDiffs,
  getScanExtractTextSource,
  getParallelViewMode,
  getPages,
  getPdfPageIndex,
  getSelectedLayer,
  getSelectedLayers,
  getStrokeColor,
  getStrokeWidthPx,
  getTextSize,
  getNewTextDirection,
  getTxtFilePath,
  getTxtSelectedBlockIndex,
  getTxtSource,
  onPageIndexChange,
  onPdfChange,
  onPdfPageIndexChange,
  onScanExtractTextDiffsChange,
  onScanExtractTextSourceChange,
  onParallelViewModeChange,
  onTxtSourceChange,
  removeNewLayer,
  setSelectedLayer,
  setSelectedLayers,
  setTxtDirty,
  setTxtFilePath,
  setTxtSelectedBlockIndex,
  setTxtSelection,
  setTxtSource,
  updateNewLayer,
  withHistoryTransient,
} from "./state.js";
import { confirmDialog, notifyDialog, toast } from "./ui-feedback.js";
import { centerTopLeft, refreshAllOverlays } from "./canvas-tools.js";
import { rebuildLayerList } from "./text-editor.js";
import {
  appendTextWithStyleMarkers,
  getStyleOverrideRangesForTxtRef,
} from "./text-style-markers.js";
import { getDefault } from "./settings.js";
import { baseName } from "./utils/path.js";

const $ = (id) => document.getElementById(id);
const RUNTIME_TOKEN = "a" + "i";
const 画像スキャン_SOURCE_VISIBLE_KEY = "opus_extract_source_panel_visible";
let extractSourcePanelVisible = false;
let txtSourceSaveInflight = false;

function readExtractSourcePanelVisible() {
  try {
    return localStorage.getItem(画像スキャン_SOURCE_VISIBLE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeExtractSourcePanelVisible(value) {
  try {
    localStorage.setItem(画像スキャン_SOURCE_VISIBLE_KEY, value ? "1" : "0");
  } catch {}
}

function syncExtractSourcePanelVisibility() {
  const panel = $("extract-source-panel");
  const stage = $("spreads-stage");
  const toggle = $("editor-extract-source-toggle");
  const source = getScanExtractTextSource();
  const show = getParallelViewMode() === "editor" && extractSourcePanelVisible && !!source?.content;
  if (toggle) toggle.checked = extractSourcePanelVisible;
  if (panel) panel.hidden = !show;
  if (stage) stage.classList.toggle("extract-source-visible", show);
}

function setupEditorExtractSourcePanel() {
  const panel = $("extract-source-panel");
  const stage = $("spreads-stage");
  const editorArea = $("spreads-editor-area");
  const toolbar = document.querySelector(".editor-toolbar-row2");
  if (panel && stage && editorArea && panel.parentElement !== stage) {
    panel.classList.add("editor-extract-source-panel");
    editorArea.insertAdjacentElement("afterend", panel);
  }
  if (toolbar && !$("editor-extract-source-toggle")) {
    const label = document.createElement("label");
    label.className = "editor-extract-toggle";
    label.title = "画像スキャンソースパネルを表示";
    label.innerHTML = '<input id="editor-extract-source-toggle" type="checkbox" /><span>画像スキャン</span>';
    const pageNav = toolbar.querySelector(".editor-page-nav");
    toolbar.insertBefore(label, pageNav || null);
    label.querySelector("input")?.addEventListener("change", (e) => {
      extractSourcePanelVisible = !!e.currentTarget.checked;
      writeExtractSourcePanelVisible(extractSourcePanelVisible);
      renderExtractSourceViewer();
    });
  }
  extractSourcePanelVisible = readExtractSourcePanelVisible();
  syncExtractSourcePanelVisibility();
}

function decodeBytes(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let offset = 0;
  if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) {
    offset = 3;
  }
  try {
    const strict = new TextDecoder("utf-8", { fatal: true });
    return strict.decode(u8.subarray(offset));
  } catch {
    try {
      const sjis = new TextDecoder("shift_jis");
      return sjis.decode(u8);
    } catch {
      return new TextDecoder("utf-8").decode(u8);
    }
  }
}

const PAGE_MARKER_RE = /<<\s*([0-9０-９]+)\s*Page\s*>>/gi;

export function splitBlocksRaw(s) {
  return s
    .split(/\n\s*\n/)
    .map((p) => p.replace(/^\n+|\n+$/g, ""))
    .filter((p) => p.length > 0);
}

function splitBlocksWithOffsets(sectionText, sectionStart = 0) {
  const text = String(sectionText ?? "").replace(/\r\n?/g, "\n");
  const blocks = [];
  const re = /\n[ \t\u3000]*\n/g;
  let start = 0;
  const push = (end) => {
    const raw = text.slice(start, end);
    const leading = raw.match(/^\n*/)?.[0]?.length ?? 0;
    const trimmed = raw.replace(/^\n+|\n+$/g, "");
    if (trimmed.length > 0) {
      blocks.push({ text: trimmed, offset: sectionStart + start + leading });
    }
  };
  let match;
  while ((match = re.exec(text)) !== null) {
    push(match.index);
    start = match.index + match[0].length;
  }
  push(text.length);
  return blocks;
}

function findBlockOffsetByIndex(content, pageNumber, paragraphIndex) {
  if (!Number.isInteger(paragraphIndex) || paragraphIndex < 0) return null;
  const norm = String(content ?? "").replace(/\r\n?/g, "\n");
  if (!Number.isInteger(pageNumber) || pageNumber <= 0) {
    return splitBlocksWithOffsets(norm, 0)[paragraphIndex]?.offset ?? null;
  }

  const re = new RegExp(PAGE_MARKER_RE.source, "gi");
  let sectionStart = -1;
  let sectionEnd = norm.length;
  let inTargetPage = false;
  let match;
  while ((match = re.exec(norm)) !== null) {
    const num = toHalfWidthInt(match[1]);
    if (inTargetPage) {
      sectionEnd = match.index;
      break;
    }
    if (num === pageNumber) {
      inTargetPage = true;
      sectionStart = match.index + match[0].length;
    }
  }
  if (!inTargetPage) return null;
  return splitBlocksWithOffsets(norm.slice(sectionStart, sectionEnd), sectionStart)[paragraphIndex]?.offset ?? null;
}

function toHalfWidthInt(s) {
  const normalized = String(s).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const n = parseInt(normalized, 10);
  return Number.isFinite(n) ? n : null;
}

export function parsePages(content) {
  const normalized = (content ?? "").replace(/\r\n?/g, "\n");
  const re = new RegExp(PAGE_MARKER_RE.source, "gi");
  const byPage = new Map();
  let lastIndex = 0;
  let currentPage = null;
  let match;
  let hasMarkers = false;

  const pushBlocks = (page, text) => {
    if (page == null) return;
    const blocks = splitBlocksRaw(text);
    if (!blocks.length) return;
    if (!byPage.has(page)) byPage.set(page, []);
    const arr = byPage.get(page);
    for (const b of blocks) arr.push(b);
  };

  while ((match = re.exec(normalized)) !== null) {
    hasMarkers = true;
    const before = normalized.slice(lastIndex, match.index);
    pushBlocks(currentPage, before);
    currentPage = toHalfWidthInt(match[1]);
    lastIndex = match.index + match[0].length;
  }
  if (hasMarkers) {
    pushBlocks(currentPage, normalized.slice(lastIndex));
    return { hasMarkers: true, all: [], byPage };
  }
  return { hasMarkers: false, all: splitBlocksRaw(normalized), byPage };
}

// 現在ページ番号 (1-indexed) を返す。
// PSD が読み込まれていれば PSD の currentPageIndex を使い、
// それ以外（見本のみ／TXT 単体）は pdfPageIndex を流用する。
// PDF も TXT 単体も同じ pdfPageIndex を「閲覧中ページ」として共有する設計。
export function getActivePageNumber() {
  if (getPages().length > 0) return getCurrentPageIndex() + 1;
  return getPdfPageIndex() + 1;
}

// TXT 原稿に含まれる <<NPage>> マーカーの最大ページ番号を返す。
// マーカー無し or TXT 未読込なら 0 を返す（ページ送り対象外）。
// 「TXT 単体読み込み時のページ総数」として main.js のページナビが参照する。
export function getTxtPageCount() {
  const source = getTxtSource();
  if (!source) return 0;
  const parsed = parsePages(source.content);
  if (!parsed.hasMarkers || parsed.byPage.size === 0) return 0;
  let max = 0;
  for (const k of parsed.byPage.keys()) {
    if (k > max) max = k;
  }
  return max;
}

function getBlocksForSource(source) {
  if (!source) return { blocks: [], hasMarkers: false, pageNumber: null };
  const parsed = parsePages(source.content);
  if (!parsed.hasMarkers) {
    return { blocks: parsed.all, hasMarkers: false, pageNumber: null };
  }
  const pageNumber = getActivePageNumber();
  return {
    blocks: parsed.byPage.get(pageNumber) ?? [],
    hasMarkers: true,
    pageNumber,
  };
}

function getVisibleBlocks() {
  return getBlocksForSource(getTxtSource());
}

export function renderTxtSourceViewer() {
  renderViewer();
  renderExtractSourceViewer();
}

function renderViewer() {
  const source = getTxtSource();
  const viewer = $("txt-source-viewer");
  const empty = $("txt-source-empty");
  const name = $("txt-source-name");
  const clearBtn = $("clear-txt-btn");
  const saveBtn = $("save-txt-btn");
  const deleteBtn = $("delete-txt-btn");

  viewer.innerHTML = "";
  renderExtractSourceViewer();

  // txt-source-actions 内 3 ボタン (保存 / 削除 / 再読み込み) は常時表示し、
  // TXT 未読込時は disabled でグレーアウトする（global の button:disabled ルール）。
  // 「テキストを削除」は選択中ブロックがある時だけ有効にする。
  if (!source) {
    viewer.hidden = true;
    empty.hidden = false;
    name.textContent = "";
    clearBtn.disabled = true;
    if (saveBtn) saveBtn.disabled = true;
    if (deleteBtn) deleteBtn.disabled = true;
    return;
  }

  viewer.hidden = false;
  empty.hidden = true;
  name.textContent = source.name;
  clearBtn.disabled = false;
  if (saveBtn) saveBtn.disabled = txtSourceSaveInflight;
  if (deleteBtn) deleteBtn.disabled = getTxtSelectedBlockIndex() == null;

  const { blocks, hasMarkers, pageNumber } = getVisibleBlocks();

  if (hasMarkers && blocks.length === 0) {
    const info = document.createElement("div");
    info.className = "txt-block-empty-hint";
    info.textContent = `ページ ${pageNumber} のテキストはありません`;
    viewer.appendChild(info);
    return;
  }

  const selectedIdx = getTxtSelectedBlockIndex();
  // 【v1.26.0 移植 (PsDesign-main v1.24.0)】
  // 自動配置で背景/ウニ判定によりフォント切替された段落の bucket マップ。
  // 同じ paragraph を参照するレイヤーが複数あるかもしれないので、最大 bucket
  // (= 最も濃い色) を採用する。bucket = 0..5 の 10% 刻みで色分け。
  const autoBucketByPara = new Map();
  for (const layer of getNewLayers()) {
    if (!layer?.autoFontSwitched) continue;
    const ref = layer.sourceTxtRef;
    if (!ref || !Number.isInteger(ref.paragraphIndex)) continue;
    if (hasMarkers && ref.pageNumber !== pageNumber) continue;
    const bucket = Number.isInteger(layer.autoFontSwitchBucket) ? layer.autoFontSwitchBucket : -1;
    const existing = autoBucketByPara.get(ref.paragraphIndex);
    if (existing == null || bucket > existing) {
      autoBucketByPara.set(ref.paragraphIndex, bucket);
    }
  }
  blocks.forEach((paragraph, idx) => {
    const el = document.createElement("div");
    el.className = "txt-block";
    el.dataset.blockIndex = String(idx);
    appendTextWithStyleMarkers(
      el,
      paragraph,
      getStyleOverrideRangesForTxtRef(pageNumber, idx),
    );
    if (idx === selectedIdx) el.classList.add("selected");
    if (autoBucketByPara.has(idx)) {
      el.classList.add("auto-font-switched");
      const b = autoBucketByPara.get(idx);
      if (Number.isInteger(b) && b >= 0) {
        el.classList.add(`auto-font-bucket-${b}`);
      }
    }
    el.addEventListener("click", () => selectBlock(idx, paragraph));
    el.addEventListener("dblclick", (e) => {
      e.preventDefault(); // text selection の暴走を抑止
      startInlineEdit(el, paragraph, pageNumber);
    });
    viewer.appendChild(el);
  });
}

// dblclick 時に該当の .txt-block を contenteditable にして直接編集できるようにする。
// 確定: blur / Ctrl+Enter / Cmd+Enter
// 取消: Escape
// 改行: Enter（contenteditable のデフォルト挙動）
// 確定で更新があれば updateTxtSourceBlock 経由で原稿全体を書換 → setTxtSource → 自動配置済み
// レイヤーへの追従は auto-place.js の onTxtSourceChange listener が担当する。
function compareExtractKeyText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\{([^{}]+)\}\(([^()]+)\)/g, "$1")
    .replace(/\r\n?/g, "\n")
    .replace(/[\s\u3000]+/g, "")
    .replace(/[\uFE63\uFF0D\uFF70\u2010-\u2015\u2212]/g, "\u30fc")
    .replace(/[、。，．.,!?！？・…ー\-()（）「」『』【】［］\[\]〈〉《》]/g, "")
    .trim();
}

function extractTextMatchScore(aRaw, bRaw) {
  const a = compareExtractKeyText(aRaw);
  const b = compareExtractKeyText(bRaw);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const shorter = Math.min(a.length, b.length);
  const longer = Math.max(a.length, b.length);
  const contain = (a.includes(b) || b.includes(a)) ? shorter / longer : 0;
  const counts = new Map();
  for (const ch of b) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let hit = 0;
  for (const ch of a) {
    const n = counts.get(ch) ?? 0;
    if (n > 0) {
      hit += 1;
      counts.set(ch, n - 1);
    }
  }
  const overlap = (2 * hit) / (a.length + b.length);
  return Math.max(contain, overlap);
}

function minimumExtractDisplayMatchScore(txt) {
  const len = compareExtractKeyText(txt).length;
  if (len <= 2) return 0.72;
  if (len <= 4) return 0.58;
  if (len <= 8) return 0.46;
  return 0.38;
}

function buildPlacedExtractIndexMap() {
  const map = new Map();
  for (const layer of getNewLayers()) {
    const ref = layer?.sourceTxtRef;
    if (!ref || !Number.isInteger(ref.pageNumber) || !Number.isInteger(ref.paragraphIndex)) continue;
    if (!Number.isInteger(ref.extractBlockIndex)) continue;
    map.set(`${ref.pageNumber}:${ref.paragraphIndex}`, {
      extractIndex: ref.extractBlockIndex,
      score: Number.isFinite(ref.extractMatchScore) ? ref.extractMatchScore : null,
    });
  }
  return map;
}

function buildExtractDisplayRows(textBlocks, extractBlocks, pageNumber) {
  const placedMap = buildPlacedExtractIndexMap();
  const usedExtract = new Set();
  const rows = [];
  for (let textIndex = 0; textIndex < textBlocks.length; textIndex += 1) {
    const placed = placedMap.get(`${pageNumber}:${textIndex}`);
    let extractIndex = Number.isInteger(placed?.extractIndex) ? placed.extractIndex : null;
    let score = Number.isFinite(placed?.score) ? placed.score : null;
    if (extractIndex == null || !extractBlocks[extractIndex]) {
      let best = null;
      for (let i = 0; i < extractBlocks.length; i += 1) {
        if (usedExtract.has(i)) continue;
        const s = extractTextMatchScore(textBlocks[textIndex], extractBlocks[i]);
        if (!best || s > best.score) best = { extractIndex: i, score: s };
      }
      if (best && best.score >= minimumExtractDisplayMatchScore(textBlocks[textIndex])) {
        extractIndex = best.extractIndex;
        score = best.score;
      }
    }
    if (extractIndex != null) usedExtract.add(extractIndex);
    const scanned = extractIndex != null ? (extractBlocks[extractIndex] ?? "") : "";
    const changed = compareExtractKeyText(textBlocks[textIndex]) !== compareExtractKeyText(scanned);
    rows.push({ type: changed ? "changed" : "matched", textIndex, extractIndex, expected: textBlocks[textIndex], scanned, score });
  }
  for (let i = 0; i < extractBlocks.length; i += 1) {
    if (usedExtract.has(i)) continue;
    rows.push({ type: "extra-extract", textIndex: null, extractIndex: i, expected: "", scanned: extractBlocks[i], score: null });
  }
  return rows;
}

function renderExtractSourceViewer() {
  const panel = $("extract-source-panel");
  if (!panel) return;
  const viewer = $("extract-source-viewer");
  const title = $("extract-source-title");
  const summary = $("extract-source-summary");
  const source = getScanExtractTextSource();
  if (!source?.content) {
    syncExtractSourcePanelVisibility();
    if (viewer) viewer.innerHTML = "";
    return;
  }
  const textInfo = getBlocksForSource(getTxtSource());
  const extractInfo = getBlocksForSource(source);
  const pageNumber = textInfo.pageNumber ?? extractInfo.pageNumber ?? getActivePageNumber();
  const rows = buildExtractDisplayRows(textInfo.blocks, extractInfo.blocks, pageNumber);
  const diffs = getScanExtractTextDiffs();
  syncExtractSourcePanelVisibility();
  if (title) title.textContent = source.name || "画像スキャン結果";
  if (summary) {
    const changedCount = rows.filter((r) => r.type !== "matched").length;
    summary.textContent = diffs.length > 0
      ? `差分 ${diffs.length} 件`
      : changedCount > 0 ? `確認 ${changedCount} 件` : "差分なし";
  }
  if (!viewer) return;
  viewer.innerHTML = "";
  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "extract-source-empty";
    empty.textContent = "このページの画像スキャン結果はありません";
    viewer.appendChild(empty);
    return;
  }
  for (const row of rows) {
    const el = document.createElement("div");
    el.className = `extract-source-block ${row.type}`;
    const label = document.createElement("div");
    label.className = "extract-source-block-label";
    label.textContent = row.type === "extra-extract"
      ? `画像スキャンのみ #${(row.extractIndex ?? 0) + 1}`
      : `#${(row.textIndex ?? 0) + 1}${Number.isFinite(row.score) ? ` / ${Math.round(row.score * 100)}%` : ""}`;
    const body = document.createElement("div");
    body.className = "extract-source-block-body";
    body.textContent = row.type === "matched"
      ? row.scanned
      : `使用: ${row.expected || "-"}\n画像スキャン: ${row.scanned || "-"}`;
    el.appendChild(label);
    el.appendChild(body);
    viewer.appendChild(el);
  }
}

function startInlineEdit(el, originalText, pageNumber) {
  if (!el || el.classList.contains("editing")) return;
  el.contentEditable = "true";
  el.classList.add("editing");
  el.focus();
  // 全選択（編集開始時にカーソルを末尾でなく全選択にすると上書きが楽）。
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  let aborted = false;
  let finalized = false;

  const cleanup = () => {
    if (finalized) return;
    finalized = true;
    el.contentEditable = "false";
    el.classList.remove("editing");
    el.removeEventListener("keydown", onKey);
    el.removeEventListener("blur", onBlur);
    if (aborted) {
      // 元テキストに戻す。setTxtSource は呼ばないので listener も発火せず、
      // 他の編集状態 (txtSelection 等) も保持される。
      el.textContent = originalText;
      return;
    }
    // contenteditable の改行は browser によって <br> / <div> になり得るため、
    // textContent ではなく innerText で取得して LF 正規化したテキストを得る。
    const newText = (el.innerText ?? el.textContent ?? "").replace(/\r\n?/g, "\n");
    if (newText !== originalText) {
      let parts = newText
        .split(/\n[ \t\u3000]*\n/)
        .map((s) => s.replace(/^\n+|\n+$/g, ""))
        .filter((s) => s.length > 0);
      if (parts.length <= 1 && !String(originalText ?? "").includes("\n") && newText.includes("\n")) {
        parts = newText
          .split(/\n[ \t\u3000]*/)
          .map((s) => s.replace(/^\n+|\n+$/g, ""))
          .filter((s) => s.length > 0);
      }
      if (parts.length > 1) {
        const paragraphIndex = Number(el.dataset.blockIndex);
        const offset = findBlockOffsetByIndex(getTxtSource()?.content, pageNumber, paragraphIndex);
        if (offset != null && splitTxtBlockAndPlace(offset, originalText, parts, paragraphIndex, pageNumber)) {
          return;
        }
      }
      updateTxtSourceBlock(pageNumber, originalText, newText);
      // setTxtSource → onTxtSourceChange → renderViewer で DOM 再構築されるため
      // この el への以降の操作は不要。
    }
  };

  const onBlur = () => cleanup();
  const onKey = (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      el.blur(); // → onBlur → cleanup（commit）
    } else if (e.key === "Escape") {
      e.preventDefault();
      aborted = true;
      el.blur(); // → onBlur → cleanup（revert）
    }
  };
  el.addEventListener("blur", onBlur);
  el.addEventListener("keydown", onKey);
}

// pageNumber（マーカー有り：1-based / 無し：null）の範囲内で oldParagraph を
// newParagraph に置換し、setTxtSource → renderViewer で UI も更新する。
// 同一テキスト or 一致なしのときは no-op で false。
export function updateTxtSourceBlock(pageNumber, oldParagraph, newParagraph) {
  if (oldParagraph === newParagraph) return false;
  const source = getTxtSource();
  if (!source) return false;
  const newContent = replaceBlockInContent(source.content, pageNumber, oldParagraph, newParagraph);
  if (newContent == null || newContent === source.content) return false;
  // setTxtSource は txtSelection / txtSelectedBlockIndex をリセットするが
  // dblclick 経路ではすでにクリア済みなので問題なし。
  // setTxtSource → onTxtSourceChange listener が renderViewer を呼ぶので明示呼出は不要。
  setTxtSource({ name: source.name, content: newContent });
  return true;
}

// pageNumber 範囲内の idx 番目（visible blocks 上の通し番号）のパラグラフを削除した
// 新しい content を返す。一致しなければ null。
export function deleteBlockFromContent(content, pageNumber, idx) {
  const norm = (content ?? "").replace(/\r\n?/g, "\n");
  if (idx == null || idx < 0) return null;

  // マーカー無し原稿: content 全体をパラグラフ列として扱う
  if (pageNumber == null) {
    const parts = splitBlocksRaw(norm);
    if (idx >= parts.length) return null;
    parts.splice(idx, 1);
    return parts.join("\n\n");
  }

  // pageNumber が指すセクション範囲を特定
  const re = new RegExp(PAGE_MARKER_RE.source, "gi");
  let sectionStart = -1;
  let sectionEnd = norm.length;
  let inTargetPage = false;
  let m;
  while ((m = re.exec(norm)) !== null) {
    const num = toHalfWidthInt(m[1]);
    if (inTargetPage) { sectionEnd = m.index; break; }
    if (num === pageNumber) {
      inTargetPage = true;
      sectionStart = m.index + m[0].length;
    }
  }
  if (!inTargetPage) return null;

  const sectionText = norm.slice(sectionStart, sectionEnd);
  const parts = splitBlocksRaw(sectionText);
  if (idx >= parts.length) return null;
  parts.splice(idx, 1);
  // セクション両端に改行を保ち、マーカー行とパラグラフを区切る
  const newSection = parts.length === 0 ? "\n" : `\n${parts.join("\n\n")}\n`;
  return norm.slice(0, sectionStart) + newSection + norm.slice(sectionEnd);
}

function moveBlockArray(parts, fromIdx, toIdx) {
  if (!Number.isInteger(fromIdx) || !Number.isInteger(toIdx)) return null;
  if (fromIdx < 0 || toIdx < 0 || fromIdx >= parts.length || toIdx >= parts.length) return null;
  const next = parts.slice();
  const [item] = next.splice(fromIdx, 1);
  next.splice(toIdx, 0, item);
  return next;
}

function moveBlockInContent(content, pageNumber, fromIdx, toIdx) {
  const norm = (content ?? "").replace(/\r\n?/g, "\n");
  if (fromIdx === toIdx) return norm;

  if (pageNumber == null) {
    const parts = splitBlocksRaw(norm);
    const moved = moveBlockArray(parts, fromIdx, toIdx);
    if (!moved) return null;
    return moved.join("\n\n");
  }

  const re = new RegExp(PAGE_MARKER_RE.source, "gi");
  let sectionStart = -1;
  let sectionEnd = norm.length;
  let inTargetPage = false;
  let m;
  while ((m = re.exec(norm)) !== null) {
    const num = toHalfWidthInt(m[1]);
    if (inTargetPage) { sectionEnd = m.index; break; }
    if (num === pageNumber) {
      inTargetPage = true;
      sectionStart = m.index + m[0].length;
    }
  }
  if (!inTargetPage) return null;

  const parts = splitBlocksRaw(norm.slice(sectionStart, sectionEnd));
  const moved = moveBlockArray(parts, fromIdx, toIdx);
  if (!moved) return null;
  const newSection = moved.length === 0 ? "\n" : `\n${moved.join("\n\n")}\n`;
  return norm.slice(0, sectionStart) + newSection + norm.slice(sectionEnd);
}

function findMarkedPageSection(norm, pageNumber) {
  if (!Number.isInteger(pageNumber) || pageNumber <= 0) return null;
  const re = new RegExp(PAGE_MARKER_RE.source, "gi");
  let sectionStart = -1;
  let sectionEnd = norm.length;
  let inTargetPage = false;
  let m;
  while ((m = re.exec(norm)) !== null) {
    const num = toHalfWidthInt(m[1]);
    if (inTargetPage) {
      sectionEnd = m.index;
      break;
    }
    if (num === pageNumber) {
      inTargetPage = true;
      sectionStart = m.index + m[0].length;
    }
  }
  if (!inTargetPage) return null;
  return { pageNumber, sectionStart, sectionEnd, blocks: splitBlocksRaw(norm.slice(sectionStart, sectionEnd)) };
}

function sectionTextFromBlocks(blocks) {
  return blocks.length === 0 ? "\n" : `\n${blocks.join("\n\n")}\n`;
}

function replaceMarkedPageSections(norm, replacements) {
  const sections = Array.from(replacements.values())
    .sort((a, b) => b.sectionStart - a.sectionStart);
  let next = norm;
  for (const section of sections) {
    next = next.slice(0, section.sectionStart)
      + sectionTextFromBlocks(section.blocks)
      + next.slice(section.sectionEnd);
  }
  return next;
}

function moveBlockBetweenPagesInContent(content, fromPageNumber, fromIdx, toPageNumber, toIdx) {
  const norm = (content ?? "").replace(/\r\n?/g, "\n");
  if (fromPageNumber == null || toPageNumber == null) return null;
  if (fromPageNumber === toPageNumber) return moveBlockInContent(norm, fromPageNumber, fromIdx, toIdx);

  const fromSection = findMarkedPageSection(norm, fromPageNumber);
  const toSection = findMarkedPageSection(norm, toPageNumber);
  if (!fromSection || !toSection) return null;
  if (fromIdx < 0 || fromIdx >= fromSection.blocks.length) return null;
  if (toIdx < 0 || toIdx > toSection.blocks.length) return null;

  const fromBlocks = fromSection.blocks.slice();
  const toBlocks = toSection.blocks.slice();
  const [moved] = fromBlocks.splice(fromIdx, 1);
  toBlocks.splice(toIdx, 0, moved);

  return replaceMarkedPageSections(norm, new Map([
    [fromPageNumber, { ...fromSection, blocks: fromBlocks }],
    [toPageNumber, { ...toSection, blocks: toBlocks }],
  ]));
}

function paragraphIndexAfterMove(idx, fromIdx, toIdx) {
  if (idx === fromIdx) return toIdx;
  if (fromIdx < toIdx && idx > fromIdx && idx <= toIdx) return idx - 1;
  if (fromIdx > toIdx && idx >= toIdx && idx < fromIdx) return idx + 1;
  return idx;
}

function psdPathForTxtPageNumber(pageNumber) {
  if (!Number.isInteger(pageNumber) || pageNumber <= 0) return null;
  return getPages()[pageNumber - 1]?.path ?? null;
}

export function moveTxtBlockByIndex(pageNumber, fromIdx, toIdx, toPageNumber = pageNumber) {
  const source = getTxtSource();
  if (!source) return false;
  if (!Number.isInteger(fromIdx) || !Number.isInteger(toIdx)) return false;
  if (fromIdx < 0 || toIdx < 0) return false;

  const fromPage = pageNumber ?? null;
  const targetPage = toPageNumber ?? null;
  const samePage = fromPage === targetPage;
  if (samePage && fromIdx === toIdx) return false;
  const newContent = samePage
    ? moveBlockInContent(source.content, fromPage, fromIdx, toIdx)
    : moveBlockBetweenPagesInContent(source.content, fromPage, fromIdx, targetPage, toIdx);
  if (newContent == null) return false;
  const targetPsdPath = samePage ? null : psdPathForTxtPageNumber(targetPage);

  let refChanged = false;
  withHistoryTransient(() => {
    for (const layer of getNewLayers().slice()) {
      const ref = layer?.sourceTxtRef;
      if (!ref || !Number.isInteger(ref.paragraphIndex)) continue;
      const refPage = ref.pageNumber == null ? null : Number(ref.pageNumber);
      if (samePage) {
        if (refPage !== fromPage) continue;
        const nextIndex = paragraphIndexAfterMove(ref.paragraphIndex, fromIdx, toIdx);
        if (nextIndex !== ref.paragraphIndex) {
          updateNewLayer(layer.tempId, {
            sourceTxtRef: { ...ref, paragraphIndex: nextIndex },
          });
          refChanged = true;
        }
        continue;
      }

      if (refPage === fromPage && ref.paragraphIndex === fromIdx) {
        const changes = {
          sourceTxtRef: { ...ref, pageNumber: targetPage, paragraphIndex: toIdx },
        };
        if (targetPsdPath) changes.psdPath = targetPsdPath;
        updateNewLayer(layer.tempId, {
          ...changes,
        });
        refChanged = true;
      } else if (refPage === fromPage && ref.paragraphIndex > fromIdx) {
        updateNewLayer(layer.tempId, {
          sourceTxtRef: { ...ref, paragraphIndex: ref.paragraphIndex - 1 },
        });
        refChanged = true;
      } else if (refPage === targetPage && ref.paragraphIndex >= toIdx) {
        updateNewLayer(layer.tempId, {
          sourceTxtRef: { ...ref, paragraphIndex: ref.paragraphIndex + 1 },
        });
        refChanged = true;
      }
    }
    if (newContent !== source.content) {
      setTxtSource({ name: source.name, content: newContent });
      setTxtDirty(true);
    }
  });

  if (newContent !== source.content || refChanged) {
    try { refreshAllOverlays(); } catch (_) {}
    try { rebuildLayerList(); } catch (_) {}
    return true;
  }
  return false;
}

// 選択中の TXT ブロックを 1 件削除する。削除に成功すれば true。
// (キーボード Delete/Backspace ハンドラから呼ぶ)
//
// 自動配置済みレイヤーには `sourceTxtRef = { pageNumber, paragraphIndex }` が埋まっており、
// 単に setTxtSource だけ呼ぶと paragraphIndex が削除位置以降のレイヤーで 1 つズレて
// 「PSD 上のテキストが消えず、別段落の内容で重複する」状態になる。これを防ぐために:
//   - 削除対象段落を sourceTxtRef で参照していたレイヤーは removeNewLayer で消す
//   - 後続段落（paragraphIndex > idx）を参照していたレイヤーは paragraphIndex を 1 デクリメント
// すべて withHistoryTransient で 1 つの undo スナップショットにまとめる。
export function deleteSelectedTxtBlock() {
  const source = getTxtSource();
  if (!source) return false;
  const idx = getTxtSelectedBlockIndex();
  if (idx == null) return false;
  const { blocks, pageNumber } = getVisibleBlocks();
  if (!blocks || idx >= blocks.length) return false;
  const newContent = deleteBlockFromContent(source.content, pageNumber, idx);
  if (newContent == null || newContent === source.content) return false;
  // 選択をクリアしてから setTxtSource → onTxtSourceChange listener で renderViewer
  setTxtSelectedBlockIndex(null);
  setTxtSelection("");

  let layerRemoved = false;
  withHistoryTransient(() => {
    // sourceTxtRef.pageNumber は parsePages の hasMarkers 有無で
    // null（マーカー無し原稿）or 数値（マーカー有り）。getVisibleBlocks の pageNumber と
    // 厳密一致するもののみ対象にする。
    const targetPage = pageNumber ?? null;
    // removeNewLayer は state.newLayers をフィルタで作り直すので、走査中に変更しても
    // 元配列は壊れないようスナップショット化（slice）してから iterate する。
    for (const layer of getNewLayers().slice()) {
      const ref = layer?.sourceTxtRef;
      if (!ref) continue;
      const refPage = ref.pageNumber ?? null;
      if (refPage !== targetPage) continue;
      if (ref.paragraphIndex === idx) {
        removeNewLayer(layer.tempId);
        layerRemoved = true;
      } else if (ref.paragraphIndex > idx) {
        updateNewLayer(layer.tempId, {
          sourceTxtRef: { ...ref, paragraphIndex: ref.paragraphIndex - 1 },
        });
      }
    }
    setTxtSource({ name: source.name, content: newContent });
  });
  // setTxtSource が onTxtSourceChange listener (scan-place の syncPlacedFromTxt) を
  // 発火するが、こちらは contents 変更時だけ rebuild する作りなので、レイヤーが
  // 1 件削除されただけのケースでは UI が古いまま残る。手動で同期させる。
  if (layerRemoved) {
    try { refreshAllOverlays(); } catch (_) {}
    try { rebuildLayerList(); } catch (_) {}
  }
  return true;
}

// 任意の (pageNumber, paragraphIndex) を直接指定して段落を削除する。
// テキストエディタモードの段落左端 × ボタンから呼ばれる（選択状態に依存せず、
// 該当段落を即削除）。内部ロジックは deleteSelectedTxtBlock と同じく:
//   - 削除対象を sourceTxtRef で参照していた新規レイヤーを removeNewLayer
//   - paragraphIndex > idx の新規レイヤーを 1 デクリメント
//   - 全部 withHistoryTransient で 1 undo スナップショット化
// 選択中ブロックの index が削除位置以降だった場合は補正（or クリア）して整合を取る。
// pageNumber は parsePages の hasMarkers に応じて null（マーカー無し原稿）or 数値（マーカー有り）。
export function deleteTxtBlockByIndex(pageNumber, idx) {
  const source = getTxtSource();
  if (!source) return false;
  if (!Number.isInteger(idx) || idx < 0) return false;
  const newContent = deleteBlockFromContent(source.content, pageNumber, idx);
  if (newContent == null || newContent === source.content) return false;

  // 選択 index の補正（削除対象 = 選択中ならクリア、削除位置より後ろが選択中なら -1）
  const selectedIdx = getTxtSelectedBlockIndex();
  if (selectedIdx === idx) {
    setTxtSelectedBlockIndex(null);
    setTxtSelection("");
  } else if (Number.isInteger(selectedIdx) && selectedIdx > idx) {
    setTxtSelectedBlockIndex(selectedIdx - 1);
  }

  let layerRemoved = false;
  withHistoryTransient(() => {
    const targetPage = pageNumber ?? null;
    for (const layer of getNewLayers().slice()) {
      const ref = layer?.sourceTxtRef;
      if (!ref) continue;
      const refPage = ref.pageNumber ?? null;
      if (refPage !== targetPage) continue;
      if (ref.paragraphIndex === idx) {
        removeNewLayer(layer.tempId);
        layerRemoved = true;
      } else if (ref.paragraphIndex > idx) {
        updateNewLayer(layer.tempId, {
          sourceTxtRef: { ...ref, paragraphIndex: ref.paragraphIndex - 1 },
        });
      }
    }
    setTxtSource({ name: source.name, content: newContent });
  });
  if (layerRemoved) {
    try { refreshAllOverlays(); } catch (_) {}
    try { rebuildLayerList(); } catch (_) {}
  }
  return true;
}

// レイヤー削除（V ツールでの Delete/Backspace）から呼ばれる、layer → TXT 方向の cascade。
// 削除された layer の `sourceTxtRef` で参照されていた段落を原稿テキストから取り除き、
// 残ったレイヤーの paragraphIndex を補正する。
//
// 引数 `deletedLayers`: 削除直前のレイヤースナップショット（tempId と sourceTxtRef を持つ）
// 引数 `excludeTempIds`: 補正対象から除外する tempId Set（呼び出し側で既に removeNewLayer 済の id）
//
// 既に呼び出し側で withHistoryTransient のスコープ内にある前提（自前では作らない）。
// 戻り値: 何か変更があれば true。
export function cascadeRemoveTxtForLayers(deletedLayers, excludeTempIds = new Set()) {
  const refs = (deletedLayers ?? [])
    .map((l) => l?.sourceTxtRef)
    .filter((r) => r && Number.isInteger(r.paragraphIndex));
  if (refs.length === 0) return false;
  const source = getTxtSource();
  if (!source) return false;

  const hasRemainingLayerForRef = (pageNumber, paragraphIndex) => getNewLayers().some((layer) => {
    if (!layer?.tempId || excludeTempIds.has(layer.tempId)) return false;
    const ref = layer?.sourceTxtRef;
    if (!ref) return false;
    const refPage = ref.pageNumber == null ? null : Number(ref.pageNumber);
    return refPage === pageNumber && ref.paragraphIndex === paragraphIndex;
  });

  // ページごとに分けて、paragraphIndex の降順で処理する。
  // 降順にすると「先に下を消す → 上の index は不変」で重複補正が不要になる。
  const byPage = new Map();
  for (const r of refs) {
    const key = r.pageNumber == null ? "__null__" : String(r.pageNumber);
    if (!byPage.has(key)) byPage.set(key, []);
    byPage.get(key).push(r);
  }

  let content = source.content;
  let changed = false;
  for (const [key, list] of byPage) {
    const pageNumber = key === "__null__" ? null : Number(key);
    const sortedDesc = list.slice().sort((a, b) => b.paragraphIndex - a.paragraphIndex);
    // 同一段落を複数レイヤーが指していた場合は重複削除を避けるため Set で 1 回ずつ。
    const seen = new Set();
    for (const r of sortedDesc) {
      if (seen.has(r.paragraphIndex)) continue;
      seen.add(r.paragraphIndex);
      // カット&ペースト等で同じ sourceTxtRef を別レイヤーがまだ参照している場合、
      // 元レイヤー削除に合わせて TXT 段落まで消すと、残った貼り付け先も同期で巻き込まれる。
      if (hasRemainingLayerForRef(pageNumber, r.paragraphIndex)) continue;
      const next = deleteBlockFromContent(content, pageNumber, r.paragraphIndex);
      if (next == null || next === content) continue;
      content = next;
      changed = true;
      // 残レイヤーの paragraphIndex 補正（同ページかつ削除位置より後ろ）
      for (const layer of getNewLayers().slice()) {
        if (excludeTempIds.has(layer.tempId)) continue;
        const ref = layer?.sourceTxtRef;
        if (!ref) continue;
        const refPage = ref.pageNumber == null ? null : Number(ref.pageNumber);
        if (refPage !== pageNumber) continue;
        if (ref.paragraphIndex > r.paragraphIndex) {
          updateNewLayer(layer.tempId, {
            sourceTxtRef: { ...ref, paragraphIndex: ref.paragraphIndex - 1 },
          });
        }
      }
    }
  }

  if (changed) {
    setTxtSource({ name: source.name, content });
  }
  return changed;
}

// content をページマーカーで区切り、pageNumber に対応するセクション内で
// oldText の最初の出現を newText に置換した結果を返す。一致しなければ null。
// pageNumber == null（マーカー無し原稿）のときは content 全体を対象にする。
// 改行は内部で LF 統一して比較・置換し、結果も LF で返す。
export function replaceBlockInContent(content, pageNumber, oldText, newText) {
  const norm = (content ?? "").replace(/\r\n?/g, "\n");
  const oldLF = (oldText ?? "").replace(/\r\n?/g, "\n");
  if (!oldLF) return null;

  if (pageNumber == null) {
    const idx = norm.indexOf(oldLF);
    if (idx < 0) return null;
    return norm.slice(0, idx) + newText + norm.slice(idx + oldLF.length);
  }

  const re = new RegExp(PAGE_MARKER_RE.source, "gi");
  let sectionStart = -1;
  let sectionEnd = norm.length;
  let inTargetPage = false;
  let m;
  while ((m = re.exec(norm)) !== null) {
    const num = toHalfWidthInt(m[1]);
    if (inTargetPage) {
      sectionEnd = m.index;
      break;
    }
    if (num === pageNumber) {
      inTargetPage = true;
      sectionStart = m.index + m[0].length;
    }
  }
  if (!inTargetPage) return null;
  const idx = norm.slice(sectionStart, sectionEnd).indexOf(oldLF);
  if (idx < 0) return null;
  const absStart = sectionStart + idx;
  return norm.slice(0, absStart) + newText + norm.slice(absStart + oldLF.length);
}

// 半角英数字 (0-9 / A-Z / a-z) を全角 (０-９ / Ａ-Ｚ / ａ-ｚ) に変換する。
// 縦書きの写植では半角を縦に並べるとレイアウトが崩れるため、
// direction === "vertical" かつ環境設定 verticalHalfToFullEnabled が true の
// ときだけ変換する (横書き / OFF は素通し)。冪等動作（全角入力は対象外）。
//
// 変換テーブル:
//   U+0030 - U+0039 (0-9)   → U+FF10 - U+FF19 (０-９)   オフセット +0xFEE0
//   U+0041 - U+005A (A-Z)   → U+FF21 - U+FF3A (Ａ-Ｚ)   オフセット +0xFEE0
//   U+0061 - U+007A (a-z)   → U+FF41 - U+FF5A (ａ-ｚ)   オフセット +0xFEE0
//
// 呼出経路: commitNewTxtInput（新規入力）/ auto-place.js mapBlockToNewLayer
// （自動配置）/ auto-place.js syncPlacedFromTxt（自動配置済みレイヤーの追従）。
// 原稿テキスト (state.txtSource.content) 自体は触らない設計（原稿は元データを
// 保持、レイヤー側だけ全角化）。
function replaceBlockAtIndexInContent(content, pageNumber, paragraphIndex, newText) {
  if (!Number.isInteger(paragraphIndex) || paragraphIndex < 0) return null;
  const norm = (content ?? "").replace(/\r\n?/g, "\n");
  const parsed = parsePages(norm);
  const nextBlock = String(newText ?? "").replace(/\r\n?/g, "\n").trim();

  if (!parsed.hasMarkers) {
    const blocks = splitBlocksRaw(norm);
    if (paragraphIndex >= blocks.length) return null;
    blocks[paragraphIndex] = nextBlock;
    return blocks.filter((b) => b.length > 0).join("\n\n");
  }

  if (!Number.isInteger(pageNumber)) return null;
  const re = new RegExp(PAGE_MARKER_RE.source, "gi");
  let sectionStart = -1;
  let sectionEnd = norm.length;
  let inTargetPage = false;
  let m;
  while ((m = re.exec(norm)) !== null) {
    const num = toHalfWidthInt(m[1]);
    if (inTargetPage) {
      sectionEnd = m.index;
      break;
    }
    if (num === pageNumber) {
      inTargetPage = true;
      sectionStart = m.index + m[0].length;
    }
  }
  if (!inTargetPage) return null;

  const sectionText = norm.slice(sectionStart, sectionEnd);
  const blocks = splitBlocksRaw(sectionText);
  if (paragraphIndex >= blocks.length) return null;
  blocks[paragraphIndex] = nextBlock;
  const kept = blocks.filter((b) => b.length > 0);
  const newSection = kept.length === 0 ? "\n" : `\n${kept.join("\n\n")}\n`;
  return norm.slice(0, sectionStart) + newSection + norm.slice(sectionEnd);
}

export function syncPlacedLayerTextToSource(layer, nextText) {
  const ref = layer?.sourceTxtRef;
  if (!ref || !Number.isInteger(ref.paragraphIndex)) return false;
  const source = getTxtSource();
  if (!source) return false;
  // PSD 上のレイヤー直接編集では、空行は「同じ吹き出し内で一行空ける」
  // 意図で使われる。原稿テキスト側は空行を段落区切りとして扱うため、
  // ここで逆同期すると元段落が分割され、配置済みレイヤーが前半だけに
  // 追従して文字が欠ける。原稿パネル側の分割配置は別経路で維持する。
  if (/\n[ \t\u3000]*\n/.test(String(nextText ?? "").replace(/\r\n?/g, "\n"))) return false;
  const nextContent = replaceBlockAtIndexInContent(
    source.content,
    Number.isInteger(ref.pageNumber) ? ref.pageNumber : null,
    ref.paragraphIndex,
    nextText,
  );
  if (nextContent == null || nextContent === source.content) return false;
  setTxtSource({ name: source.name, content: nextContent });
  setTxtDirty(true);
  return true;
}

export function convertHalfToFullForVertical(text, direction) {
  const s = String(text ?? "");
  if (direction !== "vertical") return s;
  if (getDefault("verticalHalfToFullEnabled") === false) return s;
  return s.replace(/[\x21-\x7E]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) + 0xFEE0),
  );
}

// 新規入力テキストを「現在ページの末尾」に追記し、新しい content と
// その新パラグラフが visible blocks 上で持つ paragraphIndex を返す。
//
// ケース別:
//   1) マーカー無し原稿: content 全体を 1 セクション扱い、末尾に追記。
//      paragraphIndex = 既存ブロック数（追記後の最後の index）
//   2) マーカー有り + 対象ページのセクション存在: そのセクション末尾に追記。
//      paragraphIndex = そのページの既存ブロック数
//   3) マーカー有り + 対象ページのマーカー無し: 末尾に新しい <<NPage>> セクションを生成。
//      paragraphIndex = 0
export function appendBlockToCurrentPageContent(content, pageNumber, newText) {
  const norm = (content ?? "").replace(/\r\n?/g, "\n");
  const trimmedText = String(newText ?? "").trim();
  if (!trimmedText) return { content: norm, paragraphIndex: -1 };

  const parsed = parsePages(norm);

  // ケース 1: マーカー無し
  if (!parsed.hasMarkers) {
    const existing = splitBlocksRaw(norm);
    const newContent = existing.length > 0
      ? `${existing.join("\n\n")}\n\n${trimmedText}`
      : trimmedText;
    return { content: newContent, paragraphIndex: existing.length };
  }

  // ケース 2: マーカー有り + 対象ページが存在
  const re = new RegExp(PAGE_MARKER_RE.source, "gi");
  let sectionStart = -1;
  let sectionEnd = norm.length;
  let inTarget = false;
  let m;
  while ((m = re.exec(norm)) !== null) {
    const num = toHalfWidthInt(m[1]);
    if (inTarget) { sectionEnd = m.index; break; }
    if (num === pageNumber) {
      inTarget = true;
      sectionStart = m.index + m[0].length;
    }
  }

  if (inTarget) {
    const sectionText = norm.slice(sectionStart, sectionEnd);
    const sectionBlocks = splitBlocksRaw(sectionText);
    const newSectionText = sectionBlocks.length > 0
      ? `\n${sectionBlocks.join("\n\n")}\n\n${trimmedText}\n`
      : `\n${trimmedText}\n`;
    const newContent = norm.slice(0, sectionStart) + newSectionText + norm.slice(sectionEnd);
    return { content: newContent, paragraphIndex: sectionBlocks.length };
  }

  // ケース 3: 対象ページマーカー無し → 末尾に新セクション作成
  const trimmedNorm = norm.replace(/\n+$/, "");
  const sep = trimmedNorm.length > 0 ? "\n\n" : "";
  const newContent = `${trimmedNorm}${sep}<<${pageNumber}Page>>\n\n${trimmedText}\n`;
  return { content: newContent, paragraphIndex: 0 };
}

// 「新規テキストを入力欄から確定」ハンドラ。
// PSD ページの幾何中心にテキストフレーム (newLayer) を生成し、原稿本文にも追記して
// sourceTxtRef でリンクする。原稿編集 → 配置済みフレームの追従は auto-place.js が担当。
//
// inputEl: 入力ソースの textarea/input element。サイドパネルの #txt-new-input でも、
//          エディタモードの #editor-new-input でも、同じ commit ロジックで処理する。
export function commitNewTxtInput({ inputEl } = {}) {
  if (!inputEl) inputEl = $("txt-new-input");
  if (!inputEl) return;
  const text = (inputEl.value ?? "").trim();
  if (!text) return;

  // V ツール統合後は「新規テキスト方向」トグルから direction を取得する。
  const direction = getNewTextDirection();
  const sizePt = getTextSize();
  const leadingPct = getLeadingPct();
  // 縦書きのときは半角英数字 (0-9 / A-Z / a-z) を全角に置換 (横書き / 設定 OFF は素通し)。
  // 配置レイヤーの contents と原稿本文の追記内容、両方に同じ変換後テキストを使う
  // ことで、原稿 dblclick 編集 → scan-place の syncPlacedFromTxt 連動でも整合性を保つ。
  const placedText = convertHalfToFullForVertical(text, direction);

  // 【PSD 未読込時の挙動】原稿テキストへの追記のみを行い、配置レイヤーは作らない。
  // 後で PSD を読み込んで自動配置を実行すると、auto-place.js の buildPlacementPlan
  // 側で「吹き出しに対応しない余り TXT は PSD ページ中央に配置」される。
  const pages = getPages();
  const hasPsd = pages.length > 0;
  const pageIdx = hasPsd ? getCurrentPageIndex() : 0;
  const psdPage = hasPsd ? pages[pageIdx] : null;
  // 原稿側のページ番号: PSD ありなら 1-based の現在ページ、PSD 未読込なら
  // getActivePageNumber() で PDF/TXT 由来のページ番号を取得（無ければ null）。
  const pageNumber = hasPsd ? (pageIdx + 1) : getActivePageNumber();

  let placementCoords = null;
  if (psdPage) {
    placementCoords = centerTopLeft(
      psdPage,
      { contents: placedText, sizePt, direction, leadingPct },
      psdPage.width / 2,
      psdPage.height / 2,
    );
  }

  withHistoryTransient(() => {
    // 1) 原稿本文に追記 (txtSource が null なら空 content で初期化)
    const src = getTxtSource() ?? { name: "新規テキスト.txt", content: "" };
    const { content: newContent, paragraphIndex } =
      appendBlockToCurrentPageContent(src.content, pageNumber, placedText);
    setTxtSource({ name: src.name, content: newContent });

    // 2) PSD あり時のみ中央配置のレイヤー追加 (sourceTxtRef でリンク)
    if (psdPage && placementCoords) {
      addNewLayer({
        psdPath: psdPage.path,
        x: placementCoords.x,
        y: placementCoords.y,
        contents: placedText,
        fontPostScriptName: getCurrentFont() || null,
        sizePt, direction, leadingPct,
        strokeColor: getStrokeColor(),
        strokeWidthPx: getStrokeWidthPx(),
        fillColor: getFillColor(),
        sourceTxtRef: { pageNumber, paragraphIndex },
      });
    }
  });

  inputEl.value = "";
  // サイドパネル / エディタの両方で disabled 状態を更新する。
  // syncNewInputAvailability は #txt-new-input 専用なので、自身の inputEl が
  // それと一致しなくても呼び捨てで OK（自身は手動でクリア後の availability を反映）。
  syncNewInputAvailability();
  syncNewInputAvailabilityFor(inputEl);
  if (hasPsd) {
    refreshAllOverlays();
    rebuildLayerList();
  }
  // 連続入力できるよう textarea にフォーカスを残す
  inputEl.focus();
}

// エディタ段落を空行で分割し、空行より後ろのパートを PSD ページ中央へ新規配置する。
// editor-pane.js の blur ハンドラから呼ばれる（commitNewTxtInput と同じ配置機構を再利用）。
// 前半（parts[0]）は元の段落のまま。元段落に配置済みレイヤーがあれば syncPlacedFromTxt が
// 前半テキストへ自動追従する。後続段落の paragraphIndex は挿入分だけ +shift して linkage を維持。
//
// offset: 元段落の content 内オフセット, original: 元段落の raw テキスト,
// parts: 空行で分割した段落配列 ([0]=前半 / [1..]=新規), splitIndex: 元段落の paragraphIndex,
// pageNumber: 元段落のページ番号（markered なら 1-based 数値, markerless なら null）。
// 戻り値: 分割・反映できたら true、検証失敗等で何もしなければ false。
export function splitTxtBlockAndPlace(offset, original, parts, splitIndex, pageNumber) {
  const source = getTxtSource();
  if (!source) return false;
  if (!Number.isInteger(offset) || !Number.isInteger(splitIndex)) return false;

  // 各 part は前後改行のみ trim・空は除外（再描画 splitBlocksWithOffsets の trim と一致）。
  const cleanParts = (parts ?? [])
    .map((p) => String(p ?? "").replace(/^\n+|\n+$/g, ""))
    .filter((p) => p.length > 0);
  if (cleanParts.length < 2) return false;

  const content = (source.content ?? "").replace(/\r\n?/g, "\n");
  const orig = String(original ?? "").replace(/\r\n?/g, "\n");
  if (!orig || content.slice(offset, offset + orig.length) !== orig) return false;
  const joined = cleanParts.join("\n\n");
  if (joined === orig) return false;
  const newContent = content.slice(0, offset) + joined + content.slice(offset + orig.length);
  const newParts = cleanParts.slice(1);

  // 配置先 PSD ページ / sourceTxtRef.pageNumber / cascade 対象ページの決定
  // （commitNewTxtInput と同じ算出。markered=数値ページ, markerless=現在ページ基準）。
  const pages = getPages();
  const hasPsd = pages.length > 0;
  const markered = Number.isInteger(pageNumber) && pageNumber > 0;
  let placePage = null;
  let refPageNumber = null;
  let cascadePage = null;
  if (markered) {
    refPageNumber = pageNumber;
    cascadePage = pageNumber;
    placePage = hasPsd ? (pages[pageNumber - 1] ?? null) : null;
  } else {
    const pageIdx = hasPsd ? getCurrentPageIndex() : 0;
    refPageNumber = hasPsd ? (pageIdx + 1) : getActivePageNumber();
    cascadePage = null;
    placePage = hasPsd ? (pages[pageIdx] ?? null) : null;
  }

  const sourceLayer = placePage
    ? getNewLayersForPsd(placePage.path).find((layer) => {
        const ref = layer?.sourceTxtRef;
        if (!ref || !Number.isInteger(ref.paragraphIndex)) return false;
        if (ref.paragraphIndex !== splitIndex) return false;
        if (markered) return Number(ref.pageNumber) === refPageNumber;
        return true;
      }) ?? null
    : null;
  const direction = sourceLayer?.direction ?? getNewTextDirection();
  const sizePt = sourceLayer?.sizePt ?? getTextSize();
  const leadingPct = sourceLayer?.leadingPct ?? getLeadingPct();
  const fontPostScriptName = sourceLayer?.fontPostScriptName ?? getCurrentFont() ?? null;
  const strokeColor = sourceLayer?.strokeColor ?? getStrokeColor();
  const strokeWidthPx = sourceLayer?.strokeWidthPx ?? getStrokeWidthPx();
  const fillColor = sourceLayer?.fillColor ?? getFillColor();
  const shift = newParts.length;
  const sourceTempId = sourceLayer?.tempId ?? null;
  const clonePlain = (value) => {
    if (value == null) return value;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return value;
    }
  };
  const existingLayerSnapshots = getNewLayers()
    .map((layer) => clonePlain(layer))
    .filter((layer) => layer?.tempId);

  withHistoryTransient(() => {
    // 1) 挿入カスケード: 同ページ・splitIndex より後ろの layer の paragraphIndex を +shift。
    //    （削除側 deleteTxtBlockByIndex / cascadeRemoveTxtForLayers の -1 の逆）
    const cmpPage = cascadePage == null ? null : Number(cascadePage);
    for (const layer of getNewLayers().slice()) {
      const ref = layer?.sourceTxtRef;
      if (!ref) continue;
      const refPage = ref.pageNumber == null ? null : Number(ref.pageNumber);
      if (markered && refPage !== cmpPage) continue;
      if (ref.paragraphIndex > splitIndex) {
        updateNewLayer(layer.tempId, {
          sourceTxtRef: { ...ref, paragraphIndex: ref.paragraphIndex + shift },
        });
      }
    }

    // 2) 空行より後ろの各パートを、別テキストとして PSD ページ中央へ新規配置。
    if (placePage) {
      newParts.forEach((part, i) => {
        const placedText = convertHalfToFullForVertical(part, direction);
        const coords = centerTopLeft(
          placePage,
          { contents: placedText, sizePt, direction, leadingPct },
          placePage.width / 2,
          placePage.height / 2,
        );
        addNewLayer({
          psdPath: placePage.path,
          x: coords.x,
          y: coords.y,
          contents: placedText,
          fontPostScriptName,
          sizePt, direction, leadingPct,
          strokeColor,
          strokeWidthPx,
          fillColor,
          sourceTxtRef: { pageNumber: refPageNumber, paragraphIndex: splitIndex + 1 + i },
        });
      });
    }

    // 3) content 確定 → onTxtSourceChange 発火（syncPlacedFromTxt が整った index で前半 layer を
    //    part0 へ追従、renderViewer がエディタ分割表示）。layer 調整を先に済ませてあるので整合。
    setTxtSource({ name: source.name, content: newContent });
    // 分割時は「既存テキストを動かさない/変えない」が仕様。
    // setTxtSource の同期で既存レイヤーが再センタリング・再同期されても、ここで元状態へ戻す。
    const currentLayersById = new Map(getNewLayers().map((layer) => [layer.tempId, layer]));
    for (const snapshot of existingLayerSnapshots) {
      const current = currentLayersById.get(snapshot.tempId);
      if (!current) continue;
      if (snapshot.tempId === sourceTempId) {
        updateNewLayer(snapshot.tempId, { x: snapshot.x, y: snapshot.y });
      } else {
        updateNewLayer(snapshot.tempId, {
          ...snapshot,
          sourceTxtRef: current.sourceTxtRef,
        });
      }
    }
    setTxtDirty(true);
  });

  if (placePage) {
    try { refreshAllOverlays(); } catch (_) {}
    try { rebuildLayerList(); } catch (_) {}
  }
  return true;
}

// 任意の input/textarea + 関連ボタン (id 規約: <inputId>-btn) の disabled 状態を更新。
//   - input 自体は常に enabled（PSD 未読込でも下書きできるようにする）
//   - ボタンは入力内容が無いときだけ disabled
//   - PSD 未読込時の配置押下は commitNewTxtInput 内で「原稿追記のみ」モードに分岐し、
//     後の自動配置で「画像中央」配置の対象となる（auto-place.js: mapTxtToPageCenter）
//
// 旧仕様は input まで disabled にしていたが、PSD 未読込状態で「ボタンが押せない」
// のと「文字が打てない」のがユーザーには区別できず「機能していない」と感じる原因
// だった。さらに「画像スキャン完了 + PSD 未読込」で原稿を先に書き溜めるフロー
// にも対応するため、PSD 必須の制約自体を撤去し、入力 → 原稿追記が常に動作する設計に。
export function syncNewInputAvailabilityFor(inputEl) {
  if (!inputEl) return;
  inputEl.disabled = false;
  const hasText = (inputEl.value ?? "").trim().length > 0;
  const btnId = `${inputEl.id}-btn`;
  const btn = document.getElementById(btnId);
  if (btn) btn.disabled = !hasText;
}

export function isQuickAddTextShortcut(e) {
  if (!e || e.isComposing || e.keyCode === 229) return false;
  if (!(e.ctrlKey || e.metaKey)) return false;
  return e.key === "Enter" || e.code === "Enter" || e.code === "NumpadEnter";
}

export function consumeQuickAddTextShortcut(e) {
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation?.();
}

export function shouldHandleBlurredQuickAddShortcut(e, inputEl) {
  if (!isQuickAddTextShortcut(e)) return false;
  if (!inputEl || inputEl.disabled) return false;
  if (!(inputEl.value ?? "").trim()) return false;
  const target = e.target;
  if (target === inputEl) return false;
  if (target && inputEl.contains?.(target)) return false;
  const tag = target?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return false;
  return true;
}

// PSD 読込状態 + 入力内容に応じて textarea / button の disabled を切替。
// サイドパネルの #txt-new-input + #txt-new-input-btn を更新する従来 API。
function syncNewInputAvailability() {
  const inputEl = $("txt-new-input");
  if (!inputEl) return;
  syncNewInputAvailabilityFor(inputEl);
}

function selectBlock(idx, text) {
  setTxtSelectedBlockIndex(idx);
  setTxtSelection(text);
  const viewer = $("txt-source-viewer");
  for (const el of viewer.querySelectorAll(".txt-block")) {
    el.classList.toggle("selected", el.dataset.blockIndex === String(idx));
  }
  // 削除ボタン (#delete-txt-btn) は選択中ブロックがある時だけ有効。
  const deleteBtn = $("delete-txt-btn");
  if (deleteBtn) deleteBtn.disabled = idx == null;
  // 原稿ブロック選択に対応する PSD 配置レイヤーも選択し、テキストプロパティ（バッジ）を表示。
  // 未配置ブロックならレイヤー選択をクリア。クリック / cycleTxtBlockSelection の両経路で同期。
  selectLayerForBlock(idx);
}

// 現在ページの配置済みレイヤーから、原稿ブロック idx に対応する layer を探す。
// syncTxtSelectionToLayer の逆向き（block → layer）。一致しなければ null。
function findPlacedLayerForBlock(blockIndex) {
  if (!Number.isInteger(blockIndex) || blockIndex < 0) return null;
  const pageIdx = getCurrentPageIndex();
  const page = getPages()[pageIdx];
  if (!page) return null;
  const { blocks, hasMarkers, pageNumber } = getVisibleBlocks();
  if (blockIndex >= blocks.length) return null;
  const nl = getNewLayersForPsd(page.path).find((l) => {
    const ref = l?.sourceTxtRef;
    if (!ref || !Number.isInteger(ref.paragraphIndex)) return false;
    const pageMatch = !hasMarkers || ref.pageNumber === pageNumber;
    return pageMatch && ref.paragraphIndex === blockIndex;
  });
  return nl ? { pageIndex: pageIdx, layerId: nl.tempId } : null;
}

// 原稿ブロック idx に対応する配置レイヤーを選択（無ければ選択クリア）してバッジ／一覧を更新。
function selectLayerForBlock(idx) {
  const found = idx == null ? null : findPlacedLayerForBlock(idx);
  if (found) setSelectedLayer(found.pageIndex, found.layerId);
  else setSelectedLayers([]);
  try { refreshAllOverlays(); } catch (_) {}
  try { rebuildLayerList(); } catch (_) {}
}

// プレーン ↑/↓ を「原稿テキスト選択の移動」に振り替えてよい状態かを判定する。
// 「選択中ブロックの対応レイヤー === 現在の選択レイヤー」のときだけ true。
// ユーザーがキャンバスで別レイヤーを選び直すと自動的に false になり、↑/↓ は従来の nudge に戻る。
export function isTxtBlockSelectionActive() {
  // editor モードはサイドバー原稿パネルが非表示なので対象外（stale 選択での誤発火を防ぐ）。
  if (getParallelViewMode() === "editor") return false;
  const idx = getTxtSelectedBlockIndex();
  if (idx == null || !getTxtSource()) return false;
  const found = findPlacedLayerForBlock(idx);
  const sel = getSelectedLayer();
  if (found) {
    return !!sel && getSelectedLayers().length === 1 && sel.layerId === found.layerId;
  }
  // 未配置ブロック: レイヤー未選択のときだけ原稿ナビを有効にする。
  return !sel;
}

// 原稿テキスト (txt-source-viewer) の選択ブロックを Alt+↑/↓ で順送り / 逆送りする。
// 引数: delta (+1 次へ / -1 前へ)
// - 現在ページの可視ブロック内をループ (末尾 → 先頭の wrap-around)
// - 選択なし状態で呼ばれた場合は方向に応じて先頭 / 末尾を選択
// - ブロックが 0 件のときは false、選択を切替えたら true
// - 選択ブロックを scrollIntoView してビューア内をスクロール
export function cycleTxtBlockSelection(delta) {
  const viewer = $("txt-source-viewer");
  if (!viewer || viewer.hidden) return false;
  if (!getTxtSource()) return false;
  const { blocks } = getVisibleBlocks();
  if (blocks.length === 0) return false;

  const cur = getTxtSelectedBlockIndex();
  let nextIdx;
  if (cur == null || cur < 0 || cur >= blocks.length) {
    nextIdx = delta > 0 ? 0 : blocks.length - 1;
  } else {
    nextIdx = (cur + delta + blocks.length) % blocks.length;
  }
  selectBlock(nextIdx, blocks[nextIdx]);
  const targetEl = viewer.querySelector(`.txt-block[data-block-index="${nextIdx}"]`);
  if (targetEl) targetEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
  return true;
}

// レイヤー選択切替（矢印キー ↑/↓ 等）に追従して txt-source-viewer の選択 / フォーカスを同期する。
// 引数: pageIndex (PSD ページ index, 0-based), layerId (既存=number / 新規=tempId 文字列)
// - 対象レイヤーが sourceTxtRef を持ち、その paragraphIndex が現在表示中の visible blocks
//   範囲内なら、その block を selected + scrollIntoView。
// - sourceTxtRef が無い / 現ページの可視段落と合わない場合は TXT 選択を解除し
//   .selected ハイライトを全クリア。
export function syncTxtSelectionToLayer(pageIndex, layerId) {
  const viewer = $("txt-source-viewer");
  if (!viewer || viewer.hidden) return;
  const pages = getPages();
  const page = pages[pageIndex];
  if (!page) return;

  // sourceTxtRef は新規レイヤー (tempId 文字列) のみが持つ。
  let ref = null;
  if (typeof layerId === "string") {
    const nl = getNewLayersForPsd(page.path).find((l) => l.tempId === layerId);
    ref = nl?.sourceTxtRef ?? null;
  }

  // 現ページに対応する visible blocks を取り出して、paragraphIndex が範囲内か検証。
  // 範囲外 / ref 無し → TXT 選択クリア。
  const { blocks, hasMarkers, pageNumber } = getVisibleBlocks();
  let targetIdx = null;
  let targetText = null;
  if (ref && Number.isInteger(ref.paragraphIndex)) {
    // markers 有りなら ref.pageNumber と viewer の現在ページが一致するときだけ採用。
    const pageMatch = !hasMarkers || ref.pageNumber === pageNumber;
    if (pageMatch && ref.paragraphIndex >= 0 && ref.paragraphIndex < blocks.length) {
      targetIdx = ref.paragraphIndex;
      targetText = blocks[ref.paragraphIndex];
    }
  }

  if (targetIdx == null) {
    // クリア。selectBlock(null, "") と等価だが scroll は不要。
    setTxtSelectedBlockIndex(null);
    setTxtSelection("");
    for (const el of viewer.querySelectorAll(".txt-block.selected")) {
      el.classList.remove("selected");
    }
    const deleteBtn = $("delete-txt-btn");
    if (deleteBtn) deleteBtn.disabled = true;
    return;
  }

  // 選択 + ハイライト + scrollIntoView
  setTxtSelectedBlockIndex(targetIdx);
  setTxtSelection(targetText);
  for (const el of viewer.querySelectorAll(".txt-block")) {
    el.classList.toggle("selected", el.dataset.blockIndex === String(targetIdx));
  }
  const targetEl = viewer.querySelector(`.txt-block[data-block-index="${targetIdx}"]`);
  if (targetEl) targetEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
  const deleteBtn = $("delete-txt-btn");
  if (deleteBtn) deleteBtn.disabled = false;
}

export async function pickTxtPath(opts = {}) {
  const { openFileDialog } = await import("./file-picker.js");
  const picked = await openFileDialog({
    mode: "open",
    multiple: false,
    title: "テキストを開く",
    filters: [{ name: "Text", extensions: ["txt"] }],
    // 呼び出し側が rememberKey を上書き可能（写植フローの 3 カードで共有フォルダ記憶に使う）。
    rememberKey: opts.rememberKey ?? "txt-open",
  });
  return typeof picked === "string" ? picked : null;
}

export async function pickTxtSavePath(defaultName) {
  const { openFileDialog } = await import("./file-picker.js");
  const picked = await openFileDialog({
    mode: "save",
    title: "テキストを TXT として保存",
    defaultName: defaultName || "untitled.txt",
    filters: [{ name: "Text", extensions: ["txt"] }],
    rememberKey: "txt-save",
  });
  return typeof picked === "string" ? picked : null;
}

export function ensureTxtExtension(path) {
  return /\.txt$/i.test(path) ? path : `${path}.txt`;
}

async function handleSaveBtn() {
  const source = getTxtSource();
  if (!source) return;
  if (txtSourceSaveInflight) {
    toast("保存処理中です。完了までお待ちください", { kind: "info", duration: 1800 });
    return;
  }
  txtSourceSaveInflight = true;
  const saveBtn = $("save-txt-btn");
  if (saveBtn) saveBtn.disabled = true;
  let scriptOutputPath;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const defaultName = source.name || (getTxtFilePath() ? baseName(getTxtFilePath()) : "") || "untitled.txt";
    scriptOutputPath = await invoke("save_editor_text_to_script_output", {
      content: source.content,
      defaultName,
    });
    setTxtFilePath(scriptOutputPath);
    setTxtDirty(false);
  } catch (e) {
    console.error(e);
    toast(`保存失敗: ${e?.message ?? e}`, { kind: "error" });
    txtSourceSaveInflight = false;
    if (saveBtn) saveBtn.disabled = !getTxtSource();
    return;
  }

  txtSourceSaveInflight = false;
  if (saveBtn) saveBtn.disabled = !getTxtSource();

  const displayName = baseName(scriptOutputPath);
  await notifyDialog({
    title: "保存が完了しました",
    message: `${displayName}\n${scriptOutputPath}`,
    okLabel: "閉じる",
    kind: "success",
    primaryAction: {
      label: "ProGenを開く",
      kind: "place",
      onClick: async () => {
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("launch_progen_with_text", { textPath: scriptOutputPath });
        } catch (e) {
          console.error(e);
          toast(`ProGen起動失敗: ${e?.message ?? e}`, { kind: "error" });
        }
      },
    },
  });
  return;
  let outputPath;
  try {
    outputPath = await pickTxtSavePath(source.name);
  } catch (e) {
    console.error(e);
    toast(`保存先選択失敗: ${e?.message ?? e}`, { kind: "error" });
    return;
  }
  if (!outputPath) return;
  outputPath = ensureTxtExtension(outputPath);
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke(`export_${RUNTIME_TOKEN}_text`, { content: source.content, outputPath });
    // 保存先を以後の「保存（上書き）」のターゲットとして state に記憶。
    setTxtFilePath(outputPath);
    setTxtDirty(false);
    toast("テキストを保存しました", { kind: "success", duration: 2000 });
  } catch (e) {
    console.error(e);
    toast(`保存失敗: ${e?.message ?? e}`, { kind: "error" });
  }
}

async function readTxtFromPath(path) {
  const { invoke } = await import("@tauri-apps/api/core");
  const bytes = await invoke("read_binary_file", { path });
  return decodeBytes(new Uint8Array(bytes));
}

async function handleOpenBtn() {
  try {
    const path = await pickTxtPath();
    if (!path) return;
    await loadTxtFromPath(path);
  } catch (e) {
    console.error(e);
    toast(`テキスト読込失敗: ${e.message ?? e}`, { kind: "error", duration: 4500 });
  }
}

export async function loadTxtFromPath(path) {
  try {
    const content = await readTxtFromPath(path);
    setTxtSource({ name: baseName(path), content });
    // ファイル経由はパスが取れるので、エディタの「保存」（上書き）対象として記憶。
    setTxtFilePath(path);
    setTxtDirty(false);
    renderViewer();
  } catch (e) {
    console.error(e);
    toast(`テキスト読込失敗: ${e.message ?? e}`, { kind: "error", duration: 4500 });
  }
}

// 文字列バッファから直接 TXT パネルに流し込むヘルパー。
// 画像スキャン 画像スキャン 結果 (scan-extract.js) や、その他のプログラム生成テキストから呼ぶ。
export function loadTxtFromContent(name, content) {
  setTxtSource({ name: name || "untitled.txt", content: content || "" });
  // 元ファイルが無い経路（画像スキャン 結果など）。エディタは「別名で保存」だけが利用可。
  setTxtFilePath(null);
  setTxtDirty(false);
  renderViewer();
}

async function handleFileDropped(file) {
  try {
    const buf = await file.arrayBuffer();
    const content = decodeBytes(new Uint8Array(buf));
    setTxtSource({ name: file.name, content });
    // ブラウザ File API 経由は full path が取れない。エディタは「別名で保存」のみ。
    setTxtFilePath(null);
    setTxtDirty(false);
    renderViewer();
  } catch (e) {
    console.error(e);
    toast(`テキスト読込失敗: ${e.message ?? e}`, { kind: "error", duration: 4500 });
  }
}

function isTxtFile(file) {
  if (!file) return false;
  if (file.type === "text/plain") return true;
  return /\.txt$/i.test(file.name || "");
}

function bindDropzone() {
  const zone = $("txt-source-dropzone");
  if (!zone) return;
  const onDragOver = (e) => {
    if (!e.dataTransfer) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    zone.classList.add("dragover");
  };
  const onDragLeave = () => zone.classList.remove("dragover");
  const onDrop = (e) => {
    e.preventDefault();
    zone.classList.remove("dragover");
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    const txt = Array.from(files).find(isTxtFile);
    if (!txt) {
      toast("テキストファイルを指定してください", { kind: "error" });
      return;
    }
    handleFileDropped(txt);
  };
  zone.addEventListener("dragover", onDragOver);
  zone.addEventListener("dragleave", onDragLeave);
  zone.addEventListener("drop", onDrop);

  const preventWindowDrop = (e) => {
    if (!e.dataTransfer) return;
    if (!zone.contains(e.target)) {
      e.preventDefault();
    }
  };
  window.addEventListener("dragover", preventWindowDrop);
  window.addEventListener("drop", preventWindowDrop);
}

export function initTxtSource() {
  setupEditorExtractSourcePanel();
  $("open-txt-toolbar-btn")?.addEventListener("click", handleOpenBtn);
  onPageIndexChange(() => {
    setTxtSelectedBlockIndex(null);
    setTxtSelection("");
    renderViewer();
    renderExtractSourceViewer();
  });
  // PSD 未読込で見本 (PDF/画像) のみ開いているケースの TXT 連動。
  // PSD 読込中は onPageIndexChange が同期ブリッジ経由でも本体側も発火するため、
  // ここでは PSD 無しのときだけ働かせて二重描画を避ける。
  onPdfPageIndexChange(() => {
    if (getPages().length > 0) return;
    setTxtSelectedBlockIndex(null);
    setTxtSelection("");
    renderViewer();
    renderExtractSourceViewer();
  });
  // PDF doc 自体の読込/解除でも viewer を更新（見本の有無で activePageNumber の判定先が変わるため）。
  onPdfChange(() => {
    if (getPages().length > 0) return;
    renderViewer();
    renderExtractSourceViewer();
  });
  // undo/redo で原稿テキストが復元されたとき viewer を再描画。
  // setTxtSource からも同じ listener が発火する（loadTxtFromPath 等の呼び出し直後の
  // 明示 renderViewer 呼出と二重実行になるが、いずれも同期描画なので副作用なし）。
  onTxtSourceChange(() => renderTxtSourceViewer());
  onParallelViewModeChange(() => syncExtractSourcePanelVisibility());
  onScanExtractTextSourceChange(() => renderExtractSourceViewer());
  onScanExtractTextDiffsChange(() => renderExtractSourceViewer());
  $("clear-txt-btn").addEventListener("click", async () => {
    if (!getTxtSource()) return;
    const ok = await confirmDialog({
      title: "テキストの再読み込み",
      message: "現在のテキストは破棄され、新しいテキストファイルを選択します。続行しますか？",
      confirmLabel: "選び直す",
      kind: "danger",
    });
    if (!ok) return;
    const path = await pickTxtPath();
    // ファイル選択をキャンセルした場合は現在のテキストを保持して何もしない。
    if (!path) return;
    await loadTxtFromPath(path);
  });
  $("save-txt-btn").addEventListener("click", handleSaveBtn);
  $("delete-txt-btn").addEventListener("click", async () => {
    if (!getTxtSource()) return;
    if (getTxtSelectedBlockIndex() == null) return;
    const ok = await confirmDialog({
      title: "テキストの削除",
      message: "選択中のテキストを削除します。よろしいですか？",
      confirmLabel: "削除",
      kind: "danger",
    });
    if (!ok) return;
    if (!deleteSelectedTxtBlock()) return;
    toast("選択中のテキストを削除しました", { kind: "info", duration: 1500 });
  });

  // 新規テキスト入力欄: PSD ページ中央にテキストフレームを生成するショートカット。
  const newInputEl = $("txt-new-input");
  const newInputBtn = $("txt-new-input-btn");
  if (newInputEl) {
    newInputEl.addEventListener("input", syncNewInputAvailability);
    newInputEl.addEventListener("keydown", (e) => {
      if (isQuickAddTextShortcut(e)) {
        consumeQuickAddTextShortcut(e);
        commitNewTxtInput({ inputEl: newInputEl });
      } else if (e.key === "Escape") {
        e.preventDefault();
        if ((newInputEl.value ?? "").length > 0) {
          newInputEl.value = "";
          syncNewInputAvailability();
        } else {
          newInputEl.blur();
        }
      }
    });
  }
  if (newInputBtn) {
    newInputBtn.addEventListener("click", () => commitNewTxtInput({ inputEl: newInputEl }));
  }
  document.addEventListener("keydown", (e) => {
    if (getParallelViewMode() === "editor") return;
    if (!shouldHandleBlurredQuickAddShortcut(e, newInputEl)) return;
    consumeQuickAddTextShortcut(e);
    commitNewTxtInput({ inputEl: newInputEl });
  }, true);
  // PSD 読込状態 + 入力内容で disabled を更新する listener 群。
  // PSD ロード/クリアは psdesign:psd-loaded CustomEvent (main.js が dispatch) と
  // onPageIndexChange の両方で発火する。両方を購読して取りこぼしを防ぐ。
  window.addEventListener("psdesign:psd-loaded", syncNewInputAvailability);
  // 既存の onPageIndexChange listener はこの関数より前に登録済みだが、
  // syncNewInputAvailability は内部で getPages() を見るだけの軽量関数なので
  // 二重 listener にしておく副作用は無い。
  onPageIndexChange(syncNewInputAvailability);

  bindDropzone();
  renderTxtSourceViewer();
  syncNewInputAvailability();
}

