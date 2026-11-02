import { TextSetting } from "git-real";

const save = async () => null;
const box = { width: 360 } as const;

/** A stored value. */
export const Filled = () => (
  <div style={box}>
    <TextSetting
      id="clone-dir-a"
      label="Default clone folder"
      value="/home/dev/code"
      onCommit={save}
    />
  </div>
);

/** Nothing stored: the placeholder shows the fallback. */
export const Empty = () => (
  <div style={box}>
    <TextSetting
      id="editor-b"
      label="External editor"
      value={null}
      placeholder="code --wait"
      onCommit={save}
    />
  </div>
);

/** A hint explains what the field does. */
export const WithHint = () => (
  <div style={box}>
    <TextSetting
      id="git-path-c"
      label="Git executable"
      value="/usr/bin/git"
      hint="Used for fetch, pull, push and signing. Leave empty to use the one on your PATH."
      onCommit={save}
    />
  </div>
);
