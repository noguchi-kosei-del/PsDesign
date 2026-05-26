use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use thiserror::Error;
use tauri::Emitter;

use crate::{jsx_gen, EditPayload};

const SENTINEL_TIMEOUT_SECS: u64 = 600;
const SENTINEL_POLL_MS: u64 = 300;
const PROGRESS_EVENT: &str = "photoshop_save_progress";

#[derive(Clone, Serialize)]
struct PhotoshopProgress {
    current: usize,
    total: usize,
    detail: String,
}

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

pub fn apply_edits(payload: &EditPayload, app: &tauri::AppHandle) -> Result<String, PhotoshopError> {
    let ps_path = find_photoshop_executable().ok_or(PhotoshopError::NotFound)?;
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let sentinel_path = sentinel_path_for(ts);
    let progress_path = progress_path_for(ts);
    let _ = std::fs::remove_file(&sentinel_path);
    let _ = std::fs::remove_file(&progress_path);

    emit_progress(app, 0, payload.edits.len(), "Photoshop を起動しています...");
    let jsx = jsx_gen::generate_apply_script(
        payload,
        &path_for_jsx(&sentinel_path),
        &path_for_jsx(&progress_path),
    );
    let jsx_path = write_temp_jsx(&jsx, ts)?;

    Command::new(&ps_path)
        .arg("-r")
        .arg(&jsx_path)
        .spawn()
        .map_err(|e| PhotoshopError::LaunchFailed(e.to_string()))?;
    emit_progress(app, 0, payload.edits.len(), "Photoshop に処理を渡しています...");

    let mut hidden_windows = HiddenPhotoshopWindows::default();
    hidden_windows.hide_visible_photoshop_windows();

    let deadline = Instant::now() + Duration::from_secs(SENTINEL_TIMEOUT_SECS);
    let mut last_progress = String::new();
    loop {
        hidden_windows.hide_visible_photoshop_windows();
        relay_progress_file(app, &progress_path, &mut last_progress);
        if sentinel_path.exists() {
            let content = std::fs::read_to_string(&sentinel_path).unwrap_or_default();
            let _ = std::fs::remove_file(&sentinel_path);
            let _ = std::fs::remove_file(&progress_path);
            let _ = std::fs::remove_file(&jsx_path);
            hidden_windows.restore_hidden_photoshop_windows();
            cleanup_adobe_crash_processors();
            let trimmed = content.trim().to_string();
            // "head" は OK ステータス本体（"OK" / "OK partial 7/10"）、
            // "warn_suffix" は addWarning 由来の警告群（失敗 PSD 詳細含む）。
            let (head, warn_suffix) = if let Some(idx) = trimmed.find("|WARN ") {
                (
                    trimmed[..idx].to_string(),
                    trimmed[idx + "|WARN ".len()..].trim().to_string(),
                )
            } else {
                (trimmed.clone(), String::new())
            };
            if head.starts_with("OK") {
                let total = payload.edits.len();
                let base = if let Some(rest) = head.strip_prefix("OK partial ") {
                    // "<ok>/<total>" 形式を期待。パース失敗時は安全側で全件成功扱いに戻す。
                    if let Some((ok_str, _)) = rest.split_once('/') {
                        match ok_str.trim().parse::<usize>() {
                            Ok(ok) => format!("{} / {} 個の PSD を更新", ok, total),
                            Err(_) => format!("{} 個の PSD を更新", total),
                        }
                    } else {
                        format!("{} 個の PSD を更新", total)
                    }
                } else {
                    format!("{} 個の PSD を更新", total)
                };
                if !warn_suffix.is_empty() {
                    return Ok(format!("{}（警告: {}）", base, warn_suffix));
                }
                return Ok(base);
            }
            let msg = head.strip_prefix("ERROR ").unwrap_or(&head).to_string();
            return Err(PhotoshopError::ScriptFailed(msg));
        }
        if Instant::now() > deadline {
            let _ = std::fs::remove_file(&progress_path);
            let _ = std::fs::remove_file(&jsx_path);
            hidden_windows.restore_hidden_photoshop_windows();
            cleanup_adobe_crash_processors();
            return Err(PhotoshopError::Timeout);
        }
        std::thread::sleep(Duration::from_millis(SENTINEL_POLL_MS));
    }
}

