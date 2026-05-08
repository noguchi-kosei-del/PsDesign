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
  getFonts,
} from "./state.js";
import { commitFontToSelections } from "./text-editor.js";
import { showModalAnimated, hideModalAnimated } from "./ui-feedback.js";
import { onFontsRegistered } from "./font-loader.js";

// 校正パネルと同じ共有ドライブベース。stylepallet オリジナルの ROOT_PATH を踏襲。
const STYLE_PALETTE_ROOT_PATH =
  "G:\\共有ドライブ\\CLLENN\\編集部フォルダ\\編集企画部\\編集企画_C班(AT業務推進)\\DTP制作部\\JSONフォルダ";
// レーベル別テンプレ。直下の全 .json ファイルを取り込む。
const STYLE_PALETTE_LABEL_TEMPLATE_PATH =
  STYLE_PALETTE_ROOT_PATH + "\\_レーベルテンプレ";

// 旧バージョンの localStorage 残骸を一掃するために key 文字列だけ保持。
// 新仕様では永続化なし（起動時は必ず「デフォルト」）。
const LEGACY_LAST_JSON_KEY = "psdesign_style_palette_last_json";

// 写植ワークフローでよく使う 4 種をハードコードのデフォルトとして起動直後から表示する。
// `name` は表示名（フォントの display name）。`fontName` (PostScript 名) は
// resolveFontPsName で getFonts() から自動解決する（loadDefaults 内で実行）。
const DEFAULT_PRESETS_SEED = [
  { subName: "セリフ",       name: "F910コミックW4-IPA Regular" },
  { subName: "モノローグ",   name: "ＤＦ中丸ゴシック体 Regular" },
  { subName: "回想",         name: "ＤＦ平成明朝体 W7" },
  { subName: "電話・テレビ", name: "源暎ラテミン v2 Medium" },
];

// ---------- モジュール状態 ----------
let presets = [];                  // Array<Preset>
let categoryMap = null;            // {[category]: Preset[]}
let categoryOrder = [];            // 表示順保持（Object.keys は挿入順）
let activeCategory = null;         // 現在表示中のカテゴリ名（null = flat 表示）
let selectedPresetIndex = -1;      // クリック選択中の preset の originalIndex（-1 = 未選択）
let lastLoadedJsonPath = null;

// 表示中ソースの種別。
//   "default"  = ハードコードのデフォルト 4 件（テンプレ未取得時のフォールバック）
//   "template" = STYLE_PALETTE_ROOT_PATH 直下の ●●テンプレ.json
//   "browser"  = 任意 JSON 読込ボタン経由
let activeSource = "default";

// テンプレ JSON 一覧（dropdown 用）と、スキャン状態。
// scanTemplates() で起動時に 1 回だけ取得しキャッシュする。
let templateList = [];             // Array<{ name, displayLabel, path }>
let templateScanState = "idle";    // "idle" | "loading" | "ready" | "error"

// 起動時の自動テンプレ読込が完了済みかどうか（goHome リセット時に false に戻して再実行する）。
let initialAutoloadDone = false;

// 起動時の既定テンプレとして優先選択するファイル名キーワード。
const DEFAULT_TEMPLATE_KEYWORD = "汎用統一表記テンプレ";

// フォルダブラウザ状態（校正パネル流の戻る/進むスタック）
let browserCurrentPath = "";
let browserNavStack = [];
let browserForwardStack = [];

const $ = (id) => document.getElementById(id);

function basename(path) {
  if (!path) return "";
  const m = String(path).split(/[\\/]/);
  return m[m.length - 1] || "";
}

function updateFilenameDisplay(path) {
  const el = $("style-palette-filename");
  if (!el) return;
  if (!path) {
    el.textContent = "";
    el.title = "";
    el.hidden = true;
    return;
  }
  const name = basename(path);
  el.textContent = name;
  el.title = path;
  el.hidden = false;
}

// 表示名から PostScript 名を 3 段フォールバックで解決する。
// インストールされていなければ null（呼び出し側で未解決として扱う）。
//   1. 完全一致 (f.name === displayName)
//   2. 大小・幅違い吸収 (localeCompare with sensitivity: "base")
//   3. PS 名直書き保険 (f.postScriptName === displayName)
// 正規化（"Regular"/"W4" のスペース揺れ等）は誤マッチ防止のため導入しない。
function resolveFontPsName(displayName) {
  if (!displayName) return null;
  const fonts = getFonts();
  if (!fonts || fonts.length === 0) return null;
  const exact = fonts.find((f) => f && f.name === displayName);
  if (exact) return exact.postScriptName || null;
  const ci = fonts.find(
    (f) =>
      f &&
      typeof f.name === "string" &&
      f.name.localeCompare(displayName, "ja", { sensitivity: "base" }) === 0,
  );
  if (ci) return ci.postScriptName || null;
  const ps = fonts.find((f) => f && f.postScriptName === displayName);
  if (ps) return ps.postScriptName;
  return null;
}

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

