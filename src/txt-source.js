import {
  clearTxtSource,
  getCurrentPageIndex,
  getEdit,
  getNewLayersForPsd,
  getPages,
  getTxtSelectedBlockIndex,
  getTxtSelection,
  getTxtSource,
  onPageIndexChange,
  setTxtSelectedBlockIndex,
  setTxtSelection,
  setTxtSource,
} from "./state.js";
import { confirmDialog, toast } from "./ui-feedback.js";
import { enterInPlaceEditForLayer } from "./canvas-tools.js";

const $ = (id) => document.getElementById(id);

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

function splitBlocksRaw(s) {
  return s
    .split(/\n\s*\n/)
    .map((p) => p.replace(/^\n+|\n+$/g, ""))
    .filter((p) => p.length > 0);
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

function getVisibleBlocks() {
  const source = getTxtSource();
  if (!source) return { blocks: [], hasMarkers: false, pageNumber: null };
  const parsed = parsePages(source.content);
  if (!parsed.hasMarkers) {
    return { blocks: parsed.all, hasMarkers: false, pageNumber: null };
  }
  const pageNumber = getCurrentPageIndex() + 1;
  return {
    blocks: parsed.byPage.get(pageNumber) ?? [],
    hasMarkers: true,
    pageNumber,
  };
}

export function renderTxtSourceViewer() {
  renderViewer();
}

function renderViewer() {
  const source = getTxtSource();
  const viewer = $("txt-source-viewer");
  const empty = $("txt-source-empty");
  const name = $("txt-source-name");
  const clearBtn = $("clear-txt-btn");
  const actions = $("txt-source-actions");

  viewer.innerHTML = "";

  if (!source) {
    viewer.hidden = true;
    empty.hidden = false;
    name.textContent = "";
    clearBtn.hidden = true;
    if (actions) actions.hidden = true;
    return;
  }

  viewer.hidden = false;
  empty.hidden = true;
  name.textContent = source.name;
  clearBtn.hidden = false;
  if (actions) actions.hidden = false;

  const { blocks, hasMarkers, pageNumber } = getVisibleBlocks();

  if (hasMarkers && blocks.length === 0) {
    const info = document.createElement("div");
    info.className = "txt-block-empty-hint";
    info.textContent = `ページ ${pageNumber} のテキストはありません`;
    viewer.appendChild(info);
    return;
  }

  const selectedIdx = getTxtSelectedBlockIndex();
  blocks.forEach((paragraph, idx) => {
    const el = document.createElement("div");
    el.className = "txt-block";
    el.dataset.blockIndex = String(idx);
    el.textContent = paragraph;
    if (idx === selectedIdx) el.classList.add("selected");
    el.addEventListener("click", () => selectBlock(idx, paragraph));
    el.addEventListener("dblclick", (e) => {
      e.preventDefault(); // text selection の暴走を抑止
      void runDoubleClickEdit(paragraph, pageNumber, viewer);
    });
    viewer.appendChild(el);
  });
}

async function runDoubleClickEdit(paragraph, pageNumber, viewer) {
  const match = findPlacedLayerByText(paragraph);
  if (!match) {
    toast("対応するテキストフレームが見つかりません", { kind: "info" });
    return;
  }
  // 同ページでも TXT selection を明示クリア。click→click→dblclick の発火順で
  // selectBlock が 2 回走った後でも、in-place 編集を Esc で抜けた直後にキャンバスを
  // クリックすると「同じ段落をもう一度配置」が起きる事故を防ぐ。
  setTxtSelectedBlockIndex(null);
  setTxtSelection("");
  if (viewer) {
    for (const item of viewer.querySelectorAll(".txt-block")) {
      item.classList.remove("selected");
    }
  }
  // 編集確定時に原稿テキスト側の該当ブロックも置換し、viewer を再描画する。
  await enterInPlaceEditForLayer(match.pageIndex, match.layerKey, {
    afterCommit: (newValue) => {
      updateTxtSourceBlock(pageNumber, paragraph, newValue);
    },
  });
}

// pageNumber（マーカー有り：1-based / 無し：null）の範囲内で oldParagraph を
// newParagraph に置換し、setTxtSource → renderViewer で UI も更新する。
// 同一テキスト or 一致なしのときは no-op で false。
function updateTxtSourceBlock(pageNumber, oldParagraph, newParagraph) {
  if (oldParagraph === newParagraph) return false;
  const source = getTxtSource();
  if (!source) return false;
  const newContent = replaceBlockInContent(source.content, pageNumber, oldParagraph, newParagraph);
  if (newContent == null || newContent === source.content) return false;
  // setTxtSource は txtSelection / txtSelectedBlockIndex をリセットするが
  // dblclick 経路ではすでにクリア済みなので問題なし。
  setTxtSource({ name: source.name, content: newContent });
  renderViewer();
  return true;
}

// content をページマーカーで区切り、pageNumber に対応するセクション内で
// oldText の最初の出現を newText に置換した結果を返す。一致しなければ null。
// pageNumber == null（マーカー無し原稿）のときは content 全体を対象にする。
// 改行は内部で LF 統一して比較・置換し、結果も LF で返す。
function replaceBlockInContent(content, pageNumber, oldText, newText) {
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

function normalizeForMatch(s) {
  return String(s ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/^\n+|\n+$/g, "");
}

// 段落テキストを既配置レイヤー全体から検索。検索順序：
//   1. 現在ページ → その他ページ index 昇順
//   2. ページ内：既存（PSD 元レイヤー）→ 新規（auto-place / T ツール配置）
// 最初の一致を返し、複数あれば console.info で記録（運用中の頻度把握用）。
function findPlacedLayerByText(text) {
  const target = normalizeForMatch(text);
  if (!target) return null;
  const pages = getPages();
  if (!pages || pages.length === 0) return null;
  const cur = getCurrentPageIndex();
  const order = [];
  if (cur >= 0 && cur < pages.length) order.push(cur);
  for (let i = 0; i < pages.length; i++) {
    if (i !== cur) order.push(i);
  }

  let firstMatch = null;
  let matchCount = 0;
  for (const i of order) {
    const page = pages[i];
    if (!page) continue;
    // 既存レイヤー（edit override 適用後の contents で比較）
    for (const layer of page.textLayers ?? []) {
      const edit = getEdit(page.path, layer.id);
      const raw = edit?.contents ?? layer.text ?? "";
      if (normalizeForMatch(raw) === target) {
        matchCount++;
        if (!firstMatch) {
          firstMatch = {
            pageIndex: i,
            layerKey: layer.id,
            direction: edit?.direction ?? layer.direction ?? "horizontal",
          };
        }
      }
    }
    // 新規レイヤー
    for (const nl of getNewLayersForPsd(page.path) ?? []) {
      if (normalizeForMatch(nl.contents ?? "") === target) {
        matchCount++;
        if (!firstMatch) {
          firstMatch = {
            pageIndex: i,
            layerKey: nl.tempId,
            direction: nl.direction ?? "vertical",
          };
        }
      }
    }
  }
  if (matchCount > 1) {
    console.info(`[txt-source] ${matchCount} matches for "${target.slice(0, 40)}${target.length > 40 ? "…" : ""}" — using first`);
  }
  return firstMatch;
}

function selectBlock(idx, text) {
  setTxtSelectedBlockIndex(idx);
  setTxtSelection(text);
  const viewer = $("txt-source-viewer");
  for (const el of viewer.querySelectorAll(".txt-block")) {
    el.classList.toggle("selected", el.dataset.blockIndex === String(idx));
  }
}

async function pickTxtPath() {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    multiple: false,
    title: "テキストを開く",
    filters: [{ name: "Text", extensions: ["txt"] }],
  });
  return typeof picked === "string" ? picked : null;
}

