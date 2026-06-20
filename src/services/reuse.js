// 写植再利用モードの読込フロー。
//
// 通常の loadPsdFilesByPaths とは別経路で PSD を「再利用」用に読み込む:
//   1) loadPsdForReuse で各 PSD をパース
//        canvas              = テキストを消した絵柄 (編集ペイン表示)
//        reuseReferenceCanvas = 元テキスト入りの合成画像 (見本ペイン + JPG 用)
//        reuseTextLayers      = 抽出して新規レイヤー化する元テキスト
//        reuseTextLayerIds    = 保存時に非表示化する元テキストレイヤー id
//   2) 元テキストを「新規レイヤー」として同座標に配置（写植をやり直せる編集対象）
//   3) reuseInfo (hideLayerIds + referenceCanvas) を state に記録
//   4) 見本ペイン (spreads-pdf-area) に元テキスト入り合成画像を流し込む
//   5) appMode = "reuse" にして parallel 表示にする
//
// psd-load.js（通常フロー）と同様、読込終了時に `psdesign:psd-loaded` を dispatch して
// main.js 側の UI 更新リスナーを起動する。

import {
  addPage,
  addNewLayer,
  updateNewLayer,
  clearPages,
  setFolder,
  setAppMode,
  setReuseInfo,
  setPdf,
  getPages,
  setTxtDirty,
  setTxtFilePath,
  setTxtSource,
  markReuseLayerOrigins,
} from "../state.js";
import { hideProgress, showProgress, toast, updateProgress } from "../ui-feedback.js";
import { completeProgressFlowStep, updateProgressFlow, withProgressFlow } from "../progress-flow.js";
import { renderAllSpreads } from "../spread-view.js";
import { rebuildLayerList } from "../text-editor.js";
import {
  UnsupportedBitmapPsdError,
  loadPsdForReuse,
  buildReusePageFromPsData,
  mergeReuseStrokeHintsFromAgPsd,
  mergeReuseLeadingFromAgPsd,
  mergeReuseBoundsFromAgPsd,
} from "../psd-loader.js";
import { refreshMemoryStatus } from "../memory-mode.js";
import { buildReferenceDocFromCanvases } from "../pdf-loader.js";
import {
  getExistingLayerEffectiveSizePt,
  layerRectForNew,
  alignReuseLayersToSourceCenters,
} from "../canvas-tools.js";
import { ensureFontLoaded } from "../font-loader.js";
import { notifyUnsupportedBitmapPsdFiles } from "./psd-load.js";
import { baseName, parentDir } from "../utils/path.js";
import { setGuidesLocked } from "../rulers.js";
import { endLoadOperation, tryBeginLoadOperation } from "./load-guard.js";
import { getDefault } from "../settings.js";

// 【写植再利用】テキスト領域の周辺解析（白率 / ウニ）から、通常写植と同じ基準で
// 「白フチ自動付与」「中丸ゴシック自動切替」を判定する。auto-place.js mapBlockToNewLayer
// と同一ロジック。metrics は Rust analyze_image_text_regions の戻り値（whiteRatio /
// minSegmentEdgeChanges）。baseFont は元レイヤーの実フォント。
function computeAutoStyleFromMetrics(metrics, baseFont) {
  const out = {
    strokeColor: getDefault("strokeColor") ?? "none",
    strokeWidthPx: Number.isFinite(getDefault("strokeWidthPx")) ? getDefault("strokeWidthPx") : 20,
    fontPostScriptName: baseFont || getDefault("fontPostScriptName") || null,
    autoFontSwitched: false,
    autoFontSwitchBucket: -1,
  };
  const whiteRatio = metrics && metrics.ok ? Number(metrics.whiteRatio) : NaN;
  const minSeg = metrics && metrics.ok ? Number(metrics.minSegmentEdgeChanges) : NaN;

  // (白フチ) 白率 < 閾値 → 絵柄上 → 白フチ自動付与。defaults が none のときのみ。
  if (getDefault("autoStrokeEnabled")
      && (out.strokeColor === "none" || out.strokeColor == null)
      && Number.isFinite(whiteRatio)
      && whiteRatio < (Number(getDefault("autoStrokeWhiteRatioThreshold")) || 0.7)) {
    out.strokeColor = "white";
  }

  // (中丸ゴシック) 背景スコア / ウニスコア の合成最大 ≥ 閾値 で中丸ゴシックに切替。
  const cloudPs = getDefault("cloudShapeFontPostScriptName");
  if (getDefault("cloudShapeFontEnabled") && cloudPs) {
    const bgScore = Number.isFinite(whiteRatio) ? Math.max(0, Math.min(1, 1 - whiteRatio)) : 0;
    const uniScore = Number.isFinite(minSeg) ? Math.max(0, Math.min(1, minSeg / 6)) : 0;
    const score = Math.max(bgScore, uniScore);
    const threshold = Number(getDefault("cloudShapeScoreThreshold")) || 0.5;
    const bucket = Math.max(0, Math.min(5, Math.floor((score * 100 - 50) / 10)));
    if (score >= threshold) {
      out.fontPostScriptName = cloudPs;
      out.autoFontSwitched = true;
      out.autoFontSwitchBucket = bucket;
    }
  }
  return out;
}

