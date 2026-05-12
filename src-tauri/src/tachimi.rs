// Tachimi 起動ロジック。台割マネージャー (Daiwari Manager) の
// src-tauri/src/commands/tachimi.rs から移植。
//
// 主な変更点:
//   - ステージングフォルダ名: daidori_tachimi_staging → psdesign_tachimi_staging
//     （台割マネージャーと PsDesign の同時実行で衝突しないように分離）
//   - trigger JSON のパス (%TEMP%\tachimi_cli_files.json) は Tachimi 側が
//     固定で読みに行く位置なのでそのまま使う（COMIC-Bridge / 台割マネージャーと共有）
//
// 公開コマンド:
//   - detect_tachimi_exe(hint) → Option<String>
//   - launch_tachimi_with_files(exe_path, file_paths) → Result<usize, String>

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

/// 指定パスが tachimi の実行ファイルとして妥当か検証する。
/// （存在チェック + ファイル名末尾 "tachimi.exe" の case-insensitive 一致）
fn is_tachimi_exe(p: &Path) -> bool {
    if !p.is_file() {
        return false;
    }
    let name = p
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    name == "tachimi.exe" || name == "tachimi"
}

/// 既知の候補から tachimi.exe を自動検出する。
/// hint（前回成功パス）→ 開発ビルド（Desktop\Tachimi_開発\...）→ インストール想定パスの順。
/// 見つかれば絶対パスを返し、見つからなければ None を返す。
#[tauri::command]
pub async fn detect_tachimi_exe(hint: Option<String>) -> Option<String> {
    // 1. hint（localStorage 等から渡された前回パス）
    if let Some(h) = hint.as_deref() {
        let p = PathBuf::from(h);
        if is_tachimi_exe(&p) {
            return Some(p.to_string_lossy().to_string());
        }
    }

    let mut candidates: Vec<PathBuf> = Vec::new();

    // 2. 開発ビルド：%USERPROFILE%\Desktop\Tachimi_開発\Tachimi-_Standalone\src-tauri\target\{release,debug}\tachimi.exe
    if let Some(home) = dirs::home_dir() {
        let dev_root = home
            .join("Desktop")
            .join("Tachimi_開発")
            .join("Tachimi-_Standalone")
            .join("src-tauri")
            .join("target");
        candidates.push(dev_root.join("release").join("tachimi.exe"));
        candidates.push(dev_root.join("debug").join("tachimi.exe"));
    }

    // 3. Windows のインストール想定パス
    for env_key in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Ok(base) = std::env::var(env_key) {
            let base_path = PathBuf::from(base);
            candidates.push(base_path.join("Tachimi").join("tachimi.exe"));
            candidates.push(
                base_path
                    .join("Programs")
                    .join("Tachimi")
                    .join("tachimi.exe"),
            );
        }
    }

    // 4. デスクトップ直下に置かれた配布版（あれば）
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join("Desktop").join("tachimi.exe"));
        candidates.push(home.join("Desktop").join("Tachimi").join("tachimi.exe"));
    }

    for c in candidates {
        if is_tachimi_exe(&c) {
            return Some(c.to_string_lossy().to_string());
        }
    }
    None
}

/// 連番プレフィックスを安全な文字列で組み立てる（4桁ゼロ埋め）。
fn stage_filename(idx: usize, src: &Path) -> String {
    let basename = src
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| format!("file_{:04}", idx + 1));
    format!("{:04}_{}", idx + 1, basename)
}

/// 古いステージングフォルダを掃除する（前回実行の残骸を消す）。
/// 失敗は無視（次のステップで新しいフォルダを作るので致命的ではない）。
fn cleanup_old_staging(staging_dir: &Path) {
    if staging_dir.exists() {
        if let Err(e) = fs::remove_dir_all(staging_dir) {
            eprintln!(
                "Tachimi staging - failed to clean old staging dir {}: {}",
                staging_dir.display(),
                e
            );
        }
    }
}

