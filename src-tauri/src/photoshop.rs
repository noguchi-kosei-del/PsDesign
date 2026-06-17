use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::Emitter;
use thiserror::Error;

use crate::{jsx_gen, path_access::AllowedPaths, psd_repair, EditPayload, PsdEdits};

#[cfg(windows)]
fn hide_console_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x08000000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console_window(_cmd: &mut Command) {}

const SENTINEL_TIMEOUT_SECS: u64 = 600;
const SENTINEL_POLL_MS: u64 = 300;
const PHOTOSHOP_HIDE_POLL_MS: u64 = 25;
const SAVED_PSD_UNLOCK_TIMEOUT_MS: u64 = 5_000;
const SAVED_PSD_UNLOCK_POLL_MS: u64 = 250;
const WAIT_HINT_INTERVAL_SECS: u64 = 90;
const PROGRESS_EVENT: &str = "photoshop_save_progress";

#[derive(Clone, Serialize)]
struct PhotoshopProgress {
    current: usize,
    total: usize,
    detail: String,
}

#[derive(Debug, Clone)]
struct FailedSaveEntry {
    psd_path: String,
    save_path: String,
}

#[derive(Debug)]
struct ApplyRunOutcome {
    message: String,
    failed_entries: Vec<FailedSaveEntry>,
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

pub fn apply_edits(
    payload: &EditPayload,
    app: &tauri::AppHandle,
) -> Result<String, PhotoshopError> {
    let first = run_apply_edits_once(payload, app)?;
    if first.failed_entries.is_empty() {
        return Ok(first.message);
    }

    match retry_failed_with_repaired_psds(payload, &first.failed_entries, app) {
        Ok(Some(retry)) => {
            if retry.failed_entries.is_empty() {
                Ok(format!(
                    "{}（警告: 保存失敗した PSD を修復して再保存しました: {}）",
                    first.message, retry.message
                ))
            } else {
                Ok(format!(
                    "{}（警告: PSD 修復再保存後も一部失敗しました: {}）",
                    first.message, retry.message
                ))
            }
        }
        Ok(None) => Ok(first.message),
        Err(e) => Ok(format!(
            "{}（警告: PSD 修復再保存に失敗しました: {}）",
            first.message, e
        )),
    }
}

fn run_apply_edits_once(
    payload: &EditPayload,
    app: &tauri::AppHandle,
) -> Result<ApplyRunOutcome, PhotoshopError> {
    let ps_path = find_photoshop_executable().ok_or(PhotoshopError::NotFound)?;
    let saved_psd_paths = saved_psd_paths_for_payload(payload);
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let sentinel_path = sentinel_path_for(ts);
    let progress_path = progress_path_for(ts);
    let payload_path = write_temp_apply_payload(payload, ts)?;
    let _ = std::fs::remove_file(&sentinel_path);
    let _ = std::fs::remove_file(&progress_path);
    let quit_photoshop_after_finish = false;

    emit_progress(app, 0, payload.edits.len(), "Photoshop を起動しています...");
    let jsx = jsx_gen::generate_apply_script(
        payload,
        &path_for_jsx(&payload_path),
        &path_for_jsx(&sentinel_path),
        &path_for_jsx(&progress_path),
        quit_photoshop_after_finish,
    );
    let jsx_path = write_temp_jsx(&jsx, ts)?;

    let mut command = Command::new(&ps_path);
    command.arg("-r").arg(&jsx_path);
    hide_console_window(&mut command);
    if let Err(e) = command.spawn() {
        let _ = std::fs::remove_file(&jsx_path);
        let _ = std::fs::remove_file(&payload_path);
        return Err(PhotoshopError::LaunchFailed(e.to_string()));
    }
    emit_progress(
        app,
        0,
        payload.edits.len(),
        "Photoshop に処理を渡しています...",
    );

    let mut last_progress = String::new();
    for _ in 0..160 {
        relay_progress_file(app, &progress_path, &mut last_progress);
        if sentinel_path.exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }

    let deadline = Instant::now() + Duration::from_secs(SENTINEL_TIMEOUT_SECS);
    let mut next_wait_hint = Instant::now() + Duration::from_secs(WAIT_HINT_INTERVAL_SECS);
    loop {
        relay_progress_file(app, &progress_path, &mut last_progress);
        if sentinel_path.exists() {
            let content = std::fs::read_to_string(&sentinel_path).unwrap_or_default();
            let _ = std::fs::remove_file(&sentinel_path);
            let _ = std::fs::remove_file(&progress_path);
            let _ = std::fs::remove_file(&jsx_path);
            let _ = std::fs::remove_file(&payload_path);
            cleanup_adobe_crash_processors();
            let lock_warnings = release_saved_psd_locks(&saved_psd_paths);
            let trimmed = content.trim().to_string();
            // "head" は OK ステータス本体（"OK" / "OK partial 7/10"）、
            // "warn_suffix" は addWarning 由来の警告群（失敗 PSD 詳細含む）。
            let (head, warn_suffix, failed_entries) = parse_apply_sentinel(&trimmed);
            if head.starts_with("OK") {
                let total = payload.edits.len();
                let mut message = if let Some(rest) = head.strip_prefix("OK partial ") {
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
                let mut warnings = Vec::new();
                if !warn_suffix.is_empty() {
                    warnings.push(warn_suffix);
                }
                if !lock_warnings.is_empty() {
                    warnings.push(format!(
                        "保存PSDのロック解除を確認できませんでした: {}",
                        lock_warnings.join(", ")
                    ));
                }
                if !warnings.is_empty() {
                    message = format!("{}（警告: {}）", message, warnings.join(" / "));
                }
                return Ok(ApplyRunOutcome { message, failed_entries });
            }
            let msg = head.strip_prefix("ERROR ").unwrap_or(&head).to_string();
            return Err(PhotoshopError::ScriptFailed(msg));
        }
        let now = Instant::now();
        if now >= next_wait_hint {
            let (current, total) = progress_counts(&last_progress, payload.edits.len());
            emit_progress(
                app,
                current,
                total,
                "Photoshopの処理待ちです。Photoshop側のダイアログが出ていないか確認してください",
            );
            next_wait_hint = now + Duration::from_secs(WAIT_HINT_INTERVAL_SECS);
        }
        if now > deadline {
            let _ = std::fs::remove_file(&progress_path);
            let _ = std::fs::remove_file(&jsx_path);
            let _ = std::fs::remove_file(&payload_path);
            cleanup_adobe_crash_processors();
            return Err(PhotoshopError::Timeout);
        }
        std::thread::sleep(Duration::from_millis(PHOTOSHOP_HIDE_POLL_MS));
    }
}

// 【写植再利用】Photoshop で PSD のテキストレイヤーを列挙し、テキスト非表示の合成画像
// (JPG) を書き出す。戻り値は JSX が書いた JSON 文字列（フロントが parse して使う）。
// PSD は保存しない。
fn parse_apply_sentinel(text: &str) -> (String, String, Vec<FailedSaveEntry>) {
    let (without_failed, failed_suffix) = split_marker(text, "|FAILED ");
    let (head, warn_suffix) = split_marker(without_failed, "|WARN ");
    (
        head.trim().to_string(),
        warn_suffix.trim().to_string(),
        parse_failed_entries(failed_suffix),
    )
}

fn split_marker<'a>(text: &'a str, marker: &str) -> (&'a str, &'a str) {
    if let Some(idx) = text.find(marker) {
        (&text[..idx], &text[idx + marker.len()..])
    } else {
        (text, "")
    }
}

fn parse_failed_entries(text: &str) -> Vec<FailedSaveEntry> {
    text.lines()
        .filter_map(|line| {
            let (psd_path, save_path) = line.split_once('\t')?;
            let psd_path = psd_path.trim();
            if psd_path.is_empty() {
                return None;
            }
            Some(FailedSaveEntry {
                psd_path: psd_path.to_string(),
                save_path: save_path.trim().to_string(),
            })
        })
        .collect()
}

fn retry_failed_with_repaired_psds(
    payload: &EditPayload,
    failed_entries: &[FailedSaveEntry],
    app: &tauri::AppHandle,
) -> Result<Option<ApplyRunOutcome>, String> {
    if failed_entries.is_empty() {
        return Ok(None);
    }
    emit_progress(
        app,
        0,
        failed_entries.len(),
        "PSD保存エラーを検出しました。PSDを修復して再保存します...",
    );

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let repair_dir = std::env::temp_dir().join(format!("opus_psd_repair_{}", ts));
    let mut retry_payload = payload.clone();
    retry_payload.edits.clear();
    retry_payload.save_mode = None;
    retry_payload.target_dir = None;
    let mut temp_paths = Vec::new();
    let mut repair_warnings = Vec::new();

    for (idx, failed) in failed_entries.iter().enumerate() {
        let Some(original) = payload.edits.iter().find(|edit| edit.psd_path == failed.psd_path) else {
            repair_warnings.push(format!("修復対象が見つかりません: {}", failed.psd_path));
            continue;
        };
        let Some(save_path) = target_save_path_for_edit(payload, original, failed) else {
            repair_warnings.push(format!("保存先を特定できません: {}", failed.psd_path));
            continue;
        };
        let repaired_path = repair_dir.join(format!("repaired_{}.psd", idx + 1));
        match psd_repair::repair_psd_to_file(Path::new(&failed.psd_path), &repaired_path) {
            Ok(()) => {
                let mut retry_edit = original.clone();
                retry_edit.psd_path = repaired_path.to_string_lossy().into_owned();
                retry_edit.save_path = Some(save_path);
                retry_payload.edits.push(retry_edit);
                temp_paths.push(repaired_path);
            }
            Err(e) => {
                repair_warnings.push(format!("{}: {}", failed.psd_path, e));
            }
        }
    }

    if retry_payload.edits.is_empty() {
        return Err(if repair_warnings.is_empty() {
            "修復対象のPSDを作成できませんでした".to_string()
        } else {
            repair_warnings.join(" / ")
        });
    }

    let mut outcome = run_apply_edits_once(&retry_payload, app).map_err(|e| e.to_string())?;
    for path in temp_paths {
        let _ = std::fs::remove_file(path);
    }
    let _ = std::fs::remove_dir(&repair_dir);
    if !repair_warnings.is_empty() {
        outcome.message = format!(
            "{}（警告: 修復できなかったPSDがあります: {}）",
            outcome.message,
            repair_warnings.join(" / ")
        );
    }
    Ok(Some(outcome))
}

fn target_save_path_for_edit(
    payload: &EditPayload,
    edit: &PsdEdits,
    failed: &FailedSaveEntry,
) -> Option<String> {
    if !failed.save_path.is_empty() {
        return Some(failed.save_path.clone());
    }
    if let Some(path) = edit.save_path.as_deref().filter(|s| !s.is_empty()) {
        return Some(path.to_string());
    }
    if payload.save_mode.as_deref() == Some("saveAs") {
        let dir = payload.target_dir.as_deref().filter(|s| !s.is_empty())?;
        let name = Path::new(&edit.psd_path).file_name()?;
        return Some(Path::new(dir).join(name).to_string_lossy().into_owned());
    }
    Some(edit.psd_path.clone())
}

pub fn read_text_layers(
    psd_path: &str,
    app: &tauri::AppHandle,
    allowed: &AllowedPaths,
) -> Result<String, PhotoshopError> {
    let ps_path = find_photoshop_executable().ok_or(PhotoshopError::NotFound)?;
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let sentinel_path = sentinel_path_for(ts);
    let mut out_json_path = std::env::temp_dir();
    out_json_path.push(format!("psdesign_textlayers_{}.json", ts));
    let mut ref_img_path = std::env::temp_dir();
    ref_img_path.push(format!("psdesign_reuse_ref_{}.jpg", ts));
    let mut bg_img_path = std::env::temp_dir();
    bg_img_path.push(format!("psdesign_reuse_bg_{}.jpg", ts));
    let _ = std::fs::remove_file(&sentinel_path);
    let _ = std::fs::remove_file(&out_json_path);
    let _ = std::fs::remove_file(&ref_img_path);
    let _ = std::fs::remove_file(&bg_img_path);

    emit_progress(app, 0, 1, "Photoshop でテキストを読み取っています...");
    let jsx = jsx_gen::generate_read_text_layers_script(
        &path_for_jsx(Path::new(psd_path)),
        &path_for_jsx(&out_json_path),
        &path_for_jsx(&ref_img_path),
        &path_for_jsx(&bg_img_path),
        &path_for_jsx(&sentinel_path),
    );
    let mut jsx_path = std::env::temp_dir();
    jsx_path.push(format!("psdesign_readtext_{}.jsx", ts));
    std::fs::write(&jsx_path, &jsx)?;

    Command::new(&ps_path)
        .arg("-r")
        .arg(&jsx_path)
        .spawn()
        .map_err(|e| PhotoshopError::LaunchFailed(e.to_string()))?;

    // 起動直後の前面フラッシュ防止（25ms 間隔の高速ループ）。
    for _ in 0..160 {
        if sentinel_path.exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }

    let deadline = Instant::now() + Duration::from_secs(SENTINEL_TIMEOUT_SECS);
    loop {
        if sentinel_path.exists() {
            let content = std::fs::read_to_string(&sentinel_path).unwrap_or_default();
            let _ = std::fs::remove_file(&sentinel_path);
            let _ = std::fs::remove_file(&jsx_path);
            // 完了後は前面化させず、タスクバーに最小化で戻す（別途 Photoshop を使える）。
            cleanup_adobe_crash_processors();
            let trimmed = content.trim().to_string();
            if trimmed.starts_with("OK") {
                let json = std::fs::read_to_string(&out_json_path).map_err(|e| {
                    PhotoshopError::ScriptFailed(format!("結果JSONの読込に失敗: {}", e))
                })?;
                let _ = std::fs::remove_file(&out_json_path);
                // Photoshop が書き出した一時 JPG（見本 / 背景）を許可リストへ登録する。
                // これらは後続の read_binary_file / analyze_image_text_regions が
                // ensure_allowed を通過できるようにする（list_fonts と同じ信頼入口での登録）。
                let _ = allowed.register_path(&ref_img_path);
                let _ = allowed.register_path(&bg_img_path);
                return Ok(json);
            }
            let msg = trimmed
                .strip_prefix("ERROR ")
                .unwrap_or(&trimmed)
                .to_string();
            return Err(PhotoshopError::ScriptFailed(msg));
        }
        if Instant::now() > deadline {
            let _ = std::fs::remove_file(&jsx_path);
            cleanup_adobe_crash_processors();
            return Err(PhotoshopError::Timeout);
        }
        std::thread::sleep(Duration::from_millis(SENTINEL_POLL_MS));
    }
}

// 【写植再利用・一括】複数 PSD を 1 回の Photoshop セッションで処理する。
// 戻り値は {"pages":[...]} の JSON 文字列。1 枚ごとに Photoshop を起動し直さず、
// ウィンドウ非表示を全体で 1 度だけ行い、完了後は前面化せずに非表示解除する。
pub fn read_text_layer_metadata(
    psd_path: &str,
    app: &tauri::AppHandle,
) -> Result<String, PhotoshopError> {
    let ps_path = find_photoshop_executable().ok_or(PhotoshopError::NotFound)?;
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let sentinel_path = sentinel_path_for(ts);
    let mut out_json_path = std::env::temp_dir();
    out_json_path.push(format!("psdesign_textmeta_{}.json", ts));
    let _ = std::fs::remove_file(&sentinel_path);
    let _ = std::fs::remove_file(&out_json_path);

    emit_progress(app, 0, 1, "Photoshop でテキスト位置を読み取っています...");
    let jsx = jsx_gen::generate_read_text_layer_metadata_script(
        &path_for_jsx(Path::new(psd_path)),
        &path_for_jsx(&out_json_path),
        &path_for_jsx(&sentinel_path),
    );
    let mut jsx_path = std::env::temp_dir();
    jsx_path.push(format!("psdesign_readtextmeta_{}.jsx", ts));
    std::fs::write(&jsx_path, &jsx)?;

    let mut command = Command::new(&ps_path);
    command.arg("-r").arg(&jsx_path);
    hide_console_window(&mut command);
    command
        .spawn()
        .map_err(|e| PhotoshopError::LaunchFailed(e.to_string()))?;

    for _ in 0..160 {
        if sentinel_path.exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }

    let deadline = Instant::now() + Duration::from_secs(SENTINEL_TIMEOUT_SECS);
    loop {
        if sentinel_path.exists() {
            let content = std::fs::read_to_string(&sentinel_path).unwrap_or_default();
            let _ = std::fs::remove_file(&sentinel_path);
            let _ = std::fs::remove_file(&jsx_path);
            cleanup_adobe_crash_processors();
            let trimmed = content.trim().to_string();
            if trimmed.starts_with("OK") {
                let json = std::fs::read_to_string(&out_json_path).map_err(|e| {
                    PhotoshopError::ScriptFailed(format!("結果JSONの読み込みに失敗: {}", e))
                })?;
                let _ = std::fs::remove_file(&out_json_path);
                return Ok(json);
            }
            let _ = std::fs::remove_file(&out_json_path);
            let msg = trimmed
                .strip_prefix("ERROR ")
                .unwrap_or(&trimmed)
                .to_string();
            return Err(PhotoshopError::ScriptFailed(msg));
        }
        if Instant::now() > deadline {
            let _ = std::fs::remove_file(&jsx_path);
            let _ = std::fs::remove_file(&out_json_path);
            cleanup_adobe_crash_processors();
            return Err(PhotoshopError::Timeout);
        }
        std::thread::sleep(Duration::from_millis(SENTINEL_POLL_MS));
    }
}

pub fn read_text_layers_batch(
    psd_paths: &[String],
    app: &tauri::AppHandle,
    allowed: &AllowedPaths,
) -> Result<String, PhotoshopError> {
    if psd_paths.is_empty() {
        return Ok("{\"pages\":[]}".to_string());
    }
    let ps_path = find_photoshop_executable().ok_or(PhotoshopError::NotFound)?;
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let sentinel_path = sentinel_path_for(ts);
    let mut out_json_path = std::env::temp_dir();
    out_json_path.push(format!("psdesign_textlayers_batch_{}.json", ts));
    let _ = std::fs::remove_file(&sentinel_path);
    let _ = std::fs::remove_file(&out_json_path);

    // 各 PSD ごとに ref / bg の一時 JPG パスを用意する。
    let mut jobs: Vec<(String, String, String)> = Vec::with_capacity(psd_paths.len());
    let mut temp_imgs: Vec<std::path::PathBuf> = Vec::new();
    for (i, psd) in psd_paths.iter().enumerate() {
        let mut ref_img = std::env::temp_dir();
        ref_img.push(format!("psdesign_reuse_ref_{}_{}.jpg", ts, i));
        let mut bg_img = std::env::temp_dir();
        bg_img.push(format!("psdesign_reuse_bg_{}_{}.jpg", ts, i));
        let _ = std::fs::remove_file(&ref_img);
        let _ = std::fs::remove_file(&bg_img);
        jobs.push((
            path_for_jsx(Path::new(psd)),
            path_for_jsx(&ref_img),
            path_for_jsx(&bg_img),
        ));
        temp_imgs.push(ref_img);
        temp_imgs.push(bg_img);
    }

    emit_progress(
        app,
        0,
        psd_paths.len(),
        "Photoshop でテキストを読み取っています...",
    );
    let jsx = jsx_gen::generate_read_text_layers_batch_script(
        &jobs,
        &path_for_jsx(&out_json_path),
        &path_for_jsx(&sentinel_path),
    );
    let mut jsx_path = std::env::temp_dir();
    jsx_path.push(format!("psdesign_readtext_batch_{}.jsx", ts));
    std::fs::write(&jsx_path, &jsx)?;

    Command::new(&ps_path)
        .arg("-r")
        .arg(&jsx_path)
        .spawn()
        .map_err(|e| PhotoshopError::LaunchFailed(e.to_string()))?;

    // 起動直後の前面フラッシュを防ぐため、最初の数秒は高速ループ（25ms 間隔）で
    // Photoshop のウィンドウが出た瞬間に隠す。通常植字と同様に「ずっと非表示」にする。
    for _ in 0..160 {
        if sentinel_path.exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }

    let deadline = Instant::now() + Duration::from_secs(SENTINEL_TIMEOUT_SECS);
    loop {
        if sentinel_path.exists() {
            let content = std::fs::read_to_string(&sentinel_path).unwrap_or_default();
            let _ = std::fs::remove_file(&sentinel_path);
            let _ = std::fs::remove_file(&jsx_path);
            // 完了後は前面化させず、タスクバーに最小化で戻す（別途 Photoshop を使える）。
            cleanup_adobe_crash_processors();
            let trimmed = content.trim().to_string();
            if trimmed.starts_with("OK") {
                let json = std::fs::read_to_string(&out_json_path).map_err(|e| {
                    PhotoshopError::ScriptFailed(format!("結果JSONの読込に失敗: {}", e))
                })?;
                let _ = std::fs::remove_file(&out_json_path);
                // Photoshop が書き出した全ページ分の一時 JPG（見本 / 背景）を許可リストへ登録。
                // 実在しないパス（書き出し失敗ページ）は register_path 側で無害スキップされる。
                for p in &temp_imgs {
                    let _ = allowed.register_path(p);
                }
                return Ok(json);
            }
            let msg = trimmed
                .strip_prefix("ERROR ")
                .unwrap_or(&trimmed)
                .to_string();
            return Err(PhotoshopError::ScriptFailed(msg));
        }
        if Instant::now() > deadline {
            let _ = std::fs::remove_file(&jsx_path);
            cleanup_adobe_crash_processors();
            return Err(PhotoshopError::Timeout);
        }
        std::thread::sleep(Duration::from_millis(SENTINEL_POLL_MS));
    }
}

#[cfg(windows)]
#[derive(Default)]
#[allow(dead_code)]
struct HiddenPhotoshopWindows {
    windows: Vec<HiddenPhotoshopWindow>,
}

#[cfg(windows)]
#[allow(dead_code)]
struct HiddenPhotoshopWindow {
    hwnd: isize,
}

#[cfg(windows)]
#[allow(dead_code)]
impl HiddenPhotoshopWindows {
    fn hide_visible_photoshop_windows(&mut self) {
        for target in find_visible_photoshop_windows() {
            let key = target.hwnd as isize;
            unsafe {
                winapi::um::winuser::ShowWindow(target.hwnd, winapi::um::winuser::SW_HIDE);
            }
            // Anything hidden here must be restored later. Some Adobe modal
            // windows belong to Photoshop's process but do not have Photoshop
            // in their title/class, so filtering on restore can leave them
            // invisible and make the single-instance Photoshop app look hung.
            if !self.windows.iter().any(|w| w.hwnd == key) {
                self.windows.push(HiddenPhotoshopWindow { hwnd: key });
            }
        }
    }

