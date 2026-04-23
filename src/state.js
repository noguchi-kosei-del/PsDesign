const state = {
  folder: null,
  pages: [],
  edits: new Map(),
  newLayers: [],
  selectedLayers: [], // Array<{pageIndex, layerId}>
  fonts: [],
  tool: "move",
  toolListeners: new Set(),
  nextTempId: 1,
  txtSource: null,
  txtSelection: "",
  txtSelectedBlockIndex: null,
  textSize: 12,
  textSizeListeners: new Set(),
  currentFontPostScriptName: null,
  currentFontListeners: new Set(),
  currentPageIndex: 0,
  pageIndexListeners: new Set(),
  zoom: 1,
  zoomListeners: new Set(),
};

export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 8;

export function getState() { return state; }

export function setFolder(folder) { state.folder = folder; }
export function getFolder() { return state.folder; }

export function clearPages() {
  state.pages = [];
  state.selectedLayers = [];
  state.edits.clear();
  state.newLayers = [];
  const prev = state.currentPageIndex;
  state.currentPageIndex = 0;
  if (prev !== 0) {
    for (const fn of state.pageIndexListeners) fn(0);
  }
}

export function addPage(page) { state.pages.push(page); }
export function getPages() { return state.pages; }

function editKey(psdPath, layerId) { return `${psdPath}::${layerId}`; }

export function setEdit(psdPath, layerId, changes) {
  const key = editKey(psdPath, layerId);
  const existing = state.edits.get(key) ?? { psdPath, layerId };
  state.edits.set(key, { ...existing, ...changes });
}

export function getEdit(psdPath, layerId) {
  return state.edits.get(editKey(psdPath, layerId));
}

export function addEditOffset(psdPath, layerId, ddx, ddy) {
  const current = getEdit(psdPath, layerId) ?? {};
  setEdit(psdPath, layerId, {
    dx: (current.dx ?? 0) + ddx,
    dy: (current.dy ?? 0) + ddy,
  });
}

export function hasEdits() { return state.edits.size > 0 || state.newLayers.length > 0; }

export function exportEdits() {
  const byPsd = new Map();
  const ensure = (psdPath) => {
    if (!byPsd.has(psdPath)) {
      byPsd.set(psdPath, { layers: [], newLayers: [] });
    }
    return byPsd.get(psdPath);
  };

  for (const entry of state.edits.values()) {
    const { psdPath, layerId, ...rest } = entry;
    ensure(psdPath).layers.push({ layerId, ...rest });
  }

  for (const nl of state.newLayers) {
    const { psdPath, tempId: _tempId, ...rest } = nl;
    ensure(psdPath).newLayers.push(rest);
  }

  return {
    edits: Array.from(byPsd.entries()).map(([psdPath, { layers, newLayers }]) => ({
      psdPath,
      layers,
      newLayers,
    })),
  };
}

export function setSelectedLayer(pageIndex, layerId) {
  state.selectedLayers = pageIndex == null ? [] : [{ pageIndex, layerId }];
}

export function getSelectedLayer() { return state.selectedLayers[0] ?? null; }

export function getSelectedLayers() { return state.selectedLayers; }

