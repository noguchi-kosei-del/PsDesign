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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            apply_edits_via_photoshop,
            list_fonts,
            read_binary_file,
            list_psd_files,
            ocr::check_ai_models,
            ocr::install_ai_models,
            ocr::cancel_ai_install,
            ocr::run_ai_ocr,
            ocr::export_ai_text
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