function normalizeReuseStrokeColor(value) {
  if (value === "white" || value === "black") return value;
  // 【提案A】Photoshop 読み取りで「境界線効果はあるが色を純白/純黒に分類できなかった」
  // 場合は jsx_gen.rs の strokeFromFrameFx が "present" を返す。漫画写植のフチは白が
  // 大多数なので白フチとして再現し、背景白率ヒューリスティックへ落とさない。
  if (value === "present") return "white";
  return "none";
}

function hasReuseStroke(color, width) {
  return (color === "white" || color === "black") && Number.isFinite(width) && width > 0;
}

// 塗り色と同じ色のフチは視覚的に無意味（白文字に白フチ / 黒文字に黒フチ）。
// 無効化された境界線効果の誤読・周辺解析の誤判定・祖先グループ効果の継承などで付いた
// 冗長なフチを除去する。リサイクル配置でのみ適用し、通常編集には影響しない。
function suppressRedundantStroke(strokeColor, fillColor) {
  if ((fillColor === "white" && strokeColor === "white")
    || (fillColor === "black" && strokeColor === "black")) {
    return "none";
  }
  return strokeColor;
}

function resolveReuseStrokeFromSourceOrMetrics(sourceColor, sourceWidthPx, metrics, baseFont) {
  const color = normalizeReuseStrokeColor(sourceColor);
  const width = Number.isFinite(sourceWidthPx) ? sourceWidthPx : 20;
  if (hasReuseStroke(color, width)) {
    return {
      strokeColor: color,
      strokeWidthPx: width,
      autoFontPostScriptName: baseFont || null,
      autoFontSwitched: false,
      autoFontSwitchBucket: -1,
    };
  }
  const auto = computeAutoStyleFromMetrics(metrics, baseFont);
  return {
    strokeColor: auto.strokeColor,
    strokeWidthPx: auto.strokeWidthPx,
    autoFontPostScriptName: auto.fontPostScriptName,
    autoFontSwitched: auto.autoFontSwitched,
    autoFontSwitchBucket: auto.autoFontSwitchBucket,
  };
}

function reuseRegionVariantsForItem(it, dpi) {
  const sizePt = Number(it.sizePt);
  const fontSizePx = Number.isFinite(sizePt) && sizePt > 0 ? (sizePt * (Number(dpi) || 72)) / 72 : 24;
  const left = Number(it.left) || 0;
  const top = Number(it.top) || 0;
  const right = Number(it.right) || left;
  const bottom = Number(it.bottom) || top;
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  const base = { left, top, right, bottom, fontSizePx };
  // PSD textItem.bounds は文字実体に近く、ウニ吹き出しの外周まで届かないことがある。
  // 通常の OCR 自動配置は検出 bbox 周辺を見るため、リサイクルでも少し広い bbox を併用する。
  const expand = Math.min(90, Math.max(24, fontSizePx * 1.8, Math.min(width, height) * 0.75));
  const wideX = it.direction === "vertical" ? Math.max(expand, fontSizePx * 2.4) : expand;
  const wideY = it.direction === "vertical" ? expand : Math.max(expand, fontSizePx * 2.0);
  return [
    base,
    {
      left: left - wideX,
      top: top - wideY,
      right: right + wideX,
      bottom: bottom + wideY,
      fontSizePx: Math.max(fontSizePx, expand),
    },
  ];
}

function reuseMetricScore(metric) {
  if (!metric?.ok) return -1;
  const whiteRatio = Number(metric.whiteRatio);
  const minSeg = Number(metric.minSegmentEdgeChanges);
  const bgScore = Number.isFinite(whiteRatio) ? Math.max(0, Math.min(1, 1 - whiteRatio)) : 0;
  const uniScore = Number.isFinite(minSeg) ? Math.max(0, Math.min(1, minSeg / 6)) : 0;
  return Math.max(bgScore, uniScore);
}

function pickReuseMetric(metrics) {
  let best = null;
  let bestScore = -1;
  for (const metric of metrics) {
    const score = reuseMetricScore(metric);
    if (score > bestScore) {
      best = metric;
      bestScore = score;
    }
  }
  return best;
}

// PS テキスト項目群について、背景画像で周辺解析を行い metrics 配列を返す（idx 対応）。
async function analyzeReuseRegions(bgImagePath, psItems, dpi) {
  if (!bgImagePath || !Array.isArray(psItems) || psItems.length === 0) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const variants = psItems.map((it) => reuseRegionVariantsForItem(it, dpi));
    const regions = variants.flat();
    const metrics = await invoke("analyze_image_text_regions", { imagePath: bgImagePath, regions });
    if (!Array.isArray(metrics)) return null;
    const out = [];
    let offset = 0;
    for (const itemVariants of variants) {
      out.push(pickReuseMetric(metrics.slice(offset, offset + itemVariants.length)));
      offset += itemVariants.length;
    }
    return out;
  } catch (e) {
    console.warn("[reuse] 周辺解析に失敗（自動白フチ/中丸ゴシックをスキップ）:", e);
    return null;
  }
}

// 1 ページぶんの元テキストレイヤーを「新規レイヤー」として同座標に配置する。
// Photoshop が読んだ実テキスト (reusePsTextItems) があればそれを優先（実内容/フォント/
// サイズ/座標が正確）。無ければ ag-psd 抽出 (reuseTextLayers) にフォールバック。
// 【実物再現】周辺解析による「白フチ自動付与」「中丸ゴシック自動切替」は行わず、元 PSD の
// 実フォント・実フチ（境界線効果）をそのまま再現する。
// fontSizeMode:
//   "reproduce" (既定) … 元レイヤーのフォント・サイズ・フチをそのまま再現する。
//   "select"          … フォント・サイズは指定値を使う（フチは元レイヤーの実フチを再現）。
function roundReuseReproduceSizePt(sizePt) {
  const n = Number(sizePt);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 10 + 1e-8) / 10;
}

