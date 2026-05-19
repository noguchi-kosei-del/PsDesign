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
        let symbol_font_ps_js = if payload.symbol_font_replace_enabled && !symbol_font_ps_str.is_empty() {
            js_string(symbol_font_ps_str)
        } else {
            String::from("\"\"")
        };
        let page_width = psd
            .page_width
            .filter(|v| v.is_finite() && *v > 0.0)
            .unwrap_or(0.0);
        let page_height = psd
            .page_height
            .filter(|v| v.is_finite() && *v > 0.0)
            .unwrap_or(0.0);
        out.push_str(&format!(
            "], {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {});\n",
            js_string(&save_path),
            payload.dash_tracking_mille,
            payload.tilde_tracking_mille,
            if payload.tate_chu_yoko_enabled { "true" } else { "false" },
            symbol_font_ps_js,
            payload.punctuation_tsume_percent,
            // 【v1.29.x】ルビあり行間 (%)。applyToPsd 内で「ルビありレイヤーの親文字行間」を
            // autoLeadingAmount として設定するために使う (useAutoLeading=true、ジャスティ
            // フィケーションのみ rubyLeadingPct)。
            payload.ruby_leading_pct,
            // 【v1.29.x】ルビ位置 Photoshop 微調整: 親寄せ em (親 fontSize 単位)、親離し px
            payload.ruby_photoshop_offset_em,
            payload.ruby_photoshop_bias_px,
            page_width,
            page_height
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
) where F: Fn(&T) -> String {
    out.push('{');
    let mut first = true;
    let mut keys: Vec<&String> = m.keys().collect();
    keys.sort_by(|a, b| {
        a.parse::<i64>().unwrap_or(i64::MAX).cmp(&b.parse::<i64>().unwrap_or(i64::MAX))
    });
    for k in keys {
        if !first { out.push_str(", "); }
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
app.bringToFront();

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
function initProgress(total) {
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
  return s.replace(/！！/g, "!!").replace(/！？/g, "!?");
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

  // contents の行分解。Photoshop の contents は \r 区切り (JS の split で対応)。
  var normContents = String(contents || "");
  var lines = normContents.split(/\r\n|\n|\r/);
  if (lines.length === 0) return;

  // 各行の char [start, end) 範囲を計算 (改行を含む末端まで、最終行は除く)。
  var lineRanges = [];
  var cumCh = 0;
  for (var li = 0; li < lines.length; li++) {
    var lstart = cumCh;
    var lend = cumCh + lines[li].length;
    if (li < lines.length - 1) lend += 1; // 改行 (\r) 1 文字
    lineRanges.push({ from: lstart, to: lend });
    cumCh = lend;
  }

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
  for (var ci = 0; ci < normContents.length; ci++) {
    if (normContents.charAt(ci) === "\n" || normContents.charAt(ci) === "\r") {
      lineStarts.push(ci + 1);
    }
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
  for (var k in charRubies) {
    if (!charRubies.hasOwnProperty(k)) continue;
    var start = parseInt(k, 10);
    if (isNaN(start)) continue;
    var parentLine = charIndexToLine(start);
    // 縦書き・横書きとも「親文字行の一つ前 (i-1)」を target。0 行目スキップ。
    var targetLine = parentLine - 1;
    if (targetLine < 0) continue;
    if (!seen[String(targetLine)]) {
      seen[String(targetLine)] = true;
      out.push(targetLine);
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
function applyRubies(parentLayer, contents, charRubies, fontSizePt, parentDirection, parentFontPS, parentFillColor, parentTopLeftOverride, rubyPhotoshopOffsetEm, rubyPhotoshopBiasPx) {
  if (!charRubies || isObjEmpty(charRubies)) return;

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
        try {
          createRubyLayer(parentLayer, contents, startChar + mi, startChar + mi + 1,
                          parentText.charAt(mi), monoSegments[mi],
                          rubySizePt, parentDirection, parentFontPS, parentFillColor,
                          // モノルビは最初の文字 (mi=0) のみ UI offset を使う。
                          // 残りの文字は計算式 fallback (= 各 char range の中心で配置)。
                          mi === 0 ? uiOffsetX : null, mi === 0 ? uiOffsetY : null,
                          mi === 0 ? uiAbsX : null, mi === 0 ? uiAbsY : null,
                          parentTopLeftOverride,
                          rubyPhotoshopOffsetEm, rubyPhotoshopBiasPx);
        } catch (eMono) {
          addWarning("モノルビ「" + parentText.charAt(mi) + "（" + monoSegments[mi] + "）」適用失敗: " + eMono);
        }
      }
    } else {
      try {
        createRubyLayer(parentLayer, contents, startChar, endChar,
                        parentText, rubyText,
                        rubySizePt, parentDirection, parentFontPS, parentFillColor,
                        uiOffsetX, uiOffsetY, uiAbsX, uiAbsY,
                        parentTopLeftOverride,
                        rubyPhotoshopOffsetEm, rubyPhotoshopBiasPx);
      } catch (eGroup) {
        addWarning("グループルビ「" + parentText + "（" + rubyText + "）」適用失敗: " + eGroup);
      }
    }
  }
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
  rubyLayer.name = rubyText + "（" + parentSubText + "）";
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
      var parentEmPx = 200; // フォールバック (24pt × 600/72)
      try {
        var pSizePt = parentLayer.textItem.size.value;
        var dpiVal = doc.resolution;
        if (typeof pSizePt === "number" && pSizePt > 0
            && typeof dpiVal === "number" && dpiVal > 0) {
          parentEmPx = pSizePt * (dpiVal / 72);
        }
      } catch (eEm) {}
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
        targetLeft = rangeBounds.right + gap;
        var rangeMidV = (rangeBounds.top + rangeBounds.bottom) / 2;
        targetTop = rangeMidV - rubyHeight / 2;
      } else {
        // 横書き: ルビは親 char range の **上** に配置。
        var rangeMidH = (rangeBounds.left + rangeBounds.right) / 2;
        targetLeft = rangeMidH - rubyWidth / 2;
        targetTop = rangeBounds.top - rubyHeight - gap;
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
  var lines = fullText.split("\n");
  if (lines.length === 0) return parentBounds;
  // 各行が contents 内で開始する char index と長さを事前計算。
  var lineStartChs = [];
  var maxLineLen = 0;
  var lineStartCh = 0;
  for (var i = 0; i < lines.length; i++) {
    lineStartChs.push(lineStartCh);
    if (lines[i].length > maxLineLen) maxLineLen = lines[i].length;
    lineStartCh += lines[i].length + 1; // +1 for \n
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
function applyTateChuYoko(layer, contents, enabled, direction) {
  if (!enabled) return;
  if (direction !== "vertical") return;
  var fullText = String(contents);
  if (fullText.length < 2) return;

  // 【v1.26.0】PSD 保存時に全角 ！！/！？ を半角 !!/!? に変換する。
  // Photoshop の縦中横 (baselineDirection: cross) は半角の合成 glyph 化が安定しており、
  // 全角だと cross 属性を当てても縦に並んだまま残るケースが実機で確認されている。
  // 半角化は char index 1:1 (全角 1 文字 → 半角 1 文字) なので、後段の per-char 系
  // (applyLineLeadings / applyPerCharSizesAndFonts / applyPerCharBolds 等) に影響なし。
  // 変換後の textItem.contents で pairs を再検出 (もちろん半角ペアも該当する)。
  var hasFullWidthPair = fullText.indexOf("！！") >= 0 || fullText.indexOf("！？") >= 0;
  if (hasFullWidthPair) {
    var halfText = fullText.replace(/！！/g, "!!").replace(/！？/g, "!?");
    try {
      // 改行は \r で渡す (Photoshop textItem.contents の標準)。normalizeLineBreaks と同じ規約。
      layer.textItem.contents = halfText.replace(/\n/g, "\r");
      fullText = halfText;
    } catch (eContentsRewrite) {
      // contents 上書きに失敗しても、ペア検出は元 fullText のまま継続
      addWarning("縦中横の半角化に失敗 (contents 上書き): " + eContentsRewrite);
    }
  }

  // ペア検出 (先頭から貪欲に 2 文字単位)
  // 半角 "!!" / "!?" に加えて、全角 "！！" / "！？" も縦中横の対象として扱う。
  // PSD 既存テキストは全角で組まれていることが多く、ユーザーが PsDesign で開いた
  // 際に自動で縦中横化されるべき (ag-psd は全角のまま contents として返す)。
  var pairs = [];
  var i = 0;
  while (i < fullText.length - 1) {
    var two = fullText.charAt(i) + fullText.charAt(i + 1);
    if (two === "!!" || two === "!?" || two === "！！" || two === "！？") {
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

// 【v1.31.x】applyDefaultTextSettingsToAllLayers の DOM autoKerning 設定後に、
// 連続記号ツメ (dash / tilde) を全テキストレイヤーへ再適用する safety net。
function reapplyRepeatedTrackingForAllLayers(doc, dashMille, tildeMille) {
  var dashTrack = (typeof dashMille === "number" && isFinite(dashMille)) ? dashMille : 0;
  var tildeTrack = (typeof tildeMille === "number" && isFinite(tildeMille)) ? tildeMille : 0;
  function visit(parent) {
    for (var i = 0; i < parent.layers.length; i++) {
      var l = parent.layers[i];
      if (l.typename === "LayerSet") {
        visit(l);
      } else if (l.kind === LayerKind.TEXT) {
        try {
          var ct = l.textItem.contents;
          if (typeof ct === "string" && ct.length > 0) {
            applyRepeatedDashTracking(l, ct, dashTrack, tildeTrack);
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

function applyToPsd(psdPath, edits, newLayers, savePath, dashTrackingMille, tildeTrackingMille, tateChuYokoEnabled, symbolFontPostScriptName, punctuationTsumePercent, rubyLeadingPct, rubyPhotoshopOffsetEm, rubyPhotoshopBiasPx, uiPageWidth, uiPageHeight) {
  var file = new File(psdPath);
  if (!file.exists) { $.writeln("[OPUS] skip missing: " + psdPath); return; }
  var prevUnits = app.preferences.rulerUnits;
  var prevTypeUnits = app.preferences.typeUnits;
  app.preferences.rulerUnits = Units.PIXELS;
  app.preferences.typeUnits = TypeUnits.POINTS;
  var doc = app.open(file);
  try {
    var __rubyAbsScaleX = 1;
    var __rubyAbsScaleY = 1;
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
      var layer = findLayerById(doc, e.id);
      if (!layer) { $.writeln("[OPUS] layer " + e.id + " not found in " + psdPath); continue; }
      if (layer.kind !== LayerKind.TEXT) { $.writeln("[OPUS] layer " + e.id + " is not text"); continue; }
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
      // 【v1.29.x】ルビあり時は applyLineLeadings (textStyleRange に Ldng pt 固定) を呼ばず、
      // 代わりに applyRubyAutoLeadingPercentage で paragraphStyleRange に
      // autoLeadingPercentage を行ごとに当てる (参考: 共有プラグイン ruby/index.js)。
      // ルビなしのときは従来通り applyLineLeadings (ユーザー手動の per-line override)。
      var __hasRubyE = (e.charRubies && !isObjEmpty(e.charRubies));
      if (!__hasRubyE && e.lineLeadings && !isObjEmpty(e.lineLeadings)) {
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
      // 【v1.26.0】ルビ。親レイヤーは保持しつつ、ルビごとに新規テキストレイヤーを
      // 親の直前に追加する（Photoshop ruby プラグインと同じ方針）。
      if (e.charRubies && !isObjEmpty(e.charRubies)) {
        // ルビあり行 (= main.js doApply で setLineLeading 済みの行) の
        // paragraphStyle.autoLeadingPercentage を rubyLeadingPct/100 に上書き。
        // 【v1.29.x】direction で対象行を分岐 (縦書き=当該行 / 横書き=前の行)。
        if (typeof rubyLeadingPct === "number" && rubyLeadingPct > 0) {
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
          var __colR = null;
          try { __colR = ti.color; } catch (eCol0) {}
          // 【v1.29.x 修正】parentTopLeftOverride は null で渡す。autoLeadingPercentage で
          // 親レイヤーがシフトしても、ルビは「現在の親 bounds + uiOffsetX/Y」を基準に置く
          // ことで、親-ルビ間の相対距離 (ビューアーで見ていた値) が維持される。
          // override を渡すとシフト分ルビが前の行寄りに離れすぎる事故が起きる。
          var __rubiesScaled = scaleRubyAbsoluteCoords(e.charRubies, __rubyAbsScaleX, __rubyAbsScaleY);
          applyRubies(layer, ti.contents, __rubiesScaled, __szR, __dirR, __fontR, __colR, null,
                      rubyPhotoshopOffsetEm, rubyPhotoshopBiasPx);
        } catch (eRuby) {
          addWarning("ルビの適用に失敗 (layer " + e.id + "): " + eRuby);
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
      if (tateChuYokoEnabled) {
        try {
          var __dirTcy = (typeof e.direction === "string") ? e.direction
                       : (ti.direction === Direction.VERTICAL ? "vertical" : "horizontal");
          if (__dirTcy === "vertical") {
            applyTateChuYoko(layer, ti.contents, true, __dirTcy);
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
        // 【v1.29.x 修正】autoLeadingAmount は段落全体属性。ルビあり行のみ 150% にしたい
        // なら applyLineLeadings 経路で per-line 固定 leading を当てる方式に統一する。
        // ここでは元の leadingPct (or 125 default) のまま、自動行送りで設定する。
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
          // CSS .new-layer-text の padding は両方向で 0.2em だが、Photoshop での
          // 植字位置補正は方向で異なる：
          //  - 横書き: 0.2em (CSS padding-top と一致、v1.4.0 と整合)
          //  - 縦書き: 0.3em (v1.26.0 移植/PsDesign-main v1.24.0)
          //     縦書きは Photoshop の font sidebearing + line-box gutter が CSS の半分よりも
          //     大きく出る経験値があり、0.2em では約 0.1em ぶん左ズレが残る。0.3em で吸収。
          //     24pt/600dpi で従来 0.2em (40px) → 0.3em (60px) と +20px 右シフト。
          var _padInset = 0.2 * _ptInPx;
          var _padInsetV = 0.3 * _ptInPx;
          var _fixDx, _fixDy;
          if (nl.direction === "vertical") {
            // 【v1.29.x 修正】autoLeadingAmount を rubyLeadingPct で上書きしなくなったため、
            // bbox の縦書き thick 計算も元の leadingPct (or 125 default) のままで OK。
            // ルビあり行は applyLineLeadings の per-line 固定 leading で個別に処理される。
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
            // 【v1.26.0 移植】縦書きは sidebearing 込みで _padInsetV (0.3em) を使う。
            var _boxRight = nl.x + _thick + _padInsetV - _halfLeading;
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
        // 【v1.29.x】ルビあり時は applyLineLeadings (Ldng pt 固定) を呼ばず、
        // 代わりに後段の applyRubyAutoLeadingPercentage で paragraphStyleRange を分割する。
        // ルビなしのときだけユーザーの手動 per-line override を当てる。
        var __hasRubyNL = (nl.charRubies && !isObjEmpty(nl.charRubies));
        if (!__hasRubyNL && nl.lineLeadings && !isObjEmpty(nl.lineLeadings)) {
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
        // 【v1.26.0】ルビ（新規レイヤー）。親 layer の textKey 上書きが完了してから呼ぶ。
        // ルビレイヤーは親の直前に追加され、新規 text グループ (__textGroup) 内に居る。
        if (nl.charRubies && !isObjEmpty(nl.charRubies)) {
          // ルビあり行 (= main.js doApply で setLineLeading 済みの行) の
          // paragraphStyle.autoLeadingPercentage を rubyLeadingPct/100 に上書き。
          // 【v1.29.x】direction で対象行を分岐 (縦書き=当該行 / 横書き=前の行)。
          if (typeof rubyLeadingPct === "number" && rubyLeadingPct > 0) {
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
            var __colRN = null;
            try { __colRN = nti.color; } catch (eCol1) {}
            // 【v1.29.x 修正】parentTopLeftOverride は null。autoLeadingPercentage で親が
            // シフトしても、ルビは「現在の親 bounds + uiOffsetX/Y」基準で配置することで、
            // ビューアー上で見ていた「親-ルビの相対位置」を維持する。
            var __rubiesScaledN = scaleRubyAbsoluteCoords(nl.charRubies, __rubyAbsScaleX, __rubyAbsScaleY);
            applyRubies(layerRef, nti.contents, __rubiesScaledN, __szRN, __dirRN, __fontRN, __colRN, null,
                        rubyPhotoshopOffsetEm, rubyPhotoshopBiasPx);
          } catch (eRubyN) {
            addWarning("新規レイヤーのルビ適用に失敗: " + eRubyN);
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
        // dash 系と tilde 系で別々に、写植設定の tracking 値をそのまま per-char に当てる。
        try {
          applyRepeatedDashTracking(layerRef, nti.contents, dashTrackingMille, tildeTrackingMille);
        } catch (eDashTrack) {
          addWarning("連続記号のツメ適用に失敗: " + eDashTrack);
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
    try { reapplyRepeatedTrackingForAllLayers(doc, dashTrackingMille, tildeTrackingMille); }
    catch (eRTr) { addWarning("連続記号のツメ再適用に失敗: " + eRTr); }
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
