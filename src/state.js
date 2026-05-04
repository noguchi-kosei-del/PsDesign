import { getDefault, getDefaults } from "./settings.js";

// 単純な observable スロット (tool, textSize, leadingPct, currentFont, stroke/fill,
// zoom, rotation, pdfPageIndex, pdfSplitMode, pdfSkipFirstBlank, parallelSyncMode,
// activePane, parallelViewMode, framesVisible) は createObservable ファクトリで管理し、
// 下に並ぶ $tool / $textSize ... 経由で get/set/on を提供する。
// state object には:
//   - 配列 / Map / 複合状態（pages, edits, newLayers, selectedLayers, fonts, txtSource, ...）
//   - currentPageIndex（ pages.length に依存して clamp が必要、factory では表現しづらい）
//   - aiOcrDoc / editingContext / pdfDoc 系（複数フィールドが連動）
//   - history（push/restore セマンティクス）
// のみが残る。
const state = {
  folder: null,
  pages: [],
  edits: new Map(),
  newLayers: [],
  selectedLayers: [], // Array<{pageIndex, layerId}>
  fonts: [],
  nextTempId: 1,
  txtSource: null,
  txtSourceListeners: new Set(),
  txtSelection: "",
  txtSelectedBlockIndex: null,
  currentPageIndex: 0,
  pageIndexListeners: new Set(),
  pdfDoc: null,
  pdfPath: null,
  pdfPaths: [], // loadReferenceFiles で読み込まれた全ファイルパス（自然順ソート済み）
  pdfPageCount: 0,
  pdfListeners: new Set(),
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
  // AI 画像スキャン (run_ai_ocr) の最新結果。自動配置 (ai-place.js) で参照する。
  // { doc: MokuroDocument, sourcePath: string } | null
  aiOcrDoc: null,
  aiOcrDocListeners: new Set(),
};

const HISTORY_MAX = 100;

export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 8;

export function getState() { return state; }

// 単純な observable スロットの factory。
// - normalize(v): 入力を最終値に正規化する。undefined を返したら「reject」として set を no-op にする。
// - 変化時のみ listener を発火（同値再代入は黙ってスキップ）。
// - on は unsubscribe 関数を返す。
function createObservable(initial, normalize) {
  let value = initial;
  const listeners = new Set();
  return {
    get: () => value,
    set: (next) => {
      const norm = normalize ? normalize(next, value) : next;
      if (norm === undefined) return;
      if (value === norm) return;
      value = norm;
      for (const fn of listeners) fn(value);
    },
    on: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

// よく使うバリデータ群（factory 引数として渡す）。
const _normBool = (v) => !!v;
const _normFontPs = (v) => v || null;
const _norm90 = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return ((Math.round(n / 90) * 90) % 360 + 360) % 360;
};
const _normPageIndex = (v) => {
  if (!Number.isFinite(v)) return undefined;
  return Math.max(0, Math.round(v));
};
const _normSize = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  const r = Math.round(n * 10) / 10;
  return Math.max(6, Math.min(999, r));
};
const _normLeading = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(50, Math.min(500, Math.round(n)));
};
const _normStrokeWidth = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  const r = Math.round(n * 10) / 10;
  return Math.max(0, Math.min(999, r));
};
const _normTool = (v) =>
  v === "move" || v === "text-v" || v === "text-h" || v === "pan" ? v : undefined;
const _normStrokeColor = (v) => (v === "white" || v === "black" ? v : "none");
const _normFillColor = (v) => (v === "white" || v === "black" ? v : "default");
const _normActivePane = (v) => (v === "pdf" ? "pdf" : "psd");
// "psdOnly" モードは廃止。3 モード ("parallel" | "proofread" | "editor") のみ受け入れ、
// それ以外（旧 "psdOnly" 等）は "parallel" にフォールバックする。
const _normParallelViewMode = (v) =>
  v === "editor" ? "editor" : v === "proofread" ? "proofread" : "parallel";

