// 【写植再利用】Photoshop で PSD を開き、全テキストレイヤーの内容・フォント・サイズ・
// 座標・組方向を JSON に書き出し、さらに「テキストレイヤーを全て非表示にした合成画像」を
// JPG で書き出す read-only スクリプトを生成する。ag-psd が CSP 由来等の PSD のライブ
// テキストを解析できない問題を回避するため、Photoshop に直接読ませる。
// PSD 自体は保存しない（doc.close DONOTSAVECHANGES）。
pub fn generate_read_text_layers_script(
    psd_path: &str,
    out_json_path: &str,
    ref_img_path: &str,
    bg_img_path: &str,
    sentinel_path: &str,
) -> String {
    let mut out = String::new();
    out.push_str("#target photoshop\n");
    out.push_str("app.displayDialogs = DialogModes.NO;\n");
    out.push_str("try { app.playbackDisplayDialogs = DialogModes.NO; } catch (e) {}\n");
    out.push_str(
        "try { app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS; } catch (e) {}\n",
    );
    out.push_str(&format!("var PSD_PATH = {};\n", js_string(psd_path)));
    out.push_str(&format!("var OUT_JSON = {};\n", js_string(out_json_path)));
    out.push_str(&format!("var REF_IMG = {};\n", js_string(ref_img_path)));
    out.push_str(&format!("var BG_IMG = {};\n", js_string(bg_img_path)));
    out.push_str(&format!(
        "var SENTINEL_PATH = {};\n",
        js_string(sentinel_path)
    ));
    out.push_str(READ_TEXT_BODY);
    out
}

// 【写植再利用・一括】複数 PSD を 1 回の Photoshop セッションで処理する。
// jobs: [(psd_jsx_path, ref_jpg_jsx_path, bg_jpg_jsx_path)]。
// 出力 OUT_JSON は {"pages":[{ok,psdPath,docWidth,docHeight,dpi,refImage,bgImage,textLayers},...]}。
// 1 枚ごとに Photoshop を起動し直さないので、起動・前面化の繰り返しを避けられる。
pub fn generate_read_text_layers_batch_script(
    jobs: &[(String, String, String)],
    out_json_path: &str,
    sentinel_path: &str,
) -> String {
    let mut out = String::new();
    out.push_str("#target photoshop\n");
    out.push_str("app.displayDialogs = DialogModes.NO;\n");
    out.push_str("try { app.playbackDisplayDialogs = DialogModes.NO; } catch (e) {}\n");
    out.push_str(
        "try { app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS; } catch (e) {}\n",
    );
    out.push_str(&format!("var OUT_JSON = {};\n", js_string(out_json_path)));
    out.push_str(&format!(
        "var SENTINEL_PATH = {};\n",
        js_string(sentinel_path)
    ));
    out.push_str("var JOBS = [\n");
    for (psd, ref_img, bg_img) in jobs {
        out.push_str(&format!(
            "  {{ psd: {}, ref: {}, bg: {} }},\n",
            js_string(psd),
            js_string(ref_img),
            js_string(bg_img)
        ));
    }
    out.push_str("];\n");
    out.push_str(READ_TEXT_BATCH_BODY);
    out
}

pub fn generate_read_text_layer_metadata_script(
    psd_path: &str,
    out_json_path: &str,
    sentinel_path: &str,
) -> String {
    let mut out = String::new();
    out.push_str("#target photoshop\n");
    out.push_str("app.displayDialogs = DialogModes.NO;\n");
    out.push_str("try { app.playbackDisplayDialogs = DialogModes.NO; } catch (e) {}\n");
    out.push_str(
        "try { app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS; } catch (e) {}\n",
    );
    out.push_str(&format!("var PSD_PATH = {};\n", js_string(psd_path)));
    out.push_str(&format!("var OUT_JSON = {};\n", js_string(out_json_path)));
    out.push_str(&format!(
        "var SENTINEL_PATH = {};\n",
        js_string(sentinel_path)
    ));
    out.push_str(READ_TEXT_METADATA_BODY);
    out
}

const READ_TEXT_METADATA_BODY: &str = r####"
function writeSentinel(text) {
  try {
    var f = new File(SENTINEL_PATH);
    f.encoding = "UTF-8";
    f.open("w");
    f.write(text);
    f.close();
  } catch (e) {}
}
function jsonStr(s) {
  if (s === null || s === undefined) return '""';
  s = String(s);
  var out = '"';
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    var code = s.charCodeAt(i);
    if (c === '"') out += '\\"';
    else if (c === '\\') out += '\\\\';
    else if (c === '\n') out += '\\n';
    else if (c === '\r') out += '\\r';
    else if (c === '\t') out += '\\t';
    else if (code < 0x20) {
      var h = code.toString(16);
      while (h.length < 4) h = '0' + h;
      out += '\\u' + h;
    } else { out += c; }
  }
  return out + '"';
}
function jsonNum(n) {
  if (n === null || n === undefined || isNaN(n)) return '0';
  return String(n);
}
function jsonNullableNum(n) {
  if (n === null || n === undefined || isNaN(n)) return 'null';
  return String(n);
}
function jsonBool(b) { return b ? 'true' : 'false'; }
function jsonNumArray(arr) {
  if (!arr || !arr.length) return 'null';
  var out = [];
  for (var i = 0; i < arr.length; i++) out.push(jsonNullableNum(arr[i]));
  return '[' + out.join(',') + ']';
}
function descriptorBool(desc, key) {
  try {
    var id = stringIDToTypeID(key);
    if (!desc.hasKey(id)) return null;
    return desc.getBoolean(id);
  } catch (e) {}
  return null;
}
function descriptorNumberAny(desc, stringKey, charKey) {
  try {
    var id = stringIDToTypeID(stringKey);
    if (desc.hasKey(id)) {
      try { return desc.getDouble(id); } catch (e1) {}
      try { return desc.getUnitDoubleValue(id); } catch (e2) {}
      try { return desc.getInteger(id); } catch (e3) {}
    }
  } catch (e) {}
  if (charKey) {
    try {
      var cid = charIDToTypeID(charKey);
      if (desc.hasKey(cid)) {
        try { return desc.getDouble(cid); } catch (e4) {}
        try { return desc.getUnitDoubleValue(cid); } catch (e5) {}
        try { return desc.getInteger(cid); } catch (e6) {}
      }
    } catch (e7) {}
  }
  return null;
}
function strokeFromFrameFx(fx) {
  if (!fx) return null;
  var enabled = descriptorBool(fx, "enabled");
  var present = descriptorBool(fx, "present");
  if (enabled === false || present === false) return null;
  // 【提案A/B】enabled な境界線効果(frameFX)が存在する時点で「フチあり」と確定する。
  // 色が読めない / 純白・純黒に分類できない場合も null(=none) へ落とさず "present"
  // （色未分類だがフチは存在）を返し、リサイクル側で白フチとして再現する。これで
  // 背景白率ヒューリスティックへの取りこぼし（白吹き出し内の偽陰性）を防ぐ。
  // 白/黒の判定閾値も >240/<15 から >=235/<=20 へ緩め、紙白やわずかに色味のある
  // 白フチも拾う。通常読み込み経路は normalizeExtractedStrokeColor が "present" を
  // "none" に丸めるため影響しない。
  var size = descriptorNumberAny(fx, "size", "Sz  ");
  var strokeWidthPx = (typeof size === "number" && isFinite(size) && size > 0) ? size : 20;
  var colorDesc = null;
  try {
    var colorKey = stringIDToTypeID("color");
    if (fx.hasKey(colorKey)) colorDesc = fx.getObjectValue(colorKey);
  } catch (e) {}
  if (!colorDesc) return { strokeColor: "present", strokeWidthPx: strokeWidthPx };
  var r = descriptorNumberAny(colorDesc, "red", "Rd  ");
  var g = descriptorNumberAny(colorDesc, "green", "Grn ");
  var b = descriptorNumberAny(colorDesc, "blue", "Bl  ");
  if (r === null || g === null || b === null) return { strokeColor: "present", strokeWidthPx: strokeWidthPx };
  if (r <= 1 && g <= 1 && b <= 1 && (r > 0 || g > 0 || b > 0)) {
    r *= 255;
    g *= 255;
    b *= 255;
  }
  r = Math.max(0, Math.min(255, Math.round(Number(r) || 0)));
  g = Math.max(0, Math.min(255, Math.round(Number(g) || 0)));
  b = Math.max(0, Math.min(255, Math.round(Number(b) || 0)));
  var strokeColor = "present";
  if (r >= 235 && g >= 235 && b >= 235) strokeColor = "white";
  else if (r <= 20 && g <= 20 && b <= 20) strokeColor = "black";
  return { strokeColor: strokeColor, strokeWidthPx: strokeWidthPx };
}
function strokeFromLayerEffects(L) {
  try {
    var layerId = layerIdOf(L);
    if (!layerId) return { strokeColor: "none", strokeWidthPx: 20 };
    var ref = new ActionReference();
    ref.putProperty(stringIDToTypeID("property"), stringIDToTypeID("layerEffects"));
    ref.putIdentifier(charIDToTypeID("Lyr "), layerId);
    var desc = executeActionGet(ref);
    var effectsKey = stringIDToTypeID("layerEffects");
    var effects = desc.hasKey(effectsKey) ? desc.getObjectValue(effectsKey) : desc;
    var frameKey = stringIDToTypeID("frameFX");
    if (effects.hasKey(frameKey)) {
      var single = strokeFromFrameFx(effects.getObjectValue(frameKey));
      if (single) return single;
    }
    var multiKey = stringIDToTypeID("frameFXMulti");
    if (effects.hasKey(multiKey)) {
      var list = effects.getList(multiKey);
      for (var i = 0; i < list.count; i++) {
        var item = strokeFromFrameFx(list.getObjectValue(i));
        if (item) return item;
      }
    }
  } catch (e) {}
  return { strokeColor: "none", strokeWidthPx: 20 };
}
// テキストレイヤー自身＋親グループ(LayerSet)を遡って境界線効果(frameFX)を探す。
// OPUS は「白フチ＋ルビ」のレイヤーを保存するとき、テキストレイヤーではなく
// 専用サブグループへ境界線効果を当てる（jsx_gen.rs の applyStrokeEffect(__subGroupNL)）。
// そのため再リサイクル時にテキストレイヤー単体の layerEffects を読むだけでは白フチが
// 取りこぼされ、背景白率ヒューリスティックに落ちてしまう。手動写植でグループに境界線を
// 付けているケースも同様に拾えるよう、自身に効果が無ければ祖先グループへ遡る。
function strokeFromLayerEffectsWithAncestors(L) {
  var own = strokeFromLayerEffects(L);
  if (own && own.strokeColor !== "none") return own;
  try {
    var p = L.parent;
    var guard = 0;
    while (p && guard < 12) {
      var isSet = false;
      try { isSet = (p.typename === "LayerSet"); } catch (eT) { isSet = false; }
      if (!isSet) break;
      var g = strokeFromLayerEffects(p);
      if (g && g.strokeColor !== "none") return g;
      p = p.parent;
      guard++;
    }
  } catch (e) {}
  return own;
}
function fillColorNameFromTextItem(ti) {
  try {
    var c = ti.color;
    var r = c.rgb.red;
    var g = c.rgb.green;
    var b = c.rgb.blue;
    r = Math.max(0, Math.min(255, Math.round(Number(r) || 0)));
    g = Math.max(0, Math.min(255, Math.round(Number(g) || 0)));
    b = Math.max(0, Math.min(255, Math.round(Number(b) || 0)));
    if (r > 240 && g > 240 && b > 240) return "white";
    if (r < 15 && g < 15 && b < 15) return "black";
    function hx(v) {
      var s = v.toString(16);
      return s.length < 2 ? "0" + s : s;
    }
    return "#" + hx(r) + hx(g) + hx(b);
  } catch (e) {
    return "default";
  }
}
function asPx(uv) {
  try { return uv.as("px"); } catch (e) {
    try { return Number(uv); } catch (e2) { return 0; }
  }
}
function layerIdOf(L) {
  try {
    var id = Number(L.id);
    return isNaN(id) ? 0 : id;
  } catch (e) {
    return 0;
  }
}
function descriptorNumber(desc, key) {
  try {
    var id = stringIDToTypeID(key);
    if (!desc.hasKey(id)) return null;
    try { return desc.getDouble(id); } catch (e1) {}
    try { return desc.getUnitDoubleValue(id); } catch (e2) {}
    try { return desc.getInteger(id); } catch (e3) {}
  } catch (e) {}
  return null;
}
function textTransformForLayer(L) {
  try {
    var layerId = layerIdOf(L);
    if (!layerId) return null;
    var ref = new ActionReference();
    ref.putIdentifier(charIDToTypeID("Lyr "), layerId);
    var desc = executeActionGet(ref);
    var textKey = stringIDToTypeID("textKey");
    if (!desc.hasKey(textKey)) return null;
    var textDesc = desc.getObjectValue(textKey);
    var transformKey = stringIDToTypeID("transform");
    if (!textDesc.hasKey(transformKey)) return null;
    var tr = textDesc.getObjectValue(transformKey);
    var xx = descriptorNumber(tr, "xx");
    var xy = descriptorNumber(tr, "xy");
    var yx = descriptorNumber(tr, "yx");
    var yy = descriptorNumber(tr, "yy");
    var tx = descriptorNumber(tr, "tx");
    var ty = descriptorNumber(tr, "ty");
    if (xx === null && xy === null && yx === null && yy === null && tx === null && ty === null) return null;
    return [xx, xy, yx, yy, tx, ty];
  } catch (e) {
    return null;
  }
}
function collectTextLayers(container, out) {
  for (var i = 0; i < container.layers.length; i++) {
    var L = container.layers[i];
    var isSet = false;
    try { isSet = (L.typename === "LayerSet"); } catch (e) {}
    if (isSet) {
      collectTextLayers(L, out);
      continue;
    }
    var isText = false;
    try { isText = (L.kind == LayerKind.TEXT); } catch (e) {}
    if (isText) out.push(L);
  }
}
try {
  var prevRuler = app.preferences.rulerUnits;
  var prevType = app.preferences.typeUnits;
  app.preferences.rulerUnits = Units.PIXELS;
  app.preferences.typeUnits = TypeUnits.POINTS;
  var file = new File(PSD_PATH);
  if (!file.exists) {
    writeSentinel("ERROR PSD not found: " + PSD_PATH);
  } else {
    var doc = app.open(file);
    app.activeDocument = doc;
    var textLayers = [];
    collectTextLayers(doc, textLayers);
    var items = [];
    for (var i = 0; i < textLayers.length; i++) {
      var L = textLayers[i];
      var ti = null;
      try { ti = L.textItem; } catch (e) {}
      var contents = "";
      var font = "";
      var sizePt = 0;
      var dir = "horizontal";
      var fillColor = "default";
      var visible = true;
      try { visible = L.visible; } catch (e) {}
      if (ti) {
        try { contents = ti.contents; } catch (e) {}
        try { font = ti.font; } catch (e) {}
        try { sizePt = (ti.size && ti.size.as) ? ti.size.as("pt") : Number(ti.size); } catch (e) {}
        try { dir = (ti.direction == Direction.VERTICAL) ? "vertical" : "horizontal"; } catch (e) {}
        fillColor = fillColorNameFromTextItem(ti);
      }
      var b = null;
      try { b = L.bounds; } catch (e) {}
      var left = 0, top = 0, right = 0, bottom = 0;
      if (b && b.length >= 4) { left = asPx(b[0]); top = asPx(b[1]); right = asPx(b[2]); bottom = asPx(b[3]); }
      var layerId = layerIdOf(L);
      var transform = textTransformForLayer(L);
      var stroke = strokeFromLayerEffectsWithAncestors(L);
      if (!contents || contents.length === 0) { try { contents = L.name; } catch (e) {} }
      items.push(
        '{"idx":' + jsonNum(i)
        + ',"id":' + jsonNum(layerId)
        + ',"name":' + jsonStr(L.name)
        + ',"contents":' + jsonStr(contents)
        + ',"font":' + jsonStr(font)
        + ',"sizePt":' + jsonNum(sizePt)
        + ',"left":' + jsonNum(left) + ',"top":' + jsonNum(top)
        + ',"right":' + jsonNum(right) + ',"bottom":' + jsonNum(bottom)
        + ',"transform":' + jsonNumArray(transform)
        + ',"direction":' + jsonStr(dir)
        + ',"fillColor":' + jsonStr(fillColor)
        + ',"strokeColor":' + jsonStr(stroke.strokeColor)
        + ',"strokeWidthPx":' + jsonNum(stroke.strokeWidthPx)
        + ',"visible":' + jsonBool(visible)
        + '}'
      );
    }
    var json = '{"docWidth":' + jsonNum(doc.width.as ? doc.width.as("px") : doc.width)
      + ',"docHeight":' + jsonNum(doc.height.as ? doc.height.as("px") : doc.height)
      + ',"dpi":' + jsonNum(doc.resolution)
      + ',"textLayers":[' + items.join(",") + ']}';
    var jf = new File(OUT_JSON);
    jf.encoding = "UTF-8";
    jf.open("w");
    jf.write(json);
    jf.close();
    doc.close(SaveOptions.DONOTSAVECHANGES);
    app.preferences.rulerUnits = prevRuler;
    app.preferences.typeUnits = prevType;
    writeSentinel("OK " + items.length);
  }
} catch (err) {
  writeSentinel("ERROR " + (err && err.toString ? err.toString() : String(err)));
}
"####;

const READ_TEXT_BATCH_BODY: &str = r####"
function writeSentinel(text) {
  try {
    var f = new File(SENTINEL_PATH);
    f.encoding = "UTF-8";
    f.open("w");
    f.write(text);
    f.close();
  } catch (e) {}
}
function jsonStr(s) {
  if (s === null || s === undefined) return '""';
  s = String(s);
  var out = '"';
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    var code = s.charCodeAt(i);
    if (c === '"') out += '\\"';
    else if (c === '\\') out += '\\\\';
    else if (c === '\n') out += '\\n';
    else if (c === '\r') out += '\\r';
    else if (c === '\t') out += '\\t';
    else if (code < 0x20) {
      var h = code.toString(16);
      while (h.length < 4) h = '0' + h;
      out += '\\u' + h;
    } else { out += c; }
  }
  return out + '"';
}
function jsonNum(n) {
  if (n === null || n === undefined || isNaN(n)) return '0';
  return String(n);
}
function jsonBool(b) { return b ? 'true' : 'false'; }
function jsonNullableNum(n) {
  if (n === null || n === undefined || isNaN(n)) return 'null';
  return String(n);
}
function jsonNumArray(arr) {
  if (!arr || !arr.length) return 'null';
  var out = [];
  for (var i = 0; i < arr.length; i++) out.push(jsonNullableNum(arr[i]));
  return '[' + out.join(',') + ']';
}
function descriptorBool(desc, key) {
  try {
    var id = stringIDToTypeID(key);
    if (!desc.hasKey(id)) return null;
    return desc.getBoolean(id);
  } catch (e) {}
  return null;
}
function descriptorNumberAny(desc, stringKey, charKey) {
  try {
    var id = stringIDToTypeID(stringKey);
    if (desc.hasKey(id)) {
      try { return desc.getDouble(id); } catch (e1) {}
      try { return desc.getUnitDoubleValue(id); } catch (e2) {}
      try { return desc.getInteger(id); } catch (e3) {}
    }
  } catch (e) {}
  if (charKey) {
    try {
      var cid = charIDToTypeID(charKey);
      if (desc.hasKey(cid)) {
        try { return desc.getDouble(cid); } catch (e4) {}
        try { return desc.getUnitDoubleValue(cid); } catch (e5) {}
        try { return desc.getInteger(cid); } catch (e6) {}
      }
    } catch (e7) {}
  }
  return null;
}
function strokeFromFrameFx(fx) {
  if (!fx) return null;
  var enabled = descriptorBool(fx, "enabled");
  var present = descriptorBool(fx, "present");
  if (enabled === false || present === false) return null;
  // 【提案A/B】enabled な境界線効果(frameFX)が存在する時点で「フチあり」と確定する。
  // 色が読めない / 純白・純黒に分類できない場合も null(=none) へ落とさず "present"
  // （色未分類だがフチは存在）を返し、リサイクル側で白フチとして再現する。これで
  // 背景白率ヒューリスティックへの取りこぼし（白吹き出し内の偽陰性）を防ぐ。
  // 白/黒の判定閾値も >240/<15 から >=235/<=20 へ緩め、紙白やわずかに色味のある
  // 白フチも拾う。通常読み込み経路は normalizeExtractedStrokeColor が "present" を
  // "none" に丸めるため影響しない。
  var size = descriptorNumberAny(fx, "size", "Sz  ");
  var strokeWidthPx = (typeof size === "number" && isFinite(size) && size > 0) ? size : 20;
  var colorDesc = null;
  try {
    var colorKey = stringIDToTypeID("color");
    if (fx.hasKey(colorKey)) colorDesc = fx.getObjectValue(colorKey);
  } catch (e) {}
  if (!colorDesc) return { strokeColor: "present", strokeWidthPx: strokeWidthPx };
  var r = descriptorNumberAny(colorDesc, "red", "Rd  ");
  var g = descriptorNumberAny(colorDesc, "green", "Grn ");
  var b = descriptorNumberAny(colorDesc, "blue", "Bl  ");
  if (r === null || g === null || b === null) return { strokeColor: "present", strokeWidthPx: strokeWidthPx };
  if (r <= 1 && g <= 1 && b <= 1 && (r > 0 || g > 0 || b > 0)) {
    r *= 255;
    g *= 255;
    b *= 255;
  }
  r = Math.max(0, Math.min(255, Math.round(Number(r) || 0)));
  g = Math.max(0, Math.min(255, Math.round(Number(g) || 0)));
  b = Math.max(0, Math.min(255, Math.round(Number(b) || 0)));
  var strokeColor = "present";
  if (r >= 235 && g >= 235 && b >= 235) strokeColor = "white";
  else if (r <= 20 && g <= 20 && b <= 20) strokeColor = "black";
  return { strokeColor: strokeColor, strokeWidthPx: strokeWidthPx };
}
function strokeFromLayerEffects(L) {
  try {
    var layerId = layerIdOf(L);
    if (!layerId) return { strokeColor: "none", strokeWidthPx: 20 };
    var ref = new ActionReference();
    ref.putProperty(stringIDToTypeID("property"), stringIDToTypeID("layerEffects"));
    ref.putIdentifier(charIDToTypeID("Lyr "), layerId);
    var desc = executeActionGet(ref);
    var effectsKey = stringIDToTypeID("layerEffects");
    var effects = desc.hasKey(effectsKey) ? desc.getObjectValue(effectsKey) : desc;
    var frameKey = stringIDToTypeID("frameFX");
    if (effects.hasKey(frameKey)) {
      var single = strokeFromFrameFx(effects.getObjectValue(frameKey));
      if (single) return single;
    }
    var multiKey = stringIDToTypeID("frameFXMulti");
    if (effects.hasKey(multiKey)) {
      var list = effects.getList(multiKey);
      for (var i = 0; i < list.count; i++) {
        var item = strokeFromFrameFx(list.getObjectValue(i));
        if (item) return item;
      }
    }
  } catch (e) {}
  return { strokeColor: "none", strokeWidthPx: 20 };
}
// テキストレイヤー自身＋親グループ(LayerSet)を遡って境界線効果(frameFX)を探す。
// OPUS は「白フチ＋ルビ」のレイヤーを保存するとき、テキストレイヤーではなく
// 専用サブグループへ境界線効果を当てる（jsx_gen.rs の applyStrokeEffect(__subGroupNL)）。
// そのため再リサイクル時にテキストレイヤー単体の layerEffects を読むだけでは白フチが
// 取りこぼされ、背景白率ヒューリスティックに落ちてしまう。手動写植でグループに境界線を
// 付けているケースも同様に拾えるよう、自身に効果が無ければ祖先グループへ遡る。
function strokeFromLayerEffectsWithAncestors(L) {
  var own = strokeFromLayerEffects(L);
  if (own && own.strokeColor !== "none") return own;
  try {
    var p = L.parent;
    var guard = 0;
    while (p && guard < 12) {
      var isSet = false;
      try { isSet = (p.typename === "LayerSet"); } catch (eT) { isSet = false; }
      if (!isSet) break;
      var g = strokeFromLayerEffects(p);
      if (g && g.strokeColor !== "none") return g;
      p = p.parent;
      guard++;
    }
  } catch (e) {}
  return own;
}
function layerIdOf(L) {
  try {
    var id = Number(L.id);
    return isNaN(id) ? 0 : id;
  } catch (e) {
    return 0;
  }
}
function descriptorNumber(desc, key) {
  try {
    var id = stringIDToTypeID(key);
    if (!desc.hasKey(id)) return null;
    try { return desc.getDouble(id); } catch (e1) {}
    try { return desc.getUnitDoubleValue(id); } catch (e2) {}
    try { return desc.getInteger(id); } catch (e3) {}
  } catch (e) {}
  return null;
}
function textTransformForLayer(L) {
  try {
    var layerId = layerIdOf(L);
    if (!layerId) return null;
    var ref = new ActionReference();
    ref.putIdentifier(charIDToTypeID("Lyr "), layerId);
    var desc = executeActionGet(ref);
    var textKey = stringIDToTypeID("textKey");
    if (!desc.hasKey(textKey)) return null;
    var textDesc = desc.getObjectValue(textKey);
    var transformKey = stringIDToTypeID("transform");
    if (!textDesc.hasKey(transformKey)) return null;
    var tr = textDesc.getObjectValue(transformKey);
    var xx = descriptorNumber(tr, "xx");
    var xy = descriptorNumber(tr, "xy");
    var yx = descriptorNumber(tr, "yx");
    var yy = descriptorNumber(tr, "yy");
    var tx = descriptorNumber(tr, "tx");
    var ty = descriptorNumber(tr, "ty");
    if (xx === null && xy === null && yx === null && yy === null && tx === null && ty === null) return null;
    return [xx, xy, yx, yy, tx, ty];
  } catch (e) {
    return null;
  }
}

function fillColorNameFromTextItem(ti) {
  try {
    var c = ti.color;
    var r = c.rgb.red;
    var g = c.rgb.green;
    var b = c.rgb.blue;
    r = Math.max(0, Math.min(255, Math.round(Number(r) || 0)));
    g = Math.max(0, Math.min(255, Math.round(Number(g) || 0)));
    b = Math.max(0, Math.min(255, Math.round(Number(b) || 0)));
    if (r > 240 && g > 240 && b > 240) return "white";
    if (r < 15 && g < 15 && b < 15) return "black";
    function hx(v) {
      var s = v.toString(16);
      return s.length < 2 ? "0" + s : s;
    }
    return "#" + hx(r) + hx(g) + hx(b);
  } catch (e) {
    return "default";
  }
}

function exportFlatJpg(doc, target) {
  var dup = doc.duplicate();
  try { dup.flatten(); } catch (eF) {}
  var jpgOpts = new JPEGSaveOptions();
  jpgOpts.quality = 11;
  jpgOpts.embedColorProfile = false;
  dup.saveAs(new File(target), jpgOpts, true, Extension.LOWERCASE);
  dup.close(SaveOptions.DONOTSAVECHANGES);
}

function asPx(uv) {
  try { return uv.as("px"); } catch (e) {
    try { return Number(uv); } catch (e2) { return 0; }
  }
}

// 1 PSD を処理して per-page JSON オブジェクト文字列を返す。
function processOnePsd(psdPath, refImg, bgImg) {
  var file = new File(psdPath);
  if (!file.exists) {
    return '{"ok":false,"psdPath":' + jsonStr(psdPath) + ',"error":"PSD not found"}';
  }
  var doc = app.open(file);
  app.activeDocument = doc;
  var docRes = doc.resolution;

  var refOk = false;
  try { exportFlatJpg(doc, refImg); refOk = true; } catch (eRef) {}

  var textLayers = [];
  function walk(container) {
    for (var i = 0; i < container.layers.length; i++) {
      var L = container.layers[i];
      var isSet = false;
      try { isSet = (L.typename === "LayerSet"); } catch (e) {}
      if (isSet) { walk(L); }
      else {
        var isText = false;
        try { isText = (L.kind == LayerKind.TEXT); } catch (e) {}
        if (isText) textLayers.push(L);
      }
    }
  }
  walk(doc);

  var items = [];
  for (var i = 0; i < textLayers.length; i++) {
    var L = textLayers[i];
    var ti = null;
    try { ti = L.textItem; } catch (e) {}
    var contents = "";
    var font = "";
    var sizePt = 0;
    var dir = "horizontal";
    var fillColor = "default";
    var visible = true;
    try { visible = L.visible; } catch (e) {}
    if (ti) {
      try { contents = ti.contents; } catch (e) {}
      try { font = ti.font; } catch (e) {}
      try { sizePt = (ti.size && ti.size.as) ? ti.size.as("pt") : Number(ti.size); } catch (e) {}
      try { dir = (ti.direction == Direction.VERTICAL) ? "vertical" : "horizontal"; } catch (e) {}
      fillColor = fillColorNameFromTextItem(ti);
    }
      var b = null;
      try { b = L.bounds; } catch (e) {}
      var left = 0, top = 0, right = 0, bottom = 0;
      if (b && b.length >= 4) { left = asPx(b[0]); top = asPx(b[1]); right = asPx(b[2]); bottom = asPx(b[3]); }
      var layerId = layerIdOf(L);
      var transform = textTransformForLayer(L);
      var stroke = strokeFromLayerEffectsWithAncestors(L);
      if (!contents || contents.length === 0) { try { contents = L.name; } catch (e) {} }
      items.push(
        '{"idx":' + jsonNum(i)
        + ',"id":' + jsonNum(layerId)
        + ',"name":' + jsonStr(L.name)
        + ',"contents":' + jsonStr(contents)
        + ',"font":' + jsonStr(font)
        + ',"sizePt":' + jsonNum(sizePt)
        + ',"left":' + jsonNum(left) + ',"top":' + jsonNum(top)
        + ',"right":' + jsonNum(right) + ',"bottom":' + jsonNum(bottom)
        + ',"transform":' + jsonNumArray(transform)
        + ',"direction":' + jsonStr(dir)
        + ',"fillColor":' + jsonStr(fillColor)
        + ',"strokeColor":' + jsonStr(stroke.strokeColor)
        + ',"strokeWidthPx":' + jsonNum(stroke.strokeWidthPx)
        + ',"visible":' + jsonBool(visible)
      + '}'
    );
  }

  for (var k = 0; k < textLayers.length; k++) {
    try { textLayers[k].visible = false; } catch (e) {}
  }
  var bgOk = false;
  try { exportFlatJpg(doc, bgImg); bgOk = true; } catch (eDup) {}

  var pageJson = '{"ok":true,"psdPath":' + jsonStr(psdPath)
    + ',"docWidth":' + jsonNum(doc.width.as ? doc.width.as("px") : doc.width)
    + ',"docHeight":' + jsonNum(doc.height.as ? doc.height.as("px") : doc.height)
    + ',"dpi":' + jsonNum(docRes)
    + ',"refImage":' + jsonStr(refOk ? refImg : "")
    + ',"bgImage":' + jsonStr(bgOk ? bgImg : "")
    + ',"textLayers":[' + items.join(",") + ']}';

  doc.close(SaveOptions.DONOTSAVECHANGES);
  return pageJson;
}

try {
  var prevRuler = app.preferences.rulerUnits;
  var prevType = app.preferences.typeUnits;
  app.preferences.rulerUnits = Units.PIXELS;
  app.preferences.typeUnits = TypeUnits.POINTS;

  var results = [];
  for (var j = 0; j < JOBS.length; j++) {
    try {
      results.push(processOnePsd(JOBS[j].psd, JOBS[j].ref, JOBS[j].bg));
    } catch (ej) {
      results.push('{"ok":false,"psdPath":' + jsonStr(JOBS[j].psd) + ',"error":' + jsonStr(ej && ej.toString ? ej.toString() : String(ej)) + '}');
    }
  }

  var json = '{"pages":[' + results.join(",") + ']}';
  var jf = new File(OUT_JSON);
  jf.encoding = "UTF-8";
  jf.open("w");
  jf.write(json);
  jf.close();

  app.preferences.rulerUnits = prevRuler;
  app.preferences.typeUnits = prevType;
  writeSentinel("OK " + JOBS.length);
} catch (err) {
  writeSentinel("ERROR " + (err && err.toString ? err.toString() : String(err)));
}
"####;

const READ_TEXT_BODY: &str = r####"
function writeSentinel(text) {
  try {
    var f = new File(SENTINEL_PATH);
    f.encoding = "UTF-8";
    f.open("w");
    f.write(text);
    f.close();
  } catch (e) {}
}