// transform 行列 [xx,xy,yx,yy,tx,ty] から回転角（度）を逆算する。回転 θ で xx=s·cosθ / xy=s·sinθ
// となるため angle = atan2(xy, xx)。長体/平体は textItem 側で別管理のため行列はほぼ回転のみ。
// 微小な数値誤差は 0 に丸める（保存側は rotation !== 0 のときだけ layer.rotate を呼ぶ）。
function rotationFromTransform(transform) {
  if (!Array.isArray(transform) || transform.length < 2) return 0;
  const xx = Number(transform[0]);
  const xy = Number(transform[1]);
  if (!Number.isFinite(xx) || !Number.isFinite(xy)) return 0;
  let deg = (Math.atan2(xy, xx) * 180) / Math.PI;
  if (!Number.isFinite(deg)) return 0;
  deg = Math.round(deg * 100) / 100;
  return Math.abs(deg) < 0.01 ? 0 : deg;
}

function resolveReuseFont({ unify, defaultFont, autoFont, autoFontSwitched, sourceFont }) {
  if (autoFontSwitched && autoFont) return autoFont;
  if (unify && defaultFont) return defaultFont;
  return autoFont || sourceFont || defaultFont || null;
}

function resolveReuseSize({ unify, defaultSizePt, detectedSizePt }) {
  const detected = roundReuseReproduceSizePt(detectedSizePt);
  if (Number.isFinite(detected) && detected > 0) return detected;
  return unify ? defaultSizePt : null;
}

function normalizeReuseFillColor(value) {
  if (value === "white" || value === "black" || value === "default") return value;
  if (typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value)) return value.toLowerCase();
  return "default";
}

function normalizeReusePunctuationSpace(text, enabled) {
  const s = String(text ?? "");
  if (enabled === false) return s;
  return s.replace(/、/g, " ");
}

// 先頭・末尾の空行（空白のみの行を含む）を除去する。
// Photoshop の textItem.contents は段落末尾の改行などで先頭/末尾に空行を含むことがある。
// 新規レイヤーの枠サイズは contents の行数から推定するため、空行があると厚み方向の bbox が
// 1 行ぶん膨らみ、元レイヤーの bounds（描画ピクセル基準で空行を含まない）中心との中心合わせや
// 再現配置で、1 行目／最終行に空行ができてテキストがずれる。中間の空行は意図的な改行として残す。
function trimReuseBlankLines(text) {
  return String(text ?? "")
    .replace(/^(?:[ \t　]*\n)+/, "")
    .replace(/(?:\n[ \t　]*)+$/, "");
}

function appendReuseTextSourceBlock(sourcePages, pageNumber, text) {
  if (!Array.isArray(sourcePages)) return null;
  const normalized = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) return null;
  const pageNum = Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber : 1;
  let pageEntry = sourcePages.find((entry) => entry.pageNumber === pageNum);
  if (!pageEntry) {
    pageEntry = { pageNumber: pageNum, blocks: [] };
    sourcePages.push(pageEntry);
  }
  const paragraphIndex = pageEntry.blocks.length;
  pageEntry.blocks.push(normalized);
  return { pageNumber: pageNum, paragraphIndex };
}

function buildReuseTextSourceContent(sourcePages) {
  if (!Array.isArray(sourcePages) || sourcePages.length === 0) return "";
  return [...sourcePages]
    .filter((entry) => Array.isArray(entry.blocks) && entry.blocks.length > 0)
    .sort((a, b) => a.pageNumber - b.pageNumber)
    .map((entry) => `<<${entry.pageNumber}Page>>\n\n${entry.blocks.join("\n\n")}`)
    .join("\n\n");
}

function reuseTextSourceName(files) {
  if (Array.isArray(files) && files.length === 1) {
    return `${baseName(files[0]).replace(/\.psd$/i, "")}_recycle.txt`;
  }
  return "recycle_text.txt";
}

