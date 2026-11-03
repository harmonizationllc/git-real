//! Builds unified-diff patch text for hunk and line level staging.
//!
//! The builder is pure: it turns one hunk of a [`FileDiff`] (or some of its
//! lines) into text that libgit2's `Diff::from_buffer` + `apply` accept.
//! Headers always name `diff.path` on both sides, hunk counts are recomputed
//! from the emitted lines, and the new-side start is derived from the old
//! side because libgit2 places a hunk at `new_start` without offset search.

use crate::error::GitError;
use crate::model::{ChangeKind, DiffLine, DiffLineKind, FileDiff, HunkSelection, LineEdit};

const NO_NEWLINE_MARKER: &str = "\\ No newline at end of file\n";

/// How one original diff line appears in the patch.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Op {
    Context,
    Add,
    Remove,
}

/// One line of the patch: its op, the original line and an edited text that
/// replaces the line's content on the post side.
struct PatchLine<'a> {
    op: Op,
    line: &'a DiffLine,
    replacement: Option<&'a str>,
}

impl PatchLine<'_> {
    /// Whether the line is part of the patch's old side.
    fn on_old(&self) -> bool {
        self.op != Op::Add
    }

    /// Whether the line is part of the patch's new side; a replaced removal
    /// is written back as the replacement text.
    fn on_new(&self) -> bool {
        self.op != Op::Remove || self.replacement.is_some()
    }
}

/// Builds the patch text for `selection` of `diff`.
///
/// `reverse` swaps the sides (for unstage and discard); `mode` is the git file
/// mode written to the header, e.g. `0o100644`.
pub fn build_patch(
    diff: &FileDiff,
    selection: &HunkSelection,
    reverse: bool,
    mode: u32,
) -> Result<String, GitError> {
    if diff.truncated {
        return Err(GitError::BadSelection);
    }
    let change = match diff.change {
        Some(
            c @ (ChangeKind::Modified
            | ChangeKind::Added
            | ChangeKind::Untracked
            | ChangeKind::Deleted
            | ChangeKind::Renamed),
        ) => c,
        _ => return Err(GitError::BadSelection),
    };
    let hunk = diff
        .hunks
        .get(selection.hunk_index)
        .ok_or(GitError::BadSelection)?;
    if let Some(picked) = &selection.lines {
        let invalid = picked.iter().any(|&i| {
            hunk.lines
                .get(i)
                .is_none_or(|l| l.kind == DiffLineKind::Context)
        });
        if invalid {
            return Err(GitError::BadSelection);
        }
    }

    let edit_invalid = selection.edits.iter().enumerate().any(|(n, e)| {
        let duplicate = selection.edits[..n]
            .iter()
            .any(|prev| prev.index == e.index);
        let changed = hunk
            .lines
            .get(e.index)
            .is_some_and(|l| l.kind != DiffLineKind::Context);
        let picked = selection
            .lines
            .as_ref()
            .is_none_or(|lines| lines.contains(&e.index));
        // Only a final `\r` is allowed; anything else would add patch lines.
        let body = e.text.strip_suffix('\r').unwrap_or(&e.text);
        let single_line = !body.contains(['\n', '\r']);
        !(changed && picked && single_line) || duplicate
    });
    if edit_invalid {
        return Err(GitError::BadSelection);
    }

    let mut ops = order_edited_groups(
        &hunk.lines,
        select_ops(
            &hunk.lines,
            selection.lines.as_deref(),
            &selection.edits,
            reverse,
        ),
    );
    if ops.iter().all(|o| o.op == Op::Context) {
        return Err(GitError::BadSelection);
    }
    let old_count = ops.iter().filter(|o| o.on_old()).count() as u32;
    let new_count = ops.iter().filter(|o| o.on_new()).count() as u32;
    let old_start = if reverse {
        hunk.new_start
    } else {
        hunk.old_start
    };
    let new_start = if old_count == 0 {
        old_start + 1
    } else {
        old_start
    };

    let added = matches!(change, ChangeKind::Added | ChangeKind::Untracked);
    let deleted = change == ChangeKind::Deleted;
    let pre_missing = if reverse { deleted } else { added };
    let post_missing = (if reverse { added } else { deleted }) && new_count == 0;

    let path = &diff.path;
    let mut out = format!("diff --git a/{path} b/{path}\n");
    if pre_missing {
        out.push_str(&format!(
            "new file mode {mode:o}\n--- /dev/null\n+++ b/{path}\n"
        ));
    } else if post_missing {
        out.push_str(&format!(
            "deleted file mode {mode:o}\n--- a/{path}\n+++ /dev/null\n"
        ));
    } else {
        out.push_str(&format!(
            "index 0000000..0000000 {mode:o}\n--- a/{path}\n+++ b/{path}\n"
        ));
    }
    out.push_str(&format!(
        "@@ -{old_start},{old_count} +{new_start},{new_count} @@\n"
    ));
    order_flagged_runs(&mut ops);
    render_lines(&mut out, &ops);
    Ok(out)
}

