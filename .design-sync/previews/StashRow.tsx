import { StashRow } from "git-real";

const noop = () => {};
const list = { listStyle: "none", margin: 0, padding: 0, width: 360 } as const;
const NOW = 1793000000;

const entries = [
  {
    index: 0,
    oid: "a14f9c0e72b3d85a1c6e4f90b2d7a3185ce60f4b",
    message: "WIP on feature/refs-column-polish: 7799bca test: GR-31 failing tests",
    branch: "feature/refs-column-polish",
    time: NOW - 25 * 60,
    base: "7799bca0e1d2c3b4a5968778695a4b3c2d1e0f9a",
    hasUntracked: false,
  },
  {
    index: 1,
    oid: "c82e5b1f40a9d37e6b28c1f5a0d49e73b6a2c8d1",
    message: "On main: scratch benchmark fixtures",
    branch: "main",
    time: NOW - 3 * 3600,
    base: "035ff150a1b2c3d4e5f60718293a4b5c6d7e8f90",
    hasUntracked: true,
  },
  {
    index: 2,
    oid: "e03b7d92a1c4f68b5d0e3a79c2f1b84d6a50e9c7",
    message: "WIP on (no branch): 5e43cba fix(errors): panel variant",
    branch: null,
    time: NOW - 4 * 86400,
    base: "5e43cba91f0e2d3c4b5a69788796a5b4c3d2e1f0",
    hasUntracked: false,
  },
];

/** A stash list with branch, relative time and the untracked marker. */
export const List = () => (
  <ul style={list}>
    {entries.map((entry) => (
      <StashRow
        key={entry.oid}
        entry={entry}
        selected={false}
        now={NOW}
        onSelect={noop}
        onContextMenu={noop}
      />
    ))}
  </ul>
);

/** The second stash is selected. */
export const Selected = () => (
  <ul style={list}>
    {entries.map((entry, i) => (
      <StashRow
        key={entry.oid}
        entry={entry}
        selected={i === 1}
        now={NOW}
        onSelect={noop}
        onContextMenu={noop}
      />
    ))}
  </ul>
);
