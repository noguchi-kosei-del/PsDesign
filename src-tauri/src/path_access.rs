// 【セキュリティ Phase 2 + Phase 3-lite】ローカルファイルアクセス制御の中核モジュール。
//
// 設計（セキュリティ標準設計ガイドライン / セキュリティ修正手順 準拠）:
//   - Rust 側でセッション中の「許可リスト (AllowedPaths)」を保持する。
//   - read/write/list などの利用系コマンドは入口で `ensure_allowed()` を通し、
//     未登録パスは保護フォルダかどうかに関係なく `forbidden path` を返す。
//   - 許可リストへ登録してよい入口は信頼できる経路のみ:
//       1. open_picker で発行した pickerSessionId + Rust 側 token の確定 (confirm_*)
//       2. 実 Drag & Drop (Rust の WindowEvent::DragDrop でメインプロセスが直接受領)
//       3. 起動引数 / ファイル関連付け (OS がアプリを起動した実体パス)
//       4. アプリ既定の固定業務フォルダ (Script_Output / 共有ドライブ業務サブ / フォントディレクトリ)
//   - renderer から任意パス文字列を渡して登録する API は公開しない (authorize_user_paths 禁止)。
//   - 判定は必ず std::fs::canonicalize で実体パスへ解決してから行う (.. / シンボリックリンク迂回防止)。
//   - 保存先など未作成ファイルは、親ディレクトリを canonicalize してからファイル名を結合して判定する。

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

// picker セッションの有効期間。期限切れ後は browse / confirm を拒否し、新規 open を許可する。
const PICKER_SESSION_TTL: Duration = Duration::from_secs(15 * 60);
// browse_* のレートリミット: 10 秒あたり 50 回まで（XSS による高速列挙の抑止）。
const BROWSE_WINDOW: Duration = Duration::from_secs(10);
const BROWSE_MAX_IN_WINDOW: usize = 50;

// ===================== 乱数トークン (OS Secure Random) =====================

