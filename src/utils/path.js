// パス操作の純粋ユーティリティ。bind/save.js / services/psd-load.js / main.js で共有。
// Tauri の絶対パス文字列前提で、Windows (\\) と POSIX (/) どちらも受ける。

export function baseName(p) {
  const m = p && p.match(/[\\/]([^\\/]+)$/);
  return m ? m[1] : p;
}

export function parentDir(p) {
  if (!p) return null;
  const m = p.match(/^(.+)[\\/][^\\/]+$/);
  return m ? m[1] : null;
}

export function joinPath(parent, child) {
  if (!parent) return child;
  const sep = /[\\/]$/.test(parent) ? "" : "/";
  return `${parent}${sep}${child}`;
}
