import { invoke } from "@tauri-apps/api/core";
import { getFonts } from "./state.js";
import { ensureFontLoaded } from "./font-loader.js";
import { toast } from "./ui-feedback.js";

const STORAGE_SAMPLE = "opus_font_book_sample_text";
const FONT_BOOK_ROOT_PATH = "G:/共有ドライブ/CLLENN/編集部フォルダ/編集企画部/写植・校正用テキストログ";
const FONT_BOOK_DIR_NAME = "フォント帳";
const PRESET_JSON_ROOT_PATH = "G:/共有ドライブ/CLLENN/編集部フォルダ/編集企画部/編集＿画_C班(AT業務推進)/DTP制作部/JSONフォルダ";
const DEFAULT_SAMPLE_TEXT = "永字八法 あいうえお ABC 123";
const FOLDER_ICON_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
const FILE_ICON_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';

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
  selectModalOpen: false,
  navigatorLoading: false,
  loadedBookCount: 0,
  scannedJsonCount: 0,
};

let initialized = false;
let expandedEntryId = null;
let sampleObserver = null;
let initialLoadStarted = false;

const $ = (id) => document.getElementById(id);

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

function safePathPart(part) {
  return String(part ?? "").trim().replace(/[\\/:*?"<>|]/g, "_");
}

function fontBookDirForWork(label, title) {
  const safeLabel = safePathPart(label);
  const safeTitle = safePathPart(title);
  if (!safeLabel || !safeTitle) return "";
  return joinPath(FONT_BOOK_ROOT_PATH, safeLabel, safeTitle, FONT_BOOK_DIR_NAME);
}

function extractWorkInfoFromPresetJson(data, fallback = {}) {
  const workInfo = data?.presetData?.workInfo || data?.workInfo || {};
  const label = String(workInfo.label || fallback.label || "").trim();
  const title = String(workInfo.title || fallback.title || "").trim();
  return { label, title };
}

function extractPresetFontsFromPresetJson(data, fallback = {}) {
  const presets = data?.presetData?.presets || data?.presets || {};
  const out = [];
  for (const setEntries of Object.values(presets)) {
    if (!Array.isArray(setEntries)) continue;
    for (const item of setEntries) {
      const fontPostScript = String(item?.font || item?.fontPostScript || "").trim();
      if (!fontPostScript) continue;
      out.push({
        fontPostScript,
        displayName: String(item?.name || item?.fontDisplayName || fontPostScript),
        subName: String(item?.subName || ""),
        workLabel: String(fallback.label || ""),
        workTitle: String(fallback.title || ""),
      });
    }
  }
  return out;
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

async function collectPresetJsonFiles(root, depth = 0, out = []) {
  if (!root || depth > 3) return out;
  let entries = [];
  try {
    entries = await listDirectoryItems(root);
  } catch (_) {
    return out;
  }
  for (const entry of entries) {
    const fullPath = dirPath(entry, root);
    if (entry.isDirectory) {
      await collectPresetJsonFiles(fullPath, depth + 1, out);
      continue;
    }
    if (!entry.isFile || !/\.json$/i.test(entry.name || fullPath)) continue;
    if (/_scandata\.json$/i.test(entry.name || fullPath)) continue;
    out.push(fullPath);
  }
  return out;
}

async function readPresetJsonInfo(path) {
  const content = await invoke("read_text_file", { path });
  const data = JSON.parse(content);
  const normalized = String(path || "").replace(/\\/g, "/");
  const parts = normalized.split("/");
  const fileName = parts.pop() || "";
  const fallbackTitle = fileName.replace(/\.json$/i, "");
  const fallbackLabel = parts[parts.length - 1] || "";
  const work = extractWorkInfoFromPresetJson(data, { label: fallbackLabel, title: fallbackTitle });
  return {
    path,
    data,
    label: work.label,
    title: work.title,
    presetFonts: extractPresetFontsFromPresetJson(data, work),
  };
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

async function loadFontBookBrowserFolder(path = FONT_BOOK_ROOT_PATH) {
  const dir = cleanPath(path || FONT_BOOK_ROOT_PATH);
  state.navigatorLoading = true;
  state.browserPath = dir;
  renderFontBookSelectModal();
  try {
    const entries = await listDirectoryItems(dir);
    state.browserItems = entries
      .filter((entry) => entry?.isDirectory || (entry?.isFile && /^fontbook\.json$/i.test(entry.name || "")))
      .map((entry) => ({
        name: String(entry.name || pathName(entry.path)),
        path: dirPath(entry, dir),
        isDirectory: !!entry.isDirectory,
        isFile: !!entry.isFile,
      }))
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name, "ja");
      });
  } catch (e) {
    state.browserItems = [];
    toast(`フォルダを読み込めませんでした: ${e}`, { kind: "error" });
  } finally {
    state.navigatorLoading = false;
    renderFontBookSelectModal();
  }
}

async function loadRootFolders() {
  state.navigatorLoading = true;
  if (state.selectModalOpen) renderFontBookSelectModal();
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
    toast(`${state.selectedWorkName || "作品情報"} を読み込みました (${state.entries.length}件)`, { kind: "success" });
    return true;
  } catch (e) {
    toast(`fontbook.json を読み込めませんでした: ${e}`, { kind: "error" });
    return false;
  } finally {
    state.navigatorLoading = false;
    if (state.selectModalOpen) renderFontBookSelectModal();
  }
}