/// Maps each line to its patch op, aligned with `lines`: `None` drops an
/// unselected post-side line, and an unselected pre-side line becomes context.
/// Indices in `picked` are already validated against `lines`.
fn select_ops<'a>(
    lines: &'a [DiffLine],
    picked: Option<&[usize]>,
    edits: &'a [LineEdit],
    reverse: bool,
) -> Vec<Option<PatchLine<'a>>> {
    let (post_only, pre_only) = if reverse {
        (DiffLineKind::Deletion, DiffLineKind::Addition)
    } else {
        (DiffLineKind::Addition, DiffLineKind::Deletion)
    };
    let mut selected = vec![picked.is_none(); lines.len()];
    for &i in picked.unwrap_or_default() {
        selected[i] = true;
    }
    let plain = |op, line| PatchLine {
        op,
        line,
        replacement: None,
    };
    lines
        .iter()
        .enumerate()
        .zip(selected)
        .map(|((i, line), selected)| {
            let replacement = edits.iter().find(|e| e.index == i).map(|e| e.text.as_str());
            match line.kind {
                DiffLineKind::Context => Some(plain(Op::Context, line)),
                k if k == post_only => selected.then_some(PatchLine {
                    op: Op::Add,
                    line,
                    replacement,
                }),
                k if k == pre_only && selected => Some(PatchLine {
                    op: Op::Remove,
                    line,
                    replacement,
                }),
                _ => Some(plain(Op::Context, line)),
            }
        })
        .collect()
}

/// Lays out each group of changed lines (a deletion run and the addition run
/// after it, paired by position as the viewer pairs them) in hunk order,
/// except a group holding an edit: its old lines are written first as
/// removals, then its new lines in pair order as additions, a kept line as a
/// removal and an addition of itself. A replacement then lands where its pair
/// sits among the group's other lines instead of ahead of them.
fn order_edited_groups<'a>(
    lines: &'a [DiffLine],
    ops: Vec<Option<PatchLine<'a>>>,
) -> Vec<PatchLine<'a>> {
    let mut out = Vec::with_capacity(ops.len());
    let mut ops = ops.into_iter();
    let mut start = 0;
    while start < lines.len() {
        if lines[start].kind == DiffLineKind::Context {
            out.extend(ops.next().flatten());
            start += 1;
            continue;
        }
        let dels = lines[start..]
            .iter()
            .take_while(|l| l.kind == DiffLineKind::Deletion)
            .count();
        let adds = lines[start + dels..]
            .iter()
            .take_while(|l| l.kind == DiffLineKind::Addition)
            .count();
        let group: Vec<_> = ops.by_ref().take(dels + adds).collect();
        start += dels + adds;
        if !group.iter().flatten().any(|o| o.replacement.is_some()) {
            out.extend(group.into_iter().flatten());
            continue;
        }
        let as_op = |op, o: &PatchLine<'a>, replacement| PatchLine {
            op,
            line: o.line,
            replacement,
        };
        out.extend(
            group
                .iter()
                .flatten()
                .filter(|o| o.on_old())
                .map(|o| as_op(Op::Remove, o, None)),
        );
        for k in 0..dels.max(adds) {
            let slot = [(k < dels).then_some(k), (k < adds).then_some(dels + k)];
            for o in slot.into_iter().flatten().filter_map(|i| group[i].as_ref()) {
                if o.on_new() {
                    out.push(as_op(Op::Add, o, o.replacement));
                }
            }
        }
    }
    out
}

/// Within each run of changed lines that carries a no-newline flag, moves
/// removals before additions: libgit2 rejects a `+` marker followed by `-`.
/// Runs without a flag keep their order, which libgit2 accepts as is.
fn order_flagged_runs(ops: &mut [PatchLine]) {
    for run in ops.split_mut(|o| o.op == Op::Context) {
        if run.iter().any(|o| o.line.no_newline_at_eof) {
            run.sort_by_key(|o| o.op == Op::Add);
        }
    }
}

