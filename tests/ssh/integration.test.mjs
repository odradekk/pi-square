import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ssh2 from "ssh2";
import jiti from "jiti";

const { Server, utils } = ssh2;

const load = jiti(import.meta.url, { moduleCache: false });
const { hostFingerprint, SshSessionManager } = await load("../../src/ssh/manager.ts");

const temp = mkdtempSync(join(tmpdir(), "pi-square-ssh-integration-"));
const hostKey = utils.generateKeyPairSync("ed25519");
const clientKey = utils.generateKeyPairSync("ed25519");
const privateKeyPath = join(temp, "id_ed25519");
writeFileSync(privateKeyPath, clientKey.private, { mode: 0o600 });
const parsedHostKey = utils.parseKey(hostKey.private);
assert.ok(!(parsedHostKey instanceof Error));
const fingerprint = hostFingerprint(parsedHostKey.getPublicSSH());

const openStreams = new Set();
const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
  client.on("error", () => {});
  client.on("authentication", (context) => {
    if (context.method === "publickey" && context.username === "tester") context.accept();
    else context.reject();
  });
  client.on("ready", () => {
    client.on("session", (accept) => {
      const session = accept();
      session.on("pty", (acceptPty) => acceptPty());
      session.on("shell", (acceptShell) => {
        const stream = acceptShell();
        openStreams.add(stream);
        let cwd = "/home/tester";
        let pendingLong;
        stream.on("close", () => openStreams.delete(stream));
        stream.on("data", (chunk) => {
          const text = chunk.toString("utf8");
          if (pendingLong && text.includes("continue")) {
            stream.write(`resumed\r\n${pendingLong}0\r\n`);
            pendingLong = undefined;
            return;
          }
          const marker = text.match(/(__PI_SSH_[a-f0-9]+__:)/)?.[1];
          if (!marker) return;
          const command = text.split("\n", 1)[0];
          if (command.includes("PROMPT_COMMAND")) {
            stream.write(`\r\n${marker}0\r\n`);
          } else if (command.startsWith("cd ")) {
            cwd = command.slice(3).trim();
            stream.write(`\r\n${marker}0\r\n`);
          } else if (command === "pwd") {
            stream.write(`${cwd}\r\n${marker}0\r\n`);
          } else if (command === "long") {
            pendingLong = marker;
            stream.write("approval: ");
          } else {
            stream.write(`ran:${command}\r\n${marker}0\r\n`);
          }
        });
      });
    });
  });
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
assert.ok(address && typeof address === "object");

function makeConfig(expectedFingerprint) {
  return {
    maxSessions: 2,
    profiles: [{
      name: "integration",
      defaultTarget: "local",
      targets: [{ name: "local", host: "127.0.0.1", port: address.port, username: "tester", fingerprints: [expectedFingerprint] }],
      auth: { method: "privateKey", privateKeyPath },
      maxSessions: 2,
      idleTimeoutMinutes: 30,
      connectTimeoutMs: 5_000,
      keepaliveIntervalMs: 1_000,
      keepaliveCountMax: 2,
    }],
  };
}

const manager = new SshSessionManager();
try {
  manager.configure(makeConfig(fingerprint));
  const session = await manager.connect("integration", undefined, undefined, async () => {
    throw new Error("unencrypted test key must not request a passphrase");
  });

  let result = await session.command("cd /srv", 1_000);
  assert.equal(result.state, "completed");
  result = await session.command("pwd", 1_000);
  assert.equal(result.state, "completed");
  assert.match(result.page.text, /\/srv/, "commands must share one persistent shell state");

  result = await session.command("long", 10);
  assert.equal(result.state, "running");
  assert.match(result.page.text, /approval:/);
  session.input("continue", true);
  const resumed = await session.read(result.page.nextCursor, 1_000);
  assert.match(resumed.page.text, /resumed/);
  assert.equal(session.summary().commandState, "idle");
  manager.close(session.id);

  const rejected = new SshSessionManager();
  rejected.configure(makeConfig("SHA256:AAAAAAAAAAAAAAAAAAAAAA"));
  await assert.rejects(
    () => rejected.connect("integration", undefined, undefined, async () => undefined),
    /fingerprint|verification|handshake|connection/i,
  );
  rejected.dispose();
} finally {
  manager.dispose();
  for (const stream of openStreams) stream.close();
  await new Promise((resolve) => server.close(resolve));
  rmSync(temp, { recursive: true, force: true });
}

console.log("ssh integration tests: OK");
