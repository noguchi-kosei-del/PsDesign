use crate::EditPayload;

pub fn generate_apply_script(payload: &EditPayload, sentinel_path: &str) -> String {
    let mut out = String::new();
    out.push_str(HEADER);
    out.push('\n');
    out.push_str(&format!(
        "var SENTINEL_PATH = {};\n",
        js_string(sentinel_path)
    ));
    out.push_str("try {\n");
    out.push_str("  var __psver = photoshopVersion();\n");
    out.push_str("  if (__psver > 0 && __psver < 13) { addWarning(\"Photoshop \" + __psver + \" は動作未検証のバージョンです\"); }\n");

    let total = payload.edits.len();
    out.push_str(&format!("  initProgress({});\n", total));

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
            idx,
            total,
            js_string(&status_msg)
        ));
        let save_path = if save_as && !target_dir.is_empty() {
            let name = std::path::Path::new(&psd.psd_path)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("output.psd");
            let sep = if target_dir.ends_with('/') || target_dir.ends_with('\\') {
                ""
            } else {
                "/"
            };
            format!("{}{}{}", target_dir, sep, name)
        } else {
            String::new()
        };
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
            out.push_str("},\n");
        }
        out.push_str("], [\n");
        for nl in &psd.new_layers {
            out.push_str("  {");
            out.push_str(&format!("x: {}, y: {}", nl.x, nl.y));
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
            out.push_str("},\n");
        }
        out.push_str(&format!("], {});\n\n", js_string(&save_path)));
    }

    out.push_str(&format!(
        "  setProgress({0}, {0}, \"完了\");\n",
        total
    ));
    out.push_str("  writeSentinel(\"OK\");\n");
    out.push_str("} catch (err) {\n");
    out.push_str("  writeSentinel(\"ERROR \" + (err && err.toString ? err.toString() : String(err)));\n");
    out.push_str("}\n");
    out
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
// Generated by PsDesign — do not edit.
#target photoshop
app.bringToFront();

var PSDESIGN_WARNINGS = [];
function addWarning(msg) {
  try {
    $.writeln("[PsDesign][warn] " + msg);
    PSDESIGN_WARNINGS.push(String(msg));
  } catch (warnErr) {}
}

