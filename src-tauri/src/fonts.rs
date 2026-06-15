use std::collections::HashSet;
use std::path::{Path, PathBuf};

use thiserror::Error;

use crate::FontEntry;

#[derive(Debug, Error)]
pub enum FontError {
    #[error("フォントディレクトリが見つかりません")]
    NoFontDir,
    #[error("I/O: {0}")]
    Io(#[from] std::io::Error),
}

pub fn list_fonts() -> Result<Vec<FontEntry>, FontError> {
    let dirs = font_directories();
    if dirs.is_empty() {
        return Err(FontError::NoFontDir);
    }

    let fingerprint = font_dirs_fingerprint(&dirs);
    if let Some(cached) = read_cache(&fingerprint) {
        return Ok(cached);
    }

    let mut seen: HashSet<String> = HashSet::new();
    let mut result: Vec<FontEntry> = Vec::new();

    for dir in &dirs {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !is_font_file(&path) {
                continue;
            }
            let Ok(bytes) = std::fs::read(&path) else {
                continue;
            };
            extract_fonts(&bytes, &path, &mut seen, &mut result);
        }
    }

    result.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    write_cache(&result, &fingerprint);
    Ok(result)
}

fn is_font_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|ext| {
            let lower = ext.to_ascii_lowercase();
            lower == "ttf" || lower == "otf" || lower == "ttc" || lower == "otc"
        })
        .unwrap_or_else(|| path.is_file())
}

fn extract_fonts(bytes: &[u8], path: &Path, seen: &mut HashSet<String>, out: &mut Vec<FontEntry>) {
    let count = ttf_parser::fonts_in_collection(bytes).unwrap_or(1);
    let path_str = path.to_string_lossy().into_owned();
    for index in 0..count {
        let Ok(face) = ttf_parser::Face::parse(bytes, index) else {
            continue;
        };
        let Some(mut entry) = build_entry(&face) else {
            continue;
        };
        if entry.post_script_name.is_empty() {
            continue;
        }
        entry.path = Some(path_str.clone());
        // 【v1.16.0】TTC / OTC 内の何番目の face かを保持。JS 側で
        // read_font_face_bytes(path, faceIndex) を呼ぶときに渡す。
        entry.face_index = index;
        if seen.insert(entry.post_script_name.clone()) {
            out.push(entry);
        }
    }
}

fn build_entry(face: &ttf_parser::Face) -> Option<FontEntry> {
    const NAME_ID_FULL: u16 = 4;
    const NAME_ID_POSTSCRIPT: u16 = 6;
    const NAME_ID_FAMILY: u16 = 1;
    const NAME_ID_TYPOGRAPHIC_FAMILY: u16 = 16;
    const NAME_ID_TYPOGRAPHIC_SUBFAMILY: u16 = 17;
    const NAME_ID_COMPATIBLE_FULL: u16 = 18;

    let mut full_name_ja: Option<String> = None;
    let mut full_name_en: Option<String> = None;
    let mut full_name_any: Option<String> = None;
    let mut family_name_ja: Option<String> = None;
    let mut family_name_en: Option<String> = None;
    let mut family_name_any: Option<String> = None;
    let mut post_script_name: Option<String> = None;
    let mut aliases: Vec<String> = Vec::new();

    for record in face.names() {
        let Some(decoded) = decode_name(&record) else {
            continue;
        };
        match record.name_id {
            NAME_ID_FAMILY
            | NAME_ID_FULL
            | NAME_ID_POSTSCRIPT
            | NAME_ID_TYPOGRAPHIC_FAMILY
            | NAME_ID_TYPOGRAPHIC_SUBFAMILY
            | NAME_ID_COMPATIBLE_FULL => push_unique(&mut aliases, decoded.clone()),
            _ => {}
        }
        match record.name_id {
            NAME_ID_POSTSCRIPT if post_script_name.is_none() => post_script_name = Some(decoded),
            NAME_ID_FULL => {
                if full_name_any.is_none() {
                    full_name_any = Some(decoded.clone());
                }
                if is_japanese_record(&record) && full_name_ja.is_none() {
                    full_name_ja = Some(decoded.clone());
                }
                if is_english_record(&record) && full_name_en.is_none() {
                    full_name_en = Some(decoded);
                }
            }
            NAME_ID_FAMILY => {
                if family_name_any.is_none() {
                    family_name_any = Some(decoded.clone());
                }
                if is_japanese_record(&record) && family_name_ja.is_none() {
                    family_name_ja = Some(decoded.clone());
                }
                if is_english_record(&record) && family_name_en.is_none() {
                    family_name_en = Some(decoded);
                }
            }
            _ => {}
        }
    }

    let ps = post_script_name?;
    let display = full_name_ja
        .or(family_name_ja)
        .or(full_name_en)
        .or(family_name_en)
        .or(full_name_any)
        .or(family_name_any)
        .unwrap_or_else(|| ps.clone());
    push_unique(&mut aliases, display.clone());
    push_unique(&mut aliases, ps.clone());
    Some(FontEntry {
        name: display,
        post_script_name: ps,
        aliases,
        path: None,
        // 【v1.16.0】extract_fonts 側でループ中に上書きされる初期値。
        face_index: 0,
    })
}

fn push_unique(items: &mut Vec<String>, value: String) {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return;
    }
    if !items.iter().any(|v| v.eq_ignore_ascii_case(trimmed)) {
        items.push(trimmed.to_string());
    }
}

fn is_japanese_record(record: &ttf_parser::name::Name) -> bool {
    matches_lang(record, 0x0411) || matches_lang(record, 11)
}

fn is_english_record(record: &ttf_parser::name::Name) -> bool {
    matches_lang(record, 0x0409) || matches_lang(record, 0)
}

