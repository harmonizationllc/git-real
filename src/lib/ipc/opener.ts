import { openUrl } from "@tauri-apps/plugin-opener";

/** True for an `https:` URL without userinfo, which could smuggle credentials or disguise the host. */
function isPlainHttps(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** Opens an `https:` link in the system browser; anything else is refused without opening. */
export async function openExternal(url: string): Promise<void> {
  if (!isPlainHttps(url)) throw new Error("Only https links can be opened");
  await openUrl(url);
}
