// 吹き出し検出 × TXT 自動配置 (v1.2.0)
//
// scan-extract.js が保存した ReferenceScanDocument (吹き出し座標 + 画像スキャン テキスト) と、
// txt-source.js から取れる TXT ブロック (ページ別) を突き合わせ、
// PSD の正しい位置に新規テキストレイヤーを生成する。
//
// 配置確定後は state.newLayers に積まれ、renderOverlay() が in-app プレビュー
// に即座に反映する。実際の Photoshop 書き出しは既存の Ctrl+S (保存) フロー。

import {
  getPages,
  getScanExtractDoc,
  onScanExtractDocChange,
  addNewLayer,
  getCurrentFont,
  getTextSize,
  getLeadingPct,
  getStrokeColor,
  getStrokeWidthPx,
  getFillColor,
  getNewTextDirection,
  getPdfPaths,
  getPdfDoc,
  getPdfExcludedReferencePages,
  getTxtSource,
  onTxtSourceChange,
  getNewLayers,
  updateNewLayer,
  removeNewLayer,
  beginHistoryTransient,
  commitHistoryTransient,
  abortHistoryTransient,
  setActivePane,
  setPsdZoom,
  setPdfZoom,
} from "./state.js";
import {
  parsePages,
  convertHalfToFullForVertical,
  normalizePunctuationSpaceReplacement,
  renderTxtSourceViewer,
} from "./txt-source.js";
import { notifyDialog, confirmDialog, hideProgress, showProgress, updateProgress } from "./ui-feedback.js";
import { withProgressFlow, updateProgressFlow, completeProgressFlowStep } from "./progress-flow.js";
import { loadPsdFilesByPaths, pickPsdFiles } from "./services/psd-load.js";
import { runScanExtractForFiles, runScanExtractForPlacementOnly, PLACE_ICON_SVG, normalizeReferenceScanDocForReferencePages } from "./scan-extract.js";
import { getPdfVirtualPageAt } from "./pdf-pages.js";
import { renderAllSpreads, resetPsdViewportToStart, PSD_FIT_ZOOM } from "./spread-view.js";
import { resetPdfViewportToStart, PDF_FIT_ZOOM } from "./pdf-view.js";
import { rebuildLayerList } from "./text-editor.js";
import { getDefault } from "./settings.js";
import { sortBlocksMangaOrder } from "./utils/manga-order.js";
import { baseName } from "./utils/path.js";
import { assessOcrRisk } from "./utils/ocr-risk.js";
import { getGuides } from "./rulers.js";

const $ = (id) => document.getElementById(id);
const SOURCE_DOC_KEY = "mo" + "kuro";

function waitForTransitionPaint() {
  if (typeof requestAnimationFrame !== "function") return Promise.resolve();
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 配置 / 位置調整の完了後に、見本(PDF)と PSD の両ペインを「全体が映る」フィット表示
// （Ctrl+0 相当: viewport を始点へ戻し zoom をフィット倍率に）へ揃える。
// resetPaneZoom (main.js) と同じ経路を使うが循環 import を避けるため view モジュール
// から直接 import している。
function fitBothPanesToWindow() {
  try { resetPdfViewportToStart(); setPdfZoom(PDF_FIT_ZOOM); } catch (_) {}
  try { resetPsdViewportToStart(); setPsdZoom(PSD_FIT_ZOOM); } catch (_) {}
}

let runningPlacePromise = null;
// 【v1.28.0 移植】位置調整 (3 モード) の二重起動防止フラグ
let runningAdjust = false;
// 直近に適用された配置プランのテキスト内容指紋。
// 同一テキストで連続して自動配置するときに確認ダイアログを出すために使う。
let lastPlacedFingerprint = null;

function isScanActionsLocked() {
  return $("scan-actions-row")?.classList.contains("scan-actions-row-locked") ?? false;
}

// ホームに戻る等のタイミングで自動配置の状態をリセットする。
// (lastPlacedFingerprint が残っていると次の自動配置で「同一テキスト警告」が誤発火する)
export function resetAutoPlaceState() {
  lastPlacedFingerprint = null;
}

function planFingerprint(plan) {
  const seq = [];
  for (const row of plan.pages) {
    for (const layer of row.layers) seq.push(layer.contents ?? "");
  }
  return JSON.stringify(seq);
}

// ============================================================
// 1 ブロック → NewLayer 変換
// ============================================================
// canvas-tools.js の centerTopLeft + layerRectForNew と同じ手順:
//   (1) クリック位置 = bubble の中心 (PSD 座標)
//   (2) 文字サイズ・行数・文字数からレイヤー矩形のサイズを推定
//   (3) クリック位置からレイヤーの中心が一致するよう top-left をオフセット
function longestLine(s) {
  if (!s) return 0;
  const lines = String(s).split(/\r?\n/);
  let max = 0;
  for (const line of lines) if (line.length > max) max = line.length;
  return max;
}
function countLines(s) {
  if (!s) return 0;
  return String(s).split(/\r?\n/).length;
}
// 【v1.x.0】句読点ツメ対象の文字（、/。/「/」/〝/〟）— canvas-tools.js の PUNCT_TSUME_CHAR_CODES と同一定義。
// 自動配置時の bbox 推定にも反映するため、対象文字の個数だけ longest 行の effective 長を縮める。
const PUNCT_TSUME_CHARS_SCAN = new Set(["、", "。", "「", "」", "〝", "〟"]);
function countPunctTsumeCharsScan(line) {
  if (!line) return 0;
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    if (PUNCT_TSUME_CHARS_SCAN.has(line[i])) n++;
  }
  return n;
}
// 【v1.x.0】縦中横の bbox 補正用カウント。
// auto-place.js は文字数ベース（estimateLayerSize: `effective = ln.length - … - tcyPairs`）で
// 概算するため、半角・全角どちらの TCY ペアでも「2 文字 → 1 セル」として 1 ぶん引く。
// 自動配置時の bbox 縦長を「実描画セル数」に揃える目的（フレーム末尾の余白を解消）。
// canvas-tools.js (measureText 経路) は別ロジックで半角/全角の差を実測補正する。
function countTcyPairsScan(line) {
  if (!line || line.length < 2) return 0;
  let n = 0;
  for (let k = 0; k < line.length; ) {
    const ch = line[k];
    if (ch < "0" || ch > "9") {
      k += 1;
      continue;
    }
    let j = k + 1;
    while (j < line.length && line[j] >= "0" && line[j] <= "9") j++;
    if (j - k === 2) {
      n++;
    }
    k = j;
  }
  return n;
}
const TEXT_BBOX_THICK_SAFETY_EM_SCAN = 0;
const TEXT_BBOX_MULTI_LINE_THICK_SAFETY_EM_SCAN = 0.4;
const TEXT_BBOX_LONG_SAFETY_EM_SCAN = 0.4;
const TEXT_BBOX_HEURISTIC_LONG_SCALE_SCAN = 1.05;

// canvas-tools.js layerRectForNew の幅・高さ計算と同一ロジック (px は PSD 座標)。
// 【v1.x.0】句読点ツメ (`punctuationTsumePercent`) を long 軸にも反映:
//   各行の effective char count = (chars - punctCount × tsume/100)。
//   最も長い行（実 char で）の effective 長を採用。
// 【v1.x.0】縦中横（!!/!?/！！/！？）も long 軸に反映: TCY ペアあたり 1em 引く。
function estimateLayerSize(psdPage, sizePt, contents, leadingPct, direction) {
  const dpi = psdPage.dpi ?? 72;
  const ptInPsdPx = sizePt * (dpi / 72);
  const lineCount = Math.max(1, countLines(contents));
  const leadingFactor = (leadingPct ?? 125) / 100;
  const isVertical = direction !== "horizontal";
  // 縦書きは content が右端 (block-start) に寄り box 左端 = nl.x は固定のため、thick safety を
  // 足すと box 左側に余白が溜まる（layerRectForNew / scheduleBoxAutoFit と整合）。縦書きは 0 に
  // して content を nl.x まで詰める。横書きは余白が下側に出る（= 除去される）ので従来どおり。
  const thickSafety = isVertical
    ? 0
    : (lineCount > 1 ? TEXT_BBOX_MULTI_LINE_THICK_SAFETY_EM_SCAN : TEXT_BBOX_THICK_SAFETY_EM_SCAN);
  const longSafety = isVertical ? 0 : TEXT_BBOX_LONG_SAFETY_EM_SCAN;
  const longScale = isVertical ? 1 : TEXT_BBOX_HEURISTIC_LONG_SCALE_SCAN;
  const thickBase = 1 + Math.max(0, lineCount - 1) * leadingFactor;
  const thick = Math.max(24, ptInPsdPx * (thickBase + thickSafety));
  // 句読点ツメぶんを差し引いた最大行幅（em 単位）を計算
  const tsumePct = Number(getDefault("punctuationTsumePercent")) || 0;
  const tsumeMag = tsumePct > 0 ? tsumePct / 100 : 0;
  // 縦中横は縦書きレイヤー + 設定 ON のときのみ bbox 計算に反映
  const tcyEnabled = isVertical && (getDefault("tateChuYokoEnabled") !== false);
  let maxEffectiveChars = 1;
  for (const ln of String(contents ?? "").split(/\r?\n/)) {
    const punct = tsumeMag > 0 ? countPunctTsumeCharsScan(ln) : 0;
    const tcyPairs = tcyEnabled ? countTcyPairsScan(ln) : 0;
    // TCY ペア 1 個あたり 2 文字 → 1 セル幅に圧縮されるので 1em ぶん引く。
    const effective = ln.length - punct * tsumeMag - tcyPairs;
    if (effective > maxEffectiveChars) maxEffectiveChars = effective;
  }
  const hasContent = String(contents ?? "").length > 0;
  const minLongPx = isVertical && hasContent ? ptInPsdPx : ptInPsdPx * 2;
  const longRaw = Math.max(
    minLongPx,
    ptInPsdPx * (longScale * maxEffectiveChars + longSafety),
  );
  const maxLong = isVertical ? psdPage.height * 0.95 : psdPage.width * 0.95;
  const long = Math.min(longRaw, maxLong);
  return {
    width:  isVertical ? thick : long,
    height: isVertical ? long  : thick,
  };
}

// 画像スキャンエンジン (吹き出し検出側) が吹き出しごとに推定した font_size（画像スキャン 入力画像のピクセル）を、
// 対象 PSD の物理座標系での pt に換算する。
// 換算式: pt = (font_size_px × 画像→PSD スケール) × 72 / psd.dpi
//   - スケールは sx, sy の小さい方を採用（縦書き / 横書きどちらでも安全側になる）
//   - キャリブレーション係数 0.92: 検出器の font_size は em-box（行送り・上下余白を含む）
//     寄りに出る傾向があるので、グリフ相当に揃えるべく約 8% 縮める。
//     ※ あまり大きく縮めると 1 行吹き出し（検出器が比較的正確）で過小化するため控えめに。
//   - bbox 上限キャップ: 検出された吹き出しの "厚み" 軸（縦書き=横幅、横書き=縦高）から
//     leading=1.25 を仮定して em 1 つ分の物理上限を逆算。多列吹き出しでの過大検出を抑える。
//   - 自動配置は 1pt 単位にスナップ（検出器の揺れを丸めて複数吹き出しのサイズを揃える）。
//     環境設定の textSizeStep は手動 ± ボタン専用なので使わない。
//   - [6, 999] にクランプ。
//   - font_size が無効値のときは null を返してフォールバック。
const FONT_SIZE_CALIBRATION = 0.92;
const ASSUMED_LEADING_FACTOR = 1.25;

// 【v1.26.0 移植 (PsDesign-main v1.24.0)】contents 引数を追加し、行数 / 最長行文字数を
// TXT contents から導出する（block.lines は 画像スキャン 出力で実配置 TXT と乖離するため）。
// bbox 長軸 cap も追加して過大検出を抑える。
function detectSizePtFromBlock(block, referenceScanPage, psdPage, contents) {
  const fs = block?.font_size;
  if (!Number.isFinite(fs) || fs <= 0) return null;
  const sx = psdPage.width / Math.max(referenceScanPage.img_width, 1);
  const sy = psdPage.height / Math.max(referenceScanPage.img_height, 1);
  const scale = Math.min(sx, sy);
  if (!(scale > 0)) return null;
  const dpi = psdPage.dpi ?? 72;

  // 1) detector の font_size を PSD pt に換算 + 軽いキャリブレーション
  let pt = ((fs * scale) * 72) / dpi * FONT_SIZE_CALIBRATION;

  // 2) 行数 / 最長文字数は TXT 側 contents から導出する方が信頼できる (要件③)。
  //    block.lines は 画像スキャン が分割した行数で、実際に配置する TXT セリフとは乖離する
  //    ことが多い。contents 未指定時のみ block.lines にフォールバック。
  let lineCount;
  let longChars;
  if (contents != null) {
    lineCount = Math.max(1, countLines(contents));
    longChars = Math.max(1, longestLine(contents));
  } else {
    const lines = Array.isArray(block.lines) ? block.lines : [];
    lineCount = Math.max(1, lines.length);
    const maxLineLen = lines.reduce(
      (acc, ln) => Math.max(acc, typeof ln === "string" ? ln.length : 0),
      1,
    );
    longChars = maxLineLen;
  }

  // 3) bbox の "厚み" から物理的な上限 pt を算出して上から押さえる。
  //    縦書きは横幅 = (1 + (n-1) × leading) × em の関係で em を逆算。横書きは縦高で同様。
  //    1 行は denom=1（bbox とほぼ等価）、2 行は denom=2.25、3 行は 3.5 …と多列ほど厳しく。
  const isVertical = !!block.vertical;
  const thickPsdPx = isVertical
    ? (block.box[2] - block.box[0]) * sx
    : (block.box[3] - block.box[1]) * sy;
  if (Number.isFinite(thickPsdPx) && thickPsdPx > 0) {
    const denom = 1 + Math.max(0, lineCount - 1) * ASSUMED_LEADING_FACTOR;
    const maxThickPt = ((thickPsdPx / denom) * 72) / dpi;
    if (Number.isFinite(maxThickPt) && maxThickPt > 0) pt = Math.min(pt, maxThickPt);
  }

  // 4) bbox の "長軸" (縦書き=縦高, 横書き=横幅) と最長行文字数からも上限を出す。
  //    em 約 1 倍が文字幅相当と仮定して、過大検出を上から押さえる。
  const longPsdPx = isVertical
    ? (block.box[3] - block.box[1]) * sy
    : (block.box[2] - block.box[0]) * sx;
  if (Number.isFinite(longPsdPx) && longPsdPx > 0 && longChars > 0) {
    const maxLongPt = ((longPsdPx / longChars) * 72) / dpi;
    if (Number.isFinite(maxLongPt) && maxLongPt > 0) pt = Math.min(pt, maxLongPt);
  }

  if (!Number.isFinite(pt) || pt <= 0) return null;
  // 自動配置は 1pt 単位にスナップ。検出器の細かい揺れで吹き出し間サイズが
  // ばらつくのを防ぎ、複数吹き出しでサイズを揃える。
  const snapped = Math.round(pt);
  // クランプ範囲は state.js setTextSize と一致させる。
  return Math.max(6, Math.min(999, snapped));
}

// 自動配置時、吹き出し中心からテキストを下方向にずらすバイアス (em 単位)。
// 【v1.26.0 移植 (PsDesign-main v1.24.0)】UI 上の bbox 中心と植字位置を一致させるため
// 0 (バイアスなし) に固定。値を増やすほど下にずれる (UI と Photoshop 保存後で位置が乖離するので注意)。
const BUBBLE_PLACEMENT_Y_BIAS_EM = 0;

// ============================================================
// 【v1.26.0 移植 (PsDesign-main v1.24.0)】連結吹き出し検出 (要件①)
// ============================================================
// 「ひょうたん型フキダシ」 = 視覚的には 1 つの吹き出しだが、輪郭が
// 途中でくびれて 2 つの円がつながったような形状になっており、
// comic-text-detector が 2 つの独立 block として分割検出した状態を想定。
//
// bbox + font_size + vertical のメタデータから heuristic で判定する。
//
// 判定 3 条件 (すべて満たすときに同一フキダシと認定):
//   (a) vertical (縦書き / 横書き) が一致
//   (b) font_size が近い:  max/min ≤ FONT_SIZE_RATIO_THRESHOLD
//   (P1) primaryGap ≤ font_size × PRIMARY_AXIS_GAP_FACTOR
//        AND perpDiff ≤ font_size × PERP_AXIS_ALIGN_FACTOR
//   (P2) sideGap ≤ font_size × SIDE_AXIS_GAP_FACTOR
//        AND sideCenterDiff ≤ font_size × PERP_AXIS_ALIGN_FACTOR
//
// 認定グループは検出 font_size の揺れに左右されず、ユーザー指定の
// 基本フォントサイズ (defaults.sizePt) に統一する。

const FONT_SIZE_RATIO_THRESHOLD = 1.4;
const PRIMARY_AXIS_GAP_FACTOR = 5.0;
const PERP_AXIS_ALIGN_FACTOR = 2.5;
const SIDE_AXIS_GAP_FACTOR = 1.5;

function fontSizeOf(blk) {
  const fs = blk?.font_size;
  return Number.isFinite(fs) && fs > 0 ? fs : 12;
}

function pairMatchHeuristic(a, b) {
  const A = a.box, B = b.box;
  const isVertical = !!a.vertical;
  const fsA = fontSizeOf(a);
  const fsB = fontSizeOf(b);
  const fsRatio = Math.max(fsA, fsB) / Math.max(1, Math.min(fsA, fsB));
  const fsAvg = (fsA + fsB) / 2;

  let primaryGap, perpDiff, sideGap, sideCenterDiff;
  let primaryAxisLabel, sideAxisLabel;
  if (isVertical) {
    primaryGap = Math.max(0, Math.max(A[1] - B[3], B[1] - A[3]));   // Y gap (主軸)
    perpDiff = Math.abs((A[0] + A[2]) / 2 - (B[0] + B[2]) / 2);     // X 中心差
    sideGap = Math.max(0, Math.max(A[0] - B[2], B[0] - A[2]));      // X gap (側方)
    sideCenterDiff = Math.abs((A[1] + A[3]) / 2 - (B[1] + B[3]) / 2); // Y 中心差
    primaryAxisLabel = "Y gap";
    sideAxisLabel = "X gap";
  } else {
    primaryGap = Math.max(0, Math.max(A[0] - B[2], B[0] - A[2]));
    perpDiff = Math.abs((A[1] + A[3]) / 2 - (B[1] + B[3]) / 2);
    sideGap = Math.max(0, Math.max(A[1] - B[3], B[1] - A[3]));
    sideCenterDiff = Math.abs((A[0] + A[2]) / 2 - (B[0] + B[2]) / 2);
    primaryAxisLabel = "X gap";
    sideAxisLabel = "Y gap";
  }
  const primaryTol = fsAvg * PRIMARY_AXIS_GAP_FACTOR;
  const perpTol = fsAvg * PERP_AXIS_ALIGN_FACTOR;
  const sideTol = fsAvg * SIDE_AXIS_GAP_FACTOR;

  const result = {
    primaryGap, perpDiff, sideGap, sideCenterDiff,
    primaryTol, perpTol, sideTol, fsRatio,
  };

  if (!!a.vertical !== !!b.vertical) {
    return { match: false, reason: "vertical 不一致", ...result };
  }
  if (fsRatio > FONT_SIZE_RATIO_THRESHOLD) {
    return { match: false, reason: `font_size 差大 (ratio=${fsRatio.toFixed(2)})`, ...result };
  }

  const matchPrimary = primaryGap <= primaryTol && perpDiff <= perpTol;
  if (matchPrimary) {
    return { match: true, reason: "主軸ひょうたん", ...result };
  }
  const matchSide = sideGap <= sideTol && sideCenterDiff <= perpTol;
  if (matchSide) {
    return { match: true, reason: "横ひょうたん", ...result };
  }

  let reason;
  if (primaryGap > primaryTol && sideGap > sideTol) {
    reason = `両方向距離大 (${primaryAxisLabel}=${primaryGap.toFixed(0)}/${primaryTol.toFixed(0)} ${sideAxisLabel}=${sideGap.toFixed(0)}/${sideTol.toFixed(0)})`;
  } else if (primaryGap <= primaryTol) {
    reason = `主軸OKだが直交ズレ (perp=${perpDiff.toFixed(0)}/${perpTol.toFixed(0)})`;
  } else if (sideGap <= sideTol) {
    reason = `側方OKだが直交ズレ (sideCenter=${sideCenterDiff.toFixed(0)}/${perpTol.toFixed(0)})`;
  } else {
    reason = "条件未マッチ";
  }
  return { match: false, reason, ...result };
}

