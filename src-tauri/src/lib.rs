mod alignment;
mod fonts;
mod jsx_gen;
mod ocr;
mod photoshop;
mod tachimi;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::Manager;

// 【v1.26.0】ルビ 1 件分のエントリ。state.js の charRubies スキーマと対応。
// 【v1.29.x UI-coord】offset_x / offset_y: ビューアー上のルビ wrap の実描画位置を
// 親レイヤー基準の PSD 座標 (px) で保持。canvas-tools.js scheduleRubyOffsetMeasure が
// renderOverlay 後にビューアー DOM から実測して setCharRubyOffset で書き戻す。
// 値があれば JSX 側 createRubyLayer はこの座標をルビ「中心」として配置するため、
// CSS / JSX の計算式不一致による位置ズレが完全に排除される。Option (未設定なら従来の
// 計算式 fallback)。
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RubyEntry {
    pub end: i64,
    pub text: String,
    #[serde(rename = "type")]
    pub ruby_type: String, // "mono" | "group"
    pub scale: f64,
    #[serde(rename = "offsetX", default)]
    pub offset_x: Option<f64>,
    #[serde(rename = "offsetY", default)]
    pub offset_y: Option<f64>,
    #[serde(rename = "absX", default)]
    pub abs_x: Option<f64>,
    #[serde(rename = "absY", default)]
    pub abs_y: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LayerEdit {
    #[serde(rename = "layerId")]
    pub layer_id: i64,
    #[serde(default)]
    pub contents: Option<String>,
    #[serde(rename = "fontPostScriptName", default)]
    pub font_post_script_name: Option<String>,
    #[serde(rename = "sizePt", default)]
    pub size_pt: Option<f64>,
    #[serde(default)]
    pub dx: Option<f64>,
    #[serde(default)]
    pub dy: Option<f64>,
    #[serde(default)]
    pub direction: Option<String>,
    #[serde(rename = "strokeColor", default)]
    pub stroke_color: Option<String>,
    #[serde(rename = "strokeWidthPx", default)]
    pub stroke_width_px: Option<f64>,
    #[serde(rename = "fillColor", default)]
    pub fill_color: Option<String>,
    #[serde(default)]
    pub rotation: Option<f64>,
    #[serde(rename = "leadingPct", default)]
    pub leading_pct: Option<f64>,
    #[serde(rename = "lineLeadings", default)]
    pub line_leadings: Option<HashMap<String, f64>>,
    #[serde(rename = "charSizes", default)]
    pub char_sizes: Option<HashMap<String, f64>>,
    #[serde(rename = "charFonts", default)]
    pub char_fonts: Option<HashMap<String, String>>,
    // 【v1.22.0】合成太字（faux bold）。layer 全体の bold flag。
    #[serde(rename = "syntheticBold", default)]
    pub synthetic_bold: Option<bool>,
    // 【v1.22.0】文字ごとの合成太字オーバーライド。{[charIndex]: boolean}。
    #[serde(rename = "charBolds", default)]
    pub char_bolds: Option<HashMap<String, bool>>,
    // 【v1.26.0】文字ごとのルビ。start index をキー、value は {end, text, type, scale}。
    #[serde(rename = "charRubies", default)]
    pub char_rubies: Option<HashMap<String, RubyEntry>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct NewLayer {
    pub x: f64,
    pub y: f64,
    pub contents: String,
    #[serde(rename = "fontPostScriptName", default)]
    pub font_post_script_name: Option<String>,
    #[serde(rename = "sizePt", default)]
    pub size_pt: Option<f64>,
    #[serde(default)]
    pub direction: Option<String>,
    #[serde(rename = "strokeColor", default)]
    pub stroke_color: Option<String>,
    #[serde(rename = "strokeWidthPx", default)]
    pub stroke_width_px: Option<f64>,
    #[serde(rename = "fillColor", default)]
    pub fill_color: Option<String>,
    #[serde(default)]
    pub rotation: Option<f64>,
    #[serde(rename = "leadingPct", default)]
    pub leading_pct: Option<f64>,
    #[serde(rename = "lineLeadings", default)]
    pub line_leadings: Option<HashMap<String, f64>>,
    #[serde(rename = "charSizes", default)]
    pub char_sizes: Option<HashMap<String, f64>>,
    #[serde(rename = "charFonts", default)]
    pub char_fonts: Option<HashMap<String, String>>,
    // 【v1.22.0】合成太字（faux bold）。layer 全体の bold flag。
    #[serde(rename = "syntheticBold", default)]
    pub synthetic_bold: Option<bool>,
    // 【v1.22.0】文字ごとの合成太字オーバーライド。{[charIndex]: boolean}。
    #[serde(rename = "charBolds", default)]
    pub char_bolds: Option<HashMap<String, bool>>,
    // 【v1.26.0】文字ごとのルビ。start index をキー、value は {end, text, type, scale}。
    #[serde(rename = "charRubies", default)]
    pub char_rubies: Option<HashMap<String, RubyEntry>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PsdEdits {
    #[serde(rename = "psdPath")]
    pub psd_path: String,
    #[serde(rename = "pageWidth", default)]
    pub page_width: Option<f64>,
    #[serde(rename = "pageHeight", default)]
    pub page_height: Option<f64>,
    pub layers: Vec<LayerEdit>,
    #[serde(rename = "newLayers", default)]
    pub new_layers: Vec<NewLayer>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct EditPayload {
    pub edits: Vec<PsdEdits>,
    #[serde(rename = "saveMode", default)]
    pub save_mode: Option<String>,
    #[serde(rename = "targetDir", default)]
    pub target_dir: Option<String>,
    // 連続記号のツメ（‰）。0 = OFF、負値（または絶対値）で詰まる。新規レイヤーのみ JSX で適用。
    // dash 系（— ― – ‒ ‐ ‑ ー －）と tilde 系（〜 ～）で別々の値を持てる。
    #[serde(rename = "dashTrackingMille", default)]
    pub dash_tracking_mille: f64,
    #[serde(rename = "tildeTrackingMille", default)]
    pub tilde_tracking_mille: f64,
    // 縦書きの新規レイヤーで半角 !! / !? を「縦中横」(textStyleRange の tcy 属性) に
    // するか。新規レイヤーのみ JSX で適用、既存レイヤーは触らない。
    #[serde(rename = "tateChuYokoEnabled", default)]
    pub tate_chu_yoko_enabled: bool,
    // 【v1.22.0】記号フォント置換（♡♥★☆♪♫♬♩♯♭→←↑↓ など）。新規 + 既存レイヤー両方に
    // JSX 側で適用する。ユーザーが per-char で手動指定したフォントは尊重（自動置換 skip）。
    // false / 空文字 のとき機能 OFF。
    #[serde(rename = "symbolFontReplaceEnabled", default)]
    pub symbol_font_replace_enabled: bool,
    #[serde(rename = "symbolFontPostScriptName", default)]
    pub symbol_font_post_script_name: Option<String>,
    // 【v1.22.0】句読点ツメ（、 U+3001 / 。 U+3002 を Photoshop の tsume 属性で詰める）。
    // 新規 + 既存レイヤー両方に JSX 側で適用する。0 のとき機能 OFF。0-100 の percent 値。
    #[serde(rename = "punctuationTsumePercent", default)]
    pub punctuation_tsume_percent: f64,
    // 【v1.29.x】ルビあり行間（%）。JSX 側 createRubyLayer で「親文字行と前の行のちょうど中間」
    // 配置を計算するために使う。ビューアー (CSS の --ruby-row-leading-pct) と完全に
    // 同じ値で、デフォルト 150。未指定（旧 payload）のとき 150 として扱う。
    #[serde(rename = "rubyLeadingPct", default = "default_ruby_leading_pct")]
    pub ruby_leading_pct: f64,
    // 【v1.29.x】ルビ位置 Photoshop 微調整: 親 fontSize 単位で親側に追加シフト
    #[serde(rename = "rubyPhotoshopOffsetEm", default = "default_ruby_photoshop_offset_em")]
    pub ruby_photoshop_offset_em: f64,
    // 【v1.29.x】ルビ位置 Photoshop 微調整: 親離し方向の固定 PSD px
    #[serde(rename = "rubyPhotoshopBiasPx", default = "default_ruby_photoshop_bias_px")]
    pub ruby_photoshop_bias_px: f64,
}

fn default_ruby_leading_pct() -> f64 { 150.0 }
fn default_ruby_photoshop_offset_em() -> f64 { 0.0 }
fn default_ruby_photoshop_bias_px() -> f64 { 0.0 }

// 【v1.16.0】使用フォントの拡張 — TTC face_index を保持して全 face を個別管理。
#[derive(Debug, Serialize)]
pub struct FontEntry {
    pub name: String,
    #[serde(rename = "postScriptName")]
    pub post_script_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    // TTC / OTC 内の何番目の face か（0-based）。単独 TTF/OTF は 0。
    // JS 側 (font-loader.js) は read_font_face_bytes 呼び出し時にこの値を渡し、
    // Rust が TTC からその face を切り出して標準 TTF として返す。
    #[serde(rename = "faceIndex")]
    pub face_index: u32,
}

#[tauri::command]
async fn apply_edits_via_photoshop(payload: EditPayload) -> Result<String, String> {
    if payload.save_mode.as_deref() == Some("saveAs") {
        if let Some(dir) = payload.target_dir.as_deref() {
            if !dir.is_empty() {
                std::fs::create_dir_all(dir)
                    .map_err(|e| format!("保存先フォルダの作成に失敗: {}: {}", dir, e))?;
            }
        }
    }
    photoshop::apply_edits(&payload).map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_fonts() -> Result<Vec<FontEntry>, String> {
    fonts::list_fonts().map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_binary_file(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| format!("{}: {}", path, e))
}

#[tauri::command]
async fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("{}: {}", path, e))
}

fn script_output_text_dir() -> Result<PathBuf, String> {
    let desktop = dirs::desktop_dir()
        .or_else(|| dirs::home_dir().map(|p| p.join("Desktop")))
        .ok_or_else(|| "Desktop folder was not found".to_string())?;
    Ok(desktop.join("Script_Output").join("COMIPO_text\u{62BD}\u{51FA}"))
}

fn sanitize_txt_filename(name: &str) -> String {
    let mut out: String = name
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                '_'
            } else {
                c
            }
        })
        .collect();
    out = out.trim().trim_matches('.').to_string();
    if out.is_empty() {
        out = "untitled.txt".to_string();
    }
    if !out.to_ascii_lowercase().ends_with(".txt") {
        out.push_str(".txt");
    }
    out
}

