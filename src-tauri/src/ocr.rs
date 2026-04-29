// AI セリフ抽出 (mokuro 統合)
//
// 元: serifu-memo/src-tauri/src/lib.rs (Ina986/serifu-memo v0.1.1)
// 主な変更点:
//   - ランタイム配置先を %LOCALAPPDATA%\PsDesign\ai-runtime に変更
//   - イベント名を ai_install:* / ai_ocr:* に統一
//   - PowerShell スクリプトを install-ai-models.ps1 に変更
//   - 構造体・関数を pub(crate) に整理し lib.rs から register

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use pdfium_render::prelude::*;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

const PDF_RENDER_DPI: f32 = 300.0;

// 進行中の install_ai_models プロセス (PowerShell.exe) の PID。
// cancel_ai_install から taskkill /T /F でプロセスツリーごと殺すために保持。
fn install_pid_holder() -> &'static Mutex<Option<u32>> {
    static H: OnceLock<Mutex<Option<u32>>> = OnceLock::new();
    H.get_or_init(|| Mutex::new(None))
}

fn user_runtime_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .local_data_dir()
        .map_err(|e| format!("local_data_dir取得失敗: {}", e))?;
    Ok(base.join("PsDesign").join("ai-runtime"))
}

fn resolve_mokuro_exe(app: &AppHandle) -> Result<PathBuf, String> {
    let candidates: Vec<PathBuf> = vec![
        // 1. ユーザーデータ領域 (本番: AIインストールでここに展開される)
        user_runtime_dir(app).ok().map(|p| p.join("Scripts/mokuro.exe")),
        // 2. インストーラに同梱されているケース (将来用、現在は無し)
        app.path()
            .resource_dir()
            .ok()
            .map(|p| p.join("resources/ai-runtime/Scripts/mokuro.exe")),
        // 3. 開発時のローカルセットアップ
        Some(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("resources/ai-runtime/Scripts/mokuro.exe"),
        ),
    ]
    .into_iter()
    .flatten()
    .collect();

    for c in &candidates {
        if c.exists() {
            return Ok(c.clone());
        }
    }
    Err(format!(
        "AIランタイム未セットアップ。探したパス: {:?}",
        candidates
    ))
}

