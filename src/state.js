import { getDefaults } from "./settings.js";

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
  txtSourceListeners: new Set(),
  txtSelection: "",
  txtSelectedBlockIndex: null,
  textSize: 12,
  textSizeListeners: new Set(),
  leadingPct: 125, // 行間（autoLeadingAmount %）。Photoshop の自動行送り 125% を既定。
  leadingPctListeners: new Set(),
  currentFontPostScriptName: null,
  currentFontListeners: new Set(),
  // edit-font 欄でユーザーが能動的にフォントを選んだ後、選択ツールでクリックした
  // テキストフレームへ自動適用する「ブラシ」モードのフラグ。
  // commitFont() で true、goHome() で false にリセット。
  fontPickerStuck: false,
  strokeColor: "none", // "none" | "white" | "black"
  strokeColorListeners: new Set(),
  strokeWidthPx: 20,
  strokeWidthListeners: new Set(),
  fillColor: "default", // "default" | "white" | "black"
  fillColorListeners: new Set(),
  currentPageIndex: 0,
  pageIndexListeners: new Set(),
  pdfZoom: 1,
  pdfZoomListeners: new Set(),
  psdZoom: 1,
  psdZoomListeners: new Set(),
  pdfDoc: null,
  pdfPath: null,
  pdfPageCount: 0,
  pdfListeners: new Set(),
  pdfRotation: 0, // ユーザーが追加適用する回転（0/90/180/270）
  pdfRotationListeners: new Set(),
  psdRotation: 0, // PSD 表示のビュー回転（0/90/180/270、表示専用）
  psdRotationListeners: new Set(),
  pdfPageIndex: 0, // PDF 側の virtual page index（単ページ化時は物理ページと 1:1 ではない）
  pdfPageIndexListeners: new Set(),
  pdfSplitMode: false, // 単ページ化（横長 PDF の左ページのみを表示）
  pdfSplitModeListeners: new Set(),
  pdfSkipFirstBlank: false, // 先頭白紙ページを除外（単ページ化時のみ意味を持つ）
  pdfSkipFirstBlankListeners: new Set(),
  parallelSyncMode: true, // PDF / PSD の同期モード
  parallelSyncModeListeners: new Set(),
  activePane: "psd", // "pdf" | "psd"（非同期時に矢印キー/ホイールが効くペイン）
  activePaneListeners: new Set(),
  parallelViewMode: "parallel", // "parallel" | "psdOnly"
  parallelViewModeListeners: new Set(),
  // 編集の undo / redo 履歴。スナップショット（edits + newLayers）配列。
  history: [],
  historyIndex: -1,
  historyTransientDepth: 0, // > 0 のとき push を抑制（ドラッグ中など）
  historyListeners: new Set(),
  // in-place 編集（テキストツールでレイヤークリック時の textarea）の現在対象。
  // null: 編集中でない。{psdPath, layerId|tempId, currentLineIndex, totalLines}: 編集中。
  // 行間コントロールはこれが set のとき per-line override に書き込み、unset のとき global に書く。
  editingContext: null,
  editingContextListeners: new Set(),
  // テキストフレーム（overlay 内のレイヤーボックス全体）表示フラグ。
  // false のとき renderOverlay は中身を出さない（プレビューに集中したいとき用、Ctrl+H）。
  framesVisible: true,
  framesVisibleListeners: new Set(),
  // AI 画像スキャン (run_ai_ocr) の最新結果。自動配置 (ai-place.js) で参照する。
  // { doc: MokuroDocument, sourcePath: string } | null
  aiOcrDoc: null,
  aiOcrDocListeners: new Set(),
};

