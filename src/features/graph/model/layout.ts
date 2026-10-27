// Graph constants and shortOid (column maths for the repo pane lives in src/app/layout.ts).

/** Rows fetched per getLogPage call. */
export const PAGE_SIZE = 500;
/** Height of one commit row in pixels. */
export const ROW_HEIGHT = 28;
/** Width of one lane column in pixels. */
export const LANE_WIDTH = 14;
/** Lanes beyond this are not drawn; the gutter stops growing. */
export const MAX_DRAWN_LANES = 12;
/** Ref labels shown on a row before the rest collapse. */
export const MAX_LABELS = 3;
/** Gap between ref pills in pixels. */
export const LABEL_GAP_PX = 4;
/** Gap between the ref pills and the subject in a row's message cell, in pixels. */
export const MESSAGE_GAP_PX = 6;
export const SEARCH_DEBOUNCE_MS = 200;

export const shortOid = (oid: string) => oid.slice(0, 7);
