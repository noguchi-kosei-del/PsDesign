use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn is_kenban_exe(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    name == "kenban.exe" || name == "kenban"
}

#[tauri::command]
pub async fn detect_kenban_exe(hint: Option<String>) -> Option<String> {
    if let Some(h) = hint.as_deref() {
        let path = PathBuf::from(h);
        if is_kenban_exe(&path) {
            return Some(path.to_string_lossy().to_string());
        }
    }

    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let base = PathBuf::from(local_app_data);
        candidates.push(base.join("KENBAN").join("KENBAN.exe"));
        candidates.push(base.join("KENBAN").join("kenban.exe"));
        candidates.push(base.join("Programs").join("KENBAN").join("KENBAN.exe"));
        candidates.push(base.join("Programs").join("KENBAN").join("kenban.exe"));
    }

    for env_key in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Ok(base) = std::env::var(env_key) {
            let base = PathBuf::from(base);
            candidates.push(base.join("KENBAN").join("KENBAN.exe"));
            candidates.push(base.join("KENBAN").join("kenban.exe"));
        }
    }

    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join("Desktop").join("KENBAN").join("KENBAN.exe"));
        candidates.push(home.join("Desktop").join("KENBAN.exe"));
        for project_name in ["KENBAN", "KENBAN-viewer"] {
            candidates.push(
                home.join("Desktop")
                    .join("開発中アプリ")
                    .join(project_name)
                    .join("src-tauri")
                    .join("target")
                    .join("release")
                    .join("kenban.exe"),
            );
            candidates.push(
                home.join("Desktop")
                    .join("開発中アプリ")
                    .join(project_name)
                    .join("src-tauri")
                    .join("target")
                    .join("debug")
                    .join("kenban.exe"),
            );
        }
    }

    for candidate in candidates {
        if is_kenban_exe(&candidate) {
            return Some(candidate.to_string_lossy().to_string());
        }
    }

    None
}

#[derive(Serialize)]
struct KenbanSelection {
    #[serde(rename = "filesA")]
    files_a: Vec<String>,
    #[serde(rename = "filesB")]
    files_b: Vec<String>,
}

fn existing_files(paths: Vec<String>) -> Vec<String> {
    paths
        .into_iter()
        .filter(|path| Path::new(path).is_file())
        .collect()
}

#[tauri::command]
pub async fn launch_kenban_psd_pdf(
    exe_path: String,
    psd_folder: String,
    psd_paths: Vec<String>,
    reference_paths: Vec<String>,
) -> Result<(), String> {
    let exe = PathBuf::from(&exe_path);
    if !is_kenban_exe(&exe) {
        return Err(format!("KENBAN.exe が見つかりません: {}", exe_path));
    }

    let valid_psds = existing_files(psd_paths);
    if valid_psds.is_empty() {
        return Err("KENBAN に渡せる PSD が見つかりません。".to_string());
    }

    let valid_refs = existing_files(reference_paths);
    if valid_refs.is_empty() {
        return Err("KENBAN に渡せる見本 PDF / 画像が見つかりません。".to_string());
    }

    let selection = KenbanSelection {
        files_a: valid_psds,
        files_b: valid_refs.clone(),
    };
    let json = serde_json::to_string(&selection)
        .map_err(|e| format!("KENBAN 起動 JSON の作成に失敗しました: {}", e))?;
    let json_path =
        std::env::temp_dir().join(format!("opus_kenban_psd_pdf_{}.json", std::process::id()));
    fs::write(&json_path, json).map_err(|e| {
        format!(
            "KENBAN 起動 JSON の書き込みに失敗しました ({}): {}",
            json_path.display(),
            e
        )
    })?;

    let reference_arg = valid_refs
        .first()
        .cloned()
        .unwrap_or_else(|| psd_folder.clone());

    Command::new(&exe)
        .arg("--diff")
        .arg("psd-pdf")
        .arg(psd_folder)
        .arg(reference_arg)
        .arg(json_path.to_string_lossy().to_string())
        .spawn()
        .map_err(|e| format!("KENBAN の起動に失敗しました: {}", e))?;

    Ok(())
}
