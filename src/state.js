import { getDefault, getDefaults } from "./settings.js";

// 単純な observable スロット (tool, textSize, leadingPct, currentFont, stroke/fill,
// zoom, rotation, pdfPageIndex, pdfSplitMode, pdfSkipFirstBlank, parallelSyncMode,
// activePane, parallelViewMode) は createObservable ファクトリで管理し、
// 下に並ぶ $tool / $textSize ... 経由で get/set/on を提供する。
// state object には:
//   - 配列 / Map / 複合状態（pages, edits, newLayers, selectedLayers, fonts, txtSource, ...）
//   - currentPageIndex（ pages.length に依存して clamp が必要、factory では表現しづらい）
//   - scanExtractDoc / editingContext / pdfDoc 系（複数フィールドが連動）
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
  pdfExcludedReferencePages: new Set(),
  pdfSplitPageNumbers: new Set(),
  pdfSplitPageNumberListeners: new Set(),
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
  // { doc: ReferenceScanDocument, sourcePath: string } | null
  scanExtractDoc: null,
  scanExtractDocListeners: new Set(),
  scanExtractTextSource: null,
  scanExtractTextSourceListeners: new Set(),
  scanExtractTextDiffs: [],
  scanExtractTextDiffListeners: new Set(),
  // 【写植再利用】PSD ごとの再利用情報。
  //   psdPath -> { hideLayerIds: number[], referenceCanvas: HTMLCanvasElement }
  // hideLayerIds: 保存時に visible=false にする元テキストレイヤー id 群。
  // referenceCanvas: 元テキスト入りの合成画像 (見本 + プロジェクト保存時の JPG 化用)。
  reuseInfo: new Map(),
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
  const r = Math.round(n * 100) / 100;
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
  v === "move" || v === "pan" ? v : undefined;
// V ツールの「次に作る新規テキストの方向」。サイドツールバーの方向トグルで切替。
// localStorage 永続化は main.js の bindNewTextDirectionToggle が担当。
const _normNewTextDir = (v) =>
  v === "vertical" || v === "horizontal" ? v : undefined;
const _normStrokeColor = (v) => (v === "white" || v === "black" ? v : "none");
const _hexColorRe = /^#[0-9a-fA-F]{6}$/;
const _normFillColor = (v) => {
  if (v === "white" || v === "black" || v === "default") return v;
  if (typeof v === "string" && _hexColorRe.test(v)) {
    const hex = v.toLowerCase();
    if (hex === "#ffffff") return "white";
    if (hex === "#000000") return "black";
    return hex;
  }
  return "default";
};
const _normActivePane = (v) => (v === "pdf" ? "pdf" : "psd");
// "psdOnly" モードは廃止。4 モード ("parallel" | "proofread" | "editor" | "spreadEdit") のみ受け入れ、
// それ以外（旧 "psdOnly" 等）は "parallel" にフォールバックする。
const _normParallelViewMode = (v) =>
  v === "spreadEdit" ? "spreadEdit" : v === "editor" ? "editor" : v === "proofread" ? "proofread" : v === "fontBook" ? "fontBook" : v === "imageViewer" ? "imageViewer" : "parallel";
// editor モード時の左側ペイン表示。"proofread" = 校正パネル / "pdf" = 見本画像（spreads-pdf-area）。
// 校正パネルのヘッダー左端のセグメントトグルで切替、editor モード以外では参照されない。
const _normEditorLeftPaneMode = (v) => (v === "pdf" ? "pdf" : "proofread");

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
const $pdfFirstRightBlank = createObservable(false, _normBool);
const $parallelSyncMode = createObservable(true, _normBool);
const $activePane = createObservable("psd", _normActivePane);
const $parallelViewMode = createObservable("parallel", _normParallelViewMode);
const $editorLeftPaneMode = createObservable("proofread", _normEditorLeftPaneMode);
// 【写植再利用】アプリの動作モード。"normal" = 通常の写植 / "reuse" = 写植再利用。
// reuse のとき: PSD 編集ペインはテキスト除去版を表示、保存時に元テキストレイヤーを
// 非表示化、プロジェクト保存時に見本を JPG 化する。ホームに戻ると normal に戻す。
const $appMode = createObservable("normal", (v) => (v === "reuse" || v === "transcribe" ? v : "normal"));
// V ツールで空所をダブルクリックして新規テキスト入力を開くときの方向。
// サイドツールバーの V ボタン直下にあるトグルで切替・localStorage に永続化。
const $newTextDirection = createObservable("vertical", _normNewTextDir);
// テキストエディタ用: 現在編集中の TXT の元ファイルパス（読込元 / 上書き先）。
// 「開く」「別名で保存」で更新。画像スキャン 結果や browser D&D など path が無い経路は null。
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
  // 写植再利用情報も PSD と一緒にクリア。再利用フローはこの後 setReuseInfo で再登録する。
  state.reuseInfo.clear();
  const prev = state.currentPageIndex;
  state.currentPageIndex = 0;
  if (prev !== 0) {
    for (const fn of state.pageIndexListeners) fn(0);
  }
  setStrokeColor("none");
  setFillColor("default");
  // 画像スキャン キャッシュ (scanExtractDoc) は PDF に紐付いている。PSD 切替では消さない。
  // auto-place.js が sourcePath を current PDF と比較し、不一致なら自動で再スキャンする。
  // ツール初期値（フチ太さ・行間・文字サイズ・フォント）はユーザー設定の「デフォルト」を反映。
  applyToolDefaults();
  resetHistoryBaseline();
  // PDF は PSD 再読込から独立させる（ユーザー回転も保持）。ホームに戻る時のみ hamburger-menu 側で clearPdf を呼ぶ。
}

// ===== 画像スキャン 画像スキャン ドキュメント (referenceScan 結果) =====
export function setScanExtractDoc(doc, sourcePath) {
  state.scanExtractDoc = { doc, sourcePath: sourcePath || null };
  for (const fn of state.scanExtractDocListeners) fn(state.scanExtractDoc);
}
export function getScanExtractDoc() { return state.scanExtractDoc; }
export function clearScanExtractDoc() {
  if (state.scanExtractDoc === null) return;
  state.scanExtractDoc = null;
  for (const fn of state.scanExtractDocListeners) fn(null);
}
export function onScanExtractDocChange(fn) {
  state.scanExtractDocListeners.add(fn);
  return () => state.scanExtractDocListeners.delete(fn);
}

export function setScanExtractTextSource(source) {
  state.scanExtractTextSource = source && typeof source === "object" ? source : null;
  for (const fn of state.scanExtractTextSourceListeners) fn(state.scanExtractTextSource);
}
export function getScanExtractTextSource() { return state.scanExtractTextSource; }
export function onScanExtractTextSourceChange(fn) {
  state.scanExtractTextSourceListeners.add(fn);
  return () => state.scanExtractTextSourceListeners.delete(fn);
}

