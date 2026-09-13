import { join } from "node:path";
import {
  CONFIG_DIR_NAME,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { ACCOUNTS_FILE, parseAccountName } from "./account-store.ts";
import { type AccountProviderId, SUPPORTED_PROVIDER_IDS } from "./oauth.ts";
import { FileAccountStorageBackend } from "./storage.ts";

export type ProjectDefaults = Partial<Record<AccountProviderId, string | null>>;

export class ProjectDefaultsError extends Error {
  constructor() {
    super(
      `Could not read or save ${CONFIG_DIR_NAME}/${ACCOUNTS_FILE} project defaults. ` +
        "Check file permissions and JSON (defaults must map supported provider IDs to account names or null). " +
        "Fix the file and reload, or choose a session account from /accounts to recover.",
    );
    this.name = "ProjectDefaultsError";
  }
}

export function parseProjectDefaults(raw: string | undefined): ProjectDefaults {
  if (raw === undefined) return {};
  try {
    const data: unknown = JSON.parse(raw);
    if (
      !isRecord(data) ||
      Object.keys(data).some((key) => key !== "defaults") ||
      !isRecord(data.defaults)
    ) {
      throw new ProjectDefaultsError();
    }
    const defaults: ProjectDefaults = {};
    for (const [provider, value] of Object.entries(data.defaults)) {
      if (!(SUPPORTED_PROVIDER_IDS as readonly string[]).includes(provider))
        throw new ProjectDefaultsError();
      const id = provider as AccountProviderId;
      if (value === null) {
        defaults[id] = null;
        continue;
      }
      if (typeof value !== "string") throw new ProjectDefaultsError();
      const parsed = parseAccountName(value);
      if (!parsed.ok) throw new ProjectDefaultsError();
      defaults[id] =
        parsed.name.toLowerCase() === "default" ? null : parsed.name;
    }
    return defaults;
  } catch {
    // Do not echo JSON or parse errors: a user might have pasted credentials here.
    throw new ProjectDefaultsError();
  }
}

export class ProjectDefaultsStore {
  readonly path: string;
  private readonly backend: FileAccountStorageBackend;

  constructor(cwd: string) {
    this.path = join(cwd, CONFIG_DIR_NAME, ACCOUNTS_FILE);
    this.backend = new FileAccountStorageBackend(this.path);
  }

  async read() {
    try {
      return await this.backend.readAsync(async (raw) =>
        parseProjectDefaults(raw),
      );
    } catch {
      throw new ProjectDefaultsError();
    }
  }

  async set(
    provider: AccountProviderId,
    account: string | null | undefined,
    isCurrent: () => boolean,
  ) {
    try {
      return await this.backend.withLockAsync(async (raw) => {
        if (!isCurrent()) throw new DOMException("Menu closed", "AbortError");
        const defaults = parseProjectDefaults(raw);
        // Undefined inherits the global default; null explicitly selects Pi's built-in login.
        if (account === undefined) delete defaults[provider];
        else defaults[provider] = account;
        const next = `${JSON.stringify({ defaults }, null, 2)}\n`;
        return { result: parseProjectDefaults(next), next };
      });
    } catch {
      throw new ProjectDefaultsError();
    }
  }
}

export async function loadProjectDefaults(
  ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
) {
  if (!ctx.isProjectTrusted()) return {} as ProjectDefaults;
  return new ProjectDefaultsStore(ctx.cwd).read();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
