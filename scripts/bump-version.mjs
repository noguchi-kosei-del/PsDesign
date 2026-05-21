import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const mode = process.argv[2] || "patch";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function nextPatch(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new Error(`Invalid semver: ${version}`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

function targetVersion(current) {
  if (mode === "patch") return nextPatch(current);
  if (mode === "set") {
    const value = process.argv[3];
    if (!/^\d+\.\d+\.\d+$/.test(value || "")) {
      throw new Error("Usage: node scripts/bump-version.mjs set 1.4.1");
    }
    return value;
  }
  throw new Error("Usage: node scripts/bump-version.mjs patch | set <x.y.z>");
}

function replaceFile(file, replacements) {
  let text = fs.readFileSync(file, "utf8");
  for (const [pattern, replacement] of replacements) {
    text = text.replace(pattern, replacement);
  }
  fs.writeFileSync(file, text);
}

const packagePath = path.join(root, "package.json");
const packageLockPath = path.join(root, "package-lock.json");
const cargoTomlPath = path.join(root, "src-tauri", "Cargo.toml");
const cargoLockPath = path.join(root, "src-tauri", "Cargo.lock");
const tauriConfigPath = path.join(root, "src-tauri", "tauri.conf.json");

const pkg = readJson(packagePath);
const version = targetVersion(pkg.version);
pkg.version = version;
writeJson(packagePath, pkg);

const lock = readJson(packageLockPath);
lock.version = version;
if (lock.packages?.[""]) lock.packages[""].version = version;
writeJson(packageLockPath, lock);

replaceFile(cargoTomlPath, [
  [/^version = ".+"$/m, `version = "${version}"`],
]);

replaceFile(cargoLockPath, [
  [/(\[\[package\]\]\r?\nname = "opus"\r?\nversion = )".+"/, `$1"${version}"`],
]);

const tauriConfig = readJson(tauriConfigPath);
tauriConfig.version = version;
writeJson(tauriConfigPath, tauriConfig);

console.log(`Version bumped to ${version}`);
