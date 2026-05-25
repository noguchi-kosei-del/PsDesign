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
import {
  commitNewTxtInput,
  deleteTxtBlockByIndex,
  getActivePageNumber,
  getTxtPageCount,
  ensureTxtExtension,
  pickTxtSavePath,
  syncNewInputAvailabilityFor,
} from "../txt-source.js";
import { notifyDialog, promptDialog, toast } from "../ui-feedback.js";
import {
  appendTextWithStyleMarkers,
  getStyleOverrideRangesForTxtRef,
} from "../text-style-markers.js";

const $ = (id) => document.getElementById(id);
const EDITOR_PAGE_MODE_KEY = "psdesign_editor_page_mode";
const PAGE_MARKER_RE = /<<\s*([0-9\uFF10-\uFF19]+)\s*Page\s*>>/gi;

let editorPageMode = loadEditorPageMode();
let editingBlock = false;
let lastEditorBlockSelection = null;
const editorTextMappings = new WeakMap();

function getEls() {
  return {
    viewer: $("editor-pages-viewer"),
    empty: $("editor-empty"),
    newInput: $("editor-new-input"),
    newInputBtn: $("editor-new-input-btn"),
    save: $("editor-save-btn"),
    ruby: $("editor-ruby-btn"),
    filename: $("editor-filename"),
    dirtyDot: $("editor-dirty-dot"),
    pagePrev: $("editor-page-prev-btn"),
    pageNext: $("editor-page-next-btn"),
    pageLabel: $("editor-page-label"),
    pageModeAll: $("editor-page-mode-all"),
    pageModeSingle: $("editor-page-mode-single"),
  };
}

function baseName(p) {
  if (!p) return "";
  const m = p.match(/[\\/]([^\\/]+)$/);
  return m ? m[1] : p;
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
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  let startEl = range.startContainer;
  if (startEl && startEl.nodeType !== Node.ELEMENT_NODE) startEl = startEl.parentElement;
  const block = startEl?.closest?.(".editor-page-paragraph-text");
  if (!block) return;
  let endEl = range.endContainer;
  if (endEl && endEl.nodeType !== Node.ELEMENT_NODE) endEl = endEl.parentElement;
  if (!endEl?.closest || endEl.closest(".editor-page-paragraph-text") !== block) return;

  const beforeStart = document.createRange();
  beforeStart.selectNodeContents(block);
  beforeStart.setEnd(range.startContainer, range.startOffset);
  const startInBlock = beforeStart.toString().length;
  const beforeEnd = document.createRange();
  beforeEnd.selectNodeContents(block);
  beforeEnd.setEnd(range.endContainer, range.endOffset);
  const endInBlock = beforeEnd.toString().length;
  if (startInBlock === endInBlock) return;

  const blockText = block.textContent ?? "";
  const selectedText = blockText.slice(startInBlock, endInBlock);
  if (!selectedText || selectedText.includes("\n")) return;
  const blockOffset = Number(block.dataset.offset);
  if (!Number.isInteger(blockOffset)) return;
  const displayToRaw = editorTextMappings.get(block);
  const rawStartInBlock = displayToRaw?.[startInBlock] ?? startInBlock;
  const rawEndAnchor = displayToRaw?.[endInBlock - 1];
  const rawEndInBlock = rawEndAnchor == null ? endInBlock : rawEndAnchor + 1;
  lastEditorBlockSelection = {
    absStart: blockOffset + rawStartInBlock,
    absEnd: blockOffset + rawEndInBlock,
    text: selectedText,
  };
}

function getCurrentActivePageNumber() {
  return getActivePageNumber();
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
  if (els.ruby) els.ruby.disabled = !hasContent;
  if (els.newInput) syncNewInputAvailabilityFor(els.newInput);
  syncEditorPageModeButtons();
}

async function writeTxtFile(content, defaultName) {
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke("save_editor_text_to_script_output", { content, defaultName });
}

async function handleSave() {
  await handleSaveAuto();
  return;
  const source = getTxtSource();
  const path = getTxtFilePath();
  if (!source || !path) return;
  try {
    await writeTxtFile(path, source.content);
    setTxtDirty(false);
    toast("テキストを保存しました", { kind: "success", duration: 1800 });
  } catch (e) {
    console.error(e);
    toast(`保存失敗: ${e?.message ?? e}`, { kind: "error" });
  }
}

async function handleSaveAs() {
  await handleSaveAuto();
  return;
  const source = getTxtSource();
  if (!source) return;
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
    await writeTxtFile(outputPath, source.content);
    setTxtFilePath(outputPath);
    setTxtDirty(false);
    toast("テキストを保存しました", { kind: "success", duration: 1800 });
  } catch (e) {
    console.error(e);
    toast(`保存失敗: ${e?.message ?? e}`, { kind: "error" });
  }
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

async function handleAddRuby() {
  updateEditorBlockSelectionFromDom();
  const picked = lastEditorBlockSelection;
  if (!picked || !picked.text || picked.text.includes("\n")) {
    toast("ルビを付けたい文字を1行内で選択してください", { kind: "info", duration: 2000 });
    return;
  }
  const parentText = picked.text;
  const ruby = await promptDialog({
    title: "ルビ付け",
    message: `「${parentText}」のルビを入力`,
    placeholder: "ふりがな",
  });
  if (ruby == null || ruby === "") return;
  const replacement = `｛${parentText}｝（${ruby}）`;
  const changed = replaceSourceRange(picked.absStart, picked.absEnd, parentText, replacement);
  if (!changed) {
    toast("選択範囲を更新できませんでした。もう一度選択してください", { kind: "warning", duration: 2400 });
    return;
  }
  lastEditorBlockSelection = null;
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
  const next = Math.max(0, Math.min(info.total - 1, info.current + delta));
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
  if (els.pagePrev) els.pagePrev.disabled = info.current <= 0;
  if (els.pageNext) els.pageNext.disabled = info.current >= info.total - 1;
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
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
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
}

export function bindEditorPane() {
  const els = getEls();
  if (!els.viewer) return;

  els.save?.addEventListener("click", handleSaveAuto);
  els.ruby?.addEventListener("click", handleAddRuby);
  els.pagePrev?.addEventListener("click", () => localAdvancePage(-1));
  els.pageNext?.addEventListener("click", () => localAdvancePage(+1));
  els.pageModeAll?.addEventListener("click", () => setEditorPageMode("all"));
  els.pageModeSingle?.addEventListener("click", () => setEditorPageMode("single"));
  els.viewer.tabIndex = 0;
  els.viewer.addEventListener("keydown", onViewerKeydown);

  bindNewInput();
  document.addEventListener("selectionchange", updateEditorBlockSelectionFromDom);
  document.addEventListener("keydown", onEditorPageNavShortcut, true);

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
