// テキストエディタペイン (view-mode "editor" 時に表示)。
// 原稿テキストパネル風のページ別 section + 中央配置入力欄を提供する。
//   - parsePages で `<<NPage>>` ごとに section 化、各段落は contenteditable で常時編集可能
//   - 編集確定 (blur / Ctrl+Enter) → updateTxtSourceBlock で原稿全体を書換 → state 同期
//   - 下部の #editor-new-input + #editor-new-input-btn で PSD ページ中央へ新規配置
//     (commitNewTxtInput を txt-source.js と共有)
//   - ページ送り (←/→) で対応する section を active 化 + scrollIntoView

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
} from "../state.js";
import { getPdfVirtualPageCount } from "../pdf-pages.js";
import {
  commitNewTxtInput,
  ensureTxtExtension,
  getActivePageNumber,
  getTxtPageCount,
  loadTxtFromPath,
  parsePages,
  pickTxtPath,
  pickTxtSavePath,
  syncNewInputAvailabilityFor,
  updateTxtSourceBlock,
} from "../txt-source.js";
import {
  confirmDialog,
  promptDialog,
  toast,
} from "../ui-feedback.js";

const $ = (id) => document.getElementById(id);

function getEls() {
  return {
    viewerWrap: $("editor-pages-viewer-wrap"),
    viewer: $("editor-pages-viewer"),
    empty: $("editor-empty"),
    newInput: $("editor-new-input"),
    newInputBtn: $("editor-new-input-btn"),
    save: $("editor-save-btn"),
    ruby: $("editor-ruby-btn"),
    filename: $("editor-filename"),
    dirtyDot: $("editor-dirty-dot"),
    footerStats: $("editor-footer-stats"),
    footerDirty: $("editor-footer-dirty"),
    pagePrev: $("editor-page-prev-btn"),
    pageNext: $("editor-page-next-btn"),
    pageLabel: $("editor-page-label"),
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

// 現在ページ番号（PSD or PDF/TXT 単体）。renderViewer の active 判定に使う。
function getCurrentActivePageNumber() {
  return getActivePageNumber();
}

// 現在ページの section のみを再描画する。
// ページ送り (onPageIndexChange / onPdfPageIndexChange) のたびに呼ばれ、
// 表示中の section が現在ページ用のものに置き換わる。
function renderViewer() {
  const els = getEls();
  if (!els.viewer) return;
  const source = getTxtSource();
  els.viewer.innerHTML = "";
  if (!source) {
    if (els.empty) els.empty.hidden = false;
    return;
  }
  const content = source.content ?? "";
  if (els.empty) els.empty.hidden = content.length !== 0;
  if (content.length === 0) return;

  const parsed = parsePages(content);
  const activeNum = getCurrentActivePageNumber();

  if (!parsed.hasMarkers) {
    // ページマーカー無し原稿: 1 つの section にすべての段落を入れる。
    const sec = buildSection(null, parsed.all, activeNum, true);
    els.viewer.appendChild(sec);
    return;
  }

  // 現在ページに対応する段落のみ抽出して 1 つの section として描画。
  // 該当ページにマーカーが無い / 段落が無い場合も section 自体は出して
  // 「（このページには段落がありません）」プレースホルダで明示する。
  const blocks = parsed.byPage.get(activeNum) ?? [];
  const sec = buildSection(activeNum, blocks, activeNum, false);
  els.viewer.appendChild(sec);
}

// pageNumber: マーカー有り → number, 無し → null
// blocks: 段落配列
// activeNum: 現在の active page number（active class 付与判定用）
// isMarkerless: true ならヘッダーを「ページ区切りなし」表記に
function buildSection(pageNumber, blocks, activeNum, isMarkerless) {
  const sec = document.createElement("section");
  sec.className = "editor-page-section";
  sec.dataset.pageNumber = String(pageNumber ?? 0);
  if (!isMarkerless && pageNumber === activeNum) sec.classList.add("active");
  if (isMarkerless) sec.classList.add("active"); // マーカー無しは常時 active 表示

  const header = document.createElement("header");
  header.className = "editor-page-section-header";
  header.textContent = isMarkerless
    ? "ページ区切りなし"
    : `P${pageNumLabel(pageNumber)}`;
  sec.appendChild(header);

  const body = document.createElement("div");
  body.className = "editor-page-section-body";
  if (blocks.length === 0) {
    const hint = document.createElement("div");
    hint.className = "editor-page-section-empty-hint";
    hint.textContent = "（このページには段落がありません）";
    body.appendChild(hint);
  } else {
    blocks.forEach((paragraph, idx) => {
      const el = document.createElement("div");
      el.className = "editor-page-paragraph";
      el.contentEditable = "true";
      el.spellcheck = false;
      el.dataset.paragraphIndex = String(idx);
      el.textContent = paragraph;
      bindParagraphEdit(el, paragraph, pageNumber);
      body.appendChild(el);
    });
  }
  sec.appendChild(body);
  return sec;
}

// 1 つの contenteditable 段落に編集 listener を張る。
//   - 編集開始時の originalText を closure で保持
//   - blur で innerText を取得し LF 正規化、originalText と異なれば updateTxtSourceBlock
//   - Ctrl+Enter / Cmd+Enter で blur → commit
//   - Escape で aborted=true → blur → revert
//   - IME 中は finalize しない
function bindParagraphEdit(el, originalText, pageNumber) {
  let aborted = false;
  let composing = false;

  el.addEventListener("compositionstart", () => { composing = true; });
  el.addEventListener("compositionend", () => { composing = false; });
  el.addEventListener("focus", () => { aborted = false; });

  el.addEventListener("keydown", (e) => {
    if (composing) return;
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      el.blur(); // → onBlur で commit
    } else if (e.key === "Escape") {
      e.preventDefault();
      aborted = true;
      el.blur(); // → onBlur で revert
    }
  });

  el.addEventListener("blur", () => {
    if (aborted) {
      // 元テキストに戻して終了。setTxtSource は呼ばないので listener も発火せず、
      // 他の編集状態は保持される。
      el.textContent = originalText;
      aborted = false;
      return;
    }
    // contenteditable の改行は browser によって <br> / <div> になり得るため、
    // textContent ではなく innerText で取得して LF 正規化する。
    const newText = (el.innerText ?? el.textContent ?? "").replace(/\r\n?/g, "\n");
    if (newText === originalText) return;
    // 空文字に変更されてもここでは段落削除はしない（過剰スコープ回避、UI で空段落として表示）。
    const changed = updateTxtSourceBlock(pageNumber, originalText, newText);
    if (changed) {
      // setTxtSource → onTxtSourceChange listener で renderViewer が走るので
      // この el への以降の操作は不要（DOM 自体が再構築される）。
      // 見た目のフラッシュ抑止のため、ここで el.contentEditable を一時的に false にしない。
    }
  });
}

// content / filename / dirty を DOM に反映（viewer 自体は別経路で再描画）。
function syncFromState() {
  const els = getEls();
  if (!els.viewer) return;
  const source = getTxtSource();
  const path = getTxtFilePath();
  const dirty = getTxtDirty();
  const content = source?.content ?? "";

  // ファイル名表示
  const display = path ? baseName(path) : (source?.name || "テキスト未読込");
  if (els.filename) {
    els.filename.textContent = display;
    els.filename.title = path || (source ? source.name : "");
  }

  // ダーティドット表示
  const showDirty = !!source && dirty;
  if (els.dirtyDot) els.dirtyDot.hidden = !showDirty;
  if (els.footerDirty) els.footerDirty.hidden = !showDirty;

  // フッター文字数 / 行数
  if (els.footerStats) {
    const charCount = content.length;
    const lineCount = content === "" ? 0 : content.split("\n").length;
    els.footerStats.textContent = `${charCount.toLocaleString()} 文字 / ${lineCount.toLocaleString()} 行`;
  }

  // ボタン enabled
  const hasContent = !!source;
  if (els.save) els.save.disabled = !hasContent;
  if (els.ruby) els.ruby.disabled = !hasContent;

  // 新規入力欄の disabled は PSD ロード状態 + 入力内容で更新
  if (els.newInput) syncNewInputAvailabilityFor(els.newInput);
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

// 元ファイルパスがあれば上書き、無ければ別名で保存（OCR 結果や browser D&D 由来など
// pathなし経路でも初回保存できるようにする）。
async function handleSaveAuto() {
  const source = getTxtSource();
  if (!source) return;
  if (getTxtFilePath()) await handleSave();
  else await handleSaveAs();
}

// ルビ付け: 現在フォーカス中の contenteditable 内で文字選択中なら、
// その範囲を「親（ふりがな）」に置換する。
async function handleAddRuby() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
    toast("ルビを付けたい文字列を選択してください", { kind: "info", duration: 2000 });
    return;
  }
  const range = sel.getRangeAt(0);
  // 選択範囲が contenteditable 段落内に収まっているか確認。
  const parent = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
    ? range.commonAncestorContainer.parentElement
    : range.commonAncestorContainer;
  const paragraph = parent && parent.closest && parent.closest(".editor-page-paragraph");
  if (!paragraph) {
    toast("段落内のテキストを選択してください", { kind: "info", duration: 2000 });
    return;
  }
  const parentText = sel.toString();
  if (!parentText) return;
  const ruby = await promptDialog({
    title: "ルビ付け",
    message: `「${parentText}」のふりがなを入力`,
    placeholder: "ふりがな",
  });
  if (ruby == null || ruby === "") return;
  const replacement = `${parentText}（${ruby}）`;
  // contenteditable の選択範囲を直接置換 → blur で updateTxtSourceBlock が走る。
  range.deleteContents();
  range.insertNode(document.createTextNode(replacement));
  // 選択を解除して caret を末尾に。
  sel.removeAllRanges();
  paragraph.focus();
  // 見た目を即時反映してから blur で commit を発火させる（focus → blur で
  // bindParagraphEdit の onBlur が走る）。
  paragraph.blur();
}

