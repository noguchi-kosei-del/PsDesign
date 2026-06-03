use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::Emitter;
use thiserror::Error;

use crate::{jsx_gen, EditPayload};

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
const PROGRESS_EVENT: &str = "photoshop_save_progress";
static OPUS_OWNS_PHOTOSHOP_SESSION: AtomicBool = AtomicBool::new(false);

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

pub fn apply_edits(
    payload: &EditPayload,
    app: &tauri::AppHandle,
) -> Result<String, PhotoshopError> {
    let ps_path = find_photoshop_executable().ok_or(PhotoshopError::NotFound)?;
    let saved_psd_paths = saved_psd_paths_for_payload(payload);
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let sentinel_path = sentinel_path_for(ts);
    let progress_path = progress_path_for(ts);
    let _ = std::fs::remove_file(&sentinel_path);
    let _ = std::fs::remove_file(&progress_path);
    let photoshop_was_running = is_photoshop_process_running();
    let quit_photoshop_after_finish =
        OPUS_OWNS_PHOTOSHOP_SESSION.load(Ordering::SeqCst) || !photoshop_was_running;
    if !photoshop_was_running {
        OPUS_OWNS_PHOTOSHOP_SESSION.store(true, Ordering::SeqCst);
    }

    emit_progress(app, 0, payload.edits.len(), "Photoshop を起動しています...");
    let jsx = jsx_gen::generate_apply_script(
        payload,
        &path_for_jsx(&sentinel_path),
        &path_for_jsx(&progress_path),
        quit_photoshop_after_finish,
    );
    let jsx_path = write_temp_jsx(&jsx, ts)?;

    let mut command = Command::new(&ps_path);
    command.arg("-r").arg(&jsx_path);
    hide_console_window(&mut command);
    command
        .spawn()
        .map_err(|e| PhotoshopError::LaunchFailed(e.to_string()))?;
    emit_progress(
        app,
        0,
        payload.edits.len(),
        "Photoshop に処理を渡しています...",
    );

    // 【v2.x】Photoshop 起動時の「仮想記憶ディスクの容量不足」警告ダイアログを自動 OK する。
    // このダイアログは Photoshop プロセスが起動するタイミング (= JSX 実行前) に出るため
    // JSX 内の app.displayDialogs = NO では抑制できない。Windows API で別途検出して
    // OK ボタン (IDOK = 1) に WM_COMMAND を送ることでバックグラウンドで自動クローズする。
    // バックグラウンドスレッドで動かし、メイン処理 (sentinel ポーリング) をブロックしない。
    start_scratch_dialog_auto_dismiss();

    let mut hidden_windows = HiddenPhotoshopWindows::default();
    hidden_windows.hide_visible_photoshop_windows();
    let mut last_progress = String::new();
    // 起動直後に Photoshop が一瞬前面化することがあるため、最初の数秒だけ
    // 25ms 間隔で隠し続ける。JSX 実行自体は止めず、sentinel ができたら即座に通常ループへ戻る。
    for _ in 0..160 {
        hidden_windows.hide_visible_photoshop_windows();
        relay_progress_file(app, &progress_path, &mut last_progress);
        if sentinel_path.exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }

    let deadline = Instant::now() + Duration::from_secs(SENTINEL_TIMEOUT_SECS);
    loop {
        hidden_windows.hide_visible_photoshop_windows();
        relay_progress_file(app, &progress_path, &mut last_progress);
        if sentinel_path.exists() {
            let content = std::fs::read_to_string(&sentinel_path).unwrap_or_default();
            let _ = std::fs::remove_file(&sentinel_path);
            let _ = std::fs::remove_file(&progress_path);
            let _ = std::fs::remove_file(&jsx_path);
            if !quit_photoshop_after_finish {
                hidden_windows.restore_hidden_photoshop_windows_minimized();
            } else if wait_for_photoshop_exit(Duration::from_secs(8), Some(&mut hidden_windows)) {
                OPUS_OWNS_PHOTOSHOP_SESSION.store(false, Ordering::SeqCst);
            }
            cleanup_adobe_crash_processors();
            let lock_warnings = release_saved_psd_locks(&saved_psd_paths);
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
                    return Ok(format!("{}（警告: {}）", base, warnings.join(" / ")));
                }
                return Ok(base);
            }
            let msg = head.strip_prefix("ERROR ").unwrap_or(&head).to_string();
            return Err(PhotoshopError::ScriptFailed(msg));
        }
        if Instant::now() > deadline {
            let _ = std::fs::remove_file(&progress_path);
            let _ = std::fs::remove_file(&jsx_path);
            hidden_windows.restore_hidden_photoshop_windows_minimized();
            cleanup_adobe_crash_processors();
            return Err(PhotoshopError::Timeout);
        }
        std::thread::sleep(Duration::from_millis(PHOTOSHOP_HIDE_POLL_MS));
    }
}

