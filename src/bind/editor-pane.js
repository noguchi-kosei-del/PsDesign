import {
  getCurrentPageIndex,
  getPages,
  getParallelViewMode,
  getPdfPageIndex,
  getTxtDirty,
  getTxtFilePath,
  getTxtSource,
  onPageIndexChange,
  onPdfChange,
  onPdfPageIndexChange,
  onTxtDirtyChange,
  onTxtFilePathChange,
  onTxtSourceChange,
  setCurrentPageIndex,
  setPdfPageIndex,
  setTxtDirty,
  setTxtFilePath,
  setTxtSource,
} from "../state.js";
import { getPdfVirtualPageCount } from "../pdf-pages.js";
import { nextPageIndexForTurn } from "../page-navigation.js";
import {
  commitNewTxtInput,
  consumeQuickAddTextShortcut,
  deleteTxtBlockByIndex,
  getActivePageNumber,
  getTxtPageCount,
  isQuickAddTextShortcut,
  moveTxtBlockByIndex,
  shouldHandleBlurredQuickAddShortcut,
  splitTxtBlockAndPlace,
  syncNewInputAvailabilityFor,
} from "../txt-source.js";
import { notifyDialog, toast } from "../ui-feedback.js";
import {
  appendTextWithStyleMarkers,
  getStyleOverrideRangesForTxtRef,
} from "../text-style-markers.js";
import { openContainingFolder } from "../services/open-path.js";
import { baseName } from "../utils/path.js";

const $ = (id) => document.getElementById(id);
const EDITOR_PAGE_MODE_KEY = "psdesign_editor_page_mode";
const PAGE_MARKER_RE = /<<\s*([0-9\uFF10-\uFF19]+)\s*Page\s*>>/gi;

let editorPageMode = loadEditorPageMode();
let editingBlock = false;
let lastEditorBlockSelection = null;
let editorRubyMode = "auto";
let editorQuickAddShortcutBound = false;
let editorParagraphDrag = null;
const editorTextMappings = new WeakMap();

function getEls() {
  return {
    viewer: $("editor-pages-viewer"),
    empty: $("editor-empty"),
    newInput: $("editor-new-input"),
    newInputBtn: $("editor-new-input-btn"),
    save: $("editor-save-btn"),
    rubyPopover: $("editor-ruby-popover"),
    rubyPopoverParent: $("editor-ruby-popover-parent"),
    rubyPopoverInput: $("editor-ruby-popover-input"),
    rubyPopoverApply: $("editor-ruby-popover-apply"),
    rubyPopoverRemove: $("editor-ruby-popover-remove"),
    rubyModeAuto: $("editor-ruby-mode-auto-btn"),
    rubyModeMono: $("editor-ruby-mode-mono-btn"),
    rubyModeGroup: $("editor-ruby-mode-group-btn"),
    filename: $("editor-filename"),
    dirtyDot: $("editor-dirty-dot"),
    pagePrev: $("editor-page-prev-btn"),
    pageNext: $("editor-page-next-btn"),
    pageLabel: $("editor-page-label"),
    pageModeAll: $("editor-page-mode-all"),
    pageModeSingle: $("editor-page-mode-single"),
  };
}

function pageNumLabel(n) {
  return String(n).padStart(2, "0");
}

function loadEditorPageMode() {
  try {
    return localStorage.getItem(EDITOR_PAGE_MODE_KEY) === "single" ? "single" : "all";
  } catch (_) {
    return "all";
  }
}

function syncEditorPageModeButtons() {
  const els = getEls();
  const all = editorPageMode === "all";
  if (els.pageModeAll) {
    els.pageModeAll.classList.toggle("active", all);
    els.pageModeAll.setAttribute("aria-pressed", all ? "true" : "false");
  }
  if (els.pageModeSingle) {
    els.pageModeSingle.classList.toggle("active", !all);
    els.pageModeSingle.setAttribute("aria-pressed", all ? "false" : "true");
  }
}

function setEditorPageMode(mode) {
  editorPageMode = mode === "single" ? "single" : "all";
  try { localStorage.setItem(EDITOR_PAGE_MODE_KEY, editorPageMode); } catch (_) {}
  syncEditorPageModeButtons();
  renderViewer({ scrollToActive: editorPageMode === "all" });
}

function toHalfWidthInt(s) {
  const normalized = String(s).replace(/[\uFF10-\uFF19]/g, (c) => (
    String.fromCharCode(c.charCodeAt(0) - 0xfee0)
  ));
  const n = parseInt(normalized, 10);
  return Number.isFinite(n) ? n : null;
}

function blockFromSegment(segment, absoluteStart) {
  const leading = segment.match(/^\n+/)?.[0]?.length ?? 0;
  const trailing = segment.match(/\n+$/)?.[0]?.length ?? 0;
  const text = segment.slice(leading, segment.length - trailing);
  if (text.length === 0) return null;
  return { text, offset: absoluteStart + leading };
}

function splitBlocksWithOffsets(sectionText, sectionStart) {
  const blocks = [];
  const re = /\n[ \t\u3000]*\n/g;
  let last = 0;
  let m;
  while ((m = re.exec(sectionText)) !== null) {
    const block = blockFromSegment(sectionText.slice(last, m.index), sectionStart + last);
    if (block) blocks.push(block);
    last = m.index + m[0].length;
  }
  const tail = blockFromSegment(sectionText.slice(last), sectionStart + last);
  if (tail) blocks.push(tail);
  return blocks;
}