export function setScanExtractTextDiffs(diffs) {
  state.scanExtractTextDiffs = Array.isArray(diffs) ? diffs : [];
  for (const fn of state.scanExtractTextDiffListeners) fn(state.scanExtractTextDiffs);
}
export function getScanExtractTextDiffs() { return state.scanExtractTextDiffs; }
export function onScanExtractTextDiffsChange(fn) {
  state.scanExtractTextDiffListeners.add(fn);
  return () => state.scanExtractTextDiffListeners.delete(fn);
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

// ===== 文字ごとのサイズオーバーライド =====
// 【v1.16.0】フォントサイズ一部変更 — in-place 編集中に textarea で文字選択 → サイズ変更で
// 選択範囲の文字だけサイズが変わる。layer 全体の sizePt とは別管理。
// 既存レイヤーの edit / 新規レイヤーの nl に charSizes: {[charIndex]: sizePt} を保持。
// charIndex は contents 文字列の絶対 index（textarea selectionStart と同じ）。
// 値を null にすると当該文字のオーバーライドを除去（layer 全体の sizePt にフォールバック）。
export function setCharSize(psdPath, layerIdOrTempId, charIndex, sizePtOrNull) {
  if (!Number.isInteger(charIndex) || charIndex < 0) return;
  if (typeof layerIdOrTempId === "string") {
    const idx = state.newLayers.findIndex((l) => l.tempId === layerIdOrTempId);
    if (idx < 0) return;
    const cur = { ...(state.newLayers[idx].charSizes ?? {}) };
    if (sizePtOrNull == null) delete cur[charIndex]; else cur[charIndex] = Math.round(sizePtOrNull * 10) / 10;
    state.newLayers[idx] = { ...state.newLayers[idx], charSizes: cur };
    pushHistorySnapshot();
  } else {
    const existing = getEdit(psdPath, layerIdOrTempId) ?? {};
    const cur = { ...(existing.charSizes ?? {}) };
    if (sizePtOrNull == null) delete cur[charIndex]; else cur[charIndex] = Math.round(sizePtOrNull * 10) / 10;
    setEdit(psdPath, layerIdOrTempId, { charSizes: cur });
  }
}

// charIdx の範囲 [from, to) に sizePt を適用（textarea の selectionStart/End そのまま）。
// sizePtOrNull == null で範囲内のオーバーライドを除去。
export function setCharSizesRange(psdPath, layerIdOrTempId, from, to, sizePtOrNull) {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return;
  if (from >= to) return;
  if (typeof layerIdOrTempId === "string") {
    const idx = state.newLayers.findIndex((l) => l.tempId === layerIdOrTempId);
    if (idx < 0) return;
    const cur = { ...(state.newLayers[idx].charSizes ?? {}) };
    for (let i = from; i < to; i++) {
      if (sizePtOrNull == null) delete cur[i]; else cur[i] = Math.round(sizePtOrNull * 10) / 10;
    }
    state.newLayers[idx] = { ...state.newLayers[idx], charSizes: cur };
    pushHistorySnapshot();
  } else {
    const existing = getEdit(psdPath, layerIdOrTempId) ?? {};
    const cur = { ...(existing.charSizes ?? {}) };
    for (let i = from; i < to; i++) {
      if (sizePtOrNull == null) delete cur[i]; else cur[i] = Math.round(sizePtOrNull * 10) / 10;
    }
    setEdit(psdPath, layerIdOrTempId, { charSizes: cur });
  }
}

export function getCharSize(psdPath, layerIdOrTempId, charIndex) {
  if (typeof layerIdOrTempId === "string") {
    const nl = state.newLayers.find((l) => l.tempId === layerIdOrTempId);
    return nl?.charSizes?.[charIndex];
  }
  const e = getEdit(psdPath, layerIdOrTempId);
  return e?.charSizes?.[charIndex];
}

// ===== 文字ごとのフォントオーバーライド =====
// 【v1.16.0】フォント種類一部変更 — in-place 編集中に textarea で文字選択 → フォント変更で
// 選択範囲の文字だけフォントが変わる。layer 全体の fontPostScriptName とは別管理。
// 既存レイヤーの edit / 新規レイヤーの nl に charFonts: {[charIndex]: postScriptName} を保持。
// charIndex は contents 文字列の絶対 index（textarea selectionStart と同じ）。
// 値を null にすると当該文字のオーバーライドを除去（layer 全体の fontPostScriptName にフォールバック）。
function normalizeTextScalePercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(10, Math.min(400, Math.round(n)));
}

function normalizeTextSpacingMille(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(-1000, Math.min(1000, Math.round(n)));
}

function setCharScaleRange(field, psdPath, layerIdOrTempId, from, to, percentOrNull) {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return;
  if (from >= to) return;
  const normalized = percentOrNull == null ? null : normalizeTextScalePercent(percentOrNull);
  if (percentOrNull != null && normalized == null) return;
  if (typeof layerIdOrTempId === "string") {
    const idx = state.newLayers.findIndex((l) => l.tempId === layerIdOrTempId);
    if (idx < 0) return;
    const cur = { ...(state.newLayers[idx][field] ?? {}) };
    for (let i = from; i < to; i++) {
      if (normalized == null || normalized === 100) delete cur[i]; else cur[i] = normalized;
    }
    state.newLayers[idx] = { ...state.newLayers[idx], [field]: cur };
    pushHistorySnapshot();
  } else {
    const existing = getEdit(psdPath, layerIdOrTempId) ?? {};
    const cur = { ...(existing[field] ?? {}) };
    for (let i = from; i < to; i++) {
      if (normalized == null || normalized === 100) delete cur[i]; else cur[i] = normalized;
    }
    setEdit(psdPath, layerIdOrTempId, { [field]: cur });
  }
}

export function setCharHorizontalScalesRange(psdPath, layerIdOrTempId, from, to, percentOrNull) {
  setCharScaleRange("charHorizontalScales", psdPath, layerIdOrTempId, from, to, percentOrNull);
}

export function setCharVerticalScalesRange(psdPath, layerIdOrTempId, from, to, percentOrNull) {
  setCharScaleRange("charVerticalScales", psdPath, layerIdOrTempId, from, to, percentOrNull);
}

function setCharSpacingRange(field, psdPath, layerIdOrTempId, from, to, valueOrNull) {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return;
  if (from >= to) return;
  const normalized = valueOrNull == null ? null : normalizeTextSpacingMille(valueOrNull);
  if (valueOrNull != null && normalized == null) return;
  if (typeof layerIdOrTempId === "string") {
    const idx = state.newLayers.findIndex((l) => l.tempId === layerIdOrTempId);
    if (idx < 0) return;
    const cur = { ...(state.newLayers[idx][field] ?? {}) };
    for (let i = from; i < to; i++) {
      if (normalized == null || normalized === 0) delete cur[i]; else cur[i] = normalized;
    }
    state.newLayers[idx] = { ...state.newLayers[idx], [field]: cur };
    pushHistorySnapshot();
  } else {
    const existing = getEdit(psdPath, layerIdOrTempId) ?? {};
    const cur = { ...(existing[field] ?? {}) };
    for (let i = from; i < to; i++) {
      if (normalized == null || normalized === 0) delete cur[i]; else cur[i] = normalized;
    }
    setEdit(psdPath, layerIdOrTempId, { [field]: cur });
  }
}

export function setCharTrackingsRange(psdPath, layerIdOrTempId, from, to, valueOrNull) {
  setCharSpacingRange("charTrackings", psdPath, layerIdOrTempId, from, to, valueOrNull);
}

export function setCharKerningsRange(psdPath, layerIdOrTempId, from, to, valueOrNull) {
  setCharSpacingRange("charKernings", psdPath, layerIdOrTempId, from, to, valueOrNull);
}

export function setCharTateChuYokosRange(psdPath, layerIdOrTempId, from, to, enabledOrNull) {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return;
  if (from >= to) return;
  const enabled = enabledOrNull === true ? true : enabledOrNull === false ? false : null;
  if (typeof layerIdOrTempId === "string") {
    const idx = state.newLayers.findIndex((l) => l.tempId === layerIdOrTempId);
    if (idx < 0) return;
    const cur = { ...(state.newLayers[idx].charTateChuYokos ?? {}) };
    for (let i = from; i < to; i++) {
      if (enabled === true) cur[i] = true;
      else delete cur[i];
    }
    state.newLayers[idx] = { ...state.newLayers[idx], charTateChuYokos: cur };
    pushHistorySnapshot();
  } else {
    const existing = getEdit(psdPath, layerIdOrTempId) ?? {};
    const cur = { ...(existing.charTateChuYokos ?? {}) };
    for (let i = from; i < to; i++) {
      if (enabled === true) cur[i] = true;
      else delete cur[i];
    }
    setEdit(psdPath, layerIdOrTempId, { charTateChuYokos: cur });
  }
}

export function getCharHorizontalScale(psdPath, layerIdOrTempId, charIndex) {
  if (typeof layerIdOrTempId === "string") {
    const nl = state.newLayers.find((l) => l.tempId === layerIdOrTempId);
    return nl?.charHorizontalScales?.[charIndex];
  }
  const e = getEdit(psdPath, layerIdOrTempId);
  if (e?.charHorizontalScales?.[charIndex]) return e.charHorizontalScales[charIndex];
  const page = state.pages.find((p) => p.path === psdPath);
  const layer = page?.textLayers?.find((l) => l.id === layerIdOrTempId);
  return layer?.charHorizontalScales?.[charIndex];
}

export function getCharVerticalScale(psdPath, layerIdOrTempId, charIndex) {
  if (typeof layerIdOrTempId === "string") {
    const nl = state.newLayers.find((l) => l.tempId === layerIdOrTempId);
    return nl?.charVerticalScales?.[charIndex];
  }
  const e = getEdit(psdPath, layerIdOrTempId);
  if (e?.charVerticalScales?.[charIndex]) return e.charVerticalScales[charIndex];
  const page = state.pages.find((p) => p.path === psdPath);
  const layer = page?.textLayers?.find((l) => l.id === layerIdOrTempId);
  return layer?.charVerticalScales?.[charIndex];
}

export function setCharFontsRange(psdPath, layerIdOrTempId, from, to, postScriptNameOrNull) {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return;
  if (from >= to) return;
  if (typeof layerIdOrTempId === "string") {
    const idx = state.newLayers.findIndex((l) => l.tempId === layerIdOrTempId);
    if (idx < 0) return;
    const cur = { ...(state.newLayers[idx].charFonts ?? {}) };
    for (let i = from; i < to; i++) {
      if (postScriptNameOrNull == null) delete cur[i]; else cur[i] = postScriptNameOrNull;
    }
    state.newLayers[idx] = { ...state.newLayers[idx], charFonts: cur };
    pushHistorySnapshot();
  } else {
    const existing = getEdit(psdPath, layerIdOrTempId) ?? {};
    const page = state.pages.find((p) => p.path === psdPath);
    const layer = page?.textLayers?.find((l) => l.id === layerIdOrTempId);
    const cur = { ...(existing.charFonts ?? layer?.charFonts ?? {}) };
    for (let i = from; i < to; i++) {
      if (postScriptNameOrNull == null) delete cur[i]; else cur[i] = postScriptNameOrNull;
    }
    setEdit(psdPath, layerIdOrTempId, { charFonts: cur });
  }
}