// OS の乱数生成器 (getrandom = OS random source) から hex 文字列を作る。
// 連番カウンタ (p1, p2, ...) は使わない。renderer による token 推測を防ぐ。
fn random_hex(nbytes: usize) -> String {
    let mut buf = vec![0u8; nbytes];
    // OS random source。失敗時はパニックさせず、時刻ベースの弱い fallback は使わない
    // （予測可能トークンを発行しないため、失敗時は空にしてエラー扱いにする）。
    if getrandom::getrandom(&mut buf).is_err() {
        return String::new();
    }
    let mut out = String::with_capacity(nbytes * 2);
    for b in &buf {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

fn new_session_id() -> String {
    format!("picker-{}", random_hex(16))
}

fn new_candidate_token() -> String {
    format!("p-{}", random_hex(16))
}

// ===================== 許可リスト =====================

#[derive(Default)]
pub struct AllowedPaths {
    inner: Mutex<HashSet<PathBuf>>,
}

impl AllowedPaths {
    // 実体パスを許可リストへ登録する（既に canonical 済みのものを受け取る）。
    fn insert_canonical(&self, real: PathBuf) {
        if let Ok(mut set) = self.inner.lock() {
            set.insert(real);
        }
    }

    // 任意のパス文字列を canonicalize して登録する（信頼できる入口からのみ呼ぶこと）。
    // 戻り値は canonical path（存在しないパスは登録しない）。
    pub fn register_real(&self, path: &str) -> Option<PathBuf> {
        let real = std::fs::canonicalize(path).ok()?;
        self.insert_canonical(real.clone());
        Some(real)
    }

    pub fn register_path(&self, path: &Path) -> Option<PathBuf> {
        let real = std::fs::canonicalize(path).ok()?;
        self.insert_canonical(real.clone());
        Some(real)
    }

    // 実体パス real が許可済みか。登録された実体パスそのもの、またはその配下なら許可。
    fn is_allowed_canonical(&self, real: &Path) -> bool {
        let set = match self.inner.lock() {
            Ok(s) => s,
            Err(_) => return false,
        };
        set.iter()
            .any(|allowed| real == allowed.as_path() || real.starts_with(allowed))
    }
}

// 既存パス用: canonicalize して許可判定。許可なら canonical path を返す。
pub fn ensure_allowed(allowed: &AllowedPaths, path: &str) -> Result<PathBuf, String> {
    let real =
        std::fs::canonicalize(path).map_err(|_| format!("forbidden path: {}", path))?;
    if allowed.is_allowed_canonical(&real) {
        Ok(real)
    } else {
        Err(format!("forbidden path: {}", path))
    }
}

// 保存 / 新規作成用: 対象ファイルやその親フォルダがまだ存在しない場合に対応する。
// プロジェクト保存などは projectDir/PSD/... を「書き込み時に create_dir_all で作る」前提なので、
// 親が未作成でも、実在する最も近い祖先を canonicalize して「許可ルート配下」なら許可する。
// canonicalize は `..` / シンボリックリンクを実体解決するため、未作成部分を使った迂回はできない。
pub fn ensure_allowed_for_write(allowed: &AllowedPaths, path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    if p.exists() {
        return ensure_allowed(allowed, path);
    }
    // 未作成パスは canonicalize で実体解決できないため、`..` / `.` を含むものは拒否する。
    // これが無いと、許可祖先の判定後に create_dir_all が `..` を解決して許可ルート外へ
    // 書き込めてしまう（例: <許可>\new\..\..\evil\x.txt）。正規の保存パスは `..` を含まない。
    if p
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir | std::path::Component::CurDir))
    {
        return Err(format!("forbidden path: {}", path));
    }
    // 実在する最も近い祖先を探す。
    let mut ancestor = p.parent();
    while let Some(a) = ancestor {
        if a.as_os_str().is_empty() {
            break;
        }
        if a.exists() {
            let real =
                std::fs::canonicalize(a).map_err(|_| format!("forbidden path: {}", path))?;
            if allowed.is_allowed_canonical(&real) {
                // 書き込み側で親を create_dir_all してから書く前提。元パスをそのまま返す。
                return Ok(p);
            }
            return Err(format!("forbidden path: {}", path));
        }
        ancestor = a.parent();
    }
    Err(format!("forbidden path: {}", path))
}

// ===================== browse 許可起点 =====================

// ユーザーデータ直下（%USERPROFILE% = C:\Users\<user>）。
// dirs::document_dir() 等は OneDrive 等へリダイレクトされた既知フォルダを返すことがあるため、
// picker の起点はリダイレクトを避けて home 直下の実体（ローカル）を基準にする。
fn user_home() -> Option<PathBuf> {
    dirs::home_dir().and_then(|h| std::fs::canonicalize(&h).ok())
}

// ユーザーデータ直下で見せる既知フォルダ名（ローカル実体）。これ以外（.ssh / AppData 等）は出さない。
const KNOWN_USER_FOLDERS: &[&str] = &[
    "Desktop",
    "Documents",
    "Downloads",
    "Pictures",
    "Videos",
    "Music",
    "Favorites",
    "Links",
    "Searches",
    "Saved Games",
    "Contacts",
];

// browse_* が列挙してよい起点（ホワイトリスト）。ユーザーデータ直下の既知フォルダ + 業務フォルダ。
// C:\ 直下 / C:\Windows / Program Files / AppData / .ssh / ブラウザプロファイル等は含めない。
// OneDrive リダイレクト先ではなく、必ず %USERPROFILE%\<name> のローカル実体を使う。
fn browse_root_set() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(home) = dirs::home_dir() {
        for name in KNOWN_USER_FOLDERS {
            if let Ok(c) = std::fs::canonicalize(home.join(name)) {
                roots.push(c);
            }
        }
    }
    for b in business_folder_seeds() {
        if let Ok(c) = std::fs::canonicalize(&b) {
            roots.push(c);
        }
    }
    roots
}