function buildPageModel(content) {
  const normalized = (content ?? "").replace(/\r\n?/g, "\n");
  const re = new RegExp(PAGE_MARKER_RE.source, "gi");
  const pages = [];
  const pageByNumber = new Map();

  const ensurePage = (pageNumber) => {
    if (!pageByNumber.has(pageNumber)) {
      const page = { pageNumber, blocks: [] };
      pageByNumber.set(pageNumber, page);
      pages.push(page);
    }
    return pageByNumber.get(pageNumber);
  };

  let lastIndex = 0;
  let currentPage = null;
  let hasMarkers = false;
  let match;
  while ((match = re.exec(normalized)) !== null) {
    hasMarkers = true;
    if (currentPage != null) {
      ensurePage(currentPage).blocks.push(
        ...splitBlocksWithOffsets(normalized.slice(lastIndex, match.index), lastIndex),
      );
    }
    currentPage = toHalfWidthInt(match[1]);
    if (currentPage != null) ensurePage(currentPage);
    lastIndex = match.index + match[0].length;
  }

  if (hasMarkers) {
    if (currentPage != null) {
      ensurePage(currentPage).blocks.push(...splitBlocksWithOffsets(normalized.slice(lastIndex), lastIndex));
    }
    return { hasMarkers: true, pages, allBlocks: [], normalized };
  }

  return {
    hasMarkers: false,
    pages: [],
    allBlocks: splitBlocksWithOffsets(normalized, 0),
    normalized,
  };
}

function replaceBlockAtOffset(offset, originalText, newText) {
  if (!Number.isFinite(offset)) return false;
  const source = getTxtSource();
  if (!source) return false;
  const content = (source.content ?? "").replace(/\r\n?/g, "\n");
  const original = (originalText ?? "").replace(/\r\n?/g, "\n");
  const updated = (newText ?? "").replace(/\r\n?/g, "\n");
  if (!original || updated === original) return false;
  if (content.slice(offset, offset + original.length) !== original) return false;
  const nextContent = content.slice(0, offset) + updated + content.slice(offset + original.length);
  setTxtSource({ name: source.name, content: nextContent });
  setTxtDirty(true);
  return true;
}

function replaceSourceRange(absStart, absEnd, originalText, replacement) {
  if (!Number.isInteger(absStart) || !Number.isInteger(absEnd) || absEnd <= absStart) return false;
  const source = getTxtSource();
  if (!source) return false;
  const content = (source.content ?? "").replace(/\r\n?/g, "\n");
  const original = String(originalText ?? "").replace(/\r\n?/g, "\n");
  const next = String(replacement ?? "").replace(/\r\n?/g, "\n");
  if (!original || next === original || original.includes("\n") || next.includes("\n")) return false;
  if (content.slice(absStart, absEnd) !== original) return false;
  const nextContent = content.slice(0, absStart) + next + content.slice(absEnd);
  setTxtSource({ name: source.name, content: nextContent });
  setTxtDirty(true);
  return true;
}

function displayRubySource(raw) {
  const input = String(raw ?? "");
  const displayToRaw = [];
  let text = "";
  let last = 0;
  const re = /｛([^｛｝]+)｝（([^（）]+)）|\{([^{}]+)\}\(([^()]+)\)|\[([^\[\]]+)\]\(([^)]+)\)/g;

  function appendRaw(start, end) {
    for (let i = start; i < end; i += 1) {
      text += input[i];
      displayToRaw.push(i);
    }
  }

  function appendMapped(value, rawStart) {
    const chars = Array.from(String(value ?? ""));
    chars.forEach((ch, idx) => {
      text += ch;
      displayToRaw.push(rawStart + idx);
    });
  }

  let match;
  while ((match = re.exec(input)) !== null) {
    appendRaw(last, match.index);

    const parent = match[1] ?? match[3] ?? match[5] ?? "";
    const ruby = match[2] ?? match[4] ?? match[6] ?? "";
    if (!parent || !ruby) {
      appendRaw(match.index, match.index + match[0].length);
      last = match.index + match[0].length;
      continue;
    }

    const parentStart = match.index + 1;
    const rubyOpenIndex = match.index + 1 + parent.length + 1;
    const rubyStart = rubyOpenIndex + 1;
    appendMapped(parent, parentStart);
    text += "（";
    displayToRaw.push(rubyOpenIndex);
    appendMapped(ruby, rubyStart);
    text += "）";
    displayToRaw.push(match.index + match[0].length - 1);
    last = match.index + match[0].length;
  }

  appendRaw(last, input.length);
  return { text, displayToRaw };
}

function updateEditorBlockSelectionFromDom() {
  const sel = window.getSelection?.();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  let startEl = range.startContainer;
  if (startEl && startEl.nodeType !== Node.ELEMENT_NODE) startEl = startEl.parentElement;
  const block = startEl?.closest?.(".editor-page-paragraph-text");
  if (!block) return null;
  let endEl = range.endContainer;
  if (endEl && endEl.nodeType !== Node.ELEMENT_NODE) endEl = endEl.parentElement;
  if (!endEl?.closest || endEl.closest(".editor-page-paragraph-text") !== block) return null;

  const beforeStart = document.createRange();
  beforeStart.selectNodeContents(block);
  beforeStart.setEnd(range.startContainer, range.startOffset);
  const startInBlock = beforeStart.toString().length;
  const beforeEnd = document.createRange();
  beforeEnd.selectNodeContents(block);
  beforeEnd.setEnd(range.endContainer, range.endOffset);
  const endInBlock = beforeEnd.toString().length;
  if (startInBlock === endInBlock) return null;

  const blockText = block.textContent ?? "";
  const selectedText = blockText.slice(startInBlock, endInBlock);
  if (!selectedText || selectedText.includes("\n")) return null;
  const blockOffset = Number(block.dataset.offset);
  if (!Number.isInteger(blockOffset)) return null;
  const displayToRaw = editorTextMappings.get(block);
  const rawStartInBlock = displayToRaw?.[startInBlock] ?? startInBlock;
  const rawEndAnchor = displayToRaw?.[endInBlock - 1];
  const rawEndInBlock = rawEndAnchor == null ? endInBlock : rawEndAnchor + 1;

  lastEditorBlockSelection = {
    absStart: blockOffset + rawStartInBlock,
    absEnd: blockOffset + rawEndInBlock,
    text: selectedText,
    blockEl: block,
  };
  return lastEditorBlockSelection;
}