const HISTORY_MAX = 100;

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
  setStrokeColor("none");
  setFillColor("default");
  // OCR キャッシュ (aiOcrDoc) は PDF に紐付いている。PSD 切替では消さない。
  // ai-place.js が sourcePath を current PDF と比較し、不一致なら自動で再スキャンする。
  // ツール初期値（フチ太さ・行間・文字サイズ・フォント）はユーザー設定の「デフォルト」を反映。
  applyToolDefaults();
  resetHistoryBaseline();
  // PDF は PSD 再読込から独立させる（ユーザー回転も保持）。ホームに戻る時のみ hamburger-menu 側で clearPdf を呼ぶ。
}

// ===== AI OCR ドキュメント (mokuro 結果) =====
// 画像スキャン (run_ai_ocr) の結果を保持し、自動配置機能から参照する。
export function setAiOcrDoc(doc, sourcePath) {
  state.aiOcrDoc = { doc, sourcePath: sourcePath || null };
  for (const fn of state.aiOcrDocListeners) fn(state.aiOcrDoc);
}
export function getAiOcrDoc() { return state.aiOcrDoc; }
export function clearAiOcrDoc() {
  if (state.aiOcrDoc === null) return;
  state.aiOcrDoc = null;
  for (const fn of state.aiOcrDocListeners) fn(null);
}
export function onAiOcrDocChange(fn) {
  state.aiOcrDocListeners.add(fn);
  return () => state.aiOcrDocListeners.delete(fn);
}

// 環境設定 → 「デフォルト」の値を新規テキストレイヤー用ツール状態に反映する。
// アプリ起動時 / clearPages 時 / 設定パネルでの値変更時に呼ぶ。
export function applyToolDefaults() {
  const d = getDefaults();
  if (Number.isFinite(d.textSize)) setTextSize(d.textSize);
  if (Number.isFinite(d.leadingPct)) setLeadingPct(d.leadingPct);
  if (Number.isFinite(d.strokeWidthPx)) setStrokeWidthPx(d.strokeWidthPx);
  setCurrentFont(typeof d.fontPostScriptName === "string" && d.fontPostScriptName.length > 0
    ? d.fontPostScriptName
    : null);
}

// ===== 行ごとの行間オーバーライド =====
// 既存レイヤーの edit / 新規レイヤーの nl に lineLeadings: {[lineIndex]: pct} を保持。
// 値を null にすると当該行のオーバーライドを除去（global にフォールバック）。
export function setLineLeading(psdPath, layerIdOrTempId, lineIndex, pctOrNull) {
  if (!Number.isInteger(lineIndex) || lineIndex < 0) return;
  if (typeof layerIdOrTempId === "string") {
    const idx = state.newLayers.findIndex((l) => l.tempId === layerIdOrTempId);
    if (idx < 0) return;
    const cur = { ...(state.newLayers[idx].lineLeadings ?? {}) };
    if (pctOrNull == null) delete cur[lineIndex]; else cur[lineIndex] = Math.round(pctOrNull);
    state.newLayers[idx] = { ...state.newLayers[idx], lineLeadings: cur };
    pushHistorySnapshot();
  } else {
    const existing = getEdit(psdPath, layerIdOrTempId) ?? {};
    const cur = { ...(existing.lineLeadings ?? {}) };
    if (pctOrNull == null) delete cur[lineIndex]; else cur[lineIndex] = Math.round(pctOrNull);
    setEdit(psdPath, layerIdOrTempId, { lineLeadings: cur });
  }
}

export function getLineLeading(psdPath, layerIdOrTempId, lineIndex) {
  if (typeof layerIdOrTempId === "string") {
    const nl = state.newLayers.find((l) => l.tempId === layerIdOrTempId);
    return nl?.lineLeadings?.[lineIndex];
  }
  const e = getEdit(psdPath, layerIdOrTempId);
  return e?.lineLeadings?.[lineIndex];
}

export function getEditingContext() { return state.editingContext; }
export function setEditingContext(ctx) {
  state.editingContext = ctx ?? null;
  for (const fn of state.editingContextListeners) fn(state.editingContext);
}
export function onEditingContextChange(fn) {
  state.editingContextListeners.add(fn);
  return () => state.editingContextListeners.delete(fn);
}

