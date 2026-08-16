import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { MAX_BYTES } from "../../../src/anchored-edit/constants";
import { loadFileKindAndText } from "../../../src/anchored-edit/file-kind";
import { withTempFile } from "../support/fixtures";

describe("loadFileKindAndText", () => {
	it("reads a text file and returns its content", async () => {
		await withTempFile("sample.txt", "hello\nworld\n", async ({ cwd }) => {
			const result = await loadFileKindAndText(join(cwd, "sample.txt"));
			expect(result.kind).toBe("text");
			if (result.kind === "text") {
				expect(result.text).toBe("hello\nworld\n");
				expect(result.hadUtf8DecodeErrors).toBeUndefined();
			}
		});
	});

	it("returns empty text for an empty file", async () => {
		await withTempFile("empty.txt", "", async ({ cwd }) => {
			const result = await loadFileKindAndText(join(cwd, "empty.txt"));
			expect(result.kind).toBe("text");
			if (result.kind === "text") {
				expect(result.text).toBe("");
			}
		});
	});

	it("detects a directory", async () => {
		await withTempFile("placeholder.txt", "x", async ({ cwd }) => {
			const dirPath = join(cwd, "subdir");
			await mkdir(dirPath);
			const result = await loadFileKindAndText(dirPath);
			expect(result.kind).toBe("directory");
		});
	});

	it("allows null bytes in text content (valid in JS string literals)", async () => {
		await withTempFile("placeholder.txt", "x", async ({ cwd }) => {
			const binPath = join(cwd, "binary.bin");
			await writeFile(binPath, Buffer.from([0x48, 0x00, 0x65, 0x6c, 0x6c, 0x6f]));
			const result = await loadFileKindAndText(binPath);
			expect(result.kind).toBe("text");
		});
	});

	it("detects non-UTF-8 bytes and flags hadUtf8DecodeErrors", async () => {
		await withTempFile("placeholder.txt", "x", async ({ cwd }) => {
			const legacyPath = join(cwd, "legacy.bin");
			await writeFile(legacyPath, Buffer.from([0x61, 0x62, 0x63, 0x80, 0x81]));
			const result2 = await loadFileKindAndText(legacyPath);
			expect(result2.kind).toBe("text");
			if (result2.kind === "text") {
				expect(result2.hadUtf8DecodeErrors).toBe(true);
			}
		});
	});

	it("rejects UTF-16LE with BOM as binary", async () => {
		await withTempFile("placeholder.txt", "x", async ({ cwd }) => {
			const path = join(cwd, "utf16le.txt");
			await writeFile(path, Buffer.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]));
			const result = await loadFileKindAndText(path);
			expect(result.kind).toBe("binary");
			if (result.kind === "binary") {
				expect(result.description).toContain("UTF-16LE");
			}
		});
	});

	it("rejects UTF-16BE with BOM as binary", async () => {
		await withTempFile("placeholder.txt", "x", async ({ cwd }) => {
			const path = join(cwd, "utf16be.txt");
			await writeFile(path, Buffer.from([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]));
			const result = await loadFileKindAndText(path);
			expect(result.kind).toBe("binary");
			if (result.kind === "binary") {
				expect(result.description).toContain("UTF-16BE");
			}
		});
	});

	it("rejects UTF-32LE with BOM as binary", async () => {
		await withTempFile("placeholder.txt", "x", async ({ cwd }) => {
			const path = join(cwd, "utf32le.txt");
			await writeFile(path, Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x68, 0x00, 0x00, 0x00]));
			const result = await loadFileKindAndText(path);
			expect(result.kind).toBe("binary");
			if (result.kind === "binary") {
				expect(result.description).toContain("UTF-32LE");
			}
		});
	});

	it("rejects UTF-32BE with BOM as binary", async () => {
		await withTempFile("placeholder.txt", "x", async ({ cwd }) => {
			const path = join(cwd, "utf32be.txt");
			await writeFile(path, Buffer.from([0x00, 0x00, 0xfe, 0xff, 0x00, 0x00, 0x00, 0x68]));
			const result = await loadFileKindAndText(path);
			expect(result.kind).toBe("binary");
			if (result.kind === "binary") {
				expect(result.description).toContain("UTF-32BE");
			}
		});
	});
	it("classifies files over the byte limit as too_large", async () => {
		await withTempFile("huge.txt", "x", async ({ path }) => {
			const { truncate } = await import("fs/promises");
			await truncate(path, MAX_BYTES + 1);
			const result = await loadFileKindAndText(path);
			expect(result.kind).toBe("too_large");
			if (result.kind === "too_large") {
				expect(result.description).toContain("100MB");
			}
		});
	});
});


