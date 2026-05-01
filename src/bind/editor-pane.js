// テキストエディタペイン (view-mode "editor" 時に表示)。
// Comic-Bridge DEMO の TextEditorDropPanel.tsx の MVP 部分を Vanilla JS に移植。
//   - txtSource をサイドパネルと共有して双方向同期
//   - 開く / 保存 / 別名 / コピー / クリア
//   - // 削除マーク トグル / ルビ付け
//   - 文字数 / 行数フッター + ダーティドット
// 並べ替えモードと COMIC-POT 構文ハイライトは scope 外（後日）。

import {
  clearTxtSource,
  getTxtDirty,
  getTxtFilePath,
  getTxtSource,
  onTxtDirtyChange,
  onTxtFilePathChange,
  onTxtSourceChange,
  setTxtDirty,
  setTxtFilePath,
  setTxtSource,
} from "../state.js";
import {
  ensureTxtExtension,
  loadTxtFromPath,
  pickTxtPath,
  pickTxtSavePath,
} from "../txt-source.js";
import {
  confirmDialog,
  promptDialog,
  toast,
} from "../ui-feedback.js";

const $ = (id) => document.getElementById(id);

let textareaEl = null;
// `setTxtSource` 経由で外から流入した値を textarea へ反映するときに、自身の input
// イベントで生じた `setTxtSource` 呼び出しと再帰しないようにフラグでガードする。
let suppressInput = false;

function getEls() {
  return {
    textarea: $("editor-textarea"),
    empty: $("editor-empty"),
    open: $("editor-open-btn"),
    save: $("editor-save-btn"),
    saveAs: $("editor-saveas-btn"),
    copy: $("editor-copy-btn"),
    clear: $("editor-clear-btn"),
    markDelete: $("editor-mark-delete-btn"),
    ruby: $("editor-ruby-btn"),
    filename: $("editor-filename"),
    dirtyDot: $("editor-dirty-dot"),
    footerStats: $("editor-footer-stats"),
    footerDirty: $("editor-footer-dirty"),
  };
}

function baseName(p) {
  if (!p) return "";
  const m = p.match(/[\\/]([^\\/]+)$/);
  return m ? m[1] : p;
}

// 状態（content / filename / dirty）を DOM に反映する。
function syncFromState() {
  const els = getEls();
  if (!els.textarea) return;
  const source = getTxtSource();
  const path = getTxtFilePath();
  const dirty = getTxtDirty();
  const content = source?.content ?? "";

  // textarea に外部由来の content を流し込む。フォーカス中はカーソル位置を保つ。
  if (els.textarea.value !== content) {
    const wasFocused = document.activeElement === els.textarea;
    const start = wasFocused ? els.textarea.selectionStart : null;
    const end = wasFocused ? els.textarea.selectionEnd : null;
    const scroll = els.textarea.scrollTop;
    suppressInput = true;
    els.textarea.value = content;
    suppressInput = false;
    if (wasFocused && start != null && end != null) {
      const cap = els.textarea.value.length;
      els.textarea.selectionStart = Math.min(start, cap);
      els.textarea.selectionEnd = Math.min(end, cap);
    }
    els.textarea.scrollTop = scroll;
  }

  // ファイル名表示: 元パスがあれば basename、無ければ source.name、それも無ければ "テキスト未読込"。
  const display = path ? baseName(path) : (source?.name || "テキスト未読込");
  els.filename.textContent = display;
  els.filename.title = path || (source ? source.name : "");

  // ダーティドット表示。source 無しなら出さない。
  const showDirty = !!source && dirty;
  els.dirtyDot.hidden = !showDirty;
  els.footerDirty.hidden = !showDirty;

  // フッター文字数 / 行数。
  const charCount = content.length;
  const lineCount = content === "" ? 0 : content.split("\n").length;
  els.footerStats.textContent = `${charCount.toLocaleString()} 文字 / ${lineCount.toLocaleString()} 行`;

  // textarea が空のときは txt-source-empty と同じデザインの空表示を overlay する。
  // empty は pointer-events:none なので、ユーザーのクリックは下の textarea に届き、
  // フォーカス → 入力で content が変わり、自動的に empty が消える。
  if (els.empty) els.empty.hidden = content.length !== 0;

  // ボタンの enabled 制御。row1 のファイル操作ボタン群は UI から削除済みでも JS 側は
  // null チェックで no-op にして共存させる。row2 の「テキスト保存」ボタン (#editor-save-btn)
  // は path 有無を問わず source があれば有効（path 無しのときは別名保存に分岐する）。
  const hasContent = !!source;
  if (els.save) els.save.disabled = !hasContent;
  if (els.saveAs) els.saveAs.disabled = !hasContent;
  if (els.copy) els.copy.disabled = !hasContent;
  if (els.clear) els.clear.disabled = !hasContent;
  if (els.markDelete) els.markDelete.disabled = !hasContent;
  if (els.ruby) els.ruby.disabled = !hasContent;
}