function renderList() {
  const list = $("style-palette-list");
  if (!list) return;

  if (presets.length === 0) {
    list.innerHTML = '<div class="style-palette-empty">プリセットがありません</div>';
    return;
  }

  // originalIndex を埋め込み（クリック時に参照）
  for (let i = 0; i < presets.length; i++) presets[i].originalIndex = i;

  // category dropdown は populateTemplateDropdown 専任なのでここでは触らない。
  // JSON 内に複数 category がある場合も全件 flat 表示（内部 category 切替は廃止）。
  activeCategory = null;
  renderItems(presets);
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
  // PostScript 名が解決できなかった (フォント未インストール) エントリは灰色化 + クリック無反応。
  const isUnresolved = !preset.fontName;
  if (isUnresolved) item.classList.add("style-palette-item--unresolved");
  item.title = isUnresolved
    ? `フォント未インストール: ${preset.name}`
    : (preset.description || preset.displayName);

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
    if (isUnresolved) return;  // 未インストール時はハイライトも適用もしない
    selectedPresetIndex = preset.originalIndex;
    for (const el of $("style-palette-list").querySelectorAll(".style-palette-item")) {
      el.classList.remove("selected");
    }
    item.classList.add("selected");
    applyPreset(preset);
  });

  return item;
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
// source: "default" | "template" | "browser"
//   "template" = #style-palette-category dropdown 経由
//   "browser"  = 任意 JSON 読込ボタン (#style-palette-load-btn) 経由
//   localStorage への永続化はしない（起動時は必ずデフォルト）。
export async function loadJsonFromPath(path, { source = "browser" } = {}) {
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
  activeSource = source;
  lastLoadedJsonPath = path;
  updateFilenameDisplay(path);
  renderList();
  return true;
}

// ハードコードのデフォルト 4 件を表示する。表示名から PS 名を解決するため
// onFontsRegistered の発火後に再呼び出しすれば未解決項目もカラー復帰する。
function loadDefaults() {
  presets = DEFAULT_PRESETS_SEED.map((seed) => ({
    displayName: `${seed.subName} / ${seed.name}`,
    name: seed.name,
    subName: seed.subName,
    fontName: resolveFontPsName(seed.name), // null 可（未インストール）
    description: "",
    category: "デフォルト",
  }));
  rebuildCategoryMap();
  selectedPresetIndex = -1;
  activeCategory = null;
  activeSource = "default";
  lastLoadedJsonPath = null;
  updateFilenameDisplay(null);
  renderList();
  // dropdown 同期（外部から呼ばれた場合）
  const sel = $("style-palette-category");
  if (sel && sel.value !== "__default__") sel.value = "__default__";
}

// 起動時に 2 つのフォルダをスキャンしてテンプレ一覧を構築する:
// 1) STYLE_PALETTE_ROOT_PATH 直下の `*テンプレ*.json`           → group: "テンプレート"
// 2) STYLE_PALETTE_LABEL_TEMPLATE_PATH (\_レーベルテンプレ\) 直下の全 .json → group: "レーベルテンプレ"
// どちらの取得失敗もデフォルトプリセットの動作を阻害しない（warn のみ）。
async function scanTemplates() {
  templateScanState = "loading";
  const collator = new Intl.Collator("ja", { numeric: true, sensitivity: "base" });

  // メインフォルダ: ファイル名に「テンプレ」を含む JSON のみ採用
  let mainEntries = [];
  try {
    const entries = await invoke("list_directory_entries", { path: STYLE_PALETTE_ROOT_PATH });
    mainEntries = (entries || [])
      .filter((e) => e && e.isFile && /テンプレ.*\.json$/i.test(e.name))
      .map((e) => ({
        name: e.name,
        displayLabel: e.name.replace(/\.json$/i, ""),
        path: e.path,
        group: "テンプレート",
      }))
      .sort((a, b) => collator.compare(a.displayLabel, b.displayLabel));
  } catch (e) {
    console.warn("[style-palette] テンプレスキャン失敗:", e);
  }

  // レーベルテンプレフォルダ: 直下の全 .json
  let labelEntries = [];
  try {
    const entries = await invoke("list_directory_entries", { path: STYLE_PALETTE_LABEL_TEMPLATE_PATH });
    labelEntries = (entries || [])
      .filter((e) => e && e.isFile && /\.json$/i.test(e.name))
      .map((e) => ({
        name: e.name,
        displayLabel: e.name.replace(/\.json$/i, ""),
        path: e.path,
        group: "レーベルテンプレ",
      }))
      .sort((a, b) => collator.compare(a.displayLabel, b.displayLabel));
  } catch (e) {
    console.warn("[style-palette] レーベルテンプレスキャン失敗:", e);
  }

  templateList = [...mainEntries, ...labelEntries];
  templateScanState = templateList.length > 0 ? "ready" : "error";

  populateTemplateDropdown();
  // スキャン後に初回限定で既定テンプレを自動読込。
  if (!initialAutoloadDone) {
    initialAutoloadDone = true;
    await autoLoadDefaultTemplate();
  }
}

