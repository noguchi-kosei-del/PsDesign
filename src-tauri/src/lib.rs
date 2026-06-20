mod addresses;
mod alignment;
mod crypto;
mod fonts;
mod jsx_gen;
mod kenban;
mod ocr;
mod path_access;
mod photoshop;
mod psd_repair;
mod tachimi;
mod updater_local;

use image::codecs::jpeg::JpegEncoder;
use path_access::{ensure_allowed, ensure_allowed_for_write, AllowedPaths};
use pdfium_render::prelude::*;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::webview::PageLoadEvent;
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

#[cfg(windows)]
fn hide_console_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x08000000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console_window(_cmd: &mut Command) {}

#[derive(Debug, Deserialize)]
struct NativeDialogFilter {
    name: String,
    #[serde(default)]
    extensions: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct NativeFileDialogOptions {
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    multiple: Option<bool>,
    #[serde(default)]
    filters: Vec<NativeDialogFilter>,
    #[serde(rename = "defaultPath", default)]
    default_path: Option<String>,
    #[serde(rename = "defaultName", default)]
    default_name: Option<String>,
}

// 【v1.26.0】ルビ 1 件分のエントリ。state.js の charRubies スキーマと対応。
// 【v1.29.x UI-coord】offset_x / offset_y: ビューアー上のルビ wrap の実描画位置を
// 親レイヤー基準の PSD 座標 (px) で保持。canvas-tools.js scheduleRubyOffsetMeasure が
// renderOverlay 後にビューアー DOM から実測して setCharRubyOffset で書き戻す。
// 値があれば JSX 側 createRubyLayer はこの座標をルビ「中心」として配置するため、
// CSS / JSX の計算式不一致による位置ズレが完全に排除される。Option (未設定なら従来の
// 計算式 fallback)。
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RubyOverlayEntry {
    pub start: i64,
    pub end: i64,
    pub text: String,
    #[serde(rename = "type")]
    pub ruby_type: String,
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
    #[serde(default)]
    pub overlays: Vec<RubyOverlayEntry>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LayerEdit {
    #[serde(rename = "layerId")]
    pub layer_id: i64,
    #[serde(default)]
    pub contents: Option<String>,
    #[serde(default)]
    pub deleted: Option<bool>,
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
    #[serde(rename = "horizontalScale", default)]
    pub horizontal_scale: Option<f64>,
    #[serde(rename = "verticalScale", default)]
    pub vertical_scale: Option<f64>,
    #[serde(rename = "trackingMille", default)]
    pub tracking_mille: Option<f64>,
    #[serde(rename = "kerningMille", default)]
    pub kerning_mille: Option<f64>,
    #[serde(rename = "lineLeadings", default)]
    pub line_leadings: Option<HashMap<String, f64>>,
    #[serde(rename = "charSizes", default)]
    pub char_sizes: Option<HashMap<String, f64>>,
    #[serde(rename = "charFonts", default)]
    pub char_fonts: Option<HashMap<String, String>>,
    #[serde(rename = "charHorizontalScales", default)]
    pub char_horizontal_scales: Option<HashMap<String, f64>>,
    #[serde(rename = "charVerticalScales", default)]
    pub char_vertical_scales: Option<HashMap<String, f64>>,
    #[serde(rename = "charTrackings", default)]
    pub char_trackings: Option<HashMap<String, f64>>,
    #[serde(rename = "charKernings", default)]
    pub char_kernings: Option<HashMap<String, f64>>,
    #[serde(rename = "charTateChuYokos", default)]
    pub char_tate_chu_yokos: Option<HashMap<String, bool>>,
    #[serde(rename = "charFillColors", default)]
    pub char_fill_colors: Option<HashMap<String, String>>,
    // 【v1.22.0】合成太字（faux bold）。layer 全体の bold flag。
    #[serde(rename = "syntheticBold", default)]
    pub synthetic_bold: Option<bool>,
    #[serde(rename = "syntheticItalic", default)]
    pub synthetic_italic: Option<bool>,
    // 【v1.22.0】文字ごとの合成太字オーバーライド。{[charIndex]: boolean}。
    #[serde(rename = "charBolds", default)]
    pub char_bolds: Option<HashMap<String, bool>>,
    #[serde(rename = "charItalics", default)]
    pub char_italics: Option<HashMap<String, bool>>,
    // 【v1.26.0】文字ごとのルビ。start index をキー、value は {end, text, type, scale}。
    #[serde(rename = "charRubies", default)]
    pub char_rubies: Option<HashMap<String, RubyEntry>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
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
    #[serde(rename = "horizontalScale", default)]
    pub horizontal_scale: Option<f64>,
    #[serde(rename = "verticalScale", default)]
    pub vertical_scale: Option<f64>,
    #[serde(rename = "trackingMille", default)]
    pub tracking_mille: Option<f64>,
    #[serde(rename = "kerningMille", default)]
    pub kerning_mille: Option<f64>,
    #[serde(rename = "lineLeadings", default)]
    pub line_leadings: Option<HashMap<String, f64>>,
    #[serde(rename = "charSizes", default)]
    pub char_sizes: Option<HashMap<String, f64>>,
    #[serde(rename = "charFonts", default)]
    pub char_fonts: Option<HashMap<String, String>>,
    #[serde(rename = "charHorizontalScales", default)]
    pub char_horizontal_scales: Option<HashMap<String, f64>>,
    #[serde(rename = "charVerticalScales", default)]
    pub char_vertical_scales: Option<HashMap<String, f64>>,
    #[serde(rename = "charTrackings", default)]
    pub char_trackings: Option<HashMap<String, f64>>,
    #[serde(rename = "charKernings", default)]
    pub char_kernings: Option<HashMap<String, f64>>,
    #[serde(rename = "charTateChuYokos", default)]
    pub char_tate_chu_yokos: Option<HashMap<String, bool>>,
    #[serde(rename = "charFillColors", default)]
    pub char_fill_colors: Option<HashMap<String, String>>,
    // 【v1.22.0】合成太字（faux bold）。layer 全体の bold flag。
    #[serde(rename = "syntheticBold", default)]
    pub synthetic_bold: Option<bool>,
    #[serde(rename = "syntheticItalic", default)]
    pub synthetic_italic: Option<bool>,
    // 【v1.22.0】文字ごとの合成太字オーバーライド。{[charIndex]: boolean}。
    #[serde(rename = "charBolds", default)]
    pub char_bolds: Option<HashMap<String, bool>>,
    #[serde(rename = "charItalics", default)]
    pub char_italics: Option<HashMap<String, bool>>,
    // 【v1.26.0】文字ごとのルビ。start index をキー、value は {end, text, type, scale}。
    #[serde(rename = "charRubies", default)]
    pub char_rubies: Option<HashMap<String, RubyEntry>>,
    // 【写植再利用】元テキストレイヤーの bbox 中心（PSD px）。指定があれば保存時に
    // 「作り直したテキストの実 bounds 中心」をこの座標へ合わせる（元の位置を厳密再現）。
    #[serde(rename = "reuseSrcCx", default)]
    pub reuse_src_cx: Option<f64>,
    #[serde(rename = "reuseSrcCy", default)]
    pub reuse_src_cy: Option<f64>,
    // 【UI実測アンカー】保存直前に算出した「現在の UI グリフ中心」(PSD px)。指定があれば
    // 保存時に Photoshop 実描画 bbox 中心をこの座標へ合わせる（UI の位置をそのまま再現）。
    // reuseSrcCx/Cy より優先。ユーザーが UI 上で動かした位置を保存へ反映するために使う。
    #[serde(rename = "uiAnchorCx", default)]
    pub ui_anchor_cx: Option<f64>,
    #[serde(rename = "uiAnchorCy", default)]
    pub ui_anchor_cy: Option<f64>,
    // 【リサイクル・基準位置の直接再現】抽出時に Photoshop から読んだ元レイヤーの
    // textItem.position（テキスト原点 / 基準ベースライン, PSD px）。未ドラッグのリサイクル
    // レイヤーは保存時にこの位置をそのまま設定し、bounds 中心合わせ（太字で bounds が
    // 落ち着かず下にぶれる問題の原因）を回避して元位置を厳密再現する。
    #[serde(rename = "reuseSrcPosX", default)]
    pub reuse_src_pos_x: Option<f64>,
    #[serde(rename = "reuseSrcPosY", default)]
    pub reuse_src_pos_y: Option<f64>,
    // 元レイヤーの実 bounds 右端（PSD px）。縦書きのアンカー辺合わせに使う（x=元 left, y=元 top）。
    #[serde(rename = "reuseSrcRight", default)]
    pub reuse_src_right: Option<f64>,
    // 元レイヤーの実 bounds 上端（PSD px）。top のアンカー辺合わせに使う（reuseSrcRight と対称）。
    #[serde(rename = "reuseSrcTop", default)]
    pub reuse_src_top: Option<f64>,
    // 元レイヤーの実 bounds 左端（PSD px）。横書きの左上アンカー辺合わせに使う。
    #[serde(rename = "reuseSrcLeft", default)]
    pub reuse_src_left: Option<f64>,
    // 【リンク群/フォルダ グループ再現】同 key の新規レイヤーを text サブグループへまとめる。
    #[serde(rename = "groupKey", default)]
    pub group_key: Option<String>,
    // グループに当てる境界線色（"white"|"black"|"none"）と太さ（PSD px）。
    #[serde(rename = "groupStrokeColor", default)]
    pub group_stroke_color: Option<String>,
    #[serde(rename = "groupStrokeWidth", default)]
    pub group_stroke_width: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PsdEdits {
    #[serde(rename = "psdPath")]
    pub psd_path: String,
    #[serde(rename = "savePath", default)]
    pub save_path: Option<String>,
    #[serde(rename = "pageWidth", default)]
    pub page_width: Option<f64>,
    #[serde(rename = "pageHeight", default)]
    pub page_height: Option<f64>,
    pub layers: Vec<LayerEdit>,
    #[serde(rename = "newLayers", default)]
    pub new_layers: Vec<NewLayer>,
    // 写植再利用モード: 保存時に非表示化する元テキストレイヤーの id 群。
    // 抽出テキストは newLayers として新規作成されるため、元レイヤーは hidden にして
    // 二重表示を防ぐ。通常モードでは空配列。
    #[serde(rename = "hideLayerIds", default)]
    pub hide_layer_ids: Vec<i64>,
    // 写植再利用: この PSD で「元からあるテキストレイヤー」を全て非表示にするか。
    // 旧来は EditPayload 全体フラグ (reuseHideOriginalText / appMode 駆動) だったが、
    // 通常 PSD のテキストを誤って隠さないよう per-PSD プロパティへ移した。リサイクル
    // 読込した PSD だけ true（reuseInfo 駆動）。通常モードの PSD は false で隠さない。
    #[serde(rename = "hideOriginalText", default)]
    pub hide_original_text: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
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
    // ルビレイヤーの既定フォント。未指定なら従来どおり親文字フォントを使う。
    #[serde(rename = "rubyFontPostScriptName", default)]
    pub ruby_font_post_script_name: Option<String>,
    // 【v1.29.x】ルビ位置 Photoshop 微調整: 親 fontSize 単位で親側に追加シフト
    #[serde(
        rename = "rubyPhotoshopOffsetEm",
        default = "default_ruby_photoshop_offset_em"
    )]
    pub ruby_photoshop_offset_em: f64,
    // 【v1.29.x】ルビ位置 Photoshop 微調整: 親離し方向の固定 PSD px
    #[serde(
        rename = "rubyPhotoshopBiasPx",
        default = "default_ruby_photoshop_bias_px"
    )]
    pub ruby_photoshop_bias_px: f64,
    // 【写植再利用】元テキスト非表示は EditPayload 全体フラグを廃止し、
    // PsdEdits.hide_original_text（per-PSD）へ移行した（通常 PSD 誤爆防止）。
}

