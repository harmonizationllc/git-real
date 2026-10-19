import type { RepoId } from "../../lib/ipc";

export interface BlameViewProps {
  repoId: RepoId;
  path: string;
  /** The commit to blame at; null blames HEAD. */
  oid: string | null;
}

/** Placeholder for the blame table; GR-9 task 5 fills it in. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the final signature; task 5 reads the props
export function BlameView(_props: BlameViewProps) {
  return <div role="table" aria-label="Blame" />;
}