/// Writes the hunk body. A marker follows a flagged line only when it is the
/// last line of its side; a flagged context line that ends the old side but
/// is followed by additions is written as a remove/add pair.
fn render_lines(out: &mut String, ops: &[PatchLine]) {
    let last_old = ops.iter().rposition(PatchLine::on_old);
    let last_new = ops.iter().rposition(PatchLine::on_new);
    for (i, patch_line) in ops.iter().enumerate() {
        let PatchLine {
            op,
            line,
            replacement,
        } = *patch_line;
        let content = &line.content;
        let ends_old = last_old == Some(i);
        let ends_new = last_new == Some(i);
        let (sign, marker) = match op {
            Op::Context if line.no_newline_at_eof && ends_old && !ends_new => {
                out.push_str(&format!("-{content}\n{NO_NEWLINE_MARKER}+{content}\n"));
                continue;
            }
            Op::Context => (' ', ends_old && ends_new),
            Op::Add => ('+', ends_new),
            Op::Remove => ('-', ends_old),
        };
        if op == Op::Remove
            && let Some(text) = replacement
        {
            out.push_str(&format!("-{content}\n"));
            if marker && line.no_newline_at_eof {
                out.push_str(NO_NEWLINE_MARKER);
            }
            out.push_str(&format!("+{text}\n"));
            if ends_new && line.no_newline_at_eof {
                out.push_str(NO_NEWLINE_MARKER);
            }
            continue;
        }
        let content = replacement.unwrap_or(content);
        out.push_str(&format!("{sign}{content}\n"));
        if marker && line.no_newline_at_eof {
            out.push_str(NO_NEWLINE_MARKER);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::GitError;
    use crate::model::{
        ChangeKind, DiffLine, DiffLineKind, DiffScope, FileDiff, Hunk, HunkSelection, LineEdit,
    };

    // --- helpers ---

    const MODE: u32 = 0o100644;

    fn modify_head(path: &str) -> String {
        format!(
            "diff --git a/{path} b/{path}\nindex 0000000..0000000 100644\n--- a/{path}\n+++ b/{path}\n"
        )
    }

    fn create_head(path: &str) -> String {
        format!("diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n")
    }

    fn delete_head(path: &str) -> String {
        format!(
            "diff --git a/{path} b/{path}\ndeleted file mode 100644\n--- a/{path}\n+++ /dev/null\n"
        )
    }

    fn ctx(content: &str) -> DiffLine {
        dl(DiffLineKind::Context, content, false)
    }

    fn add(content: &str) -> DiffLine {
        dl(DiffLineKind::Addition, content, false)
    }

    fn del(content: &str) -> DiffLine {
        dl(DiffLineKind::Deletion, content, false)
    }

    fn dl(kind: DiffLineKind, content: &str, no_newline_at_eof: bool) -> DiffLine {
        DiffLine {
            kind,
            old_lineno: None,
            new_lineno: None,
            content: content.into(),
            no_newline_at_eof,
        }
    }

    /// Builds a hunk whose counts are derived from its lines.
    fn hunk(old_start: u32, new_start: u32, lines: Vec<DiffLine>) -> Hunk {
        let old_lines = lines
            .iter()
            .filter(|l| l.kind != DiffLineKind::Addition)
            .count() as u32;
        let new_lines = lines
            .iter()
            .filter(|l| l.kind != DiffLineKind::Deletion)
            .count() as u32;
        Hunk {
            old_start,
            old_lines,
            new_start,
            new_lines,
            header: format!("@@ -{old_start},{old_lines} +{new_start},{new_lines} @@"),
            lines,
        }
    }

    fn file_diff(path: &str, change: ChangeKind, hunks: Vec<Hunk>) -> FileDiff {
        FileDiff {
            path: path.into(),
            old_path: None,
            scope: DiffScope::Unstaged,
            change: Some(change),
            is_binary: false,
            hunks,
            truncated: false,
            old_encoding: None,
            new_encoding: None,
        }
    }

    fn whole(hunk_index: usize) -> HunkSelection {
        HunkSelection {
            hunk_index,
            lines: None,
            edits: vec![],
        }
    }

    fn lines(hunk_index: usize, picked: &[usize]) -> HunkSelection {
        HunkSelection {
            hunk_index,
            lines: Some(picked.to_vec()),
            edits: vec![],
        }
    }

    fn sel(picked: &[usize], edits: &[(usize, &str)]) -> HunkSelection {
        HunkSelection {
            hunk_index: 0,
            lines: Some(picked.to_vec()),
            edits: edits
                .iter()
                .map(|(index, text)| LineEdit {
                    index: *index,
                    text: (*text).to_owned(),
                })
                .collect(),
        }
    }

    /// `[-a, -b, +c, +d]` starting at line 1 on both sides.
    fn two_for_two() -> FileDiff {
        file_diff(
            "f.txt",
            ChangeKind::Modified,
            vec![hunk(1, 1, vec![del("a"), del("b"), add("c"), add("d")])],
        )
    }

    // --- whole hunk: header and lines are emitted exactly ---

    #[test]
    fn build_patch_whole_hunk_round_trips_header_and_lines() {
        let diff = file_diff(
            "README.md",
            ChangeKind::Modified,
            vec![hunk(1, 1, vec![ctx("# fixture"), add("second")])],
        );
        let patch = build_patch(&diff, &whole(0), false, MODE).expect("patch");
        assert_eq!(
            patch,
            format!(
                "{}@@ -1,1 +1,2 @@\n # fixture\n+second\n",
                modify_head("README.md")
            )
        );
    }

    #[test]
    fn build_patch_second_hunk_emits_only_the_selected_hunk() {
        let diff = file_diff(
            "f.txt",
            ChangeKind::Modified,
            vec![
                hunk(1, 1, vec![del("a"), add("A")]),
                hunk(20, 20, vec![del("t"), add("T")]),
            ],
        );
        let patch = build_patch(&diff, &whole(1), false, MODE).expect("patch");
        assert_eq!(
            patch,
            format!("{}@@ -20,1 +20,1 @@\n-t\n+T\n", modify_head("f.txt"))
        );
    }

    // --- added and deleted files use /dev/null ---

    #[test]
    fn build_patch_added_file_uses_dev_null_old() {
        let diff = file_diff(
            "new.txt",
            ChangeKind::Added,
            vec![hunk(0, 1, vec![add("one"), add("two")])],
        );
        let patch = build_patch(&diff, &whole(0), false, MODE).expect("patch");
        assert_eq!(
            patch,
            format!("{}@@ -0,0 +1,2 @@\n+one\n+two\n", create_head("new.txt"))
        );
    }

    #[test]
    fn build_patch_untracked_file_uses_dev_null_old() {
        let diff = file_diff(
            "new.txt",
            ChangeKind::Untracked,
            vec![hunk(0, 1, vec![add("one")])],
        );
        let patch = build_patch(&diff, &whole(0), false, MODE).expect("patch");
        assert_eq!(
            patch,
            format!("{}@@ -0,0 +1,1 @@\n+one\n", create_head("new.txt"))
        );
    }

    #[test]
    fn build_patch_deleted_file_uses_dev_null_new() {
        let diff = file_diff(
            "old.txt",
            ChangeKind::Deleted,
            vec![hunk(1, 0, vec![del("one"), del("two")])],
        );
        let patch = build_patch(&diff, &whole(0), false, MODE).expect("patch");
        assert_eq!(
            patch,
            format!("{}@@ -1,2 +1,0 @@\n-one\n-two\n", delete_head("old.txt"))
        );
    }

    // --- partial line selection: unselected deletions become context, unselected additions are dropped ---

    #[test]
    fn build_patch_partial_lines_keeps_unselected_deletions_as_context() {
        let patch = build_patch(&two_for_two(), &lines(0, &[0, 2]), false, MODE).expect("patch");
        assert_eq!(
            patch,
            format!("{}@@ -1,2 +1,2 @@\n-a\n b\n+c\n", modify_head("f.txt"))
        );
    }

    #[test]
    fn build_patch_partial_lines_drops_unselected_additions() {
        let patch = build_patch(&two_for_two(), &lines(0, &[0, 1, 3]), false, MODE).expect("patch");
        assert_eq!(
            patch,
            format!("{}@@ -1,2 +1,1 @@\n-a\n-b\n+d\n", modify_head("f.txt"))
        );
    }

    #[test]
    fn build_patch_partial_lines_keeps_context_lines_in_place() {
        let diff = file_diff(
            "f.txt",
            ChangeKind::Modified,
            vec![hunk(
                1,
                1,
                vec![
                    ctx("a"),
                    del("b"),
                    add("B"),
                    ctx("c"),
                    del("d"),
                    add("D"),
                    ctx("e"),
                ],
            )],
        );
        let patch = build_patch(&diff, &lines(0, &[1, 2]), false, MODE).expect("patch");
        assert_eq!(
            patch,
            format!(
                "{}@@ -1,5 +1,5 @@\n a\n-b\n+B\n c\n d\n e\n",
                modify_head("f.txt")
            )
        );
    }

    // --- reverse: signs and counts swap ---

    #[test]
    fn build_patch_reverse_swaps_signs_and_counts() {
        let diff = file_diff(
            "README.md",
            ChangeKind::Modified,
            vec![hunk(1, 1, vec![ctx("# fixture"), add("second")])],
        );
        let patch = build_patch(&diff, &whole(0), true, MODE).expect("patch");
        assert_eq!(
            patch,
            format!(
                "{}@@ -1,2 +1,1 @@\n # fixture\n-second\n",
                modify_head("README.md")
            )
        );
    }

    #[test]
    fn build_patch_reverse_added_file_becomes_deletion_to_dev_null() {
        let diff = file_diff(
            "new.txt",
            ChangeKind::Added,
            vec![hunk(0, 1, vec![add("one"), add("two")])],
        );
        let patch = build_patch(&diff, &whole(0), true, MODE).expect("patch");
        assert_eq!(
            patch,
            format!("{}@@ -1,2 +1,0 @@\n-one\n-two\n", delete_head("new.txt"))
        );
    }

    #[test]
    fn build_patch_reverse_deleted_file_becomes_addition_from_dev_null() {
        let diff = file_diff(
            "old.txt",
            ChangeKind::Deleted,
            vec![hunk(1, 0, vec![del("one")])],
        );
        let patch = build_patch(&diff, &whole(0), true, MODE).expect("patch");
        assert_eq!(
            patch,
            format!("{}@@ -0,0 +1,1 @@\n+one\n", create_head("old.txt"))
        );
    }

    // In reverse the patch targets the side that holds the additions, so
    // unselected additions are context and unselected deletions are dropped.
    #[test]
    fn build_patch_reverse_partial_keeps_unselected_additions_as_context() {
        let patch = build_patch(&two_for_two(), &lines(0, &[0, 2]), true, MODE).expect("patch");
        assert_eq!(
            patch,
            format!("{}@@ -1,2 +1,2 @@\n+a\n-c\n d\n", modify_head("f.txt"))
        );
    }

    #[test]
    fn build_patch_reverse_partial_drops_unselected_deletions() {
        let patch = build_patch(&two_for_two(), &lines(0, &[2, 3]), true, MODE).expect("patch");
        assert_eq!(
            patch,
            format!("{}@@ -1,2 +1,0 @@\n-c\n-d\n", modify_head("f.txt"))
        );
    }

    // --- missing trailing newline ---

    #[test]
    fn build_patch_no_newline_marker_follows_flagged_line() {
        let diff = file_diff(
            "f.txt",
            ChangeKind::Modified,
            vec![hunk(
                1,
                1,
                vec![
                    ctx("keep"),
                    del("old"),
                    dl(DiffLineKind::Addition, "new", true),
                ],
            )],
        );
        let patch = build_patch(&diff, &whole(0), false, MODE).expect("patch");
        assert_eq!(
            patch,
            format!(
                "{}@@ -1,2 +1,2 @@\n keep\n-old\n+new\n\\ No newline at end of file\n",
                modify_head("f.txt")
            )
        );
    }

    // --- GR-52: partial-line edits ---

    fn del_add_diff() -> FileDiff {
        file_diff(
            "f.txt",
            ChangeKind::Modified,
            vec![hunk(1, 1, vec![ctx("a"), del("A"), add("B"), ctx("z")])],
        )
    }

    #[test]
    fn edit_on_remove_replaces_the_line_forward() {
        let patch =
            build_patch(&del_add_diff(), &sel(&[1], &[(1, "C")]), false, MODE).expect("patch");
        assert_eq!(
            patch,
            format!("{}@@ -1,3 +1,3 @@\n a\n-A\n+C\n z\n", modify_head("f.txt"))
        );
    }

    #[test]
    fn edit_on_remove_replaces_the_line_reverse() {
        let patch =
            build_patch(&del_add_diff(), &sel(&[2], &[(2, "C'")]), true, MODE).expect("patch");
        assert!(patch.ends_with(" a\n-B\n+C'\n z\n"), "got {patch:?}");
    }

    #[test]
    fn edit_on_add_writes_replacement_text() {
        let diff = file_diff(
            "f.txt",
            ChangeKind::Modified,
            vec![hunk(1, 1, vec![ctx("a"), add("B"), ctx("z")])],
        );
        let patch = build_patch(&diff, &sel(&[1], &[(1, "P")]), false, MODE).expect("patch");
        assert!(patch.ends_with(" a\n+P\n z\n"), "got {patch:?}");
    }

    #[test]
    fn edit_on_add_reverse_of_pure_deletion() {
        let diff = file_diff(
            "f.txt",
            ChangeKind::Modified,
            vec![hunk(1, 1, vec![ctx("a"), del("A"), ctx("z")])],
        );
        let patch = build_patch(&diff, &sel(&[1], &[(1, "P")]), true, MODE).expect("patch");
        assert!(patch.ends_with(" a\n+P\n z\n"), "got {patch:?}");
    }

    #[test]
    fn edit_keeps_no_newline_marker_on_last_line() {
        let diff = file_diff(
            "f.txt",
            ChangeKind::Modified,
            vec![hunk(
                1,
                1,
                vec![
                    ctx("a"),
                    dl(DiffLineKind::Deletion, "A", true),
                    dl(DiffLineKind::Addition, "B", true),
                ],
            )],
        );
        let patch = build_patch(&diff, &sel(&[1], &[(1, "C")]), false, MODE).expect("patch");
        assert!(
            patch.ends_with(
                " a\n-A\n\\ No newline at end of file\n+C\n\\ No newline at end of file\n"
            ),
            "got {patch:?}"
        );
    }

    #[test]
    fn edit_on_unselected_line_is_bad_selection() {
        let diff = file_diff(
            "f.txt",
            ChangeKind::Modified,
            vec![hunk(1, 1, vec![ctx("a"), del("A"), add("B")])],
        );
        let err = build_patch(&diff, &sel(&[1], &[(2, "x")]), false, MODE).expect_err("bad");
        assert!(matches!(err, GitError::BadSelection), "got {err:?}");
    }

    #[test]
    fn edit_on_context_line_is_bad_selection() {
        let diff = file_diff(
            "f.txt",
            ChangeKind::Modified,
            vec![hunk(1, 1, vec![ctx("a"), del("A"), add("B")])],
        );
        let err = build_patch(&diff, &sel(&[0, 1], &[(0, "x")]), false, MODE).expect_err("bad");
        assert!(matches!(err, GitError::BadSelection), "got {err:?}");
    }

    #[test]
    fn edit_text_with_newline_is_bad_selection() {
        let err =
            build_patch(&del_add_diff(), &sel(&[1], &[(1, "C\nD")]), false, MODE).expect_err("bad");
        assert!(matches!(err, GitError::BadSelection), "got {err:?}");
    }

    #[test]
    fn edit_text_with_interior_carriage_return_is_bad_selection() {
        let err =
            build_patch(&del_add_diff(), &sel(&[1], &[(1, "C\rD")]), false, MODE).expect_err("bad");
        assert!(matches!(err, GitError::BadSelection), "got {err:?}");
        let patch = build_patch(&del_add_diff(), &sel(&[1], &[(1, "C\r")]), false, MODE)
            .expect("trailing CR is accepted");
        assert!(patch.ends_with(" a\n-A\n+C\r\n z\n"), "got {patch:?}");
    }

    #[test]
    fn duplicate_edit_index_is_bad_selection() {
        let err = build_patch(
            &del_add_diff(),
            &sel(&[1], &[(1, "C"), (1, "D")]),
            false,
            MODE,
        )
        .expect_err("bad");
        assert!(matches!(err, GitError::BadSelection), "got {err:?}");
    }

    #[test]
    fn edited_remove_with_selected_partner_add_stages_both_texts() {
        let patch =
            build_patch(&del_add_diff(), &sel(&[1, 2], &[(1, "C")]), false, MODE).expect("patch");
        assert_eq!(
            patch,
            format!(
                "{}@@ -1,3 +1,4 @@\n a\n-A\n+C\n+B\n z\n",
                modify_head("f.txt")
            )
        );
    }

    #[test]
    fn serde_round_trips_edits_and_defaults_to_empty() {
        let without: HunkSelection =
            serde_json::from_str(r#"{"hunkIndex":0,"lines":[1]}"#).expect("parse");
        assert_eq!(without.edits, vec![]);
        let with: HunkSelection =
            serde_json::from_str(r#"{"hunkIndex":0,"lines":[1],"edits":[{"index":1,"text":"C"}]}"#)
                .expect("parse");
        assert_eq!(
            with.edits,
            vec![LineEdit {
                index: 1,
                text: "C".to_owned()
            }]
        );
        let back: HunkSelection =
            serde_json::from_str(&serde_json::to_string(&with).expect("ser")).expect("parse");
        assert_eq!(back, with);
    }

    // --- invalid selections ---

    #[test]
    fn build_patch_out_of_range_hunk_is_bad_selection() {
        let err = build_patch(&two_for_two(), &whole(1), false, MODE).expect_err("bad hunk index");
        assert!(matches!(err, GitError::BadSelection), "got {err:?}");
    }

    #[test]
    fn build_patch_context_line_index_is_bad_selection() {
        let diff = file_diff(
            "f.txt",
            ChangeKind::Modified,
            vec![hunk(1, 1, vec![ctx("a"), add("b")])],
        );
        let err =
            build_patch(&diff, &lines(0, &[0, 1]), false, MODE).expect_err("context selected");
        assert!(matches!(err, GitError::BadSelection), "got {err:?}");
    }

    #[test]
    fn build_patch_line_index_out_of_range_is_bad_selection() {
        let err = build_patch(&two_for_two(), &lines(0, &[9]), false, MODE).expect_err("bad line");
        assert!(matches!(err, GitError::BadSelection), "got {err:?}");
    }

    #[test]
    fn build_patch_empty_selection_is_bad_selection() {
        let err = build_patch(&two_for_two(), &lines(0, &[]), false, MODE).expect_err("empty");
        assert!(matches!(err, GitError::BadSelection), "got {err:?}");
    }

    #[test]
    fn build_patch_diff_without_hunks_is_bad_selection() {
        let diff = file_diff("f.txt", ChangeKind::Modified, vec![]);
        let err = build_patch(&diff, &whole(0), false, MODE).expect_err("no hunks");
        assert!(matches!(err, GitError::BadSelection), "got {err:?}");
    }

    // --- starts are recomputed: the diff's own new_start is never trusted ---

    #[test]
    fn build_patch_rewrites_new_start_to_old_start() {
        let diff = file_diff(
            "f.txt",
            ChangeKind::Modified,
            vec![hunk(15, 17, vec![ctx("a"), ctx("b"), ctx("c"), add("d")])],
        );
        let forward = build_patch(&diff, &whole(0), false, MODE).expect("patch");
        let reverse = build_patch(&diff, &whole(0), true, MODE).expect("patch");
        assert_eq!(
            (forward, reverse),
            (
                format!(
                    "{}@@ -15,3 +15,4 @@\n a\n b\n c\n+d\n",
                    modify_head("f.txt")
                ),
                format!(
                    "{}@@ -17,4 +17,3 @@\n a\n b\n c\n-d\n",
                    modify_head("f.txt")
                ),
            )
        );
    }

    #[test]
    fn build_patch_pure_insertion_starts_new_side_one_after_old() {
        let diff = file_diff(
            "f.txt",
            ChangeKind::Modified,
            vec![hunk(3, 4, vec![add("x")])],
        );
        let patch = build_patch(&diff, &whole(0), false, MODE).expect("patch");
        assert_eq!(
            patch,
            format!("{}@@ -3,0 +4,1 @@\n+x\n", modify_head("f.txt"))
        );
    }

    // --- no-newline flag edge cases ---

    #[test]
    fn build_patch_flagged_pair_emits_marker_after_each_line() {
        let diff = file_diff(
            "f.txt",
            ChangeKind::Modified,
            vec![hunk(
                1,
                1,
                vec![
                    dl(DiffLineKind::Deletion, "x", true),
                    dl(DiffLineKind::Addition, "y", true),
                ],
            )],
        );
        let patch = build_patch(&diff, &whole(0), false, MODE).expect("patch");
        assert_eq!(
            patch,
            format!(
                "{}@@ -1,1 +1,1 @@\n-x\n\\ No newline at end of file\n+y\n\\ No newline at end of file\n",
                modify_head("f.txt")
            )
        );
    }

    #[test]
    fn build_patch_flagged_line_turned_context_before_addition_is_rewritten() {
        let diff = file_diff(
            "f.txt",
            ChangeKind::Modified,
            vec![hunk(
                1,
                1,
                vec![
                    dl(DiffLineKind::Deletion, "x", true),
                    dl(DiffLineKind::Addition, "y", true),
                ],
            )],
        );
        let patch = build_patch(&diff, &lines(0, &[1]), false, MODE).expect("patch");
        assert_eq!(
            patch,
            format!(
                "{}@@ -1,1 +1,2 @@\n-x\n\\ No newline at end of file\n+x\n+y\n\\ No newline at end of file\n",
                modify_head("f.txt")
            )
        );
    }

    // --- headers for partial deletions and modes ---

    #[test]
    fn build_patch_partial_deleted_file_uses_modify_header() {
        let diff = file_diff(
            "f.txt",
            ChangeKind::Deleted,
            vec![hunk(1, 0, vec![del("x"), del("y")])],
        );
        let patch = build_patch(&diff, &lines(0, &[0]), false, MODE).expect("patch");
        assert_eq!(
            patch,
            format!("{}@@ -1,2 +1,1 @@\n-x\n y\n", modify_head("f.txt"))
        );
    }

    #[test]
    fn build_patch_keeps_executable_mode() {
        let diff = file_diff(
            "run.sh",
            ChangeKind::Modified,
            vec![hunk(1, 1, vec![ctx("a"), add("b")])],
        );
        let patch = build_patch(&diff, &whole(0), false, 0o100755).expect("patch");
        assert!(
            patch.contains("index 0000000..0000000 100755\n"),
            "got {patch}"
        );
    }

    #[test]
    fn build_patch_ignores_old_path_of_a_rename() {
        let mut diff = file_diff(
            "DOC.md",
            ChangeKind::Renamed,
            vec![hunk(1, 1, vec![del("e"), add("E")])],
        );
        diff.old_path = Some("README.md".into());
        let patch = build_patch(&diff, &whole(0), true, MODE).expect("patch");
        assert!(patch.starts_with(&modify_head("DOC.md")), "got {patch}");
    }

    #[test]
    fn build_patch_added_file_with_mode_uses_new_file_mode_line() {
        let diff = file_diff(
            "run.sh",
            ChangeKind::Added,
            vec![hunk(0, 1, vec![add("x")])],
        );
        let patch = build_patch(&diff, &whole(0), false, 0o100755).expect("patch");
        assert!(patch.contains("new file mode 100755\n"), "got {patch}");
    }

    // --- more invalid inputs ---

    #[test]
    fn build_patch_truncated_diff_is_bad_selection() {
        let mut diff = two_for_two();
        diff.truncated = true;
        let err = build_patch(&diff, &whole(0), false, MODE).expect_err("truncated");
        assert!(matches!(err, GitError::BadSelection), "got {err:?}");
    }

    #[test]
    fn build_patch_conflicted_change_is_bad_selection() {
        let mut diff = two_for_two();
        diff.change = Some(ChangeKind::Conflicted);
        let err = build_patch(&diff, &whole(0), false, MODE).expect_err("conflicted");
        assert!(matches!(err, GitError::BadSelection), "got {err:?}");
    }

    #[test]
    fn build_patch_type_change_is_bad_selection() {
        let mut diff = two_for_two();
        diff.change = Some(ChangeKind::TypeChange);
        let err = build_patch(&diff, &whole(0), false, MODE).expect_err("type change");
        assert!(matches!(err, GitError::BadSelection), "got {err:?}");
    }

    #[test]
    fn build_patch_unchanged_file_is_bad_selection() {
        let mut diff = two_for_two();
        diff.change = None;
        let err = build_patch(&diff, &whole(0), false, MODE).expect_err("no change");
        assert!(matches!(err, GitError::BadSelection), "got {err:?}");
    }

    #[test]
    fn build_patch_reverse_selection_of_only_unselectable_side_is_bad_selection() {
        // Reversed, picking nothing but context-turned lines leaves no +/- line.
        let err = build_patch(&two_for_two(), &lines(0, &[]), true, MODE).expect_err("empty");
        assert!(matches!(err, GitError::BadSelection), "got {err:?}");
    }
}