// 新規入力欄から中央配置をコミット。txt-source.js の commitNewTxtInput を共有。
function handleCommitNewInput() {
  const els = getEls();
  if (!els.newInput) return;
  commitNewTxtInput({ inputEl: els.newInput });
}

// 現在のページソース判定（main.js の activePageSource と同じロジックを local 実装）。
// main.js から import すると静的循環 import が発生し、評価順序によっては
// activePageSource が undefined のままバインドされる事故が起きる。state / pdf-pages /
// txt-source からは循環なく取れるので、ここで再実装する。
function localActivePageSource() {
  const psd = getPages().length;
  if (psd > 0) return { source: "psd", total: psd, current: getCurrentPageIndex() };
  const pdf = getPdfVirtualPageCount();
  if (pdf > 0) return { source: "pdf", total: pdf, current: getPdfPageIndex() };
  const txt = getTxtPageCount();
  if (txt > 0) return { source: "txt", total: txt, current: getPdfPageIndex() };
  return null;
}

// エディタモードのページ送り。同期モード固定で実装する（PDF/PSD ペインが
// 隠されているのでアクティブペインの概念が無いため、両ペイン共通の同期動作で OK）。
function localAdvancePage(delta) {
  const info = localActivePageSource();
  if (!info) return;
  const next = Math.max(0, Math.min(info.total - 1, info.current + delta));
  if (info.source === "psd") setCurrentPageIndex(next);
  else setPdfPageIndex(next); // pdf / txt はどちらも pdfPageIndex 駆動
}

