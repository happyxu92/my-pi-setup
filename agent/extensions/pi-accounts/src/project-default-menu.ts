import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import { type AccountStore, getOwnCredential } from "./account-store.ts";
import type { AccountProviderAdapter, AccountProviderId } from "./oauth.ts";
import { ProjectDefaultsStore } from "./project-defaults.ts";

export async function showProjectDefaultsMenu(
  ctx: ExtensionCommandContext,
  store: AccountStore,
  adapters: Map<AccountProviderId, AccountProviderAdapter>,
  owner: { signal: AbortSignal; isCurrent(): boolean },
) {
  if (!ctx.hasUI || !owner.isCurrent()) return;
  if (!ctx.isProjectTrusted()) {
    ctx.ui.notify(
      "Project defaults require a trusted project. Use /trust and restart Pi first.",
      "warning",
    );
    return;
  }
  const project = new ProjectDefaultsStore(ctx.cwd);
  try {
    const providers = [...adapters.values()].sort((a, b) =>
      a.displayName.localeCompare(b.displayName),
    );
    const selected = await ctx.ui.select(
      `Project default account — ${sanitizeTerminalText(ctx.cwd)}`,
      providers.map((provider) => provider.displayName),
      { signal: owner.signal },
    );
    if (!owner.isCurrent() || selected === undefined) return;
    const provider = providers.find(
      (candidate) => candidate.displayName === selected,
    );
    if (!provider) return;
    const defaults = await project.read();
    const state = await store.readProviderAsync(provider.id);
    if (!owner.isCurrent()) return;
    const inherited = state.active ?? "Pi built-in login";
    const saved = defaults[provider.id];
    const options: { label: string; account: string | null | undefined }[] = [
      { label: `Inherit global default (${inherited})`, account: undefined },
      { label: "Pi built-in login", account: null },
      ...Object.keys(state.accounts)
        .sort()
        .map((name) => ({ label: `Account: ${name}`, account: name })),
    ];
    const choice = await ctx.ui.select(
      `Default ${provider.displayName} account for new project sessions\n` +
        `Saved: ${saved === undefined ? `inherit global (${inherited})` : (saved ?? "Pi built-in login")}\n` +
        "Selecting saves immediately. This session is unchanged.",
      options.map((option) => option.label),
      { signal: owner.signal },
    );
    if (!owner.isCurrent() || choice === undefined) return;
    const option = options.find((candidate) => candidate.label === choice);
    if (!option) return;
    if (typeof option.account === "string") {
      const latest = await store.readProviderAsync(provider.id);
      if (!owner.isCurrent()) return;
      if (!getOwnCredential(latest.accounts, option.account)) {
        ctx.ui.notify(
          "Account no longer exists. Reopen /accounts and choose another account.",
          "error",
        );
        return;
      }
    }
    if (!ctx.isProjectTrusted()) return;
    await project.set(
      provider.id,
      option.account,
      () => owner.isCurrent() && ctx.isProjectTrusted(),
    );
    if (!owner.isCurrent()) return;
    ctx.ui.notify(
      `Project default ${provider.displayName} account: ${option.label}. ` +
        `Saved to ${sanitizeTerminalText(project.path)}. This session is unchanged; use /new to apply.`,
      "info",
    );
  } catch {
    if (!owner.isCurrent()) return;
    ctx.ui.notify(
      "Could not save the project default account. Check .pi/pi-accounts.json and account storage, then try again.",
      "error",
    );
  }
}