// 【写植再利用 / draft 生成（純粋）】page から「新規レイヤー化すべき下書き(draft)」配列を作る。
// ここでは state を一切変更しない（addNewLayer / updateNewLayer を呼ばない）。各 draft は
//   create         : addNewLayer に渡す引数
//   updates        : 作成後に updateNewLayer する静的フィールド（rect 非依存）/ null
//   centerFromRect : { cx, cy } のとき、反映側で layerRectForNew(page, created) から x/y を中心合わせ
//   alignTarget    : { cx, cy, font } のとき、反映側で alignTargets へ push
// sourcePages は原稿テキスト構築用のアキュムレータ（draft データ）で、ここで追記する。
// 挙動は旧 extractTextLayersToNewLayers と同一（layerRectForNew は created 依存のため反映側に残す）。
async function collectReuseDraftsForPage(
  page,
  { unify, defaultFont, defaultSizePt, punctuationSpaceReplacementEnabled },
  sourcePages,
  pageNumber,
) {
  const drafts = [];
  const psItems = Array.isArray(page?.reusePsTextItems) ? page.reusePsTextItems : null;
  if (psItems && psItems.length > 0) {
    // 【リサイクル＝実物再現】周辺解析による「自動白フチ付与」「中丸ゴシック自動切替」は行わない。
    // 元 PSD の実フォント・実フチ（境界線効果 frameFX）をそのまま再現する。
    for (let i = 0; i < psItems.length; i++) {
      const it = psItems[i];
      if (!it) continue;
      // PSD 上で非表示にされたテキストレイヤーはリサイクル対象から除外する。
      // Photoshop 一括/単体読み取りは可視・非表示を問わず全テキストレイヤーを返すため
      // ここで弾かないと、ユーザーが隠したレイヤーまで可視の新規レイヤーとして再生成される。
      if (it.visible === false) continue;
      // Photoshop の contents は改行が \r。アプリ内は \n に正規化。
      const contents = trimReuseBlankLines(normalizeReusePunctuationSpace(
        String(it.contents ?? "").replace(/\r\n?/g, "\n"),
        punctuationSpaceReplacementEnabled,
      ));
      if (!contents) continue;
      const direction = it.direction === "vertical" ? "vertical" : "horizontal";
      const hasBounds = [it.left, it.top, it.right, it.bottom].every((v) => Number.isFinite(v))
        && it.right > it.left && it.bottom > it.top;
      // サイズ: Photoshop が読んだ textItem.size を元サイズとして採用。bounds 逆算は取れない時のみ。
      const nominalPt = Number(it.sizePt);
      let sizePt = Number.isFinite(nominalPt) && nominalPt > 0 ? nominalPt : null;
      if (!sizePt && hasBounds) {
        const boundsSize = getExistingLayerEffectiveSizePt(
          page,
          { left: it.left, top: it.top, right: it.right, bottom: it.bottom, fontSize: nominalPt, direction, text: contents },
          null,
        );
        if (Number.isFinite(boundsSize) && boundsSize > 0) sizePt = boundsSize;
      }
      // フォント: 自動中丸ゴシック切替は使わない。「写植見本を再現」は元レイヤーのフォント、
      // 「フォント・サイズを指定」は指定フォントをそのまま使う。
      const layerFont = unify ? (defaultFont || it.font || null) : (it.font || defaultFont || null);
      const layerSize = resolveReuseSize({ unify, defaultSizePt, detectedSizePt: sizePt });
      // フチ: 元レイヤーの境界線効果(frameFX)をそのまま再現する。"present"（境界線は存在するが
      // 色未分類）は white として再現。元にフチが無ければ none（周辺解析からの自動白フチは付けない）。
      const reproStrokeColor = normalizeReuseStrokeColor(it.strokeColor);
      const reproStrokeWidthPx = Number.isFinite(it.strokeWidthPx) ? it.strokeWidthPx : 20;
      // グループ単位（フチ付きリンク群/フォルダ）の再現。同 groupKey の新規レイヤーを保存側で
      // text サブグループへまとめ、グループにフチを当てる。個別フチ(reproStrokeColor)は READ 側で
      // none に抑止済み。groupKey が無ければ従来どおり個別レイヤー。
      const reproGroupKey = (typeof it.groupKey === "string" && it.groupKey) ? it.groupKey : null;
      const reproGroupStrokeColor = reproGroupKey ? normalizeReuseStrokeColor(it.groupStrokeColor) : "none";
      const reproGroupStrokeWidth = Number.isFinite(it.groupStrokeWidth) ? it.groupStrokeWidth : 20;
      // 字間の実物再現。レイヤー全体のトラッキング（ti.tracking）は trackingMille として、
      // 範囲ごとの逸脱と個別カーニング/サイズ/フォント/太字は per-char マップとして渡し、保存側で再適用する。
      const reproTrackingMille = Number.isFinite(it.trackingMille) ? it.trackingMille : 0;
      const reproCharTrackings = (it.charTrackings && typeof it.charTrackings === "object") ? it.charTrackings : {};
      const reproCharKernings = (it.charKernings && typeof it.charKernings === "object") ? it.charKernings : {};
      const reproCharSizes = (it.charSizes && typeof it.charSizes === "object") ? it.charSizes : {};
      const reproCharFonts = (it.charFonts && typeof it.charFonts === "object") ? it.charFonts : {};
      const reproCharBolds = (it.charBolds && typeof it.charBolds === "object") ? it.charBolds : {};
      const reproLineLeadings = (it.lineLeadings && typeof it.lineLeadings === "object") ? it.lineLeadings : {};
      // 行送り（行間）。元レイヤーの自動行送り % をそのまま使う（取れなければ 125 既定）。
      const reproLeadingPct = Number.isFinite(it.leadingPct) && it.leadingPct > 0 ? it.leadingPct : 125;
      // 長体 / 平体。
      const reproHScale = Number.isFinite(it.horizontalScale) && it.horizontalScale > 0 ? it.horizontalScale : 100;
      const reproVScale = Number.isFinite(it.verticalScale) && it.verticalScale > 0 ? it.verticalScale : 100;
      // 合成太字 / 斜体。
      const reproBold = it.syntheticBold === true;
      const reproItalic = it.syntheticItalic === true;
      // 角度。transform 行列 [xx,xy,yx,yy,tx,ty] から回転角を逆算（度）。
      const reproRotation = rotationFromTransform(it.transform);
      const reuseFillColor = normalizeReuseFillColor(it.fillColor);
      const sourceTxtRef = appendReuseTextSourceBlock(sourcePages, pageNumber, contents);
      const create = {
        psdPath: page.path,
        x: Number.isFinite(it.left) ? it.left : 0,
        y: Number.isFinite(it.top) ? it.top : 0,
        contents,
        fontPostScriptName: layerFont,
        sizePt: layerSize,
        direction,
        // 塗り色と同色のフチ（白文字に白フチ等）は冗長なので除去する。
        strokeColor: suppressRedundantStroke(reproStrokeColor, reuseFillColor),
        strokeWidthPx: reproStrokeWidthPx,
        fillColor: reuseFillColor,
        rotation: reproRotation,
        leadingPct: reproLeadingPct,
        horizontalScale: reproHScale,
        verticalScale: reproVScale,
        syntheticBold: reproBold,
        syntheticItalic: reproItalic,
        trackingMille: reproTrackingMille,
        charTrackings: reproCharTrackings,
        charKernings: reproCharKernings,
        charSizes: reproCharSizes,
        charFonts: reproCharFonts,
        charBolds: reproCharBolds,
        lineLeadings: reproLineLeadings,
        autoFontSwitched: false,
        autoFontSwitchBucket: -1,
        groupKey: reproGroupKey,
        groupStrokeColor: reproGroupStrokeColor,
        groupStrokeWidth: reproGroupStrokeWidth,
        sourceTxtRef,
      };
      let updates = null;
      let centerFromRect = null;
      let alignTarget = null;
      // 元レイヤーの実 bbox 中心に新規枠の中心を合わせる（auto-place と同じ中心固定方式）。
      // 【v2.x fix】再現/指定モードを問わず「中心合わせ」に統一する。旧実装は再現モード
      // (useSourceBounds) のみ元 bounds を左上アンカーで枠に当てていたが、保存側 jsx_gen は
      // 常に「実描画 bbox 中心を元中心(reuseSrcCx/Cy)へ合わせる」中心基準のため、
      // ビューアー(左上基準)と PSD(中心基準)で位置が食い違い、さらに元サイズ枠が実テキストを
      // 満たさず「枠と実テキストのズレ」も生んでいた。両モードとも中心合わせ＋tight 枠にして
      // 保存と一致させる（reuseSrcLeft/Top/... reuseSource* は廃止）。
      // reuseSrcCx/Cy = 元レイヤー中心（保存時に実 bbox 中心をここへ合わせ位置を厳密再現）。
      // reuseTightThick = 枠の厚み方向を実テキスト幅に詰める（tight 枠が実テキストを抱く）。
      if (hasBounds) {
        // ag-psd の実 bounds（rendered）があればそれを優先。無ければ Photoshop AM の字面ボックス。
        // jsx の位置補正は layerRef.bounds(rendered) を見るため、揃える相手も rendered が正しい。
        const agOk = Number.isFinite(it.agLeft) && Number.isFinite(it.agTop)
          && Number.isFinite(it.agRight) && Number.isFinite(it.agBottom);
        const bL = agOk ? it.agLeft : it.left;
        const bT = agOk ? it.agTop : it.top;
        const bR = agOk ? it.agRight : it.right;
        const bB = agOk ? it.agBottom : it.bottom;
        const cx = (bL + bR) / 2;
        const cy = (bT + bB) / 2;
        updates = { reuseSrcCx: cx, reuseSrcCy: cy, reuseTightThick: true };
        // 元レイヤーの textItem.position（基準位置）。未ドラッグ保存時に bounds 中心合わせを使わず
        // これを直接設定して厳密再現する（太字で bounds が落ち着かず下にぶれる問題の根治）。
        if (Number.isFinite(it.posX) && Number.isFinite(it.posY)) {
          updates.reuseSrcPosX = it.posX;
          updates.reuseSrcPosY = it.posY;
        }
        // 元 bounds 右端 / 上端 / 左端（rendered）。保存時にアンカー辺合わせで厳密再現するために使う。
        // 縦書き=右上アンカー（reuseSrcRight + reuseSrcTop）、横書き=左上アンカー（reuseSrcLeft + reuseSrcTop）。
        if (Number.isFinite(bR)) updates.reuseSrcRight = bR;
        if (Number.isFinite(bT)) updates.reuseSrcTop = bT;
        if (Number.isFinite(bL)) updates.reuseSrcLeft = bL;
        // 反映側で layerRectForNew(page, created) を使い中心合わせ + フォントロード後の厳密補正対象。
        centerFromRect = { cx, cy };
        alignTarget = { cx, cy, font: layerFont || null };
      }
      drafts.push({ create, updates, centerFromRect, alignTarget });
    }
    return drafts;
  }

  // フォールバック: ag-psd 抽出データ。
  const layers = Array.isArray(page?.reuseTextLayers) ? page.reuseTextLayers : [];
  for (const tl of layers) {
    if (!tl) continue;
    const boundsSizePt = getExistingLayerEffectiveSizePt(page, tl, null);
    const layerFont = resolveReuseFont({
      unify,
      defaultFont,
      autoFont: tl.font || null,
      autoFontSwitched: false,
      sourceFont: tl.font || null,
    });
    const layerSize = resolveReuseSize({ unify, defaultSizePt, detectedSizePt: boundsSizePt });
    const contents = trimReuseBlankLines(normalizeReusePunctuationSpace(
      String(tl.text ?? "").replace(/\r\n?/g, "\n"),
      punctuationSpaceReplacementEnabled,
    ));
    if (!contents) continue;
    const sourceTxtRef = appendReuseTextSourceBlock(sourcePages, pageNumber, contents);
    const create = {
      psdPath: page.path,
      x: Number.isFinite(tl.left) ? tl.left : 0,
      y: Number.isFinite(tl.top) ? tl.top : 0,
      contents,
      fontPostScriptName: layerFont,
      sizePt: layerSize,
      direction: tl.direction === "vertical" ? "vertical" : "horizontal",
      // 塗り色と同色のフチ（白文字に白フチ等）は冗長なので除去する。
      strokeColor: suppressRedundantStroke(tl.strokeColor ?? "none", normalizeReuseFillColor(tl.fillColor)),
      strokeWidthPx: Number.isFinite(tl.strokeWidthPx) ? tl.strokeWidthPx : 20,
      fillColor: normalizeReuseFillColor(tl.fillColor),
      leadingPct: 125,
      horizontalScale: Number.isFinite(tl.horizontalScale) ? tl.horizontalScale : 100,
      verticalScale: Number.isFinite(tl.verticalScale) ? tl.verticalScale : 100,
      trackingMille: Number.isFinite(tl.trackingMille) ? tl.trackingMille : 0,
      kerningMille: Number.isFinite(tl.kerningMille) ? tl.kerningMille : 0,
      sourceTxtRef,
    };
    const updates = {};
    // per-char フォントは「再現」モードのみ反映（「統一」モードは単一フォントに揃える）。
    if (!unify && tl.charFonts && Object.keys(tl.charFonts).length > 0) {
      updates.charFonts = { ...tl.charFonts };
    }
    let centerFromRect = null;
    let alignTarget = null;
    // 元レイヤーの実 bbox 中心に合わせて再配置（Photoshop 経路と同じ中心固定）。
    // 【v2.x fix】再現/指定モードを問わず中心合わせに統一（psItems 経路と同じ。保存側と一致。
    // 旧 !unify の元 bounds 左上アンカー＋reuseSource* は廃止）。
    const hasBounds = [tl.left, tl.top, tl.right, tl.bottom].every((v) => Number.isFinite(v))
      && tl.right > tl.left && tl.bottom > tl.top;
    if (hasBounds) {
      const cx = (tl.left + tl.right) / 2;
      const cy = (tl.top + tl.bottom) / 2;
      updates.reuseSrcCx = cx;
      updates.reuseSrcCy = cy;
      updates.reuseTightThick = true;
      centerFromRect = { cx, cy };
      alignTarget = { cx, cy, font: layerFont || null };
    }
    drafts.push({
      create,
      updates: Object.keys(updates).length > 0 ? updates : null,
      centerFromRect,
      alignTarget,
    });
  }
  return drafts;
}

