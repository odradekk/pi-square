import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { anchoredStoreDir, anchoredHashStorePath } from "../../../src/anchored-edit/paths";

const root = join(tmpdir(), "pi-square-anchored-paths");

describe("anchoredStoreDir", () => {
  it("places the store inside the session's own directory", () => {
    expect(anchoredStoreDir(join(root, "session-a"), root)).toBe(
      join(root, "session-a", "anchored-edit"),
    );
  });

  it("falls back to the OS temp directory when the session has no persistent directory", () => {
    const fallback = anchoredStoreDir(undefined, root);
    const key = createHash("sha256").update(root).digest("hex").slice(0, 16);
    expect(fallback).toBe(join(tmpdir(), "pi-square-anchored-edit", key));
  });

  it("treats an empty or whitespace-only session directory as absent", () => {
    expect(anchoredStoreDir("", root)).toBe(anchoredStoreDir(undefined, root));
    expect(anchoredStoreDir("   ", root)).toBe(anchoredStoreDir(undefined, root));
  });

  it("keys the fallback by the workspace root, so two workspaces never share a throwaway store", () => {
    const a = anchoredStoreDir(undefined, join(root, "ws-a"));
    const b = anchoredStoreDir(undefined, join(root, "ws-b"));
    expect(a).not.toBe(b);
  });

  it("is stable for the same inputs", () => {
    expect(anchoredStoreDir(undefined, root)).toBe(anchoredStoreDir(undefined, root));
    expect(anchoredStoreDir(join(root, "s"), root)).toBe(anchoredStoreDir(join(root, "s"), root));
  });

  it("keeps the session directory authoritative over the workspace root", () => {
    // Two different workspaces whose sessions share one session directory
    // resolve the same store: the session directory, not the workspace,
    // owns the store location.
    const sessionDir = join(root, "shared-session");
    expect(anchoredStoreDir(sessionDir, join(root, "ws-a"))).toBe(
      anchoredStoreDir(sessionDir, join(root, "ws-b")),
    );
  });
});

describe("anchoredHashStorePath", () => {
  it("names the hash-store database inside the store directory", () => {
    expect(anchoredHashStorePath(join(root, "anchored-edit"))).toBe(
      join(root, "anchored-edit", "hash-store.sqlite"),
    );
  });
});
