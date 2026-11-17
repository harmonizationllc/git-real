import { create } from "zustand";

interface DiffSearchState {
  query: string;
  wholeWord: boolean;
  matchCase: boolean;
  setQuery(q: string): void;
  toggleWholeWord(): void;
  toggleMatchCase(): void;
}

/** The find-in-diff query and options; shared so they survive switching files. */
export const useDiffSearchStore = create<DiffSearchState>()((set) => ({
  query: "",
  wholeWord: false,
  matchCase: false,
  setQuery: (query) => set({ query }),
  toggleWholeWord: () => set((s) => ({ wholeWord: !s.wholeWord })),
  toggleMatchCase: () => set((s) => ({ matchCase: !s.matchCase })),
}));
