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
    if let Some(cached) = read_cache() {
        return Ok(cached);
    }

    let dirs = font_directories();
    if dirs.is_empty() {
        return Err(FontError::NoFontDir);
    }

    let mut seen: HashSet<String> = HashSet::new();
    let mut result: Vec<FontEntry> = Vec::new();

    for dir in &dirs {
        let Ok(entries) = std::fs::read_dir(dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if !is_font_file(&path) {
                continue;
            }
            let Ok(bytes) = std::fs::read(&path) else { continue };
            extract_fonts(&bytes, &path, &mut seen, &mut result);
        }
    }

    result.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    write_cache(&result);
    Ok(result)
}

fn is_font_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|ext| {
            let lower = ext.to_ascii_lowercase();
            lower == "ttf" || lower == "otf" || lower == "ttc" || lower == "otc"
        })
        .unwrap_or(false)
}

fn extract_fonts(bytes: &[u8], path: &Path, seen: &mut HashSet<String>, out: &mut Vec<FontEntry>) {
    let count = ttf_parser::fonts_in_collection(bytes).unwrap_or(1);
    let path_str = path.to_string_lossy().into_owned();
    for index in 0..count {
        let Ok(face) = ttf_parser::Face::parse(bytes, index) else { continue };
        let Some(mut entry) = build_entry(&face) else { continue };
        if entry.post_script_name.is_empty() {
            continue;
        }
        entry.path = Some(path_str.clone());
        if seen.insert(entry.post_script_name.clone()) {
            out.push(entry);
        }
    }
}

fn build_entry(face: &ttf_parser::Face) -> Option<FontEntry> {
    const NAME_ID_FULL: u16 = 4;
    const NAME_ID_POSTSCRIPT: u16 = 6;
    const NAME_ID_FAMILY: u16 = 1;

    let mut full_name: Option<String> = None;
    let mut family_name: Option<String> = None;
    let mut post_script_name: Option<String> = None;

    for record in face.names() {
        let Some(decoded) = decode_name(&record) else { continue };
        match record.name_id {
            NAME_ID_POSTSCRIPT if post_script_name.is_none() => post_script_name = Some(decoded),
            NAME_ID_FULL => {
                if prefer_record(&record) || full_name.is_none() {
                    full_name = Some(decoded);
                }
            }
            NAME_ID_FAMILY => {
                if prefer_record(&record) || family_name.is_none() {
                    family_name = Some(decoded);
                }
            }
            _ => {}
        }
    }

    let ps = post_script_name?;
    let display = full_name.or(family_name).unwrap_or_else(|| ps.clone());
    Some(FontEntry {
        name: display,
        post_script_name: ps,
        path: None,
    })
}

fn prefer_record(record: &ttf_parser::name::Name) -> bool {
    matches_lang(record, 0x0411) || matches_lang(record, 0x0409)
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

#[cfg(windows)]
fn font_directories() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    if let Ok(windir) = std::env::var("WINDIR") {
        let mut p = PathBuf::from(windir);
        p.push("Fonts");
        if p.is_dir() {
            dirs.push(p);
        }
    } else {
        let p = PathBuf::from(r"C:\Windows\Fonts");
        if p.is_dir() {
            dirs.push(p);
        }
    }

    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let mut p = PathBuf::from(local);
        p.push("Microsoft");
        p.push("Windows");
        p.push("Fonts");
        if p.is_dir() {
            dirs.push(p);
        }
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
    p.push("fonts.json");
    Some(p)
}

fn read_cache() -> Option<Vec<FontEntry>> {
    let path = cache_path()?;
    let raw = std::fs::read_to_string(&path).ok()?;
    #[derive(serde::Deserialize)]
    struct Row {
        name: String,
        #[serde(rename = "postScriptName")]
        ps: String,
        #[serde(default)]
        path: Option<String>,
    }
    let rows: Vec<Row> = serde_json::from_str(&raw).ok()?;
    // 旧キャッシュ（path なし）は破棄して再ビルド
    if rows.iter().any(|r| r.path.is_none()) {
        return None;
    }
    Some(
        rows.into_iter()
            .map(|r| FontEntry {
                name: r.name,
                post_script_name: r.ps,
                path: r.path,
            })
            .collect(),
    )
}

fn write_cache(fonts: &[FontEntry]) {
    let Some(path) = cache_path() else { return };
    let json = serde_json::to_string_pretty(fonts);
    if let Ok(s) = json {
        let _ = std::fs::write(path, s);
    }
}