export function setSelectedLayers(list) {
  if (!Array.isArray(list)) {
    state.selectedLayers = [];
    return;
  }
  const seen = new Set();
  const out = [];
  for (const s of list) {
    if (!s) continue;
    const key = `${s.pageIndex}::${s.layerId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ pageIndex: s.pageIndex, layerId: s.layerId });
  }
  state.selectedLayers = out;
}

export function isLayerSelected(pageIndex, layerId) {
  return state.selectedLayers.some((s) => s.pageIndex === pageIndex && s.layerId === layerId);
}

export function toggleLayerSelected(pageIndex, layerId) {
  const idx = state.selectedLayers.findIndex((s) => s.pageIndex === pageIndex && s.layerId === layerId);
  if (idx >= 0) {
    state.selectedLayers = state.selectedLayers.filter((_, i) => i !== idx);
  } else {
    state.selectedLayers = [...state.selectedLayers, { pageIndex, layerId }];
  }
}

export function setFonts(fonts) { state.fonts = fonts; }
export function getFonts() { return state.fonts; }

export function getFontDisplayName(psName) {
  if (!psName) return null;
  const hit = state.fonts.find((f) => f.postScriptName === psName);
  return hit?.name ?? psName;
}

export function getTool() { return state.tool; }
export function setTool(tool) {
  if (tool !== "move" && tool !== "text" && tool !== "pan") return;
  if (state.tool === tool) return;
  state.tool = tool;
  for (const fn of state.toolListeners) fn(tool);
}
export function onToolChange(fn) {
  state.toolListeners.add(fn);
  return () => state.toolListeners.delete(fn);
}

export function addNewLayer({ psdPath, x, y, contents, fontPostScriptName, sizePt, direction }) {
  const tempId = `new-${state.nextTempId++}`;
  const layer = {
    tempId,
    psdPath,
    x,
    y,
    contents: contents ?? "",
    fontPostScriptName: fontPostScriptName ?? null,
    sizePt: sizePt ?? null,
    direction: direction ?? "vertical",
  };
  state.newLayers.push(layer);
  return layer;
}

export function updateNewLayer(tempId, changes) {
  const idx = state.newLayers.findIndex((l) => l.tempId === tempId);
  if (idx < 0) return;
  state.newLayers[idx] = { ...state.newLayers[idx], ...changes };
}

export function removeNewLayer(tempId) {
  state.newLayers = state.newLayers.filter((l) => l.tempId !== tempId);
}

export function getNewLayers() { return state.newLayers; }

export function getNewLayersForPsd(psdPath) {
  return state.newLayers.filter((l) => l.psdPath === psdPath);
}

export function setTxtSource(source) {
  state.txtSource = source ? { name: source.name, content: source.content } : null;
  state.txtSelection = "";
  state.txtSelectedBlockIndex = null;
}
export function getTxtSource() { return state.txtSource; }
export function clearTxtSource() {
  state.txtSource = null;
  state.txtSelection = "";
  state.txtSelectedBlockIndex = null;
}

export function setTxtSelection(s) { state.txtSelection = s || ""; }
export function getTxtSelection() { return state.txtSelection; }

export function setTxtSelectedBlockIndex(i) {
  state.txtSelectedBlockIndex = typeof i === "number" ? i : null;
}
export function getTxtSelectedBlockIndex() { return state.txtSelectedBlockIndex; }

export function getCurrentPageIndex() { return state.currentPageIndex; }
export function setCurrentPageIndex(i) {
  if (!Number.isFinite(i)) return;
  const pages = state.pages.length;
  if (pages === 0) {
    if (state.currentPageIndex !== 0) {
      state.currentPageIndex = 0;
      for (const fn of state.pageIndexListeners) fn(0);
    }
    return;
  }
  const clamped = Math.max(0, Math.min(pages - 1, Math.round(i)));
  if (state.currentPageIndex === clamped) return;
  state.currentPageIndex = clamped;
  for (const fn of state.pageIndexListeners) fn(clamped);
}
export function onPageIndexChange(fn) {
  state.pageIndexListeners.add(fn);
  return () => state.pageIndexListeners.delete(fn);
}

export function getTextSize() { return state.textSize; }
export function setTextSize(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return;
  const rounded = Math.round(v * 10) / 10;
  const clamped = Math.max(6, Math.min(400, rounded));
  if (state.textSize === clamped) return;
  state.textSize = clamped;
  for (const fn of state.textSizeListeners) fn(clamped);
}
export function onTextSizeChange(fn) {
  state.textSizeListeners.add(fn);
  return () => state.textSizeListeners.delete(fn);
}

export function getZoom() { return state.zoom; }
export function setZoom(z) {
  const v = Number(z);
  if (!Number.isFinite(v)) return;
  const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, v));
  const rounded = Math.round(clamped * 1000) / 1000;
  if (state.zoom === rounded) return;
  state.zoom = rounded;
  for (const fn of state.zoomListeners) fn(rounded);
}
export function onZoomChange(fn) {
  state.zoomListeners.add(fn);
  return () => state.zoomListeners.delete(fn);
}

export function getCurrentFont() { return state.currentFontPostScriptName; }
export function setCurrentFont(psName) {
  const v = psName || null;
  if (state.currentFontPostScriptName === v) return;
  state.currentFontPostScriptName = v;
  for (const fn of state.currentFontListeners) fn(v);
}
export function onCurrentFontChange(fn) {
  state.currentFontListeners.add(fn);
  return () => state.currentFontListeners.delete(fn);
}
