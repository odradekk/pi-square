import assert from "node:assert/strict";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { SshMarkerScanner } = await load("../../src/ssh/session.ts");

const framed = new SshMarkerScanner("abc123");
assert.equal(framed.marker, "__PI_SSH_abc123__:");
assert.equal(
  framed.commandFrame("pwd"),
  `pwd\n__pi_square_rc=$?\nprintf '\\n${framed.marker}%s\\n' "$__pi_square_rc"\nunset __pi_square_rc\n`,
);
assert.match(
  new SshMarkerScanner().marker,
  /^__PI_SSH_[a-f0-9]{36}__:$/,
  "the default token must stay unguessable",
);

// A whole marker in one chunk completes the command and reports its exit code.
const whole = new SshMarkerScanner("whole");
let scan = whole.push(`hello\n${whole.marker}0\n`);
assert.deepEqual(scan, { output: "hello", exitCode: 0 });
assert.equal(whole.flush(), "", "a completed command leaves nothing pending");
scan = whole.push(`tail ${whole.marker}130\r\nafter\r\n`);
assert.deepEqual(scan, { output: "tail after\r\n", exitCode: 130 });

// A marker split mid-token is held back until the rest arrives.
const splitMarker = new SshMarkerScanner("split-marker");
scan = splitMarker.push(`first line\r\n${splitMarker.marker.slice(0, 10)}`);
assert.equal(scan.output, "first line", "a partial marker must never reach output");
assert.equal(scan.exitCode, undefined);
assert.doesNotMatch(scan.output, /__PI_SSH_/);
scan = splitMarker.push(`${splitMarker.marker.slice(10)}0\r\n`);
assert.deepEqual(scan, { output: "", exitCode: 0 });

// A complete marker whose exit-code digits are still arriving stays pending.
const splitDigits = new SshMarkerScanner("split-digits");
scan = splitDigits.push(`value\r\n${splitDigits.marker}-`);
assert.equal(scan.output, "value", "a marker with a partial exit code must never reach output");
assert.equal(scan.exitCode, undefined);
assert.doesNotMatch(scan.output, /__PI_SSH_/);
scan = splitDigits.push("12\r\n");
assert.deepEqual(scan, { output: "", exitCode: -12 }, "a negative exit code split across chunks must parse whole");

// A chunk boundary between CR and LF before the marker keeps the CR pending.
const beforeCrlf = new SshMarkerScanner("before-crlf");
scan = beforeCrlf.push("done\r");
assert.equal(scan.output, "done", "a trailing CR is held back with a possible marker");
scan = beforeCrlf.push(`\n${beforeCrlf.marker}0\r\n`);
assert.deepEqual(scan, { output: "", exitCode: 0 });

// A chunk boundary between CR and LF after the exit code keeps them pending.
const afterCrlf = new SshMarkerScanner("after-crlf");
scan = afterCrlf.push(`done\r\n${afterCrlf.marker}7\r`);
assert.equal(scan.output, "done", "a marker missing only its final LF must never reach output");
assert.equal(scan.exitCode, undefined);
scan = afterCrlf.push("\n");
assert.deepEqual(scan, { output: "", exitCode: 7 });

// Text held back as a possible marker prefix is released once it diverges.
const diverges = new SshMarkerScanner("m");
scan = diverges.push("a\n__PI_SSH_");
assert.equal(scan.output, "a");
scan = diverges.push("mismatch");
assert.equal(scan.output, "\n__PI_SSH_mismatch", "a prefix that can no longer become a marker must be released");
assert.equal(diverges.flush(), "");

// Only this scanner's own token may complete the command.
const foreign = new SshMarkerScanner("mine");
scan = foreign.push("out __PI_SSH_other__:9\r\n");
assert.equal(scan.exitCode, undefined, "a foreign marker must not complete the command");
assert.equal(scan.output + foreign.flush(), "out __PI_SSH_other__:9\r\n");

// Flush hands over everything still pending and clears it.
const pending = new SshMarkerScanner("flush");
scan = pending.push(`tail\r\n${pending.marker.slice(0, 8)}`);
assert.equal(scan.output, "tail");
assert.equal(pending.flush(), `\r\n${pending.marker.slice(0, 8)}`);
assert.equal(pending.flush(), "", "flush must clear the pending text");

// The holdback must depend on what could still become a marker, not on how
// much output preceded it. A long listing followed by a marker prefix is the
// realistic shape of a command that is about to finish, and a holdback that
// gives up once the pending text outgrows the marker would leak the prefix
// into the output page here while every short-prefix case above still passed.
const longOutput = new SshMarkerScanner("cafe0");
const listing = "-rw-r--r-- 1 deploy deploy 4096 Sep 18 10:00 releases\r\n".repeat(6);
scan = longOutput.push(listing + `\r\n${longOutput.marker.slice(0, 14)}`);
assert.equal(scan.output, listing, "output before a marker prefix is released, the prefix is not");
assert.doesNotMatch(scan.output, /__PI_SSH_/, "no part of a marker may reach the output page");
scan = longOutput.push(`${longOutput.marker.slice(14)}0\r\n`);
assert.deepEqual(scan, { output: "", exitCode: 0 }, "the held prefix completes the marker on the next chunk");

// The same holdback holds when the pending text never completes: the prefix is
// surrendered only by flush, and still never through the output page.
const longPartial = new SshMarkerScanner("cafe1");
scan = longPartial.push(listing + `\r\n${longPartial.marker.slice(0, 20)}`);
assert.equal(scan.output, listing);
assert.equal(longPartial.flush(), `\r\n${longPartial.marker.slice(0, 20)}`);

// A token carrying pattern syntax is matched literally, so it can neither fail
// to compile nor complete on another command's marker.
const literal = new SshMarkerScanner(".*");
assert.equal(literal.push("x __PI_SSH_deadbeef__:9\r\n").exitCode, undefined, "a token is never treated as a pattern");
assert.equal(literal.push(`\r\n${literal.marker}3\r\n`).exitCode, 3, "its own marker still completes the command");

console.log("ssh marker scanner tests: OK");
