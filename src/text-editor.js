import {
  getCurrentPageIndex,
  getEdit,
  getFonts,
  getNewLayersForPsd,
  getPages,
  getSelectedLayer,
  removeNewLayer,
  setCurrentFont,
  setCurrentPageIndex,
  setEdit,
  setSelectedLayer,
  setTextSize,
  updateNewLayer,
} from "./state.js";
import { refreshAllOverlays } from "./canvas-tools.js";

const listEl = () => document.getElementById("layer-list");
const editorEl = () => document.getElementById("editor");
const contentsEl = () => document.getElementById("edit-contents");
const fontEl = () => document.getElementById("edit-font");
const fontComboboxEl = () => document.getElementById("edit-font-combobox");
const fontToggleEl = () => document.getElementById("edit-font-toggle");
const fontListEl = () => document.getElementById("edit-font-list");

export function rebuildLayerList() {
  const ul = listEl();
  ul.innerHTML = "";
  const pages = getPages();
  if (pages.length === 0) {
    applySelectionHighlight();
    populateEditor();
    return;
  }

  const pageIndex = Math.max(0, Math.min(pages.length - 1, getCurrentPageIndex()));
  const page = pages[pageIndex];

  const header = document.createElement("li");
  header.textContent = `— ${fileName(page.path)} —`;
  header.style.pointerEvents = "none";
  header.style.color = "var(--text-muted)";
  header.style.fontWeight = "600";
  ul.appendChild(header);

  for (const layer of page.textLayers) {
    const li = document.createElement("li");
    li.dataset.pageIndex = String(pageIndex);
    li.dataset.layerId = String(layer.id);
    li.dataset.layerKind = "existing";
    const edit = getEdit(page.path, layer.id);
    const displayText = edit?.contents ?? layer.text;
    const movedMark = edit && (edit.dx || edit.dy) ? "・移動" : "";
    const editedMark = edit ? `• 編集済${movedMark}` : "";
    li.innerHTML = `
      <div class="layer-text">${escapeHtml(truncate(displayText, 40))}</div>
      <div class="layer-meta">${escapeHtml(layer.font || "")} ${layer.fontSize ?? ""}pt ${editedMark}</div>
    `;
    li.addEventListener("click", () => selectLayer(pageIndex, layer.id));
    ul.appendChild(li);
  }

  const newLayers = getNewLayersForPsd(page.path);
  for (const nl of newLayers) {
    const li = document.createElement("li");
    li.dataset.pageIndex = String(pageIndex);
    li.dataset.layerId = nl.tempId;
    li.dataset.layerKind = "new";
    li.innerHTML = `
      <div class="layer-text">＋ ${escapeHtml(truncate(nl.contents, 40))}</div>
      <div class="layer-meta">新規テキスト ${nl.sizePt ?? ""}pt</div>
    `;
    li.addEventListener("click", () => selectLayer(pageIndex, nl.tempId));
    ul.appendChild(li);
  }

  applySelectionHighlight();
  populateEditor();
}

function selectLayer(pageIndex, layerId) {
  if (getCurrentPageIndex() !== pageIndex) {
    setCurrentPageIndex(pageIndex);
  }
  setSelectedLayer(pageIndex, layerId);
  applySelectionHighlight();
  populateEditor();
  refreshAllOverlays();
}

function applySelectionHighlight() {
  const sel = getSelectedLayer();
  for (const li of listEl().querySelectorAll("li[data-layer-id]")) {
    const match =
      sel &&
      li.dataset.pageIndex === String(sel.pageIndex) &&
      li.dataset.layerId === String(sel.layerId);
    li.classList.toggle("selected", !!match);
  }
}

function resolveSelection() {
  const sel = getSelectedLayer();
  if (!sel) return null;
  const page = getPages()[sel.pageIndex];
  if (!page) return null;
  if (typeof sel.layerId === "string") {
    const nl = getNewLayersForPsd(page.path).find((l) => l.tempId === sel.layerId);
    if (!nl) return null;
    return { kind: "new", page, newLayer: nl };
  }
  const layer = page.textLayers.find((l) => l.id === sel.layerId);
  if (!layer) return null;
  return { kind: "existing", page, layer };
}