    #[allow(dead_code)]
    fn restore_hidden_photoshop_windows(&mut self) {
        for window in self.windows.drain(..) {
            let hwnd = window.hwnd as winapi::shared::windef::HWND;
            unsafe {
                winapi::um::winuser::ShowWindow(hwnd, winapi::um::winuser::SW_RESTORE);
            }
        }
    }

    // 前面化せずに（フォーカスを奪わずに）非表示を解除する。
    #[allow(dead_code)]
    fn restore_hidden_photoshop_windows_noactivate(&mut self) {
        for window in self.windows.drain(..) {
            let hwnd = window.hwnd as winapi::shared::windef::HWND;
            unsafe {
                // SW_SHOWNA (8): 現在のサイズ・位置で表示するがアクティブ化しない。
                winapi::um::winuser::ShowWindow(hwnd, winapi::um::winuser::SW_SHOWNA);
            }
        }
    }

    // 処理完了後、Photoshop を「タスクバーに最小化」で戻す。前面には出さないが、
    // ユーザーがタスクバーからクリックすれば通常通り使える（完全非表示にはしない）。
    fn restore_hidden_photoshop_windows_minimized(&mut self) {
        for window in self.windows.drain(..) {
            let hwnd = window.hwnd as winapi::shared::windef::HWND;
            unsafe {
                // SW_SHOWMINNOACTIVE (7): 最小化状態で表示するがアクティブ化しない。
                winapi::um::winuser::ShowWindow(hwnd, winapi::um::winuser::SW_SHOWMINNOACTIVE);
            }
        }
    }
}

#[cfg(not(windows))]
#[derive(Default)]
#[allow(dead_code)]
struct HiddenPhotoshopWindows;

#[cfg(not(windows))]
#[allow(dead_code)]
impl HiddenPhotoshopWindows {
    fn hide_visible_photoshop_windows(&mut self) {}
    fn restore_hidden_photoshop_windows(&mut self) {}
    fn restore_hidden_photoshop_windows_noactivate(&mut self) {}
    fn restore_hidden_photoshop_windows_minimized(&mut self) {}
}

#[cfg(windows)]
fn cleanup_adobe_crash_processors() {
    for image_name in ["Adobe Crash Processor.exe", "Adobe Crash Handler.exe"] {
        let mut command = Command::new("taskkill");
        command.args(["/T", "/F", "/IM", image_name]);
        hide_console_window(&mut command);
        let _ = command.output();
    }
}

#[cfg(not(windows))]
fn cleanup_adobe_crash_processors() {}

fn saved_psd_paths_for_payload(payload: &EditPayload) -> Vec<PathBuf> {
    let save_as = payload.save_mode.as_deref() == Some("saveAs");
    let target_dir = payload.target_dir.as_deref().filter(|s| !s.is_empty());
    payload
        .edits
        .iter()
        .filter_map(|psd| {
            if let Some(save_path) = psd.save_path.as_deref().filter(|s| !s.is_empty()) {
                return Some(PathBuf::from(save_path));
            }
            if save_as {
                let dir = target_dir?;
                let name = Path::new(&psd.psd_path).file_name()?;
                Some(Path::new(dir).join(name))
            } else {
                Some(PathBuf::from(&psd.psd_path))
            }
        })
        .collect()
}

fn release_saved_psd_locks(paths: &[PathBuf]) -> Vec<String> {
    if paths.is_empty() {
        return Vec::new();
    }
    let deadline = Instant::now() + Duration::from_millis(SAVED_PSD_UNLOCK_TIMEOUT_MS);
    loop {
        cleanup_adobe_crash_processors();
        let locked: Vec<String> = paths
            .iter()
            .filter(|path| is_psd_file_locked(path))
            .map(|path| path.display().to_string())
            .collect();
        if locked.is_empty() || Instant::now() >= deadline {
            return locked;
        }
        std::thread::sleep(Duration::from_millis(SAVED_PSD_UNLOCK_POLL_MS));
    }
}

fn is_psd_file_locked(path: &Path) -> bool {
    if !path.exists() {
        return false;
    }
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .is_err()
}

// 【v2.x】Photoshop 起動時に出る「仮想記憶ディスクの容量不足」警告ダイアログを
// バックグラウンドで監視し、見つけたら自動的に OK を押す。
//
// このダイアログは Photoshop プロセス起動時に表示されるため、JSX (app.displayDialogs)
// では抑制できない。Windows API (EnumWindows + EnumChildWindows + PostMessage)
// で別途検出して OK ボタンに BM_CLICK を送信することでバックグラウンドクローズする。
//
// 検出対象タイトル (日本語 / 英語 Photoshop):
//   - "仮想記憶ディスクの容量不足"
//   - "Scratch Disks are almost full"
//   - "Scratch disks are full"
//
// ポーリング期間: Photoshop 起動から最大 90 秒間、500ms 間隔。
// 対象は起動時のスクラッチディスク容量警告だけに限定する。
//
// dismiss 戦略:
//   ダイアログ HWND の子ウィンドウから「OK」テキストを持つ Button クラスを
//           EnumChildWindows で探して BM_CLICK (= 0x00F5) を PostMessage で送る。
//           SendInput / WM_CLOSE / WM_COMMAND IDOK は保存中の正規モーダルを
//           誤って確定・終了させうるため使わない。
#[cfg(windows)]
#[allow(dead_code)]
fn start_scratch_dialog_auto_dismiss() {
    std::thread::spawn(|| {
        use std::time::{Duration, Instant};
        let deadline = Instant::now() + Duration::from_secs(90);
        while Instant::now() < deadline {
            let _ = dismiss_known_photoshop_dialogs();
            std::thread::sleep(Duration::from_millis(250));
        }
    });
}

#[cfg(not(windows))]
#[allow(dead_code)]
fn start_scratch_dialog_auto_dismiss() {}

#[cfg(windows)]
fn photoshop_related_process_ids() -> Vec<u32> {
    use std::mem;
    use winapi::um::handleapi::{CloseHandle, INVALID_HANDLE_VALUE};
    use winapi::um::tlhelp32::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Vec::new();
        }