// TXT 注記の括弧 3 種。displayRubySource の正規表現と対応させる。
const RUBY_BRACKETS = [
  { open: "｛", close: "｝", rOpen: "（", rClose: "）" },
  { open: "{", close: "}", rOpen: "(", rClose: ")" },
  { open: "[", close: "]", rOpen: "(", rClose: ")" },
];
// ルビ注記の区切り文字。選択文字列にこれらが含まれる場合は新規付与を弾く。
const RUBY_DELIMITER_RE = /[｛｝（）{}()[\]]/;

function normalizedRubyText(value) {
  return String(value ?? "").trim().replace(/[\t\u3000]+/g, " ").replace(/ +/g, " ");
}

function rubyParts(value) {
  return normalizedRubyText(value).split(/[ \u3000]+/).filter(Boolean);
}

function inferEditorRubyMode(parentText, rubyText) {
  const parentLen = Array.from(String(parentText ?? "").replace(/[ \t\u3000]+/g, "")).length;
  const parts = rubyParts(rubyText);
  return parentLen > 0 && /[ \t\u3000]/.test(String(rubyText ?? "")) && parts.length === parentLen
    ? "mono"
    : "group";
}

function formatRubyForEditorMode(parentText, rubyText, mode) {
  const text = normalizedRubyText(rubyText);
  if (!text) return { ok: false, text: "" };
  if (mode === "group") return { ok: true, text: text.replace(/[ \u3000]+/g, "") };
  if (mode !== "mono") return { ok: true, text };

  const parentLen = Array.from(String(parentText ?? "").replace(/[ \t\u3000]+/g, "")).length;
  const parts = rubyParts(text);
  if (parentLen > 0 && parts.length === parentLen) {
    return { ok: true, text: parts.join(" ") };
  }

  const chars = Array.from(text.replace(/[ \u3000]+/g, ""));
  if (parentLen > 0 && chars.length === parentLen) {
    return { ok: true, text: chars.join(" ") };
  }

  return {
    ok: false,
    text,
    reason: `モノルビは親文字数（${parentLen}）とルビの分割数を合わせてください。`,
  };
}

