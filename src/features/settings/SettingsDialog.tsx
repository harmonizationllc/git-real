import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";
import { useRestoreFocus } from "../../components/useRestoreFocus";
import { AboutSettings } from "./AboutSettings";
import { checkGitCli, pickFile, pickFolder, toAppError } from "../../lib/ipc";
import type { Settings } from "../../lib/ipc";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "../../lib/query/keys";
import { DIFF_FONT_MAX, DIFF_FONT_MIN, useAppearancePrefs } from "../../lib/store/appearancePrefs";
import type { ThemePref } from "../../lib/store/appearancePrefs";
import { useShell } from "../../lib/store/shell";
import type { SettingsSection } from "../../lib/store/shell";
import { useToasts } from "../../lib/store/toasts";
import { TextSetting } from "./TextSetting";
import { useSettings } from "./useSettings";
import styles from "./SettingsDialog.module.css";

export interface SettingsDialogProps {
  section?: SettingsSection;
  onClose(): void;
  fallbackFocus: RefObject<HTMLElement | null>;
}

const THEMES: { value: ThemePref; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const EDITOR_HINT = "Command line; the file or folder path is appended, e.g. code --wait";
const DIFF_HINT = 'Git difftool command, e.g. meld "$LOCAL" "$REMOTE"';
const MERGE_HINT = 'Git mergetool command, e.g. meld "$LOCAL" "$BASE" "$REMOTE" --output "$MERGED"';

/** The one dialog that edits appearance (localStorage) and the backend settings (settings.json). */
export function SettingsDialog({ section, onClose, fallbackFocus }: SettingsDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useRestoreFocus(fallbackFocus);
  useLayoutEffect(() => {
    // Focus the first control of the chosen section, else the first control of the dialog. The
    // dialog element itself is never a focus target, so it needs no tabIndex.
    const dialog = dialogRef.current;
    const scope = section
      ? dialog?.querySelector<HTMLElement>(`[data-section="${section}"]`)
      : dialog;
    const first = scope?.querySelector<HTMLElement>("input, button, [tabindex]");
    first?.focus();
    first?.scrollIntoView?.({ block: "nearest" });
  }, [section]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.nativeEvent.isComposing || e.keyCode === 229) return;
    onClose();
  };

  return (
    <div className={styles.backdrop} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={styles.dialog}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className={styles.title}>
          Settings
        </h2>
        <AppearanceSettings />
        <DiffSettings />
        <CloneSettings />
        <ToolsSettings />
        <GitSettings />
        <AboutSettings />
        <div className={styles.actions}>
          <button type="button" onClick={() => useShell.getState().open({ kind: "shortcuts" })}>
            Keyboard shortcuts…
          </button>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/** A titled section tagged with `data-section` so a `section` prop can focus and scroll to it. */
export function Section({
  id,
  name,
  children,
}: {
  id: SettingsSection;
  name: string;
  children: React.ReactNode;
}) {
  const headingId = useId();
  return (
    <section data-section={id} aria-labelledby={headingId} className={styles.section}>
      <h3 id={headingId} className={styles.sectionTitle}>
        {name}
      </h3>
      {children}
    </section>
  );
}

function AppearanceSettings() {
  const theme = useAppearancePrefs((s) => s.theme);
  const setTheme = useAppearancePrefs((s) => s.setTheme);
  const groupName = useId();
  return (
    <Section id="appearance" name="Appearance">
      <div role="radiogroup" aria-label="Theme" className={styles.field}>
        {THEMES.map(({ value, label }) => (
          <label key={value} className={styles.radio}>
            <input
              type="radio"
              name={groupName}
              value={value}
              checked={theme === value}
              onChange={() => setTheme(value)}
            />
            {label}
          </label>
        ))}
      </div>
    </Section>
  );
}

function DiffSettings() {
  const family = useAppearancePrefs((s) => s.diffFontFamily);
  const setFamily = useAppearancePrefs((s) => s.setDiffFontFamily);
  const size = useAppearancePrefs((s) => s.diffFontSize);
  const setSize = useAppearancePrefs((s) => s.setDiffFontSize);
  const sizeId = useId();
  const [sizeDraft, setSizeDraft] = useState(String(size));

  const [prevSize, setPrevSize] = useState(size);
  if (prevSize !== size) {
    setPrevSize(size);
    setSizeDraft(String(size));
  }

  const onSizeChange = (raw: string) => {
    setSizeDraft(raw);
    const n = Number(raw);
    // In-range integers apply at once; an out-of-range value waits for blur so typing on the
    // way to a valid number does not snap.
    if (raw !== "" && Number.isInteger(n) && n >= DIFF_FONT_MIN && n <= DIFF_FONT_MAX) {
      setSize(n);
    }
  };

  const commitSize = () => {
    const n = Number(sizeDraft);
    if (sizeDraft !== "" && !Number.isNaN(n)) setSize(n);
    setSizeDraft(String(useAppearancePrefs.getState().diffFontSize));
  };

  return (
    <Section id="diff" name="Diff">
      <TextSetting
        id={`${sizeId}-family`}
        label="Font family"
        value={family}
        placeholder="System monospace"
        onCommit={async (next) => {
          setFamily(next);
          return null;
        }}
      />
      <div className={styles.field}>
        <label htmlFor={sizeId}>Font size</label>
        <span className={styles.sizeRow}>
          <input
            id={sizeId}
            type="number"
            min={DIFF_FONT_MIN}
            max={DIFF_FONT_MAX}
            step={1}
            value={sizeDraft}
            onChange={(e) => onSizeChange(e.target.value)}
            onBlur={commitSize}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitSize();
            }}
          />
          <span aria-hidden="true">px</span>
        </span>
      </div>
      <pre aria-label="Diff font sample" className={styles.sample}>
        {"- const total = a + b;\n+ const total = add(a, b);"}
      </pre>
    </Section>
  );
}

