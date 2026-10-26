import type { CloneUrlForm, DiffMode, SettingsPatch, ThemePref } from "../ipc";
import {
  DIFF_FONT_MAX,
  DIFF_FONT_MIN,
  REFS_DEFAULT,
  SIDEBAR_DEFAULT,
  useSettings,
} from "./settings";

const setPref = (patch: SettingsPatch) => useSettings.getState().setPref(patch);

export function setTheme(theme: ThemePref): void {
  setPref({ appearance: { theme } });
}

/** Trims; an empty name clears the family back to the default. */
export function setDiffFontFamily(family: string | null): void {
  const trimmed = family?.trim();
  setPref({ appearance: { diffFontFamily: trimmed ? trimmed : null } });
}

/** Rounds and clamps to DIFF_FONT_MIN..DIFF_FONT_MAX; NaN is ignored. */
export function setDiffFontSize(size: number): void {
  if (Number.isNaN(size)) return;
  const diffFontSize = Math.min(DIFF_FONT_MAX, Math.max(DIFF_FONT_MIN, Math.round(size)));
  setPref({ appearance: { diffFontSize } });
}

export function setDiffMode(mode: DiffMode): void {
  setPref({ diff: { mode } });
}

export function setIgnoreWhitespace(ignoreWhitespace: boolean): void {
  setPref({ diff: { ignoreWhitespace } });
}

// Rust takes whole pixels; drag handles can yield fractional widths on scaled displays.
export function setRefsWidth(width: number): void {
  setPref({ layout: { refsWidth: Math.round(width) } });
}

export function setSidebarWidth(width: number): void {
  setPref({ layout: { sidebarWidth: Math.round(width) } });
}

export function resetWidth(column: "refs" | "sidebar"): void {
  setPref({
    layout: column === "refs" ? { refsWidth: REFS_DEFAULT } : { sidebarWidth: SIDEBAR_DEFAULT },
  });
}

export function setTagsCollapsed(tagsCollapsed: boolean): void {
  setPref({ layout: { tagsCollapsed } });
}

export function setPullRequestsCollapsed(pullRequestsCollapsed: boolean): void {
  setPref({ layout: { pullRequestsCollapsed } });
}

export function setIssuesCollapsed(issuesCollapsed: boolean): void {
  setPref({ layout: { issuesCollapsed } });
}

export function setCloneUrlForm(urlForm: CloneUrlForm): void {
  setPref({ clone: { urlForm } });
}

export function setCheckOnStartup(checkOnStartup: boolean): void {
  setPref({ updates: { checkOnStartup } });
}
