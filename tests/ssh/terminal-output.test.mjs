import assert from "node:assert/strict";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { projectTerminalOutput } = await load("../../src/ssh/terminal-output.ts");

assert.equal(projectTerminalOutput("alpha\r\nbeta\n"), "alpha\nbeta\n", "CRLF must remain a single newline");
assert.equal(projectTerminalOutput("progress 0%\rprogress 50%\rprogress 100%\ncomplete\n"), "progress 100%\ncomplete\n");
assert.equal(projectTerminalOutput("download 0%\r\u001b[2Kdownload 100%\n"), "download 100%\n", "erase-line progress must retain only the visible state");
assert.equal(projectTerminalOutput("abcdef\rxy\u001b[K\n"), "xy\n", "erase-to-end must clear the overwritten suffix");
assert.equal(projectTerminalOutput("abc\b\bXY\n"), "aXY\n", "backspace must move the single-line cursor");
assert.equal(projectTerminalOutput("\u001b[31mred\u001b[0m\u0000\n"), "red\n", "styling and unsafe controls must not reach model output");
assert.equal(projectTerminalOutput("\u001b(Bplain\n"), "plain\n", "multi-byte ESC sequences must be removed completely");
assert.equal(
  projectTerminalOutput("safe\u001b]8;;https://attacker.test\u0007link\u001b]8;;\u0007\n"),
  "safelink\n",
  "OSC payloads must be removed while visible text remains",
);
assert.equal(
  projectTerminalOutput("safe\u001bPsecret\u0007still-secret\u001b\\visible\n"),
  "safevisible\n",
  "BEL must not terminate a DCS control string",
);
assert.equal(projectTerminalOutput("discarded output\r\u001b[2Kfinal\n", 6), "final\n", "the character limit must apply after projection");

console.log("ssh terminal output tests: OK");
