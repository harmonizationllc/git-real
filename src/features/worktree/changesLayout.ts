import { SECTION_MIN } from "../../app/refsLayout";

/** The shortest the Unstaged or Staged pane may be. */
export const PANE_FLOOR = SECTION_MIN;
/** Conflicts never takes more than this share of the Changes body. */
export const CONFLICTS_MAX_SHARE = 0.4;

export interface PaneHeights {
  /** 0 when conflictsNatural is 0. */
  conflicts: number;
  unstaged: number;
  staged: number;
  /** The tallest the Unstaged pane may be dragged. */
  max: number;
}

/**
 * Sizes the Changes panel's panes.
 * measuredContainer: the body wrapper's height minus the divider (SPLIT_HANDLE_WIDTH).
 * conflictsNatural: the Conflicts section's content height, 0 when hidden.
 * stored: layout.changesUnstagedHeight.
 */
export function fitChangesPanes(
  measuredContainer: number,
  conflictsNatural: number,
  stored: number | null,
): PaneHeights {
  // A measured height can be fractional; every output is a whole pixel.
  const container = Math.floor(measuredContainer);
  if (container <= 0) {
    return {
      conflicts: conflictsNatural,
      unstaged: PANE_FLOOR,
      staged: PANE_FLOOR,
      max: Infinity,
    };
  }
  const conflicts = Math.min(
    Math.ceil(conflictsNatural),
    Math.floor(container * CONFLICTS_MAX_SHARE),
  );
  const shared = container - conflicts;
  const max = Math.max(PANE_FLOOR, shared - PANE_FLOOR);
  const unstaged = Math.min(max, Math.max(PANE_FLOOR, stored ?? Math.round(shared / 2)));
  const staged = Math.max(PANE_FLOOR, shared - unstaged);
  return { conflicts, unstaged, staged, max };
}