export function getCharFont(psdPath, layerIdOrTempId, charIndex) {
  if (typeof layerIdOrTempId === "string") {
    const nl = state.newLayers.find((l) => l.tempId === layerIdOrTempId);
    return nl?.charFonts?.[charIndex];
  }
  const e = getEdit(psdPath, layerIdOrTempId);
  if (e?.charFonts?.[charIndex]) return e.charFonts[charIndex];
  const page = state.pages.find((p) => p.path === psdPath);
  const layer = page?.textLayers?.find((l) => l.id === layerIdOrTempId);
  return layer?.charFonts?.[charIndex];
}

// ===== 文字ごとの合成太字（faux bold / syntheticBold）オーバーライド =====
// 【v1.22.0】Photoshop の Character パネル「B」ボタン相当。in-place 編集中に textarea で
// 文字選択 → 太字トグルで選択範囲の文字だけ syntheticBold が切替わる。layer 全体の
// syntheticBold とは別管理（per-char 値があれば layer 値より優先）。値スキーマは
// charSizes / charFonts と同じ {[charIndex]: boolean}。null で当該文字のオーバーライド除去。
export function setCharBoldsRange(psdPath, layerIdOrTempId, from, to, valueOrNull) {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return;
  if (from >= to) return;
  if (typeof layerIdOrTempId === "string") {
    const idx = state.newLayers.findIndex((l) => l.tempId === layerIdOrTempId);
    if (idx < 0) return;
    const cur = { ...(state.newLayers[idx].charBolds ?? {}) };
    for (let i = from; i < to; i++) {
      if (valueOrNull == null) delete cur[i]; else cur[i] = !!valueOrNull;
    }
    state.newLayers[idx] = { ...state.newLayers[idx], charBolds: cur };
    pushHistorySnapshot();
  } else {
    const existing = getEdit(psdPath, layerIdOrTempId) ?? {};
    const cur = { ...(existing.charBolds ?? {}) };
    for (let i = from; i < to; i++) {
      if (valueOrNull == null) delete cur[i]; else cur[i] = !!valueOrNull;
    }
    setEdit(psdPath, layerIdOrTempId, { charBolds: cur });
  }
}

export function getCharBold(psdPath, layerIdOrTempId, charIndex) {
  if (typeof layerIdOrTempId === "string") {
    const nl = state.newLayers.find((l) => l.tempId === layerIdOrTempId);
    return nl?.charBolds?.[charIndex];
  }
  const e = getEdit(psdPath, layerIdOrTempId);
  return e?.charBolds?.[charIndex];
}

export function setCharItalicsRange(psdPath, layerIdOrTempId, from, to, valueOrNull) {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return;
  if (from >= to) return;
  if (typeof layerIdOrTempId === "string") {
    const idx = state.newLayers.findIndex((l) => l.tempId === layerIdOrTempId);
    if (idx < 0) return;
    const cur = { ...(state.newLayers[idx].charItalics ?? {}) };
    for (let i = from; i < to; i++) {
      if (valueOrNull == null) delete cur[i]; else cur[i] = !!valueOrNull;
    }
    state.newLayers[idx] = { ...state.newLayers[idx], charItalics: cur };
    pushHistorySnapshot();
  } else {
    const existing = getEdit(psdPath, layerIdOrTempId) ?? {};
    const cur = { ...(existing.charItalics ?? {}) };
    for (let i = from; i < to; i++) {
      if (valueOrNull == null) delete cur[i]; else cur[i] = !!valueOrNull;
    }
    setEdit(psdPath, layerIdOrTempId, { charItalics: cur });
  }
}

export function getCharItalic(psdPath, layerIdOrTempId, charIndex) {
  if (typeof layerIdOrTempId === "string") {
    const nl = state.newLayers.find((l) => l.tempId === layerIdOrTempId);
    return nl?.charItalics?.[charIndex];
  }
  const e = getEdit(psdPath, layerIdOrTempId);
  return e?.charItalics?.[charIndex];
}

// ===== 【v1.26.0】文字ごとのルビ（per-char ruby）=====
// スキーマ: { "<startIndex>": {end, text, type:"mono"|"group", scale:50} }。
// start index をキー、range 全体を 1 件で保持する（他の per-char API とは異なる形式）。
// setCharRubiesRange: from..to に被る既存エントリを drop し、text が空文字なら何も書き込まない
// （削除のみ）、text が非空なら {[from]: {end:to, text, type, scale}} を追加。
function normalizeCharRubiesMap(map) {
  if (!map || typeof map !== "object") return {};
  const out = {};
  for (const k of Object.keys(map)) {
    const start = Number(k);
    const entry = map[k];
    if (!Number.isFinite(start) || !entry || typeof entry !== "object") continue;
    if (typeof entry.text !== "string" || entry.text.length === 0) continue;
    const end = Number(entry.end);
    if (!Number.isFinite(end) || end <= start) continue;
    const normalized = {
      end,
      text: entry.text,
      type: entry.type === "mono" ? "mono" : "group",
      scale: Number.isFinite(Number(entry.scale)) ? Number(entry.scale) : 50,
    };
    if (Array.isArray(entry.overlays)) {
      const overlays = entry.overlays
        .map((overlay) => {
          if (!overlay || typeof overlay !== "object") return null;
          const overlayStart = Number(overlay.start);
          const overlayEnd = Number(overlay.end);
          const overlayText = typeof overlay.text === "string" ? overlay.text : "";
          if (!Number.isFinite(overlayStart) || !Number.isFinite(overlayEnd) || overlayEnd <= overlayStart || !overlayText) return null;
          return {
            start: overlayStart,
            end: overlayEnd,
            text: overlayText,
            type: overlay.type === "mono" ? "mono" : "group",
            scale: Number.isFinite(Number(overlay.scale)) ? Number(overlay.scale) : 50,
            ...(Number.isFinite(Number(overlay.offsetX)) ? { offsetX: Number(overlay.offsetX) } : {}),
            ...(Number.isFinite(Number(overlay.offsetY)) ? { offsetY: Number(overlay.offsetY) } : {}),
            ...(Number.isFinite(Number(overlay.absX)) ? { absX: Number(overlay.absX) } : {}),
            ...(Number.isFinite(Number(overlay.absY)) ? { absY: Number(overlay.absY) } : {}),
          };
        })
        .filter(Boolean);
      if (overlays.length > 0) normalized.overlays = overlays;
    }
    // 【v1.29.x UI-coord】ビューアー上のルビ wrap の実描画位置を PSD 座標 (親レイヤー基準) で
    // 保持。canvas-tools.js が renderOverlay 後に setCharRubyOffset() で書き込む。
    // 値があれば JSX 側の createRubyLayer はこの座標をそのまま使う (計算ズレ排除)。
    // 未設定 / NaN のときは JSX 側の幾何計算 fallback。
    if (Number.isFinite(Number(entry.offsetX))) normalized.offsetX = Number(entry.offsetX);
    if (Number.isFinite(Number(entry.offsetY))) normalized.offsetY = Number(entry.offsetY);
    if (Number.isFinite(Number(entry.absX))) normalized.absX = Number(entry.absX);
    if (Number.isFinite(Number(entry.absY))) normalized.absY = Number(entry.absY);
    out[String(start)] = normalized;
  }
  return out;
}

function dropOverlapping(map, from, to) {
  const out = {};
  for (const k of Object.keys(map)) {
    const start = Number(k);
    const entry = map[k];
    const end = Number(entry.end);
    // 重複: [start, end) と [from, to) が交差していれば drop
    if (start < to && end > from) continue;
    out[String(start)] = entry;
  }
  return out;
}

function isDakutenRubyText(text) {
  const chars = Array.from(String(text ?? ""));
  return chars.length > 0 && chars.every((ch) => {
    const code = ch.charCodeAt(0);
    return code === 0x309b || code === 0xff9e || code === 0x3099;
  });
}

function isNakaguroRubyText(text) {
  const chars = Array.from(String(text ?? ""));
  return chars.length > 0 && chars.every((ch) => {
    const code = ch.charCodeAt(0);
    return code === 0x30fb || code === 0xff65;
  });
}

function isSpecialRubyText(text) {
  return isDakutenRubyText(text) || isNakaguroRubyText(text);
}