#[tauri::command]
async fn save_editor_text_to_script_output(
    content: String,
    default_name: Option<String>,
) -> Result<String, String> {
    let dir = script_output_text_dir()?;
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Script_Output folder create failed ({}): {}", dir.display(), e))?;
    let name = sanitize_txt_filename(default_name.as_deref().unwrap_or("untitled.txt"));
    let path = dir.join(name);
    fs::write(&path, content)
        .map_err(|e| format!("text save failed ({}): {}", path.display(), e))?;
    Ok(path.to_string_lossy().to_string())
}

fn write_progen_handoff(text_path: &Path) -> Result<(), String> {
    if !text_path.is_file() {
        return Err(format!("saved text file was not found: {}", text_path.display()));
    }
    let dir = script_output_text_dir()?;
    fs::create_dir_all(&dir)
        .map_err(|e| format!("handoff folder create failed ({}): {}", dir.display(), e))?;
    let marker = dir.join(".progen_handoff.txt");
    fs::write(&marker, text_path.to_string_lossy().as_bytes())
        .map_err(|e| format!("handoff marker write failed ({}): {}", marker.display(), e))
}

fn find_progen_launcher() -> Option<PathBuf> {
    let desktop = dirs::desktop_dir()
        .or_else(|| dirs::home_dir().map(|p| p.join("Desktop")))?;
    let root = desktop.join("progen_DEMO").join("data");
    let candidates = [
        root.join("dev.bat"),
        root.join("src-tauri").join("target").join("release").join("progen.exe"),
        root.join("src-tauri").join("target").join("debug").join("progen.exe"),
    ];
    candidates.into_iter().find(|p| p.exists())
}