// テキストフレーム（layer-box overlay）表示。Ctrl+H から切り替え。
export function getFramesVisible() { return state.framesVisible; }
export function setFramesVisible(v) {
  const next = !!v;
  if (state.framesVisible === next) return;
  state.framesVisible = next;
  for (const fn of state.framesVisibleListeners) fn(next);
}
export function toggleFramesVisible() { setFramesVisible(!state.framesVisible); }
export function onFramesVisibleChange(fn) {
  state.framesVisibleListeners.add(fn);
  return () => state.framesVisibleListeners.delete(fn);
}

// ===== Undo / Redo 履歴 =====
function snapshotState() {
  return {
    edits: Array.from(state.edits.entries()).map(([k, v]) => [k, { ...v }]),
    newLayers: state.newLayers.map((l) => ({ ...l })),
    nextTempId: state.nextTempId,
    // txt-source（原稿テキスト）の内容も undo/redo で復元する。dblclick 経由の
    // in-place 編集が原稿側を書き換えるケースで、レイヤー編集と原稿変更を 1 ステップで巻き戻す。
    txtSource: state.txtSource ? { ...state.txtSource } : null,
  };
}

function txtSourceEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.name === b.name && a.content === b.content;
}

function restoreSnapshot(snap) {
  state.edits = new Map(snap.edits.map(([k, v]) => [k, { ...v }]));
  state.newLayers = snap.newLayers.map((l) => ({ ...l }));
  state.nextTempId = snap.nextTempId;
  // 復元で消えた新規レイヤーへの選択参照は破棄（参照不整合防止）。
  state.selectedLayers = state.selectedLayers.filter((s) => {
    if (typeof s.layerId === "string") {
      return state.newLayers.some((nl) => nl.tempId === s.layerId);
    }
    return true;
  });
  // txtSource を復元。古いスナップショット（フィールド未保存）は素通し。
  if (Object.prototype.hasOwnProperty.call(snap, "txtSource")) {
    const restored = snap.txtSource ? { ...snap.txtSource } : null;
    if (!txtSourceEqual(state.txtSource, restored)) {
      state.txtSource = restored;
      // 復元先と現在で内容が変わるため、選択は無効になり得る。安全側に倒してクリア。
      state.txtSelection = "";
      state.txtSelectedBlockIndex = null;
      for (const fn of state.txtSourceListeners) fn(state.txtSource);
    }
  }
  for (const fn of state.historyListeners) fn();
}

function pushHistorySnapshot() {
  if (state.historyTransientDepth > 0) return;
  // redo 分岐は破棄してから現在状態を新たな最終地点として積む。
  state.history = state.history.slice(0, state.historyIndex + 1);
  state.history.push(snapshotState());
  if (state.history.length > HISTORY_MAX) state.history.shift();
  state.historyIndex = state.history.length - 1;
  for (const fn of state.historyListeners) fn();
}

function resetHistoryBaseline() {
  state.history = [snapshotState()];
  state.historyIndex = 0;
  state.historyTransientDepth = 0;
  for (const fn of state.historyListeners) fn();
}

export function undo() {
  if (!canUndo()) return false;
  state.historyIndex--;
  restoreSnapshot(state.history[state.historyIndex]);
  return true;
}

export function redo() {
  if (!canRedo()) return false;
  state.historyIndex++;
  restoreSnapshot(state.history[state.historyIndex]);
  return true;
}

export function canUndo() { return state.historyIndex > 0; }
export function canRedo() { return state.historyIndex < state.history.length - 1; }

// 全削除：edits と newLayers をすべて消し、選択も解除する。空打ちのときは false を返す。
export function clearAllEdits() {
  if (state.edits.size === 0 && state.newLayers.length === 0) return false;
  state.edits.clear();
  state.newLayers = [];
  state.selectedLayers = [];
  pushHistorySnapshot();
  return true;
}