async function readTxtFromPath(path) {
  const { invoke } = await import("@tauri-apps/api/core");
  const bytes = await invoke("read_binary_file", { path });
  return decodeBytes(new Uint8Array(bytes));
}

function baseName(p) {
  const m = p && p.match(/[\\/]([^\\/]+)$/);
  return m ? m[1] : p;
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
    renderViewer();
  } catch (e) {
    console.error(e);
    toast(`テキスト読込失敗: ${e.message ?? e}`, { kind: "error", duration: 4500 });
  }
}

// 文字列バッファから直接 TXT パネルに流し込むヘルパー。
// AI OCR 結果 (ai-ocr.js) や、その他のプログラム生成テキストから呼ぶ。
export function loadTxtFromContent(name, content) {
  setTxtSource({ name: name || "untitled.txt", content: content || "" });
  renderViewer();
}

async function handleFileDropped(file) {
  try {
    const buf = await file.arrayBuffer();
    const content = decodeBytes(new Uint8Array(buf));
    setTxtSource({ name: file.name, content });
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
  $("open-txt-toolbar-btn").addEventListener("click", handleOpenBtn);
  onPageIndexChange(() => {
    setTxtSelectedBlockIndex(null);
    setTxtSelection("");
    renderViewer();
  });
  $("clear-txt-btn").addEventListener("click", async () => {
    if (!getTxtSource()) return;
    const ok = await confirmDialog({
      title: "テキストのクリア",
      message: "読み込んだテキストをリセットします。よろしいですか？",
      confirmLabel: "クリア",
    });
    if (!ok) return;
    clearTxtSource();
    renderViewer();
    toast("テキストをクリアしました", { kind: "info", duration: 1500 });
  });
  bindDropzone();
  renderViewer();
}

export function getActiveTxtSelection() {
  if (!getTxtSource()) return "";
  return getTxtSelection();
}

export function advanceTxtSelection() {
  const source = getTxtSource();
  if (!source) return false;
  const { blocks } = getVisibleBlocks();
  const cur = getTxtSelectedBlockIndex();
  if (cur == null) return false;
  const next = cur + 1;
  if (next >= blocks.length) {
    setTxtSelectedBlockIndex(null);
    setTxtSelection("");
    const viewer = $("txt-source-viewer");
    if (viewer) {
      for (const el of viewer.querySelectorAll(".txt-block")) {
        el.classList.remove("selected");
      }
    }
    return false;
  }
  setTxtSelectedBlockIndex(next);
  setTxtSelection(blocks[next]);
  const viewer = $("txt-source-viewer");
  if (viewer) {
    for (const el of viewer.querySelectorAll(".txt-block")) {
      el.classList.toggle("selected", el.dataset.blockIndex === String(next));
    }
    const nextEl = viewer.querySelector(`.txt-block[data-block-index="${next}"]`);
    if (nextEl) nextEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  return true;
}