async function loadFontBookFromWorkFolder(folder) {
  if (!folder?.path) return false;
  state.navigatorLoading = true;
  state.selectedWorkPath = folder.path;
  state.selectedWorkName = folder.name || "";
  try {
    const book = await readFontBookFromWorkFolder(folder.path);
    if (!book) {
      state.dir = cleanPath(folder.path);
      state.entries = [];
      state.selectedBookFolderName = "";
      state.presetFonts = [];
      state.loadedBookCount = 0;
      state.scannedJsonCount = 0;
      renderFontBook();
      toast("fontbook.json が見つかりませんでした", { kind: "warning" });
      return false;
    }
    const entriesByKey = new Map();
    for (const entry of book.entries) entriesByKey.set(entry.key, entry);
    state.dir = book.dir;
    state.sourceMode = "gdrive-folder";
    state.entries = Array.from(entriesByKey.values());
    state.selectedBookFolderName = bookDisplayFolderName(joinPath(book.dir, "fontbook.json"));
    state.presetFonts = [];
    state.loadedBookCount = 1;
    state.scannedJsonCount = 0;
    state.category = "";
    renderFontBook();
    toast(`${state.selectedWorkName || "フォント帳"} を読み込みました (${state.entries.length}件)`, { kind: "success" });
    return true;
  } catch (e) {
    toast(`fontbook.json を読み込めませんでした: ${e}`, { kind: "error" });
    return false;
  } finally {
    state.navigatorLoading = false;
  }
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
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 19V5"></path>
            <path d="m5 12 7-7 7 7"></path>
          </svg>
        </button>
        <div class="font-book-browser-path" title="${escapeHtml(currentPath)}">${escapeHtml(currentPath.replace(FONT_BOOK_ROOT_PATH, "TOP"))}</div>
      </div>
      <div class="font-book-browser-list">
        ${state.navigatorLoading ? `<div class="font-book-select-empty">読み込み中...</div>` : state.browserItems.length === 0 ? `<div class="font-book-select-empty">フォルダまたはfontbook.jsonがありません</div>` : state.browserItems.map((item) => `
          <button class="font-book-browser-item ${item.isFile ? "json" : "folder"} ${item.path === state.selectedJsonPath ? "active" : ""}" type="button" data-path="${escapeHtml(item.path)}" data-kind="${item.isFile ? "json" : "folder"}" title="${escapeHtml(item.name)}">
            <span class="font-book-browser-icon" aria-hidden="true">${item.isFile ? FILE_ICON_SVG : FOLDER_ICON_SVG}</span>
            <span class="font-book-browser-name">${escapeHtml(item.name)}</span>
          </button>
        `).join("")}
      </div>
    </div>`;
  bindFontBookSelectModalEvents(modal);
}

function bindFontBookSelectModalEvents(modal) {
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

async function scanGDriveFontBooks() {
  const books = [];
  const seenDirs = new Set();
  const presetFontsByKey = new Map();
  let scannedJsonCount = 0;
  const pushBook = (book) => {
    if (!book || seenDirs.has(book.dir)) return;
    seenDirs.add(book.dir);
    books.push(book);
  };

  const presetJsonFiles = await collectPresetJsonFiles(PRESET_JSON_ROOT_PATH);
  for (const jsonPath of presetJsonFiles) {
    let info = null;
    try {
      info = await readPresetJsonInfo(jsonPath);
    } catch (_) {
      continue;
    }
    scannedJsonCount += 1;
    for (const preset of info.presetFonts) {
      const key = `${preset.fontPostScript}::${preset.subName}`;
      if (!presetFontsByKey.has(key)) presetFontsByKey.set(key, preset);
    }
    const dir = fontBookDirForWork(info.label, info.title);
    if (dir) pushBook(await tryReadFontBookDir(dir));
  }

  // JSON にまだ紐づいていない既存フォント帳も拾うフォールバック。
  pushBook(await tryReadFontBookDir(FONT_BOOK_ROOT_PATH));
  const labels = await listDirectories(FONT_BOOK_ROOT_PATH);
  for (const label of labels) {
    const labelPath = dirPath(label, FONT_BOOK_ROOT_PATH);
    pushBook(await tryReadFontBookDir(joinPath(labelPath, FONT_BOOK_DIR_NAME)));

    let titles = [];
    try {
      titles = await listDirectories(labelPath);
    } catch (_) {
      continue;
    }
    for (const title of titles) {
      const titlePath = dirPath(title, labelPath);
      pushBook(await tryReadFontBookDir(joinPath(titlePath, FONT_BOOK_DIR_NAME)));
    }
  }
  return { books, presetFonts: Array.from(presetFontsByKey.values()), scannedJsonCount };
}

async function loadFontBooksFromGDrive({ notify = true } = {}) {
  try {
    const { books, presetFonts, scannedJsonCount } = await scanGDriveFontBooks();
    const entriesByKey = new Map();
    for (const book of books) {
      for (const entry of book.entries) {
        entriesByKey.set(entry.key, entry);
      }
    }
    state.dir = FONT_BOOK_ROOT_PATH;
    state.sourceMode = "gdrive";
    state.entries = Array.from(entriesByKey.values());
    state.presetFonts = presetFonts;
    state.loadedBookCount = books.length;
    state.scannedJsonCount = scannedJsonCount;
    renderFontBook();
    if (notify) {
      toast(`作品名JSONからフォント帳を読み込みました (${scannedJsonCount}JSON / ${books.length}冊 / ${state.entries.length}件)`, { kind: "success" });
    }
    return books.length > 0;
  } catch (e) {
    if (notify) toast(`Gドライブのフォント帳を読み込めませんでした: ${e}`, { kind: "error" });
    return false;
  }
}

function fontLabel(font) {
  return font?.name || font?.family || font?.postScriptName || "";
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
  const query = state.query.trim().toLowerCase();
  return buildGroups().filter((group) => {
    if (state.hideEmpty && group.entries.length === 0) return false;
    if (state.category && group.subName !== state.category) return false;
    if (!query) return true;
    const haystack = `${group.displayName} ${group.postScriptName} ${group.subName}`.toLowerCase();
    return haystack.includes(query);
  });
}

function renderCategories(groups) {
  const root = $("font-book-category-items");
  const btn = $("font-book-category-menu-btn");
  if (!root || !btn) return;
  const cats = Array.from(new Set(groups.map((g) => g.subName).filter(Boolean))).sort((a, b) => a.localeCompare(b, "ja"));
  btn.disabled = false;
  btn.title = state.category ? `カテゴリ: ${state.category}` : "カテゴリ";
  btn.setAttribute("aria-label", btn.title);
  root.innerHTML = [
    `<button class="font-book-category-item ${state.category ? "" : "active"}" type="button" data-category="">すべて</button>`,
    ...cats.map((cat) =>
      `<button class="font-book-category-item ${state.category === cat ? "active" : ""}" type="button" data-category="${escapeHtml(cat)}">${escapeHtml(cat)}</button>`,
    ),
  ].join("");
  for (const item of root.querySelectorAll(".font-book-category-item")) {
    item.addEventListener("click", () => {
      state.category = item.dataset.category || "";
      root.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      renderFontBook();
    });
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
  const list = $("font-book-list");
  if (!list) return;

  const allGroups = buildGroups();
  const groups = filteredGroups();
  renderCategories(allGroups);

  const heading = state.selectedBookFolderName
    ? `<div class="font-book-source-title" title="${escapeHtml(state.selectedJsonPath || state.dir || "")}">${escapeHtml(state.selectedBookFolderName)}</div>`
    : "";
  const listHeader = `
    <div class="font-book-list-header">
      ${heading}
      <input id="font-book-search" class="font-book-search" type="search" placeholder="フォント名で検索..." autocomplete="off" value="${escapeHtml(state.query)}" />
    </div>`;
  if (groups.length === 0) {
    list.innerHTML = `
      ${listHeader}
      <div class="font-book-empty">
        <div class="font-book-empty-icon">Aa</div>
        <div>表示できるフォントがありません。</div>
      </div>`;
    return;
  }

  list.dataset.size = state.previewSize;
  list.innerHTML = `${listHeader}${groups.map(renderGroup).join("")}`;
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
      <span class="font-book-shot-caption">${escapeHtml(entry.sourceFile || entry.fontDisplayName)}</span>
      ${note}
    </button>`;
}