// blocks 各要素について「グループ ID」「グループ内 member 数 >= 2 か」を返す。
// 戻り値: { groupId: number, connected: boolean }[]  (blocks と同じ index)
function groupConnectedBlocks(blocks, debugTag = "") {
  const n = blocks.length;
  if (n === 0) return [];
  // Union-Find with path compression
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const pairLogs = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const r = pairMatchHeuristic(blocks[i], blocks[j]);
      pairLogs.push({ i, j, ...r });
      if (r.match) union(i, j);
    }
  }
  const rootToGroup = new Map();
  let nextGroupId = 0;
  const groupIds = new Array(n);
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!rootToGroup.has(r)) rootToGroup.set(r, nextGroupId++);
    groupIds[i] = rootToGroup.get(r);
  }
  const memberCount = new Array(nextGroupId).fill(0);
  for (let i = 0; i < n; i++) memberCount[groupIds[i]]++;
  const connectedGroupCount = memberCount.filter((c) => c >= 2).length;
  console.info(`[scan-place]${debugTag} blocks=${n} groups=${nextGroupId} connected_groups=${connectedGroupCount}`);
  for (let i = 0; i < n; i++) {
    const b = blocks[i].box;
    const fs = blocks[i].font_size;
    const v = blocks[i].vertical;
    console.info(
      `[scan-place]${debugTag} [block ${i}] vert=${v} fs=${fs} bbox=(${Math.round(b[0])},${Math.round(b[1])})-(${Math.round(b[2])},${Math.round(b[3])}) groupId=${groupIds[i]}${memberCount[groupIds[i]] >= 2 ? " ★連結" : ""}`,
    );
  }
  const sortedPairs = [...pairLogs].sort(
    (a, b) => Math.min(a.primaryGap, a.sideGap) - Math.min(b.primaryGap, b.sideGap),
  );
  const showCount = Math.min(sortedPairs.length, 30);
  for (let i = 0; i < showCount; i++) {
    const p = sortedPairs[i];
    const tag = p.match ? "★連結" : "単独 ";
    console.info(
      `[scan-place]${debugTag} ${tag} pair(${p.i},${p.j}): primaryGap=${p.primaryGap.toFixed(0)}/${p.primaryTol.toFixed(0)} perpDiff=${p.perpDiff.toFixed(0)}/${p.perpTol.toFixed(0)} sideGap=${p.sideGap.toFixed(0)}/${p.sideTol.toFixed(0)} sideCenter=${p.sideCenterDiff.toFixed(0)}/${p.perpTol.toFixed(0)} fsRatio=${p.fsRatio.toFixed(2)} → ${p.reason}`,
    );
  }
  if (sortedPairs.length > showCount) {
    console.info(`[scan-place]${debugTag} (... 残り ${sortedPairs.length - showCount} ペアは省略 / 距離が遠いため)`);
  }
  return groupIds.map((g) => ({ groupId: g, connected: memberCount[g] >= 2 }));
}

// 【v1.28.0 移植 (PsDesign-main v1.24.0+ / v1.25.0)】
// 見本と PSD の差分から scale + offset を Rust の compute_alignment で計算。
// mode = "mode1" (PSDに余分) / "mode2" (見本に余分) を Rust に渡す。
// PDF / JPEG / PNG に対応。失敗 / 見本未指定 は null を返してフォールバック。
let lastAlignmentError = "";

// contentScale (= k) は「OCR(見本) 1px が PSD 何 logical px に相当するか」。
// 見本がPDFの場合、OCRは PDF_RENDER_DPI(=300) でラスタライズされるため、PSDが600dpi等だと
// img_width(300dpi) と psd.width(600dpi) が別単位になり、従来の (refW-psdW)/2 は単位混在で
// ずれる。k を渡すと scale=1/k・offset=refW/2 - psdW/(2k) で dpi 差を吸収する。
// k=1 のとき従来挙動 (見本とPSDが同解像度前提) に一致する。
function computeCenterMarginAlignment(psdPage, referenceScanPage, contentScale = 1) {
  const refW = Number(referenceScanPage?.img_width);
  const refH = Number(referenceScanPage?.img_height);
  const psdW = Number(psdPage?.width);
  const psdH = Number(psdPage?.height);
  if (![refW, refH, psdW, psdH].every((v) => Number.isFinite(v) && v > 0)) return null;
  const k = (Number.isFinite(contentScale) && contentScale > 0) ? contentScale : 1;
  // newPsdC = (refC - offset) / scale を満たすよう scale=1/k, offset=refC側の中心余白。
  const scale = 1 / k;
  const offsetX = refW / 2.0 - psdW / (2.0 * k);
  const offsetY = refH / 2.0 - psdH / (2.0 * k);
  // psd_bbox / ref_bbox は診断ログ用 (配置計算では未使用)。k 換算後の見本対応領域を表す。
  const refWInPsd = refW * k;
  const refHInPsd = refH * k;
  return {
    scale,
    offset_x: offsetX,
    offset_y: offsetY,
    diff_score: 0.0,
    candidates: 1,
    psd_bbox: [
      psdW / 2.0 - refWInPsd / 2.0,
      psdH / 2.0 - refHInPsd / 2.0,
      psdW / 2.0 + refWInPsd / 2.0,
      psdH / 2.0 + refHInPsd / 2.0,
    ],
    ref_bbox: [0.0, 0.0, refW, refH],
    psd_full_size: [psdW, psdH],
    ref_full_size: [refW, refH],
    content_scale: k,
  };
}

// 見本PDFのOCRラスタライズ解像度 (src-tauri/src/ocr.rs PDF_RENDER_DPI と一致させること)。
const REFERENCE_PDF_OCR_DPI = 300;

// 【1ページ目基準】見本の解像度(dpi)は「先頭の見本ファイル」から一度だけ読み、全ページで使い回す
// (毎ページ読み込まない)。PDF見本は OCR が 300dpi 描画なので 300。画像見本は埋め込みdpi
// (JPEG JFIF / PNG pHYs) を Rust の read_reference_dpi で読む。先頭パスが変わったときだけ再取得。
let baseReferenceDpiPromise = null;
let baseReferenceDpiKey = "";
async function getBaseReferenceDpi() {
  const paths = getPdfPaths();
  const first = (Array.isArray(paths) && paths.length) ? paths[0] : null;
  const key = first || "";
  if (baseReferenceDpiKey === key && baseReferenceDpiPromise) return baseReferenceDpiPromise;
  baseReferenceDpiKey = key;
  baseReferenceDpiPromise = (async () => {
    if (!first) return null;
    if (/\.pdf$/i.test(first)) return REFERENCE_PDF_OCR_DPI; // PDFは300dpiで描画される
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const dpi = await invoke("read_reference_dpi", { path: first });
      return (Number.isFinite(dpi) && dpi > 0) ? dpi : null;
    } catch (_) {
      return null;
    }
  })();
  return baseReferenceDpiPromise;
}

// 【mode1 = PSDに余白あり / 確定式】見本とPSDの「解像度を揃えてから」中央余白計算するための
// 解像度マッチ係数 k (= 見本1px が PSD 何 logical px に相当するか = psd.dpi / 見本dpi)。
// baseRefDpi は getBaseReferenceDpi() で 1ページ目から取得した見本dpi (PDF=300, 画像=埋め込み)。
// psd.dpi または 見本dpi が不明なら揃えられないので k=1 + warn を返す (→画像差分にフォールバック)。
function resolutionMatchForMode1(referencePath, psdPage, baseRefDpi) {
  const isPdf = /\.pdf$/i.test(String(referencePath || ""));
  const psdDpi = Number(psdPage?.dpi);
  const psdDpiOk = Number.isFinite(psdDpi) && psdDpi >= 72 && psdDpi <= 4800;
  const refDpi = (Number.isFinite(baseRefDpi) && baseRefDpi > 0) ? baseRefDpi : null;
  let k = 1;
  let warn = "";
  if (psdDpiOk && refDpi != null) {
    k = psdDpi / refDpi;
    if (!(k > 0.1 && k < 10)) { k = 1; warn = `k=${(psdDpi / refDpi).toFixed(2)} が範囲外`; }
  } else if (!psdDpiOk) {
    warn = "PSDのdpi不明";
  } else if (refDpi == null) {
    warn = isPdf ? "PDF基準dpi未取得" : "見本画像に埋め込みdpiが無い";
  }
  return { k, refDpi, psdDpi: psdDpiOk ? psdDpi : null, isPdf, warn };
}

function snapHalfOrFull(pt) {
  const intPart = Math.floor(pt);
  const frac = pt - intPart;
  if (frac < 0.25) return intPart;
  if (frac < 0.75) return intPart + 0.5;
  return intPart + 1;
}

async function computeAlignmentSafe(referencePath, psdPage, referenceScanPage, pdfPageIndex = 0, mode = "mode1") {
  if (!referencePath) return null;
  if (!psdPage?.canvas) return null;
  if (mode === "mode1") {
    // 確定式(中央配置)は「見本とPSDが同解像度」が前提。解像度を確実に揃えられるのは
    // 「見本がPDF かつ PSDに正しい印刷dpiがある」ケースのみ。それ以外(画像見本 / dpi不明 /
    // 異常dpi)は確定式が中心寄りの誤配置になるため、下の画像差分(content matching)へフォールバックする。
    const baseRefDpi = await getBaseReferenceDpi();
    const rm = resolutionMatchForMode1(referencePath, psdPage, baseRefDpi);
    // 確定式が使える信頼条件: 見本dpi(1ページ目基準)とPSD印刷dpi(>=150)が両方取れ、kが妥当な範囲。
    const reliable = rm.refDpi != null && Number.isFinite(rm.psdDpi) && rm.psdDpi >= 150 && !rm.warn;
    if (reliable) {
      const alignment = computeCenterMarginAlignment(psdPage, referenceScanPage, rm.k);
      if (alignment) {
        lastAlignmentError = "";
        console.info(
          `[scan-adjust mode1/確定式] 解像度マッチ(1ページ目基準): 見本=${rm.isPdf ? "PDF" : "画像"}@${rm.refDpi}dpi → PSD@${rm.psdDpi}dpi, k=${rm.k.toFixed(4)} → scale=${alignment.scale.toFixed(4)}, offset=(${alignment.offset_x.toFixed(0)}, ${alignment.offset_y.toFixed(0)})`,
        );
        const refW = Number(referenceScanPage?.img_width);
        const refH = Number(referenceScanPage?.img_height);
        const psdW = Number(psdPage?.width);
        const psdH = Number(psdPage?.height);
        if ([refW, refH, psdW, psdH].every((v) => Number.isFinite(v) && v > 0)) {
          const aspectDiffPct = Math.abs((refW / refH) / (psdW / psdH) - 1) * 100;
          if (aspectDiffPct > 5) {
            console.warn(
              `[scan-adjust mode1] ⚠ 見本とPSDの縦横比が ${aspectDiffPct.toFixed(1)}% 異なります。確定式の前提が崩れる可能性 → 重ね調整(手動)を検討してください。`,
            );
          }
        }
        return alignment;
      }
    } else {
      // フォールバック: 画像差分で位置合わせ (解像度非依存)。下の invokeAlignment(mode="mode1") が
      // Rust 側で grid search を実行する。
      console.info(
        `[scan-adjust mode1/画像差分フォールバック] 解像度を確定できないため絵柄の重なりで位置合わせします (見本=${rm.isPdf ? "PDF" : "画像"}, psdDpi=${rm.psdDpi ?? "?"}${rm.warn ? `, ${rm.warn}` : ""})`,
      );
    }
  }
  const errors = [];
  try {
    const psdBase64 = psdPage.canvas.toDataURL("image/png");
    const refBboxes = (referenceScanPage?.blocks ?? []).map((b) => ({
      left: b.box[0], top: b.box[1], right: b.box[2], bottom: b.box[3],
    }));
    const psdBboxes = (psdPage.textLayers ?? []).map((l) => ({
      left: l.left, top: l.top, right: l.right, bottom: l.bottom,
    }));
    const { invoke } = await import("@tauri-apps/api/core");
    const invokeAlignment = (referenceImageDataBase64) => invoke("compute_alignment", {
      referencePath,
      referencePdfPageIndex: pdfPageIndex,
      referenceImageDataBase64,
      psdImageDataBase64: psdBase64,
      referenceTextBboxes: refBboxes,
      psdTextBboxes: psdBboxes,
      psdWidth: psdPage.width,
      psdHeight: psdPage.height,
      mode,
      // referenceScan 画像スキャン の入力画像サイズを Rust に渡し、
      // alignment.offset を referenceScan 単位 (= bbox 座標と同単位) で計算させる
      [`${SOURCE_DOC_KEY}ImgWidth`]: referenceScanPage?.img_width ?? null,
      [`${SOURCE_DOC_KEY}ImgHeight`]: referenceScanPage?.img_height ?? null,
    });

    const isPdfReference = /\.pdf$/i.test(referencePath);
    const isRasterReference = /\.(jpe?g|png)$/i.test(referencePath);

    if (isPdfReference) {
      const refCanvas = await renderReferencePageToCanvas(pdfPageIndex, referenceScanPage?.img_width ?? null);
      const refBase64 = refCanvas ? refCanvas.toDataURL("image/png") : null;
      if (refBase64) {
        try {
          const result = await invokeAlignment(refBase64);
          lastAlignmentError = "";
          return result;
        } catch (e) {
          errors.push(`canvas: ${String(e?.message ?? e)}`);
        }
      } else {
        errors.push("canvas: 見本ページをCanvas化できませんでした");
      }
    }

    if (isRasterReference || isPdfReference) {
      try {
        const result = await invokeAlignment(null);
        lastAlignmentError = "";
        return result;
      } catch (e) {
        errors.push(`file: ${String(e?.message ?? e)}`);
      }
    }

    if (!isPdfReference) {
      const refCanvas = await renderReferencePageToCanvas(pdfPageIndex, referenceScanPage?.img_width ?? null);
      const refBase64 = refCanvas ? refCanvas.toDataURL("image/png") : null;
      if (refBase64) {
        try {
          const result = await invokeAlignment(refBase64);
          lastAlignmentError = "";
          return result;
        } catch (e) {
          errors.push(`canvas: ${String(e?.message ?? e)}`);
        }
      } else {
        errors.push("canvas: 見本ページをCanvas化できませんでした");
      }
    }
  } catch (e) {
    errors.push(`unexpected: ${String(e?.message ?? e)}`);
  }
  lastAlignmentError = errors.join(" / ");
    console.warn(`[scan-place] compute_alignment 失敗 (${referencePath}): ${lastAlignmentError}`);
  return null;
}

async function computeAlignmentsForPages(mode, psdPages, referenceScanDoc, referencePaths, { progressLabel = null, progressFlow = null } = {}) {
  if (mode !== "mode1" && mode !== "mode2") return new Map();
  const alignmentByPath = new Map();
  const isSinglePdfMultiPsd = referencePaths.length === 1
    && /\.pdf$/i.test(referencePaths[0])
    && psdPages.length > 1;
  const psdPageMap = buildPsdPageMap(psdPages, referenceScanDoc?.pages?.length ?? 0);
  const N = isSinglePdfMultiPsd
    ? psdPages.length
    : Math.min(psdPages.length, referencePaths.length);
  if (progressLabel) {
    updateProgress(withProgressFlow(progressFlow, { current: 0, total: Math.max(N, 1), detail: `${progressLabel} 0/${N}`, showCount: false }));
  }
  // 【高速化・1ページ目基準】位置合わせ(scale+offset)は判型/塗り足し/解像度が同じなら全ページ同一。
  // 同じ寸法 (PSD寸法 × 見本寸法) のページは最初の1回だけ計算し、以降は使い回して画像差分の
  // 重い再計算を避ける。寸法が違うページ (見開き等) だけ個別に計算する。
  const geomCache = new Map();
  for (let i = 0; i < N; i++) {
    const psd = psdPages[i];
    const referenceIndex = referenceIndexForPsdRow(psdPageMap, i);
    const refEntry = isSinglePdfMultiPsd ? referencePaths[0] : referencePaths[i];
    const refPath = typeof refEntry === "string" ? refEntry : refEntry?.path;
    const pdfPageIdx = Number.isInteger(refEntry?.pdfPageIndex)
      ? refEntry.pdfPageIndex
      : (isSinglePdfMultiPsd ? referenceIndex : 0);
    const referenceScan = referenceScanDoc?.pages?.[referenceIndex] ?? { blocks: [] };
    if (progressLabel) {
      updateProgress(withProgressFlow(progressFlow, { current: i, total: N, detail: `${progressLabel} ${i + 1}/${N} を計算中…`, showCount: false }));
    }
    const geomSig = `${psd?.width}x${psd?.height}|${referenceScan?.img_width}x${referenceScan?.img_height}`;
    let alignment;
    if (geomCache.has(geomSig)) {
      alignment = geomCache.get(geomSig);
    } else {
      alignment = await computeAlignmentSafe(refPath, psd, referenceScan, pdfPageIdx, mode);
      geomCache.set(geomSig, alignment);
    }
    if (alignment && psd?.path) alignmentByPath.set(psd.path, alignment);
    if (progressLabel) {
      updateProgress(withProgressFlow(progressFlow, { current: i + 1, total: N, detail: `${progressLabel} ${i + 1}/${N} 完了`, showCount: false }));
    }
  }
  return alignmentByPath;
}

function getLoadedReferenceEntryForPage(index) {
  const doc = getPdfDoc();
  if (doc && typeof doc.getSourcePath === "function") {
    const virtualPage = getPdfVirtualPageAt(index);
    const physicalPageNum = virtualPage?.pageNum ?? (index + 1);
    const pageNum = typeof doc.getSourcePageNum === "function" ? doc.getSourcePageNum(physicalPageNum) : 1;
    const path = doc.getSourcePath(physicalPageNum);
    return path ? { path, pdfPageIndex: Math.max(0, (Number(pageNum) || 1) - 1) } : null;
  }
  return null;
}