fn default_ruby_leading_pct() -> f64 {
    150.0
}
fn default_ruby_photoshop_offset_em() -> f64 {
    0.0
}
fn default_ruby_photoshop_bias_px() -> f64 {
    0.0
}

// 【v1.16.0】使用フォントの拡張 — TTC face_index を保持して全 face を個別管理。
#[derive(Debug, Serialize)]
pub struct FontEntry {
    pub name: String,
    #[serde(rename = "postScriptName")]
    pub post_script_name: String,
    pub aliases: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    // TTC / OTC 内の何番目の face か（0-based）。単独 TTF/OTF は 0。
    // JS 側 (font-loader.js) は read_font_face_bytes 呼び出し時にこの値を渡し、
    // Rust が TTC からその face を切り出して標準 TTF として返す。
    #[serde(rename = "faceIndex")]
    pub face_index: u32,
}

#[tauri::command]
async fn apply_edits_via_photoshop(
    app: tauri::AppHandle,
    allowed: tauri::State<'_, AllowedPaths>,
    payload: EditPayload,
) -> Result<String, String> {
    // 編集対象 PSD は、ユーザーが選択 / D&D / 起動引数で登録した既許可パスに限定する。
    for edit in &payload.edits {
        ensure_allowed(&allowed, &edit.psd_path)?;
    }
    if payload.save_mode.as_deref() == Some("saveAs") {
        if let Some(dir) = payload.target_dir.as_deref() {
            if !dir.is_empty() {
                // 保存先は親が許可済み（業務フォルダ配下）であることを確認してから作成する。
                ensure_allowed_for_write(&allowed, dir)?;
                std::fs::create_dir_all(dir)
                    .map_err(|e| format!("保存先フォルダの作成に失敗: {}: {}", dir, e))?;
                // 作成後の実フォルダを許可リストへ登録（配下の PSD 書き出しを許可）。
                let _ = allowed.register_real(dir);
            }
        }
    }
    photoshop::apply_edits(&payload, &app).map_err(|e| e.to_string())
}

// 【写植再利用】Photoshop で PSD のテキストレイヤーを列挙し、テキスト非表示の合成画像
// (JPG) を書き出す。戻り値は JSX が生成した JSON 文字列（{docWidth,docHeight,dpi,
// bgImage,textLayers:[...]}）。フロント側で parse して再利用フローに使う。
#[tauri::command]
async fn read_psd_text_layers(
    app: tauri::AppHandle,
    allowed: tauri::State<'_, AllowedPaths>,
    psd_path: String,
) -> Result<String, String> {
    ensure_allowed(&allowed, &psd_path)?;
    photoshop::read_text_layers(&psd_path, &app, &allowed).map_err(|e| e.to_string())
}

