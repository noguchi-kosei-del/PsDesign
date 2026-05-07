// スタイルパレット — Photoshop UXP プラグイン `stylepallet`
// (C:\Users\noguchi-kosei\Desktop\ネイティブデータ\stylepallet) の機能を PsDesign に移植。
//
// テキスト編集セクション内のフォントピッカーを、社内で curate された JSON プリセット
// （カテゴリ別、和名 / 英名 / subName / description）から選んで適用する UI に置き換える。
//
// JSON 形式（3 形式互換、stylepallet と同じ）:
// 1) 新形式:   { presetData: { presets: { [category]: [...] } } }
// 2) 旧形式:   { presets: { [category]: [...] } }
// 3) 最古形式: { [category]: [...] }
//
// 適用フロー:
// - クリック: .selected ハイライト + 説明文表示（state は変更しない）
// - dblclick: 選択中レイヤーに commitFontToSelections で一括適用、選択 0 件なら state.currentFont
//   に保存（次に配置するテキストの既定フォントとして使われる）
// - setFontPickerStuck(true) も併せて呼ぶので、その後 V ツールで別レイヤーを
//   クリックするとブラシモードで連続適用される（v1.3.0 B 節既存挙動に乗る）

import { invoke } from "@tauri-apps/api/core";
import {
  setCurrentFont,
  getSelectedLayers,
  setFontPickerStuck,
} from "./state.js";
import { commitFontToSelections } from "./text-editor.js";
import { showModalAnimated, hideModalAnimated } from "./ui-feedback.js";

// 校正パネルと同じ共有ドライブベース。stylepallet オリジナルの ROOT_PATH を踏襲。
const STYLE_PALETTE_ROOT_PATH =
  "G:\\共有ドライブ\\CLLENN\\編集部フォルダ\\編集企画部\\編集企画_C班(AT業務推進)\\DTP制作部\\JSONフォルダ";

const LAST_JSON_KEY = "psdesign_style_palette_last_json";

// ---------- モジュール状態 ----------
let presets = [];                  // Array<Preset>
let categoryMap = null;            // {[category]: Preset[]}
let categoryOrder = [];            // 表示順保持（Object.keys は挿入順）
let activeCategory = null;         // 現在表示中のカテゴリ名（null = フィルタ中の flat 表示）
let selectedPresetIndex = -1;      // クリック選択中の preset の originalIndex（-1 = 未選択）
let lastLoadedJsonPath = null;
let searchTimer = null;

// フォルダブラウザ状態（校正パネル流の戻る/進むスタック）
let browserCurrentPath = "";
let browserNavStack = [];
let browserForwardStack = [];

const $ = (id) => document.getElementById(id);

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// txt-source.js / proofread.js と同じ UTF-8 BOM スキップ + Shift_JIS フォールバック。
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

// ---------- JSON パース（stylepallet prepareFontListData 移植） ----------
function parsePresetJson(raw) {
  presets = [];
  let sourceData = null;
  if (raw?.presetData?.presets && typeof raw.presetData.presets === "object") {
    sourceData = raw.presetData.presets;
  } else if (raw?.presets && typeof raw.presets === "object") {
    sourceData = raw.presets;
  } else if (raw && typeof raw === "object") {
    sourceData = raw;
  }
  if (!sourceData || typeof sourceData !== "object") return;
  for (const setName in sourceData) {
    if (setName === "workInfo" || setName === "strokeSizes" || setName === "fontSizeStats") continue;
    const arr = sourceData[setName];
    if (!Array.isArray(arr) || arr.length === 0) continue;
    for (const p of arr) {
      if (!p || !p.name) continue;
      const displayName = p.subName ? `${p.subName} / ${p.name}` : p.name;
      presets.push({
        displayName,
        name: p.name,
        subName: p.subName || null,
        fontName: p.font,
        description: p.description || "",
        category: setName,
      });
    }
  }
}

// ---------- リスト描画 ----------
function rebuildCategoryMap() {
  categoryMap = {};
  categoryOrder = [];
  for (const p of presets) {
    const cat = p.category || "その他";
    if (!categoryMap[cat]) {
      categoryMap[cat] = [];
      categoryOrder.push(cat);
    }
    categoryMap[cat].push(p);
  }
}