// ExtendScript には JSON が無いので最小限のエンコーダを用意する。
function jsonStr(s) {
  if (s === null || s === undefined) return '""';
  s = String(s);
  var out = '"';
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    var code = s.charCodeAt(i);
    if (c === '"') out += '\\"';
    else if (c === '\\') out += '\\\\';
    else if (c === '\n') out += '\\n';
    else if (c === '\r') out += '\\r';
    else if (c === '\t') out += '\\t';
    else if (code < 0x20) {
      var h = code.toString(16);
      while (h.length < 4) h = '0' + h;
      out += '\\u' + h;
    } else {
      out += c;
    }
  }
  return out + '"';
}
function jsonNum(n) {
  if (n === null || n === undefined || isNaN(n)) return '0';
  return String(n);
}
function jsonBool(b) { return b ? 'true' : 'false'; }
function layerIdOf(L) {
  try {
    var id = Number(L.id);
    return isNaN(id) ? 0 : id;
  } catch (e) {
    return 0;
  }
}
function descriptorBool(desc, key) {
  try {
    var id = stringIDToTypeID(key);
    if (!desc.hasKey(id)) return null;
    return desc.getBoolean(id);
  } catch (e) {}
  return null;
}
function descriptorNumberAny(desc, stringKey, charKey) {
  try {
    var id = stringIDToTypeID(stringKey);
    if (desc.hasKey(id)) {
      try { return desc.getDouble(id); } catch (e1) {}
      try { return desc.getUnitDoubleValue(id); } catch (e2) {}
      try { return desc.getInteger(id); } catch (e3) {}
    }
  } catch (e) {}
  if (charKey) {
    try {
      var cid = charIDToTypeID(charKey);
      if (desc.hasKey(cid)) {
        try { return desc.getDouble(cid); } catch (e4) {}
        try { return desc.getUnitDoubleValue(cid); } catch (e5) {}
        try { return desc.getInteger(cid); } catch (e6) {}
      }
    } catch (e7) {}
  }
  return null;
}
function strokeFromFrameFx(fx) {
  if (!fx) return null;
  var enabled = descriptorBool(fx, "enabled");
  var present = descriptorBool(fx, "present");
  if (enabled === false || present === false) return null;
  // 【提案A/B】enabled な境界線効果(frameFX)が存在する時点で「フチあり」と確定する。
  // 色が読めない / 純白・純黒に分類できない場合も null(=none) へ落とさず "present"
  // （色未分類だがフチは存在）を返し、リサイクル側で白フチとして再現する。これで
  // 背景白率ヒューリスティックへの取りこぼし（白吹き出し内の偽陰性）を防ぐ。
  // 白/黒の判定閾値も >240/<15 から >=235/<=20 へ緩め、紙白やわずかに色味のある
  // 白フチも拾う。通常読み込み経路は normalizeExtractedStrokeColor が "present" を
  // "none" に丸めるため影響しない。
  var size = descriptorNumberAny(fx, "size", "Sz  ");
  var strokeWidthPx = (typeof size === "number" && isFinite(size) && size > 0) ? size : 20;
  var colorDesc = null;
  try {
    var colorKey = stringIDToTypeID("color");
    if (fx.hasKey(colorKey)) colorDesc = fx.getObjectValue(colorKey);
  } catch (e) {}
  if (!colorDesc) return { strokeColor: "present", strokeWidthPx: strokeWidthPx };
  var r = descriptorNumberAny(colorDesc, "red", "Rd  ");
  var g = descriptorNumberAny(colorDesc, "green", "Grn ");
  var b = descriptorNumberAny(colorDesc, "blue", "Bl  ");
  if (r === null || g === null || b === null) return { strokeColor: "present", strokeWidthPx: strokeWidthPx };
  if (r <= 1 && g <= 1 && b <= 1 && (r > 0 || g > 0 || b > 0)) {
    r *= 255;
    g *= 255;
    b *= 255;
  }
  r = Math.max(0, Math.min(255, Math.round(Number(r) || 0)));
  g = Math.max(0, Math.min(255, Math.round(Number(g) || 0)));
  b = Math.max(0, Math.min(255, Math.round(Number(b) || 0)));
  var strokeColor = "present";
  if (r >= 235 && g >= 235 && b >= 235) strokeColor = "white";
  else if (r <= 20 && g <= 20 && b <= 20) strokeColor = "black";
  return { strokeColor: strokeColor, strokeWidthPx: strokeWidthPx };
}
function strokeFromLayerEffects(L) {
  try {
    var layerId = layerIdOf(L);
    if (!layerId) return { strokeColor: "none", strokeWidthPx: 20 };
    var ref = new ActionReference();
    ref.putProperty(stringIDToTypeID("property"), stringIDToTypeID("layerEffects"));
    ref.putIdentifier(charIDToTypeID("Lyr "), layerId);
    var desc = executeActionGet(ref);
    var effectsKey = stringIDToTypeID("layerEffects");
    var effects = desc.hasKey(effectsKey) ? desc.getObjectValue(effectsKey) : desc;
    var frameKey = stringIDToTypeID("frameFX");
    if (effects.hasKey(frameKey)) {
      var single = strokeFromFrameFx(effects.getObjectValue(frameKey));
      if (single) return single;
    }
    var multiKey = stringIDToTypeID("frameFXMulti");
    if (effects.hasKey(multiKey)) {
      var list = effects.getList(multiKey);
      for (var i = 0; i < list.count; i++) {
        var item = strokeFromFrameFx(list.getObjectValue(i));
        if (item) return item;
      }
    }
  } catch (e) {}
  return { strokeColor: "none", strokeWidthPx: 20 };
}
// テキストレイヤー自身＋親グループ(LayerSet)を遡って境界線効果(frameFX)を探す。
// OPUS は「白フチ＋ルビ」のレイヤーを保存するとき、テキストレイヤーではなく
// 専用サブグループへ境界線効果を当てる（jsx_gen.rs の applyStrokeEffect(__subGroupNL)）。
// そのため再リサイクル時にテキストレイヤー単体の layerEffects を読むだけでは白フチが
// 取りこぼされ、背景白率ヒューリスティックに落ちてしまう。手動写植でグループに境界線を
// 付けているケースも同様に拾えるよう、自身に効果が無ければ祖先グループへ遡る。
function strokeFromLayerEffectsWithAncestors(L) {
  var own = strokeFromLayerEffects(L);
  if (own && own.strokeColor !== "none") return own;
  try {
    var p = L.parent;
    var guard = 0;
    while (p && guard < 12) {
      var isSet = false;
      try { isSet = (p.typename === "LayerSet"); } catch (eT) { isSet = false; }
      if (!isSet) break;
      var g = strokeFromLayerEffects(p);
      if (g && g.strokeColor !== "none") return g;
      p = p.parent;
      guard++;
    }
  } catch (e) {}
  return own;
}

function fillColorNameFromTextItem(ti) {
  try {
    var c = ti.color;
    var r = c.rgb.red;
    var g = c.rgb.green;
    var b = c.rgb.blue;
    r = Math.max(0, Math.min(255, Math.round(Number(r) || 0)));
    g = Math.max(0, Math.min(255, Math.round(Number(g) || 0)));
    b = Math.max(0, Math.min(255, Math.round(Number(b) || 0)));
    if (r > 240 && g > 240 && b > 240) return "white";
    if (r < 15 && g < 15 && b < 15) return "black";
    function hx(v) {
      var s = v.toString(16);
      return s.length < 2 ? "0" + s : s;
    }
    return "#" + hx(r) + hx(g) + hx(b);
  } catch (e) {
    return "default";
  }
}

try {
  var prevRuler = app.preferences.rulerUnits;
  var prevType = app.preferences.typeUnits;
  app.preferences.rulerUnits = Units.PIXELS;
  app.preferences.typeUnits = TypeUnits.POINTS;

  var file = new File(PSD_PATH);
  if (!file.exists) { writeSentinel("ERROR PSD not found: " + PSD_PATH); }
  else {
    var doc = app.open(file);
    app.activeDocument = doc;
    var docRes = doc.resolution;

    function exportFlatJpg(target) {
      var dup = doc.duplicate();
      try { dup.flatten(); } catch (eF) {}
      var jpgOpts = new JPEGSaveOptions();
      jpgOpts.quality = 11;
      jpgOpts.embedColorProfile = false;
      dup.saveAs(new File(target), jpgOpts, true, Extension.LOWERCASE);
      dup.close(SaveOptions.DONOTSAVECHANGES);
    }

    // 見本（元テキスト入り合成画像）を先に書き出す。
    var refOk = false;
    try { exportFlatJpg(REF_IMG); refOk = true; } catch (eRef) {}

    // 全テキストレイヤーを再帰収集（出現順＝後で保存時に同順で辿って非表示化するため）。
    var textLayers = [];
    function walk(container) {
      for (var i = 0; i < container.layers.length; i++) {
        var L = container.layers[i];
        var isSet = false;
        try { isSet = (L.typename === "LayerSet"); } catch (e) {}
        if (isSet) { walk(L); }
        else {
          var isText = false;
          try { isText = (L.kind == LayerKind.TEXT); } catch (e) {}
          if (isText) textLayers.push(L);
        }
      }
    }
    walk(doc);

    function asPx(uv) {
      try { return uv.as("px"); } catch (e) {
        try { return Number(uv); } catch (e2) { return 0; }
      }
    }

    var items = [];
    for (var i = 0; i < textLayers.length; i++) {
      var L = textLayers[i];
      var ti = null;
      try { ti = L.textItem; } catch (e) {}
      var contents = "";
      var font = "";
      var sizePt = 0;
      var dir = "horizontal";
      var fillColor = "default";
      var visible = true;
      try { visible = L.visible; } catch (e) {}
      if (ti) {
        try { contents = ti.contents; } catch (e) {}
        try { font = ti.font; } catch (e) {}
        try { sizePt = (ti.size && ti.size.as) ? ti.size.as("pt") : Number(ti.size); } catch (e) {}
        try { dir = (ti.direction == Direction.VERTICAL) ? "vertical" : "horizontal"; } catch (e) {}
        fillColor = fillColorNameFromTextItem(ti);
      }
      var b = null;
      try { b = L.bounds; } catch (e) {}
      var left = 0, top = 0, right = 0, bottom = 0;
      if (b && b.length >= 4) { left = asPx(b[0]); top = asPx(b[1]); right = asPx(b[2]); bottom = asPx(b[3]); }
      // contents が空（取得失敗）ならレイヤー名で補完（PS はテキストレイヤーを内容で自動命名する）。
      if (!contents || contents.length === 0) { try { contents = L.name; } catch (e) {} }
      var stroke = strokeFromLayerEffectsWithAncestors(L);
      items.push(
        '{"idx":' + jsonNum(i)
        + ',"name":' + jsonStr(L.name)
        + ',"contents":' + jsonStr(contents)
        + ',"font":' + jsonStr(font)
        + ',"sizePt":' + jsonNum(sizePt)
        + ',"left":' + jsonNum(left) + ',"top":' + jsonNum(top)
        + ',"right":' + jsonNum(right) + ',"bottom":' + jsonNum(bottom)
        + ',"direction":' + jsonStr(dir)
        + ',"fillColor":' + jsonStr(fillColor)
        + ',"strokeColor":' + jsonStr(stroke.strokeColor)
        + ',"strokeWidthPx":' + jsonNum(stroke.strokeWidthPx)
        + ',"visible":' + jsonBool(visible)
        + '}'
      );
    }

    // テキストを全て非表示にした合成画像を JPG で書き出す（背景＝原稿表示用）。
    // レイヤー効果（フチ等）もレイヤー非表示で一緒に消えるので、Photoshop の描画結果が
    // そのまま「テキストを消した絵」になる。
    for (var i = 0; i < textLayers.length; i++) {
      try { textLayers[i].visible = false; } catch (e) {}
    }
    var bgOk = false;
    try { exportFlatJpg(BG_IMG); bgOk = true; } catch (eDup) {}

    var json = '{"docWidth":' + jsonNum(doc.width.as ? doc.width.as("px") : doc.width)
      + ',"docHeight":' + jsonNum(doc.height.as ? doc.height.as("px") : doc.height)
      + ',"dpi":' + jsonNum(docRes)
      + ',"refImage":' + jsonStr(refOk ? REF_IMG : "")
      + ',"bgImage":' + jsonStr(bgOk ? BG_IMG : "")
      + ',"textLayers":[' + items.join(",") + ']}';
    var jf = new File(OUT_JSON);
    jf.encoding = "UTF-8";
    jf.open("w");
    jf.write(json);
    jf.close();

    doc.close(SaveOptions.DONOTSAVECHANGES);
    app.preferences.rulerUnits = prevRuler;
    app.preferences.typeUnits = prevType;
    writeSentinel("OK " + items.length);
  }
} catch (err) {
  writeSentinel("ERROR " + (err && err.toString ? err.toString() : String(err)));
}
"####;