        let mut entry: PROCESSENTRY32W = mem::zeroed();
        entry.dwSize = mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut processes: Vec<(u32, u32, String)> = Vec::new();
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                let nul = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len());
                let exe = String::from_utf16_lossy(&entry.szExeFile[..nul]).to_ascii_lowercase();
                processes.push((entry.th32ProcessID, entry.th32ParentProcessID, exe));
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);

        let mut targets: Vec<u32> = processes
            .iter()
            .filter_map(|(pid, _, exe)| {
                if exe == "photoshop.exe" {
                    Some(*pid)
                } else {
                    None
                }
            })
            .collect();
        let mut changed = true;
        while changed {
            changed = false;
            for (pid, parent_pid, _) in &processes {
                if targets.contains(parent_pid) && !targets.contains(pid) {
                    targets.push(*pid);
                    changed = true;
                }
            }
        }
        targets
    }
}

// 常時バックグラウンド監視は保存中の Photoshop に割り込むリスクがあるため起動しない。
#[cfg(windows)]
pub fn start_background_dialog_watcher() {
    // Do not keep a global watcher alive. It can collide with Photoshop saves
    // that were started outside this module. Each read-only Photoshop launch
    // starts a short, scoped scratch-warning watcher instead.
}

#[cfg(not(windows))]
pub fn start_background_dialog_watcher() {}

