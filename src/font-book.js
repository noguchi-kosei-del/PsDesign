import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getFonts } from "./state.js";
import { ensureFontLoaded } from "./font-loader.js";
import { openFileDialog } from "./file-picker.js";
import { toast } from "./ui-feedback.js";

const STORAGE_DIR = "psdesign_font_book_dir";
const STORAGE_SIZE = "psdesign_font_book_preview_size";

const state = {
  dir: null,
  entries: [],
  query: "",
  hideEmpty: true,
  category: "",
  previewSize: "M",
};

let initialized = false;
let expandedEntryId = null;
let sampleObserver = null;

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

function normalizeEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const id = String(entry.id ?? "").trim();
  const fontPostScript = String(entry.fontPostScript ?? "").trim();
  if (!id || !fontPostScript) return null;
  return {
    id,
    fontPostScript,
    fontDisplayName: String(entry.fontDisplayName ?? fontPostScript),
    subName: String(entry.subName ?? ""),
    sourceFile: String(entry.sourceFile ?? ""),
    capturedAt: String(entry.capturedAt ?? ""),
    note: String(entry.note ?? ""),
  };
}

async function loadFontBookFromDir(dir, { notify = true } = {}) {
  const jsonPath = `${String(dir).replace(/[\\/]+$/, "")}/fontbook.json`;
  try {
    const content = await invoke("read_text_file", { path: jsonPath });
    const data = JSON.parse(content);
    const entries = Array.isArray(data?.entries) ? data.entries.map(normalizeEntry).filter(Boolean) : [];
    state.dir = String(dir).replace(/[\\/]+$/, "");
    state.entries = entries;
    localStorage.setItem(STORAGE_DIR, state.dir);
    renderFontBook();
    if (notify) toast(`フォント帳を読み込みました (${entries.length}件)`, { kind: "success" });
  } catch (e) {
    state.dir = String(dir).replace(/[\\/]+$/, "");
    state.entries = [];
    renderFontBook();
    toast(`フォント帳を読み込めませんでした: ${e}`, { kind: "error" });
  }
}

async function chooseFontBookDir() {
  const dir = await openFileDialog({
    mode: "openFolder",
    title: "フォント帳フォルダを選択",
    rememberKey: "font-book",
    defaultPath: state.dir || undefined,
  });
  if (!dir) return;
  await loadFontBookFromDir(dir);
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
  const root = $("font-book-categories");
  if (!root) return;
  const cats = Array.from(new Set(groups.map((g) => g.subName).filter(Boolean))).sort((a, b) => a.localeCompare(b, "ja"));
  root.hidden = cats.length === 0;
  if (cats.length === 0) {
    root.innerHTML = "";
    return;
  }
  root.innerHTML = [
    `<button class="font-book-category-btn ${state.category ? "" : "active"}" type="button" data-category="">すべて</button>`,
    ...cats.map((cat) =>
      `<button class="font-book-category-btn ${state.category === cat ? "active" : ""}" type="button" data-category="${escapeHtml(cat)}">${escapeHtml(cat)}</button>`,
    ),
  ].join("");
  for (const btn of root.querySelectorAll(".font-book-category-btn")) {
    btn.addEventListener("click", () => {
      state.category = btn.dataset.category || "";
      renderFontBook();
    });
  }
}

function imageUrl(entryId) {
  if (!state.dir) return "";
  return convertFileSrc(`${state.dir}/${entryId}.jpg`);
}

