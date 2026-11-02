import { Section, TextSetting } from "git-real";

const save = async () => null;
const box = { width: 380 } as const;

/** A titled settings section holding two text fields. */
export const WithFields = () => (
  <div style={box}>
    <Section id="clone" name="Clone">
      <TextSetting
        id="clone-dir-s"
        label="Default clone folder"
        value="/home/dev/code"
        onCommit={save}
      />
      <TextSetting
        id="clone-url-s"
        label="Default remote host"
        value={null}
        placeholder="github.com"
        onCommit={save}
      />
    </Section>
  </div>
);

/** A section with a single field and a hint. */
export const WithHint = () => (
  <div style={box}>
    <Section id="tools" name="Tools">
      <TextSetting
        id="editor-s"
        label="External editor"
        value="code --wait"
        hint="Opened from a file's context menu."
        onCommit={save}
      />
    </Section>
  </div>
);