pub fn generate_apply_script(
    payload: &EditPayload,
    payload_path: &str,
    sentinel_path: &str,
    progress_path: &str,
    quit_photoshop_after_finish: bool,
) -> String {
    let mut out = String::new();
    out.push_str(HEADER);
    out.push('\n');
    out.push_str(&format!(
        "var SENTINEL_PATH = {};\n",
        js_string(sentinel_path)
    ));
    out.push_str(&format!(
        "var PROGRESS_PATH = {};\n",
        js_string(progress_path)
    ));
    out.push_str(&format!(
        "var PAYLOAD_PATH = {};\n",
        js_string(payload_path)
    ));
    out.push_str(&format!(
        "var OPUS_QUIT_PHOTOSHOP_AFTER_FINISH = {};\n",
        if quit_photoshop_after_finish {
            "true"
        } else {
            "false"
        }
    ));
    out.push_str("var OPUS_FAILED_PSD_ENTRIES = [];\n");
    out.push_str("try {\n");
    out.push_str("  var __psver = photoshopVersion();\n");
    out.push_str("  if (__psver > 0 && __psver < 13) { addWarning(\"Photoshop \" + __psver + \" は動作未検証のバージョンです\"); }\n");

    let total = payload.edits.len();
    if !payload_path.is_empty() {
        out.push_str(
            r####"
  function __readUtf8(path) {
    var f = new File(path);
    f.encoding = "UTF-8";
    if (!f.exists) throw new Error("payload file not found: " + path);
    if (!f.open("r")) throw new Error("payload file open failed: " + path);
    var s = f.read();
    f.close();
    return s;
  }
  function __parseJsonText(s) {
    if (typeof JSON !== "undefined" && JSON && JSON.parse) return JSON.parse(s);
    return eval("(" + s + ")");
  }
  function __has(o, k) { return o && typeof o[k] !== "undefined" && o[k] !== null; }
  function __copy(o, k, out, to) { if (__has(o, k)) out[to || k] = o[k]; }
  function __rubies(raw) {
    if (!raw) return raw;
    var out = {};
    for (var k in raw) {
      if (!raw.hasOwnProperty(k)) continue;
      var e = raw[k];
      if (!e) continue;
      var c = {};
      for (var p in e) if (e.hasOwnProperty(p)) c[p] = e[p];
      if (typeof c.rubyType === "undefined" && typeof c.type !== "undefined") c.rubyType = c.type;
      if (c.overlays && c.overlays.length) {
        var ov = [];
        for (var i = 0; i < c.overlays.length; i++) {
          var src = c.overlays[i];
          if (!src) continue;
          var dst = {};
          for (var op in src) if (src.hasOwnProperty(op)) dst[op] = src[op];
          if (typeof dst.rubyType === "undefined" && typeof dst.type !== "undefined") dst.rubyType = dst.type;
          ov.push(dst);
        }
        c.overlays = ov;
      }
      out[k] = c;
    }
    return out;
  }
  function __layer(raw) {
    var out = {};
    __copy(raw, "layerId", out, "id");
    __copy(raw, "contents", out);
    __copy(raw, "deleted", out);
    __copy(raw, "fontPostScriptName", out, "font");
    __copy(raw, "sizePt", out, "size");
    __copy(raw, "dx", out);
    __copy(raw, "dy", out);
    __copy(raw, "direction", out);
    __copy(raw, "strokeColor", out);
    __copy(raw, "strokeWidthPx", out, "strokeWidth");
    __copy(raw, "fillColor", out);
    __copy(raw, "rotation", out);
    __copy(raw, "leadingPct", out);
    __copy(raw, "horizontalScale", out);
    __copy(raw, "verticalScale", out);
    __copy(raw, "trackingMille", out);
    __copy(raw, "kerningMille", out);
    __copy(raw, "lineLeadings", out);
    __copy(raw, "charSizes", out);
    __copy(raw, "charFonts", out);
    __copy(raw, "charHorizontalScales", out);
    __copy(raw, "charVerticalScales", out);
    __copy(raw, "charTrackings", out);
    __copy(raw, "charKernings", out);
    __copy(raw, "charTateChuYokos", out);
    __copy(raw, "charFillColors", out);
    __copy(raw, "syntheticBold", out);
    __copy(raw, "syntheticItalic", out);
    __copy(raw, "charBolds", out);
    __copy(raw, "charItalics", out);
    if (__has(raw, "charRubies")) out.charRubies = __rubies(raw.charRubies);
    return out;
  }
  function __newLayer(raw) {
    var out = __layer(raw);
    __copy(raw, "x", out);
    __copy(raw, "y", out);
    __copy(raw, "reuseSrcCx", out);
    __copy(raw, "reuseSrcCy", out);
    __copy(raw, "uiAnchorCx", out);
    __copy(raw, "uiAnchorCy", out);
    return out;
  }
  function __mapLayers(list, fn) {
    var out = [];
    if (!list || !list.length) return out;
    for (var i = 0; i < list.length; i++) out.push(fn(list[i] || {}));
    return out;
  }
  function __baseName(path) {
    var s = String(path || "");
    var a = s.split(/[\/\\]/);
    return a.length ? (a[a.length - 1] || "output.psd") : "output.psd";
  }
  function __normPath(path) { return String(path || "").replace(/\\/g, "/"); }
  function __savePath(payload, psd) {
    if (psd && typeof psd.savePath === "string" && psd.savePath.length > 0) return __normPath(psd.savePath);
    if (payload && payload.saveMode === "saveAs" && typeof payload.targetDir === "string" && payload.targetDir.length > 0) {
      var dir = payload.targetDir;
      var sep = (dir.charAt(dir.length - 1) === "/" || dir.charAt(dir.length - 1) === "\\") ? "" : "/";
      return __normPath(dir + sep + __baseName(psd.psdPath));
    }
    return "";
  }
  var __payload = __parseJsonText(__readUtf8(PAYLOAD_PATH));
  if (!__payload) __payload = {};
  var __edits = (__payload && __payload.edits && __payload.edits.length) ? __payload.edits : [];
  var __total = __edits.length;
  initProgress(__total);
  var __saveOk = 0;
  var __saveFail = 0;
  var __symbolFontPS = (__payload.symbolFontReplaceEnabled && __payload.symbolFontPostScriptName) ? __payload.symbolFontPostScriptName : "";
  var __rubyFontPS = __payload.rubyFontPostScriptName || "";
  for (var __idx = 0; __idx < __edits.length; __idx++) {
    var __psd = __edits[__idx];
    var __fileName = __baseName(__psd.psdPath);
    var __outPath = __savePath(__payload, __psd);
    setProgress(__idx + 1, __total, __fileName + " processing (" + (__idx + 1) + "/" + __total + ")");
    try {
      applyToPsd(
        __psd.psdPath,
        __mapLayers(__psd.layers, __layer),
        __mapLayers(__psd.newLayers, __newLayer),
        __outPath,
        __payload.dashTrackingMille || 0,
        __payload.tildeTrackingMille || 0,
        __payload.tateChuYokoEnabled === true,
        __symbolFontPS,
        __payload.punctuationTsumePercent || 0,
        __payload.rubyLeadingPct || 150,
        __rubyFontPS,
        __payload.rubyPhotoshopOffsetEm || 0,
        __payload.rubyPhotoshopBiasPx || 0,
        (__psd.pageWidth && isFinite(__psd.pageWidth)) ? __psd.pageWidth : 0,
        (__psd.pageHeight && isFinite(__psd.pageHeight)) ? __psd.pageHeight : 0,
        (__psd.hideLayerIds && __psd.hideLayerIds.length) ? __psd.hideLayerIds : [],
        __payload.reuseHideOriginalText === true
      );
      __saveOk++;
    } catch (eFile) {
      OPUS_FAILED_PSD_ENTRIES.push(String(__psd.psdPath || "") + "\t" + String(__outPath || ""));
      __saveFail++;
      addWarning("[save failed] " + __fileName + ": " + (eFile && eFile.toString ? eFile.toString() : String(eFile)));
    }
  }
"####,
        );
    } else {
    out.push_str(&format!("  initProgress({});\n", total));
    // 個別 PSD の保存失敗を集計するカウンタ。ループの途中で例外が出ても残りの PSD を
    // 処理し続け、最終的に "OK partial N/M" として Rust に返す。
    out.push_str("  var __saveOk = 0;\n");
    out.push_str("  var __saveFail = 0;\n");

    let save_as = payload.save_mode.as_deref() == Some("saveAs");
    let target_dir = payload.target_dir.as_deref().unwrap_or("");

    for (idx, psd) in payload.edits.iter().enumerate() {
        let file_name = std::path::Path::new(&psd.psd_path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        let status_msg = format!("{} を処理中 ({}/{})", file_name, idx + 1, total);
        out.push_str(&format!(
            "  setProgress({}, {}, {});\n",
            idx + 1,
            total,
            js_string(&status_msg)
        ));
        let save_path = if let Some(override_path) = psd.save_path.as_deref().filter(|s| !s.is_empty()) {
            override_path.replace('\\', "/")
        } else if save_as && !target_dir.is_empty() {
            let name = std::path::Path::new(&psd.psd_path)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("output.psd");
            let sep = if target_dir.ends_with('/') || target_dir.ends_with('\\') {
                ""
            } else {
                "/"
            };
            let raw = format!("{}{}{}", target_dir, sep, name);
            // Photoshop の File API はパス区切り文字の混在 (Windows の "\" と "/")
            // に弱い。joinPath が forward slash を入れる一方で openFolder ダイアログから
            // 返る親パスは backslash なので、そのままだと例えば
            //   "C:\Users\foo\bar/写植/page1.psd"
            // のような混在パスになり、outFile.parent の解決や saveAs の overwrite が
            // 不安定になる（旧フォルダが残ったまま新規ファイルが作られない / 上書きされない）。
            // すべて forward slash に正規化（Photoshop URI スタイル）して安定化。
            raw.replace('\\', "/")
        } else {
            String::new()
        };
        // ファイル単位の try/catch で「i 番目で失敗 → 残り全部スキップ」を回避。
        // 失敗は addWarning に積むので最終トーストで件数とエラーが見える。
        out.push_str("  try {\n");
        out.push_str(&format!(
            "applyToPsd({path}, [\n",
            path = js_string(&psd.psd_path)
        ));
        for layer in &psd.layers {
            out.push_str("  {");
            out.push_str(&format!("id: {}", layer.layer_id));
            if let Some(ref c) = layer.contents {
                out.push_str(&format!(", contents: {}", js_string(c)));
            }
            if layer.deleted == Some(true) {
                out.push_str(", deleted: true");
            }
            if let Some(ref f) = layer.font_post_script_name {
                out.push_str(&format!(", font: {}", js_string(f)));
            }
            if let Some(s) = layer.size_pt {
                out.push_str(&format!(", size: {}", s));
            }
            if let Some(dx) = layer.dx {
                out.push_str(&format!(", dx: {}", dx));
            }
            if let Some(dy) = layer.dy {
                out.push_str(&format!(", dy: {}", dy));
            }
            if let Some(ref d) = layer.direction {
                out.push_str(&format!(", direction: {}", js_string(d)));
            }
            if let Some(ref s) = layer.stroke_color {
                out.push_str(&format!(", strokeColor: {}", js_string(s)));
            }
            if let Some(w) = layer.stroke_width_px {
                out.push_str(&format!(", strokeWidth: {}", w));
            }
            if let Some(ref f) = layer.fill_color {
                out.push_str(&format!(", fillColor: {}", js_string(f)));
            }
            if let Some(r) = layer.rotation {
                out.push_str(&format!(", rotation: {}", r));
            }
            if let Some(l) = layer.leading_pct {
                out.push_str(&format!(", leadingPct: {}", l));
            }
            if let Some(s) = layer.horizontal_scale {
                out.push_str(&format!(", horizontalScale: {}", s));
            }
            if let Some(s) = layer.vertical_scale {
                out.push_str(&format!(", verticalScale: {}", s));
            }
            if let Some(s) = layer.tracking_mille {
                out.push_str(&format!(", trackingMille: {}", s));
            }
            if let Some(s) = layer.kerning_mille {
                out.push_str(&format!(", kerningMille: {}", s));
            }
            if let Some(ref ll) = layer.line_leadings {
                if !ll.is_empty() {
                    out.push_str(", lineLeadings: ");
                    emit_line_leadings(&mut out, ll);
                }
            }
            if let Some(ref cs) = layer.char_sizes {
                if !cs.is_empty() {
                    out.push_str(", charSizes: ");
                    emit_char_sizes(&mut out, cs);
                }
            }
            if let Some(ref cf) = layer.char_fonts {
                if !cf.is_empty() {
                    out.push_str(", charFonts: ");
                    emit_char_fonts(&mut out, cf);
                }
            }
            if let Some(ref cs) = layer.char_horizontal_scales {
                if !cs.is_empty() {
                    out.push_str(", charHorizontalScales: ");
                    emit_char_sizes(&mut out, cs);
                }
            }
            if let Some(ref cs) = layer.char_vertical_scales {
                if !cs.is_empty() {
                    out.push_str(", charVerticalScales: ");
                    emit_char_sizes(&mut out, cs);
                }
            }
            if let Some(ref cs) = layer.char_trackings {
                if !cs.is_empty() {
                    out.push_str(", charTrackings: ");
                    emit_char_sizes(&mut out, cs);
                }
            }
            if let Some(ref cs) = layer.char_kernings {
                if !cs.is_empty() {
                    out.push_str(", charKernings: ");
                    emit_char_sizes(&mut out, cs);
                }
            }
            if let Some(ref ct) = layer.char_tate_chu_yokos {
                if !ct.is_empty() {
                    out.push_str(", charTateChuYokos: ");
                    emit_char_bolds(&mut out, ct);
                }
            }
            if let Some(ref cf) = layer.char_fill_colors {
                if !cf.is_empty() {
                    out.push_str(", charFillColors: ");
                    emit_char_fonts(&mut out, cf);
                }
            }
            if let Some(b) = layer.synthetic_bold {
                out.push_str(&format!(
                    ", syntheticBold: {}",
                    if b { "true" } else { "false" }
                ));
            }
            if let Some(i) = layer.synthetic_italic {
                out.push_str(&format!(
                    ", syntheticItalic: {}",
                    if i { "true" } else { "false" }
                ));
            }
            if let Some(ref cb) = layer.char_bolds {
                if !cb.is_empty() {
                    out.push_str(", charBolds: ");
                    emit_char_bolds(&mut out, cb);
                }
            }
            if let Some(ref ci) = layer.char_italics {
                if !ci.is_empty() {
                    out.push_str(", charItalics: ");
                    emit_char_bolds(&mut out, ci);
                }
            }
            if let Some(ref cr) = layer.char_rubies {
                if !cr.is_empty() {
                    out.push_str(", charRubies: ");
                    emit_char_rubies(&mut out, cr);
                }
            }
            out.push_str("},\n");
        }
        out.push_str("], [\n");
        for nl in &psd.new_layers {
            out.push_str("  {");
            out.push_str(&format!("x: {}, y: {}", nl.x, nl.y));
            if let Some(cx) = nl.reuse_src_cx {
                out.push_str(&format!(", reuseSrcCx: {}", cx));
            }
            if let Some(cy) = nl.reuse_src_cy {
                out.push_str(&format!(", reuseSrcCy: {}", cy));
            }
            if let Some(cx) = nl.ui_anchor_cx {
                out.push_str(&format!(", uiAnchorCx: {}", cx));
            }
            if let Some(cy) = nl.ui_anchor_cy {
                out.push_str(&format!(", uiAnchorCy: {}", cy));
            }
            out.push_str(&format!(", contents: {}", js_string(&nl.contents)));
            if let Some(ref f) = nl.font_post_script_name {
                out.push_str(&format!(", font: {}", js_string(f)));
            }
            if let Some(s) = nl.size_pt {
                out.push_str(&format!(", size: {}", s));
            }
            if let Some(ref d) = nl.direction {
                out.push_str(&format!(", direction: {}", js_string(d)));
            }
            if let Some(ref s) = nl.stroke_color {
                out.push_str(&format!(", strokeColor: {}", js_string(s)));
            }
            if let Some(w) = nl.stroke_width_px {
                out.push_str(&format!(", strokeWidth: {}", w));
            }
            if let Some(ref f) = nl.fill_color {
                out.push_str(&format!(", fillColor: {}", js_string(f)));
            }
            if let Some(r) = nl.rotation {
                out.push_str(&format!(", rotation: {}", r));
            }
            if let Some(l) = nl.leading_pct {
                out.push_str(&format!(", leadingPct: {}", l));
            }
            if let Some(s) = nl.horizontal_scale {
                out.push_str(&format!(", horizontalScale: {}", s));
            }
            if let Some(s) = nl.vertical_scale {
                out.push_str(&format!(", verticalScale: {}", s));
            }
            if let Some(s) = nl.tracking_mille {
                out.push_str(&format!(", trackingMille: {}", s));
            }
            if let Some(s) = nl.kerning_mille {
                out.push_str(&format!(", kerningMille: {}", s));
            }
            if let Some(ref ll) = nl.line_leadings {
                if !ll.is_empty() {
                    out.push_str(", lineLeadings: ");
                    emit_line_leadings(&mut out, ll);
                }
            }
            if let Some(ref cs) = nl.char_sizes {
                if !cs.is_empty() {
                    out.push_str(", charSizes: ");
                    emit_char_sizes(&mut out, cs);
                }
            }
            if let Some(ref cf) = nl.char_fonts {
                if !cf.is_empty() {
                    out.push_str(", charFonts: ");
                    emit_char_fonts(&mut out, cf);
                }
            }
            if let Some(ref cs) = nl.char_horizontal_scales {
                if !cs.is_empty() {
                    out.push_str(", charHorizontalScales: ");
                    emit_char_sizes(&mut out, cs);
                }
            }
            if let Some(ref cs) = nl.char_vertical_scales {
                if !cs.is_empty() {
                    out.push_str(", charVerticalScales: ");
                    emit_char_sizes(&mut out, cs);
                }
            }
            if let Some(ref cs) = nl.char_trackings {
                if !cs.is_empty() {
                    out.push_str(", charTrackings: ");
                    emit_char_sizes(&mut out, cs);
                }
            }
            if let Some(ref cs) = nl.char_kernings {
                if !cs.is_empty() {
                    out.push_str(", charKernings: ");
                    emit_char_sizes(&mut out, cs);
                }
            }
            if let Some(ref ct) = nl.char_tate_chu_yokos {
                if !ct.is_empty() {
                    out.push_str(", charTateChuYokos: ");
                    emit_char_bolds(&mut out, ct);
                }
            }
            if let Some(ref cf) = nl.char_fill_colors {
                if !cf.is_empty() {
                    out.push_str(", charFillColors: ");
                    emit_char_fonts(&mut out, cf);
                }
            }
            if let Some(b) = nl.synthetic_bold {
                out.push_str(&format!(
                    ", syntheticBold: {}",
                    if b { "true" } else { "false" }
                ));
            }
            if let Some(i) = nl.synthetic_italic {
                out.push_str(&format!(
                    ", syntheticItalic: {}",
                    if i { "true" } else { "false" }
                ));
            }
            if let Some(ref cb) = nl.char_bolds {
                if !cb.is_empty() {
                    out.push_str(", charBolds: ");
                    emit_char_bolds(&mut out, cb);
                }
            }
            if let Some(ref ci) = nl.char_italics {
                if !ci.is_empty() {
                    out.push_str(", charItalics: ");
                    emit_char_bolds(&mut out, ci);
                }
            }
            if let Some(ref cr) = nl.char_rubies {
                if !cr.is_empty() {
                    out.push_str(", charRubies: ");
                    emit_char_rubies(&mut out, cr);
                }
            }
            out.push_str("},\n");
        }
        // 【v1.22.0】記号フォント置換 PostScript 名 / 句読点ツメ % を追加引数として埋め込む。
        let symbol_font_ps_str = payload
            .symbol_font_post_script_name
            .as_deref()
            .unwrap_or("");
        let symbol_font_ps_js =
            if payload.symbol_font_replace_enabled && !symbol_font_ps_str.is_empty() {
                js_string(symbol_font_ps_str)
            } else {
                String::from("\"\"")
            };
        let ruby_font_ps_js = payload
            .ruby_font_post_script_name
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(js_string)
            .unwrap_or_else(|| String::from("\"\""));
        let page_width = psd
            .page_width
            .filter(|v| v.is_finite() && *v > 0.0)
            .unwrap_or(0.0);
        let page_height = psd
            .page_height
            .filter(|v| v.is_finite() && *v > 0.0)
            .unwrap_or(0.0);
        // 写植再利用モード: 非表示化する元テキストレイヤー id を JS 配列リテラルにする。
        let hide_layer_ids_js = format!(
            "[{}]",
            psd.hide_layer_ids
                .iter()
                .map(|id| id.to_string())
                .collect::<Vec<_>>()
                .join(",")
        );
        out.push_str(&format!(
            "], {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {});\n",
            js_string(&save_path),
            payload.dash_tracking_mille,
            payload.tilde_tracking_mille,
            if payload.tate_chu_yoko_enabled {
                "true"
            } else {
                "false"
            },
            symbol_font_ps_js,
            payload.punctuation_tsume_percent,
            // 【v1.29.x】ルビあり行間 (%)。applyToPsd 内で「ルビありレイヤーの親文字行間」を
            // autoLeadingAmount として設定するために使う (useAutoLeading=true、ジャスティ
            // フィケーションのみ rubyLeadingPct)。
            payload.ruby_leading_pct,
            ruby_font_ps_js,
            // 【v1.29.x】ルビ位置 Photoshop 微調整: 親寄せ em (親 fontSize 単位)、親離し px
            payload.ruby_photoshop_offset_em,
            payload.ruby_photoshop_bias_px,
            page_width,
            page_height,
            // 写植再利用: 保存時に非表示化する元テキストレイヤー id 群（末尾引数）。
            hide_layer_ids_js,
            // 写植再利用: true のとき元からあるテキストレイヤーを全て非表示にする。
            if payload.reuse_hide_original_text {
                "true"
            } else {
                "false"
            }
        ));
        out.push_str("    __saveOk++;\n");
        out.push_str("  } catch (eFile) {\n");
        out.push_str(&format!(
            "    OPUS_FAILED_PSD_ENTRIES.push({} + \"\\t\" + {});\n",
            js_string(&psd.psd_path),
            js_string(&save_path)
        ));
        out.push_str(&format!(
            "    __saveFail++;\n    addWarning(\"[保存失敗] \" + {} + \": \" + (eFile && eFile.toString ? eFile.toString() : String(eFile)));\n",
            js_string(file_name)
        ));
        out.push_str("  }\n\n");
    }

    }
    out.push_str(&format!("  setProgress({0}, {0}, \"完了\");\n", total));
    // 1 件以上失敗した場合は "OK partial <ok>/<total>" を返し、Rust 側で
    // 「N / M 個の PSD を更新」表示に切替える。失敗詳細は |WARN suffix。
    out.push_str("  if (__saveFail > 0) {\n");
    out.push_str(
        "    writeSentinel(\"OK partial \" + __saveOk + \"/\" + (__saveOk + __saveFail));\n",
    );
    out.push_str("  } else {\n");
    out.push_str("    writeSentinel(\"OK\");\n");
    out.push_str("  }\n");
    out.push_str("} catch (err) {\n");
    out.push_str(
        "  writeSentinel(\"ERROR \" + (err && err.toString ? err.toString() : String(err)));\n",
    );
    out.push_str("} finally {\n");
    out.push_str("  finishOpusPhotoshopSession();\n");
    out.push_str("}\n");
    out
}

// 【Phase 1 (v1.24.0 後) リファクタ】4 つの emit_* ヘルパーが「key を char/line
// index の数値順にソート → `{"<idx>": <value>, ...}` 形式の JSON object literal を
// 出力」する同型構造だったため、ジェネリック関数 emit_sorted_map_by_int_key に統合。
// 各 emit_* は薄い formatter ラッパーとして残し、呼出側 (applyToPsd の per-PSD ループ等)
// は無変更。新しい per-char 属性追加時はラッパー 1 行追加で済む。
//
// 出力順を char index 順に安定化（diff レビュー / JSX 側のループの予測可能性のため）。
// ExtendScript 側は順序非依存だが、Rust 側で sort して emit するルールを統一する。
//
// 【非互換性に注意】旧 emit_line_leadings は lexical sort（"10" が "2" より先）
// だったが、本統合で数値ソートに揃えた。line index は通常 10 未満で実害は無いが、
// 行数 10+ のレイヤーで出力順が安定化される。JSX 側の動作は変わらない（順序非依存）。
fn emit_sorted_map_by_int_key<T, F>(
    out: &mut String,
    m: &std::collections::HashMap<String, T>,
    format_value: F,
) where
    F: Fn(&T) -> String,
{
    out.push('{');
    let mut first = true;
    let mut keys: Vec<&String> = m.keys().collect();
    keys.sort_by(|a, b| {
        a.parse::<i64>()
            .unwrap_or(i64::MAX)
            .cmp(&b.parse::<i64>().unwrap_or(i64::MAX))
    });
    for k in keys {
        if !first {
            out.push_str(", ");
        }
        first = false;
        out.push_str(&format!("\"{}\": {}", k, format_value(&m[k])));
    }
    out.push('}');
}

fn emit_line_leadings(out: &mut String, m: &std::collections::HashMap<String, f64>) {
    emit_sorted_map_by_int_key(out, m, |v| format!("{}", v));
}

// 【v1.21.0】per-char サイズ map を JSX のオブジェクトリテラルとして emit。
fn emit_char_sizes(out: &mut String, m: &std::collections::HashMap<String, f64>) {
    emit_sorted_map_by_int_key(out, m, |v| format!("{}", v));
}

// 【v1.21.0】per-char フォント map を JSX のオブジェクトリテラルとして emit。
// value は PostScript 名（string）なので js_string でエスケープ（`"..."` を返す）。
fn emit_char_fonts(out: &mut String, m: &std::collections::HashMap<String, String>) {
    emit_sorted_map_by_int_key(out, m, |v| js_string(v.as_str()));
}

// 【v1.22.0】per-char 合成太字（faux bold）map を JSX のオブジェクトリテラルとして emit。
fn emit_char_bolds(out: &mut String, m: &std::collections::HashMap<String, bool>) {
    emit_sorted_map_by_int_key(out, m, |v| if *v { "true".into() } else { "false".into() });
}

// 【v1.26.0】per-char ルビ map を JSX のオブジェクトリテラルとして emit。
// 値は {end: N, text: "...", rubyType: "mono"|"group", scale: N, offsetX?: N, offsetY?: N}。
// JSX 側でキー `type` は ExtendScript の予約語ではないが、わかりやすさのため `rubyType` に rename。
// 【v1.29.x UI-coord】offsetX / offsetY (PSD px、親レイヤー基準) があれば JSX 側はこれを
// ルビ中心として配置 (createRubyLayer)。無ければ従来の幾何計算 fallback。
fn emit_char_rubies(out: &mut String, m: &std::collections::HashMap<String, crate::RubyEntry>) {
    emit_sorted_map_by_int_key(out, m, |v| {
        let mut s = String::with_capacity(64);
        s.push_str(&format!(
            "{{end: {}, text: {}, rubyType: {}, scale: {}",
            v.end,
            js_string(&v.text),
            js_string(&v.ruby_type),
            v.scale
        ));
        if let Some(ox) = v.offset_x {
            if ox.is_finite() {
                s.push_str(&format!(", offsetX: {}", ox));
            }
        }
        if let Some(oy) = v.offset_y {
            if oy.is_finite() {
                s.push_str(&format!(", offsetY: {}", oy));
            }
        }
        if let Some(ax) = v.abs_x {
            if ax.is_finite() {
                s.push_str(&format!(", absX: {}", ax));
            }
        }
        if let Some(ay) = v.abs_y {
            if ay.is_finite() {
                s.push_str(&format!(", absY: {}", ay));
            }
        }
        if !v.overlays.is_empty() {
            s.push_str(", overlays: [");
            for (i, overlay) in v.overlays.iter().enumerate() {
                if i > 0 {
                    s.push_str(", ");
                }
                s.push_str(&format!(
                    "{{start: {}, end: {}, text: {}, rubyType: {}, scale: {}",
                    overlay.start,
                    overlay.end,
                    js_string(&overlay.text),
                    js_string(&overlay.ruby_type),
                    overlay.scale
                ));
                if let Some(ox) = overlay.offset_x {
                    if ox.is_finite() {
                        s.push_str(&format!(", offsetX: {}", ox));
                    }
                }
                if let Some(oy) = overlay.offset_y {
                    if oy.is_finite() {
                        s.push_str(&format!(", offsetY: {}", oy));
                    }
                }
                if let Some(ax) = overlay.abs_x {
                    if ax.is_finite() {
                        s.push_str(&format!(", absX: {}", ax));
                    }
                }
                if let Some(ay) = overlay.abs_y {
                    if ay.is_finite() {
                        s.push_str(&format!(", absY: {}", ay));
                    }
                }
                s.push('}');
            }
            s.push(']');
        }
        s.push('}');
        s
    });
}

fn js_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

const HEADER: &str = r##"
// Generated by OPUS — do not edit.
#target photoshop
// Photoshop 操作中ダイアログ全般 (フォント置換 / 互換性確認 / 上書き確認 等) を全て抑制する。
// フロント側 (bind/save.js ensurePhotoshopScratchOk) でスクラッチディスク容量の事前警告を
// 出しているので、ここから先で出る可能性のあるモーダルは保存処理を blocking させないために
// 抑制してよい。エラー自体は executeAction の例外として catch され addWarning で記録される。
try { app.displayDialogs = DialogModes.NO; } catch (_dlgErr) {}
try { app.playbackDisplayDialogs = DialogModes.NO; } catch (_playbackDlgErr) {}
try { app.userInteractionLevel = UserInteractionLevel.SUPPRESSALERTS; } catch (_uiErr) {}
var PSDESIGN_WARNINGS = [];
function addWarning(msg) {
  try {
    $.writeln("[OPUS][warn] " + msg);
    PSDESIGN_WARNINGS.push(String(msg));
  } catch (warnErr) {}
}

// ===== Photoshop 側進捗パレット（ScriptUI） =====
// Photoshop 本体はスクリプト実行中も UI は動くが、長時間かかる保存処理で
// 「何が起きているか」を示すために軽量なパレットウインドウで進捗表示する。
// 失敗時も writeSentinel() 内で closeProgress() が呼ばれるのでリークしない。
var PSDESIGN_PROGRESS = null;
function writeProgress(current, total, message) {
  try {
    var f = new File(PROGRESS_PATH);
    f.encoding = "UTF-8";
    if (f.open("w")) {
      f.write(String(current) + "\t" + String(total) + "\t" + String(message || ""));
      f.close();
    }
  } catch (progressErr) {}
}
function initProgress(total) {
  PSDESIGN_PROGRESS = null;
  writeProgress(0, total, "Photoshop を準備しています...");
  return;
  try {
    var w = new Window("palette", "OPUS — PSD を保存中", undefined, { closeButton: false });
    w.orientation = "column";
    w.alignChildren = ["fill", "center"];
    w.margins = 16;
    w.spacing = 8;
    w.preferredSize.width = 380;
    w.pb = w.add("progressbar", undefined, 0, Math.max(1, total));
    w.pb.preferredSize.width = 340;
    w.status = w.add("statictext", undefined, "準備中...", { truncate: "middle" });
    w.status.preferredSize.width = 340;
    w.count = w.add("statictext", undefined, "0 / " + total);
    w.count.justify = "right";
    w.show();
    PSDESIGN_PROGRESS = w;
  } catch (e) {
    PSDESIGN_PROGRESS = null;
    $.writeln("[OPUS] progress init failed: " + e);
  }
}
function setProgress(current, total, message) {
  writeProgress(current, total, message);
  if (!PSDESIGN_PROGRESS) return;
  try {
    PSDESIGN_PROGRESS.pb.value = Math.min(current, PSDESIGN_PROGRESS.pb.maxvalue);
    if (typeof message === "string") PSDESIGN_PROGRESS.status.text = message;
    PSDESIGN_PROGRESS.count.text = current + " / " + total;
    PSDESIGN_PROGRESS.update();
  } catch (e) {}
}
function closeProgress() {
  if (!PSDESIGN_PROGRESS) return;
  try { PSDESIGN_PROGRESS.close(); } catch (e) {}
  PSDESIGN_PROGRESS = null;
}

function purgeOpusPhotoshopCaches() {
  try { app.purge(PurgeTarget.ALLCACHES); } catch (ePurgeAll) {
    try { app.purge(PurgeTarget.CLIPBOARDCACHE); } catch (ePurgeClip) {}
    try { app.purge(PurgeTarget.HISTORYCACHES); } catch (ePurgeHistory) {}
  }
}
function finishOpusPhotoshopSession() {
  try { purgeOpusPhotoshopCaches(); } catch (ePurge) {}
}

// Photoshop バージョン判定。CS6 (v13) 未満は string ID の一部が未登録の可能性が
// あるため、対象バージョンなら警告を出す。保存自体はそのまま試行する。
function photoshopVersion() {
  try {
    var v = parseFloat(app.version);
    return isNaN(v) ? 0 : v;
  } catch (eVer) { return 0; }
}

function writeSentinel(text) {
  // UI は結果を書き終える前に必ず閉じる（失敗時でも進捗パレットを残さない）。
  try { closeProgress(); } catch (closeErr) {}
  try {
    var payload = String(text);
    if (PSDESIGN_WARNINGS.length > 0 && payload.indexOf("ERROR") !== 0) {
      payload = payload + "|WARN " + PSDESIGN_WARNINGS.join(" | ");
    }
    if (typeof OPUS_FAILED_PSD_ENTRIES !== "undefined" && OPUS_FAILED_PSD_ENTRIES.length > 0 && payload.indexOf("ERROR") !== 0) {
      payload = payload + "|FAILED " + OPUS_FAILED_PSD_ENTRIES.join("\n");
    }
    var f = new File(SENTINEL_PATH);
    f.encoding = "UTF-8";
    f.open("w");
    f.write(payload);
    f.close();
  } catch (sentinelErr) {
    $.writeln("[OPUS] failed to write sentinel: " + sentinelErr);
  }
}

function blackColor() {
  var c = new SolidColor();
  c.rgb.red = 0;
  c.rgb.green = 0;
  c.rgb.blue = 0;
  return c;
}

function whiteColor() {
  var c = new SolidColor();
  c.rgb.red = 255;
  c.rgb.green = 255;
  c.rgb.blue = 255;
  return c;
}

function hexColor(name) {
  if (typeof name !== "string") return null;
  var m = /^#([0-9a-fA-F]{6})$/.exec(name);
  if (!m) return null;
  var hex = m[1];
  var c = new SolidColor();
  c.rgb.red = parseInt(hex.substring(0, 2), 16);
  c.rgb.green = parseInt(hex.substring(2, 4), 16);
  c.rgb.blue = parseInt(hex.substring(4, 6), 16);
  return c;
}

// name: "white" | "black" | "#rrggbb" | "default"（それ以外）。
// "default" は null を返し、呼び出し側で「色を変更しない」を選択。
function fillColorFor(name) {
  if (name === "white") return whiteColor();
  if (name === "black") return blackColor();
  var hex = hexColor(name);
  if (hex) return hex;
  return null;
}

function normalizeLineBreaks(s) {
  if (typeof s !== "string") return s;
  return s.replace(/\r\n/g, "\r").replace(/\n/g, "\r");
}

// 【v1.26.0】PSD 保存時、tateChuYokoEnabled が ON のときに連続ペア「！！」「！？」を
// 半角「!!」「!?」へ変換する。理由:
//   - Photoshop の縦中横 (baselineDirection: cross) は半角文字での動作が最も安定。
//     全角だと baselineDirection を当てても合成 glyph 化されず、結果ユーザー画面で
//     縦書きのまま残るケースがある (実機確認済み)。
//   - 連続 2 文字パターンだけ対象。単独の「！」は素通し (意図不明な単発を変換しない)。
//   - 単純な逐次 replace で OK: ！！ / ！？ を半角ペアに置換するだけ。
//     全角 → 半角は 1 文字 → 1 文字の置換なので、char index は保たれ、後段の
//     per-char 系 (applyLineLeadings / applyPerCharSizesAndFonts / applyPerCharBolds /
//     applyRubies / applySymbolFont / applyPunctuationTsume) も影響なし。
function normalizeFullWidthToHalfTcy(s, tcyEnabled) {
  if (!tcyEnabled) return s;
  if (typeof s !== "string") return s;
  // 元 PSD は全角や「合成文字」で組まれることが多い。縦中横で半角ペアにするため:
  //   - 単一の合成文字 ‼(U+203C) ⁇(U+2047) ⁈(U+2048) ⁉(U+2049) → 半角 2 文字へ展開
  //     （1 文字 → 2 文字に増えるので per-char マップとは併用しない前提。写植再利用は per-char なし）
  //   - 全角 2 連 ！！ / ！？ / ？！ / ？？ → 半角ペア（1:1）
  return s
    .replace(/‼/g, "!!")
    .replace(/⁇/g, "??")
    .replace(/⁈/g, "?!")
    .replace(/⁉/g, "!?")
    .replace(/！！/g, "!!")
    .replace(/！？/g, "!?")
    .replace(/？！/g, "?!")
    .replace(/？？/g, "??");
}

function isVerticalSingleColumnCenterRiskCharCode(c) {
  if (c === 0x0021 || c === 0x003F || c === 0xFF01 || c === 0xFF1F) return true;
  if (c === 0x003A || c === 0x003B || c === 0xFF1A || c === 0xFF1B ||
      c === 0x30FB || c === 0x2025 ||
      c === 0x2026) return true;
  if (c === 0x0028 || c === 0x0029 || c === 0x005B || c === 0x005D ||
      c === 0x007B || c === 0x007D || c === 0xFF08 || c === 0xFF09 ||
      c === 0x300C || c === 0x300D || c === 0x300E || c === 0x300F ||
      c === 0x3010 || c === 0x3011 || c === 0x3014 || c === 0x3015 ||
      c === 0x3016 || c === 0x3017 || c === 0x3018 || c === 0x3019 ||
      c === 0x301A || c === 0x301B || c === 0x301D || c === 0x301F) return true;
  if (c === 0x2010 || c === 0x2011 || c === 0x2012 || c === 0x2013 ||
      c === 0x2014 || c === 0x2015 || c === 0x2212 || c === 0x2500 ||
      c === 0x2501 || c === 0x30FC || c === 0x301C || c === 0xFF0D ||
      c === 0xFF5E || c === 0x007E) return true;
  if ((c >= 0x2190 && c <= 0x2193) ||
      (c >= 0x25A0 && c <= 0x25EF) ||
      (c >= 0x2600 && c <= 0x26FF)) return true;
  if (c === 0x3041 || c === 0x3043 || c === 0x3045 || c === 0x3047 ||
      c === 0x3049 || c === 0x3063 || c === 0x3083 || c === 0x3085 ||
      c === 0x3087 || c === 0x308E || c === 0x30A1 || c === 0x30A3 ||
      c === 0x30A5 || c === 0x30A7 || c === 0x30A9 || c === 0x30C3 ||
      c === 0x30E3 || c === 0x30E5 || c === 0x30E7 || c === 0x30EE ||
      c === 0x30F5 || c === 0x30F6) return true;
  return false;
}

function isVerticalRightEdgePunctuationCharCode(c) {
  return c === 0x002C || c === 0x002E || c === 0x3001 || c === 0x3002 ||
    c === 0xFF0C || c === 0xFF0E || c === 0xFF64 || c === 0xFF61;
}

function isVerticalRightEdgePunctuationText(s) {
  var text = String(s || "").replace(/\r\n?/g, "\n");
  if (text.length === 0 || text.indexOf("\n") >= 0) return false;
  for (var i = 0; i < text.length; i++) {
    if (!isVerticalRightEdgePunctuationCharCode(text.charCodeAt(i))) return false;
  }
  return true;
}

function isVerticalSingleColumnCenterRiskText(s) {
  var text = String(s || "").replace(/\r\n?/g, "\n");
  if (text.length === 0 || text.indexOf("\n") >= 0) return false;
  for (var i = 0; i < text.length; i++) {
    if (!isVerticalSingleColumnCenterRiskCharCode(text.charCodeAt(i))) return false;
  }
  return true;
}

function findLayerById(doc, id) {
  function walk(parent) {
    for (var i = 0; i < parent.layers.length; i++) {
      var l = parent.layers[i];
      try { if (l.id === id) return l; } catch (e) {}
      if (l.typename === "LayerSet") {
        var found = walk(l);
        if (found) return found;
      }
    }
    return null;
  }
  return walk(doc);
}

function rememberLayerInIdIndex(index, layer) {
  if (!index || !layer) return;
  try {
    var id = layer.id;
    if (typeof id !== "number") return;
    var key = String(id);
    if (typeof index[key] === "undefined") index[key] = layer;
  } catch (eIdx) {}
}

function buildLayerIdIndex(doc) {
  var index = {};
  function walk(parent) {
    if (!parent || !parent.layers) return;
    for (var i = 0; i < parent.layers.length; i++) {
      var l = parent.layers[i];
      rememberLayerInIdIndex(index, l);
      try {
        if (l.typename === "LayerSet") walk(l);
      } catch (eWalk) {}
    }
  }
  walk(doc);
  return index;
}

function findLayerByIdIndexed(doc, index, id) {
  if (index && typeof id === "number") {
    var key = String(id);
    if (typeof index[key] !== "undefined") return index[key];
  }
  return findLayerById(doc, id);
}

// PsDesign で配置した新規テキストレイヤーは、毎回ドキュメント直下に
// 新しいグループ ("text") を作って格納する。既存の "text" フォルダ
// （特に非表示にされているもの）はユーザーの意図的な構成なので
// 再利用しない / 可視化しない / 中身を触らない。重複名は Photoshop 側が
// "text 2" 等に自動採番してくれることがある（しなくても運用上問題なし）。
// 失敗時は null を返し、呼び出し側で doc 直下にフォールバックさせる。
function createNewTextGroupAtTop(doc) {
  var created = null;
  try {
    created = doc.layerSets.add();
  } catch (eAdd) {
    addWarning("text グループ作成に失敗: " + eAdd);
    return null;
  }
  // 先に最上部へ移動 → その後 名前 / 可視化 を設定する順にすると、
  // 一部 PS バージョンで move 後に name が "グループ N" にリセットされる
  // 不具合を回避できる。
  try {
    created.move(doc, ElementPlacement.PLACEATBEGINNING);
  } catch (eMove) {
    addWarning("text グループの最上部配置に失敗: " + eMove);
  }
  try {
    created.name = "text";
  } catch (eName) {
    addWarning("text グループの名前設定に失敗: " + eName);
  }
  try {
    created.visible = true;
  } catch (eVis) {}
  return created;
}

// ===== Photoshop Action Manager 用 string ID ラッパ =====
// Adobe 公式は CS6 以降 stringIDToTypeID を推奨。charID（4 文字コード）は
// 互換レイヤーで将来削除の可能性あり。ここで string ID ベースに統一して
// アップデート耐性を高める。
var sID = function (s) { return stringIDToTypeID(s); };
// 一部の日本語タイポグラフィ属性（tsume 等）は Photoshop の内部レジストリで
// stringID 名が安定して登録されていないバージョンがあり、stringIDToTypeID() が
// charID 経由の TypeID と異なる値を返して silently ignore されることがある。
// その場合は charID 経由の方が確実。検証済み: tsume = "PrTs", percentUnit = "#Prc"。
var cID = function (s) { return charIDToTypeID(s); };

function applyStrokeEffect(layerRef, opts) {
  if (!opts) return;
  var color = opts.color;
  var size = opts.size;
  if (!color || color === "none" || !(size > 0)) {
    try { disableStrokeEffect(layerRef); } catch (eDis) {}
    return;
  }
  app.activeDocument.activeLayer = layerRef;
  var rgb = (color === "white") ? [255, 255, 255] : [0, 0, 0];

  var desc = new ActionDescriptor();
  var ref = new ActionReference();
  ref.putProperty(sID("property"), sID("layerEffects"));
  ref.putEnumerated(sID("layer"), sID("ordinal"), sID("targetEnum"));
  desc.putReference(sID("null"), ref);

  var fx = new ActionDescriptor();
  fx.putUnitDouble(sID("scale"), sID("percentUnit"), 100);

  var stroke = new ActionDescriptor();
  stroke.putBoolean(sID("enabled"), true);
  stroke.putBoolean(sID("present"), true);
  stroke.putBoolean(sID("showInDialog"), true);
  stroke.putEnumerated(sID("style"), sID("frameStyle"), sID("outsetFrame"));
  stroke.putEnumerated(sID("paintType"), sID("frameFill"), sID("solidColor"));
  stroke.putEnumerated(sID("mode"), sID("blendMode"), sID("normal"));
  stroke.putUnitDouble(sID("opacity"), sID("percentUnit"), 100);
  stroke.putUnitDouble(sID("size"), sID("pixelsUnit"), size);
  stroke.putBoolean(sID("antiAlias"), true);

  var c = new ActionDescriptor();
  c.putDouble(sID("red"), rgb[0]);
  c.putDouble(sID("green"), rgb[1]);
  c.putDouble(sID("blue"), rgb[2]);
  stroke.putObject(sID("color"), sID("RGBColor"), c);

  fx.putObject(sID("frameFX"), sID("frameFX"), stroke);
  desc.putObject(sID("to"), sID("layerEffects"), fx);
  executeAction(sID("set"), desc, DialogModes.NO);
}

// ===== 行ごとの行間（per-line leading）適用 =====
// Photoshop は per-character leading なので、Action Manager で textKey を取得して
// textStyleRange を行単位にバラし、override がある行だけ autoLeading=false + 絶対 leading
// に置換する。ベースの textStyle は 1 つ目から複製して継承する。

function isObjEmpty(o) {
  if (!o) return true;
  for (var k in o) if (o.hasOwnProperty(k)) return false;
  return true;
}

function scaleRubyAbsoluteCoords(charRubies, sx, sy) {
  if (!charRubies || isObjEmpty(charRubies)) return charRubies;
  if (!(typeof sx === "number" && isFinite(sx) && sx > 0)) sx = 1;
  if (!(typeof sy === "number" && isFinite(sy) && sy > 0)) sy = 1;
  if (Math.abs(sx - 1) < 0.000001 && Math.abs(sy - 1) < 0.000001) return charRubies;
  var out = {};
  for (var k in charRubies) {
    if (!charRubies.hasOwnProperty(k)) continue;
    var e = charRubies[k];
    if (!e) continue;
    var c = {};
    for (var p in e) if (e.hasOwnProperty(p)) c[p] = e[p];
    if (typeof c.absX === "number" && isFinite(c.absX)) c.absX = c.absX * sx;
    if (typeof c.absY === "number" && isFinite(c.absY)) c.absY = c.absY * sy;
    out[k] = c;
  }
  return out;
}

function buildRubyLineLeadings(contents, charRubies, explicitLineLeadings, rubyLeadingPct) {
  var out = {};
  var hasAny = false;
  if (explicitLineLeadings) {
    for (var k in explicitLineLeadings) {
      if (!explicitLineLeadings.hasOwnProperty(k)) continue;
      var explicitPct = explicitLineLeadings[k];
      if (typeof explicitPct === "number" && isFinite(explicitPct) && explicitPct > 0) {
        out[String(k)] = explicitPct;
        hasAny = true;
      }
    }
  }
  if (charRubies && !isObjEmpty(charRubies) &&
      typeof rubyLeadingPct === "number" && isFinite(rubyLeadingPct) && rubyLeadingPct > 0) {
    var rubyLines = computeRubyLineIndices(contents, charRubies, "vertical");
    for (var i = 0; i < rubyLines.length; i++) {
      var idx = parseInt(rubyLines[i], 10);
      if (isNaN(idx) || idx < 0) continue;
      // Preserve a user-edited per-line leading. Ruby defaults are only a
      // fallback for ruby-bearing lines that do not already have an override.
      if (typeof out[String(idx)] !== "number") {
        out[String(idx)] = rubyLeadingPct;
        hasAny = true;
      }
    }
  }
  return hasAny ? out : null;
}

function copyDescKey(src, dst, key) {
  var t = src.getType(key);
  switch (t) {
    case DescValueType.STRINGTYPE:    dst.putString(key, src.getString(key)); break;
    case DescValueType.INTEGERTYPE:   dst.putInteger(key, src.getInteger(key)); break;
    case DescValueType.LARGEINTEGERTYPE: dst.putLargeInteger(key, src.getLargeInteger(key)); break;
    case DescValueType.DOUBLETYPE:    dst.putDouble(key, src.getDouble(key)); break;
    case DescValueType.BOOLEANTYPE:   dst.putBoolean(key, src.getBoolean(key)); break;
    case DescValueType.UNITDOUBLE:    dst.putUnitDouble(key, src.getUnitDoubleType(key), src.getUnitDoubleValue(key)); break;
    case DescValueType.ENUMERATEDTYPE: dst.putEnumerated(key, src.getEnumerationType(key), src.getEnumerationValue(key)); break;
    case DescValueType.OBJECTTYPE:    dst.putObject(key, src.getObjectType(key), cloneActionDescriptor(src.getObjectValue(key))); break;
    case DescValueType.LISTTYPE:      dst.putList(key, cloneActionList(src.getList(key))); break;
    case DescValueType.REFERENCETYPE: dst.putReference(key, src.getReference(key)); break;
    case DescValueType.CLASSTYPE:     dst.putClass(key, src.getClass(key)); break;
    case DescValueType.ALIASTYPE:     dst.putPath(key, src.getPath(key)); break;
    case DescValueType.RAWTYPE:       dst.putData(key, src.getData(key)); break;
  }
}

function cloneActionDescriptor(d) {
  var c = new ActionDescriptor();
  for (var i = 0; i < d.count; i++) {
    var key = d.getKey(i);
    copyDescKey(d, c, key);
  }
  return c;
}

function cloneActionList(srcList) {
  var dst = new ActionList();
  for (var i = 0; i < srcList.count; i++) {
    var t = srcList.getType(i);
    switch (t) {
      case DescValueType.STRINGTYPE:    dst.putString(srcList.getString(i)); break;
      case DescValueType.INTEGERTYPE:   dst.putInteger(srcList.getInteger(i)); break;
      case DescValueType.DOUBLETYPE:    dst.putDouble(srcList.getDouble(i)); break;
      case DescValueType.BOOLEANTYPE:   dst.putBoolean(srcList.getBoolean(i)); break;
      case DescValueType.UNITDOUBLE:    dst.putUnitDouble(srcList.getUnitDoubleType(i), srcList.getUnitDoubleValue(i)); break;
      case DescValueType.ENUMERATEDTYPE: dst.putEnumerated(srcList.getEnumerationType(i), srcList.getEnumerationValue(i)); break;
      case DescValueType.OBJECTTYPE:    dst.putObject(srcList.getObjectType(i), cloneActionDescriptor(srcList.getObjectValue(i))); break;
      case DescValueType.LISTTYPE:      dst.putList(cloneActionList(srcList.getList(i))); break;
      case DescValueType.REFERENCETYPE: dst.putReference(srcList.getReference(i)); break;
      case DescValueType.CLASSTYPE:     dst.putClass(srcList.getClass(i)); break;
    }
  }
  return dst;
}

function applyLineLeadings(layer, lineLeadings, contents, fontSizePt) {
  if (isObjEmpty(lineLeadings)) return;
  app.activeDocument.activeLayer = layer;

  var layerRef = new ActionReference();
  layerRef.putEnumerated(sID("layer"), sID("ordinal"), sID("targetEnum"));
  var layerDesc = executeActionGet(layerRef);
  if (!layerDesc.hasKey(sID("textKey"))) return;
  var textKey = layerDesc.getObjectValue(sID("textKey"));

  var oldRanges = textKey.getList(sID("textStyleRange"));
  if (oldRanges.count === 0) return;
  var baseStyle = oldRanges.getObjectValue(0).getObjectValue(sID("textStyle"));

  var sourceText = String(contents);
  var lines = [];
  var lineBreakRe = /\r\n|\r|\n/g;
  var lineStart = 0;
  var lineBreak;
  while ((lineBreak = lineBreakRe.exec(sourceText)) !== null) {
    lines.push({
      text: sourceText.substring(lineStart, lineBreak.index),
      breakLength: lineBreak[0].length
    });
    lineStart = lineBreak.index + lineBreak[0].length;
  }
  lines.push({
    text: sourceText.substring(lineStart),
    breakLength: 0
  });
  var newRangeList = new ActionList();
  var pos = 0;
  for (var i = 0; i < lines.length; i++) {
    var len = lines[i].text.length;
    var startChar = pos;
    var endChar = pos + len + lines[i].breakLength;

    var styleClone = cloneActionDescriptor(baseStyle);
    var pct = lineLeadings[String(i)];
    if (typeof pct === "number") {
      styleClone.putBoolean(sID("autoLeading"), false);
      styleClone.putUnitDouble(sID("leading"), sID("pointsUnit"), fontSizePt * (pct / 100));
    } else {
      styleClone.putBoolean(sID("autoLeading"), true);
    }

    var rangeDesc = new ActionDescriptor();
    rangeDesc.putInteger(sID("from"), startChar);
    rangeDesc.putInteger(sID("to"), endChar);
    rangeDesc.putObject(sID("textStyle"), sID("textStyle"), styleClone);
    newRangeList.putObject(sID("textStyleRange"), rangeDesc);
    pos = endChar;
  }

  var newTextKey = cloneActionDescriptor(textKey);
  newTextKey.putList(sID("textStyleRange"), newRangeList);

  var setDesc = new ActionDescriptor();
  setDesc.putReference(sID("null"), layerRef);
  setDesc.putObject(sID("to"), sID("textLayer"), newTextKey);
  executeAction(sID("set"), setDesc, DialogModes.NO);
}

// ===== 文字ごとの サイズ・フォント (per-char) =====
// charSizes: { "0": 18, "5": 24, ... }   絶対 char index → pt 値
// charFonts: { "0": "PostScriptName", ... } 絶対 char index → PostScript 名
//
// 既存の textStyleRange を baseStyle として clone-and-replace。各 char の所属 range を
// 記録して (srcRangeIndex, sizePt, fontPs) が同じ連続文字を 1 セグメントに圧縮。
// applyLineLeadings 後に呼ぶことで、行間設定と per-char 設定が共存できる
// （baseStyle は前段で再構築された textStyleRange から clone される）。
//
// set の class には sID("textLayer") を使う。"textKey" だと Photoshop が
// 渡された textStyleRange を破棄して既存値を保持するケースがあるため、
// per-character スタイル変更は applyRepeatedDashTracking と同様 "textLayer" で set する。
function applyPerCharSizesAndFonts(layer, contents, charSizes, charFonts) {
  var hasSizes = charSizes && !isObjEmpty(charSizes);
  var hasFonts = charFonts && !isObjEmpty(charFonts);
  if (!hasSizes && !hasFonts) return;
  app.activeDocument.activeLayer = layer;

  var layerRef = new ActionReference();
  layerRef.putEnumerated(sID("layer"), sID("ordinal"), sID("targetEnum"));
  var layerDesc = executeActionGet(layerRef);
  if (!layerDesc.hasKey(sID("textKey"))) return;
  var textKey = layerDesc.getObjectValue(sID("textKey"));

  var oldRanges = textKey.getList(sID("textStyleRange"));
  if (oldRanges.count === 0) return;

  // 各 char の所属 range index を事前構築。
  var srcRangeIndex = [];
  var totalChars = 0;
  for (var r = 0; r < oldRanges.count; r++) {
    var rd = oldRanges.getObjectValue(r);
    var fromCh = rd.getInteger(sID("from"));
    var toCh = rd.getInteger(sID("to"));
    if (toCh > totalChars) totalChars = toCh;
    for (var c = fromCh; c < toCh; c++) srcRangeIndex[c] = r;
  }
  if (totalChars === 0) return;

  function readSize(idx) {
    var v = charSizes ? charSizes[String(idx)] : undefined;
    return (typeof v === "number") ? v : null;
  }
  function readFont(idx) {
    var v = charFonts ? charFonts[String(idx)] : undefined;
    return (typeof v === "string" && v.length > 0) ? v : null;
  }

  // 連続する同 (srcRange, size, font) 文字を 1 セグメントに圧縮。
  var newRangeList = new ActionList();
  if (typeof srcRangeIndex[0] !== "number") srcRangeIndex[0] = 0;
  var curStart = 0;
  var curSrc = srcRangeIndex[0];
  var curSize = readSize(0);
  var curFont = readFont(0);

  for (var p = 1; p <= totalChars; p++) {
    var nextSrc, nextSize, nextFont, boundary;
    if (p === totalChars) {
      boundary = true;
      nextSrc = curSrc; nextSize = curSize; nextFont = curFont;
    } else {
      nextSrc = (typeof srcRangeIndex[p] === "number") ? srcRangeIndex[p] : curSrc;
      nextSize = readSize(p);
      nextFont = readFont(p);
      boundary = (nextSrc !== curSrc) || (nextSize !== curSize) || (nextFont !== curFont);
    }
    if (boundary) {
      var srcRange = oldRanges.getObjectValue(curSrc);
      var srcStyle = srcRange.getObjectValue(sID("textStyle"));
      var styleClone = cloneActionDescriptor(srcStyle);
      if (curSize !== null) {
        try { styleClone.putUnitDouble(sID("size"), sID("pointsUnit"), curSize); } catch (eSz) {}
      }
      if (curFont !== null) {
        // 【v2.x】per-char フォントも Photoshop 認識 PS 名に解決してから書く。
        // cache 経由なので同じフォント名の連続では実質コスト 0。
        try { styleClone.putString(sID("fontPostScriptName"), resolvePhotoshopFontPS(curFont)); } catch (eFn) {}
      }
      var newRangeDesc = new ActionDescriptor();
      newRangeDesc.putInteger(sID("from"), curStart);
      newRangeDesc.putInteger(sID("to"), p);
      newRangeDesc.putObject(sID("textStyle"), sID("textStyle"), styleClone);
      newRangeList.putObject(sID("textStyleRange"), newRangeDesc);
      curStart = p;
      curSrc = nextSrc;
      curSize = nextSize;
      curFont = nextFont;
    }
  }

  var newTextKey = cloneActionDescriptor(textKey);
  newTextKey.putList(sID("textStyleRange"), newRangeList);
  var setDesc = new ActionDescriptor();
  setDesc.putReference(sID("null"), layerRef);
  setDesc.putObject(sID("to"), sID("textLayer"), newTextKey);
  executeAction(sID("set"), setDesc, DialogModes.NO);
}

function rgbDescriptorForFillColor(name) {
  var c = fillColorFor(name);
  if (!c) return null;
  var d = new ActionDescriptor();
  d.putDouble(sID("red"), c.rgb.red);
  d.putDouble(sID("green"), c.rgb.green);
  d.putDouble(sID("blue"), c.rgb.blue);
  return d;
}

function applyPerCharFillColors(layer, contents, charFillColors) {
  if (!charFillColors || isObjEmpty(charFillColors)) return;
  app.activeDocument.activeLayer = layer;

  var layerRef = new ActionReference();
  layerRef.putEnumerated(sID("layer"), sID("ordinal"), sID("targetEnum"));
  var layerDesc = executeActionGet(layerRef);
  if (!layerDesc.hasKey(sID("textKey"))) return;
  var textKey = layerDesc.getObjectValue(sID("textKey"));

  var oldRanges = textKey.getList(sID("textStyleRange"));
  if (oldRanges.count === 0) return;

  var srcRangeIndex = [];
  var totalChars = 0;
  for (var r = 0; r < oldRanges.count; r++) {
    var rd = oldRanges.getObjectValue(r);
    var fromCh = rd.getInteger(sID("from"));
    var toCh = rd.getInteger(sID("to"));
    if (toCh > totalChars) totalChars = toCh;
    for (var c = fromCh; c < toCh; c++) srcRangeIndex[c] = r;
  }
  if (totalChars === 0) return;

  function readFill(idx) {
    var v = charFillColors ? charFillColors[String(idx)] : undefined;
    if (typeof v !== "string" || v.length === 0 || v === "default") return null;
    return rgbDescriptorForFillColor(v);
  }

  var newRangeList = new ActionList();
  if (typeof srcRangeIndex[0] !== "number") srcRangeIndex[0] = 0;
  var curStart = 0;
  var curSrc = srcRangeIndex[0];
  var curFill = readFill(0);

  for (var p = 1; p <= totalChars; p++) {
    var nextSrc, nextFill, boundary;
    if (p === totalChars) {
      boundary = true;
      nextSrc = curSrc; nextFill = curFill;
    } else {
      nextSrc = (typeof srcRangeIndex[p] === "number") ? srcRangeIndex[p] : curSrc;
      nextFill = readFill(p);
      boundary = (nextSrc !== curSrc) || ((curFill === null) !== (nextFill === null));
      if (!boundary && curFill !== null && nextFill !== null) boundary = true;
    }
    if (boundary) {
      var srcRange = oldRanges.getObjectValue(curSrc);
      var srcStyle = srcRange.getObjectValue(sID("textStyle"));
      var styleClone = cloneActionDescriptor(srcStyle);
      if (curFill !== null) {
        try { styleClone.putObject(sID("color"), sID("RGBColor"), curFill); } catch (eColor) {}
      }
      var newRangeDesc = new ActionDescriptor();
      newRangeDesc.putInteger(sID("from"), curStart);
      newRangeDesc.putInteger(sID("to"), p);
      newRangeDesc.putObject(sID("textStyle"), sID("textStyle"), styleClone);
      newRangeList.putObject(sID("textStyleRange"), newRangeDesc);
      curStart = p;
      curSrc = nextSrc;
      curFill = nextFill;
    }
  }

  var newTextKey = cloneActionDescriptor(textKey);
  newTextKey.putList(sID("textStyleRange"), newRangeList);
  var setDesc = new ActionDescriptor();
  setDesc.putReference(sID("null"), layerRef);
  setDesc.putObject(sID("to"), sID("textLayer"), newTextKey);
  executeAction(sID("set"), setDesc, DialogModes.NO);
}

// 【v1.22.0】===== 文字ごとの合成太字（faux bold / syntheticBold） =====
// charBolds: { "0": true, "5": false, ... } 絶対 char index → bool 値
// layerBold: layer 全体の bold flag (boolean)。char 個別指定が無い文字に適用。
//
// applyPerCharSizesAndFonts と同型の clone-and-replace。layerBold が true で
// charBolds が空の場合でも全 char に true をセットしたいので、layerBold あり
// または charBolds あり のどちらかで処理を起動する。
function normalizeTextScalePercent(v) {
  if (typeof v !== "number" || !isFinite(v)) return null;
  return Math.max(10, Math.min(400, Math.round(v)));
}

function putTextScaleKeys(styleDesc, horizontalScale, verticalScale) {
  var hs = normalizeTextScalePercent(horizontalScale);
  var vs = normalizeTextScalePercent(verticalScale);
  if (hs !== null) {
    try { styleDesc.putUnitDouble(sID("horizontalScale"), sID("percentUnit"), hs); } catch (eHs) {}
  }
  if (vs !== null) {
    try { styleDesc.putUnitDouble(sID("verticalScale"), sID("percentUnit"), vs); } catch (eVs) {}
  }
}

function applyLayerTextScales(layer, horizontalScale, verticalScale) {
  if (normalizeTextScalePercent(horizontalScale) === null && normalizeTextScalePercent(verticalScale) === null) return;
  app.activeDocument.activeLayer = layer;
  var layerRef = new ActionReference();
  layerRef.putEnumerated(sID("layer"), sID("ordinal"), sID("targetEnum"));
  var layerDesc = executeActionGet(layerRef);
  if (!layerDesc.hasKey(sID("textKey"))) return;
  var textKey = layerDesc.getObjectValue(sID("textKey"));
  var oldRanges = textKey.getList(sID("textStyleRange"));
  if (oldRanges.count === 0) return;
  var newRangeList = new ActionList();
  for (var r = 0; r < oldRanges.count; r++) {
    var srcRange = oldRanges.getObjectValue(r);
    var styleClone = cloneActionDescriptor(srcRange.getObjectValue(sID("textStyle")));
    putTextScaleKeys(styleClone, horizontalScale, verticalScale);
    var rangeDesc = new ActionDescriptor();
    rangeDesc.putInteger(sID("from"), srcRange.getInteger(sID("from")));
    rangeDesc.putInteger(sID("to"), srcRange.getInteger(sID("to")));
    rangeDesc.putObject(sID("textStyle"), sID("textStyle"), styleClone);
    newRangeList.putObject(sID("textStyleRange"), rangeDesc);
  }
  var newTextKey = cloneActionDescriptor(textKey);
  newTextKey.putList(sID("textStyleRange"), newRangeList);
  var setDesc = new ActionDescriptor();
  setDesc.putReference(sID("null"), layerRef);
  setDesc.putObject(sID("to"), sID("textLayer"), newTextKey);
  executeAction(sID("set"), setDesc, DialogModes.NO);
}

function applyPerCharTextScales(layer, contents, charHorizontalScales, charVerticalScales) {
  var hasH = charHorizontalScales && !isObjEmpty(charHorizontalScales);
  var hasV = charVerticalScales && !isObjEmpty(charVerticalScales);
  if (!hasH && !hasV) return;
  app.activeDocument.activeLayer = layer;
  var layerRef = new ActionReference();
  layerRef.putEnumerated(sID("layer"), sID("ordinal"), sID("targetEnum"));
  var layerDesc = executeActionGet(layerRef);
  if (!layerDesc.hasKey(sID("textKey"))) return;
  var textKey = layerDesc.getObjectValue(sID("textKey"));
  var oldRanges = textKey.getList(sID("textStyleRange"));
  if (oldRanges.count === 0) return;
  var srcRangeIndex = [];
  var totalChars = 0;
  for (var r = 0; r < oldRanges.count; r++) {
    var rd = oldRanges.getObjectValue(r);
    var fromCh = rd.getInteger(sID("from"));
    var toCh = rd.getInteger(sID("to"));
    if (toCh > totalChars) totalChars = toCh;
    for (var c = fromCh; c < toCh; c++) srcRangeIndex[c] = r;
  }
  if (totalChars === 0) return;
  function readScale(map, idx) {
    var v = map ? map[String(idx)] : undefined;
    return (typeof v === "number") ? normalizeTextScalePercent(v) : null;
  }
  var newRangeList = new ActionList();
  if (typeof srcRangeIndex[0] !== "number") srcRangeIndex[0] = 0;
  var curStart = 0;
  var curSrc = srcRangeIndex[0];
  var curH = readScale(charHorizontalScales, 0);
  var curV = readScale(charVerticalScales, 0);
  for (var p = 1; p <= totalChars; p++) {
    var nextSrc, nextH, nextV, boundary;
    if (p === totalChars) {
      boundary = true;
      nextSrc = curSrc; nextH = curH; nextV = curV;
    } else {
      nextSrc = (typeof srcRangeIndex[p] === "number") ? srcRangeIndex[p] : curSrc;
      nextH = readScale(charHorizontalScales, p);
      nextV = readScale(charVerticalScales, p);
      boundary = (nextSrc !== curSrc) || (nextH !== curH) || (nextV !== curV);
    }
    if (boundary) {
      var srcRange = oldRanges.getObjectValue(curSrc);
      var styleClone = cloneActionDescriptor(srcRange.getObjectValue(sID("textStyle")));
      putTextScaleKeys(styleClone, curH, curV);
      var rangeDesc = new ActionDescriptor();
      rangeDesc.putInteger(sID("from"), curStart);
      rangeDesc.putInteger(sID("to"), p);
      rangeDesc.putObject(sID("textStyle"), sID("textStyle"), styleClone);
      newRangeList.putObject(sID("textStyleRange"), rangeDesc);
      curStart = p;
      curSrc = nextSrc;
      curH = nextH;
      curV = nextV;
    }
  }
  var newTextKey = cloneActionDescriptor(textKey);
  newTextKey.putList(sID("textStyleRange"), newRangeList);
  var setDesc = new ActionDescriptor();
  setDesc.putReference(sID("null"), layerRef);
  setDesc.putObject(sID("to"), sID("textLayer"), newTextKey);
  executeAction(sID("set"), setDesc, DialogModes.NO);
}

function normalizeTextSpacingMille(v) {
  if (typeof v !== "number" || !isFinite(v)) return null;
  return Math.max(-1000, Math.min(1000, Math.round(v)));
}

function putTrackingValue(styleDesc, value) {
  var n = normalizeTextSpacingMille(value);
  if (n === null) return;
  try { styleDesc.putInteger(sID("tracking"), n); } catch (eTrackA) {}
  try { styleDesc.putInteger(cID("Trck"), n); } catch (eTrackB) {}
}

function addKerningRange(list, from, to, value) {
  var n = normalizeTextSpacingMille(value);
  if (n === null) return;
  var kernDesc = new ActionDescriptor();
  kernDesc.putInteger(sID("from"), from);
  kernDesc.putInteger(sID("to"), to);
  kernDesc.putInteger(sID("kerning"), n);
  list.putObject(sID("kerningRange"), kernDesc);
}

function applyLayerTextSpacing(layer, trackingMille, kerningMille) {
  var tr = normalizeTextSpacingMille(trackingMille);
  var kr = normalizeTextSpacingMille(kerningMille);
  if (tr === 0) tr = null;
  if (kr === 0) kr = null;
  if (tr === null && kr === null) return;
  app.activeDocument.activeLayer = layer;
  var layerRef = new ActionReference();
  layerRef.putEnumerated(sID("layer"), sID("ordinal"), sID("targetEnum"));
  var layerDesc = executeActionGet(layerRef);
  if (!layerDesc.hasKey(sID("textKey"))) return;
  var textKey = layerDesc.getObjectValue(sID("textKey"));
  var oldRanges = textKey.getList(sID("textStyleRange"));
  var newTextKey = cloneActionDescriptor(textKey);
  if (tr !== null && oldRanges.count > 0) {
    var newRangeList = new ActionList();
    for (var r = 0; r < oldRanges.count; r++) {
      var srcRange = oldRanges.getObjectValue(r);
      var styleClone = cloneActionDescriptor(srcRange.getObjectValue(sID("textStyle")));
      putTrackingValue(styleClone, tr);
      var rangeDesc = new ActionDescriptor();
      rangeDesc.putInteger(sID("from"), srcRange.getInteger(sID("from")));
      rangeDesc.putInteger(sID("to"), srcRange.getInteger(sID("to")));
      rangeDesc.putObject(sID("textStyle"), sID("textStyle"), styleClone);
      newRangeList.putObject(sID("textStyleRange"), rangeDesc);
    }
    newTextKey.putList(sID("textStyleRange"), newRangeList);
  }
  if (kr !== null) {
    var kernList = new ActionList();
    var totalChars = 0;
    for (var rr = 0; rr < oldRanges.count; rr++) {
      var rd = oldRanges.getObjectValue(rr);
      var toCh = rd.getInteger(sID("to"));
      if (toCh > totalChars) totalChars = toCh;
    }
    for (var k = Math.max(0, totalChars - 2); k >= 0; k--) addKerningRange(kernList, k, k + 1, kr);
    newTextKey.putList(sID("kerningRange"), kernList);
  }
  var setDesc = new ActionDescriptor();
  setDesc.putReference(sID("null"), layerRef);
  setDesc.putObject(sID("to"), sID("textLayer"), newTextKey);
  executeAction(sID("set"), setDesc, DialogModes.NO);
}

function applyPerCharTextSpacing(layer, contents, charTrackings, charKernings) {
  var hasT = charTrackings && !isObjEmpty(charTrackings);
  var hasK = charKernings && !isObjEmpty(charKernings);
  if (!hasT && !hasK) return;
  app.activeDocument.activeLayer = layer;
  var layerRef = new ActionReference();
  layerRef.putEnumerated(sID("layer"), sID("ordinal"), sID("targetEnum"));
  var layerDesc = executeActionGet(layerRef);
  if (!layerDesc.hasKey(sID("textKey"))) return;
  var textKey = layerDesc.getObjectValue(sID("textKey"));
  var oldRanges = textKey.getList(sID("textStyleRange"));
  if (oldRanges.count === 0) return;
  var srcRangeIndex = [];
  var totalChars = 0;
  for (var r = 0; r < oldRanges.count; r++) {
    var rd = oldRanges.getObjectValue(r);
    var fromCh = rd.getInteger(sID("from"));
    var toCh = rd.getInteger(sID("to"));
    if (toCh > totalChars) totalChars = toCh;
    for (var c = fromCh; c < toCh; c++) srcRangeIndex[c] = r;
  }
  if (totalChars === 0) return;
  function readSpacing(map, idx) {
    var v = map ? map[String(idx)] : undefined;
    return (typeof v === "number") ? normalizeTextSpacingMille(v) : null;
  }
  function isOpeningManualTsumeChar(idx) {
    if (!contents || idx < 0 || idx >= contents.length) return false;
    var c = String(contents).charCodeAt(idx);
    return c === 0x300C || c === 0x3010 || c === 0x3014 ||
           c === 0x3016 || c === 0x3018 || c === 0x301A ||
           c === 0x301D || c === 0xFF08;
  }
  function openingTsumePct(idx) {
    if (!isOpeningManualTsumeChar(idx)) return 0;
    var total = 0;
    var tv = readSpacing(charTrackings, idx);
    var kv = readSpacing(charKernings, idx);
    if (tv !== null && tv < 0) total += tv;
    if (kv !== null && kv < 0) total += kv;
    if (total >= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((-total) / 10)));
  }
  function trackingForStyle(idx) {
    var v = readSpacing(charTrackings, idx);
    return (v !== null && v < 0 && openingTsumePct(idx) > 0) ? null : v;
  }
  var hasOpeningTsume = false;
  for (var oi = 0; oi < totalChars; oi++) {
    if (openingTsumePct(oi) > 0) { hasOpeningTsume = true; break; }
  }
  var newTextKey = cloneActionDescriptor(textKey);
  if (hasT || hasOpeningTsume) {
    var newRangeList = new ActionList();
    if (typeof srcRangeIndex[0] !== "number") srcRangeIndex[0] = 0;
    var keyTsume = sID("mojiZume");
    var keyPctUnit = sID("percentUnit");
    var curStart = 0;
    var curSrc = srcRangeIndex[0];
    var curT = trackingForStyle(0);
    var curTsume = openingTsumePct(0);
    for (var p = 1; p <= totalChars; p++) {
      var nextSrc, nextT, nextTsume, boundary;
      if (p === totalChars) {
        boundary = true; nextSrc = curSrc; nextT = curT; nextTsume = curTsume;
      } else {
        nextSrc = (typeof srcRangeIndex[p] === "number") ? srcRangeIndex[p] : curSrc;
        nextT = trackingForStyle(p);
        nextTsume = openingTsumePct(p);
        boundary = (nextSrc !== curSrc) || (nextT !== curT) || (nextTsume !== curTsume);
      }
      if (boundary) {
        var srcRange = oldRanges.getObjectValue(curSrc);
        var styleClone = cloneActionDescriptor(srcRange.getObjectValue(sID("textStyle")));
        putTrackingValue(styleClone, curT);
        if (curTsume > 0) {
          try { styleClone.putUnitDouble(keyTsume, keyPctUnit, curTsume / 100); } catch (eTs) {}
        }
        var rangeDesc = new ActionDescriptor();
        rangeDesc.putInteger(sID("from"), curStart);
        rangeDesc.putInteger(sID("to"), p);
        rangeDesc.putObject(sID("textStyle"), sID("textStyle"), styleClone);
        newRangeList.putObject(sID("textStyleRange"), rangeDesc);
        curStart = p; curSrc = nextSrc; curT = nextT; curTsume = nextTsume;
      }
    }
    newTextKey.putList(sID("textStyleRange"), newRangeList);
  }
  if (hasK) {
    var kernList = new ActionList();
    for (var k = Math.max(0, totalChars - 2); k >= 0; k--) {
      var kv = readSpacing(charKernings, k);
      if (kv !== null && kv < 0 && openingTsumePct(k) > 0) continue;
      if (kv !== null) addKerningRange(kernList, k, k + 1, kv);
    }
    newTextKey.putList(sID("kerningRange"), kernList);
  }
  var setDesc = new ActionDescriptor();
  setDesc.putReference(sID("null"), layerRef);
  setDesc.putObject(sID("to"), sID("textLayer"), newTextKey);
  executeAction(sID("set"), setDesc, DialogModes.NO);
}