fn is_user_home(real: &Path) -> bool {
    user_home().map(|h| h == real).unwrap_or(false)
}

// 列挙を許可する実体パスか。既知フォルダ/業務フォルダ「配下」、または「ユーザーデータ直下そのもの」。
// ユーザーデータ直下の任意の子（.ssh / AppData 等）は許可しない（移動はできても自由列挙はさせない）。
fn is_under_browse_root(real: &Path) -> bool {
    if is_user_home(real) {
        return true;
    }
    browse_root_set()
        .iter()
        .any(|root| real == root.as_path() || real.starts_with(root))
}

// ===================== 起動時に許可シードする固定業務フォルダ =====================

// アプリ既定の業務フォルダ（読み書きの起点として起動時に許可リストへシードする）。
// 存在しないパスは register 時に自動でスキップされる。
pub fn business_folder_seeds() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    // 出力 / プロジェクト / 写植完了 / OPUSテキスト 等はすべて Script_Output 配下。
    // アプリ内部は dirs::desktop_dir()（OneDrive の場合あり）とローカル home\Desktop の
    // 両方を使い得るので、両方を許可しておき保存先のズレで forbidden にならないようにする。
    if let Some(desktop) = dirs::desktop_dir() {
        out.push(desktop.join("Script_Output"));
    }
    if let Some(home) = dirs::home_dir() {
        out.push(home.join("Desktop").join("Script_Output"));
    }
    // 共有ドライブの業務サブフォルダ（校正 JSON / スタイルパレット JSON / OCR）。
    out.push(PathBuf::from(
        r"G:\共有ドライブ\CLLENN\編集部フォルダ\編集企画部\写植・校正用テキストログ",
    ));
    out.push(PathBuf::from(
        r"G:\共有ドライブ\CLLENN\編集部フォルダ\編集企画部\編集企画_C班(AT業務推進)\DTP制作部\JSONフォルダ",
    ));
    out.push(PathBuf::from(
        r"G:\共有ドライブ\ソニーからのデータ受領\編集企画_AT業務推進\DTP制作部\OCR",
    ));
    out.push(PathBuf::from(
        r"G:\共有ドライブ\CLLENN\編集部フォルダ\編集企画部\編集企画_AT業務推進\DTP制作部\PDF読み取り",
    ));
    out
}

// 起動時にシードする（business folders + フォントディレクトリ）。
pub fn seed_allowed(allowed: &AllowedPaths) {
    // ローカルの出力ルート（Desktop\Script_Output）は起動時に存在しないと canonicalize できず
    // 許可登録されない → 初回起動時に保存系が forbidden になる。先に作成してから登録する。
    // 共有ドライブ (G:) はネットワーク先なので自動作成しない（存在すれば register される）。
    if let Some(desktop) = dirs::desktop_dir() {
        let _ = std::fs::create_dir_all(desktop.join("Script_Output"));
    }
    if let Some(home) = dirs::home_dir() {
        let _ = std::fs::create_dir_all(home.join("Desktop").join("Script_Output"));
    }
    for b in business_folder_seeds() {
        let _ = allowed.register_path(&b);
    }
    // フォントディレクトリ（read_font_face_bytes 用、フォントは秘匿情報ではない）。
    if let Ok(windir) = std::env::var("SystemRoot").or_else(|_| std::env::var("windir")) {
        let _ = allowed.register_path(&PathBuf::from(windir).join("Fonts"));
    }
    if let Some(local) = dirs::data_local_dir() {
        let _ = allowed.register_path(&local.join("Microsoft").join("Windows").join("Fonts"));
    }
}

// ===================== picker セッション =====================

struct PickerSession {
    id: String,
    created: Instant,
    candidates: HashMap<String, PathBuf>, // token -> canonical real path
    browse_times: Vec<Instant>,
}

