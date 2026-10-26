import { invoke } from "@tauri-apps/api/core";
import type { ExternalDiffScope, RepoId } from "./types";

export function openInEditor(path: string, repoId?: RepoId): Promise<void> {
  return invoke<void>("open_in_editor", { repoId: repoId ?? null, path });
}

export function openExternalDiff(
  repoId: RepoId,
  path: string,
  scope: ExternalDiffScope,
): Promise<void> {
  return invoke<void>("open_external_diff", { repoId, path, scope });
}

export function openExternalMerge(repoId: RepoId, path: string): Promise<void> {
  return invoke<void>("open_external_merge", { repoId, path });
}
