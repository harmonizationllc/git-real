import { GraphToolbar } from "git-real";

const noop = () => {};
const box = { width: 560 } as const;

/** No query: the search box is empty and navigation is disabled. */
export const Idle = () => (
  <div style={box}>
    <GraphToolbar
      query=""
      onQueryChange={noop}
      matchCount={null}
      current={0}
      onPrevious={noop}
      onNext={noop}
      total={48213}
      complete={true}
      refreshing={false}
    />
  </div>
);

/** A query with matches: counter and enabled Previous / Next. */
export const Searching = () => (
  <div style={box}>
    <GraphToolbar
      query="fix(graph)"
      onQueryChange={noop}
      matchCount={17}
      current={4}
      onPrevious={noop}
      onNext={noop}
      total={48213}
      complete={true}
      refreshing={false}
    />
  </div>
);

/** The graph is still being built; the commit count grows. */
export const Loading = () => (
  <div style={box}>
    <GraphToolbar
      query=""
      onQueryChange={noop}
      matchCount={null}
      current={0}
      onPrevious={noop}
      onNext={noop}
      total={12480}
      complete={false}
      refreshing={false}
    />
  </div>
);
