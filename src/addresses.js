// 業務フォルダの実パス取得（固有アドレスの外部参照）。
//
// 社内共有ドライブの実パスはソースに直書きせず、Rust 側の `get_business_address` 経由で
// COMIC-Bridge 共用の addresses.enc（割符 AES-256-GCM）から実行時復号した値を取得する。
// 取得結果はキー単位でキャッシュ（同一キーは 1 回だけ invoke）。
// 未解決（G:未接続・未シール等）は空文字を返す＝呼び出し側は従来の「未接続」と同じ扱い。

const _cache = new Map();

/**
 * @param {string} key CB 中立キー（例: "content.jsonFolder" / "content.textLogBase"）
 * @returns {Promise<string>} 実パス（未解決なら ""）
 */
export async function getBusinessAddress(key) {
  if (_cache.has(key)) return _cache.get(key);
  let value = "";
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    value = (await invoke("get_business_address", { key })) || "";
  } catch (e) {
    console.error("[addresses] get_business_address failed:", key, e);
    value = "";
  }
  _cache.set(key, value);
  return value;
}