// 【写植再利用・一括】複数 PSD を 1 回の Photoshop セッションで読み取る。戻り値は
// {"pages":[{ok,psdPath,docWidth,docHeight,dpi,refImage,bgImage,textLayers},...]} の JSON。
#[tauri::command]
async fn read_psd_text_layer_metadata(
    app: tauri::AppHandle,
    allowed: tauri::State<'_, AllowedPaths>,
    psd_path: String,
) -> Result<String, String> {
    ensure_allowed(&allowed, &psd_path)?;
    photoshop::read_text_layer_metadata(&psd_path, &app).map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_psd_text_layers_batch(
    app: tauri::AppHandle,
    allowed: tauri::State<'_, AllowedPaths>,
    psd_paths: Vec<String>,
) -> Result<String, String> {
    for p in &psd_paths {
        ensure_allowed(&allowed, p)?;
    }
    photoshop::read_text_layers_batch(&psd_paths, &app, &allowed).map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_fonts(
    allowed: tauri::State<'_, AllowedPaths>,
) -> Result<Vec<FontEntry>, String> {
    let list = fonts::list_fonts().map_err(|e| e.to_string())?;
    // Rust 側で列挙したフォント実体（信頼できる入口）を許可リストへ登録し、
    // 後続の read_font_face_bytes が ensure_allowed を通過できるようにする。
    for f in &list {
        if let Some(p) = &f.path {
            let _ = allowed.register_real(p);
        }
    }
    Ok(list)
}

// 戻り値を Vec<u8> にすると Tauri が serde_json でシリアライズし、
// 「数値配列の JSON 文字列」になってメインプロセス/レンダラのメモリを爆発させる
// （200MB の PSD で約 1GB の文字列 + 2億超要素の JS 配列 → STATUS_BREAKPOINT で
// WebView がクラッシュ）。tauri::ipc::Response で生バイトを返すと JSON を経由せず
// ArrayBuffer としてフロントへ渡るため、メモリ消費を実ファイルサイズ相当まで抑えられる。
// フロント側は各所で new Uint8Array(bytes) して受けており、ArrayBuffer でも透過的に動く。
#[tauri::command]
async fn read_binary_file(
    allowed: tauri::State<'_, AllowedPaths>,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let real = ensure_allowed(&allowed, &path)?;
    let bytes = std::fs::read(&real).map_err(|e| format!("{}: {}", path, e))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
async fn rename_psd_file(
    allowed: tauri::State<'_, AllowedPaths>,
    path: String,
    #[allow(non_snake_case)] newName: String,
) -> Result<String, String> {
    let real = ensure_allowed(&allowed, &path)?;
    if !real.is_file() {
        return Err(format!("not a file: {}", path));
    }
    let old_ext = real
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if old_ext != "psd" {
        return Err("only PSD files can be renamed".to_string());
    }

    let new_name = newName.trim();
    if new_name.is_empty()
        || new_name.chars().any(|c| {
            c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
        })
        || new_name.ends_with('.')
        || new_name.ends_with(' ')
    {
        return Err("invalid file name".to_string());
    }
    let new_path = Path::new(new_name);
    if new_path.file_name().and_then(|s| s.to_str()) != Some(new_name) {
        return Err("file name must not include a folder".to_string());
    }
    let new_ext = new_path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if new_ext != "psd" {
        return Err("new file name must end with .psd".to_string());
    }

    let parent = real
        .parent()
        .ok_or_else(|| "file has no parent folder".to_string())?;
    let target = parent.join(new_name);
    if target == real {
        return Ok(real.to_string_lossy().to_string());
    }
    if target.exists() {
        return Err(format!("target already exists: {}", target.display()));
    }

    fs::rename(&real, &target)
        .map_err(|e| format!("rename failed ({} -> {}): {}", real.display(), target.display(), e))?;
    let _ = allowed.register_path(&target);
    if let Some(parent) = target.parent() {
        let _ = allowed.register_path(parent);
    }
    Ok(target.to_string_lossy().to_string())
}

/// 見本画像 (JPEG / PNG) に埋め込まれた解像度 (dpi) を読む。取得できなければ None。
/// JPEG: JFIF APP0 の density、PNG: pHYs チャンク。位置調整 mode1 で見本とPSDの解像度を
/// 揃える (k = psd.dpi / 見本dpi) ために使う。
#[tauri::command]
async fn read_reference_dpi(
    allowed: tauri::State<'_, AllowedPaths>,
    path: String,
) -> Result<Option<f64>, String> {
    let real = ensure_allowed(&allowed, &path)?;
    let mut file = File::open(&real).map_err(|e| format!("{}: {}", path, e))?;
    let mut buf = vec![0u8; 65536];
    let n = file
        .read(&mut buf)
        .map_err(|e| format!("{}: {}", path, e))?;
    Ok(parse_image_dpi(&buf[..n]))
}

fn parse_image_dpi(buf: &[u8]) -> Option<f64> {
    // PNG: シグネチャ + pHYs チャンク (ppuX, ppuY, unit)。unit=1(meter) のとき dpi = ppu * 0.0254。
    if buf.len() >= 8 && buf[0..8] == [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] {
        let mut i = 8usize;
        while i + 8 <= buf.len() {
            let len = u32::from_be_bytes([buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]) as usize;
            let ctype = &buf[i + 4..i + 8];
            let data_start = i + 8;
            if ctype == b"pHYs" && data_start + 9 <= buf.len() {
                let ppux = u32::from_be_bytes([
                    buf[data_start],
                    buf[data_start + 1],
                    buf[data_start + 2],
                    buf[data_start + 3],
                ]);
                let unit = buf[data_start + 8];
                if unit == 1 && ppux > 0 {
                    return Some(ppux as f64 * 0.0254);
                }
                return None;
            }
            if ctype == b"IDAT" {
                break; // pHYs は IDAT より前にあるはず
            }
            i = data_start + len + 4; // data + crc(4)
        }
        return None;
    }
    // JPEG: SOI + APP0(JFIF) の density / APP1(EXIF) の XResolution。
    // Photoshop 書き出しは JFIF 無しで EXIF にだけ dpi を持つことがある (実例: XRes=350)。
    // JFIF を優先し、無ければ EXIF を使う。
    if buf.len() >= 2 && buf[0] == 0xFF && buf[1] == 0xD8 {
        let mut i = 2usize;
        let mut jfif: Option<f64> = None;
        let mut exif: Option<f64> = None;
        while i + 4 <= buf.len() {
            if buf[i] != 0xFF {
                break;
            }
            let marker = buf[i + 1];
            if marker == 0xD9 || marker == 0xDA {
                break; // EOI / SOS (画像データ開始)
            }
            let seg_len = u16::from_be_bytes([buf[i + 2], buf[i + 3]]) as usize;
            let seg_start = i + 4;
            let seg_end = (i + 2 + seg_len).min(buf.len());
            if marker == 0xE0
                && seg_start + 12 <= buf.len()
                && &buf[seg_start..seg_start + 5] == b"JFIF\0"
            {
                let units = buf[seg_start + 7];
                let xden = u16::from_be_bytes([buf[seg_start + 8], buf[seg_start + 9]]);
                if xden > 0 {
                    if units == 1 {
                        jfif = Some(xden as f64);
                    } else if units == 2 {
                        jfif = Some(xden as f64 * 2.54);
                    }
                }
            } else if marker == 0xE1
                && seg_start + 6 <= buf.len()
                && seg_start + 6 <= seg_end
                && &buf[seg_start..seg_start + 6] == b"Exif\0\0"
            {
                // seg_start+6 <= seg_end を確認してから slice (壊れた短いセグメントでの panic 回避)。
                exif = parse_exif_dpi(&buf[seg_start + 6..seg_end]);
            }
            if jfif.is_some() {
                return jfif;
            }
            i = i + 2 + seg_len;
        }
        return jfif.or(exif);
    }
    None
}

/// EXIF (TIFF) から XResolution + ResolutionUnit を読んで dpi を返す。
/// buf は "Exif\0\0" の直後 (= TIFF ヘッダ先頭) を指す。
fn parse_exif_dpi(buf: &[u8]) -> Option<f64> {
    if buf.len() < 8 {
        return None;
    }
    let le = &buf[0..2] == b"II";
    let be = &buf[0..2] == b"MM";
    if !le && !be {
        return None;
    }
    let r16 = |o: usize| -> Option<u16> {
        if o + 2 > buf.len() {
            return None;
        }
        Some(if le {
            u16::from_le_bytes([buf[o], buf[o + 1]])
        } else {
            u16::from_be_bytes([buf[o], buf[o + 1]])
        })
    };
    let r32 = |o: usize| -> Option<u32> {
        if o + 4 > buf.len() {
            return None;
        }
        Some(if le {
            u32::from_le_bytes([buf[o], buf[o + 1], buf[o + 2], buf[o + 3]])
        } else {
            u32::from_be_bytes([buf[o], buf[o + 1], buf[o + 2], buf[o + 3]])
        })
    };
    let ifd0 = r32(4)? as usize;
    let n = r16(ifd0)? as usize;
    let mut xres: Option<f64> = None;
    let mut unit: u16 = 2; // 既定 inch
    for e in 0..n {
        let eo = ifd0 + 2 + e * 12;
        if eo + 12 > buf.len() {
            break;
        }
        let tagid = r16(eo)?;
        let typ = r16(eo + 2)?;
        if tagid == 0x011A && typ == 5 {
            // XResolution (RATIONAL): 値は 8 バイトなので offset 参照
            let off = r32(eo + 8)? as usize;
            let num = r32(off)?;
            let den = r32(off + 4)?;
            if den != 0 {
                xres = Some(num as f64 / den as f64);
            }
        } else if tagid == 0x0128 && typ == 3 {
            // ResolutionUnit (SHORT): 値フィールド先頭に左詰め格納
            unit = r16(eo + 8)?;
        }
    }
    let x = xres?;
    if !(x.is_finite() && x > 0.0) {
        return None;
    }
    match unit {
        3 => Some(x * 2.54), // per cm → per inch
        _ => Some(x),        // 2 = inch (不明時も inch とみなす)
    }
}

#[tauri::command]
async fn is_unsupported_bitmap_psd(
    allowed: tauri::State<'_, AllowedPaths>,
    path: String,
) -> Result<bool, String> {
    let real = ensure_allowed(&allowed, &path)?;
    let mut file = File::open(&real).map_err(|e| format!("{}: {}", path, e))?;
    let mut header = [0u8; 26];
    let read = file
        .read(&mut header)
        .map_err(|e| format!("{}: {}", path, e))?;
    if read < header.len() || &header[0..4] != b"8BPS" {
        return Ok(false);
    }
    let depth = u16::from_be_bytes([header[22], header[23]]);
    let color_mode = u16::from_be_bytes([header[24], header[25]]);
    Ok(color_mode == 0 || (color_mode == 1 && depth == 1))
}

#[tauri::command]
async fn read_text_file(
    allowed: tauri::State<'_, AllowedPaths>,
    path: String,
) -> Result<String, String> {
    let real = ensure_allowed(&allowed, &path)?;
    if let Some(parent) = real.parent() {
        let _ = allowed.register_path(parent);
    }
    std::fs::read_to_string(&real).map_err(|e| format!("{}: {}", path, e))
}

fn is_windows_shortcut(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("lnk"))
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn resolve_windows_shortcut_target(path: &Path) -> Option<PathBuf> {
    use std::os::windows::process::CommandExt;

    if !is_windows_shortcut(path) {
        return None;
    }

    let script = r#"
$ErrorActionPreference = 'Stop'
$shortcutPath = $env:OPUS_SHORTCUT_PATH
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$target = [string]$shortcut.TargetPath
if ($target.Length -gt 0) {
  [Console]::Write([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($target)))
}
"#;
    let mut command = Command::new("powershell.exe");
    let output = command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .env("OPUS_SHORTCUT_PATH", path)
        .creation_flags(0x08000000)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    let encoded = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if encoded.is_empty() {
        return None;
    }
    let bytes = STANDARD.decode(encoded).ok()?;
    let mut u16s = Vec::with_capacity(bytes.len() / 2);
    for chunk in bytes.chunks_exact(2) {
        u16s.push(u16::from_le_bytes([chunk[0], chunk[1]]));
    }
    let target = String::from_utf16(&u16s).ok()?;
    let target = target.trim();
    if target.is_empty() {
        return None;
    }
    Some(PathBuf::from(target))
}

#[cfg(not(target_os = "windows"))]
fn resolve_windows_shortcut_target(_path: &Path) -> Option<PathBuf> {
    None
}

fn resolve_shortcut_path(path: &Path) -> PathBuf {
    resolve_windows_shortcut_target(path)
        .filter(|target| target.exists())
        .unwrap_or_else(|| path.to_path_buf())
}

fn unique_sidecar_path(path: &Path, tag: &str) -> PathBuf {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("file");
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    for attempt in 0..1000 {
        let candidate = parent.join(format!(
            ".{}.{}.{}.{}",
            file_name,
            tag,
            std::process::id(),
            stamp + attempt
        ));
        if !candidate.exists() {
            return candidate;
        }
    }
    parent.join(format!(
        ".{}.{}.{}.fallback",
        file_name,
        tag,
        std::process::id()
    ))
}

fn write_file_safely(path: &Path, data: &[u8], kind: &str) -> Result<(), String> {
    if path.is_dir() {
        return Err(format!("{} write target is a folder ({})", kind, path.display()));
    }
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("folder create failed ({}): {}", parent.display(), e))?;
        }
    }

    let temp = unique_sidecar_path(path, "tmp");
    let write_result = (|| -> Result<(), String> {
        let mut file = File::create(&temp)
            .map_err(|e| format!("{} temp create failed ({}): {}", kind, temp.display(), e))?;
        file.write_all(data)
            .map_err(|e| format!("{} temp write failed ({}): {}", kind, temp.display(), e))?;
        file.sync_all()
            .map_err(|e| format!("{} temp sync failed ({}): {}", kind, temp.display(), e))?;
        Ok(())
    })();
    if let Err(err) = write_result {
        let _ = fs::remove_file(&temp);
        return Err(err);
    }

    if cfg!(windows) && path.exists() {
        let backup = unique_sidecar_path(path, "bak");
        fs::rename(path, &backup).map_err(|e| {
            let _ = fs::remove_file(&temp);
            format!(
                "{} backup rename failed ({} -> {}): {}",
                kind,
                path.display(),
                backup.display(),
                e
            )
        })?;
        match fs::rename(&temp, path) {
            Ok(()) => {
                let _ = fs::remove_file(&backup);
                Ok(())
            }
            Err(e) => {
                let _ = fs::rename(&backup, path);
                let _ = fs::remove_file(&temp);
                Err(format!(
                    "{} replace failed ({}): {}",
                    kind,
                    path.display(),
                    e
                ))
            }
        }
    } else {
        fs::rename(&temp, path).map_err(|e| {
            let _ = fs::remove_file(&temp);
            format!("{} replace failed ({}): {}", kind, path.display(), e)
        })
    }
}

