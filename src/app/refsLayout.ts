export const REFS_SECTIONS = [
  "branches",
  "stashes",
  "tags",
  "worktrees",
  "pullRequests",
  "issues",
] as const;

export type RefsSection = (typeof REFS_SECTIONS)[number];

/** Sections whose height the user can drag; Issues is not resizable. */
export type ResizableSection = Exclude<RefsSection, "issues">;

/** The smallest height a taller section is shrunk to. */
export const SECTION_MIN = 72;

/** A section whose content is at most this tall (a header plus one or two rows) is never squeezed. */
export const SECTION_WHOLE_MAX = 144;

/** A section's measured content height and its stored height (null = automatic). */
export interface SectionInput {
  natural: number;
  fixed: number | null;
}

/** The height a section never shrinks below: its content up to SECTION_WHOLE_MAX, else SECTION_MIN. */
export function sectionFloor(natural: number): number {
  return natural <= SECTION_WHOLE_MAX ? natural : SECTION_MIN;
}

/**
 * Shares the column between the sections (spec §3.1; index 0 is Branches). Each section prefers
 * its content height, or its stored height clamped between its floor and its content; a stored
 * Branches height is a true height, only floored. Leftover space goes to an automatic Branches;
 * an overflow is taken from the automatic sections in proportion to their room above the floor,
 * then from the fixed ones. Floors are never crossed. Heights are whole pixels: when the shares
 * fill the container, the rounding remainder goes to the last automatic section with a non-zero
 * height, so the heights sum exactly to the container. An unmeasured container (<= 0) returns the
 * content heights unchanged.
 */
export function fitSections(container: number, sections: SectionInput[]): number[] {
  if (container <= 0) return sections.map((s) => s.natural);
  const floors = sections.map((s) => sectionFloor(s.natural));
  const heights = sections.map((s, i) =>
    s.fixed === null
      ? s.natural
      : Math.min(i === 0 ? Infinity : s.natural, Math.max(floors[i], s.fixed)),
  );
  let over = heights.reduce((sum, h) => sum + h, 0) - container;
  if (over <= 0) {
    if (sections[0].fixed === null) heights[0] -= over;
  } else {
    for (const automatic of [true, false]) {
      const members = sections.flatMap((s, i) => ((s.fixed === null) === automatic ? [i] : []));
      const room = members.reduce((sum, i) => sum + heights[i] - floors[i], 0);
      if (room <= 0) continue;
      const taken = Math.min(over, room);
      for (const i of members) heights[i] -= (taken * (heights[i] - floors[i])) / room;
      over -= taken;
    }
  }
  return toWholePixels(container, sections, heights);
}

/**
 * Rounds each height; when the unrounded heights fill the container, the last automatic section
 * with a non-zero height absorbs the rounding remainder so the sum stays exact.
 */
function toWholePixels(container: number, sections: SectionInput[], heights: number[]): number[] {
  const rounded = heights.map(Math.round);
  const sum = heights.reduce((total, h) => total + h, 0);
  if (Math.abs(sum - container) >= 0.5) return rounded;
  for (let i = rounded.length - 1; i >= 0; i--) {
    if (sections[i].fixed !== null || rounded[i] === 0) continue;
    rounded[i] += container - rounded.reduce((total, h) => total + h, 0);
    break;
  }
  return rounded;
}

/**
 * The tallest a section may be dragged: the container less every other section's floor, but never
 * below the section's own floor.
 */
export function maxSectionHeight(
  container: number,
  sections: SectionInput[],
  index: number,
): number {
  if (container <= 0) return Infinity;
  const max = sections.reduce(
    (rest, s, i) => (i === index ? rest : rest - sectionFloor(s.natural)),
    container,
  );
  return Math.max(sectionFloor((sections[index] as SectionInput).natural), max);
}
