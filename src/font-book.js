import { invoke } from "@tauri-apps/api/core";
import { getFonts } from "./state.js";
import { ensureFontLoaded } from "./font-loader.js";
import { toast } from "./ui-feedback.js";
import { getBusinessAddress } from "./addresses.js";

const STORAGE_SAMPLE = "opus_font_book_sample_text";
// フォント帳のルート（中立キー content.textLogBase）。実パスはソース直書きせず外部参照 enc から
// 実行時取得する。使用前に ensureFontBookRoot() を await（または起動時 prime）すること。
let FONT_BOOK_ROOT_PATH = "";
async function ensureFontBookRoot() {
  if (!FONT_BOOK_ROOT_PATH) {
    // 校正テキストログと同じ共有ドライブ。font-book は元実装でスラッシュ区切りを使うため正規化。
    const base = await getBusinessAddress("content.textLogBase");
    FONT_BOOK_ROOT_PATH = base ? base.replace(/\\/g, "/") : "";
  }
  return FONT_BOOK_ROOT_PATH;
}
const FONT_BOOK_DIR_NAME = "フォント帳";
const DEFAULT_SAMPLE_TEXT = "永字八法 あいうえお ABC 123";
const FOLDER_ICON_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
const FILE_ICON_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';

const BROWSER_SEARCH_MAX_DEPTH = 4;
const BROWSER_SEARCH_MAX_RESULTS = 100;
const BROWSER_SEARCH_MAX_DIRS = 260;
const BROWSER_SEARCH_DEBOUNCE_MS = 180;

const state = {
  dir: null,
  sourceMode: "gdrive",
  entries: [],
  query: "",
  hideEmpty: true,
  category: "",
  previewSize: "S",
  sampleText: DEFAULT_SAMPLE_TEXT,
  presetFonts: [],
  rootFolders: [],
  selectedRootPath: "",
  selectedRootName: "",
  workFolders: [],
  selectedWorkPath: "",
  selectedWorkName: "",
  jsonChoices: [],
  selectedJsonPath: "",
  selectedBookFolderName: "",
  browserPath: "",
  browserItems: [],
  browserQuery: "",
  browserSearchItems: [],
  browserSearchLoading: false,
  browserSearchToken: 0,
  selectModalOpen: false,
  navigatorLoading: false,
  loadedBookCount: 0,
  scannedJsonCount: 0,
};

let initialized = false;
let expandedEntryId = null;
let sampleObserver = null;
let shotImageObserver = null;
let initialLoadStarted = false;
let browserSearchTimer = null;

function fontBookDebug(stage, detail = {}) {
  try {
    if (localStorage.getItem("opus_debug_font_book") !== "1") return;
    const entry = {
      at: new Date().toISOString(),
      stage,
      detail,
    };
    window.__fontBookDebugLogs = Array.isArray(window.__fontBookDebugLogs)
      ? window.__fontBookDebugLogs
      : [];
    window.__fontBookDebugLogs.push(entry);
    console.info("[font-book-debug]", stage, detail);
  } catch (_) {
    // Debug logging must never break the font book UI.
  }
}

function compactBrowserItem(item) {
  return {
    name: item?.name ?? "",
    path: item?.path ?? "",
    kind: item?.isFile ? "json" : item?.isDirectory ? "folder" : "unknown",
  };
}

const $ = (id) => document.getElementById(id);

function fontBookListEls() {
  return [
    $("font-book-list"),
    $("pdf-font-book-list"),
  ].filter(Boolean);
}

function fontBookSampleInputs() {
  return Array.from(document.querySelectorAll("#font-book-sample-input, [data-font-book-sample]"));
}

function fontBookCategoryWraps() {
  return Array.from(document.querySelectorAll(".font-book-category-menu-wrap"));
}

