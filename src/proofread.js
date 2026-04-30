// 校正パネル — Comic-Bridge の ProofreadPanel 相当を pdf-stage 上にオーバーレイ表示。
// 校正 JSON（MojiQ/Comic-Bridge 互換）を読み込んで、項目を「正誤 / 提案 / 全て」の
// 3 タブで表示する。項目クリックで該当ページへジャンプ。
//
// JSON 形式（どちらにも対応）:
// 1) ネスト形式: { work, checks: { simple: { items: [...] }, variation: { items: [...] } } }
// 2) フラット配列形式: [{ category, page, excerpt, content, checkKind }, ...]

import { setCurrentPageIndex } from "./state.js";
import { notifyDialog } from "./ui-feedback.js";

const $ = (id) => document.getElementById(id);

// MojiQ proofreading-panel.js の formatPage / jumpToPage 互換のパース。
// 「{N}ページ」「{N}P」を最優先で拾い、無ければ最初の数字。
// "1巻 16ページ" → 16（「巻」の前の 1 を誤って拾わない）。
// 旧実装は parseInt("1巻 16ページ", 10) で常に 1 を返していたため
// 校正項目をクリックすると常に 1 ページ目に飛んでしまっていた。
function parsePageNumber(pageStr) {
  if (!pageStr) return null;
  const s = String(pageStr);
  const withSuffix = s.match(/(\d+)\s*(?:ページ|P|p)/);
  if (withSuffix) {
    const n = parseInt(withSuffix[1], 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const head = s.match(/^\s*(\d+)/);
  if (head) {
    const n = parseInt(head[1], 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

// 校正 JSON の読み込み先ベースパス（MojiQ の calibration-panel と同じ共有ドライブ参照）。
// ProGen が出力した校正チェックデータが置かれるフォルダ。Tauri の open() に
// defaultPath として渡すので、ファイル選択ダイアログがこの場所で開く。
// 実環境にこのパスが無い場合は OS が親ディレクトリ等にフォールバックする。
const PROOFREAD_BASE_PATH =
  "G:\\共有ドライブ\\CLLENN\\編集部フォルダ\\編集企画部\\写植・校正用テキストログ";

// カテゴリ番号に対応する色（Comic-Bridge と同じ 10 色パレット）
const CATEGORY_COLORS = [
  "#3498db", "#27ae60", "#e67e22", "#9b59b6", "#1abc9c",
  "#e91e63", "#3f51b5", "#e74c3c", "#f1c40f", "#95a5a6",
];

function getCategoryColor(category) {
  const m = String(category || "").match(/^(\d+)\./);
  if (!m) return "#888";
  const idx = (parseInt(m[1], 10) - 1) % CATEGORY_COLORS.length;
  return CATEGORY_COLORS[idx];
}

let checkData = null;
// "correctness" | "proposal" | "both"
let checkTabMode = "both";

// ビュー：未読込 / 結果表示 / フォルダブラウザ
// "results" は checkData がある通常表示、"browser" は MojiQ 風のフォルダ選択 UI、
// "empty" は何も読み込まれていない初期状態（読込ボタン付きの案内）。
let viewMode = "empty";

// フォルダブラウザの状態（ブラウザ風 2 段履歴）
let browserCurrentPath = "";
let browserNavStack = [];      // 戻る用：祖先（後にキャンセルで戻れる）パスのスタック
let browserForwardStack = [];  // 進む用：戻った後に再訪できるパスのスタック

// txt-source.js と同じ UTF-8 BOM スキップ + Shift_JIS フォールバック。
function decodeBytes(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let offset = 0;
  if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) offset = 3;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(u8.subarray(offset));
  } catch {
    try { return new TextDecoder("shift_jis").decode(u8); }
    catch { return new TextDecoder("utf-8").decode(u8); }
  }
}

// 「JSON読込」ボタンの起点。OS のファイル選択ではなく、MojiQ 風の
// アプリ内フォルダブラウザを開く。
async function openBrowser() {
  viewMode = "browser";
  browserCurrentPath = PROOFREAD_BASE_PATH;
  browserNavStack = [];
  browserForwardStack = [];
  renderPanel();
  await loadBrowserFolder(PROOFREAD_BASE_PATH);
}

// 指定パスを表示するだけ。スタック管理は呼出側で行う方針（呼び出し元によって
// forwardStack の挙動が違うので、ここでは関与しない）。
async function loadBrowserFolder(dirPath) {
  const list = $("proofread-browser-list");
  if (list) {
    list.innerHTML = '<div class="proofread-browser-loading">読み込み中…</div>';
  }
  let entries;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    entries = await invoke("list_directory_entries", { path: dirPath });
  } catch (e) {
    console.error("[proofread] list_directory_entries failed:", e);
    if (list) {
      list.innerHTML = `<div class="proofread-browser-error">読み込みに失敗しました：${escapeHtml(String(e?.message ?? e))}</div>`;
    }
    return;
  }
  browserCurrentPath = dirPath;
  // MojiQ と同じ「校正チェックデータ」自動スキップ：
  // サブフォルダがそれ 1 つだけのときは「直接降りる」と同じ扱いで navStack に積む。
  const subFolders = (entries || []).filter((e) => e.isDirectory);
  if (subFolders.length === 1 && subFolders[0].name === "校正チェックデータ") {
    browserNavStack.push(dirPath);
    await loadBrowserFolder(subFolders[0].path);
    return;
  }
  renderBrowserList(entries || []);
  renderBrowserBreadcrumb();
}

// フォルダクリック等で「直接降りる」とき。current を navStack に push し、forward 履歴は破棄。
async function browserNavigateInto(dirPath) {
  if (browserCurrentPath) browserNavStack.push(browserCurrentPath);
  browserForwardStack = [];
  await loadBrowserFolder(dirPath);
}

function renderBrowserList(entries) {
  const list = $("proofread-browser-list");
  if (!list) return;
  // フォルダ → JSON ファイルの順、それぞれ日本語ロケールでソート。
  const collator = new Intl.Collator("ja", { numeric: true, sensitivity: "base" });
  const folders = entries.filter((e) => e.isDirectory).sort((a, b) => collator.compare(a.name, b.name));
  const files = entries
    .filter((e) => e.isFile && /\.json$/i.test(e.name))
    .sort((a, b) => collator.compare(a.name, b.name));
  const items = [...folders, ...files];

  if (items.length === 0) {
    list.innerHTML = '<div class="proofread-browser-empty">このフォルダには JSON ファイルがありません</div>';
    return;
  }

  list.innerHTML = "";
  for (const item of items) {
    const row = document.createElement("div");
    row.className = item.isDirectory ? "proofread-browser-row folder" : "proofread-browser-row file";
    row.tabIndex = 0;
    row.dataset.path = item.path;

    const icon = document.createElement("span");
    icon.className = "proofread-browser-icon";
    icon.innerHTML = item.isDirectory
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
      : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
    row.appendChild(icon);

    const name = document.createElement("span");
    name.className = "proofread-browser-name";
    name.textContent = item.name;
    row.appendChild(name);

    const handler = () => {
      if (item.isDirectory) {
        void browserNavigateInto(item.path);
      } else {
        void loadJsonFromPath(item.path);
      }
    };
    row.addEventListener("click", handler);
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handler();
      }
    });
    list.appendChild(row);
  }
}