function applyPerCharBolds(layer, contents, charBolds, layerBold) {
  var hasChar = charBolds && !isObjEmpty(charBolds);
  var lb = layerBold === true;
  if (!hasChar && !lb) return;
  app.activeDocument.activeLayer = layer;

  var layerRef = new ActionReference();
  layerRef.putEnumerated(sID("layer"), sID("ordinal"), sID("targetEnum"));
  var layerDesc = executeActionGet(layerRef);
  if (!layerDesc.hasKey(sID("textKey"))) return;
  var textKey = layerDesc.getObjectValue(sID("textKey"));

  var oldRanges = textKey.getList(sID("textStyleRange"));
  if (oldRanges.count === 0) return;

  var srcRangeIndex = [];
  var totalChars = 0;
  for (var r = 0; r < oldRanges.count; r++) {
    var rd = oldRanges.getObjectValue(r);
    var fromCh = rd.getInteger(sID("from"));
    var toCh = rd.getInteger(sID("to"));
    if (toCh > totalChars) totalChars = toCh;
    for (var c = fromCh; c < toCh; c++) srcRangeIndex[c] = r;
  }
  if (totalChars === 0) return;

  // 各 char の effective bold を解決: charBolds[i] があれば優先、無ければ layerBold。
  function readBold(idx) {
    if (charBolds) {
      var v = charBolds[String(idx)];
      if (typeof v === "boolean") return v;
    }
    return lb;
  }

  // 連続する同 (srcRange, bold) 文字を 1 セグメントに圧縮。
  var newRangeList = new ActionList();
  if (typeof srcRangeIndex[0] !== "number") srcRangeIndex[0] = 0;
  var curStart = 0;
  var curSrc = srcRangeIndex[0];
  var curBold = readBold(0);

  for (var p = 1; p <= totalChars; p++) {
    var nextSrc, nextBold, boundary;
    if (p === totalChars) {
      boundary = true;
      nextSrc = curSrc; nextBold = curBold;
    } else {
      nextSrc = (typeof srcRangeIndex[p] === "number") ? srcRangeIndex[p] : curSrc;
      nextBold = readBold(p);
      boundary = (nextSrc !== curSrc) || (nextBold !== curBold);
    }
    if (boundary) {
      var srcRange = oldRanges.getObjectValue(curSrc);
      var srcStyle = srcRange.getObjectValue(sID("textStyle"));
      var styleClone = cloneActionDescriptor(srcStyle);
      try { styleClone.putBoolean(sID("syntheticBold"), curBold === true); } catch (eSB) {}
      var newRangeDesc = new ActionDescriptor();
      newRangeDesc.putInteger(sID("from"), curStart);
      newRangeDesc.putInteger(sID("to"), p);
      newRangeDesc.putObject(sID("textStyle"), sID("textStyle"), styleClone);
      newRangeList.putObject(sID("textStyleRange"), newRangeDesc);
      curStart = p;
      curSrc = nextSrc;
      curBold = nextBold;
    }
  }

  var newTextKey = cloneActionDescriptor(textKey);
  newTextKey.putList(sID("textStyleRange"), newRangeList);
  var setDesc = new ActionDescriptor();
  setDesc.putReference(sID("null"), layerRef);
  // 他の per-char 関数と同じく "textLayer" class で set。
  setDesc.putObject(sID("to"), sID("textLayer"), newTextKey);
  executeAction(sID("set"), setDesc, DialogModes.NO);
}

// 【v1.29.x】===== ルビあり行の autoLeadingPercentage 上書き =====
// 参考: 共有プラグイン (panels/ruby/index.js) の runApplyLeadingScript / paragraphStyleRange 分割実装。
//
// 「自動行送りのまま、ジャスティフィケーション値だけ行ごとに変える」を実現するには、
// paragraphStyleRange を行ごとに分割し、各 paragraphStyle に
// `stringIDToTypeID("autoLeadingPercentage")` を put する必要がある。
// 値は倍率 (1.5 = 150%) で putDouble。
//
// 引数:
//   layer: 対象テキストレイヤー (artLayer)
//   contents: 親レイヤーの contents (textItem.contents の改行は \r)
//   rubyLineIndices: ルビが乗る行の 0-based index の配列 (例: [1, 3])
//   multiplier: 倍率 (1.5 = 150%)
//   defaultMultiplier: 他の行に当てる元の倍率 (例: 1.25 = 125%、e.leadingPct/100 でいい)
function applyPerCharItalics(layer, contents, charItalics, layerItalic) {
  var hasChar = charItalics && !isObjEmpty(charItalics);
  var li = layerItalic === true;
  app.activeDocument.activeLayer = layer;

  var layerRef = new ActionReference();
  layerRef.putEnumerated(sID("layer"), sID("ordinal"), sID("targetEnum"));
  var layerDesc = executeActionGet(layerRef);
  if (!layerDesc.hasKey(sID("textKey"))) return;
  var textKey = layerDesc.getObjectValue(sID("textKey"));

  var oldRanges = textKey.getList(sID("textStyleRange"));
  if (oldRanges.count === 0) return;

  var srcRangeIndex = [];
  var totalChars = 0;
  for (var r = 0; r < oldRanges.count; r++) {
    var rd = oldRanges.getObjectValue(r);
    var fromCh = rd.getInteger(sID("from"));
    var toCh = rd.getInteger(sID("to"));
    if (toCh > totalChars) totalChars = toCh;
    for (var c = fromCh; c < toCh; c++) srcRangeIndex[c] = r;
  }
  if (totalChars === 0) return;

  function readItalic(idx) {
    if (charItalics) {
      var v = charItalics[String(idx)];
      if (typeof v === "boolean") return v;
    }
    return li;
  }

  var newRangeList = new ActionList();
  if (typeof srcRangeIndex[0] !== "number") srcRangeIndex[0] = 0;
  var curStart = 0;
  var curSrc = srcRangeIndex[0];
  var curItalic = readItalic(0);

  for (var p = 1; p <= totalChars; p++) {
    var nextSrc, nextItalic, boundary;
    if (p === totalChars) {
      boundary = true;
      nextSrc = curSrc; nextItalic = curItalic;
    } else {
      nextSrc = (typeof srcRangeIndex[p] === "number") ? srcRangeIndex[p] : curSrc;
      nextItalic = readItalic(p);
      boundary = (nextSrc !== curSrc) || (nextItalic !== curItalic);
    }
    if (boundary) {
      var srcRange = oldRanges.getObjectValue(curSrc);
      var srcStyle = srcRange.getObjectValue(sID("textStyle"));
      var styleClone = cloneActionDescriptor(srcStyle);
      try { styleClone.putBoolean(sID("syntheticItalic"), curItalic === true); } catch (eSI) {}
      var newRangeDesc = new ActionDescriptor();
      newRangeDesc.putInteger(sID("from"), curStart);
      newRangeDesc.putInteger(sID("to"), p);
      newRangeDesc.putObject(sID("textStyle"), sID("textStyle"), styleClone);
      newRangeList.putObject(sID("textStyleRange"), newRangeDesc);
      curStart = p;
      curSrc = nextSrc;
      curItalic = nextItalic;
    }
  }

  var newTextKey = cloneActionDescriptor(textKey);
  newTextKey.putList(sID("textStyleRange"), newRangeList);
  var setDesc = new ActionDescriptor();
  setDesc.putReference(sID("null"), layerRef);
  setDesc.putObject(sID("to"), sID("textLayer"), newTextKey);
  executeAction(sID("set"), setDesc, DialogModes.NO);
}

function applyRubyAutoLeadingPercentage(layer, contents, rubyLineIndices, multiplier, defaultMultiplier) {
  if (!rubyLineIndices || rubyLineIndices.length === 0) return;
  if (typeof multiplier !== "number" || !isFinite(multiplier) || multiplier <= 0) return;

  // 【v1.29.x 修正】「変更前 bounds 保存 → 変更後復元」処理は撤廃。autoLeadingPercentage で
  // 生まれた行間余白 (ルビ用空間) も translate で打ち消してしまい、結果ルビが親文字に重なる
  // 事故が起きていた。autoLeadingPercentage の効果は Photoshop に任せ、親文字位置は
  // 自然に下 (横書き) / 左 (縦書き) にシフトさせる。

  // 対象レイヤーを active に
  try {
    var sRef = new ActionReference();
    sRef.putIdentifier(charIDToTypeID("Lyr "), layer.id);
    var sDesc = new ActionDescriptor();
    sDesc.putReference(charIDToTypeID("null"), sRef);
    executeAction(charIDToTypeID("slct"), sDesc, DialogModes.NO);
  } catch (eSel) { return; }

  // textKey 取得
  var getRef = new ActionReference();
  getRef.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
  var layerDesc = executeActionGet(getRef);
  if (!layerDesc.hasKey(sID("textKey"))) return;
  var textKey = layerDesc.getObjectValue(sID("textKey"));
  if (!textKey.hasKey(sID("paragraphStyleRange"))) return;

  // 各行の char [start, end) 範囲を計算。改行が \r\n の場合も
  // paragraphStyleRange の境界がずれないよう、実際の改行長を含める。
  var normContents = String(contents || "");
  var lineRanges = [];
  var lineStart = 0;
  var lineBreakRe = /\r\n|\r|\n/g;
  var lineBreak;
  while ((lineBreak = lineBreakRe.exec(normContents)) !== null) {
    lineRanges.push({ from: lineStart, to: lineBreak.index + lineBreak[0].length });
    lineStart = lineBreak.index + lineBreak[0].length;
  }
  lineRanges.push({ from: lineStart, to: normContents.length });

  // ルビが乗る行の (from, to) リスト
  var rubyRanges = [];
  for (var ri = 0; ri < rubyLineIndices.length; ri++) {
    var idx = rubyLineIndices[ri];
    if (idx < 0 || idx >= lineRanges.length) continue;
    rubyRanges.push(lineRanges[idx]);
  }
  if (rubyRanges.length === 0) return;

  // ある [from, to) がルビ行に重なるか
  function overlapsRuby(from, to) {
    for (var rj = 0; rj < rubyRanges.length; rj++) {
      var r = rubyRanges[rj];
      if (from < r.to && to > r.from) return true;
    }
    return false;
  }

  // paragraphStyle をコピー (参考プラグイン互換)
  function copyParaStyle(srcStyle, applyRubyLeading) {
    var newParaStyle = new ActionDescriptor();
    var paraKeys = ["styleSheetHasParent", "justification", "hyphenate", "directionType", "leadingType",
                    "justificationWordMinimum", "justificationWordDesired", "justificationWordMaximum",
                    "justificationLetterMinimum", "justificationLetterDesired", "justificationLetterMaximum",
                    "justificationGlyphMinimum", "justificationGlyphDesired", "justificationGlyphMaximum",
                    "burasagari", "textEveryLineComposer", "textComposerEngine"];
    for (var pk = 0; pk < paraKeys.length; pk++) {
      var pKey = sID(paraKeys[pk]);
      if (srcStyle.hasKey(pKey)) {
        try {
          var pType = srcStyle.getType(pKey);
          if (pType === DescValueType.BOOLEANTYPE) {
            newParaStyle.putBoolean(pKey, srcStyle.getBoolean(pKey));
          } else if (pType === DescValueType.ENUMERATEDTYPE) {
            newParaStyle.putEnumerated(pKey, srcStyle.getEnumerationType(pKey), srcStyle.getEnumerationValue(pKey));
          } else if (pType === DescValueType.DOUBLETYPE) {
            newParaStyle.putDouble(pKey, srcStyle.getDouble(pKey));
          }
        } catch (e2) {}
      }
    }
    // Algn (charID)
    var algnKey = charIDToTypeID("Algn");
    if (srcStyle.hasKey(algnKey)) {
      try { newParaStyle.putEnumerated(algnKey, srcStyle.getEnumerationType(algnKey), srcStyle.getEnumerationValue(algnKey)); } catch (e3) {}
    }
    // autoLeadingPercentage: 対象行は multiplier、それ以外は元の値 (なければ defaultMultiplier)
    var alpKey = sID("autoLeadingPercentage");
    if (applyRubyLeading) {
      newParaStyle.putDouble(alpKey, multiplier);
    } else {
      if (srcStyle.hasKey(alpKey)) {
        try { newParaStyle.putDouble(alpKey, srcStyle.getDouble(alpKey)); }
        catch (eDef) {
          if (typeof defaultMultiplier === "number" && isFinite(defaultMultiplier) && defaultMultiplier > 0) {
            newParaStyle.putDouble(alpKey, defaultMultiplier);
          }
        }
      } else if (typeof defaultMultiplier === "number" && isFinite(defaultMultiplier) && defaultMultiplier > 0) {
        newParaStyle.putDouble(alpKey, defaultMultiplier);
      }
    }
    return newParaStyle;
  }

  function addParaRange(list, fromIdx, toIdx, srcStyle, applyRubyLeading) {
    if (fromIdx >= toIdx) return;
    var newParaRange = new ActionDescriptor();
    newParaRange.putInteger(charIDToTypeID("From"), fromIdx);
    newParaRange.putInteger(charIDToTypeID("T   "), toIdx);
    newParaRange.putObject(sID("paragraphStyle"), sID("paragraphStyle"), copyParaStyle(srcStyle, applyRubyLeading));
    list.putObject(sID("paragraphStyleRange"), newParaRange);
  }

  // 既存の paragraphStyleRange を rubyRanges の境界で分割しながらコピー
  var origParaList = textKey.getList(sID("paragraphStyleRange"));
  var newParaList = new ActionList();
  for (var pi = 0; pi < origParaList.count; pi++) {
    var origParaRange = origParaList.getObjectValue(pi);
    var pFrom = origParaRange.getInteger(charIDToTypeID("From"));
    var pTo = origParaRange.getInteger(charIDToTypeID("T   "));
    var srcParaStyle = origParaRange.getObjectValue(sID("paragraphStyle"));
    // [pFrom, pTo) を rubyRanges の境界で分割
    var borders = [pFrom, pTo];
    for (var rk = 0; rk < rubyRanges.length; rk++) {
      var r = rubyRanges[rk];
      if (r.from > pFrom && r.from < pTo) borders.push(r.from);
      if (r.to > pFrom && r.to < pTo) borders.push(r.to);
    }
    borders.sort(function (a, b) { return a - b; });
    // ユニーク化
    var uniq = [];
    for (var bi = 0; bi < borders.length; bi++) {
      if (bi === 0 || borders[bi] !== borders[bi - 1]) uniq.push(borders[bi]);
    }
    // 各セグメントを追加
    for (var si = 0; si < uniq.length - 1; si++) {
      var segFrom = uniq[si];
      var segTo = uniq[si + 1];
      addParaRange(newParaList, segFrom, segTo, srcParaStyle, overlapsRuby(segFrom, segTo));
    }
  }

  // textKey を再構築 (paragraphStyleRange のみ差し替え、それ以外は元のまま)
  var newTextKey = new ActionDescriptor();
  // 元の textKey の全 key をコピー (paragraphStyleRange だけ後で上書き)
  var copyTextKeyAllExcept = function (paraKey) {
    var keyList = [
      "textStyleRange", "textShape", "orientation", "antiAlias", "antiAliasSharp",
      "textGridding", "warp"
    ];
    for (var ki = 0; ki < keyList.length; ki++) {
      var k = sID(keyList[ki]);
      if (!textKey.hasKey(k)) continue;
      try {
        var t = textKey.getType(k);
        if (t === DescValueType.LISTTYPE) {
          newTextKey.putList(k, textKey.getList(k));
        } else if (t === DescValueType.OBJECTTYPE) {
          newTextKey.putObject(k, textKey.getObjectType(k), textKey.getObjectValue(k));
        } else if (t === DescValueType.ENUMERATEDTYPE) {
          newTextKey.putEnumerated(k, textKey.getEnumerationType(k), textKey.getEnumerationValue(k));
        } else if (t === DescValueType.BOOLEANTYPE) {
          newTextKey.putBoolean(k, textKey.getBoolean(k));
        } else if (t === DescValueType.DOUBLETYPE) {
          newTextKey.putDouble(k, textKey.getDouble(k));
        } else if (t === DescValueType.INTEGERTYPE) {
          newTextKey.putInteger(k, textKey.getInteger(k));
        } else if (t === DescValueType.STRINGTYPE) {
          newTextKey.putString(k, textKey.getString(k));
        }
      } catch (eCp) {}
    }
  };
  copyTextKeyAllExcept();
  newTextKey.putList(sID("paragraphStyleRange"), newParaList);

  // 書き戻し。class は "textLayer" (sID) で set。
  var setRef = new ActionReference();
  setRef.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
  var setDesc2 = new ActionDescriptor();
  setDesc2.putReference(charIDToTypeID("null"), setRef);
  setDesc2.putObject(sID("to"), sID("textLayer"), newTextKey);
  executeAction(sID("set"), setDesc2, DialogModes.NO);
}

function applyLineLeadingPercentages(layer, contents, lineLeadings, defaultMultiplier) {
  if (isObjEmpty(lineLeadings)) return;
  var grouped = {};
  for (var k in lineLeadings) {
    if (!lineLeadings.hasOwnProperty(k)) continue;
    var idx = parseInt(k, 10);
    var pct = lineLeadings[k];
    if (isNaN(idx) || idx < 0) continue;
    if (typeof pct !== "number" || !isFinite(pct) || pct <= 0) continue;
    var multiplier = pct / 100;
    var groupKey = String(Math.round(multiplier * 1000000) / 1000000);
    if (!grouped[groupKey]) grouped[groupKey] = [];
    grouped[groupKey].push(idx);
  }
  for (var g in grouped) {
    if (!grouped.hasOwnProperty(g)) continue;
    var mult = parseFloat(g);
    if (typeof mult !== "number" || !isFinite(mult) || mult <= 0) continue;
    applyRubyAutoLeadingPercentage(layer, contents, grouped[g], mult, defaultMultiplier);
  }
}

