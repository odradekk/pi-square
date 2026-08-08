/**
 * Exhaustive display catalog for every model-callable tool.
 *
 * Each built-in Pi tool and every pi-square extension tool has exactly one
 * entry with a fixed family and explicit parent/child availability metadata.
 * Platform shell ownership is recorded for bash (non-Windows) and pwsh (Windows).
 */

import {
  DISPLAY_FAMILIES,
  DISPLAY_TOOL_NAME_REGEX,
  FAMILY_ICONS,
  MAX_ICON_CELLS,
  UNKNOWN_TOOL_ICON,
  type DisplayFamily,
} from "./types";

export interface DisplayToolCatalogEntry {
  readonly name: string;
  readonly family: DisplayFamily;
  readonly parent: boolean;
  readonly child: boolean;
  /** Platform-exclusive shell ownership. */
  readonly platformShell?: "non-windows" | "windows";
  readonly description: string;
}

export const DISPLAY_CATALOG: readonly DisplayToolCatalogEntry[] = Object.freeze(([
  // ── filesystem ──────────────────────────────────────────────────
  {
    name: "read",
    family: "filesystem",
    parent: true,
    child: true,
    description: "Read file contents or image attachments",
  },
  {
    name: "ls",
    family: "filesystem",
    parent: true,
    child: true,
    description: "List directory contents",
  },
  {
    name: "edit",
    family: "filesystem",
    parent: true,
    child: true,
    description: "Edit a file using targeted text replacement",
  },
  {
    name: "write",
    family: "filesystem",
    parent: true,
    child: true,
    description: "Write content to a file",
  },
  {
    name: "find",
    family: "filesystem",
    parent: true,
    child: true,
    description: "Find files and directories by pattern",
  },
  {
    name: "fd",
    family: "filesystem",
    parent: true,
    child: true,
    description: "Find files and directories using a bundled fd binary",
  },
  // ── search ──────────────────────────────────────────────────────
  {
    name: "grep",
    family: "search",
    parent: true,
    child: true,
    description: "Search file contents using literal or regex patterns",
  },
  {
    name: "rg",
    family: "search",
    parent: true,
    child: true,
    description: "Search file contents using a bundled ripgrep binary",
  },
  {
    name: "sg",
    family: "search",
    parent: true,
    child: true,
    description: "Search code structure using ast-grep patterns",
  },
  {
    name: "codegraph",
    family: "search",
    parent: true,
    child: true,
    description: "Query a local semantic code graph index",
  },
  {
    name: "pdf_search",
    family: "search",
    parent: true,
    child: true,
    description: "Search local PDF documents for text",
  },
  // ── execution ───────────────────────────────────────────────────
  {
    name: "bash",
    family: "execution",
    parent: true,
    child: true,
    platformShell: "non-windows",
    description: "Execute bash commands on non-Windows platforms",
  },
  {
    name: "pwsh",
    family: "execution",
    parent: true,
    child: true,
    platformShell: "windows",
    description: "Execute PowerShell commands on Windows",
  },
  {
    name: "scheme",
    family: "execution",
    parent: true,
    child: true,
    description: "Evaluate Chez Scheme code in a WASM sandbox",
  },
  // ── remote ──────────────────────────────────────────────────────
  {
    name: "search",
    family: "remote",
    parent: true,
    child: true,
    description: "Search the web using Jina",
  },
  {
    name: "fetch",
    family: "remote",
    parent: true,
    child: true,
    description: "Retrieve readable content from URLs",
  },
  {
    name: "libs",
    family: "remote",
    parent: true,
    child: true,
    description: "Search library documentation via Context7",
  },
  {
    name: "docs",
    family: "remote",
    parent: true,
    child: true,
    description: "Retrieve library documentation via Context7",
  },
  {
    name: "parse",
    family: "remote",
    parent: true,
    child: false,
    description: "Parse selected local PDF pages through Firecrawl",
  },
  {
    name: "github_search",
    family: "remote",
    parent: true,
    child: true,
    description: "Search GitHub repositories, code, and commits",
  },
  {
    name: "github_read",
    family: "remote",
    parent: true,
    child: true,
    description: "Read files from GitHub repositories",
  },
  {
    name: "github_tree",
    family: "remote",
    parent: true,
    child: true,
    description: "Browse GitHub repository trees",
  },
  {
    name: "github_commit",
    family: "remote",
    parent: true,
    child: true,
    description: "Inspect GitHub commit history",
  },
  {
    name: "ssh",
    family: "remote",
    parent: true,
    child: false,
    description: "Execute commands on persistent SSH shells",
  },
  // ── workflow ────────────────────────────────────────────────────
  {
    name: "todo",
    family: "workflow",
    parent: true,
    child: false,
    description: "Manage a bounded session task list",
  },
  {
    name: "ask",
    family: "workflow",
    parent: true,
    child: false,
    description: "Present interactive questions to the user",
  },
  {
    name: "time",
    family: "workflow",
    parent: true,
    child: false,
    description: "Return the current local date and time",
  },
  // ── agent ───────────────────────────────────────────────────────
  {
    name: "subagent_delegate",
    family: "agent",
    parent: true,
    child: false,
    description: "Delegate work to a child subagent",
  },
  {
    name: "subagent_resume",
    family: "agent",
    parent: true,
    child: false,
    description: "Resume an existing child subagent",
  },
] satisfies readonly DisplayToolCatalogEntry[]).map((entry) => Object.freeze(entry)));