function renderBrowserBreadcrumb() {
  // パンくず（current path 表示）は廃止。残るのは戻る/進むボタンの disabled 同期のみ。
  const backBtn = $("proofread-browser-back-btn");
  const fwdBtn = $("proofread-browser-forward-btn");
  if (backBtn) backBtn.disabled = browserNavStack.length === 0;
  if (fwdBtn) fwdBtn.disabled = browserForwardStack.length === 0;
}

function browserGoUp() {
  if (browserNavStack.length === 0) return;
  // 戻る：current を forwardStack に積んでから navStack を pop。
  if (browserCurrentPath) browserForwardStack.push(browserCurrentPath);
  const prev = browserNavStack.pop();
  void loadBrowserFolder(prev);
}

function browserGoForward() {
  if (browserForwardStack.length === 0) return;
  // 進む：current を navStack に積んでから forwardStack を pop。
  if (browserCurrentPath) browserNavStack.push(browserCurrentPath);
  const next = browserForwardStack.pop();
  void loadBrowserFolder(next);
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function loadJsonFromPath(filePath) {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const bytes = await invoke("read_binary_file", { path: filePath });
    const content = decodeBytes(bytes);
    let data;
    try { data = JSON.parse(content); }
    catch (e) {
      throw new Error(`JSONの解析に失敗しました: ${e?.message ?? e}`);
    }

    const allItems = [];
    const parseGroup = (src, fallbackKind) => {
      const arr = Array.isArray(src) ? src : Array.isArray(src?.items) ? src.items : null;
      if (!arr) return;
      for (const item of arr) {
        allItems.push({
          picked: false,
          category: item.category || "",
          page: item.page != null ? String(item.page) : "",
          excerpt: item.excerpt || "",
          content: item.content || item.text || "",
          checkKind: item.checkKind === "proposal" || item.checkKind === "correctness"
            ? item.checkKind
            : fallbackKind,
        });
      }
    };

    if (data && data.checks) {
      parseGroup(data.checks.simple, "correctness");
      parseGroup(data.checks.variation, "proposal");
    } else if (Array.isArray(data)) {
      parseGroup(data, "correctness");
    } else {
      throw new Error("校正JSONの形式が正しくありません（checks フィールド or 配列形式が必要です）");
    }

    const baseName = filePath.replace(/^.*[\\/]/, "");
    checkData = {
      title: (data && typeof data.work === "string") ? data.work : "",
      fileName: baseName,
      filePath,
      allItems,
      correctnessItems: allItems.filter((i) => i.checkKind === "correctness"),
      proposalItems: allItems.filter((i) => i.checkKind === "proposal"),
    };
    viewMode = "results";
    renderPanel();
  } catch (e) {
    console.error("[proofread] load failed:", e);
    await notifyDialog({
      title: "校正JSON読み込みエラー",
      message: `校正JSONを読み込めませんでした。\n\n${e?.message ?? e}`,
    });
  }
}