fn resolve_setup_script(app: &AppHandle) -> Result<PathBuf, String> {
    let candidates: Vec<PathBuf> = vec![
        app.path()
            .resource_dir()
            .ok()
            .map(|p| p.join("resources/scripts/install-ai-models.ps1")),
        app.path()
            .resource_dir()
            .ok()
            .map(|p| p.join("scripts/install-ai-models.ps1")),
        Some(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("scripts/install-ai-models.ps1"),
        ),
    ]
    .into_iter()
    .flatten()
    .collect();

    for c in &candidates {
        if c.exists() {
            return Ok(c.clone());
        }
    }
    Err(format!(
        "AIインストールスクリプトが見つかりません: {:?}",
        candidates
    ))
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct MokuroBlock {
    #[serde(rename = "box")]
    pub bbox: [f64; 4],
    pub vertical: bool,
    pub font_size: f64,
    pub lines: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct MokuroPage {
    pub img_width: u32,
    pub img_height: u32,
    pub img_path: String,
    pub blocks: Vec<MokuroBlock>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct MokuroDocument {
    pub version: String,
    pub title: String,
    pub volume: String,
    pub pages: Vec<MokuroPage>,
}

#[derive(Serialize, Clone, Debug)]
struct LogEvent {
    line: String,
    stream: &'static str,
}

#[derive(Serialize, Clone, Debug)]
struct ProgressEvent {
    phase: &'static str,
    current: u32,
    total: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    eta: Option<String>,
}

fn parse_mokuro_progress(line: &str) -> Option<(u32, u32, Option<String>)> {
    let key = "Processing pages";
    let pos = line.rfind(key)?;
    let rest = &line[pos + key.len()..];
    let after_first = rest.find('|')?;
    let after_first_slice = &rest[after_first + 1..];
    let after_second = after_first_slice.find('|')?;
    let segment = after_first_slice[after_second + 1..].trim_start();
    let frac_end = segment
        .find(|c: char| c.is_whitespace() || c == '[')
        .unwrap_or(segment.len());
    let frac = &segment[..frac_end];
    let mut parts = frac.split('/');
    let n: u32 = parts.next()?.trim().parse().ok()?;
    let total: u32 = parts.next()?.trim().parse().ok()?;
    let eta = segment.find('[').and_then(|s| {
        segment[s..]
            .find(']')
            .map(|e| segment[s + 1..s + e].to_string())
    });
    Some((n, total, eta))
}

// stdout/stderr を `\n` だけでなく `\r` でも分割して chunk ごとにコールバック。
// mokuro (tqdm) は `\r` でしか進捗バーを refresh しないため、std の
// `BufReader::lines()` (`\n` 区切り) では mokuro が終了するまで一行も yield されず、
// OCR 中の進捗がまったく UI に届かなくなる。これを回避するためのヘルパ。
fn read_chunks_cr_lf<R: Read, F: FnMut(String)>(reader: R, mut on_line: F) {
    let mut br = BufReader::with_capacity(4096, reader);
    let mut leftover: Vec<u8> = Vec::with_capacity(256);
    let mut buf = [0u8; 4096];
    loop {
        let n = match br.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        let mut start = 0usize;
        for i in 0..n {
            let b = buf[i];
            if b == b'\n' || b == b'\r' {
                leftover.extend_from_slice(&buf[start..i]);
                if !leftover.is_empty() {
                    let s = String::from_utf8_lossy(&leftover).into_owned();
                    on_line(s);
                    leftover.clear();
                }
                start = i + 1;
            }
        }
        if start < n {
            leftover.extend_from_slice(&buf[start..n]);
        }
    }
    if !leftover.is_empty() {
        let s = String::from_utf8_lossy(&leftover).into_owned();
        on_line(s);
    }
}

struct TempDirGuard {
    path: PathBuf,
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn make_pdfium(app: &AppHandle) -> Result<Pdfium, String> {
    let dll_path = resolve_pdfium_dll(app)?;
    let bindings = Pdfium::bind_to_library(dll_path)
        .map_err(|e| format!("pdfium DLL読み込み失敗: {:?}", e))?;
    Ok(Pdfium::new(bindings))
}

fn resolve_pdfium_dll(app: &AppHandle) -> Result<PathBuf, String> {
    let candidates: Vec<PathBuf> = vec![
        app.path()
            .resource_dir()
            .ok()
            .map(|p| p.join("resources/pdfium/pdfium.dll")),
        app.path()
            .resource_dir()
            .ok()
            .map(|p| p.join("pdfium.dll")),
        Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/pdfium/pdfium.dll")),
    ]
    .into_iter()
    .flatten()
    .collect();

    for c in &candidates {
        if c.exists() {
            return Ok(c.clone());
        }
    }
    Err(format!(
        "pdfium.dllが見つかりません: 探したパス={:?}",
        candidates
    ))
}

fn natural_sort_key(s: &str) -> Vec<(bool, String, u64)> {
    let mut out = Vec::new();
    let mut buf = String::new();
    let mut is_num = false;
    for c in s.chars() {
        let d = c.is_ascii_digit();
        if buf.is_empty() {
            is_num = d;
            buf.push(c);
        } else if d == is_num {
            buf.push(c);
        } else {
            push_token(&mut out, &buf, is_num);
            buf.clear();
            is_num = d;
            buf.push(c);
        }
    }
    if !buf.is_empty() {
        push_token(&mut out, &buf, is_num);
    }
    out
}

fn push_token(out: &mut Vec<(bool, String, u64)>, s: &str, is_num: bool) {
    if is_num {
        let n = s.parse::<u64>().unwrap_or(u64::MAX);
        out.push((true, String::new(), n));
    } else {
        out.push((false, s.to_lowercase(), 0));
    }
}

fn is_pdf(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("pdf"))
        .unwrap_or(false)
}

fn render_pdf_pages(
    app: &AppHandle,
    pdfium: &Pdfium,
    pdf_path: &Path,
    out_dir: &Path,
    base_index: usize,
    overall_total: u32,
    pad: usize,
) -> Result<usize, String> {
    let doc = pdfium
        .load_pdf_from_file(pdf_path, None)
        .map_err(|e| format!("PDF読み込み失敗 {}: {:?}", pdf_path.display(), e))?;

    let render_config = PdfRenderConfig::new()
        .scale_page_by_factor(PDF_RENDER_DPI / 72.0);

    let total = doc.pages().len();
    for (i, page) in doc.pages().iter().enumerate() {
        let bitmap = page
            .render_with_config(&render_config)
            .map_err(|e| format!("PDFページ描画失敗: {:?}", e))?;
        let img = bitmap.as_image();
        let dest = out_dir.join(format!(
            "page_{:0width$}.jpg",
            base_index + i + 1,
            width = pad
        ));
        img.to_rgb8()
            .save_with_format(&dest, image::ImageFormat::Jpeg)
            .map_err(|e| format!("JPG保存失敗 {}: {}", dest.display(), e))?;

        app.emit(
            "ai_ocr:progress",
            ProgressEvent {
                phase: "pdf",
                current: (base_index + i + 1) as u32,
                total: overall_total,
                eta: None,
            },
        )
        .ok();
        app.emit(
            "ai_ocr:log",
            LogEvent {
                line: format!(
                    "PDF展開: {} ({}/{}) → {}",
                    pdf_path.file_name().unwrap_or_default().to_string_lossy(),
                    i + 1,
                    total,
                    dest.file_name().unwrap_or_default().to_string_lossy()
                ),
                stream: "stdout",
            },
        )
        .ok();
    }
    Ok(total as usize)
}

fn make_temp_volume(
    app: &AppHandle,
    files: &[String],
) -> Result<(TempDirGuard, PathBuf, String), String> {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let parent = std::env::temp_dir().join(format!("psdesign-ai-{}", ts));
    let volume_name = "volume".to_string();
    let volume_dir = parent.join(&volume_name);
    std::fs::create_dir_all(&volume_dir)
        .map_err(|e| format!("テンポラリ作成失敗: {}", e))?;

    let guard = TempDirGuard {
        path: parent.clone(),
    };

    let mut sorted = files.to_vec();
    sorted.sort_by(|a, b| {
        let ka = natural_sort_key(
            Path::new(a)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .as_ref(),
        );
        let kb = natural_sort_key(
            Path::new(b)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .as_ref(),
        );
        ka.cmp(&kb)
    });

    let needs_pdf = sorted.iter().any(|p| is_pdf(Path::new(p)));
    let pdfium = if needs_pdf { Some(make_pdfium(app)?) } else { None };

    let mut overall_total: u32 = 0;
    for src in &sorted {
        let p = Path::new(src);
        if is_pdf(p) {
            let pdfium_ref = pdfium.as_ref().expect("pdfium when PDFs present");
            let pdf = pdfium_ref
                .load_pdf_from_file(p, None)
                .map_err(|e| format!("PDF読み込み失敗 {}: {:?}", p.display(), e))?;
            overall_total += pdf.pages().len() as u32;
        } else {
            overall_total += 1;
        }
    }

    app.emit(
        "ai_ocr:progress",
        ProgressEvent {
            phase: "pdf",
            current: 0,
            total: overall_total,
            eta: None,
        },
    )
    .ok();

    let pad = (overall_total as usize).to_string().len().max(4);
    let mut idx: usize = 0;
    for src in &sorted {
        let src_path = PathBuf::from(src);
        if is_pdf(&src_path) {
            let pdfium_ref = pdfium.as_ref().expect("pdfium when PDFs present");
            let n = render_pdf_pages(app, pdfium_ref, &src_path, &volume_dir, idx, overall_total, pad)?;
            idx += n;
        } else {
            let ext = src_path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("jpg")
                .to_lowercase();
            idx += 1;
            let dest = volume_dir.join(format!("page_{:0width$}.{}", idx, ext, width = pad));
            std::fs::copy(&src_path, &dest)
                .map_err(|e| format!("コピー失敗 {}: {}", src, e))?;
            app.emit(
                "ai_ocr:progress",
                ProgressEvent {
                    phase: "pdf",
                    current: idx as u32,
                    total: overall_total,
                    eta: None,
                },
            )
            .ok();
        }
    }
    Ok((guard, parent, volume_name))
}

#[tauri::command]
pub async fn run_ai_ocr(
    app: AppHandle,
    files: Vec<String>,
    force_cpu: Option<bool>,
) -> Result<MokuroDocument, String> {
    if files.is_empty() {
        return Err("ファイルが選択されていません".to_string());
    }
    let mokuro_path = resolve_mokuro_exe(&app)?;

    let (_guard, parent_dir, volume_name) = make_temp_volume(&app, &files)?;

    app.emit("ai_ocr:start", &volume_name).ok();

    let mut cmd = Command::new(&mokuro_path);
    cmd.arg("--disable_confirmation=True")
        .arg("--legacy_html=False")
        .arg("--parent_dir")
        .arg(parent_dir.as_os_str())
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONUTF8", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if force_cpu.unwrap_or(false) {
        cmd.arg("--force_cpu");
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("mokuroの起動に失敗しました: {}", e))?;

    let stdout = child.stdout.take().expect("stdout pipe");
    let stderr = child.stderr.take().expect("stderr pipe");

    let app_out = app.clone();
    let stdout_handle = std::thread::spawn(move || {
        read_chunks_cr_lf(stdout, |line| {
            if let Some((current, total, eta)) = parse_mokuro_progress(&line) {
                app_out
                    .emit(
                        "ai_ocr:progress",
                        ProgressEvent {
                            phase: "ocr",
                            current,
                            total,
                            eta,
                        },
                    )
                    .ok();
            }
            app_out
                .emit(
                    "ai_ocr:log",
                    LogEvent {
                        line,
                        stream: "stdout",
                    },
                )
                .ok();
        });
    });

    let app_err = app.clone();
    let stderr_handle = std::thread::spawn(move || {
        read_chunks_cr_lf(stderr, |line| {
            if let Some((current, total, eta)) = parse_mokuro_progress(&line) {
                app_err
                    .emit(
                        "ai_ocr:progress",
                        ProgressEvent {
                            phase: "ocr",
                            current,
                            total,
                            eta,
                        },
                    )
                    .ok();
            }
            app_err
                .emit(
                    "ai_ocr:log",
                    LogEvent {
                        line,
                        stream: "stderr",
                    },
                )
                .ok();
        });
    });

    let status = child
        .wait()
        .map_err(|e| format!("mokuroの待機に失敗しました: {}", e))?;
    stdout_handle.join().ok();
    stderr_handle.join().ok();

    let mokuro_file = parent_dir.join(format!("{}.mokuro", volume_name));
    let mokuro_file_exists = mokuro_file.exists();

    if !status.success() && !mokuro_file_exists {
        return Err(format!(
            "mokuroが異常終了しました (exit code {:?})",
            status.code()
        ));
    }
    if !status.success() {
        // PyTorch/CUDAのatexitで非ゼロ終了することがある。
        // .mokuroが書き出されていれば処理自体は成功しているので続行。
        app.emit(
            "ai_ocr:log",
            LogEvent {
                line: format!(
                    "[警告] mokuroが exit {:?} で終了しましたが、.mokuroファイルは生成されています。続行します。",
                    status.code()
                ),
                stream: "stderr",
            },
        )
        .ok();
    }

    let content = std::fs::read_to_string(&mokuro_file).map_err(|e| {
        format!(
            "{}が読めませんでした: {}",
            mokuro_file.to_string_lossy(),
            e
        )
    })?;
    let doc: MokuroDocument = serde_json::from_str(&content)
        .map_err(|e| format!(".mokuroのパースに失敗しました: {}", e))?;

    Ok(doc)
    // _guard drops here → temp dir removed
}

#[tauri::command]
pub fn export_ai_text(content: String, output_path: String) -> Result<(), String> {
    std::fs::write(&output_path, content).map_err(|e| format!("書き込み失敗: {}", e))?;
    Ok(())
}

#[derive(Serialize, Clone, Debug)]
pub struct RuntimeStatus {
    available: bool,
    path: Option<String>,
    user_runtime_dir: Option<String>,
}

#[tauri::command]
pub fn check_ai_models(app: AppHandle) -> RuntimeStatus {
    let resolved = resolve_mokuro_exe(&app);
    RuntimeStatus {
        available: resolved.is_ok(),
        path: resolved.ok().map(|p| p.to_string_lossy().to_string()),
        user_runtime_dir: user_runtime_dir(&app)
            .ok()
            .map(|p| p.to_string_lossy().to_string()),
    }
}

#[tauri::command]
pub async fn install_ai_models(app: AppHandle) -> Result<(), String> {
    let script = resolve_setup_script(&app)?;
    let target = user_runtime_dir(&app)?;
    std::fs::create_dir_all(target.parent().unwrap_or(&target))
        .map_err(|e| format!("ターゲット親フォルダ作成失敗: {}", e))?;

    app.emit("ai_install:start", target.to_string_lossy().to_string())
        .ok();

    let mut cmd = Command::new("powershell.exe");
    cmd.arg("-NoProfile")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-File")
        .arg(&script)
        .arg("-RuntimeDir")
        .arg(&target)
        // Python サブプロセスのstdout buffering / cp932 / Pipe to stdout was broken
        // 対策。PowerShell から呼ばれる pip / python -c が安定する。
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONLEGACYWINDOWSSTDIO", "0")
        .env("PYTHONUTF8", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("AIインストール起動失敗: {}", e))?;

    // PID を共有領域に格納 (cancel_ai_install から参照するため)
    {
        let mut guard = install_pid_holder().lock().unwrap();
        *guard = Some(child.id());
    }

    let stdout = child.stdout.take().expect("stdout pipe");
    let stderr = child.stderr.take().expect("stderr pipe");

    let app_out = app.clone();
    let h1 = std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            app_out
                .emit(
                    "ai_install:log",
                    LogEvent {
                        line,
                        stream: "stdout",
                    },
                )
                .ok();
        }
    });
    let app_err = app.clone();
    let h2 = std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            app_err
                .emit(
                    "ai_install:log",
                    LogEvent {
                        line,
                        stream: "stderr",
                    },
                )
                .ok();
        }
    });

    let status = child
        .wait()
        .map_err(|e| format!("AIインストール待機失敗: {}", e))?;
    h1.join().ok();
    h2.join().ok();

    // PID クリア (成功・失敗・キャンセル いずれの場合も)
    // cancel 経由で install_pid_holder.take() 済みなら None になっている。
    let was_cancelled = install_pid_holder().lock().unwrap().take().is_none()
        && !status.success();

    if was_cancelled {
        return Err("AIインストールを中止しました".to_string());
    }

    if !status.success() {
        return Err(format!(
            "AIインストールが異常終了 (exit code {:?})",
            status.code()
        ));
    }

    app.emit("ai_install:done", ()).ok();
    Ok(())
}

/// 進行中の AIインストール (PowerShell プロセス) を中止する。
/// `taskkill /T /F /PID <pid>` でプロセスツリー (PowerShell + 子の Python / pip) を強制終了する。
/// PID は install_ai_models 内で記録されており、ここで take() することで
/// 後段の wait() からは「キャンセルされた」状態として認識される。
#[tauri::command]
pub fn cancel_ai_install() -> Result<(), String> {
    let pid_opt = install_pid_holder().lock().unwrap().take();
    if let Some(pid) = pid_opt {
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .output();
    }
    Ok(())
}