function pushUniqueRubyOverlay(overlays, overlay) {
  if (!overlay || typeof overlay.text !== "string" || !overlay.text) return;
  const start = Number(overlay.start);
  const end = Number(overlay.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
  const exists = overlays.some((cur) =>
    Number(cur.start) === start
    && Number(cur.end) === end
    && cur.text === overlay.text);
  if (!exists) overlays.push({ ...overlay, start, end });
}

function collectSpecialRubyOverlays(map, from, to) {
  const overlays = [];
  for (const k of Object.keys(map)) {
    const start = Number(k);
    const entry = map[k];
    const end = Number(entry?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || !(start < to && end > from)) continue;
    if (isSpecialRubyText(entry.text)) {
      const overlay = {
        start,
        end,
        text: entry.text,
        type: entry.type === "mono" ? "mono" : "group",
        scale: Number.isFinite(Number(entry.scale)) ? Number(entry.scale) : 100,
      };
      if (Number.isFinite(Number(entry.offsetX))) overlay.offsetX = Number(entry.offsetX);
      if (Number.isFinite(Number(entry.offsetY))) overlay.offsetY = Number(entry.offsetY);
      if (Number.isFinite(Number(entry.absX))) overlay.absX = Number(entry.absX);
      if (Number.isFinite(Number(entry.absY))) overlay.absY = Number(entry.absY);
      pushUniqueRubyOverlay(overlays, overlay);
    }
    if (Array.isArray(entry.overlays)) {
      for (const overlay of entry.overlays) {
        if (!isSpecialRubyText(overlay?.text)) continue;
        const overlayStart = Number(overlay.start);
        const overlayEnd = Number(overlay.end);
        if (!Number.isFinite(overlayStart) || !Number.isFinite(overlayEnd) || !(overlayStart < to && overlayEnd > from)) continue;
        pushUniqueRubyOverlay(overlays, overlay);
      }
    }
  }
  return overlays;
}

function addRubyOverlay(map, from, to, text, type, scale) {
  for (const k of Object.keys(map)) {
    const start = Number(k);
    const entry = map[k];
    const end = Number(entry?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (from < end && to > start) {
      if (rubyEntryMatchesText(entry, text)) return true;
      const overlays = Array.isArray(entry.overlays) ? entry.overlays.slice() : [];
      const nextOverlay = { start: from, end: to, text, type, scale };
      const sameIndex = overlays.findIndex((overlay) =>
        Number(overlay?.start) === from
        && Number(overlay?.end) === to
        && overlay?.text === text);
      if (sameIndex >= 0) overlays[sameIndex] = nextOverlay;
      else overlays.push(nextOverlay);
      map[k] = { ...entry, overlays };
      return true;
    }
  }
  return false;
}

function rubyEntryMatchesText(entry, text) {
  if (typeof entry?.text !== "string" || typeof text !== "string" || !text) return false;
  if (entry.text === text) return true;
  if (isNakaguroRubyText(entry.text) && isNakaguroRubyText(text)) return true;
  if (isDakutenRubyText(entry.text) && isDakutenRubyText(text)) return true;
  return Array.from(entry.text).length > 0 && Array.from(entry.text).every((ch) => ch === text);
}

function rubyOverlayMatchesText(overlay, from, to, text) {
  const start = Number(overlay?.start);
  const end = Number(overlay?.end);
  const overlayText = typeof overlay?.text === "string" ? overlay.text : "";
  const textMatches = overlayText === text
    || (isNakaguroRubyText(overlayText) && isNakaguroRubyText(text))
    || (isDakutenRubyText(overlayText) && isDakutenRubyText(text))
    || (Array.from(overlayText).length > 0 && Array.from(overlayText).every((ch) => ch === text));
  return Number.isFinite(start)
    && Number.isFinite(end)
    && start < to
    && end > from
    && textMatches;
}

export function setCharRubiesRange(psdPath, layerIdOrTempId, from, to, text, type, scale, options = {}) {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return;
  if (from >= to) return;
  const ttxt = typeof text === "string" ? text : "";
  const rtype = type === "mono" ? "mono" : "group";
  const rscale = Number.isFinite(Number(scale)) ? Number(scale) : 50;
  if (typeof layerIdOrTempId === "string") {
    const idx = state.newLayers.findIndex((l) => l.tempId === layerIdOrTempId);
    if (idx < 0) return;
    let cur = normalizeCharRubiesMap(state.newLayers[idx].charRubies);
    const preservedSpecialOverlays = ttxt.length > 0 && !isSpecialRubyText(ttxt)
      ? collectSpecialRubyOverlays(cur, from, to)
      : [];
    if (options?.appendOverlay && ttxt.length > 0 && addRubyOverlay(cur, from, to, ttxt, rtype, rscale)) {
      state.newLayers[idx] = { ...state.newLayers[idx], charRubies: cur };
      pushHistorySnapshot();
      return;
    }
    cur = dropOverlapping(cur, from, to);
    if (ttxt.length > 0) {
      cur[String(from)] = {
        end: to,
        text: ttxt,
        type: rtype,
        scale: rscale,
        ...(preservedSpecialOverlays.length > 0 ? { overlays: preservedSpecialOverlays } : {}),
      };
    }
    state.newLayers[idx] = { ...state.newLayers[idx], charRubies: cur };
    pushHistorySnapshot();
  } else {
    const existing = getEdit(psdPath, layerIdOrTempId) ?? {};
    let cur = normalizeCharRubiesMap(existing.charRubies);
    const preservedSpecialOverlays = ttxt.length > 0 && !isSpecialRubyText(ttxt)
      ? collectSpecialRubyOverlays(cur, from, to)
      : [];
    if (options?.appendOverlay && ttxt.length > 0 && addRubyOverlay(cur, from, to, ttxt, rtype, rscale)) {
      setEdit(psdPath, layerIdOrTempId, { charRubies: cur });
      return;
    }
    cur = dropOverlapping(cur, from, to);
    if (ttxt.length > 0) {
      cur[String(from)] = {
        end: to,
        text: ttxt,
        type: rtype,
        scale: rscale,
        ...(preservedSpecialOverlays.length > 0 ? { overlays: preservedSpecialOverlays } : {}),
      };
    }
    setEdit(psdPath, layerIdOrTempId, { charRubies: cur });
  }
}

function normalizeRubyScaleValue(scale) {
  const n = Number(scale);
  if (!Number.isFinite(n)) return 50;
  return Math.max(1, Math.min(300, Math.round(n * 100) / 100));
}

function clearRubyMeasuredOffsets(entry) {
  if (!entry || typeof entry !== "object") return entry;
  const { offsetX, offsetY, absX, absY, ...rest } = entry;
  return rest;
}

function getRubyForRangeFromMap(map, from, to, text, options = {}) {
  const cur = normalizeCharRubiesMap(map);
  const targetText = typeof text === "string" ? text : "";
  const wantsOverlay = options?.overlay === true;
  for (const k of Object.keys(cur)) {
    const start = Number(k);
    const entry = cur[k];
    const end = Number(entry?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (wantsOverlay) {
      if (!Array.isArray(entry.overlays)) continue;
      for (let i = 0; i < entry.overlays.length; i++) {
        const overlay = entry.overlays[i];
        const overlayStart = Number(overlay?.start);
        const overlayEnd = Number(overlay?.end);
        if (!Number.isFinite(overlayStart) || !Number.isFinite(overlayEnd)) continue;
        if (overlayStart !== from || overlayEnd !== to) continue;
        if (targetText && overlay.text !== targetText) continue;
        return { ...overlay, overlay: true, overlayIndex: i, ownerStart: start };
      }
      continue;
    }
    if (start !== from || end !== to) continue;
    if (targetText && entry.text !== targetText) continue;
    return { start, end, text: entry.text, type: entry.type, scale: entry.scale, overlay: false };
  }
  return null;
}

export function getCharRubyForRange(psdPath, layerIdOrTempId, from, to, text, options = {}) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from >= to) return null;
  const map = getCharRubies(psdPath, layerIdOrTempId);
  return getRubyForRangeFromMap(map, from, to, text, options);
}

function setRubyScaleInMap(map, from, to, text, scale, options = {}) {
  const cur = normalizeCharRubiesMap(map);
  const targetText = typeof text === "string" ? text : "";
  const wantsOverlay = options?.overlay === true;
  const nextScale = normalizeRubyScaleValue(scale);
  let changed = false;
  for (const k of Object.keys(cur)) {
    const start = Number(k);
    const entry = cur[k];
    const end = Number(entry?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (wantsOverlay) {
      if (!Array.isArray(entry.overlays)) continue;
      const overlays = entry.overlays.map((overlay) => {
        const overlayStart = Number(overlay?.start);
        const overlayEnd = Number(overlay?.end);
        if (!Number.isFinite(overlayStart) || !Number.isFinite(overlayEnd)) return overlay;
        if (overlayStart !== from || overlayEnd !== to) return overlay;
        if (targetText && overlay.text !== targetText) return overlay;
        if (Math.abs((Number(overlay.scale) || 50) - nextScale) < 1e-9) return overlay;
        changed = true;
        return { ...clearRubyMeasuredOffsets(overlay), scale: nextScale };
      });
      if (changed) cur[k] = { ...entry, overlays };
      continue;
    }
    if (start !== from || end !== to) continue;
    if (targetText && entry.text !== targetText) continue;
    if (Math.abs((Number(entry.scale) || 50) - nextScale) < 1e-9) continue;
    cur[k] = { ...clearRubyMeasuredOffsets(entry), scale: nextScale };
    changed = true;
  }
  return { map: cur, changed };
}

export function setCharRubyScale(psdPath, layerIdOrTempId, from, to, text, scale, options = {}) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from >= to) return false;
  if (typeof layerIdOrTempId === "string") {
    const idx = state.newLayers.findIndex((l) => l.tempId === layerIdOrTempId);
    if (idx < 0) return false;
    const { map, changed } = setRubyScaleInMap(state.newLayers[idx].charRubies, from, to, text, scale, options);
    if (!changed) return false;
    state.newLayers[idx] = { ...state.newLayers[idx], charRubies: map };
    pushHistorySnapshot();
    return true;
  }
  const existing = getEdit(psdPath, layerIdOrTempId) ?? {};
  const { map, changed } = setRubyScaleInMap(existing.charRubies, from, to, text, scale, options);
  if (!changed) return false;
  setEdit(psdPath, layerIdOrTempId, { charRubies: map });
  return true;
}