function renderList(filterText = "") {
  const list = $("style-palette-list");
  const catSelect = $("style-palette-category");
  if (!list) return;

  if (presets.length === 0) {
    list.innerHTML = '<div class="style-palette-empty">プリセット JSON を読み込んでください</div>';
    if (catSelect) catSelect.hidden = true;
    return;
  }

  const filter = (filterText || "").toLowerCase();
  // originalIndex を埋め込み（dblclick で参照）
  for (let i = 0; i < presets.length; i++) presets[i].originalIndex = i;

  const filtered = filter
    ? presets.filter((d) =>
        (d.displayName ?? "").toLowerCase().includes(filter) ||
        (d.fontName ?? "").toLowerCase().includes(filter) ||
        (d.category ?? "").toLowerCase().includes(filter))
    : presets;

  if (filtered.length === 0) {
    list.innerHTML = '<div class="style-palette-empty">該当するフォントがありません</div>';
    if (catSelect) catSelect.hidden = true;
    return;
  }

  // フィルタ中はカテゴリ dropdown 非表示・flat 表示。
  // フィルタ無し + 複数カテゴリのときだけ dropdown を出して切替式に。
  const useDropdown = !filter && categoryOrder.length > 1;

  if (useDropdown) {
    if (catSelect) {
      catSelect.hidden = false;
      catSelect.innerHTML = "";
      if (!activeCategory || !categoryMap[activeCategory]) {
        activeCategory = categoryOrder[0];
      }
      for (const cat of categoryOrder) {
        const opt = document.createElement("option");
        opt.value = cat;
        opt.textContent = `${cat} (${categoryMap[cat].length})`;
        if (cat === activeCategory) opt.selected = true;
        catSelect.appendChild(opt);
      }
    }
    renderItems(categoryMap[activeCategory] || []);
  } else {
    if (catSelect) catSelect.hidden = true;
    activeCategory = null;
    renderItems(filtered);
  }
}

function renderItems(items) {
  const list = $("style-palette-list");
  if (!list) return;
  list.innerHTML = "";
  for (const preset of items) {
    list.appendChild(createPresetItem(preset));
  }
}

function createPresetItem(preset) {
  const item = document.createElement("div");
  item.className = "style-palette-item";
  item.dataset.index = String(preset.originalIndex);
  if (preset.originalIndex === selectedPresetIndex) {
    item.classList.add("selected");
  }
  item.title = preset.description || preset.displayName;

  const main = document.createElement("div");
  main.className = "style-palette-item-name";
  main.textContent = preset.subName || preset.name;
  item.appendChild(main);

  if (preset.subName) {
    const sub = document.createElement("div");
    sub.className = "style-palette-item-sub";
    sub.textContent = preset.name;
    item.appendChild(sub);
  }

  // クリック: 選択ハイライト + ブラシモード起動 + 選択中レイヤーへの即時適用。
  // applyPreset が:
  //   - レイヤー選択あり: commitFontToSelections で即時適用
  //   - レイヤー選択なし: 「次に配置するテキスト」の既定フォントとして state に保存
  // 両ケースで setFontPickerStuck(true) を立てるので、その後 V ツールで別フレームを
  // 1 クリックすると brush mode で自動適用される。
  item.addEventListener("click", () => {
    selectedPresetIndex = preset.originalIndex;
    for (const el of $("style-palette-list").querySelectorAll(".style-palette-item")) {
      el.classList.remove("selected");
    }
    item.classList.add("selected");
    applyPreset(preset);
  });

  return item;
}

// ---------- 検索（200ms デバウンス） ----------
function handleSearch() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const input = $("style-palette-search");
    renderList(input ? input.value : "");
  }, 200);
}

// ---------- プリセット適用 ----------
function applyPreset(preset) {
  if (!preset?.fontName) return;
  const sel = getSelectedLayers();
  if (sel.length > 0) {
    // 選択中のレイヤーがあれば一括適用（Ctrl+Z 1 回で巻き戻る）。
    commitFontToSelections(preset.fontName);
  }
  // currentFont と sticky brush は常に更新する。
  // 選択 0 件のときは「次に配置するテキスト」の既定フォントとして state に残る。
  setCurrentFont(preset.fontName);
  setFontPickerStuck(true);
}

