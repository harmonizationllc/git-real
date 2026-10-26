import { invoke } from "@tauri-apps/api/core";
import type { UpdateInfo } from "./types";

/** Checks GitHub for a release newer than this build. */
export function checkForUpdate(): Promise<UpdateInfo> {
  return invoke<UpdateInfo>("check_for_update");
}