// ドラッグ中は内部の連続更新を 1 件にまとめる。begin/commit のペアで使う。
// nest 可能（depth カウンタ）。abort はドラッグ中断時に push せず depth だけ戻す。
export function beginHistoryTransient() { state.historyTransientDepth++; }
export function commitHistoryTransient() {
  if (state.historyTransientDepth > 0) state.historyTransientDepth--;
  if (state.historyTransientDepth === 0) pushHistorySnapshot();
}
export function abortHistoryTransient() {
  if (state.historyTransientDepth > 0) state.historyTransientDepth--;
}

export function onHistoryChange(fn) {
  state.historyListeners.add(fn);
  return () => state.historyListeners.delete(fn);
}

export function addPage(page) { state.pages.push(page); }
export function getPages() { return state.pages; }

// 基準PSD（最初に読み込まれた PSD ページ）。1 つも読み込まれていない場合は null。
export function getReferencePage() {
  return state.pages[0] ?? null;
}

// 実 pt を「基準PSD 換算 pt」へ変換する。基準と一致 / 未読込 / 不正値の場合は素通し。
// 換算は物理高さ (height/dpi) の比に基づく：DPI 違い・キャンバス寸法違いの両方を吸収する。
export function toDisplaySizePt(actualPt, page) {
  if (!Number.isFinite(actualPt)) return actualPt;
  const ref = getReferencePage();
  if (!ref || !page || ref === page) return actualPt;
  const refDpi = ref.dpi ?? 72;
  const pageDpi = page.dpi ?? 72;
  const refH = (ref.height ?? 0) / refDpi;
  const pageH = (page.height ?? 0) / pageDpi;
  if (!(refH > 0) || !(pageH > 0)) return actualPt;
  return actualPt * (refH / pageH);
}

function editKey(psdPath, layerId) { return `${psdPath}::${layerId}`; }

export function setEdit(psdPath, layerId, changes) {
  const key = editKey(psdPath, layerId);
  const existing = state.edits.get(key) ?? { psdPath, layerId };
  state.edits.set(key, { ...existing, ...changes });
  pushHistorySnapshot();
}

export function getEdit(psdPath, layerId) {
  return state.edits.get(editKey(psdPath, layerId));
}

export function addEditOffset(psdPath, layerId, ddx, ddy) {
  // NaN/Infinity が混入すると保存時に JSX へ "dx: NaN" リテラルが出力され、
  // Photoshop 側で UnitValue 例外 → 当該 PSD 以降のループ全停止につながる。
  // ここで finite な値だけを受け付けて伝播を防ぐ。
  if (!Number.isFinite(ddx) || !Number.isFinite(ddy)) return;
  const current = getEdit(psdPath, layerId) ?? {};
  setEdit(psdPath, layerId, {
    dx: (current.dx ?? 0) + ddx,
    dy: (current.dy ?? 0) + ddy,
  });
}

export function hasEdits() { return state.edits.size > 0 || state.newLayers.length > 0; }

// 数値フィールドから NaN/Infinity を取り除く。これらが JSX に渡ると
// "dx: NaN" のようなリテラルが出力されて Photoshop が UnitValue 例外を
// 投げ、当該 PSD 以降の保存ループが全停止する。防御深化のためここで
// サニタイズしておく（一次防御は addEditOffset / setTextSize 等の入口）。
function sanitizeNumericFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "number" && !Number.isFinite(v)) continue;
    out[k] = v;
  }
  return out;
}

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
    ensure(psdPath).layers.push({ layerId, ...sanitizeNumericFields(rest) });
  }

  for (const nl of state.newLayers) {
    const { psdPath, tempId: _tempId, ...rest } = nl;
    // 新規レイヤーの x/y は配置必須のため、いずれかが NaN/Infinity なら
    // そのレイヤー自体を payload から落とす（不正配置で JSX を壊さない）。
    if (!Number.isFinite(nl.x) || !Number.isFinite(nl.y)) continue;
    ensure(psdPath).newLayers.push(sanitizeNumericFields(rest));
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
  if (tool !== "move" && tool !== "text-v" && tool !== "text-h" && tool !== "pan") return;
  if (state.tool === tool) return;
  state.tool = tool;
  for (const fn of state.toolListeners) fn(tool);
}
export function onToolChange(fn) {
  state.toolListeners.add(fn);
  return () => state.toolListeners.delete(fn);
}

