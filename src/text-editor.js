import {
  getCurrentPageIndex,
  getEdit,
  getFonts,
  getNewLayersForPsd,
  getPages,
  getSelectedLayer,
  removeNewLayer,
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
const sizeEl = () => document.getElementById("edit-size");

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
  if (!resolved) { editor.hidden = true; return; }
  editor.hidden = false;

  const deleteBtn = document.getElementById("delete-new-layer-btn");

  let effectiveSize = null;
  if (resolved.kind === "existing") {
    const { page, layer } = resolved;
    const edit = getEdit(page.path, layer.id) ?? {};
    contentsEl().value = edit.contents ?? layer.text ?? "";
    effectiveSize = edit.sizePt ?? layer.fontSize ?? null;
    sizeEl().value = effectiveSize ?? "";
    rebuildFontOptions(edit.fontPostScriptName ?? layer.font);
    if (deleteBtn) deleteBtn.hidden = true;
  } else {
    const { newLayer } = resolved;
    contentsEl().value = newLayer.contents ?? "";
    effectiveSize = newLayer.sizePt ?? null;
    sizeEl().value = effectiveSize ?? "";
    rebuildFontOptions(newLayer.fontPostScriptName ?? "");
    if (deleteBtn) deleteBtn.hidden = false;
  }

  if (effectiveSize != null && Number.isFinite(effectiveSize)) {
    setTextSize(effectiveSize);
  }
}

function rebuildFontOptions(currentValue) {
  const sel = fontEl();
  sel.innerHTML = "";
  const fonts = getFonts();
  const options = fonts.length ? fonts : [{ postScriptName: currentValue || "", name: currentValue || "(現在値)" }];
  for (const font of options) {
    const opt = document.createElement("option");
    opt.value = font.postScriptName;
    opt.textContent = font.name || font.postScriptName;
    if (font.postScriptName === currentValue) opt.selected = true;
    sel.appendChild(opt);
  }
}

export function bindEditorEvents() {
  contentsEl().addEventListener("input", () => commitField("contents", contentsEl().value));
  fontEl().addEventListener("change", () => commitField("fontPostScriptName", fontEl().value));
  sizeEl().addEventListener("input", () => {
    const v = parseFloat(sizeEl().value);
    if (!Number.isNaN(v)) commitField("sizePt", v);
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