export function rangeHasRubyText(psdPath, layerIdOrTempId, from, to, text) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from >= to || typeof text !== "string" || !text) return false;
  const map = getCharRubies(psdPath, layerIdOrTempId);
  for (const k of Object.keys(map)) {
    const start = Number(k);
    const entry = map[k];
    const end = Number(entry?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || !(start < to && end > from)) continue;
    if (rubyEntryMatchesText(entry, text)) return true;
    if (Array.isArray(entry.overlays) && entry.overlays.some((overlay) => rubyOverlayMatchesText(overlay, from, to, text))) return true;
  }
  return false;
}

export function removeRubyTextRange(psdPath, layerIdOrTempId, from, to, text) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from >= to || typeof text !== "string" || !text) return false;
  const removeFromMap = (map) => {
    const cur = normalizeCharRubiesMap(map);
    let changed = false;
    for (const k of Object.keys(cur)) {
      const start = Number(k);
      const entry = cur[k];
      const end = Number(entry?.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || !(start < to && end > from)) continue;
      if (rubyEntryMatchesText(entry, text)) {
        delete cur[k];
        changed = true;
        continue;
      }
      if (Array.isArray(entry.overlays)) {
        const overlays = entry.overlays.filter((overlay) => !rubyOverlayMatchesText(overlay, from, to, text));
        if (overlays.length !== entry.overlays.length) {
          cur[k] = overlays.length > 0 ? { ...entry, overlays } : { ...entry, overlays: undefined };
          changed = true;
        }
      }
    }
    return { map: cur, changed };
  };

  if (typeof layerIdOrTempId === "string") {
    const idx = state.newLayers.findIndex((l) => l.tempId === layerIdOrTempId);
    if (idx < 0) return false;
    const { map, changed } = removeFromMap(state.newLayers[idx].charRubies);
    if (!changed) return false;
    state.newLayers[idx] = { ...state.newLayers[idx], charRubies: map };
    pushHistorySnapshot();
    return true;
  }

  const existing = getEdit(psdPath, layerIdOrTempId) ?? {};
  const { map, changed } = removeFromMap(existing.charRubies);
  if (!changed) return false;
  setEdit(psdPath, layerIdOrTempId, { charRubies: map });
  return true;
}

export function removeCharRubyAt(psdPath, layerIdOrTempId, charIndex) {
  if (!Number.isInteger(charIndex)) return null;
  const removeFromMap = (map) => {
    const cur = normalizeCharRubiesMap(map);
    for (const k of Object.keys(cur)) {
      const start = Number(k);
      const entry = cur[k];
      const end = Number(entry?.end);
      if (Number.isFinite(start) && Number.isFinite(end) && charIndex >= start && charIndex < end) {
        delete cur[k];
        return { map: cur, removed: { start, end, text: entry.text, type: entry.type, scale: entry.scale } };
      }
    }
    return { map: cur, removed: null };
  };

  if (typeof layerIdOrTempId === "string") {
    const idx = state.newLayers.findIndex((l) => l.tempId === layerIdOrTempId);
    if (idx < 0) return null;
    const { map, removed } = removeFromMap(state.newLayers[idx].charRubies);
    if (!removed) return null;
    state.newLayers[idx] = { ...state.newLayers[idx], charRubies: map };
    pushHistorySnapshot();
    return removed;
  }

  const existing = getEdit(psdPath, layerIdOrTempId) ?? {};
  const { map, removed } = removeFromMap(existing.charRubies);
  if (!removed) return null;
  setEdit(psdPath, layerIdOrTempId, { charRubies: map });
  return removed;
}

export function getCharRubies(psdPath, layerIdOrTempId) {
  if (typeof layerIdOrTempId === "string") {
    const nl = state.newLayers.find((l) => l.tempId === layerIdOrTempId);
    return nl?.charRubies ?? {};
  }
  const e = getEdit(psdPath, layerIdOrTempId);
  return e?.charRubies ?? {};
}

// 【v1.29.x UI-coord】指定 ruby エントリにビューアー描画時の PSD 座標オフセットを記録する。
// renderOverlay の最後で .ruby-wrap の位置を測って呼ぶ。history snapshot は出さない
// (UI 由来のキャッシュであり、user の編集操作ではない)。
export function setCharRubyOffset(psdPath, layerIdOrTempId, start, offsetX, offsetY, absX = null, absY = null) {
  if (!Number.isInteger(start)) return;
  if (!Number.isFinite(offsetX) || !Number.isFinite(offsetY)) return;
  const absolute = {};
  if (Number.isFinite(Number(absX))) absolute.absX = Number(absX);
  if (Number.isFinite(Number(absY))) absolute.absY = Number(absY);
  if (typeof layerIdOrTempId === "string") {
    const idx = state.newLayers.findIndex((l) => l.tempId === layerIdOrTempId);
    if (idx < 0) return;
    const cur = { ...(state.newLayers[idx].charRubies ?? {}) };
    const key = String(start);
    if (!cur[key]) return; // ルビ entry がない位置は無視
    cur[key] = { ...cur[key], offsetX, offsetY, ...absolute };
    // pushHistorySnapshot は呼ばない (UI cache 更新のため)
    state.newLayers[idx] = { ...state.newLayers[idx], charRubies: cur };
  } else {
    const existing = getEdit(psdPath, layerIdOrTempId) ?? {};
    const cur = { ...(existing.charRubies ?? {}) };
    const key = String(start);
    if (!cur[key]) return;
    cur[key] = { ...cur[key], offsetX, offsetY, ...absolute };
    // setEdit は pushHistorySnapshot を内部で呼ぶので使わず、edits マップに直接書き込む。
    const eKey = `${psdPath}::${layerIdOrTempId}`;
    const e = state.edits.get(eKey) ?? { psdPath, layerId: layerIdOrTempId };
    state.edits.set(eKey, { ...e, charRubies: cur });
  }
}

export function setCharRubyVisualOffset(psdPath, layerIdOrTempId, start, end, text, overlay, offsetX, offsetY, absX = null, absY = null) {
  if (!Number.isInteger(start) || !Number.isFinite(offsetX) || !Number.isFinite(offsetY)) return;
  const endNum = Number(end);
  const targetText = typeof text === "string" ? text : "";
  const absolute = {};
  if (Number.isFinite(Number(absX))) absolute.absX = Number(absX);
  if (Number.isFinite(Number(absY))) absolute.absY = Number(absY);
  const applyToMap = (map) => {
    const cur = { ...(map ?? {}) };
    if (overlay === true) {
      if (!Number.isFinite(endNum) || endNum <= start) return { map: cur, changed: false };
      for (const key of Object.keys(cur)) {
        const entry = cur[key];
        if (!Array.isArray(entry?.overlays)) continue;
        let changed = false;
        const overlays = entry.overlays.map((ov) => {
          if (Number(ov?.start) !== start || Number(ov?.end) !== endNum) return ov;
          if (targetText && ov?.text !== targetText) return ov;
          changed = true;
          return { ...ov, offsetX, offsetY, ...absolute };
        });
        if (changed) {
          cur[key] = { ...entry, overlays };
          return { map: cur, changed: true };
        }
      }
      return { map: cur, changed: false };
    }
    const key = String(start);
    if (!cur[key]) return { map: cur, changed: false };
    cur[key] = { ...cur[key], offsetX, offsetY, ...absolute };
    return { map: cur, changed: true };
  };

  if (typeof layerIdOrTempId === "string") {
    const idx = state.newLayers.findIndex((l) => l.tempId === layerIdOrTempId);
    if (idx < 0) return;
    const { map, changed } = applyToMap(state.newLayers[idx].charRubies);
    if (!changed) return;
    state.newLayers[idx] = { ...state.newLayers[idx], charRubies: map };
    return;
  }

  const existing = getEdit(psdPath, layerIdOrTempId) ?? {};
  const { map, changed } = applyToMap(existing.charRubies);
  if (!changed) return;
  const eKey = `${psdPath}::${layerIdOrTempId}`;
  const e = state.edits.get(eKey) ?? { psdPath, layerId: layerIdOrTempId };
  state.edits.set(eKey, { ...e, charRubies: map });
}