// 【v1.29.x 修正】contents (\n or \r 区切り) と charRubies から
// 「autoLeadingPercentage の対象行 = **親文字行の一つ前の行 (i-1)**」の 0-based index を抽出。
//
// ユーザー要望: 縦書き / 横書き ともに「**前の行 (i-1)**」の autoLeadingPercentage 値を
// 変更する。これにより Photoshop の文字パネルで「前の行に 150%」と表示される。
//
// 親文字が 0 行目 (= 先頭行) の場合、前の行が存在しないのでスキップ。
// (direction 引数は将来の拡張用に残すが、現状は両方向とも同じ挙動)
function computeRubyLineIndices(contents, charRubies, direction) {
  var out = [];
  if (!charRubies) return out;
  var normContents = String(contents || "");
  var lineStarts = [0];
  var lineBreakRe = /\r\n|\r|\n/g;
  var lineBreak;
  while ((lineBreak = lineBreakRe.exec(normContents)) !== null) {
    lineStarts.push(lineBreak.index + lineBreak[0].length);
  }
  function charIndexToLine(idx) {
    var lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1;
    }
    return lo;
  }
  var seen = {};
  function addRubyLineForStart(start) {
    var parentLine = charIndexToLine(start);
    // 縦書き・横書きとも「親文字行の一つ前 (i-1)」を target。0 行目スキップ。
    var targetLine = parentLine - 1;
    if (targetLine < 0) return;
    if (!seen[String(targetLine)]) {
      seen[String(targetLine)] = true;
      out.push(targetLine);
    }
  }
  for (var k in charRubies) {
    if (!charRubies.hasOwnProperty(k)) continue;
    var start = parseInt(k, 10);
    if (isNaN(start)) continue;
    var entry = charRubies[k];
    if (entry && typeof entry.text === "string" && entry.text.length > 0 && !isDakutenRubyText(entry.text)) {
      addRubyLineForStart(start);
    }
    if (entry && entry.overlays && entry.overlays.length) {
      for (var oi = 0; oi < entry.overlays.length; oi++) {
        var ov = entry.overlays[oi];
        if (!ov || typeof ov.text !== "string" || ov.text.length === 0) continue;
        if (isDakutenRubyText(ov.text)) continue;
        var ovStart = parseInt(ov.start, 10);
        if (isNaN(ovStart)) continue;
        addRubyLineForStart(ovStart);
      }
    }
  }
  return out;
}

// 【v1.26.0】===== ルビ =====
// charRubies: { "<start>": {end, text, rubyType, scale}, ... }
// 親レイヤーは保持。各ルビごとに新規テキストレイヤーを親の直前に追加する。
// 命名規則: 「{ルビ文字}（{親文字}）」（Photoshop プラグイン版と互換）。
//
// 配置ロジック（Phase A 改良版）:
//   contents の改行から「親文字が何行目（縦書きでは何列目）にあるか」を推定し、char range の
//   おおまかな位置を計算する。ルビは親レイヤーの **外側**（縦書きなら親 bounds.right の外、
//   横書きなら親 bounds.top の上）に必ず出るよう余白付きで配置するため、親テキストと重ならない。
//   ユーザーは PS 側で必要に応じて微調整できる。
// 【v1.29.x】parentTopLeftOverride: applyRubyAutoLeadingPercentage で親レイヤーがシフトしても、
// その**変更前**の top-left (= UI 上の親フレーム top-left に等しい) をルビ配置の基準として使う。
// これにより、uiOffsetX/Y で計算したルビ位置が「ビューアー上の見た目と完全一致」する。
// null のときは現在の親 bounds をそのまま使う (旧挙動)。
// 【v1.29.x】rubyPhotoshopOffsetEm / rubyPhotoshopBiasPx: ルビ位置 Photoshop 微調整値。
// settings (写植設定) で変更可能。デフォルト 0 / 0。
function isNakaguroRubyText(text) {
  var s = String(text || "");
  if (s.length === 0) return false;
  for (var i = 0; i < s.length; i++) {
    var code = s.charCodeAt(i);
    if (code !== 0x30FB && code !== 0xFF65) return false;
  }
  return true;
}

function isDakutenRubyText(text) {
  var s = String(text || "");
  if (s.length === 0) return false;
  for (var i = 0; i < s.length; i++) {
    var code = s.charCodeAt(i);
    if (code !== 0x309B && code !== 0xFF9E && code !== 0x3099) return false;
  }
  return true;
}

function isSpecialParentMarkRubyText(text) {
  return isNakaguroRubyText(text) || isDakutenRubyText(text);
}

function rubyLayerNameFor(parentSubText, rubyText) {
  return String(rubyText || "") + "（" + String(parentSubText || "") + "）";
}

function addRubyLayerName(names, parentSubText, rubyText) {
  var name = rubyLayerNameFor(parentSubText, rubyText);
  if (name && name !== "（）") names[name] = true;
}

function collectRubyLayerNames(contents, charRubies) {
  var names = {};
  if (!charRubies) return names;
  for (var key in charRubies) {
    if (!charRubies.hasOwnProperty(key)) continue;
    var startChar = parseInt(key, 10);
    if (isNaN(startChar)) continue;
    var entry = charRubies[key];
    if (!entry || typeof entry.text !== "string" || entry.text.length === 0) continue;
    var endChar = entry.end;
    if (!(endChar > startChar) || endChar > String(contents).length) continue;
    var parentText = String(contents).substring(startChar, endChar);
    var rubyText = entry.text;
    var rubyType = entry.rubyType || "group";
    var monoSegments = null;
    if (rubyType === "mono") {
      var parts = rubyText.split(/[ 　]+/);
      if (parts.length === parentText.length) monoSegments = parts;
    }
    if (monoSegments) {
      for (var mi = 0; mi < parentText.length; mi++) {
        addRubyLayerName(names, parentText.charAt(mi), monoSegments[mi]);
      }
    } else {
      addRubyLayerName(names, parentText, rubyText);
    }
    if (entry.overlays && entry.overlays.length) {
      for (var oi = 0; oi < entry.overlays.length; oi++) {
        var ov = entry.overlays[oi];
        if (!ov || typeof ov.text !== "string" || ov.text.length === 0) continue;
        var ovStart = parseInt(ov.start, 10);
        var ovEnd = parseInt(ov.end, 10);
        if (isNaN(ovStart) || isNaN(ovEnd) || !(ovEnd > ovStart) || ovEnd > String(contents).length) continue;
        addRubyLayerName(names, String(contents).substring(ovStart, ovEnd), ov.text);
      }
    }
  }
  return names;
}

function removeExistingGeneratedRubyLayers(parentLayer, rubyNames) {
  try {
    if (!parentLayer || !rubyNames || isObjEmpty(rubyNames)) return;
    var parentBounds = getLayerBoundsPx(parentLayer);
    if (!parentBounds) return;
    var pad = Math.max(
      200,
      Math.abs(parentBounds.right - parentBounds.left) * 1.5,
      Math.abs(parentBounds.bottom - parentBounds.top) * 1.5
    );
    var parentId = null;
    try { parentId = parentLayer.id; } catch (ePid) {}
    function matchesRubyName(name) {
      if (typeof name !== "string" || name.length === 0) return false;
      for (var rn in rubyNames) {
        if (!rubyNames.hasOwnProperty(rn)) continue;
        if (name === rn || name.indexOf(rn + " ") === 0) return true;
      }
      return false;
    }
    var targets = [];
    function collectTargets(container) {
      if (!container || !container.layers) return;
      var layers = container.layers;
      for (var li = layers.length - 1; li >= 0; li--) {
        var layer = layers[li];
        if (!layer) continue;
        try {
          if (layer.typename === "LayerSet") collectTargets(layer);
        } catch (eSet) {}
        if (!matchesRubyName(layer.name)) continue;
        try {
          if (parentId !== null && layer.id === parentId) continue;
        } catch (eSame) {}
        try {
          if (layer.typename !== "ArtLayer" || layer.kind !== LayerKind.TEXT) continue;
        } catch (eKind) {
          continue;
        }
        var b = getLayerBoundsPx(layer);
        if (!b) continue;
        var nearParent = !(
          b.right < parentBounds.left - pad ||
          b.left > parentBounds.right + pad ||
          b.bottom < parentBounds.top - pad ||
          b.top > parentBounds.bottom + pad
        );
        if (!nearParent) continue;
        targets.push(layer);
      }
    }
    collectTargets(app.activeDocument);
    for (var ti = 0; ti < targets.length; ti++) {
      var layer = targets[ti];
      try {
        if (parentId !== null && layer.id === parentId) continue;
      } catch (eSame) {}
      try { layer.remove(); } catch (eRemoveRuby) {}
    }
  } catch (eRemoveExistingRuby) {}
}

function parentEmPxForLayer(parentLayer, doc) {
  var parentEmPx = 200;
  try {
    var pSizePt = parentLayer.textItem.size.value;
    var dpiVal = doc.resolution;
    if (typeof pSizePt === "number" && pSizePt > 0
        && typeof dpiVal === "number" && dpiVal > 0) {
      parentEmPx = pSizePt * (dpiVal / 72);
    }
  } catch (eEm) {}
  return parentEmPx;
}

var PARENT_MARK_OFFSET_EM = 0.55;
var NAKAGURO_PARENT_MARK_OFFSET_EM = 0.72;
var NAKAGURO_FIRST_LINE_PARENT_MARK_OFFSET_EM = 0.84;
var NORMAL_FIRST_LINE_RUBY_GAP_EM = 0.08;
var LATER_LINE_RUBY_PARENT_OFFSET_EM = 0.72;
var NORMAL_RUBY_PARENT_NUDGE_EM = 0.08;

function lineIndexForCharIndex(contents, idx) {
  var fullText = String(contents || "");
  var target = parseInt(idx, 10);
  if (isNaN(target) || target <= 0) return 0;
  var line = 0;
  for (var i = 0; i < fullText.length && i < target; i++) {
    var ch = fullText.charAt(i);
    if (ch === "\r") {
      line++;
      if (fullText.charAt(i + 1) === "\n") i++;
    } else if (ch === "\n") {
      line++;
    }
  }
  return line;
}

function applyRubies(parentLayer, contents, charRubies, fontSizePt, parentDirection, parentFontPS, parentFillColor, parentTopLeftOverride, rubyPhotoshopOffsetEm, rubyPhotoshopBiasPx) {
  if (!charRubies || isObjEmpty(charRubies)) return [];
  var __createdRubyLayers = [];
  var __emittedRubyKeys = {};
  var __emittedNakaguroRanges = [];
  function emitRubyOnce(fromCh, toCh, rubyText) {
    if (isNakaguroRubyText(rubyText)) {
      for (var nri = 0; nri < __emittedNakaguroRanges.length; nri++) {
        var nr = __emittedNakaguroRanges[nri];
        if (fromCh < nr.end && toCh > nr.start) return false;
      }
      __emittedNakaguroRanges.push({ start: fromCh, end: toCh });
    }
    var emitKey = String(fromCh) + "\u0001" + String(toCh) + "\u0001" + String(rubyText || "");
    if (__emittedRubyKeys[emitKey]) return false;
    __emittedRubyKeys[emitKey] = true;
    return true;
  }

  removeExistingGeneratedRubyLayers(parentLayer, collectRubyLayerNames(contents, charRubies));

  for (var key in charRubies) {
    if (!charRubies.hasOwnProperty(key)) continue;
    var startChar = parseInt(key, 10);
    var entry = charRubies[key];
    if (!entry || typeof entry.text !== "string" || entry.text.length === 0) continue;
    var endChar = entry.end;
    if (!(endChar > startChar)) continue;
    if (endChar > String(contents).length) continue;

    var parentText = String(contents).substring(startChar, endChar);
    var rubyText = entry.text;
    var rubyType = entry.rubyType || "group";
    var rubyScale = (typeof entry.scale === "number" && entry.scale > 0) ? entry.scale : 50;
    var rubySizePt = fontSizePt * (rubyScale / 100);

    // モノルビ: スペース/全角スペースで分割。子数と親数が一致するならモノ。
    // 不一致はグループにフォールバック（プレビュー側 decideRubyType と一致挙動）。
    var monoSegments = null;
    if (rubyType === "mono") {
      var parts = rubyText.split(/[ 　]+/);
      if (parts.length === parentText.length) monoSegments = parts;
    }

    // 【v1.29.x UI-coord】ビューアー実描画位置 (PSD px、親レイヤー基準) があれば
    // 計算式 fallback ではなくこの位置を使う。CSS / JSX の式不一致による位置ズレが消える。
    // monoSegments モードでは entry.offsetX/Y は「最初の文字 (= entry.start) の wrap」を
    // 指すので、複数モノルビ wrap の各位置までは個別に取れない。Phase A 改良として:
    //   - グループルビ: offsetX/Y をルビ中心として使用 (完璧一致)
    //   - モノルビ: offsetX/Y を最初の wrap 位置として、後続は char 間隔で線形配置 (近似)
    var hasUiOffset = (typeof entry.offsetX === "number" && typeof entry.offsetY === "number"
                      && isFinite(entry.offsetX) && isFinite(entry.offsetY));
    var uiOffsetX = hasUiOffset ? entry.offsetX : null;
    var uiOffsetY = hasUiOffset ? entry.offsetY : null;
    var hasUiAbs = (typeof entry.absX === "number" && typeof entry.absY === "number"
                    && isFinite(entry.absX) && isFinite(entry.absY));
    var uiAbsX = hasUiAbs ? entry.absX : null;
    var uiAbsY = hasUiAbs ? entry.absY : null;

    if (monoSegments) {
      for (var mi = 0; mi < parentText.length; mi++) {
        if (!emitRubyOnce(startChar + mi, startChar + mi + 1, monoSegments[mi])) continue;
        try {
          var __mrLayer = createRubyLayer(parentLayer, contents, startChar + mi, startChar + mi + 1,
                          parentText.charAt(mi), monoSegments[mi],
                          rubySizePt, parentDirection, parentFontPS, parentFillColor,
                          // モノルビは最初の文字 (mi=0) のみ UI offset を使う。
                          // 残りの文字は計算式 fallback (= 各 char range の中心で配置)。
                          mi === 0 ? uiOffsetX : null, mi === 0 ? uiOffsetY : null,
                          mi === 0 ? uiAbsX : null, mi === 0 ? uiAbsY : null,
                          parentTopLeftOverride,
                          rubyPhotoshopOffsetEm, rubyPhotoshopBiasPx);
          if (__mrLayer) __createdRubyLayers.push(__mrLayer);
        } catch (eMono) {
          addWarning("モノルビ「" + parentText.charAt(mi) + "（" + monoSegments[mi] + "）」適用失敗: " + eMono);
        }
      }
    } else {
      if (emitRubyOnce(startChar, endChar, rubyText)) {
        try {
          var __grLayer = createRubyLayer(parentLayer, contents, startChar, endChar,
                          parentText, rubyText,
                          rubySizePt, parentDirection, parentFontPS, parentFillColor,
                          uiOffsetX, uiOffsetY, uiAbsX, uiAbsY,
                          parentTopLeftOverride,
                          rubyPhotoshopOffsetEm, rubyPhotoshopBiasPx);
          if (__grLayer) __createdRubyLayers.push(__grLayer);
        } catch (eGroup) {
          addWarning("グループルビ「" + parentText + "（" + rubyText + "）」適用失敗: " + eGroup);
        }
      }
    }

    if (entry.overlays && entry.overlays.length) {
      for (var oi = 0; oi < entry.overlays.length; oi++) {
        var ov = entry.overlays[oi];
        if (!ov || typeof ov.text !== "string" || ov.text.length === 0) continue;
        var ovStart = parseInt(ov.start, 10);
        var ovEnd = parseInt(ov.end, 10);
        if (isNaN(ovStart) || isNaN(ovEnd) || !(ovEnd > ovStart) || ovEnd > String(contents).length) continue;
        var ovScale = (typeof ov.scale === "number" && ov.scale > 0) ? ov.scale : 50;
        var ovSizePt = fontSizePt * (ovScale / 100);
        var ovParentText = String(contents).substring(ovStart, ovEnd);
        var ovHasUiOffset = (typeof ov.offsetX === "number" && typeof ov.offsetY === "number"
                            && isFinite(ov.offsetX) && isFinite(ov.offsetY));
        var ovOffsetX = ovHasUiOffset ? ov.offsetX : null;
        var ovOffsetY = ovHasUiOffset ? ov.offsetY : null;
        var ovHasUiAbs = (typeof ov.absX === "number" && typeof ov.absY === "number"
                          && isFinite(ov.absX) && isFinite(ov.absY));
        var ovAbsX = ovHasUiAbs ? ov.absX : null;
        var ovAbsY = ovHasUiAbs ? ov.absY : null;
        if (!emitRubyOnce(ovStart, ovEnd, ov.text)) continue;
        try {
          var __ovLayer = createRubyLayer(parentLayer, contents, ovStart, ovEnd,
                          ovParentText, ov.text,
                          ovSizePt, parentDirection, parentFontPS, parentFillColor,
                          ovOffsetX, ovOffsetY, ovAbsX, ovAbsY,
                          parentTopLeftOverride,
                          rubyPhotoshopOffsetEm, rubyPhotoshopBiasPx);
          if (__ovLayer) {
            if (!isSpecialParentMarkRubyText(ov.text)) {
              try {
                var stackPx = fontSizePt * 0.62 * (oi + 1);
                if (parentDirection === "vertical") __ovLayer.translate(new UnitValue(0, "px"), new UnitValue(stackPx, "px"));
                else __ovLayer.translate(new UnitValue(stackPx, "px"), new UnitValue(0, "px"));
              } catch (eOvShift) {}
            }
            __createdRubyLayers.push(__ovLayer);
          }
        } catch (eOverlay) {
          addWarning("追加ルビ「" + ovParentText + "（" + ov.text + "）」適用失敗: " + eOverlay);
        }
      }
    }
  }
  return __createdRubyLayers;
}

// 1 個のルビレイヤーを生成して親の直前に挿入。
// 【v1.29.x UI-coord】uiOffsetX / uiOffsetY: ビューアー上の `.ruby-text` 中心位置を
// 親レイヤー top-left からの相対座標 (PSD px) で渡す。null なら計算式 fallback。
// 【v1.29.x】parentTopLeftOverride: applyRubyAutoLeadingPercentage で親レイヤーが
// シフトしてしまった後でも、変更前の top-left (UI 上の親フレーム top-left と一致) を
// 使ってルビを配置するための上書き値 {left, top}。null なら現在の親 bounds を使う。
function createRubyLayer(parentLayer, contents, fromCh, toCh, parentSubText, rubyText,
                          rubySizePt, parentDirection, parentFontPS, parentFillColor,
                          uiOffsetX, uiOffsetY, uiAbsX, uiAbsY, parentTopLeftOverride,
                          rubyPhotoshopOffsetEm, rubyPhotoshopBiasPx) {
  var doc = app.activeDocument;
  // 親レイヤーの bounds を再評価（layer 効果や前段の per-char 編集後の最新値）。
  try {
    parentLayer.translate(new UnitValue(0, "px"), new UnitValue(0, "px"));
  } catch (eParentRf) {}
  var currentParentBounds = getLayerBoundsPx(parentLayer);
  if (!currentParentBounds) return;
  // 【v1.29.x】parentTopLeftOverride: applyRubyAutoLeadingPercentage で親レイヤーがシフトした
  // 場合に、変更前 (= UI 上の親フレーム top-left に等しい) の top-left を「ルビ配置の基準」
  // として使う。これにより uiOffsetX/Y で計算したルビ位置がビューアー上の見た目と一致する。
  // 縦書き/横書き共通で、bounds の幅・高さは現在値、top-left のみ override 値に差し替える。
  var parentBounds;
  if (parentTopLeftOverride
      && typeof parentTopLeftOverride.left === "number"
      && typeof parentTopLeftOverride.top === "number"
      && isFinite(parentTopLeftOverride.left)
      && isFinite(parentTopLeftOverride.top)) {
    var w = currentParentBounds.right - currentParentBounds.left;
    var h = currentParentBounds.bottom - currentParentBounds.top;
    parentBounds = {
      left: parentTopLeftOverride.left,
      top: parentTopLeftOverride.top,
      right: parentTopLeftOverride.left + w,
      bottom: parentTopLeftOverride.top + h
    };
  } else {
    parentBounds = currentParentBounds;
  }
  // char range の推定 bounds（contents の改行ベース）。layer 全体 bounds を行/列で均等分割して
  // char range の位置をおおまかに割り当てる。
  var rangeBounds = estimateCharRangeBounds(parentBounds, contents, fromCh, toCh, parentDirection);

  // 新規テキストレイヤー（doc 直下に作成 → 親直前に move の 2 段階パターン）。
  var rubyLayer = doc.artLayers.add();
  rubyLayer.kind = LayerKind.TEXT;
  rubyLayer.name = rubyLayerNameFor(parentSubText, rubyText);
  var rti = rubyLayer.textItem;
  // direction 継承
  try {
    if (parentDirection === "vertical") rti.direction = Direction.VERTICAL;
    else rti.direction = Direction.HORIZONTAL;
  } catch (eDir) {}
  rti.contents = rubyText;
  if (typeof parentFontPS === "string" && parentFontPS.length > 0) {
    try { rti.font = parentFontPS; } catch (eFn) {}
  }
  try { rti.size = new UnitValue(rubySizePt, "pt"); } catch (eSz) {}
  try { rti.autoLeadingAmount = 100; rti.useAutoLeading = true; } catch (eAl) {}
  if (parentFillColor) {
    try { rti.color = parentFillColor; } catch (eCol) {}
  }

  // bounds の再評価トリガー（PS が text layer 作成直後の bounds 計算遅延に対応）。
  // translate(0, 0) を呼ぶと PS は bounds を再計算する。
  try {
    rubyLayer.translate(new UnitValue(0, "px"), new UnitValue(0, "px"));
  } catch (eRf) {}

  // 配置：親 char range bounds の指定エッジに揃える。boundsNoEffects 優先で取得。
  try {
    var rbObj = getLayerBoundsPx(rubyLayer);
    if (!rbObj) return;
    var actualLeft = rbObj.left;
    var actualTop = rbObj.top;
    var actualRight = rbObj.right;
    var actualBottom = rbObj.bottom;
    var rubyWidth = actualRight - actualLeft;
    var rubyHeight = actualBottom - actualTop;
    var targetLeft, targetTop;

    // 【v1.29.x UI-coord】ビューアー実描画位置 (uiOffsetX/Y) があれば、これを「ルビ中心」として
    // 扱い、計算式 fallback を使わない。uiOffset は親レイヤー top-left からの相対 PSD 座標。
    var hasUiOffset = (typeof uiOffsetX === "number" && typeof uiOffsetY === "number"
                      && isFinite(uiOffsetX) && isFinite(uiOffsetY));
    var hasUiAbs = (typeof uiAbsX === "number" && typeof uiAbsY === "number"
                    && isFinite(uiAbsX) && isFinite(uiAbsY));
    var isParentMarkRuby = isSpecialParentMarkRubyText(rubyText);
    var parentLineIndex = lineIndexForCharIndex(contents, fromCh);
    var isFirstLineNormalRuby = !isParentMarkRuby && parentLineIndex === 0;
    var parentMarkOffsetEm = isNakaguroRubyText(rubyText) ? NAKAGURO_PARENT_MARK_OFFSET_EM : PARENT_MARK_OFFSET_EM;
    if (isNakaguroRubyText(rubyText) && parentLineIndex === 0) {
      parentMarkOffsetEm = NAKAGURO_FIRST_LINE_PARENT_MARK_OFFSET_EM;
    }
    if (isParentMarkRuby || parentLineIndex > 0 || isFirstLineNormalRuby) {
      // Parent marks, later-line rubies, and first-line normal rubies are
      // positioned from the parent range. UI-measured offsets include
      // ruby-line placement and can drift from Photoshop's adjusted geometry.
      hasUiOffset = false;
      hasUiAbs = false;
    }
    if (hasUiAbs || hasUiOffset) {
      // ルビ中心:
      //   縦書き: UI 側も Photoshop 側も、親テキスト右端基準の offsetX として扱う。
      //   横書き: 左上基準。
      var rubyCenterX = hasUiAbs
        ? uiAbsX
        : ((parentDirection === "vertical") ? parentBounds.right + uiOffsetX : parentBounds.left + uiOffsetX);
      var rubyCenterY = hasUiAbs ? uiAbsY : parentBounds.top + uiOffsetY;
      // ビューアーは「親文字と前の行の中間」(行間中央) を基準にルビを表示する。
      // Photoshop でも同じ中心を使い、写植設定で明示された補正値だけ追加する。
      //  - PHOTOSHOP_RUBY_TO_PARENT_OFFSET_EM: 親 font em 単位で親側にシフト (em 依存)
      //  - PHOTOSHOP_RUBY_PARENT_BIAS_PX:      親から離す方向の微小固定 PSD px (font 非依存)
      // 縦書き: 親の **右** にルビ
      //   rubyCenterX -= em シフト (親側 = 左)
      //   rubyCenterX += 固定 (親から離す方向 = 右)
      // 横書き: 親の **上** にルビ
      //   rubyCenterY += em シフト (親側 = 下)
      //   rubyCenterY -= 固定 (親から離す方向 = 上)
      // ビューアー側の CSS `--ruby-parent-offset-em` (現在 0.15em) と合算して
      // 「合計 1.0em ぶん親寄せ」を維持する。CSS を変えたら、ここを (1.0 - CSS 値) に調整する。
      // settings.js (写植設定) で変更可能。デフォルトは applyToPsd 呼び出し側で
      // payload.ruby_photoshop_offset_em / ruby_photoshop_bias_px が渡される。
      var PHOTOSHOP_RUBY_TO_PARENT_OFFSET_EM =
        (typeof rubyPhotoshopOffsetEm === "number" && isFinite(rubyPhotoshopOffsetEm))
          ? rubyPhotoshopOffsetEm : 0;
      // rubyPhotoshopBiasPx は「**13pt フォント前提**」の px 値として扱い、
      // 実際の親文字 fontSize に比例して拡縮する。
      //   実際の bias = 設定値 × (parentFontSizePt / 13)
      // 例: 設定値 7.5 なら、24pt で 7.5 × (24/13) ≈ 13.8px。
      var PHOTOSHOP_RUBY_PARENT_BIAS_REF_PT = 13;  // 設定値の基準フォントサイズ
      var __biasPxBase = (typeof rubyPhotoshopBiasPx === "number" && isFinite(rubyPhotoshopBiasPx))
        ? rubyPhotoshopBiasPx : 0;
      var __parentSizePtForBias = 13;
      try {
        var __pSizePt2 = parentLayer.textItem.size.value;
        if (typeof __pSizePt2 === "number" && __pSizePt2 > 0) __parentSizePtForBias = __pSizePt2;
      } catch (ePtBias) {}
      var PHOTOSHOP_RUBY_PARENT_BIAS_PX = __biasPxBase * (__parentSizePtForBias / PHOTOSHOP_RUBY_PARENT_BIAS_REF_PT);
      // 親 1em の PSD px 値を取得 (親 fontSize * dpi/72)
      var parentEmPx = parentEmPxForLayer(parentLayer, doc);
      if (!hasUiAbs) {
        if (parentDirection === "vertical") {
          rubyCenterX -= parentEmPx * PHOTOSHOP_RUBY_TO_PARENT_OFFSET_EM;
          rubyCenterX += PHOTOSHOP_RUBY_PARENT_BIAS_PX;
        } else {
          rubyCenterY += parentEmPx * PHOTOSHOP_RUBY_TO_PARENT_OFFSET_EM;
          rubyCenterY -= PHOTOSHOP_RUBY_PARENT_BIAS_PX;
        }
      }
      // ルビの top-left は中心からルビ寸法の半分引いた値。
      targetLeft = rubyCenterX - rubyWidth / 2;
      targetTop = rubyCenterY - rubyHeight / 2;
    } else {
      // 計算式 fallback (旧挙動): char range bounds の指定エッジに揃える。
      // ルビと親の隙間（px）。0 にすると密着、大きくすると離れる。実用上 2〜4 px が良い。
      var gap = 2;
      if (parentDirection === "vertical") {
        // 縦書き: ルビは親 char range の **右** に配置。
        var rangeMidV = (rangeBounds.top + rangeBounds.bottom) / 2;
        if (isParentMarkRuby) {
          var parentMarkCenterX = (rangeBounds.left + rangeBounds.right) / 2 + parentEmPxForLayer(parentLayer, doc) * parentMarkOffsetEm;
          targetLeft = parentMarkCenterX - rubyWidth / 2;
        } else if (parentLineIndex > 0) {
          var laterLineRubyCenterX = (rangeBounds.left + rangeBounds.right) / 2 + parentEmPxForLayer(parentLayer, doc) * LATER_LINE_RUBY_PARENT_OFFSET_EM;
          targetLeft = laterLineRubyCenterX - rubyWidth / 2;
        } else {
          targetLeft = rangeBounds.right + parentEmPxForLayer(parentLayer, doc) * NORMAL_FIRST_LINE_RUBY_GAP_EM;
        }
        targetTop = rangeMidV - rubyHeight / 2;
      } else {
        // 横書き: 2 行目以降は前行との中間、1 行目は親の右側に配置。
        var rangeMidH = (rangeBounds.left + rangeBounds.right) / 2;
        targetLeft = rangeMidH - rubyWidth / 2;
        if (isParentMarkRuby) {
          var parentMarkCenterXH = rangeMidH + parentEmPxForLayer(parentLayer, doc) * parentMarkOffsetEm;
          targetLeft = parentMarkCenterXH - rubyWidth / 2;
          targetTop = (rangeBounds.top + rangeBounds.bottom) / 2 - rubyHeight / 2;
        } else if (isFirstLineNormalRuby) {
          targetLeft = rangeBounds.right + parentEmPxForLayer(parentLayer, doc) * NORMAL_FIRST_LINE_RUBY_GAP_EM;
          targetTop = (rangeBounds.top + rangeBounds.bottom) / 2 - rubyHeight / 2;
        } else if (parentLineIndex > 0) {
          var laterLineRubyCenterY = (rangeBounds.top + rangeBounds.bottom) / 2 - parentEmPxForLayer(parentLayer, doc) * LATER_LINE_RUBY_PARENT_OFFSET_EM;
          targetTop = laterLineRubyCenterY - rubyHeight / 2;
        } else {
          targetTop = rangeBounds.top - rubyHeight - gap;
        }
      }
    }
    if (!isParentMarkRuby && !isFirstLineNormalRuby) {
      var normalRubyParentNudgePx = parentEmPxForLayer(parentLayer, doc) * NORMAL_RUBY_PARENT_NUDGE_EM;
      if (parentDirection === "vertical") {
        targetLeft -= normalRubyParentNudgePx;
      } else {
        targetTop += normalRubyParentNudgePx;
      }
    }
    var dx = targetLeft - actualLeft;
    var dy = targetTop - actualTop;
    if (dx !== 0 || dy !== 0) {
      rubyLayer.translate(new UnitValue(dx, "px"), new UnitValue(dy, "px"));
    }
    try {
      var rbCheck = getLayerBoundsPx(rubyLayer);
      if (rbCheck) {
        var checkCenterX = (rbCheck.left + rbCheck.right) / 2;
        var checkCenterY = (rbCheck.top + rbCheck.bottom) / 2;
        var wantedCenterX = targetLeft + rubyWidth / 2;
        var wantedCenterY = targetTop + rubyHeight / 2;
        var fixCenterDx = wantedCenterX - checkCenterX;
        var fixCenterDy = wantedCenterY - checkCenterY;
        if (Math.abs(fixCenterDx) > 0.01 || Math.abs(fixCenterDy) > 0.01) {
          rubyLayer.translate(new UnitValue(fixCenterDx, "px"), new UnitValue(fixCenterDy, "px"));
        }
      }
    } catch (eCenterFix) {}
  } catch (ePlace) {}

  // 親の直前に move（順序: 元の親 layer の真上）
  try {
    rubyLayer.move(parentLayer, ElementPlacement.PLACEBEFORE);
  } catch (eMove) {}
  return rubyLayer;
}

// 親レイヤー全体の bounds を px 単位で取得。
// boundsNoEffects を優先（layer 効果 = strokeEffect / drop shadow 等を除外したテキスト実体の bounds）。
// 親テキストに白フチがあると bounds は拡大されルビが実テキストから離れすぎてしまう。
// boundsNoEffects が無い古い PS バージョンでは通常の bounds にフォールバック。
function getLayerBoundsPx(layer) {
  try {
    var bne = layer.boundsNoEffects;
    return {
      left: bne[0].as("px"),
      top: bne[1].as("px"),
      right: bne[2].as("px"),
      bottom: bne[3].as("px")
    };
  } catch (eNoEff) {
    try {
      var b = layer.bounds;
      return {
        left: b[0].as("px"),
        top: b[1].as("px"),
        right: b[2].as("px"),
        bottom: b[3].as("px")
      };
    } catch (e) { return null; }
  }
}

// contents の改行構造から char range のおおまかな bounds を推定。
// 縦書き(vertical-rl): 各行 = 列、lines[0] が一番右の列。char range の縦位置は
//   その列内の char offset と「全行の最大長」から計算。これにより行ごとに長さが違っても
//   char height が同じになり、複数行で char index と縦位置が整合する。
// 横書き: 同様に「全行の最大長」で行内 char width を統一。
// Phase A の精度として、per-char size override や複雑な改行は誤差が出る可能性あり。
function estimateCharRangeBounds(parentBounds, contents, fromCh, toCh, parentDirection) {
  var fullText = String(contents || "");
  var lines = [];
  var lineStartChs = [];
  var lineStartCh = 0;
  var lineBreakRe = /\r\n|\r|\n/g;
  var lineBreak;
  while ((lineBreak = lineBreakRe.exec(fullText)) !== null) {
    lineStartChs.push(lineStartCh);
    lines.push(fullText.substring(lineStartCh, lineBreak.index));
    lineStartCh = lineBreak.index + lineBreak[0].length;
  }
  lineStartChs.push(lineStartCh);
  lines.push(fullText.substring(lineStartCh));
  if (lines.length === 0) return parentBounds;
  // 各行が contents 内で開始する char index と長さを事前計算。
  var maxLineLen = 0;
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].length > maxLineLen) maxLineLen = lines[i].length;
  }
  if (maxLineLen === 0) return parentBounds;

  // fromCh / toCh が属する行（0-based）と行内 offset を計算
  var fromLine = 0, fromOffset = 0;
  var toLine = 0, toOffset = 0;
  for (var j = 0; j < lines.length; j++) {
    var lineEnd = lineStartChs[j] + lines[j].length;
    if (fromCh >= lineStartChs[j] && fromCh <= lineEnd) {
      fromLine = j; fromOffset = fromCh - lineStartChs[j];
    }
    if (toCh > lineStartChs[j] && toCh <= lineEnd) {
      toLine = j; toOffset = toCh - lineStartChs[j];
    }
  }

  var totalLines = lines.length;
  var width = parentBounds.right - parentBounds.left;
  var height = parentBounds.bottom - parentBounds.top;

  if (parentDirection === "vertical") {
    // 縦書き(vertical-rl): lines[0] が一番右の列、列幅 = width / totalLines。
    // 列内の char 高さ = height / maxLineLen で均等配置（行長が違っても char height 統一）。
    var colW = width / totalLines;
    var charH = height / maxLineLen;
    var rightOfRange = parentBounds.right - fromLine * colW;
    var leftOfRange = rightOfRange - colW;
    // 行内の縦位置: fromOffset 番目の char の top を起点
    var topY = parentBounds.top + fromOffset * charH;
    var bottomY = (fromLine === toLine)
      ? parentBounds.top + toOffset * charH
      : parentBounds.top + lines[fromLine].length * charH; // 跨る場合は fromLine 末まで
    if (bottomY <= topY) bottomY = topY + charH * 0.5; // 安全策
    return {
      left: leftOfRange,
      right: rightOfRange,
      top: topY,
      bottom: bottomY,
    };
  }
  // 横書き: lines[0] が一番上の行、行高 = height / totalLines。
  // 行内 char 幅 = width / maxLineLen。
  var rowH = height / totalLines;
  var charW = width / maxLineLen;
  var topOfRange = parentBounds.top + fromLine * rowH;
  var bottomOfRange = topOfRange + rowH;
  var leftSide = parentBounds.left + fromOffset * charW;
  var rightSide = (fromLine === toLine)
    ? parentBounds.left + toOffset * charW
    : parentBounds.left + lines[fromLine].length * charW;
  if (rightSide <= leftSide) rightSide = leftSide + charW * 0.5;
  return {
    top: topOfRange,
    bottom: bottomOfRange,
    left: leftSide,
    right: rightSide,
  };
}