function syncEditorRubyModeButtons(mode = editorRubyMode) {
  const safeMode = mode === "mono" || mode === "group" ? mode : "auto";
  editorRubyMode = safeMode;
  const els = getEls();
  [
    [els.rubyModeAuto, "auto"],
    [els.rubyModeMono, "mono"],
    [els.rubyModeGroup, "group"],
  ].forEach(([btn, key]) => {
    if (!btn) return;
    const active = key === safeMode;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

// 選択範囲 [absStart, absEnd) が、ちょうど既存注記の親文字に一致するか調べる。
// 一致すれば { parent, ruby, fullStart, fullEnd } を返す（注記全体の範囲）。
function detectRubyAnnotationAtSelection(content, absStart, absEnd) {
  if (!Number.isInteger(absStart) || !Number.isInteger(absEnd) || absEnd <= absStart) return null;
  const before = content[absStart - 1];
  const after = content[absEnd];
  for (const b of RUBY_BRACKETS) {
    if (before !== b.open || after !== b.close) continue;
    if (content[absEnd + 1] !== b.rOpen) continue;
    const close = content.indexOf(b.rClose, absEnd + 2);
    if (close === -1) continue;
    const ruby = content.slice(absEnd + 2, close);
    if (!ruby || ruby.includes("\n")) continue;
    return {
      parent: content.slice(absStart, absEnd),
      ruby,
      fullStart: absStart - 1,
      fullEnd: close + 1,
    };
  }
  return null;
}

function rubyPopoverHasFocus() {
  const pop = $("editor-ruby-popover");
  return !!pop && !pop.hidden && pop.contains(document.activeElement);
}

function hideRubyPopover() {
  const pop = $("editor-ruby-popover");
  if (!pop || pop.hidden) return;
  pop.hidden = true;
  delete pop.dataset.absStart;
  delete pop.dataset.absEnd;
}

// 選択中の段落（.editor-page-paragraph-text）の直下に、wrap 相対の absolute 座標で配置する。
function positionRubyPopover(sel) {
  const pop = $("editor-ruby-popover");
  const wrap = $("editor-pages-viewer-wrap");
  const blockEl = sel?.blockEl;
  if (!pop || !wrap || !blockEl || !blockEl.isConnected) return;
  const b = blockEl.getBoundingClientRect();
  const w = wrap.getBoundingClientRect();
  const pad = 4;
  const gap = 4;
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  // wrap の padding box 基準（getBoundingClientRect 差分なので transform 祖先の影響を受けない）。
  let left = b.left - w.left;
  if (left + pw > w.width - pad) left = w.width - pw - pad;
  if (left < pad) left = pad;
  let top = b.bottom - w.top + gap;
  // 下に収まらなければ段落の上へ反転。
  if (top + ph > w.height - pad) {
    const above = b.top - w.top - ph - gap;
    top = above >= pad ? above : Math.max(pad, w.height - ph - pad);
  }
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
}

function showRubyPopover(sel) {
  const els = getEls();
  const pop = els.rubyPopover;
  const input = els.rubyPopoverInput;
  const parentEl = els.rubyPopoverParent;
  const removeBtn = els.rubyPopoverRemove;
  if (!pop || !input || !parentEl || !sel) return;

  const sameTarget = !pop.hidden
    && pop.dataset.absStart === String(sel.absStart)
    && pop.dataset.absEnd === String(sel.absEnd);

  if (!sameTarget) {
    pop.dataset.absStart = String(sel.absStart);
    pop.dataset.absEnd = String(sel.absEnd);
    parentEl.textContent = sel.text;
    parentEl.title = sel.text;
    const source = getTxtSource();
    const content = (source?.content ?? "").replace(/\r\n?/g, "\n");
    const existing = detectRubyAnnotationAtSelection(content, sel.absStart, sel.absEnd);
    input.value = existing ? existing.ruby : "";
    if (existing) syncEditorRubyModeButtons(inferEditorRubyMode(existing.parent, existing.ruby));
    else syncEditorRubyModeButtons(editorRubyMode);
    if (removeBtn) removeBtn.hidden = !existing;
  }

  pop.hidden = false;
  positionRubyPopover(sel);
}

function handleEditorSelectionChange() {
  const sel = updateEditorBlockSelectionFromDom();
  if (sel) {
    showRubyPopover(sel);
  } else if (!rubyPopoverHasFocus()) {
    hideRubyPopover();
  }
}

function applyRubyFromPopover() {
  const els = getEls();
  const sel = lastEditorBlockSelection;
  if (!sel) {
    hideRubyPopover();
    return;
  }
  const rawRuby = (els.rubyPopoverInput?.value ?? "").trim();
  if (rawRuby === "") return;
  const source = getTxtSource();
  const content = (source?.content ?? "").replace(/\r\n?/g, "\n");
  const existing = detectRubyAnnotationAtSelection(content, sel.absStart, sel.absEnd);
  const parentText = existing ? existing.parent : sel.text;
  const formatted = formatRubyForEditorMode(parentText, rawRuby, editorRubyMode);
  if (!formatted.ok) {
    toast(formatted.reason || "ルビを適用できませんでした。入力を確認してください", { kind: "warning", duration: 2600 });
    return;
  }
  const ruby = formatted.text;

  let ok = false;
  if (existing) {
    const original = content.slice(existing.fullStart, existing.fullEnd);
    const replacement = `｛${existing.parent}｝（${ruby}）`;
    ok = replaceSourceRange(existing.fullStart, existing.fullEnd, original, replacement);
  } else {
    if (RUBY_DELIMITER_RE.test(sel.text)) {
      toast("既存のルビを含む範囲には付けられません。親文字だけを選択してください", { kind: "warning", duration: 2600 });
      return;
    }
    const replacement = `｛${sel.text}｝（${ruby}）`;
    ok = replaceSourceRange(sel.absStart, sel.absEnd, sel.text, replacement);
  }

  if (!ok) {
    toast("ルビを適用できませんでした。もう一度選択してください", { kind: "warning", duration: 2400 });
    return;
  }
  lastEditorBlockSelection = null;
  hideRubyPopover();
}

function removeRubyFromPopover() {
  const sel = lastEditorBlockSelection;
  if (!sel) {
    hideRubyPopover();
    return;
  }
  const source = getTxtSource();
  const content = (source?.content ?? "").replace(/\r\n?/g, "\n");
  const existing = detectRubyAnnotationAtSelection(content, sel.absStart, sel.absEnd);
  if (!existing) {
    hideRubyPopover();
    return;
  }
  const original = content.slice(existing.fullStart, existing.fullEnd);
  const ok = replaceSourceRange(existing.fullStart, existing.fullEnd, original, existing.parent);
  if (!ok) {
    toast("ルビを削除できませんでした。もう一度選択してください", { kind: "warning", duration: 2400 });
    return;
  }
  lastEditorBlockSelection = null;
  hideRubyPopover();
}

function getCurrentActivePageNumber() {
  return getActivePageNumber();
}

function editorDragPageNumberFrom(el) {
  const n = Number(el?.dataset?.pageNumber);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function editorParagraphsForPage(pageNumber) {
  const viewer = $("editor-pages-viewer");
  if (!viewer) return [];
  const pageKey = pageNumber == null ? "0" : String(pageNumber);
  return Array.from(viewer.querySelectorAll(`.editor-page-paragraph[data-page-number="${pageKey}"]`));
}

function clearEditorParagraphDropIndicators() {
  document.querySelectorAll(
    ".editor-page-paragraph-drop-before, .editor-page-paragraph-drop-after, .editor-page-section-drop-empty",
  ).forEach((el) => {
    el.classList.remove(
      "editor-page-paragraph-drop-before",
      "editor-page-paragraph-drop-after",
      "editor-page-section-drop-empty",
    );
  });
}

function resetEditorParagraphDrag() {
  clearEditorParagraphDropIndicators();
  document.querySelectorAll(".editor-page-paragraph-dragging").forEach((el) => {
    el.classList.remove("editor-page-paragraph-dragging");
  });
  document.body.classList.remove("editor-paragraph-reordering");
  document.removeEventListener("pointermove", handleEditorParagraphPointerMove, true);
  document.removeEventListener("pointerup", handleEditorParagraphPointerUp, true);
  document.removeEventListener("pointercancel", handleEditorParagraphPointerCancel, true);
  editorParagraphDrag = null;
}

function paragraphDropTargetFor(el, e) {
  if (!editorParagraphDrag) return null;
  const toPageNumber = editorDragPageNumberFrom(el);
  const samePage = toPageNumber === editorParagraphDrag.pageNumber;
  const paragraphs = editorParagraphsForPage(toPageNumber);
  if (paragraphs.length === 0) return null;

  const targetIndex = Number(el.dataset.paragraphIndex);
  if (!Number.isInteger(targetIndex)) return null;
  const rect = el.getBoundingClientRect();
  const after = e.clientY >= rect.top + rect.height / 2;
  let toIndex = targetIndex + (after ? 1 : 0);
  if (samePage && toIndex > editorParagraphDrag.fromIndex) toIndex -= 1;
  const maxIndex = samePage ? paragraphs.length - 1 : paragraphs.length;
  toIndex = Math.max(0, Math.min(maxIndex, toIndex));
  if (samePage && toIndex === editorParagraphDrag.fromIndex) return null;
  return {
    toPageNumber,
    toIndex,
    indicatorEl: el,
    indicatorClass: after ? "editor-page-paragraph-drop-after" : "editor-page-paragraph-drop-before",
  };
}

function sectionDropTargetFor(section, e) {
  if (!editorParagraphDrag || !section) return null;
  const toPageNumber = editorDragPageNumberFrom(section);
  const samePage = toPageNumber === editorParagraphDrag.pageNumber;
  const paragraphs = editorParagraphsForPage(toPageNumber);
  if (paragraphs.length === 0) {
    if (samePage) return null;
    return {
      toPageNumber,
      toIndex: 0,
      indicatorEl: section,
      indicatorClass: "editor-page-section-drop-empty",
    };
  }

  const firstRect = paragraphs[0].getBoundingClientRect();
  const lastRect = paragraphs[paragraphs.length - 1].getBoundingClientRect();
  if (e.clientY < firstRect.top) return paragraphDropTargetFor(paragraphs[0], { clientY: firstRect.top - 1 });
  if (e.clientY > lastRect.bottom) return paragraphDropTargetFor(paragraphs[paragraphs.length - 1], { clientY: lastRect.bottom + 1 });
  return null;
}

function editorDropTargetFromPoint(e) {
  const hit = document.elementFromPoint(e.clientX, e.clientY);
  const paragraph = hit?.closest?.(".editor-page-paragraph") ?? null;
  if (paragraph) return paragraphDropTargetFor(paragraph, e);
  return sectionDropTargetFor(hit?.closest?.(".editor-page-section") ?? null, e);
}

function updateEditorParagraphDropTarget(e) {
  const target = editorDropTargetFromPoint(e);
  clearEditorParagraphDropIndicators();
  if (editorParagraphDrag) {
    editorParagraphDrag.toPageNumber = target?.toPageNumber ?? null;
    editorParagraphDrag.toIndex = target?.toIndex ?? null;
  }
  if (!target) return null;
  target.indicatorEl.classList.add(target.indicatorClass);
  return target;
}

function handleEditorParagraphPointerMove(e) {
  if (!editorParagraphDrag) return;
  e.preventDefault();
  e.stopPropagation();
  updateEditorParagraphDropTarget(e);
}

function handleEditorParagraphPointerUp(e) {
  if (!editorParagraphDrag) return;
  e.preventDefault();
  e.stopPropagation();
  updateEditorParagraphDropTarget(e);

  const { pageNumber, fromIndex, toPageNumber, toIndex } = editorParagraphDrag;
  resetEditorParagraphDrag();
  if (Number.isInteger(toIndex)) {
    moveTxtBlockByIndex(pageNumber, fromIndex, toIndex, toPageNumber);
  }
}

function handleEditorParagraphPointerCancel(e) {
  if (!editorParagraphDrag) return;
  e.preventDefault();
  e.stopPropagation();
  resetEditorParagraphDrag();
}

function startEditorParagraphDrag(e, el, pageNumber, paragraphIndex) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();

  const activeText = document.activeElement?.closest?.(".editor-page-paragraph-text");
  if (activeText) activeText.blur();
  editingBlock = false;

  const pageKey = pageNumber == null ? "0" : String(pageNumber);
  const latestEl = $("editor-pages-viewer")?.querySelector(
    `.editor-page-paragraph[data-page-number="${pageKey}"][data-paragraph-index="${paragraphIndex}"]`,
  );
  const sourceEl = latestEl || el;
  if (!sourceEl?.isConnected) return;

  editorParagraphDrag = { pageNumber, fromIndex: paragraphIndex, toPageNumber: pageNumber, toIndex: null };
  sourceEl.classList.add("editor-page-paragraph-dragging");
  document.body.classList.add("editor-paragraph-reordering");
  document.addEventListener("pointermove", handleEditorParagraphPointerMove, true);
  document.addEventListener("pointerup", handleEditorParagraphPointerUp, true);
  document.addEventListener("pointercancel", handleEditorParagraphPointerCancel, true);
}

function buildSection(pageNumber, blocks, activeNum, options = {}) {
  const { markerless = false, showHeader = true } = options;
  const sec = document.createElement("section");
  sec.className = "editor-page-section";
  sec.dataset.pageNumber = String(pageNumber ?? 0);
  if (markerless || pageNumber === activeNum) sec.classList.add("active");

  if (showHeader) {
    const header = document.createElement("header");
    header.className = "editor-page-section-header";
    header.textContent = markerless ? "ページ区切りなし" : `P${pageNumLabel(pageNumber)}`;
    sec.appendChild(header);
  }

  const body = document.createElement("div");
  body.className = "editor-page-section-body";
  if (blocks.length === 0) {
    const hint = document.createElement("div");
    hint.className = "editor-page-section-empty-hint";
    hint.textContent = "このページには段落がありません";
    body.appendChild(hint);
  } else {
    blocks.forEach((block, idx) => {
      const el = document.createElement("div");
      el.className = "editor-page-paragraph";
      el.dataset.paragraphIndex = String(idx);
      el.dataset.pageNumber = String(pageNumber ?? 0);
      el.dataset.offset = String(block.offset);
      el.dataset.originalText = block.text;

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "editor-page-paragraph-delete-btn";
      delBtn.setAttribute("aria-label", "この段落を削除");
      delBtn.title = "この段落を削除";
      delBtn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      delBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      delBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        editingBlock = false;
        deleteTxtBlockByIndex(markerless ? null : pageNumber, idx);
      });
      el.appendChild(delBtn);

      const dragBtn = document.createElement("button");
      dragBtn.type = "button";
      dragBtn.className = "editor-page-paragraph-drag-btn";
      dragBtn.tabIndex = -1;
      dragBtn.setAttribute("aria-label", "段落を移動");
      dragBtn.title = "段落を移動";
      dragBtn.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true"><circle cx="5" cy="3.5" r="1.2"/><circle cx="11" cy="3.5" r="1.2"/><circle cx="5" cy="8" r="1.2"/><circle cx="11" cy="8" r="1.2"/><circle cx="5" cy="12.5" r="1.2"/><circle cx="11" cy="12.5" r="1.2"/></svg>';
      dragBtn.addEventListener("pointerdown", (e) => startEditorParagraphDrag(e, el, markerless ? null : pageNumber, idx));
      dragBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      el.appendChild(dragBtn);

      const textEl = document.createElement("div");
      textEl.className = "editor-page-paragraph-text";
      textEl.contentEditable = "true";
      textEl.spellcheck = false;
      textEl.dataset.paragraphIndex = String(idx);
      textEl.dataset.pageNumber = String(pageNumber ?? 0);
      textEl.dataset.offset = String(block.offset);
      textEl.dataset.originalText = block.text;
      const display = displayRubySource(block.text);
      textEl.dataset.originalDisplayText = display.text;
      appendTextWithStyleMarkers(
        textEl,
        display.text,
        getStyleOverrideRangesForTxtRef(markerless ? null : pageNumber, idx),
      );
      editorTextMappings.set(textEl, display.displayToRaw);
      el.appendChild(textEl);
      bindParagraphEdit(textEl);
      body.appendChild(el);
    });
  }
  sec.appendChild(body);
  return sec;
}

function renderViewer({ scrollToActive = false } = {}) {
  const els = getEls();
  if (!els.viewer) return;
  hideRubyPopover();
  if (editingBlock) return;

  const source = getTxtSource();
  els.viewer.innerHTML = "";
  if (!source) {
    if (els.empty) els.empty.hidden = false;
    return;
  }

  const content = source.content ?? "";
  if (els.empty) els.empty.hidden = content.length !== 0;
  if (content.length === 0) return;

  const model = buildPageModel(content);
  const activeNum = getCurrentActivePageNumber();

  if (!model.hasMarkers) {
    els.viewer.appendChild(buildSection(null, model.allBlocks, activeNum, { markerless: true }));
    return;
  }

  if (editorPageMode === "all") {
    const pages = model.pages.length > 0 ? model.pages : [{ pageNumber: activeNum, blocks: [] }];
    for (const page of pages) {
      els.viewer.appendChild(buildSection(page.pageNumber, page.blocks, activeNum));
    }
    if (scrollToActive) {
      requestAnimationFrame(() => {
        const active = els.viewer.querySelector(".editor-page-section.active");
        active?.scrollIntoView?.({ block: "start", behavior: "smooth" });
      });
    }
    return;
  }

  const page = model.pages.find((p) => p.pageNumber === activeNum) ?? { pageNumber: activeNum, blocks: [] };
  els.viewer.appendChild(buildSection(page.pageNumber, page.blocks, activeNum));
  els.viewer.scrollTop = 0;
}

function bindParagraphEdit(el) {
  let aborted = false;
  let composing = false;

  el.addEventListener("compositionstart", () => { composing = true; });
  el.addEventListener("compositionend", () => { composing = false; });
  el.addEventListener("focus", () => {
    aborted = false;
    editingBlock = true;
  });

  el.addEventListener("keydown", (e) => {
    if (composing) return;
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      el.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      aborted = true;
      el.blur();
    } else if (
      e.key === "ArrowLeft"
      || e.key === "ArrowRight"
      || e.key === "ArrowUp"
      || e.key === "ArrowDown"
    ) {
      e.stopPropagation();
    }
  });

  el.addEventListener("blur", () => {
    editingBlock = false;
    const original = el.dataset.originalText ?? "";
    const originalDisplay = el.dataset.originalDisplayText ?? original;
    if (aborted) {
      el.textContent = originalDisplay;
      aborted = false;
      return;
    }
    const newText = (el.innerText ?? el.textContent ?? "").replace(/\r\n?/g, "\n");
    if (newText === originalDisplay) return;
    // 空行（連続改行）で分割されていれば、空行より後ろのパートを画像中央へ新規配置する。
    // 分割正規表現は再描画 splitBlocksWithOffsets と同じ（全角スペースも含む空行を許容）。
    let parts = newText
      .split(/\n[ \t　]*\n/)
      .map((s) => s.replace(/^\n+|\n+$/g, ""))
      .filter((s) => s.length > 0);
    if (parts.length <= 1 && !originalDisplay.includes("\n") && newText.includes("\n")) {
      parts = newText
        .split(/\n[ \t\u3000]*/)
        .map((s) => s.replace(/^\n+|\n+$/g, ""))
        .filter((s) => s.length > 0);
    }
    if (parts.length > 1) {
      const pn = Number(el.dataset.pageNumber);
      const ok = splitTxtBlockAndPlace(
        Number(el.dataset.offset),
        original,
        parts,
        Number(el.dataset.paragraphIndex),
        (Number.isInteger(pn) && pn > 0) ? pn : null,
      );
      if (!ok) renderViewer();
      return;
    }
    const changed = replaceBlockAtOffset(Number(el.dataset.offset), original, newText);
    if (!changed) renderViewer();
  });
}

