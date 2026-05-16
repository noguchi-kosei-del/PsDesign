// 吹き出し検出 × TXT 自動配置 (v1.2.0)
//
// ai-ocr.js が保存した MokuroDocument (吹き出し座標 + OCR テキスト) と、
// txt-source.js から取れる TXT ブロック (ページ別) を突き合わせ、
// PSD の正しい位置に新規テキストレイヤーを生成する。
//
// 配置確定後は state.newLayers に積まれ、renderOverlay() が in-app プレビュー
// に即座に反映する。実際の Photoshop 書き出しは既存の Ctrl+S (保存) フロー。

import {
  getPages,
  getAiOcrDoc,
  onAiOcrDocChange,
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
  getTxtSource,
  onTxtSourceChange,
  getNewLayers,
  updateNewLayer,
  beginHistoryTransient,
  commitHistoryTransient,
  abortHistoryTransient,
} from "./state.js";
import { parsePages, convertHalfToFullForVertical, renderTxtSourceViewer } from "./txt-source.js";
import { notifyDialog, confirmDialog, hideProgress, promptDialog, showProgress, updateProgress } from "./ui-feedback.js";
import { loadPsdFilesByPaths, pickPsdFiles } from "./services/psd-load.js";
import { runAiOcrForFiles, PLACE_ICON_SVG } from "./ai-ocr.js";
import { renderAllSpreads } from "./spread-view.js";
import { rebuildLayerList } from "./text-editor.js";
import { getDefault } from "./settings.js";
import { sortBlocksMangaOrder } from "./utils/manga-order.js";

const $ = (id) => document.getElementById(id);

let runningPlace = false;
// 【v1.28.0 移植】位置調整 (3 モード) の二重起動防止フラグ
let runningAdjust = false;
// 直近に適用された配置プランのテキスト内容指紋。
// 同一テキストで連続して自動配置するときに確認ダイアログを出すために使う。
let lastPlacedFingerprint = null;

function isAiActionsLocked() {
  return $("ai-actions-row")?.classList.contains("ai-actions-row-locked") ?? false;
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
// 【v1.x.0】句読点ツメ対象の文字（、 / 。）— canvas-tools.js の PUNCT_TSUME_CHAR_CODES と同一定義。
// 自動配置時の bbox 推定にも反映するため、`、` `。` の個数だけ longest 行の effective 長を縮める。
const PUNCT_TSUME_CHARS_AI = new Set(["、", "。"]);
function countPunctTsumeCharsAI(line) {
  if (!line) return 0;
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    if (PUNCT_TSUME_CHARS_AI.has(line[i])) n++;
  }
  return n;
}
// 【v1.x.0】縦中横の bbox 補正用カウント。
// ai-place.js は文字数ベース（estimateLayerSize: `effective = ln.length - … - tcyPairs`）で
// 概算するため、半角・全角どちらの TCY ペアでも「2 文字 → 1 セル」として 1 ぶん引く。
// 自動配置時の bbox 縦長を「実描画セル数」に揃える目的（フレーム末尾の余白を解消）。
// canvas-tools.js (measureText 経路) は別ロジックで半角/全角の差を実測補正する。
function countTcyPairsAI(line) {
  if (!line || line.length < 2) return 0;
  let n = 0;
  for (let k = 0; k < line.length - 1; ) {
    const two = line.slice(k, k + 2);
    if (two === "!!" || two === "!?" || two === "！！" || two === "！？") {
      n++;
      k += 2;
    } else {
      k += 1;
    }
  }
  return n;
}
// canvas-tools.js layerRectForNew の幅・高さ計算と同一ロジック (px は PSD 座標)。
// thick / long の安全余白 (+0.4em) も canvas-tools.js と揃える。
// 【v1.x.0】句読点ツメ (`punctuationTsumePercent`) を long 軸にも反映:
//   各行の effective char count = (chars - punctCount × tsume/100)。
//   最も長い行（実 char で）の effective 長を採用。
// 【v1.x.0】縦中横（!!/!?/！！/！？）も long 軸に反映: TCY ペアあたり 1em 引く。
function estimateLayerSize(psdPage, sizePt, contents, leadingPct, direction) {
  const dpi = psdPage.dpi ?? 72;
  const ptInPsdPx = sizePt * (dpi / 72);
  const lineCount = Math.max(1, countLines(contents));
  const leadingFactor = (leadingPct ?? 125) / 100;
  const thick = Math.max(24, ptInPsdPx * (leadingFactor * lineCount + 0.4));
  // 句読点ツメぶんを差し引いた最大行幅（em 単位）を計算
  const tsumePct = Number(getDefault("punctuationTsumePercent")) || 0;
  const tsumeMag = tsumePct > 0 ? tsumePct / 100 : 0;
  const isVertical = direction !== "horizontal";
  // 縦中横は縦書きレイヤー + 設定 ON のときのみ bbox 計算に反映
  const tcyEnabled = isVertical && (getDefault("tateChuYokoEnabled") !== false);
  let maxEffectiveChars = 1;
  for (const ln of String(contents ?? "").split(/\r?\n/)) {
    const punct = tsumeMag > 0 ? countPunctTsumeCharsAI(ln) : 0;
    const tcyPairs = tcyEnabled ? countTcyPairsAI(ln) : 0;
    // TCY ペア 1 個あたり 2 文字 → 1 セル幅に圧縮されるので 1em ぶん引く。
    const effective = ln.length - punct * tsumeMag - tcyPairs;
    if (effective > maxEffectiveChars) maxEffectiveChars = effective;
  }
  const longRaw = Math.max(ptInPsdPx * 2, ptInPsdPx * (1.05 * maxEffectiveChars + 0.4));
  const maxLong = isVertical ? psdPage.height * 0.95 : psdPage.width * 0.95;
  const long = Math.min(longRaw, maxLong);
  return {
    width:  isVertical ? thick : long,
    height: isVertical ? long  : thick,
  };
}

