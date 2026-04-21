import {
  clearTxtSource,
  getTxtSelectedBlockIndex,
  getTxtSelection,
  getTxtSource,
  setTxtSelectedBlockIndex,
  setTxtSelection,
  setTxtSource,
} from "./state.js";
import { toast } from "./ui-feedback.js";

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

function splitBlocks(content) {
  const normalized = content.replace(/\r\n?/g, "\n");
  return normalized
    .split(/\n\s*\n/)
    .map((p) => p.replace(/^\n+|\n+$/g, ""))
    .filter((p) => p.length > 0);
}

function renderViewer() {
  const source = getTxtSource();
  const viewer = $("txt-source-viewer");
  const empty = $("txt-source-empty");
  const name = $("txt-source-name");
  const clearBtn = $("clear-txt-btn");
  const hint = $("txt-source-hint");
  const actions = $("txt-source-actions");

  viewer.innerHTML = "";

  if (!source) {
    viewer.hidden = true;
    empty.hidden = false;
    name.textContent = "";
    clearBtn.hidden = true;
    hint.hidden = true;
    if (actions) actions.hidden = true;
    return;
  }

  viewer.hidden = false;
  empty.hidden = true;
  name.textContent = source.name;
  clearBtn.hidden = false;
  hint.hidden = false;
  if (actions) actions.hidden = false;

  const blocks = splitBlocks(source.content);
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
    const content = await readTxtFromPath(path);
    setTxtSource({ name: baseName(path), content });
    renderViewer();
    toast(`TXT読込: ${baseName(path)} (${content.length}文字)`, { kind: "success" });
  } catch (e) {
    console.error(e);
    toast(`TXT読込失敗: ${e.message ?? e}`, { kind: "error", duration: 4500 });
  }
}

async function handleFileDropped(file) {
  try {
    const buf = await file.arrayBuffer();
    const content = decodeBytes(new Uint8Array(buf));
    setTxtSource({ name: file.name, content });
    renderViewer();
    toast(`TXT読込: ${file.name} (${content.length}文字)`, { kind: "success" });
  } catch (e) {
    console.error(e);
    toast(`TXT読込失敗: ${e.message ?? e}`, { kind: "error", duration: 4500 });
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
      toast("TXTファイルを指定してください", { kind: "error" });
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
  $("clear-txt-btn").addEventListener("click", () => {
    clearTxtSource();
    renderViewer();
    toast("TXTをクリアしました", { kind: "info", duration: 1500 });
  });
  bindDropzone();
  renderViewer();
}

export function getActiveTxtSelection() {
  if (!getTxtSource()) return "";
  return getTxtSelection();
}
