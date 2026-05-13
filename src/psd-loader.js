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

// 【v1.26.0 移植 (PsDesign-main v1.24.0) 案G】ハイブリッド方式:
//   1) psd.canvas をベースに描画 (現状の見た目を完全維持)
//   2) 非表示レイヤーの bbox 範囲だけ、可視非テキストレイヤーで再合成した画像で上書き
//   → 非表示テキストの焼き込みだけが「絵柄に置き換わる」、その他は psd.canvas のまま
//
// 旧 maskHiddenLayersOnComposite (案 A: 白フィル) は frameFX (白フチ) が残るケースが
// あったため、案 G に置換。ベースに psd.canvas を使うため、再合成画像が不完全でも
// 全体が真っ白くなることはない。再合成画像が空 (白) なら非表示部分だけが白になる
// (= 案 B/D の矩形 fill 相当に degrade)。
function rebuildCanvasMaskingHidden(psd) {
  try {
    if (!psd || !psd.width || !psd.height) return null;
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

    // (2) 非表示レイヤーを集める
    const hiddenList = [];
    if (Array.isArray(psd.children)) {
      for (const child of psd.children) {
        collectHiddenLayersForMasking(child, true, hiddenList);
      }
    }
    if (hiddenList.length === 0) return canvas;

    // (3) 可視非テキストレイヤーで「絵柄背景」用の合成画像を作る
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
    for (const layer of visibleLayers.reverse()) {
      const lc = layer.canvas;
      if (!lc || lc.width === 0 || lc.height === 0) continue;
      const op = (typeof layer.opacity === "number") ? layer.opacity / 255 : 1;
      vctx.globalAlpha = Math.max(0, Math.min(1, op));
      vctx.drawImage(lc, layer.left ?? 0, layer.top ?? 0);
    }
    vctx.globalAlpha = 1;

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
    let drawnAll = 0;
    for (const item of hiddenList) {
      const lc = item.canvas;
      if (!lc || lc.width === 0 || lc.height === 0) continue;
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
      if (w <= 0 || h <= 0) continue;

      // visibleCanvas の該当矩形が一様白かを 5 点サンプリング (4 隅 + 中央) で判定
      if (isRectMostlyWhite(vctx, sx, sy, w, h)) {
        skippedAll++;
        continue; // 絵柄が無い → 上書きしない (psd.canvas のまま残す)
      }
      ctx.drawImage(visibleCanvas, sx, sy, w, h, sx, sy, w, h);
      drawnAll++;
    }
    if (skippedAll > 0) {
      console.info(`[psd-loader] mask skip: visibleCanvas が空のため ${skippedAll}件 上書き回避 / ${drawnAll}件 上書き`);
    }
    return canvas;
  } catch (e) {
    console.warn("rebuildCanvasMaskingHidden failed:", e);
    return null;
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

  // 【v1.26.0 移植 (PsDesign-main v1.24.0) 案G】
  // 非表示レイヤー (テキスト含む) の焼き込みを「実際の絵柄」で上書き。
  // psd.canvas をベースにしつつ、非表示テキスト位置だけ可視レイヤー再合成画像で
  // 置き換えるので、現状の見た目を維持しつつ非表示テキストの焼き付きが消える。
  // 旧 maskHiddenLayersOnComposite (案 A 白フィル) は frameFX 白フチが残る欠点があった。
  let canvas = psd.canvas;
  if (Array.isArray(psd.children)) {
    const rebuilt = rebuildCanvasMaskingHidden(psd);
    if (rebuilt) {
      canvas = rebuilt;
      console.info(`[psd-loader] canvas 部分再合成 OK | path=${path}`);
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