function syncFromState() {
  const els = getEls();
  if (!els.viewer) return;
  const source = getTxtSource();
  const path = getTxtFilePath();
  const dirty = getTxtDirty();

  const display = path ? baseName(path) : (source?.name || "テキスト未読込");
  if (els.filename) {
    els.filename.textContent = display;
    els.filename.title = path || (source ? source.name : "");
  }

  const hasContent = !!source;
  if (els.dirtyDot) els.dirtyDot.hidden = !(hasContent && dirty);
  if (els.save) els.save.disabled = !hasContent;
  if (els.newInput) syncNewInputAvailabilityFor(els.newInput);
  syncEditorPageModeButtons();
}

async function writeTxtFile(content, defaultName) {
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke("save_editor_text_to_script_output", { content, defaultName });
}

async function launchProgenWithText(savedPath) {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("launch_progen_with_text", { textPath: savedPath });
}

function defaultSaveNameFor(source) {
  const fromSource = source?.name;
  const fromPath = getTxtFilePath() ? baseName(getTxtFilePath()) : "";
  return fromSource || fromPath || "untitled.txt";
}

async function handleSaveAuto() {
  const source = getTxtSource();
  if (!source) return;
  let outputPath;
  try {
    outputPath = await writeTxtFile(source.content, defaultSaveNameFor(source));
    setTxtFilePath(outputPath);
    setTxtDirty(false);
  } catch (e) {
    console.error(e);
    toast(`保存失敗: ${e?.message ?? e}`, { kind: "error" });
    return;
  }

  const displayName = baseName(outputPath);
  await notifyDialog({
    title: "保存が完了しました",
    message: `${displayName}\n${outputPath}`,
    okLabel: "閉じる",
    kind: "success",
    secondaryAction: {
      label: "保存先フォルダを開く",
      kind: "primary",
      onClick: async () => {
        try {
          await openContainingFolder(outputPath);
        } catch (e) {
          console.error(e);
          toast(`保存先フォルダを開けませんでした: ${e?.message ?? e}`, { kind: "error" });
        }
      },
    },
    primaryAction: {
      label: "ProGenを開く",
      kind: "place",
      onClick: async () => {
        try {
          await launchProgenWithText(outputPath);
        } catch (e) {
          console.error(e);
          toast(`ProGen起動失敗: ${e?.message ?? e}`, { kind: "error" });
        }
      },
    },
  });
}

