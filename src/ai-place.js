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
  getTxtSource,
  onTxtSourceChange,
  getNewLayers,
  updateNewLayer,
  beginHistoryTransient,
  abortHistoryTransient,
} from "./state.js";
import { parsePages, convertHalfToFullForVertical } from "./txt-source.js";
import { notifyDialog, confirmDialog, hideProgress } from "./ui-feedback.js";
import { loadPsdFilesByPaths, pickPsdFiles } from "./services/psd-load.js";
import { runAiOcrForFiles, PLACE_ICON_SVG } from "./ai-ocr.js";
import { renderAllSpreads } from "./spread-view.js";
import { rebuildLayerList } from "./text-editor.js";
import { getDefault } from "./settings.js";
import { sortBlocksMangaOrder } from "./utils/manga-order.js";

const $ = (id) => document.getElementById(id);

let runningPlace = false;
// 直近に適用された配置プランのテキスト内容指紋。
// 同一テキストで連続して自動配置するときに確認ダイアログを出すために使う。
let lastPlacedFingerprint = null;

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

function detectSizePtFromBlock(block, mokuroPage, psdPage) {
  const fs = block?.font_size;
  if (!Number.isFinite(fs) || fs <= 0) return null;
  const sx = psdPage.width / Math.max(mokuroPage.img_width, 1);
  const sy = psdPage.height / Math.max(mokuroPage.img_height, 1);
  const scale = Math.min(sx, sy);
  if (!(scale > 0)) return null;
  const dpi = psdPage.dpi ?? 72;

  // 1) detector の font_size を PSD pt に換算 + 軽いキャリブレーション
  let pt = ((fs * scale) * 72) / dpi * FONT_SIZE_CALIBRATION;

  // 2) bbox の "厚み" から物理的な上限 pt を算出して上から押さえる。
  //    縦書きは横幅 = (1 + (n-1) × leading) × em の関係で em を逆算。横書きは縦高で同様。
  //    1 行は denom=1（bbox とほぼ等価）、2 行は denom=2.25、3 行は 3.5 …と多列ほど厳しく。
  const lines = Array.isArray(block.lines) ? block.lines : [];
  const lineCount = Math.max(1, lines.length);
  const isVertical = !!block.vertical;
  const thickPsdPx = isVertical
    ? (block.box[2] - block.box[0]) * sx
    : (block.box[3] - block.box[1]) * sy;
  if (Number.isFinite(thickPsdPx) && thickPsdPx > 0) {
    const denom = 1 + Math.max(0, lineCount - 1) * ASSUMED_LEADING_FACTOR;
    const maxPt = ((thickPsdPx / denom) * 72) / dpi;
    if (Number.isFinite(maxPt) && maxPt > 0) pt = Math.min(pt, maxPt);
  }

  if (!Number.isFinite(pt) || pt <= 0) return null;
  // 自動配置は 1pt 単位にスナップ。検出器の細かい揺れで吹き出し間サイズが
  // ばらつくのを防ぎ、複数吹き出しでサイズを揃える。
  const snapped = Math.round(pt);
  // クランプ範囲は state.js setTextSize と一致させる。
  return Math.max(6, Math.min(999, snapped));
}

// 自動配置時、吹き出し中心からテキストを少し下方向にずらすバイアス (em 単位)。
// 画像スキャンエンジン (吹き出し検出側) の bbox が「上方向に寄っていて下が長め」になりやすく、
// そのまま中心に置くと視覚的に上寄りに見えるため経験補正。
// 単位は em (× ptInPsdPx)。値を増やすほど下に動く。0 で従来挙動。
const BUBBLE_PLACEMENT_Y_BIAS_EM = 0.3;

function mapBlockToNewLayer(block, mokuroPage, psdPage, contents, defaults, sourceTxtRef) {
  const sx = psdPage.width / Math.max(mokuroPage.img_width, 1);
  const sy = psdPage.height / Math.max(mokuroPage.img_height, 1);
  const direction = block.vertical ? "vertical" : "horizontal";
  // bubble bbox の中心を PSD 座標に変換 → "ユーザーがクリックした位置" と等価。
  const cx = ((block.box[0] + block.box[2]) / 2) * sx;
  const cy = ((block.box[1] + block.box[3]) / 2) * sy;
  // 推定レイヤー矩形サイズ → top-left を中心合わせで算出
  // (canvas-tools.js: centerTopLeft = clickX - width/2, clickY - height/2)
  // 縦書きレイヤーは設定 verticalHalfToFullEnabled (default true) に従い、
  // 半角英数字 (0-9 / A-Z / a-z) を全角に自動変換する。
  // bbox 推定は変換後テキストで行うため、文字幅差は影響しない（char count ベース）。
  const text = convertHalfToFullForVertical(contents ?? "", direction);
  // 検出フォントサイズが取れた吹き出しは見本に合わせる、取れなければデフォルトにフォールバック。
  const detectedPt = detectSizePtFromBlock(block, mokuroPage, psdPage);
  const sizePt = detectedPt ?? defaults.sizePt ?? 24;
  const { width, height } = estimateLayerSize(
    psdPage, sizePt, text, defaults.leadingPct ?? 125, direction,
  );
  // 下方向バイアス: ptInPsdPx 換算で BUBBLE_PLACEMENT_Y_BIAS_EM em ぶん下げる。
  const dpi = psdPage.dpi ?? 72;
  const ptInPsdPx = sizePt * (dpi / 72);
  const yBias = ptInPsdPx * BUBBLE_PLACEMENT_Y_BIAS_EM;
  const x = cx - width / 2;
  const y = cy - height / 2 + yBias;
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
    const layers = [];
    // 全 TXT 段落を配置: sorted[j] があれば吹き出し中央、無ければ PSD ページ中央。
    // 旧仕様は placedCount = min(txt, sorted) で余り TXT を捨てていたが、ユーザーが
    // 入力欄から追加した段落も自動配置で拾うために全件処理に変更。
    for (let j = 0; j < txt.length; j++) {
      const block = sorted[j];
      const sourceTxtRef = { pageNumber: i + 1, paragraphIndex: j };
      if (block) {
        layers.push(mapBlockToNewLayer(block, mokuro, psd, txt[j], defaults, sourceTxtRef));
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
    const defaults = {
      fontPostScriptName: getCurrentFont(),
      sizePt: getTextSize(),
      leadingPct: getLeadingPct(),
      strokeColor: getStrokeColor(),
      strokeWidthPx: getStrokeWidthPx(),
      fillColor: getFillColor(),
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
    const cache = getAiOcrDoc();
    const hasOcr = !!(
      cache &&
      cache.doc &&
      Array.isArray(cache.doc.pages) &&
      cache.doc.pages.length > 0
    );
    btn.disabled = !hasOcr;
    btn.title = hasOcr
      ? "OCR 結果と原稿テキストを吹き出し位置に自動配置"
      : "先に画像スキャンを実行してください";
  };
  onAiOcrDocChange(sync);
  sync();

  // TXT 編集 → 自動配置済みレイヤー contents を追従。
  // 編集はサイドパネル dblclick 編集 / エディタ textarea / undo/redo 経由で発生する。
  onTxtSourceChange(syncPlacedFromTxt);
}
