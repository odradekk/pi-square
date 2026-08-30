import { describe, expect, it } from "vitest";
import { readNormFile } from "../../../src/anchored-edit/file-reader";
import { withTempFile, withTempDir, loadTestStore } from "../support/fixtures";

describe("readNormFile", () => {
	it("reads a normal file and returns NormFile with correct fields", async () => {
		await withTempFile("sample.txt", "hello\nworld", async ({ cwd }) => {
			const store = await loadTestStore(cwd);
			try {
				const result = await readNormFile("sample.txt", cwd, { store });
				expect(result.absolutePath).toMatch(/sample\.txt$/);
				expect(result.normalized).toBe("hello\nworld");
				expect(result.bom).toBe("");
				expect(result.originalEnding).toBe("\n");
				expect(result.fileHashes).toHaveLength(2);
				expect(result.fileHashes[0]).toMatch(/^[A-Za-z0-9]{3}$/);
				expect(result.fileHashes[1]).toMatch(/^[A-Za-z0-9]{3}$/);
				expect(result.hadUtf8DecodeErrors).toBe(false);
			} finally {
				store.release();
			}
		});
	});

	it("preserves a UTF-8 BOM in the bom field", async () => {
		await withTempFile("bom.txt", "hello", async ({ cwd, path }) => {
			const { writeFile } = await import("fs/promises");
			await writeFile(path, "\uFEFFhello\n", "utf-8");
			const store = await loadTestStore(cwd);
			try {
				const result = await readNormFile("bom.txt", cwd, { store });
				expect(result.bom).toBe("\uFEFF");
				expect(result.normalized).toBe("hello\n");
			} finally {
				store.release();
			}
		});
	});

	it("detects CRLF line endings and normalizes to LF", async () => {
		await withTempFile("crlf.txt", "hello", async ({ cwd, path }) => {
			const { writeFile } = await import("fs/promises");
			await writeFile(path, "alpha\r\nbeta\r\n", "utf-8");
			const store = await loadTestStore(cwd);
			try {
				const result = await readNormFile("crlf.txt", cwd, { store });
				expect(result.originalEnding).toBe("\r\n");
				expect(result.normalized).toBe("alpha\nbeta\n");
			} finally {
				store.release();
			}
		});
	});

	it("detects LF line endings and leaves content unchanged", async () => {
		await withTempFile("lf.txt", "alpha\nbeta", async ({ cwd }) => {
			const store = await loadTestStore(cwd);
			try {
				const result = await readNormFile("lf.txt", cwd, { store });
				expect(result.originalEnding).toBe("\n");
				expect(result.normalized).toBe("alpha\nbeta");
			} finally {
				store.release();
			}
		});
	});

	it("uses a preloaded LFile when provided", async () => {
		await withTempFile("sample.txt", "ignored", async ({ cwd }) => {
			const preloaded = {
				kind: "text" as const,
				text: "preloaded\ncontent",
			};
			const store = await loadTestStore(cwd);
			try {
				const result = await readNormFile("sample.txt", cwd, { preloadedFile: preloaded, store });
				expect(result.normalized).toBe("preloaded\ncontent");
			} finally {
				store.release();
			}
		});
	});

	it("throws File not found for non-existent file", async () => {
		await withTempDir("filereader-missing-", async (dir) => {
			const store = await loadTestStore(dir);
			try {
				await expect(
					readNormFile("nonexistent.txt", dir, { store }),
				).rejects.toThrow("File not found");
			} finally {
				store.release();
			}
		});
	});

	it("computes correct hashes for the normalized content", async () => {
		await withTempFile("data.txt", "aaa\nbbb\nccc", async ({ cwd }) => {
			const store = await loadTestStore(cwd);
			try {
				const result = await readNormFile("data.txt", cwd, { store });
				expect(result.fileHashes).toHaveLength(3);

				expect(result.fileHashes[0]).not.toBe(result.fileHashes[1]);
				expect(result.fileHashes[1]).not.toBe(result.fileHashes[2]);
			} finally {
				store.release();
			}
		});
	});

	it("handles a file without trailing newline", async () => {
		await withTempFile("notrailing.txt", "hello\nworld", async ({ cwd }) => {
			const store = await loadTestStore(cwd);
			try {
				const result = await readNormFile("notrailing.txt", cwd, { store });
				expect(result.normalized).toBe("hello\nworld");
				expect(result.fileHashes).toHaveLength(2);
			} finally {
				store.release();
			}
		});
	});

	it("handles bare CR line endings (old Mac style)", async () => {
		await withTempFile("oldmac.txt", "hello", async ({ cwd, path }) => {
			const { writeFile } = await import("fs/promises");
			await writeFile(path, "alpha\rbeta\r", "utf-8");
			const store = await loadTestStore(cwd);
			try {
				const result = await readNormFile("oldmac.txt", cwd, { store });
				expect(result.normalized).toBe("alpha\nbeta\n");
			} finally {
				store.release();
			}
		});
	});

	describe("maxLines guard", () => {
		it("rejects files exceeding the limit before hashing", async () => {
			await withTempFile("big.txt", "a\nb\nc\nd\ne", async ({ cwd }) => {
				const store = await loadTestStore(cwd);
				try {
					await expect(
						readNormFile("big.txt", cwd, { maxLines: 3, store }),
					).rejects.toThrow(/\[E_FILE_TOO_LARGE\]/);
				} finally {
					store.release();
				}
			});
		});

		it("allows files at or under the limit", async () => {
			await withTempFile("ok.txt", "a\nb\nc", async ({ cwd }) => {
				const store = await loadTestStore(cwd);
				try {
					const result = await readNormFile("ok.txt", cwd, { maxLines: 5, store });
					expect(result.fileHashes).toHaveLength(3);
				} finally {
					store.release();
				}
			});
		});

		it("does not enforce the guard when maxLines is omitted (read path)", async () => {
			await withTempFile("plain.txt", "a\nb\nc\nd\ne", async ({ cwd }) => {
				const store = await loadTestStore(cwd);
				try {
					const result = await readNormFile("plain.txt", cwd, { store });
					expect(result.fileHashes).toHaveLength(5);
				} finally {
					store.release();
				}
			});
		});
	});
});