function handleCommitNewInput() {
  const els = getEls();
  if (!els.newInput) return;
  commitNewTxtInput({ inputEl: els.newInput });
}

function localActivePageSource() {
  const psd = getPages().length;
  if (psd > 0) return { source: "psd", total: psd, current: getCurrentPageIndex() };
  const pdf = getPdfVirtualPageCount();
  if (pdf > 0) return { source: "pdf", total: pdf, current: getPdfPageIndex() };
  const txt = getTxtPageCount();
  if (txt > 0) return { source: "txt", total: txt, current: getPdfPageIndex() };
  return null;
}

function localAdvancePage(delta) {
  const info = localActivePageSource();
  if (!info) return;
  const next = nextPageIndexForTurn(info.source, info.current, info.total, delta);
  if (info.source === "psd") setCurrentPageIndex(next);
  else setPdfPageIndex(next);
}

function syncPageNav() {
  const els = getEls();
  if (!els.pageLabel) return;
  const info = localActivePageSource();
  if (!info || info.total <= 0) {
    els.pageLabel.textContent = "- / -";
    if (els.pagePrev) els.pagePrev.disabled = true;
    if (els.pageNext) els.pageNext.disabled = true;
    return;
  }
  els.pageLabel.textContent = `P${String(info.current + 1).padStart(2, "0")} / ${info.total}`;
  if (els.pagePrev) {
    els.pagePrev.disabled = nextPageIndexForTurn(info.source, info.current, info.total, -1) === info.current;
  }
  if (els.pageNext) {
    els.pageNext.disabled = nextPageIndexForTurn(info.source, info.current, info.total, +1) === info.current;
  }
}