export function addNewLayer({
  psdPath,
  x,
  y,
  contents,
  fontPostScriptName,
  sizePt,
  direction,
  strokeColor,
  strokeWidthPx,
  fillColor,
  rotation,
  leadingPct,
}) {
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
    strokeColor: strokeColor ?? "none",
    strokeWidthPx: Number.isFinite(strokeWidthPx) ? strokeWidthPx : 20,
    fillColor: fillColor === "white" || fillColor === "black" ? fillColor : "default",
    rotation: Number.isFinite(rotation) ? rotation : 0,
    leadingPct: Number.isFinite(leadingPct) ? leadingPct : 125,
    // 行ごとの行間オーバーライド。キーは 0-based の行番号、値は %。
    // 未指定の行は層の leadingPct（autoLeading）を使う。
    lineLeadings: {},
  };
  state.newLayers.push(layer);
  pushHistorySnapshot();
  return layer;
}

export function updateNewLayer(tempId, changes) {
  const idx = state.newLayers.findIndex((l) => l.tempId === tempId);
  if (idx < 0) return;
  state.newLayers[idx] = { ...state.newLayers[idx], ...changes };
  pushHistorySnapshot();
}

export function removeNewLayer(tempId) {
  const before = state.newLayers.length;
  state.newLayers = state.newLayers.filter((l) => l.tempId !== tempId);
  if (state.newLayers.length !== before) pushHistorySnapshot();
}

export function getNewLayers() { return state.newLayers; }

export function getNewLayersForPsd(psdPath) {
  return state.newLayers.filter((l) => l.psdPath === psdPath);
}

export function setTxtSource(source) {
  const next = source ? { name: source.name, content: source.content } : null;
  const same = txtSourceEqual(state.txtSource, next);
  state.txtSource = next;
  state.txtSelection = "";
  state.txtSelectedBlockIndex = null;
  if (!same) {
    for (const fn of state.txtSourceListeners) fn(state.txtSource);
    pushHistorySnapshot();
  }
}
export function getTxtSource() { return state.txtSource; }
export function clearTxtSource() {
  const wasNonNull = state.txtSource !== null;
  state.txtSource = null;
  state.txtSelection = "";
  state.txtSelectedBlockIndex = null;
  if (wasNonNull) {
    for (const fn of state.txtSourceListeners) fn(null);
    pushHistorySnapshot();
  }
}
export function onTxtSourceChange(fn) {
  state.txtSourceListeners.add(fn);
  return () => state.txtSourceListeners.delete(fn);
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
  const clamped = Math.max(6, Math.min(999, rounded));
  if (state.textSize === clamped) return;
  state.textSize = clamped;
  for (const fn of state.textSizeListeners) fn(clamped);
}
export function onTextSizeChange(fn) {
  state.textSizeListeners.add(fn);
  return () => state.textSizeListeners.delete(fn);
}

export function getLeadingPct() { return state.leadingPct; }
export function setLeadingPct(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return;
  const rounded = Math.round(v);
  const clamped = Math.max(50, Math.min(500, rounded));
  if (state.leadingPct === clamped) return;
  state.leadingPct = clamped;
  for (const fn of state.leadingPctListeners) fn(clamped);
}
export function onLeadingPctChange(fn) {
  state.leadingPctListeners.add(fn);
  return () => state.leadingPctListeners.delete(fn);
}

function clampZoom(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, n));
  return Math.round(clamped * 1000) / 1000;
}