// 【写植再利用 / draft 反映】collectReuseDraftsForPage が返した drafts を実際の state へ反映する。
// addNewLayer / updateNewLayer / alignTargets への push はここだけで行う（commit 境界の前段）。
// layerRectForNew は created 依存のため、centerFromRect の x/y はここで解決する。
function applyReuseDraftsToPage(page, drafts, alignTargets) {
  let count = 0;
  for (const d of drafts) {
    const created = addNewLayer(d.create);
    let updates = d.updates ? { ...d.updates } : null;
    if (created && d.centerFromRect) {
      const rect = layerRectForNew(page, created);
      updates = updates || {};
      updates.x = d.centerFromRect.cx - rect.width / 2;
      updates.y = d.centerFromRect.cy - rect.height / 2;
    }
    if (created && updates && Object.keys(updates).length > 0) {
      updateNewLayer(created.tempId, updates);
    }
    if (created && d.alignTarget && Array.isArray(alignTargets)) {
      alignTargets.push({
        psdPath: page.path,
        tempId: created.tempId,
        cx: d.alignTarget.cx,
        cy: d.alignTarget.cy,
        font: d.alignTarget.font,
      });
    }
    count += 1;
  }
  return count;
}

// fontSizeMode / unifyFont / unifySize から collect 用の設定オブジェクトを 1 度だけ作る。
// 「写植見本を再現」= reproduce（unify=false）/「フォント・サイズを指定」= select（unify=true）。
function buildReuseCollectConfig(fontSizeMode, unifyFont, unifySize, punctuationSpaceReplacementEnabled) {
  const unify = fontSizeMode === "select";
  const defaultFont = unify ? (unifyFont || getDefault("fontPostScriptName") || null) : null;
  const sizeRaw = unify ? Number(unifySize ?? getDefault("textSize")) : NaN;
  const defaultSizePt = unify && Number.isFinite(sizeRaw) && sizeRaw > 0 ? sizeRaw : null;
  return { unify, defaultFont, defaultSizePt, punctuationSpaceReplacementEnabled };
}