function renderFontBook() {
  const meta = $("font-book-meta");
  const list = $("font-book-list");
  const hideBtn = $("font-book-hide-empty-btn");
  if (!list) return;

  const allGroups = buildGroups();
  const groups = filteredGroups();
  renderCategories(allGroups);

  if (meta) {
    const source = state.dir ? state.dir : "fontbook.json が入っている「フォント帳」フォルダを選択してください。";
    meta.textContent = state.dir
      ? `${source} / ${state.entries.length} スクリーンショット`
      : source;
    meta.title = source;
  }
  if (hideBtn) {
    hideBtn.classList.toggle("active", state.hideEmpty);
    hideBtn.setAttribute("aria-pressed", state.hideEmpty ? "true" : "false");
  }
  for (const btn of document.querySelectorAll(".font-book-size-btn")) {
    btn.classList.toggle("active", btn.dataset.size === state.previewSize);
  }

  if (groups.length === 0) {
    list.innerHTML = `
      <div class="font-book-empty">
        <div class="font-book-empty-icon">Aa</div>
        <div>表示できるフォントがありません。</div>
      </div>`;
    return;
  }

  list.dataset.size = state.previewSize;
  list.innerHTML = groups.map(renderGroup).join("");
  bindRenderedCards();
}

function renderGroup(group) {
  const ps = escapeHtml(group.postScriptName);
  const sample = "永字八法 あいうえお ABC 123";
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
  const image = imageUrl(entry.id);
  const note = entry.note ? `<div class="font-book-note">${escapeHtml(entry.note)}</div>` : "";
  return `
    <button class="font-book-shot" type="button" data-entry-id="${escapeHtml(entry.id)}">
      <img src="${escapeHtml(image)}" alt="${escapeHtml(entry.fontDisplayName)}" loading="lazy" draggable="false" />
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
  for (const shot of document.querySelectorAll(".font-book-shot[data-entry-id]")) {
    shot.addEventListener("click", () => openExpanded(shot.dataset.entryId));
  }
}

function openExpanded(entryId) {
  expandedEntryId = entryId;
  const entry = state.entries.find((e) => e.id === entryId);
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
      <button class="font-book-modal-close" type="button" data-close="1" aria-label="閉じる">×</button>
      <img src="${escapeHtml(imageUrl(entry.id))}" alt="${escapeHtml(entry.fontDisplayName)}" />
      <div class="font-book-modal-info">
        <strong>${escapeHtml(entry.fontDisplayName)}</strong>
        ${entry.subName ? `<span>${escapeHtml(entry.subName)}</span>` : ""}
        <small>${escapeHtml(entry.sourceFile || "")}</small>
        ${entry.note ? `<p>${escapeHtml(entry.note)}</p>` : ""}
      </div>
    </div>`;
  modal.hidden = false;
  modal.addEventListener("click", (e) => {
    if (e.target?.dataset?.close) closeExpanded();
  }, { once: true });
}

function closeExpanded() {
  expandedEntryId = null;
  const modal = $("font-book-modal");
  if (modal) modal.hidden = true;
}

function bindControls() {
  $("font-book-open-btn")?.addEventListener("click", chooseFontBookDir);
  $("font-book-refresh-btn")?.addEventListener("click", () => {
    if (state.dir) loadFontBookFromDir(state.dir);
    else renderFontBook();
  });
  $("font-book-search")?.addEventListener("input", (e) => {
    state.query = e.target.value || "";
    renderFontBook();
  });
  $("font-book-hide-empty-btn")?.addEventListener("click", () => {
    state.hideEmpty = !state.hideEmpty;
    renderFontBook();
  });
  for (const btn of document.querySelectorAll(".font-book-size-btn")) {
    btn.addEventListener("click", () => {
      state.previewSize = btn.dataset.size || "M";
      localStorage.setItem(STORAGE_SIZE, state.previewSize);
      renderFontBook();
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && expandedEntryId) closeExpanded();
  });
  window.addEventListener("psdesign:fonts-loaded", renderFontBook);
}

export function initFontBookPanel() {
  if (initialized) return;
  initialized = true;
  try {
    const size = localStorage.getItem(STORAGE_SIZE);
    if (size === "S" || size === "M" || size === "L") state.previewSize = size;
    const dir = localStorage.getItem(STORAGE_DIR);
    if (dir) loadFontBookFromDir(dir, { notify: false });
  } catch (_) {}
  bindControls();
  renderFontBook();
}