#[tauri::command]
async fn launch_progen_with_text(text_path: String) -> Result<String, String> {
    let text_path = PathBuf::from(text_path);
    write_progen_handoff(&text_path)?;
    let launcher = find_progen_launcher().ok_or_else(|| {
        "ProGen launcher was not found under Desktop\\progen_DEMO\\data".to_string()
    })?;

    if launcher.extension().and_then(|s| s.to_str()).map(|s| s.eq_ignore_ascii_case("bat")).unwrap_or(false) {
        Command::new("cmd")
            .args(["/C", "start", "", &launcher.to_string_lossy()])
            .current_dir(launcher.parent().unwrap_or_else(|| Path::new(".")))
            .spawn()
            .map_err(|e| format!("ProGen dev.bat launch failed: {}", e))?;
    } else {
        Command::new(&launcher)
            .spawn()
            .map_err(|e| format!("ProGen launch failed ({}): {}", launcher.display(), e))?;
    }
    Ok(launcher.to_string_lossy().to_string())
}

// 【v1.16.0】使用フォントの拡張 — TTC face 抽出コマンド（FontFace API は TTC をそのまま渡すと
// 先頭 face しか登録できないため、Rust 側で該当 face を切り出して標準 TTF にして返す）。
// 指定したフォントファイルから face_index で示された 1 つのフォント face を取り出して
// 標準 TTF として返す。
// - 単独 TTF/OTF（"OTTO" / 0x00010000 / "true" など）の場合は元の bytes をそのまま返す
// - TTC/OTC（"ttcf"）の場合は内包する SFNT offset table を解析し、該当 face のテーブルだけ
//   抽出して標準 SFNT 形式で再構築する。これにより JS の FontFace API が認識できる
//
// FontFace API は TTC バイト列を渡すと先頭 face しか登録できず、2 番目以降のフォントが
// CSS で参照できなくなる。日本語環境では游ゴシック M/B/D など多くのフォントが TTC に
// 同居しているため、この変換が無いと「フォント一覧に出るのに UI に反映されない」状態になる。
#[tauri::command]
async fn read_font_face_bytes(path: String, face_index: u32) -> Result<Vec<u8>, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("{}: {}", path, e))?;
    // face_index == 0 は旧挙動と同じく元のファイル bytes をそのまま返す。
    // - 単独 TTF/OTF: 通常通り
    // - TTC の先頭 face: FontFace は TTC bytes を渡されると先頭 face を自動採用するので
    //   ここで TTC をそのまま返しても旧 read_binary_file と等価動作
    // 抽出ロジックは face_index >= 1 のみで動かして、face[0] には絶対影響を与えないようにする。
    if face_index == 0 {
        return Ok(bytes);
    }
    if bytes.len() >= 4 && &bytes[0..4] == b"ttcf" {
        if let Some(extracted) = extract_face_from_ttc(&bytes, face_index) {
            // ttf-parser で構造を検証してから返す。検証失敗時は元 TTC bytes に
            // フォールバックして「先頭 face が登録される」旧挙動に戻す。
            // FontFace.load が完全に失敗するよりは何かしら登録される方がマシ。
            if ttf_parser::Face::parse(&extracted, 0).is_ok() {
                return Ok(extracted);
            }
        }
        // 抽出 / 検証失敗 → 元 TTC bytes を返す（FontFace は先頭 face を読む）
        return Ok(bytes);
    }
    // 単独 TTF/OTF で face_index > 0 → 仕様上不正だが、互換のため元 bytes を返す。
    Ok(bytes)
}

