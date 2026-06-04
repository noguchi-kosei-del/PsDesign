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
} from "../state.js";
import { hideProgress, showProgress, toast, updateProgress } from "../ui-feedback.js";
import { withProgressFlow } from "../progress-flow.js";
import { renderAllSpreads } from "../spread-view.js";
import { rebuildLayerList } from "../text-editor.js";
import {
  UnsupportedBitmapPsdError,
  loadPsdForReuse,
  buildReusePageFromPsData,
} from "../psd-loader.js";
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
    if (score >= threshold && bucket >= 1) {
      out.fontPostScriptName = cloudPs;
      out.autoFontSwitched = true;
      out.autoFontSwitchBucket = bucket;
    }
  }
  return out;
}

// PS テキスト項目群について、背景画像で周辺解析を行い metrics 配列を返す（idx 対応）。
async function analyzeReuseRegions(bgImagePath, psItems, dpi) {
  if (!bgImagePath || !Array.isArray(psItems) || psItems.length === 0) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const regions = psItems.map((it) => {
      const sizePt = Number(it.sizePt);
      const fontSizePx = Number.isFinite(sizePt) && sizePt > 0 ? (sizePt * (Number(dpi) || 72)) / 72 : 24;
      return {
        left: Number(it.left) || 0,
        top: Number(it.top) || 0,
        right: Number(it.right) || 0,
        bottom: Number(it.bottom) || 0,
        fontSizePx,
      };
    });
    const metrics = await invoke("analyze_image_text_regions", { imagePath: bgImagePath, regions });
    return Array.isArray(metrics) ? metrics : null;
  } catch (e) {
    console.warn("[reuse] 周辺解析に失敗（自動白フチ/中丸ゴシックをスキップ）:", e);
    return null;
  }
}

// 1 ページぶんの元テキストレイヤーを「新規レイヤー」として同座標に配置する。
// Photoshop が読んだ実テキスト (reusePsTextItems) があればそれを優先（実内容/フォント/
// サイズ/座標が正確）。無ければ ag-psd 抽出 (reuseTextLayers) にフォールバック。
// 植字後、通常写植と同じ周辺解析で「白フチ自動付与」「中丸ゴシック自動切替」を反映する。
// fontSizeMode:
//   "reproduce" (既定) … 元レイヤーのフォント・サイズを再現する。
//   "select"          … 指定フォント・サイズ（unifyFont / unifySize、無ければ既定）で全テキストを統一する（位置は元のまま）。
function roundReuseReproduceSizePt(sizePt) {
  const n = Number(sizePt);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 10 + 1e-8) / 10;
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

