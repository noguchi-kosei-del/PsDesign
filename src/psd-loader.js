import { readPsd } from "ag-psd";
import { extractPsdGuides } from "./utils/psd-guides.js";
import {
  getLargePsdPreviewLimits,
  getPreviewScaleForSize,
  getRasterMemoryLimits,
  isCriticalLowMemoryMode,
  isLowMemoryMode,
} from "./memory-mode.js";

let psdParseWorker = null;
let psdParseWorkerSeq = 1;
const psdParseWorkerPending = new Map();
const MANY_LAYER_LIGHT_PARSE_THRESHOLD = 700;

function maybeReleasePsdParseWorkerForMemory() {
  if (!isLowMemoryMode()) return;
  if (!psdParseWorker || psdParseWorkerPending.size > 0) return;
  psdParseWorker.terminate();
  psdParseWorker = null;
}

function waitForNextFrame() {
  if (typeof requestAnimationFrame !== "function") return Promise.resolve();
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function nowMs() {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

async function yieldIfNeeded(startedAt, budgetMs = 12) {
  if (nowMs() - startedAt < budgetMs) return nowMs();
  await waitForNextFrame();
  return nowMs();
}

function createBlankCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  return canvas;
}

function scaledSize(width, height, scale) {
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function createFinalPageCanvas(source, logicalWidth, logicalHeight) {
  const scale = getPreviewScaleForSize(logicalWidth, logicalHeight);
  const size = scaledSize(logicalWidth, logicalHeight, scale);
  if (
    source &&
    scale >= 0.999 &&
    source.width === size.width &&
    source.height === size.height
  ) {
    return { canvas: source, previewScale: 1 };
  }
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { canvas: source ?? null, previewScale: source ? 1 : scale };
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  if (source) {
    ctx.drawImage(source, 0, 0, size.width, size.height);
  } else {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size.width, size.height);
  }
  return { canvas, previewScale: scale };
}

function pageCanvasScale(canvas, logicalWidth, logicalHeight) {
  if (!canvas || !(logicalWidth > 0) || !(logicalHeight > 0)) return 1;
  const sx = canvas.width / logicalWidth;
  const sy = canvas.height / logicalHeight;
  const scale = Math.min(sx, sy);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

function downscaleCanvasForPage(canvas, logicalWidth, logicalHeight, targetScale) {
  if (!canvas || !(logicalWidth > 0) || !(logicalHeight > 0) || !(targetScale > 0)) return canvas;
  const currentScale = pageCanvasScale(canvas, logicalWidth, logicalHeight);
  if (currentScale <= targetScale + 0.001) return canvas;
  const size = scaledSize(logicalWidth, logicalHeight, targetScale);
  const out = document.createElement("canvas");
  out.width = size.width;
  out.height = size.height;
  const ctx = out.getContext("2d");
  if (!ctx) return canvas;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, 0, 0, size.width, size.height);
  return out;
}

export function downscaleLoadedPageForCurrentMemory(page) {
  if (!page || !(page.width > 0) || !(page.height > 0) || !isLowMemoryMode()) return false;
  const targetScale = getPreviewScaleForSize(page.width, page.height);
  if (!(targetScale > 0) || targetScale >= 0.999) return false;
  let changed = false;
  const nextCanvas = downscaleCanvasForPage(page.canvas, page.width, page.height, targetScale);
  if (nextCanvas && nextCanvas !== page.canvas) {
    page.canvas = nextCanvas;
    changed = true;
  }
  if (page.reuseReferenceCanvas) {
    const nextReference = downscaleCanvasForPage(page.reuseReferenceCanvas, page.width, page.height, targetScale);
    if (nextReference && nextReference !== page.reuseReferenceCanvas) {
      page.reuseReferenceCanvas = nextReference;
      changed = true;
    }
  }
  if (changed) {
    page.previewScale = targetScale;
    page.lowMemoryPreview = true;
  }
  return changed;
}

function withPreviewMetadata(page, previewScale = 1) {
  const scale = Number.isFinite(previewScale) && previewScale > 0 ? previewScale : 1;
  return {
    ...page,
    previewScale: scale,
    lowMemoryPreview: scale < 0.999,
  };
}

function expectedPreviewSize(width, height, scale) {
  return scaledSize(width, height, Number.isFinite(scale) && scale > 0 ? scale : 1);
}

function canvasMatchesPreviewSize(canvas, width, height, scale) {
  if (!canvas) return false;
  const size = expectedPreviewSize(width, height, scale);
  return canvas.width === size.width && canvas.height === size.height;
}

// テストモード用: 実 PSD を読まずに白紙ページオブジェクトを生成する。
// 戻り値は loadPsdFromPath と同じ形 ({path,width,height,canvas,textLayers,dpi})。
export function buildBlankPsdPage(path, width, height, dpi = 72) {
  const preview = createFinalPageCanvas(null, width, height);
  return withPreviewMetadata({
    path,
    width,
    height,
    canvas: preview.canvas,
    textLayers: [],
    dpi,
  }, preview.previewScale);
}

function virtualSplitPath(path, side) {
  return `${path}#psdesign-split-${side}`;
}

function stripVirtualSplitSuffix(path) {
  return String(path ?? "").replace(/#psdesign-split-(?:right|left)$/i, "");
}

function stripFileExtForPageNumber(name) {
  return String(name ?? "").replace(/\.[^.\\/]+$/, "");
}

function baseNameForPageNumber(path) {
  const clean = stripVirtualSplitSuffix(path);
  const m = clean && clean.match(/[\\/]([^\\/]+)$/);
  return m ? m[1] : clean;
}

function parseExplicitSpreadPageNumbers(path) {
  const name = stripFileExtForPageNumber(baseNameForPageNumber(path));
  const match = name.match(/(?:^|_)(\d{1,4})(?:[_\s]+(\d{1,4}))$/)
    ?? name.match(/^(\d{1,4})(?:[\-\s]+(\d{1,4}))$/);
  if (!match) return null;
  const nums = [match[1], match[2]]
    .map((v) => parseInt(v, 10))
    .filter((v) => Number.isInteger(v) && v > 0);
  if (nums.length !== 2) return null;
  return Math.abs(nums[1] - nums[0]) === 1 ? nums : null;
}

function cropCanvasHalf(source, logicalWidth, logicalHeight, offsetX, splitWidth) {
  if (!source || !(logicalWidth > 0) || !(logicalHeight > 0) || !(splitWidth > 0)) return null;
  const sxScale = source.width / logicalWidth;
  const syScale = source.height / logicalHeight;
  const sx = Math.max(0, Math.round(offsetX * sxScale));
  const sw = Math.max(1, Math.round(splitWidth * sxScale));
  const sh = Math.max(1, Math.round(logicalHeight * syScale));
  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d");
  if (!ctx) return source;
  ctx.drawImage(source, sx, 0, sw, sh, 0, 0, sw, sh);
  return canvas;
}

function shiftGuidesForSplit(guides, offsetX, splitWidth) {
  if (!guides) return guides;
  const h = Array.isArray(guides.h) ? [...guides.h] : [];
  const v = (Array.isArray(guides.v) ? guides.v : [])
    .map((x) => x - offsetX)
    .filter((x) => Number.isFinite(x) && x >= 0 && x <= splitWidth);
  return { h, v };
}

function splitLayerBelongsToSide(layer, offsetX, splitWidth) {
  const left = Number(layer?.left);
  const right = Number(layer?.right);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  const center = (left + right) / 2;
  return center >= offsetX && center < offsetX + splitWidth;
}

function shiftLayerForSplit(layer, offsetX) {
  const out = { ...layer };
  if (Number.isFinite(out.left)) out.left -= offsetX;
  if (Number.isFinite(out.right)) out.right -= offsetX;
  return out;
}

export function expandLandscapePsdPage(page) {
  if (!page || !(page.width > page.height)) return [page];
  const spreadPages = parseExplicitSpreadPageNumbers(page.path);
  if (!spreadPages) return [page];
  const splitWidth = page.width / 2;
  const sides = [
    { side: "right", offsetX: splitWidth, logicalPageNumber: spreadPages[0] },
    { side: "left", offsetX: 0, logicalPageNumber: spreadPages[1] },
  ];
  return sides.map(({ side, offsetX, logicalPageNumber }) => ({
    ...page,
    path: virtualSplitPath(page.path, side),
    sourcePath: page.path,
    sourceWidth: page.width,
    sourceHeight: page.height,
    splitSide: side,
    splitOffsetX: offsetX,
    splitWidth,
    logicalPageNumber,
    width: splitWidth,
    canvas: cropCanvasHalf(page.canvas, page.width, page.height, offsetX, splitWidth),
    reuseReferenceCanvas: cropCanvasHalf(page.reuseReferenceCanvas, page.width, page.height, offsetX, splitWidth),
    psdGuides: shiftGuidesForSplit(page.psdGuides, offsetX, splitWidth),
    textLayers: (page.textLayers ?? [])
      .filter((layer) => splitLayerBelongsToSide(layer, offsetX, splitWidth))
      .map((layer) => shiftLayerForSplit(layer, offsetX)),
  }));
}

function canUsePsdParseWorker() {
  return typeof Worker === "function" && typeof OffscreenCanvas === "function";
}

function readPsdHeaderSize(bytes) {
  try {
    const view = bytes instanceof Uint8Array
      ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : new DataView(bytes);
    if (view.byteLength < 26) return null;
    const sig = String.fromCharCode(
      view.getUint8(0),
      view.getUint8(1),
      view.getUint8(2),
      view.getUint8(3),
    );
    if (sig !== "8BPS") return null;
    const height = view.getUint32(14, false);
    const width = view.getUint32(18, false);
    if (!(width > 0 && height > 0)) return null;
    return { width, height, pixels: width * height };
  } catch {
    return null;
  }
}

function readUint64AsNumber(view, offset) {
  if (offset + 8 > view.byteLength) return null;
  const hi = view.getUint32(offset, false);
  const lo = view.getUint32(offset + 4, false);
  const value = hi * 2 ** 32 + lo;
  return Number.isSafeInteger(value) ? value : null;
}

function readSectionLength(view, offset, version) {
  if (version === 2) return { length: readUint64AsNumber(view, offset), bytes: 8 };
  if (offset + 4 > view.byteLength) return { length: null, bytes: 4 };
  return { length: view.getUint32(offset, false), bytes: 4 };
}

function readPsdLayerCount(bytes) {
  try {
    const view = bytes instanceof Uint8Array
      ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : new DataView(bytes);
    if (view.byteLength < 34) return null;
    const sig = String.fromCharCode(
      view.getUint8(0),
      view.getUint8(1),
      view.getUint8(2),
      view.getUint8(3),
    );
    if (sig !== "8BPS") return null;
    const version = view.getUint16(4, false);
    if (version !== 1 && version !== 2) return null;
    let offset = 26;
    const colorModeLength = view.getUint32(offset, false);
    offset += 4 + colorModeLength;
    if (offset >= view.byteLength) return null;
    const imageResources = readSectionLength(view, offset, version);
    if (!Number.isFinite(imageResources.length)) return null;
    offset += imageResources.bytes + imageResources.length;
    if (offset >= view.byteLength) return null;
    const layerMask = readSectionLength(view, offset, version);
    if (!Number.isFinite(layerMask.length) || layerMask.length <= 0) return 0;
    offset += layerMask.bytes;
    if (offset >= view.byteLength) return null;
    const layerInfo = readSectionLength(view, offset, version);
    if (!Number.isFinite(layerInfo.length) || layerInfo.length <= 0) return 0;
    offset += layerInfo.bytes;
    if (version === 2 && offset + 4 <= view.byteLength) {
      const count32 = Math.abs(view.getInt32(offset, false));
      return count32 < 1_000_000 ? count32 : null;
    }
    if (offset + 2 <= view.byteLength) {
      return Math.abs(view.getInt16(offset, false));
    }
    return null;
  } catch {
    return null;
  }
}

function shouldPreserveLayerImagesForLowMemory(bytes) {
  const maxPixels = Number(getRasterMemoryLimits().highFidelityMaskingMaxPixels);
  if (!(maxPixels > 0)) return false;
  const size = readPsdHeaderSize(bytes);
  return !!size && size.pixels <= maxPixels;
}

function psdParseHints(bytes) {
  const layerCount = readPsdLayerCount(bytes);
  return {
    layerCount,
    forceLightLayerParse: Number.isFinite(layerCount) && layerCount >= MANY_LAYER_LIGHT_PARSE_THRESHOLD,
  };
}

function shouldForceLightLayerParse(hints) {
  return hints?.forceLightLayerParse === true && isCriticalLowMemoryMode();
}

function collectLayerDiagnostics(layer, stats = {
  parsedLayerCount: 0,
  textLayerCount: 0,
  visibleTextLayerCount: 0,
  hiddenTextLayerCount: 0,
}, parentVisible = true) {
  if (!layer) return stats;
  stats.parsedLayerCount += 1;
  const effectiveVisible = parentVisible && !isLayerHidden(layer);
  if (layer.text) {
    stats.textLayerCount += 1;
    if (effectiveVisible) stats.visibleTextLayerCount += 1;
    else stats.hiddenTextLayerCount += 1;
  }
  if (Array.isArray(layer.children)) {
    for (const child of layer.children) {
      collectLayerDiagnostics(child, stats, effectiveVisible);
    }
  }
  return stats;
}

function buildParseDiagnostics({
  path,
  hints,
  stats,
  parseMode,
  forceLightLayerParse,
  skipLayerImageData,
  preserveLayerImages,
  finalCanvasSource,
  previewScale,
}) {
  const estimatedLayerCount = Number.isFinite(hints?.layerCount) ? hints.layerCount : null;
  const textLayerCount = Number.isFinite(stats?.textLayerCount) ? stats.textLayerCount : null;
  const visibleTextLayerCount = Number.isFinite(stats?.visibleTextLayerCount) ? stats.visibleTextLayerCount : null;
  const hiddenTextLayerCount = Number.isFinite(stats?.hiddenTextLayerCount) ? stats.hiddenTextLayerCount : null;
  const parsedLayerCount = Number.isFinite(stats?.parsedLayerCount) ? stats.parsedLayerCount : null;
  const lightParseUsed = forceLightLayerParse === true || skipLayerImageData === true;
  return {
    path,
    parseMode,
    manyLayerThreshold: MANY_LAYER_LIGHT_PARSE_THRESHOLD,
    estimatedLayerCount,
    parsedLayerCount,
    textLayerCount,
    visibleTextLayerCount,
    hiddenTextLayerCount,
    forceLightLayerParse: forceLightLayerParse === true,
    skipLayerImageData: skipLayerImageData === true,
    preserveLayerImages: preserveLayerImages === true,
    lightParseUsed,
    lowMemoryMode: isLowMemoryMode(),
    criticalLowMemoryMode: isCriticalLowMemoryMode(),
    finalCanvasSource: finalCanvasSource ?? null,
    previewScale: Number.isFinite(previewScale) ? previewScale : null,
  };
}

function logParseDiagnostics(diagnostics) {
  if (!diagnostics) return;
  const level = diagnostics.lightParseUsed ? "warn" : "info";
  console[level](
    `[psd-loader] diagnostics | path=${diagnostics.path} | mode=${diagnostics.parseMode}`
    + ` | layers=${diagnostics.estimatedLayerCount ?? "unknown"}`
    + ` | parsed=${diagnostics.parsedLayerCount ?? "unknown"}`
    + ` | text=${diagnostics.textLayerCount ?? "unknown"}`
    + ` | visibleText=${diagnostics.visibleTextLayerCount ?? "unknown"}`
    + ` | hiddenText=${diagnostics.hiddenTextLayerCount ?? "unknown"}`
    + ` | light=${diagnostics.lightParseUsed}`
    + ` | skipLayerImageData=${diagnostics.skipLayerImageData}`
    + ` | psTextFallback=${diagnostics.photoshopTextMetadataFallback ?? "not-needed"}`
    + ` | psTextMatched=${diagnostics.photoshopTextMetadataMatched ?? "n/a"}/${diagnostics.photoshopTextMetadataTotal ?? "n/a"}`
    + ` | psTextImported=${diagnostics.photoshopTextMetadataImported ?? "n/a"}`
    + ` | canvas=${diagnostics.finalCanvasSource ?? "unknown"}`,
  );
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizePsText(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").trim();
}

function normalizeTextLayerName(value) {
  return String(value ?? "").trim();
}

function normalizeExtractedStrokeColor(value) {
  return value === "white" || value === "black" ? value : "none";
}

function normalizeExtractedStrokeWidth(value) {
  const width = finiteNumber(value);
  return width !== null && width > 0 ? width : 20;
}

function strokeFromPhotoshopItem(item) {
  const strokeColor = normalizeExtractedStrokeColor(item?.strokeColor);
  const strokeWidthPx = normalizeExtractedStrokeWidth(item?.strokeWidthPx);
  return {
    strokeColor,
    strokeWidthPx: strokeColor === "none" ? 20 : strokeWidthPx,
  };
}

function isUsefulBounds(item) {
  const left = finiteNumber(item?.left);
  const top = finiteNumber(item?.top);
  const right = finiteNumber(item?.right);
  const bottom = finiteNumber(item?.bottom);
  return left !== null && top !== null && right !== null && bottom !== null && right >= left && bottom >= top;
}

function normalizeTransform(transform) {
  if (!Array.isArray(transform)) return null;
  const values = transform.slice(0, 6).map(finiteNumber);
  if (values.every((v) => v === null)) return null;
  return values.map((v) => v ?? 0);
}

function photoshopTextMetadataSignature(item) {
  const text = normalizePsText(item?.contents ?? item?.text);
  const name = normalizeTextLayerName(item?.name);
  return `${name}\u0000${text}`;
}

function visiblePhotoshopTextItems(psData) {
  return (Array.isArray(psData?.textLayers) ? psData.textLayers : [])
    .filter((item) => item && item.visible !== false);
}

function textLayerFromPhotoshopItem(item) {
  if (!item || item.visible === false) return null;
  const psId = finiteNumber(item.id);
  if (psId === null || psId <= 0 || !isUsefulBounds(item)) return null;
  const sizePt = finiteNumber(item.sizePt);
  const transform = normalizeTransform(item.transform);
  const effectiveSizePt = transform ? effectiveFontSize(sizePt, transform) : sizePt;
  const stroke = strokeFromPhotoshopItem(item);
  return {
    id: psId,
    photoshopLayerId: psId,
    name: typeof item.name === "string" ? item.name : "",
    text: normalizePsText(item.contents),
    font: typeof item.font === "string" ? item.font : "",
    rawFontSize: sizePt !== null && sizePt > 0 ? sizePt : null,
    fontSize: effectiveSizePt !== null && effectiveSizePt > 0 ? effectiveSizePt : 12,
    left: finiteNumber(item.left),
    top: finiteNumber(item.top),
    right: finiteNumber(item.right),
    bottom: finiteNumber(item.bottom),
    direction: item.direction === "vertical" ? "vertical" : "horizontal",
    horizontalScale: 100,
    verticalScale: 100,
    trackingMille: 0,
    kerningMille: 0,
    strokeColor: stroke.strokeColor,
    strokeWidthPx: stroke.strokeWidthPx,
    fillColor: typeof item.fillColor === "string" && item.fillColor ? item.fillColor : "default",
    ...(transform ? { transform } : {}),
    metadataSource: "photoshop",
  };
}

function mergePhotoshopTextMetadata(textLayers, psData) {
  const sourceLayers = Array.isArray(textLayers) ? textLayers : [];
  const psItems = visiblePhotoshopTextItems(psData);
  if (!psItems.length) {
    return { textLayers: sourceLayers, matched: 0, imported: 0, total: 0 };
  }

  const byId = new Map();
  const bySignature = new Map();
  for (const item of psItems) {
    const psId = finiteNumber(item.id);
    if (psId !== null && psId > 0 && !byId.has(psId)) byId.set(psId, item);
    const sig = photoshopTextMetadataSignature(item);
    if (!bySignature.has(sig)) bySignature.set(sig, []);
    bySignature.get(sig).push(item);
  }

  const used = new Set();
  let matched = 0;
  const merged = sourceLayers.map((layer) => {
    const layerId = finiteNumber(layer?.id);
    let item = layerId !== null ? byId.get(layerId) : null;
    if (item && used.has(item)) item = null;

    if (!item) {
      const sig = photoshopTextMetadataSignature({
        name: layer?.name,
        contents: layer?.text,
      });
      const candidates = bySignature.get(sig) ?? [];
      item = candidates.find((candidate) => !used.has(candidate)) ?? null;
    }

    if (!item) return layer;
    used.add(item);
    matched += 1;

    const out = { ...layer };
    const psId = finiteNumber(item.id);
    if (psId !== null && psId > 0) {
      out.id = psId;
      out.photoshopLayerId = psId;
    }
    if (layerId !== null && psId !== null && layerId !== psId) out.agPsdLayerId = layerId;
    if (typeof item.name === "string") out.name = item.name;
    if (typeof item.contents === "string") out.text = normalizePsText(item.contents);
    if (typeof item.font === "string" && item.font) out.font = item.font;
    const sizePt = finiteNumber(item.sizePt);
    const transform = normalizeTransform(item.transform);
    if (sizePt !== null && sizePt > 0) {
      out.rawFontSize = sizePt;
      out.fontSize = transform ? effectiveFontSize(sizePt, transform) : sizePt;
    }
    if (isUsefulBounds(item)) {
      out.left = finiteNumber(item.left);
      out.top = finiteNumber(item.top);
      out.right = finiteNumber(item.right);
      out.bottom = finiteNumber(item.bottom);
    }
    if (item.direction === "vertical" || item.direction === "horizontal") out.direction = item.direction;
    if (typeof item.fillColor === "string" && item.fillColor) out.fillColor = item.fillColor;
    const stroke = strokeFromPhotoshopItem(item);
    if (stroke.strokeColor !== "none") {
      out.strokeColor = stroke.strokeColor;
      out.strokeWidthPx = stroke.strokeWidthPx;
    }
    if (transform) out.transform = transform;
    out.metadataSource = "photoshop";
    return out;
  });

  let imported = 0;
  for (const item of psItems) {
    if (used.has(item)) continue;
    const layer = textLayerFromPhotoshopItem(item);
    if (!layer) continue;
    merged.push(layer);
    imported += 1;
  }

  return { textLayers: merged, matched, imported, total: psItems.length };
}

async function applyPhotoshopTextMetadataFallback(page, diagnostics) {
  if (!page || diagnostics?.lightParseUsed !== true) return page;
  diagnostics.photoshopTextMetadataFallback = "attempted";
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const json = await invoke("read_psd_text_layer_metadata", { psdPath: page.path });
    const psData = JSON.parse(json);
    const result = mergePhotoshopTextMetadata(page.textLayers, psData);
    diagnostics.photoshopTextMetadataFallback = "ok";
    diagnostics.photoshopTextMetadataMatched = result.matched;
    diagnostics.photoshopTextMetadataImported = result.imported;
    diagnostics.photoshopTextMetadataTotal = result.total;
    console.info(
      `[psd-loader] Photoshop text metadata fallback | path=${page.path}`
      + ` | matched=${result.matched}/${result.total}`
      + ` | imported=${result.imported}`,
    );
    return {
      ...page,
      textLayers: result.textLayers,
      psdDiagnostics: diagnostics,
    };
  } catch (error) {
    diagnostics.photoshopTextMetadataFallback = "failed";
    diagnostics.photoshopTextMetadataError = error?.message ?? String(error);
    console.warn("[psd-loader] Photoshop text metadata fallback failed:", page.path, error);
    return {
      ...page,
      psdDiagnostics: diagnostics,
    };
  }
}

function getPsdParseWorker() {
  if (psdParseWorker) return psdParseWorker;
  psdParseWorker = new Worker(new URL("./psd-parse-worker.js", import.meta.url), { type: "module" });
  psdParseWorker.onmessage = (event) => {
    const { id, ok, parsed, error } = event.data ?? {};
    const pending = psdParseWorkerPending.get(id);
    if (!pending) return;
    psdParseWorkerPending.delete(id);
    if (ok) {
      pending.resolve(parsed);
    } else {
      const err = new Error(error?.message ?? "PSD worker parse failed");
      err.name = error?.name ?? "Error";
      err.code = error?.code ?? null;
      pending.reject(err);
    }
    maybeReleasePsdParseWorkerForMemory();
  };
  psdParseWorker.onerror = (event) => {
    const error = new Error(event?.message ?? "PSD worker failed");
    for (const pending of psdParseWorkerPending.values()) {
      pending.reject(error);
    }
    psdParseWorkerPending.clear();
    psdParseWorker?.terminate();
    psdParseWorker = null;
  };
  return psdParseWorker;
}

function parsePsdWithWorker(bytes, hints = psdParseHints(bytes)) {
  if (!canUsePsdParseWorker()) return Promise.reject(new Error("PSD parse worker is not available"));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  // 低メモリ時は強い制限 + lowMemory フラグ（レイヤー画像スキップ等のパース挙動を変える）。
  // 通常メモリ時も巨大 PSD 縮小のため上限は渡すが、lowMemory:false なのでパース挙動
  // （マスキング合成・レイヤー画像保持）は従来どおりで、表示ラスターだけが縮小される。
  const limits = isLowMemoryMode()
    ? { ...getRasterMemoryLimits(), critical: isCriticalLowMemoryMode(), lowMemory: true }
    : { ...getLargePsdPreviewLimits(), lowMemory: false };
  limits.layerCount = hints.layerCount;
  limits.forceLightLayerParse = shouldForceLightLayerParse(hints);
  const id = psdParseWorkerSeq++;
  return new Promise((resolve, reject) => {
    psdParseWorkerPending.set(id, { resolve, reject });
    getPsdParseWorker().postMessage({ id, buffer, preview: limits }, [buffer]);
  });
}

function imageBitmapToCanvas(bitmap) {
  if (!bitmap) return null;
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return canvas;
}

function canvasDarknessStats(canvas) {
  if (!canvas || !(canvas.width > 0) || !(canvas.height > 0)) return null;
  const ctx = canvas.getContext?.("2d");
  if (!ctx) return null;

  const sampleCols = Math.min(48, Math.max(8, canvas.width));
  const sampleRows = Math.min(48, Math.max(8, canvas.height));
  let count = 0;
  let dark = 0;
  let veryDark = 0;
  let bright = 0;
  let sum = 0;
  let sampleTotal = 0;
  let transparent = 0;
  let translucent = 0;
  let alphaSum = 0;
  let minAlpha = 255;
  let maxAlpha = 0;

  try {
    for (let row = 0; row < sampleRows; row++) {
      const y = Math.min(canvas.height - 1, Math.floor((row + 0.5) * canvas.height / sampleRows));
      for (let col = 0; col < sampleCols; col++) {
        const x = Math.min(canvas.width - 1, Math.floor((col + 0.5) * canvas.width / sampleCols));
        const data = ctx.getImageData(x, y, 1, 1).data;
        const alpha = data[3] ?? 255;
        sampleTotal += 1;
        alphaSum += alpha;
        minAlpha = Math.min(minAlpha, alpha);
        maxAlpha = Math.max(maxAlpha, alpha);
        if (alpha < 16) {
          transparent += 1;
          continue;
        }
        if (alpha < 240) translucent += 1;
        const lum = 0.2126 * data[0] + 0.7152 * data[1] + 0.0722 * data[2];
        count += 1;
        sum += lum;
        if (lum < 72) dark += 1;
        if (lum < 36) veryDark += 1;
        if (lum > 210) bright += 1;
      }
    }
  } catch {
    return null;
  }

  if (sampleTotal === 0) return null;
  return {
    sampleTotal,
    opaqueSamples: count,
    average: count > 0 ? sum / count : null,
    darkRatio: count > 0 ? dark / count : 0,
    veryDarkRatio: count > 0 ? veryDark / count : 0,
    brightRatio: count > 0 ? bright / count : 0,
    transparentRatio: transparent / sampleTotal,
    translucentRatio: translucent / sampleTotal,
    opaqueRatio: count / sampleTotal,
    averageAlpha: alphaSum / sampleTotal,
    minAlpha,
    maxAlpha,
  };
}

function darkPreviewDecision(canvas, meta = {}) {
  const dpi = Number(meta.dpi ?? 0);
  const colorMode = Number(meta.colorMode);
  const bitsPerChannel = Number(meta.bitsPerChannel ?? 0);
  const channels = Number(meta.channels ?? 0);
  const isRgb = !Number.isFinite(colorMode) || colorMode === 3;
  const finalCanvasSource = String(meta.finalCanvasSource ?? "");
  const isSyntheticPreview =
    finalCanvasSource === "mask-rebuild"
    || finalCanvasSource === "visible-non-text-preview";
  const highRisk =
    isRgb
    && (dpi >= 300 || bitsPerChannel > 8 || channels > 3 || isSyntheticPreview);
  const stats = canvasDarknessStats(canvas);
  const hasLumStats = !!stats && stats.opaqueSamples > 0;
  const suspiciousDark = hasLumStats && highRisk && (
    (stats.average < 82 && stats.darkRatio > 0.56 && stats.brightRatio < 0.28)
    || (stats.average < 64 && stats.darkRatio > 0.44)
    || (stats.veryDarkRatio > 0.72 && stats.brightRatio < 0.18)
  );
  const suspiciousAlpha = !!stats
    && isRgb
    && channels > 3
    && (
      stats.transparentRatio > 0.08
      || stats.translucentRatio > 0.2
      || stats.averageAlpha < 245
    );
  const suspicious = suspiciousDark || suspiciousAlpha;
  let reason = "ok";
  if (!highRisk) reason = "not-high-risk";
  else if (!stats) reason = "no-stats";
  else if (!hasLumStats) reason = "no-opaque-samples";
  else if (suspiciousAlpha) reason = "suspicious-alpha";
  else if (suspiciousDark) reason = "suspicious-dark";
  else reason = "stats-not-suspicious";
  return {
    suspicious,
    reason,
    stats,
    meta: {
      path: meta.path ?? "",
      width: meta.width ?? null,
      height: meta.height ?? null,
      canvasWidth: canvas?.width ?? null,
      canvasHeight: canvas?.height ?? null,
      previewScale: pageCanvasScale(canvas, meta.width, meta.height),
      dpi: Number.isFinite(dpi) && dpi > 0 ? dpi : null,
      colorMode: Number.isFinite(colorMode) ? colorMode : null,
      bitsPerChannel: Number.isFinite(bitsPerChannel) && bitsPerChannel > 0 ? bitsPerChannel : null,
      channels: Number.isFinite(channels) && channels > 0 ? channels : null,
      isRgb,
      highRisk,
      isSyntheticPreview,
      finalCanvasSource: finalCanvasSource || null,
    },
  };
}

function looksLikeDarkAgPsdPreview(canvas, meta = {}) {
  const decision = darkPreviewDecision(canvas, meta);
  if (!decision.suspicious) return false;
  return true;
}

async function tryLoadPhotoshopPreviewCanvas(path, width, height) {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const json = await invoke("read_psd_text_layers", { psdPath: path });
    const psData = JSON.parse(json);
    const imagePath = psData?.refImage || psData?.bgImage;
    if (!imagePath) return null;
    return await jpgFileToCanvas(imagePath, width, height);
  } catch {
    return null;
  }
}

async function replaceDarkPreviewWithPhotoshopIfNeeded(canvas, meta) {
  if (!looksLikeDarkAgPsdPreview(canvas, meta)) return canvas;
  const replacement = await tryLoadPhotoshopPreviewCanvas(meta.path, meta.width, meta.height);
  if (!replacement) return canvas;
  return replacement;
}

export class UnsupportedBitmapPsdError extends Error {
  constructor(path) {
    super("モノクロ2階調のPSDは読み込めません");
    this.name = "UnsupportedBitmapPsdError";
    this.code = "UNSUPPORTED_BITMAP_PSD";
    this.path = path;
  }
}

function isBitmapPsd(psd) {
  return psd?.colorMode === 0;
}

// ag-psd の返す effects.stroke は Photoshop 側のバージョンや PSD の保存時期で
// 形状が揺れる。以下を吸収して堅牢に読み戻す:
//   - 配列 / 単体オブジェクトの両方
//   - enabled (新) と visible (旧) の両プロパティ
//   - size が数値 / { value, units } / { value: { value, units } } のいずれか
//   - color が { r,g,b } / [r,g,b] / #rrggbb の 3 形式
function pickActiveStrokeFx(raw) {
  if (!raw) return null;
  const list = Array.isArray(raw) ? raw : [raw];
  // enabled === true / visible !== false を最優先し、次に先頭をフォールバック。
  const active = list.find((fx) => fx && (fx.enabled === true || fx.visible === true));
  if (active) return active;
  const anyNotDisabled = list.find((fx) => fx && fx.enabled !== false && fx.visible !== false);
  return anyNotDisabled ?? list[0] ?? null;
}

function readStrokeSizePx(fx) {
  if (!fx) return null;
  const raw = fx.size;
  if (raw == null) return null;
  // 数値そのまま
  if (typeof raw === "number") return raw > 0 ? raw : null;
  // { value, units } 形式
  if (typeof raw === "object") {
    const units = (raw.units ?? raw.unit ?? "").toLowerCase();
    const v = typeof raw.value === "number"
      ? raw.value
      : typeof raw.value === "object"
        ? raw.value?.value
        : null;
    if (typeof v !== "number" || !(v > 0)) return null;
    // "pixels" / "px" 以外（points, percent, millimeters 等）は
    // PSD の解像度に依存するため厳密変換できない。pt のみ簡易換算（1pt ≒ 1.333px）、
    // それ以外は pixel 相当とみなして警告なしでそのまま採用。
    if (units.indexOf("pt") === 0 || units.indexOf("point") === 0) return v * (96 / 72);
    return v;
  }
  return null;
}

function readColorChannelValue(value) {
  if (typeof value === "number") return value;
  if (value && typeof value === "object") {
    if (typeof value.value === "number") return value.value;
    if (value.value && typeof value.value === "object" && typeof value.value.value === "number") return value.value.value;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normalizeRgbChannels(r, g, b) {
  r = readColorChannelValue(r);
  g = readColorChannelValue(g);
  b = readColorChannelValue(b);
  if (r <= 1 && g <= 1 && b <= 1 && (r > 0 || g > 0 || b > 0)) {
    r *= 255;
    g *= 255;
    b *= 255;
  }
  return [
    Math.max(0, Math.min(255, Math.round(Number(r) || 0))),
    Math.max(0, Math.min(255, Math.round(Number(g) || 0))),
    Math.max(0, Math.min(255, Math.round(Number(b) || 0))),
  ];
}

function normalizeCmykChannel(value) {
  const n = readColorChannelValue(value);
  if (!Number.isFinite(n)) return 0;
  if (n <= 1) return Math.max(0, Math.min(1, n));
  return Math.max(0, Math.min(1, n / 100));
}

function cmykObjectToRgb(c) {
  if (!c || typeof c !== "object") return null;
  const hasCmyk = c.k != null || c.black != null || c.c != null || c.cyan != null ||
    c.m != null || c.magenta != null || c.y != null || c.yellow != null;
  if (!hasCmyk) return null;
  const cyan = normalizeCmykChannel(c.c ?? c.cyan ?? 0);
  const magenta = normalizeCmykChannel(c.m ?? c.magenta ?? 0);
  const yellow = normalizeCmykChannel(c.y ?? c.yellow ?? 0);
  const black = normalizeCmykChannel(c.k ?? c.black ?? 0);
  return [
    255 * (1 - cyan) * (1 - black),
    255 * (1 - magenta) * (1 - black),
    255 * (1 - yellow) * (1 - black),
  ];
}

function readStrokeColor(fx) {
  if (!fx) return "none";
  // fx.enabled / fx.visible のどちらかが明示 false なら切られた扱い。
  if (fx.enabled === false) return "none";
  if (fx.visible === false) return "none";
  const c = fx.color;
  let r = 0, g = 0, b = 0;
  if (Array.isArray(c) && c.length >= 3) {
    [r, g, b] = c;
  } else if (c && typeof c === "object") {
    const cmykRgb = cmykObjectToRgb(c);
    if (cmykRgb) {
      [r, g, b] = cmykRgb;
    } else {
      r = c.r ?? c.red ?? 0;
      g = c.g ?? c.green ?? 0;
      b = c.b ?? c.blue ?? 0;
    }
  } else if (typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c)) {
    r = parseInt(c.slice(1, 3), 16);
    g = parseInt(c.slice(3, 5), 16);
    b = parseInt(c.slice(5, 7), 16);
  } else {
    return "none";
  }
  [r, g, b] = normalizeRgbChannels(r, g, b);
  // 【提案B】純白/純黒の判定閾値を >240/<15 から >=235/<=20 に緩め、紙白や
  // わずかに色味のある白フチも拾えるようにする（リサイクルの白フチ復元の取りこぼし対策）。
  if (r >= 235 && g >= 235 && b >= 235) return "white";
  if (r <= 20 && g <= 20 && b <= 20) return "black";
  // 白/黒 に分類できない色は保存時に壊さないよう "none" ではなく一旦読むが、
  // UI トグルは白/黒/なししかないので "none" フォールバックが安全。
  return "none";
}

// 塗り色は ag-psd の layer.text.style.fillColor に入る。保存時期/バージョンで
// {r,g,b} / {red,green,blue} / [r,g,b] / #rrggbb の揺れがあるため吸収。
// 白黒に分類できない色は HEX として保持し、編集 UI / 書き戻しに渡す。
function extractFillColor(layer) {
  const c = layer?.text?.style?.fillColor;
  if (!c) return "default";
  let r = 0, g = 0, b = 0;
  if (Array.isArray(c) && c.length >= 3) {
    [r, g, b] = c;
  } else if (typeof c === "object") {
    const cmykRgb = cmykObjectToRgb(c);
    if (cmykRgb) {
      [r, g, b] = cmykRgb;
    } else {
      r = c.r ?? c.red ?? 0;
      g = c.g ?? c.green ?? 0;
      b = c.b ?? c.blue ?? 0;
    }
  } else if (typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c)) {
    r = parseInt(c.slice(1, 3), 16);
    g = parseInt(c.slice(3, 5), 16);
    b = parseInt(c.slice(5, 7), 16);
  } else {
    return "default";
  }
  [r, g, b] = normalizeRgbChannels(r, g, b);
  if (r > 240 && g > 240 && b > 240) return "white";
  if (r < 15 && g < 15 && b < 15) return "black";
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function extractStroke(layer) {
  const effects = layer.effects ?? null;
  if (!effects) return { strokeColor: "none", strokeWidthPx: 20 };
  const fx = pickActiveStrokeFx(effects.stroke);
  if (!fx) return { strokeColor: "none", strokeWidthPx: 20 };
  const strokeColor = readStrokeColor(fx);
  const sz = readStrokeSizePx(fx);
  const strokeWidthPx = typeof sz === "number" && sz > 0 ? sz : 20;
  if (strokeColor === "none") return { strokeColor: "none", strokeWidthPx: 20 };
  return { strokeColor, strokeWidthPx };
}

// ag-psd の style.fontSize は PSD エンジンが保持している生の font size で、
// 実描画サイズはこれに layer.text.transform 行列の scale が掛かったもの。
// 例：PSD で「100pt のテキストを 0.2 倍に縮小して配置」した場合、
//   style.fontSize = 100、transform = [0.2, 0, 0, 0.2, tx, ty]
// なので実効 pt = 100 × 0.2 = 20pt。
// 行列式 = (a*d - b*c) は scale^2（回転は scale を変えないので det は等価）。
// その平方根 = 等価 uniform scale。漫画写植では基本 uniform scale なのでこの近似で十分。
function hasVisibleExtractedStroke(stroke) {
  return (stroke?.strokeColor === "white" || stroke?.strokeColor === "black")
    && Number.isFinite(stroke.strokeWidthPx)
    && stroke.strokeWidthPx > 0;
}

function collectReuseStrokeHintsFromAgPsd(layer, out = [], parentVisible = true, parentStroke = null) {
  const effectiveVisible = parentVisible && !isLayerHidden(layer);
  const own = extractStroke(layer);
  const ownVisible = hasVisibleExtractedStroke(own);
  // 子テキストへ継承する境界線：自身に効果があれば自身、無ければ祖先からの継承を引き継ぐ。
  // OPUS は「白フチ＋ルビ」をサブグループへ境界線適用するため、テキストレイヤー単体の
  // effects には frameFX が無く、グループ側に乗っている。親グループの効果を子テキストへ
  // 降ろすことで、Photoshop 読み取りが取りこぼした層でもヒントから白フチを復元できる。
  const strokeForChildren = ownVisible ? own : parentStroke;
  if (effectiveVisible && typeof layer?.id === "number") {
    // テキストレイヤーの hint は「自身の効果」優先、無ければ祖先グループの効果を継承。
    const effective = ownVisible ? own : (layer.text ? parentStroke : null);
    if (effective && hasVisibleExtractedStroke(effective)) {
      out.push({
        id: layer.id,
        name: layer.name ?? "",
        contents: layer.text?.text ?? "",
        left: layer.left ?? null,
        top: layer.top ?? null,
        right: layer.right ?? null,
        bottom: layer.bottom ?? null,
        strokeColor: effective.strokeColor,
        strokeWidthPx: effective.strokeWidthPx,
      });
    }
  }
  if (Array.isArray(layer?.children)) {
    for (const child of layer.children) collectReuseStrokeHintsFromAgPsd(child, out, effectiveVisible, strokeForChildren);
  }
  return out;
}

function boundsDistance(a, b) {
  const keys = ["left", "top", "right", "bottom"];
  let total = 0;
  for (const key of keys) {
    const av = finiteNumber(a?.[key]);
    const bv = finiteNumber(b?.[key]);
    if (av === null || bv === null) return Number.POSITIVE_INFINITY;
    total += Math.abs(av - bv);
  }
  return total;
}

function findReuseStrokeHintForPhotoshopItem(item, hints, usedHints) {
  const itemId = finiteNumber(item?.id);
  if (itemId !== null) {
    const byId = hints.find((hint) => !usedHints.has(hint) && finiteNumber(hint.id) === itemId);
    if (byId) return byId;
  }

  const text = normalizePsText(item?.contents);
  const name = normalizeTextLayerName(item?.name);
  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const hint of hints) {
    if (usedHints.has(hint)) continue;
    const hintText = normalizePsText(hint.contents);
    const hintName = normalizeTextLayerName(hint.name);
    if (text && hintText && hintText !== text) continue;
    if (name && hintName && hintName !== name) continue;
    const score = boundsDistance(item, hint);
    if (score < bestScore) {
      best = hint;
      bestScore = score;
    }
  }
  return bestScore <= 8 ? best : null;
}

export async function mergeReuseStrokeHintsFromAgPsd(page, path = page?.path) {
  const items = Array.isArray(page?.reusePsTextItems) ? page.reusePsTextItems : null;
  if (!items || items.length === 0 || !path) return page;
  const needsStroke = items.some((item) => {
    const stroke = strokeFromPhotoshopItem(item);
    return !hasVisibleExtractedStroke(stroke) || stroke.strokeColor === "black";
  });
  if (!needsStroke) return page;
  try {
    const bytes = await readFileBytes(path);
    await waitForNextFrame();
    const psd = readPsd(bytes, {
      skipLayerImageData: true,
      skipLinkedFilesData: true,
      skipThumbnail: true,
      useImageData: false,
    });
    const hints = [];
    if (Array.isArray(psd.children)) {
      for (const child of psd.children) collectReuseStrokeHintsFromAgPsd(child, hints, true);
    }
    if (!hints.length) return page;
    const usedHints = new Set();
    for (const item of items) {
      const hint = findReuseStrokeHintForPhotoshopItem(item, hints, usedHints);
      const current = strokeFromPhotoshopItem(item);
      if (!hint) {
        continue;
      }
      const currentHasStroke = hasVisibleExtractedStroke(current);
      const shouldApply = !currentHasStroke
        || current.strokeColor === hint.strokeColor
        || (current.strokeColor === "black" && hint.strokeColor === "white");
      if (!shouldApply) {
        continue;
      }
      usedHints.add(hint);
      item.strokeColor = hint.strokeColor;
      item.strokeWidthPx = hint.strokeWidthPx;
    }
  } catch (error) {
    console.warn("[reuse] stroke effect fallback read failed:", path, error);
  }
  return page;
}

function effectiveFontSize(rawFontSize, transform) {
  if (!Number.isFinite(rawFontSize) || rawFontSize <= 0) return rawFontSize ?? null;
  if (!Array.isArray(transform) || transform.length < 4) return rawFontSize;
  const [a, b, c, d] = transform;
  const det = Math.abs(a * d - b * c);
  if (!Number.isFinite(det) || det <= 0) return rawFontSize;
  const scale = Math.sqrt(det);
  // scale ≈ 1 ならフォーマット差吸収のため素通し。極端値（>10 / <0.01）も生値を返す
  // ことで「ag-psd 側で transform に意図しない値が入ったとき」の暴れを防ぐ。
  if (!(scale > 0.01 && scale < 10)) return rawFontSize;
  return rawFontSize * scale;
}

function readTextScalePercent(style, key) {
  const raw = style?.[key];
  let v = null;
  if (typeof raw === "number") {
    v = raw;
  } else if (raw && typeof raw === "object") {
    v = typeof raw.value === "number" ? raw.value : null;
  }
  if (!Number.isFinite(v) || v <= 0) return 100;
  return Math.max(10, Math.min(400, Math.round(v)));
}

function readTextSpacingMille(style, key) {
  const raw = style?.[key];
  let v = null;
  if (typeof raw === "number") {
    v = raw;
  } else if (raw && typeof raw === "object") {
    v = typeof raw.value === "number" ? raw.value : null;
  }
  if (!Number.isFinite(v)) return 0;
  return Math.max(-1000, Math.min(1000, Math.round(v)));
}

function extractStyleRunStyles(textData, baseFont, baseRawFontSize, transform) {
  const text = textData?.text ?? "";
  const runs = Array.isArray(textData?.styleRuns) ? textData.styleRuns : [];
  const charFonts = {};
  const charSizes = {};
  const charTrackings = {};
  const charKernings = {};
  const usedFonts = [];
  const baseEffectiveSize = effectiveFontSize(baseRawFontSize, transform);
  const baseTracking = readTextSpacingMille(textData?.style, "tracking");
  const baseKerning = readTextSpacingMille(textData?.style, "kerning");
  const addUsed = (font) => {
    if (!font || usedFonts.includes(font)) return;
    usedFonts.push(font);
  };
  addUsed(baseFont);

  let pos = 0;
  for (const run of runs) {
    const len = Math.max(0, Math.floor(Number(run?.length) || 0));
    const font = run?.style?.font?.name || baseFont || "";
    const rawSize = Number.isFinite(run?.style?.fontSize) ? run.style.fontSize : baseRawFontSize;
    const size = effectiveFontSize(rawSize, transform);
    const tracking = readTextSpacingMille(run?.style, "tracking");
    const kerning = readTextSpacingMille(run?.style, "kerning");
    if (font) addUsed(font);
    const end = Math.min(text.length, pos + len);
    if (font && font !== baseFont) {
      for (let i = pos; i < end; i++) charFonts[i] = font;
    }
    if (Number.isFinite(size) && Number.isFinite(baseEffectiveSize) && Math.abs(size - baseEffectiveSize) > 0.01) {
      for (let i = pos; i < end; i++) charSizes[i] = size;
    }
    if (tracking !== baseTracking) {
      for (let i = pos; i < end; i++) charTrackings[i] = tracking;
    }
    if (kerning !== baseKerning) {
      for (let i = pos; i < end; i++) charKernings[i] = kerning;
    }
    pos += len;
    if (pos >= text.length) break;
  }
  return { charFonts, charSizes, charTrackings, charKernings, usedFonts };
}

// 【v1.26.0 移植 (PsDesign-main v1.24.0)】非表示判定を統一する。
// ag-psd のバージョンによっては `hidden` ではなく `visible: false` のみセットされる
// ケースがあるため両方確認する。collectTextLayers / collectHiddenLayersForMasking /
// collectVisibleNonTextLayers で同じ判定関数を使う。
function isLayerHidden(layer) {
  return !!layer.hidden || layer.visible === false;
}

// PSD 上で非表示になっているレイヤー / フォルダ（およびその子孫）は
// 「読み込みから除外したものとして扱う」ため、collectTextLayers では親フォルダ
// の可視性を伝播し、テキストレイヤー本体 or 上位グループのいずれかが非表示
// であればテキスト一覧に含めない。
function collectTextLayers(layer, out = [], parentVisible = true) {
  const effectiveVisible = parentVisible && !isLayerHidden(layer);
  if (layer.text && typeof layer.id === "number") {
    if (!effectiveVisible) {
      // 非表示テキストはスキップ（子は持たない想定だがネストにも備えて return しない）
    } else {
      const style = layer.text.style ?? {};
      const orientation = layer.text.orientation;
      const { strokeColor, strokeWidthPx } = extractStroke(layer);
      const fillColor = extractFillColor(layer);
      const baseFont = style.font?.name ?? "";
      const baseFontSize = effectiveFontSize(style.fontSize, layer.text.transform);
      const { charFonts, charSizes, charTrackings, charKernings, usedFonts } = extractStyleRunStyles(
        layer.text,
        baseFont,
        style.fontSize,
        layer.text.transform,
      );
      out.push({
        id: layer.id,
        name: layer.name ?? "",
        text: layer.text.text ?? "",
        font: baseFont,
        charFonts,
        charSizes,
        charTrackings,
        charKernings,
        usedFonts,
        fontSize: baseFontSize,
        left: layer.left ?? 0,
        top: layer.top ?? 0,
        right: layer.right ?? 0,
        bottom: layer.bottom ?? 0,
        direction: orientation === "vertical" ? "vertical" : "horizontal",
        horizontalScale: readTextScalePercent(style, "horizontalScale"),
        verticalScale: readTextScalePercent(style, "verticalScale"),
        trackingMille: readTextSpacingMille(style, "tracking"),
        kerningMille: readTextSpacingMille(style, "kerning"),
        strokeColor,
        strokeWidthPx,
        fillColor,
      });
    }
  }
  if (Array.isArray(layer.children)) {
    for (const child of layer.children) {
      collectTextLayers(child, out, effectiveVisible);
    }
  }
  return out;
}

// 非表示レイヤーのうち、ag-psd がラスタライズして canvas を持っている
// もの（テキストレイヤー / 通常ラスター / スマートオブジェクトの一部）を
// 再帰的に集める。親グループが非表示でも子の canvas を独立に拾うため、
// 「フォルダごと非表示にされたテキスト群」も個別に削れる。
// canvas を持たないレイヤー（調整レイヤー等）はそもそも合成済み
// psd.canvas でも独立した「物体」として焼き込まれていないので無視して
// よい（裏側の絵柄を白で潰す副作用も無くなる）。
function collectHiddenLayersForMasking(layer, parentVisible, out) {
  const selfHidden = isLayerHidden(layer);
  const effectiveVisible = parentVisible && !selfHidden;

  if (
    !effectiveVisible &&
    layer.canvas &&
    layer.canvas.width > 0 &&
    layer.canvas.height > 0
  ) {
    // 【v1.26.0 移植 (PsDesign-main v1.24.0)】
    // frameFX (白フチ) サイズを取得して mask の dilate 量を決める根拠にする。
    // 白フチ無しのレイヤーは小さい dilate で文字輪郭ぴったりに消す。
    const stroke = extractStroke(layer);
    const strokePx = stroke.strokeColor === "none" ? 0 : stroke.strokeWidthPx;
    out.push({
      canvas: layer.canvas,
      left: layer.left ?? 0,
      top: layer.top ?? 0,
      name: layer.name,
      isText: !!layer.text,
      strokePx,
    });
  }

  // 親が非表示でも子は個別に canvas を持っている可能性があるので必ず再帰する。
  if (Array.isArray(layer.children)) {
    for (const child of layer.children) {
      collectHiddenLayersForMasking(child, effectiveVisible, out);
    }
  }
}

// 【v1.26.0 移植 (PsDesign-main v1.24.0)】
// 全レイヤーツリーを再帰スキャンし、可視 + 非テキスト + canvas を持つ レイヤーを集める。
// 出力順はツリーの上から (= ag-psd children 順) なので、描画時は reverse する。
//
// グループ canvas (フォルダ合成済み) を採用すると、内部に可視テキストが含まれていた
// ときに「テキストごと焼き込まれた絵柄」が visibleCanvas に入ってしまい、それで
// 非表示部分を上書きすると「可視テキスト位置に焼き込みテキスト」が見えてしまう。
// よって **フォルダはスキップして子を再帰**、ラスター本体 (canvas を持つ非フォルダ)
// だけを描画候補に集める。
function collectVisibleNonTextLayers(layer, parentVisible, out) {
  const selfHidden = isLayerHidden(layer);
  const effectiveVisible = parentVisible && !selfHidden;

  // テキストレイヤーは除外 (子は持たない想定だが念のため再帰)
  if (layer.text) {
    if (Array.isArray(layer.children)) {
      for (const child of layer.children) {
        collectVisibleNonTextLayers(child, effectiveVisible, out);
      }
    }
    return;
  }
  // フォルダ (children あり) はスキップして子を再帰。フォルダ自身の合成 canvas は
  // 内部テキストを含む可能性があるので採用しない。
  const isFolder = Array.isArray(layer.children);
  if (!isFolder &&
      effectiveVisible &&
      layer.canvas &&
      layer.canvas.width > 0 &&
      layer.canvas.height > 0) {
    out.push(layer);
    return;
  }
  if (isFolder) {
    for (const child of layer.children) {
      collectVisibleNonTextLayers(child, effectiveVisible, out);
    }
  }
}

// 【写植再利用】可視テキストレイヤーを再帰収集する。buildTextRemovedCanvas で
// 「絵柄から消す対象」、保存時に非表示化する元レイヤー id の取得に使う。
// canvas があればその寸法を、無ければ bbox (right-left / bottom-top) を上書き範囲に使う。
function collectVisibleTextLayersForMasking(layer, parentVisible, out) {
  const effectiveVisible = parentVisible && !isLayerHidden(layer);
  if (effectiveVisible && layer.text && typeof layer.id === "number") {
    const stroke = extractStroke(layer);
    const strokePx = stroke.strokeColor === "none" ? 0 : stroke.strokeWidthPx;
    const lc = layer.canvas;
    const hasCanvas = lc && lc.width > 0 && lc.height > 0;
    const left = layer.left ?? 0;
    const top = layer.top ?? 0;
    const width = hasCanvas ? lc.width : Math.max(0, (layer.right ?? 0) - left);
    const height = hasCanvas ? lc.height : Math.max(0, (layer.bottom ?? 0) - top);
    if (width > 0 && height > 0) {
      // canvas はグリフ形状マスク（文字部分だけを白で消す）に使う。無ければ矩形白塗りに退避。
      out.push({ id: layer.id, left, top, width, height, strokePx, canvas: hasCanvas ? lc : null });
    }
  }
  if (Array.isArray(layer.children)) {
    for (const child of layer.children) {
      collectVisibleTextLayersForMasking(child, effectiveVisible, out);
    }
  }
}

// 【v1.26.0 移植 (PsDesign-main v1.24.0)】
// 矩形が「ほぼ白で塗られている (= 絵柄が無い)」かを軽量サンプリングで判定。
// 4 隅 + 中央の 5 点を getImageData で取り、すべて白に近ければ true。
// 「visibleCanvas の該当領域に何も描画されなかった」ケース (= ag-psd で
// 線画/背景レイヤーの canvas が取得できなかった) を検出して、上書き処理を
// skip するために使う。元の psd.canvas を残すことで「白塗り問題」を防ぐ。
function isRectMostlyWhite(ctx, sx, sy, w, h) {
  try {
    const samples = [
      [Math.floor(sx + w / 2), Math.floor(sy + h / 2)],
      [sx, sy],
      [sx + w - 1, sy],
      [sx, sy + h - 1],
      [sx + w - 1, sy + h - 1],
    ];
    for (const [x, y] of samples) {
      const data = ctx.getImageData(x, y, 1, 1).data;
      if (data[0] < 250 || data[1] < 250 || data[2] < 250) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// 「ほぼ黒で塗りつぶされている」かを 5 点サンプリングで判定。
// 黒い大型背景レイヤー (ノドの黒塗り、効果線、暗背景等) が
// collectVisibleNonTextLayers で visibleCanvas に混入したとき、
// 上書きすると元 psd.canvas の絵柄が黒で潰される事故を防ぐ。
// 全 5 点が RGB <= 20 (= ほぼ純黒) のときだけ true。通常の絵柄に
// 含まれる黒線・黒ベタは局所的なので、5 点全部が黒になることは稀。
function isRectMostlyBlack(ctx, sx, sy, w, h) {
  try {
    const samples = [
      [Math.floor(sx + w / 2), Math.floor(sy + h / 2)],
      [sx, sy],
      [sx + w - 1, sy],
      [sx, sy + h - 1],
      [sx + w - 1, sy + h - 1],
    ];
    for (const [x, y] of samples) {
      const data = ctx.getImageData(x, y, 1, 1).data;
      if (data[0] > 20 || data[1] > 20 || data[2] > 20) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// 【v1.26.0 移植 (PsDesign-main v1.24.0) 案G】ハイブリッド方式:
//   1) psd.canvas をベースに描画 (現状の見た目を完全維持)
//   2) 非表示レイヤーの bbox 範囲だけ、可視非テキストレイヤーで再合成した画像で上書き
//   → 非表示テキストの焼き込みだけが「絵柄に置き換わる」、その他は psd.canvas のまま
//
// 旧 maskHiddenLayersOnComposite (案 A: 白フィル) は frameFX (白フチ) が残るケースが
// あったため、案 G に置換。ベースに psd.canvas を使うため、再合成画像が不完全でも
// 全体が真っ白くなることはない。再合成画像が空 (白) なら非表示部分だけが白になる
// (= 案 B/D の矩形 fill 相当に degrade)。
async function rebuildCanvasMaskingHidden(psd) {
  try {
    if (!psd || !psd.width || !psd.height) return null;
    // (2) 非表示レイヤーを集める
    const hiddenList = [];
    if (Array.isArray(psd.children)) {
      for (const child of psd.children) {
        collectHiddenLayersForMasking(child, true, hiddenList);
      }
    }
    if (hiddenList.length === 0) {
      return psd.canvas ? null : createBlankCanvas(psd.width, psd.height);
    }

    await waitForNextFrame();

    const canvas = document.createElement("canvas");
    canvas.width = psd.width;
    canvas.height = psd.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    // (1) ベース: psd.canvas をそのまま描画 (= 元の見た目)
    if (psd.canvas) {
      ctx.drawImage(psd.canvas, 0, 0);
    } else {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, psd.width, psd.height);
    }

    // (3) 可視非テキストレイヤーで「絵柄背景」用の合成画像を作る
    await waitForNextFrame();

    const visibleCanvas = document.createElement("canvas");
    visibleCanvas.width = psd.width;
    visibleCanvas.height = psd.height;
    const vctx = visibleCanvas.getContext("2d");
    if (!vctx) return canvas;
    vctx.fillStyle = "#ffffff";
    vctx.fillRect(0, 0, psd.width, psd.height);
    const visibleLayers = [];
    if (Array.isArray(psd.children)) {
      for (const child of psd.children) {
        collectVisibleNonTextLayers(child, true, visibleLayers);
      }
    }
    // 描画順は「下から上」なので reverse
    let yieldStartedAt = nowMs();
    const visibleDrawOrder = visibleLayers.reverse();
    for (let i = 0; i < visibleDrawOrder.length; i++) {
      const layer = visibleDrawOrder[i];
      const lc = layer.canvas;
      if (!lc || lc.width === 0 || lc.height === 0) continue;
      const op = (typeof layer.opacity === "number") ? layer.opacity / 255 : 1;
      vctx.globalAlpha = Math.max(0, Math.min(1, op));
      vctx.drawImage(lc, layer.left ?? 0, layer.top ?? 0);
      if ((i + 1) % 6 === 0) {
        yieldStartedAt = await yieldIfNeeded(yieldStartedAt);
      }
    }
    vctx.globalAlpha = 1;

    await waitForNextFrame();

    // (4) 非表示レイヤーの bbox 範囲 + DILATE 余白だけ、visibleCanvas から切り出して上書き。
    // DILATE は frameFX (白フチ) サイズ (layer.strokePx) を加味して per-layer に決める。
    // 例: stroke 0 → DILATE 4 / stroke 20 → DILATE 24 / stroke 50 → DILATE 54
    //
    // 【ガード】visibleCanvas の該当矩形が「ほぼ白」(= 元 PSD で線画/背景レイヤーの canvas が
    // 取得できなかった) なら上書きを skip して psd.canvas を残す。これで「テキスト位置が
    // ぽっかり白くなる」事故を防ぐ (元の見た目維持にフォールバック)。
    const psdW = psd.width;
    const psdH = psd.height;
    let skippedAll = 0;
    let skippedBlack = 0;
    let drawnAll = 0;
    yieldStartedAt = nowMs();
    for (let i = 0; i < hiddenList.length; i++) {
      const item = hiddenList[i];
      const lc = item.canvas;
      if (!lc || lc.width === 0 || lc.height === 0) {
        if ((i + 1) % 4 === 0) yieldStartedAt = await yieldIfNeeded(yieldStartedAt);
        continue;
      }
      const strokePx = Number.isFinite(item.strokePx) && item.strokePx > 0 ? item.strokePx : 0;
      const DILATE = Math.ceil(strokePx) + 4;
      const left0 = (item.left ?? 0) - DILATE;
      const top0 = (item.top ?? 0) - DILATE;
      const right0 = (item.left ?? 0) + lc.width + DILATE;
      const bottom0 = (item.top ?? 0) + lc.height + DILATE;
      const sx = Math.max(0, Math.floor(left0));
      const sy = Math.max(0, Math.floor(top0));
      const ex = Math.min(psdW, Math.ceil(right0));
      const ey = Math.min(psdH, Math.ceil(bottom0));
      const w = ex - sx;
      const h = ey - sy;
      if (w <= 0 || h <= 0) {
        if ((i + 1) % 4 === 0) yieldStartedAt = await yieldIfNeeded(yieldStartedAt);
        continue;
      }

      // visibleCanvas の該当矩形が一様白かを 5 点サンプリング (4 隅 + 中央) で判定
      if (isRectMostlyWhite(vctx, sx, sy, w, h)) {
        skippedAll++;
        if ((i + 1) % 4 === 0) yieldStartedAt = await yieldIfNeeded(yieldStartedAt);
        continue; // 絵柄が無い → 上書きしない (psd.canvas のまま残す)
      }
      // visibleCanvas の該当矩形が一様黒かを 5 点サンプリングで判定。
      // 真っ黒で上書きすると元 psd.canvas の絵柄を黒く塗り潰してしまうので、
      // この場合も上書きを skip して psd.canvas のままにする。
      if (isRectMostlyBlack(vctx, sx, sy, w, h)) {
        skippedBlack++;
        if ((i + 1) % 4 === 0) yieldStartedAt = await yieldIfNeeded(yieldStartedAt);
        continue;
      }
      ctx.drawImage(visibleCanvas, sx, sy, w, h, sx, sy, w, h);
      drawnAll++;
      if ((i + 1) % 4 === 0) {
        yieldStartedAt = await yieldIfNeeded(yieldStartedAt);
      }
    }
    if (skippedAll > 0 || skippedBlack > 0) {
      console.info(`[psd-loader] mask skip: 白 ${skippedAll}件 / 黒 ${skippedBlack}件 上書き回避 / ${drawnAll}件 上書き`);
    }
    return canvas;
  } catch (e) {
    console.warn("rebuildCanvasMaskingHidden failed:", e);
    return null;
  }
}

// 【写植再利用】「テキストを消した絵」を作る。
// この種の PSD（OPUS 保存物など）は個別レイヤーの canvas が空で、絵柄は psd.canvas
// (合成画像) にしか無いことが多い。そこで psd.canvas をベースに、各テキストレイヤーの
// 「グリフ形状」をマスクにして文字部分だけを白で塗って消す。矩形ではなくグリフ形状で
// 消すので、吹き出しの外（暗い絵柄）に白い矩形ハローが残らない。
// 吹き出し内文字 → 既に白地なので白で消して自然。吹き出し外文字（白フチ等）→ グリフ
// 形状ぶんだけ白くなるが、その上に再作成した編集テキストが重なるので実用上問題ない。
// テキストレイヤーの canvas が取得できない場合のみ矩形白塗りに退避。
async function buildTextRemovedCanvas(psd) {
  try {
    if (!psd || !psd.width || !psd.height) return null;
    const textList = [];
    if (Array.isArray(psd.children)) {
      for (const child of psd.children) collectVisibleTextLayersForMasking(child, true, textList);
    }
    if (textList.length === 0) {
      // テキストが無い → 元 canvas をそのまま使う (null を返すと呼出側が psd.canvas を採用)
      return null;
    }

    await waitForNextFrame();
    const canvas = document.createElement("canvas");
    canvas.width = psd.width;
    canvas.height = psd.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    if (psd.canvas) {
      ctx.drawImage(psd.canvas, 0, 0);
    } else {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, psd.width, psd.height);
    }

    const psdW = psd.width;
    const psdH = psd.height;
    let yieldStartedAt = nowMs();
    for (let i = 0; i < textList.length; i++) {
      const item = textList[i];
      const strokePx = Number.isFinite(item.strokePx) && item.strokePx > 0 ? item.strokePx : 0;
      const lc = item.canvas;
      if (lc && lc.width > 0 && lc.height > 0) {
        // グリフ形状マスク: テキストレイヤー canvas のアルファを使い、文字＋フチ＋AA ぶんを
        // 膨張させた「白いグリフ」を作って psd.canvas 上の文字へ重ねて消す。
        const pad = Math.ceil(strokePx) + 6;
        const mw = lc.width + pad * 2;
        const mh = lc.height + pad * 2;
        const mask = document.createElement("canvas");
        mask.width = mw;
        mask.height = mh;
        const mc = mask.getContext("2d");
        if (mc) {
          // pad ぶん全方向に少しずつずらして描画 → グリフを膨張（フチ／AA の取りこぼし防止）。
          const step = Math.max(1, Math.round(pad / 2));
          for (let dx = -pad; dx <= pad; dx += step) {
            for (let dy = -pad; dy <= pad; dy += step) {
              mc.drawImage(lc, pad + dx, pad + dy);
            }
          }
          // グリフのアルファ形状を白で塗りつぶす（source-in で形状を保ったまま色を白に）。
          mc.globalCompositeOperation = "source-in";
          mc.fillStyle = "#ffffff";
          mc.fillRect(0, 0, mw, mh);
          mc.globalCompositeOperation = "source-over";
          ctx.drawImage(mask, (item.left ?? 0) - pad, (item.top ?? 0) - pad);
        }
      } else {
        // canvas 無し → 矩形白塗りに退避（稀）。
        const DILATE = Math.ceil(strokePx) + 4;
        const sx = Math.max(0, Math.floor((item.left ?? 0) - DILATE));
        const sy = Math.max(0, Math.floor((item.top ?? 0) - DILATE));
        const ex = Math.min(psdW, Math.ceil((item.left ?? 0) + item.width + DILATE));
        const ey = Math.min(psdH, Math.ceil((item.top ?? 0) + item.height + DILATE));
        if (ex > sx && ey > sy) {
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(sx, sy, ex - sx, ey - sy);
        }
      }
      if ((i + 1) % 2 === 0) yieldStartedAt = await yieldIfNeeded(yieldStartedAt);
    }
    return canvas;
  } catch (e) {
    console.warn("buildTextRemovedCanvas failed:", e);
    return null;
  }
}

// JPG ファイルを読み込んで指定サイズの canvas に描画する。
async function jpgFileToCanvas(imgPath, width, height) {
  const bytes = await readFileBytes(imgPath);
  const bitmap = await createImageBitmap(new Blob([bytes]));
  const w = width > 0 ? width : bitmap.width;
  const h = height > 0 ? height : bitmap.height;
  const scale = getPreviewScaleForSize(w, h);
  const size = scaledSize(w, h, scale);
  const canvas = createBlankCanvas(size.width, size.height);
  const ctx = canvas.getContext("2d");
  if (ctx) ctx.drawImage(bitmap, 0, 0, size.width, size.height);
  try { bitmap.close?.(); } catch (_) {}
  return canvas;
}

// 【写植再利用】PSD を「再利用」用に読み込む。
// まず Photoshop に PSD を開かせ、(a) 全テキストレイヤーの実内容/フォント/サイズ/座標、
// (b) 見本（テキスト入り合成画像 JPG）、(c) 原稿（テキスト非表示の合成画像 JPG）を取得する。
// ag-psd は CSP 由来等の PSD のライブテキストを解析できない（TySh 1 バイトずれ）ため、
// Photoshop に直接読ませるのが確実。Photoshop が使えない/失敗した場合は ag-psd による
// 抽出にフォールバックする（OPUS 保存物などライブテキストが読める PSD 向け）。
//
// 返り値:
//   canvas               : テキストを消した絵柄 (編集ペイン表示用 = page.canvas)
//   textLayers           : [] (既存レイヤーオーバーレイは出さない)
//   reuseReferenceCanvas : 元テキスト入りの合成画像 (見本ペイン + JPG 用)
//   reusePsTextItems     : Photoshop が読んだ実テキスト [{contents,font,sizePt,left,top,
//                          right,bottom,direction,name,visible}] （優先して新規レイヤー化）
//   reuseTextLayers      : ag-psd 抽出テキスト（フォールバック時のみ）
//   reuseTextLayerIds    : ag-psd 抽出の元レイヤー id（フォールバック時のみ）

// Photoshop が書き出した per-page データ（{docWidth,docHeight,dpi,refImage,bgImage,textLayers}）
// から再利用ページオブジェクトを構築する。単一読み取り（loadPsdForReuse）と一括読み取り
// （read_psd_text_layers_batch）の両方から共有する。データ不足なら null を返す。
export async function buildReusePageFromPsData(path, psData) {
  if (!psData) return null;
  const width = Math.round(Number(psData.docWidth) || 0);
  const height = Math.round(Number(psData.docHeight) || 0);
  const dpi = Number(psData.dpi) || 72;
  if (!(width > 0 && height > 0 && psData.refImage && psData.bgImage)) return null;
  const reuseReferenceCanvas = await jpgFileToCanvas(psData.refImage, width, height);
  const editCanvas = await jpgFileToCanvas(psData.bgImage, width, height);
  const previewScale = getPreviewScaleForSize(width, height);
  return withPreviewMetadata({
    path,
    width,
    height,
    dpi,
    canvas: editCanvas,
    textLayers: [],
    reuseReferenceCanvas,
    reuseReferenceImagePath: psData.refImage || null,
    reusePsTextItems: Array.isArray(psData.textLayers) ? psData.textLayers : [],
    // テキスト非表示の背景 JPG パス（自動白フチ / 中丸ゴシック判定の周辺解析に使う）。
    reuseBgImagePath: psData.bgImage || null,
    reuseTextLayers: [],
    reuseTextLayerIds: [],
  }, previewScale);
}

export async function loadPsdForReuse(path) {
  // --- 第一経路: Photoshop で読む ---
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const json = await invoke("read_psd_text_layers", { psdPath: path });
    const psData = JSON.parse(json);
    const page = await buildReusePageFromPsData(path, psData);
    if (page) return await mergeReuseStrokeHintsFromAgPsd(page, path);
    console.warn("[reuse] Photoshop read returned incomplete data, falling back to ag-psd", psData);
  } catch (e) {
    console.warn("[reuse] Photoshop text read failed, falling back to ag-psd:", e);
  }

  // --- フォールバック: ag-psd（ライブテキストが解析できる PSD 向け） ---
  const bytes = await readFileBytes(path);
  await waitForNextFrame();
  const hints = psdParseHints(bytes);
  const forceLightLayerParse = shouldForceLightLayerParse(hints);
  const preserveLayerImages = !forceLightLayerParse
    && (!isLowMemoryMode() || shouldPreserveLayerImagesForLowMemory(bytes));
  const skipLayerImageData = forceLightLayerParse || (isLowMemoryMode() && !preserveLayerImages);
  if (forceLightLayerParse) {
    console.info(`[psd-loader] many-layer reuse fallback: skip layer image data | path=${path} | layers=${hints.layerCount}`);
  }
  const psd = readPsd(bytes, {
    skipLayerImageData,
    skipLinkedFilesData: isLowMemoryMode() || forceLightLayerParse,
    skipThumbnail: true,
    useImageData: false,
  });
  await waitForNextFrame();
  if (isBitmapPsd(psd)) {
    throw new UnsupportedBitmapPsdError(path);
  }

  const textLayers = [];
  const visibleTextItems = [];
  if (Array.isArray(psd.children)) {
    for (const child of psd.children) collectTextLayers(child, textLayers, true);
    for (const child of psd.children) collectVisibleTextLayersForMasking(child, true, visibleTextItems);
  }
  const reuseTextLayerIds = visibleTextItems
    .map((it) => it.id)
    .filter((id) => typeof id === "number");
  const dpi = psd.imageResources?.resolutionInfo?.horizontalResolution ?? 72;

  const reuseReferenceCanvas = createBlankCanvas(psd.width, psd.height);
  if (psd.canvas) {
    const rctx = reuseReferenceCanvas.getContext("2d");
    if (rctx) rctx.drawImage(psd.canvas, 0, 0);
  }

  let editCanvas = await buildTextRemovedCanvas(psd);
  if (!editCanvas) {
    editCanvas = createBlankCanvas(psd.width, psd.height);
    if (psd.canvas) {
      const ectx = editCanvas.getContext("2d");
      if (ectx) ectx.drawImage(psd.canvas, 0, 0);
    }
  }
  if (editCanvas.width !== psd.width || editCanvas.height !== psd.height) {
    editCanvas = createBlankCanvas(psd.width, psd.height);
  }

  const preview = createFinalPageCanvas(editCanvas, psd.width, psd.height);
  const referencePreview = createFinalPageCanvas(reuseReferenceCanvas, psd.width, psd.height);
  return withPreviewMetadata({
    path,
    width: psd.width,
    height: psd.height,
    canvas: preview.canvas,
    textLayers: [],
    dpi,
    reuseReferenceCanvas: referencePreview.canvas,
    reuseReferenceImagePath: null,
    reusePsTextItems: null,
    reuseTextLayers: textLayers,
    reuseTextLayerIds,
  }, preview.previewScale);
}

export async function loadPsdFromPath(path) {
  const bytes = await readFileBytes(path);
  const hints = psdParseHints(bytes);
  const forceLightLayerParse = shouldForceLightLayerParse(hints);
  if (forceLightLayerParse) {
    console.info(`[psd-loader] many-layer PSD: using light layer parse | path=${path} | layers=${hints.layerCount}`);
  }
  if (canUsePsdParseWorker()) {
    try {
      const parsed = await parsePsdWithWorker(bytes, hints);
      let canvas = imageBitmapToCanvas(parsed.bitmap);
      let previewScale = Number.isFinite(parsed.previewScale) && parsed.previewScale > 0
        ? parsed.previewScale
        : getPreviewScaleForSize(parsed.width, parsed.height);
      // canvas のサイズが PSD 寸法と不整合なら異常 (描画が PSD 領域外に出る or 中央に縮小描画されてしまう)。
      // 仕上がりチェック / メインステージで page.canvas をフル領域に drawImage するため、不整合だと
      // ページが完全に崩れる。空白 canvas へフォールバックすれば最低限テキスト overlay は読める。
      if (canvas && !canvasMatchesPreviewSize(canvas, parsed.width, parsed.height, previewScale)) {
        const expected = expectedPreviewSize(parsed.width, parsed.height, previewScale);
        console.warn(
          `[psd-loader] worker canvas size mismatch | path=${path} | `
          + `canvas=${canvas.width}x${canvas.height} expected=${expected.width}x${expected.height}`,
        );
        const fallback = createFinalPageCanvas(null, parsed.width, parsed.height);
        canvas = fallback.canvas;
        previewScale = fallback.previewScale;
      }
      if (canvas) {
        const psdDiagnostics = {
          ...parsed.diagnostics,
          path,
          parseMode: parsed.diagnostics?.parseMode ?? "worker",
          manyLayerThreshold: MANY_LAYER_LIGHT_PARSE_THRESHOLD,
          estimatedLayerCount: Number.isFinite(parsed.diagnostics?.estimatedLayerCount)
            ? parsed.diagnostics.estimatedLayerCount
            : (Number.isFinite(hints.layerCount) ? hints.layerCount : null),
        };
        canvas = await replaceDarkPreviewWithPhotoshopIfNeeded(canvas, {
          path,
          width: parsed.width,
          height: parsed.height,
          dpi: parsed.dpi ?? 72,
          colorMode: parsed.colorMode,
          bitsPerChannel: parsed.bitsPerChannel,
          channels: parsed.channels,
          source: "worker",
          finalCanvasSource: parsed.finalCanvasSource ?? null,
        });
        previewScale = pageCanvasScale(canvas, parsed.width, parsed.height);
        psdDiagnostics.previewScale = previewScale;
        let page = withPreviewMetadata({
          path,
          width: parsed.width,
          height: parsed.height,
          canvas,
          textLayers: parsed.textLayers ?? [],
          dpi: parsed.dpi ?? 72,
          psdGuides: parsed.guides ?? { h: [], v: [] },
          psdDiagnostics,
        }, previewScale);
        page = await applyPhotoshopTextMetadataFallback(page, psdDiagnostics);
        logParseDiagnostics(page.psdDiagnostics);
        return page;
      }
    } catch (error) {
      if (error?.code === "UNSUPPORTED_BITMAP_PSD") {
        throw new UnsupportedBitmapPsdError(path);
      }
      console.warn("PSD worker parse failed, falling back to main thread:", error);
    }
  }

  await waitForNextFrame();

  const preserveLayerImages = !forceLightLayerParse
    && (!isLowMemoryMode() || shouldPreserveLayerImagesForLowMemory(bytes));
  const skipLayerImageData = forceLightLayerParse || (isLowMemoryMode() && !preserveLayerImages);
  const psd = readPsd(bytes, {
    skipLayerImageData,
    skipLinkedFilesData: isLowMemoryMode() || forceLightLayerParse,
    skipThumbnail: true,
    useImageData: false,
  });
  await waitForNextFrame();
  if (isBitmapPsd(psd)) {
    throw new UnsupportedBitmapPsdError(path);
  }
  const textLayers = [];
  let layerDiagnostics = {
    parsedLayerCount: 0,
    textLayerCount: 0,
    visibleTextLayerCount: 0,
    hiddenTextLayerCount: 0,
  };
  if (Array.isArray(psd.children)) {
    for (const child of psd.children) {
      collectTextLayers(child, textLayers, true);
      collectLayerDiagnostics(child, layerDiagnostics, true);
    }
  }
  const dpi = psd.imageResources?.resolutionInfo?.horizontalResolution ?? 72;

  // 【v1.26.0 移植 (PsDesign-main v1.24.0) 案G】
  // 非表示レイヤー (テキスト含む) の焼き込みを「実際の絵柄」で上書き。
  // psd.canvas をベースにしつつ、非表示テキスト位置だけ可視レイヤー再合成画像で
  // 置き換えるので、現状の見た目を維持しつつ非表示テキストの焼き付きが消える。
  // 旧 maskHiddenLayersOnComposite (案 A 白フィル) は frameFX 白フチが残る欠点があった。
  let canvas = psd.canvas;
  let finalCanvasSource = psd.canvas ? "composite" : "blank";
  if (Array.isArray(psd.children) && !skipLayerImageData) {
    const rebuilt = await rebuildCanvasMaskingHidden(psd);
    if (rebuilt) {
      canvas = rebuilt;
      finalCanvasSource = "mask-rebuild";
      console.info(`[psd-loader] canvas 部分再合成 OK | path=${path}`);
    }
  }

  // canvas のサイズが PSD 寸法と不整合なら異常 → 空白 canvas にフォールバック。
  // 仕上がりチェック / メインステージで page.canvas をフル領域に drawImage するため、
  // 不整合だと「縮小描画されて中央の小さな矩形」のような壊れた見え方になる。
  if (canvas && (canvas.width !== psd.width || canvas.height !== psd.height)) {
    console.warn(
      `[psd-loader] main thread canvas size mismatch | path=${path} | `
      + `canvas=${canvas.width}x${canvas.height} expected=${psd.width}x${psd.height}`,
    );
    canvas = createBlankCanvas(psd.width, psd.height);
    finalCanvasSource = "blank-size-mismatch";
  }
  canvas = await replaceDarkPreviewWithPhotoshopIfNeeded(canvas, {
    path,
    width: psd.width,
    height: psd.height,
    dpi,
    colorMode: psd.colorMode,
    bitsPerChannel: psd.bitsPerChannel,
    channels: psd.channels,
    source: "main",
    finalCanvasSource,
  });

  const preview = createFinalPageCanvas(canvas, psd.width, psd.height);
  const psdDiagnostics = buildParseDiagnostics({
    path,
    hints,
    stats: layerDiagnostics,
    parseMode: "main",
    forceLightLayerParse,
    skipLayerImageData,
    preserveLayerImages,
    finalCanvasSource,
    previewScale: preview.previewScale,
  });
  let page = withPreviewMetadata({
    path,
    width: psd.width,
    height: psd.height,
    canvas: preview.canvas,
    textLayers,
    dpi,
    psdGuides: extractPsdGuides(psd),
    psdDiagnostics,
  }, preview.previewScale);
  page = await applyPhotoshopTextMetadataFallback(page, psdDiagnostics);
  logParseDiagnostics(page.psdDiagnostics);
  return page;
}

async function readFileBytes(path) {
  const { invoke } = await import("@tauri-apps/api/core");
  const bytes = await invoke("read_binary_file", { path });
  return new Uint8Array(bytes);
}