// === Observable スロット定義 ===
// state object の同名フィールド + 同名 Listeners Set のペアを置き換える。
// 旧 state.tool / state.toolListeners 等の直接参照は本ファイル内でも撤去済み。
const $tool = createObservable("move", _normTool);
const $textSize = createObservable(12, _normSize);
const $leadingPct = createObservable(125, _normLeading);
const $currentFont = createObservable(null, _normFontPs);
const $strokeColor = createObservable("none", _normStrokeColor);
const $strokeWidthPx = createObservable(20, _normStrokeWidth);
const $fillColor = createObservable("default", _normFillColor);
const $pdfZoom = createObservable(1, (v) => clampZoom(v) ?? undefined);
const $psdZoom = createObservable(1, (v) => clampZoom(v) ?? undefined);
const $pdfRotation = createObservable(0, _norm90);
const $psdRotation = createObservable(0, _norm90);
const $pdfPageIndex = createObservable(0, _normPageIndex);
const $pdfSplitMode = createObservable(false, _normBool);
const $pdfSkipFirstBlank = createObservable(false, _normBool);
const $parallelSyncMode = createObservable(true, _normBool);
const $activePane = createObservable("psd", _normActivePane);
const $parallelViewMode = createObservable("parallel", _normParallelViewMode);
const $framesVisible = createObservable(true, _normBool);
// テキストエディタ用: 現在編集中の TXT の元ファイルパス（読込元 / 上書き先）。
// 「開く」「別名で保存」で更新。OCR 結果や browser D&D など path が無い経路は null。
const $txtFilePath = createObservable(null, (v) => (v == null ? null : String(v)));
// テキストエディタ用: 未保存変更フラグ。textarea 入力で true、保存 / 読込で false。
const $txtDirty = createObservable(false, _normBool);

function clampZoom(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, n));
  return Math.round(clamped * 1000) / 1000;
}

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
export const getFramesVisible = $framesVisible.get;
export const setFramesVisible = $framesVisible.set;
export const onFramesVisibleChange = $framesVisible.on;
export function toggleFramesVisible() { setFramesVisible(!getFramesVisible()); }

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

