import { beforeEach, describe, expect, it, vi } from "vitest";

const unlinkMock = vi.fn(async () => undefined);
const renameMock = vi.fn(async () => undefined);
const handleSyncMock = vi.fn(async () => undefined);
const identity = { dev: 1, ino: 7, birthtimeMs: 10, mtimeMs: 11, size: 7 };
const openMock = vi.fn(async () => ({
  writeFile: vi.fn(async () => undefined),
  chmod: vi.fn(async () => undefined),
  sync: handleSyncMock,
  stat: vi.fn(async () => identity),
  close: vi.fn(async () => undefined),
}));
const mkdirMock = vi.fn(async () => undefined);
const statMock = vi.fn(async () => ({ mode: 0o100644, nlink: 1, ...identity }));
const lstatMock = vi.fn(async () => ({ isSymbolicLink: () => false, isFile: () => true, ...identity }));
const readlinkMock = vi.fn(async () => "");

vi.mock("fs/promises", () => ({
  lstat: lstatMock,
  mkdir: mkdirMock,
  open: openMock,
  readlink: readlinkMock,
  rename: renameMock,
  unlink: unlinkMock,
  stat: statMock,
}));

describe("writeAtomic temp-file cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    renameMock.mockResolvedValue(undefined);
    handleSyncMock.mockResolvedValue(undefined);
  });

  it("removes its own temp file, identity-checked, when rename fails", async () => {
    renameMock.mockRejectedValue(new Error("rename failed"));

    const { writeAtomic } = await import("../../../src/anchored-edit/fs-write");

    await expect(writeAtomic("/tmp/target.txt", "content")).rejects.toThrow(
      "rename failed",
    );

    expect(unlinkMock).toHaveBeenCalledTimes(1);
    expect(unlinkMock).toHaveBeenCalledWith(
      expect.stringMatching(/\.tmp-/),
    );
  });

  it("does not remove anything when rename succeeds", async () => {
    const { writeAtomic } = await import("../../../src/anchored-edit/fs-write");

    await writeAtomic("/tmp/target.txt", "content");

    expect(renameMock).toHaveBeenCalledTimes(1);
    expect(unlinkMock).not.toHaveBeenCalled();
  });
});
