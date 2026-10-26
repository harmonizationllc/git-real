export const REFS_SECTIONS = ["branches", "stashes", "tags", "pullRequests", "issues"] as const;

export type RefsSection = (typeof REFS_SECTIONS)[number];

/** Sections whose height the user can drag; Issues is not resizable. */
export type ResizableSection = Exclude<RefsSection, "issues">;

/** The smallest height a section is shrunk to; a shorter section keeps its own height. */
export const SECTION_MIN = 72;

/** A section's measured content height and its stored height (null = automatic). */
export interface SectionInput {
  natural: number;
  fixed: number | null;
}

/** The height a section never shrinks below: SECTION_MIN, or its content if that is shorter. */
export function sectionFloor(natural: number): number {
  return Math.min(SECTION_MIN, natural);
}

/**
 * Shares the column between the sections (spec §3.1; index 0 is Branches). Each section prefers
 * its content height, or its stored height clamped between its floor and its content. Leftover
 * space goes to an automatic Branches; an overflow is taken from the automatic sections in
 * proportion to their room above the floor, then from the fixed ones. Floors are never crossed.
 * An unmeasured container (<= 0) returns the content heights unchanged.
 */
export function fitSections(container: number, sections: SectionInput[]): number[] {
  if (container <= 0) return sections.map((s) => s.natural);
  const floors = sections.map((s) => sectionFloor(s.natural));
  const heights = sections.map((s, i) =>
    s.fixed === null ? s.natural : Math.min(s.natural, Math.max(floors[i], s.fixed)),
  );
  let over = heights.reduce((sum, h) => sum + h, 0) - container;
  if (over <= 0) {
    if (sections[0].fixed === null) heights[0] -= over;
    return heights;
  }
  for (const automatic of [true, false]) {
    const members = sections.flatMap((s, i) => ((s.fixed === null) === automatic ? [i] : []));
    const room = members.reduce((sum, i) => sum + heights[i] - floors[i], 0);
    if (room <= 0) continue;
    const taken = Math.min(over, room);
    for (const i of members) heights[i] -= (taken * (heights[i] - floors[i])) / room;
    over -= taken;
  }
  return heights;
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