// ページナビボタンのラベル / disabled を現在ページソースから更新する。
// 「P02 / 24」のような ゼロ埋め 2 桁表記。ソースが無いときは「— / —」。
function syncPageNav() {
  const els = getEls();
  if (!els.pageLabel) return;
  const info = localActivePageSource();
  if (!info || info.total <= 0) {
    els.pageLabel.textContent = "— / —";
    if (els.pagePrev) els.pagePrev.disabled = true;
    if (els.pageNext) els.pageNext.disabled = true;
    return;
  }
  const cur = info.current + 1; // 1-based 表示
  const padCur = String(cur).padStart(2, "0");
  els.pageLabel.textContent = `P${padCur} / ${info.total}`;
  if (els.pagePrev) els.pagePrev.disabled = info.current <= 0;
  if (els.pageNext) els.pageNext.disabled = info.current >= info.total - 1;
}

// Ctrl+← / Ctrl+→ でページ送り。
// エディタモード (view-mode === "editor") のときだけ動作させ、他モードでは
// 既存ショートカット (pageFirst / pageLast) を尊重する。
// capture フェーズで先取りして preventDefault + stopImmediatePropagation することで、
// settings.js の findShortcutMatch 経由の dispatcher より先に処理を奪う。
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
  if (els.newInputBtn) {
    els.newInputBtn.addEventListener("click", handleCommitNewInput);
  }
}

