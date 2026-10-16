import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { CloneProgressPayload, Progress } from "./types";

export type { UnlistenFn } from "@tauri-apps/api/event";

// Mirrors the Rust events::CLONE_PROGRESS constant.
const CLONE_PROGRESS = "clone-progress";

export function onCloneProgress(
  cloneId: number,
  handler: (p: Progress) => void,
): Promise<UnlistenFn> {
  return listen<CloneProgressPayload>(CLONE_PROGRESS, (e) => {
    if (e.payload.cloneId === cloneId) handler(e.payload.progress);
  });
}