impl PickerSession {
    fn is_expired(&self) -> bool {
        self.created.elapsed() > PICKER_SESSION_TTL
    }
}

#[derive(Default)]
pub struct PickerState {
    inner: Mutex<Option<PickerSession>>,
}

#[derive(Serialize)]
pub struct PickerOpenResult {
    #[serde(rename = "pickerSessionId")]
    picker_session_id: String,
}

#[derive(Serialize)]
pub struct BrowseEntry {
    name: String,
    #[serde(rename = "isDirectory")]
    is_directory: bool,
    #[serde(rename = "isFile")]
    is_file: bool,
    // 子要素の実パスは返さない。確定 (confirm) 時に使う候補 token のみを返す。
    token: String,
}

#[derive(Serialize)]
pub struct BrowsePathInfo {
    name: String,
    #[serde(rename = "isDirectory")]
    is_directory: bool,
    #[serde(rename = "isFile")]
    is_file: bool,
    #[serde(rename = "sizeBytes")]
    size_bytes: u64,
    token: String,
}

#[derive(Serialize)]
pub struct BrowseRoot {
    name: String,
    // 既知の公開フォルダ（デスクトップ等）。秘匿情報ではないので表示用に path を返す。
    path: String,
}

impl PickerState {
    // 有効なセッションを取り出す（無効 / 期限切れは None）。
    fn with_valid_session<T>(
        &self,
        session_id: &str,
        f: impl FnOnce(&mut PickerSession) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut guard = self.inner.lock().map_err(|_| "picker lock".to_string())?;
        match guard.as_mut() {
            Some(s) if s.id == session_id && !s.is_expired() => f(s),
            _ => Err("forbidden path: invalid picker session".to_string()),
        }
    }
}

fn check_rate_limit(session: &mut PickerSession) -> Result<(), String> {
    let now = Instant::now();
    session
        .browse_times
        .retain(|t| now.duration_since(*t) < BROWSE_WINDOW);
    if session.browse_times.len() >= BROWSE_MAX_IN_WINDOW {
        return Err("forbidden path: browse rate limit exceeded".to_string());
    }
    session.browse_times.push(now);
    Ok(())
}

// ----- 公開コマンド -----

// 新規 picker セッションを開く。有効な既存セッションがある間は拒否（二重起動防止）。
#[tauri::command]
pub async fn open_picker(
    picker: tauri::State<'_, PickerState>,
) -> Result<PickerOpenResult, String> {
    let mut guard = picker.inner.lock().map_err(|_| "picker lock".to_string())?;
    if let Some(s) = guard.as_ref() {
        if !s.is_expired() {
            return Err("forbidden path: picker already open".to_string());
        }
    }
    let id = new_session_id();
    if id.is_empty() {
        return Err("picker session generation failed".to_string());
    }
    *guard = Some(PickerSession {
        id: id.clone(),
        created: Instant::now(),
        candidates: HashMap::new(),
        browse_times: Vec::new(),
    });
    Ok(PickerOpenResult {
        picker_session_id: id,
    })
}

// picker セッションを破棄する（候補 token も破棄）。
#[tauri::command]
pub async fn close_picker(
    picker: tauri::State<'_, PickerState>,
    #[allow(non_snake_case)] pickerSessionId: String,
) -> Result<(), String> {
    let mut guard = picker.inner.lock().map_err(|_| "picker lock".to_string())?;
    if let Some(s) = guard.as_ref() {
        if s.id == pickerSessionId {
            *guard = None;
        }
    }
    Ok(())
}