// ── Lookup helpers ───────────────────────────────────────────────────

const CATALOG_BY_NAME: ReadonlyMap<string, DisplayToolCatalogEntry> = new Map(
  DISPLAY_CATALOG.map((entry) => [entry.name, entry]),
);

export function getCatalogEntry(name: string): DisplayToolCatalogEntry | undefined {
  return CATALOG_BY_NAME.get(name);
}

export function catalogFamilyFor(name: string): DisplayFamily | undefined {
  return CATALOG_BY_NAME.get(name)?.family;
}

/**
 * Per-tool icon overrides. A tool without an override uses the icon of its
 * family. Filesystem mutation and the three execution prompts are the only
 * operations whose icon differs from the family default.
 */
const TOOL_ICONS: Readonly<Record<string, string>> = Object.freeze({
  edit: "▣",
  write: "▣",
  bash: "$ ❯",
  pwsh: "PS ❯",
  scheme: "λ ❯",
});

/**
 * Resolve the fixed icon for a tool. Catalog tools resolve through their
 * override or family; an explicitly adapted tool with no catalog entry falls
 * back to its declared family, and finally to the generic unknown-tool icon.
 */
export function catalogIconFor(name: string, family?: DisplayFamily): string {
  const override = TOOL_ICONS[name];
  if (override) return override;
  const resolved = CATALOG_BY_NAME.get(name)?.family ?? family;
  return resolved ? FAMILY_ICONS[resolved] : UNKNOWN_TOOL_ICON;
}

export function catalogToolNames(): readonly string[] {
  return DISPLAY_CATALOG.map((entry) => entry.name);
}

export function catalogNamesByFamily(): ReadonlyMap<DisplayFamily, readonly string[]> {
  const map = new Map<DisplayFamily, string[]>();
  for (const family of DISPLAY_FAMILIES) map.set(family, []);
  for (const entry of DISPLAY_CATALOG) {
    map.get(entry.family)!.push(entry.name);
  }
  return map;
}

// ── Validation ───────────────────────────────────────────────────────

/**
 * Verify catalog invariants: unique names, one known family per tool,
 * explicit availability metadata, every family populated, and every
 * name matches the tool-name pattern. Returns a list of error strings
 * (empty when valid).
 */
export function validateCatalog(): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const entry of DISPLAY_CATALOG) {
    if (seen.has(entry.name)) {
      errors.push(`duplicate catalog tool name '${entry.name}'`);
    }
    seen.add(entry.name);

    if (!DISPLAY_FAMILIES.includes(entry.family)) {
      errors.push(`tool '${entry.name}' has unknown family '${entry.family}'`);
    }
    if (typeof entry.parent !== "boolean") {
      errors.push(`tool '${entry.name}' is missing boolean parent availability`);
    }
    if (typeof entry.child !== "boolean") {
      errors.push(`tool '${entry.name}' is missing boolean child availability`);
    }
    if (!entry.parent && !entry.child) {
      errors.push(`tool '${entry.name}' is available in neither parent nor child scope`);
    }
    if (!DISPLAY_TOOL_NAME_REGEX.test(entry.name)) {
      errors.push(`catalog tool name '${entry.name}' does not match the required pattern`);
    }

    const icon = catalogIconFor(entry.name);
    if (icon.length === 0) {
      errors.push(`tool '${entry.name}' resolves to an empty icon`);
    } else if (Array.from(icon).length > MAX_ICON_CELLS) {
      errors.push(`tool '${entry.name}' resolves to an icon wider than ${MAX_ICON_CELLS} cells`);
    }
  }

  const familiesInUse = new Set(DISPLAY_CATALOG.map((e) => e.family));
  for (const family of DISPLAY_FAMILIES) {
    if (!familiesInUse.has(family)) {
      errors.push(`family '${family}' has no catalog entries`);
    }
  }

  return errors;
}
