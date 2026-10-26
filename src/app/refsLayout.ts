export const REFS_SECTIONS = ["branches", "stashes", "tags", "pullRequests", "issues"] as const;

export type RefsSection = (typeof REFS_SECTIONS)[number];

/** Sections whose height the user can drag; Issues is not resizable. */
export type ResizableSection = Exclude<RefsSection, "issues">;
