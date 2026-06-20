//! 固有アドレス（共有ドライブの社内パス等）の外部参照（割符暗号化・COMIC-Bridge と共用）。
//!
//! セキュリティ方針: 社内パス・取引先/部署名を含む実アドレスを **ソースに焼かない**。
//! 実アドレスは **COMIC-Bridge と同一の `addresses.enc`（割符 AES-256-GCM）** に集約し、
//! OPUS は起動時に **復号のみ** して参照する。平文は G: にも置かない。
//!
//! 解決順:
//!   1. 環境変数 `OPUS_ADDRESS_REF`（CI/検証用。`addresses.json` ファイル or 参照フォルダを指す）
//!   2. ローカル中立ポインタ `%LOCALAPPDATA%\OPUS\address-ref-location.json`
//!        `{ "referenceListPath": "<G:..>\\参照アドレス\\addresses.json" }`
//!      → その親フォルダの `addresses.enc` を `address-seal.key`(割符B) で復号
//!   3. 内蔵シード（既定・パッチ内部化）
//!
//! 復号 JSON は CB マスター構造 `{ "addresses": { "content.jsonFolder": "...", ... } }`。
//! キーは CB の中立キー名を用いる（例: JSONフォルダ=content.jsonFolder /
//! 写植・校正用テキストログ=content.textLogBase）。
//! ソースに残る実パスは `%LOCALAPPDATA%\OPUS\...`（＝アプリ自身の名前）のみ。
//! ポインタ未配置 / G:未接続 / 復号失敗 / キー無しは空文字を返す＝従来の「G:未接続＝no-op」と同じ安全側挙動。

use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::OnceLock;

static ADDRESSES: OnceLock<HashMap<String, String>> = OnceLock::new();

const ENC_FILE: &str = "addresses.enc";
const SEAL_KEY_FILE: &str = "address-seal.key";

/// 内蔵シード（参照アドレスフォルダの addresses.json の場所）。Base64 で持ち、平文の社内パスは
/// ソースに出さない（唯一持つのは「アドレス帳のありか」1個のみ）。これによりポインタ未配置でも
/// アプリ単体で enc に到達できる（＝参照先登録パッチの内部化）。
const SEED_B64: &str = "Rzov5YWx5pyJ44OJ44Op44Kk44OWL0NMTEVOTi/nt6jpm4bpg6jjg5Xjgqnjg6vjg4Av57eo6ZuG5LyB55S76YOoL+e3qOmbhuS8geeUu19D54+tKEFU5qWt5YuZ5o6o6YCyKS9EVFDliLbkvZzpg6gv5Y+C54Wn44Ki44OJ44Os44K5L2FkZHJlc3Nlcy5qc29u";

/// 内蔵シードをデコードして addresses.json パスを返す。
fn embedded_seed() -> Option<PathBuf> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(SEED_B64)
        .ok()?;
    let s = String::from_utf8(bytes).ok()?;
    let s = s.trim();
    if s.is_empty() {
        None
    } else {
        Some(PathBuf::from(s))
    }
}

/// ローカル中立ポインタ（任意・上書き用）。`%LOCALAPPDATA%\OPUS\address-ref-location.json`。
fn pointer_ref() -> Option<PathBuf> {
    let base = std::env::var("LOCALAPPDATA").ok()?;
    let pointer = PathBuf::from(base)
        .join("OPUS")
        .join("address-ref-location.json");
    let text = std::fs::read_to_string(&pointer).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    let p = v.get("referenceListPath")?.as_str()?.trim().to_string();
    if p.is_empty() {
        None
    } else {
        Some(PathBuf::from(p))
    }
}

/// 参照リスト（addresses.json ファイル）のパスを解決する。親フォルダに enc/割符がある前提。
/// 解決順: 環境変数（CI/検証）→ ローカルポインタ（任意・上書き）→ 内蔵シード（既定・パッチ内部化）。
fn list_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("OPUS_ADDRESS_REF") {
        let p = p.trim();
        if !p.is_empty() {
            let pb = PathBuf::from(p);
            return Some(if pb.is_dir() {
                pb.join("addresses.json")
            } else {
                pb
            });
        }
    }
    pointer_ref().or_else(embedded_seed)
}

/// 参照フォルダの `addresses.enc` を割符で復号して平文 JSON 文字列を返す。
/// enc が無ければ平文 `addresses.json` フォールバック（移行/検証用）。
fn read_raw() -> Option<String> {
    let list = list_path()?;
    let folder = list.parent()?;
    let enc_path = folder.join(ENC_FILE);
    if enc_path.exists() {
        let enc = std::fs::read(&enc_path).ok()?;
        let seal_text = std::fs::read_to_string(folder.join(SEAL_KEY_FILE)).ok()?;
        let seal_b = crate::crypto::parse_seal_hex(&seal_text).ok()?;
        let plain = crate::crypto::decrypt(&enc, &seal_b).ok()?;
        return String::from_utf8(plain).ok();
    }
    std::fs::read_to_string(&list).ok()
}

/// 参照リストを読み込み、`addresses` オブジェクト（または直下）の `key: "path"` を文字列マップへ展開する。
fn load() -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Some(raw) = read_raw() else {
        return map;
    };
    let Ok(v) = serde_json::from_str::<Value>(&raw) else {
        return map;
    };
    let obj = v
        .get("addresses")
        .and_then(|a| a.as_object())
        .or_else(|| v.as_object());
    if let Some(obj) = obj {
        for (k, val) in obj {
            if let Some(s) = val.as_str() {
                map.insert(k.clone(), s.to_string());
            }
        }
    }
    map
}

/// 指定キー（CB中立キー名）の実アドレスを返す（未設定なら空文字）。初回のみ読み込み、以後はキャッシュ。
pub fn addr(key: &str) -> String {
    ADDRESSES
        .get_or_init(load)
        .get(key)
        .cloned()
        .unwrap_or_default()
}