function setMode(mode) {
  if (mode !== "correctness" && mode !== "proposal" && mode !== "both") return;
  checkTabMode = mode;
  renderPanel();
}

// 校正 JSON のパスから「作品フォルダ名」と「巻数」を推定する。
// 想定パス例: .../<作品名>/<巻数>/校正チェックデータ/<file.json>
//   - ファイル直近の親が "校正チェックデータ" なら 1 段スキップ（MojiQ 流の自動降下と整合）
//   - その上の階層を「巻数」、さらに 1 段上を「フォルダ名」として扱う
// 階層が浅いケースは取れた範囲だけ返す（不足は空文字）。
function deriveProofreadMeta(filePath) {
  if (!filePath) return { folder: "", volume: "" };
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  if (parts.length < 2) return { folder: "", volume: "" };
  // parts[last] = file.json なので、directory chain は last-1 から
  let baseIdx = parts.length - 2;
  if (parts[baseIdx] === "校正チェックデータ" && baseIdx > 0) baseIdx -= 1;
  const volume = parts[baseIdx] || "";
  const folder = baseIdx >= 1 ? (parts[baseIdx - 1] || "") : "";
  return { folder, volume };
}

function renderProofreadMeta() {
  const meta = $("proofread-meta");
  if (!meta) return;
  // browser ビュー or empty ビュー（checkData 無し）では非表示
  if (!checkData || viewMode !== "results") {
    meta.hidden = true;
    meta.innerHTML = "";
    return;
  }
  const { folder, volume } = deriveProofreadMeta(checkData.filePath);
  meta.innerHTML = "";
  // フォルダ + 巻数が両方取れない場合は、JSON 内の work 名 / ファイル名にフォールバック
  // 表示。checkData がある以上は必ず何か出して「何が読み込まれているか」を可視化する。
  if (!folder && !volume) {
    const fallback = document.createElement("span");
    fallback.className = "proofread-meta-folder";
    fallback.textContent = checkData.title || checkData.fileName || "(読込済み)";
    meta.appendChild(fallback);
    meta.hidden = false;
    return;
  }
  meta.hidden = false;
  if (folder) {
    const f = document.createElement("span");
    f.className = "proofread-meta-folder";
    f.textContent = folder;
    meta.appendChild(f);
  }
  if (folder && volume) {
    const sep = document.createElement("span");
    sep.className = "proofread-meta-sep";
    sep.textContent = "/";
    meta.appendChild(sep);
  }
  if (volume) {
    const v = document.createElement("span");
    v.className = "proofread-meta-volume";
    v.textContent = volume;
    meta.appendChild(v);
  }
}

