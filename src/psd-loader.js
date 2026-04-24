import { readPsd } from "ag-psd";

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
  // 白/黒 に分類できない色は保存時に壊さないよう "none" ではなく一旦読むが、
  // UI トグルは白/黒/なししかないので "none" フォールバックが安全。
  return "none";
}

function extractStroke(layer) {
  const effects = layer.effects ?? null;
  if (!effects) return { strokeColor: "none", strokeWidthPx: 2 };
  const fx = pickActiveStrokeFx(effects.stroke);
  if (!fx) return { strokeColor: "none", strokeWidthPx: 2 };
  const strokeColor = readStrokeColor(fx);
  if (strokeColor === "none") return { strokeColor: "none", strokeWidthPx: 2 };
  const sz = readStrokeSizePx(fx);
  const strokeWidthPx = typeof sz === "number" && sz > 0 ? sz : 2;
  return { strokeColor, strokeWidthPx };
}

function collectTextLayers(layer, out = []) {
  if (layer.text && typeof layer.id === "number") {
    const style = layer.text.style ?? {};
    const orientation = layer.text.orientation;
    const { strokeColor, strokeWidthPx } = extractStroke(layer);
    out.push({
      id: layer.id,
      name: layer.name ?? "",
      text: layer.text.text ?? "",
      font: style.font?.name ?? "",
      fontSize: style.fontSize ?? null,
      left: layer.left ?? 0,
      top: layer.top ?? 0,
      right: layer.right ?? 0,
      bottom: layer.bottom ?? 0,
      direction: orientation === "vertical" ? "vertical" : "horizontal",
      strokeColor,
      strokeWidthPx,
    });
  }
  if (Array.isArray(layer.children)) {
    for (const child of layer.children) collectTextLayers(child, out);
  }
  return out;
}

export async function loadPsdFromPath(path) {
  const bytes = await readFileBytes(path);
  const psd = readPsd(bytes, {
    skipLayerImageData: false,
    skipThumbnail: true,
    useImageData: false,
  });
  const textLayers = [];
  if (Array.isArray(psd.children)) {
    for (const child of psd.children) collectTextLayers(child, textLayers);
  }
  const dpi = psd.imageResources?.resolutionInfo?.horizontalResolution ?? 72;
  return {
    path,
    width: psd.width,
    height: psd.height,
    canvas: psd.canvas,
    textLayers,
    dpi,
  };
}

async function readFileBytes(path) {
  const { invoke } = await import("@tauri-apps/api/core");
  const bytes = await invoke("read_binary_file", { path });
  return new Uint8Array(bytes);
}