export function getPdfZoom() { return state.pdfZoom; }
export function setPdfZoom(z) {
  const rounded = clampZoom(z);
  if (rounded == null) return;
  if (state.pdfZoom === rounded) return;
  state.pdfZoom = rounded;
  for (const fn of state.pdfZoomListeners) fn(rounded);
}
export function onPdfZoomChange(fn) {
  state.pdfZoomListeners.add(fn);
  return () => state.pdfZoomListeners.delete(fn);
}

export function getPsdZoom() { return state.psdZoom; }
export function setPsdZoom(z) {
  const rounded = clampZoom(z);
  if (rounded == null) return;
  if (state.psdZoom === rounded) return;
  state.psdZoom = rounded;
  for (const fn of state.psdZoomListeners) fn(rounded);
}
export function onPsdZoomChange(fn) {
  state.psdZoomListeners.add(fn);
  return () => state.psdZoomListeners.delete(fn);
}

export function getPdfDoc() { return state.pdfDoc; }
export function getPdfPath() { return state.pdfPath; }
export function getPdfPageCount() { return state.pdfPageCount; }
export function setPdf(doc, path) {
  const prev = state.pdfDoc;
  if (prev && prev !== doc && typeof prev.destroy === "function") {
    try { prev.destroy(); } catch (_) {}
  }
  state.pdfDoc = doc || null;
  state.pdfPath = path || null;
  state.pdfPageCount = doc && typeof doc.numPages === "number" ? doc.numPages : 0;
  // ユーザー回転は PDF 切替時も保持（同じワークフローの PDF は同じ向きの傾向があるため）。
  // リセットしたい場合はホームに戻るで clearPdf → clearPdfRotation を呼ぶ。
  // pdfPageIndex は新 PDF 読込時に 0 にリセット（旧 PDF の仮想ページ数とは無関係のため）。
  if (state.pdfPageIndex !== 0) {
    state.pdfPageIndex = 0;
    for (const fn of state.pdfPageIndexListeners) fn(0);
  }
  for (const fn of state.pdfListeners) fn(state.pdfDoc);
}
export function clearPdf() {
  if (!state.pdfDoc && !state.pdfPath) return;
  setPdf(null, null);
}
export function onPdfChange(fn) {
  state.pdfListeners.add(fn);
  return () => state.pdfListeners.delete(fn);
}

export function getPdfRotation() { return state.pdfRotation; }
export function setPdfRotation(deg) {
  const n = Number(deg);
  if (!Number.isFinite(n)) return;
  const normalized = ((Math.round(n / 90) * 90) % 360 + 360) % 360;
  if (state.pdfRotation === normalized) return;
  state.pdfRotation = normalized;
  for (const fn of state.pdfRotationListeners) fn(normalized);
}
export function onPdfRotationChange(fn) {
  state.pdfRotationListeners.add(fn);
  return () => state.pdfRotationListeners.delete(fn);
}

export function getPsdRotation() { return state.psdRotation; }
export function setPsdRotation(deg) {
  const n = Number(deg);
  if (!Number.isFinite(n)) return;
  const normalized = ((Math.round(n / 90) * 90) % 360 + 360) % 360;
  if (state.psdRotation === normalized) return;
  state.psdRotation = normalized;
  for (const fn of state.psdRotationListeners) fn(normalized);
}
export function onPsdRotationChange(fn) {
  state.psdRotationListeners.add(fn);
  return () => state.psdRotationListeners.delete(fn);
}

export function getPdfPageIndex() { return state.pdfPageIndex; }
export function setPdfPageIndex(i) {
  if (!Number.isFinite(i)) return;
  const clamped = Math.max(0, Math.round(i));
  if (state.pdfPageIndex === clamped) return;
  state.pdfPageIndex = clamped;
  for (const fn of state.pdfPageIndexListeners) fn(clamped);
}
export function onPdfPageIndexChange(fn) {
  state.pdfPageIndexListeners.add(fn);
  return () => state.pdfPageIndexListeners.delete(fn);
}