// ---------- JSON 読込 ----------
export async function loadJsonFromPath(path) {
  if (!path) return false;
  let raw;
  try {
    const bytes = await invoke("read_binary_file", { path });
    const text = decodeBytes(bytes);
    raw = JSON.parse(text);
  } catch (e) {
    console.error("[style-palette] read JSON failed:", e);
    showLoadError(`JSON 読込失敗: ${e?.message ?? e}`);
    return false;
  }
  parsePresetJson(raw);
  if (presets.length === 0) {
    showLoadError("有効なプリセットが見つかりませんでした。");
    return false;
  }
  rebuildCategoryMap();
  selectedPresetIndex = -1;
  activeCategory = null;
  lastLoadedJsonPath = path;
  try { localStorage.setItem(LAST_JSON_KEY, path); } catch (_) {}
  // 検索欄もリセット
  const search = $("style-palette-search");
  if (search) search.value = "";
  renderList("");
  return true;
}

// 「ホームに戻る」で呼ばれるリセット関数。読み込んだ JSON / プリセット一覧 /
// 直前パスの localStorage / 検索欄 / カテゴリ dropdown / 説明文表示 を全てクリアし、
// 起動直後の「プリセット JSON を読み込んでください」状態に戻す。
export function resetStylePaletteState() {
  presets = [];
  categoryMap = null;
  categoryOrder = [];
  activeCategory = null;
  selectedPresetIndex = -1;
  lastLoadedJsonPath = null;
  try { localStorage.removeItem(LAST_JSON_KEY); } catch (_) {}
  const search = $("style-palette-search");
  if (search) search.value = "";
  const catSelect = $("style-palette-category");
  if (catSelect) {
    catSelect.innerHTML = "";
    catSelect.hidden = true;
  }
  const list = $("style-palette-list");
  if (list) {
    list.innerHTML = '<div class="style-palette-empty">プリセット JSON を読み込んでください</div>';
  }
}

function showLoadError(message) {
  const list = $("style-palette-list");
  if (list) {
    list.innerHTML = `<div class="style-palette-empty">${escapeHtml(message)}</div>`;
  }
}

// ---------- フォルダブラウザ（校正パネル流） ----------
async function openBrowser() {
  const modal = $("style-palette-browser-modal");
  if (!modal) return;
  // 直前の場所があればそこから開く、無ければルート。
  const startPath = lastLoadedJsonPath
    ? lastLoadedJsonPath.replace(/[\\/][^\\/]+$/, "")
    : STYLE_PALETTE_ROOT_PATH;
  browserCurrentPath = startPath;
  browserNavStack = [];
  browserForwardStack = [];
  showModalAnimated(modal);
  await loadBrowserFolder(startPath);
}

function closeBrowser() {
  const modal = $("style-palette-browser-modal");
  if (modal) hideModalAnimated(modal);
}

async function loadBrowserFolder(dirPath) {
  const list = $("style-palette-browser-list");
  if (list) {
    list.innerHTML = '<div class="style-palette-browser-loading">読み込み中…</div>';
  }
  let entries;
  try {
    entries = await invoke("list_directory_entries", { path: dirPath });
  } catch (e) {
    console.error("[style-palette] list_directory_entries failed:", e);
    if (list) {
      list.innerHTML = `<div class="style-palette-browser-error">読み込みに失敗しました：${escapeHtml(String(e?.message ?? e))}</div>`;
    }
    renderBrowserNav();
    return;
  }
  browserCurrentPath = dirPath;
  renderBrowserList(entries || []);
  renderBrowserNav();
}

async function browserNavigateInto(dirPath) {
  if (browserCurrentPath) browserNavStack.push(browserCurrentPath);
  browserForwardStack = [];
  await loadBrowserFolder(dirPath);
}

async function browserGoBack() {
  if (browserNavStack.length === 0) return;
  if (browserCurrentPath) browserForwardStack.push(browserCurrentPath);
  const prev = browserNavStack.pop();
  await loadBrowserFolder(prev);
}

async function browserGoForward() {
  if (browserForwardStack.length === 0) return;
  if (browserCurrentPath) browserNavStack.push(browserCurrentPath);
  const next = browserForwardStack.pop();
  await loadBrowserFolder(next);
}