#[cfg(windows)]
#[derive(Default)]
struct HiddenPhotoshopWindows {
    hwnds: Vec<isize>,
}

#[cfg(windows)]
impl HiddenPhotoshopWindows {
    fn hide_visible_photoshop_windows(&mut self) {
        for hwnd in find_visible_photoshop_windows() {
            let key = hwnd as isize;
            unsafe {
                winapi::um::winuser::ShowWindow(hwnd, winapi::um::winuser::SW_HIDE);
            }
            if !self.hwnds.contains(&key) {
                self.hwnds.push(key);
            }
        }
    }

    fn restore_hidden_photoshop_windows(&mut self) {
        for hwnd_key in self.hwnds.drain(..) {
            let hwnd = hwnd_key as winapi::shared::windef::HWND;
            unsafe {
                winapi::um::winuser::ShowWindow(hwnd, winapi::um::winuser::SW_RESTORE);
            }
        }
    }
}

#[cfg(not(windows))]
#[derive(Default)]
struct HiddenPhotoshopWindows;

#[cfg(not(windows))]
impl HiddenPhotoshopWindows {
    fn hide_visible_photoshop_windows(&mut self) {}
    fn restore_hidden_photoshop_windows(&mut self) {}
}

#[cfg(windows)]
fn cleanup_adobe_crash_processors() {
    for image_name in ["Adobe Crash Processor.exe", "Adobe Crash Handler.exe"] {
        let _ = Command::new("taskkill")
            .args(["/F", "/IM", image_name])
            .output();
    }
}

#[cfg(not(windows))]
fn cleanup_adobe_crash_processors() {}

#[cfg(windows)]
fn find_visible_photoshop_windows() -> Vec<winapi::shared::windef::HWND> {
    use winapi::shared::minwindef::{BOOL, LPARAM};
    use winapi::shared::windef::HWND;
    use winapi::um::winuser::{
        EnumWindows, GetClassNameW, GetWindowTextLengthW, GetWindowTextW, IsWindowVisible,
    };

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let out = &mut *(lparam as *mut Vec<HWND>);
        if IsWindowVisible(hwnd) == 0 {
            return 1;
        }

        let class_name = window_class_name(hwnd).to_ascii_lowercase();
        let title = window_title(hwnd).to_ascii_lowercase();
        if class_name.contains("photoshop") || title.contains("photoshop") {
            out.push(hwnd);
        }
        1
    }

    unsafe fn window_class_name(hwnd: HWND) -> String {
        let mut buf = [0u16; 256];
        let len = GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        String::from_utf16_lossy(&buf[..len.max(0) as usize])
    }

    unsafe fn window_title(hwnd: HWND) -> String {
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return String::new();
        }
        let mut buf = vec![0u16; len as usize + 1];
        let got = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        String::from_utf16_lossy(&buf[..got.max(0) as usize])
    }

    let mut windows = Vec::new();
    unsafe {
        EnumWindows(Some(enum_proc), &mut windows as *mut _ as LPARAM);
    }
    windows
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

fn progress_path_for(ts: u128) -> PathBuf {
    let mut path = std::env::temp_dir();
    path.push(format!("psdesign_progress_{}.txt", ts));
    path
}

fn path_for_jsx(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

fn emit_progress(app: &tauri::AppHandle, current: usize, total: usize, detail: impl Into<String>) {
    let _ = app.emit(
        PROGRESS_EVENT,
        PhotoshopProgress {
            current,
            total,
            detail: detail.into(),
        },
    );
}

fn relay_progress_file(app: &tauri::AppHandle, path: &PathBuf, last: &mut String) {
    let Ok(content) = std::fs::read_to_string(path) else {
        return;
    };
    if content == *last {
        return;
    }
    *last = content.clone();
    let mut parts = content.splitn(3, '\t');
    let current = parts
        .next()
        .and_then(|s| s.trim().parse::<usize>().ok())
        .unwrap_or(0);
    let total = parts
        .next()
        .and_then(|s| s.trim().parse::<usize>().ok())
        .unwrap_or(0);
    let detail = parts.next().unwrap_or("").trim().to_string();
    emit_progress(app, current, total, detail);
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
                if full.exists() && best.as_ref().map_or(true, |(v, _)| version > *v) {
                    best = Some((version, full));
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