// 同期スコープの transient ラッパ。begin/commit/abort の 3 連を try/finally 不要で
// 安全に書ける。fn が false を返した場合は push せず（mutation なしの意）、
// 例外を投げた場合は depth だけ戻して再 throw。それ以外は depth を戻して push する。
// ドラッグのように begin と commit が別イベントに跨る用途では imperative API を直接使う。
export function withHistoryTransient(fn) {
  state.historyTransientDepth++;
  let result;
  try {
    result = fn();
  } catch (err) {
    if (state.historyTransientDepth > 0) state.historyTransientDepth--;
    throw err;
  }
  if (state.historyTransientDepth > 0) state.historyTransientDepth--;
  if (result !== false && state.historyTransientDepth === 0) {
    pushHistorySnapshot();
  }
  return result;
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

  // 連続記号のツメ（環境設定の global 値）。新規レイヤー（newLayers）にだけ JSX 側で適用する。
  // 既存レイヤー（layers / edits）は触らない方針。0 のとき機能 OFF。dash/tilde グループ別。
  const dashTrackingMille = Number(getDefault("dashTrackingMille")) || 0;
  const tildeTrackingMille = Number(getDefault("tildeTrackingMille")) || 0;

  return {
    dashTrackingMille,
    tildeTrackingMille,
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

export const getTool = $tool.get;
export const setTool = $tool.set;
export const onToolChange = $tool.on;

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
  sourceTxtRef,
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
    // 自動配置 (ai-place.js) で生成されたレイヤーは元 TXT 段落への参照を持つ。
    // { pageNumber, paragraphIndex } を保持し、後から TXT が編集されたときに
    // syncPlacedFromTxt が contents を追従させる。手動配置レイヤーは null。
    sourceTxtRef: sourceTxtRef ?? null,
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
  // 元ファイルパス / ダーティフラグも一緒にリセット（履歴対象外なので個別に呼ぶ）。
  $txtFilePath.set(null);
  $txtDirty.set(false);
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

export const getTextSize = $textSize.get;
export const setTextSize = $textSize.set;
export const onTextSizeChange = $textSize.on;

export const getLeadingPct = $leadingPct.get;
export const setLeadingPct = $leadingPct.set;
export const onLeadingPctChange = $leadingPct.on;

export const getPdfZoom = $pdfZoom.get;
export const setPdfZoom = $pdfZoom.set;
export const onPdfZoomChange = $pdfZoom.on;

export const getPsdZoom = $psdZoom.get;
export const setPsdZoom = $psdZoom.set;
export const onPsdZoomChange = $psdZoom.on;

export function getPdfDoc() { return state.pdfDoc; }
export function getPdfPath() { return state.pdfPath; }
export function getPdfPaths() { return [...state.pdfPaths]; }
export function getPdfPageCount() { return state.pdfPageCount; }
export function setPdf(doc, path, paths) {
  const prev = state.pdfDoc;
  if (prev && prev !== doc && typeof prev.destroy === "function") {
    try { prev.destroy(); } catch (_) {}
  }
  state.pdfDoc = doc || null;
  state.pdfPath = path || null;
  state.pdfPaths = Array.isArray(paths) ? [...paths] : (path ? [path] : []);
  state.pdfPageCount = doc && typeof doc.numPages === "number" ? doc.numPages : 0;
  // ユーザー回転は PDF 切替時も保持（同じワークフローの PDF は同じ向きの傾向があるため）。
  // リセットしたい場合はホームに戻るで clearPdf → clearPdfRotation を呼ぶ。
  // pdfPageIndex は新 PDF 読込時に 0 にリセット（旧 PDF の仮想ページ数とは無関係のため）。
  setPdfPageIndex(0);
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

export const getPdfRotation = $pdfRotation.get;
export const setPdfRotation = $pdfRotation.set;
export const onPdfRotationChange = $pdfRotation.on;

export const getPsdRotation = $psdRotation.get;
export const setPsdRotation = $psdRotation.set;
export const onPsdRotationChange = $psdRotation.on;

export const getPdfPageIndex = $pdfPageIndex.get;
export const setPdfPageIndex = $pdfPageIndex.set;
export const onPdfPageIndexChange = $pdfPageIndex.on;

export const getPdfSplitMode = $pdfSplitMode.get;
export const setPdfSplitMode = $pdfSplitMode.set;
export const onPdfSplitModeChange = $pdfSplitMode.on;

export const getPdfSkipFirstBlank = $pdfSkipFirstBlank.get;
export const setPdfSkipFirstBlank = $pdfSkipFirstBlank.set;
export const onPdfSkipFirstBlankChange = $pdfSkipFirstBlank.on;

export const getParallelSyncMode = $parallelSyncMode.get;
export const setParallelSyncMode = $parallelSyncMode.set;
export const onParallelSyncModeChange = $parallelSyncMode.on;

export const getActivePane = $activePane.get;
export const setActivePane = $activePane.set;
export const onActivePaneChange = $activePane.on;

export const getParallelViewMode = $parallelViewMode.get;
export const setParallelViewMode = $parallelViewMode.set;
export const onParallelViewModeChange = $parallelViewMode.on;

export const getCurrentFont = $currentFont.get;
export const setCurrentFont = $currentFont.set;
export const onCurrentFontChange = $currentFont.on;

// fontPickerStuck はリスナー不要のシンプルなブール状態（commitFont で true、goHome で false）。
// observable factory を使わず、モジュールスコープのプリミティブで保持する。
let _fontPickerStuck = false;
export function getFontPickerStuck() { return _fontPickerStuck; }
export function setFontPickerStuck(v) { _fontPickerStuck = !!v; }

export const getStrokeColor = $strokeColor.get;
export const setStrokeColor = $strokeColor.set;
export const onStrokeColorChange = $strokeColor.on;

export const getStrokeWidthPx = $strokeWidthPx.get;
export const setStrokeWidthPx = $strokeWidthPx.set;
export const onStrokeWidthChange = $strokeWidthPx.on;

export const getFillColor = $fillColor.get;
export const setFillColor = $fillColor.set;
export const onFillColorChange = $fillColor.on;

export const getTxtFilePath = $txtFilePath.get;
export const setTxtFilePath = $txtFilePath.set;
export const onTxtFilePathChange = $txtFilePath.on;

export const getTxtDirty = $txtDirty.get;
export const setTxtDirty = $txtDirty.set;
export const onTxtDirtyChange = $txtDirty.on;
