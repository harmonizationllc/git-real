export const REFS_SECTIONS = [
  "local",
  "remote",
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
 * Takes `min(over, room)` from the members, each giving in proportion to its own room, and
 * returns what is still over.
 */
function shrink(heights: number[], members: number[], rooms: number[], over: number): number {
  const room = members.reduce((sum, i) => sum + rooms[i], 0);
  if (room <= 0) return over;
  const taken = Math.min(over, room);
  for (const i of members) heights[i] -= (taken * rooms[i]) / room;
  return over - taken;
}

/**
 * Shares the column between the sections (spec §3.1). The absorber (default index 0; null for
 * none) takes the leftover; it must be null or an index into `sections` (not range-checked).
 * Each section prefers its content height, or its stored height as a true height, only floored
 * (so a stored height may exceed the content).
 * Leftover space goes to an automatic absorber. An overflow is taken in four passes, each in
 * proportion to the members' room: first the blank space (height above content) of the stored
 * sections other than `protect`, then the automatic sections' room above their floor, then the
 * room above their floor of the stored sections other than `protect`, and last `protect` alone
 * (the section dragged last, which keeps its height until nothing else can give). Floors are
 * never crossed. Heights are whole pixels: when the
 * shares fill the container, the rounding remainder goes to the last automatic section that is
 * sharing, else to an automatic absorber above its floor, so the heights sum exactly to the
 * container; when no automatic section can take the pixel it stays unassigned. An unmeasured
 * container (<= 0) returns the content heights unchanged.
 */
export function fitSections(
  container: number,
  sections: SectionInput[],
  absorber: number | null = 0,
  protect: number | null = null,
): number[] {
  if (container <= 0) return sections.map((s) => s.natural);
  const floors = sections.map((s) => sectionFloor(s.natural));
  const heights = sections.map((s, i) =>
    s.fixed === null ? s.natural : Math.max(floors[i], s.fixed),
  );
  let over = heights.reduce((sum, h) => sum + h, 0) - container;
  if (over <= 0) {
    if (absorber !== null && sections[absorber].fixed === null) heights[absorber] -= over;
  } else {
    const all = sections.map((_, i) => i);
    const stored = all.filter((i) => sections[i].fixed !== null && i !== protect);
    const automatic = all.filter((i) => sections[i].fixed === null);
    const blank = heights.map((h, i) => Math.max(0, h - sections[i].natural));
    over = shrink(heights, stored, blank, over);
    over = shrink(
      heights,
      automatic,
      heights.map((h, i) => h - floors[i]),
      over,
    );
    over = shrink(
      heights,
      stored,
      heights.map((h, i) => h - floors[i]),
      over,
    );
    if (protect !== null && sections[protect].fixed !== null) {
      shrink(
        heights,
        [protect],
        heights.map((h, i) => h - floors[i]),
        over,
      );
    }
  }
  return toWholePixels(container, sections, floors, heights, absorber);
}

/**
 * Rounds each height. When the unrounded heights fill the container, the rounding remainder goes
 * to the last automatic section that is sharing (above its floor and shrunk below its content),
 * else to an automatic absorber above its floor, else it stays unassigned. A section shown whole
 * never gives or takes the pixel, and a recipient never ends below its floor or, while sharing,
 * above its content.
 */
function toWholePixels(
  container: number,
  sections: SectionInput[],
  floors: number[],
  heights: number[],
  absorber: number | null,
): number[] {
  const rounded = heights.map(Math.round);
  const sum = heights.reduce((total, h) => total + h, 0);
  if (Math.abs(sum - container) >= 0.5) return rounded;
  const remainder = container - rounded.reduce((total, h) => total + h, 0);
  // An automatic section above its floor that stays within [floor, max] after taking the pixel.
  const takes = (i: number, max: number) =>
    sections[i].fixed === null &&
    heights[i] > floors[i] &&
    rounded[i] + remainder >= floors[i] &&
    rounded[i] + remainder <= max;
  let recipient = -1;
  for (let i = rounded.length - 1; i >= 0 && recipient < 0; i--) {
    const natural = sections[i].natural;
    if (heights[i] < natural && takes(i, natural)) recipient = i;
  }
  if (recipient < 0 && absorber !== null && takes(absorber, Infinity)) recipient = absorber;
  if (recipient >= 0) rounded[recipient] += remainder;
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
