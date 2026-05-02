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

// 塗り色は ag-psd の layer.text.style.fillColor に入る。保存時期/バージョンで
// {r,g,b} / {red,green,blue} / [r,g,b] / #rrggbb の揺れがあるため吸収。
// 白黒に分類できない色は "default"（= 元の色を保持、書き戻し時に触らない）。
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
  if (r > 240 && g > 240 && b > 240) return "white";
  if (r < 15 && g < 15 && b < 15) return "black";
  return "default";
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

// ag-psd の style.fontSize は PSD エンジンが保持している生の font size で、
// 実描画サイズはこれに layer.text.transform 行列の scale が掛かったもの。
// 例：PSD で「100pt のテキストを 0.2 倍に縮小して配置」した場合、
//   style.fontSize = 100、transform = [0.2, 0, 0, 0.2, tx, ty]
// なので実効 pt = 100 × 0.2 = 20pt。
// 行列式 = (a*d - b*c) は scale^2（回転は scale を変えないので det は等価）。
// その平方根 = 等価 uniform scale。漫画写植では基本 uniform scale なのでこの近似で十分。
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

// PSD 上で非表示になっているレイヤー / フォルダ（およびその子孫）は
// 「読み込みから除外したものとして扱う」ため、collectTextLayers では親フォルダ
// の可視性を伝播し、テキストレイヤー本体 or 上位グループのいずれかが非表示
// であればテキスト一覧に含めない。
function collectTextLayers(layer, out = [], parentVisible = true) {
  const effectiveVisible = parentVisible && !layer.hidden;
  if (layer.text && typeof layer.id === "number") {
    if (!effectiveVisible) {
      // 非表示テキストはスキップ（子は持たない想定だがネストにも備えて return しない）
    } else {
      const style = layer.text.style ?? {};
      const orientation = layer.text.orientation;
      const { strokeColor, strokeWidthPx } = extractStroke(layer);
      const fillColor = extractFillColor(layer);
      out.push({
        id: layer.id,
        name: layer.name ?? "",
        text: layer.text.text ?? "",
        font: style.font?.name ?? "",
        fontSize: effectiveFontSize(style.fontSize, layer.text.transform),
        left: layer.left ?? 0,
        top: layer.top ?? 0,
        right: layer.right ?? 0,
        bottom: layer.bottom ?? 0,
        direction: orientation === "vertical" ? "vertical" : "horizontal",
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
  const selfHidden = !!layer.hidden;
  const effectiveVisible = parentVisible && !selfHidden;

  if (
    !effectiveVisible &&
    layer.canvas &&
    layer.canvas.width > 0 &&
    layer.canvas.height > 0
  ) {
    out.push({
      canvas: layer.canvas,
      left: layer.left ?? 0,
      top: layer.top ?? 0,
      name: layer.name,
    });
  }

  // 親が非表示でも子は個別に canvas を持っている可能性があるので必ず再帰する。
  if (Array.isArray(layer.children)) {
    for (const child of layer.children) {
      collectHiddenLayersForMasking(child, effectiveVisible, out);
    }
  }
}

// 各「非表示レイヤー canvas」のアルファをマスクとして、psd.canvas の
// 該当ピクセル（= 実際にそのレイヤーが寄与している形状の画素）だけを
// 白で塗りつぶしたコピーを返す。矩形ではなく「文字の輪郭ぴったり」
// で消すので、レイヤーの裏側にあった絵柄は欠けない。
//
// 仕組み:
//   1) main canvas に psd.canvas をコピー
//   2) レイヤーごとに同サイズの一時 canvas を用意
//   3) 一時 canvas を白で塗る
//   4) globalCompositeOperation = "destination-in" + そのレイヤーの canvas を描画
//      → 一時 canvas は「白×レイヤー alpha」になる（テキスト形状のみ白で残る）
//   5) 一時 canvas を main canvas の (left, top) に重ね描画
function maskHiddenLayersOnComposite(psd, hiddenLayers) {
  try {
    const src = psd.canvas;
    if (!src || !src.width || !src.height) return null;
    const canvas = document.createElement("canvas");
    canvas.width = src.width;
    canvas.height = src.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(src, 0, 0);

    for (const item of hiddenLayers) {
      const lc = item.canvas;
      if (!lc || lc.width === 0 || lc.height === 0) continue;

      // レイヤーと同サイズの一時 canvas に「白で塗る → destination-in でレイヤー
      // 形状にクリップ」した画像を作る
      const tmp = document.createElement("canvas");
      tmp.width = lc.width;
      tmp.height = lc.height;
      const tctx = tmp.getContext("2d");
      if (!tctx) continue;
      tctx.fillStyle = "#ffffff";
      tctx.fillRect(0, 0, tmp.width, tmp.height);
      tctx.globalCompositeOperation = "destination-in";
      tctx.drawImage(lc, 0, 0);

      // main canvas の該当位置に重ね描き
      ctx.drawImage(tmp, item.left, item.top);
    }
    return canvas;
  } catch (e) {
    console.warn("maskHiddenLayersOnComposite failed:", e);
    return null;
  }
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
    for (const child of psd.children) collectTextLayers(child, textLayers, true);
  }
  const dpi = psd.imageResources?.resolutionInfo?.horizontalResolution ?? 72;

  // 非表示レイヤー / フォルダが存在するなら、ag-psd の合成済み canvas には
  // 当時の状態（= 表示時の焼き込み）が残っている可能性が高い。
  // 各非表示レイヤー自身の canvas を「形状マスク」として利用し、その輪郭
  // 部分だけを白で塗ることで、裏側の絵柄を保ったままレイヤー本体だけ消す。
  let canvas = psd.canvas;
  if (Array.isArray(psd.children) && canvas) {
    const hiddenLayers = [];
    for (const child of psd.children) {
      collectHiddenLayersForMasking(child, true, hiddenLayers);
    }
    if (hiddenLayers.length > 0) {
      const masked = maskHiddenLayersOnComposite(psd, hiddenLayers);
      if (masked) canvas = masked;
    }
  }

  return {
    path,
    width: psd.width,
    height: psd.height,
    canvas,
    textLayers,
    dpi,
  };
}

async function readFileBytes(path) {
  const { invoke } = await import("@tauri-apps/api/core");
  const bytes = await invoke("read_binary_file", { path });
  return new Uint8Array(bytes);
}