// ===== Photoshop 側進捗パレット（ScriptUI） =====
// Photoshop 本体はスクリプト実行中も UI は動くが、長時間かかる保存処理で
// 「何が起きているか」を示すために軽量なパレットウインドウで進捗表示する。
// 失敗時も writeSentinel() 内で closeProgress() が呼ばれるのでリークしない。
var PSDESIGN_PROGRESS = null;
function initProgress(total) {
  try {
    var w = new Window("palette", "PsDesign — PSD を保存中", undefined, { closeButton: false });
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
    $.writeln("[PsDesign] progress init failed: " + e);
  }
}
function setProgress(current, total, message) {
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
    var f = new File(SENTINEL_PATH);
    f.encoding = "UTF-8";
    f.open("w");
    f.write(payload);
    f.close();
  } catch (sentinelErr) {
    $.writeln("[PsDesign] failed to write sentinel: " + sentinelErr);
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

// name: "white" | "black" | "default"（それ以外）。
// "default" は null を返し、呼び出し側で「色を変更しない」を選択。
function fillColorFor(name) {
  if (name === "white") return whiteColor();
  if (name === "black") return blackColor();
  return null;
}

function normalizeLineBreaks(s) {
  if (typeof s !== "string") return s;
  return s.replace(/\r\n/g, "\r").replace(/\n/g, "\r");
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

// ===== Photoshop Action Manager 用 string ID ラッパ =====
// Adobe 公式は CS6 以降 stringIDToTypeID を推奨。charID（4 文字コード）は
// 互換レイヤーで将来削除の可能性あり。ここで string ID ベースに統一して
// アップデート耐性を高める。
var sID = function (s) { return stringIDToTypeID(s); };

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

  var c = new ActionDescriptor();
  c.putDouble(sID("red"), rgb[0]);
  c.putDouble(sID("green"), rgb[1]);
  c.putDouble(sID("blue"), rgb[2]);
  stroke.putObject(sID("color"), sID("RGBColor"), c);

  fx.putObject(sID("frameFX"), sID("frameFX"), stroke);
  desc.putObject(sID("to"), sID("layerEffects"), fx);
  executeAction(sID("set"), desc, DialogModes.NO);
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
  fx.putObject(sID("frameFX"), sID("frameFX"), stroke);
  desc.putObject(sID("to"), sID("layerEffects"), fx);
  try { executeAction(sID("set"), desc, DialogModes.NO); } catch (e) {}
}

function applyToPsd(psdPath, edits, newLayers, savePath) {
  var file = new File(psdPath);
  if (!file.exists) { $.writeln("[PsDesign] skip missing: " + psdPath); return; }
  var prevUnits = app.preferences.rulerUnits;
  var prevTypeUnits = app.preferences.typeUnits;
  app.preferences.rulerUnits = Units.PIXELS;
  app.preferences.typeUnits = TypeUnits.POINTS;
  var doc = app.open(file);
  try {
    for (var i = 0; i < edits.length; i++) {
      var e = edits[i];
      var layer = findLayerById(doc, e.id);
      if (!layer) { $.writeln("[PsDesign] layer " + e.id + " not found in " + psdPath); continue; }
      if (layer.kind !== LayerKind.TEXT) { $.writeln("[PsDesign] layer " + e.id + " is not text"); continue; }
      var ti = layer.textItem;
      if (typeof e.direction === "string") {
        try {
          if (e.direction === "vertical") ti.direction = Direction.VERTICAL;
          else if (e.direction === "horizontal") ti.direction = Direction.HORIZONTAL;
        } catch (eDirEx) {}
      }
      if (typeof e.contents === "string") ti.contents = normalizeLineBreaks(e.contents);
      if (typeof e.font === "string" && e.font.length > 0) ti.font = e.font;
      if (typeof e.size === "number") ti.size = new UnitValue(e.size, "pt");
      if (typeof e.dx === "number" || typeof e.dy === "number") {
        var dx = (typeof e.dx === "number") ? e.dx : 0;
        var dy = (typeof e.dy === "number") ? e.dy : 0;
        if (dx !== 0 || dy !== 0) {
          layer.translate(new UnitValue(dx, "px"), new UnitValue(dy, "px"));
        }
      }
      if (typeof e.strokeColor === "string" || typeof e.strokeWidth === "number") {
        try {
          applyStrokeEffect(layer, {
            color: (typeof e.strokeColor === "string") ? e.strokeColor : "none",
            size: (typeof e.strokeWidth === "number") ? e.strokeWidth : 20,
          });
        } catch (eStroke) {
          addWarning("境界線効果の適用に失敗 (layer " + e.id + "): " + eStroke);
        }
      }
      if (typeof e.fillColor === "string") {
        var fc = fillColorFor(e.fillColor);
        if (fc) {
          try { ti.color = fc; } catch (eFill) {
            addWarning("文字色の適用に失敗 (layer " + e.id + "): " + eFill);
          }
        }
      }
    }
    if (newLayers && newLayers.length > 0) {
      for (var j = 0; j < newLayers.length; j++) {
        var nl = newLayers[j];
        var layerRef = doc.artLayers.add();
        layerRef.kind = LayerKind.TEXT;
        var nti = layerRef.textItem;
        if (nl.direction === "vertical") {
          try { nti.direction = Direction.VERTICAL; } catch (eDir) {}
        } else if (nl.direction === "horizontal") {
          try { nti.direction = Direction.HORIZONTAL; } catch (eDir2) {}
        }
        nti.contents = normalizeLineBreaks(nl.contents);
        if (typeof nl.font === "string" && nl.font.length > 0) {
          try { nti.font = nl.font; } catch (eFont) {}
        }
        nti.size = new UnitValue((typeof nl.size === "number") ? nl.size : 24, "pt");
        try { nti.autoLeadingAmount = 125; } catch (eAutoLeadPct) {}
        try { nti.useAutoLeading = true; } catch (eAutoLead) {}
        try {
          var nfc = fillColorFor(typeof nl.fillColor === "string" ? nl.fillColor : "default");
          nti.color = nfc ? nfc : blackColor();
        } catch (eColor) {}
        nti.position = [new UnitValue(nl.x, "px"), new UnitValue(nl.y, "px")];
        try {
          var _b = layerRef.bounds;
          layerRef.translate(new UnitValue(0, "px"), new UnitValue(0, "px"));
        } catch (eBounds) {}
        try {
          applyStrokeEffect(layerRef, {
            color: (typeof nl.strokeColor === "string") ? nl.strokeColor : "none",
            size: (typeof nl.strokeWidth === "number") ? nl.strokeWidth : 20,
          });
        } catch (eStrokeNew) {
          addWarning("新規レイヤーへの境界線効果適用に失敗: " + eStrokeNew);
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
      try {
        doc.saveAs(outFile, opts, true, Extension.LOWERCASE);
      } catch (eSaveAs) {
        doc.saveAs(outFile, opts, true);
      }
    } else {
      doc.save();
    }
  } finally {
    doc.close(SaveOptions.DONOTSAVECHANGES);
    app.preferences.rulerUnits = prevUnits;
    app.preferences.typeUnits = prevTypeUnits;
  }
}
"##;
