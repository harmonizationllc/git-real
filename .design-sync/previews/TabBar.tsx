import { TabBar } from "git-real";

const noop = () => {};

const repo = (id: string, name: string, path: string, headBranch: string) => ({
  id: id as never,
  summary: { name, path, headBranch, isBare: false },
});

const frame = { width: 640 } as const;

/** Three open repositories, the middle one active. */
export const ThreeTabs = () => (
  <div style={frame}>
    <TabBar
      tabs={[
        repo("1", "git-real", "/home/dev/code/git-real", "main"),
        repo("2", "design-tokens", "/home/dev/code/design-tokens", "feature/tokens"),
        repo("3", "dotfiles", "/home/dev/dotfiles", "main"),
      ]}
      activeId={"2" as never}
      onActivate={noop}
      onClose={noop}
    />
  </div>
);

/** One tab; the start-screen button follows it. */
export const Single = () => (
  <div style={frame}>
    <TabBar
      tabs={[repo("1", "git-real", "/home/dev/code/git-real", "main")]}
      activeId={"1" as never}
      onActivate={noop}
      onClose={noop}
    />
  </div>
);

/** Long repository names truncate rather than push the controls out. */
export const LongNames = () => (
  <div style={frame}>
    <TabBar
      tabs={[
        repo(
          "1",
          "internal-platform-infrastructure-monorepo",
          "/srv/work/internal-platform-infrastructure-monorepo",
          "main",
        ),
        repo(
          "2",
          "customer-facing-web-application-frontend",
          "/srv/work/customer-facing-web-application-frontend",
          "develop",
        ),
      ]}
      activeId={"1" as never}
      onActivate={noop}
      onClose={noop}
    />
  </div>
);
