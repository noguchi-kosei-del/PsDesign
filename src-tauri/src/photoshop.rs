use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use thiserror::Error;

use crate::{jsx_gen, EditPayload};

const SENTINEL_TIMEOUT_SECS: u64 = 600;
const SENTINEL_POLL_MS: u64 = 300;

#[derive(Debug, Error)]
pub enum PhotoshopError {
    #[error("Photoshop の実行ファイルが見つかりません")]
    NotFound,
    #[error("Photoshop 起動に失敗: {0}")]
    LaunchFailed(String),
    #[error("スクリプト実行エラー: {0}")]
    ScriptFailed(String),
    #[error("Photoshop 応答待ちタイムアウト (Photoshop が起動中でも script が完了していない可能性があります)")]
    Timeout,
    #[error("I/O エラー: {0}")]
    Io(#[from] std::io::Error),
}

pub fn apply_edits(payload: &EditPayload) -> Result<String, PhotoshopError> {
    let ps_path = find_photoshop_executable().ok_or(PhotoshopError::NotFound)?;
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let sentinel_path = sentinel_path_for(ts);
    let _ = std::fs::remove_file(&sentinel_path);

    let jsx = jsx_gen::generate_apply_script(payload, &sentinel_path_for_jsx(&sentinel_path));
    let jsx_path = write_temp_jsx(&jsx, ts)?;

    Command::new(&ps_path)
        .arg("-r")
        .arg(&jsx_path)
        .spawn()
        .map_err(|e| PhotoshopError::LaunchFailed(e.to_string()))?;

    let deadline = Instant::now() + Duration::from_secs(SENTINEL_TIMEOUT_SECS);
    loop {
        if sentinel_path.exists() {
            let content = std::fs::read_to_string(&sentinel_path).unwrap_or_default();
            let _ = std::fs::remove_file(&sentinel_path);
            let _ = std::fs::remove_file(&jsx_path);
            let trimmed = content.trim().to_string();
            if trimmed.starts_with("OK") {
                return Ok(format!("{} 個の PSD を更新", payload.edits.len()));
            }
            let msg = trimmed
                .strip_prefix("ERROR ")
                .unwrap_or(&trimmed)
                .to_string();
            return Err(PhotoshopError::ScriptFailed(msg));
        }
        if Instant::now() > deadline {
            let _ = std::fs::remove_file(&jsx_path);
            return Err(PhotoshopError::Timeout);
        }
        std::thread::sleep(Duration::from_millis(SENTINEL_POLL_MS));
    }
}

fn write_temp_jsx(jsx: &str, ts: u128) -> std::io::Result<PathBuf> {
    let mut path = std::env::temp_dir();
    path.push(format!("psdesign_apply_{}.jsx", ts));
    std::fs::write(&path, jsx)?;
    Ok(path)
}

fn sentinel_path_for(ts: u128) -> PathBuf {
    let mut path = std::env::temp_dir();
    path.push(format!("psdesign_done_{}.flag", ts));
    path
}

fn sentinel_path_for_jsx(p: &PathBuf) -> String {
    p.to_string_lossy().replace('\\', "/")
}

#[cfg(windows)]
pub fn find_photoshop_executable() -> Option<PathBuf> {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let base = hklm
        .open_subkey_with_flags("SOFTWARE\\Adobe\\Photoshop", KEY_READ)
        .ok()?;

    let mut best: Option<(f32, PathBuf)> = None;
    for subkey_name in base.enum_keys().flatten() {
        let version: f32 = subkey_name.parse().unwrap_or(0.0);
        if let Ok(subkey) = base.open_subkey_with_flags(&subkey_name, KEY_READ) {
            let path: Result<String, _> = subkey.get_value("ApplicationPath");
            if let Ok(app_dir) = path {
                let mut full = PathBuf::from(app_dir);
                full.push("Photoshop.exe");
                if full.exists() {
                    if best.as_ref().map_or(true, |(v, _)| version > *v) {
                        best = Some((version, full));
                    }
                }
            }
        }
    }
    best.map(|(_, p)| p)
}

#[cfg(not(windows))]
pub fn find_photoshop_executable() -> Option<PathBuf> {
    None
}