/// すべての PSD ファイルパス群を Tachimi に渡して起動する。
///
/// 設計: 複数 PSD 混在の場合でも Tachimi がファイルを見つけられるよう、
/// `%TEMP%\psdesign_tachimi_staging\` に**ハードリンク**で全ファイルを集約してから渡す。
/// - ハードリンクは同一ボリュームならほぼ即時で I/O ゼロ（NTFS の link 機能）
/// - 跨ボリューム時はファイルコピーへフォールバック
/// - 連番プレフィックス (`0001_`, `0002_`, ...) でページ順序を保持
/// - ファイル名重複も自動回避
///
/// Tachimi 側は起動時に `%TEMP%\tachimi_cli_files.json` の JSON 配列を読み取り、
/// 読み込み後に同ファイルを削除する設計（COMIC-Bridge / 台割マネージャー連携と共有）。
///
/// 戻り値: 実際にステージングに成功したファイル数。
#[tauri::command]
pub async fn launch_tachimi_with_files(
    exe_path: String,
    file_paths: Vec<String>,
) -> Result<usize, String> {
    let exe = Path::new(&exe_path);
    if !exe.exists() || !exe.is_file() {
        return Err(format!(
            "Tachimi の実行ファイルが見つかりません: {}",
            exe_path
        ));
    }

    if file_paths.is_empty() {
        return Err("渡すファイルがありません。".to_string());
    }

    // 存在するファイルだけを抽出（壊れた参照は無視して残りで起動する）
    let valid: Vec<String> = file_paths
        .into_iter()
        .filter(|p| Path::new(p).exists())
        .collect();

    if valid.is_empty() {
        return Err(
            "渡せるファイルが見つかりませんでした（参照先がすべて存在しないか移動されています）。"
                .to_string(),
        );
    }

    // ステージングフォルダ: 前回分を掃除してから新規作成
    let staging_dir = std::env::temp_dir().join("psdesign_tachimi_staging");
    cleanup_old_staging(&staging_dir);
    fs::create_dir_all(&staging_dir).map_err(|e| {
        format!(
            "ステージングフォルダの作成に失敗 ({}): {}",
            staging_dir.display(),
            e
        )
    })?;

    // 全ファイルをハードリンク（失敗時はコピー）でステージングへ集約
    let mut staged_paths: Vec<String> = Vec::with_capacity(valid.len());
    let mut link_errors: Vec<String> = Vec::new();
    for (idx, src) in valid.iter().enumerate() {
        let src_path = Path::new(src);
        let staged_name = stage_filename(idx, src_path);
        let dest = staging_dir.join(&staged_name);

        // 同名既存（前回掃除に失敗した場合などのフェイルセーフ）を除去
        if dest.exists() {
            let _ = fs::remove_file(&dest);
        }

        // 1) ハードリンク: 同一ボリューム内で最速、I/O ほぼゼロ
        let linked = fs::hard_link(src_path, &dest).is_ok();
        // 2) 失敗時はファイルコピー（クロスボリューム / 権限 / FS 非対応など）
        if !linked {
            match fs::copy(src_path, &dest) {
                Ok(_) => {}
                Err(e) => {
                    link_errors.push(format!("{}: {}", src, e));
                    continue;
                }
            }
        }
        staged_paths.push(dest.to_string_lossy().to_string());
    }

    if staged_paths.is_empty() {
        return Err(format!(
            "ステージングに失敗しました ({} 件)。最初の失敗: {}",
            link_errors.len(),
            link_errors.first().cloned().unwrap_or_default()
        ));
    }

    if !link_errors.is_empty() {
        eprintln!(
            "Tachimi staging - {} files staged, {} failed (例: {})",
            staged_paths.len(),
            link_errors.len(),
            link_errors.first().cloned().unwrap_or_default()
        );
    }

    // トリガー JSON を %TEMP%\tachimi_cli_files.json に書き出し
    let trigger_path = std::env::temp_dir().join("tachimi_cli_files.json");
    let json = serde_json::to_string(&staged_paths)
        .map_err(|e| format!("トリガー JSON のシリアライズに失敗: {}", e))?;
    fs::write(&trigger_path, json).map_err(|e| {
        format!(
            "トリガー JSON の書き出しに失敗 ({}): {}",
            trigger_path.display(),
            e
        )
    })?;

    eprintln!(
        "Tachimi launch - staging: {} ({} files), trigger: {}",
        staging_dir.display(),
        staged_paths.len(),
        trigger_path.display()
    );

    // tachimi.exe を spawn（CLI 引数なし、トリガーファイル経由）
    Command::new(&exe_path).spawn().map_err(|e| {
        // spawn 失敗時はトリガーファイルが残ると次回他経路から誤読されるため削除
        let _ = fs::remove_file(&trigger_path);
        format!("Tachimi の起動に失敗: {}", e)
    })?;

    eprintln!("Tachimi launch - spawned: {}", exe_path);
    Ok(staged_paths.len())
}
