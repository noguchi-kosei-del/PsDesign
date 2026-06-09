// セキュリティ回帰チェック（Phase 2 最終仕様 + Phase 3-lite）。
//
// DevTools での実動作確認を置き換えるものではなく、危険な実装へ「先祖返り」した時に
// ビルド前段で気づくための静的チェック。セキュリティ修正手順.md の 21 項目に対応する。
//
//   npm run check:security
//
// 1 件でも失敗したら exit code 1 で落とす。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(rel) {
  try {
    return readFileSync(join(root, rel), "utf8");
  } catch {
    return "";
  }
}

const pathAccess = read("src-tauri/src/path_access.rs");
const libRs = read("src-tauri/src/lib.rs");
const filePicker = read("src/file-picker.js");

// browse_directory_entries / browse_path_info の関数本体を切り出す（構造判定用）。
function fnBody(src, name) {
  const start = src.indexOf(`pub async fn ${name}`);
  if (start < 0) return "";
  // 次の `#[tauri::command]` か `pub async fn` まで（雑だが十分）。
  const rest = src.slice(start + 1);
  const next = rest.search(/\n#\[tauri::command\]|\npub async fn /);
  return next < 0 ? rest : rest.slice(0, next);
}

const browseDir = fnBody(pathAccess, "browse_directory_entries");
const browsePathInfo = fnBody(pathAccess, "browse_path_info");

// BrowseEntry / BrowsePathInfo の struct 定義を切り出す。
function structBody(src, name) {
  const start = src.indexOf(`struct ${name}`);
  if (start < 0) return "";
  const open = src.indexOf("{", start);
  const close = src.indexOf("}", open);
  return open < 0 || close < 0 ? "" : src.slice(open, close);
}
const browseEntryStruct = structBody(pathAccess, "BrowseEntry");
const browsePathInfoStruct = structBody(pathAccess, "BrowsePathInfo");

// invoke_handler に登録されているコマンド一覧（generate_handler! の中身）。
// コメント中の言及ではなく「実際に公開されているか」で判定するため。
function invokeHandlerBlock(src) {
  const start = src.indexOf("generate_handler!");
  if (start < 0) return "";
  const open = src.indexOf("[", start);
  const close = src.indexOf("]", open);
  return open < 0 || close < 0 ? "" : src.slice(open, close);
}
const handlerBlock = invokeHandlerBlock(libRs);
// コメント行を除いたコード行（command 定義の有無判定用）。
function stripComments(src) {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}
const pathAccessCode = stripComments(pathAccess);
const libRsCode = stripComments(libRs);

const checks = [
  // 1
  [
    "pickerSessionId is generated from secure random bytes",
    /fn new_session_id\([^)]*\)\s*->\s*String\s*\{\s*format!\("picker-\{\}",\s*random_hex/.test(
      pathAccess
    ),
  ],
  // 2
  [
    "picker token is generated from secure random bytes",
    /fn new_candidate_token\([^)]*\)\s*->\s*String\s*\{\s*format!\("p-\{\}",\s*random_hex/.test(
      pathAccess
    ),
  ],
  // 3
  [
    "old sequential picker token counter is not present",
    !/AtomicU(size|32|64)/.test(pathAccess) &&
      !/fetch_add/.test(pathAccess) &&
      !/format!\(\s*"p\{\}"\s*,/.test(pathAccess),
  ],
  // 4
  ["OS random source is present", /getrandom::getrandom\s*\(/.test(pathAccess)],
  // 5
  ["browse rate limiter exists", /fn check_rate_limit\(/.test(pathAccess)],
  // 6
  [
    "browse rate limiter has the expected light threshold",
    /BROWSE_MAX_IN_WINDOW:\s*usize\s*=\s*50/.test(pathAccess) &&
      /BROWSE_WINDOW:\s*Duration\s*=\s*Duration::from_secs\(10\)/.test(pathAccess),
  ],
  // 7
  [
    "open_picker rejects an existing active picker session",
    /forbidden path: picker already open/.test(pathAccess),
  ],
  // 8
  [
    "file picker UI blocks duplicate picker startup",
    /if\s*\(resolveCurrent\)\s*\{[\s\S]{0,120}return null/.test(filePicker),
  ],
  // 9
  [
    "both browse commands call the rate limiter",
    /check_rate_limit\(s\)\?/.test(browseDir) &&
      /check_rate_limit\(s\)\?/.test(browsePathInfo),
  ],
  // 10
  ["save fileName validator exists", /fn validate_save_file_name\(/.test(pathAccess)],
  // 11
  [
    "save fileName rejects leading and trailing whitespace",
    /name\s*!=\s*name\.trim\(\)/.test(pathAccess),
  ],
  // 12
  [
    "save fileName rejects trailing dot and trailing space",
    /ends_with\('\.'\)\s*\|\|\s*name\.ends_with\(' '\)/.test(pathAccess),
  ],
  // 13
  [
    "save fileName rejects path separators and dangerous Windows characters",
    /'\\\\'\s*\|\s*'\/'\s*\|\s*':'\s*\|\s*'\*'\s*\|\s*'\?'\s*\|\s*'"'\s*\|\s*'<'\s*\|\s*'>'\s*\|\s*'\|'/.test(
      pathAccess
    ),
  ],
  // 14
  [
    "save fileName rejects Windows reserved device names",
    /"CON"/.test(pathAccess) &&
      /"PRN"/.test(pathAccess) &&
      /"COM1"/.test(pathAccess) &&
      /"LPT1"/.test(pathAccess),
  ],
  // 15
  [
    "save path confirmation uses the validator",
    /fn confirm_file_picker_save_path[\s\S]{0,400}validate_save_file_name\(&fileName\)/.test(
      pathAccess
    ),
  ],
  // 16（コメント中の言及は許容し、定義/公開のみを禁止）
  [
    "authorize_user_paths command is not exposed",
    !/fn\s+authorize_user_paths/.test(pathAccessCode) &&
      !/fn\s+authorize_user_paths/.test(libRsCode) &&
      !/authorize_user_paths/.test(handlerBlock),
  ],
  // 17
  [
    "confirm_file_picker_paths path-string registration command is not exposed",
    !/fn\s+confirm_file_picker_paths\b/.test(pathAccessCode) &&
      !/confirm_file_picker_paths\b/.test(handlerBlock),
  ],
  // 18
  [
    "browse_directory_entries requires pickerSessionId",
    /pub async fn browse_directory_entries\([\s\S]{0,300}pickerSessionId:\s*String/.test(
      pathAccess
    ),
  ],
  // 19
  [
    "browse_path_info requires pickerSessionId",
    /pub async fn browse_path_info\([\s\S]{0,300}pickerSessionId:\s*String/.test(pathAccess),
  ],
  // 20
  [
    "browse_directory_entries returns candidate token instead of child real path",
    /token:\s*String/.test(browseEntryStruct) && !/\bpath:\s*String/.test(browseEntryStruct),
  ],
  // 21
  [
    "browse_path_info returns candidate token instead of real path",
    /token:\s*String/.test(browsePathInfoStruct) &&
      !/\bpath:\s*String/.test(browsePathInfoStruct),
  ],
];

let failed = 0;
for (const [label, ok] of checks) {
  if (ok) {
    console.log(`[OK] ${label}`);
  } else {
    console.error(`[NG] ${label}`);
    failed += 1;
  }
}

console.log("");
if (failed > 0) {
  console.error(`Security regression check FAILED: ${failed} / ${checks.length}`);
  process.exit(1);
}
console.log(`Security regression check passed: ${checks.length}`);