function mapBlockToNewLayer(block, referenceScanPage, psdPage, contents, defaults, sourceTxtRef, groupInfo, alignment) {
  const sx = psdPage.width / Math.max(referenceScanPage.img_width, 1);
  const sy = psdPage.height / Math.max(referenceScanPage.img_height, 1);
  const direction = block.vertical ? "vertical" : "horizontal";
  // bubble bbox の中心を PSD 座標に変換 → "ユーザーがクリックした位置" と等価。
  // 【v1.28.0 移植】alignment があれば Rust 計算済みの scale + offset で逆変換、
  // なければ従来通り見本 / PSD のフルサイズ比率で単純スケール。
  let cx, cy;
  if (alignment && Number.isFinite(alignment.scale) && alignment.scale > 0) {
    const refCx = (block.box[0] + block.box[2]) / 2;
    const refCy = (block.box[1] + block.box[3]) / 2;
    cx = (refCx - alignment.offset_x) / alignment.scale;
    cy = (refCy - alignment.offset_y) / alignment.scale;
  } else {
    cx = ((block.box[0] + block.box[2]) / 2) * sx;
    cy = ((block.box[1] + block.box[3]) / 2) * sy;
  }
  // 縦書きレイヤーは設定 verticalHalfToFullEnabled (default true) に従い、
  // 半角英数字 (0-9 / A-Z / a-z) を全角に自動変換する。
  // bbox 推定は変換後テキストで行うため、文字幅差は影響しない（char count ベース）。
  const rubyParsed = parseRubyAnnotatedText(contents ?? "", { promoteInlineNakaguro: direction === "vertical" });
  const text = normalizePunctuationSpaceReplacement(
    convertHalfToFullForVertical(rubyParsed.text, direction),
    defaults.punctuationSpaceReplacementEnabled,
  );
  const charRubies = rubyParsed.charRubies;
  // 【v1.26.0 移植 (PsDesign-main v1.24.0 要件①)】
  // 連結グループに属するブロック (member >= 2) はサイズを基本フォントサイズに統一。
  // 検出 font_size の揺れで連結セリフ間のサイズがバラつくのを防ぐ。
  // 単独ブロックは従来通り detectSizePtFromBlock の検出値、無効なら defaults にフォールバック。
  // contents を渡すことで、検出側ロジックが TXT 行数 / 最長行文字数を使って bbox から
  // em を逆算できる (block.lines より信頼度高) → 要件③ の精度改善。
  let sizePt;
  if (groupInfo && groupInfo.connected) {
    sizePt = defaults.sizePt ?? 24;
  } else {
    const detectedPt = detectSizePtFromBlock(block, referenceScanPage, psdPage, text);
    sizePt = detectedPt ?? defaults.sizePt ?? 24;
  }
  if (defaults.positionAdjustMode === "mode2" && alignment && Number.isFinite(alignment.scale) && alignment.scale > 0) {
    const autoSx = psdPage.width / Math.max(referenceScanPage.img_width, 1);
    const sizeCorrectionFactor = 1.0 / (autoSx * alignment.scale);
    if (Number.isFinite(sizeCorrectionFactor) && sizeCorrectionFactor > 0
        && Math.abs(sizeCorrectionFactor - 1.0) > 0.02) {
      const snapped = snapHalfOrFull(sizePt * sizeCorrectionFactor);
      if (Number.isFinite(snapped) && snapped >= 6 && snapped <= 999) sizePt = snapped;
    }
  }
  const { width, height } = estimateLayerSize(
    psdPage, sizePt, text, defaults.leadingPct ?? 125, direction,
  );
  // 下方向バイアス: ptInPsdPx 換算で BUBBLE_PLACEMENT_Y_BIAS_EM em ぶん下げる。
  const dpi = psdPage.dpi ?? 72;
  const ptInPsdPx = sizePt * (dpi / 72);
  const yBias = ptInPsdPx * BUBBLE_PLACEMENT_Y_BIAS_EM;
  const x = cx - width / 2;
  const y = cy - height / 2 + yBias;

  // ============================================================
  // 【v1.26.0 移植 (PsDesign-main v1.24.0)】
  // 周辺解析メタデータに基づくスタイル自動選択 (要件 ②, ④)
  // ============================================================
  // Rust 側 (extract.rs analyze_doc_in_place) が各 block の bbox 外周を解析し以下を埋めている:
  //   surroundingWhiteRatio       (0..1) 白率
  //   surroundingEdgeChanges      (int)  1 周合計の白↔黒変化数
  //   surroundingMinSegmentEdgeChanges (int) 4 セグメント中の最小変化数
  let strokeColor = defaults.strokeColor;
  let fontPostScriptName = defaults.fontPostScriptName;
  let autoFontSwitched = false;
  let autoFontSwitchBucket = -1;

  // (要件②) 白率 < 閾値 → 描画上 → 白フチ自動付与
  // ユーザーが defaults で別の strokeColor を選んでいる場合は上書きせず尊重。
  let appliedStroke = false;
  if (defaults.autoStrokeEnabled
      && (strokeColor === "none" || strokeColor == null)
      && Number.isFinite(block?.surroundingWhiteRatio)
      && block.surroundingWhiteRatio < (defaults.autoStrokeWhiteRatioThreshold ?? 0.7)) {
    strokeColor = "white";
    appliedStroke = true;
  }

  // (要件④) 背景スコア / ウニスコア の合成最大値 ≥ 閾値 (デフォルト 50% = 0.5) で
  //   中丸ゴシックに切替。bucket = 10% 刻みの 6 段階で UI 色分け。
  //   背景スコア = 1 - white_ratio       (周囲が黒いほど高い)
  //   ウニスコア = min(min_seg / 6, 1)   (4 セグメントすべてに凹凸が分布するほど高い)
  // 切替先 PS 名が空のときは何もしない。
  let scoreReason = null;
  let bgScore = 0;
  let uniScore = 0;
  if (defaults.cloudShapeFontEnabled && defaults.cloudShapeFontPostScriptName) {
    const wr = block?.surroundingWhiteRatio;
    const ms = block?.surroundingMinSegmentEdgeChanges;
    if (Number.isFinite(wr)) bgScore = Math.max(0, Math.min(1, 1 - wr));
    if (Number.isFinite(ms)) uniScore = Math.max(0, Math.min(1, ms / 6));
    const score = Math.max(bgScore, uniScore);
    const threshold = defaults.cloudShapeScoreThreshold ?? 0.5;
    const bucket = Math.max(0, Math.min(5, Math.floor((score * 100 - 50) / 10)));
    if (score >= threshold && bucket >= 1) {
      fontPostScriptName = defaults.cloudShapeFontPostScriptName;
      autoFontSwitched = true;
      // bucket: 50-59 → 0, 60-69 → 1, 70-79 → 2, 80-89 → 3, 90-99 → 4, 100 → 5
      autoFontSwitchBucket = bucket;
      const pct = Math.round(score * 100);
      scoreReason = bgScore >= uniScore ? `背景(${pct}%)` : `ウニ(${pct}%)`;
    }
  }

  // デバッグログ
  const wrStr = Number.isFinite(block?.surroundingWhiteRatio)
    ? block.surroundingWhiteRatio.toFixed(2) : "-";
  const ecStr = Number.isFinite(block?.surroundingEdgeChanges)
    ? block.surroundingEdgeChanges : "-";
  const msStr = Number.isFinite(block?.surroundingMinSegmentEdgeChanges)
    ? block.surroundingMinSegmentEdgeChanges : "-";
  const tags = [];
  if (appliedStroke) tags.push("白フチ");
  if (scoreReason) tags.push(`★${scoreReason}→${fontPostScriptName}`);
  console.info(
    `[scan-place] surround page=${(sourceTxtRef?.pageNumber ?? "?")} idx=${sourceTxtRef?.paragraphIndex ?? "?"} white=${wrStr} edge=${ecStr} minSeg=${msStr} bg=${bgScore.toFixed(2)} uni=${uniScore.toFixed(2)} ${tags.length ? "[" + tags.join(", ") + "]" : "[default]"}`,
  );

  const layer = {
    psdPath: psdPage.path,
    x,
    y,
    contents: text,
    direction,
    fontPostScriptName,
    sizePt,
    leadingPct: defaults.leadingPct,
    strokeColor,
    strokeWidthPx: defaults.strokeWidthPx,
    fillColor: defaults.fillColor,
    sourceTxtRef,
    charRubies,
    lineLeadings: rubyLineLeadingsForText(text, charRubies),
    autoFontSwitched,        // UI で色強調するためのフラグ
    autoFontSwitchBucket,    // 0..5 の 10% 刻みバケット (UI 色分け用)、-1 は未切替
  };
  return fitAutoPlaceLayerToGuideFrame(psdPage, layer);
}

// 吹き出しに対応しない「余り TXT 段落」を PSD ページの幾何中心 (width/2, height/2)
// に配置する。ユーザーが PSD 未読込時にテキストを追加したケース、または 画像スキャン の
// 吹き出し検出数より原稿段落が多いケースで使う（旧仕様では `leftoverTxt` として
// 捨てていたが、画像中央に置くことで全段落を必ず配置に乗せる）。
// direction は吹き出し情報がないため `getNewTextDirection()` (UI トグル) を採用。
function mapTxtToPageCenter(psdPage, contents, defaults, sourceTxtRef) {
  const direction = getNewTextDirection();
  const rubyParsed = parseRubyAnnotatedText(contents ?? "", { promoteInlineNakaguro: direction === "vertical" });
  const text = normalizePunctuationSpaceReplacement(
    convertHalfToFullForVertical(rubyParsed.text, direction),
    defaults.punctuationSpaceReplacementEnabled,
  );
  const charRubies = rubyParsed.charRubies;
  const sizePt = defaults.sizePt ?? 24;
  const { width, height } = estimateLayerSize(
    psdPage, sizePt, text, defaults.leadingPct ?? 125, direction,
  );
  // PSD ページの幾何中心 (width/2, height/2) を bbox 中央に合わせる top-left に変換。
  const x = psdPage.width / 2 - width / 2;
  const y = psdPage.height / 2 - height / 2;
  const layer = {
    psdPath: psdPage.path,
    x,
    y,
    contents: text,
    direction,
    fontPostScriptName: defaults.fontPostScriptName,
    sizePt,
    leadingPct: defaults.leadingPct,
    strokeColor: defaults.strokeColor,
    strokeWidthPx: defaults.strokeWidthPx,
    fillColor: defaults.fillColor,
    sourceTxtRef,
    charRubies,
    lineLeadings: rubyLineLeadingsForText(text, charRubies),
  };
  return fitAutoPlaceLayerToGuideFrame(psdPage, layer);
}

// ============================================================
// 配置プラン構築
// ============================================================
// 戻り値:
//   {
//     pages: [
//       {
//         pageIndex,    // 1-based
//         psdName,      // 表示用ファイル名
//         bubbleCount,  // 検出吹き出し数
//         txtCount,     // TXT ブロック数
//         placedCount,  // 実際に配置するペア数
//         status,       // "ok" | "warn-bubble-extra" | "warn-empty-txt" | "warn-empty-bubble"
//         layers,       // NewLayer 配列 (placedCount 件)
//         leftoverTxt,  // 余り TXT ブロック配列
//         leftoverBubbles, // 余り吹き出しの 画像スキャン テキスト配列
//       }, ...
//     ],
//     totals: { placed, leftoverTxt, leftoverBubbles },
//   }
function parseRubyAnnotatedText(raw, options = {}) {
  const input = String(raw ?? "");
  const charRubies = {};
  let text = "";
  let last = 0;
  const re = /｛([^｛｝]+)｝（([^（）]+)）|\{([^{}]+)\}\(([^()]+)\)|\[([^\[\]]+)\]\(([^()]+)\)/g;
  let match;
  while ((match = re.exec(input)) !== null) {
    text += input.slice(last, match.index);
    const parentRaw = match[1] ?? match[3] ?? match[5] ?? match[7] ?? "";
    const rubyRaw = String(match[2] ?? match[4] ?? match[6] ?? match[8] ?? "");
    const parentText = String(parentRaw).replace(/[ \t\u3000]+/g, "");
    const rubyText = rubyRaw.trim().replace(/[\t\u3000]+/g, " ").replace(/ +/g, " ");
    if (parentText && rubyText && rubyText !== "...") {
      const start = text.length;
      text += parentText;
      const normalizedRubyText = normalizeAnnotatedRubyText(rubyText, parentText);
      const rubyParts = rubyText.split(/[ \u3000]+/).filter(Boolean);
      const rubyHasSpaces = /[ \t\u3000]/.test(rubyRaw);
      const rubyType = rubyHasSpaces && rubyParts.length === Array.from(parentText).length
        ? "mono"
        : "group";
      charRubies[String(start)] = {
        end: start + parentText.length,
        text: normalizedRubyText,
        type: rubyType,
        scale: rubyScaleForAnnotatedText(normalizedRubyText),
      };
    } else {
      text += match[0];
    }
    last = match.index + match[0].length;
  }
  text += input.slice(last);
  if (options?.promoteInlineNakaguro) {
    return promoteInlineNakaguroToRuby(text, charRubies);
  }
  return { text, charRubies };
}

function promoteInlineNakaguroToRuby(text, charRubies) {
  const chars = Array.from(String(text ?? ""));
  if (!chars.some(isNakaguroChar)) return { text, charRubies };

  const removed = new Set();
  const marks = [];
  let i = 0;
  while (i < chars.length) {
    if (!isNakaguroChar(chars[i])) {
      i += 1;
      continue;
    }
    const runStart = i;
    while (i < chars.length && isNakaguroChar(chars[i])) i += 1;
    const runEnd = i;
    const prev = runStart - 1;
    const next = runEnd;
    if (isInlineNakaguroParentChar(chars[prev]) && isInlineNakaguroParentChar(chars[next])) {
      for (let j = runStart; j < runEnd; j += 1) removed.add(j);
      marks.push({ prev, next });
    }
  }
  if (removed.size === 0) return { text, charRubies };

  const boundaryMap = new Array(chars.length + 1);
  let newLen = 0;
  for (let old = 0; old <= chars.length; old += 1) {
    boundaryMap[old] = newLen;
    if (old < chars.length && !removed.has(old)) newLen += 1;
  }
  const nextText = chars.filter((_, idx) => !removed.has(idx)).join("");
  const nextRubies = {};
  for (const [key, entry] of Object.entries(charRubies ?? {})) {
    const start = Number(key);
    const end = Number(entry?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const mappedStart = boundaryMap[Math.max(0, Math.min(chars.length, start))];
    const mappedEnd = boundaryMap[Math.max(0, Math.min(chars.length, end))];
    if (!Number.isFinite(mappedStart) || !Number.isFinite(mappedEnd) || mappedEnd <= mappedStart) continue;
    nextRubies[String(mappedStart)] = { ...entry, end: mappedEnd };
  }
  for (const mark of marks) {
    const start = boundaryMap[mark.prev];
    const end = boundaryMap[mark.next] + 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    addInlineNakaguroRuby(nextRubies, start, end);
  }
  return { text: nextText, charRubies: nextRubies };
}

function addInlineNakaguroRuby(map, from, to) {
  const text = "\u30fb".repeat(Math.max(1, to - from));
  for (const key of Object.keys(map)) {
    const start = Number(key);
    const entry = map[key];
    const end = Number(entry?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (from < end && to > start) {
      const overlays = Array.isArray(entry.overlays) ? entry.overlays.slice() : [];
      const sameIndex = overlays.findIndex((overlay) =>
        Number(overlay?.start) === from
        && Number(overlay?.end) === to
        && isNakaguroRubyText(overlay?.text));
      const overlay = { start: from, end: to, text, type: "group", scale: 100 };
      if (sameIndex >= 0) overlays[sameIndex] = overlay;
      else overlays.push(overlay);
      map[key] = { ...entry, overlays };
      return;
    }
  }
  map[String(from)] = { end: to, text, type: "group", scale: 100 };
}

function isInlineNakaguroParentChar(ch) {
  if (typeof ch !== "string" || ch.length === 0) return false;
  if (/[\r\n\s\u3000]/.test(ch)) return false;
  return !/[、。，．.,!?！？…ー\-()（）「」『』【】［］\[\]〈〉《》]/.test(ch);
}

function normalizeAnnotatedRubyText(rubyText, parentText) {
  if (!isNakaguroRubyTextLoose(rubyText)) return rubyText;
  const parentCount = Array.from(String(parentText ?? "")).length;
  return "\u30fb".repeat(Math.max(1, parentCount));
}

function rubyScaleForAnnotatedText(rubyText) {
  return isNakaguroRubyTextLoose(rubyText) ? 100 : 50;
}

function isNakaguroChar(ch) {
  const code = String(ch ?? "").codePointAt(0);
  return code === 0x30fb || code === 0xff65;
}

function isNakaguroRubyText(text) {
  const chars = Array.from(String(text ?? ""));
  if (chars.length === 0) return false;
  return chars.every(isNakaguroChar);
}

function isNakaguroRubyTextLoose(text) {
  const chars = Array.from(String(text ?? "").replace(/[ \t\u3000]+/g, ""));
  if (chars.length === 0) return false;
  return chars.every(isNakaguroChar);
}

function isDakutenRubyText(text) {
  const chars = Array.from(String(text ?? ""));
  if (chars.length === 0) return false;
  return chars.every((ch) => {
    const code = ch.codePointAt(0);
    return code === 0x309b || code === 0xff9e || code === 0x3099;
  });
}

function rubyLineLeadingsForText(text, charRubies) {
  const out = {};
  if (!charRubies || Object.keys(charRubies).length === 0) return out;
  const rubyLeadingPct = Number(getDefault("rubyLeadingPct")) || 150;
  for (const key of Object.keys(charRubies)) {
    if (isDakutenRubyText(charRubies[key]?.text)) continue;
    const start = Number(key);
    if (!Number.isFinite(start)) continue;
    const parentLineIndex = String(text ?? "").slice(0, start).split(/\r\n|\r|\n/).length - 1;
    // frontend と Photoshop の両方とも index は「親文字行 - 1」に lineLeadings
    // を入れる仕様（canvas-tools.js renderInnerText: overrides[i-1] を行 i の
    // marginBlockStart に適用）。これで親文字行の上に余白が広がりルビ用スペースが
    // 確保される。0 行目にルビを振った場合は前の行が無いので skip。
    const targetLineIndex = parentLineIndex - 1;
    if (targetLineIndex >= 0) out[targetLineIndex] = rubyLeadingPct;
  }
  return out;
}

const PLACEMENT_DASH_MARK = "\uE000";
const PLACEMENT_DASH_LIKE_RE = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D\uFF70\u30FC\u2500-\u2503|｜]/g;

function normalizePlacementText(value) {
  return parseRubyAnnotatedText(value).text
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\s\u3000]+/g, "")
    .replace(PLACEMENT_DASH_LIKE_RE, PLACEMENT_DASH_MARK)
    .replace(/[、。，．.,!?！？・…ー\-()（）「」『』【】［］\[\]〈〉《》]/g, "")
    .trim();
}

function isDashOnlyPlacementText(value) {
  const normalized = normalizePlacementText(value);
  return normalized.length > 0 && [...normalized].every((ch) => ch === PLACEMENT_DASH_MARK);
}

function getBlockText(block) {
  if (!block) return "";
  if (Array.isArray(block.lines)) return block.lines.join("\n");
  if (typeof block.text === "string") return block.text;
  if (typeof block.contents === "string") return block.contents;
  return "";
}

function lcsLength(a, b) {
  if (!a || !b) return 0;
  const prev = new Array(b.length + 1).fill(0);
  const cur = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1] + 1
        : Math.max(prev[j], cur[j - 1]);
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = cur[j];
  }
  return prev[b.length];
}

