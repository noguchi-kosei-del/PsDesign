import { initializeCanvas, readPsd } from "ag-psd";

initializeCanvas(
  (width, height) => new OffscreenCanvas(width, height),
  undefined,
  (width, height) => new ImageData(width, height),
);

function isBitmapPsd(psd) {
  return psd?.colorMode === 0;
}

function pickActiveStrokeFx(raw) {
  if (!raw) return null;
  const list = Array.isArray(raw) ? raw : [raw];
  const active = list.find((fx) => fx && (fx.enabled === true || fx.visible === true));
  if (active) return active;
  const anyNotDisabled = list.find((fx) => fx && fx.enabled !== false && fx.visible !== false);
  return anyNotDisabled ?? list[0] ?? null;
}

function readStrokeSizePx(fx) {
  if (!fx) return null;
  const raw = fx.size;
  if (raw == null) return null;
  if (typeof raw === "number") return raw > 0 ? raw : null;
  if (typeof raw === "object") {
    const units = (raw.units ?? raw.unit ?? "").toLowerCase();
    const v = typeof raw.value === "number"
      ? raw.value
      : typeof raw.value === "object"
        ? raw.value?.value
        : null;
    if (typeof v !== "number" || !(v > 0)) return null;
    if (units.indexOf("pt") === 0 || units.indexOf("point") === 0) return v * (96 / 72);
    return v;
  }
  return null;
}

function readStrokeColor(fx) {
  if (!fx || fx.enabled === false || fx.visible === false) return "none";
  const c = fx.color;
  let r = 0, g = 0, b = 0;
  if (Array.isArray(c) && c.length >= 3) {
    [r, g, b] = c;
  } else if (c && typeof c === "object") {
    r = c.r ?? c.red ?? 0;
    g = c.g ?? c.green ?? 0;
    b = c.b ?? c.blue ?? 0;
  } else if (typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c)) {
    r = parseInt(c.slice(1, 3), 16);
    g = parseInt(c.slice(3, 5), 16);
    b = parseInt(c.slice(5, 7), 16);
  } else {
    return "none";
  }
  if (r > 240 && g > 240 && b > 240) return "white";
  if (r < 15 && g < 15 && b < 15) return "black";
  return "none";
}

function extractFillColor(layer) {
  const c = layer?.text?.style?.fillColor;
  if (!c) return "default";
  let r = 0, g = 0, b = 0;
  if (Array.isArray(c) && c.length >= 3) {
    [r, g, b] = c;
  } else if (typeof c === "object") {
    r = c.r ?? c.red ?? 0;
    g = c.g ?? c.green ?? 0;
    b = c.b ?? c.blue ?? 0;
  } else if (typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c)) {
    r = parseInt(c.slice(1, 3), 16);
    g = parseInt(c.slice(3, 5), 16);
    b = parseInt(c.slice(5, 7), 16);
  } else {
    return "default";
  }
  r = Math.max(0, Math.min(255, Math.round(Number(r) || 0)));
  g = Math.max(0, Math.min(255, Math.round(Number(g) || 0)));
  b = Math.max(0, Math.min(255, Math.round(Number(b) || 0)));
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
  if (strokeColor === "none") return { strokeColor: "none", strokeWidthPx: 20 };
  const sz = readStrokeSizePx(fx);
  const strokeWidthPx = typeof sz === "number" && sz > 0 ? sz : 20;
  return { strokeColor, strokeWidthPx };
}