#[cfg(windows)]
fn dismiss_known_photoshop_dialogs() -> usize {
    use winapi::shared::minwindef::{BOOL, LPARAM};
    use winapi::shared::windef::HWND;
    use winapi::um::winuser::{
        EnumChildWindows, EnumWindows, GetClassNameW, GetWindowTextLengthW, GetWindowTextW,
        GetWindowThreadProcessId, IsWindowVisible, PostMessageW, ShowWindow, BM_CLICK, SW_SHOWNA,
    };

    // OK ボタンのラベル候補 (Photoshop 言語別 + 半角全角)。
    const OK_LABELS: &[&str] = &["ok", "ｏｋ", "ＯＫ", "&ok"];

    struct DismissState {
        count: usize,
        target_pids: Vec<u32>,
    }

    struct ChildTextMatchState {
        matched: bool,
    }

    unsafe extern "system" fn find_ok_button_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let out = &mut *(lparam as *mut HWND);
        if !out.is_null() {
            return 0;
        }
        let class = window_class_name(hwnd).to_lowercase();
        if !class.contains("button") {
            return 1;
        }
        let title = window_title(hwnd);
        let title_lower = title.trim().to_lowercase().replace('&', "");
        if OK_LABELS.iter().any(|l| title_lower == *l) {
            *out = hwnd;
            return 0;
        }
        1
    }

    unsafe extern "system" fn child_text_match_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let state = &mut *(lparam as *mut ChildTextMatchState);
        if state.matched {
            return 0;
        }
        let title = window_title(hwnd);
        if contains_photoshop_blocking_dialog_keyword(&title) {
            state.matched = true;
            return 0;
        }
        1
    }

    unsafe fn child_text_matches(hwnd: HWND) -> bool {
        let mut state = ChildTextMatchState { matched: false };
        EnumChildWindows(
            hwnd,
            Some(child_text_match_proc),
            &mut state as *mut _ as LPARAM,
        );
        state.matched
    }

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let state = &mut *(lparam as *mut DismissState);
        let title = window_title(hwnd);
        let title_lower = title.to_lowercase();
        let class_lower = window_class_name(hwnd).to_ascii_lowercase();
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        let is_photoshop_window = (pid != 0 && state.target_pids.contains(&pid))
            || title_lower.contains("photoshop")
            || title_lower.contains("adobe")
            || class_lower.contains("photoshop");
        if !is_photoshop_window {
            return 1;
        }

        let dialog_like = class_lower == "#32770"
            || class_lower.contains("dialog")
            || class_lower.contains("modal")
            || title_lower.trim() == "adobe photoshop";
        let matched = contains_photoshop_blocking_dialog_keyword(&title)
            || (dialog_like && child_text_matches(hwnd));
        if !matched {
            return 1;
        }

        eprintln!(
            "[ps-dismiss] detected dialog hwnd={:?} title={:?}",
            hwnd, title
        );

        if IsWindowVisible(hwnd) == 0 {
            eprintln!("[ps-dismiss] dialog was hidden; showing without activation before dismiss");
            let _ = ShowWindow(hwnd, SW_SHOWNA);
            std::thread::sleep(std::time::Duration::from_millis(80));
        }

        // 子ウィンドウから OK ボタンを探して BM_CLICK。
        // 標準 Win32 Button が存在すれば確実。Adobe Skia UI ではボタンが
        // EnumChildWindows で見えないので null になる。
        let mut ok_btn: HWND = std::ptr::null_mut();
        EnumChildWindows(
            hwnd,
            Some(find_ok_button_proc),
            &mut ok_btn as *mut _ as LPARAM,
        );
        if !ok_btn.is_null() {
            eprintln!("[ps-dismiss] BM_CLICK to ok_btn={:?}", ok_btn);
            let _ = PostMessageW(ok_btn, BM_CLICK, 0, 0);
        } else {
            eprintln!("[ps-dismiss] no standard OK button found (Skia UI?)");
        }

        state.count += 1;
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

    let mut state = DismissState {
        count: 0,
        target_pids: photoshop_related_process_ids(),
    };
    unsafe {
        EnumWindows(Some(enum_proc), &mut state as *mut _ as LPARAM);
    }
    state.count
}

