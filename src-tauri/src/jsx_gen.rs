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
            if let Some(ref ll) = layer.line_leadings {
                if !ll.is_empty() {
                    out.push_str(", lineLeadings: ");
                    emit_line_leadings(&mut out, ll);
                }
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
            if let Some(r) = nl.rotation {
                out.push_str(&format!(", rotation: {}", r));
            }
            if let Some(l) = nl.leading_pct {
                out.push_str(&format!(", leadingPct: {}", l));
            }
            if let Some(ref ll) = nl.line_leadings {
                if !ll.is_empty() {
                    out.push_str(", lineLeadings: ");
                    emit_line_leadings(&mut out, ll);
                }
            }
            out.push_str("},\n");
        }
        out.push_str(&format!(
            "], {}, {}, {});\n",
            js_string(&save_path),
            payload.dash_tracking_mille,
            payload.tilde_tracking_mille
        ));
        out.push_str("    __saveOk++;\n");
        out.push_str("  } catch (eFile) {\n");
        out.push_str(&format!(
            "    __saveFail++;\n    addWarning(\"[保存失敗] \" + {} + \": \" + (eFile && eFile.toString ? eFile.toString() : String(eFile)));\n",
            js_string(file_name)
        ));
        out.push_str("  }\n\n");
    }

    out.push_str(&format!(
        "  setProgress({0}, {0}, \"完了\");\n",
        total
    ));
    // 1 件以上失敗した場合は "OK partial <ok>/<total>" を返し、Rust 側で
    // 「N / M 個の PSD を更新」表示に切替える。失敗詳細は |WARN suffix。
    out.push_str("  if (__saveFail > 0) {\n");
    out.push_str("    writeSentinel(\"OK partial \" + __saveOk + \"/\" + (__saveOk + __saveFail));\n");
    out.push_str("  } else {\n");
    out.push_str("    writeSentinel(\"OK\");\n");
    out.push_str("  }\n");
    out.push_str("} catch (err) {\n");
    out.push_str("  writeSentinel(\"ERROR \" + (err && err.toString ? err.toString() : String(err)));\n");
    out.push_str("}\n");
    out
}