// 指定 char index を完全に覆う ruby エントリを返す（無ければ null）。
export function getCharRubyAt(psdPath, layerIdOrTempId, charIndex) {
  const map = getCharRubies(psdPath, layerIdOrTempId);
  for (const k of Object.keys(map)) {
    const start = Number(k);
    const entry = map[k];
    if (!Number.isFinite(start) || !entry) continue;
    if (charIndex >= start && charIndex < Number(entry.end)) {
      return { start, end: Number(entry.end), text: entry.text, type: entry.type, scale: entry.scale };
    }
  }
  return null;
}

// 範囲 [from, to) と交差する ruby エントリがあるか判定。
export function rangeHasAnyRuby(psdPath, layerIdOrTempId, from, to) {
  const map = getCharRubies(psdPath, layerIdOrTempId);
  for (const k of Object.keys(map)) {
    const start = Number(k);
    const entry = map[k];
    if (!Number.isFinite(start) || !entry) continue;
    const end = Number(entry.end);
    if (start < to && end > from) return true;
  }
  return false;
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

// V ツールの「新規テキスト方向」(vertical / horizontal)
export const getNewTextDirection = $newTextDirection.get;
export const setNewTextDirection = $newTextDirection.set;
export const onNewTextDirectionChange = $newTextDirection.on;

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

function cloneProjectValue(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function txtSourceEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.name === b.name && a.content === b.content;
}

function normalizeTxtSourceContent(content) {
  return String(content ?? "").replace(/\u301c/g, "\uff5e");
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
    const restored = snap.txtSource
      ? { ...snap.txtSource, content: normalizeTxtSourceContent(snap.txtSource.content) }
      : null;
    if (!txtSourceEqual(state.txtSource, restored)) {
      state.txtSource = restored;
      // 復元先と現在で内容が変わるため、選択は無効になり得る。安全側に倒してクリア。
      state.txtSelection = "";
      state.txtSelectedBlockIndex = null;
      for (const fn of state.txtSourceListeners) fn(state.txtSource);
    }
  }
  // undo/redo で状態が変わった → 保存ダーティ。
  markSaveDirty();
  for (const fn of state.historyListeners) fn();
}

// ── 保存ダーティ追跡 ──────────────────────────────────────────────
// 「PSD へ未反映の編集があるか」「プロジェクト(.opus)へ未保存の状態があるか」を独立に追跡する。
// 編集 (pushHistorySnapshot) / undo・redo で両方 dirty、PSD 保存で psd を、プロジェクト保存で
// project を clean に戻す。clearPages / プロジェクト読込 (resetHistoryBaseline) で両方 clean。
// ウインドウを閉じる確認ダイアログで「何が未保存か」を条件分岐するのに使う。
let psdSaveDirty = false;
let projectSaveDirty = false;
function markSaveDirty() { psdSaveDirty = true; projectSaveDirty = true; }
function markAllSaveClean() { psdSaveDirty = false; projectSaveDirty = false; }
export function getPsdSaveDirty() { return psdSaveDirty; }
export function getProjectSaveDirty() { return projectSaveDirty; }
export function markPsdSaveClean() { psdSaveDirty = false; }
export function markProjectSaveClean() { projectSaveDirty = false; }

function pushHistorySnapshot() {
  if (state.historyTransientDepth > 0) return;
  // redo 分岐は破棄してから現在状態を新たな最終地点として積む。
  state.history = state.history.slice(0, state.historyIndex + 1);
  state.history.push(snapshotState());
  if (state.history.length > HISTORY_MAX) state.history.shift();
  state.historyIndex = state.history.length - 1;
  markSaveDirty();
  for (const fn of state.historyListeners) fn();
}

function resetHistoryBaseline() {
  state.history = [snapshotState()];
  state.historyIndex = 0;
  state.historyTransientDepth = 0;
  // 読込/クリア直後は「保存済み（未編集）」状態。次の編集まで両方 clean。
  markAllSaveClean();
  for (const fn of state.historyListeners) fn();
}

export function exportProjectSnapshot() {
  const snap = {
    psdPaths: getUniquePsdSourcePaths(),
    edits: Array.from(state.edits.values()).map(cloneProjectValue),
    newLayers: state.newLayers.map(cloneProjectValue),
    nextTempId: state.nextTempId,
    txtSource: state.txtSource ? { ...state.txtSource } : null,
    txtSelection: state.txtSelection || "",
    txtSelectedBlockIndex: state.txtSelectedBlockIndex,
  };
  // 【v2.x】診断ログ: 保存スナップショット内の charRubies 件数を可視化。
  // 保存時点で 0/0 件なら入口問題 (= 手動ルビが state に書かれていない、もしくは
  // setCharRubiesRange の対象 layer/edit が exportEdits の対象外)。
  // applyProjectSnapshot 側ログと突合して、どこで消えるかを切り分けるための情報。
  const editsRuby = snap.edits.filter((e) => e?.charRubies && Object.keys(e.charRubies).length > 0).length;
  const newLayersRuby = snap.newLayers.filter((l) => l?.charRubies && Object.keys(l.charRubies).length > 0).length;
  console.info(
    `[exportProjectSnapshot] edits=${snap.edits.length}(ruby:${editsRuby}) `
    + `newLayers=${snap.newLayers.length}(ruby:${newLayersRuby})`,
  );
  return snap;
}

