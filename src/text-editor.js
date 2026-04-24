import {
  getCurrentPageIndex,
  getEdit,
  getFonts,
  getNewLayersForPsd,
  getPages,
  getSelectedLayer,
  getSelectedLayers,
  getStrokeColor,
  getStrokeWidthPx,
  removeNewLayer,
  setCurrentFont,
  setCurrentPageIndex,
  setEdit,
  setSelectedLayer,
  setSelectedLayers,
  setStrokeColor,
  setStrokeWidthPx,
  setTextSize,
  toggleLayerSelected,
  updateNewLayer,
} from "./state.js";
import { refreshAllOverlays } from "./canvas-tools.js";
import { confirmDialog } from "./ui-feedback.js";

const listEl = () => document.getElementById("layer-list");
const editorEl = () => document.getElementById("editor");
const fontEl = () => document.getElementById("edit-font");
const fontComboboxEl = () => document.getElementById("edit-font-combobox");
const fontToggleEl = () => document.getElementById("edit-font-toggle");
const fontListEl = () => document.getElementById("edit-font-list");
const dirVerticalBtnEl = () => document.getElementById("dir-vertical-btn");
const dirHorizontalBtnEl = () => document.getElementById("dir-horizontal-btn");
const strokeNoneBtnEl = () => document.getElementById("stroke-none-btn");
const strokeWhiteBtnEl = () => document.getElementById("stroke-white-btn");
const strokeBlackBtnEl = () => document.getElementById("stroke-black-btn");
const strokeWidthInputEl = () => document.getElementById("stroke-width-input");

function syncDirectionToggle(direction) {
  const v = dirVerticalBtnEl();
  const h = dirHorizontalBtnEl();
  if (v) v.classList.toggle("active", direction === "vertical");
  if (h) h.classList.toggle("active", direction === "horizontal");
}

// color === null は「複数選択で値が混在している」状態。全ボタン非アクティブ。
function syncStrokeToggle(color) {
  const n = strokeNoneBtnEl();
  const w = strokeWhiteBtnEl();
  const b = strokeBlackBtnEl();
  if (n) n.classList.toggle("active", color === "none");
  if (w) w.classList.toggle("active", color === "white");
  if (b) b.classList.toggle("active", color === "black");
}

// widthPx === null は混在。input を空にして placeholder で示す。
function syncStrokeWidthInput(widthPx) {
  const input = strokeWidthInputEl();
  if (!input) return;
  if (document.activeElement === input) return;
  if (widthPx == null) {
    input.value = "";
    input.placeholder = "混在";
    return;
  }
  input.value = String(widthPx);
  input.placeholder = "";
}

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
    li.addEventListener("click", (e) => selectLayer(pageIndex, layer.id, e));
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
    li.addEventListener("click", (e) => selectLayer(pageIndex, nl.tempId, e));
    ul.appendChild(li);
  }

  applySelectionHighlight();
  populateEditor();
}

function selectLayer(pageIndex, layerId, event) {
  if (getCurrentPageIndex() !== pageIndex) {
    setCurrentPageIndex(pageIndex);
  }
  if (event?.shiftKey) {
    toggleLayerSelected(pageIndex, layerId);
  } else {
    setSelectedLayer(pageIndex, layerId);
  }
  applySelectionHighlight();
  populateEditor();
  refreshAllOverlays();
}