// dropdown をテンプレ群で再構築。現在選択値は可能な限り維持。
// テンプレが見つからない場合は disabled プレースホルダを表示。
// group フィールドが複数種類あれば <optgroup> でラベル別にまとめる。
function populateTemplateDropdown() {
  const sel = $("style-palette-category");
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = "";
  if (templateList.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "テンプレートが見つかりません";
    opt.disabled = true;
    sel.appendChild(opt);
    sel.disabled = true;
    sel.hidden = false;
    return;
  }
  sel.disabled = false;

  // group ごとに optgroup でまとめる（挿入順 = scanTemplates の収集順）。
  const groupBuckets = new Map();
  for (const t of templateList) {
    const g = t.group || "テンプレート";
    if (!groupBuckets.has(g)) groupBuckets.set(g, []);
    groupBuckets.get(g).push(t);
  }
  for (const [groupName, items] of groupBuckets) {
    const og = document.createElement("optgroup");
    og.label = groupName;
    for (const t of items) {
      const opt = document.createElement("option");
      opt.value = `tpl::${t.path}`;
      opt.textContent = t.displayLabel;
      og.appendChild(opt);
    }
    sel.appendChild(og);
  }

  if (prev && Array.from(sel.options).some((o) => o.value === prev)) {
    sel.value = prev;
  }
  sel.hidden = false;
}

// 起動時 / リセット時に呼ばれる「既定テンプレを自動選択して読み込む」関数。
// 1) 汎用統一表記テンプレ を最優先
// 2) 見つからなければ先頭テンプレ
// 3) テンプレ自体が無い / 読込失敗ならハードコード defaults にフォールバック
async function autoLoadDefaultTemplate() {
  if (templateList.length === 0) {
    loadDefaults();
    return;
  }
  const target =
    templateList.find((t) => t.displayLabel.includes(DEFAULT_TEMPLATE_KEYWORD)) ||
    templateList[0];
  const ok = await loadJsonFromPath(target.path, { source: "template" });
  if (!ok) {
    loadDefaults();
    return;
  }
  const sel = $("style-palette-category");
  if (sel) sel.value = `tpl::${target.path}`;
}

// 「ホームに戻る」で呼ばれるリセット関数。
// 既定テンプレ（汎用統一表記テンプレ）を再読込する。templateList が空のときのみ
// ハードコード defaults にフォールバック。
export function resetStylePaletteState() {
  presets = [];
  categoryMap = null;
  categoryOrder = [];
  activeCategory = null;
  selectedPresetIndex = -1;
  lastLoadedJsonPath = null;
  updateFilenameDisplay(null);
  void autoLoadDefaultTemplate();
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
        const ok = await loadJsonFromPath(entry.path, { source: "browser" });
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
  // テンプレ切替 (旧: 単一 JSON 内の category 切替 → 新: テンプレ JSON 切替)
  const catSelect = $("style-palette-category");
  if (catSelect) {
    catSelect.addEventListener("change", () => {
      const v = catSelect.value;
      if (v && v.startsWith("tpl::")) {
        const path = v.slice(5);
        void loadJsonFromPath(path, { source: "template" });
      }
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

  // 旧バージョンの localStorage 残骸を一掃（新仕様では永続化なし）
  try { localStorage.removeItem(LEGACY_LAST_JSON_KEY); } catch (_) {}

  // テンプレスキャン完了後に汎用統一表記テンプレを自動読込する。
  // スキャン中はリスト領域に読み込み中表示を出してユーザーに状況を伝える。
  const list = $("style-palette-list");
  if (list) {
    list.innerHTML = '<div class="style-palette-empty">テンプレートを読み込み中…</div>';
  }
  void scanTemplates();

  // フォント登録完了で未解決のフォールバック defaults を再解決。
  // テンプレ表示中は no-op、defaults フォールバック中なら再描画して灰色解除。
  onFontsRegistered(() => {
    if (activeSource === "default") loadDefaults();
  });
}