function effectiveFontSize(rawFontSize, transform) {
  if (!Number.isFinite(rawFontSize) || rawFontSize <= 0) return rawFontSize ?? null;
  if (!Array.isArray(transform) || transform.length < 4) return rawFontSize;
  const [a, b, c, d] = transform;
  const det = Math.abs(a * d - b * c);
  if (!Number.isFinite(det) || det <= 0) return rawFontSize;
  const scale = Math.sqrt(det);
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

function isLayerHidden(layer) {
  return !!layer.hidden || layer.visible === false;
}

function collectTextLayers(layer, out = [], parentVisible = true) {
  const effectiveVisible = parentVisible && !isLayerHidden(layer);
  if (layer.text && typeof layer.id === "number" && effectiveVisible) {
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
  if (Array.isArray(layer.children)) {
    for (const child of layer.children) {
      collectTextLayers(child, out, effectiveVisible);
    }
  }
  return out;
}

function collectHiddenLayersForMasking(layer, parentVisible, out) {
  const selfHidden = isLayerHidden(layer);
  const effectiveVisible = parentVisible && !selfHidden;
  if (!effectiveVisible && layer.canvas && layer.canvas.width > 0 && layer.canvas.height > 0) {
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
  if (Array.isArray(layer.children)) {
    for (const child of layer.children) {
      collectHiddenLayersForMasking(child, effectiveVisible, out);
    }
  }
}

function collectVisibleNonTextLayers(layer, parentVisible, out) {
  const selfHidden = isLayerHidden(layer);
  const effectiveVisible = parentVisible && !selfHidden;
  if (layer.text) {
    if (Array.isArray(layer.children)) {
      for (const child of layer.children) {
        collectVisibleNonTextLayers(child, effectiveVisible, out);
      }
    }
    return;
  }
  const isFolder = Array.isArray(layer.children);
  if (!isFolder && effectiveVisible && layer.canvas && layer.canvas.width > 0 && layer.canvas.height > 0) {
    out.push(layer);
    return;
  }
  if (isFolder) {
    for (const child of layer.children) {
      collectVisibleNonTextLayers(child, effectiveVisible, out);
    }
  }
}

function createBlankCanvas(width, height) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  return canvas;
}

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

function rebuildCanvasMaskingHidden(psd) {
  if (!psd || !psd.width || !psd.height) return null;
  const hiddenList = [];
  if (Array.isArray(psd.children)) {
    for (const child of psd.children) {
      collectHiddenLayersForMasking(child, true, hiddenList);
    }
  }
  if (hiddenList.length === 0) {
    return psd.canvas ?? createBlankCanvas(psd.width, psd.height);
  }

  const canvas = new OffscreenCanvas(psd.width, psd.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return psd.canvas ?? null;
  if (psd.canvas) {
    ctx.drawImage(psd.canvas, 0, 0);
  } else {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, psd.width, psd.height);
  }

  const visibleCanvas = new OffscreenCanvas(psd.width, psd.height);
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
  for (const layer of visibleLayers.reverse()) {
    const lc = layer.canvas;
    if (!lc || lc.width === 0 || lc.height === 0) continue;
    const op = typeof layer.opacity === "number" ? layer.opacity / 255 : 1;
    vctx.globalAlpha = Math.max(0, Math.min(1, op));
    vctx.drawImage(lc, layer.left ?? 0, layer.top ?? 0);
  }
  vctx.globalAlpha = 1;

  const psdW = psd.width;
  const psdH = psd.height;
  for (const item of hiddenList) {
    const lc = item.canvas;
    if (!lc || lc.width === 0 || lc.height === 0) continue;
    const strokePx = Number.isFinite(item.strokePx) && item.strokePx > 0 ? item.strokePx : 0;
    const dilate = Math.ceil(strokePx) + 4;
    const sx = Math.max(0, Math.floor((item.left ?? 0) - dilate));
    const sy = Math.max(0, Math.floor((item.top ?? 0) - dilate));
    const ex = Math.min(psdW, Math.ceil((item.left ?? 0) + lc.width + dilate));
    const ey = Math.min(psdH, Math.ceil((item.top ?? 0) + lc.height + dilate));
    const w = ex - sx;
    const h = ey - sy;
    if (w <= 0 || h <= 0) continue;
    if (isRectMostlyWhite(vctx, sx, sy, w, h)) continue;
    ctx.drawImage(visibleCanvas, sx, sy, w, h, sx, sy, w, h);
  }
  return canvas;
}

function parsePsd(buffer) {
  const psd = readPsd(buffer, {
    skipLayerImageData: false,
    skipThumbnail: true,
    useImageData: false,
  });
  if (isBitmapPsd(psd)) {
    const error = new Error("Unsupported bitmap PSD");
    error.code = "UNSUPPORTED_BITMAP_PSD";
    throw error;
  }

  const textLayers = [];
  if (Array.isArray(psd.children)) {
    for (const child of psd.children) collectTextLayers(child, textLayers, true);
  }
  const canvas = Array.isArray(psd.children)
    ? rebuildCanvasMaskingHidden(psd)
    : psd.canvas ?? createBlankCanvas(psd.width, psd.height);
  const bitmap = canvas?.transferToImageBitmap ? canvas.transferToImageBitmap() : null;
  return {
    width: psd.width,
    height: psd.height,
    dpi: psd.imageResources?.resolutionInfo?.horizontalResolution ?? 72,
    textLayers,
    bitmap,
  };
}

globalThis.onmessage = (event) => {
  const { id, buffer } = event.data ?? {};
  try {
    const parsed = parsePsd(buffer);
    const transfer = parsed.bitmap ? [parsed.bitmap] : [];
    globalThis.postMessage({ id, ok: true, parsed }, transfer);
  } catch (error) {
    globalThis.postMessage({
      id,
      ok: false,
      error: {
        name: error?.name ?? "Error",
        message: error?.message ?? String(error),
        code: error?.code ?? null,
      },
    });
  }
};