// 【写植再利用 / commit 境界】collect 済みの全ページ drafts を通常 newLayers へ一括反映する。
// collect（解析）と apply（state 反映）を分離する commit フェーズで、リサイクル固有の抽出結果を
// ここで初めて通常写植 state へ流し込む唯一の出口。draftsByPage: [{ page, drafts }]。
// 挙動は旧「ページごとに即 apply」と等価（最終 state / 履歴 / tempId 順は同じ。反映タイミングが
// ループ末尾に寄るだけ＝読込中の見た目以外は不変）。
function commitReuseSessionToTypesetting(draftsByPage, alignTargets) {
  let total = 0;
  for (const entry of (Array.isArray(draftsByPage) ? draftsByPage : [])) {
    if (!entry || !entry.page || !Array.isArray(entry.drafts)) continue;
    total += applyReuseDraftsToPage(entry.page, entry.drafts, alignTargets);
  }
  return total;
}

// options:
//   extract       : true なら元テキストを新規レイヤーとして抽出配置する（新規読込）。
//                   false ならスキップ（プロジェクト再開: newLayers は snapshot から復元）。
//   skipReference : true なら見本ペインへの setPdf をスキップ（再開時は保存済み JPG を使う）。
//   keepProgressOpen / progressFlow : 進捗モーダル制御。
export async function loadPsdFilesForReuse(files, {
  progressFlow = null,
  progressFlowSteps = null,
  keepProgressOpen = false,
  extract = true,
  skipReference = false,
  fontSizeMode = "reproduce",
  unifyFont = null,
  unifySize = null,
  punctuationSpaceReplacementEnabled = getDefault("punctuationSpaceReplacementEnabled"),
  loadOperationToken = null,
} = {}) {
  if (!files || files.length === 0) return;
  const ownLoadOperationToken = loadOperationToken ? null : tryBeginLoadOperation("reuse-load");
  if (!loadOperationToken && !ownLoadOperationToken) {
    toast("PSDの読み込み中です。完了までお待ちください", { kind: "info", duration: 2200 });
    return;
  }
  try {
  await refreshMemoryStatus();
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  files = [...files].sort((a, b) => collator.compare(baseName(a), baseName(b)));

  setFolder(parentDir(files[0]) ?? null);
  setGuidesLocked(false);

  const flowForPhase = (phase) => {
    if (!progressFlow || !progressFlowSteps) return progressFlow;
    const id = typeof progressFlow === "string" ? progressFlow : progressFlow.id;
    const stepId = progressFlowSteps[phase];
    return id && stepId ? { id, stepId } : progressFlow;
  };
  const readFlow = flowForPhase("read");
  const extractFlow = flowForPhase("extract");
  const placeFlow = flowForPhase("place");
  const viewFlow = flowForPhase("view");
  const progressVariant = progressFlowSteps ? "place" : "load";

  showProgress(withProgressFlow(readFlow, {
    title: "リサイクルを準備中…",
    detail: baseName(files[0]),
    current: 0,
    total: files.length,
    variant: progressVariant,
    tasks: ["ファイル確認", "PSD解析", "テキスト抽出"],
    taskIndex: 0,
    taskProgress: 0,
  }));

  // 先に reuse モードへ。clearPages が reuseInfo もクリアするので、この後 setReuseInfo で再登録。
  setAppMode("reuse");
  clearPages();
  renderAllSpreads();
  rebuildLayerList();
  window.dispatchEvent(new CustomEvent("psdesign:psd-loaded"));

  const failures = [];
  const unsupported = [];
  const referenceItems = [];
  const reuseTextSourcePages = [];
  // フォントロード後に中心を合わせるための配置補正ターゲット群。
  const alignTargets = [];
  // 【commit 境界】ページループでは collect（draft 生成）だけ行い、ここに溜める。
  // ループ後に commitReuseSessionToTypesetting で通常 newLayers へ一括反映する。
  const reuseDraftsByPage = [];
  const reuseCollectConfig = buildReuseCollectConfig(
    fontSizeMode, unifyFont, unifySize, punctuationSpaceReplacementEnabled,
  );

  // 【一括読み取り】まず 1 回の Photoshop セッションで全 PSD を読み取る。これにより
  // 1 枚ごとに Photoshop を起動し直して前面化する挙動を避け、最初に総ページ数も把握できる。
  // 失敗 / 件数不一致時は従来の per-file 読み取りにフォールバックする。
  let batchPages = null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    updateProgress(withProgressFlow(readFlow, {
      detail: `Photoshop で ${files.length} ページを読み取り中…`,
      current: 0,
      total: files.length,
      taskIndex: 0,
    }));
    const json = await invoke("read_psd_text_layers_batch", { psdPaths: files });
    const parsed = JSON.parse(json);
    if (parsed && Array.isArray(parsed.pages) && parsed.pages.length === files.length) {
      batchPages = parsed.pages; // files と同順
    } else {
      console.warn("[reuse] batch page count mismatch, falling back to per-file", parsed?.pages?.length, files.length);
    }
  } catch (e) {
    console.warn("[reuse] batch read failed, falling back to per-file:", e);
  }
  if (progressFlowSteps) {
    completeProgressFlowStep(readFlow, { detail: "PSD読み取り 完了" });
  }

  for (let i = 0; i < files.length; i++) {
    const path = files[i];
    updateProgress(withProgressFlow(extractFlow, {
      detail: `テキストを抽出中… (${baseName(path)})`,
      current: i,
      total: files.length,
      taskIndex: i === 0 ? 0 : 1,
    }));
    try {
      let page = null;
      const r = batchPages ? batchPages[i] : null;
      if (r && r.ok) {
        page = await buildReusePageFromPsData(path, r);
        if (page) {
          page = await mergeReuseStrokeHintsFromAgPsd(page, path);
          page = await mergeReuseLeadingFromAgPsd(page, path);
          // ag-psd の実 bounds（rendered）を各 item に貼り、位置補正の基準を字面ボックスから rendered へ。
          page = await mergeReuseBoundsFromAgPsd(page, path);
        }
      }
      // バッチ未取得 / 不完全なページは個別読み取りにフォールバック。
      if (!page) page = await loadPsdForReuse(path);
      addPage(page);
      if (extract) {
        // collect のみ（state は変更しない）。reuseTextSourcePages は collect が追記する。
        const drafts = await collectReuseDraftsForPage(
          page,
          reuseCollectConfig,
          reuseTextSourcePages,
          i + 1,
        );
        reuseDraftsByPage.push({ page, drafts });
      }
      setReuseInfo(page.path, {
        hideLayerIds: page.reuseTextLayerIds || [],
        referenceCanvas: page.reuseReferenceCanvas || null,
        referenceImagePath: page.reuseReferenceImagePath || null,
        // 写植再利用した PSD は保存時に元テキストを非表示にする（per-PSD フラグ）。
        hideOriginalText: true,
      });
      if (page.reuseReferenceCanvas) {
        referenceItems.push({ canvas: page.reuseReferenceCanvas, path: page.path });
      }
      renderAllSpreads();
      rebuildLayerList();
      window.dispatchEvent(new CustomEvent("psdesign:psd-loaded"));
    } catch (e) {
      console.error(e);
      if (e instanceof UnsupportedBitmapPsdError || e?.code === "UNSUPPORTED_BITMAP_PSD") {
        unsupported.push(path);
      } else {
        failures.push({ path, error: e });
      }
    }
    updateProgress(withProgressFlow(extractFlow, {
      detail: `テキスト抽出 完了 (${baseName(path)})`,
      current: i + 1,
      total: files.length,
      taskIndex: i + 1 >= files.length ? 2 : 1,
    }));
  }
  if (progressFlowSteps) {
    completeProgressFlowStep(extractFlow, { detail: "テキスト抽出 完了" });
  }

  // 【commit 境界】collect 済みの全ページ drafts を通常 newLayers へ一括反映する。
  // ここで初めてリサイクル抽出結果が通常写植 state に入る。反映後に再描画してレイヤーを表示。
  if (extract && reuseDraftsByPage.length > 0) {
    commitReuseSessionToTypesetting(reuseDraftsByPage, alignTargets);
    renderAllSpreads();
    rebuildLayerList();
  }

  // 見本ペインに元テキスト入りの合成画像を流し込む。
  // 再開時 (skipReference) は保存済み JPG を別途読み込むのでスキップ。
  if (extract) {
    updateProgressFlow(placeFlow, { detail: "原稿テキストを生成中…", progress: 8, showCount: false });
    const content = buildReuseTextSourceContent(reuseTextSourcePages);
    setTxtSource(content ? { name: reuseTextSourceName(files), content } : null);
    setTxtFilePath(null);
    setTxtDirty(false);
  }

  if (referenceItems.length > 0 && !skipReference) {
    try {
      updateProgressFlow(placeFlow, { detail: "見本ペインを準備中…", progress: 28, showCount: false });
      const doc = await buildReferenceDocFromCanvases(referenceItems);
      setPdf(doc, referenceItems[0].path, referenceItems.map((it) => it.path));
    } catch (e) {
      console.warn("[reuse] reference doc build failed:", e);
    }
  }

  window.dispatchEvent(new CustomEvent("psdesign:psd-loaded"));

  // 【写植再利用】再生成テキストの中心を元レイヤーの中心に厳密に合わせる。
  // フォントを確実にロード → 再描画 → 実描画 rect を測って中心ズレを補正、の順で実行する。
  // フォント未ロードのまま測ると measureText 幅が変わって後でズレる（ページ切替で右に動く）ため、
  // 必ずロード後に測定する。
  if (extract && alignTargets.length > 0) {
    try {
      updateProgressFlow(placeFlow, { detail: "フォントを読み込み中…", progress: 48, showCount: false });
      // フォントを確実にロードしてから measureText で実テキスト寸法を確定させる。
      const fonts = new Set(alignTargets.map((t) => t.font).filter(Boolean));
      await Promise.all([...fonts].map((f) => Promise.resolve(ensureFontLoaded(f)).catch(() => {})));
      // 全ページ一括で、実テキスト寸法から決定論的に中心を合わせる（DOM・ページ切替に非依存）。
      updateProgressFlow(placeFlow, { detail: "配置中心を補正中…", progress: 72, showCount: false });
      const moved = alignReuseLayersToSourceCenters(alignTargets, getPages());
      if (moved > 0) {
        renderAllSpreads();
        rebuildLayerList();
      }
    } catch (e) {
      console.warn("[reuse] center align failed:", e);
    }
    // 配置・中心補正が確定した時点の位置を「元の配置位置」として記録する。
    // 保存時にこの位置から動いていなければ Photoshop 元中心 (reuseSrcCx/Cy) で厳密再現する。
    markReuseLayerOrigins();
  }
  if (progressFlowSteps) {
    completeProgressFlowStep(placeFlow, { detail: "配置調整 完了" });
    completeProgressFlowStep(viewFlow, { detail: "表示準備 完了" });
  }

  const allFailed = failures.length + unsupported.length === files.length;
  if (!keepProgressOpen || allFailed) {
    await hideProgress({ success: !allFailed });
  }

  if (unsupported.length) {
    await notifyUnsupportedBitmapPsdFiles(unsupported);
  }
  if (failures.length) {
    const first = failures[0];
    const msg = failures.length === 1
      ? `読込失敗 ${baseName(first.path)}: ${first.error?.message ?? first.error}`
      : `読込失敗 ${failures.length} 件（${baseName(first.path)} 他）`;
    toast(msg, { kind: "error", duration: 5000 });
  }
  } finally {
    if (ownLoadOperationToken) endLoadOperation(ownLoadOperationToken);
  }
}