export function bindEditorPane() {
  const els = getEls();
  if (!els.viewer) return;

  // ツールバー (row2) 配線。row1 系のボタン (#editor-open-btn / #editor-saveas-btn /
  // #editor-copy-btn / #editor-clear-btn / #editor-mark-delete-btn) は HTML 上既に
  // 撤去されている。null チェックで安全に扱う。
  els.save?.addEventListener("click", handleSaveAuto);
  els.ruby?.addEventListener("click", handleAddRuby);

  // ページ移動ボタン
  els.pagePrev?.addEventListener("click", () => localAdvancePage(-1));
  els.pageNext?.addEventListener("click", () => localAdvancePage(+1));

  // 新規テキスト入力欄
  bindNewInput();

  // Ctrl+← / Ctrl+→ ショートカット（エディタモード時のみ active）
  document.addEventListener("keydown", onEditorPageNavShortcut, true);

  // txtSource 変化で全 viewer 再描画 + filename / dirty / footer 同期。
  // TXT 単体運用時は activePageSource の total が変わるためページラベルも更新。
  onTxtSourceChange(() => {
    renderViewer();
    syncFromState();
    syncPageNav();
  });
  onTxtFilePathChange(syncFromState);
  onTxtDirtyChange(syncFromState);

  // ページ送り連動: PSD or PDF の page index が変化 → 現在ページ用 section に再描画。
  // 旧仕様の「active class だけ動かす」ではなく、表示する section 自体を入れ替える。
  onPageIndexChange(() => {
    renderViewer();
    syncPageNav();
  });
  onPdfPageIndexChange(() => {
    // PSD 読込中は onPageIndexChange が同期ブリッジ経由で発火するためスキップ。
    if (getPages().length > 0) return;
    renderViewer();
    syncPageNav();
  });
  onPdfChange(() => {
    if (getPages().length > 0) return;
    renderViewer();
    syncPageNav();
  });

  // PSD ロード/クリアで新規入力欄の disabled を更新（getActivePageNumber も
  // 判定先が変わるため、現在ページ用 section に再描画する）。
  window.addEventListener("psdesign:psd-loaded", () => {
    if (els.newInput) syncNewInputAvailabilityFor(els.newInput);
    renderViewer();
    syncPageNav();
  });

  // 初期化反映。
  renderViewer();
  syncFromState();
  syncPageNav();
}

// view-mode が "editor" に切り替わったときのフォーカス制御。
// main.js bindParallelViewMode が呼ぶ。
// active section の最初の段落へフォーカスを移すと自然な編集開始位置になる。
export function focusEditor() {
  const viewer = $("editor-pages-viewer");
  if (!viewer) return;
  requestAnimationFrame(() => {
    const active = viewer.querySelector(".editor-page-section.active");
    const first = (active || viewer).querySelector(".editor-page-paragraph");
    if (first) first.focus();
  });
}