function onEditorPageNavShortcut(e) {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.altKey || e.shiftKey) return;
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  if (getParallelViewMode() !== "editor") return;
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
  localAdvancePage(e.key === "ArrowLeft" ? -1 : 1);
}

function onViewerKeydown(e) {
  if (editingBlock || editorPageMode === "all") return;
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  const tag = e.target?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

  let delta = 0;
  if (e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "PageUp") delta = -1;
  else if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "PageDown") delta = 1;
  else return;

  e.preventDefault();
  e.stopPropagation();
  localAdvancePage(delta);
}

function bindNewInput() {
  const els = getEls();
  if (!els.newInput) return;
  els.newInput.addEventListener("input", () => syncNewInputAvailabilityFor(els.newInput));
  els.newInput.addEventListener("keydown", (e) => {
    if (isQuickAddTextShortcut(e)) {
      consumeQuickAddTextShortcut(e);
      handleCommitNewInput();
    } else if (e.key === "Escape") {
      e.preventDefault();
      if ((els.newInput.value ?? "").length > 0) {
        els.newInput.value = "";
        syncNewInputAvailabilityFor(els.newInput);
      } else {
        els.newInput.blur();
      }
    }
  });
  els.newInputBtn?.addEventListener("click", handleCommitNewInput);
  if (!editorQuickAddShortcutBound) {
    editorQuickAddShortcutBound = true;
    document.addEventListener("keydown", (e) => {
      if (getParallelViewMode() !== "editor") return;
      if (editingBlock) return;
      const currentEls = getEls();
      if (!shouldHandleBlurredQuickAddShortcut(e, currentEls.newInput)) return;
      consumeQuickAddTextShortcut(e);
      commitNewTxtInput({ inputEl: currentEls.newInput });
    }, true);
  }
}