// 画像スキャンエンジン (吹き出し検出側) が吹き出しごとに推定した font_size（OCR 入力画像のピクセル）を、
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
// TXT contents から導出する（block.lines は OCR 出力で実配置 TXT と乖離するため）。
// bbox 長軸 cap も追加して過大検出を抑える。
function detectSizePtFromBlock(block, mokuroPage, psdPage, contents) {
  const fs = block?.font_size;
  if (!Number.isFinite(fs) || fs <= 0) return null;
  const sx = psdPage.width / Math.max(mokuroPage.img_width, 1);
  const sy = psdPage.height / Math.max(mokuroPage.img_height, 1);
  const scale = Math.min(sx, sy);
  if (!(scale > 0)) return null;
  const dpi = psdPage.dpi ?? 72;

  // 1) detector の font_size を PSD pt に換算 + 軽いキャリブレーション
  let pt = ((fs * scale) * 72) / dpi * FONT_SIZE_CALIBRATION;

  // 2) 行数 / 最長文字数は TXT 側 contents から導出する方が信頼できる (要件③)。
  //    block.lines は OCR が分割した行数で、実際に配置する TXT セリフとは乖離する
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
  console.info(`[ai-place]${debugTag} blocks=${n} groups=${nextGroupId} connected_groups=${connectedGroupCount}`);
  for (let i = 0; i < n; i++) {
    const b = blocks[i].box;
    const fs = blocks[i].font_size;
    const v = blocks[i].vertical;
    console.info(
      `[ai-place]${debugTag} [block ${i}] vert=${v} fs=${fs} bbox=(${Math.round(b[0])},${Math.round(b[1])})-(${Math.round(b[2])},${Math.round(b[3])}) groupId=${groupIds[i]}${memberCount[groupIds[i]] >= 2 ? " ★連結" : ""}`,
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
      `[ai-place]${debugTag} ${tag} pair(${p.i},${p.j}): primaryGap=${p.primaryGap.toFixed(0)}/${p.primaryTol.toFixed(0)} perpDiff=${p.perpDiff.toFixed(0)}/${p.perpTol.toFixed(0)} sideGap=${p.sideGap.toFixed(0)}/${p.sideTol.toFixed(0)} sideCenter=${p.sideCenterDiff.toFixed(0)}/${p.perpTol.toFixed(0)} fsRatio=${p.fsRatio.toFixed(2)} → ${p.reason}`,
    );
  }
  if (sortedPairs.length > showCount) {
    console.info(`[ai-place]${debugTag} (... 残り ${sortedPairs.length - showCount} ペアは省略 / 距離が遠いため)`);
  }
  return groupIds.map((g) => ({ groupId: g, connected: memberCount[g] >= 2 }));
}

