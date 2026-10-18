import type { CommitConfig, WorkingTreeStatus } from "../../lib/ipc";

export interface CommitGateInput {
  amend: boolean;
  subject: string;
  status: WorkingTreeStatus | undefined;
  config: CommitConfig | undefined;
}

/** Why the Commit button is disabled, first match wins; null means it is enabled. */
export function commitDisabledReason({
  amend,
  subject,
  status,
  config,
}: CommitGateInput): string | null {
  if (status === undefined || config === undefined) return "Loading…";
  if (config.name === null || config.email === null) {
    return "Set user.name and user.email in your Git config";
  }
  if (status.entries.some((e) => e.conflicted)) return "Resolve conflicts before committing";
  if (!amend && !status.entries.some((e) => e.index !== null)) return "Stage changes to commit";
  if (subject.trim() === "") return "Enter a commit subject";
  return null;
}