async function extractTextLayersToNewLayers(page, alignTargets, fontSizeMode = "reproduce", unifyFont = null, unifySize = null, sourcePages = null, pageNumber = 1) {
  const unify = fontSizeMode === "select";
  const defaultFont = unify ? (unifyFont || getDefault("fontPostScriptName") || null) : null;
  const sizeRaw = unify ? Number(unifySize ?? getDefault("textSize")) : NaN;
  const defaultSizePt = unify && Number.isFinite(sizeRaw) && sizeRaw > 0 ? sizeRaw : null;
  const psItems = Array.isArray(page?.reusePsTextItems) ? page.reusePsTextItems : null;
  if (psItems && psItems.length > 0) {
    // 周辺解析（テキスト非表示の背景画像で白率 / ウニを計測）。
    const metricsList = await analyzeReuseRegions(page.reuseBgImagePath, psItems, page.dpi);
    let count = 0;
    for (let i = 0; i < psItems.length; i++) {
      const it = psItems[i];
      if (!it) continue;
      // Photoshop の contents は改行が \r。アプリ内は \n に正規化。
      const contents = String(it.contents ?? "").replace(/\r\n?/g, "\n");
      if (!contents) continue;
      const direction = it.direction === "vertical" ? "vertical" : "horizontal";
      const hasBounds = [it.left, it.top, it.right, it.bottom].every((v) => Number.isFinite(v))
        && it.right > it.left && it.bottom > it.top;
      // サイズ: Photoshop が読んだ textItem.size を元サイズとして採用する。
      // Photoshop 経路の bounds は描画済み bbox なので、縦書き・複数行・句読点ツメでは
      // 厚み軸が実 fontSize より小さく出やすい。ここで bounds 逆算を優先すると
      // 「写植見本を再現」時に文字が縮むため、sizePt が取れない場合だけフォールバックに使う。
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
      // 周辺解析から白フチ / 中丸ゴシックを判定（元フォントをベースに上書き）。
      const auto = computeAutoStyleFromMetrics(
        metricsList ? metricsList[i] : null,
        it.font || null,
      );
      // 「統一」モードでは既定フォント・サイズで上書き（位置は元のまま中心合わせ）。
      const layerFont = defaultFont ?? auto.fontPostScriptName;
      const layerSize = defaultSizePt ?? roundReuseReproduceSizePt(sizePt);
      const useSourceBounds = !unify && hasBounds;
      const sourceTxtRef = appendReuseTextSourceBlock(sourcePages, pageNumber, contents);
      const created = addNewLayer({
        psdPath: page.path,
        x: Number.isFinite(it.left) ? it.left : 0,
        y: Number.isFinite(it.top) ? it.top : 0,
        contents,
        fontPostScriptName: layerFont,
        sizePt: layerSize,
        direction,
        strokeColor: auto.strokeColor,
        strokeWidthPx: auto.strokeWidthPx,
        leadingPct: 125,
        autoFontSwitched: auto.autoFontSwitched,
        autoFontSwitchBucket: auto.autoFontSwitchBucket,
        sourceTxtRef,
      });
      // 元レイヤーの実 bbox 中心に新規枠の中心を合わせる（auto-place と同じ中心固定方式）。
      // OPUS の新規レイヤー枠は文字数推定ベースなので、top-left 配置だと縦書きアンカー差や
      // 枠サイズ推定差で位置がずれる。中心を合わせれば推定枠が多少違っても見た目が一致する。
      // ここは初期推定（フォント未ロードで誤差あり）。最終的にはフォントロード後に
      // alignReuseLayersToSourceCenters で実描画中心を測って厳密に合わせる。
      if (created && hasBounds) {
        const cx = (it.left + it.right) / 2;
        const cy = (it.top + it.bottom) / 2;
        // reuseSrcCx/Cy = 元レイヤーの中心。保存時に「実 bounds 中心」をここへ合わせ、元の位置を厳密再現。
        // reuseTightThick = 枠の厚み方向を実テキスト幅に詰める（左余白を作らない）。
        const updates = { reuseSrcCx: cx, reuseSrcCy: cy, reuseTightThick: true };
        if (useSourceBounds) {
          Object.assign(updates, {
            x: it.left,
            y: it.top,
            reuseSrcLeft: it.left,
            reuseSrcTop: it.top,
            reuseSrcRight: it.right,
            reuseSrcBottom: it.bottom,
            reuseSourceContents: contents,
            reuseSourceSizePt: layerSize,
          });
        } else {
          const rect = layerRectForNew(page, created);
          updates.x = cx - rect.width / 2;
          updates.y = cy - rect.height / 2;
        }
        updateNewLayer(created.tempId, updates);
        if (!useSourceBounds && Array.isArray(alignTargets)) {
          alignTargets.push({ psdPath: page.path, tempId: created.tempId, cx, cy, font: layerFont || null });
        }
      }
      count += 1;
    }
    return count;
  }

  // フォールバック: ag-psd 抽出データ。
  const layers = Array.isArray(page?.reuseTextLayers) ? page.reuseTextLayers : [];
  let count = 0;
  for (const tl of layers) {
    if (!tl) continue;
    const boundsSizePt = getExistingLayerEffectiveSizePt(page, tl, null);
    // 「統一」モードでは既定フォント・サイズで上書き（位置は元のまま中心合わせ）。
    const layerFont = defaultFont ?? (tl.font || null);
    const layerSize = defaultSizePt ?? roundReuseReproduceSizePt(boundsSizePt);
    const contents = String(tl.text ?? "").replace(/\r\n?/g, "\n");
    if (!contents) continue;
    const sourceTxtRef = appendReuseTextSourceBlock(sourcePages, pageNumber, contents);
    const created = addNewLayer({
      psdPath: page.path,
      x: Number.isFinite(tl.left) ? tl.left : 0,
      y: Number.isFinite(tl.top) ? tl.top : 0,
      contents,
      fontPostScriptName: layerFont,
      sizePt: layerSize,
      direction: tl.direction === "vertical" ? "vertical" : "horizontal",
      strokeColor: tl.strokeColor ?? "none",
      strokeWidthPx: Number.isFinite(tl.strokeWidthPx) ? tl.strokeWidthPx : 20,
      fillColor: tl.fillColor ?? "default",
      leadingPct: 125,
      horizontalScale: Number.isFinite(tl.horizontalScale) ? tl.horizontalScale : 100,
      verticalScale: Number.isFinite(tl.verticalScale) ? tl.verticalScale : 100,
      trackingMille: Number.isFinite(tl.trackingMille) ? tl.trackingMille : 0,
      kerningMille: Number.isFinite(tl.kerningMille) ? tl.kerningMille : 0,
      sourceTxtRef,
    });
    const updates = {};
    // per-char フォントは「再現」モードのみ反映（「統一」モードは単一フォントに揃える）。
    if (created && !unify && tl.charFonts && Object.keys(tl.charFonts).length > 0) {
      updates.charFonts = { ...tl.charFonts };
    }
    // 元レイヤーの実 bbox 中心に合わせて再配置（Photoshop 経路と同じ中心固定）。
    const hasBounds = [tl.left, tl.top, tl.right, tl.bottom].every((v) => Number.isFinite(v))
      && tl.right > tl.left && tl.bottom > tl.top;
    if (created && hasBounds) {
      const cx = (tl.left + tl.right) / 2;
      const cy = (tl.top + tl.bottom) / 2;
      // 保存時に実 bounds 中心を元中心へ合わせるため、元中心を保持する。
      updates.reuseSrcCx = cx;
      updates.reuseSrcCy = cy;
      // 枠の厚み方向を実テキスト幅に詰める（左余白を作らない）。
      updates.reuseTightThick = true;
      if (!unify) {
        updates.x = tl.left;
        updates.y = tl.top;
        updates.reuseSrcLeft = tl.left;
        updates.reuseSrcTop = tl.top;
        updates.reuseSrcRight = tl.right;
        updates.reuseSrcBottom = tl.bottom;
        updates.reuseSourceContents = contents;
        updates.reuseSourceSizePt = layerSize;
      } else {
        const rect = layerRectForNew(page, created);
        updates.x = cx - rect.width / 2;
        updates.y = cy - rect.height / 2;
      }
      if (unify && Array.isArray(alignTargets)) {
        alignTargets.push({ psdPath: page.path, tempId: created.tempId, cx, cy, font: layerFont || null });
      }
    }
    if (created && Object.keys(updates).length > 0) {
      updateNewLayer(created.tempId, updates);
    }
    count += 1;
  }
  return count;
}

