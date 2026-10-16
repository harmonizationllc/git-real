import { invoke } from "@tauri-apps/api/core";
import type { GitCliInfo, OpenedRepo, RecentEntry, RepoId } from "./types";

export function openRepo(path: string): Promise<OpenedRepo> {
  return invoke<OpenedRepo>("open_repo", { path });
}

export function initRepo(path: string): Promise<OpenedRepo> {
  return invoke<OpenedRepo>("init_repo", { path });
}

export function cloneRepo(url: string, dest: string, cloneId: number): Promise<OpenedRepo> {
  return invoke<OpenedRepo>("clone_repo", { url, dest, cloneId });
}

export function closeRepo(id: RepoId): Promise<void> {
  return invoke<void>("close_repo", { id });
}

export function listRecent(): Promise<RecentEntry[]> {
  return invoke<RecentEntry[]>("list_recent");
}

export function removeRecent(path: string): Promise<RecentEntry[]> {
  return invoke<RecentEntry[]>("remove_recent", { path });
}

export function checkGitCli(): Promise<GitCliInfo> {
  return invoke<GitCliInfo>("check_git_cli");
}
