import { beforeEach, describe, expect, it, vi } from "vitest";

const isWindows = process.platform === "win32";

const writeFileMock = vi.fn(async () => undefined);
const handleWriteFileMock = vi.fn(async () => undefined);
const handleChmodMock = vi.fn(async () => undefined);
const handleCloseMock = vi.fn(async () => undefined);
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
const statMock = vi.fn(async () => ({ mode: 0o100600, nlink: 1 }));
const lstatMock = vi.fn(async () => ({ isSymbolicLink: () => false, isFile: () => true }));
const readlinkMock = vi.fn(async () => "");

vi.mock("fs/promises", () => ({
	lstat: lstatMock,
	open: openMock,
	unlink: vi.fn(async () => undefined),
	mkdir: mkdirMock,
	readlink: readlinkMock,
	rename: renameMock,
	stat: statMock,
	writeFile: writeFileMock,
}));

describe.skipIf(isWindows)("writeAtomic permissions", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		openMock.mockResolvedValue({
			writeFile: handleWriteFileMock,
			chmod: handleChmodMock,
			sync: handleSyncMock,
			stat: handleStatMock,
			close: handleCloseMock,
		});
		statMock.mockResolvedValue({ mode: 0o100600, nlink: 1, ...identity });
		lstatMock.mockResolvedValue({ isSymbolicLink: () => false, isFile: () => true, ...identity });
		handleStatMock.mockResolvedValue(identity);
	});

	it("creates the temporary file securely, writes content, then restores the target mode", async () => {
		const { writeAtomic } = await import("../../../src/anchored-edit/fs-write");

		await writeAtomic("/tmp/secret.txt", "secret\n");

		expect(openMock).toHaveBeenCalledWith(
			expect.stringMatching(/\/tmp\/.tmp-/),
			193, // O_CREAT|O_EXCL|O_WRONLY from the shared safe-write temp primitive
			0o600,
		);
		expect(handleWriteFileMock).toHaveBeenCalledWith("secret\n", "utf8");
		expect(handleChmodMock).toHaveBeenCalledWith(0o600);
		expect(handleCloseMock).toHaveBeenCalled();
		expect(writeFileMock).not.toHaveBeenCalled();
	});
});