function renderBrowserList(entries) {
  const list = $("style-palette-browser-list");
  if (!list) return;
  const collator = new Intl.Collator("ja", { numeric: true, sensitivity: "base" });
  const folders = entries.filter((e) => e.isDirectory).sort((a, b) => collator.compare(a.name, b.name));
  const files = entries
    .filter((e) => e.isFile && /\.json$/i.test(e.name))
    .sort((a, b) => collator.compare(a.name, b.name));
  const items = [...folders, ...files];

  if (items.length === 0) {
    list.innerHTML = '<div class="style-palette-browser-empty">このフォルダには JSON ファイルがありません</div>';
    return;
  }

  list.innerHTML = "";
  for (const entry of items) {
    const row = document.createElement("div");
    row.className = entry.isDirectory ? "style-palette-browser-row folder" : "style-palette-browser-row file";
    row.tabIndex = 0;

    const icon = document.createElement("span");
    icon.className = "style-palette-browser-icon";
    icon.innerHTML = entry.isDirectory
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
      : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
    row.appendChild(icon);

    const name = document.createElement("span");
    name.className = "style-palette-browser-name";
    name.textContent = entry.name;
    row.appendChild(name);

    const handler = async () => {
      if (entry.isDirectory) {
        await browserNavigateInto(entry.path);
      } else {
        const ok = await loadJsonFromPath(entry.path);
        if (ok) closeBrowser();
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

function renderBrowserNav() {
  const back = $("style-palette-browser-back-btn");
  const fwd = $("style-palette-browser-forward-btn");
  if (back) back.disabled = browserNavStack.length === 0;
  if (fwd) fwd.disabled = browserForwardStack.length === 0;
}

// ---------- 配線 ----------
export function bindStylePalette() {
  // 検索 input
  const search = $("style-palette-search");
  if (search) {
    search.addEventListener("input", handleSearch);
  }

  // カテゴリ切替
  const catSelect = $("style-palette-category");
  if (catSelect) {
    catSelect.addEventListener("change", () => {
      activeCategory = catSelect.value;
      renderItems(categoryMap?.[activeCategory] ?? []);
    });
  }

  // 外側クリックでプリセット選択（visual highlight）と brush mode (fontPickerStuck) をクリア。
  // mousedown ではなく click を使うことで、frame click → mousedown で brush apply →
  // click で brush clear の順序を保証し、apply が阻害されない。
  // - canvas 上の frame: mousedown ハンドラで maybeApplyStickyFont が走る → 後の document click で clear
  // - レイヤー一覧の row: click ハンドラで selectLayer → maybeApplyStickyFont が走る
  //   → 同 click 後に document click で clear（target click が先、document bubble が後）
  document.addEventListener("click", (e) => {
    const palette = $("style-palette");
    if (!palette) return;
    if (palette.contains(e.target)) return; // パレット内クリックは保持
    if (selectedPresetIndex !== -1) {
      selectedPresetIndex = -1;
      for (const el of palette.querySelectorAll(".style-palette-item.selected")) {
        el.classList.remove("selected");
      }
    }
    setFontPickerStuck(false);
  });

  // 読込ボタン
  const loadBtn = $("style-palette-load-btn");
  if (loadBtn) {
    loadBtn.addEventListener("click", () => { void openBrowser(); });
  }

  // フォルダブラウザのナビゲーション
  const back = $("style-palette-browser-back-btn");
  if (back) back.addEventListener("click", () => { void browserGoBack(); });
  const fwd = $("style-palette-browser-forward-btn");
  if (fwd) fwd.addEventListener("click", () => { void browserGoForward(); });
  const cancel = $("style-palette-browser-cancel-btn");
  if (cancel) cancel.addEventListener("click", () => closeBrowser());

  // 背景クリック / Esc でキャンセル
  const modal = $("style-palette-browser-modal");
  if (modal) {
    modal.addEventListener("mousedown", (e) => {
      if (e.target === modal) closeBrowser();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && modal.classList.contains("visible")) {
        closeBrowser();
      }
    });
  }

  // 起動時に直前 JSON パスから自動再読込（失敗してもサイレント）
  let autoPath = null;
  try { autoPath = localStorage.getItem(LAST_JSON_KEY); } catch (_) {}
  if (autoPath) {
    void loadJsonFromPath(autoPath).catch(() => { /* silent */ });
  }
}
