import { readFileSync } from "node:fs";

const input = readFileSync(0, "utf8");
const packs = JSON.parse(input);
if (!Array.isArray(packs) || packs.length !== 1) {
  throw new Error(`expected one packed package, received ${Array.isArray(packs) ? packs.length : "invalid JSON"}`);
}

const pack = packs[0];
const allowedRoots = new Set(["src", "subagents", "themes"]);
const allowedFiles = new Set([
  "CHANGELOG.md",
  "docs/adr/0011-shadow-minds.md",
  "docs/shadow-minds.md",
  "LICENSE",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "package.json",
  "shadow-minds/example.md",
  "shadow-minds/schema-reference.md",
]);
const requiredFiles = [
  "LICENSE",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "package.json",
  "src/index.ts",
  "src/display-api.ts",
  "shadow-minds/example.md",
  "shadow-minds/schema-reference.md",
  "subagents/crawler.yaml",
  "subagents/example_profile.yaml",
  "subagents/explorer.yaml",
  "subagents/generalist.yaml",
  "subagents/librarian.yaml",
  "subagents/oracle.yaml",
];
const paths = new Set(pack.files.map((file) => file.path));

for (const path of paths) {
  const root = path.split("/", 1)[0];
  if (!allowedFiles.has(path) && !allowedRoots.has(root)) {
    throw new Error(`unexpected publication file: ${path}`);
  }
}
for (const path of requiredFiles) {
  if (!paths.has(path)) throw new Error(`missing required publication file: ${path}`);
}
if (pack.name !== "@odradekk/pi-square") throw new Error(`unexpected package name: ${pack.name}`);
if (pack.size > 1024 * 1024) throw new Error(`compressed package exceeds 1 MiB: ${pack.size}`);
if (pack.unpackedSize > 4 * 1024 * 1024) throw new Error(`unpacked package exceeds 4 MiB: ${pack.unpackedSize}`);

console.log(`${pack.name}@${pack.version}: ${pack.entryCount} files, ${pack.size} bytes compressed`);