// 【v1.16.0】使用フォントの拡張 — TTC → 単独 TTF 再構築のコア実装。
// TTC ヘッダ → 該当 face の SFNT offset table → 各 table 領域を抽出して
// 単独 TTF を再構築する。table データは TTC 内のオフセット参照なので、
// 新しいファイル先頭からの相対オフセットに書き換える。
// - ディレクトリエントリは tag 昇順にソート（OpenType 仕様）
// - head テーブルの checkSumAdjustment を再計算（厳格パーサ対策）
fn extract_face_from_ttc(ttc: &[u8], face_index: u32) -> Option<Vec<u8>> {
    if ttc.len() < 12 || &ttc[0..4] != b"ttcf" {
        return None;
    }
    let num_fonts = u32::from_be_bytes([ttc[8], ttc[9], ttc[10], ttc[11]]);
    if face_index >= num_fonts {
        return None;
    }
    let off_pos = 12usize.checked_add((face_index as usize).checked_mul(4)?)?;
    if ttc.len() < off_pos + 4 {
        return None;
    }
    let sfnt_off = u32::from_be_bytes([
        ttc[off_pos],
        ttc[off_pos + 1],
        ttc[off_pos + 2],
        ttc[off_pos + 3],
    ]) as usize;
    if ttc.len() < sfnt_off + 12 {
        return None;
    }
    let num_tables = u16::from_be_bytes([ttc[sfnt_off + 4], ttc[sfnt_off + 5]]) as usize;
    let dir_size = num_tables.checked_mul(16)?;
    if ttc.len() < sfnt_off + 12 + dir_size {
        return None;
    }
    // (tag, checksum, offset, length) を読む
    let mut entries: Vec<(u32, u32, u32, u32)> = Vec::with_capacity(num_tables);
    for i in 0..num_tables {
        let p = sfnt_off + 12 + i * 16;
        let tag = u32::from_be_bytes([ttc[p], ttc[p + 1], ttc[p + 2], ttc[p + 3]]);
        let checksum =
            u32::from_be_bytes([ttc[p + 4], ttc[p + 5], ttc[p + 6], ttc[p + 7]]);
        let offset =
            u32::from_be_bytes([ttc[p + 8], ttc[p + 9], ttc[p + 10], ttc[p + 11]]);
        let length =
            u32::from_be_bytes([ttc[p + 12], ttc[p + 13], ttc[p + 14], ttc[p + 15]]);
        entries.push((tag, checksum, offset, length));
    }
    // OpenType spec はディレクトリエントリを tag 昇順でソートすることを要求。
    // 多くの TTC は既にソート済みだが、稀に違反するファイルがあるため明示的にソート。
    // 厳格なフォントパーサ（DirectWrite 等）は順序違反で全体を却下するため重要。
    entries.sort_by_key(|&(tag, _, _, _)| tag);
    let header_size = 12 + dir_size; // sfnt header + table dir
    // 各 table は 4-byte 境界で padding して連結。新しいオフセットを計算。
    let mut new_offsets: Vec<u32> = Vec::with_capacity(num_tables);
    let mut tables_size = 0usize;
    for &(_, _, _, length) in &entries {
        new_offsets.push((header_size + tables_size) as u32);
        tables_size += pad4(length as usize);
    }
    let mut out: Vec<u8> = Vec::with_capacity(header_size + tables_size);
    // sfntVersion は元の SFNT offset table から複製
    out.extend_from_slice(&ttc[sfnt_off..sfnt_off + 4]);
    out.extend_from_slice(&(num_tables as u16).to_be_bytes());
    // searchRange / entrySelector / rangeShift（仕様通り計算）
    let entry_selector = if num_tables == 0 {
        0
    } else {
        (num_tables as f64).log2().floor() as u16
    };
    let search_range = (1u16 << entry_selector) * 16;
    let range_shift = (num_tables as u16).saturating_mul(16).saturating_sub(search_range);
    out.extend_from_slice(&search_range.to_be_bytes());
    out.extend_from_slice(&entry_selector.to_be_bytes());
    out.extend_from_slice(&range_shift.to_be_bytes());
    // table directory（offset を新しい値に差し替え、それ以外は維持）
    for (i, &(tag, checksum, _orig_off, length)) in entries.iter().enumerate() {
        out.extend_from_slice(&tag.to_be_bytes());
        out.extend_from_slice(&checksum.to_be_bytes());
        out.extend_from_slice(&new_offsets[i].to_be_bytes());
        out.extend_from_slice(&length.to_be_bytes());
    }
    // table data（4-byte padding 付き）
    for &(_, _, offset, length) in &entries {
        let off = offset as usize;
        let len = length as usize;
        if ttc.len() < off + len {
            return None;
        }
        out.extend_from_slice(&ttc[off..off + len]);
        let pad = pad4(len) - len;
        for _ in 0..pad {
            out.push(0);
        }
    }

    // head テーブルの checkSumAdjustment を再計算する。
    // SFNT 仕様:
    //   1. head.checkSumAdjustment（head 先頭から +8 の 4 バイト）を 0 にする
    //   2. ファイル全体の 4 バイト境界での u32 の合計を計算（最後の半端は 0 padding）
    //   3. checkSumAdjustment = 0xB1B0_AFBA - sum（u32 wrap）
    //   4. その値を head に書き戻す
    // TTC から face を取り出すと directory 内の offset が変わるため、元ファイルの
    // head.checkSumAdjustment が無効になる。一部のフォント検証が厳しいパーサ（特に
    // Windows DirectWrite 系）はこれを検証して却下するため、必ず再計算する。
    let head_tag: u32 = u32::from_be_bytes(*b"head");
    let mut head_table_off: Option<usize> = None;
    for (i, &(tag, _, _, _)) in entries.iter().enumerate() {
        if tag == head_tag {
            head_table_off = Some(new_offsets[i] as usize);
            break;
        }
    }
    if let Some(head_off) = head_table_off {
        if out.len() >= head_off + 12 {
            // checkSumAdjustment を 0 に
            out[head_off + 8] = 0;
            out[head_off + 9] = 0;
            out[head_off + 10] = 0;
            out[head_off + 11] = 0;
            // ファイル全体の u32 BE sum を計算
            let mut sum: u32 = 0;
            let mut idx = 0usize;
            while idx + 4 <= out.len() {
                let v = u32::from_be_bytes([out[idx], out[idx + 1], out[idx + 2], out[idx + 3]]);
                sum = sum.wrapping_add(v);
                idx += 4;
            }
            // 残りバイト（あれば）を 0 padding して u32 として加算
            if idx < out.len() {
                let mut tail = [0u8; 4];
                let n = out.len() - idx;
                for k in 0..n {
                    tail[k] = out[idx + k];
                }
                let v = u32::from_be_bytes(tail);
                sum = sum.wrapping_add(v);
            }
            let adjustment: u32 = 0xB1B0_AFBA_u32.wrapping_sub(sum);
            let bytes_adj = adjustment.to_be_bytes();
            out[head_off + 8..head_off + 12].copy_from_slice(&bytes_adj);
        }
    }
    Some(out)
}

