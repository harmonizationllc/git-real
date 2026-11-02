import { TagRow } from "git-real";

const noop = () => {};
const list = { listStyle: "none", margin: 0, padding: 0, width: 360 } as const;

const tags = [
  {
    name: "v0.3.0",
    target: "7caf9d6b1e0a24c58d3f9017ab62e4c5d8f13a90",
    annotated: true,
    subject: "Refs column polish and config-read fix",
    time: 1792400000,
  },
  {
    name: "v0.2.1",
    target: "3722a6e90d4b15c78e2f0a63b9d81c47f5a2e6d0",
    annotated: true,
    subject: "First-paint font warm-up",
    time: 1791500000,
  },
  {
    name: "v0.2.0",
    target: "c395eb5a2f7d01e48b6c93d0a5e17f2849b3c6a1",
    annotated: false,
    subject: null,
    time: 1790800000,
  },
  {
    name: "v0.1.0",
    target: "688026e4b1a93c70d5f2e8a16b04c9d37e5f1a28",
    annotated: false,
    subject: null,
    time: 1789000000,
  },
];

/** Mixed lightweight and annotated tags, newest first. */
export const Tags = () => (
  <ul style={list}>
    {tags.map((tag) => (
      <TagRow key={tag.name} tag={tag} onSelect={noop} onContextMenu={noop} />
    ))}
  </ul>
);

/** Lightweight tags only: no annotated marker. */
export const Lightweight = () => (
  <ul style={list}>
    {tags
      .filter((t) => !t.annotated)
      .map((tag) => (
        <TagRow key={tag.name} tag={tag} onSelect={noop} onContextMenu={noop} />
      ))}
  </ul>
);

/** Annotated tags only. */
export const Annotated = () => (
  <ul style={list}>
    {tags
      .filter((t) => t.annotated)
      .map((tag) => (
        <TagRow key={tag.name} tag={tag} onSelect={noop} onContextMenu={noop} />
      ))}
  </ul>
);
