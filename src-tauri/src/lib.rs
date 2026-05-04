mod fonts;
mod jsx_gen;
mod ocr;
mod photoshop;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PsdEdits {
    #[serde(rename = "psdPath")]
    pub psd_path: String,
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
}

#[derive(Debug, Serialize)]
pub struct FontEntry {
    pub name: String,
    #[serde(rename = "postScriptName")]
    pub post_script_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            apply_edits_via_photoshop,
            list_fonts,
            read_binary_file,
            list_psd_files,
            list_directory_entries,
            list_drives,
            home_dir,
            ocr::check_ai_models,
            ocr::install_ai_models,
            ocr::cancel_ai_install,
            ocr::run_ai_ocr,
            ocr::export_ai_text
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