export function bindEditorPane() {
  const els = getEls();
  if (!els.viewer) return;

  els.save?.addEventListener("click", handleSaveAuto);
  els.pagePrev?.addEventListener("click", () => localAdvancePage(-1));
  els.pageNext?.addEventListener("click", () => localAdvancePage(+1));
  els.pageModeAll?.addEventListener("click", () => setEditorPageMode("all"));
  els.pageModeSingle?.addEventListener("click", () => setEditorPageMode("single"));
  els.viewer.tabIndex = 0;
  els.viewer.addEventListener("keydown", onViewerKeydown);
  els.viewer.addEventListener("scroll", handleEditorSelectionChange, { passive: true });

  // mousedown の preventDefault で、ボタンが contenteditable からフォーカスを奪わない
  // ようにする（選択崩れ→ selectionchange でポップオーバーが消える競合を防ぐ）。
  els.rubyPopoverApply?.addEventListener("mousedown", (e) => e.preventDefault());
  els.rubyPopoverRemove?.addEventListener("mousedown", (e) => e.preventDefault());
  [els.rubyModeAuto, els.rubyModeMono, els.rubyModeGroup].forEach((btn) => {
    btn?.addEventListener("mousedown", (e) => e.preventDefault());
    btn?.addEventListener("click", () => syncEditorRubyModeButtons(btn.dataset.mode));
  });
  syncEditorRubyModeButtons(editorRubyMode);
  els.rubyPopoverApply?.addEventListener("click", applyRubyFromPopover);
  els.rubyPopoverRemove?.addEventListener("click", removeRubyFromPopover);
  els.rubyPopoverInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      applyRubyFromPopover();
    } else if (e.key === "Escape") {
      e.preventDefault();
      hideRubyPopover();
    }
  });

  bindNewInput();
  document.addEventListener("selectionchange", handleEditorSelectionChange);
  document.addEventListener("keydown", onEditorPageNavShortcut, true);
  // ポップオーバー外をクリックしたら閉じる（エディタ内クリックは selectionchange でも閉じる）。
  document.addEventListener("mousedown", (e) => {
    const pop = $("editor-ruby-popover");
    if (!pop || pop.hidden) return;
    if (pop.contains(e.target)) return;
    hideRubyPopover();
  }, true);

  onTxtSourceChange(() => {
    renderViewer();
    syncFromState();
    syncPageNav();
  });
  onTxtFilePathChange(syncFromState);
  onTxtDirtyChange(syncFromState);
  onPageIndexChange(() => {
    renderViewer({ scrollToActive: editorPageMode === "all" });
    syncPageNav();
  });
  onPdfPageIndexChange(() => {
    if (getPages().length > 0) return;
    renderViewer({ scrollToActive: editorPageMode === "all" });
    syncPageNav();
  });
  onPdfChange(() => {
    if (getPages().length > 0) return;
    renderViewer({ scrollToActive: editorPageMode === "all" });
    syncPageNav();
  });

  window.addEventListener("psdesign:psd-loaded", () => {
    if (els.newInput) syncNewInputAvailabilityFor(els.newInput);
    renderViewer({ scrollToActive: editorPageMode === "all" });
    syncPageNav();
  });

  syncEditorPageModeButtons();
  renderViewer();
  syncFromState();
  syncPageNav();
}

export function focusEditor() {
  const viewer = $("editor-pages-viewer");
  if (!viewer) return;
  requestAnimationFrame(() => {
    const active = viewer.querySelector(".editor-page-section.active");
    const first = (active || viewer).querySelector(".editor-page-paragraph-text");
    if (first) first.focus();
  });
}

export function refreshEditorPaneViewer() {
  renderViewer({ scrollToActive: editorPageMode === "all" });
  syncFromState();
  syncPageNav();
}
