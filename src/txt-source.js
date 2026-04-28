import {
  clearTxtSource,
  getCurrentPageIndex,
  getTxtSelectedBlockIndex,
  getTxtSelection,
  getTxtSource,
  onPageIndexChange,
  setTxtSelectedBlockIndex,
  setTxtSelection,
  setTxtSource,
} from "./state.js";
import { confirmDialog, toast } from "./ui-feedback.js";

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
    viewer.appendChild(el);
  });
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