function fontBookHeaderHostForList(list) {
  if (list?.id === "pdf-font-book-list") return $("pdf-font-book-list-header");
  return null;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeSelectorId(s) {
  return String(s ?? "").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function cleanPath(path) {
  return String(path ?? "").replace(/[\\/]+$/, "");
}

function trimPathPart(part) {
  return String(part ?? "").replace(/^[\\/]+|[\\/]+$/g, "");
}

function joinPath(...parts) {
  const filtered = parts.filter((part) => part !== null && part !== undefined && String(part) !== "");
  if (filtered.length === 0) return "";
  const [head, ...tail] = filtered;
  return [cleanPath(head), ...tail.map(trimPathPart)].join("/");
}

function entryKeyFor(dir, id) {
  return `${cleanPath(dir)}::${id}`;
}

function normalizeEntry(entry, sourceDir = "") {
  if (!entry || typeof entry !== "object") return null;
  const id = String(entry.id ?? "").trim();
  const fontPostScript = String(entry.fontPostScript ?? "").trim();
  if (!id || !fontPostScript) return null;
  const fontBookDir = cleanPath(sourceDir || entry.fontBookDir || "");
  return {
    id,
    key: entryKeyFor(fontBookDir, id),
    fontBookDir,
    fontPostScript,
    fontDisplayName: String(entry.fontDisplayName ?? fontPostScript),
    subName: String(entry.subName ?? ""),
    sourceFile: String(entry.sourceFile ?? ""),
    capturedAt: String(entry.capturedAt ?? ""),
    note: String(entry.note ?? ""),
  };
}

async function readFontBookEntriesFromDir(dir) {
  const cleanDir = cleanPath(dir);
  const content = await invoke("read_text_file", { path: `${cleanDir}/fontbook.json` });
  const data = JSON.parse(content);
  return Array.isArray(data?.entries) ? data.entries.map((entry) => normalizeEntry(entry, cleanDir)).filter(Boolean) : [];
}

async function listDirectories(dir) {
  const entries = await invoke("list_directory_entries", { path: dir });
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry?.isDirectory)
    .sort((a, b) => String(a.name || a.path || "").localeCompare(String(b.name || b.path || ""), "ja"));
}

async function listDirectoryItems(dir) {
  const entries = await invoke("list_directory_entries", { path: dir });
  return (Array.isArray(entries) ? entries : [])
    .sort((a, b) => String(a.name || a.path || "").localeCompare(String(b.name || b.path || ""), "ja"));
}

async function tryReadFontBookDir(dir) {
  try {
    const entries = await readFontBookEntriesFromDir(dir);
    return { dir: cleanPath(dir), entries };
  } catch (_) {
    return null;
  }
}

function dirPath(entry, fallbackParent) {
  return cleanPath(entry?.path || joinPath(fallbackParent, entry?.name || ""));
}

function parentDir(path) {
  return cleanPath(String(path || "").replace(/\\/g, "/").replace(/\/[^/]*$/, ""));
}

function pathName(path) {
  return String(path || "").replace(/\\/g, "/").split("/").filter(Boolean).pop() || "";
}

function isFontBookJsonItem(item) {
  return !!item?.isFile && /^fontbook\.json$/i.test(item.name || pathName(item.path));
}

function browserItemFromEntry(entry, fallbackParent) {
  return {
    name: String(entry?.name || pathName(entry?.path)),
    path: dirPath(entry, fallbackParent),
    isDirectory: !!entry?.isDirectory,
    isFile: !!entry?.isFile,
  };
}

function browserItemMatchesQuery(item, query) {
  const text = normalizeFontSearchText(`${item?.name ?? ""} ${item?.path ?? ""}`);
  return text.includes(query);
}

async function searchFontBookBrowserDescendants(rootPath, query, token) {
  const results = [];
  const seen = new Set();
  let visitedDirs = 0;

  async function visit(dir, depth) {
    if (
      token !== state.browserSearchToken
      || results.length >= BROWSER_SEARCH_MAX_RESULTS
      || visitedDirs >= BROWSER_SEARCH_MAX_DIRS
      || depth > BROWSER_SEARCH_MAX_DEPTH
    ) {
      return;
    }
    visitedDirs += 1;
    let entries = [];
    try {
      entries = await listDirectoryItems(dir);
    } catch (e) {
      fontBookDebug("browser-recursive-search-list-error", {
        dir,
        depth,
        error: e?.message ?? String(e),
      });
      return;
    }

    for (const entry of entries) {
      if (token !== state.browserSearchToken || results.length >= BROWSER_SEARCH_MAX_RESULTS) return;
      const item = browserItemFromEntry(entry, dir);
      const selectable = item.isDirectory || isFontBookJsonItem(item);
      if (selectable && browserItemMatchesQuery(item, query) && !seen.has(item.path)) {
        seen.add(item.path);
        results.push(item);
      }
      if (item.isDirectory && depth < BROWSER_SEARCH_MAX_DEPTH) {
        await visit(item.path, depth + 1);
      }
    }
  }

  await visit(rootPath, 0);
  return { results, visitedDirs };
}

function bookDisplayFolderName(jsonPath) {
  const dir = parentDir(jsonPath);
  if (!dir) return "";
  if (pathName(dir) === FONT_BOOK_DIR_NAME) return pathName(parentDir(dir));
  return pathName(dir);
}

async function readFontBookFromWorkFolder(dir) {
  const cleanDir = cleanPath(dir);
  const direct = await tryReadFontBookDir(cleanDir);
  if (direct) return direct;
  return await tryReadFontBookDir(joinPath(cleanDir, FONT_BOOK_DIR_NAME));
}

async function readFontBookEntriesFromJson(path) {
  const cleanJsonPath = cleanPath(path);
  const sourceDir = parentDir(cleanJsonPath);
  const content = await invoke("read_text_file", { path: cleanJsonPath });
  const data = JSON.parse(content);
  const entries = Array.isArray(data?.entries)
    ? data.entries.map((entry) => normalizeEntry(entry, sourceDir)).filter(Boolean)
    : [];
  return { dir: sourceDir, jsonPath: cleanJsonPath, entries };
}

async function tryReadFontBookJson(path) {
  try {
    return await readFontBookEntriesFromJson(path);
  } catch (_) {
    return null;
  }
}

async function fontBookJsonPathInFolder(path) {
  const direct = joinPath(path, "fontbook.json");
  if (await tryReadFontBookJson(direct)) return direct;
  return "";
}

async function loadFontBookBrowserFolder(path) {
  await ensureFontBookRoot();
  const dir = cleanPath(path || FONT_BOOK_ROOT_PATH);
  fontBookDebug("browser-folder-load-start", {
    requestedPath: path,
    dir,
  });
  state.navigatorLoading = true;
  state.browserPath = dir;
  state.browserQuery = "";
  state.browserSearchItems = [];
  state.browserSearchLoading = false;
  state.browserSearchToken += 1;
  if (browserSearchTimer) {
    clearTimeout(browserSearchTimer);
    browserSearchTimer = null;
  }
  renderFontBookSelectModal();
  try {
    const entries = await listDirectoryItems(dir);
    state.browserItems = entries
      .map((entry) => browserItemFromEntry(entry, dir))
      .filter((item) => item.isDirectory || isFontBookJsonItem(item))
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name, "ja");
      });
    fontBookDebug("browser-folder-load-success", {
      dir,
      total: state.browserItems.length,
      items: state.browserItems.slice(0, 10).map(compactBrowserItem),
    });
  } catch (e) {
    state.browserItems = [];
    fontBookDebug("browser-folder-load-error", {
      dir,
      error: e?.message ?? String(e),
    });
    toast(`フォルダを読み込めませんでした: ${e}`, { kind: "error" });
  } finally {
    state.navigatorLoading = false;
    renderFontBookSelectModal();
    fontBookDebug("browser-folder-load-finish", {
      dir,
      query: state.browserQuery,
      total: state.browserItems.length,
      navigatorLoading: state.navigatorLoading,
    });
  }
}

