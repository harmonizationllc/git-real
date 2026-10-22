import { openUrl } from "@tauri-apps/plugin-opener";

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/** Opens an `https:` link in the system browser; anything else is refused without opening. */
export async function openExternal(url: string): Promise<void> {
  if (!isHttps(url)) throw new Error("Only https links can be opened");
  await openUrl(url);
}