// 【v1.22.0】===== 記号フォント自動置換（♡♥★☆♪♫♬♩♯♭→←↑↓〇○●◎△▲▽▼□■◇◆♠♣♦） =====
// 写植本体フォントが対応していない記号類を別フォント（小塚ゴシック Pr6N R 等）で組む。
// 既存・新規両方のレイヤーに適用。プレビュー側（canvas-tools.js の SYMBOL_CHAR_CODES）と
// 同じ char code 集合を使う。
//
// skip 条件: per-char で手動指定したフォント (charFonts[i]) がある char のみ触らない。
// それ以外の記号 char は無条件に symbolFontPS で上書きする。
//
// 【v2.x 修正】旧仕様の「レイヤー既定フォント !== symbolFontPS なら skip」は撤去。
// F910 コミック等の display フォントで ♡ グリフが無いケースで記号が壊れる事故を防ぐため、
// 「per-char 手動指定が無ければ常に置換」に統一。中丸ゴシック等の記号対応フォントで
// ♡ をそのフォントのまま残したい場合は per-char 指定で守れる。
//
// 実装: applyPerCharSizesAndFonts と同型の clone-and-replace パターン。各 char の
// 「effective font」を「手動指定 (charFonts[i]) > 記号置換 > レンジ既存スタイル」の優先順で
// 解決し、置換が必要な char だけ font を上書きする。
function applySymbolFont(layer, contents, symbolFontPS, charFonts) {
  if (typeof symbolFontPS !== "string" || symbolFontPS.length === 0) return;

  // プレビュー側 SYMBOL_CHAR_CODES と完全一致。char code 直接判定（regex 回避）。
  function isSymbolChar(s) {
    var c = s.charCodeAt(0);
    return (
      c === 0x2661 || c === 0x2665 || c === 0x2764 ||                       // hearts
      c === 0x2605 || c === 0x2606 ||                                       // stars
      c === 0x266A || c === 0x266B || c === 0x266C || c === 0x2669 ||       // music notes
      c === 0x266F || c === 0x266D ||                                       // sharp / flat
      c === 0x2192 || c === 0x2190 || c === 0x2191 || c === 0x2193 ||       // arrows
      c === 0x25CB || c === 0x25CF || c === 0x3007 || c === 0x25CE ||       // circles
      c === 0x25B3 || c === 0x25B2 || c === 0x25BD || c === 0x25BC ||       // triangles
      c === 0x25A1 || c === 0x25A0 ||                                       // squares
      c === 0x25C7 || c === 0x25C6 ||                                       // diamonds
      c === 0x2660 || c === 0x2663 || c === 0x2666                          // suits
    );
  }
  function readManualFont(idx) {
    var v = charFonts ? charFonts[String(idx)] : undefined;
    return (typeof v === "string" && v.length > 0) ? v : null;
  }

  var fullText = String(contents);
  if (fullText.length === 0) return;

  // 記号文字の置換は per-char 手動指定がない限り常に発動する。
  var fontPerChar = [];
  var anyReplace = false;
  for (var i = 0; i < fullText.length; i++) {
    if (!isSymbolChar(fullText.charAt(i))) {
      fontPerChar[i] = null;
      continue;
    }
    if (readManualFont(i) !== null) {
      // per-char で手動指定あり → ユーザー意図を尊重して触らない
      fontPerChar[i] = null;
      continue;
    }
    // 記号 char + 手動指定なし → symbolFontPS で上書き
    fontPerChar[i] = symbolFontPS;
    anyReplace = true;
  }
  if (!anyReplace) return;

  app.activeDocument.activeLayer = layer;
  var layerRef = new ActionReference();
  layerRef.putEnumerated(sID("layer"), sID("ordinal"), sID("targetEnum"));
  var layerDesc = executeActionGet(layerRef);
  if (!layerDesc.hasKey(sID("textKey"))) return;
  var textKey = layerDesc.getObjectValue(sID("textKey"));
  var oldRanges = textKey.getList(sID("textStyleRange"));
  if (oldRanges.count === 0) return;

  var srcRangeIndex = [];
  var totalChars = 0;
  for (var r = 0; r < oldRanges.count; r++) {
    var rd = oldRanges.getObjectValue(r);
    var fromCh = rd.getInteger(sID("from"));
    var toCh = rd.getInteger(sID("to"));
    if (toCh > totalChars) totalChars = toCh;
    for (var c = fromCh; c < toCh; c++) srcRangeIndex[c] = r;
  }
  if (totalChars === 0) return;

  // (srcRangeIndex, fontPerChar) 境界で textStyleRange を再構築。
  var newRangeList = new ActionList();
  if (typeof srcRangeIndex[0] !== "number") srcRangeIndex[0] = 0;
  var curStart = 0;
  var curSrc = srcRangeIndex[0];
  var curFont = fontPerChar[0] || null;

  for (var p = 1; p <= totalChars; p++) {
    var nextSrc, nextFont, boundary;
    if (p === totalChars) {
      boundary = true;
      nextSrc = curSrc; nextFont = curFont;
    } else {
      nextSrc = (typeof srcRangeIndex[p] === "number") ? srcRangeIndex[p] : curSrc;
      nextFont = fontPerChar[p] || null;
      boundary = (nextSrc !== curSrc) || (nextFont !== curFont);
    }
    if (boundary) {
      var srcRange = oldRanges.getObjectValue(curSrc);
      var srcStyle = srcRange.getObjectValue(sID("textStyle"));
      var styleClone = cloneActionDescriptor(srcStyle);
      if (curFont !== null) {
        // 【v2.x】per-char フォントも Photoshop 認識 PS 名に解決してから書く。
        // cache 経由なので同じフォント名の連続では実質コスト 0。
        try { styleClone.putString(sID("fontPostScriptName"), resolvePhotoshopFontPS(curFont)); } catch (eFn) {}
      }
      var newRangeDesc = new ActionDescriptor();
      newRangeDesc.putInteger(sID("from"), curStart);
      newRangeDesc.putInteger(sID("to"), p);
      newRangeDesc.putObject(sID("textStyle"), sID("textStyle"), styleClone);
      newRangeList.putObject(sID("textStyleRange"), newRangeDesc);
      curStart = p;
      curSrc = nextSrc;
      curFont = nextFont;
    }
  }

  var newTextKey = cloneActionDescriptor(textKey);
  newTextKey.putList(sID("textStyleRange"), newRangeList);
  var setDesc = new ActionDescriptor();
  setDesc.putReference(sID("null"), layerRef);
  // applyRepeatedDashTracking と同じ理由で "textLayer" class を使う（textKey class だと
  // per-character スタイル変更が破棄されるケースがある既知問題）。
  setDesc.putObject(sID("to"), sID("textLayer"), newTextKey);
  executeAction(sID("set"), setDesc, DialogModes.NO);
}

// 【v1.22.0】===== 句読点ツメ（、 / 。 を mojiZume N% で詰める） =====
// 漫画写植慣例の「読点・句点後の不自然な空白を詰める」処理。Photoshop の Character パネルの
// 「ツメ」属性を Action Manager 経由で per-character に当てる。プレビュー（CSS）には
// 反映しない（Photoshop 専用機能）。
//
// ★重要 (1)★ 現代 Photoshop (CC 2018+) における tsume の正式 string ID 名は **`mojiZume`**
// （日本語「文字詰め」の音読み）。旧来 `tsume` / charID `PrTs` は登録されていない TypeID と
// 一致しないため put が silently ignore される（実機ダンプで判明：textStyle の key 一覧に
// `mojiZume` が出現、`tsume` は出現しない）。
//
// ★重要 (2)★ `mojiZume` の値スケールは **0〜1 の fraction**（percentUnit 経由でも内部的には
// 0〜1）。50 をそのまま渡すと PS が 5000% と解釈して bbox が異常崩壊し、text が見えなくなる。
// 50% を表現するには 0.5 を渡す。実機検証で text invisible 症状から逆算判明。
//
// 既存・新規両方のレイヤーに適用。
function applyPunctuationTsume(layer, contents, tsumePct) {
  var pct = Number(tsumePct) || 0;
  if (pct <= 0) return;
  // 0-100 にクランプ
  if (pct > 100) pct = 100;

  // 対象は「、」「。」「「」「」」「〝」「〟」。
  function isPunctChar(s) {
    var c = s.charCodeAt(0);
    return c === 0x3001 || c === 0x3002 ||
           c === 0x300C || c === 0x300D ||
           c === 0x301D || c === 0x301F;
  }

  var fullText = String(contents);
  if (fullText.length === 0) return;

  // 各 char にツメを当てるか。1 文字でも該当があれば処理続行。
  var hasAny = false;
  var punctFlag = [];
  for (var i = 0; i < fullText.length; i++) {
    var hit = isPunctChar(fullText.charAt(i));
    punctFlag[i] = hit;
    if (hit) hasAny = true;
  }
  if (!hasAny) return;

  // 現代 Photoshop の正式 key 名は "mojiZume"。レガシー "tsume" / "PrTs" はこの PS では効かない。
  var keyTsume = sID("mojiZume");
  var keyPctUnit = sID("percentUnit");

  app.activeDocument.activeLayer = layer;
  var layerRef = new ActionReference();
  layerRef.putEnumerated(sID("layer"), sID("ordinal"), sID("targetEnum"));
  var layerDesc = executeActionGet(layerRef);
  if (!layerDesc.hasKey(sID("textKey"))) return;
  var textKey = layerDesc.getObjectValue(sID("textKey"));
  var oldRanges = textKey.getList(sID("textStyleRange"));
  if (oldRanges.count === 0) return;

  var srcRangeIndex = [];
  var totalChars = 0;
  for (var r = 0; r < oldRanges.count; r++) {
    var rd = oldRanges.getObjectValue(r);
    var fromCh = rd.getInteger(sID("from"));
    var toCh = rd.getInteger(sID("to"));
    if (toCh > totalChars) totalChars = toCh;
    for (var c = fromCh; c < toCh; c++) srcRangeIndex[c] = r;
  }
  if (totalChars === 0) return;

  // (srcRangeIndex, punctFlag) 境界で textStyleRange を再構築。
  var newRangeList = new ActionList();
  if (typeof srcRangeIndex[0] !== "number") srcRangeIndex[0] = 0;
  var curStart = 0;
  var curSrc = srcRangeIndex[0];
  var curPunct = !!punctFlag[0];

  for (var p = 1; p <= totalChars; p++) {
    var nextSrc, nextPunct, boundary;
    if (p === totalChars) {
      boundary = true;
      nextSrc = curSrc; nextPunct = curPunct;
    } else {
      nextSrc = (typeof srcRangeIndex[p] === "number") ? srcRangeIndex[p] : curSrc;
      nextPunct = !!punctFlag[p];
      boundary = (nextSrc !== curSrc) || (nextPunct !== curPunct);
    }
    if (boundary) {
      var srcRange = oldRanges.getObjectValue(curSrc);
      var srcStyle = srcRange.getObjectValue(sID("textStyle"));
      var styleClone = cloneActionDescriptor(srcStyle);
      if (curPunct) {
        // mojiZume は 0〜1 の fraction を期待（50% → 0.5）。pct は 0-100 で受け取るので
        // 100 で割って fraction 化してから putUnitDouble へ渡す。
        try { styleClone.putUnitDouble(keyTsume, keyPctUnit, pct / 100); } catch (eTs) {}
      }
      var newRangeDesc = new ActionDescriptor();
      newRangeDesc.putInteger(sID("from"), curStart);
      newRangeDesc.putInteger(sID("to"), p);
      newRangeDesc.putObject(sID("textStyle"), sID("textStyle"), styleClone);
      newRangeList.putObject(sID("textStyleRange"), newRangeDesc);
      curStart = p;
      curSrc = nextSrc;
      curPunct = nextPunct;
    }
  }

  var newTextKey = cloneActionDescriptor(textKey);
  newTextKey.putList(sID("textStyleRange"), newRangeList);
  var setDesc = new ActionDescriptor();
  setDesc.putReference(sID("null"), layerRef);
  setDesc.putObject(sID("to"), sID("textLayer"), newTextKey);
  executeAction(sID("set"), setDesc, DialogModes.NO);
}

// ===== 連続記号「— ― 〜 ～」の自動ツメ =====
// 連続したラン（length >= 2）の最初の N-1 文字に tracking を当てる。最後の 1 文字は
// ツメない（次の通常文字との字間が詰まりすぎないように。プレビュー側 CSS の挙動と一致）。
// 既に textStyleRange が複数あれば（例：applyLineLeadings 後）、各範囲ごとに baseStyle を
// 引き継いで tracking を上書きするため、行ごとの行間と併用しても情報を失わない。
function applyRepeatedDashTracking(layer, contents, dashMille, tildeMille) {
  var dashTrack = (typeof dashMille === "number" && isFinite(dashMille)) ? dashMille : 0;
  var tildeKern = (typeof tildeMille === "number" && isFinite(tildeMille)) ? tildeMille : 0;
  // 対象文字を char code で判定。regex の Unicode リテラルは ExtendScript のファイル
  // エンコーディング（既定 Shift_JIS / Win JP）に左右されるため、char code 直接指定で安全に。
  // dash:  — U+2014 / ― U+2015 / – U+2013 / ‒ U+2012 / ‐ U+2010 / ‑ U+2011 / ー U+30FC / － U+FF0D
  // tilde: 〜 U+301C / ～ U+FF5E
  function charGroup(s) {
    var c = s.charCodeAt(0);
    // dash 系: ハイフン・ダッシュ・長音記号・全角ハイフン・罫線素片・マイナス記号・各種ダッシュ系類似文字
    if (c === 0x2014 || c === 0x2015 || c === 0x2013 || c === 0x2012 ||
        c === 0x2010 || c === 0x2011 || c === 0x30FC || c === 0xFF0D ||
        // 【v1.30.x】罫線素片 / マイナス記号 / 小書きダッシュも dash として扱う
        c === 0x2500 || c === 0x2501 || c === 0x2212 || c === 0x2043 ||
        c === 0xFE58 || c === 0xFE63) return "dash";
    // tilde 系: WAVE DASH, FULLWIDTH TILDE, ASCII TILDE, SMALL TILDE
    if (c === 0x301C || c === 0xFF5E || c === 0x007E || c === 0x02DC) return "tilde";
    return null;
  }
  var fullText = String(contents);
  if (fullText.length === 0) return;
  function putTrackingValue(styleDesc, value) {
    try { styleDesc.putInteger(sID("tracking"), value); } catch (eTrackA) {}
    try { styleDesc.putInteger(cID("Trck"), value); } catch (eTrackB) {}
  }

  // 各 char に当てる tracking 値（0 = ツメなし）。連続ランの最後の 1 文字は常に 0。
  // dash は textStyleRange の tracking、tilde は textLayer の kerningRange として別属性に書く。
  // 値が 0 のグループも textStyleRange を再構築して明示的に tracking=0 を書く。
  // これにより、以前の保存で PSD 側に残った「～～」等の tracking を確実に解除できる。
  var trackingPerChar = [];
  var groupPerChar = [];
  var tildeKerningRanges = [];
  for (var p0 = 0; p0 < fullText.length; p0++) trackingPerChar[p0] = 0;
  for (var g0 = 0; g0 < fullText.length; g0++) groupPerChar[g0] = "";
  var i = 0;
  var anyRepeatedRun = false;
  while (i < fullText.length) {
    var runGroup = charGroup(fullText.charAt(i));
    if (runGroup !== null) {
      var j = i;
      while (j < fullText.length && charGroup(fullText.charAt(j)) === runGroup) j++;
      // ラン長 N >= 2 のとき、最初の N-1 文字に group 別の tracking を当てる
      if (j - i >= 2) {
        anyRepeatedRun = true;
        for (var k = i; k < j - 1; k++) {
          if (runGroup === "dash") {
            trackingPerChar[k] = dashTrack;
          } else if (runGroup === "tilde") {
            trackingPerChar[k] = 0;
            tildeKerningRanges.push({ from: k, to: k + 1, kerning: tildeKern });
          }
          groupPerChar[k] = runGroup;
        }
        groupPerChar[j - 1] = runGroup + "-tail";
      }
      i = j;
    } else {
      i++;
    }
  }
  if (!anyRepeatedRun) return;

  app.activeDocument.activeLayer = layer;
  var layerRef = new ActionReference();
  layerRef.putEnumerated(sID("layer"), sID("ordinal"), sID("targetEnum"));
  var layerDesc = executeActionGet(layerRef);
  if (!layerDesc.hasKey(sID("textKey"))) return;
  var textKey = layerDesc.getObjectValue(sID("textKey"));
  var oldRanges = textKey.getList(sID("textStyleRange"));
  if (oldRanges.count === 0) return;

  // 各 char index がどの old range に属するかを記録
  var srcRangeIndex = [];
  var totalChars = 0;
  for (var r = 0; r < oldRanges.count; r++) {
    var rd = oldRanges.getObjectValue(r);
    var fromCh = rd.getInteger(sID("from"));
    var toCh = rd.getInteger(sID("to"));
    if (toCh > totalChars) totalChars = toCh;
    for (var c = fromCh; c < toCh; c++) srcRangeIndex[c] = r;
  }
  if (totalChars === 0) return;

  // (srcRangeIndex, trackingValue, groupKind) が連続している区間に圧縮し、textStyleRange を再構築。
  // groupKind も boundary に含めることで、dash と tilde が同じ 0 値を持つ境界でも
  // Photoshop 側に別レンジとして渡し、後段のレンジ畳み込みで片方の値だけが残る状況を避ける。
  var newRangeList = new ActionList();
  if (typeof srcRangeIndex[0] !== "number") srcRangeIndex[0] = 0;
  var curStart = 0;
  var curSrc = srcRangeIndex[0];
  var curTrack = trackingPerChar[0] || 0;
  var curGroup = groupPerChar[0] || "";

  for (var p = 1; p <= totalChars; p++) {
    var nextSrc, nextTrack, nextGroup, boundary;
    if (p === totalChars) {
      boundary = true;
      nextSrc = curSrc;
      nextTrack = curTrack;
      nextGroup = curGroup;
    } else {
      nextSrc = (typeof srcRangeIndex[p] === "number") ? srcRangeIndex[p] : curSrc;
      nextTrack = trackingPerChar[p] || 0;
      nextGroup = groupPerChar[p] || "";
      boundary = (nextSrc !== curSrc) || (nextTrack !== curTrack) || (nextGroup !== curGroup);
    }
    if (boundary) {
      var srcRange = oldRanges.getObjectValue(curSrc);
      var srcStyle = srcRange.getObjectValue(sID("textStyle"));
      var styleClone = cloneActionDescriptor(srcStyle);
      putTrackingValue(styleClone, curTrack);
      var newRangeDesc = new ActionDescriptor();
      newRangeDesc.putInteger(sID("from"), curStart);
      newRangeDesc.putInteger(sID("to"), p);
      newRangeDesc.putObject(sID("textStyle"), sID("textStyle"), styleClone);
      newRangeList.putObject(sID("textStyleRange"), newRangeDesc);
      curStart = p;
      curSrc = nextSrc;
      curTrack = nextTrack;
      curGroup = nextGroup;
    }
  }

  var newTextKey = cloneActionDescriptor(textKey);
  newTextKey.putList(sID("textStyleRange"), newRangeList);
  if (tildeKerningRanges.length > 0) {
    // Photoshop の kerningRange は前方順で複数渡すと最後だけ効くバージョンがあるため、
    // 終端側から並べる。
    tildeKerningRanges.sort(function (a, b) { return b.from - a.from; });
    var kernList = new ActionList();
    for (var kr = 0; kr < tildeKerningRanges.length; kr++) {
      var item = tildeKerningRanges[kr];
      var kernDesc = new ActionDescriptor();
      kernDesc.putInteger(sID("from"), item.from);
      kernDesc.putInteger(sID("to"), item.to);
      kernDesc.putInteger(sID("kerning"), item.kerning);
      kernList.putObject(sID("kerningRange"), kernDesc);
    }
    newTextKey.putList(sID("kerningRange"), kernList);
  }
  var setDesc = new ActionDescriptor();
  setDesc.putReference(sID("null"), layerRef);
  // class は "textLayer" (charID "TxtL") を指定。"textKey" を指定すると Photoshop が
  // 渡された textStyleRange を破棄して既存値を保持するケースがあるため、tracking のような
  // per-character スタイル変更は "textLayer" class で set する必要がある。
  setDesc.putObject(sID("to"), sID("textLayer"), newTextKey);
  executeAction(sID("set"), setDesc, DialogModes.NO);
}

// 半角 !! / !? を「縦中横」(textStyleRange の baselineDirection=cross) に。
// 新規・縦書きレイヤーのみ対象。先頭から貪欲に 2 文字単位でペア化し、3 文字以上連続の
// とき余り 1 文字は単独 (ユーザー仕様)。例: "!!!" → 先頭 !! のみ tcy / "!!?" → !! のみ tcy。
//
// 実機検証で判明:
//   Photoshop は縦中横を `textStyleRange.textStyle.baselineDirection = cross` という
//   enum 値で実装している。"cross" は「縦書きの line direction に対して垂直 (= 横並び)」を
//   意味し、これが縦中横の本質的な挙動。手動で縦中横を適用済みの PSD で当該レンジを
//   読むと bd=cross / 通常レンジは bd=(なし) になっていることを確認済み。
//
// 実装方針:
//   1) clone-and-replace 方式で textStyleRange を per-character 再構築 (フォント等のスタイルを保持)
//   2) ペア該当レンジに putEnumerated(baselineDirection, baselineDirection, cross) を当てる
//   3) ペア外レンジは clone した style をそのまま (baselineDirection を触らない)
//   4) set は textLayer クラス (tracking と同じパターン)
function applyTateChuYoko(layer, contents, enabled, direction, charTateChuYokos) {
  var hasManual = charTateChuYokos && !isObjEmpty(charTateChuYokos);
  if (!enabled && !hasManual) return;
  if (direction !== "vertical") return;
  var fullText = String(contents);
  if (fullText.length < 1) return;

  // 【v2.x】TCY enabled かつ縦書きのとき、全角「！！」「！？」を半角「!!」「!?」に変換。
  // Photoshop の baselineDirection: cross は半角の合成 glyph 化が安定しており、全角だと
  // cross 属性を当てても縦に並んだまま残るケースが実機で確認されているため (CLAUDE.md 参照)。
  // 半角化は char index 1:1 (全角 1 文字 → 半角 1 文字) なので、後段の per-char 系
  // (applyLineLeadings / applyPerCharSizesAndFonts / applyPerCharBolds / applyRubies /
  // applySymbolFont / applyPunctuationTsume) も影響なし。
  if (enabled) {
    var halfText = normalizeFullWidthToHalfTcy(fullText, true);
    if (halfText !== fullText) {
      try { layer.textItem.contents = normalizeLineBreaks(halfText); } catch (eHalfSet) {}
      fullText = halfText;
    }
  }

  // 自動 TCY 対象:
  //   1) 半角数字 2 桁の連続 (例: "12", "85") — 縦書き写植の標準慣行
  //   2) 半角「!!」「!?」ペア — 上記の半角化変換後にも検出
  // それ以外 (charTateChuYokos[i] === true で指定された範囲) は手動 TCY として下で処理。
  var pairs = [];
  if (enabled) {
    var i = 0;
    while (i < fullText.length) {
      var ch = fullText.charAt(i);
      // 数字 2 桁検出
      if (ch >= "0" && ch <= "9") {
        var j = i + 1;
        while (j < fullText.length && fullText.charAt(j) >= "0" && fullText.charAt(j) <= "9") j++;
        if (j - i === 2) pairs.push({ start: i, end: j });
        i = j;
        continue;
      }
      // 「!!」「!?」「?!」「??」検出 (1 ペア = 2 文字)。半角化済みなので半角で判定。
      if ((ch === "!" || ch === "?") && i + 1 < fullText.length) {
        var next = fullText.charAt(i + 1);
        if (next === "!" || next === "?") {
          pairs.push({ start: i, end: i + 2 });
          i += 2;
          continue;
        }
      }
      i += 1;
    }
  }
  if (hasManual) {
    var mi = 0;
    while (mi < fullText.length) {
      if (charTateChuYokos[String(mi)] === true) {
        var mj = mi + 1;
        while (mj < fullText.length && charTateChuYokos[String(mj)] === true) mj++;
        if (mj - mi >= 2) pairs.push({ start: mi, end: mj });
        mi = mj;
      } else {
        mi++;
      }
    }
  }
  if (pairs.length > 1) {
    pairs.sort(function(a, b) {
      return (a.start - b.start) || (a.end - b.end);
    });
    var mergedPairs = [];
    for (var mpi = 0; mpi < pairs.length; mpi++) {
      var pr = pairs[mpi];
      var lastPair = mergedPairs.length > 0 ? mergedPairs[mergedPairs.length - 1] : null;
      if (lastPair && pr.start <= lastPair.end) {
        if (pr.end > lastPair.end) lastPair.end = pr.end;
      } else {
        mergedPairs.push({ start: pr.start, end: pr.end });
      }
    }
    pairs = mergedPairs;
  }
  if (pairs.length === 0) return;

  app.activeDocument.activeLayer = layer;
  var layerRef = new ActionReference();
  layerRef.putEnumerated(sID("layer"), sID("ordinal"), sID("targetEnum"));
  var layerDesc = executeActionGet(layerRef);
  if (!layerDesc.hasKey(sID("textKey"))) return;
  var textKey = layerDesc.getObjectValue(sID("textKey"));
  var oldRanges = textKey.getList(sID("textStyleRange"));
  if (oldRanges.count === 0) return;

  var srcRangeIndex = [];
  var totalChars = 0;
  for (var r = 0; r < oldRanges.count; r++) {
    var rd = oldRanges.getObjectValue(r);
    var fromCh = rd.getInteger(sID("from"));
    var toCh = rd.getInteger(sID("to"));
    if (toCh > totalChars) totalChars = toCh;
    for (var c = fromCh; c < toCh; c++) srcRangeIndex[c] = r;
  }
  if (totalChars === 0) return;

  // 各 char に pairId (0 = 非ペア、1+ = pairs[idx-1])。隣接ペアを別レンジに保つため。
  var pairId = [];
  for (var p0 = 0; p0 < totalChars; p0++) pairId[p0] = 0;
  for (var pi2 = 0; pi2 < pairs.length; pi2++) {
    var pp = pairs[pi2];
    for (var pc = pp.start; pc < pp.end && pc < totalChars; pc++) {
      pairId[pc] = pi2 + 1;
    }
  }

  // (srcRangeIndex, pairId) 境界で textStyleRange を再構築。pairId 差分で boundary。
  var newRangeList = new ActionList();
  if (typeof srcRangeIndex[0] !== "number") srcRangeIndex[0] = 0;
  var curStart = 0;
  var curSrc = srcRangeIndex[0];
  var curPair = pairId[0];
  for (var pos = 1; pos <= totalChars; pos++) {
    var nextSrc, nextPair, boundary;
    if (pos === totalChars) {
      boundary = true;
      nextSrc = curSrc;
      nextPair = curPair;
    } else {
      nextSrc = (typeof srcRangeIndex[pos] === "number") ? srcRangeIndex[pos] : curSrc;
      nextPair = pairId[pos];
      boundary = (nextSrc !== curSrc) || (nextPair !== curPair);
    }
    if (boundary) {
      var srcRange = oldRanges.getObjectValue(curSrc);
      var srcStyle = srcRange.getObjectValue(sID("textStyle"));
      var styleClone = cloneActionDescriptor(srcStyle);
      if (curPair > 0) {
        // ペア該当レンジのみ baselineDirection = cross を当てる (= 縦中横化)
        try {
          styleClone.putEnumerated(
            sID("baselineDirection"),
            sID("baselineDirection"),
            sID("cross")
          );
        } catch (eBD) {}
      }
      var newRangeDesc = new ActionDescriptor();
      newRangeDesc.putInteger(sID("from"), curStart);
      newRangeDesc.putInteger(sID("to"), pos);
      newRangeDesc.putObject(sID("textStyle"), sID("textStyle"), styleClone);
      newRangeList.putObject(sID("textStyleRange"), newRangeDesc);
      curStart = pos;
      curSrc = nextSrc;
      curPair = nextPair;
    }
  }

  var newTextKey = cloneActionDescriptor(textKey);
  newTextKey.putList(sID("textStyleRange"), newRangeList);
  var setDesc = new ActionDescriptor();
  setDesc.putReference(sID("null"), layerRef);
  setDesc.putObject(sID("to"), sID("textLayer"), newTextKey);
  try {
    executeAction(sID("set"), setDesc, DialogModes.NO);
  } catch (eSet) {
    addWarning("縦中横の適用に失敗: " + eSet);
  }
}

// 【v2.x】フォント名解決インデックス。アプリ側 (Tauri/Rust 経由) が渡してくる PS 名と、
// Photoshop の app.fonts が持つ PS 名が一致しないケース (CJK の DynaFont 系などで
// "-WIN-RKSJ-H" サフィックスを Photoshop 側だけが持っている、display 名+Regular で送っている等)
// に対応するため、applyToPsd 入口で 1 回だけ app.fonts を走査してインデックスを構築し、
// 以降は O(1) で wanted → Photoshop が認識する PS 名へ解決する。
// 解決失敗時は wanted をそのまま返す (= 現状挙動と同じ、回帰リスクなし)。
var __FONT_PS_SET = null;        // { "PS-NAME": true, ... }
var __FONT_BY_PREFIX = null;     // { "prefixBeforeHyphen": "fullPS" }、複数候補は -WIN-RKSJ-H 優先
var __FONT_BY_NAME = null;       // { "displayName": "fullPS" }
var __FONT_RESOLVE_CACHE = null; // { wanted: resolved } メモ
function buildFontIndex() {
  __FONT_PS_SET = {};
  __FONT_BY_PREFIX = {};
  __FONT_BY_NAME = {};
  __FONT_RESOLVE_CACHE = {};
  try {
    var n = app.fonts.length;
    for (var i = 0; i < n; i++) {
      var f = app.fonts[i];
      var ps = null, nm = null;
      try { ps = f.postScriptName; } catch (eFps) {}
      try { nm = f.name; } catch (eFnm) {}
      if (typeof ps === "string" && ps.length > 0) {
        __FONT_PS_SET[ps] = true;
        var hyphenIdx = ps.indexOf("-");
        if (hyphenIdx > 0) {
          var prefix = ps.substring(0, hyphenIdx);
          var existing = __FONT_BY_PREFIX[prefix];
          // 同じ prefix で複数候補ある場合は -WIN-RKSJ-H を最優先 (Windows 日本語 PS 用)。
          // 既に -WIN-RKSJ-H が入っている prefix は上書きしない。
          var isWinSjis = /-WIN-RKSJ-H$/.test(ps);
          var existingIsWinSjis = existing ? /-WIN-RKSJ-H$/.test(existing) : false;
          if (!existing || (isWinSjis && !existingIsWinSjis)) {
            __FONT_BY_PREFIX[prefix] = ps;
          }
        }
        if (typeof nm === "string" && nm.length > 0 && !__FONT_BY_NAME[nm]) {
          __FONT_BY_NAME[nm] = ps;
        }
      }
    }
  } catch (eIdx) {
    addWarning("フォント名解決インデックスの構築に失敗: " + eIdx);
  }
}
// 【v2.x】日本語フォント名 → 英字フォント名の翻訳辞書。
// DirectWrite (Windows) が「F910コミックW4-IPA Regular」のような日本語ローカライズ名を返すのに対し、
// Photoshop は英字 PS 名「F910ComicW4-IPA」で持っているケースを橋渡しする。
// 長いキーから順に置換するため、辞書はキー長降順で適用する (例: 「ゴシック」の前に「丸ゴシック」
// を試して、「丸ゴシック」が誤って「丸Gothic」になる事故を防ぐ)。
var __JP_TO_EN_FONT_DICT = {
  "丸ゴシック": "MaruGothic",
  "コミック": "Comic",
  "ヒラギノ": "Hiragino",
  "教科書体": "Kyokasho",
  "見出ミン": "MidashiMin",
  "見出ゴ": "MidashiGo",
  "リュウミン": "Ryumin",
  "角ゴシック": "KakuGothic",
  "明朝": "Mincho",
  "ゴシック": "Gothic",
  "新ゴ": "ShinGo",
  "丸ゴ": "Maru",
  "角ゴ": "KakuGo",
  "毛筆": "Mohitsu",
  "楷書": "Kaisho",
  "行書": "Gyosho",
  "じゅん": "Jun"
};
var __JP_TO_EN_FONT_KEYS_SORTED = null;
function transliterateJapaneseFontName(s) {
  if (typeof s !== "string") return s;
  if (!__JP_TO_EN_FONT_KEYS_SORTED) {
    __JP_TO_EN_FONT_KEYS_SORTED = [];
    for (var k in __JP_TO_EN_FONT_DICT) {
      if (__JP_TO_EN_FONT_DICT.hasOwnProperty(k)) __JP_TO_EN_FONT_KEYS_SORTED.push(k);
    }
    __JP_TO_EN_FONT_KEYS_SORTED.sort(function (a, b) { return b.length - a.length; });
  }
  var out = s;
  for (var i = 0; i < __JP_TO_EN_FONT_KEYS_SORTED.length; i++) {
    var key = __JP_TO_EN_FONT_KEYS_SORTED[i];
    out = out.split(key).join(__JP_TO_EN_FONT_DICT[key]);
  }
  return out;
}