async function loadRootFolders() {
  state.navigatorLoading = true;
  if (state.selectModalOpen) renderFontBookSelectModal();
  await ensureFontBookRoot();
  try {
    const dirs = await listDirectories(FONT_BOOK_ROOT_PATH);
    state.rootFolders = dirs.map((entry) => ({
      name: String(entry.name || ""),
      path: dirPath(entry, FONT_BOOK_ROOT_PATH),
    }));
    if (!state.rootFolders.some((item) => item.path === state.selectedRootPath)) {
      const first = state.rootFolders[0];
      state.selectedRootPath = first?.path || "";
      state.selectedRootName = first?.name || "";
    }
    await loadWorkFoldersForSelectedRoot({ autoSelect: false });
  } catch (e) {
    state.rootFolders = [];
    state.workFolders = [];
    state.entries = [];
    state.presetFonts = [];
    if (state.selectModalOpen) renderFontBookSelectModal();
    renderFontBook();
    toast(`フォント帳フォルダを読み込めませんでした: ${e}`, { kind: "error" });
  } finally {
    state.navigatorLoading = false;
    if (state.selectModalOpen) renderFontBookSelectModal();
  }
}

async function loadWorkFoldersForSelectedRoot({ autoSelect = false } = {}) {
  const rootPath = state.selectedRootPath;
  if (!rootPath) {
    state.workFolders = [];
    state.selectedWorkPath = "";
    state.selectedWorkName = "";
    state.jsonChoices = [];
    state.selectedJsonPath = "";
    state.selectedBookFolderName = "";
    if (state.selectModalOpen) renderFontBookSelectModal();
    return;
  }
  let dirs = [];
  try {
    dirs = await listDirectories(rootPath);
  } catch (_) {
    dirs = [];
  }

  const folders = dirs.map((entry) => ({
    name: String(entry.name || ""),
    path: dirPath(entry, rootPath),
  }));

  const rootBook = await readFontBookFromWorkFolder(rootPath);
  if (rootBook) {
    folders.unshift({
      name: state.selectedRootName || rootPath.split(/[\\/]/).pop() || "フォント帳",
      path: rootPath,
    });
  }

  state.workFolders = folders;
  if (!folders.some((item) => item.path === state.selectedWorkPath)) {
    state.selectedWorkPath = "";
    state.selectedWorkName = "";
    state.jsonChoices = [];
    state.selectedJsonPath = "";
    state.selectedBookFolderName = "";
  }
  if (state.selectModalOpen) renderFontBookSelectModal();

  if (autoSelect && folders.length > 0) {
    await loadJsonChoicesForWorkFolder(folders[0]);
  }
}

async function loadJsonChoicesForWorkFolder(folder) {
  state.selectedWorkPath = folder?.path || "";
  state.selectedWorkName = folder?.name || "";
  state.selectedJsonPath = "";
  state.selectedBookFolderName = "";
  state.jsonChoices = [];
  if (!state.selectedWorkPath) return;

  const candidates = [
    {
      label: "fontbook.json",
      path: joinPath(state.selectedWorkPath, "fontbook.json"),
    },
    {
      label: `${FONT_BOOK_DIR_NAME}/fontbook.json`,
      path: joinPath(state.selectedWorkPath, FONT_BOOK_DIR_NAME, "fontbook.json"),
    },
  ];
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate.path)) continue;
    seen.add(candidate.path);
    const book = await tryReadFontBookJson(candidate.path);
    if (!book) continue;
    state.jsonChoices.push({
      ...candidate,
      entryCount: book.entries.length,
    });
  }
}

async function loadFontBookFromJsonChoice(choice) {
  if (!choice?.path) return false;
  state.navigatorLoading = true;
  state.selectedJsonPath = choice.path;
  if (state.selectModalOpen) renderFontBookSelectModal();
  try {
    const book = await readFontBookEntriesFromJson(choice.path);
    const entriesByKey = new Map();
    for (const entry of book.entries) entriesByKey.set(entry.key, entry);
    state.dir = book.dir;
    state.sourceMode = "gdrive-json";
    state.entries = Array.from(entriesByKey.values());
    state.selectedBookFolderName = bookDisplayFolderName(choice.path);
    state.presetFonts = [];
    state.loadedBookCount = 1;
    state.scannedJsonCount = 0;
    state.category = "";
    renderFontBook();
    closeFontBookSelectModal();
    return true;
  } catch (e) {
    toast(`fontbook.json を読み込めませんでした: ${e}`, { kind: "error" });
    return false;
  } finally {
    state.navigatorLoading = false;
    if (state.selectModalOpen) renderFontBookSelectModal();
  }
}

export function getFontBookProjectState() {
  if (!state.selectedJsonPath) return null;
  const projectState = {
    selectedJsonPath: state.selectedJsonPath,
    selectedBookFolderName: state.selectedBookFolderName || bookDisplayFolderName(state.selectedJsonPath),
    dir: state.dir || parentDir(state.selectedJsonPath),
  };
  fontBookDebug("project-state-export", projectState);
  return projectState;
}

export async function restoreFontBookProjectState(saved) {
  const selectedJsonPath = cleanPath(saved?.selectedJsonPath || saved?.jsonPath || "");
  fontBookDebug("project-state-restore-start", {
    saved,
    selectedJsonPath,
  });
  if (!selectedJsonPath) return false;
  state.selectedJsonPath = selectedJsonPath;
  state.selectedBookFolderName = saved?.selectedBookFolderName || bookDisplayFolderName(selectedJsonPath);
  const restored = await loadFontBookFromJsonChoice({
    label: "fontbook.json",
    path: selectedJsonPath,
    entryCount: 0,
  });
  fontBookDebug("project-state-restore-finish", {
    selectedJsonPath,
    restored,
    entryCount: state.entries.length,
  });
  return restored;
}

