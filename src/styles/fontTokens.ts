/** Font family custom properties declared on `:root` in tokens.css. */
export const FONT_FAMILY_TOKENS = ["--font-ui", "--font-mono-ui", "--font-mono"] as const;

/** The px text size scale declared on `:root`, smallest first. */
export const TEXT_SIZE_TOKENS = [
  "--text-xs",
  "--text-sm",
  "--text-md",
  "--text-base",
  "--text-lg",
  "--text-xl",
  "--text-2xl",
] as const;

/** The user-chosen diff font size, written inline on `<html>` by applyAppearance. */
export const DIFF_SIZE_TOKEN = "--diff-font-size";

/** The only font weights the stylesheets may use. */
export const FONT_WEIGHTS = ["normal", "600", "700"] as const;

/** Values of the `data-platform` attribute that selects the monospace UI family. */
export const PLATFORMS = ["linux", "macos", "windows"] as const;
export type Platform = (typeof PLATFORMS)[number];