function applySelectionHighlight() {
  const selections = getSelectedLayers();
  for (const li of listEl().querySelectorAll("li[data-layer-id]")) {
    const match = selections.some(
      (s) =>
        li.dataset.pageIndex === String(s.pageIndex) &&
        li.dataset.layerId === String(s.layerId),
    );
    li.classList.toggle("selected", match);
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

function updateDeleteButtonVisibility() {
  const deleteBtn = document.getElementById("delete-new-layer-btn");
  if (!deleteBtn) return;
  const anyNew = getSelectedLayers().some((s) => typeof s.layerId === "string");
  deleteBtn.hidden = !anyNew;
}

// 選択中レイヤー集合からフチ（color/width）の共通値を算出する。
// 全て同値なら値、混在なら null、選択 0 件なら既定値（none/2）。
function computeCommonStroke(selections) {
  if (selections.length === 0) {
    return { strokeColor: "none", strokeWidthPx: 2 };
  }
  let color;
  let width;
  for (const s of selections) {
    const resolved = resolveLayerRef(s);
    if (!resolved) continue;
    let c, w;
    if (resolved.kind === "existing") {
      const { page, layer } = resolved;
      const edit = getEdit(page.path, layer.id) ?? {};
      c = edit.strokeColor ?? layer.strokeColor ?? "none";
      w = edit.strokeWidthPx ?? layer.strokeWidthPx ?? 2;
    } else {
      c = resolved.newLayer.strokeColor ?? "none";
      w = resolved.newLayer.strokeWidthPx ?? 2;
    }
    if (color === undefined) color = c; else if (color !== c) color = null;
    if (width === undefined) width = w; else if (width !== w) width = null;
  }
  return {
    strokeColor: color === undefined ? "none" : color,
    strokeWidthPx: width === undefined ? 2 : width,
  };
}

function resolveLayerRef(sel) {
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
  const selections = getSelectedLayers();
  updateDeleteButtonVisibility();

  if (selections.length === 0) {
    editor.hidden = true;
    return;
  }
  editor.hidden = false;

  // フォント/サイズ/組方向は単独選択時のみ表示（複数だと値が曖昧）。
  // フチは複数選択でも一括適用できるため常に表示。
  const singleOnly = editor.querySelectorAll("[data-editor-scope='single']");
  for (const el of singleOnly) el.hidden = selections.length !== 1;

  if (selections.length === 1) {
    const resolved = resolveSelection();
    if (!resolved) { editor.hidden = true; return; }

    let effectiveSize = null;
    let effectiveFont = null;
    let effectiveDirection = "vertical";
    if (resolved.kind === "existing") {
      const { page, layer } = resolved;
      const edit = getEdit(page.path, layer.id) ?? {};
      effectiveSize = edit.sizePt ?? layer.fontSize ?? null;
      effectiveFont = edit.fontPostScriptName ?? layer.font ?? null;
      effectiveDirection = edit.direction ?? layer.direction ?? "horizontal";
      rebuildFontOptions(effectiveFont);
    } else {
      const { newLayer } = resolved;
      effectiveSize = newLayer.sizePt ?? null;
      effectiveFont = newLayer.fontPostScriptName ?? null;
      effectiveDirection = newLayer.direction ?? "vertical";
      rebuildFontOptions(effectiveFont ?? "");
    }

    if (effectiveSize != null && Number.isFinite(effectiveSize)) setTextSize(effectiveSize);
    if (effectiveFont) setCurrentFont(effectiveFont);
    syncDirectionToggle(effectiveDirection);
  }

  // フチは単独/複数いずれでも共通値を表示。
  const { strokeColor, strokeWidthPx } = computeCommonStroke(selections);
  if (strokeColor != null) setStrokeColor(strokeColor);
  if (strokeWidthPx != null) setStrokeWidthPx(strokeWidthPx);
  syncStrokeToggle(strokeColor);
  syncStrokeWidthInput(strokeWidthPx);
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
    deleteBtn.addEventListener("click", async () => {
      const selections = getSelectedLayers();
      const tempIds = selections
        .filter((s) => typeof s.layerId === "string")
        .map((s) => s.layerId);
      if (tempIds.length === 0) return;
      const ok = await confirmDialog({
        title: "レイヤー削除",
        message: "レイヤーを削除します。よろしいですか？",
        confirmLabel: "削除",
      });
      if (!ok) return;
      for (const id of tempIds) removeNewLayer(id);
      // 既存レイヤーは残し、新規分だけを選択から除外。
      setSelectedLayers(selections.filter((s) => typeof s.layerId !== "string"));
      rebuildLayerList();
      refreshAllOverlays();
    });
  }
  const bindDirButton = (btn, direction) => {
    if (!btn) return;
    btn.addEventListener("click", () => {
      commitField("direction", direction);
      syncDirectionToggle(direction);
    });
  };
  bindDirButton(dirVerticalBtnEl(), "vertical");
  bindDirButton(dirHorizontalBtnEl(), "horizontal");

  const bindStrokeButton = (btn, color) => {
    if (!btn) return;
    btn.addEventListener("click", () => {
      setStrokeColor(color);
      syncStrokeToggle(color);
      // 色と太さはセットで書き込む（片方だけだと既存レイヤーの他方が失われる）。
      // 幅が混在しているときは各レイヤーの幅を保持（null）。
      commitStrokeFields(color, currentWidthForCommit());
    });
  };
  bindStrokeButton(strokeNoneBtnEl(), "none");
  bindStrokeButton(strokeWhiteBtnEl(), "white");
  bindStrokeButton(strokeBlackBtnEl(), "black");

  const widthInput = strokeWidthInputEl();
  if (widthInput) {
    widthInput.addEventListener("input", () => {
      const raw = widthInput.value;
      if (raw === "") return;
      const n = Number(raw);
      if (!Number.isFinite(n)) return;
      setStrokeWidthPx(n);
      commitStrokeFields(null, getStrokeWidthPx());
    });
    widthInput.addEventListener("blur", () => {
      if (widthInput.value === "" || !Number.isFinite(Number(widthInput.value))) {
        setStrokeWidthPx(2);
        widthInput.value = "2";
        commitStrokeFields(null, 2);
      }
    });
  }
}

// colorOrNull / widthOrNull に null を渡すと「各レイヤーの現在値を保持」の意味。
// 複数選択でフチ色/幅が混在している状態で片方だけを編集したとき、
// 他方がグローバル state で上書きされて本来の値が失われるのを避ける。
// 色と太さは JSX 側で必ずセットで評価されるため、ここで常に両フィールドを書き込む。
function commitStrokeFields(colorOrNull, widthOrNull) {
  const selections = getSelectedLayers();
  if (selections.length === 0) return;
  for (const sel of selections) {
    const ref = resolveLayerRef(sel);
    if (!ref) continue;
    let curColor, curWidth;
    if (ref.kind === "existing") {
      const edit = getEdit(ref.page.path, ref.layer.id) ?? {};
      curColor = edit.strokeColor ?? ref.layer.strokeColor ?? "none";
      curWidth = edit.strokeWidthPx ?? ref.layer.strokeWidthPx ?? 2;
    } else {
      curColor = ref.newLayer.strokeColor ?? "none";
      curWidth = ref.newLayer.strokeWidthPx ?? 2;
    }
    const changes = {
      strokeColor: colorOrNull !== null ? colorOrNull : curColor,
      strokeWidthPx: widthOrNull !== null ? widthOrNull : curWidth,
    };
    if (ref.kind === "existing") {
      setEdit(ref.page.path, ref.layer.id, changes);
    } else {
      updateNewLayer(ref.newLayer.tempId, changes);
    }
  }
  rebuildLayerList();
  refreshAllOverlays();
}

function currentWidthForCommit() {
  const input = strokeWidthInputEl();
  // 混在表示（input が空）のときは null を返し、per-layer 保持モードにする。
  if (input && input.value === "") return null;
  return getStrokeWidthPx();
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