// browse の起点候補（既知の公開フォルダ）。モニタ/ホームボタン用。
#[tauri::command]
pub async fn picker_roots(
    picker: tauri::State<'_, PickerState>,
    #[allow(non_snake_case)] pickerSessionId: String,
) -> Result<Vec<BrowseRoot>, String> {
    picker.with_valid_session(&pickerSessionId, |_s| {
        // OneDrive リダイレクト先ではなく、ユーザーデータ直下（%USERPROFILE%）の実体を返す。
        let labels: &[(&str, &str)] = &[
            ("Desktop", "デスクトップ"),
            ("Documents", "ドキュメント"),
            ("Downloads", "ダウンロード"),
            ("Pictures", "ピクチャ"),
            ("Videos", "ビデオ"),
            ("Music", "ミュージック"),
        ];
        let mut out = Vec::new();
        if let Some(home) = dirs::home_dir() {
            for (folder, name) in labels {
                if let Ok(c) = std::fs::canonicalize(home.join(folder)) {
                    out.push(BrowseRoot {
                        name: name.to_string(),
                        path: c.to_string_lossy().to_string(),
                    });
                }
            }
        }
        Ok(out)
    })
}

// 指定ディレクトリを列挙する。セッション必須 / レートリミット / 許可起点配下のみ。
// 子要素は表示名 + 種別 + token のみを返す（実パスは返さない）。
#[tauri::command]
pub async fn browse_directory_entries(
    picker: tauri::State<'_, PickerState>,
    #[allow(non_snake_case)] pickerSessionId: String,
    path: String,
) -> Result<Vec<BrowseEntry>, String> {
    picker.with_valid_session(&pickerSessionId, |s| {
        check_rate_limit(s)?;
        let real = std::fs::canonicalize(&path)
            .map_err(|_| format!("forbidden path: {}", path))?;
        if !is_under_browse_root(&real) {
            return Err(format!("forbidden path: {}", path));
        }
        // ユーザーデータ直下では、既知フォルダ以外（.ssh / AppData 等）を一切見せない。
        let at_home = is_user_home(&real);
        let read = std::fs::read_dir(&real)
            .map_err(|_| format!("forbidden path: {}", path))?;
        let mut out = Vec::new();
        for entry in read.filter_map(|e| e.ok()) {
            let p = entry.path();
            let meta = match std::fs::metadata(&p) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let is_dir = meta.is_dir();
            let is_file = meta.is_file();
            if !is_dir && !is_file {
                continue;
            }
            let name = match p.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            if at_home && (!is_dir || !KNOWN_USER_FOLDERS.contains(&name.as_str())) {
                continue;
            }
            // 子の canonical 実パスを候補として保持し、token のみ返す。
            let child_real = std::fs::canonicalize(&p).unwrap_or(p);
            let token = new_candidate_token();
            if token.is_empty() {
                continue;
            }
            s.candidates.insert(token.clone(), child_real);
            out.push(BrowseEntry {
                name,
                is_directory: is_dir,
                is_file,
                token,
            });
        }
        Ok(out)
    })
}

// 指定パスの情報を返す。セッション必須 / レートリミット / 許可起点配下のみ。
// 実パスは返さず token を返す（保存先ディレクトリの token 取得などに使う）。
#[tauri::command]
pub async fn browse_path_info(
    picker: tauri::State<'_, PickerState>,
    #[allow(non_snake_case)] pickerSessionId: String,
    path: String,
) -> Result<BrowsePathInfo, String> {
    picker.with_valid_session(&pickerSessionId, |s| {
        check_rate_limit(s)?;
        let real = std::fs::canonicalize(&path)
            .map_err(|_| format!("forbidden path: {}", path))?;
        if !is_under_browse_root(&real) {
            return Err(format!("forbidden path: {}", path));
        }
        let meta = std::fs::metadata(&real)
            .map_err(|_| format!("forbidden path: {}", path))?;
        let name = real
            .file_name()
            .and_then(|n| n.to_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| path.clone());
        let token = new_candidate_token();
        if token.is_empty() {
            return Err("token generation failed".to_string());
        }
        s.candidates.insert(token.clone(), real.clone());
        Ok(BrowsePathInfo {
            name,
            is_directory: meta.is_dir(),
            is_file: meta.is_file(),
            size_bytes: meta.len(),
            token,
        })
    })
}