export function applyProjectSnapshot(snapshot, options = {}) {
  // 【v2.x】silentTxtListener: true (デフォルト false → true に変更) で
  // state.txtSource 復元時に txtSourceListeners (例: auto-place.js syncPlacedFromTxt)
  // の発火を抑制する。プロジェクト復元時に listener が走ると、自動配置レイヤーの
  // 手動 charRubies / lineLeadings が TXT 注記由来の値 (空 or 部分的) で上書きされる
  // 事故が再発するため、復元時は静かに txtSource だけ書き換える。後続の UI 再描画は
  // services/project.js が renderTxtSourceViewer / renderAllSpreads / rebuildLayerList を
  // 明示的に呼ぶことで賄う。
  const { silentTxtListener = false } = options;
  const loadedPaths = new Set(state.pages.map((p) => p.path).filter(Boolean));
  const edits = Array.isArray(snapshot?.edits) ? snapshot.edits : [];
  const newLayers = Array.isArray(snapshot?.newLayers) ? snapshot.newLayers : [];
  state.edits = new Map();
  let editsRubyCount = 0;
  for (const raw of edits) {
    const entry = cloneProjectValue(raw);
    if (!entry || typeof entry !== "object") continue;
    const psdPath = typeof entry.psdPath === "string" ? entry.psdPath : "";
    const layerId = Number(entry.layerId);
    if (!psdPath || !loadedPaths.has(psdPath) || !Number.isFinite(layerId)) continue;
    entry.layerId = layerId;
    if (entry.charRubies && Object.keys(entry.charRubies).length > 0) editsRubyCount++;
    state.edits.set(editKey(psdPath, layerId), entry);
  }

  let maxTempId = 0;
  let newLayersRubyCount = 0;
  state.newLayers = [];
  for (const raw of newLayers) {
    const layer = cloneProjectValue(raw);
    if (!layer || typeof layer !== "object") continue;
    if (typeof layer.psdPath !== "string" || !loadedPaths.has(layer.psdPath)) continue;
    if (!Number.isFinite(Number(layer.x)) || !Number.isFinite(Number(layer.y))) continue;
    layer.x = Number(layer.x);
    layer.y = Number(layer.y);
    if (typeof layer.tempId !== "string" || !layer.tempId) {
      layer.tempId = `new-${++maxTempId}`;
    }
    const m = layer.tempId.match(/^new-(\d+)$/);
    if (m) maxTempId = Math.max(maxTempId, Number(m[1]) || 0);
    if (layer.charRubies && Object.keys(layer.charRubies).length > 0) newLayersRubyCount++;
    state.newLayers.push(layer);
  }
  const requestedNext = Number(snapshot?.nextTempId);
  state.nextTempId = Math.max(
    Number.isFinite(requestedNext) ? Math.round(requestedNext) : 1,
    maxTempId + 1,
    1,
  );
  state.selectedLayers = [];

  if (Object.prototype.hasOwnProperty.call(snapshot || {}, "txtSource")) {
    const restored = snapshot.txtSource ? {
      name: String(snapshot.txtSource.name || "untitled.txt"),
      content: normalizeTxtSourceContent(snapshot.txtSource.content),
    } : null;
    const changed = !txtSourceEqual(state.txtSource, restored);
    state.txtSource = restored;
    state.txtSelection = "";
    state.txtSelectedBlockIndex = null;
    if (changed && !silentTxtListener) {
      for (const fn of state.txtSourceListeners) fn(state.txtSource);
    }
  }

  // 【v2.x】診断ログ: プロジェクト復元時の charRubies 件数を可視化。
  // 0/0 件で「ルビ消失」報告が来た場合は保存時点で空 (入口問題)。
  // 復元直後に件数あり、その後ユーザー操作後に消えるならどこかの mutator 起因。
  console.info(
    `[applyProjectSnapshot] edits=${state.edits.size}(ruby:${editsRubyCount}) `
    + `newLayers=${state.newLayers.length}(ruby:${newLayersRubyCount}) `
    + `silentTxtListener=${silentTxtListener}`,
  );

  resetHistoryBaseline();
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

export function getPsdSourcePath(pageOrPath) {
  if (!pageOrPath) return null;
  if (typeof pageOrPath === "object") return pageOrPath.sourcePath ?? pageOrPath.path ?? null;
  const page = state.pages.find((p) => p.path === pageOrPath || p.sourcePath === pageOrPath);
  return page?.sourcePath ?? pageOrPath;
}

export function getUniquePsdSourcePaths() {
  const out = [];
  const seen = new Set();
  for (const page of state.pages) {
    const path = getPsdSourcePath(page);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

function getPsdSourcePageForPath(path) {
  const page = state.pages.find((p) => p.path === path || p.sourcePath === path) ?? null;
  if (!page) return null;
  return {
    ...page,
    path: page.sourcePath ?? page.path,
    width: page.sourceWidth ?? page.width,
    height: page.sourceHeight ?? page.height,
  };
}

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
    const sourcePath = getPsdSourcePath(psdPath);
    if (!sourcePath) return null;
    if (!byPsd.has(sourcePath)) {
      const page = getPsdSourcePageForPath(sourcePath);
      byPsd.set(sourcePath, {
        pageWidth: Number.isFinite(Number(page?.width)) ? Number(page.width) : null,
        pageHeight: Number.isFinite(Number(page?.height)) ? Number(page.height) : null,
        layers: [],
        newLayers: [],
      });
    }
    return byPsd.get(sourcePath);
  };

  // Save/export operates on every loaded PSD, even when a file has no text layers
  // or no edits. Otherwise blank/non-text PSDs are skipped by the Photoshop loop.
  for (const page of state.pages) {
    if (typeof page?.path === "string" && page.path) ensure(page.path);
  }

  for (const entry of state.edits.values()) {
    const { psdPath, layerId, ...rest } = entry;
    const page = state.pages.find((p) => p.path === psdPath) ?? null;
    const layer = page?.textLayers?.find?.((l) => l.id === layerId) ?? null;
    const payload = { layerId, ...sanitizeNumericFields(rest) };
    if (payload.strokeColor == null && layer?.strokeColor != null) payload.strokeColor = layer.strokeColor;
    if (payload.strokeWidthPx == null && Number.isFinite(layer?.strokeWidthPx)) payload.strokeWidthPx = layer.strokeWidthPx;
    ensure(psdPath)?.layers.push(payload);
  }

  for (const nl of state.newLayers) {
    const { psdPath, tempId: _tempId, ...rest } = nl;
    // 新規レイヤーの x/y は配置必須のため、いずれかが NaN/Infinity なら
    // そのレイヤー自体を payload から落とす（不正配置で JSX を壊さない）。
    if (!Number.isFinite(nl.x) || !Number.isFinite(nl.y)) continue;
    const page = state.pages.find((p) => p.path === psdPath) ?? null;
    const offsetX = Number.isFinite(page?.splitOffsetX) ? page.splitOffsetX : 0;
    const payload = sanitizeNumericFields({ ...rest, x: nl.x + offsetX, y: nl.y });
    ensure(psdPath)?.newLayers.push(payload);
  }

  // 連続記号のツメ（環境設定の global 値）。新規レイヤー（newLayers）にだけ JSX 側で適用する。
  // 既存レイヤー（layers / edits）は触らない方針。0 のとき機能 OFF。dash/tilde グループ別。
  const dashTrackingMille = Number(getDefault("dashRunTrackingMille")) || 0;
  const tildeTrackingMille = Number(getDefault("tildeRunKerningMille")) || 0;
  // 縦中横（!! / !? の自動 tcy）も新規・縦書きレイヤーにだけ JSX 側で適用する。
  const tateChuYokoEnabled = getDefault("tateChuYokoEnabled") !== false;
  // 記号フォント置換（♡♥★☆♪ 等を別フォントで自動置換）。新規 + 既存両方に JSX 側で適用する。
  // ユーザーが per-char で手動指定したフォントは尊重（自動置換 skip）。
  const symbolFontReplaceEnabled = getDefault("symbolFontReplaceEnabled") !== false;
  const symbolFontPostScriptName = String(getDefault("symbolFontPostScriptName") || "");
  // 句読点ツメ（、。を Photoshop 保存時にツメ N% で組む）。新規 + 既存両方に適用。0 で OFF。
  const punctuationTsumePercent = Number(getDefault("punctuationTsumePercent")) || 0;
  // 【v1.29.x】ルビあり行間。JSX 側 (createRubyLayer) が「行間中央」配置を計算するために
  // 受け取る。ビューアー (CSS) の --ruby-row-leading-pct と完全に同じ値を使う。
  const rubyLeadingPct = Number(getDefault("rubyLeadingPct")) || 150;
  // 【v1.29.x】ルビ位置の Photoshop 側 微調整値。
  //   rubyPhotoshopOffsetEm: Photoshop 保存時だけ追加する em 補正 (default 0)
  //   rubyPhotoshopBiasPx  : Photoshop 保存時だけ追加する px 補正 (default 0)
  const rubyPhotoshopOffsetEm = Number.isFinite(Number(getDefault("rubyPhotoshopOffsetEm")))
    ? Number(getDefault("rubyPhotoshopOffsetEm")) : 0;
  const rubyPhotoshopBiasPx = Number.isFinite(Number(getDefault("rubyPhotoshopBiasPx")))
    ? Number(getDefault("rubyPhotoshopBiasPx")) : 0;
  // ルビレイヤーのフォントは親文字レイヤーのフォントを継承させる。空文字を渡すと
  // jsx_gen 側 (applyToPsd → applyRubies) が __fontR / __fontRN（親レイヤーのフォント）に
  // フォールバックする。以前は環境設定の既定フォント (F910) を当てていたため、フレームの
  // フォントを変えても保存後のルビだけ F910 になっていた。
  const rubyFontPostScriptName = "";

  return {
    dashTrackingMille,
    tildeTrackingMille,
    tateChuYokoEnabled,
    symbolFontReplaceEnabled,
    symbolFontPostScriptName,
    punctuationTsumePercent,
    rubyLeadingPct,
    rubyFontPostScriptName,
    rubyPhotoshopOffsetEm,
    rubyPhotoshopBiasPx,
    // 写植再利用モード: 保存時に「元から PSD にあるテキストレイヤーを全て非表示」にする。
    // 抽出テキストは newLayers として新規作成されるため、元テキストは隠して置き換える。
    // id を持たない PSD でも確実に隠せるよう、id 指定ではなく「全テキスト非表示」方式。
    reuseHideOriginalText: $appMode.get() === "reuse",
    edits: Array.from(byPsd.entries()).map(([psdPath, { layers, newLayers }]) => ({
      psdPath,
      layers,
      newLayers,
      // 写植再利用: 保存時に非表示化する元テキストレイヤー id 群。通常モードは空配列。
      hideLayerIds: state.reuseInfo.get(psdPath)?.hideLayerIds ?? [],
    })),
  };
}

export function setSelectedLayer(pageIndex, layerId) {
  state.selectedLayers = pageIndex == null ? [] : [{ pageIndex, layerId }];
  notifySelectionChanged();
}

export function getSelectedLayer() { return state.selectedLayers[0] ?? null; }

export function getSelectedLayers() { return state.selectedLayers; }

function notifySelectionChanged() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("psdesign:selection-changed"));
}

