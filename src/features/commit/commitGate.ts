import type { CommitConfig, OperationState, WorkingTreeStatus } from "../../lib/ipc";

export interface CommitGateInput {
  amend: boolean;
  subject: string;
  status: WorkingTreeStatus | undefined;
  operation: OperationState | undefined;
  config: CommitConfig | undefined;
}

/** Why the Commit button is disabled, first match wins; null means it is enabled. */
export function commitDisabledReason({
  amend,
  subject,
  status,
  operation,
  config,
}: CommitGateInput): string | null {
  if (status === undefined || config === undefined) return "Loading…";
  if (operation?.kind === "rebase") return "Use Continue in the banner to resume the rebase";
  if (config.name === null || config.email === null) {
    return "Set user.name and user.email in your Git config";
  }
  if (status.entries.some((e) => e.conflicted)) return "Resolve conflicts before committing";
  // An all-ours merge stages nothing, yet git still records the merge commit (MERGE_HEAD exists).
  if (!amend && operation?.kind !== "merge" && !status.entries.some((e) => e.index !== null)) {
    return "Stage changes to commit";
  }
  if (subject.trim() === "") return "Enter a commit subject";
  return null;
}