function charOverlapScore(a, b) {
  if (!a || !b) return 0;
  const counts = new Map();
  for (const ch of b) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let hit = 0;
  for (const ch of a) {
    const n = counts.get(ch) ?? 0;
    if (n > 0) {
      hit += 1;
      counts.set(ch, n - 1);
    }
  }
  return (2 * hit) / (a.length + b.length);
}

function textSimilarityScore(aRaw, bRaw) {
  const a = normalizePlacementText(aRaw);
  const b = normalizePlacementText(bRaw);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const shorter = Math.min(a.length, b.length);
  const longer = Math.max(a.length, b.length);
  const contain = (a.includes(b) || b.includes(a)) ? shorter / longer : 0;
  const lcs = lcsLength(a, b) / longer;
  const overlap = charOverlapScore(a, b);
  return Math.max(contain, lcs * 0.72 + overlap * 0.28);
}

function lowPlacementMatchScore(txt, extract) {
  const len = Math.min(normalizePlacementText(txt).length, normalizePlacementText(extract).length);
  if (isDashOnlyPlacementText(txt)) return 0.9;
  if (len <= 2) return 0.72;
  if (len <= 4) return 0.58;
  if (len <= 8) return 0.46;
  return 0.38;
}

function assignBlocksToTxt(txtBlocks, sortedBlocks) {
  const entries = sortedBlocks.map((block, index) => ({ block, index, text: getBlockText(block) }));
  const candidates = [];
  for (let txtIndex = 0; txtIndex < txtBlocks.length; txtIndex += 1) {
    for (const entry of entries) {
      candidates.push({
        txtIndex,
        entry,
        score: textSimilarityScore(txtBlocks[txtIndex], entry.text),
      });
    }
  }
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ad = Math.abs(a.entry.index - a.txtIndex);
    const bd = Math.abs(b.entry.index - b.txtIndex);
    if (ad !== bd) return ad - bd;
    if (a.txtIndex !== b.txtIndex) return a.txtIndex - b.txtIndex;
    return a.entry.index - b.entry.index;
  });
  const usedTxt = new Set();
  const usedBlock = new Set();
  const assigned = new Array(txtBlocks.length).fill(null);
  const rejectedMatches = [];
  const rejectedTxt = new Set();
  for (const candidate of candidates) {
    if (usedTxt.has(candidate.txtIndex) || usedBlock.has(candidate.entry.index)) continue;
    const lowThreshold = lowPlacementMatchScore(txtBlocks[candidate.txtIndex], candidate.entry.text);
    if (isDashOnlyPlacementText(txtBlocks[candidate.txtIndex]) && candidate.score < lowThreshold) continue;
    const risk = assessOcrRisk(txtBlocks[candidate.txtIndex], candidate.entry.text);
    if (risk.risky) {
      if (!rejectedTxt.has(candidate.txtIndex) && candidate.score >= lowThreshold) {
        rejectedTxt.add(candidate.txtIndex);
        rejectedMatches.push({
          txtIndex: candidate.txtIndex,
          entry: candidate.entry,
          score: candidate.score,
          risk,
        });
      }
      continue;
    }
    assigned[candidate.txtIndex] = {
      ...candidate.entry,
      score: candidate.score,
      lowConfidence: candidate.score < lowThreshold,
    };
    usedTxt.add(candidate.txtIndex);
    usedBlock.add(candidate.entry.index);
  }
  return { assigned, rejectedMatches };
}

// 配置用の「見開きグループ」を返す。各 group = { key, pageNumbers:[..], blocks:[..] }。
//   - マーカー無し: 全文を 1 グループ (pageNumbers:[1]) にまとめる（旧仕様＝1 ページ目扱い）。
//   - 単一ページマーカー <<5Page>>: pageNumbers:[5] の単独グループ。
//   - 見開きマーカー <<2,3Page>>: pageNumbers:[2,3] の 1 グループ（構成単ページ PSD をまとめて扱う）。
function buildPlacementGroups(parsed) {
  if (!parsed?.hasMarkers) {
    return [{ key: 1, pageNumbers: [1], blocks: parsed?.all ?? [] }];
  }
  return Array.isArray(parsed.groups) ? parsed.groups : [];
}

function buildTxtPageMapForSync(parsed) {
  return parsed.hasMarkers ? parsed.byPage : new Map([[1, parsed.all]]);
}

function stripFileExt(name) {
  return String(name ?? "").replace(/\.[^.\\/]+$/, "");
}

// PSD ファイル名からページ番号を推定する。NFKC 正規化（全角数字/全角カンマ→半角）後、
//  1) 先頭の見開き表記「数字 + 区切り(, ， 、 _ - 空白) + 数字」（後続文字可。例: "2,3" "2、3" "004_005" "2-3"）
//  2) 先頭の単ページ表記「数字」（後続に日本語等が付いてもよい。例: "4修正版" "1p修正版" "11"）
//  3) 旧来の末尾アンカー（"page_05" / "ch_04_05" など数字が末尾にある命名）
// の順で解釈し、いずれも外れたら fallback ページ番号を返す。
function parsePsdPageNumbersFromPath(path, fallbackPageNumber) {
  const name = stripFileExt(baseName(path ?? "")).normalize("NFKC");
  // 1) 先頭の見開き表記。
  const spread = name.match(/^\s*(\d{1,4})\s*[,，、_\-\s]\s*(\d{1,4})/);
  if (spread) {
    const a = parseInt(spread[1], 10);
    const b = parseInt(spread[2], 10);
    if (Number.isInteger(a) && a > 0 && Number.isInteger(b) && b > 0) {
      if (a === b) return [a];
      if (Math.abs(b - a) === 1) return [a, b];
    }
  }
  // 2) 先頭の単ページ表記（"4修正版" のように先頭数字＋後続文字を拾う）。
  const leading = name.match(/^\s*(\d{1,4})/);
  if (leading) {
    const n = parseInt(leading[1], 10);
    if (Number.isInteger(n) && n > 0) return [n];
  }
  // 3) 旧来: 数字が末尾にある命名。
  const tail = name.match(/(?:^|_)(\d{1,4})(?:[_\s]+(\d{1,4}))?$/)
    ?? name.match(/^(\d{1,4})(?:[\-\s]+(\d{1,4}))?$/);
  if (tail) {
    const nums = [tail[1], tail[2]]
      .filter(Boolean)
      .map((v) => parseInt(v, 10))
      .filter((v) => Number.isInteger(v) && v > 0);
    if (nums.length === 2) {
      if (nums[0] === nums[1]) return [nums[0]];
      if (Math.abs(nums[1] - nums[0]) === 1) return nums;
      return [fallbackPageNumber];
    }
    if (nums.length === 1) return nums;
  }
  return [fallbackPageNumber];
}

function buildPsdPageMap(psdPages, referencePageCount = 0) {
  const pageNumbersByPsdIndex = psdPages.map((psd, index) => {
    if (Number.isInteger(psd?.logicalPageNumber) && psd.logicalPageNumber > 0) {
      return [psd.logicalPageNumber];
    }
    const nums = parsePsdPageNumbersFromPath(psd?.sourcePath ?? psd?.path, index + 1);
    if (nums.length >= 2 && psd?.splitSide === "right") return [nums[0]];
    if (nums.length >= 2 && psd?.splitSide === "left") return [nums[1]];
    return nums;
  });
  const logicalPageNumbers = [...new Set(
    pageNumbersByPsdIndex.flat().filter((n) => Number.isInteger(n) && n > 0),
  )].sort((a, b) => a - b);
  const pageToPsdIndices = new Map();
  let logicalMaxPage = 0;
  let hasSpreadPsd = false;
  let hasLogicalMismatch = false;
  for (let index = 0; index < pageNumbersByPsdIndex.length; index += 1) {
    const nums = pageNumbersByPsdIndex[index];
    if (nums.length > 1) hasSpreadPsd = true;
    if (nums.length !== 1 || nums[0] !== index + 1) hasLogicalMismatch = true;
    for (const pageNumber of nums) {
      logicalMaxPage = Math.max(logicalMaxPage, pageNumber);
      const arr = pageToPsdIndices.get(pageNumber) ?? [];
      arr.push(index);
      pageToPsdIndices.set(pageNumber, arr);
    }
  }
  if (!(logicalMaxPage > 0)) logicalMaxPage = psdPages.length;
  const usedPsdIndices = new Set();
  for (const [pageNumber, indices] of pageToPsdIndices.entries()) {
    const preferred = indices.find((idx) => psdPages[idx]?.logicalPageNumber === pageNumber)
      ?? indices.find((idx) => {
        const psd = psdPages[idx];
        const nums = parsePsdPageNumbersFromPath(psd?.sourcePath ?? psd?.path, idx + 1);
        return (psd?.splitSide === "right" && nums[0] === pageNumber)
          || (psd?.splitSide === "left" && nums[1] === pageNumber);
      })
      ?? indices[0];
    pageToPsdIndices.set(pageNumber, [preferred]);
    usedPsdIndices.add(preferred);
  }
  // 見本（referenceScanDoc.pages）と PSD/論理ページの対応付け方針:
  //  - 枚数一致（見本=PSD）のときは位置対応(1:1)を最優先し、論理マッピングは使わない。
  //    （途中見開きが両側で同数に分割される通常ケースはこれで正しく揃う）
  //  - 論理マッピングを使うのは見開き/論理ずれがあり、かつ枚数が一致せず、見本が
  //    「論理最大ページまでの連番（フル）」または「現存ページぶんに圧縮」されているとき。
  //  - 見本がフル（>= 論理最大ページ）なら割り当ては実ページ番号 N→index N-1。
  //    見本が圧縮（飛番なし連番の現存ぶん）なら従来どおりランク（logicalPageNumbers 内の順位）。
  //    これにより「見本が飛番」「PSD が歯抜け（欠番）」でも誤対応しにくくする。
  const psdCount = psdPages.length;
  const referenceCoversLogicalMax = logicalMaxPage > 0 && referencePageCount >= logicalMaxPage;
  const referenceCoversCompacted = referencePageCount >= (logicalPageNumbers.length || psdCount);
  const countsMatch = psdCount > 0 && referencePageCount === psdCount;
  const referenceIndexByLogicalPage = new Map(
    referenceCoversLogicalMax
      ? logicalPageNumbers.map((pageNumber) => [pageNumber, pageNumber - 1])
      : logicalPageNumbers.map((pageNumber, index) => [pageNumber, index]),
  );
  const referenceUsesLogicalPages = !countsMatch
    && (hasSpreadPsd || hasLogicalMismatch)
    && (referenceCoversLogicalMax || referenceCoversCompacted);
  return {
    pageNumbersByPsdIndex,
    logicalPageNumbers,
    pageToPsdIndices,
    logicalMaxPage,
    hasSpreadPsd,
    hasLogicalMismatch,
    usedPsdIndices,
    referencePageCountByOrder: logicalPageNumbers.length || psdPages.length,
    referenceIndexByLogicalPage,
    referenceUsesLogicalPages,
  };
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  if (max < min) return min;
  return Math.max(min, Math.min(max, value));
}

function isTextFitEnabled() {
  return getDefault("textFitEnabled") !== false;
}