// options:
//   extract       : true なら元テキストを新規レイヤーとして抽出配置する（新規読込）。
//                   false ならスキップ（プロジェクト再開: newLayers は snapshot から復元）。
//   skipReference : true なら見本ペインへの setPdf をスキップ（再開時は保存済み JPG を使う）。
//   keepProgressOpen / progressFlow : 進捗モーダル制御。
export async function loadPsdFilesForReuse(files, {
  progressFlow = null,
  keepProgressOpen = false,
  extract = true,
  skipReference = false,
  fontSizeMode = "reproduce",
  unifyFont = null,
  unifySize = null,
} = {}) {
  if (!files || files.length === 0) return;
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  files = [...files].sort((a, b) => collator.compare(baseName(a), baseName(b)));

  setFolder(parentDir(files[0]) ?? null);
  setGuidesLocked(false);

  showProgress(withProgressFlow(progressFlow, {
    title: "リサイクルを準備中…",
    detail: baseName(files[0]),
    current: 0,
    total: files.length,
    variant: "load",
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

  // 【一括読み取り】まず 1 回の Photoshop セッションで全 PSD を読み取る。これにより
  // 1 枚ごとに Photoshop を起動し直して前面化する挙動を避け、最初に総ページ数も把握できる。
  // 失敗 / 件数不一致時は従来の per-file 読み取りにフォールバックする。
  let batchPages = null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    updateProgress(withProgressFlow(progressFlow, {
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

  for (let i = 0; i < files.length; i++) {
    const path = files[i];
    updateProgress(withProgressFlow(progressFlow, {
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
      }
      // バッチ未取得 / 不完全なページは個別読み取りにフォールバック。
      if (!page) page = await loadPsdForReuse(path);
      addPage(page);
      if (extract) {
        await extractTextLayersToNewLayers(
          page,
          alignTargets,
          fontSizeMode,
          unifyFont,
          unifySize,
          reuseTextSourcePages,
          i + 1,
        );
      }
      setReuseInfo(page.path, {
        hideLayerIds: page.reuseTextLayerIds || [],
        referenceCanvas: page.reuseReferenceCanvas || null,
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
    updateProgress(withProgressFlow(progressFlow, {
      detail: baseName(path),
      current: i + 1,
      total: files.length,
      taskIndex: i + 1 >= files.length ? 2 : 1,
    }));
  }

  // 見本ペインに元テキスト入りの合成画像を流し込む。
  // 再開時 (skipReference) は保存済み JPG を別途読み込むのでスキップ。
  if (extract) {
    const content = buildReuseTextSourceContent(reuseTextSourcePages);
    setTxtSource(content ? { name: reuseTextSourceName(files), content } : null);
    setTxtFilePath(null);
    setTxtDirty(false);
  }

  if (referenceItems.length > 0 && !skipReference) {
    try {
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
      // フォントを確実にロードしてから measureText で実テキスト寸法を確定させる。
      const fonts = new Set(alignTargets.map((t) => t.font).filter(Boolean));
      await Promise.all([...fonts].map((f) => Promise.resolve(ensureFontLoaded(f)).catch(() => {})));
      // 全ページ一括で、実テキスト寸法から決定論的に中心を合わせる（DOM・ページ切替に非依存）。
      const moved = alignReuseLayersToSourceCenters(alignTargets, getPages());
      if (moved > 0) {
        renderAllSpreads();
        rebuildLayerList();
      }
    } catch (e) {
      console.warn("[reuse] center align failed:", e);
    }
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
}
