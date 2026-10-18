import styles from "./DiffRows.module.css";

interface Props {
  lineno: number | null;
  pressed: boolean;
  label: string;
  /** Present only for a selectable line; without it the gutter is a plain cell. */
  onClick?(shift: boolean): void;
}

/** One line-number cell; a toggle button when the line can be selected. */
export function Gutter({ lineno, pressed, label, onClick }: Props) {
  return (
    <span className={styles.gutter}>
      {onClick ? (
        <button
          type="button"
          className={styles.gutterButton}
          aria-pressed={pressed}
          aria-label={label}
          onClick={(e) => onClick(e.shiftKey)}
        >
          {lineno}
        </button>
      ) : (
        lineno
      )}
    </span>
  );
}