function ensureFontBookSelectModal() {
  let modal = $("font-book-select-modal");
  if (modal) return modal;
  modal = document.createElement("div");
  modal.id = "font-book-select-modal";
  modal.className = "font-book-select-modal";
  document.body.appendChild(modal);
  return modal;
}

function openFontBookSelectModal() {
  state.selectModalOpen = true;
  const modal = ensureFontBookSelectModal();
  modal.hidden = false;
  renderFontBookSelectModal();
  requestAnimationFrame(() => modal.classList.add("visible"));
  loadFontBookBrowserFolder(state.browserPath || FONT_BOOK_ROOT_PATH);
}

function closeFontBookSelectModal() {
  state.selectModalOpen = false;
  const modal = $("font-book-select-modal");
  if (!modal) return;
  modal.classList.remove("visible");
  setTimeout(() => {
    if (!state.selectModalOpen) modal.hidden = true;
  }, 140);
}

function filteredFontBookBrowserItems() {
  const query = normalizeFontSearchText(state.browserQuery);
  if (!query) {
    fontBookDebug("browser-filter", {
      queryRaw: state.browserQuery,
      query,
      total: state.browserItems.length,
      matched: state.browserItems.length,
      sample: state.browserItems.slice(0, 8).map(compactBrowserItem),
    });
    return state.browserItems;
  }
  const filtered = state.browserItems.filter((item) => browserItemMatchesQuery(item, query));
  const seen = new Set(filtered.map((item) => item.path));
  for (const item of state.browserSearchItems) {
    if (seen.has(item.path) || !browserItemMatchesQuery(item, query)) continue;
    seen.add(item.path);
    filtered.push(item);
  }
  fontBookDebug("browser-filter", {
    queryRaw: state.browserQuery,
    query,
    total: state.browserItems.length,
    recursiveTotal: state.browserSearchItems.length,
    recursiveLoading: state.browserSearchLoading,
    matched: filtered.length,
    sample: filtered.slice(0, 8).map(compactBrowserItem),
  });
  return filtered;
}

function fontBookBrowserListHtml() {
  const browserItems = filteredFontBookBrowserItems();
  const emptyMessage = state.browserItems.length === 0
    ? "フォルダまたはfontbook.jsonがありません"
    : "一致する項目がありません";
  if (state.navigatorLoading) {
    return `<div class="font-book-select-empty">読み込み中...</div>`;
  }
  if (state.browserSearchLoading && browserItems.length === 0) {
    return `<div class="font-book-select-empty">検索中...</div>`;
  }
  if (browserItems.length === 0) {
    return `<div class="font-book-select-empty">${emptyMessage}</div>`;
  }
  return browserItems.map((item) => `
    <button class="font-book-browser-item ${item.isFile ? "json" : "folder"} ${item.path === state.selectedJsonPath ? "active" : ""}" type="button" data-path="${escapeHtml(item.path)}" data-kind="${item.isFile ? "json" : "folder"}" title="${escapeHtml(item.name)}">
      <span class="font-book-browser-icon" aria-hidden="true">${item.isFile ? FILE_ICON_SVG : FOLDER_ICON_SVG}</span>
      <span class="font-book-browser-name">${escapeHtml(item.name)}</span>
    </button>
  `).join("");
}

function renderFontBookBrowserList() {
  const list = $("font-book-select-modal")?.querySelector(".font-book-browser-list");
  if (!list) {
    fontBookDebug("browser-list-render-missing", {
      query: state.browserQuery,
      modalExists: !!$("font-book-select-modal"),
    });
    return;
  }
  list.innerHTML = fontBookBrowserListHtml();
  fontBookDebug("browser-list-render", {
    query: state.browserQuery,
    itemCount: list.querySelectorAll(".font-book-browser-item").length,
    emptyText: list.querySelector(".font-book-select-empty")?.textContent?.trim() ?? "",
  });
}

function scheduleFontBookBrowserSearch() {
  if (browserSearchTimer) {
    clearTimeout(browserSearchTimer);
    browserSearchTimer = null;
  }
  const query = normalizeFontSearchText(state.browserQuery);
  state.browserSearchToken += 1;
  const token = state.browserSearchToken;
  if (!query) {
    state.browserSearchItems = [];
    state.browserSearchLoading = false;
    renderFontBookBrowserList();
    return;
  }

  state.browserSearchItems = [];
  state.browserSearchLoading = true;
  renderFontBookBrowserList();
  browserSearchTimer = setTimeout(async () => {
    const rootPath = state.browserPath || FONT_BOOK_ROOT_PATH;
    fontBookDebug("browser-recursive-search-start", {
      queryRaw: state.browserQuery,
      query,
      rootPath,
      token,
    });
    try {
      const { results, visitedDirs } = await searchFontBookBrowserDescendants(rootPath, query, token);
      if (token !== state.browserSearchToken) {
        fontBookDebug("browser-recursive-search-discard", { token, activeToken: state.browserSearchToken });
        return;
      }
      state.browserSearchItems = results;
      fontBookDebug("browser-recursive-search-finish", {
        query,
        rootPath,
        visitedDirs,
        matched: results.length,
        sample: results.slice(0, 8).map(compactBrowserItem),
      });
    } catch (e) {
      if (token === state.browserSearchToken) {
        fontBookDebug("browser-recursive-search-error", {
          query,
          rootPath,
          error: e?.message ?? String(e),
        });
      }
    } finally {
      if (token === state.browserSearchToken) {
        state.browserSearchLoading = false;
        renderFontBookBrowserList();
      }
    }
  }, BROWSER_SEARCH_DEBOUNCE_MS);
}

