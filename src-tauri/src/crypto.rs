//! 参照アドレスリスト(addresses.enc)の復号 — 「割符(わりふ)」方式（COMIC-Bridge と共用）。
//!
//! 復号鍵は 2 つの片割れを合成して作る:
//!   A … このアプリのバイナリに埋め込まれた片割れ(`APP_SECRET`)。
//!   B … アドレスフォルダに置かれた鍵ファイル `address-seal.key` の中身(32バイト)。
//! 復号鍵 K = SHA256(A ‖ B)。AES-256-GCM で `addresses.enc` を復号する。
//!
//! ★ OPUS は COMIC-Bridge と **同一の `addresses.enc` を共用**する。そのため
//!    `APP_SECRET`・方式・MAGIC は CB の `crypto.rs` と **バイト完全一致**でなければならない
//!    （変えると CB が作った enc を復号できなくなる）。OPUS は復号のみ（暗号化はしない）。

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use sha2::{Digest, Sha256};

/// アプリ内蔵の割符の片割れ(A)。CB の crypto.rs と完全一致（共用 enc を復号するため）。
const APP_SECRET: [u8; 32] = [
    0x12, 0x74, 0x57, 0x26, 0x59, 0xbb, 0x9a, 0xac, 0x2a, 0x33, 0x6b, 0x8a, 0x79, 0x7c, 0xe8, 0x89,
    0xc3, 0xd7, 0xd5, 0x9d, 0x19, 0x1f, 0x36, 0x56, 0x80, 0x41, 0xb3, 0x5f, 0xda, 0x2c, 0x29, 0xef,
];

/// 暗号ファイルの先頭マジック(フォーマット識別)。
const MAGIC: &[u8; 4] = b"CBA1";
/// nonce(GCM) のバイト数。
const NONCE_LEN: usize = 12;

/// 復号鍵 K = SHA256(A ‖ B)。B は割符ファイルの 32 バイト。
fn derive_key(seal_b: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(APP_SECRET);
    h.update(seal_b);
    h.finalize().into()
}

/// `addresses.enc`(= MAGIC ‖ nonce(12) ‖ AES-256-GCM 暗号文+タグ)を復号して平文を返す。
pub fn decrypt(enc: &[u8], seal_b: &[u8; 32]) -> Result<Vec<u8>, String> {
    if enc.len() < MAGIC.len() + NONCE_LEN + 16 {
        return Err("暗号データが短すぎます(壊れている可能性があります)".to_string());
    }
    if &enc[..MAGIC.len()] != MAGIC {
        return Err("暗号データのヘッダーが不正です(addresses.enc ではありません)".to_string());
    }
    let nonce = &enc[MAGIC.len()..MAGIC.len() + NONCE_LEN];
    let ciphertext = &enc[MAGIC.len() + NONCE_LEN..];

    let key = derive_key(seal_b);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    cipher
        .decrypt(Nonce::from_slice(nonce), ciphertext)
        .map_err(|_| {
            "復号に失敗しました(割符 address-seal.key が一致しないか、データが破損しています)"
                .to_string()
        })
}

/// 割符ファイルの中身(16進テキスト)を 32 バイトへ復号する。
/// BOM/前後空白/改行は無視する(エディタ保存差を吸収)。
pub fn parse_seal_hex(text: &str) -> Result<[u8; 32], String> {
    let t = text.strip_prefix('\u{feff}').unwrap_or(text).trim();
    let hex: String = t.chars().filter(|c| !c.is_whitespace()).collect();
    if hex.len() != 64 {
        return Err(format!(
            "割符ファイルの形式が不正です(16進64文字が必要ですが {} 文字でした)",
            hex.len()
        ));
    }
    let mut out = [0u8; 32];
    let bytes = hex.as_bytes();
    for i in 0..32 {
        let hi = hex_val(bytes[i * 2])?;
        let lo = hex_val(bytes[i * 2 + 1])?;
        out[i] = (hi << 4) | lo;
    }
    Ok(out)
}

fn hex_val(c: u8) -> Result<u8, String> {
    match c {
        b'0'..=b'9' => Ok(c - b'0'),
        b'a'..=b'f' => Ok(c - b'a' + 10),
        b'A'..=b'F' => Ok(c - b'A' + 10),
        _ => Err("割符ファイルに16進以外の文字が含まれています".to_string()),
    }
}