function CloneSettings() {
  const { settings, update } = useSettings();
  const queryClient = useQueryClient();
  const current = settings?.defaultCloneDir ?? null;
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const flashSaved = () => {
    setSaved(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setSaved(false), 1000);
  };

  const save = async (dir: string | null) => {
    try {
      await update({ defaultCloneDir: dir });
      flashSaved();
    } catch (e) {
      useToasts
        .getState()
        .notify({ text: `Couldn't save settings: ${toAppError(e).message}`, variant: "error" });
    }
  };

  const choose = async () => {
    // The freshest value, in case the query resolved after this render's closure was captured.
    const live = queryClient.getQueryData<Settings>(queryKeys.settings)?.defaultCloneDir ?? current;
    const dir = await pickFolder("Choose default clone directory", live ?? undefined);
    if (dir !== null) await save(dir);
  };

  return (
    <Section id="clone" name="Clone">
      <div className={styles.field}>
        <span className={styles.label}>Default clone directory</span>
        <span className={styles.value}>{current ?? "Not set"}</span>
        <span className={styles.row}>
          <button type="button" onClick={() => void choose()}>
            Choose folder…
          </button>
          <button type="button" disabled={current === null} onClick={() => void save(null)}>
            Clear
          </button>
          {saved && (
            <span role="status" className={styles.saved}>
              Saved
            </span>
          )}
        </span>
      </div>
    </Section>
  );
}

function ToolsSettings() {
  const { settings, update } = useSettings();
  const ids = useId();

  const save =
    (key: keyof Settings) =>
    async (next: string | null): Promise<string | null> => {
      try {
        await update({ [key]: next } as Partial<Settings>);
        return null;
      } catch (e) {
        useToasts
          .getState()
          .notify({ text: `Couldn't save settings: ${toAppError(e).message}`, variant: "error" });
        return "";
      }
    };

  return (
    <Section id="tools" name="Tools">
      <TextSetting
        id={`${ids}-editor`}
        label="External editor"
        value={settings?.externalEditor ?? null}
        hint={EDITOR_HINT}
        onCommit={save("externalEditor")}
      />
      <TextSetting
        id={`${ids}-diff`}
        label="External diff tool"
        value={settings?.externalDiffTool ?? null}
        hint={DIFF_HINT}
        onCommit={save("externalDiffTool")}
      />
      <TextSetting
        id={`${ids}-merge`}
        label="External merge tool"
        value={settings?.externalMergeTool ?? null}
        hint={MERGE_HINT}
        onCommit={save("externalMergeTool")}
      />
    </Section>
  );
}

function GitSettings() {
  const { settings, update } = useSettings();
  const git = useQuery({ queryKey: queryKeys.gitCli, queryFn: () => checkGitCli() });
  const id = useId();

  const save = async (next: string | null): Promise<string | null> => {
    try {
      await update({ gitExecutable: next });
      return null;
    } catch (e) {
      const err = toAppError(e);
      if (err.kind === "gitCliInvalid") return `Not a Git executable: ${err.message}`;
      useToasts
        .getState()
        .notify({ text: `Couldn't save settings: ${err.message}`, variant: "error" });
      return "";
    }
  };

  const browse = async () => {
    const path = await pickFile("Choose Git executable");
    if (path !== null) await save(path);
  };

  return (
    <Section id="git" name="Git">
      <TextSetting
        id={id}
        label="Git executable"
        value={settings?.gitExecutable ?? null}
        placeholder="Found on PATH"
        onCommit={save}
      />
      <div className={styles.row}>
        <button type="button" onClick={() => void browse()}>
          Browse…
        </button>
        <button type="button" onClick={() => void save(null)}>
          Use PATH
        </button>
      </div>
      {git.data &&
        (git.data.available ? (
          <p className={styles.value}>
            Using {git.data.path} (git version {git.data.version})
          </p>
        ) : (
          git.data.error && (
            <p role="alert" className={styles.value}>
              {git.data.error}
            </p>
          )
        ))}
    </Section>
  );
}