function renderFontBookSelectModal() {
  const modal = ensureFontBookSelectModal();
  const currentPath = state.browserPath || FONT_BOOK_ROOT_PATH;
  const isRoot = cleanPath(currentPath) === cleanPath(FONT_BOOK_ROOT_PATH);
  if (state.navigatorLoading && state.browserItems.length === 0) {
    modal.innerHTML = `
      <div class="font-book-select-backdrop" data-close="1"></div>
      <div class="font-book-select-card" role="dialog" aria-modal="true">
        <div class="font-book-select-header">
          <strong>作品情報を選択</strong>
          <button class="font-book-select-close" type="button" data-close="1">閉じる</button>
        </div>
        <div class="font-book-select-loading">読み込み中...</div>
      </div>`;
    bindFontBookSelectModalEvents(modal);
    return;
  }

  modal.innerHTML = `
    <div class="font-book-select-backdrop" data-close="1"></div>
    <div class="font-book-select-card" role="dialog" aria-modal="true">
      <div class="font-book-select-header">
        <strong>作品情報を選択</strong>
        <button class="font-book-select-close" type="button" data-close="1">閉じる</button>
      </div>
      <div class="font-book-browser-bar">
        <button class="font-book-browser-up" type="button" data-up="1" aria-label="上へ" title="上へ" ${isRoot ? "disabled" : ""}>
          <span aria-hidden="true">↑</span>
        </button>
        <div class="font-book-browser-path" title="${escapeHtml(currentPath)}">${escapeHtml(currentPath.replace(FONT_BOOK_ROOT_PATH, "TOP"))}</div>
      </div>
      <div class="font-book-browser-search-row">
        <input class="font-book-browser-search" type="search" data-browser-search="1" placeholder="検索..." autocomplete="off" value="${escapeHtml(state.browserQuery)}" />
      </div>
      <div class="font-book-browser-list">
        ${fontBookBrowserListHtml()}
      </div>
    </div>`;
  bindFontBookSelectModalEvents(modal);
}

function bindFontBookSelectModalEvents(modal) {
  modal.oninput = (e) => {
    const input = e.target?.closest?.("[data-browser-search]");
    if (!input) return;
    fontBookDebug("browser-search-input", {
      value: input.value,
      inputType: e.inputType,
      isComposing: !!e.isComposing,
      activeElementIsInput: document.activeElement === input,
    });
    state.browserQuery = input.value;
    scheduleFontBookBrowserSearch();
  };
  modal.oncompositionend = (e) => {
    const input = e.target?.closest?.("[data-browser-search]");
    if (!input) return;
    fontBookDebug("browser-search-compositionend", {
      value: input.value,
      activeElementIsInput: document.activeElement === input,
    });
    state.browserQuery = input.value;
    scheduleFontBookBrowserSearch();
  };
  modal.onkeydown = (e) => {
    if (!e.target?.closest?.("[data-browser-search]")) return;
    fontBookDebug("browser-search-keydown", {
      key: e.key,
      code: e.code,
      value: e.target?.value ?? "",
      defaultPrevented: e.defaultPrevented,
    });
    if (e.key !== "Escape") e.stopPropagation();
  };
  modal.onclick = async (e) => {
    const target = e.target;
    if (target?.dataset?.close) {
      closeFontBookSelectModal();
      return;
    }
    const upBtn = target.closest?.("[data-up]");
    if (upBtn && !upBtn.disabled) {
      const next = parentDir(state.browserPath);
      if (next && next.startsWith(cleanPath(FONT_BOOK_ROOT_PATH))) await loadFontBookBrowserFolder(next);
      return;
    }
    const itemBtn = target.closest?.("[data-kind][data-path]");
    if (itemBtn?.dataset.kind === "folder") {
      const jsonPath = await fontBookJsonPathInFolder(itemBtn.dataset.path);
      if (jsonPath) {
        state.selectedRootName = pathName(FONT_BOOK_ROOT_PATH);
        state.selectedWorkName = bookDisplayFolderName(jsonPath);
        loadFontBookFromJsonChoice({
          label: "fontbook.json",
          path: jsonPath,
          entryCount: 0,
        });
        return;
      }
      await loadFontBookBrowserFolder(itemBtn.dataset.path);
      return;
    }
    if (itemBtn?.dataset.kind === "json") {
      state.selectedRootName = pathName(FONT_BOOK_ROOT_PATH);
      state.selectedWorkName = bookDisplayFolderName(itemBtn.dataset.path);
      loadFontBookFromJsonChoice({
        label: "fontbook.json",
        path: itemBtn.dataset.path,
        entryCount: 0,
      });
    }
  };
}

function fontLabel(font) {
  return font?.name || font?.family || font?.postScriptName || "";
}

function normalizeFontSearchText(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("ja");
}

function fontMapByPostScript() {
  const map = new Map();
  const fonts = Array.isArray(getFonts()) ? getFonts() : [];
  for (const font of fonts) {
    if (font?.postScriptName && !map.has(font.postScriptName)) {
      map.set(font.postScriptName, font);
    }
  }
  return map;
}

