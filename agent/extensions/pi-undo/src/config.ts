import { readFile } from "node:fs/promises";
import { posix } from "node:path";

export interface PiUndoConfig {
  readonly excludeDirectories: readonly string[];
}

/** Loads and validates project-local pi-undo configuration. */
export async function loadPiUndoConfig(configPath: string) {
  let content: string;
  try {
    content = await readFile(configPath, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return { excludeDirectories: [] } satisfies PiUndoConfig;
    }
    throw error;
  }
  return parsePiUndoConfig(JSON.parse(content));
}

/** Converts untrusted JSON data into canonical workspace-relative exclusions. */
export function parsePiUndoConfig(value: unknown): PiUndoConfig {
  if (!isRecord(value)) throw new Error("configuration must be a JSON object");
  const unknownKeys = Object.keys(value).filter(
    (key) => key !== "excludeDirectories",
  );
  if (unknownKeys.length > 0) {
    throw new Error(`unknown configuration key: ${unknownKeys.join(", ")}`);
  }

  const directories = value.excludeDirectories ?? [];
  if (!Array.isArray(directories))
    throw new Error("excludeDirectories must be an array");

  const canonical = directories.map((directory, index) => {
    if (typeof directory !== "string") {
      throw new Error(`excludeDirectories[${index}] must be a string`);
    }
    return canonicalDirectory(directory, index);
  });
  canonical.sort(comparePaths);

  const exclusions: string[] = [];
  for (const directory of canonical) {
    if (
      exclusions.some(
        (parent) => directory === parent || directory.startsWith(`${parent}/`),
      )
    ) {
      continue;
    }
    exclusions.push(directory);
  }
  return { excludeDirectories: exclusions };
}

function canonicalDirectory(value: string, index: number) {
  const trimmed = value.trim().replace(/^\.\//, "").replace(/\/+$/, "");
  if (
    trimmed.length === 0 ||
    trimmed === "." ||
    trimmed.includes("\\") ||
    trimmed.includes("\0") ||
    trimmed.startsWith("/") ||
    /^[A-Za-z]:/.test(trimmed)
  ) {
    throw new Error(
      `excludeDirectories[${index}] must be a workspace-relative directory`,
    );
  }
  const normalized = posix.normalize(trimmed);
  const parts = normalized.split("/");
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    parts.some(
      (part) => part === "." || part === ".." || part.toLowerCase() === ".git",
    )
  ) {
    throw new Error(`excludeDirectories[${index}] contains an unsafe path`);
  }
  return normalized;
}

function comparePaths(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasErrorCode(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