#[tauri::command]
async fn write_text_file(
    allowed: tauri::State<'_, AllowedPaths>,
    path: String,
    content: String,
) -> Result<(), String> {
    let path_buf = ensure_allowed_for_write(&allowed, &path)?;
    write_file_safely(&path_buf, content.as_bytes(), "text")
}

// 任意のバイナリデータをディスクへ書き出す。写植再利用モードで、見本（元テキスト入りの
// 合成画像）を JPG にエンコードしてプロジェクトフォルダへ保存するために使う。
// フロント側は canvas.toBlob("image/jpeg") → ArrayBuffer → number[] で渡す。
#[tauri::command]
async fn write_binary_file(
    allowed: tauri::State<'_, AllowedPaths>,
    path: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let path_buf = ensure_allowed_for_write(&allowed, &path)?;
    write_file_safely(&path_buf, &data, "binary")
}

#[tauri::command]
async fn copy_file(
    allowed: tauri::State<'_, AllowedPaths>,
    source: String,
    dest: String,
) -> Result<u64, String> {
    let source_path = ensure_allowed(&allowed, &source)?;
    let dest_path = ensure_allowed_for_write(&allowed, &dest)?;
    if let Some(parent) = dest_path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("folder create failed ({}): {}", parent.display(), e))?;
        }
    }
    fs::copy(&source_path, &dest_path).map_err(|e| {
        format!(
            "file copy failed ({} -> {}): {}",
            source_path.display(),
            dest_path.display(),
            e
        )
    })
}

fn sanitize_project_dir_name(name: &str) -> String {
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
        "OPUS_Project".to_string()
    } else {
        out
    }
}

fn opus_project_root_dir() -> Result<PathBuf, String> {
    let desktop = dirs::desktop_dir()
        .or_else(|| dirs::home_dir().map(|p| p.join("Desktop")))
        .ok_or_else(|| "Desktop folder was not found".to_string())?;
    let root = desktop.join("Script_Output").join("OPUSプロジェクト");
    fs::create_dir_all(&root).map_err(|e| {
        format!(
            "Script_Output folder create failed ({}): {}",
            root.display(),
            e
        )
    })?;
    Ok(root)
}

#[tauri::command]
async fn opus_project_root_path() -> Result<String, String> {
    Ok(opus_project_root_dir()?.to_string_lossy().to_string())
}

#[tauri::command]
async fn create_opus_project_dir(name: String) -> Result<String, String> {
    let root = opus_project_root_dir()?;
    let candidate = root.join(sanitize_project_dir_name(&name));
    fs::create_dir_all(&candidate).map_err(|e| {
        format!(
            "project folder create failed ({}): {}",
            candidate.display(),
            e
        )
    })?;
    Ok(candidate.to_string_lossy().to_string())
}

#[tauri::command]
async fn script_output_dir() -> Result<String, String> {
    let desktop = dirs::desktop_dir()
        .or_else(|| dirs::home_dir().map(|p| p.join("Desktop")))
        .ok_or_else(|| "Desktop folder was not found".to_string())?;
    let dir = desktop.join("Script_Output");
    fs::create_dir_all(&dir).map_err(|e| {
        format!(
            "Script_Output folder create failed ({}): {}",
            dir.display(),
            e
        )
    })?;
    Ok(dir.to_string_lossy().to_string())
}