function populateEditor() {
  const editor = editorEl();
  const resolved = resolveSelection();
  if (!resolved) {
    editor.hidden = true;
    return;
  }
  editor.hidden = false;

  const deleteBtn = document.getElementById("delete-new-layer-btn");

  let effectiveSize = null;
  let effectiveFont = null;
  if (resolved.kind === "existing") {
    const { page, layer } = resolved;
    const edit = getEdit(page.path, layer.id) ?? {};
    contentsEl().value = edit.contents ?? layer.text ?? "";
    effectiveSize = edit.sizePt ?? layer.fontSize ?? null;
    effectiveFont = edit.fontPostScriptName ?? layer.font ?? null;
    rebuildFontOptions(effectiveFont);
    if (deleteBtn) deleteBtn.hidden = true;
  } else {
    const { newLayer } = resolved;
    contentsEl().value = newLayer.contents ?? "";
    effectiveSize = newLayer.sizePt ?? null;
    effectiveFont = newLayer.fontPostScriptName ?? null;
    rebuildFontOptions(effectiveFont ?? "");
    if (deleteBtn) deleteBtn.hidden = false;
  }

  if (effectiveSize != null && Number.isFinite(effectiveSize)) {
    setTextSize(effectiveSize);
  }
  if (effectiveFont) {
    setCurrentFont(effectiveFont);
  }
}

let comboItems = [];
let comboHighlighted = -1;
let comboOpen = false;

function ensureComboBuilt() {
  const list = fontListEl();
  if (!list || comboItems.length) return;
  const fonts = getFonts();
  if (!fonts.length) return;
  list.innerHTML = "";
  comboItems = fonts.map((font) => {
    const li = document.createElement("li");
    li.className = "font-combobox-item";
    li.setAttribute("role", "option");
    const main = document.createElement("span");
    main.className = "font-combobox-name";
    main.textContent = font.name || font.postScriptName;
    li.appendChild(main);
    if (font.name && font.postScriptName && font.name !== font.postScriptName) {
      const sub = document.createElement("span");
      sub.className = "font-combobox-sub";
      sub.textContent = font.postScriptName;
      li.appendChild(sub);
    }
    li.addEventListener("mousedown", (e) => e.preventDefault());
    li.addEventListener("click", () => commitFont(font));
    list.appendChild(li);
    return { el: li, font };
  });
}

function filterCombo(query) {
  const q = (query ?? "").trim().toLowerCase();
  let firstVisible = -1;
  for (let i = 0; i < comboItems.length; i++) {
    const { el, font } = comboItems[i];
    const hay = `${font.name ?? ""}\n${font.postScriptName ?? ""}`.toLowerCase();
    const match = q === "" || hay.includes(q);
    el.style.display = match ? "" : "none";
    if (match && firstVisible < 0) firstVisible = i;
  }
  setComboHighlight(firstVisible);
}

function setComboHighlight(idx) {
  if (comboHighlighted >= 0 && comboItems[comboHighlighted]) {
    comboItems[comboHighlighted].el.classList.remove("highlight");
  }
  comboHighlighted = idx;
  if (idx >= 0 && comboItems[idx]) {
    comboItems[idx].el.classList.add("highlight");
    comboItems[idx].el.scrollIntoView({ block: "nearest" });
  }
}

function openCombo() {
  ensureComboBuilt();
  const list = fontListEl();
  if (!list || !comboItems.length) return;
  list.hidden = false;
  comboOpen = true;
  filterCombo(fontEl().value);
  const currentPs = fontEl().dataset.ps || "";
  if (currentPs) {
    const idx = comboItems.findIndex(({ font, el }) =>
      el.style.display !== "none" && font.postScriptName === currentPs);
    if (idx >= 0) setComboHighlight(idx);
  }
}

function closeCombo() {
  const list = fontListEl();
  if (list) list.hidden = true;
  comboOpen = false;
}

function moveComboHighlight(dir) {
  if (!comboOpen) { openCombo(); return; }
  const visible = [];
  for (let i = 0; i < comboItems.length; i++) {
    if (comboItems[i].el.style.display !== "none") visible.push(i);
  }
  if (!visible.length) return;
  let pos = visible.indexOf(comboHighlighted);
  if (pos < 0) pos = 0;
  else pos = (pos + dir + visible.length) % visible.length;
  setComboHighlight(visible[pos]);
}