export function getPdfSplitMode() { return state.pdfSplitMode; }
export function setPdfSplitMode(on) {
  const v = !!on;
  if (state.pdfSplitMode === v) return;
  state.pdfSplitMode = v;
  for (const fn of state.pdfSplitModeListeners) fn(v);
}
export function onPdfSplitModeChange(fn) {
  state.pdfSplitModeListeners.add(fn);
  return () => state.pdfSplitModeListeners.delete(fn);
}

export function getPdfSkipFirstBlank() { return state.pdfSkipFirstBlank; }
export function setPdfSkipFirstBlank(on) {
  const v = !!on;
  if (state.pdfSkipFirstBlank === v) return;
  state.pdfSkipFirstBlank = v;
  for (const fn of state.pdfSkipFirstBlankListeners) fn(v);
}
export function onPdfSkipFirstBlankChange(fn) {
  state.pdfSkipFirstBlankListeners.add(fn);
  return () => state.pdfSkipFirstBlankListeners.delete(fn);
}

export function getParallelSyncMode() { return state.parallelSyncMode; }
export function setParallelSyncMode(on) {
  const v = !!on;
  if (state.parallelSyncMode === v) return;
  state.parallelSyncMode = v;
  for (const fn of state.parallelSyncModeListeners) fn(v);
}
export function onParallelSyncModeChange(fn) {
  state.parallelSyncModeListeners.add(fn);
  return () => state.parallelSyncModeListeners.delete(fn);
}

export function getActivePane() { return state.activePane; }
export function setActivePane(pane) {
  const v = pane === "pdf" ? "pdf" : "psd";
  if (state.activePane === v) return;
  state.activePane = v;
  for (const fn of state.activePaneListeners) fn(v);
}
export function onActivePaneChange(fn) {
  state.activePaneListeners.add(fn);
  return () => state.activePaneListeners.delete(fn);
}

export function getParallelViewMode() { return state.parallelViewMode; }
export function setParallelViewMode(mode) {
  const v = mode === "psdOnly" ? "psdOnly" : "parallel";
  if (state.parallelViewMode === v) return;
  state.parallelViewMode = v;
  for (const fn of state.parallelViewModeListeners) fn(v);
}
export function onParallelViewModeChange(fn) {
  state.parallelViewModeListeners.add(fn);
  return () => state.parallelViewModeListeners.delete(fn);
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

export function getFontPickerStuck() { return state.fontPickerStuck; }
export function setFontPickerStuck(v) { state.fontPickerStuck = !!v; }

export function getStrokeColor() { return state.strokeColor; }
export function setStrokeColor(color) {
  const v = color === "white" || color === "black" ? color : "none";
  if (state.strokeColor === v) return;
  state.strokeColor = v;
  for (const fn of state.strokeColorListeners) fn(v);
}
export function onStrokeColorChange(fn) {
  state.strokeColorListeners.add(fn);
  return () => state.strokeColorListeners.delete(fn);
}

export function getStrokeWidthPx() { return state.strokeWidthPx; }
export function setStrokeWidthPx(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return;
  const rounded = Math.round(v * 10) / 10;
  const clamped = Math.max(0, Math.min(999, rounded));
  if (state.strokeWidthPx === clamped) return;
  state.strokeWidthPx = clamped;
  for (const fn of state.strokeWidthListeners) fn(clamped);
}
export function onStrokeWidthChange(fn) {
  state.strokeWidthListeners.add(fn);
  return () => state.strokeWidthListeners.delete(fn);
}

export function getFillColor() { return state.fillColor; }
export function setFillColor(color) {
  const v = color === "white" || color === "black" ? color : "default";
  if (state.fillColor === v) return;
  state.fillColor = v;
  for (const fn of state.fillColorListeners) fn(v);
}
export function onFillColorChange(fn) {
  state.fillColorListeners.add(fn);
  return () => state.fillColorListeners.delete(fn);
}