function bindRenderedCards() {
  if (sampleObserver) {
    sampleObserver.disconnect();
    sampleObserver = null;
  }
  const list = $("font-book-list");
  const fonts = fontMapByPostScript();
  sampleObserver = new IntersectionObserver((items) => {
    for (const item of items) {
      if (!item.isIntersecting) continue;
      const sample = item.target;
      const ps = sample.dataset.fontPs;
      const font = fonts.get(ps);
      if (font) {
        sample.style.fontFamily = `"${font.name}", "${font.postScriptName}", sans-serif`;
        ensureFontLoaded(font.postScriptName);
      }
      sampleObserver?.unobserve(sample);
    }
  }, { root: list, rootMargin: "140px" });
  for (const sample of document.querySelectorAll(".font-book-sample[data-font-ps]")) {
    const ps = sample.dataset.fontPs;
    const font = fonts.get(ps);
    if (font) {
      sample.style.fontFamily = `"${font.name}", "${font.postScriptName}", sans-serif`;
    }
    sampleObserver.observe(sample);
  }
  for (const shot of document.querySelectorAll(".font-book-shot[data-entry-key]")) {
    shot.addEventListener("click", () => openExpanded(shot.dataset.entryKey));
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

function bindControls() {
  $("font-book-select-info-btn")?.addEventListener("click", () => {
    openFontBookSelectModal();
  });
  $("font-book-refresh-btn")?.addEventListener("click", () => {
    loadRootFolders();
  });
  $("font-book-category-menu-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = $("font-book-category-menu");
    const btn = $("font-book-category-menu-btn");
    if (!menu || !btn) return;
    const willOpen = menu.hidden;
    if (willOpen) {
      const rect = btn.getBoundingClientRect();
      const width = 220;
      const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width));
      menu.style.setProperty("--font-book-category-menu-left", `${left}px`);
      menu.style.setProperty("--font-book-category-menu-top", `${rect.bottom + 6}px`);
    }
    menu.hidden = !willOpen;
    btn.setAttribute("aria-expanded", menu.hidden ? "false" : "true");
  });
  $("font-book-sample-input")?.addEventListener("input", (e) => {
    state.sampleText = e.target.value || DEFAULT_SAMPLE_TEXT;
    try {
      localStorage.setItem(STORAGE_SAMPLE, state.sampleText);
    } catch (_) {}
    renderFontBook();
  });
  document.addEventListener("input", (e) => {
    if (e.target?.id !== "font-book-search") return;
    const pos = e.target.selectionStart ?? e.target.value.length;
    state.query = e.target.value || "";
    renderFontBook();
    requestAnimationFrame(() => {
      const input = $("font-book-search");
      if (!input) return;
      input.focus();
      input.setSelectionRange(pos, pos);
    });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && expandedEntryId) closeExpanded();
    if (e.key === "Escape" && state.selectModalOpen) closeFontBookSelectModal();
    if (e.key === "Escape") {
      const menu = $("font-book-category-menu");
      const btn = $("font-book-category-menu-btn");
      if (menu && !menu.hidden) {
        menu.hidden = true;
        btn?.setAttribute("aria-expanded", "false");
      }
    }
  });
  document.addEventListener("click", (e) => {
    const menu = $("font-book-category-menu");
    const wrap = e.target?.closest?.(".font-book-category-menu-wrap");
    if (menu && !menu.hidden && !wrap) {
      menu.hidden = true;
      $("font-book-category-menu-btn")?.setAttribute("aria-expanded", "false");
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
  try {
    const sample = localStorage.getItem(STORAGE_SAMPLE);
    if (sample) state.sampleText = sample;
  } catch (_) {}
  const sampleInput = $("font-book-sample-input");
  if (sampleInput) sampleInput.value = state.sampleText;
  bindControls();
  renderFontBook();
}
