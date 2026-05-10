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
            if let Some(b) = layer.synthetic_bold {
                out.push_str(&format!(", syntheticBold: {}", if b { "true" } else { "false" }));
            }
            if let Some(ref cb) = layer.char_bolds {
                if !cb.is_empty() {
                    out.push_str(", charBolds: ");
                    emit_char_bolds(&mut out, cb);
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
            if let Some(b) = nl.synthetic_bold {
                out.push_str(&format!(", syntheticBold: {}", if b { "true" } else { "false" }));
            }
            if let Some(ref cb) = nl.char_bolds {
                if !cb.is_empty() {
                    out.push_str(", charBolds: ");
                    emit_char_bolds(&mut out, cb);
                }
            }
            out.push_str("},\n");
        }
        // 【v1.22.0】記号フォント置換 PostScript 名 / 句読点ツメ % を追加引数として埋め込む。
        let symbol_font_ps_str = payload
            .symbol_font_post_script_name
            .as_deref()
            .unwrap_or("");
        let symbol_font_ps_js = if payload.symbol_font_replace_enabled && !symbol_font_ps_str.is_empty() {
            js_string(symbol_font_ps_str)
        } else {
            String::from("\"\"")
        };
        out.push_str(&format!(
            "], {}, {}, {}, {}, {}, {});\n",
            js_string(&save_path),
            payload.dash_tracking_mille,
            payload.tilde_tracking_mille,
            if payload.tate_chu_yoko_enabled { "true" } else { "false" },
            symbol_font_ps_js,
            payload.punctuation_tsume_percent
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

// 【v1.21.0】per-char サイズ map を JSX のオブジェクトリテラルとして emit。
// key は char index（数値）。出力順を char index 順に安定化（diff レビューや
// JSX 側のループの予測可能性のため）。
fn emit_char_sizes(out: &mut String, m: &std::collections::HashMap<String, f64>) {
    out.push('{');
    let mut first = true;
    let mut keys: Vec<&String> = m.keys().collect();
    keys.sort_by(|a, b| {
        a.parse::<i64>().unwrap_or(i64::MAX).cmp(&b.parse::<i64>().unwrap_or(i64::MAX))
    });
    for k in keys {
        if !first { out.push_str(", "); }
        first = false;
        out.push_str(&format!("\"{}\": {}", k, m[k]));
    }
    out.push('}');
}

// 【v1.21.0】per-char フォント map を JSX のオブジェクトリテラルとして emit。
// value は PostScript 名（string）なので js_string でエスケープ。
fn emit_char_fonts(out: &mut String, m: &std::collections::HashMap<String, String>) {
    out.push('{');
    let mut first = true;
    let mut keys: Vec<&String> = m.keys().collect();
    keys.sort_by(|a, b| {
        a.parse::<i64>().unwrap_or(i64::MAX).cmp(&b.parse::<i64>().unwrap_or(i64::MAX))
    });
    for k in keys {
        if !first { out.push_str(", "); }
        first = false;
        out.push_str(&format!("\"{}\": {}", k, js_string(m[k].as_str())));
    }
    out.push('}');
}

// 【v1.22.0】per-char 合成太字（faux bold）map を JSX のオブジェクトリテラルとして emit。
// value は boolean。
fn emit_char_bolds(out: &mut String, m: &std::collections::HashMap<String, bool>) {
    out.push('{');
    let mut first = true;
    let mut keys: Vec<&String> = m.keys().collect();
    keys.sort_by(|a, b| {
        a.parse::<i64>().unwrap_or(i64::MAX).cmp(&b.parse::<i64>().unwrap_or(i64::MAX))
    });
    for k in keys {
        if !first { out.push_str(", "); }
        first = false;
        out.push_str(&format!("\"{}\": {}", k, if m[k] { "true" } else { "false" }));
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
        try { styleClone.putString(sID("fontPostScriptName"), curFont); } catch (eFn) {}
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

// 【v1.22.0】===== 文字ごとの合成太字（faux bold / syntheticBold） =====
// charBolds: { "0": true, "5": false, ... } 絶対 char index → bool 値
// layerBold: layer 全体の bold flag (boolean)。char 個別指定が無い文字に適用。
//
// applyPerCharSizesAndFonts と同型の clone-and-replace。layerBold が true で
// charBolds が空の場合でも全 char に true をセットしたいので、layerBold あり
// または charBolds あり のどちらかで処理を起動する。
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

// 【v1.22.0】===== 記号フォント自動置換（♡♥★☆♪♫♬♩♯♭→←↑↓〇○●◎△▲▽▼□■◇◆♠♣♦） =====
// 写植本体フォントが対応していない記号類を別フォント（小塚ゴシック Pr6N R 等）で組む。
// 既存・新規両方のレイヤーに適用。プレビュー側（canvas-tools.js の SYMBOL_CHAR_CODES）と
// 同じ char code 集合を使う。ユーザーが per-char で手動指定したフォント (charFonts[i]) が
// ある char は skip（手動意図を尊重）。
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
      c === 0x2661 || c === 0x2665 ||                                       // hearts
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

  // 各 char に当てる置換フォント（null = 触らない、文字列 = 上書き）。
  var fontPerChar = [];
  var anyReplace = false;
  for (var i = 0; i < fullText.length; i++) {
    if (readManualFont(i) === null && isSymbolChar(fullText.charAt(i))) {
      fontPerChar[i] = symbolFontPS;
      anyReplace = true;
    } else {
      fontPerChar[i] = null;
    }
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
        try { styleClone.putString(sID("fontPostScriptName"), curFont); } catch (eFn) {}
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

  // 対象は「、」(U+3001) と「。」(U+3002) のみ。
  function isPunctChar(s) {
    var c = s.charCodeAt(0);
    return c === 0x3001 || c === 0x3002;
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
function applyTateChuYoko(layer, contents, enabled, direction) {
  if (!enabled) return;
  if (direction !== "vertical") return;
  var fullText = String(contents);
  if (fullText.length < 2) return;

  // ペア検出 (先頭から貪欲に 2 文字単位)
  var pairs = [];
  var i = 0;
  while (i < fullText.length - 1) {
    var two = fullText.charAt(i) + fullText.charAt(i + 1);
    if (two === "!!" || two === "!?") {
      pairs.push({ start: i, end: i + 2 });
      i += 2;
    } else {
      i += 1;
    }
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

// PsDesign が保存する PSD 内の全テキストレイヤーに、共通設定を適用する。
//   - autoKerning = MANUAL (= UI の「カーニング: 0」、自動カーニング無効)
//   - antiAliasMethod = SHARP (= 「シャープ」)
// 既存・新規を問わず、保存される PSD 内のテキストはすべてこの設定で揃える方針。
function applyDefaultTextSettingsToAllLayers(doc) {
  function visit(parent) {
    for (var i = 0; i < parent.layers.length; i++) {
      var l = parent.layers[i];
      if (l.typename === "LayerSet") {
        visit(l);
      } else if (l.kind === LayerKind.TEXT) {
        try { l.textItem.autoKerning = AutoKernType.MANUAL; } catch (eAk) {}
        try { l.textItem.antiAliasMethod = AntiAlias.SHARP; } catch (eAa) {}
      }
    }
  }
  visit(doc);
}

// 【v1.22.0】applyDefaultTextSettingsToAllLayers の DOM autoKerning 設定後に、句読点ツメを
// 全テキストレイヤーに再適用する safety net。DOM access が一部の per-char 属性を flatten で
// 落とすケースに対応。冪等（既に正しい値が入っていれば動作変化なし）。
function reapplyPunctuationTsumeForAllLayers(doc, tsumePct) {
  if (!tsumePct || tsumePct <= 0) return;
  function visit(parent) {
    for (var i = 0; i < parent.layers.length; i++) {
      var l = parent.layers[i];
      if (l.typename === "LayerSet") {
        visit(l);
      } else if (l.kind === LayerKind.TEXT) {
        try {
          var ct = l.textItem.contents;
          if (typeof ct === "string" && ct.length > 0) {
            applyPunctuationTsume(l, ct, tsumePct);
          }
        } catch (eR) {}
      }
    }
  }
  visit(doc);
}

// 【v1.22.0】記号フォント置換の Phase B safety net。新規・既存・未編集を問わず全テキスト
// レイヤーに再適用。charFonts は null（未編集レイヤーには manual override 情報が無いため、
// 全シンボル char を置換対象とする）。
function reapplySymbolFontForAllLayers(doc, symbolFontPS) {
  if (typeof symbolFontPS !== "string" || symbolFontPS.length === 0) return;
  function visit(parent) {
    for (var i = 0; i < parent.layers.length; i++) {
      var l = parent.layers[i];
      if (l.typename === "LayerSet") {
        visit(l);
      } else if (l.kind === LayerKind.TEXT) {
        try {
          var ct = l.textItem.contents;
          if (typeof ct === "string" && ct.length > 0) {
            applySymbolFont(l, ct, symbolFontPS, null);
          }
        } catch (eR) {}
      }
    }
  }
  visit(doc);
}

function applyToPsd(psdPath, edits, newLayers, savePath, dashTrackingMille, tildeTrackingMille, tateChuYokoEnabled, symbolFontPostScriptName, punctuationTsumePercent) {
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
      if (e.syntheticBold === true || e.syntheticBold === false ||
          (e.charBolds && !isObjEmpty(e.charBolds))) {
        try {
          applyPerCharBolds(layer, ti.contents, e.charBolds, e.syntheticBold === true);
        } catch (eBold) {
          addWarning("合成太字の適用に失敗 (layer " + e.id + "): " + eBold);
        }
      }
      // 【v1.22.0】記号フォント置換（♡♥★☆♪♫♬♩♯♭ など → symbolFontPostScriptName）。
      // 既存レイヤーにも適用（保存される PSD 内の全テキストを統一する方針）。
      // ユーザーが per-char で手動指定したフォント (e.charFonts[i]) がある char は skip。
      if (typeof symbolFontPostScriptName === "string" && symbolFontPostScriptName.length > 0) {
        try {
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
          // _ptInPx と _padInset (CSS .new-layer-text の padding 0.2em ぶん) は両 direction で
          // 共有するため if/else より前で算出。padding は v1.5.0 で bbox に +0.4em の安全余白を
          // 入れた際、テキスト本体を bbox 中央に視覚配置するため CSS で 0.2em ずつ仕込まれている。
          // 旧 JSX 補正は v1.4.0 時点 (padding 無し) の式のままで、この 0.2em 補正が抜けると
          // 縦書きは Photoshop で 0.2em 左ズレ、横書きは 0.2em 上ズレになる
          // (24pt/600dpi で約 40px)。
          var _dpi = doc.resolution;
          var _sizePt = (typeof nl.size === "number") ? nl.size : 24;
          var _ptInPx = _sizePt * (_dpi / 72);
          var _padInset = 0.2 * _ptInPx;
          var _fixDx, _fixDy;
          if (nl.direction === "vertical") {
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
            // bbox.right (= nl.x + thick) は v1.5.0 で +0.4em 拡張されたが、
            // CSS padding-right 0.2em で text 右端は bbox.right から 0.2em 内側に入る。
            // よって preview の text 右端は nl.x + thick + 0.2em - halfLeading の位置にある。
            // (nl.x 自身が bubble center 基準で 0.2em 左にシフトしている分も加味すると、
            //  preview text 右端の絶対位置は v1.4.0 と同じ。JSX 補正にだけ +0.2em が抜けていた。)
            var _boxRight = nl.x + _thick + _padInset - _halfLeading;
            _fixDx = _boxRight - _actualRight;
            _fixDy = nl.y - _actualTop;
          } else {
            // 横書きも同様に CSS padding-top 0.2em ぶん bounds.top を下げる必要がある。
            // 補正なしだと Photoshop でテキストが 0.2em 上にずれる。
            _fixDx = nl.x - _actualLeft;
            _fixDy = (nl.y + _padInset) - _actualTop;
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
        if (nl.syntheticBold === true || nl.syntheticBold === false ||
            (nl.charBolds && !isObjEmpty(nl.charBolds))) {
          try {
            applyPerCharBolds(layerRef, nti.contents, nl.charBolds, nl.syntheticBold === true);
          } catch (eBoldNew) {
            addWarning("新規レイヤーの合成太字適用に失敗: " + eBoldNew);
          }
        }
        // 【v1.22.0】記号フォント置換（♡♥★☆♪♫♬♩♯♭ など → symbolFontPostScriptName）。
        // 新規レイヤーにも適用。ユーザーが per-char で手動指定したフォントは尊重。
        if (typeof symbolFontPostScriptName === "string" && symbolFontPostScriptName.length > 0) {
          try {
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
        // 縦中横（!! / !? の自動 tcy）。設定 ON かつ縦書きレイヤーのみ。
        // applyRepeatedDashTracking の後に呼ぶことで、tracking で再構築された textStyleRange
        // を引き継ぎつつ baselineDirection=cross を上乗せする。
        if (tateChuYokoEnabled) {
          try {
            applyTateChuYoko(layerRef, nti.contents, true, nl.direction);
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
    // 保存する PSD 内の全テキストレイヤーをカーニング 0 (MANUAL) + アンチエイリアス
    // シャープに揃える。新規 / 既存問わず、書き出される PSD のテキスト設定を統一する。
    try { applyDefaultTextSettingsToAllLayers(doc); } catch (eDefSet) {
      addWarning("テキスト共通設定 (kerning/antialias) の適用に失敗: " + eDefSet);
    }
    // 【v1.22.0】Phase B: applyDefaultTextSettingsToAllLayers の DOM autoKerning 設定が
    // textStyleRange を flatten してマイナーな per-char 属性（tsume / 記号フォント）を
    // 落とすことがあるため、保存直前に全テキストレイヤーへ再適用する safety net。
    // 既存・新規・PsDesign が触っていないレイヤーすべてが対象。再適用は冪等（既に正しい
    // 値が入っていれば動作変化なし）。
    if (typeof punctuationTsumePercent === "number" && punctuationTsumePercent > 0) {
      try { reapplyPunctuationTsumeForAllLayers(doc, punctuationTsumePercent); }
      catch (eRTs) { addWarning("句読点ツメ再適用に失敗: " + eRTs); }
    }
    if (typeof symbolFontPostScriptName === "string" && symbolFontPostScriptName.length > 0) {
      try { reapplySymbolFontForAllLayers(doc, symbolFontPostScriptName); }
      catch (eRSym) { addWarning("記号フォント置換再適用に失敗: " + eRSym); }
    }
    if (typeof savePath === "string" && savePath.length > 0) {
      var outFile = new File(savePath);
      try {
        var outFolder = outFile.parent;
        if (outFolder && !outFolder.exists) outFolder.create();
      } catch (eMk) {}
      // 既存ファイルがあれば事前に削除して saveAs の確実な上書きを保証する。
      // asCopy=true の saveAs は本来上書きするが、ファイルロックや権限エラーで
      // silent に失敗するケースがある（その場合 catch も走らずに古いファイルが残る）。
      // 事前削除で「ファイルが存在しない状態で saveAs」する安全パスに揃える。
      try {
        if (outFile.exists) outFile.remove();
      } catch (eRm) {
        addWarning("既存ファイル削除失敗: " + outFile.fsName + " (" + eRm + ")");
      }
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