describe("loadFileKindAndText — maxLines early bailout", () => {
  it("rejects files exceeding maxLines during decode", async () => {
    await withTempFile("many-lines.txt", Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n"), async ({ cwd }) => {
      const path = join(cwd, "many-lines.txt");
      await expect(
        loadFileKindAndText(path, { maxLines: 5 }),
      ).rejects.toThrow(/\[E_FILE_TOO_LARGE\].*more than 5 lines/);
    });
  });

  it("uses displayPath in the error message when provided", async () => {
    await withTempFile("many-lines.txt", Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n"), async ({ cwd }) => {
      const path = join(cwd, "many-lines.txt");
      await expect(
        loadFileKindAndText(path, { maxLines: 5, displayPath: "many-lines.txt" }),
      ).rejects.toThrow(/\[E_FILE_TOO_LARGE\] many-lines\.txt/);
    });
  });

  it("accepts files at the boundary", async () => {
    await withTempFile("ok-lines.txt", Array.from({ length: 5 }, (_, i) => `line${i}`).join("\n"), async ({ cwd }) => {
      const path = join(cwd, "ok-lines.txt");
      const result = await loadFileKindAndText(path, { maxLines: 5 });
      expect(result.kind).toBe("text");
    });
  });

  it("counts CRLF line endings towards the limit", async () => {
    await withTempFile("crlf-lines.txt", "a", async ({ path }) => {
      const { writeFile } = await import("fs/promises");
      await writeFile(path, Array.from({ length: 8 }, (_, i) => `line${i}`).join("\r\n"), "utf-8");
      await expect(
        loadFileKindAndText(path, { maxLines: 5 }),
      ).rejects.toThrow(/\[E_FILE_TOO_LARGE\]/);
    });
  });

  it("is a no-op when maxLines is omitted", async () => {
    await withTempFile("plain-lines.txt", Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n"), async ({ cwd }) => {
      const result = await loadFileKindAndText(join(cwd, "plain-lines.txt"));
      expect(result.kind).toBe("text");
    });
  });
});

describe("loadFileKindAndText — image detection", () => {
  const ftypBox = (brand: string): Buffer => {
    const box = Buffer.alloc(24);
    box.writeUInt32BE(24, 0);
    box.write("ftyp", 4, "latin1");
    box.write(brand, 8, "latin1");
    box.write(brand, 16, "latin1");
    box.write("mif1", 20, "latin1");
    return box;
  };
  const crc32 = (buf: Buffer): Buffer => {
    let c = -1;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    const out = Buffer.alloc(4);
    out.writeUInt32BE((c ^ -1) >>> 0);
    return out;
  };
  const pngChunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeBuf = Buffer.from(type, "ascii");
    return Buffer.concat([len, typeBuf, data, crc32(Buffer.concat([typeBuf, data]))]);
  };
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(1, 0);
  ihdrData.writeUInt32BE(1, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 2;
  const acTLData = Buffer.alloc(8);
  acTLData.writeUInt32BE(1, 0);
  const apngBytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdrData),
    pngChunk("acTL", acTLData),
  ]);

  it("treats AVIF, HEIC, and HEIF ftyp brands as binary", async () => {
    await withTempFile("placeholder.txt", "x", async ({ cwd }) => {
      const cases: [string, string][] = [
        ["avif", "image/avif"],
        ["heic", "image/heic"],
        ["mif1", "image/heif"],
      ];
      for (const [brand, mime] of cases) {
        const path = join(cwd, `img-${brand}.bin`);
        await writeFile(path, ftypBox(brand));
        const result = await loadFileKindAndText(path);
        expect(result.kind, brand).toBe("binary");
        if (result.kind === "binary") expect(result.description).toBe(mime);
      }
    });
  });

  it("treats TIFF, ICO, JXL, JP2, PSD, and APNG as binary", async () => {
    await withTempFile("placeholder.txt", "x", async ({ cwd }) => {
      const tiff = Buffer.concat([
        Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]),
        Buffer.alloc(24),
      ]);
      const ico = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10]);
      const jxl = Buffer.from([0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a]);
      const jp2 = Buffer.alloc(64);
      Buffer.from([0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a]).copy(jp2, 0);
      jp2.write("jp2 ", 20, "latin1");
      const psd = Buffer.from("8BPS\x00\x01\x00\x00\x00\x00\x00\x00\x00\x00");
      const cases: [string, Buffer, string][] = [
        ["tiff", tiff, "image/tiff"],
        ["ico", ico, "image/x-icon"],
        ["jxl", jxl, "image/jxl"],
        ["jp2", jp2, "image/jp2"],
        ["psd", psd, "image/vnd.adobe.photoshop"],
        ["apng", apngBytes, "image/apng"],
      ];
      for (const [name, bytes, mime] of cases) {
        const path = join(cwd, `img-${name}.bin`);
        await writeFile(path, bytes);
        const result = await loadFileKindAndText(path);
        expect(result.kind, name).toBe("binary");
        if (result.kind === "binary") expect(result.description).toBe(mime);
      }
    });
  });

  it("detects a real BMP as an image attachment", async () => {
    await withTempFile("placeholder.txt", "x", async ({ cwd }) => {
      const bmp = Buffer.from([0x42, 0x4d, 0x36, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x36, 0x00, 0x00, 0x00]);
      const path = join(cwd, "img.bmp");
      await writeFile(path, bmp);
      const result = await loadFileKindAndText(path);
      expect(result.kind).toBe("image");
      if (result.kind === "image") expect(result.mimeType).toBe("image/bmp");
    });
  });

  it("treats loose-magic text as text, not as an image or binary", async () => {
    await withTempFile("placeholder.txt", "x", async ({ cwd }) => {
      const cases: [string, string][] = [
        ["bm.txt", "BMW is a car company\nsecond line\n"],
        ["icns.txt", "icnsomething\n"],
        ["psd.txt", "8BPSomething\n"],
      ];
      for (const [name, content] of cases) {
        const path = join(cwd, name);
        await writeFile(path, content, "utf-8");
        const result = await loadFileKindAndText(path);
        expect(result.kind, name).toBe("text");
        if (result.kind === "text") expect(result.text, name).toBe(content);
      }
    });
  });
});