function commitFont(font) {
  const input = fontEl();
  input.value = font.name || font.postScriptName;
  input.dataset.ps = font.postScriptName;
  setCurrentFont(font.postScriptName);
  commitField("fontPostScriptName", font.postScriptName);
  closeCombo();
}

function resolveFontFromInput(typed) {
  const trimmed = (typed ?? "").trim();
  if (!trimmed) return null;
  const fonts = getFonts();
  const exactDisplay = fonts.find((f) => (f.name ?? "") === trimmed);
  if (exactDisplay) return exactDisplay;
  const exactPs = fonts.find((f) => (f.postScriptName ?? "") === trimmed);
  if (exactPs) return exactPs;
  const lower = trimmed.toLowerCase();
  const ciDisplay = fonts.find((f) => (f.name ?? "").toLowerCase() === lower);
  if (ciDisplay) return ciDisplay;
  const ciPs = fonts.find((f) => (f.postScriptName ?? "").toLowerCase() === lower);
  if (ciPs) return ciPs;
  return null;
}

function rebuildFontOptions(currentValue) {
  const input = fontEl();
  if (!input) return;
  const fonts = getFonts();
  let displayText = "";
  let ps = "";
  if (currentValue) {
    const hit =
      fonts.find((f) => f.postScriptName === currentValue) ??
      fonts.find((f) => f.name === currentValue);
    if (hit) {
      displayText = hit.name || hit.postScriptName;
      ps = hit.postScriptName;
    } else {
      displayText = currentValue;
      ps = currentValue;
    }
  }
  input.value = displayText;
  input.dataset.ps = ps;
}

export function bindEditorEvents() {
  contentsEl().addEventListener("input", () => commitField("contents", contentsEl().value));
  const input = fontEl();
  input.addEventListener("focus", () => openCombo());
  input.addEventListener("input", () => {
    if (!comboOpen) openCombo();
    else filterCombo(input.value);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveComboHighlight(+1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveComboHighlight(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (comboOpen && comboHighlighted >= 0) {
        commitFont(comboItems[comboHighlighted].font);
      } else {
        const font = resolveFontFromInput(input.value);
        if (font) commitFont(font);
      }
      input.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeCombo();
      input.blur();
    }
  });
  input.addEventListener("blur", () => {
    setTimeout(() => {
      const active = document.activeElement;
      if (!active || !fontComboboxEl()?.contains(active)) closeCombo();
    }, 120);
  });
  const toggleBtn = fontToggleEl();
  if (toggleBtn) {
    toggleBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      if (comboOpen) {
        closeCombo();
      } else {
        input.focus();
        openCombo();
      }
    });
  }
  document.addEventListener("mousedown", (e) => {
    if (!comboOpen) return;
    if (!fontComboboxEl()?.contains(e.target)) closeCombo();
  });
  const deleteBtn = document.getElementById("delete-new-layer-btn");
  if (deleteBtn) {
    deleteBtn.addEventListener("click", () => {
      const resolved = resolveSelection();
      if (!resolved || resolved.kind !== "new") return;
      removeNewLayer(resolved.newLayer.tempId);
      setSelectedLayer(null);
      rebuildLayerList();
      refreshAllOverlays();
    });
  }
}

function commitField(field, value) {
  const resolved = resolveSelection();
  if (!resolved) return;
  if (resolved.kind === "existing") {
    setEdit(resolved.page.path, resolved.layer.id, { [field]: value });
  } else {
    updateNewLayer(resolved.newLayer.tempId, { [field]: value });
  }
  rebuildLayerList();
  refreshAllOverlays();
}

export function commitSelectedLayerField(field, value) {
  commitField(field, value);
}

export function hasSelection() {
  return resolveSelection() != null;
}

function truncate(s, n) { return s && s.length > n ? s.slice(0, n) + "…" : s; }
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fileName(p) {
  if (!p) return "";
  const m = p.match(/[\\/]([^\\/]+)$/);
  return m ? m[1] : p;
}
