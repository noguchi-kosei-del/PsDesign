import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
  .split(/\r?\n/)
  .filter(Boolean);

const sourceExtensions = /\.(js|mjs|html|css|rs)$/i;
const ignored = /^(dist|node_modules|public\/pdfjs)\//;

const targets = tracked.filter((file) => sourceExtensions.test(file) && !ignored.test(file.replace(/\\/g, "/")));

const mojibakeMarkers = [
  0xfffd,
  0x7e5d, 0x7e3a, 0x8b41, 0x9695, 0x9a55, 0x9ae2, 0x8700, 0x879f, 0x87c6, 0x90b1, 0x7e32,
  0x8b5b, 0x873f, 0x9b06, 0x8811, 0x7b28, 0xff83, 0x8c3f, 0x8373, 0x87b3, 0x90b5, 0x8b93,
  0x83f4, 0x8c41, 0x86fb, 0x9af1, 0x9666, 0x8b1a, 0x7e67, 0x9711, 0x9049, 0x8763, 0x8b4f,
  0x8c3a, 0x7aca, 0x908a, 0x838d, 0x83eb,
].map((codePoint) => String.fromCodePoint(codePoint));

const findings = [];

for (const file of targets) {
  const text = readFileSync(file, "utf8");
  if (text.charCodeAt(0) === 0xfeff) {
    findings.push(`${file}:1: UTF-8 BOM is not allowed`);
  }
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const marker = mojibakeMarkers.find((m) => line.includes(m));
    if (marker) {
      findings.push(`${file}:${index + 1}: suspicious mojibake marker "${marker}"`);
    }
  });
}

if (findings.length) {
  console.error("Source integrity check failed:");
  for (const finding of findings.slice(0, 80)) console.error(`  ${finding}`);
  if (findings.length > 80) console.error(`  ...and ${findings.length - 80} more`);
  process.exit(1);
}

console.log(`Source integrity check passed (${targets.length} files).`);
