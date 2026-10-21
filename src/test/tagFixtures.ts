import type { TagEntry, TagList } from "../lib/ipc";
import { oidOf } from "./graphFixtures";

/** A lightweight tag on `oidOf(0)` made at 1_700_000_000, unless overridden. */
export const tagEntry = (name: string, over: Partial<TagEntry> = {}): TagEntry => ({
  name,
  target: oidOf(0),
  annotated: false,
  subject: null,
  time: 1_700_000_000,
  ...over,
});

export const tagList = (over: Partial<TagList> = {}): TagList => ({
  tags: [],
  remotes: ["origin"],
  ...over,
});
