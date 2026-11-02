import { HistoryRow } from "git-real";

const noop = () => {};
const NOW = 1793000000;
const box = { width: 440 } as const;

const entry = (
  oid: string,
  subject: string,
  authorName: string,
  ago: number,
  change: "added" | "modified" | "deleted" | "renamed",
  oldPath: string | null = null,
) => ({
  oid,
  subject,
  authorName,
  authorEmail: `${authorName.split(" ")[0].toLowerCase()}@example.com`,
  authorTime: NOW - ago,
  change,
  path: "src/features/graph/RefLabels.tsx",
  oldPath,
});

/** Three commits touching one file; the first is selected. */
export const Commits = () => (
  <div role="listbox" style={box}>
    <HistoryRow
      id="h1"
      selected={true}
      now={NOW}
      onSelect={noop}
      entry={entry(
        "5e43cba",
        "fix(errors): refs-column error boxes use the panel variant",
        "Jason Harmon",
        2 * 3600,
        "modified",
      )}
    />
    <HistoryRow
      id="h2"
      selected={false}
      now={NOW}
      onSelect={noop}
      entry={entry(
        "c395eb5",
        "perf(graph): fit ref pills in one measure pass",
        "Priya Natarajan",
        3 * 86400,
        "modified",
      )}
    />
    <HistoryRow
      id="h3"
      selected={false}
      now={NOW}
      onSelect={noop}
      entry={entry(
        "a2dd049",
        "feat(graph): ref labels with overflow pill",
        "Jason Harmon",
        40 * 86400,
        "added",
      )}
    />
  </div>
);

/** A rename shows the old to new path line. */
export const WithRename = () => (
  <div role="listbox" style={box}>
    <HistoryRow
      id="r1"
      selected={false}
      now={NOW}
      onSelect={noop}
      entry={entry(
        "9624e3b",
        "refactor: move graph labels into the graph feature",
        "Marcus Webb",
        12 * 86400,
        "renamed",
        "src/features/refs/RefLabels.tsx",
      )}
    />
    <HistoryRow
      id="r2"
      selected={false}
      now={NOW}
      onSelect={noop}
      entry={entry(
        "7ad2205",
        "chore: drop unused label export",
        "Jason Harmon",
        20 * 86400,
        "deleted",
      )}
    />
  </div>
);