// 【v1.28.0 移植 (PsDesign-main v1.24.0+ / v1.25.0)】
// 見本と PSD の差分から scale + offset を Rust の compute_alignment で計算。
// mode = "mode1" (PSDに余分) / "mode2" (見本に余分) を Rust に渡す。
// PDF / JPEG / PNG に対応。失敗 / 見本未指定 は null を返してフォールバック。
let lastAlignmentError = "";

async function computeAlignmentSafe(referencePath, psdPage, mokuroPage, pdfPageIndex = 0, mode = "mode1") {
  if (!referencePath) return null;
  if (!psdPage?.canvas) return null;
  const errors = [];
  try {
    const psdBase64 = psdPage.canvas.toDataURL("image/png");
    const refBboxes = (mokuroPage?.blocks ?? []).map((b) => ({
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
      // mokuro OCR の入力画像サイズを Rust に渡し、
      // alignment.offset を mokuro 単位 (= bbox 座標と同単位) で計算させる
      mokuroImgWidth: mokuroPage?.img_width ?? null,
      mokuroImgHeight: mokuroPage?.img_height ?? null,
    });

    if (/\.(jpe?g|png|pdf)$/i.test(referencePath)) {
      try {
        const result = await invokeAlignment(null);
        lastAlignmentError = "";
        return result;
      } catch (e) {
        errors.push(`file: ${String(e?.message ?? e)}`);
      }
    }

    const refCanvas = await renderReferencePageToCanvas(pdfPageIndex, mokuroPage?.img_width ?? null);
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
  } catch (e) {
    errors.push(`unexpected: ${String(e?.message ?? e)}`);
  }
  lastAlignmentError = errors.join(" / ");
  console.warn(`[ai-place] compute_alignment 失敗 (${referencePath}): ${lastAlignmentError}`);
  return null;
}

function mapBlockToNewLayer(block, mokuroPage, psdPage, contents, defaults, sourceTxtRef, groupInfo, alignment) {
  const sx = psdPage.width / Math.max(mokuroPage.img_width, 1);
  const sy = psdPage.height / Math.max(mokuroPage.img_height, 1);
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
  const text = convertHalfToFullForVertical(contents ?? "", direction);
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
    const detectedPt = detectSizePtFromBlock(block, mokuroPage, psdPage, text);
    sizePt = detectedPt ?? defaults.sizePt ?? 24;
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
  // Rust 側 (ocr.rs analyze_doc_in_place) が各 block の bbox 外周を解析し以下を埋めている:
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
    if (score >= threshold) {
      fontPostScriptName = defaults.cloudShapeFontPostScriptName;
      autoFontSwitched = true;
      // bucket: 50-59 → 0, 60-69 → 1, 70-79 → 2, 80-89 → 3, 90-99 → 4, 100 → 5
      autoFontSwitchBucket = Math.max(0, Math.min(5, Math.floor((score - 0.5) / 0.1)));
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
    `[ai-place] surround page=${(sourceTxtRef?.pageNumber ?? "?")} idx=${sourceTxtRef?.paragraphIndex ?? "?"} white=${wrStr} edge=${ecStr} minSeg=${msStr} bg=${bgScore.toFixed(2)} uni=${uniScore.toFixed(2)} ${tags.length ? "[" + tags.join(", ") + "]" : "[default]"}`,
  );

  return {
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
    autoFontSwitched,        // UI で色強調するためのフラグ
    autoFontSwitchBucket,    // 0..5 の 10% 刻みバケット (UI 色分け用)、-1 は未切替
  };
}

// 吹き出しに対応しない「余り TXT 段落」を PSD ページの幾何中心 (width/2, height/2)
// に配置する。ユーザーが PSD 未読込時にテキストを追加したケース、または OCR の
// 吹き出し検出数より原稿段落が多いケースで使う（旧仕様では `leftoverTxt` として
// 捨てていたが、画像中央に置くことで全段落を必ず配置に乗せる）。
// direction は吹き出し情報がないため `getNewTextDirection()` (UI トグル) を採用。
function mapTxtToPageCenter(psdPage, contents, defaults, sourceTxtRef) {
  const direction = getNewTextDirection();
  const text = convertHalfToFullForVertical(contents ?? "", direction);
  const sizePt = defaults.sizePt ?? 24;
  const { width, height } = estimateLayerSize(
    psdPage, sizePt, text, defaults.leadingPct ?? 125, direction,
  );
  // PSD ページの幾何中心 (width/2, height/2) を bbox 中央に合わせる top-left に変換。
  const x = psdPage.width / 2 - width / 2;
  const y = psdPage.height / 2 - height / 2;
  return {
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
  };
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
//         leftoverBubbles, // 余り吹き出しの OCR テキスト配列
//       }, ...
//     ],
//     totals: { placed, leftoverTxt, leftoverBubbles },
//   }
function buildPlacementPlan(mokuroDoc, psdPages, txtByPage, defaults) {
  const N = Math.min(psdPages.length, mokuroDoc.pages.length);
  const out = { pages: [], totals: { placed: 0, leftoverTxt: 0, leftoverBubbles: 0 } };
  const baseName = (p) => {
    const m = p && p.match(/[\\/]([^\\/]+)$/);
    return m ? m[1] : (p || "");
  };
  for (let i = 0; i < N; i++) {
    const psd = psdPages[i];
    const mokuro = mokuroDoc.pages[i];
    const txt = txtByPage.get(i + 1) ?? [];
    const sorted = sortBlocksMangaOrder(mokuro.blocks ?? []);
    // 【v1.26.0 移植 (PsDesign-main v1.24.0 要件①)】
    // 連結グループ判定 (ひょうたん型フキダシ検出)。Union-Find で 3 条件 (vertical 一致 +
    // font_size 近 + bbox 重なり/近接) を満たすペアが同グループになる。
    // 連結グループに属する block は mapBlockToNewLayer 内でサイズを defaults.sizePt に統一。
    const groups = groupConnectedBlocks(sorted, ` page ${i + 1}`);
    const layers = [];
    // 全 TXT 段落を配置: sorted[j] があれば吹き出し中央、無ければ PSD ページ中央。
    // 旧仕様は placedCount = min(txt, sorted) で余り TXT を捨てていたが、ユーザーが
    // 入力欄から追加した段落も自動配置で拾うために全件処理に変更。
    for (let j = 0; j < txt.length; j++) {
      const block = sorted[j];
      const sourceTxtRef = { pageNumber: i + 1, paragraphIndex: j };
      if (block) {
        layers.push(mapBlockToNewLayer(block, mokuro, psd, txt[j], defaults, sourceTxtRef, groups[j]));
      } else {
        // 余り TXT: PSD ページ中央に配置
        layers.push(mapTxtToPageCenter(psd, txt[j], defaults, sourceTxtRef));
      }
    }
    const placedCount = txt.length;
    // leftoverTxt は実質ゼロになるが、互換のため空配列で保持する
    const leftoverTxt = [];
    const leftoverBubbles = sorted.slice(txt.length).map((b) =>
      Array.isArray(b.lines) ? b.lines.join(" ") : ""
    );
    let status = "ok";
    if (sorted.length === 0 && txt.length === 0) status = "ok";
    else if (sorted.length === 0) status = "warn-empty-bubble";
    else if (txt.length === 0) status = "warn-empty-txt";
    // 旧 "warn-txt-extra" は廃止: 余り TXT は PSD 中央配置に変わったので警告不要。
    else if (sorted.length > txt.length) status = "warn-bubble-extra";

    out.pages.push({
      pageIndex: i + 1,
      psdName: baseName(psd.path),
      bubbleCount: sorted.length,
      txtCount: txt.length,
      placedCount,
      status,
      layers,
      leftoverTxt,
      leftoverBubbles,
    });
    out.totals.placed += placedCount;
    out.totals.leftoverTxt += leftoverTxt.length;
    out.totals.leftoverBubbles += leftoverBubbles.length;
  }
  // PSD 数 / OCR ページ数の不一致を末尾に warning として記録
  if (psdPages.length > N) {
    out.unmappedPsdCount = psdPages.length - N;
  }
  if (mokuroDoc.pages.length > N) {
    out.unmappedMokuroCount = mokuroDoc.pages.length - N;
  }
  return out;
}

// ============================================================
// 確認モーダル UI（PSD と OCR ページ数が不一致のときだけ表示）
// ============================================================
function renderPlanReviewTable(plan) {
  const warning = $("ai-place-review-warning");
  const warningDetail = $("ai-place-review-warning-detail");
  if (!warning || !warningDetail) return;
  const psdExtra = plan.unmappedPsdCount ?? 0;
  const ocrExtra = plan.unmappedMokuroCount ?? 0;
  if (psdExtra > 0 || ocrExtra > 0) {
    const psdTotal = plan.pages.length + psdExtra;
    const ocrTotal = plan.pages.length + ocrExtra;
    const parts = [];
    parts.push(`PSD: ${psdTotal} 枚 / 画像スキャン: ${ocrTotal} ページ`);
    if (psdExtra > 0) parts.push(`末尾の PSD ${psdExtra} 枚にはテキストが配置されません。`);
    if (ocrExtra > 0) parts.push(`末尾の OCR ${ocrExtra} ページ分は使用されません。`);
    warningDetail.textContent = parts.join(" ");
    warning.hidden = false;
  } else {
    warning.hidden = true;
  }
}

function showPlanReviewModal(plan) {
  return new Promise((resolve) => {
    const modal = $("ai-place-review-modal");
    const okBtn = $("ai-place-review-ok");
    const cancelBtn = $("ai-place-review-cancel");
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
// 確定 → addNewLayer 一括
// ============================================================
function applyPlan(plan) {
  let added = 0;
  for (const row of plan.pages) {
    for (const layer of row.layers) {
      addNewLayer(layer);
      added++;
    }
  }
  if (added > 0) {
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
async function runAutoPlace() {
  if (runningPlace) return;
  runningPlace = true;
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
      await loadPsdFilesByPaths(files, { icon: PLACE_ICON_SVG, label: "自動配置中…" });
      psdPages = getPages();
      if (!psdPages || psdPages.length === 0) {
        // 読み込みが全件失敗 (loadPsdFilesByPaths が内部で notifyDialog を出す) 等
        return;
      }
    }
    const txtSrc = getTxtSource();
    if (!txtSrc || !txtSrc.content) {
      await notifyDialog({
        title: "自動配置できません",
        message: "テキストが読み込まれていません。\n先に TXT を開くか、画像スキャンを実行してください。",
      });
      return;
    }
    const parsed = parsePages(txtSrc.content);
    const txtByPage = parsed.hasMarkers ? parsed.byPage : new Map([[1, parsed.all]]);

    // 2. OCR キャッシュ確認
    //   - キャッシュ有効: 結果あり & pages 1 件以上 → そのまま再利用
    //   - 無効なら、読込済み見本ファイル全てを対象に画像スキャンを自動トリガーする。
    let cache = getAiOcrDoc();
    const cacheValid = !!(
      cache &&
      cache.doc &&
      Array.isArray(cache.doc.pages) &&
      cache.doc.pages.length > 0
    );
    if (!cacheValid) {
      const loadedRefs = getPdfPaths();
      if (loadedRefs.length === 0) {
        await notifyDialog({
          title: "自動配置できません",
          message: "OCR の元になる PDF / 画像が必要です。\n先に PDF を開くか、画像スキャンを実行してください。",
        });
        return;
      }
      // 既存の画像スキャンフローを呼び出す (進捗モーダルは ai-ocr 側が出す)。
      // 読込済みの見本ファイル全てを OCR 対象にして自動配置の整合を取る。
      await runAiOcrForFiles(loadedRefs);
      cache = getAiOcrDoc();
      if (!cache || !cache.doc) {
        // 画像スキャン側がエラー通知済みなのでここでは静かに戻る
        return;
      }
    }

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
      cloudShapeFontEnabled: getDefault("cloudShapeFontEnabled"),
      cloudShapeScoreThreshold: getDefault("cloudShapeScoreThreshold"),
      cloudShapeFontPostScriptName: getDefault("cloudShapeFontPostScriptName"),
    };
    const plan = buildPlacementPlan(cache.doc, psdPages, txtByPage, defaults);

    if (plan.totals.placed === 0) {
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
      if (!proceed) return;
    }

    // 5. 確認モーダル（PSD と OCR ページ数が不一致のときだけ表示）
    const hasMismatch =
      (plan.unmappedPsdCount ?? 0) > 0 || (plan.unmappedMokuroCount ?? 0) > 0;
    if (hasMismatch) {
      const ok = await showPlanReviewModal(plan);
      if (!ok) return;
    }

    // 6. 適用
    applyPlan(plan);
    lastPlacedFingerprint = fingerprint;
    // 進捗モーダルだけ緑のチェックマークアニメで閉じる。完了 notifyDialog は
    // ユーザー要望で出さない（写植作業の流れを止めないため）。エラー時のみ下の
    // catch で notifyDialog を表示する。
    await hideProgress({ success: true });
  } catch (e) {
    console.error(e);
    await hideProgress();
    await notifyDialog({
      title: "自動配置エラー",
      message: String(e?.message ?? e ?? "不明なエラー"),
    });
  } finally {
    runningPlace = false;
  }
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
  const txtByPage = parsed.hasMarkers ? parsed.byPage : new Map([[1, parsed.all]]);
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
      const next = convertHalfToFullForVertical(rawNext, direction);
      if (next === layer.contents) continue;

      // contents 変更で推定 width/height が変わるため、x/y をそのままにすると
      // bbox top-left 固定 → 旧中心からズレて見える（上左に寄ったように見える）。
      // 旧 contents の bbox 中心を求め、新 contents の bbox を中心起点で再配置する。
      const updates = { contents: next };
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
export function bindAiPlaceButton() {
  const btn = $("ai-place-btn");
  if (!btn) return;
  btn.addEventListener("click", () => { void runAutoPlace(); });
  // OCR 結果が無いうちはグレーアウト。setAiOcrDoc / clearAiOcrDoc に追従。
  const sync = () => {
    const locked = isAiActionsLocked();
    const cache = getAiOcrDoc();
    const hasOcr = !!(
      cache &&
      cache.doc &&
      Array.isArray(cache.doc.pages) &&
      cache.doc.pages.length > 0
    );
    btn.disabled = locked || !hasOcr;
    btn.title = locked
      ? "画像スキャンエンジンが未インストールです。"
      : hasOcr
      ? "OCR 結果と原稿テキストを吹き出し位置に自動配置"
      : "先に画像スキャンを実行してください";
  };
  onAiOcrDocChange(sync);
  window.addEventListener("psdesign:ai-actions-lock-change", sync);
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
//   mode1 (PSDに余分余白): scale=1, offset=(mokuro - psd)/2 の確定式
//     ref < psd → 絵柄領域中心へシフト集約
//   mode2 (見本に余分余白): KENBAN 流の画像差分 grid search (Rust)
//     scale + offset を画像から自動検出 + per-layer サイズ補正
//   mode3 (重ね調整): 全画面オーバーレイで見本/PSD を半透明で重ね、
//     ドラッグ・ホイールで手動位置/スケール調整
//
// sourceTxtRef ベースで idempotent (累積バグなし、複数回押しても同じ結果)。
// 範囲外飛び出しガード付き (PSD ±30% 超えるレイヤーは補正スキップ)。
async function runPositionAdjust(mode = "mode1", options = {}) {
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
    const cache = getAiOcrDoc();
    const mokuroDoc = cache?.doc;

    showProgress({ detail: `${modeLabel} 中…`, icon: PLACE_ICON_SVG, label: modeLabel });

    const alignmentByPath = new Map();
    const isSinglePdfMultiPsd = referencePaths.length === 1
      && /\.pdf$/i.test(referencePaths[0])
      && psdPages.length > 1;
    const N = isSinglePdfMultiPsd
      ? psdPages.length
      : Math.min(psdPages.length, referencePaths.length);
    for (let i = 0; i < N; i++) {
      const psd = psdPages[i];
      const refPath = isSinglePdfMultiPsd ? referencePaths[0] : referencePaths[i];
      const pdfPageIdx = isSinglePdfMultiPsd ? i : 0;
      const mokuro = mokuroDoc?.pages?.[i] ?? { blocks: [] };
      updateProgress({ current: i, total: N, detail: `${modeLabel} ${i + 1}/${N}`, showCount: false });
      console.info(
        `[ai-adjust] page=${i + 1} mode=${mode} ref=${refPath}`,
      );
      const alignment = await computeAlignmentSafe(refPath, psd, mokuro, pdfPageIdx, mode);
      if (alignment) {
        alignmentByPath.set(psd.path, alignment);
        const expectedSign = mode === "mode2" ? "+" : "-";
        const actualSign = alignment.offset_x === 0
          ? "0" : alignment.offset_x > 0 ? "+" : "-";
        const modeMatches = (mode === "mode2" && alignment.offset_x > 0)
          || (mode === "mode1" && alignment.offset_x < 0)
          || alignment.offset_x === 0;
        console.info(
          `[ai-adjust] page=${i + 1} mode=${mode} scale=${alignment.scale.toFixed(3)} offset=(${alignment.offset_x.toFixed(0)}, ${alignment.offset_y.toFixed(0)}) ${modeMatches ? "✓" : `⚠ 期待符号=${expectedSign}, 実符号=${actualSign}`}`,
        );
      }
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
        const mokuroPage = mokuroDoc?.pages?.[idx];
        if (!psd || !mokuroPage) continue;
        const sx = psd.width / Math.max(mokuroPage.img_width, 1);
        const sy = psd.height / Math.max(mokuroPage.img_height, 1);
        if (!Number.isFinite(sx) || sx <= 0 || !Number.isFinite(sy) || sy <= 0) continue;

        const halfW = getApproxLayerCenterDelta(layer, psd, "x");
        const halfH = getApproxLayerCenterDelta(layer, psd, "y");

        // mokuro 元 bbox から refCx を取得 (idempotent)
        let refCx, refCy;
        const txtRef = layer.sourceTxtRef;
        const block = (txtRef && Number.isInteger(txtRef.paragraphIndex))
          ? mokuroPage?.blocks?.[txtRef.paragraphIndex]
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
            `[ai-adjust]   layer "${(layer.contents ?? "").slice(0, 12)}" 補正後位置が PSD 範囲外 → skip`,
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
          const autoSx = psd.width / Math.max(mokuroPage.img_width, 1);
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
      `[ai-adjust] 完了: ${movedCount}/${newLayers.length} 件のレイヤーを移動 (skipped: outOfRange=${skippedOutOfRange}, NaN=${skippedNaN})`,
    );
    if (movedCount > 0) {
      try { renderAllSpreads(); } catch (_) {}
      try { rebuildLayerList(); } catch (_) {}
    }
    await hideProgress({ success: true });
    await notifyDialog({
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
    console.warn("[ai-place] renderReferencePageToCanvas failed:", e);
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

async function runOverlayAlign() {
  if (runningAdjust) return;
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

  const mokuroDoc = getAiOcrDoc()?.doc;

  runningAdjust = true;
  showProgress({ detail: "重ね調整 中…", icon: PLACE_ICON_SVG, label: "重ね調整" });

  beginHistoryTransient();
  let movedCount = 0;
  let transientCommitted = false;
  try {
    for (const layer of newLayers) {
      if (!layer || !layer.psdPath) continue;
      const idx = psdPages.findIndex((p) => p?.path === layer.psdPath);
      if (idx < 0) continue;
      const psd = psdPages[idx];
      const mokuroPage = mokuroDoc?.pages?.[idx];
      if (!psd || !mokuroPage) continue;
      const mokuroW = Math.max(mokuroPage.img_width, 1);
      const mokuroH = Math.max(mokuroPage.img_height, 1);
      const sx = psd.width / mokuroW;
      const sy = psd.height / mokuroH;
      if (!Number.isFinite(sx) || sx <= 0) continue;

      const mokuroPerRefX = mokuroW / result.ref_natural_w;
      const mokuroPerRefY = mokuroH / result.ref_natural_h;
      const alignScaleX = result.scale_in_ref * mokuroPerRefX;
      const alignScaleY = result.scale_in_ref * mokuroPerRefY;
      const alignScale = (alignScaleX + alignScaleY) / 2;
      const alignOffsetX = result.offset_x_in_ref * mokuroPerRefX;
      const alignOffsetY = result.offset_y_in_ref * mokuroPerRefY;

      let refCx, refCy;
      const txtRef = layer.sourceTxtRef;
      const block = (txtRef && Number.isInteger(txtRef.paragraphIndex))
        ? mokuroPage?.blocks?.[txtRef.paragraphIndex]
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

  console.info(`[ai-adjust mode3] alignScale=${result.scale_in_ref.toFixed(4)}, offset_in_ref=(${result.offset_x_in_ref.toFixed(0)}, ${result.offset_y_in_ref.toFixed(0)}), ${movedCount} 件移動`);
  if (movedCount > 0) {
    try { renderAllSpreads(); } catch (_) {}
    try { rebuildLayerList(); } catch (_) {}
  }
  await hideProgress({ success: true });
  await notifyDialog({
    title: "重ね調整 完了",
    message: `${movedCount} 件のレイヤーを調整しました。`,
    kind: "success",
  });
}

export function bindPositionAdjustButton() {
  const menuBtn = $("ai-adjust-menu-btn");
  const btn1 = $("ai-adjust-btn");
  const btn2 = $("ai-adjust2-btn");
  const btn3 = $("ai-adjust3-btn");
  const dropdown = menuBtn?.closest?.(".ai-adjust-dropdown");
  if (!menuBtn && !btn1 && !btn2 && !btn3) return;
  if (btn1) btn1.addEventListener("click", () => { void runPositionAdjust("mode1"); });
  if (btn2) btn2.addEventListener("click", () => { void runPositionAdjust("mode2"); });
  if (btn3) btn3.addEventListener("click", () => { void runOverlayAlign(); });
  if (dropdown && menuBtn) {
    dropdown.addEventListener("mouseenter", () => {
      if (!menuBtn.disabled) menuBtn.setAttribute("aria-expanded", "true");
    });
    dropdown.addEventListener("mouseleave", () => {
      menuBtn.setAttribute("aria-expanded", "false");
    });
  }
  const sync = () => {
    const locked = isAiActionsLocked();
    const has = getNewLayers().some((l) => l && l.tempId);
    const disabled = locked || !has;
    const titleWhenDisabled = locked
      ? "画像スキャンエンジンが未インストールです。"
      : "先に自動配置を実行してください";
    if (menuBtn) {
      menuBtn.disabled = disabled;
      menuBtn.title = !disabled
        ? "位置調整メニュー"
        : titleWhenDisabled;
      menuBtn.setAttribute("aria-expanded", !disabled ? menuBtn.getAttribute("aria-expanded") || "false" : "false");
    }
    if (btn1) {
      btn1.disabled = disabled;
      btn1.title = !disabled
        ? "位置調整1: PSDに余分余白あり (確定式)"
        : titleWhenDisabled;
    }
    if (btn2) {
      btn2.disabled = disabled;
      btn2.title = !disabled
        ? "位置調整2: 見本に余分余白あり (画像差分 grid search)"
        : titleWhenDisabled;
    }
    if (btn3) {
      btn3.disabled = disabled;
      btn3.title = !disabled
        ? "重ね調整: 見本に PSD を半透明で重ねて手動調整"
        : titleWhenDisabled;
    }
  };
  sync();
  onAiOcrDocChange(sync);
  onTxtSourceChange(sync);
  window.addEventListener("psdesign:ai-actions-lock-change", sync);
  setInterval(sync, 1000);
}