#[inline]
fn pad4(n: usize) -> usize {
    (n + 3) & !3
}

#[tauri::command]
async fn list_psd_files(folder: String) -> Result<Vec<String>, String> {
    let entries = std::fs::read_dir(&folder).map_err(|e| format!("{}: {}", folder, e))?;
    let mut files: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .map(|e| e.path())
        .filter(|p| {
            p.extension()
                .and_then(|ext| ext.to_str())
                .map(|s| s.eq_ignore_ascii_case("psd"))
                .unwrap_or(false)
        })
        .filter_map(|p| p.to_str().map(|s| s.to_string()))
        .collect();
    files.sort();
    Ok(files)
}

#[derive(serde::Serialize)]
struct DirEntry {
    name: String,
    path: String,
    #[serde(rename = "isDirectory")]
    is_directory: bool,
    #[serde(rename = "isFile")]
    is_file: bool,
}

#[derive(serde::Serialize)]
struct DriveInfo {
    letter: String,
    path: String,
}

// カスタムファイル選択ダイアログのドライブ切替 UI 用。Windows は A:〜Z: のうち存在するルートを
// 列挙し、ネットワーク／クラウドドライブを除外する：
//   - DRIVE_REMOTE（4） … 通常のネットワークドライブ
//   - DRIVE_NO_ROOT_DIR（1） / DRIVE_UNKNOWN（0） … 不明・マウント不能
//   - Google Drive for Desktop / OneDrive / Dropbox 等の仮想クラウドドライブは DRIVE_FIXED で
//     報告されるため、GetVolumeInformationW でボリュームラベルと FS 名を取得して
//     既知のクラウド系名前パターンに該当するものを除外する。
// Unix 系は "/" のみを返す。
#[tauri::command]
async fn list_drives() -> Result<Vec<DriveInfo>, String> {
    #[cfg(target_os = "windows")]
    {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use winapi::um::fileapi::{GetDriveTypeW, GetVolumeInformationW};
        const DRIVE_UNKNOWN: u32 = 0;
        const DRIVE_NO_ROOT_DIR: u32 = 1;
        const DRIVE_REMOTE: u32 = 4;

        fn u16_buf_to_string(buf: &[u16]) -> String {
            let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
            String::from_utf16_lossy(&buf[..len])
        }

        // 既知のクラウドドライブ名（小文字で含有チェック）。Google Drive for Desktop は
        // ボリュームラベルが "Google Drive"、FS 名は "DriveFS" や "Google Drive Filesystem"
        // などになる。OneDrive / Dropbox / Box も同様に label / FS から検知する。
        const CLOUD_PATTERNS: &[&str] = &[
            "google drive",
            "googledrive",
            "drivefs",
            "onedrive",
            "dropbox",
            "box drive",
            "boxdrive",
        ];

        let mut out = Vec::new();
        for c in b'A'..=b'Z' {
            let letter = format!("{}:", c as char);
            let root = format!("{}\\", letter);
            if !std::path::Path::new(&root).exists() {
                continue;
            }
            // GetDriveTypeW は wide string 終端の \0 を要求する。
            let wide: Vec<u16> = OsStr::new(&root)
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            let drive_type = unsafe { GetDriveTypeW(wide.as_ptr()) };
            if drive_type == DRIVE_REMOTE
                || drive_type == DRIVE_UNKNOWN
                || drive_type == DRIVE_NO_ROOT_DIR
            {
                continue;
            }

            // ボリュームラベル / FS 名でクラウドドライブを除外。
            let mut vol_name_buf = [0u16; 261]; // MAX_PATH + 1
            let mut fs_name_buf = [0u16; 261];
            let info_ok = unsafe {
                GetVolumeInformationW(
                    wide.as_ptr(),
                    vol_name_buf.as_mut_ptr(),
                    vol_name_buf.len() as u32,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    fs_name_buf.as_mut_ptr(),
                    fs_name_buf.len() as u32,
                )
            } != 0;
            if info_ok {
                let label = u16_buf_to_string(&vol_name_buf).to_lowercase();
                let fs = u16_buf_to_string(&fs_name_buf).to_lowercase();
                let is_cloud = CLOUD_PATTERNS
                    .iter()
                    .any(|pat| label.contains(pat) || fs.contains(pat));
                if is_cloud {
                    continue;
                }
            }

            out.push(DriveInfo { letter, path: root });
        }
        Ok(out)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(vec![DriveInfo { letter: "/".into(), path: "/".into() }])
    }
}