#[cfg(not(windows))]
fn dismiss_known_photoshop_dialogs() -> usize {
    0
}

#[cfg(windows)]
#[allow(dead_code)]
struct PhotoshopWindowTarget {
    hwnd: winapi::shared::windef::HWND,
}

#[cfg(windows)]
const PHOTOSHOP_BLOCKING_DIALOG_KEYWORDS: &[&str] = &[
    "仮想記憶ディスク",
    "スクラッチディスク",
    "scratch disk",
    "scratch disks",
    "容量不足",
    "空き容量",
];

#[cfg(windows)]
fn contains_photoshop_blocking_dialog_keyword(text: &str) -> bool {
    let lower = text.to_lowercase();
    PHOTOSHOP_BLOCKING_DIALOG_KEYWORDS
        .iter()
        .any(|kw| lower.contains(kw))
}

#[cfg(windows)]
#[allow(dead_code)]
fn is_photoshop_dialog_hide_exempt(class_name: &str, title: &str) -> bool {
    let class_lower = class_name.trim().to_ascii_lowercase();
    let title_lower = title.trim().to_lowercase();
    class_lower == "#32770"
        || class_lower.contains("dialog")
        || class_lower.contains("modal")
        || title_lower == "adobe photoshop"
        || contains_photoshop_blocking_dialog_keyword(title)
}

