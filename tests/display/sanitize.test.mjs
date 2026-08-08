import assert from "node:assert/strict";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const {
  redactDisplaySecrets,
  sanitizeDisplayText,
  sanitizeDisplayLine,
  sanitizeMarkdownForDisplay,
  safeHttpUrl,
  truncateCodePoints,
} = await load("../../src/display/sanitize.ts");

const hostile = "safe\x1b]0;owned\x07 text\u0000\tline\r\nnext\x1b[31mred\x1b[0m";
const clean = sanitizeDisplayText(hostile);
assert.doesNotMatch(clean, /owned|\x1b|\x07/);
assert.match(clean, /safe text\\x00   line\nnextred/);
assert.equal(sanitizeDisplayLine("a\nb\t"), "a\\nb\\t");

const secrets = [
  "authorization: Bearer abc.def",
  "api_key=super-secret",
  "token: plain-token",
  "password: hunter2",
  "github_pat_ABC123",
  "ghp_ABC123",
  "fc-ABC_def",
  "Bearer opaque-token",
  "exact-value",
].join("\n");
const redacted = sanitizeDisplayText(secrets, { exactSecrets: ["exact-value"] });
assert.doesNotMatch(redacted, /abc\.def|super-secret|plain-token|hunter2|github_pat_|ghp_|fc-ABC|opaque-token|exact-value/i);
assert.ok((redacted.match(/\[REDACTED\]/g) ?? []).length >= 9);
assert.equal(redactDisplaySecrets("token one one", ["one"]), "token [REDACTED] [REDACTED]");

const markdown = sanitizeMarkdownForDisplay("[bad](https://evil.test) www.evil.test a@b.test\n```js\n[code](x)\n```");
assert.match(markdown, /\\\[bad\]/);
assert.match(markdown, /www\\\.evil/);
assert.match(markdown, /a\\@b\.test/);
assert.match(markdown, /\[code\]\(x\)/, "fenced code remains literal");

assert.equal(safeHttpUrl("https://example.test/a?q=1"), "https://example.test/a?q=1");
assert.equal(safeHttpUrl("https://user:pass@example.test/"), undefined);
assert.equal(safeHttpUrl("file:///tmp/a"), undefined);
assert.equal(safeHttpUrl("javascript:alert(1)"), undefined);
assert.equal(truncateCodePoints("ab😀cd", 4), "ab😀…");
assert.equal(truncateCodePoints("ab😀cd", 4, "..."), "a...");
assert.equal(truncateCodePoints("ab😀cd", 5), "ab😀cd");

console.log("display sanitize tests: OK");