// ホームディレクトリのパスを返す。カスタムファイル選択ダイアログが remember 値も
// defaultPath も無いときの起点として使用。Windows は USERPROFILE、Unix は HOME を採用。
#[tauri::command]
async fn home_dir() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        std::env::var("USERPROFILE")
            .map_err(|_| "USERPROFILE 環境変数が取得できません".to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("HOME").map_err(|_| "HOME 環境変数が取得できません".to_string())
    }
}

// デスクトップディレクトリのパスを返す。カスタムファイル選択ダイアログの既定起点。
// Windows: %USERPROFILE%\Desktop / Unix: $HOME/Desktop。
// 存在しない場合はエラーで返し、呼び出し側で home_dir フォールバックさせる。
#[tauri::command]
async fn desktop_dir() -> Result<String, String> {
    let home = home_dir().await?;
    let sep = if cfg!(target_os = "windows") { "\\" } else { "/" };
    let path = format!("{}{}Desktop", home, sep);
    if std::path::Path::new(&path).is_dir() {
        Ok(path)
    } else {
        Err(format!("Desktop ディレクトリが存在しません: {}", path))
    }
}

// 校正パネルのカスタムフォルダブラウザ用に、ディレクトリの中身（フォルダ + ファイル）を返す。
// 隠しファイル / シンボリックリンクの type 解決失敗は無視。サブツリー走査はしない（1 階層のみ）。
#[tauri::command]
async fn list_directory_entries(path: String) -> Result<Vec<DirEntry>, String> {
    let entries =
        std::fs::read_dir(&path).map_err(|e| format!("ディレクトリ読み取り失敗 {}: {}", path, e))?;
    let mut out: Vec<DirEntry> = Vec::new();
    for entry in entries.filter_map(|e| e.ok()) {
        let p = entry.path();
        let ft = entry.file_type().ok();
        let is_dir = ft.as_ref().map(|t| t.is_dir()).unwrap_or(false);
        let is_file = ft.as_ref().map(|t| t.is_file()).unwrap_or(false);
        if !is_dir && !is_file {
            continue;
        }
        let name = match p.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        let path_str = match p.to_str() {
            Some(s) => s.to_string(),
            None => continue,
        };
        out.push(DirEntry {
            name,
            path: path_str,
            is_directory: is_dir,
            is_file,
        });
    }
    Ok(out)
}