function renderPanel() {
  // タブボタンの active 同期。browser 表示中はタブグループ自体を hidden に。
  const inBrowser = viewMode === "browser";
  for (const btn of document.querySelectorAll(".proofread-tab")) {
    const active = btn.dataset.tab === checkTabMode;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  }
  const tabsEl = $("proofread-tabs");
  if (tabsEl) tabsEl.hidden = inBrowser;
  // ブラウザナビ（戻る/進む/パンくず）の表示切替
  const navEl = $("proofread-browser-nav");
  if (navEl) navEl.hidden = !inBrowser;
  // 「キャンセル」はブラウザモード時のみ表示
  const cancelBtn = $("proofread-browser-cancel-btn");
  if (cancelBtn) cancelBtn.hidden = !inBrowser;
  // 「JSON読込」はブラウザモード以外（empty / results）で表示
  const loadBtn = $("proofread-load-btn");
  if (loadBtn) loadBtn.hidden = inBrowser;
  // browser モードに入ったらボタンの disabled とパンくずも同期
  if (inBrowser) renderBrowserBreadcrumb();

  const body = $("proofread-body");
  if (!body) return;
  body.innerHTML = "";

  // 読込済み JSON のメタ情報行を更新（results ビュー時のみ表示）
  renderProofreadMeta();

  // ── フォルダブラウザビュー ──
  if (viewMode === "browser") {
    body.appendChild(renderBrowser());
    return;
  }

  // ── 未読込（empty）ビュー ──
  if (!checkData) {
    const empty = document.createElement("div");
    empty.className = "proofread-empty";
    // MojiQ の「校正チェックを読み込み」と同じ list-checks SVG。
    const iconWrap = document.createElement("div");
    iconWrap.className = "proofread-empty-icon-wrap";
    iconWrap.innerHTML =
      '<svg class="proofread-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<line x1="10" y1="6" x2="21" y2="6"/>' +
      '<line x1="10" y1="12" x2="21" y2="12"/>' +
      '<line x1="10" y1="18" x2="21" y2="18"/>' +
      '<polyline points="3,6 4,7 6,5"/>' +
      '<polyline points="3,12 4,13 6,11"/>' +
      '<polyline points="3,18 4,19 6,17"/>' +
      '</svg>';
    empty.appendChild(iconWrap);
    const p = document.createElement("p");
    p.className = "proofread-empty-text";
    p.textContent = "校正チェックJSONを読み込んでください";
    empty.appendChild(p);
    body.appendChild(empty);
    return;
  }

  // ── 結果表示ビュー ──
  if (checkTabMode === "both") {
    const both = document.createElement("div");
    both.className = "proofread-2col";
    both.appendChild(renderColumn("correctness", "正誤チェック", checkData.correctnessItems));
    both.appendChild(renderColumn("proposal", "提案チェック", checkData.proposalItems));
    body.appendChild(both);
  } else {
    const items = checkTabMode === "correctness"
      ? checkData.correctnessItems
      : checkData.proposalItems;
    body.appendChild(renderList(items));
  }
}

// MojiQ 風のフォルダブラウザのリスト本体だけを返す（戻る/進む/パンくず/キャンセルは
// 共通ヘッダー側 .proofread-panel-header に移動済み）。
// 一覧の中身は loadBrowserFolder の中で renderBrowserList が後から書き換える。
function renderBrowser() {
  const wrap = document.createElement("div");
  wrap.className = "proofread-browser";

  const list = document.createElement("div");
  list.id = "proofread-browser-list";
  list.className = "proofread-browser-list";
  list.innerHTML = '<div class="proofread-browser-loading">読み込み中…</div>';
  wrap.appendChild(list);
  return wrap;
}

// kind 別の見出しアイコン SVG（lucide ベース）。
// correctness = check-circle（緑）、proposal = file-text（オレンジ）。
const COL_ICON_SVG = {
  correctness:
    '<svg class="proofread-col-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="10"/><polyline points="8 12.5 11 15.5 16 9.5"/></svg>',
  proposal:
    '<svg class="proofread-col-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>' +
    '<polyline points="14 2 14 8 20 8"/>' +
    '<line x1="16" y1="13" x2="8" y2="13"/>' +
    '<line x1="16" y1="17" x2="8" y2="17"/>' +
    '<line x1="10" y1="9" x2="8" y2="9"/></svg>',
};

function renderColumn(kind, title, items) {
  const col = document.createElement("div");
  col.className = "proofread-col";

  const header = document.createElement("div");
  header.className = `proofread-col-header ${kind}`;
  const iconSpan = document.createElement("span");
  iconSpan.className = "proofread-col-icon-wrap";
  iconSpan.innerHTML = COL_ICON_SVG[kind] || "";
  const titleSpan = document.createElement("span");
  titleSpan.textContent = title;
  const countSpan = document.createElement("span");
  countSpan.className = "proofread-col-count";
  countSpan.textContent = `(${items.length})`;
  header.appendChild(iconSpan);
  header.appendChild(titleSpan);
  header.appendChild(countSpan);
  col.appendChild(header);

  const list = document.createElement("div");
  list.className = "proofread-col-list";
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "proofread-empty-list";
    empty.textContent = "該当なし";
    list.appendChild(empty);
  } else {
    for (const item of items) list.appendChild(renderItem(item));
  }
  col.appendChild(list);
  return col;
}

