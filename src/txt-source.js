import {
  getCurrentPageIndex,
  getNewLayers,
  getPages,
  getPdfPageIndex,
  getTxtSelectedBlockIndex,
  getTxtSelection,
  getTxtSource,
  onPageIndexChange,
  onPdfChange,
  onPdfPageIndexChange,
  onTxtSourceChange,
  removeNewLayer,
  setTxtDirty,
  setTxtFilePath,
  setTxtSelectedBlockIndex,
  setTxtSelection,
  setTxtSource,
  updateNewLayer,
  withHistoryTransient,
} from "./state.js";
import { confirmDialog, toast } from "./ui-feedback.js";
import { refreshAllOverlays } from "./canvas-tools.js";
import { rebuildLayerList } from "./text-editor.js";

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

// 現在ページ番号 (1-indexed) を返す。
// PSD が読み込まれていれば PSD の currentPageIndex を使い、
// それ以外（見本のみ／TXT 単体）は pdfPageIndex を流用する。
// PDF も TXT 単体も同じ pdfPageIndex を「閲覧中ページ」として共有する設計。
function activePageNumber() {
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

function getVisibleBlocks() {
  const source = getTxtSource();
  if (!source) return { blocks: [], hasMarkers: false, pageNumber: null };
  const parsed = parsePages(source.content);
  if (!parsed.hasMarkers) {
    return { blocks: parsed.all, hasMarkers: false, pageNumber: null };
  }
  const pageNumber = activePageNumber();
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
  const saveBtn = $("save-txt-btn");
  const deleteBtn = $("delete-txt-btn");

  viewer.innerHTML = "";

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
  if (saveBtn) saveBtn.disabled = false;
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
  blocks.forEach((paragraph, idx) => {
    const el = document.createElement("div");
    el.className = "txt-block";
    el.dataset.blockIndex = String(idx);
    el.textContent = paragraph;
    if (idx === selectedIdx) el.classList.add("selected");
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
// レイヤーへの追従は ai-place.js の onTxtSourceChange listener が担当する。
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
function updateTxtSourceBlock(pageNumber, oldParagraph, newParagraph) {
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
function deleteBlockFromContent(content, pageNumber, idx) {
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
  // setTxtSource が onTxtSourceChange listener (ai-place の syncPlacedFromTxt) を
  // 発火するが、こちらは contents 変更時だけ rebuild する作りなので、レイヤーが
  // 1 件削除されただけのケースでは UI が古いまま残る。手動で同期させる。
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
}

export async function pickTxtPath() {
  const { openFileDialog } = await import("./file-picker.js");
  const picked = await openFileDialog({
    mode: "open",
    multiple: false,
    title: "テキストを開く",
    filters: [{ name: "Text", extensions: ["txt"] }],
    rememberKey: "txt-open",
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
    await invoke("export_ai_text", { content: source.content, outputPath });
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
// AI OCR 結果 (ai-ocr.js) や、その他のプログラム生成テキストから呼ぶ。
export function loadTxtFromContent(name, content) {
  setTxtSource({ name: name || "untitled.txt", content: content || "" });
  // 元ファイルが無い経路（OCR 結果など）。エディタは「別名で保存」だけが利用可。
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
  $("open-txt-toolbar-btn").addEventListener("click", handleOpenBtn);
  onPageIndexChange(() => {
    setTxtSelectedBlockIndex(null);
    setTxtSelection("");
    renderViewer();
  });
  // PSD 未読込で見本 (PDF/画像) のみ開いているケースの TXT 連動。
  // PSD 読込中は onPageIndexChange が同期ブリッジ経由でも本体側も発火するため、
  // ここでは PSD 無しのときだけ働かせて二重描画を避ける。
  onPdfPageIndexChange(() => {
    if (getPages().length > 0) return;
    setTxtSelectedBlockIndex(null);
    setTxtSelection("");
    renderViewer();
  });
  // PDF doc 自体の読込/解除でも viewer を更新（見本の有無で activePageNumber の判定先が変わるため）。
  onPdfChange(() => {
    if (getPages().length > 0) return;
    renderViewer();
  });
  // undo/redo で原稿テキストが復元されたとき viewer を再描画。
  // setTxtSource からも同じ listener が発火する（loadTxtFromPath 等の呼び出し直後の
  // 明示 renderViewer 呼出と二重実行になるが、いずれも同期描画なので副作用なし）。
  onTxtSourceChange(() => renderViewer());
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