fn update_splash_progress(app: &tauri::AppHandle, value: u32) {
    if let Some(splash_window) = app.get_webview_window("splash") {
        let _ = splash_window.eval(&format!(
            "if(window.__splashSetProgress)window.__splashSetProgress({});",
            value
        ));
    }
}

fn apply_app_icon(window: &tauri::WebviewWindow) {
    let Ok(img) = image::load_from_memory(include_bytes!("../icons/icon.png")) else {
        return;
    };
    let rgba = img.into_rgba8();
    let (width, height) = rgba.dimensions();
    let icon = tauri::image::Image::new_owned(rgba.into_raw(), width, height);
    let _ = window.set_icon(icon);
}

#[tauri::command]
async fn close_splash(window: tauri::Window) -> Result<(), String> {
    let app = window.app_handle();

    update_splash_progress(&app, 72);
    std::thread::sleep(std::time::Duration::from_millis(180));
    update_splash_progress(&app, 88);
    std::thread::sleep(std::time::Duration::from_millis(160));
    update_splash_progress(&app, 100);
    std::thread::sleep(std::time::Duration::from_millis(420));

    if let Some(main_window) = app.get_webview_window("main") {
        apply_app_icon(&main_window);
        main_window.show().map_err(|e| e.to_string())?;
        let _ = main_window.set_focus();
    }

    if let Some(splash_window) = app.get_webview_window("splash") {
        splash_window.close().map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            if let Some(main_window) = app.get_webview_window("main") {
                apply_app_icon(&main_window);
            }

            let splash_window = tauri::WebviewWindowBuilder::new(
                app,
                "splash",
                tauri::WebviewUrl::App("splash.html".into()),
            )
            .title("PsDesign")
            .inner_size(870.0, 600.0)
            .resizable(false)
            .decorations(false)
            .center()
            .always_on_top(true)
            .skip_taskbar(true)
            .build()?;
            apply_app_icon(&splash_window);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            close_splash,
            apply_edits_via_photoshop,
            list_fonts,
            read_binary_file,
            read_text_file,
            save_editor_text_to_script_output,
            launch_progen_with_text,
            read_font_face_bytes,
            list_psd_files,
            list_directory_entries,
            list_drives,
            home_dir,
            desktop_dir,
            ocr::check_ai_models,
            ocr::install_ai_models,
            ocr::cancel_ai_install,
            ocr::uninstall_ai_models,
            ocr::run_ai_ocr,
            ocr::export_ai_text,
            alignment::compute_alignment,
            tachimi::detect_tachimi_exe,
            tachimi::launch_tachimi_with_files
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