fn script_output_text_dir() -> Result<PathBuf, String> {
    let desktop = dirs::desktop_dir()
        .or_else(|| dirs::home_dir().map(|p| p.join("Desktop")))
        .ok_or_else(|| "Desktop folder was not found".to_string())?;
    Ok(desktop
        .join("Script_Output")
        .join("OPUSテキスト"))
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

fn is_editor_page_marker_line(line: &str) -> bool {
    let s = line.trim();
    if !s.starts_with("<<") || !s.ends_with(">>") || s.len() < 8 {
        return false;
    }
    let inner = s[2..s.len() - 2].trim();
    let Some(number) = inner.strip_suffix("Page") else {
        return false;
    };
    let number = number.trim();
    !number.is_empty()
        && number
            .chars()
            .all(|c| c.is_ascii_digit() || ('０'..='９').contains(&c))
}

fn ensure_blank_line_after_page_markers(content: &str) -> String {
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    let mut out = String::with_capacity(normalized.len());
    let mut lines = normalized.split('\n').peekable();

    while let Some(line) = lines.next() {
        out.push_str(line);
        if lines.peek().is_some() {
            out.push('\n');
        }
        if is_editor_page_marker_line(line) {
            if let Some(next_line) = lines.peek() {
                if !next_line.trim().is_empty() {
                    out.push('\n');
                }
            }
        }
    }

    out
}

#[tauri::command]
async fn save_editor_text_to_script_output(
    content: String,
    default_name: Option<String>,
) -> Result<String, String> {
    let dir = script_output_text_dir()?;
    fs::create_dir_all(&dir).map_err(|e| {
        format!(
            "OPUSテキスト folder create failed ({}): {}",
            dir.display(),
            e
        )
    })?;
    let name = sanitize_txt_filename(default_name.as_deref().unwrap_or("untitled.txt"));
    let path = dir.join(name);
    let content = ensure_blank_line_after_page_markers(&content);
    write_file_safely(&path, content.as_bytes(), "text save")?;
    Ok(path.to_string_lossy().to_string())
}

fn write_progen_handoff(text_path: &Path) -> Result<(), String> {
    if !text_path.is_file() {
        return Err(format!(
            "saved text file was not found: {}",
            text_path.display()
        ));
    }
    let dir = script_output_text_dir()?;
    fs::create_dir_all(&dir)
        .map_err(|e| format!("handoff folder create failed ({}): {}", dir.display(), e))?;
    let marker = dir.join(".progen_handoff.txt");
    fs::write(&marker, text_path.to_string_lossy().as_bytes())
        .map_err(|e| format!("handoff marker write failed ({}): {}", marker.display(), e))?;

    // Keep the legacy marker as a plain path. Newer ProGen builds can use these
    // sidecars to open at home and load the saved text after genre/label selection.
    let mode_marker = dir.join(".progen_handoff_mode.txt");
    fs::write(&mode_marker, b"home").map_err(|e| {
        format!(
            "handoff mode marker write failed ({}): {}",
            mode_marker.display(),
            e
        )
    })?;

    let payload_marker = dir.join(".progen_handoff.json");
    let payload = serde_json::json!({
        "textPath": text_path.to_string_lossy(),
        "mode": "home",
        "source": "opus",
        "loadTiming": "afterGenreLabelSelection",
        "deferTextLoadUntil": "genreLabelSelected",
    });
    let payload_bytes = serde_json::to_vec_pretty(&payload)
        .map_err(|e| format!("handoff payload encode failed: {}", e))?;
    fs::write(&payload_marker, payload_bytes).map_err(|e| {
        format!(
            "handoff payload write failed ({}): {}",
            payload_marker.display(),
            e
        )
    })?;

    Ok(())
}

fn find_progen_launcher() -> Option<PathBuf> {
    let desktop = dirs::desktop_dir().or_else(|| dirs::home_dir().map(|p| p.join("Desktop")))?;
    let home = dirs::home_dir();
    let demo_root = desktop.join("progen_DEMO");
    let native_checkout_root = desktop.join("ネイティブデータ").join("progen");
    let mut candidates = Vec::new();

    candidates.push(desktop.join("ProGen.lnk"));
    if let Some(home) = home {
        candidates.push(
            home.join("AppData")
                .join("Local")
                .join("ProGen")
                .join("progen.exe"),
        );
    }
    candidates.push(
        native_checkout_root
            .join("src-tauri")
            .join("target")
            .join("release")
            .join("progen.exe"),
    );

    let checkout_roots = [
        // Current ProGen checkout layout.
        demo_root.join("progen"),
        // Older layout kept for compatibility with existing local setups.
        demo_root.join("data"),
    ];
    for root in checkout_roots {
        candidates.push(
            root.join("src-tauri")
                .join("target")
                .join("release")
                .join("progen.exe"),
        );
    }
    candidates.into_iter().find(|p| p.exists())
}

#[tauri::command]
async fn launch_progen_with_text(
    allowed: tauri::State<'_, AllowedPaths>,
    text_path: String,
) -> Result<String, String> {
    // 連携で渡すテキストは Script_Output 配下の保存済みファイル（既許可）に限定する。
    ensure_allowed(&allowed, &text_path)?;
    let text_path = PathBuf::from(text_path);
    write_progen_handoff(&text_path)?;
    let launcher = find_progen_launcher().ok_or_else(|| {
        "ProGen launcher was not found under Desktop\\ProGen.lnk, AppData\\Local\\ProGen, Desktop\\ネイティブデータ\\progen, Desktop\\progen_DEMO\\progen, or Desktop\\progen_DEMO\\data".to_string()
    })?;
    let text_path_arg = text_path.to_string_lossy().to_string();
    let launch_args = [
        "--handoff-mode",
        "home",
        "--text-path",
        text_path_arg.as_str(),
    ];

    let launcher_ext = launcher
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let batch_launch =
        launcher_ext.eq_ignore_ascii_case("bat") || launcher_ext.eq_ignore_ascii_case("cmd");
    let shortcut_launch = launcher_ext.eq_ignore_ascii_case("lnk");
    if batch_launch {
        let mut command = Command::new("cmd");
        command
            .arg("/C")
            .arg(&launcher)
            .args(launch_args)
            .current_dir(launcher.parent().unwrap_or_else(|| Path::new(".")));
        hide_console_window(&mut command);
        command.spawn().map_err(|e| {
            format!(
                "ProGen launcher start failed ({}): {}",
                launcher.display(),
                e
            )
        })?;
    } else if shortcut_launch {
        let mut command = Command::new("cmd");
        command
            .args(["/C", "start", "", &launcher.to_string_lossy()])
            .args(launch_args)
            .current_dir(launcher.parent().unwrap_or_else(|| Path::new(".")));
        hide_console_window(&mut command);
        command.spawn().map_err(|e| {
            format!(
                "ProGen launcher start failed ({}): {}",
                launcher.display(),
                e
            )
        })?;
    } else {
        let mut command = Command::new(&launcher);
        command.args(launch_args);
        hide_console_window(&mut command);
        command
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
async fn read_font_face_bytes(
    allowed: tauri::State<'_, AllowedPaths>,
    path: String,
    face_index: u32,
) -> Result<Vec<u8>, String> {
    let real = ensure_allowed(&allowed, &path)?;
    let path = real.to_string_lossy().to_string();
    let bytes = std::fs::read(&path).map_err(|e| format!("{}: {}", path, e))?;
    // Extract every TTC/OTC face, including face 0, into standalone SFNT bytes.
    // Some WebView2 builds fail to load older Japanese TTC files through FontFace.
    if bytes.len() >= 4 && &bytes[0..4] == b"ttcf" {
        if let Some(extracted) = extract_face_from_ttc(&bytes, face_index) {
            let extracted = match repair_sfnt_for_webview(extracted.clone()) {
                Some(repaired) => repaired,
                None => extracted,
            };
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
    Ok(repair_sfnt_for_webview(bytes.clone()).unwrap_or(bytes))
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
        let checksum = u32::from_be_bytes([ttc[p + 4], ttc[p + 5], ttc[p + 6], ttc[p + 7]]);
        let offset = u32::from_be_bytes([ttc[p + 8], ttc[p + 9], ttc[p + 10], ttc[p + 11]]);
        let length = u32::from_be_bytes([ttc[p + 12], ttc[p + 13], ttc[p + 14], ttc[p + 15]]);
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
    let range_shift = (num_tables as u16)
        .saturating_mul(16)
        .saturating_sub(search_range);
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
        out.resize(out.len() + pad, 0);
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
                tail[..n].copy_from_slice(&out[idx..idx + n]);
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

fn repair_sfnt_for_webview(mut sfnt: Vec<u8>) -> Option<Vec<u8>> {
    if sfnt.len() < 12 || &sfnt[0..4] == b"ttcf" {
        return None;
    }
    let num_tables = u16::from_be_bytes([sfnt[4], sfnt[5]]) as usize;
    let dir_size = num_tables.checked_mul(16)?;
    if sfnt.len() < 12 + dir_size {
        return None;
    }

    let mut tables: Vec<(u32, u32, u32)> = Vec::with_capacity(num_tables);
    for i in 0..num_tables {
        let p = 12 + i * 16;
        let tag = u32::from_be_bytes([sfnt[p], sfnt[p + 1], sfnt[p + 2], sfnt[p + 3]]);
        let offset = u32::from_be_bytes([sfnt[p + 8], sfnt[p + 9], sfnt[p + 10], sfnt[p + 11]]);
        let length = u32::from_be_bytes([sfnt[p + 12], sfnt[p + 13], sfnt[p + 14], sfnt[p + 15]]);
        let end = (offset as usize).checked_add(length as usize)?;
        if end > sfnt.len() {
            return None;
        }
        tables.push((tag, offset, length));
    }

    let cmap_tag = u32::from_be_bytes(*b"cmap");
    let mut changed = false;
    for &(tag, offset, length) in &tables {
        if tag == cmap_tag {
            changed |= repair_cmap_format4_search_params(&mut sfnt, offset as usize, length as usize);
        }
    }
    if !changed {
        return None;
    }

    rewrite_sfnt_checksums(&mut sfnt, &tables)?;
    Some(sfnt)
}

fn repair_cmap_format4_search_params(sfnt: &mut [u8], cmap_off: usize, cmap_len: usize) -> bool {
    let cmap_end = match cmap_off.checked_add(cmap_len) {
        Some(end) if end <= sfnt.len() => end,
        _ => return false,
    };
    if cmap_len < 4 {
        return false;
    }
    let num_records = u16::from_be_bytes([sfnt[cmap_off + 2], sfnt[cmap_off + 3]]) as usize;
    let records_end = match cmap_off.checked_add(4 + num_records.saturating_mul(8)) {
        Some(end) if end <= cmap_end => end,
        _ => return false,
    };

    let mut changed = false;
    for i in 0..num_records {
        let rec = cmap_off + 4 + i * 8;
        if rec + 8 > records_end {
            break;
        }
        let sub_rel = u32::from_be_bytes([sfnt[rec + 4], sfnt[rec + 5], sfnt[rec + 6], sfnt[rec + 7]]) as usize;
        let sub = match cmap_off.checked_add(sub_rel) {
            Some(v) if v + 14 <= cmap_end => v,
            _ => continue,
        };
        let format = u16::from_be_bytes([sfnt[sub], sfnt[sub + 1]]);
        if format != 4 {
            continue;
        }
        let length = u16::from_be_bytes([sfnt[sub + 2], sfnt[sub + 3]]) as usize;
        if sub.checked_add(length).map_or(true, |end| end > cmap_end) || length < 14 {
            continue;
        }
        let seg_count_x2 = u16::from_be_bytes([sfnt[sub + 6], sfnt[sub + 7]]);
        if seg_count_x2 == 0 || seg_count_x2 % 2 != 0 {
            continue;
        }
        let seg_count = seg_count_x2 / 2;
        let entry_selector = floor_log2_u16(seg_count);
        let search_range = (1u16 << (entry_selector as u32)).saturating_mul(2);
        let range_shift = seg_count_x2.saturating_sub(search_range);
        changed |= write_u16_if_changed(sfnt, sub + 8, search_range);
        changed |= write_u16_if_changed(sfnt, sub + 10, entry_selector);
        changed |= write_u16_if_changed(sfnt, sub + 12, range_shift);
    }
    changed
}

fn rewrite_sfnt_checksums(sfnt: &mut [u8], tables: &[(u32, u32, u32)]) -> Option<()> {
    let head_tag = u32::from_be_bytes(*b"head");
    let mut head_off = None;
    for (i, &(tag, offset, length)) in tables.iter().enumerate() {
        if tag == head_tag {
            let off = offset as usize;
            if length < 12 || off + 12 > sfnt.len() {
                return None;
            }
            head_off = Some(off);
        }
        let checksum = table_checksum(sfnt, offset as usize, length as usize)?;
        let dir_checksum_pos = 12 + i * 16 + 4;
        if dir_checksum_pos + 4 > sfnt.len() {
            return None;
        }
        sfnt[dir_checksum_pos..dir_checksum_pos + 4].copy_from_slice(&checksum.to_be_bytes());
    }

    let head_off = head_off?;
    sfnt[head_off + 8..head_off + 12].copy_from_slice(&0u32.to_be_bytes());
    for (i, &(_tag, offset, length)) in tables.iter().enumerate() {
        let checksum = table_checksum(sfnt, offset as usize, length as usize)?;
        let dir_checksum_pos = 12 + i * 16 + 4;
        sfnt[dir_checksum_pos..dir_checksum_pos + 4].copy_from_slice(&checksum.to_be_bytes());
    }

    let file_sum = checksum_bytes(sfnt);
    let adjustment = 0xB1B0_AFBA_u32.wrapping_sub(file_sum);
    sfnt[head_off + 8..head_off + 12].copy_from_slice(&adjustment.to_be_bytes());
    Some(())
}

fn table_checksum(sfnt: &[u8], offset: usize, length: usize) -> Option<u32> {
    let end = offset.checked_add(length)?;
    if end > sfnt.len() {
        return None;
    }
    Some(checksum_padded_bytes(&sfnt[offset..end]))
}

fn checksum_bytes(bytes: &[u8]) -> u32 {
    checksum_padded_bytes(bytes)
}

fn checksum_padded_bytes(bytes: &[u8]) -> u32 {
    let mut sum: u32 = 0;
    let mut idx = 0usize;
    while idx + 4 <= bytes.len() {
        let v = u32::from_be_bytes([bytes[idx], bytes[idx + 1], bytes[idx + 2], bytes[idx + 3]]);
        sum = sum.wrapping_add(v);
        idx += 4;
    }
    if idx < bytes.len() {
        let mut tail = [0u8; 4];
        tail[..bytes.len() - idx].copy_from_slice(&bytes[idx..]);
        sum = sum.wrapping_add(u32::from_be_bytes(tail));
    }
    sum
}

fn floor_log2_u16(v: u16) -> u16 {
    15 - v.leading_zeros() as u16
}

fn write_u16_if_changed(bytes: &mut [u8], offset: usize, value: u16) -> bool {
    if offset + 2 > bytes.len() {
        return false;
    }
    let new_bytes = value.to_be_bytes();
    if bytes[offset..offset + 2] == new_bytes {
        return false;
    }
    bytes[offset..offset + 2].copy_from_slice(&new_bytes);
    true
}

#[inline]
fn pad4(n: usize) -> usize {
    (n + 3) & !3
}

#[tauri::command]
async fn list_psd_files(
    allowed: tauri::State<'_, AllowedPaths>,
    folder: String,
) -> Result<Vec<String>, String> {
    let folder_path = resolve_shortcut_path(Path::new(&folder));
    ensure_allowed(&allowed, &folder_path.to_string_lossy())?;
    let entries =
        std::fs::read_dir(&folder_path).map_err(|e| format!("{}: {}", folder_path.display(), e))?;
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
struct PathInfo {
    name: String,
    path: String,
    #[serde(rename = "isDirectory")]
    is_directory: bool,
    #[serde(rename = "isFile")]
    is_file: bool,
    #[serde(rename = "sizeBytes")]
    size_bytes: u64,
    #[serde(rename = "modifiedMs")]
    modified_ms: Option<u64>,
}

#[derive(serde::Serialize)]
struct CompressedReferencePdf {
    #[serde(rename = "sourcePath")]
    source_path: String,
    #[serde(rename = "outputPaths")]
    output_paths: Vec<String>,
    #[serde(rename = "originalSizeBytes")]
    original_size_bytes: u64,
    #[serde(rename = "compressedSizeBytes")]
    compressed_size_bytes: u64,
}

#[derive(serde::Serialize, Clone)]
struct ReferencePdfCompressProgress {
    #[serde(rename = "jobId")]
    job_id: String,
    current: usize,
    total: usize,
    percent: u32,
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
        Ok(vec![DriveInfo {
            letter: "/".into(),
            path: "/".into(),
        }])
    }
}

// ホームディレクトリのパスを返す。カスタムファイル選択ダイアログが remember 値も
// defaultPath も無いときの起点として使用。Windows は USERPROFILE、Unix は HOME を採用。
#[tauri::command]
async fn home_dir() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        std::env::var("USERPROFILE").map_err(|_| "USERPROFILE 環境変数が取得できません".to_string())
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
    let sep = if cfg!(target_os = "windows") {
        "\\"
    } else {
        "/"
    };
    let path = format!("{}{}Desktop", home, sep);
    if std::path::Path::new(&path).is_dir() {
        Ok(path)
    } else {
        Err(format!("Desktop ディレクトリが存在しません: {}", path))
    }
}

/// フロントへ業務フォルダの実パスを渡す（固有アドレスはソース直書きせず外部参照 enc から実行時解決）。
/// 公開してよい業務フォルダのキーのみ許可（秘匿キー＝updater/pubkey/org 等は返さない）。
/// 未解決（G:未接続・未シール等）は空文字を返す＝従来の「G:未接続」と同じ安全側挙動。
#[tauri::command]
fn get_business_address(key: String) -> String {
    match key.as_str() {
        "content.jsonFolder"
        | "content.textLogBase"
        | "content.textLogFolder"
        | "content.ocrRoot"
        | "content.pdfReadRoot" => addresses::addr(&key),
        _ => String::new(),
    }
}

fn dialog_file_path_to_string(path: tauri_plugin_dialog::FilePath) -> Result<String, String> {
    path.into_path()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

fn register_native_dialog_path(allowed: &AllowedPaths, mode: &str, path: &str) {
    match mode {
        "save" => {
            if let Some(parent) = Path::new(path).parent() {
                let _ = allowed.register_path(parent);
            }
        }
        "openFolder" => {
            let _ = allowed.register_real(path);
        }
        _ => {
            let p = Path::new(path);
            let _ = allowed.register_path(p);
            if let Some(parent) = p.parent() {
                let _ = allowed.register_path(parent);
            }
        }
    }
}

fn register_open_file_with_parent(allowed: &AllowedPaths, path: &Path) {
    let _ = allowed.register_path(path);
    if path.is_file() {
        if let Some(parent) = path.parent() {
            let _ = allowed.register_path(parent);
        }
    }
}

#[tauri::command]
async fn native_file_dialog(
    app: tauri::AppHandle,
    allowed: tauri::State<'_, AllowedPaths>,
    options: NativeFileDialogOptions,
) -> Result<Option<Vec<String>>, String> {
    let NativeFileDialogOptions {
        mode,
        title,
        multiple,
        filters,
        default_path,
        default_name,
    } = options;
    let mode = mode.unwrap_or_else(|| "open".to_string());
    let multiple = multiple.unwrap_or(false);
    let mut dialog = app.dialog().file();

    if let Some(title) = title.as_deref().filter(|s| !s.trim().is_empty()) {
        dialog = dialog.set_title(title);
    }
    if let Some(default_path) = default_path.as_deref().filter(|s| !s.trim().is_empty()) {
        let path = PathBuf::from(default_path);
        let dir = if path.is_file() {
            path.parent().map(Path::to_path_buf)
        } else {
            Some(path)
        };
        if let Some(dir) = dir {
            dialog = dialog.set_directory(dir);
        }
    }
    if let Some(default_name) = default_name.as_deref().filter(|s| !s.trim().is_empty()) {
        dialog = dialog.set_file_name(default_name);
    }
    for filter in filters {
        if filter.extensions.is_empty() {
            continue;
        }
        let exts: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
        dialog = dialog.add_filter(filter.name, &exts);
    }

    let picked = match mode.as_str() {
        "save" => dialog.blocking_save_file().map(|path| vec![path]),
        "openFolder" => dialog.blocking_pick_folder().map(|path| vec![path]),
        _ if multiple => dialog.blocking_pick_files(),
        _ => dialog.blocking_pick_file().map(|path| vec![path]),
    };

    let Some(paths) = picked else {
        return Ok(None);
    };

    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        let path_string = dialog_file_path_to_string(path)?;
        register_native_dialog_path(&allowed, &mode, &path_string);
        out.push(path_string);
    }
    Ok(Some(out))
}

// Photoshop のスクラッチディスク容量を取得する。
// Photoshop は起動時にスクラッチディスク (デフォルト = システムドライブ、通常 C:)
// の空き容量が一定値を下回るとモーダル警告を出して停止する。OPUS 側で事前に
// 空き容量をユーザーに知らせるための情報源。
//
// 戻り値: { path, free_bytes, total_bytes, low (free < 100GB) }
// `low` は最も浅い段階 (< 100 GB) の即時判定用。フロント側 (bind/save.js
// ensurePhotoshopScratchOk) では `free_bytes` を直接見て 5 段階 (< 100/50/20/10/5 GB) に
// 分類してメッセージを変えるため、`low` は実質的に使われない。後方互換のため残す。
// Windows: %SystemDrive%（通常 "C:"）の root に対して GetDiskFreeSpaceExW で取得。
// Unix: 対象 OS は Windows なので「未サポート」を返す。
#[derive(Debug, Serialize)]
struct DriveFreeSpace {
    path: String,
    free_bytes: u64,
    total_bytes: u64,
    low: bool,
}

const PHOTOSHOP_SCRATCH_LOW_THRESHOLD_BYTES: u64 = 100u64 * 1024 * 1024 * 1024; // 100 GB

#[derive(Debug, Serialize)]
struct SystemMemoryStatus {
    total_physical_bytes: u64,
    available_physical_bytes: u64,
    memory_load_percent: u32,
    low: bool,
    reason: String,
    threshold_available_bytes: u64,
    threshold_total_bytes: u64,
    threshold_memory_load_percent: u32,
}

const LOW_MEMORY_AVAILABLE_THRESHOLD_BYTES: u64 = 4u64 * 1024 * 1024 * 1024; // 4 GiB
const LOW_MEMORY_TOTAL_THRESHOLD_BYTES: u64 = 8u64 * 1024 * 1024 * 1024; // 8 GiB
const HIGH_MEMORY_LOAD_THRESHOLD_PERCENT: u32 = 85;

#[tauri::command]
async fn get_system_memory_status() -> Result<SystemMemoryStatus, String> {
    #[cfg(target_os = "windows")]
    {
        use std::mem;
        use winapi::um::sysinfoapi::{GlobalMemoryStatusEx, MEMORYSTATUSEX};

        let mut status: MEMORYSTATUSEX = unsafe { mem::zeroed() };
        status.dwLength = mem::size_of::<MEMORYSTATUSEX>() as u32;
        let ok = unsafe { GlobalMemoryStatusEx(&mut status) };
        if ok == 0 {
            return Err("GlobalMemoryStatusEx failed".to_string());
        }

        let total = status.ullTotalPhys as u64;
        let available = status.ullAvailPhys as u64;
        let load = status.dwMemoryLoad as u32;
        let low_available = available < LOW_MEMORY_AVAILABLE_THRESHOLD_BYTES;
        let low_total = total > 0 && total <= LOW_MEMORY_TOTAL_THRESHOLD_BYTES;
        let high_load = load >= HIGH_MEMORY_LOAD_THRESHOLD_PERCENT;
        let low = low_available || low_total || high_load;
        let reason = if low_available {
            "available".to_string()
        } else if low_total {
            "total".to_string()
        } else if high_load {
            "load".to_string()
        } else {
            "normal".to_string()
        };

        Ok(SystemMemoryStatus {
            total_physical_bytes: total,
            available_physical_bytes: available,
            memory_load_percent: load,
            low,
            reason,
            threshold_available_bytes: LOW_MEMORY_AVAILABLE_THRESHOLD_BYTES,
            threshold_total_bytes: LOW_MEMORY_TOTAL_THRESHOLD_BYTES,
            threshold_memory_load_percent: HIGH_MEMORY_LOAD_THRESHOLD_PERCENT,
        })
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(SystemMemoryStatus {
            total_physical_bytes: 0,
            available_physical_bytes: 0,
            memory_load_percent: 0,
            low: false,
            reason: "unsupported".to_string(),
            threshold_available_bytes: LOW_MEMORY_AVAILABLE_THRESHOLD_BYTES,
            threshold_total_bytes: LOW_MEMORY_TOTAL_THRESHOLD_BYTES,
            threshold_memory_load_percent: HIGH_MEMORY_LOAD_THRESHOLD_PERCENT,
        })
    }
}

#[tauri::command]
async fn get_photoshop_scratch_free_space() -> Result<DriveFreeSpace, String> {
    #[cfg(target_os = "windows")]
    {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use winapi::um::fileapi::GetDiskFreeSpaceExW;

        // システムドライブを取得（環境変数 SystemDrive、通常 "C:"）。
        // 末尾に "\\" を付けて root path として渡す。
        let system_drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".to_string());
        let root = format!("{}\\", system_drive);

        let wide: Vec<u16> = OsStr::new(&root)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        // ULARGE_INTEGER は winapi で u64 と互換のため、直接 u64 を渡せる。
        let mut free_for_caller: u64 = 0;
        let mut total: u64 = 0;
        let mut total_free: u64 = 0;
        let ok = unsafe {
            GetDiskFreeSpaceExW(
                wide.as_ptr(),
                &mut free_for_caller as *mut u64 as *mut _,
                &mut total as *mut u64 as *mut _,
                &mut total_free as *mut u64 as *mut _,
            )
        };
        if ok == 0 {
            return Err(format!(
                "GetDiskFreeSpaceExW failed for system drive: {}",
                root
            ));
        }
        Ok(DriveFreeSpace {
            path: root,
            free_bytes: free_for_caller,
            total_bytes: total,
            low: free_for_caller < PHOTOSHOP_SCRATCH_LOW_THRESHOLD_BYTES,
        })
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("get_photoshop_scratch_free_space is only supported on Windows".to_string())
    }
}

// 校正パネルのカスタムフォルダブラウザ用に、ディレクトリの中身（フォルダ + ファイル）を返す。
// 隠しファイル / シンボリックリンクの type 解決失敗は無視。サブツリー走査はしない（1 階層のみ）。
#[tauri::command]
async fn list_directory_entries(
    allowed: tauri::State<'_, AllowedPaths>,
    path: String,
) -> Result<Vec<DirEntry>, String> {
    let dir_path = resolve_shortcut_path(Path::new(&path));
    ensure_allowed(&allowed, &dir_path.to_string_lossy())?;
    let entries = std::fs::read_dir(&dir_path)
        .map_err(|e| format!("ディレクトリ読み取り失敗 {}: {}", dir_path.display(), e))?;
    let mut out: Vec<DirEntry> = Vec::new();
    for entry in entries.filter_map(|e| e.ok()) {
        let p = entry.path();
        // Desktop often contains many .lnk files. Resolving every child shortcut here
        // spawns a shell process per entry and can flash many windows, so listing keeps
        // child entries as-is. Explicit path navigation still resolves shortcuts above.
        let meta = std::fs::metadata(&p).ok();
        let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let is_file = meta.as_ref().map(|m| m.is_file()).unwrap_or(false);
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

#[tauri::command]
async fn open_folder_in_explorer(path: String) -> Result<(), String> {
    let folder = PathBuf::from(&path);
    if !folder.exists() {
        return Err(format!("フォルダが見つかりません: {}", path));
    }
    if !folder.is_dir() {
        return Err(format!("フォルダではありません: {}", path));
    }

    #[cfg(target_os = "windows")]
    {
        let native_path = path.replace('/', "\\");
        Command::new("explorer.exe")
            .arg(native_path)
            .spawn()
            .map_err(|e| format!("Explorer を起動できませんでした: {}", e))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&folder)
            .spawn()
            .map_err(|e| format!("Finder を起動できませんでした: {}", e))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(&folder)
            .spawn()
            .map_err(|e| format!("フォルダを開けませんでした: {}", e))?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err("この環境ではフォルダを開けません".to_string())
}

#[tauri::command]
async fn startup_args(allowed: tauri::State<'_, AllowedPaths>) -> Result<Vec<String>, String> {
    let args = normalize_launch_args(std::env::args().skip(1));
    // OS がアプリへ渡した起動引数（ファイル関連付け / ショートカット）は信頼できる入口。
    // 実体として存在するパスのみ許可リストへ登録する。
    for a in &args {
        let _ = allowed.register_real(a);
    }
    Ok(args)
}

fn normalize_launch_args<I>(args: I) -> Vec<String>
where
    I: IntoIterator<Item = String>,
{
    args.into_iter()
        .map(|arg| {
            let path = PathBuf::from(&arg);
            let resolved = resolve_shortcut_path(&path);
            if resolved != path {
                resolved.to_string_lossy().to_string()
            } else {
                arg
            }
        })
        .collect()
}

#[tauri::command]
async fn path_info(
    allowed: tauri::State<'_, AllowedPaths>,
    path: String,
) -> Result<PathInfo, String> {
    let input_path = PathBuf::from(&path);
    let p = resolve_shortcut_path(&input_path);
    // 未登録パスは存在有無 / サイズを返さない（File System Oracle 防止）。
    ensure_allowed(&allowed, &p.to_string_lossy())?;
    let meta = std::fs::metadata(&p)
        .map_err(|e| format!("パスを確認できません: {}: {}", p.display(), e))?;
    let name = p
        .file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| path.clone());
    Ok(PathInfo {
        name,
        path: p.to_string_lossy().to_string(),
        is_directory: meta.is_dir(),
        is_file: meta.is_file(),
        size_bytes: meta.len(),
        modified_ms: meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64),
    })
}

const REFERENCE_PDF_COMPRESS_MAX_EDGE: i32 = 2400;
const REFERENCE_PDF_COMPRESS_JPEG_QUALITY: u8 = 78;

fn safe_file_stem_for_temp(path: &Path) -> String {
    let raw = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("reference_pdf");
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    let trimmed = out.trim_matches('_');
    if trimmed.is_empty() {
        "reference_pdf".to_string()
    } else {
        trimmed.chars().take(48).collect()
    }
}

#[tauri::command]
async fn compress_reference_pdf(
    app: tauri::AppHandle,
    allowed: tauri::State<'_, AllowedPaths>,
    path: String,
    job_id: Option<String>,
) -> Result<CompressedReferencePdf, String> {
    let pdf_path = ensure_allowed(&allowed, &path)?;
    let original_size_bytes = fs::metadata(&pdf_path)
        .map_err(|e| format!("PDF metadata failed ({}): {}", pdf_path.display(), e))?
        .len();

    let pdfium = ocr::make_pdfium(&app)?;
    let doc = pdfium
        .load_pdf_from_file(&pdf_path, None)
        .map_err(|e| format!("PDF read failed ({}): {:?}", pdf_path.display(), e))?;
    let page_count = doc.pages().len();
    if page_count == 0 {
        return Err("PDF has no pages".to_string());
    }
    let job_id = job_id.unwrap_or_else(|| "reference-pdf-compress".to_string());
    let emit_progress = |current: usize| {
        let percent = if page_count == 0 {
            0
        } else {
            ((current as f64 / page_count as f64) * 100.0).round() as u32
        }
        .min(100);
        let _ = app.emit(
            "reference_pdf_compress:progress",
            ReferencePdfCompressProgress {
                job_id: job_id.clone(),
                current,
                total: page_count as usize,
                percent,
            },
        );
    };
    emit_progress(0);

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let temp_dir = std::env::temp_dir().join(format!(
        "psdesign-reference-pdf-{}-{}",
        ts,
        safe_file_stem_for_temp(&pdf_path)
    ));
    fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("temp folder create failed ({}): {}", temp_dir.display(), e))?;

    let pad = page_count.to_string().len().max(3);
    let render_config = PdfRenderConfig::new()
        .set_target_width(REFERENCE_PDF_COMPRESS_MAX_EDGE)
        .set_maximum_height(REFERENCE_PDF_COMPRESS_MAX_EDGE)
        .use_print_quality(false)
        .set_image_smoothing(false)
        .render_form_data(false);

    let mut output_paths = Vec::with_capacity(page_count as usize);
    let mut compressed_size_bytes = 0u64;
    for (i, page) in doc.pages().iter().enumerate() {
        let bitmap = page
            .render_with_config(&render_config)
            .map_err(|e| format!("PDF page render failed (page={}): {:?}", i + 1, e))?;
        let rgb = bitmap.as_image().to_rgb8();
        let dest = temp_dir.join(format!("page_{:0width$}.jpg", i + 1, width = pad));
        let file = File::create(&dest)
            .map_err(|e| format!("JPG create failed ({}): {}", dest.display(), e))?;
        let mut encoder = JpegEncoder::new_with_quality(file, REFERENCE_PDF_COMPRESS_JPEG_QUALITY);
        encoder
            .encode_image(&rgb)
            .map_err(|e| format!("JPG encode failed ({}): {}", dest.display(), e))?;

        let size = fs::metadata(&dest)
            .map(|m| m.len())
            .unwrap_or(0);
        compressed_size_bytes = compressed_size_bytes.saturating_add(size);
        let dest_string = dest.to_string_lossy().to_string();
        let _ = allowed.register_real(&dest_string);
        output_paths.push(dest_string);
        emit_progress(i + 1);
    }

    Ok(CompressedReferencePdf {
        source_path: pdf_path.to_string_lossy().to_string(),
        output_paths,
        original_size_bytes,
        compressed_size_bytes,
    })
}

fn update_splash_progress(app: &tauri::AppHandle, value: u32) {
    if let Some(splash_window) = app.get_webview_window("splash") {
        let _ = splash_window.eval(format!(
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

    update_splash_progress(app, 72);
    std::thread::sleep(std::time::Duration::from_millis(180));
    update_splash_progress(app, 88);
    std::thread::sleep(std::time::Duration::from_millis(160));
    update_splash_progress(app, 100);
    std::thread::sleep(std::time::Duration::from_millis(1450));

    if let Some(main_window) = app.get_webview_window("main") {
        apply_app_icon(&main_window);
        // visible:false で生成したメインウィンドウが、起動方法や WebView2 / Windows の
        // 状態によっては「最小化」状態で現れることがある（show() だけだと最小化のまま
        // 画面に出ず、ユーザーには「スプラッシュしか見えない / 何も出ない」状態になる）。
        // unminimize → show → set_focus を順に呼んで、確実に通常表示・前面化する。
        let _ = main_window.unminimize();
        main_window.show().map_err(|e| e.to_string())?;
        let _ = main_window.unminimize();
        let _ = main_window.set_focus();
    }

    if let Some(splash_window) = app.get_webview_window("splash") {
        splash_window.close().map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // セッション中の許可リスト。起動時に固定業務フォルダ / フォントディレクトリをシードする。
    let allowed_paths = AllowedPaths::default();
    path_access::seed_allowed(&allowed_paths);

    tauri::Builder::default()
        .manage(allowed_paths)
        .manage(path_access::PickerState::default())
        // 実 Drag & Drop（OS → メインプロセス）で受領したパスを許可リストへ登録する。
        // renderer 経由の任意パス登録 API は作らず、ここ（信頼できる入口）で登録する。
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                let allowed = window.state::<AllowedPaths>();
                for p in paths {
                    register_open_file_with_parent(&allowed, p);
                }
            }
        })
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let args = normalize_launch_args(args);
            {
                let allowed = app.state::<AllowedPaths>();
                for a in &args {
                    register_open_file_with_parent(&allowed, Path::new(a));
                }
            }
            if let Some(main_window) = app.get_webview_window("main") {
                let _ = main_window.unminimize();
                let _ = main_window.show();
                let _ = main_window.set_focus();
                let _ = main_window.emit("second-instance-args", args);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // 常時バックグラウンド監視は保存中の Photoshop に割り込むリスクがあるため、
            // start_background_dialog_watcher は現在 no-op。Photoshop 起動直後に必要な
            // スクラッチ警告処理は、読み取り系コマンドの短時間 watcher に限定する。
            photoshop::start_background_dialog_watcher();

            if let Some(main_window) = app.get_webview_window("main") {
                apply_app_icon(&main_window);
            }

            let splash_window = tauri::WebviewWindowBuilder::new(
                app,
                "splash",
                tauri::WebviewUrl::App("splash.html".into()),
            )
            .title("OPUS")
            .inner_size(871.0, 546.0)
            .background_color(tauri::webview::Color(0x02, 0x03, 0x0a, 255))
            .visible(false)
            .resizable(false)
            .decorations(false)
            .center()
            .always_on_top(true)
            .skip_taskbar(true)
            .on_page_load(|window, payload| {
                if payload.event() == PageLoadEvent::Finished {
                    let _ = window.show();
                    let _ = window.eval(
                        "requestAnimationFrame(()=>requestAnimationFrame(()=>document.querySelector('.splash')?.classList.add('is-ready')));",
                    );
                }
            })
            .build()?;
            apply_app_icon(&splash_window);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            close_splash,
            apply_edits_via_photoshop,
            read_psd_text_layers,
            read_psd_text_layer_metadata,
            read_psd_text_layers_batch,
            list_fonts,
            read_binary_file,
            rename_psd_file,
            read_reference_dpi,
            is_unsupported_bitmap_psd,
            read_text_file,
            write_text_file,
            write_binary_file,
            copy_file,
            compress_reference_pdf,
            opus_project_root_path,
            create_opus_project_dir,
            script_output_dir,
            save_editor_text_to_script_output,
            launch_progen_with_text,
            read_font_face_bytes,
            list_psd_files,
            list_directory_entries,
            path_access::open_picker,
            path_access::close_picker,
            path_access::picker_roots,
            path_access::browse_directory_entries,
            path_access::browse_path_info,
            path_access::confirm_file_picker_selection,
            path_access::confirm_file_picker_save_path,
            native_file_dialog,
            open_folder_in_explorer,
            startup_args,
            path_info,
            list_drives,
            home_dir,
            desktop_dir,
            get_business_address,
            get_system_memory_status,
            get_photoshop_scratch_free_space,
            ocr::check_ai_models,
            ocr::install_ai_models,
            ocr::cancel_ai_install,
            ocr::uninstall_ai_models,
            ocr::run_ai_ocr,
            ocr::export_ai_text,
            ocr::analyze_image_text_regions,
            alignment::compute_alignment,
            kenban::detect_kenban_exe,
            kenban::launch_kenban_psd_pdf,
            tachimi::detect_tachimi_exe,
            tachimi::launch_tachimi_with_files,
            updater_local::check_local_update,
            updater_local::apply_local_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