function buildGroups() {
  const fonts = fontMapByPostScript();
  const map = new Map();
  for (const preset of state.presetFonts) {
    const font = fonts.get(preset.fontPostScript);
    if (!map.has(preset.fontPostScript)) {
      map.set(preset.fontPostScript, {
        postScriptName: preset.fontPostScript,
        displayName: fontLabel(font) || preset.displayName || preset.fontPostScript,
        subName: preset.subName,
        aliases: Array.isArray(font?.aliases) ? font.aliases : [],
        entries: [],
      });
    } else if (preset.subName && !map.get(preset.fontPostScript).subName) {
      map.get(preset.fontPostScript).subName = preset.subName;
    }
  }
  for (const entry of state.entries) {
    const font = fonts.get(entry.fontPostScript);
    const group = map.get(entry.fontPostScript) || {
      postScriptName: entry.fontPostScript,
      displayName: fontLabel(font) || entry.fontDisplayName,
      subName: entry.subName,
      aliases: Array.isArray(font?.aliases) ? font.aliases : [],
      entries: [],
    };
    if (!group.subName && entry.subName) group.subName = entry.subName;
    if (!group.displayName) group.displayName = entry.fontDisplayName;
    group.entries.push(entry);
    map.set(entry.fontPostScript, group);
  }
  return Array.from(map.values()).sort((a, b) =>
    a.displayName.localeCompare(b.displayName, "ja", { sensitivity: "base" }),
  );
}

function filteredGroups() {
  const query = normalizeFontSearchText(state.query).trim();
  return buildGroups().filter((group) => {
    if (state.hideEmpty && group.entries.length === 0) return false;
    if (state.category && group.subName !== state.category) return false;
    if (!query) return true;
    const aliases = Array.isArray(group.aliases) ? group.aliases : [];
    const haystack = normalizeFontSearchText(`${group.displayName} ${group.postScriptName} ${group.subName} ${aliases.join(" ")}`);
    return haystack.includes(query);
  });
}

function renderCategories(groups) {
  const cats = Array.from(new Set(groups.map((g) => g.subName).filter(Boolean))).sort((a, b) => a.localeCompare(b, "ja"));
  for (const wrap of fontBookCategoryWraps()) {
    const root = wrap.querySelector("#font-book-category-items, .font-book-category-items");
    const btn = wrap.querySelector("#font-book-category-menu-btn, [data-font-book-action='category']");
    if (!root || !btn) continue;
    btn.disabled = false;
    btn.title = state.category ? `カテゴリ: ${state.category}` : "カテゴリ";
    btn.setAttribute("aria-label", btn.title);
    root.hidden = false;
    root.innerHTML = [
      `<button class="font-book-category-item ${state.category ? "" : "active"}" type="button" data-category="">すべて</button>`,
      ...cats.map((cat) =>
        `<button class="font-book-category-item ${state.category === cat ? "active" : ""}" type="button" data-category="${escapeHtml(cat)}">${escapeHtml(cat)}</button>`,
      ),
    ].join("");
    for (const item of root.querySelectorAll(".font-book-category-item")) {
      item.addEventListener("click", () => {
        state.category = item.dataset.category || "";
        const menu = wrap.querySelector(".font-book-category-menu");
        if (menu) menu.hidden = true;
        btn.setAttribute("aria-expanded", "false");
        renderFontBook();
      });
    }
  }
}

function imagePath(entryOrId) {
  const entry = typeof entryOrId === "object"
    ? entryOrId
    : state.entries.find((item) => item.key === entryOrId || item.id === entryOrId);
  if (!entry) return "";
  const dir = entry.fontBookDir || state.dir;
  if (!dir) return "";
  return `${dir}/${entry.id}.jpg`;
}

