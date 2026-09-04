import { beforeEach, describe, expect, it, vi } from "vitest";

const unlinkMock = vi.fn(async () => undefined);
const handleCloseMock = vi.fn(async () => undefined);
const handleWriteFileMock = vi.fn(async () => undefined);
const handleChmodMock = vi.fn(async () => undefined);
const handleSyncMock = vi.fn(async () => undefined);
const identity = { dev: 1, ino: 7, birthtimeMs: 10, mtimeMs: 11, size: 7 };
const handleStatMock = vi.fn(async () => identity);
const openMock = vi.fn(async () => ({
  writeFile: handleWriteFileMock,
  chmod: handleChmodMock,
  sync: handleSyncMock,
  stat: handleStatMock,
  close: handleCloseMock,
}));
const renameMock = vi.fn(async () => undefined);
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

describe("writeAtomic — temp file cleanup on write failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handleWriteFileMock.mockResolvedValue(undefined);
    handleChmodMock.mockResolvedValue(undefined);
    handleCloseMock.mockResolvedValue(undefined);
    handleStatMock.mockResolvedValue(identity);
    openMock.mockResolvedValue({
      writeFile: handleWriteFileMock,
      chmod: handleChmodMock,
      sync: handleSyncMock,
      stat: handleStatMock,
      close: handleCloseMock,
    });
    renameMock.mockResolvedValue(undefined);
    statMock.mockResolvedValue({ mode: 0o100644, nlink: 1, ...identity });
  });

  it("cleans up the temp file when writeFile on the temp handle fails", async () => {
    handleWriteFileMock.mockRejectedValue(new Error("write failed"));

    const { writeAtomic } = await import("../../../src/anchored-edit/fs-write");

    await expect(writeAtomic("/tmp/target.txt", "content")).rejects.toThrow(
      "write failed",
    );

    expect(unlinkMock).toHaveBeenCalledWith(
      expect.stringMatching(/\.tmp-/),
    );
    expect(handleCloseMock).toHaveBeenCalled();
  });

  it("cleans up the temp file when chmod on the temp handle fails", async () => {
    handleChmodMock.mockRejectedValue(new Error("chmod failed"));

    const { writeAtomic } = await import("../../../src/anchored-edit/fs-write");

    await expect(writeAtomic("/tmp/target.txt", "content")).rejects.toThrow(
      "chmod failed",
    );

    expect(unlinkMock).toHaveBeenCalledWith(
      expect.stringMatching(/\.tmp-/),
    );
    expect(handleCloseMock).toHaveBeenCalled();
  });

  it("does not remove anything when the write and chmod succeed", async () => {
    const { writeAtomic } = await import("../../../src/anchored-edit/fs-write");

    await writeAtomic("/tmp/target.txt", "content");

    expect(unlinkMock).not.toHaveBeenCalled();
    expect(renameMock).toHaveBeenCalledTimes(1);
  });
});