// 【写植再利用】Photoshop で PSD のテキストレイヤーを列挙し、テキスト非表示の合成画像
// (JPG) を書き出す。戻り値は JSX が書いた JSON 文字列（フロントが parse して使う）。
// PSD は保存しない。
pub fn read_text_layers(psd_path: &str, app: &tauri::AppHandle) -> Result<String, PhotoshopError> {
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

    start_scratch_dialog_auto_dismiss();
    let mut hidden_windows = HiddenPhotoshopWindows::default();
    hidden_windows.hide_visible_photoshop_windows();
    // 起動直後の前面フラッシュ防止（25ms 間隔の高速ループ）。
    for _ in 0..160 {
        hidden_windows.hide_visible_photoshop_windows();
        if sentinel_path.exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }

    let deadline = Instant::now() + Duration::from_secs(SENTINEL_TIMEOUT_SECS);
    loop {
        hidden_windows.hide_visible_photoshop_windows();
        if sentinel_path.exists() {
            let content = std::fs::read_to_string(&sentinel_path).unwrap_or_default();
            let _ = std::fs::remove_file(&sentinel_path);
            let _ = std::fs::remove_file(&jsx_path);
            // 完了後は前面化させず、タスクバーに最小化で戻す（別途 Photoshop を使える）。
            hidden_windows.restore_hidden_photoshop_windows_minimized();
            cleanup_adobe_crash_processors();
            let trimmed = content.trim().to_string();
            if trimmed.starts_with("OK") {
                let json = std::fs::read_to_string(&out_json_path).map_err(|e| {
                    PhotoshopError::ScriptFailed(format!("結果JSONの読込に失敗: {}", e))
                })?;
                let _ = std::fs::remove_file(&out_json_path);
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
            hidden_windows.restore_hidden_photoshop_windows_minimized();
            cleanup_adobe_crash_processors();
            return Err(PhotoshopError::Timeout);
        }
        std::thread::sleep(Duration::from_millis(SENTINEL_POLL_MS));
    }
}

// 【写植再利用・一括】複数 PSD を 1 回の Photoshop セッションで処理する。
// 戻り値は {"pages":[...]} の JSON 文字列。1 枚ごとに Photoshop を起動し直さず、
// ウィンドウ非表示を全体で 1 度だけ行い、完了後は前面化せずに非表示解除する。
pub fn read_text_layers_batch(
    psd_paths: &[String],
    app: &tauri::AppHandle,
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

    start_scratch_dialog_auto_dismiss();
    let mut hidden_windows = HiddenPhotoshopWindows::default();
    hidden_windows.hide_visible_photoshop_windows();
    // 起動直後の前面フラッシュを防ぐため、最初の数秒は高速ループ（25ms 間隔）で
    // Photoshop のウィンドウが出た瞬間に隠す。通常植字と同様に「ずっと非表示」にする。
    for _ in 0..160 {
        hidden_windows.hide_visible_photoshop_windows();
        if sentinel_path.exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }

    let deadline = Instant::now() + Duration::from_secs(SENTINEL_TIMEOUT_SECS);
    loop {
        // 処理中に出てくる Photoshop ウィンドウは隠し続ける（前面化を防止）。
        hidden_windows.hide_visible_photoshop_windows();
        if sentinel_path.exists() {
            let content = std::fs::read_to_string(&sentinel_path).unwrap_or_default();
            let _ = std::fs::remove_file(&sentinel_path);
            let _ = std::fs::remove_file(&jsx_path);
            // 完了後は前面化させず、タスクバーに最小化で戻す（別途 Photoshop を使える）。
            hidden_windows.restore_hidden_photoshop_windows_minimized();
            cleanup_adobe_crash_processors();
            let trimmed = content.trim().to_string();
            if trimmed.starts_with("OK") {
                let json = std::fs::read_to_string(&out_json_path).map_err(|e| {
                    PhotoshopError::ScriptFailed(format!("結果JSONの読込に失敗: {}", e))
                })?;
                let _ = std::fs::remove_file(&out_json_path);
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
            hidden_windows.restore_hidden_photoshop_windows_minimized();
            cleanup_adobe_crash_processors();
            return Err(PhotoshopError::Timeout);
        }
        std::thread::sleep(Duration::from_millis(SENTINEL_POLL_MS));
    }
}

#[cfg(windows)]
#[derive(Default)]
struct HiddenPhotoshopWindows {
    windows: Vec<HiddenPhotoshopWindow>,
}

#[cfg(windows)]
struct HiddenPhotoshopWindow {
    hwnd: isize,
    restore_after: bool,
}

#[cfg(windows)]
impl HiddenPhotoshopWindows {
    fn hide_visible_photoshop_windows(&mut self) {
        for target in find_visible_photoshop_windows() {
            let key = target.hwnd as isize;
            unsafe {
                winapi::um::winuser::ShowWindow(target.hwnd, winapi::um::winuser::SW_HIDE);
            }
            if !self.windows.iter().any(|w| w.hwnd == key) {
                self.windows.push(HiddenPhotoshopWindow {
                    hwnd: key,
                    restore_after: target.restore_after,
                });
            }
        }
    }

    #[allow(dead_code)]
    fn restore_hidden_photoshop_windows(&mut self) {
        for window in self.windows.drain(..) {
            if !window.restore_after {
                continue;
            }
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
            if !window.restore_after {
                continue;
            }
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
            if !window.restore_after {
                continue;
            }
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
struct HiddenPhotoshopWindows;

#[cfg(not(windows))]
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
// ポーリング期間: Photoshop 起動から最大 90 秒間、500ms 間隔。複数の警告ダイアログ
// (容量不足の後にフォント置換警告など) が連鎖して出るケースにも対応する。
//
// dismiss 戦略は 2 段:
//   戦略 1: ダイアログ HWND の子ウィンドウから「OK」テキストを持つ Button クラスを
//           EnumChildWindows で探して BM_CLICK (= 0x00F5) を PostMessage で送る。
//           Adobe ダイアログでは独自の WndProc で IDOK が無視されるケースが多いので、
//           実際の OK ボタンを叩く方が確実。
//   戦略 2: 並行して WM_COMMAND IDOK もダイアログ本体に送る (補助)。
#[cfg(windows)]
fn start_scratch_dialog_auto_dismiss() {
    std::thread::spawn(|| {
        use std::time::{Duration, Instant};
        let deadline = Instant::now() + Duration::from_secs(90);
        while Instant::now() < deadline {
            let _ = dismiss_known_photoshop_dialogs();
            std::thread::sleep(Duration::from_millis(500));
        }
    });
}

#[cfg(not(windows))]
fn start_scratch_dialog_auto_dismiss() {}

#[cfg(windows)]
fn is_photoshop_process_running() -> bool {
    !photoshop_related_process_ids().is_empty()
}

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

#[cfg(not(windows))]
fn is_photoshop_process_running() -> bool {
    false
}

fn wait_for_photoshop_exit(
    timeout: Duration,
    mut hidden_windows: Option<&mut HiddenPhotoshopWindows>,
) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Some(windows) = hidden_windows.as_deref_mut() {
            windows.hide_visible_photoshop_windows();
        }
        if !is_photoshop_process_running() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(PHOTOSHOP_HIDE_POLL_MS));
    }
    !is_photoshop_process_running()
}

// 【v2.x】常時バックグラウンド監視。アプリ起動時に一度だけ呼ぶ。Photoshop が
// いつ起動されても (OPUS の保存処理経由以外も含む) 警告ダイアログを自動 OK する。
// 2 秒間隔で polling、CPU 負荷は無視できるレベル。
#[cfg(windows)]
pub fn start_background_dialog_watcher() {
    std::thread::spawn(|| {
        use std::time::Duration;
        loop {
            let _ = dismiss_known_photoshop_dialogs();
            std::thread::sleep(Duration::from_millis(2000));
        }
    });
}

#[cfg(not(windows))]
pub fn start_background_dialog_watcher() {}

#[cfg(windows)]
fn dismiss_known_photoshop_dialogs() -> usize {
    use winapi::shared::minwindef::{BOOL, LPARAM};
    use winapi::shared::windef::HWND;
    use winapi::um::winuser::{
        EnumChildWindows, EnumWindows, GetClassNameW, GetForegroundWindow, GetWindowTextLengthW,
        GetWindowTextW, IsWindowVisible, PostMessageW, SendInput, SetForegroundWindow, BM_CLICK,
        INPUT, INPUT_KEYBOARD, KEYEVENTF_KEYUP, VK_RETURN, WM_CHAR, WM_CLOSE, WM_COMMAND,
        WM_KEYDOWN, WM_KEYUP,
    };

    // 検出対象のダイアログタイトル (小文字で部分一致判定)。複数のロケール / バージョン
    // 表記揺れを 1 リストに集約する。
    const TARGET_KEYWORDS: &[&str] = &[
        "仮想記憶ディスクの容量不足",
        "仮想記憶ディスク",
        "scratch disk",
        "scratch disks",
    ];

    // OK ボタンのラベル候補 (Photoshop 言語別 + 半角全角)。
    const OK_LABELS: &[&str] = &["ok", "ｏｋ", "ＯＫ", "&ok"];

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

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let count = &mut *(lparam as *mut usize);
        if IsWindowVisible(hwnd) == 0 {
            return 1;
        }
        let title = window_title(hwnd);
        let title_lower = title.to_lowercase();
        if title_lower.is_empty() {
            return 1;
        }
        let matched = TARGET_KEYWORDS
            .iter()
            .any(|kw| title_lower.contains(&kw.to_lowercase()));
        if !matched {
            return 1;
        }

        eprintln!(
            "[ps-dismiss] detected dialog hwnd={:?} title={:?}",
            hwnd, title
        );

        // 戦略 1: 子ウィンドウから OK ボタンを探して BM_CLICK。
        // 標準 Win32 Button が存在すれば確実。Adobe Skia UI ではボタンが
        // EnumChildWindows で見えないので null になる。
        let mut ok_btn: HWND = std::ptr::null_mut();
        EnumChildWindows(
            hwnd,
            Some(find_ok_button_proc),
            &mut ok_btn as *mut _ as LPARAM,
        );
        if !ok_btn.is_null() {
            eprintln!("[ps-dismiss] strategy 1: BM_CLICK to ok_btn={:?}", ok_btn);
            let _ = PostMessageW(ok_btn, BM_CLICK, 0, 0);
        } else {
            eprintln!("[ps-dismiss] strategy 1: no standard OK button found (Skia UI?)");
        }

        // 戦略 2: ダイアログ本体に WM_COMMAND IDOK。
        eprintln!("[ps-dismiss] strategy 2: WM_COMMAND IDOK to dialog");
        let _ = PostMessageW(hwnd, WM_COMMAND, 1, 0);

        // 戦略 3: VK_RETURN を WM_KEYDOWN/UP で送る (Skia UI 向け)。
        // 多くの Adobe ダイアログは Enter キーで OK を確定する。
        eprintln!("[ps-dismiss] strategy 3: WM_KEYDOWN/UP VK_RETURN to dialog");
        let _ = PostMessageW(hwnd, WM_KEYDOWN, VK_RETURN as usize, 0);
        let _ = PostMessageW(hwnd, WM_KEYUP, VK_RETURN as usize, 0);

        // 戦略 4: WM_CHAR '\r' (一部の UI Framework はキー入力を WM_CHAR で受ける)。
        eprintln!("[ps-dismiss] strategy 4: WM_CHAR \\r to dialog");
        let _ = PostMessageW(hwnd, WM_CHAR, '\r' as usize, 0);

        // 戦略 5: SetForegroundWindow + SendInput VK_RETURN (最後の手段)。
        // フォーカスを一時的にダイアログへ移して、グローバルキー入力として Enter を送る。
        // 確実だが、ユーザーが他のアプリで作業中だとフォーカスが奪われる副作用あり。
        // 起動時警告中はユーザーは保存処理を待っているので実用上 OK と判断。
        eprintln!("[ps-dismiss] strategy 5: SetForegroundWindow + SendInput Enter");
        let orig_fg = GetForegroundWindow();
        let _ = SetForegroundWindow(hwnd);
        std::thread::sleep(std::time::Duration::from_millis(80));
        // Enter キーを KEYDOWN + KEYUP で送る。
        let mut inputs: [INPUT; 2] = std::mem::zeroed();
        inputs[0].type_ = INPUT_KEYBOARD;
        {
            let ki = inputs[0].u.ki_mut();
            ki.wVk = VK_RETURN as u16;
            ki.wScan = 0;
            ki.dwFlags = 0;
            ki.time = 0;
            ki.dwExtraInfo = 0;
        }
        inputs[1].type_ = INPUT_KEYBOARD;
        {
            let ki = inputs[1].u.ki_mut();
            ki.wVk = VK_RETURN as u16;
            ki.wScan = 0;
            ki.dwFlags = KEYEVENTF_KEYUP;
            ki.time = 0;
            ki.dwExtraInfo = 0;
        }
        SendInput(
            inputs.len() as u32,
            inputs.as_mut_ptr(),
            std::mem::size_of::<INPUT>() as i32,
        );
        // 元のフォアグラウンドウィンドウへ復帰 (奪ったフォーカスをユーザーに返す)。
        if !orig_fg.is_null() && orig_fg != hwnd {
            std::thread::sleep(std::time::Duration::from_millis(50));
            let _ = SetForegroundWindow(orig_fg);
        }

        // 戦略 6: WM_CLOSE (× ボタン相当、最終手段)。Skia UI でも効きやすい。
        // OK と等価ではないかもしれないが、Photoshop の起動警告ではダイアログを閉じる
        // ことで処理続行になるケースが多い。
        eprintln!("[ps-dismiss] strategy 6: WM_CLOSE to dialog");
        let _ = PostMessageW(hwnd, WM_CLOSE, 0, 0);

        *count += 1;
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

    let mut count: usize = 0;
    unsafe {
        EnumWindows(Some(enum_proc), &mut count as *mut _ as LPARAM);
    }
    count
}

#[cfg(windows)]
struct PhotoshopWindowTarget {
    hwnd: winapi::shared::windef::HWND,
    restore_after: bool,
}

#[cfg(windows)]
fn find_visible_photoshop_windows() -> Vec<PhotoshopWindowTarget> {
    use winapi::shared::minwindef::{BOOL, LPARAM};
    use winapi::shared::windef::HWND;
    use winapi::um::winuser::{
        EnumWindows, GetClassNameW, GetWindowTextLengthW, GetWindowTextW,
        GetWindowThreadProcessId, IsWindowVisible,
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
        if is_target_process || class_name.contains("photoshop") || title.contains("photoshop") {
            state.windows.push(PhotoshopWindowTarget {
                hwnd,
                restore_after: class_name.contains("photoshop") || title.contains("photoshop"),
            });
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
