mod alignment;
mod fonts;
mod jsx_gen;
mod kenban;
mod ocr;
mod photoshop;
mod tachimi;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::webview::PageLoadEvent;
use tauri::Manager;

#[cfg(windows)]
fn hide_console_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x08000000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console_window(_cmd: &mut Command) {}

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
    // 写植再利用モード: 保存時に非表示化する元テキストレイヤーの id 群。
    // 抽出テキストは newLayers として新規作成されるため、元レイヤーは hidden にして
    // 二重表示を防ぐ。通常モードでは空配列。
    #[serde(rename = "hideLayerIds", default)]
    pub hide_layer_ids: Vec<i64>,
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
    // 【写植再利用】true のとき、保存時に各 PSD の「元からあるテキストレイヤー」を全て
    // 非表示にする（抽出テキストは newLayers として新規作成済み）。
    #[serde(rename = "reuseHideOriginalText", default)]
    pub reuse_hide_original_text: bool,
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
    payload: EditPayload,
) -> Result<String, String> {
    if payload.save_mode.as_deref() == Some("saveAs") {
        if let Some(dir) = payload.target_dir.as_deref() {
            if !dir.is_empty() {
                std::fs::create_dir_all(dir)
                    .map_err(|e| format!("保存先フォルダの作成に失敗: {}: {}", dir, e))?;
            }
        }
    }
    photoshop::apply_edits(&payload, &app).map_err(|e| e.to_string())
}

// 【写植再利用】Photoshop で PSD のテキストレイヤーを列挙し、テキスト非表示の合成画像
// (JPG) を書き出す。戻り値は JSX が生成した JSON 文字列（{docWidth,docHeight,dpi,
// bgImage,textLayers:[...]}）。フロント側で parse して再利用フローに使う。
#[tauri::command]
async fn read_psd_text_layers(app: tauri::AppHandle, psd_path: String) -> Result<String, String> {
    photoshop::read_text_layers(&psd_path, &app).map_err(|e| e.to_string())
}

// 【写植再利用・一括】複数 PSD を 1 回の Photoshop セッションで読み取る。戻り値は
// {"pages":[{ok,psdPath,docWidth,docHeight,dpi,refImage,bgImage,textLayers},...]} の JSON。
#[tauri::command]
async fn read_psd_text_layers_batch(
    app: tauri::AppHandle,
    psd_paths: Vec<String>,
) -> Result<String, String> {
    photoshop::read_text_layers_batch(&psd_paths, &app).map_err(|e| e.to_string())
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

#[tauri::command]
async fn write_text_file(path: String, content: String) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    if let Some(parent) = path_buf.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("folder create failed ({}): {}", parent.display(), e))?;
        }
    }
    fs::write(&path_buf, content)
        .map_err(|e| format!("text write failed ({}): {}", path_buf.display(), e))
}

// 任意のバイナリデータをディスクへ書き出す。写植再利用モードで、見本（元テキスト入りの
// 合成画像）を JPG にエンコードしてプロジェクトフォルダへ保存するために使う。
// フロント側は canvas.toBlob("image/jpeg") → ArrayBuffer → number[] で渡す。
#[tauri::command]
async fn write_binary_file(path: String, data: Vec<u8>) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    if let Some(parent) = path_buf.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("folder create failed ({}): {}", parent.display(), e))?;
        }
    }
    fs::write(&path_buf, &data)
        .map_err(|e| format!("binary write failed ({}): {}", path_buf.display(), e))
}

#[tauri::command]
async fn copy_file(source: String, dest: String) -> Result<u64, String> {
    let source_path = PathBuf::from(&source);
    let dest_path = PathBuf::from(&dest);
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
    fs::write(&path, content)
        .map_err(|e| format!("text save failed ({}): {}", path.display(), e))?;
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
    let mut candidates = vec![desktop.join("ProGen.lnk")];
    if let Some(home) = home {
        candidates.push(
            home.join("AppData")
                .join("Local")
                .join("ProGen")
                .join("progen.exe"),
        );
    }
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
        candidates.push(
            root.join("src-tauri")
                .join("target")
                .join("debug")
                .join("progen.exe"),
        );
        candidates.push(root.join("dev.bat"));
    }
    candidates.into_iter().find(|p| p.exists())
}

#[tauri::command]
async fn launch_progen_with_text(text_path: String) -> Result<String, String> {
    let text_path = PathBuf::from(text_path);
    write_progen_handoff(&text_path)?;
    let launcher = find_progen_launcher().ok_or_else(|| {
        "ProGen launcher was not found under Desktop\\ProGen.lnk, AppData\\Local\\ProGen, Desktop\\progen_DEMO\\progen, or Desktop\\progen_DEMO\\data".to_string()
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

#[inline]
fn pad4(n: usize) -> usize {
    (n + 3) & !3
}

#[tauri::command]
async fn list_psd_files(folder: String) -> Result<Vec<String>, String> {
    let folder_path = resolve_shortcut_path(Path::new(&folder));
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
async fn list_directory_entries(path: String) -> Result<Vec<DirEntry>, String> {
    let dir_path = resolve_shortcut_path(Path::new(&path));
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
async fn startup_args() -> Vec<String> {
    std::env::args()
        .skip(1)
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
async fn path_info(path: String) -> Result<PathInfo, String> {
    let input_path = PathBuf::from(&path);
    let p = resolve_shortcut_path(&input_path);
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
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // 【v2.x】Photoshop 警告ダイアログ (仮想記憶ディスクの容量不足など) を
            // アプリ起動時から常時バックグラウンドで監視し、見つけたら自動 OK する。
            // 2 秒間隔で polling、CPU 負荷は無視できるレベル。OPUS の保存処理経由
            // 以外 (例: ユーザーが直接 Photoshop を操作中) で警告が出ても拾える。
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
            read_psd_text_layers_batch,
            list_fonts,
            read_binary_file,
            read_text_file,
            write_text_file,
            write_binary_file,
            copy_file,
            opus_project_root_path,
            create_opus_project_dir,
            script_output_dir,
            save_editor_text_to_script_output,
            launch_progen_with_text,
            read_font_face_bytes,
            list_psd_files,
            list_directory_entries,
            open_folder_in_explorer,
            startup_args,
            path_info,
            list_drives,
            home_dir,
            desktop_dir,
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
            tachimi::launch_tachimi_with_files
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