fn matches_lang(record: &ttf_parser::name::Name, lang_id: u16) -> bool {
    record.language_id == lang_id
}

fn decode_name(record: &ttf_parser::name::Name) -> Option<String> {
    if let Some(s) = record.to_string() {
        let trimmed = s.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
}

fn push_font_dir(dirs: &mut Vec<PathBuf>, path: PathBuf) {
    if !path.is_dir() {
        return;
    }
    let key = path.to_string_lossy().to_lowercase();
    if dirs.iter().any(|d| d.to_string_lossy().to_lowercase() == key) {
        return;
    }
    dirs.push(path);
}

#[cfg(windows)]
fn font_directories() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    if let Ok(windir) = std::env::var("WINDIR") {
        let mut p = PathBuf::from(windir);
        p.push("Fonts");
        push_font_dir(&mut dirs, p);
    } else {
        let p = PathBuf::from(r"C:\Windows\Fonts");
        push_font_dir(&mut dirs, p);
    }

    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let mut p = PathBuf::from(local);
        p.push("Microsoft");
        p.push("Windows");
        p.push("Fonts");
        push_font_dir(&mut dirs, p);
    }

    for env_name in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(root) = std::env::var_os(env_name) {
            push_font_dir(
                &mut dirs,
                PathBuf::from(root).join("Common Files").join("Adobe").join("Fonts"),
            );
        }
    }

    if let Some(appdata) = std::env::var_os("APPDATA") {
        let appdata = PathBuf::from(appdata);
        push_font_dir(&mut dirs, appdata.join("Adobe").join("Fonts"));
        push_font_dir(
            &mut dirs,
            appdata.join("Adobe").join("CoreSync").join("plugins").join("livetype").join("r"),
        );
    }

    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        push_font_dir(&mut dirs, PathBuf::from(local).join("Adobe").join("Fonts"));
    }

    dirs
}

#[cfg(not(windows))]
fn font_directories() -> Vec<PathBuf> {
    Vec::new()
}

fn cache_path() -> Option<PathBuf> {
    let base = std::env::var_os("APPDATA").map(PathBuf::from)?;
    let mut p = base;
    p.push("PsDesign");
    std::fs::create_dir_all(&p).ok()?;
    p.push("fonts-ja-display.json");
    Some(p)
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
struct FontCacheDir {
    path: String,
    #[serde(rename = "fileCount")]
    file_count: u64,
    #[serde(rename = "latestModifiedMs")]
    latest_modified_ms: u64,
    #[serde(rename = "totalSize")]
    total_size: u64,
}

fn system_time_ms(time: std::time::SystemTime) -> u64 {
    time.duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn font_dirs_fingerprint(dirs: &[PathBuf]) -> Vec<FontCacheDir> {
    let mut out = Vec::new();
    for dir in dirs {
        let mut file_count = 0u64;
        let mut latest_modified_ms = 0u64;
        let mut total_size = 0u64;
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !is_font_file(&path) {
                    continue;
                }
                let Ok(meta) = entry.metadata() else {
                    continue;
                };
                if !meta.is_file() {
                    continue;
                }
                file_count += 1;
                total_size = total_size.saturating_add(meta.len());
                if let Ok(modified) = meta.modified() {
                    latest_modified_ms = latest_modified_ms.max(system_time_ms(modified));
                }
            }
        }
        out.push(FontCacheDir {
            path: dir.to_string_lossy().into_owned(),
            file_count,
            latest_modified_ms,
            total_size,
        });
    }
    out
}

fn read_cache(expected_fingerprint: &[FontCacheDir]) -> Option<Vec<FontEntry>> {
    let path = cache_path()?;
    let raw = std::fs::read_to_string(&path).ok()?;
    #[derive(serde::Deserialize)]
    struct Row {
        name: String,
        #[serde(rename = "postScriptName")]
        ps: String,
        aliases: Option<Vec<String>>,
        #[serde(default)]
        path: Option<String>,
        // 【v1.16.0】v2 キャッシュ。旧キャッシュ（face_index なし）は None になる。
        #[serde(rename = "faceIndex", default)]
        face_index: Option<u32>,
    }
    #[derive(serde::Deserialize)]
    struct CacheFile {
        version: u32,
        fingerprint: Vec<FontCacheDir>,
        fonts: Vec<Row>,
    }
    let cache: CacheFile = serde_json::from_str(&raw).ok()?;
    if cache.version < 3 || cache.fingerprint != expected_fingerprint {
        return None;
    }
    let rows = cache.fonts;
    // 旧 v1 キャッシュ（path なし or face_index なし）は破棄して再ビルド。
    // face_index が無いと TTC 第 2 face 以降の Yu Gothic Bold 等が一切登録できないため、
    // 必ず再ビルドして全 face をキャッシュに含める必要がある。
    if rows
        .iter()
        .any(|r| r.path.is_none() || r.face_index.is_none() || r.aliases.is_none())
    {
        return None;
    }
    Some(
        rows.into_iter()
            .map(|r| FontEntry {
                name: r.name,
                post_script_name: r.ps,
                aliases: r.aliases.unwrap_or_default(),
                path: r.path,
                face_index: r.face_index.unwrap_or(0),
            })
            .collect(),
    )
}

fn write_cache(fonts: &[FontEntry], fingerprint: &[FontCacheDir]) {
    let Some(path) = cache_path() else { return };
    #[derive(serde::Serialize)]
    struct CacheFile<'a> {
        version: u32,
        fingerprint: &'a [FontCacheDir],
        fonts: &'a [FontEntry],
    }
    let json = serde_json::to_string_pretty(&CacheFile {
        version: 3,
        fingerprint,
        fonts,
    });
    if let Ok(s) = json {
        let _ = std::fs::write(path, s);
    }
}