#[cfg(windows)]
#[allow(dead_code)]
fn find_visible_photoshop_windows() -> Vec<PhotoshopWindowTarget> {
    use winapi::shared::minwindef::{BOOL, LPARAM};
    use winapi::shared::windef::HWND;
    use winapi::um::winuser::{
        EnumWindows, GetClassNameW, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
        IsWindowVisible,
    };

    struct EnumState {
        windows: Vec<PhotoshopWindowTarget>,
        target_pids: Vec<u32>,
    }

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let state = &mut *(lparam as *mut EnumState);
        if IsWindowVisible(hwnd) == 0 {
            return 1;
        }

        let class_name = window_class_name(hwnd).to_ascii_lowercase();
        let title = window_title(hwnd).to_ascii_lowercase();
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        let is_target_process = pid != 0 && state.target_pids.contains(&pid);
        if is_photoshop_dialog_hide_exempt(&class_name, &title) {
            return 1;
        }
        let hideable_photoshop_surface = class_name.contains("photoshop")
            || title.contains("photoshop")
            || title.contains(".psd")
            || title.contains(".psb");
        if is_target_process && hideable_photoshop_surface {
            state.windows.push(PhotoshopWindowTarget { hwnd });
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

    let mut state = EnumState {
        windows: Vec::new(),
        target_pids: photoshop_related_process_ids(),
    };
    unsafe {
        EnumWindows(Some(enum_proc), &mut state as *mut _ as LPARAM);
    }
    state.windows
}

fn write_temp_jsx(jsx: &str, ts: u128) -> std::io::Result<PathBuf> {
    let mut path = std::env::temp_dir();
    path.push(format!("psdesign_apply_{}.jsx", ts));
    std::fs::write(&path, jsx)?;
    Ok(path)
}

fn write_temp_apply_payload(payload: &EditPayload, ts: u128) -> std::io::Result<PathBuf> {
    let mut path = std::env::temp_dir();
    path.push(format!("psdesign_apply_payload_{}.json", ts));
    let bytes = serde_json::to_vec(payload)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(&path, bytes)?;
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

fn progress_counts(content: &str, default_total: usize) -> (usize, usize) {
    let mut parts = content.splitn(3, '\t');
    let current = parts
        .next()
        .and_then(|s| s.trim().parse::<usize>().ok())
        .unwrap_or(0);
    let total = parts
        .next()
        .and_then(|s| s.trim().parse::<usize>().ok())
        .unwrap_or(default_total);
    (current, total)
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