// token 群を確定して許可リストへ登録し、解決済み実パスを返す。
// 無効 token / 期限切れ / close 後 / セッション外 confirm は forbidden path。
#[tauri::command]
pub async fn confirm_file_picker_selection(
    picker: tauri::State<'_, PickerState>,
    allowed: tauri::State<'_, AllowedPaths>,
    #[allow(non_snake_case)] pickerSessionId: String,
    tokens: Vec<String>,
) -> Result<Vec<String>, String> {
    picker.with_valid_session(&pickerSessionId, |s| {
        let mut out = Vec::new();
        for t in &tokens {
            let candidate = s
                .candidates
                .get(t)
                .ok_or_else(|| "forbidden path: invalid token".to_string())?;
            // 候補は browse 時点の canonical。確定時に再度 canonicalize して検証する。
            let real = std::fs::canonicalize(candidate)
                .map_err(|_| "forbidden path: token no longer resolvable".to_string())?;
            allowed.insert_canonical(real.clone());
            if real.is_file() {
                if let Some(parent) = real.parent() {
                    allowed.insert_canonical(parent.to_path_buf());
                }
            }
            out.push(real.to_string_lossy().to_string());
        }
        Ok(out)
    })
}

// 保存先を確定する。pickerSessionId + directoryToken + fileName のみ受け付ける。
// fileName は厳格検証し、ディレクトリトークン配下のフルパスを登録して返す。
#[tauri::command]
pub async fn confirm_file_picker_save_path(
    picker: tauri::State<'_, PickerState>,
    allowed: tauri::State<'_, AllowedPaths>,
    #[allow(non_snake_case)] pickerSessionId: String,
    #[allow(non_snake_case)] directoryToken: String,
    #[allow(non_snake_case)] fileName: String,
) -> Result<String, String> {
    validate_save_file_name(&fileName)?;
    picker.with_valid_session(&pickerSessionId, |s| {
        let dir = s
            .candidates
            .get(&directoryToken)
            .ok_or_else(|| "forbidden path: invalid token".to_string())?;
        let dir_real = std::fs::canonicalize(dir)
            .map_err(|_| "forbidden path: token no longer resolvable".to_string())?;
        if !dir_real.is_dir() {
            return Err("forbidden path: directory token is not a directory".to_string());
        }
        let full = dir_real.join(&fileName);
        allowed.insert_canonical(full.clone());
        Ok(full.to_string_lossy().to_string())
    })
}

// 保存ファイル名の厳格検証（セキュリティ標準設計ガイドライン 5.3）。
pub fn validate_save_file_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("forbidden path: empty file name".to_string());
    }
    if name.len() > 180 {
        return Err("forbidden path: file name too long".to_string());
    }
    // 先頭・末尾の空白
    if name != name.trim() {
        return Err("forbidden path: file name has leading/trailing whitespace".to_string());
    }
    // 末尾ドット / 末尾スペース（trim 後でも明示的に）
    if name.ends_with('.') || name.ends_with(' ') {
        return Err("forbidden path: file name ends with dot or space".to_string());
    }
    if name == "." || name == ".." {
        return Err("forbidden path: invalid file name".to_string());
    }
    // 制御文字 + 危険文字 + パス区切り
    for c in name.chars() {
        if c.is_control() {
            return Err("forbidden path: control character in file name".to_string());
        }
        if matches!(
            c,
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
        ) {
            return Err("forbidden path: dangerous character in file name".to_string());
        }
    }
    // Windows 予約名（拡張子を除いた stem で判定、大小無視）
    let stem_upper = name
        .split('.')
        .next()
        .unwrap_or("")
        .to_ascii_uppercase();
    const RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
        "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if RESERVED.contains(&stem_upper.as_str()) {
        return Err("forbidden path: Windows reserved device name".to_string());
    }
    Ok(())
}