function resolveDynaFontMaruGothicVariant(query) {
  if (typeof query !== "string" || query.length === 0) return null;
  var aliasMap = {
    "DFMaruGothic-Md": "DFMaruGothic-Md-WIN-RKSJ-H",
    "DFGMaruGothic-Md": "DFMaruGothic-Md-WING-RKSJ-H",
    "DFPMaruGothic-Md": "DFMaruGothic-Md-WINP-RKSJ-H"
  };
  var resolved = aliasMap[query] || null;
  return (resolved && __FONT_PS_SET[resolved]) ? resolved : null;
}

function resolvePhotoshopFontPS(wanted) {
  if (typeof wanted !== "string" || wanted.length === 0) return wanted;
  if (!__FONT_PS_SET) return wanted; // インデックス未構築なら素通し (フェイルセーフ)
  if (Object.prototype.hasOwnProperty.call(__FONT_RESOLVE_CACHE, wanted)) {
    return __FONT_RESOLVE_CACHE[wanted];
  }
  // 戦略 1〜5 を一塊にしたヘルパー (transliteration 後にも再利用するため関数化)。
  function __tryFontStrategies(query) {
    if (__FONT_PS_SET[query]) return query;
    var dynaMaru = resolveDynaFontMaruGothicVariant(query);
    if (dynaMaru) return dynaMaru;
    var withSuffix = query + "-WIN-RKSJ-H";
    if (__FONT_PS_SET[withSuffix]) return withSuffix;
    if (__FONT_BY_PREFIX[query]) return __FONT_BY_PREFIX[query];
    var trimmed = query.replace(/\s+Regular$/i, "");
    if (trimmed !== query) {
      if (__FONT_PS_SET[trimmed]) return trimmed;
      var trimmedSuffix = trimmed + "-WIN-RKSJ-H";
      if (__FONT_PS_SET[trimmedSuffix]) return trimmedSuffix;
      if (__FONT_BY_PREFIX[trimmed]) return __FONT_BY_PREFIX[trimmed];
    }
    if (__FONT_BY_NAME[query]) return __FONT_BY_NAME[query];
    return null;
  }
  var result = (function () {
    // 戦略 1〜5: wanted そのままで完全一致 / -WIN-RKSJ-H 付加 / prefix / Regular 剥がし / display 名一致
    var r = __tryFontStrategies(wanted);
    if (r) return r;
    // 【v2.x】戦略 6: 日本語 → 英字 翻訳して 1〜5 を再試行。DirectWrite が日本語ローカライズ名で
    // 返してくる ("F910コミックW4-IPA Regular") のを、Photoshop の英字 PS 名 ("F910ComicW4-IPA") に
    // 橋渡しするための変換。
    var translit = transliterateJapaneseFontName(wanted);
    if (translit !== wanted) {
      r = __tryFontStrategies(translit);
      if (r) return r;
    }
    // 【v2.x】戦略 7: ASCII プレフィックス + ウェイト (W\d+) でフォントを線形探索。
    // 翻訳辞書に無い日本語フォント名 / 部分日本語混在のときの最後の救済策。
    // 誤マッチを避けるため、wanted が明示的なウェイト指定 (W4 / W12 等) を持っているときのみ発動。
    var asciiPrefix = wanted.match(/^[\x21-\x7E]+/);
    var weightMatch = wanted.match(/W\d+/);
    if (asciiPrefix && asciiPrefix[0].length >= 3 && weightMatch) {
      var prefix = asciiPrefix[0];
      var weight = weightMatch[0];
      try {
        for (var i7 = 0; i7 < app.fonts.length; i7++) {
          var ps7 = null;
          try { ps7 = app.fonts[i7].postScriptName; } catch (eF7) {}
          if (typeof ps7 !== "string") continue;
          if (ps7.indexOf(prefix) !== 0) continue;
          if (ps7.indexOf(weight) < 0) continue;
          return ps7;
        }
      } catch (eS7) {}
    }
    // 【v2.x】戦略 8: Kozuka ファミリーの Pro ↔ Pr6N 自動フォールバック (同ウェイト維持)。
    // 例: KozGoPro-Heavy が未インストールでも KozGoPr6N-Heavy があれば後者を採用。
    //     KozMinPro-Bold が無ければ KozMinPr6N-Bold を試す、等。
    // Pro / Pr6N は文字集合が違うだけでグリフ形状はほぼ同じ (Pr6N は JIS 2004 改定対応で
    // 漢字が一部変わるが、記号文字 ♡♥★♪→ 等は完全に同形)。記号フォント置換用途では
    // 区別する必要なし。両方向 (Pro→Pr6N / Pr6N→Pro) で動作する。
    var kozuMatch = wanted.match(/^(Koz(?:Go|Min))(Pro|Pr6N)-(.+)$/);
    if (kozuMatch) {
      var kStem = kozuMatch[1];          // "KozGo" or "KozMin"
      var kFamily = kozuMatch[2];        // "Pro" or "Pr6N"
      var kWeight = kozuMatch[3];        // "Heavy", "Bold", "Regular", ...
      var kOther = (kFamily === "Pro") ? "Pr6N" : "Pro";
      var kSwapped = kStem + kOther + "-" + kWeight;
      if (__FONT_PS_SET[kSwapped]) return kSwapped;
    }
    // 解決失敗 → wanted のまま (現状挙動)
    return wanted;
  })();
  __FONT_RESOLVE_CACHE[wanted] = result;
  return result;
}

// 【v2.x】Photoshop の DOM `textItem.font = "..."` 代入は、指定 PostScript 名のフォントが
// インストールされていなかったり、ロード状態が安定していないと **silent failure** する
// （例外を投げず、内部のフォントが Photoshop デフォルト = 多くは小塚 Pr6N に置き換わる）。
// これを回避するため、Action Manager 経由で textStyleRange[*].textStyle.fontPostScriptName
// を直接書き込む確実な代入関数を提供する。DOM 代入と二重で当てることで、どちらかが
// 失敗しても他方で救う。
// 呼び出し側: applyToPsd の各レイヤー処理で nti.font / ti.font 代入の直後にこれを呼ぶ。
// per-char 手動指定 (charFonts) は後段の applyPerCharSizesAndFonts が clone-and-replace で
// 上書きするので、ここで全 range に同じ font を当てても無害（base として残る）。
function applyLayerFont(layer, postScriptName) {
  if (typeof postScriptName !== "string" || postScriptName.length === 0) return;
  // 【v2.x】Photoshop が認識できる PS 名に解決してから書く。インデックス未構築なら素通し。
  postScriptName = resolvePhotoshopFontPS(postScriptName);
  try {
    app.activeDocument.activeLayer = layer;
    var layerRef = new ActionReference();
    layerRef.putEnumerated(sID("layer"), sID("ordinal"), sID("targetEnum"));
    var layerDesc = executeActionGet(layerRef);
    if (!layerDesc.hasKey(sID("textKey"))) return;
    var textKey = layerDesc.getObjectValue(sID("textKey"));
    var oldRanges = textKey.getList(sID("textStyleRange"));
    if (oldRanges.count === 0) return;

    var newRangeList = new ActionList();
    for (var r = 0; r < oldRanges.count; r++) {
      var rd = oldRanges.getObjectValue(r);
      var fromCh = rd.getInteger(sID("from"));
      var toCh = rd.getInteger(sID("to"));
      var srcStyle = rd.getObjectValue(sID("textStyle"));
      var styleClone = cloneActionDescriptor(srcStyle);
      try { styleClone.putString(sID("fontPostScriptName"), postScriptName); } catch (eFn) {}
      var newRangeDesc = new ActionDescriptor();
      newRangeDesc.putInteger(sID("from"), fromCh);
      newRangeDesc.putInteger(sID("to"), toCh);
      newRangeDesc.putObject(sID("textStyle"), sID("textStyle"), styleClone);
      newRangeList.putObject(sID("textStyleRange"), newRangeDesc);
    }
    var newTextKey = cloneActionDescriptor(textKey);
    newTextKey.putList(sID("textStyleRange"), newRangeList);
    var setDesc = new ActionDescriptor();
    setDesc.putReference(sID("null"), layerRef);
    // set の class は sID("textLayer") を使う (sID("textKey") だと Photoshop が
    // 新 textStyleRange を破棄して既存値を保持するケースが既知 — applyRepeatedDashTracking
    // 等の per-character 系と同じパターン)。
    setDesc.putObject(sID("to"), sID("textLayer"), newTextKey);
    executeAction(sID("set"), setDesc, DialogModes.NO);
  } catch (e) {
    addWarning("レイヤーフォント設定に失敗 (" + postScriptName + "): " + e);
  }
}

function disableStrokeEffect(layerRef) {
  app.activeDocument.activeLayer = layerRef;
  var desc = new ActionDescriptor();
  var ref = new ActionReference();
  ref.putProperty(sID("property"), sID("layerEffects"));
  ref.putEnumerated(sID("layer"), sID("ordinal"), sID("targetEnum"));
  desc.putReference(sID("null"), ref);
  var fx = new ActionDescriptor();
  var stroke = new ActionDescriptor();
  stroke.putBoolean(sID("enabled"), false);
  // present/showInDialog を false にしないと、Photoshop は descriptor を保持し続け
  // レイヤーパネルに fx マーク + 「効果 / 境界線」のリスト表示が残る (描画はされない)。
  // ダイアログを開くとチェックは外れているのに表示だけ残る現象を防ぐため明示削除する。
  stroke.putBoolean(sID("present"), false);
  stroke.putBoolean(sID("showInDialog"), false);
  fx.putObject(sID("frameFX"), sID("frameFX"), stroke);
  desc.putObject(sID("to"), sID("layerEffects"), fx);
  try { executeAction(sID("set"), desc, DialogModes.NO); } catch (e) {}
}

// 【v2.x】Phase B 全レイヤー走査ヘルパー。「実効可視」(自レイヤー visible + 全祖先 LayerSet も visible)
// なテキストレイヤーだけ fn(l) を呼ぶ。
//
// **なぜ非表示を除外するか**: PsDesign の運用では、非表示テキストレイヤーは
// 「同じセリフの小塚版バックアップ」「OCR 直後の原文」「言語切替用の代替テキスト」など、
// ユーザーが意図的に元のフォント/スタイルで残してあるもの。Phase B が autoKerning や記号
// フォント置換 / 句読点ツメ等を強制適用すると、ユーザー意図を破壊することになる。
// 表示中レイヤーだけ統一処理し、隠したものは触らない方針へ変更 (旧仕様は visible/hidden 区別
// なしで全レイヤー処理)。Phase A (edits / newLayers ループ) はユーザーが触ったレイヤーだけが
// 対象なので元から影響なし。
function visitVisibleTextLayers(doc, fn) {
  function walk(parent, ancestorVisible) {
    for (var i = 0; i < parent.layers.length; i++) {
      var l = parent.layers[i];
      var thisVisible = ancestorVisible && (l.visible !== false);
      if (l.typename === "LayerSet") {
        walk(l, thisVisible);
      } else if (l.kind === LayerKind.TEXT && thisVisible) {
        fn(l);
      }
    }
  }
  walk(doc, true);
}

function rememberTextLayerForPhaseB(out, seen, layer) {
  if (!out || !seen || !layer) return;
  var isText = false;
  try { isText = (layer.kind === LayerKind.TEXT); } catch (eKind) {}
  if (!isText) return;
  var key = null;
  try {
    if (typeof layer.id === "number") key = "id:" + layer.id;
  } catch (eId) {}
  if (key) {
    if (seen[key]) return;
    seen[key] = true;
  }
  out.push(layer);
}

function rememberTextLayersForPhaseB(out, seen, layers) {
  if (!layers || !layers.length) return;
  for (var i = 0; i < layers.length; i++) {
    rememberTextLayerForPhaseB(out, seen, layers[i]);
  }
}

function visitPhaseBTextLayers(layers, fn) {
  if (!layers || !layers.length) return;
  for (var i = 0; i < layers.length; i++) {
    var l = layers[i];
    if (!l) continue;
    var isText = false;
    try {
      isText = (l.kind === LayerKind.TEXT);
    } catch (eVisitKind) {}
    if (!isText) continue;
    fn(l);
  }
}

// Phase B 対象として収集済みのテキストレイヤーに、共通設定を適用する。
//   - autoKerning = MANUAL (= UI の「カーニング: 0」、自動カーニング無効)
//   - antiAliasMethod = SHARP (= 「シャープ」)
//
// 【v2.x 修正】Photoshop の DOM `textItem.autoKerning = MANUAL` 代入は
// textStyleRange を flatten して font 等の per-character 属性をリセットすることがある
// (CLAUDE.md 「Phase B safety net 設計判断」参照)。これでユーザーが選んだ中丸ゴシック
// 等のレイヤー既定フォントが Photoshop デフォルト (= 多くの場合 KozGoPr6N-Regular) に
// 戻り、Phase B safety net `reapplySymbolFontForAllLayers` で記号位置を symbolFontPS
// に置換 → 結果として全テキストが小塚化、というシナリオを再発させていた。
// 対策: autoKerning / antiAliasMethod 設定の **前後で font を保存・復元** する。
// flatten が起きてもユーザー指定のフォントを温存する。
function applyDefaultTextSettingsToPhaseBLayers(layers) {
  visitPhaseBTextLayers(layers, function (l) {
    // 【v2.x 最適化 B】現状の autoKerning / antiAliasMethod を先に読み、既に望ましい値なら
    // 何もせずに早期 return。書込みコスト + autoKerning flatten + font 保存・復元の一連を
    // まるごと回避できる。PsDesign で過去に保存した PSD を再保存する典型ケース (= 既に
    // MANUAL / SHARP 設定済み) で 1 レイヤーあたり 200〜300ms 削減。
    var needsKerning = true;
    var needsAa = true;
    try {
      if (l.textItem.autoKerning === AutoKernType.MANUAL) needsKerning = false;
    } catch (eAkGet) { /* 取得失敗 → 念のため書き込む */ }
    try {
      if (l.textItem.antiAliasMethod === AntiAlias.SHARP) needsAa = false;
    } catch (eAaGet) { /* 同上 */ }
    if (!needsKerning && !needsAa) return;

    // 書き込みが必要な場合のみ font 保存・復元コストを払う。autoKerning は flatten を
    // 誘発するので font 退避が必須、antiAlias は flatten しないので退避不要。
    var savedFont = null;
    if (needsKerning) {
      try { savedFont = l.textItem.font; } catch (eFontGet) {}
    }
    if (needsKerning) {
      try { l.textItem.autoKerning = AutoKernType.MANUAL; } catch (eAk) {}
    }
    if (needsAa) {
      try { l.textItem.antiAliasMethod = AntiAlias.SHARP; } catch (eAa) {}
    }
    // flatten で font 情報がデフォルトに置き換わった場合は元の値で復元。
    // savedFont が null or 既に同値の場合は何もしない (副作用なし)。
    if (needsKerning && typeof savedFont === "string" && savedFont.length > 0) {
      try {
        var currentFont = l.textItem.font;
        if (currentFont !== savedFont) {
          l.textItem.font = savedFont;
        }
      } catch (eFontRestore) {}
    }
  });
}

// 【v1.22.0】DOM autoKerning 設定後に、句読点ツメを
// Phase B 対象テキストレイヤーに再適用する safety net。DOM access が一部の per-char 属性を flatten で
// 落とすケースに対応。冪等（既に正しい値が入っていれば動作変化なし）。
function reapplyPunctuationTsumeForPhaseBLayers(layers, tsumePct) {
  if (!tsumePct || tsumePct <= 0) return;
  visitPhaseBTextLayers(layers, function (l) {
    try {
      var ct = l.textItem.contents;
      if (typeof ct === "string" && ct.length > 0) {
        applyPunctuationTsume(l, ct, tsumePct);
      }
    } catch (eR) {}
  });
}

// 【写植再利用】PSD 内の全テキストレイヤー (LayerKind.TEXT) を再帰的に非表示にする。
// 抽出テキストを newLayers として作成し直す前に呼び、元テキストとの二重表示を防ぐ。
function hideAllTextLayers(container) {
  for (var i = 0; i < container.layers.length; i++) {
    var L = container.layers[i];
    var isSet = false;
    try { isSet = (L.typename === "LayerSet"); } catch (e) {}
    if (isSet) {
      hideAllTextLayers(L);
    } else {
      var isText = false;
      try { isText = (L.kind == LayerKind.TEXT); } catch (e) {}
      if (isText) {
        try { L.visible = false; } catch (e) {}
      }
    }
  }
}

// 【v1.31.x】DOM autoKerning 設定後に、
// 連続記号ツメ (dash / tilde) を Phase B 対象テキストレイヤーへ再適用する safety net。
function reapplyRepeatedTrackingForPhaseBLayers(layers, dashMille, tildeMille) {
  var dashTrack = (typeof dashMille === "number" && isFinite(dashMille)) ? dashMille : 0;
  var tildeTrack = (typeof tildeMille === "number" && isFinite(tildeMille)) ? tildeMille : 0;
  visitPhaseBTextLayers(layers, function (l) {
    try {
      var ct = l.textItem.contents;
      if (typeof ct === "string" && ct.length > 0) {
        applyRepeatedDashTracking(l, ct, dashTrack, tildeTrack);
      }
    } catch (eR) {}
  });
}

// 【写植再利用バグ修正】縦中横 (!! / !? / 半角2桁) の Phase B safety net。
// autoKerning DOM 設定が textStyleRange を flatten して
// baselineDirection=cross を落とすため、保存直前に Phase B 対象テキストレイヤーへ再適用する。
// レイヤーの組方向は PS から読み取り、縦書きのみ対象。冪等（半角化・cross 付与とも再実行安全）。
function reapplyTateChuYokoForPhaseBLayers(layers, enabled) {
  if (!enabled) return;
  visitPhaseBTextLayers(layers, function (l) {
    try {
      var ct = l.textItem.contents;
      if (typeof ct !== "string" || ct.length === 0) return;
      var dir = "horizontal";
      try { dir = (l.textItem.direction == Direction.VERTICAL) ? "vertical" : "horizontal"; } catch (eD) {}
      if (dir !== "vertical") return;
      applyTateChuYoko(l, ct, enabled, dir, null);
    } catch (eR) {}
  });
}

// 【v1.22.0】記号フォント置換の Phase B safety net。Phase B 対象テキストレイヤーに再適用。
// charFonts は null（この段階では payload 側の manual override 情報を参照しないため）。
// 【v2.x 修正】旧仕様で取得していた layerFont (l.textItem.font) は applySymbolFont 内部の
// skip 判定撤去に伴い不要になった。コミックフォント等の記号未収録レイヤーで ♡ が壊れる
// 事故を防ぐため、per-char 手動指定がない記号は **常に symbolFontPS で置換** する方針。
function reapplySymbolFontForPhaseBLayers(layers, symbolFontPS) {
  if (typeof symbolFontPS !== "string" || symbolFontPS.length === 0) return;
  visitPhaseBTextLayers(layers, function (l) {
    try {
      var ct = l.textItem.contents;
      if (typeof ct === "string" && ct.length > 0) {
        applySymbolFont(l, ct, symbolFontPS, null);
      }
    } catch (eR) {}
  });
}

function reapplyManualTextSpacingForPayload(doc, layerIdIndex, edits, newLayers) {
  function hasNonZeroNumber(v) {
    return typeof v === "number" && isFinite(v) && Math.round(v) !== 0;
  }
  function hasManualSpacing(entry) {
    return entry && (
      hasNonZeroNumber(entry.trackingMille) ||
      hasNonZeroNumber(entry.kerningMille) ||
      (entry.charTrackings && !isObjEmpty(entry.charTrackings)) ||
      (entry.charKernings && !isObjEmpty(entry.charKernings))
    );
  }
  function reapply(layer, entry, label) {
    if (!layer || layer.kind !== LayerKind.TEXT || !entry) return;
    try {
      if (hasNonZeroNumber(entry.trackingMille) || hasNonZeroNumber(entry.kerningMille)) {
        applyLayerTextSpacing(layer, entry.trackingMille, entry.kerningMille);
      }
    } catch (eLayerSpacing) {
      addWarning(label + " text spacing final reapply failed: " + eLayerSpacing);
    }
    try {
      if ((entry.charTrackings && !isObjEmpty(entry.charTrackings)) || (entry.charKernings && !isObjEmpty(entry.charKernings))) {
        var ct = "";
        try { ct = layer.textItem.contents; } catch (eTextContents) {}
        applyPerCharTextSpacing(layer, ct, entry.charTrackings, entry.charKernings);
      }
    } catch (eCharSpacing) {
      addWarning(label + " per-char text spacing final reapply failed: " + eCharSpacing);
    }
  }
  for (var i = 0; i < edits.length; i++) {
    var e = edits[i];
    if (!hasManualSpacing(e)) continue;
    reapply(findLayerByIdIndexed(doc, layerIdIndex, e.id), e, "layer " + e.id);
  }
  for (var j = 0; j < newLayers.length; j++) {
    var nl = newLayers[j];
    if (!hasManualSpacing(nl)) continue;
    var layer = (typeof nl.__createdLayerId === "number") ? findLayerByIdIndexed(doc, layerIdIndex, nl.__createdLayerId) : null;
    reapply(layer, nl, "new layer " + j);
  }
}

