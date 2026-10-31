import type { Platform } from "../styles/fontTokens";

/**
 * Maps `navigator.platform` to the app's platform name: the `data-platform` value that tokens.css
 * uses to pick the monospace UI family, and the source of the shortcut labels. Anything that is not
 * macOS or Windows is `linux`.
 */
export function detectPlatform(platform: string = navigator.platform): Platform {
  if (platform.startsWith("Mac")) return "macos";
  if (platform.startsWith("Win")) return "windows";
  return "linux";
}