function bytesToBase64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < arr.length; i += chunkSize) {
    binary += String.fromCharCode(...arr.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function imageDataUrl(entry) {
  const path = imagePath(entry);
  if (!path) return "";
  const bytes = await invoke("read_binary_file", { path });
  return `data:image/jpeg;base64,${bytesToBase64(bytes)}`;
}

function renderFontBook() {
  const lists = fontBookListEls();
  if (!lists.length) return;

  const allGroups = buildGroups();
  const groups = filteredGroups();
  renderCategories(allGroups);

  const hasSourceTitle = !!state.selectedBookFolderName;
  const heading = hasSourceTitle
    ? `<div class="font-book-source-title" title="${escapeHtml(state.selectedJsonPath || state.dir || "")}">${escapeHtml(state.selectedBookFolderName)}</div>`
    : "";
  const listHeader = `
    <div class="font-book-list-header ${hasSourceTitle ? "has-source-title" : "no-source-title"}">
      ${heading}
      <input class="font-book-search" type="search" placeholder="フォント名で検索..." autocomplete="off" value="${escapeHtml(state.query)}" />
    </div>`;
  const bodyContent = groups.length === 0
    ? `
        <div class="font-book-empty">
          <div class="font-book-empty-icon">Aa</div>
          <div>表示できるフォントがありません。</div>
        </div>`
    : groups.map(renderGroup).join("");
  for (const list of lists) {
    const headerHost = fontBookHeaderHostForList(list);
    list.dataset.size = state.previewSize;
    if (headerHost) {
      headerHost.innerHTML = listHeader;
      list.innerHTML = bodyContent;
    } else {
      list.innerHTML = `${listHeader}${bodyContent}`;
    }
  }
  bindRenderedCards();
}

function renderGroup(group) {
  const ps = escapeHtml(group.postScriptName);
  const sample = state.sampleText || DEFAULT_SAMPLE_TEXT;
  const entriesHtml = group.entries.length > 0
    ? `<div class="font-book-shots">${group.entries.map(renderEntry).join("")}</div>`
    : `<div class="font-book-no-shot">スクリーンショットなし</div>`;
  return `
    <article class="font-book-group" id="font-book-${safeSelectorId(group.postScriptName)}" data-font-ps="${ps}">
      <header class="font-book-group-header">
        <div class="font-book-name-wrap">
          <div class="font-book-name" title="${ps}">${escapeHtml(group.displayName || group.postScriptName)}</div>
          <div class="font-book-ps">${ps}</div>
        </div>
        ${group.subName ? `<span class="font-book-subname">${escapeHtml(group.subName)}</span>` : ""}
        <span class="font-book-count">${group.entries.length}</span>
      </header>
      <div class="font-book-sample" data-font-ps="${ps}">${escapeHtml(sample)}</div>
      ${entriesHtml}
    </article>`;
}

function renderEntry(entry) {
  const note = entry.note ? `<div class="font-book-note">${escapeHtml(entry.note)}</div>` : "";
  return `
    <button class="font-book-shot" type="button" data-entry-key="${escapeHtml(entry.key)}">
      <span class="font-book-shot-image-wrap">
        <span class="font-book-shot-loading">Loading...</span>
        <img class="font-book-shot-image" data-entry-key="${escapeHtml(entry.key)}" alt="${escapeHtml(entry.fontDisplayName)}" loading="lazy" hidden />
      </span>
      <span class="font-book-shot-caption">${escapeHtml(entry.sourceFile || entry.fontDisplayName)}</span>
      ${note}
    </button>`;
}

function bindRenderedCards() {
  if (sampleObserver) {
    sampleObserver.disconnect();
    sampleObserver = null;
  }
  if (shotImageObserver) {
    shotImageObserver.disconnect();
    shotImageObserver = null;
  }
  const fonts = fontMapByPostScript();
  const fontFamilyFor = (font) => {
    const parts = [];
    const add = (name) => {
      const trimmed = String(name ?? "").trim();
      if (!trimmed) return;
      if (/^(regular|bold|italic|bold italic|light|medium|heavy|ultra|demi ?bold|semi ?bold|extra ?light|ex ?light|black)$/i.test(trimmed)) return;
      const q = `"${trimmed.replace(/["\\]/g, "\\$&")}"`;
      if (!parts.includes(q)) parts.push(q);
    };
    add(font?.name);
    for (const alias of Array.isArray(font?.aliases) ? font.aliases : []) add(alias);
    add(font?.postScriptName);
    parts.push("sans-serif");
    return parts.join(", ");
  };
  sampleObserver = new IntersectionObserver((items) => {
    for (const item of items) {
      if (!item.isIntersecting) continue;
      const sample = item.target;
      const ps = sample.dataset.fontPs;
      const font = fonts.get(ps);
      if (font) {
        sample.style.fontFamily = fontFamilyFor(font);
        ensureFontLoaded(font.postScriptName);
      }
      sampleObserver?.unobserve(sample);
    }
  }, { root: null, rootMargin: "140px" });
  for (const sample of document.querySelectorAll(".font-book-sample[data-font-ps]")) {
    const ps = sample.dataset.fontPs;
    const font = fonts.get(ps);
    if (font) {
      sample.style.fontFamily = fontFamilyFor(font);
    }
    sampleObserver.observe(sample);
  }
  for (const shot of document.querySelectorAll(".font-book-shot[data-entry-key]")) {
    shot.addEventListener("click", () => openExpanded(shot.dataset.entryKey));
  }
  const shotTargets = Array.from(document.querySelectorAll(".font-book-shot[data-entry-key]"));
  if (typeof IntersectionObserver === "undefined") {
    for (const shot of shotTargets) loadShotImage(shot.querySelector(".font-book-shot-image[data-entry-key]"));
    return;
  }
  shotImageObserver = new IntersectionObserver((items) => {
    for (const item of items) {
      if (!item.isIntersecting) continue;
      loadShotImage(item.target.querySelector(".font-book-shot-image[data-entry-key]"));
      shotImageObserver?.unobserve(item.target);
    }
  }, { root: null, rootMargin: "260px" });
  for (const shot of shotTargets) {
    shotImageObserver.observe(shot);
  }
}

async function loadShotImage(img) {
  const entryKey = img?.dataset?.entryKey;
  if (!entryKey || img.dataset.loaded === "1" || img.dataset.loading === "1") return;
  const entry = state.entries.find((e) => e.key === entryKey || e.id === entryKey);
  if (!entry) return;
  img.dataset.loading = "1";
  const shot = img.closest(".font-book-shot");
  try {
    const src = await imageDataUrl(entry);
    if (!img.isConnected || img.dataset.entryKey !== entryKey) return;
    img.src = src;
    img.hidden = false;
    img.dataset.loaded = "1";
    shot?.classList.add("image-loaded");
  } catch (e) {
    console.error("font book thumbnail load failed:", e);
    shot?.classList.add("image-error");
  } finally {
    delete img.dataset.loading;
  }
}

async function openExpanded(entryKey) {
  expandedEntryId = entryKey;
  const entry = state.entries.find((e) => e.key === entryKey || e.id === entryKey);
  if (!entry) return;
  let modal = $("font-book-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "font-book-modal";
    modal.className = "font-book-modal";
    document.body.appendChild(modal);
  }
  modal.innerHTML = `
    <div class="font-book-modal-backdrop" data-close="1"></div>
    <div class="font-book-modal-card" role="dialog" aria-modal="true">
      <div class="font-book-modal-image-wrap">
        <div class="font-book-modal-loading">読み込み中...</div>
      </div>
      <div class="font-book-modal-info">
        <div class="font-book-modal-info-text">
          <strong>${escapeHtml(entry.fontDisplayName)}</strong>
          ${entry.subName ? `<span>${escapeHtml(entry.subName)}</span>` : ""}
          <small>${escapeHtml(entry.sourceFile || "")}</small>
          ${entry.note ? `<p>${escapeHtml(entry.note)}</p>` : ""}
        </div>
        <button class="font-book-modal-close" type="button" data-close="1">閉じる</button>
      </div>
    </div>`;
  modal.hidden = false;
  modal.onclick = (e) => {
    if (e.target?.dataset?.close) closeExpanded();
  };

  try {
    const src = await imageDataUrl(entry);
    if (expandedEntryId !== entryKey) return;
    const wrap = modal.querySelector(".font-book-modal-image-wrap");
    if (wrap) {
      wrap.innerHTML = `<img src="${escapeHtml(src)}" alt="${escapeHtml(entry.fontDisplayName)}" />`;
    }
  } catch (e) {
    console.error("font book image load failed:", e);
    const wrap = modal.querySelector(".font-book-modal-image-wrap");
    if (wrap) {
      wrap.innerHTML = `<div class="font-book-modal-error">画像を読み込めませんでした</div>`;
    }
  }
}

function closeExpanded() {
  expandedEntryId = null;
  const modal = $("font-book-modal");
  if (modal) modal.hidden = true;
}

export function setPdfFontBookVisible(visible) {
  const area = $("spreads-pdf-area");
  const stage = $("pdf-font-book-stage");
  const pdfStage = $("pdf-stage");
  const btn = $("pdf-font-book-btn");
  if (!area || !stage || !pdfStage) return;
  area.classList.toggle("font-book-visible", visible);
  stage.hidden = !visible;
  pdfStage.hidden = visible;
  btn?.setAttribute("aria-pressed", visible ? "true" : "false");
  if (visible) {
    loadInitialFontBook();
    renderFontBook();
  }
}

function bindPdfFontBookToggle() {
  const btn = $("pdf-font-book-btn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const visible = !$("pdf-font-book-stage")?.hidden;
    setPdfFontBookVisible(!visible);
  });
}

function bindControls() {
  document.addEventListener("click", (e) => {
    const selectBtn = e.target?.closest?.("#font-book-select-info-btn, [data-font-book-action='select']");
    if (selectBtn) {
      openFontBookSelectModal();
      return;
    }
    const refreshBtn = e.target?.closest?.("#font-book-refresh-btn, [data-font-book-action='refresh']");
    if (refreshBtn) {
      loadRootFolders();
      return;
    }
    const categoryBtn = e.target?.closest?.("#font-book-category-menu-btn, [data-font-book-action='category']");
    if (!categoryBtn) return;
    e.stopPropagation();
    const wrap = categoryBtn.closest(".font-book-category-menu-wrap");
    const menu = wrap?.querySelector?.(".font-book-category-menu");
    if (!menu) return;
    const willOpen = menu.hidden;
    if (willOpen) {
      const rect = categoryBtn.getBoundingClientRect();
      const width = 220;
      const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width));
      menu.style.setProperty("--font-book-category-menu-left", `${left}px`);
      menu.style.setProperty("--font-book-category-menu-top", `${rect.bottom + 6}px`);
    }
    menu.hidden = !willOpen;
    categoryBtn.setAttribute("aria-expanded", menu.hidden ? "false" : "true");
  });
  document.addEventListener("input", (e) => {
    if (e.target?.matches?.("#font-book-sample-input, [data-font-book-sample]")) {
      state.sampleText = e.target.value || DEFAULT_SAMPLE_TEXT;
      try {
        localStorage.setItem(STORAGE_SAMPLE, state.sampleText);
      } catch (_) {}
      for (const input of fontBookSampleInputs()) {
        if (input !== e.target) input.value = state.sampleText;
      }
      renderFontBook();
      return;
    }
    if (!e.target?.classList?.contains("font-book-search")) return;
    const pos = e.target.selectionStart ?? e.target.value.length;
    const listId = e.target.closest(".font-book-list")?.id || "";
    state.query = e.target.value || "";
    renderFontBook();
    requestAnimationFrame(() => {
      const root = listId ? $(listId) : null;
      const input = root?.querySelector(".font-book-search") ?? document.querySelector(".font-book-search");
      if (!input) return;
      input.focus();
      input.setSelectionRange(pos, pos);
    });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && expandedEntryId) closeExpanded();
    if (e.key === "Escape" && state.selectModalOpen) closeFontBookSelectModal();
    if (e.key === "Escape") {
      for (const wrap of fontBookCategoryWraps()) {
        const menu = wrap.querySelector(".font-book-category-menu");
        const btn = wrap.querySelector("#font-book-category-menu-btn, [data-font-book-action='category']");
        if (!menu || menu.hidden) continue;
        menu.hidden = true;
        btn?.setAttribute("aria-expanded", "false");
      }
    }
  });
  document.addEventListener("click", (e) => {
    const wrap = e.target?.closest?.(".font-book-category-menu-wrap");
    if (wrap) return;
    for (const categoryWrap of fontBookCategoryWraps()) {
      const menu = categoryWrap.querySelector(".font-book-category-menu");
      if (!menu || menu.hidden) continue;
      menu.hidden = true;
      categoryWrap.querySelector("#font-book-category-menu-btn, [data-font-book-action='category']")?.setAttribute("aria-expanded", "false");
    }
  });
  window.addEventListener("psdesign:fonts-loaded", renderFontBook);
  window.addEventListener("opus:font-book-visible", loadInitialFontBook);
}

function loadInitialFontBook() {
  if (initialLoadStarted) return;
  initialLoadStarted = true;
  loadRootFolders();
}

export function initFontBookPanel() {
  if (initialized) return;
  initialized = true;
  // ルート（外部参照 enc）を起動時に先読みしておく（描画時の表示・比較で参照されるため）。
  ensureFontBookRoot().catch(() => {});
  try {
    const sample = localStorage.getItem(STORAGE_SAMPLE);
    if (sample) state.sampleText = sample;
  } catch (_) {}
  for (const sampleInput of fontBookSampleInputs()) {
    sampleInput.value = state.sampleText;
  }
  bindPdfFontBookToggle();
  bindControls();
  renderFontBook();
}