function applyToPsd(psdPath, edits, newLayers, savePath, dashTrackingMille, tildeTrackingMille, tateChuYokoEnabled, symbolFontPostScriptName, punctuationTsumePercent, rubyLeadingPct, rubyFontPostScriptName, rubyPhotoshopOffsetEm, rubyPhotoshopBiasPx, uiPageWidth, uiPageHeight, hideLayerIds, reuseHideOriginalText) {
  var file = new File(psdPath);
  if (!file.exists) { $.writeln("[OPUS] skip missing: " + psdPath); return; }
  var prevUnits = app.preferences.rulerUnits;
  var prevTypeUnits = app.preferences.typeUnits;
  app.preferences.rulerUnits = Units.PIXELS;
  app.preferences.typeUnits = TypeUnits.POINTS;
  // 【v2.x】「PSD/PSB ファイルの互換性を最大化」を Always Yes に強制する。
  // これが Never / Ask の場合、Photoshop が saveAs で「合成画像 (composite image)」
  // を埋め込まずに保存することがあり、次回 OPUS が ag-psd で読むときに
  // psd.canvas が空 (灰色 / 透明) → メインステージ / 仕上がりチェックで
  // PSD 絵柄が表示されない症状になる。Always Yes に強制セットすることで、
  // saveAs 時に必ず合成画像が含まれる PSD が出力され、次回読込で
  // psd.canvas が正しい絵柄を持つ。
  // executeAction 経由で preferences の queryStateChangedAlertCheckbox 等を回避し、
  // ダイアログを出さずに一時的に切り替え、保存後に元の設定へ戻す。
  var prevMaxCompat = null;
  try { prevMaxCompat = app.preferences.maximizeCompatibility; } catch (eMcGet) {}
  try { app.preferences.maximizeCompatibility = QueryStateType.ALWAYS; } catch (eMcSet) {
    // フォールバック: executeAction で psdMaxCompatibility を always に。
    try {
      var __mcDesc = new ActionDescriptor();
      var __mcRef = new ActionReference();
      __mcRef.putProperty(charIDToTypeID("Prpr"), stringIDToTypeID("fileSaveOptions"));
      __mcRef.putEnumerated(charIDToTypeID("capp"), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
      __mcDesc.putReference(charIDToTypeID("null"), __mcRef);
      var __mcSet = new ActionDescriptor();
      __mcSet.putEnumerated(stringIDToTypeID("maximizeCompatibility"), stringIDToTypeID("queryStateType"), stringIDToTypeID("always"));
      __mcDesc.putObject(charIDToTypeID("T   "), stringIDToTypeID("fileSaveOptions"), __mcSet);
      executeAction(charIDToTypeID("setd"), __mcDesc, DialogModes.NO);
    } catch (eMcFallback) {}
  }
  var doc = app.open(file);
  var __layerIdIndex = buildLayerIdIndex(doc);
  try {
    // 【写植再利用】reuseHideOriginalText: 元からあるテキストレイヤーを全て非表示にする。
    // 新規レイヤー (newLayers) はこの後に作成されるので隠れない。抽出テキストで写植し直す。
    if (reuseHideOriginalText === true) {
      try { hideAllTextLayers(doc); } catch (eHideAll) { addWarning("元テキスト一括非表示に失敗: " + eHideAll); }
    }
    // 【v2.x】フォント名解決インデックスを構築。以降 resolvePhotoshopFontPS が
    // app.fonts と照合した正しい PS 名に補正する。symbolFontPostScriptName も入口で
    // 一度だけ resolve しておくと、以降のループ内で繰り返し補正する必要がなくなる。
    buildFontIndex();
    if (typeof symbolFontPostScriptName === "string" && symbolFontPostScriptName.length > 0) {
      symbolFontPostScriptName = resolvePhotoshopFontPS(symbolFontPostScriptName);
    }
    var __rubyAbsScaleX = 1;
    var __rubyAbsScaleY = 1;
    var __phaseBTextLayers = [];
    var __phaseBTextLayerIds = {};
    try {
      var __docW = doc.width.as("px");
      var __docH = doc.height.as("px");
      if (typeof uiPageWidth === "number" && isFinite(uiPageWidth) && uiPageWidth > 0
          && typeof __docW === "number" && isFinite(__docW) && __docW > 0) {
        __rubyAbsScaleX = __docW / uiPageWidth;
      }
      if (typeof uiPageHeight === "number" && isFinite(uiPageHeight) && uiPageHeight > 0
          && typeof __docH === "number" && isFinite(__docH) && __docH > 0) {
        __rubyAbsScaleY = __docH / uiPageHeight;
      }
    } catch (eRubyAbsScale) {}
    for (var i = 0; i < edits.length; i++) {
      var e = edits[i];
      var layer = findLayerByIdIndexed(doc, __layerIdIndex, e.id);
      if (!layer) { $.writeln("[OPUS] layer " + e.id + " not found in " + psdPath); continue; }
      if (layer.kind !== LayerKind.TEXT) { $.writeln("[OPUS] layer " + e.id + " is not text"); continue; }
      if (e.deleted === true) {
        try { layer.visible = false; } catch (eDeleteHide) {
          addWarning("cut layer hide failed (layer " + e.id + "): " + eDeleteHide);
        }
        continue;
      }
      rememberTextLayerForPhaseB(__phaseBTextLayers, __phaseBTextLayerIds, layer);
      var ti = layer.textItem;
      if (typeof e.direction === "string") {
        try {
          if (e.direction === "vertical") ti.direction = Direction.VERTICAL;
          else if (e.direction === "horizontal") ti.direction = Direction.HORIZONTAL;
        } catch (eDirEx) {}
      }
      if (typeof e.contents === "string") ti.contents = normalizeLineBreaks(e.contents);
      if (typeof e.font === "string" && e.font.length > 0) {
        // 【v2.x】Photoshop が認識する PS 名 (例: -WIN-RKSJ-H サフィックス付き) に解決してから当てる。
        var __resolvedFontE = resolvePhotoshopFontPS(e.font);
        ti.font = __resolvedFontE;
        // 【v2.x】DOM `ti.font = ...` は silent failure する可能性があるため、
        // Action Manager 経由で textStyleRange.fontPostScriptName も直接書き込む。
        // 両方当てることで、フォントロード状態のばらつきや Photoshop バージョン差を吸収。
        try { applyLayerFont(layer, __resolvedFontE); } catch (eAlf) {}
      }
      if (typeof e.size === "number") ti.size = new UnitValue(e.size, "pt");
      if (typeof e.dx === "number" || typeof e.dy === "number") {
        var dx = (typeof e.dx === "number") ? e.dx : 0;
        var dy = (typeof e.dy === "number") ? e.dy : 0;
        if (dx !== 0 || dy !== 0) {
          layer.translate(new UnitValue(dx, "px"), new UnitValue(dy, "px"));
        }
      }
      // フチは文字装飾・ルビ・回転がすべて終わった後に一度だけ確定する。
      if (typeof e.fillColor === "string") {
        var fc = fillColorFor(e.fillColor);
        if (fc) {
          try { ti.color = fc; } catch (eFill) {
            addWarning("文字色の適用に失敗 (layer " + e.id + "): " + eFill);
          }
        }
      }
      // autoLeadingAmount は段落全体属性なので、これは元の leadingPct のまま設定する
      // (= デフォルトの「自動行送り」)。ルビあり行は後で paragraphStyleRange を分割して
      // autoLeadingPercentage を上書きする方式で per-line に変える。
      if (typeof e.leadingPct === "number") {
        try {
          ti.autoLeadingAmount = e.leadingPct;
          ti.useAutoLeading = true;
        } catch (eLead) {
          addWarning("行間の適用に失敗 (layer " + e.id + "): " + eLead);
        }
      }
      // 【v1.29.x】ルビあり時は textStyleRange の固定 leading ではなく、
      // paragraphStyleRange の autoLeadingPercentage を行ごとに当てる。
      // ルビなしのときは従来通り applyLineLeadings (ユーザー手動の per-line override)。
      var __hasRubyE = (e.charRubies && !isObjEmpty(e.charRubies));
      var __lineLeadingsE = __hasRubyE
        ? buildRubyLineLeadings(ti.contents, e.charRubies, e.lineLeadings, rubyLeadingPct)
        : e.lineLeadings;
      if (__lineLeadingsE && !isObjEmpty(__lineLeadingsE)) {
        try {
          var __sz = ti.size.value;
          if (__hasRubyE) {
            var __defLineMult = (typeof e.leadingPct === "number" && e.leadingPct > 0)
              ? (e.leadingPct / 100) : 1.0;
            applyLineLeadingPercentages(layer, ti.contents, __lineLeadingsE, __defLineMult);
          } else {
            applyLineLeadings(layer, __lineLeadingsE, ti.contents, __sz);
          }
        } catch (eLineLead) {
          addWarning("行ごとの行間の適用に失敗 (layer " + e.id + "): " + eLineLead);
        }
      }
      // 【v1.21.0】per-char サイズ・フォント。applyLineLeadings の後に呼ぶことで
      // 行間と per-char 設定が共存できる（baseStyle は前段で再構築された
      // textStyleRange から clone される）。
      if ((e.charSizes && !isObjEmpty(e.charSizes)) || (e.charFonts && !isObjEmpty(e.charFonts))) {
        try {
          applyPerCharSizesAndFonts(layer, ti.contents, e.charSizes, e.charFonts);
        } catch (ePerChar) {
          addWarning("文字ごとのサイズ・フォント適用に失敗 (layer " + e.id + "): " + ePerChar);
        }
      }
      // 【v1.22.0】合成太字（faux bold）。layer 全体 (e.syntheticBold) と per-char
      // (e.charBolds) のハイブリッド。どちらかに値があれば適用。
      if (e.charFillColors && !isObjEmpty(e.charFillColors)) {
        try {
          applyPerCharFillColors(layer, ti.contents, e.charFillColors);
        } catch (eCharFill) {
          addWarning("per-char fill color apply failed (layer " + e.id + "): " + eCharFill);
        }
      }
      if (typeof e.horizontalScale === "number" || typeof e.verticalScale === "number") {
        try {
          applyLayerTextScales(layer, e.horizontalScale, e.verticalScale);
        } catch (eScale) {
          addWarning("text scale apply failed (layer " + e.id + "): " + eScale);
        }
      }
      if ((e.charHorizontalScales && !isObjEmpty(e.charHorizontalScales)) || (e.charVerticalScales && !isObjEmpty(e.charVerticalScales))) {
        try {
          applyPerCharTextScales(layer, ti.contents, e.charHorizontalScales, e.charVerticalScales);
        } catch (eCharScale) {
          addWarning("per-char text scale apply failed (layer " + e.id + "): " + eCharScale);
        }
      }
      if (e.syntheticBold === true || e.syntheticBold === false ||
          (e.charBolds && !isObjEmpty(e.charBolds))) {
        try {
          var __boldLayerOverride = (e.syntheticBold === true || e.syntheticBold === false) ? e.syntheticBold : null;
          applyPerCharBolds(layer, ti.contents, e.charBolds, __boldLayerOverride);
        } catch (eBold) {
          addWarning("合成太字の適用に失敗 (layer " + e.id + "): " + eBold);
        }
      }
      if (e.syntheticItalic === true || e.syntheticItalic === false ||
          (e.charItalics && !isObjEmpty(e.charItalics))) {
        try {
          var __italicLayerOverride = (e.syntheticItalic === true || e.syntheticItalic === false) ? e.syntheticItalic : null;
          applyPerCharItalics(layer, ti.contents, e.charItalics, __italicLayerOverride);
        } catch (eItalic) {
          addWarning("合成斜体の適用に失敗 (layer " + e.id + "): " + eItalic);
        }
      }
      // 【v1.26.0】ルビ。親レイヤーは保持しつつ、ルビごとに新規テキストレイヤーを
      // 親の直前に追加する（Photoshop ruby プラグインと同じ方針）。
      if (e.charRubies && !isObjEmpty(e.charRubies)) {
        // ルビあり行 (= main.js doApply で setLineLeading 済みの行) の
        // paragraphStyle.autoLeadingPercentage を rubyLeadingPct/100 に上書き。
        // 【v1.29.x】direction で対象行を分岐 (縦書き=当該行 / 横書き=前の行)。
        if (!(__lineLeadingsE && !isObjEmpty(__lineLeadingsE)) &&
            typeof rubyLeadingPct === "number" && rubyLeadingPct > 0) {
          try {
            var __dirRubyLP = (typeof e.direction === "string") ? e.direction
                              : (ti.direction === Direction.VERTICAL ? "vertical" : "horizontal");
            var __rubyLines = computeRubyLineIndices(ti.contents, e.charRubies, __dirRubyLP);
            var __defMult = (typeof e.leadingPct === "number" && e.leadingPct > 0)
              ? (e.leadingPct / 100) : 1.0;
            applyRubyAutoLeadingPercentage(layer, ti.contents, __rubyLines, rubyLeadingPct / 100, __defMult);
          } catch (eRubyLP) {
            addWarning("ルビあり行間 (autoLeadingPercentage) の適用に失敗 (layer " + e.id + "): " + eRubyLP);
          }
        }
        try {
          var __szR = ti.size.value;
          var __dirR = (typeof e.direction === "string") ? e.direction
                       : (ti.direction === Direction.VERTICAL ? "vertical" : "horizontal");
          var __fontR = (typeof e.font === "string" && e.font.length > 0) ? e.font : ti.font;
          var __rubyFontR = (typeof rubyFontPostScriptName === "string" && rubyFontPostScriptName.length > 0)
                            ? rubyFontPostScriptName : __fontR;
          var __colR = null;
          try { __colR = ti.color; } catch (eCol0) {}
          // 【v1.29.x 修正】parentTopLeftOverride は null で渡す。autoLeadingPercentage で
          // 親レイヤーがシフトしても、ルビは「現在の親 bounds + uiOffsetX/Y」を基準に置く
          // ことで、親-ルビ間の相対距離 (ビューアーで見ていた値) が維持される。
          // override を渡すとシフト分ルビが前の行寄りに離れすぎる事故が起きる。
          var __rubiesScaled = scaleRubyAbsoluteCoords(e.charRubies, __rubyAbsScaleX, __rubyAbsScaleY);
          var __rlE = applyRubies(layer, ti.contents, __rubiesScaled, __szR, __dirR, __rubyFontR, __colR, null,
                      rubyPhotoshopOffsetEm, rubyPhotoshopBiasPx);
          rememberTextLayersForPhaseB(__phaseBTextLayers, __phaseBTextLayerIds, __rlE);
        } catch (eRuby) {
          addWarning("ルビの適用に失敗 (layer " + e.id + "): " + eRuby);
        }
      }
      // 【v1.22.0】記号フォント置換（♡♥★☆♪♫♬♩♯♭ など → symbolFontPostScriptName）。
      // 既存レイヤーにも適用（保存される PSD 内の全テキストを統一する方針）。
      // ユーザーが per-char で手動指定したフォント (e.charFonts[i]) がある char は skip。
      // レイヤー既定フォントが symbolFontPS と異なる場合も skip
      //（ユーザーが選んだ本体フォントが記号もカバーしていると見做して尊重）。
      // 注: Rust 側 (lib.rs `font_post_script_name`) は serde rename で `fontPostScriptName`
      // として渡るが、Rust → JSX の emit (jsx_gen.rs:77) で **`font`** キーに変換されている。
      // そのため JSX 内では `e.font` を参照する（`e.fontPostScriptName` は undefined）。
      if (typeof symbolFontPostScriptName === "string" && symbolFontPostScriptName.length > 0) {
        try {
          // 【v2.x】レイヤー既定フォントによる skip 判定は撤去。記号文字は per-char 手動指定が
          // ない限り常に symbolFontPS で置換する (コミックフォント等の記号未収録フォントで
          // ♡♥★ が壊れる事故を防ぐため)。
          applySymbolFont(layer, ti.contents, symbolFontPostScriptName, e.charFonts);
        } catch (eSymF) {
          addWarning("記号フォント置換に失敗 (layer " + e.id + "): " + eSymF);
        }
      }
      // 【v1.22.0】句読点ツメ（、 U+3001 / 。 U+3002 を tsume N% で詰める）。既存レイヤーにも適用。
      if (typeof punctuationTsumePercent === "number" && punctuationTsumePercent > 0) {
        try {
          applyPunctuationTsume(layer, ti.contents, punctuationTsumePercent);
        } catch (eTsume) {
          addWarning("句読点ツメの適用に失敗 (layer " + e.id + "): " + eTsume);
        }
      }
      // 【v1.31.x】連続記号のツメ。既存レイヤーにも新規レイヤーと同じ dash / tilde 別値を適用する。
      // これを省くと PSD 側に残っていた tracking が見た目に残り、「――」が「～～」側の値に
      // 引っ張られて見えるケースがある。
      try {
        applyRepeatedDashTracking(layer, ti.contents, dashTrackingMille, tildeTrackingMille);
      } catch (eDashTrackExisting) {
        addWarning("連続記号のツメ適用に失敗 (layer " + e.id + "): " + eDashTrackExisting);
      }
      // 【v1.26.0】縦中横（!! / !? の自動 tcy）。既存レイヤーにも適用（PSD 内に全角 ！！ で
      // 組まれているテキストを保存時に半角化 + 縦中横 cross 属性を当てる）。
      // 縦書きレイヤーのみ対象。direction は e.direction → ti.direction の優先順で判定。
      if (tateChuYokoEnabled || (e.charTateChuYokos && !isObjEmpty(e.charTateChuYokos))) {
        try {
          var __dirTcy = (typeof e.direction === "string") ? e.direction
                       : (ti.direction === Direction.VERTICAL ? "vertical" : "horizontal");
          if (__dirTcy === "vertical") {
            applyTateChuYoko(layer, ti.contents, tateChuYokoEnabled, __dirTcy, e.charTateChuYokos);
          }
        } catch (eTcyExisting) {
          addWarning("縦中横の適用に失敗 (layer " + e.id + "): " + eTcyExisting);
        }
      }
      if (typeof e.rotation === "number" && e.rotation !== 0) {
        try {
          layer.rotate(e.rotation, AnchorPosition.MIDDLECENTER);
        } catch (eRot) {
          addWarning("レイヤー回転の適用に失敗 (layer " + e.id + "): " + eRot);
        }
      }
      if (typeof e.strokeColor === "string" || typeof e.strokeWidth === "number") {
        try {
          applyStrokeEffect(layer, {
            color: (typeof e.strokeColor === "string") ? e.strokeColor : "none",
            size: (typeof e.strokeWidth === "number") ? e.strokeWidth : 20,
          });
        } catch (eStrokeUnder) {
          addWarning("境界線効果の適用に失敗(layer " + e.id + "): " + eStrokeUnder);
        }
      }
    }
    if (newLayers && newLayers.length > 0) {
      // PsDesign が追加するテキストレイヤーは「毎回新しい text グループ」
      // を最上部に作って格納する。既存の非表示 "text" フォルダ等はユーザー
      // 構成なので一切触らない。配置 → 設定 → 最後に group へ move する
      // 2 段階方式（LayerSet.artLayers.add() が PS バージョンで不安定な
      // ケースを避ける。座標は document 絶対なので group 内でも位置不変）。
      var __textGroup = createNewTextGroupAtTop(doc);
      for (var j = 0; j < newLayers.length; j++) {
        var nl = newLayers[j];
        var layerRef = doc.artLayers.add();
        layerRef.kind = LayerKind.TEXT;
        rememberLayerInIdIndex(__layerIdIndex, layerRef);
        rememberTextLayerForPhaseB(__phaseBTextLayers, __phaseBTextLayerIds, layerRef);
        try { nl.__createdLayerId = layerRef.id; } catch (eNewLayerId) {}
        var nti = layerRef.textItem;
        if (nl.direction === "vertical") {
          try { nti.direction = Direction.VERTICAL; } catch (eDir) {}
        } else if (nl.direction === "horizontal") {
          try { nti.direction = Direction.HORIZONTAL; } catch (eDir2) {}
        }
        nti.contents = normalizeLineBreaks(nl.contents);
        // 【縦中横】縦書き + TCY 有効のとき、全角「！！」「！？」を半角「!!」「!?」へ先に変換する。
        // applyTateChuYoko 内での contents 再代入（フォント等の per-char 書式が壊れる）を避けるため、
        // フォント・書式を当てる前にここで一度だけ行う。全角→半角は char index 1:1 で per-char に影響なし。
        if (tateChuYokoEnabled && nl.direction === "vertical") {
          try {
            var __halfNL = normalizeFullWidthToHalfTcy(nti.contents, true);
            if (__halfNL !== nti.contents) nti.contents = __halfNL;
          } catch (eHalfNL) {}
        }
        if (typeof nl.font === "string" && nl.font.length > 0) {
          // 【v2.x】Photoshop が認識する PS 名に解決してから当てる。中丸ゴシック等の
          // -WIN-RKSJ-H サフィックス付きで Photoshop が登録している CJK フォントに対応。
          var __resolvedFontNL = resolvePhotoshopFontPS(nl.font);
          try { nti.font = __resolvedFontNL; } catch (eFont) {}
          // 【v2.x】DOM `nti.font = ...` は silent failure する可能性があるため、
          // Action Manager 経由で textStyleRange.fontPostScriptName も直接書き込む。
          // 中丸ゴシック等のフォントが PsDesign では認識されるが Photoshop の DOM 経由では
          // silent に小塚に置き換わる事故 (= 「中丸ゴシックが psd で小塚になる」報告) を
          // 根本対応する。両方当てることで、どちらかが失敗しても他方で救う。
          try { applyLayerFont(layerRef, __resolvedFontNL); } catch (eAlfNew) {}
        }
        nti.size = new UnitValue((typeof nl.size === "number") ? nl.size : 24, "pt");
        // autoLeadingAmount は段落全体属性。ここでは元の leadingPct (or 125 default)
        // のまま自動行送りにし、ルビあり行だけ後段の paragraphStyleRange
        // autoLeadingPercentage で個別に上書きする。
        var __lpNew = (typeof nl.leadingPct === "number") ? nl.leadingPct : 125;
        try { nti.autoLeadingAmount = __lpNew; } catch (eAutoLeadPct) {}
        try { nti.useAutoLeading = true; } catch (eAutoLead) {}
        try {
          var nfc = fillColorFor(typeof nl.fillColor === "string" ? nl.fillColor : "default");
          nti.color = nfc ? nfc : blackColor();
        } catch (eColor) {}
        nti.position = [new UnitValue(nl.x, "px"), new UnitValue(nl.y, "px")];
        // Photoshop の textItem.position はテキストアンカー（横書き=ベースライン左、
        // 縦書き=1 文字目の右上）であり、PsDesign 側の nl.x/nl.y は bounding-box の
        // top-left を意図している。さらに編集画面の縦書き CSS は writing-mode: vertical-rl
        // で 1 列目（最右列）が box.right から始まるため、
        //   - 横書き: 配置後の bounds.top-left を (nl.x, nl.y) に揃える。
        //   - 縦書き: bounds.top-right を (nl.x + thick, nl.y) に揃える。
        //     ここで thick = ptInPsdPx * (1 + (lineCount - 1) * leadingFactor) は編集側 layerRectForNew と同じ式。
        try {
          var _b = layerRef.bounds;
          var _actualLeft  = _b[0].as("px");
          var _actualTop   = _b[1].as("px");
          var _actualRight = _b[2].as("px");
          var _actualBottom = _b[3].as("px");
          var _dpi = doc.resolution;
          var _sizePt = (typeof nl.size === "number") ? nl.size : 24;
          var _ptInPx = _sizePt * (_dpi / 72);
          var _fixDx, _fixDy;
          // 中心合わせの基準: uiAnchorCx/Cy（保存直前に算出した現在の UI グリフ中心）を最優先。
          // これによりユーザーが UI 上で動かした位置がそのまま保存に反映される。
          // uiAnchor が無ければ reuseSrcCx/Cy（抽出時の元中心）へフォールバック。
          var _anchorCx = (typeof nl.uiAnchorCx === "number") ? nl.uiAnchorCx
            : ((typeof nl.reuseSrcCx === "number") ? nl.reuseSrcCx : null);
          var _anchorCy = (typeof nl.uiAnchorCy === "number") ? nl.uiAnchorCy
            : ((typeof nl.reuseSrcCy === "number") ? nl.reuseSrcCy : null);
          if (_anchorCx !== null && _anchorCy !== null) {
            // 【中心基準】作り直したテキストの「実 bounds 中心」を UI 中心 (or 元中心) に合わせる。
            // UI の枠幅推定や CSS/Photoshop のジオメトリ差・複数行の左余白に依存せず一致させる。
            var _actCx = (_actualLeft + _actualRight) / 2;
            var _actCy = (_actualTop + _actualBottom) / 2;
            _fixDx = _anchorCx - _actCx;
            _fixDy = _anchorCy - _actCy;
          } else if (nl.direction === "vertical") {
            // 【v2.x】縦書き位置補正:
            // canvas-tools.js layerRectForNew の bbox 幅 (thick) は:
            //   thick = ptInPx × (1 + leadingFactor × (lineCount - 1) + thickSafetyEm)
            // 【fix】縦書きは thickSafetyEm を 0 に統一した（layerRectForNew /
            //   auto-place.js estimateLayerSize と同方針）。理由: vertical-rl は content が
            //   box の右端 (block-start) に寄り box 左端 = nl.x は固定のため、safety を足すと
            //   余白が必ず box の「左側」に溜まる（自動配置テキスト左の余分な余白の原因）。
            //   ここを 0 にしないと UI (safety 無し) と PSD (safety 有り) で text 右端が
            //   0.4em ズレるため、JS 側の bbox 計算と必ず一致させる。
            // CSS .new-layer-text には padding は無く (width/height: 100% + box-sizing: border-box のみ)、
            // vertical-rl の自然挙動で first column が bbox 右端に揃う。
            // つまり PsDesign canvas での text 右端 = bbox.right = nl.x + thickCanvas。
            // PSD でも同じ位置に揃えればプレビューと完全一致する。
            var _lpFactor = ((typeof nl.leadingPct === "number") ? nl.leadingPct : 125) / 100;
            var _contentsForCount = String(nl.contents || "");
            var _lc = _contentsForCount.split(/\r\n|\r|\n/).length;
            if (_lc < 1) _lc = 1;
            var _thickSafetyEm = 0;
            var _thickBase = 1 + Math.max(0, _lc - 1) * _lpFactor;
            var _thickCanvas = _ptInPx * (_thickBase + _thickSafetyEm);
            if (_thickCanvas < 24) _thickCanvas = 24;
            var _boxRight = nl.x + _thickCanvas;
            var _actualWidth = _actualRight - _actualLeft;
            var _columnWidth = (_ptInPx > 0) ? _ptInPx : _thickCanvas;
            var _rightEdgePunctuation = isVerticalRightEdgePunctuationText(_contentsForCount);
            var _shouldCenterSingleColumn = (_lc === 1 && _actualWidth > 0 && _columnWidth > 0 &&
              ((!_rightEdgePunctuation && _actualWidth < _columnWidth * 0.82) ||
                isVerticalSingleColumnCenterRiskText(_contentsForCount)));
            if (_shouldCenterSingleColumn) {
              _fixDx = (_boxRight - (_columnWidth / 2)) - ((_actualLeft + _actualRight) / 2);
            } else {
              _fixDx = _boxRight - _actualRight;
            }
            _fixDy = nl.y - _actualTop;
          } else {
            // 横書きも CSS padding なしなので、bbox.left = text 左端 / bbox.top = text 上端。
            _fixDx = nl.x - _actualLeft;
            _fixDy = nl.y - _actualTop;
          }
          if (_fixDx !== 0 || _fixDy !== 0) {
            layerRef.translate(new UnitValue(_fixDx, "px"), new UnitValue(_fixDy, "px"));
          }
        } catch (eBounds) {}
        // フチはルビ生成後に一括適用する。ここで先に付けると、
        // Photoshop の bounds が変わり、ルビ位置計算がぶれる。
        // 【v1.29.x】ルビあり時は paragraphStyleRange の autoLeadingPercentage、
        // ルビなしのときは従来の textStyleRange 固定 leading を使う。
        var __hasRubyNL = (nl.charRubies && !isObjEmpty(nl.charRubies));
        var __lineLeadingsNL = __hasRubyNL
          ? buildRubyLineLeadings(nti.contents, nl.charRubies, nl.lineLeadings, rubyLeadingPct)
          : nl.lineLeadings;
        if (__lineLeadingsNL && !isObjEmpty(__lineLeadingsNL)) {
          try {
            var __szNew = nti.size.value;
            if (__hasRubyNL) {
              var __defLineMultN = (typeof nl.leadingPct === "number" && nl.leadingPct > 0)
                ? (nl.leadingPct / 100) : 1.25;
              applyLineLeadingPercentages(layerRef, nti.contents, __lineLeadingsNL, __defLineMultN);
            } else {
              applyLineLeadings(layerRef, __lineLeadingsNL, nti.contents, __szNew);
            }
          } catch (eLineLeadNew) {
            addWarning("新規レイヤーの行ごとの行間適用に失敗: " + eLineLeadNew);
          }
        }
        // 【v1.21.0】per-char サイズ・フォント。applyLineLeadings の後 / dash-tracking と
        // tcy の前に呼ぶ。各関数は前段の textStyleRange を baseStyle として clone するので、
        // 順番に上書きする属性は保持される。
        if ((nl.charSizes && !isObjEmpty(nl.charSizes)) || (nl.charFonts && !isObjEmpty(nl.charFonts))) {
          try {
            applyPerCharSizesAndFonts(layerRef, nti.contents, nl.charSizes, nl.charFonts);
          } catch (ePerCharNew) {
            addWarning("新規レイヤーの文字ごとのサイズ・フォント適用に失敗: " + ePerCharNew);
          }
        }
        // 【v1.22.0】合成太字（faux bold）。layer 全体 / per-char ハイブリッド。
        if (nl.charFillColors && !isObjEmpty(nl.charFillColors)) {
          try {
            applyPerCharFillColors(layerRef, nti.contents, nl.charFillColors);
          } catch (eCharFillNew) {
            addWarning("new layer per-char fill color apply failed: " + eCharFillNew);
          }
        }
        if (typeof nl.horizontalScale === "number" || typeof nl.verticalScale === "number") {
          try {
            applyLayerTextScales(layerRef, nl.horizontalScale, nl.verticalScale);
          } catch (eScaleNew) {
            addWarning("new layer text scale apply failed: " + eScaleNew);
          }
        }
        if ((nl.charHorizontalScales && !isObjEmpty(nl.charHorizontalScales)) || (nl.charVerticalScales && !isObjEmpty(nl.charVerticalScales))) {
          try {
            applyPerCharTextScales(layerRef, nti.contents, nl.charHorizontalScales, nl.charVerticalScales);
          } catch (eCharScaleNew) {
            addWarning("new layer per-char text scale apply failed: " + eCharScaleNew);
          }
        }
        if (nl.syntheticBold === true || nl.syntheticBold === false ||
            (nl.charBolds && !isObjEmpty(nl.charBolds))) {
          try {
            var __boldLayerOverrideN = (nl.syntheticBold === true || nl.syntheticBold === false) ? nl.syntheticBold : null;
            applyPerCharBolds(layerRef, nti.contents, nl.charBolds, __boldLayerOverrideN);
          } catch (eBoldNew) {
            addWarning("新規レイヤーの合成太字適用に失敗: " + eBoldNew);
          }
        }
        if (nl.syntheticItalic === true || nl.syntheticItalic === false ||
            (nl.charItalics && !isObjEmpty(nl.charItalics))) {
          try {
            var __italicLayerOverrideN = (nl.syntheticItalic === true || nl.syntheticItalic === false) ? nl.syntheticItalic : null;
            applyPerCharItalics(layerRef, nti.contents, nl.charItalics, __italicLayerOverrideN);
          } catch (eItalicNew) {
            addWarning("新規レイヤーの合成斜体適用に失敗: " + eItalicNew);
          }
        }
        // 【v1.26.0】ルビ（新規レイヤー）。親 layer の textKey 上書きが完了してから呼ぶ。
        // ルビレイヤーは親の直前に追加され、新規 text グループ (__textGroup) 内に居る。
        var __rubyLayersNL = [];
        if (nl.charRubies && !isObjEmpty(nl.charRubies)) {
          // ルビあり行 (= main.js doApply で setLineLeading 済みの行) の
          // paragraphStyle.autoLeadingPercentage を rubyLeadingPct/100 に上書き。
          // 【v1.29.x】direction で対象行を分岐 (縦書き=当該行 / 横書き=前の行)。
          if (!(__lineLeadingsNL && !isObjEmpty(__lineLeadingsNL)) &&
              typeof rubyLeadingPct === "number" && rubyLeadingPct > 0) {
            try {
              var __dirRubyLPN = nl.direction || "vertical";
              var __rubyLinesN = computeRubyLineIndices(nti.contents, nl.charRubies, __dirRubyLPN);
              var __defMultN = (typeof nl.leadingPct === "number" && nl.leadingPct > 0)
                ? (nl.leadingPct / 100) : 1.25;
              applyRubyAutoLeadingPercentage(layerRef, nti.contents, __rubyLinesN, rubyLeadingPct / 100, __defMultN);
            } catch (eRubyLPN) {
              addWarning("新規レイヤーのルビあり行間 (autoLeadingPercentage) 適用に失敗: " + eRubyLPN);
            }
          }
          try {
            var __szRN = nti.size.value;
            var __dirRN = nl.direction || "vertical";
            var __fontRN = (typeof nl.font === "string" && nl.font.length > 0) ? nl.font : nti.font;
            var __rubyFontRN = (typeof rubyFontPostScriptName === "string" && rubyFontPostScriptName.length > 0)
                               ? rubyFontPostScriptName : __fontRN;
            var __colRN = null;
            try { __colRN = nti.color; } catch (eCol1) {}
            // 【v1.29.x 修正】parentTopLeftOverride は null。autoLeadingPercentage で親が
            // シフトしても、ルビは「現在の親 bounds + uiOffsetX/Y」基準で配置することで、
            // ビューアー上で見ていた「親-ルビの相対位置」を維持する。
            var __rubiesScaledN = scaleRubyAbsoluteCoords(nl.charRubies, __rubyAbsScaleX, __rubyAbsScaleY);
            var __rl = applyRubies(layerRef, nti.contents, __rubiesScaledN, __szRN, __dirRN, __rubyFontRN, __colRN, null,
                        rubyPhotoshopOffsetEm, rubyPhotoshopBiasPx);
            if (__rl && __rl.length) {
              __rubyLayersNL = __rl;
              rememberTextLayersForPhaseB(__phaseBTextLayers, __phaseBTextLayerIds, __rl);
            }
          } catch (eRubyN) {
            addWarning("新規レイヤーのルビ適用に失敗: " + eRubyN);
          }
        }
        // 【v1.22.0】記号フォント置換（♡♥★☆♪♫♬♩♯♭ など → symbolFontPostScriptName）。
        // 新規レイヤーにも適用。ユーザーが per-char で手動指定したフォントは尊重。
        // レイヤー既定フォントが symbolFontPS と異なる場合も skip
        //（中丸ゴシック等、ユーザーが選んだ記号対応フォントを保護する）。
        // 注: Rust 側 (lib.rs `font_post_script_name`) は serde rename で `fontPostScriptName`
        // として渡るが、Rust → JSX の emit (jsx_gen.rs:203) で **`font`** キーに変換されている。
        // そのため JSX 内では `nl.font` を参照する（`nl.fontPostScriptName` は undefined）。
        if (typeof symbolFontPostScriptName === "string" && symbolFontPostScriptName.length > 0) {
          try {
            // 【v2.x】レイヤー既定フォントによる skip 判定は撤去 (Phase A 既存レイヤー側と同方針)。
            applySymbolFont(layerRef, nti.contents, symbolFontPostScriptName, nl.charFonts);
          } catch (eSymFNew) {
            addWarning("新規レイヤーの記号フォント置換に失敗: " + eSymFNew);
          }
        }
        // 【v1.22.0】句読点ツメ（、 U+3001 / 。 U+3002 を tsume N% で詰める）。新規レイヤーにも適用。
        if (typeof punctuationTsumePercent === "number" && punctuationTsumePercent > 0) {
          try {
            applyPunctuationTsume(layerRef, nti.contents, punctuationTsumePercent);
          } catch (eTsumeNew) {
            addWarning("新規レイヤーの句読点ツメ適用に失敗: " + eTsumeNew);
          }
        }
        // 連続記号のツメ（環境設定の global 値）。新規レイヤーのみ。
        // dash 系と tilde 系で別々に、写植設定の tracking 値をそのまま per-char に当てる。
        try {
          applyRepeatedDashTracking(layerRef, nti.contents, dashTrackingMille, tildeTrackingMille);
        } catch (eDashTrack) {
          addWarning("連続記号のツメ適用に失敗: " + eDashTrack);
        }
        // 縦中横（!! / !? の自動 tcy）。設定 ON かつ縦書きレイヤーのみ。
        // applyRepeatedDashTracking の後に呼ぶことで、tracking で再構築された textStyleRange
        // を引き継ぎつつ baselineDirection=cross を上乗せする。
        if (tateChuYokoEnabled || (nl.charTateChuYokos && !isObjEmpty(nl.charTateChuYokos))) {
          try {
            applyTateChuYoko(layerRef, nti.contents, tateChuYokoEnabled, nl.direction, nl.charTateChuYokos);
          } catch (eTcy) {
            addWarning("縦中横 (!! / !?) の適用に失敗: " + eTcy);
          }
        }
        if (typeof nl.rotation === "number" && nl.rotation !== 0) {
          try {
            layerRef.rotate(nl.rotation, AnchorPosition.MIDDLECENTER);
          } catch (eRotNew) {
            addWarning("新規レイヤー回転の適用に失敗: " + eRotNew);
          }
        }
        // 全設定が完了したら "text" フォルダへ移動（座標は document 絶対なので
        // 表示位置は変わらない）。group 確保に失敗していた場合は doc 直下のまま。
        var __strokeColorNL = (typeof nl.strokeColor === "string") ? nl.strokeColor : "none";
        var __strokeSizeNL = (typeof nl.strokeWidth === "number") ? nl.strokeWidth : 20;
        var __hasStrokeNL = (__strokeColorNL === "white" || __strokeColorNL === "black") && __strokeSizeNL > 0;
        var __hasRubiesNL = (__rubyLayersNL && __rubyLayersNL.length > 0);
        if (__hasRubiesNL) {
          for (var __lkI = 0; __lkI < __rubyLayersNL.length; __lkI++) {
            try { __rubyLayersNL[__lkI].link(layerRef); } catch (eLinkR) {}
          }
        }
        var __subGroupNL = null;
        if (__hasStrokeNL && __hasRubiesNL) {
          try {
            if (__textGroup) {
              try { __subGroupNL = __textGroup.layerSets.add(); } catch (eSgInTg) {
                __subGroupNL = doc.layerSets.add();
              }
            } else {
              __subGroupNL = doc.layerSets.add();
            }
            try {
              __subGroupNL.name = (typeof layerRef.name === "string" && layerRef.name.length > 0) ? layerRef.name : "text";
            } catch (eSgName) {}
            for (var __sgI = __rubyLayersNL.length - 1; __sgI >= 0; __sgI--) {
              try { __rubyLayersNL[__sgI].move(__subGroupNL, ElementPlacement.PLACEATBEGINNING); } catch (eSgR) {}
            }
            try { layerRef.move(__subGroupNL, ElementPlacement.PLACEATEND); } catch (eSgP) {}
            // 親レイヤーは生成直後で境界線効果を持たないため、ここで disableStrokeEffect を
            // 呼ぶと無用な「無効化済み境界線 descriptor」が付いて fx マークが残る。
            // 親側には何もせず、サブグループ側にのみ境界線を当てる。
            try { applyStrokeEffect(__subGroupNL, { color: __strokeColorNL, size: __strokeSizeNL }); } catch (eSgStroke) {
              addWarning("白フチ付きルビグループへの境界線効果適用に失敗: " + eSgStroke);
            }
          } catch (eSgCreate) {
            addWarning("白フチ付きルビグループ作成に失敗: " + eSgCreate);
            __subGroupNL = null;
          }
        }
        if (__textGroup && !__subGroupNL) {
          try { layerRef.move(__textGroup, ElementPlacement.PLACEATBEGINNING); } catch (eMoveNL2) {
            addWarning("text フォルダへの移動に失敗 (新規レイヤー): " + eMoveNL2);
          }
          if (__hasRubiesNL) {
            for (var __tgI = __rubyLayersNL.length - 1; __tgI >= 0; __tgI--) {
              try { __rubyLayersNL[__tgI].move(layerRef, ElementPlacement.PLACEBEFORE); } catch (eTgR) {}
            }
          }
        } else if (__textGroup && __subGroupNL) {
          try { __subGroupNL.move(__textGroup, ElementPlacement.PLACEATBEGINNING); } catch (eMoveSg) {}
        }
        try { layerRef.visible = true; } catch (eVisNL2) {}
        if (__subGroupNL) { try { __subGroupNL.visible = true; } catch (eVisSg) {} }
        if (__hasRubiesNL) {
          for (var __vrI = 0; __vrI < __rubyLayersNL.length; __vrI++) {
            try { __rubyLayersNL[__vrI].visible = true; } catch (eVisR) {}
          }
        }
        // フチはここだけで確定する。ルビあり + グループ作成成功時はグループ側にだけ境界線を持たせる。
        // フチ無し (!__hasStrokeNL) の新規レイヤーには何もしない:
        // 新規レイヤーは doc.artLayers.add() 直後で境界線効果を持たないため、
        // ここで disableStrokeEffect を呼ぶと無用な「無効化済み境界線 descriptor」が
        // 付与され、Photoshop 上で fx マーク + 効果リストの「境界線」表示が残ってしまう。
        if (__hasStrokeNL && (!__hasRubiesNL || !__subGroupNL)) {
          try {
            applyStrokeEffect(layerRef, { color: __strokeColorNL, size: __strokeSizeNL });
          } catch (eStrokeNewFinal) {
            addWarning("新規レイヤーの境界線効果適用に失敗: " + eStrokeNewFinal);
          }
        }
        // 念のため可視化（一部 PS で move 後に visible=false になるケースを補正）
        try { layerRef.visible = true; } catch (eVisNL) {}
      }
      // 全レイヤー処理後、新規作成したグループ自身を可視に揃える（既存
      // フォルダは触らない方針なので、ここで触るのは createNewTextGroupAtTop
      // が返した「新規作成 LayerSet」のみ）。
      if (__textGroup) {
        try { __textGroup.visible = true; } catch (eVisG) {}
      }
    }
    // Phase B は今回編集・生成したテキストレイヤーだけに限定する。
    // 未編集の既存テキストへ autoKerning / per-char 再適用が波及すると、
    // 多レイヤー PSD ほど保存時の副作用と処理時間が大きくなる。
    try { applyDefaultTextSettingsToPhaseBLayers(__phaseBTextLayers); } catch (eDefSet) {
      addWarning("テキスト共通設定 (kerning/antialias) の適用に失敗: " + eDefSet);
    }
    // 【v1.22.0】Phase B: autoKerning 設定が textStyleRange を flatten してマイナーな
    // per-char 属性（tsume / 記号フォント）を落とすことがあるため、保存直前に再適用する
    // safety net。対象は __phaseBTextLayers に収集済みの編集・生成レイヤーだけ。
    if (typeof punctuationTsumePercent === "number" && punctuationTsumePercent > 0) {
      try { reapplyPunctuationTsumeForPhaseBLayers(__phaseBTextLayers, punctuationTsumePercent); }
      catch (eRTs) { addWarning("句読点ツメ再適用に失敗: " + eRTs); }
    }
    try { reapplyRepeatedTrackingForPhaseBLayers(__phaseBTextLayers, dashTrackingMille, tildeTrackingMille); }
    catch (eRTr) { addWarning("連続記号のツメ再適用に失敗: " + eRTr); }
    if (typeof symbolFontPostScriptName === "string" && symbolFontPostScriptName.length > 0) {
      try { reapplySymbolFontForPhaseBLayers(__phaseBTextLayers, symbolFontPostScriptName); }
      catch (eRSym) { addWarning("記号フォント置換再適用に失敗: " + eRSym); }
    }
    try { reapplyManualTextSpacingForPayload(doc, __layerIdIndex, edits, newLayers); }
    catch (eRManualSpacing) { addWarning("manual text spacing reapply failed: " + eRManualSpacing); }
    // 【写植再利用バグ修正】縦中横 (!! / !?) は autoKerning flatten で消えるため再適用する。
    // 他の per-char 再適用（記号フォント / manual spacing）が textStyleRange を再構築して
    // cross を落とさないよう、Phase B の最後に実行する。
    if (tateChuYokoEnabled) {
      try { reapplyTateChuYokoForPhaseBLayers(__phaseBTextLayers, tateChuYokoEnabled); }
      catch (eRTcy) { addWarning("縦中横の再適用に失敗: " + eRTcy); }
    }
    for (var __delI = 0; __delI < edits.length; __delI++) {
      if (edits[__delI] && edits[__delI].deleted === true) {
        try {
          var __deletedLayer = findLayerByIdIndexed(doc, __layerIdIndex, edits[__delI].id);
          if (__deletedLayer) __deletedLayer.visible = false;
        } catch (eDeletedHideFinal) {
          addWarning("cut layer final hide failed (layer " + edits[__delI].id + "): " + eDeletedHideFinal);
        }
      }
    }
    // 写植再利用モード: 抽出テキストは newLayers として作成済みなので、元のテキスト
    // レイヤーを非表示にして二重表示を防ぐ。id で探して visible=false にするだけ。
    if (hideLayerIds && hideLayerIds.length) {
      for (var __hi = 0; __hi < hideLayerIds.length; __hi++) {
        try {
          var __hideLayer = findLayerByIdIndexed(doc, __layerIdIndex, hideLayerIds[__hi]);
          if (__hideLayer) __hideLayer.visible = false;
        } catch (eHide) {
          addWarning("元テキストレイヤー非表示化に失敗 (id " + hideLayerIds[__hi] + "): " + eHide);
        }
      }
    }
    if (typeof savePath === "string" && savePath.length > 0) {
      var outFile = new File(savePath);
      try {
        var outFolder = outFile.parent;
        if (outFolder && !outFolder.exists) outFolder.create();
      } catch (eMk) {}
      var opts = new PhotoshopSaveOptions();
      try { opts.embedColorProfile = true; } catch (eOpt1) {}
      try { opts.alphaChannels = true; } catch (eOpt2) {}
      try { opts.layers = true; } catch (eOpt3) {}
      try { opts.spotColors = true; } catch (eOpt4) {}
      var __stamp = (new Date()).getTime();
      var __saveBase = outFile.fsName.replace(/\.psd$/i, "");
      var tmpFile = new File(__saveBase + ".psdesign-tmp-" + __stamp + ".psd");
      var bakFile = new File(__saveBase + ".psdesign-bak-" + __stamp + ".psd");
      var hadExisting = outFile.exists;
      var movedExisting = false;
      try {
        doc.saveAs(tmpFile, opts, true, Extension.LOWERCASE);
      } catch (eSaveAs) {
        try {
          doc.saveAs(tmpFile, opts, true);
        } catch (eSaveAs2) {
          try { if (tmpFile.exists) tmpFile.remove(); } catch (eTmpSaveRemove) {}
          throw eSaveAs2;
        }
      }
      if (!tmpFile.exists) throw new Error("saveAs did not create file: " + tmpFile.fsName);
      try {
        if (hadExisting) {
          if (bakFile.exists) bakFile.remove();
          movedExisting = outFile.rename(bakFile.name);
          if (!movedExisting) throw new Error("backup rename failed: " + outFile.fsName);
        }
        if (!tmpFile.rename(outFile.name)) {
          throw new Error("replace rename failed: " + tmpFile.fsName + " -> " + outFile.fsName);
        }
        if (movedExisting && bakFile.exists) {
          try { bakFile.remove(); } catch (eBakRemove) {
            addWarning("save backup cleanup failed: " + bakFile.fsName + " (" + eBakRemove + ")");
          }
        }
      } catch (eReplace) {
        try {
          if (movedExisting && !outFile.exists && bakFile.exists) bakFile.rename(outFile.name);
        } catch (eRestore) {
          addWarning("save backup restore failed: " + bakFile.fsName + " (" + eRestore + ")");
        }
        try { if (tmpFile.exists) tmpFile.remove(); } catch (eTmpRemove) {}
        throw eReplace;
      }
    } else {
      doc.save();
    }
  } finally {
    doc.close(SaveOptions.DONOTSAVECHANGES);
    app.preferences.rulerUnits = prevUnits;
    app.preferences.typeUnits = prevTypeUnits;
    if (prevMaxCompat !== null) {
      try { app.preferences.maximizeCompatibility = prevMaxCompat; } catch (eMcRestore) {}
    }
  }
}
"##;
use crate::EditPayload;
