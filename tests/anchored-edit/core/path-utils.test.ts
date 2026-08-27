import { describe, expect, it } from "vitest";
import * as os from "os";
import { resolve } from "path";
import { toCwd } from "../../../src/anchored-edit/paths";

describe("toCwd", () => {
  const cwd = "/home/user/project";

  it("resolves a relative path against cwd", () => {
    expect(toCwd("src/main.ts", cwd)).toBe(
      resolve(cwd, "src/main.ts"),
    );
  });

  it("returns absolute paths unchanged", () => {
    expect(toCwd("/etc/hosts", cwd)).toBe("/etc/hosts");
  });

  it("expands ~ to home directory", () => {
    expect(toCwd("~/file.txt", cwd)).toBe(
      os.homedir() + "/file.txt",
    );
  });

  it("expands bare ~ to home directory", () => {
    expect(toCwd("~", cwd)).toBe(os.homedir());
  });

  // Native path authority (#185): toCwd mirrors Pi 0.84.2's normalizePath
  // (utils/paths.ts) — a leading @ mention prefix is stripped, unicode
  // spaces fold to plain spaces, and the strip happens before ~ expansion —
  // so the anchored tools resolve exactly the path the Pi factory resolved.
  it("strips a leading @ mention prefix like Pi's native tools", () => {
    expect(toCwd("@src/main.ts", cwd)).toBe(
      resolve(cwd, "src/main.ts"),
    );
  });

  it("folds unicode spaces to plain spaces like Pi's native tools", () => {
    expect(toCwd("src/my\u00A0file.ts", cwd)).toBe(
      resolve(cwd, "src/my file.ts"),
    );
  });

  it("strips @ before ~ expansion, so @~ reaches the home directory", () => {
    expect(toCwd("@~/notes.md", cwd)).toBe(
      os.homedir() + "/notes.md",
    );
  });

  it("decodes file:// URLs to paths", () => {
    expect(toCwd(`file://${resolve(cwd, "src/main.ts")}`, cwd)).toBe(
      resolve(cwd, "src/main.ts"),
    );
  });
});