function renderList(items) {
  const list = document.createElement("div");
  list.className = "proofread-list";
  if (!items || items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "proofread-empty-list";
    empty.textContent = "該当する項目がありません";
    list.appendChild(empty);
    return list;
  }
  for (const item of items) list.appendChild(renderItem(item));
  return list;
}

function renderItem(item) {
  const el = document.createElement("div");
  el.className = "proofread-item";

  const meta = document.createElement("div");
  meta.className = "proofread-item-meta";

  const badge = document.createElement("span");
  badge.className = "proofread-cat-badge";
  badge.style.backgroundColor = getCategoryColor(item.category);
  badge.textContent = item.category || "—";
  meta.appendChild(badge);

  const parsedPage = parsePageNumber(item.page);
  if (item.page) {
    if (parsedPage !== null) {
      // MojiQ 風ハイパーリンク: 青文字 + ホバー下線 + クリックでジャンプ
      const p = document.createElement("button");
      p.type = "button";
      p.className = "proofread-page proofread-page-link";
      p.textContent = `p.${item.page}`;
      p.title = `ページ ${parsedPage} へジャンプ`;
      p.addEventListener("click", (e) => {
        e.stopPropagation(); // 行クリックとの二重発火を防止
        setCurrentPageIndex(parsedPage - 1);
      });
      meta.appendChild(p);
    } else {
      // パース失敗時はリンクにせず通常表示（押せないリンクで誤解させない）
      const p = document.createElement("span");
      p.className = "proofread-page";
      p.textContent = `p.${item.page}`;
      meta.appendChild(p);
    }
  }

  const kindEl = document.createElement("span");
  kindEl.className = `proofread-kind ${item.checkKind}`;
  kindEl.textContent = item.checkKind === "correctness" ? "正誤" : "提案";
  meta.appendChild(kindEl);

  el.appendChild(meta);

  if (item.excerpt) {
    const ex = document.createElement("div");
    ex.className = "proofread-excerpt";
    ex.textContent = item.excerpt;
    el.appendChild(ex);
  }
  if (item.content) {
    const c = document.createElement("div");
    c.className = "proofread-content";
    c.textContent = item.content;
    el.appendChild(c);
  }

  el.addEventListener("click", () => {
    if (!item.page) return;
    const pn = parsePageNumber(item.page);
    if (pn !== null) setCurrentPageIndex(pn - 1);
  });

  return el;
}

function isPanelOpen() {
  const panel = $("proofread-panel");
  return !!panel && !panel.hidden;
}

function setPanelOpen(open) {
  const panel = $("proofread-panel");
  const toggleBtn = $("proofread-toggle-btn");
  if (!panel) return;
  panel.hidden = !open;
  if (toggleBtn) toggleBtn.setAttribute("aria-pressed", open ? "true" : "false");
  if (open) {
    // パネルを開いた時点で適切な viewMode を選ぶ。
    if (!checkData) viewMode = "empty";
    else if (viewMode !== "browser") viewMode = "results";
    renderPanel();
  }
}

function togglePanel() {
  setPanelOpen(!isPanelOpen());
}

export function bindProofreadUi() {
  const toggleBtn = $("proofread-toggle-btn");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePanel();
    });
  }

  // 閉じるボタンは廃止（校正トグルボタンで開閉できるため不要）

  // ヘッダーの「JSON読込」: フォルダブラウザを開く（既存 openBrowser に直結）。
  const loadBtn = $("proofread-load-btn");
  if (loadBtn) loadBtn.addEventListener("click", openBrowser);

  // ヘッダーに移したフォルダブラウザのナビゲーション。
  const backBtn = $("proofread-browser-back-btn");
  if (backBtn) backBtn.addEventListener("click", browserGoUp);

  const fwdBtn = $("proofread-browser-forward-btn");
  if (fwdBtn) fwdBtn.addEventListener("click", browserGoForward);

  const cancelBtn = $("proofread-browser-cancel-btn");
  if (cancelBtn) cancelBtn.addEventListener("click", () => {
    viewMode = checkData ? "results" : "empty";
    renderPanel();
  });

  for (const tab of document.querySelectorAll(".proofread-tab")) {
    tab.addEventListener("click", () => setMode(tab.dataset.tab));
  }

  // 初期状態を反映（hidden のまま、データ無し）。
  renderPanel();
}
