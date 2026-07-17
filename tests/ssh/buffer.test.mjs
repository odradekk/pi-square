import assert from "node:assert/strict";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { SshOutputBuffer } = await load("../../src/ssh/buffer.ts");

const buffer = new SshOutputBuffer(8, 4);
buffer.append("abc");
buffer.append(Buffer.from("def"));
let page = buffer.read(0);
assert.equal(page.text, "abcd");
assert.equal(page.nextCursor, 4);
assert.equal(page.hasMore, true);
assert.equal(page.cursorExpired, false);

page = buffer.read(page.nextCursor);
assert.equal(page.text, "ef");
assert.equal(page.nextCursor, 6);
assert.equal(page.hasMore, false);

buffer.append("ghi");
page = buffer.read(0);
assert.equal(page.cursorExpired, true);
assert.equal(page.oldestCursor, 1);
assert.equal(page.text, "bcde");
assert.equal(page.droppedChars, 1);

const unicode = new SshOutputBuffer(5, 10);
unicode.append("aé🙂");
page = unicode.read(0);
assert.equal(page.cursorExpired, true);
assert.equal(page.text, "🙂", "trimming must not split a UTF-8 code point");
assert.equal(page.oldestCursor, 2);

console.log("ssh output buffer tests: OK");
