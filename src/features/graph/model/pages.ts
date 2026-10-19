import { PAGE_SIZE } from "./layout";

export const pageOf = (index: number) => Math.floor(index / PAGE_SIZE);
export const pageStart = (page: number) => page * PAGE_SIZE;

/** The pages covering rows `first..=last`, ascending; rows below 0 are ignored, empty when `last < first`. */
export function pagesFor(first: number, last: number): number[] {
  if (last < first) return [];
  const pages: number[] = [];
  for (let p = Math.max(0, pageOf(first)); p <= pageOf(last); p++) pages.push(p);
  return pages;
}