function guideFrameForPage(page) {
  if (!page?.path) return null;
  const guides = getGuides(page.path);
  const h = (Array.isArray(guides?.h) ? guides.h : [])
    .filter(Number.isFinite)
    .map((v) => clampNumber(v, 0, page.height))
    .sort((a, b) => a - b);
  const v = (Array.isArray(guides?.v) ? guides.v : [])
    .filter(Number.isFinite)
    .map((x) => clampNumber(x, 0, page.width))
    .sort((a, b) => a - b);
  if (h.length < 2 || v.length < 2) return null;
  const top = h[0];
  const bottom = h[h.length - 1];
  const left = v[0];
  const right = v[v.length - 1];
  if (!(right > left && bottom > top)) return null;
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function autoPlaceLayerRect(psdPage, layer) {
  const size = estimateLayerSize(
    psdPage,
    layer.sizePt ?? 24,
    layer.contents ?? "",
    layer.leadingPct ?? 125,
    layer.direction ?? "vertical",
  );
  return {
    left: layer.x ?? 0,
    top: layer.y ?? 0,
    right: (layer.x ?? 0) + size.width,
    bottom: (layer.y ?? 0) + size.height,
    width: size.width,
    height: size.height,
  };
}

function fitAutoPlaceLayerToGuideFrame(psdPage, layer) {
  if (!isTextFitEnabled()) return layer;
  const frame = guideFrameForPage(psdPage);
  if (!frame || !layer) return layer;
  let next = { ...layer };
  let rect = autoPlaceLayerRect(psdPage, next);
  const scale = Math.min(
    1,
    frame.width / Math.max(rect.width, 1),
    frame.height / Math.max(rect.height, 1),
  );
  if (scale < 0.999 && Number.isFinite(next.sizePt) && next.sizePt > 6) {
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    next.sizePt = Math.max(6, snapHalfOrFull(next.sizePt * scale));
    rect = autoPlaceLayerRect(psdPage, next);
    next.x = centerX - rect.width / 2;
    next.y = centerY - rect.height / 2;
    rect = autoPlaceLayerRect(psdPage, next);
  }
  next.x = rect.width <= frame.width
    ? clampNumber(rect.left, frame.left, frame.right - rect.width)
    : frame.left;
  next.y = rect.height <= frame.height
    ? clampNumber(rect.top, frame.top, frame.bottom - rect.height)
    : frame.top;
  return next;
}

// TXT のページ番号を「見本順の連番」とみなして論理ページ順へ読み替えるべきか判定する。
// 画像スキャン由来の TXT は、非表示ページを除いた見本の並び順で <<1Page>>..<<KPage>> の
// 連番が振られる（referenceScanDocToText）。一方 PSD は実ページ番号（"4修正版"→4 等）で
// 解釈されるため、見開きや非表示で飛番が出ると TXT 連番と PSD 実番号が食い違う。
// TXT が 1..K の連番で、かつ PSD 論理ページがそれと異なる（飛番/歯抜け）ときに限り、
// TXT ページ N → logicalPages[N-1]（見本順の N 番目の実ページ）へ読み替える。
// 原稿テキストが実ページ番号（飛番あり）で書かれている場合は連番にならないので読み替えない。
function txtGroupsUseReferenceOrder(txtGroups, psdPageMap) {
  if (!psdPageMap?.hasLogicalMismatch) return false;
  const logicalPages = psdPageMap.logicalPageNumbers ?? [];
  if (logicalPages.length === 0) return false;
  // 論理ページが既に 1..K の連番（飛番なし）なら、TXT 連番をそのまま使えるので読み替え不要。
  if (logicalPages.every((p, i) => p === i + 1)) return false;
  const txtPageSet = new Set();
  for (const group of Array.isArray(txtGroups) ? txtGroups : []) {
    const nums = Array.isArray(group?.pageNumbers) && group.pageNumbers.length
      ? group.pageNumbers
      : [group?.key];
    for (const n of nums) {
      if (Number.isInteger(n) && n > 0) txtPageSet.add(n);
    }
  }
  const txtPages = [...txtPageSet].sort((a, b) => a - b);
  if (txtPages.length === 0) return false;
  // TXT が 1..K の連番（= 見本順 / 画像スキャン由来）で、かつ TXT のページ数が論理ページ数と
  // 一致する（= 見本順 N 番目 ⇔ 論理ページ N 番目 の 1:1 読み替えが成立する）ときだけ読み替える。
  // 連番でない（原稿が実ページ番号）または個数が合わない場合は、誤った読み替えを避けて素通しする。
  const txtIsContiguousFrom1 = txtPages[0] === 1 && txtPages[txtPages.length - 1] === txtPages.length;
  return txtIsContiguousFrom1 && txtPages.length === logicalPages.length;
}

function resolveReferenceOrderPageNumbers(pageNumbers, psdPageMap, useReferenceOrder) {
  if (!useReferenceOrder) return pageNumbers;
  const logicalPages = psdPageMap.logicalPageNumbers ?? [];
  return pageNumbers
    .map((n) => {
      const idx = Number(n) - 1;
      return Number.isInteger(idx) && idx >= 0 && idx < logicalPages.length
        ? logicalPages[idx]
        : null;
    })
    .filter((n) => Number.isInteger(n) && n > 0);
}

function uniquePsdIndicesForPageNumbers(pageNumbers, psdPageMap, psdCount) {
  const out = [];
  const seen = new Set();
  for (const n of pageNumbers) {
    const mapped = psdPageMap.pageToPsdIndices.get(n);
    const candidates = mapped && mapped.length ? mapped : [n - 1];
    for (const idx of candidates) {
      if (!Number.isInteger(idx) || idx < 0 || idx >= psdCount || seen.has(idx)) continue;
      seen.add(idx);
      out.push(idx);
    }
  }
  return out;
}

function referenceIndexForPsdRow(psdPageMap, rowIndex) {
  const logicalPages = psdPageMap.pageNumbersByPsdIndex[rowIndex] ?? [rowIndex + 1];
  if (psdPageMap.referenceUsesLogicalPages) {
    const referenceIndex = psdPageMap.referenceIndexByLogicalPage?.get(logicalPages[0]);
    return Number.isInteger(referenceIndex) ? referenceIndex : rowIndex;
  }
  return rowIndex;
}

function referenceScanForLogicalPage(referenceScanDoc, psdPageMap, pageNumber) {
  const referenceIndex = psdPageMap.referenceIndexByLogicalPage?.get(pageNumber);
  if (!Number.isInteger(referenceIndex)) return null;
  return referenceScanDoc?.pages?.[referenceIndex] ?? null;
}

function originalIndexBlock(block, originalIndex) {
  return {
    ...block,
    __opusOriginalBlockIndex: Number.isInteger(block?.__opusOriginalBlockIndex)
      ? block.__opusOriginalBlockIndex
      : originalIndex,
  };
}

function withOriginalBlockIndices(referenceScan) {
  if (!referenceScan || !Array.isArray(referenceScan.blocks)) return referenceScan;
  return {
    ...referenceScan,
    blocks: referenceScan.blocks.map((block, index) => originalIndexBlock(block, index)),
  };
}

function centerXOfBlock(block) {
  const box = Array.isArray(block?.box) ? block.box : null;
  if (!box || box.length < 4) return null;
  const x1 = Number(box[0]);
  const x2 = Number(box[2]);
  return Number.isFinite(x1) && Number.isFinite(x2) ? (x1 + x2) / 2 : null;
}

function spreadSideForLogicalPage(logicalPages, pageNumber) {
  const pos = logicalPages.indexOf(pageNumber);
  if (pos === 0) return "right";
  if (pos === 1) return "left";
  return null;
}

function filterSpreadReferenceScanSide(referenceScan, side) {
  const width = Number(referenceScan?.img_width);
  const blocks = Array.isArray(referenceScan?.blocks) ? referenceScan.blocks : [];
  if (!referenceScan || !Number.isFinite(width) || width <= 0 || (side !== "left" && side !== "right")) {
    return withOriginalBlockIndices(referenceScan);
  }
  const half = width / 2;
  return {
    ...referenceScan,
    blocks: blocks
      .map((block, index) => ({ block, index, cx: centerXOfBlock(block) }))
      .filter((item) => Number.isFinite(item.cx) && (side === "right" ? item.cx >= half : item.cx < half))
      .map((item) => originalIndexBlock(item.block, item.index)),
    __opusSpreadSide: side,
  };
}

function expandSinglePageScanIntoSpread(referenceScan, side, leftWidth, rightWidth, originalBase = 0) {
  if (!referenceScan || (side !== "left" && side !== "right")) return withOriginalBlockIndices(referenceScan);
  const ownWidth = Math.max(1, Number(referenceScan.img_width) || 1);
  const lw = Math.max(1, Number(leftWidth) || ownWidth);
  const rw = Math.max(1, Number(rightWidth) || ownWidth);
  const fullWidth = lw + rw;
  const offsetX = side === "right" ? lw : 0;
  const blocks = Array.isArray(referenceScan.blocks) ? referenceScan.blocks : [];
  return {
    ...referenceScan,
    img_width: fullWidth,
    blocks: blocks.map((block, index) => {
      const box = Array.isArray(block?.box) ? block.box : null;
      const next = originalIndexBlock(block, originalBase + index);
      if (!box || box.length < 4) return next;
      return {
        ...next,
        box: [
          Number(box[0]) + offsetX,
          Number(box[1]),
          Number(box[2]) + offsetX,
          Number(box[3]),
        ],
      };
    }),
    __opusSpreadSide: side,
  };
}

function referenceScanForSpreadPage(referenceScanDoc, rowReferenceScan, logicalPages, pageNumber, psdPageMap, wholeSpread) {
  if (logicalPages.length < 2) return withOriginalBlockIndices(rowReferenceScan);
  const side = spreadSideForLogicalPage(logicalPages, pageNumber);
  if (psdPageMap.referenceUsesLogicalPages) {
    const firstPageScan = referenceScanForLogicalPage(referenceScanDoc, psdPageMap, logicalPages[0]);
    const secondPageScan = referenceScanForLogicalPage(referenceScanDoc, psdPageMap, logicalPages[1]);
    if (wholeSpread && firstPageScan && secondPageScan) {
      const leftWidth = Math.max(1, Number(secondPageScan.img_width) || 1);
      const rightWidth = Math.max(1, Number(firstPageScan.img_width) || 1);
      const right = expandSinglePageScanIntoSpread(firstPageScan, "right", leftWidth, rightWidth, 0);
      const left = expandSinglePageScanIntoSpread(secondPageScan, "left", leftWidth, rightWidth, 100000);
      return {
        ...right,
        img_height: Math.max(Number(firstPageScan.img_height) || 0, Number(secondPageScan.img_height) || 0),
        blocks: [...(right.blocks ?? []), ...(left.blocks ?? [])],
        __opusSpreadSide: "both",
      };
    }
    const sourceScan = side === "right" ? firstPageScan : side === "left" ? secondPageScan : null;
    if (sourceScan) {
      const leftWidth = Math.max(1, Number(secondPageScan?.img_width) || Number(sourceScan.img_width) || 1);
      const rightWidth = Math.max(1, Number(firstPageScan?.img_width) || Number(sourceScan.img_width) || 1);
      return expandSinglePageScanIntoSpread(sourceScan, side, leftWidth, rightWidth);
    }
  }
  if (wholeSpread) return withOriginalBlockIndices(rowReferenceScan);
  return filterSpreadReferenceScanSide(rowReferenceScan, side);
}

function referenceScanForPlacement(referenceScanDoc, row, pageNumber, psdPageMap, wholeSpread) {
  const logicalPages = psdPageMap.pageNumbersByPsdIndex[row.pageIndex - 1] ?? [row.pageIndex];
  if (logicalPages.length >= 2) {
    return referenceScanForSpreadPage(referenceScanDoc, row.referenceScan, logicalPages, pageNumber, psdPageMap, wholeSpread);
  }
  return withOriginalBlockIndices(row.referenceScan);
}

function placementEntriesForGroup(referenceScanDoc, rows, pageNumbers, psdPageMap) {
  const wholeSpread = pageNumbers.length >= 2;
  const rowIndices = uniquePsdIndicesForPageNumbers(pageNumbers, psdPageMap, rows.length);
  const entries = [];
  const seen = new Set();
  for (const rowIdx of rowIndices) {
    const row = rows[rowIdx];
    if (!row) continue;
    const logicalPages = psdPageMap.pageNumbersByPsdIndex[rowIdx] ?? [rowIdx + 1];
    const logicalMembers = pageNumbers.filter((n) => logicalPages.includes(n));
    const targetPages = logicalMembers.length ? logicalMembers : [pageNumbers[0] ?? rowIdx + 1];
    for (const pageNumber of targetPages) {
      const key = wholeSpread ? `${rowIdx}:spread` : `${rowIdx}:${pageNumber}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const referenceScan = referenceScanForPlacement(referenceScanDoc, row, pageNumber, psdPageMap, wholeSpread);
      if (!referenceScan) continue;
      entries.push({ rowIdx, pageNumber, referenceScan });
      if (wholeSpread) break;
    }
  }
  return entries;
}

function getAutoPlaceScanPageLimit(psdPages) {
  return buildPsdPageMap(psdPages).referencePageCountByOrder;
}

function referenceScanForLayerAdjustment(referenceScanDoc, psdPageMap, psdIndex, sourceTxtRef = null) {
  const row = {
    pageIndex: psdIndex + 1,
    referenceScan: referenceScanDoc?.pages?.[referenceIndexForPsdRow(psdPageMap, psdIndex)] ?? null,
  };
  const pageNumber = Number(sourceTxtRef?.pageNumber);
  if (Number.isInteger(pageNumber) && pageNumber > 0) {
    return referenceScanForPlacement(referenceScanDoc, row, pageNumber, psdPageMap, false) ?? row.referenceScan;
  }
  return withOriginalBlockIndices(row.referenceScan);
}

// 【見開きマーカー対応】txtGroups (= buildPlacementGroups) を「見開き単位」で処理する。
// 見開き <<2,3Page>> は構成する単ページ PSD (P2・P3) の吹き出しを 1 つに結合し、
// その見開きのテキストプールを内容マッチで割り当てる。各レイヤーは所属する単ページ PSD の
// 行へ振り分ける。これにより「どの段落が P2 か P3 か」をテキストに書かなくても、OCR の
// 吹き出し検出＋内容マッチで自動的に正しい単ページへ載る。
// sourceTxtRef.pageNumber は常に見開きキー (= 先頭ページ番号) に統一する（byPage/cascade/sync 整合）。
function buildPlacementPlan(referenceScanDoc, psdPages, txtGroups, defaults, options = {}) {
  const alignmentByPath = options.alignmentByPath instanceof Map ? options.alignmentByPath : null;
  const M = psdPages.length;
  const R = referenceScanDoc.pages.length;
  const psdPageMap = buildPsdPageMap(psdPages, R);
  const useReferenceOrderForTxtPages = txtGroupsUseReferenceOrder(txtGroups, psdPageMap);
  const out = { pages: [], totals: { placed: 0, leftoverTxt: 0, leftoverBubbles: 0 } };

  // PSD ページごとの行。各見開きグループの配置結果を、bubble が属する単ページ PSD の行へ溜める。
  const rows = psdPages.map((psd, i) => ({
    pageIndex: i + 1,
    psd,
    psdPath: psd?.path ?? null,
    psdName: baseName(psd?.path ?? ""),
    referenceScanIndex: referenceIndexForPsdRow(psdPageMap, i),
    referenceScan: referenceScanDoc.pages[referenceIndexForPsdRow(psdPageMap, i)] ?? null,
    sorted: null,
    layers: [],
    placedCount: 0,
    txtCount: 0,
    usedLocal: new Set(),
    centeredCount: 0,
    ocrRiskWarnings: [],
  }));

  for (const group of txtGroups) {
    const txt = group.blocks ?? [];
    const pageNumbers = Array.isArray(group.pageNumbers) && group.pageNumbers.length
      ? group.pageNumbers
      : [group.key];
    const placementPageNumbers = resolveReferenceOrderPageNumbers(
      pageNumbers,
      psdPageMap,
      useReferenceOrderForTxtPages,
    );
    if (placementPageNumbers.length === 0) continue;
    // この見開きに属する単ページ PSD のうち、OCR 結果がある index を集める。
    const memberEntries = placementEntriesForGroup(referenceScanDoc, rows, placementPageNumbers, psdPageMap)
      .filter((entry) => rows[entry.rowIdx]?.referenceScan && entry.referenceScan);
    // 構成ページの吹き出しを結合（各 bubble に所属行 + 連結グループ情報を記録）。
    const combined = [];
    const meta = [];
    for (const entry of memberEntries) {
      const row = rows[entry.rowIdx];
      const sorted = sortBlocksMangaOrder(entry.referenceScan.blocks ?? []);
      if (!row.sorted) row.sorted = sortBlocksMangaOrder(row.referenceScan?.blocks ?? []);
      // 【v1.26.0 移植】連結グループ判定 (ひょうたん型) はページ単位で算出。
      const connected = groupConnectedBlocks(sorted, ` page ${entry.pageNumber ?? entry.rowIdx + 1}`);
      for (let k = 0; k < sorted.length; k++) {
        const originalIdx = Number.isInteger(sorted[k]?.__opusOriginalBlockIndex)
          ? sorted[k].__opusOriginalBlockIndex
          : k;
        meta.push({
          rowIdx: entry.rowIdx,
          localIdx: originalIdx,
          connected: connected[k],
          referenceScan: entry.referenceScan,
        });
        combined.push(sorted[k]);
      }
    }
    if (txt.length === 0) continue;
    // 全 TXT 段落を配置: 結合バブルに内容マッチすれば所属単ページの吹き出し中央へ。
    // マッチしなかった段落（＝吹き出しが検出されない / 段落数 > 吹き出し数）は、
    // 読み順で見開きの構成ページへ振り分け、中央に重なって見えなくなるのを防ぐため段組みでずらす。
    const { assigned, rejectedMatches } = assignBlocksToTxt(txt, combined);
    for (const rejected of rejectedMatches) {
      if (assigned[rejected.txtIndex]) continue;
      const m = rejected?.entry && Number.isInteger(rejected.entry.index) ? meta[rejected.entry.index] : null;
      const row = m ? rows[m.rowIdx] : null;
      if (!row) continue;
      row.ocrRiskWarnings.push({
        pageNumber: group.key,
        paragraphIndex: rejected.txtIndex,
        expected: txt[rejected.txtIndex] ?? "",
        scanned: rejected.entry.text ?? "",
        score: rejected.score,
        reason: rejected.risk?.reason ?? "OCR差分疑い",
      });
    }
    for (let j = 0; j < txt.length; j++) {
      const a = assigned[j];
      const m = a && Number.isInteger(a.index) ? meta[a.index] : null;
      const sourceTxtRef = {
        pageNumber: group.key,
        paragraphIndex: j,
        extractBlockIndex: m ? m.localIdx : j,
        extractMatchScore: Number.isFinite(a?.score) ? a.score : 0,
      };
      if (a && m) {
        const row = rows[m.rowIdx];
        const alignment = row.psdPath && alignmentByPath ? alignmentByPath.get(row.psdPath) : null;
        const layer = mapBlockToNewLayer(a.block, m.referenceScan, row.psd, txt[j], defaults, sourceTxtRef, m.connected, alignment);
        layer.lowExtractTextMatch = a.lowConfidence === true;
        layer.extractMatchScore = sourceTxtRef.extractMatchScore;
        row.layers.push(layer);
        row.usedLocal.add(m.localIdx);
        row.placedCount += 1;
        row.txtCount += 1;
      } else {
        // 余り TXT: 読み順で前半→先頭ページ / 後半→次ページに振り分け。
        let tgtIdx;
        if (memberEntries.length >= 1) {
          const frac = txt.length > 1 ? j / txt.length : 0;
          tgtIdx = memberEntries[Math.min(memberEntries.length - 1, Math.floor(frac * memberEntries.length))].rowIdx;
        } else {
          const fallbackPageNumber = placementPageNumbers[0] ?? group.key;
          tgtIdx = uniquePsdIndicesForPageNumbers([fallbackPageNumber], psdPageMap, M)[0] ?? (fallbackPageNumber - 1);
        }
        const row = rows[tgtIdx];
        if (row && row.psd) {
          const layer = mapTxtToPageCenter(row.psd, txt[j], defaults, sourceTxtRef);
          // 重なり回避: このページで中央配置した通し番号ぶん、右下方向へ少しずつずらす。
          const n = row.centeredCount;
          row.centeredCount += 1;
          const step = (defaults.sizePt ?? 24) * (row.psd.dpi ?? 72) / 72 * 1.6;
          layer.x = (layer.x ?? 0) + n * step * 0.35;
          layer.y = (layer.y ?? 0) + n * step;
          row.layers.push(layer);
          row.placedCount += 1;
          row.txtCount += 1;
        }
      }
    }
  }

  // 行 → out.pages（PSD ページ単位の結果）。
  for (const row of rows) {
    const rowIndex = row.pageIndex - 1;
    if (!psdPageMap.usedPsdIndices.has(rowIndex) && row.placedCount === 0) continue;
    const sorted = row.sorted ?? sortBlocksMangaOrder(row.referenceScan?.blocks ?? []);
    const bubbleCount = sorted.length;
    const leftoverBubbles = sorted
      .filter((_, idx) => !row.usedLocal.has(idx))
      .map((b) => (Array.isArray(b.lines) ? b.lines.join(" ") : ""));
    let status = "ok";
    if (bubbleCount === 0 && row.txtCount === 0) status = "ok";
    else if (bubbleCount === 0) status = "warn-empty-bubble";
    else if (row.txtCount === 0) status = sorted.length === 0 ? "ok" : "skip-empty-txt";
    else if (bubbleCount > row.txtCount) status = "warn-bubble-extra";
    out.pages.push({
      pageIndex: row.pageIndex,
      psdPath: row.psdPath,
      psdName: row.psdName,
      bubbleCount,
      txtCount: row.txtCount,
      placedCount: row.placedCount,
      status,
      layers: row.layers,
      leftoverTxt: [],
      leftoverBubbles,
      ocrRiskWarnings: row.ocrRiskWarnings,
    });
    out.totals.placed += row.placedCount;
    out.totals.leftoverBubbles += leftoverBubbles.length;
    out.totals.ocrRiskSkipped = (out.totals.ocrRiskSkipped ?? 0) + row.ocrRiskWarnings.length;
  }
  // PSD 数 / 画像スキャン ページ数の不一致を末尾に warning として記録
  const expectedReferenceCount = psdPageMap.referencePageCountByOrder;
  if (expectedReferenceCount > R) out.unmappedPsdCount = expectedReferenceCount - R;
  if (R > expectedReferenceCount) out.unmappedReferenceScanCount = R - expectedReferenceCount;
  return out;
}

// ============================================================
// 確認モーダル UI（ページ数不一致 / OCR 危険一致があるときだけ表示）
// ============================================================
function renderPlanReviewTable(plan) {
  const warning = $("scan-place-review-warning");
  const warningDetail = $("scan-place-review-warning-detail");
  if (!warning || !warningDetail) return;
  const psdExtra = plan.unmappedPsdCount ?? 0;
  const extractExtra = plan.unmappedReferenceScanCount ?? 0;
  const ocrRiskCount = plan.totals?.ocrRiskSkipped ?? 0;
  if (psdExtra > 0 || extractExtra > 0 || ocrRiskCount > 0) {
    const psdTotal = plan.pages.length + psdExtra;
    const extractTotal = plan.pages.length + extractExtra;
    const parts = [];
    if (psdExtra > 0 || extractExtra > 0) parts.push(`PSD: ${psdTotal} 枚 / 画像スキャン: ${extractTotal} ページ`);
    if (psdExtra > 0) parts.push(`末尾の PSD ${psdExtra} 枚にはテキストが配置されません。`);
    if (extractExtra > 0) parts.push(`末尾の 画像スキャン ${extractExtra} ページ分は使用されません。`);
    if (ocrRiskCount > 0) {
      const examples = (plan.pages ?? [])
        .flatMap((page) => page.ocrRiskWarnings ?? [])
        .slice(0, 3)
        .map((w) => `「${String(w.expected ?? "").replace(/\s+/g, " ").slice(0, 12)}」←OCR「${String(w.scanned ?? "").replace(/\s+/g, " ").slice(0, 12)}」`);
      parts.push(`短い漢字語のOCR差分疑い ${ocrRiskCount} 件は、誤配置を避けるため吹き出し確定せず中央配置にしました。${examples.length ? `例: ${examples.join(" / ")}` : ""}`);
    }
    warningDetail.textContent = parts.join(" ");
    warning.hidden = false;
  } else {
    warning.hidden = true;
  }
}

function showPlanReviewModal(plan) {
  return new Promise((resolve) => {
    const modal = $("scan-place-review-modal");
    const okBtn = $("scan-place-review-ok");
    const cancelBtn = $("scan-place-review-cancel");
    if (!modal || !okBtn || !cancelBtn) {
      resolve(false);
      return;
    }
    renderPlanReviewTable(plan);
    modal.hidden = false;
    const cleanup = (result) => {
      modal.hidden = true;
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      modal.removeEventListener("mousedown", onOverlay);
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onOverlay = (e) => { if (e.target === modal) cleanup(false); };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); cleanup(false); }
      else if (e.key === "Enter") { e.preventDefault(); cleanup(true); }
    };
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    modal.addEventListener("mousedown", onOverlay);
    document.addEventListener("keydown", onKey);
    okBtn.disabled = plan.totals.placed === 0;
    requestAnimationFrame(() => okBtn.focus());
  });
}

// ============================================================
function removeExistingAutoPlacedLayersForPlan(plan) {
  const targets = new Set();
  for (const row of plan.pages) {
    if (row?.psdPath) targets.add(`${row.psdPath}::${row.pageIndex ?? null}`);
    for (const layer of row.layers) {
      if (!layer?.psdPath || !layer?.sourceTxtRef) continue;
      const pageNumber = layer.sourceTxtRef.pageNumber ?? null;
      targets.add(`${layer.psdPath}::${pageNumber}`);
    }
  }
  if (targets.size === 0) return 0;

  let removed = 0;
  for (const layer of getNewLayers().slice()) {
    const ref = layer?.sourceTxtRef;
    if (!ref || !layer?.psdPath) continue;
    const key = `${layer.psdPath}::${ref.pageNumber ?? null}`;
    if (!targets.has(key)) continue;
    removeNewLayer(layer.tempId);
    removed++;
  }
  return removed;
}

// 確定 → 既存の自動配置レイヤーを置換して addNewLayer 一括
// ============================================================
function applyPlan(plan) {
  let added = 0;
  let removed = 0;
  beginHistoryTransient();
  try {
    removed = removeExistingAutoPlacedLayersForPlan(plan);
    for (const row of plan.pages) {
      for (const layer of row.layers) {
        addNewLayer(layer);
        added++;
      }
    }
    if (added > 0 || removed > 0) commitHistoryTransient();
    else abortHistoryTransient();
  } catch (e) {
    abortHistoryTransient();
    throw e;
  }
  if (added > 0 || removed > 0) {
    // overlay の再描画とレイヤーリスト更新を即座に反映
    try { renderAllSpreads(); } catch (_) {}
    try { rebuildLayerList(); } catch (_) {}
    // 【v1.26.0 移植 (PsDesign-main v1.24.0)】原稿テキストパネルの該当段落も色強調
    // (autoFontSwitched フラグに連動)。
    try { renderTxtSourceViewer(); } catch (_) {}
  }
  return added;
}

// ============================================================
// 自動配置メインフロー
// ============================================================
export async function runAutoPlace({
  allowExtractText = false,
  preserveTxtDuringExtract = false,
  forceRescan = false,
  positionOnlyScan = false,
  positionAdjustMode = null,
  cloudShapeFontEnabled = null,
  punctuationSpaceReplacementEnabled = null,
  progressFlowId = null,
  // v2.2.x: 完了 → workspace の星空ディゾルブ演出を呼び出し側で実施したい場合は
  // true を渡す。runAutoPlace の最終 hideProgress(success: true) を skip するので、
  // 呼び出し側で hideProgress + scene transition を担当する。
  skipFinalHide = false,
} = {}) {
  if (runningPlacePromise) return runningPlacePromise;
  runningPlacePromise = (async () => {
  let progressOpenForAutoPlace = false;
  const closeAutoPlaceProgress = async (options) => {
    if (!progressOpenForAutoPlace) return;
    progressOpenForAutoPlace = false;
    await hideProgress(options);
  };
  const scanProgressFlow = progressFlowId ? { id: progressFlowId, stepId: "scan" } : null;
  const placeProgressFlow = progressFlowId ? { id: progressFlowId, stepId: "place" } : null;
  const alignProgressFlow = progressFlowId ? { id: progressFlowId, stepId: "align" } : null;
  try {
    // 1. PSD / TXT の事前確認
    //    PSD 未読込なら、ファイル選択ダイアログを起動して読み込みまで一気通貫で進める
    //    (ユーザーがダイアログをキャンセルした場合は静かに戻る)。
    let psdPages = getPages();
    if (!psdPages || psdPages.length === 0) {
      const files = await pickPsdFiles();
      if (!files || files.length === 0) return;
      // 自動配置から呼ばれる PSD 読込なので進捗バーには wand-sparkles アイコンと
      // 「自動配置中…」ラベルを出し、ユーザーの操作文脈を維持する。
      await loadPsdFilesByPaths(files, { icon: PLACE_ICON_SVG, label: "自動配置中…", variant: "place", progressFlow: progressFlowId ? { id: progressFlowId, stepId: "psd-load" } : null });
      psdPages = getPages();
      if (!psdPages || psdPages.length === 0) {
        // 読み込みが全件失敗 (loadPsdFilesByPaths が内部で notifyDialog を出す) 等
        return;
      }
    }
    let txtSrc = getTxtSource();
    if ((!txtSrc || !txtSrc.content) && !allowExtractText) {
      await notifyDialog({
        title: "自動配置できません",
        message: "テキストが読み込まれていません。\n先に TXT を開くか、画像スキャンを実行してください。",
      });
      return;
    }

    // 2. 画像スキャン キャッシュ確認
    //   - キャッシュ有効: 結果あり & pages 1 件以上 → そのまま再利用
    //   - 無効なら、読込済み見本ファイル全てを対象に画像スキャンを自動トリガーする。
    let cache = getScanExtractDoc();
    const loadedRefs = getPdfPaths();
    const imageReferenceOnly = loadedRefs.length > 0 && loadedRefs.every((p) => /\.(jpe?g|png|webp|tiff?|bmp)$/i.test(p));
    const cacheLooksLikeStaleImageSplit = imageReferenceOnly
      && cache?.doc?.__opusVirtualPages === true
      && Array.isArray(cache.doc.pages)
      && cache.doc.pages.length > loadedRefs.length;
    const cacheValid = !forceRescan && !cacheLooksLikeStaleImageSplit && !!(
      cache &&
      cache.doc &&
      Array.isArray(cache.doc.pages) &&
      cache.doc.pages.length > 0
    );
    if (!cacheValid) {
      if (loadedRefs.length === 0) {
        await notifyDialog({
          title: "自動配置できません",
          message: "画像スキャン の元になる PDF / 画像が必要です。\n先に PDF を開くか、画像スキャンを実行してください。",
        });
        return;
      }
      // 既存の画像スキャンフローを呼び出す (進捗モーダルは scan-extract 側が出す)。
      // 読込済みの見本ファイル全てを 画像スキャン 対象にして自動配置の整合を取る。
      if (positionOnlyScan) {
        await runScanExtractForPlacementOnly(loadedRefs, { keepProgressOpen: true, progressFlow: scanProgressFlow });
      } else {
        await runScanExtractForFiles(loadedRefs, {
          loadText: !preserveTxtDuringExtract || !(txtSrc && txtSrc.content),
          maxPages: getAutoPlaceScanPageLimit(psdPages),
          excludedPages: getPdfExcludedReferencePages(),
          keepProgressOpen: true,
          progressFlow: scanProgressFlow,
        });
      }
      progressOpenForAutoPlace = true;
      showProgress(withProgressFlow(placeProgressFlow, {
        title: "自動配置中…",
        detail: "自動配置を準備中…",
        icon: PLACE_ICON_SVG,
        variant: "place",
        current: null,
        total: null,
        showCount: false,
      }));
      cache = getScanExtractDoc();
      if (!cache || !cache.doc) {
        await closeAutoPlaceProgress();
        // 画像スキャン側がエラー通知済みなのでここでは静かに戻る
        return;
      }
    }

    txtSrc = getTxtSource();
    if (!txtSrc || !txtSrc.content) {
      await closeAutoPlaceProgress();
      await notifyDialog({
        title: "自動配置できません",
        message: "テキストが読み込まれていません。\nテキストファイルを指定するか、画像スキャン結果からテキストを生成してください。",
      });
      return;
    }
    const parsed = parsePages(txtSrc.content);
    const txtGroups = buildPlacementGroups(parsed);

    // 3. プラン構築
    // 【v1.26.0 移植 (PsDesign-main v1.24.0)】
    // フォントは「現在のフォント (ツール状態)」ではなく **環境設定のデフォルトフォント** を優先。
    // ユーザーが手動でツール状態のフォントを変えても、自動配置はデフォルト値を尊重する。
    const defaults = {
      fontPostScriptName: getDefault("fontPostScriptName") || getCurrentFont(),
      sizePt: getTextSize(),
      leadingPct: getLeadingPct(),
      strokeColor: getStrokeColor(),
      strokeWidthPx: getStrokeWidthPx(),
      fillColor: getFillColor(),
      // 周辺解析に基づく白フチ自動付与 (要件 ②)
      autoStrokeEnabled: getDefault("autoStrokeEnabled"),
      autoStrokeWhiteRatioThreshold: getDefault("autoStrokeWhiteRatioThreshold"),
      // 中丸ゴシック自動切替 (要件 ④, 背景 + ウニ合成スコア)
      cloudShapeFontEnabled: cloudShapeFontEnabled == null
        ? getDefault("cloudShapeFontEnabled")
        : cloudShapeFontEnabled !== false,
      cloudShapeScoreThreshold: getDefault("cloudShapeScoreThreshold"),
      cloudShapeFontPostScriptName: getDefault("cloudShapeFontPostScriptName"),
      punctuationSpaceReplacementEnabled: punctuationSpaceReplacementEnabled == null
        ? getDefault("punctuationSpaceReplacementEnabled")
        : punctuationSpaceReplacementEnabled !== false,
      positionAdjustMode,
    };
    const placementDoc = normalizeReferenceScanDocForReferencePages(cache.doc);
    let alignmentByPath = null;
    if (positionAdjustMode === "mode1" || positionAdjustMode === "mode2") {
      progressOpenForAutoPlace = true;
      showProgress(withProgressFlow(alignProgressFlow, { title: "自動配置中…", detail: "位置調整を計算中…", icon: PLACE_ICON_SVG, variant: "place" }));
      const alignPsdPageMap = buildPsdPageMap(psdPages, placementDoc?.pages?.length ?? 0);
      alignmentByPath = await computeAlignmentsForPages(
        positionAdjustMode,
        psdPages,
        placementDoc,
        psdPages
          .map((_, i) => getLoadedReferenceEntryForPage(referenceIndexForPsdRow(alignPsdPageMap, i)))
          .filter(Boolean),
        { progressLabel: "位置調整を計算中…", progressFlow: alignProgressFlow },
      );
      if (alignmentByPath.size === 0) {
        await closeAutoPlaceProgress();
        await notifyDialog({
          title: "位置調整できません",
          message: `見本画像から位置調整を計算できませんでした。見本ページの表示状態と、PSD/見本のページ対応を確認してください。${lastAlignmentError ? `\n\n詳細: ${lastAlignmentError}` : ""}`,
        });
        return;
      }
    }
    if (placeProgressFlow) {
      updateProgressFlow(placeProgressFlow, { detail: "配置プランを作成中…", progress: 18, showCount: false });
    }
    const plan = buildPlacementPlan(placementDoc, psdPages, txtGroups, defaults, { alignmentByPath });

    if (plan.totals.placed === 0) {
      await closeAutoPlaceProgress();
      await notifyDialog({
        title: "配置できる組み合わせがありません",
        message: "TXT ブロックと検出された吹き出しの対応が 1 件もありません。\nTXT のページ区切りや PSD の枚数を確認してください。",
      });
      return;
    }

    // 4. 直前と同じテキスト内容なら重複確認
    const fingerprint = planFingerprint(plan);
    if (lastPlacedFingerprint !== null && lastPlacedFingerprint === fingerprint) {
      const proceed = await confirmDialog({
        title: "テキスト内容が同一です",
        message: "前回と同じテキスト内容で自動配置しようとしています。\n自動配置を行いますか？",
        confirmLabel: "実行",
        cancelLabel: "キャンセル",
      });
      if (!proceed) {
        await closeAutoPlaceProgress();
        return;
      }
    }

    // 5. 確認モーダル（ページ数不一致 / OCR 危険一致があるときだけ表示）
    const needsReview =
      (plan.unmappedPsdCount ?? 0) > 0
      || (plan.unmappedReferenceScanCount ?? 0) > 0
      || (plan.totals?.ocrRiskSkipped ?? 0) > 0;
    if (needsReview) {
      const ok = await showPlanReviewModal(plan);
      if (!ok) {
        await closeAutoPlaceProgress();
        return;
      }
    }

    // 6. 適用
    if (placeProgressFlow) {
      updateProgressFlow(placeProgressFlow, { detail: "テキストを配置中…", progress: 72, showCount: false });
    }
    applyPlan(plan);
    lastPlacedFingerprint = fingerprint;
    await waitForTransitionPaint();
    if (placeProgressFlow) {
      completeProgressFlowStep(placeProgressFlow, { detail: "自動配置 完了" });
    }
    // 進捗モーダルだけ緑のチェックマークアニメで閉じる。完了 notifyDialog は
    // ユーザー要望で出さない（写植作業の流れを止めないため）。エラー時のみ下の
    // catch で notifyDialog を表示する。
    const willRunExternalAlign = positionAdjustMode === "mode3" && progressFlowId;
    if (willRunExternalAlign) {
      // mode3: 中間 close (overlay-align に手渡すため必ず実行、skipFinalHide とは無関係)
      await hideProgress();
    } else if (progressOpenForAutoPlace) {
      if (skipFinalHide) {
        // 呼び出し側が close を担当するので、内部 state だけリセット
        progressOpenForAutoPlace = false;
      } else {
        await closeAutoPlaceProgress({ success: true });
      }
    } else {
      if (!skipFinalHide) {
        await hideProgress({ success: true });
      }
    }
    await wait(320);
    setActivePane("psd");
    // 配置完了後、見本(PDF)と PSD の両方が全体表示になるようフィットへ揃える。
    fitBothPanesToWindow();
    return { placed: true, positionAdjusted: positionAdjustMode === "mode1" || positionAdjustMode === "mode2" };
  } catch (e) {
    console.error(e);
    await hideProgress();
    await notifyDialog({
      title: "自動配置エラー",
      message: String(e?.message ?? e ?? "不明なエラー"),
    });
  } finally {
    runningPlacePromise = null;
  }
  })();
  return runningPlacePromise;
}

// ============================================================
// 自動配置済みレイヤーの TXT 追従同期
// ============================================================
// 自動配置時に各レイヤーへ sourceTxtRef = { pageNumber, paragraphIndex } を埋めている。
// TXT が編集されたら、現在の TXT を再パースして該当段落を見つけ、レイヤー contents を
// 上書きする。手動配置レイヤー（sourceTxtRef なし）は触らない。
//
// 履歴: setTxtSource が listener 末尾で pushHistorySnapshot を呼ぶので、ここでの
// updateNewLayer による snapshot push は不要。begin/abortHistoryTransient で抑制する。
function syncPlacedFromTxt() {
  const txtSrc = getTxtSource();
  if (!txtSrc?.content) return;
  const layers = getNewLayers();
  // 自動配置レイヤーが 1 件も無ければ早期 return（パースコスト回避）。
  if (!layers.some((l) => l && l.sourceTxtRef)) return;
  const parsed = parsePages(txtSrc.content);
  const txtByPage = buildTxtPageMapForSync(parsed);
  // psdPath → page object のルックアップ。中心固定の x/y 再計算で page.dpi が必要。
  const pagesByPath = new Map();
  for (const p of getPages()) {
    if (p?.path) pagesByPath.set(p.path, p);
  }

  beginHistoryTransient();
  let changed = false;
  try {
    for (const layer of layers) {
      const ref = layer?.sourceTxtRef;
      if (!ref) continue;
      const paragraphs = txtByPage.get(ref.pageNumber);
      if (!paragraphs) continue;
      const rawNext = paragraphs[ref.paragraphIndex];
      if (rawNext == null) continue;
      // 縦書きレイヤーは設定 verticalHalfToFullEnabled に従い半角英数字を全角化。
      // 原稿側は元データを保持する設計のため、レイヤー contents に変換後を書き戻す
      // ことで原稿との見た目差分を吸収する（横書きと設定 OFF は冪等に素通し）。
      const direction = layer.direction ?? "horizontal";
      const rubyParsedNext = parseRubyAnnotatedText(rawNext, { promoteInlineNakaguro: direction === "vertical" });
      const next = normalizePunctuationSpaceReplacement(
        convertHalfToFullForVertical(rubyParsedNext.text, direction),
        getDefault("punctuationSpaceReplacementEnabled"),
      );
      const nextCharRubies = rubyParsedNext.charRubies;

      // 【手動ルビ保護: char index 単位のマージ】TXT 注記由来のルビと手動ルビを統合。
      //   - TXT 注記由来の char index → nextCharRubies の値で上書き (明示的注記の優先順位を維持)
      //   - 注記が無い char index → layer 既存ルビ (= 手動振り) を保持
      // これにより以下の事故をすべて解消:
      //   (1) プロジェクト再オープン時 (TXT 注記が一切無い場合) → 手動ルビが空マップで潰される
      //   (2) TXT 注記が部分的にあるケース → 注記外の手動ルビも一緒に消える
      //   (3) TXT 注記由来のルビが新規追加されたケース → 注記の char index だけは正しく更新
      // 旧フォーク (boolean 判定) は (1) のみ解消、(2) が未解消だった。
      const mergedRubies = { ...nextCharRubies };
      for (const [k, v] of Object.entries(layer.charRubies ?? {})) {
        if (!(k in mergedRubies)) mergedRubies[k] = v;
      }
      const nextLineLeadings = rubyLineLeadingsForText(next, mergedRubies);
      const rubiesChanged = JSON.stringify(layer.charRubies ?? {}) !== JSON.stringify(mergedRubies);
      const leadingsChanged = JSON.stringify(layer.lineLeadings ?? {}) !== JSON.stringify(nextLineLeadings);

      // contents が同じで、ルビ/行間にも変更がなければ continue
      if (next === layer.contents && !rubiesChanged && !leadingsChanged) continue;

      // contents 変更で推定 width/height が変わるため、x/y をそのままにすると
      // bbox top-left 固定 → 旧中心からズレて見える（上左に寄ったように見える）。
      // 旧 contents の bbox 中心を求め、新 contents の bbox を中心起点で再配置する。
      const updates = {
        contents: next,
        charRubies: mergedRubies,
        lineLeadings: nextLineLeadings,
      };
      if (next !== layer.contents) {
        updates.autoFontSwitched = false;
        updates.autoFontSwitchBucket = -1;
      }
      const psdPage = pagesByPath.get(layer.psdPath);
      if (psdPage) {
        const sizePt = layer.sizePt ?? 24;
        const leadingPct = layer.leadingPct ?? 125;
        const oldRect = estimateLayerSize(psdPage, sizePt, layer.contents ?? "", leadingPct, direction);
        const newRect = estimateLayerSize(psdPage, sizePt, next, leadingPct, direction);
        const cx = (layer.x ?? 0) + oldRect.width / 2;
        const cy = (layer.y ?? 0) + oldRect.height / 2;
        updates.x = cx - newRect.width / 2;
        updates.y = cy - newRect.height / 2;
      }
      updateNewLayer(layer.tempId, updates);
      changed = true;
    }
  } finally {
    abortHistoryTransient();
  }
  if (changed) {
    try { renderAllSpreads(); } catch (_) {}
    try { rebuildLayerList(); } catch (_) {}
  }
}

// ============================================================
// バインド
// ============================================================
export function bindScanPlaceButton() {
  const btn = $("scan-place-btn");
  if (btn) {
    btn.addEventListener("click", () => { void runAutoPlace(); });
  }
  // 画像スキャン 結果が無いうちはグレーアウト。setScanExtractDoc / clearScanExtractDoc に追従。
  const sync = () => {
    if (!btn) return;
    const locked = isScanActionsLocked();
    const cache = getScanExtractDoc();
    const hasExtract = !!(
      cache &&
      cache.doc &&
      Array.isArray(cache.doc.pages) &&
      cache.doc.pages.length > 0
    );
    btn.disabled = locked || !hasExtract;
    btn.title = locked
      ? "画像スキャンエンジンが未インストールです。"
      : hasExtract
      ? "画像スキャン 結果と原稿テキストを吹き出し位置に自動配置"
      : "先に画像スキャンを実行してください";
  };
  onScanExtractDocChange(sync);
  window.addEventListener("psdesign:scan-actions-lock-change", sync);
  sync();

  // TXT 編集 → 自動配置済みレイヤー contents を追従。
  // 編集はサイドパネル dblclick 編集 / エディタ textarea / undo/redo 経由で発生する。
  onTxtSourceChange(syncPlacedFromTxt);
}

// ============================================================
// 【v1.28.0 移植 (PsDesign-main v1.25.0)】
// 位置調整 (alignment 適用) フロー — 3 モード対応
// ============================================================
// 自動配置で生成済みのレイヤーに対して、各 PSD ページごとに見本画像との
// alignment (scale + offset) を計算し、配置済みレイヤーの座標を一括変換する。
//
// 3 モード:
//   mode1 (PSDに余分余白): scale=1, offset=(referenceScan - psd)/2 の確定式
//     ref < psd → 絵柄領域中心へシフト集約
//   mode2 (見本に余分余白): KENBAN 流の画像差分 grid search (Rust)
//     scale + offset を画像から自動検出 + per-layer サイズ補正
//   mode3 (重ね調整): 全画面オーバーレイで見本/PSD を半透明で重ね、
//     ドラッグ・ホイールで手動位置/スケール調整
//
// sourceTxtRef ベースで idempotent (累積バグなし、複数回押しても同じ結果)。
// 範囲外飛び出しガード付き (PSD ±30% 超えるレイヤーは補正スキップ)。
export async function runPositionAdjust(mode = "mode1", options = {}) {
  if (runningAdjust) return;
  runningAdjust = true;
  const modeLabel = mode === "mode2"
    ? "位置調整2 (見本に余分余白あり、画像差分)"
    : "位置調整1 (PSDに余分余白あり、確定式)";
  try {
    const psdPages = getPages();
    if (!psdPages || psdPages.length === 0) {
      await notifyDialog({ title: `${modeLabel} できません`, message: "PSD が読み込まれていません。" });
      return;
    }
    const referencePaths = getPdfPaths();
    if (!referencePaths || referencePaths.length === 0) {
      await notifyDialog({ title: `${modeLabel} できません`, message: "見本画像が読み込まれていません。" });
      return;
    }
    const newLayers = getNewLayers();
    if (!newLayers || newLayers.length === 0) {
      await notifyDialog({ title: `${modeLabel} できません`, message: "配置済みのテキストレイヤーがありません。" });
      return;
    }
    const pathToIndex = new Map();
    psdPages.forEach((p, i) => { if (p?.path) pathToIndex.set(p.path, i); });
    const cache = getScanExtractDoc();
    const referenceScanDoc = cache?.doc;

    showProgress({ detail: `${modeLabel} 中…`, icon: PLACE_ICON_SVG, label: modeLabel, variant: "place" });

    const psdPageMap = buildPsdPageMap(psdPages, referenceScanDoc?.pages?.length ?? 0);
    const referenceEntries = psdPages.map((_, i) => getLoadedReferenceEntryForPage(referenceIndexForPsdRow(psdPageMap, i)));
    const alignmentByPath = new Map();
    const N = psdPages.length;
    // 【高速化・1ページ目基準】同じ寸法 (PSD寸法 × 見本寸法) のページは位置合わせを使い回す
    // (判型/塗り足し/解像度が同じなら scale+offset は全ページ同一)。重い画像差分を 1 回だけにする。
    const geomCache = new Map();
    updateProgress({ current: 0, total: Math.max(N, 1), detail: `${modeLabel} 0/${N}`, showCount: false });
    for (let i = 0; i < N; i++) {
      const psd = psdPages[i];
      const referenceIndex = referenceIndexForPsdRow(psdPageMap, i);
      const refEntry = referenceEntries[i];
      const refPath = typeof refEntry === "string" ? refEntry : refEntry?.path;
      const pdfPageIdx = Number.isInteger(refEntry?.pdfPageIndex) ? refEntry.pdfPageIndex : 0;
      const referenceScan = referenceScanDoc?.pages?.[referenceIndex] ?? { blocks: [] };
      if (!refPath) continue;
      updateProgress({ current: i, total: N, detail: `${modeLabel} ${i + 1}/${N} を計算中…`, showCount: false });
      const geomSig = `${psd?.width}x${psd?.height}|${referenceScan?.img_width}x${referenceScan?.img_height}`;
      const cached = geomCache.has(geomSig);
      console.info(
        `[scan-adjust] page=${i + 1} mode=${mode} ref=${refPath}${cached ? " (1ページ目の結果を再利用)" : ""}`,
      );
      const alignment = cached
        ? geomCache.get(geomSig)
        : await computeAlignmentSafe(refPath, psd, referenceScan, pdfPageIdx, mode);
      if (!cached) geomCache.set(geomSig, alignment);
      if (alignment) {
        alignmentByPath.set(psd.path, alignment);
        const expectedSign = mode === "mode2" ? "+" : "-";
        const actualSign = alignment.offset_x === 0
          ? "0" : alignment.offset_x > 0 ? "+" : "-";
        const modeMatches = (mode === "mode2" && alignment.offset_x > 0)
          || (mode === "mode1" && alignment.offset_x < 0)
          || alignment.offset_x === 0;
        console.info(
          `[scan-adjust] page=${i + 1} mode=${mode} scale=${alignment.scale.toFixed(3)} offset=(${alignment.offset_x.toFixed(0)}, ${alignment.offset_y.toFixed(0)}) ${modeMatches ? "✓" : `⚠ 期待符号=${expectedSign}, 実符号=${actualSign}`}`,
        );
      }
      updateProgress({ current: i + 1, total: N, detail: `${modeLabel} ${i + 1}/${N} 完了`, showCount: false });
    }

    if (alignmentByPath.size === 0) {
      await hideProgress();
      await notifyDialog({
        title: "位置調整できません",
        message: `見本画像から alignment が計算できませんでした。見本ページの表示状態と、PSD/見本のページ対応を確認してください。${lastAlignmentError ? `\n\n詳細: ${lastAlignmentError}` : ""}`,
      });
      return;
    }

    beginHistoryTransient();
    let movedCount = 0;
    let skippedOutOfRange = 0, skippedNaN = 0;
    let transientCommitted = false;
    try {
      for (const layer of newLayers) {
        if (!layer || !layer.psdPath) continue;
        const alignment = alignmentByPath.get(layer.psdPath);
        if (!alignment) continue;
        if (!Number.isFinite(alignment.scale) || alignment.scale <= 0) continue;
        const idx = pathToIndex.get(layer.psdPath);
        const psd = psdPages[idx];
        const referenceScanPage = referenceScanForLayerAdjustment(referenceScanDoc, psdPageMap, idx, layer.sourceTxtRef);
        if (!psd || !referenceScanPage) continue;
        const sx = psd.width / Math.max(referenceScanPage.img_width, 1);
        const sy = psd.height / Math.max(referenceScanPage.img_height, 1);
        if (!Number.isFinite(sx) || sx <= 0 || !Number.isFinite(sy) || sy <= 0) continue;

        const halfW = getApproxLayerCenterDelta(layer, psd, "x");
        const halfH = getApproxLayerCenterDelta(layer, psd, "y");

        // referenceScan 元 bbox から refCx を取得 (idempotent)
        let refCx, refCy;
        const txtRef = layer.sourceTxtRef;
        const extractBlockIndex = Number.isInteger(txtRef?.extractBlockIndex) ? txtRef.extractBlockIndex : txtRef?.paragraphIndex;
        const block = (txtRef && Number.isInteger(extractBlockIndex))
          ? referenceScanPage?.blocks?.[extractBlockIndex]
          : null;
        if (block?.box && block.box.length >= 4) {
          refCx = (block.box[0] + block.box[2]) / 2;
          refCy = (block.box[1] + block.box[3]) / 2;
        } else {
          // sourceTxtRef がない (手動配置等) → 現在位置から逆算
          const psdCx = (layer.x ?? 0) + halfW;
          const psdCy = (layer.y ?? 0) + halfH;
          refCx = psdCx / sx;
          refCy = psdCy / sy;
        }

        // 補正後位置: newPsdCx = (refCx - offset_x) / scale
        const newPsdCx = (refCx - alignment.offset_x) / alignment.scale;
        const newPsdCy = (refCy - alignment.offset_y) / alignment.scale;

        // 範囲外飛び出しガード (PSD 寸法から ±30% 超え)
        const safetyMargin = 0.3;
        const cxOOR = newPsdCx < -psd.width * safetyMargin
          || newPsdCx > psd.width * (1 + safetyMargin);
        const cyOOR = newPsdCy < -psd.height * safetyMargin
          || newPsdCy > psd.height * (1 + safetyMargin);
        if (cxOOR || cyOOR) {
          console.warn(
            `[scan-adjust]   layer "${(layer.contents ?? "").slice(0, 12)}" 補正後位置が PSD 範囲外 → skip`,
          );
          skippedOutOfRange++;
          continue;
        }

        // 中心固定で top-left を再算出
        const newX = newPsdCx - halfW;
        const newY = newPsdCy - halfH;
        if (!Number.isFinite(newX) || !Number.isFinite(newY)) { skippedNaN++; continue; }

        // sizePt スナップ (mode2 のみ、idempotent な sizePtBasis ベースで計算)
        const snapHalfOrFull = (pt) => {
          const intPart = Math.floor(pt);
          const frac = pt - intPart;
          if (frac < 0.25) return intPart;
          if (frac < 0.75) return intPart + 0.5;
          return intPart + 1;
        };

        const changes = { x: newX, y: newY };
        if (mode === "mode2") {
          const autoSx = psd.width / Math.max(referenceScanPage.img_width, 1);
          const sizeCorrectionFactor = 1.0 / (autoSx * alignment.scale);
          if (Number.isFinite(sizeCorrectionFactor) && sizeCorrectionFactor > 0
              && Math.abs(sizeCorrectionFactor - 1.0) > 0.02) {
            const basis = Number.isFinite(layer.sizePtBasis) && layer.sizePtBasis > 0
              ? layer.sizePtBasis
              : (layer.sizePt ?? 12);
            const rawSizePt = basis * sizeCorrectionFactor;
            const snappedSizePt = snapHalfOrFull(rawSizePt);
            if (Number.isFinite(snappedSizePt) && snappedSizePt >= 6 && snappedSizePt <= 999) {
              changes.sizePt = snappedSizePt;
            }
          }
        }
        updateNewLayer(layer.tempId, changes);
        movedCount++;
      }
      if (movedCount > 0) {
        commitHistoryTransient();
        transientCommitted = true;
      }
    } finally {
      if (!transientCommitted) abortHistoryTransient();
    }
    console.info(
      `[scan-adjust] 完了: ${movedCount}/${newLayers.length} 件のレイヤーを移動 (skipped: outOfRange=${skippedOutOfRange}, NaN=${skippedNaN})`,
    );
    if (movedCount > 0) {
      try { renderAllSpreads(); } catch (_) {}
      try { rebuildLayerList(); } catch (_) {}
    }
    // 位置調整完了後、見本(PDF)と PSD の両方が全体表示になるようフィットへ揃える。
    fitBothPanesToWindow();
    await hideProgress({ success: true });
    if (!options?.automatic) await notifyDialog({
      title: `${modeLabel} 完了`,
      message: `${movedCount} 件のレイヤーを調整しました。`,
      kind: "success",
    });
  } catch (e) {
    console.error(e);
    await hideProgress();
    await notifyDialog({ title: `${modeLabel} エラー`, message: String(e?.message ?? e ?? "不明なエラー") });
  } finally {
    runningAdjust = false;
  }
}

// レイヤーの幅・高さの半分を返す簡易ヘルパー
function getApproxLayerCenterDelta(layer, psdPage, axis) {
  const sizePt = layer.sizePt ?? 24;
  const direction = layer.direction ?? "vertical";
  const leadingPct = layer.leadingPct ?? 125;
  const { width, height } = estimateLayerSize(psdPage, sizePt, layer.contents ?? "", leadingPct, direction);
  return axis === "x" ? width / 2 : height / 2;
}

// ============================================================
// 【v1.28.0 移植 mode3】重ね調整: 見本 + PSD を半透明で重ねて手動位置/スケール調整
// ============================================================

async function renderReferencePageToCanvas(pageIdx, preferredWidth = null) {
  const doc = getPdfDoc();
  if (!doc || typeof doc.getPage !== "function") return null;
  try {
    const total = doc.numPages ?? 0;
    const idx = Math.min(Math.max(pageIdx, 0), total - 1);
    const page = await doc.getPage(idx + 1);
    const baseViewport = page.getViewport({ scale: 1 });
    const targetW = Number.isFinite(preferredWidth) && preferredWidth > 0
      ? preferredWidth
      : Math.min(2000, baseViewport.width);
    const scale = targetW / baseViewport.width;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas;
  } catch (e) {
    console.warn("[scan-place] renderReferencePageToCanvas failed:", e);
    return null;
  }
}

// オーバーレイ調整モーダル: { scale_in_ref, offset_x_in_ref, offset_y_in_ref, ref_natural_w, ref_natural_h } を返す
function showOverlayAlignModal(refCanvas, psdCanvas) {
  return new Promise((resolve) => {
    const modal = $("overlay-align-modal");
    const stage = $("overlay-align-stage");
    const zoomLabel = $("overlay-align-zoom-label");
    const zoomInBtn = $("overlay-align-zoom-in");
    const zoomOutBtn = $("overlay-align-zoom-out");
    const swapBtn = $("overlay-align-swap");
    const resetBtn = $("overlay-align-reset");
    const cancelBtn = $("overlay-align-cancel");
    const okBtn = $("overlay-align-ok");
    if (!modal || !stage) { resolve(null); return; }

    stage.innerHTML = "";
    stage.classList.remove("dragging");

    modal.hidden = false;
    const stageRect = stage.getBoundingClientRect();
    const stageW = stageRect.width;
    const stageH = stageRect.height;
    if (stageW <= 0 || stageH <= 0) {
      modal.hidden = true;
      resolve(null);
      return;
    }

    const VIEW_FIT_RATIO = 0.8;
    const refW = refCanvas.width;
    const refH = refCanvas.height;
    const psdW = psdCanvas.width;
    const psdH = psdCanvas.height;
    const fitW = stageW * VIEW_FIT_RATIO;
    const fitH = stageH * VIEW_FIT_RATIO;
    const refBaseStageScale = Math.min(fitW / refW, fitH / refH);
    const psdBaseStageScale = Math.min(fitW / psdW, fitH / psdH);

    const refImg = document.createElement("canvas");
    refImg.className = "overlay-align-ref-img";
    refImg.width = refCanvas.width;
    refImg.height = refCanvas.height;
    stage.appendChild(refImg);

    const psdEl = document.createElement("canvas");
    psdEl.className = "overlay-align-psd-canvas";
    psdEl.width = psdCanvas.width;
    psdEl.height = psdCanvas.height;
    stage.appendChild(psdEl);

    const makeCyanInkCanvas = (sourceCanvas) => {
      const out = document.createElement("canvas");
      out.width = sourceCanvas.width;
      out.height = sourceCanvas.height;
      const src = document.createElement("canvas");
      src.width = sourceCanvas.width;
      src.height = sourceCanvas.height;
      const srcCtx = src.getContext("2d");
      srcCtx.drawImage(sourceCanvas, 0, 0);
      const image = srcCtx.getImageData(0, 0, src.width, src.height);
      const data = image.data;
      for (let i = 0; i < data.length; i += 4) {
        const lum = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
        const ink = Math.max(0, Math.min(255, 255 - lum));
        data[i] = 56;
        data[i + 1] = 202;
        data[i + 2] = 255;
        data[i + 3] = Math.round(ink * (data[i + 3] / 255));
      }
      out.getContext("2d").putImageData(image, 0, 0);
      return out;
    };
    const refCyanCanvas = makeCyanInkCanvas(refCanvas);
    const psdCyanCanvas = makeCyanInkCanvas(psdCanvas);
    const drawDisplayCanvas = (el, sourceCanvas, cyanCanvas, moving) => {
      const ctx = el.getContext("2d");
      ctx.clearRect(0, 0, el.width, el.height);
      ctx.drawImage(moving ? cyanCanvas : sourceCanvas, 0, 0);
    };

    let movingSide = "psd";
    let manualScale = 1.0;
    let moveOffsetX = 0;
    let moveOffsetY = 0;
    let refLeft = 0;
    let refTop = 0;
    let refStageScale = refBaseStageScale;
    let psdLeft = 0;
    let psdTop = 0;
    let psdStageScale = psdBaseStageScale;

    const centerLeft = (w, scale) => (stageW - w * scale) / 2;
    const centerTop = (h, scale) => (stageH - h * scale) / 2;
    const movingBaseScale = () => (
      movingSide === "psd"
        ? (refW * refBaseStageScale) / psdW
        : (psdW * psdBaseStageScale) / refW
    );

    const applyElementRect = (el, left, top, w, h, scale) => {
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
      el.style.width = `${w * scale}px`;
      el.style.height = `${h * scale}px`;
    };

    const getCurrentTransform = () => {
      if (movingSide === "psd") {
        const psdMovingScale = movingBaseScale() * manualScale;
        return {
          scale: psdMovingScale / refStageScale,
          offsetX: (moveOffsetX - refLeft) / refStageScale,
          offsetY: (moveOffsetY - refTop) / refStageScale,
        };
      }
      const refMovingScale = movingBaseScale() * manualScale;
      return {
        scale: psdStageScale / refMovingScale,
        offsetX: (psdLeft - moveOffsetX) / refMovingScale,
        offsetY: (psdTop - moveOffsetY) / refMovingScale,
      };
    };

    const setMovingStateFromTransform = (transform) => {
      const baseScale = movingBaseScale();
      if (movingSide === "psd") {
        const targetScale = refStageScale * transform.scale;
        manualScale = Math.max(0.1, Math.min(10, targetScale / baseScale));
        moveOffsetX = refLeft + refStageScale * transform.offsetX;
        moveOffsetY = refTop + refStageScale * transform.offsetY;
      } else {
        const targetScale = psdStageScale / Math.max(transform.scale, 0.000001);
        manualScale = Math.max(0.1, Math.min(10, targetScale / baseScale));
        const refMovingScale = baseScale * manualScale;
        moveOffsetX = psdLeft - refMovingScale * transform.offsetX;
        moveOffsetY = psdTop - refMovingScale * transform.offsetY;
      }
    };

    const updateLayout = () => {
      drawDisplayCanvas(refImg, refCanvas, refCyanCanvas, movingSide === "ref");
      drawDisplayCanvas(psdEl, psdCanvas, psdCyanCanvas, movingSide === "psd");
      refImg.classList.toggle("overlay-align-layer-moving", movingSide === "ref");
      refImg.classList.toggle("overlay-align-layer-base", movingSide !== "ref");
      psdEl.classList.toggle("overlay-align-layer-moving", movingSide === "psd");
      psdEl.classList.toggle("overlay-align-layer-base", movingSide !== "psd");
      if (swapBtn) swapBtn.textContent = movingSide === "psd" ? "見本を動かす" : "PSDを動かす";

      if (movingSide === "psd") {
        refStageScale = refBaseStageScale;
        refLeft = centerLeft(refW, refStageScale);
        refTop = centerTop(refH, refStageScale);
        applyElementRect(refImg, refLeft, refTop, refW, refH, refStageScale);

        const psdMovingScale = movingBaseScale() * manualScale;
        psdStageScale = psdMovingScale;
        psdLeft = moveOffsetX;
        psdTop = moveOffsetY;
        applyElementRect(psdEl, moveOffsetX, moveOffsetY, psdW, psdH, psdMovingScale);
      } else {
        psdStageScale = psdBaseStageScale;
        psdLeft = centerLeft(psdW, psdStageScale);
        psdTop = centerTop(psdH, psdStageScale);
        applyElementRect(psdEl, psdLeft, psdTop, psdW, psdH, psdStageScale);

        const refMovingScale = movingBaseScale() * manualScale;
        refStageScale = refMovingScale;
        refLeft = moveOffsetX;
        refTop = moveOffsetY;
        applyElementRect(refImg, moveOffsetX, moveOffsetY, refW, refH, refMovingScale);
      }
      if (zoomLabel) zoomLabel.textContent = `${(manualScale * 100).toFixed(0)}%`;
    };

    const resetMoving = () => {
      manualScale = 1.0;
      const baseScale = movingBaseScale();
      const w = movingSide === "psd" ? psdW : refW;
      const h = movingSide === "psd" ? psdH : refH;
      moveOffsetX = centerLeft(w, baseScale);
      moveOffsetY = centerTop(h, baseScale);
      updateLayout();
    };
    resetMoving();

    let dragging = false;
    let dragStartX = 0, dragStartY = 0;
    let dragStartOffsetX = 0, dragStartOffsetY = 0;
    const onStageMouseDown = (e) => {
      if (e.button !== 0) return;
      dragging = true;
      dragStartX = e.clientX; dragStartY = e.clientY;
      dragStartOffsetX = moveOffsetX; dragStartOffsetY = moveOffsetY;
      stage.classList.add("dragging");
      e.preventDefault();
    };
    const onStageMouseMove = (e) => {
      if (!dragging) return;
      moveOffsetX = dragStartOffsetX + (e.clientX - dragStartX);
      moveOffsetY = dragStartOffsetY + (e.clientY - dragStartY);
      updateLayout();
    };
    const onStageMouseUp = () => {
      if (!dragging) return;
      dragging = false;
      stage.classList.remove("dragging");
    };

    const zoomAt = (cx, cy, factor) => {
      const oldScale = manualScale;
      const newScale = Math.max(0.1, Math.min(10, oldScale * factor));
      const baseScale = movingBaseScale();
      const localX = (cx - moveOffsetX) / (baseScale * oldScale);
      const localY = (cy - moveOffsetY) / (baseScale * oldScale);
      manualScale = newScale;
      moveOffsetX = cx - localX * (baseScale * newScale);
      moveOffsetY = cy - localY * (baseScale * newScale);
      updateLayout();
    };

    const onStageWheel = (e) => {
      e.preventDefault();
      const stageRect2 = stage.getBoundingClientRect();
      zoomAt(
        e.clientX - stageRect2.left,
        e.clientY - stageRect2.top,
        e.deltaY < 0 ? 1.05 : (1 / 1.05),
      );
    };

    const zoomBy = (factor) => zoomAt(stageW / 2, stageH / 2, factor);
    const onZoomIn = () => zoomBy(1.1);
    const onZoomOut = () => zoomBy(1 / 1.1);
    const onReset = () => resetMoving();
    const onSwap = () => {
      const transform = getCurrentTransform();
      movingSide = movingSide === "psd" ? "ref" : "psd";
      updateLayout();
      setMovingStateFromTransform(transform);
      updateLayout();
    };

    const cleanup = (result) => {
      stage.removeEventListener("mousedown", onStageMouseDown);
      window.removeEventListener("mousemove", onStageMouseMove);
      window.removeEventListener("mouseup", onStageMouseUp);
      stage.removeEventListener("wheel", onStageWheel);
      zoomInBtn?.removeEventListener("click", onZoomIn);
      zoomOutBtn?.removeEventListener("click", onZoomOut);
      swapBtn?.removeEventListener("click", onSwap);
      resetBtn?.removeEventListener("click", onReset);
      cancelBtn?.removeEventListener("click", onCancel);
      okBtn?.removeEventListener("click", onOk);
      document.removeEventListener("keydown", onKey);
      modal.hidden = true;
      stage.innerHTML = "";
      resolve(result);
    };

    const onCancel = () => cleanup(null);
    const onOk = () => {
      const transform = getCurrentTransform();
      cleanup({
        scale_in_ref: transform.scale,
        offset_x_in_ref: transform.offsetX,
        offset_y_in_ref: transform.offsetY,
        ref_natural_w: refW,
        ref_natural_h: refH,
      });
    };
    const onKey = (e) => {
      if (e.key === "Escape") onCancel();
      else if (e.key === "Enter") onOk();
    };

    stage.addEventListener("mousedown", onStageMouseDown);
    window.addEventListener("mousemove", onStageMouseMove);
    window.addEventListener("mouseup", onStageMouseUp);
    stage.addEventListener("wheel", onStageWheel, { passive: false });
    zoomInBtn?.addEventListener("click", onZoomIn);
    zoomOutBtn?.addEventListener("click", onZoomOut);
    swapBtn?.addEventListener("click", onSwap);
    resetBtn?.addEventListener("click", onReset);
    cancelBtn?.addEventListener("click", onCancel);
    okBtn?.addEventListener("click", onOk);
    document.addEventListener("keydown", onKey);
  });
}

async function runOverlayAlign(options = {}) {
  if (runningAdjust) return;
  const progressFlow = options.progressFlowId
    ? { id: options.progressFlowId, stepId: "align" }
    : options.progressFlow;
  const psdPages = getPages();
  if (!psdPages || psdPages.length === 0) {
    await notifyDialog({ title: "重ね調整できません", message: "PSD が読み込まれていません。" });
    return;
  }
  const referencePaths = getPdfPaths();
  if (!referencePaths || referencePaths.length === 0) {
    await notifyDialog({ title: "重ね調整できません", message: "見本画像が読み込まれていません。" });
    return;
  }
  const newLayers = getNewLayers();
  if (!newLayers || newLayers.length === 0) {
    await notifyDialog({ title: "重ね調整できません", message: "配置済みのテキストレイヤーがありません。" });
    return;
  }

  const psd0 = psdPages[0];
  if (!psd0?.canvas) {
    await notifyDialog({ title: "重ね調整できません", message: "PSD canvas が取得できませんでした。" });
    return;
  }
  const refCanvas = await renderReferencePageToCanvas(0);
  if (!refCanvas) {
    await notifyDialog({ title: "見本の取得失敗", message: "見本画像が描画できませんでした。" });
    return;
  }

  const result = await showOverlayAlignModal(refCanvas, psd0.canvas);
  if (!result) return;

  const referenceScanDoc = getScanExtractDoc()?.doc;
  const psdPageMap = buildPsdPageMap(psdPages, referenceScanDoc?.pages?.length ?? 0);

  runningAdjust = true;
  showProgress(withProgressFlow(progressFlow, {
    title: progressFlow ? "自動配置中…" : undefined,
    detail: "重ね調整 中…",
    icon: PLACE_ICON_SVG,
    label: "重ね調整",
    variant: "place",
    showCount: false,
  }));

  // 【bugfix】重ね調整モーダルは psd0.canvas (= 大きい PSD では表示用に縮小されたプレビュー
  // canvas) のピクセル寸法で transform を算出する。result.scale_in_ref は「ref自然px / PSD
  // *canvas*px」単位なので、そのまま実寸 (logical) 座標として適用するとプレビュー縮小率ぶん
  // 位置が原点 (左上) 方向に縮んで全レイヤーが左上に固まる。canvas→logical 係数で補正して
  // 「ref自然px / PSD *logical*px」へ換算する (小さい PSD では canvas==logical で係数=1 の no-op)。
  const psd0CanvasW = Number(psd0?.canvas?.width);
  const psd0LogicalW = Number(psd0?.width);
  const overlayCanvasToLogical = (Number.isFinite(psd0CanvasW) && psd0CanvasW > 0
    && Number.isFinite(psd0LogicalW) && psd0LogicalW > 0)
    ? (psd0CanvasW / psd0LogicalW)
    : 1;
  const scaleInRefLogical = result.scale_in_ref * overlayCanvasToLogical;

  beginHistoryTransient();
  let movedCount = 0;
  let transientCommitted = false;
  try {
    for (const layer of newLayers) {
      if (!layer || !layer.psdPath) continue;
      const idx = psdPages.findIndex((p) => p?.path === layer.psdPath);
      if (idx < 0) continue;
      const psd = psdPages[idx];
      const referenceScanPage = referenceScanForLayerAdjustment(referenceScanDoc, psdPageMap, idx, layer.sourceTxtRef);
      if (!psd || !referenceScanPage) continue;
      const referenceScanW = Math.max(referenceScanPage.img_width, 1);
      const referenceScanH = Math.max(referenceScanPage.img_height, 1);
      const sx = psd.width / referenceScanW;
      const sy = psd.height / referenceScanH;
      if (!Number.isFinite(sx) || sx <= 0) continue;

      const referenceScanPerRefX = referenceScanW / result.ref_natural_w;
      const referenceScanPerRefY = referenceScanH / result.ref_natural_h;
      const alignScaleX = scaleInRefLogical * referenceScanPerRefX;
      const alignScaleY = scaleInRefLogical * referenceScanPerRefY;
      const alignScale = (alignScaleX + alignScaleY) / 2;
      const alignOffsetX = result.offset_x_in_ref * referenceScanPerRefX;
      const alignOffsetY = result.offset_y_in_ref * referenceScanPerRefY;

      let refCx, refCy;
      const txtRef = layer.sourceTxtRef;
      const extractBlockIndex = Number.isInteger(txtRef?.extractBlockIndex) ? txtRef.extractBlockIndex : txtRef?.paragraphIndex;
      const block = (txtRef && Number.isInteger(extractBlockIndex))
        ? referenceScanPage?.blocks?.[extractBlockIndex]
        : null;
      if (block?.box && block.box.length >= 4) {
        refCx = (block.box[0] + block.box[2]) / 2;
        refCy = (block.box[1] + block.box[3]) / 2;
      } else {
        const halfW0 = getApproxLayerCenterDelta(layer, psd, "x");
        const halfH0 = getApproxLayerCenterDelta(layer, psd, "y");
        const psdCx = (layer.x ?? 0) + halfW0;
        const psdCy = (layer.y ?? 0) + halfH0;
        refCx = psdCx / sx;
        refCy = psdCy / sy;
      }

      const newPsdCx = (refCx - alignOffsetX) / alignScale;
      const newPsdCy = (refCy - alignOffsetY) / alignScale;

      const autoSx = sx;
      const sizeCorrectionFactor = 1.0 / (autoSx * alignScale);
      const snapHalfOrFull = (pt) => {
        const intPart = Math.floor(pt);
        const frac = pt - intPart;
        if (frac < 0.25) return intPart;
        if (frac < 0.75) return intPart + 0.5;
        return intPart + 1;
      };

      const halfW = getApproxLayerCenterDelta(layer, psd, "x");
      const halfH = getApproxLayerCenterDelta(layer, psd, "y");
      const newX = newPsdCx - halfW;
      const newY = newPsdCy - halfH;
      if (!Number.isFinite(newX) || !Number.isFinite(newY)) continue;

      const changes = { x: newX, y: newY };
      if (Number.isFinite(sizeCorrectionFactor) && sizeCorrectionFactor > 0
          && Math.abs(sizeCorrectionFactor - 1.0) > 0.02) {
        const basis = Number.isFinite(layer.sizePtBasis) && layer.sizePtBasis > 0
          ? layer.sizePtBasis
          : (layer.sizePt ?? 12);
        const rawSize = basis * sizeCorrectionFactor;
        const snapped = snapHalfOrFull(rawSize);
        if (Number.isFinite(snapped) && snapped >= 6 && snapped <= 999) {
          changes.sizePt = snapped;
        }
      }
      updateNewLayer(layer.tempId, changes);
      movedCount++;
    }
    if (movedCount > 0) {
      commitHistoryTransient();
      transientCommitted = true;
    }
  } finally {
    if (!transientCommitted) abortHistoryTransient();
    runningAdjust = false;
  }

  console.info(`[scan-adjust mode3] alignScale=${result.scale_in_ref.toFixed(4)}, offset_in_ref=(${result.offset_x_in_ref.toFixed(0)}, ${result.offset_y_in_ref.toFixed(0)}), ${movedCount} 件移動`);
  if (movedCount > 0) {
    try { renderAllSpreads(); } catch (_) {}
    try { rebuildLayerList(); } catch (_) {}
  }
  // 重ね調整完了後、見本(PDF)と PSD の両方が全体表示になるようフィットへ揃える。
  fitBothPanesToWindow();
  if (progressFlow) {
    completeProgressFlowStep(progressFlow, { detail: "重ね調整 完了" });
    await waitForTransitionPaint();
  }
  if (!options.skipFinalHide) {
    await hideProgress({ success: true });
    await notifyDialog({
      title: "重ね調整 完了",
      message: `${movedCount} 件のレイヤーを調整しました。`,
      kind: "success",
    });
  }
}

const POSITION_ADJUST_OPTIONS = [
  {
    mode: "none",
    title: "位置調整なし",
    description: "自動配置のみ行う",
    run: () => undefined,
  },
  {
    mode: "mode1",
    title: "位置調整1",
    description: "PSDに余分余白あり",
    run: () => runPositionAdjust("mode1"),
  },
  {
    mode: "mode2",
    title: "位置調整2",
    description: "見本に余分余白あり",
    run: () => runPositionAdjust("mode2"),
  },
  {
    mode: "mode3",
    title: "重ね調整",
    description: "見本にPSDを重ねて手動調整",
    run: () => runOverlayAlign(),
  },
];

export function getPositionAdjustOptions() {
  return POSITION_ADJUST_OPTIONS.map(({ mode, title, description }) => ({ mode, title, description }));
}

export async function runSelectedPositionAdjust(mode, options = {}) {
  if (mode === "none") return undefined;
  const alignFlow = options.progressFlowId ? { id: options.progressFlowId, stepId: "align" } : options.progressFlow;
  if (alignFlow) {
    updateProgressFlow(alignFlow, { detail: "位置調整中…", progress: 15, showCount: false });
  }
  let result;
  if (mode === "mode3") result = await runOverlayAlign(options);
  else if (mode === "mode1" || mode === "mode2") result = await runPositionAdjust(mode, options);
  else return undefined;
  if (alignFlow && mode !== "mode3") {
    completeProgressFlowStep(alignFlow, { detail: "位置調整 完了" });
  }
  return result;
}

function renderPositionAdjustPreview(mode) {
  if (mode === "none") {
    return `
      <span class="scan-adjust-choice-preview scan-adjust-choice-preview-none" aria-hidden="true">
        <svg class="scan-adjust-choice-preview-text-icon" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
          <path d="M8 10h48v15h-8v-7H36v36h8v8H20v-8h8V18H16v7H8V10z" fill="currentColor"></path>
        </svg>
        <svg class="scan-adjust-choice-preview-arrow" viewBox="0 0 32 20" aria-hidden="true" focusable="false">
          <path d="M3 10h22M17 3l8 7-8 7" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"></path>
        </svg>
        <span class="scan-adjust-choice-preview-doc scan-adjust-choice-preview-single">PSD</span>
      </span>`;
  }
  if (mode === "mode3") {
    return `
      <span class="scan-adjust-choice-preview scan-adjust-choice-preview-overlay" aria-hidden="true">
        <span class="scan-adjust-choice-preview-photo scan-adjust-choice-preview-photo-back">
          <span class="scan-adjust-choice-preview-mountain"></span>
        </span>
        <span class="scan-adjust-choice-preview-photo scan-adjust-choice-preview-photo-front">
          <span class="scan-adjust-choice-preview-sun"></span>
          <span class="scan-adjust-choice-preview-mountain"></span>
        </span>
      </span>`;
  }

  const isMode1 = mode === "mode1";
  return `
    <span class="scan-adjust-choice-preview scan-adjust-choice-preview-offset ${isMode1 ? "is-psd-framed" : "is-reference-framed"}" aria-hidden="true">
      <span class="scan-adjust-choice-preview-doc scan-adjust-choice-preview-reference">見本</span>
      <span class="scan-adjust-choice-preview-doc scan-adjust-choice-preview-psd">PSD</span>
    </span>`;
}

function ensurePositionAdjustDialog() {
  let modal = $("scan-adjust-choice-modal");
  if (modal) return modal;
  modal = document.createElement("div");
  modal.id = "scan-adjust-choice-modal";
  modal.className = "scan-adjust-choice-modal";
  modal.hidden = true;
  modal.innerHTML = `
    <div class="scan-adjust-choice-backdrop" data-close="1"></div>
    <div class="scan-adjust-choice-card" role="dialog" aria-modal="true" aria-labelledby="scan-adjust-choice-title">
      <div class="scan-adjust-choice-header">
        <span class="scan-adjust-choice-title" id="scan-adjust-choice-title">位置調整を選択</span>
      </div>
      <div class="scan-adjust-choice-list">
        ${POSITION_ADJUST_OPTIONS.map((option) => `
          <button class="scan-adjust-choice-option" type="button" data-mode="${option.mode}">
            <span class="scan-adjust-choice-option-text">
              <span class="scan-adjust-choice-option-title">${option.title}</span>
              <span class="scan-adjust-choice-option-desc">${option.description}</span>
            </span>
            ${renderPositionAdjustPreview(option.mode)}
          </button>
        `).join("")}
      </div>
      <div class="scan-adjust-choice-actions">
        <button class="scan-adjust-choice-cancel" type="button" data-close="1">キャンセル</button>
      </div>
    </div>`;
  modal.addEventListener("click", (e) => {
    if (modal.dataset.chooseOnly === "1") return;
    const close = e.target?.closest?.("[data-close]");
    if (close) {
      closePositionAdjustDialog();
      return;
    }
    const btn = e.target?.closest?.(".scan-adjust-choice-option");
    if (!btn) return;
    const option = POSITION_ADJUST_OPTIONS.find((item) => item.mode === btn.dataset.mode);
    closePositionAdjustDialog();
    if (option) void option.run();
  });
  document.body.appendChild(modal);
  return modal;
}

function openPositionAdjustDialog() {
  const modal = ensurePositionAdjustDialog();
  modal.hidden = false;
  requestAnimationFrame(() => {
    modal.classList.add("visible");
    modal.querySelector(".scan-adjust-choice-option")?.focus();
  });
}

function closePositionAdjustDialog() {
  const modal = $("scan-adjust-choice-modal");
  if (!modal) return;
  modal.classList.remove("visible");
  window.setTimeout(() => { modal.hidden = true; }, 120);
}

// options.keepOpen が true なら、ユーザーが OK を選んでも modal を閉じずに保持する。
// 呼び出し側で progress modal をフェードイン完了させた後に明示的に
// closePositionAdjustDialogExternal() を呼ぶことで「位置調整 → progress への引き継ぎ」
// 中にホーム画面が透けて見える事故を避ける用途。cancel (null) のときは即時 close する。
export function choosePositionAdjustMode(options = {}) {
  return new Promise((resolve) => {
    const modal = ensurePositionAdjustDialog();
    let settled = false;
    const onClick = (e) => {
      const close = e.target?.closest?.("[data-close]");
      if (close) {
        e.preventDefault();
        e.stopImmediatePropagation();
        cleanup(null);
        return;
      }
      const btn = e.target?.closest?.(".scan-adjust-choice-option");
      if (!btn) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      cleanup(btn.dataset.mode || null);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cleanup(null);
      }
    };
    const cleanup = (value) => {
      if (settled) return;
      settled = true;
      delete modal.dataset.chooseOnly;
      modal.removeEventListener("click", onClick, true);
      window.removeEventListener("keydown", onKey, true);
      // OK 選択 + keepOpen のとき modal は表示維持（呼出側が後で閉じる）。
      // それ以外 (cancel / keepOpen 無し) は即時クローズ。
      if (!options.keepOpen || value == null) {
        closePositionAdjustDialog();
      }
      resolve(value);
    };
    modal.dataset.chooseOnly = "1";
    modal.addEventListener("click", onClick, true);
    window.addEventListener("keydown", onKey, true);
    modal.hidden = false;
    requestAnimationFrame(() => {
      modal.classList.add("visible");
      modal.querySelector(".scan-adjust-choice-option")?.focus();
    });
  });
}

// 外部から位置調整 modal を閉じるための公開 API（keepOpen 経路用）。
export function closePositionAdjustModalExternal() {
  closePositionAdjustDialog();
}

export function bindPositionAdjustButton() {
  const menuBtn = $("scan-adjust-menu-btn");
  if (!menuBtn) return;
  menuBtn.addEventListener("click", () => {
    if (!menuBtn.disabled) openPositionAdjustDialog();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("scan-adjust-choice-modal")?.hidden) {
      e.preventDefault();
      closePositionAdjustDialog();
    }
  });
  const sync = () => {
    const locked = isScanActionsLocked();
    const has = getNewLayers().some((l) => l && l.tempId);
    const disabled = locked || !has;
    const titleWhenDisabled = locked
      ? "画像スキャンエンジンが未インストールです。"
      : "先に自動配置を実行してください";
    menuBtn.disabled = disabled;
    menuBtn.title = disabled ? titleWhenDisabled : "位置調整を選択";
  };
  sync();
  onScanExtractDocChange(sync);
  onTxtSourceChange(sync);
  window.addEventListener("psdesign:scan-actions-lock-change", sync);
  setInterval(sync, 1000);
}