fn emit_line_leadings(out: &mut String, m: &std::collections::HashMap<String, f64>) {
    out.push('{');
    let mut first = true;
    // 出力順を安定化させるため key でソート（ExtendScript 側は順序非依存だが diff 安定化に有用）。
    let mut keys: Vec<&String> = m.keys().collect();
    keys.sort();
    for k in keys {
        if !first { out.push_str(", "); }
        first = false;
        out.push_str(&format!("\"{}\": {}", k, m[k]));
    }
    out.push('}');
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

// ===== 行ごとの行間（per-line leading）適用 =====
// Photoshop は per-character leading なので、Action Manager で textKey を取得して
// textStyleRange を行単位にバラし、override がある行だけ autoLeading=false + 絶対 leading
// に置換する。ベースの textStyle は 1 つ目から複製して継承する。

function isObjEmpty(o) {
  if (!o) return true;
  for (var k in o) if (o.hasOwnProperty(k)) return false;
  return true;
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

  var lines = String(contents).split("\r");
  var newRangeList = new ActionList();
  var pos = 0;
  for (var i = 0; i < lines.length; i++) {
    var len = lines[i].length;
    var startChar = pos;
    var includeBreak = (i < lines.length - 1) ? 1 : 0;
    var endChar = pos + len + includeBreak;

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
  setDesc.putObject(sID("to"), sID("textKey"), newTextKey);
  executeAction(sID("set"), setDesc, DialogModes.NO);
}

// ===== 連続記号「— ― 〜 ～」の自動ツメ =====
// 連続したラン（length >= 2）の最初の N-1 文字に tracking を当てる。最後の 1 文字は
// ツメない（次の通常文字との字間が詰まりすぎないように。プレビュー側 CSS の挙動と一致）。
// 既に textStyleRange が複数あれば（例：applyLineLeadings 後）、各範囲ごとに baseStyle を
// 引き継いで tracking を上書きするため、行ごとの行間と併用しても情報を失わない。
function applyRepeatedDashTracking(layer, contents, dashMille, tildeMille) {
  var dashTrack = -Math.abs(dashMille || 0);
  var tildeTrack = -Math.abs(tildeMille || 0);
  if (dashTrack === 0 && tildeTrack === 0) return;
  // 対象文字を char code で判定。regex の Unicode リテラルは ExtendScript のファイル
  // エンコーディング（既定 Shift_JIS / Win JP）に左右されるため、char code 直接指定で安全に。
  // dash:  — U+2014 / ― U+2015 / – U+2013 / ‒ U+2012 / ‐ U+2010 / ‑ U+2011 / ー U+30FC / － U+FF0D
  // tilde: 〜 U+301C / ～ U+FF5E
  function charGroup(s) {
    var c = s.charCodeAt(0);
    if (c === 0x2014 || c === 0x2015 || c === 0x2013 || c === 0x2012 ||
        c === 0x2010 || c === 0x2011 || c === 0x30FC || c === 0xFF0D) return "dash";
    if (c === 0x301C || c === 0xFF5E) return "tilde";
    return null;
  }
  function isTargetChar(s) { return charGroup(s) !== null; }

  var fullText = String(contents);
  if (fullText.length === 0) return;

  // 各 char に当てる tracking 値（0 = ツメなし）。連続ランの最後の 1 文字は常に 0。
  var trackingPerChar = [];
  for (var p0 = 0; p0 < fullText.length; p0++) trackingPerChar[p0] = 0;
  var i = 0;
  var anyTracked = false;
  while (i < fullText.length) {
    if (isTargetChar(fullText.charAt(i))) {
      var j = i;
      while (j < fullText.length && isTargetChar(fullText.charAt(j))) j++;
      // ラン長 N >= 2 のとき、最初の N-1 文字に group 別の tracking を当てる
      if (j - i >= 2) {
        for (var k = i; k < j - 1; k++) {
          var grp = charGroup(fullText.charAt(k));
          var v = grp === "dash" ? dashTrack : grp === "tilde" ? tildeTrack : 0;
          if (v !== 0) {
            trackingPerChar[k] = v;
            anyTracked = true;
          }
        }
      }
      i = j;
    } else {
      i++;
    }
  }
  if (!anyTracked) return;

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

  // (srcRangeIndex, trackingValue) が連続している区間に圧縮し、textStyleRange を再構築
  var newRangeList = new ActionList();
  if (typeof srcRangeIndex[0] !== "number") srcRangeIndex[0] = 0;
  var curStart = 0;
  var curSrc = srcRangeIndex[0];
  var curTrack = trackingPerChar[0] || 0;

  for (var p = 1; p <= totalChars; p++) {
    var nextSrc, nextTrack, boundary;
    if (p === totalChars) {
      boundary = true;
      nextSrc = curSrc;
      nextTrack = curTrack;
    } else {
      nextSrc = (typeof srcRangeIndex[p] === "number") ? srcRangeIndex[p] : curSrc;
      nextTrack = trackingPerChar[p] || 0;
      boundary = (nextSrc !== curSrc) || (nextTrack !== curTrack);
    }
    if (boundary) {
      var srcRange = oldRanges.getObjectValue(curSrc);
      var srcStyle = srcRange.getObjectValue(sID("textStyle"));
      var styleClone = cloneActionDescriptor(srcStyle);
      try {
        styleClone.putInteger(sID("tracking"), curTrack);
      } catch (eTrack) {}
      var newRangeDesc = new ActionDescriptor();
      newRangeDesc.putInteger(sID("from"), curStart);
      newRangeDesc.putInteger(sID("to"), p);
      newRangeDesc.putObject(sID("textStyle"), sID("textStyle"), styleClone);
      newRangeList.putObject(sID("textStyleRange"), newRangeDesc);
      curStart = p;
      curSrc = nextSrc;
      curTrack = nextTrack;
    }
  }

  var newTextKey = cloneActionDescriptor(textKey);
  newTextKey.putList(sID("textStyleRange"), newRangeList);
  var setDesc = new ActionDescriptor();
  setDesc.putReference(sID("null"), layerRef);
  // class は "textLayer" (charID "TxtL") を指定。"textKey" を指定すると Photoshop が
  // 渡された textStyleRange を破棄して既存値を保持するケースがあるため、tracking のような
  // per-character スタイル変更は "textLayer" class で set する必要がある。
  setDesc.putObject(sID("to"), sID("textLayer"), newTextKey);
  executeAction(sID("set"), setDesc, DialogModes.NO);
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

function applyToPsd(psdPath, edits, newLayers, savePath, dashTrackingMille, tildeTrackingMille) {
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
      if (typeof e.leadingPct === "number") {
        try {
          ti.autoLeadingAmount = e.leadingPct;
          ti.useAutoLeading = true;
        } catch (eLead) {
          addWarning("行間の適用に失敗 (layer " + e.id + "): " + eLead);
        }
      }
      if (e.lineLeadings && !isObjEmpty(e.lineLeadings)) {
        try {
          var __sz = ti.size.value;
          applyLineLeadings(layer, e.lineLeadings, ti.contents, __sz);
        } catch (eLineLead) {
          addWarning("行ごとの行間の適用に失敗 (layer " + e.id + "): " + eLineLead);
        }
      }
      if (typeof e.rotation === "number" && e.rotation !== 0) {
        try {
          layer.rotate(e.rotation, AnchorPosition.MIDDLECENTER);
        } catch (eRot) {
          addWarning("レイヤー回転の適用に失敗 (layer " + e.id + "): " + eRot);
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
        //     ここで thick = ptInPsdPx * leadingFactor * lineCount は編集側 layerRectForNew と同じ式。
        try {
          var _b = layerRef.bounds;
          var _actualLeft  = _b[0].as("px");
          var _actualTop   = _b[1].as("px");
          var _actualRight = _b[2].as("px");
          var _fixDx, _fixDy;
          if (nl.direction === "vertical") {
            var _dpi = doc.resolution;
            var _sizePt = (typeof nl.size === "number") ? nl.size : 24;
            var _ptInPx = _sizePt * (_dpi / 72);
            var _lpFactor = ((typeof nl.leadingPct === "number") ? nl.leadingPct : 125) / 100;
            var _contentsForCount = String(nl.contents || "");
            var _lc = _contentsForCount.split(/\r?\n/).length;
            if (_lc < 1) _lc = 1;
            var _thick = _ptInPx * _lpFactor * _lc;
            if (_thick < 24) _thick = 24;
            // CSS line-box 由来の最右列インセット。理論値は (leadingFactor - 1) * em / 2
            // (両側均等の half-leading 想定) だが、実機の Browser 側 vertical-rl では
            // line-height extra (= (L - 1) * em) が左側に寄せて配置される挙動が観測された。
            // empirical に full extra を採用 (24pt/600dpi/125% で 50px)。
            // 反復: 1/2 → 12px 右ズレ / 3/4 → 8px 右ズレ / 1 → ≈0px (本値)。
            var _halfLeading = (_lpFactor - 1) * _ptInPx;
            if (_halfLeading < 0) _halfLeading = 0;
            var _boxRight = nl.x + _thick - _halfLeading;
            _fixDx = _boxRight - _actualRight;
            _fixDy = nl.y - _actualTop;
          } else {
            _fixDx = nl.x - _actualLeft;
            _fixDy = nl.y - _actualTop;
          }
          if (_fixDx !== 0 || _fixDy !== 0) {
            layerRef.translate(new UnitValue(_fixDx, "px"), new UnitValue(_fixDy, "px"));
          }
        } catch (eBounds) {}
        try {
          applyStrokeEffect(layerRef, {
            color: (typeof nl.strokeColor === "string") ? nl.strokeColor : "none",
            size: (typeof nl.strokeWidth === "number") ? nl.strokeWidth : 20,
          });
        } catch (eStrokeNew) {
          addWarning("新規レイヤーへの境界線効果適用に失敗: " + eStrokeNew);
        }
        if (nl.lineLeadings && !isObjEmpty(nl.lineLeadings)) {
          try {
            var __szNew = nti.size.value;
            applyLineLeadings(layerRef, nl.lineLeadings, nti.contents, __szNew);
          } catch (eLineLeadNew) {
            addWarning("新規レイヤーの行ごとの行間適用に失敗: " + eLineLeadNew);
          }
        }
        // 連続記号のツメ（環境設定の global 値）。新規レイヤーのみ。
        // 負値・正値どちらでも「絶対値ぶん詰める」セマンティクスに統一（ユーザー混乱を吸収）。
        // dash 系と tilde 系で別々の値を per-char に当てる。
        var __hasDashTrack = typeof dashTrackingMille === "number" && dashTrackingMille !== 0;
        var __hasTildeTrack = typeof tildeTrackingMille === "number" && tildeTrackingMille !== 0;
        if (__hasDashTrack || __hasTildeTrack) {
          try {
            applyRepeatedDashTracking(
              layerRef,
              nti.contents,
              __hasDashTrack ? dashTrackingMille : 0,
              __hasTildeTrack ? tildeTrackingMille : 0
            );
          } catch (eDashTrack) {
            addWarning("連続記号のツメ適用に失敗: " + eDashTrack);
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
        if (__textGroup) {
          try {
            layerRef.move(__textGroup, ElementPlacement.PLACEATBEGINNING);
          } catch (eMoveNL) {
            addWarning("text フォルダへの移動に失敗 (新規レイヤー): " + eMoveNL);
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