export function setSelectedLayers(list) {
  if (!Array.isArray(list)) {
    state.selectedLayers = [];
    notifySelectionChanged();
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
  notifySelectionChanged();
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
  notifySelectionChanged();
}

export function setFonts(fonts) { state.fonts = fonts; }
export function getFonts() { return state.fonts; }

const FONT_DISPLAY_NAME_FALLBACKS = new Map([
  ["DFGMaruGothic-Md", "ＤＦ中丸ゴシック体"],
]);

function containsJapaneseText(value) {
  return /[\u3040-\u30ff\u3400-\u9fff\uff00-\uffef]/.test(String(value ?? ""));
}

function preferredLocalizedFontName(font, psName) {
  const aliases = Array.isArray(font?.aliases) ? font.aliases : [];
  const candidates = [
    font?.name,
    ...aliases,
  ]
    .map((v) => String(v ?? "").trim())
    .filter((v) => v && v !== psName);
  return candidates.find(containsJapaneseText) ?? candidates[0] ?? null;
}

export function getFontDisplayName(psName) {
  if (!psName) return null;
  const hit = state.fonts.find((f) => f.postScriptName === psName);
  return preferredLocalizedFontName(hit, psName)
    ?? FONT_DISPLAY_NAME_FALLBACKS.get(psName)
    ?? psName;
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
  horizontalScale,
  verticalScale,
  trackingMille,
  kerningMille,
  syntheticBold,
  syntheticItalic,
  sourceTxtRef,
  autoFontSwitched,
  autoFontSwitchBucket,
  lineLeadings,
  charRubies,
  lowExtractTextMatch,
  extractMatchScore,
  reuseTightThick,
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
    fillColor: _normFillColor(fillColor),
    rotation: Number.isFinite(rotation) ? rotation : 0,
    leadingPct: Number.isFinite(leadingPct) ? leadingPct : 125,
    horizontalScale: Number.isFinite(horizontalScale) ? normalizeTextScalePercent(horizontalScale) : 100,
    verticalScale: Number.isFinite(verticalScale) ? normalizeTextScalePercent(verticalScale) : 100,
    trackingMille: Number.isFinite(trackingMille) ? normalizeTextSpacingMille(trackingMille) : 0,
    kerningMille: Number.isFinite(kerningMille) ? normalizeTextSpacingMille(kerningMille) : 0,
    // 【v1.22.0】合成太字（faux bold）。layer 全体に適用、per-char (charBolds) があれば
    // それが優先される。
    syntheticBold: syntheticBold === true,
    syntheticItalic: syntheticItalic === true,
    // 行ごとの行間オーバーライド。キーは 0-based の行番号、値は %。
    // 未指定の行は層の leadingPct（autoLeading）を使う。
    lineLeadings: lineLeadings && typeof lineLeadings === "object" ? { ...lineLeadings } : {},
    // 【v1.16.0】文字ごとのサイズ / フォントオーバーライド。
    // キーは contents 文字列の絶対 index（textarea selectionStart と同じ）。
    // UI プレビューのみ反映、Photoshop には書き戻されない（layer 全体の sizePt/font が使われる）。
    charSizes: {},
    charFonts: {},
    charHorizontalScales: {},
    charVerticalScales: {},
    charTrackings: {},
    charKernings: {},
    charTateChuYokos: {},
    charFillColors: {},
    // 【v1.22.0】文字ごとの合成太字オーバーライド。{[charIndex]: boolean}。
    // 値あり → layer の syntheticBold より優先。値なし → layer 値にフォールバック。
    charBolds: {},
    charItalics: {},
    // 【v1.26.0 ルビ】文字ごとのルビ。スキーマは他の per-char とは異なり「start index を
    // キーに range 全体を 1 件で保持」: { "<start>": {end, text, type:"mono"|"group", scale:50} }。
    // overlap は禁止（setCharRubiesRange で正規化）。プレビューは <ruby><rt>...</rt></ruby>
    // タグで描画、Photoshop 保存時は jsx_gen.rs の applyRubies で親レイヤーの直前に新規ルビ
    // レイヤーを追加する。
    charRubies: normalizeCharRubiesMap(charRubies),
    // 自動配置 (auto-place.js) で生成されたレイヤーは元 TXT 段落への参照を持つ。
    // { pageNumber, paragraphIndex } を保持し、後から TXT が編集されたときに
    // syncPlacedFromTxt が contents を追従させる。手動配置レイヤーは null。
    sourceTxtRef: sourceTxtRef ?? null,
    // 【v1.26.0 移植 (PsDesign-main v1.24.0)】自動配置で背景/ウニ判定により中丸ゴシック等に
    // フォント自動切替された目印。ビューア / レイヤーリスト / 原稿テキスト で色強調するための
    // UI 用フラグ。手動配置 = false。
    autoFontSwitched: autoFontSwitched === true,
    // 0..5 の bucket index (10% 刻み)。-1 は未切替 / 算出不能。
    // CSS 側で auto-font-bucket-N クラス → 6 段階の色グラデーション。
    autoFontSwitchBucket: Number.isInteger(autoFontSwitchBucket) ? autoFontSwitchBucket : -1,
    lowExtractTextMatch: lowExtractTextMatch === true,
    extractMatchScore: Number.isFinite(extractMatchScore) ? extractMatchScore : null,
    reuseTightThick: reuseTightThick === true,
    // 【v1.28.0 移植 (PsDesign-main v1.25.0)】自動配置時の元 sizePt。
    // 位置調整 mode2 / mode3 でサイズ補正を idempotent にするために保存する。
    // layer.sizePt が後から更新されても、補正は sizePtBasis × sizeCorrectionFactor で再計算。
    sizePtBasis: Number.isFinite(sizePt) ? sizePt : null,
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
  const next = source ? { name: source.name, content: normalizeTxtSourceContent(source.content) } : null;
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

function stringArraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((value, i) => value === b[i]);
}

function numberSetsEqual(a, b) {
  if (!(a instanceof Set) || !(b instanceof Set) || a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

export function getPdfDoc() { return state.pdfDoc; }
export function getPdfPath() { return state.pdfPath; }
export function getPdfPaths() { return [...state.pdfPaths]; }
export function getPdfExcludedReferencePages() { return new Set(state.pdfExcludedReferencePages); }
export function setPdfExcludedReferencePages(pages) {
  const next = new Set(
    Array.from(pages || [])
      .map((v) => Number(v))
      .filter((v) => Number.isInteger(v) && v > 0),
  );
  const changed = !numberSetsEqual(state.pdfExcludedReferencePages, next);
  state.pdfExcludedReferencePages = next;
  if (changed) clearScanExtractDoc();
}
export function getPdfSplitPageNumbers() { return new Set(state.pdfSplitPageNumbers); }
export function setPdfSplitPageNumbers(pages) {
  const next = new Set(
    Array.from(pages || [])
      .map((v) => Number(v))
      .filter((v) => Number.isInteger(v) && v > 0),
  );
  const changed = !numberSetsEqual(state.pdfSplitPageNumbers, next);
  if (!changed) return;
  state.pdfSplitPageNumbers = next;
  clearScanExtractDoc();
  for (const fn of state.pdfSplitPageNumberListeners) fn(new Set(next));
}
export function onPdfSplitPageNumbersChange(fn) {
  state.pdfSplitPageNumberListeners.add(fn);
  return () => state.pdfSplitPageNumberListeners.delete(fn);
}
export function getPdfPageCount() { return state.pdfPageCount; }
export function setPdf(doc, path, paths) {
  const prev = state.pdfDoc;
  const nextPath = path || null;
  const nextPaths = Array.isArray(paths) ? [...paths] : (path ? [path] : []);
  const referenceChanged = prev !== doc
    || state.pdfPath !== nextPath
    || !stringArraysEqual(state.pdfPaths, nextPaths);
  if (prev && prev !== doc && typeof prev.destroy === "function") {
    try { prev.destroy(); } catch (_) {}
  }
  state.pdfDoc = doc || null;
  state.pdfPath = nextPath;
  state.pdfPaths = nextPaths;
  state.pdfExcludedReferencePages = new Set();
  if (referenceChanged) clearScanExtractDoc();
  state.pdfPageCount = doc && typeof doc.numPages === "number" ? doc.numPages : 0;
  // ユーザー回転は PDF 切替時も保持（同じワークフローの PDF は同じ向きの傾向があるため）。
  // リセットしたい場合はホームに戻るで clearPdf → clearPdfRotation を呼ぶ。
  // pdfPageIndex は新 PDF 読込時に 0 にリセット（旧 PDF の仮想ページ数とは無関係のため）。
  setPdfPageIndex(0);
  for (const fn of state.pdfListeners) fn(state.pdfDoc);
}
export function clearPdf() {
  if (!state.pdfDoc && !state.pdfPath) {
    clearScanExtractDoc();
    return;
  }
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

export const getPdfFirstRightBlank = $pdfFirstRightBlank.get;
export const setPdfFirstRightBlank = $pdfFirstRightBlank.set;
export const onPdfFirstRightBlankChange = $pdfFirstRightBlank.on;

export const getParallelSyncMode = $parallelSyncMode.get;
export const setParallelSyncMode = $parallelSyncMode.set;
export const onParallelSyncModeChange = $parallelSyncMode.on;

export const getActivePane = $activePane.get;
export const setActivePane = $activePane.set;
export const onActivePaneChange = $activePane.on;

export const getParallelViewMode = $parallelViewMode.get;
export const setParallelViewMode = $parallelViewMode.set;
export const onParallelViewModeChange = $parallelViewMode.on;

export const getEditorLeftPaneMode = $editorLeftPaneMode.get;
export const setEditorLeftPaneMode = $editorLeftPaneMode.set;
export const onEditorLeftPaneModeChange = $editorLeftPaneMode.on;

// 【写植再利用】アプリ動作モード ("normal" | "reuse")。
export const getAppMode = $appMode.get;
export const setAppMode = $appMode.set;
export const onAppModeChange = $appMode.on;

// 【写植再利用】PSD ごとの再利用情報 (hideLayerIds + referenceCanvas)。
export function setReuseInfo(psdPath, info) {
  if (!psdPath) return;
  state.reuseInfo.set(psdPath, {
    hideLayerIds: Array.isArray(info?.hideLayerIds) ? [...info.hideLayerIds] : [],
    referenceCanvas: info?.referenceCanvas ?? null,
    referenceImagePath: typeof info?.referenceImagePath === "string" ? info.referenceImagePath : null,
  });
}
export function getReuseInfo(psdPath) {
  return state.reuseInfo.get(psdPath) ?? null;
}
export function getAllReuseInfo() {
  return state.reuseInfo;
}
export function clearReuseInfo() {
  state.reuseInfo.clear();
}
export function hasReuseInfo() {
  return state.reuseInfo.size > 0;
}

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