function onTextareaInput() {
  if (suppressInput) return;
  const els = getEls();
  const content = els.textarea.value;
  // setTxtSource は txtSelection をリセットするが name は保持して上書き。
  const source = getTxtSource();
  setTxtSource({ name: source?.name || "untitled.txt", content });
  setTxtDirty(true);
}

async function handleOpen() {
  try {
    const path = await pickTxtPath();
    if (!path) return;
    await loadTxtFromPath(path);
  } catch (e) {
    console.error(e);
    toast(`テキスト読込失敗: ${e?.message ?? e}`, { kind: "error" });
  }
}

async function writeTxtFile(outputPath, content) {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("export_ai_text", { content, outputPath });
}

async function handleSave() {
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

// editor-toolbar-row2 の「テキスト保存」ボタン用エントリ。
// 元ファイルパスがあれば上書き、無ければ別名で保存（OCR 結果や browser D&D 由来など
// pathなし経路でも初回保存できるようにする）。
async function handleSaveAuto() {
  const source = getTxtSource();
  if (!source) return;
  if (getTxtFilePath()) await handleSave();
  else await handleSaveAs();
}

async function handleSaveAs() {
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

async function handleCopy() {
  const source = getTxtSource();
  if (!source) return;
  try {
    await navigator.clipboard.writeText(source.content);
    toast("クリップボードにコピーしました", { kind: "success", duration: 1500 });
  } catch (e) {
    console.error(e);
    toast(`コピー失敗: ${e?.message ?? e}`, { kind: "error" });
  }
}

async function handleClear() {
  if (!getTxtSource()) return;
  const ok = await confirmDialog({
    title: "テキストのクリア",
    message: "本文を空にして読込状態を解除します。よろしいですか？",
    confirmLabel: "クリア",
    kind: "danger",
  });
  if (!ok) return;
  clearTxtSource();
}

// textarea の現在カーソル / 選択がカバーしている「行範囲」を返す。
// returns: { startLineStart: number, endLineEnd: number, lines: string[], lineStartIndices: number[] }
function getLineRange(textarea) {
  const value = textarea.value;
  const selStart = textarea.selectionStart;
  const selEnd = textarea.selectionEnd;
  // 選択範囲を含む最初の行頭と最後の行末を求める。
  let startLineStart = value.lastIndexOf("\n", selStart - 1) + 1;
  let endLineEnd = value.indexOf("\n", selEnd);
  if (endLineEnd === -1) endLineEnd = value.length;
  // 選択末尾がちょうど行頭にあるとき（次行を巻き込まない）の補正。
  if (selEnd > selStart && selEnd === startLineStart) {
    // 選択 0 文字相当で 1 行のみ対象なら現状のまま。
  }
  const slice = value.slice(startLineStart, endLineEnd);
  const lines = slice.split("\n");
  return { startLineStart, endLineEnd, lines };
}

// // 削除マークの行頭トグル。全行に // が付いていれば外し、そうでなければ全行に付ける。
function handleToggleDeleteMark() {
  const els = getEls();
  const ta = els.textarea;
  if (!ta) return;
  const { startLineStart, endLineEnd, lines } = getLineRange(ta);
  if (lines.length === 0) return;
  const allMarked = lines.every((l) => /^\s*\/\//.test(l));
  const newLines = lines.map((l) => {
    if (allMarked) {
      // 既存の // を 1 つだけ外す。先頭スペースは保持。
      return l.replace(/^(\s*)\/\/\s?/, "$1");
    }
    if (/^\s*$/.test(l)) return l; // 空行はマークしない
    return `// ${l.replace(/^\s+/, "")}`;
  });
  const replacement = newLines.join("\n");
  // setRangeText でカーソル位置・スクロール位置を保ったまま置換。
  const scroll = ta.scrollTop;
  const selStart = ta.selectionStart;
  const selEnd = ta.selectionEnd;
  ta.setSelectionRange(startLineStart, endLineEnd);
  ta.setRangeText(replacement, startLineStart, endLineEnd, "preserve");
  // 選択範囲は新しい block 全体を再選択（ユーザーが連続でトグルできるよう）。
  ta.selectionStart = startLineStart;
  ta.selectionEnd = startLineStart + replacement.length;
  ta.scrollTop = scroll;
  // 入力イベントを発火 → setTxtSource + setTxtDirty が走る。
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

// 選択文字列を「親（ふりがな）」に置換。選択無し or キャンセルで no-op。
async function handleAddRuby() {
  const els = getEls();
  const ta = els.textarea;
  if (!ta) return;
  const selStart = ta.selectionStart;
  const selEnd = ta.selectionEnd;
  if (selEnd <= selStart) {
    toast("ルビを付けたい文字列を選択してください", { kind: "info", duration: 2000 });
    return;
  }
  const parent = ta.value.slice(selStart, selEnd);
  const ruby = await promptDialog({
    title: "ルビ付け",
    message: `「${parent}」のふりがなを入力`,
    placeholder: "ふりがな",
  });
  if (ruby == null || ruby === "") return;
  const replacement = `${parent}（${ruby}）`;
  const scroll = ta.scrollTop;
  ta.setSelectionRange(selStart, selEnd);
  ta.setRangeText(replacement, selStart, selEnd, "end");
  ta.scrollTop = scroll;
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

export function bindEditorPane() {
  const els = getEls();
  if (!els.textarea) return;
  textareaEl = els.textarea;

  // textarea 入力 → state へ反映。
  els.textarea.addEventListener("input", onTextareaInput);

  // ツールバー配線。
  els.open?.addEventListener("click", handleOpen);
  // row2 の「テキスト保存」ボタンは「ある元ファイル → 上書き / 無ければ別名」を自動分岐。
  els.save?.addEventListener("click", handleSaveAuto);
  els.saveAs?.addEventListener("click", handleSaveAs);
  els.copy?.addEventListener("click", handleCopy);
  els.clear?.addEventListener("click", handleClear);
  els.markDelete?.addEventListener("click", handleToggleDeleteMark);
  els.ruby?.addEventListener("click", handleAddRuby);

  // 状態変化を購読して DOM に反映。サイドパネル側 (txt-source-viewer) からの編集や
  // OCR 完了による setTxtSource もこのリスナー経由で textarea に流れる。
  onTxtSourceChange(syncFromState);
  onTxtFilePathChange(syncFromState);
  onTxtDirtyChange(syncFromState);

  // 初期化反映。
  syncFromState();
}

// view-mode が "editor" に切り替わったときの textarea フォーカス制御。
// main.js bindParallelViewMode が呼ぶ。
export function focusEditor() {
  if (!textareaEl) textareaEl = $("editor-textarea");
  if (textareaEl) requestAnimationFrame(() => textareaEl.focus());
}
