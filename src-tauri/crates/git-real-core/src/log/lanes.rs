//! Streaming lane layout for the commit graph (spec section 3.3).
//!
//! Commits arrive in topological order, children before parents. Each column
//! holds the oid of the commit it is waiting for; a commit's dot takes the
//! first column expecting it (or a free one), its parents leave from the dot,
//! and every other occupied column passes straight through the row.

use git2::Oid;

use crate::model::GraphEdge;

pub(crate) struct LaneLayout {
    /// Per column, the commit that column's line is heading to; `None` is free.
    columns: Vec<Option<Oid>>,
    /// The widest the layout has been, sampled before trailing free columns
    /// are trimmed so a dot in a new last column counts.
    max_columns: u32,
}

impl LaneLayout {
    pub(crate) fn new() -> Self {
        Self {
            columns: Vec::new(),
            max_columns: 0,
        }
    }

    /// Places `oid` and returns its column and the row's edges, sorted.
    pub(crate) fn next(&mut self, oid: Oid, parents: &[Oid]) -> (u32, Vec<GraphEdge>) {
        let before = self.columns.clone();
        let mut edges = Vec::new();

        // 1. The dot's column: the first one expecting this commit, else a free one.
        let expecting: Vec<usize> = before
            .iter()
            .enumerate()
            .filter(|(_, c)| **c == Some(oid))
            .map(|(k, _)| k)
            .collect();
        let lane = match expecting.first() {
            Some(&k) => k,
            None => self.take_free(),
        };

        // 2. Every column expecting this commit joins the dot and is freed.
        for &k in &expecting {
            edges.push(edge(Some(k), None));
            self.columns[k] = None;
        }

        // 3. Parents leave the dot: the first in the dot's column, the others
        //    in the column already expecting them or a free one.
        for (i, parent) in parents.iter().enumerate() {
            let k = if i == 0 {
                lane
            } else {
                match self.columns.iter().position(|c| *c == Some(*parent)) {
                    Some(k) => k,
                    None => self.take_free(),
                }
            };
            self.columns[k] = Some(*parent);
            edges.push(edge(None, Some(k)));
        }

        // 4. Columns this commit did not touch pass straight through.
        for (k, expected) in before.iter().enumerate() {
            if expected.is_some()
                && *expected != Some(oid)
                && self.columns.get(k).is_some_and(Option::is_some)
            {
                edges.push(edge(Some(k), Some(k)));
            }
        }

        self.max_columns = self.max_columns.max(to_u32(self.columns.len()));
        while self.columns.last().is_some_and(Option::is_none) {
            self.columns.pop();
        }
        edges.sort();
        (to_u32(lane), edges)
    }

    /// The widest row laid out so far.
    pub(crate) fn max_columns(&self) -> u32 {
        self.max_columns
    }

    /// The first free column, or a new one; the slot is left `None` for the
    /// caller to fill.
    fn take_free(&mut self) -> usize {
        match self.columns.iter().position(Option::is_none) {
            Some(k) => k,
            None => {
                self.columns.push(None);
                self.columns.len() - 1
            }
        }
    }
}

fn edge(top: Option<usize>, bottom: Option<usize>) -> GraphEdge {
    GraphEdge {
        top: top.map(to_u32),
        bottom: bottom.map(to_u32),
    }
}

fn to_u32(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::GraphEdge;
    use git2::Oid;

    fn o(n: u8) -> Oid {
        Oid::from_bytes(&[n; 20]).unwrap()
    }

    fn e(top: Option<u32>, bottom: Option<u32>) -> GraphEdge {
        GraphEdge { top, bottom }
    }

    // Linear history: a single column; the tip has no line above its dot and
    // the root has no line below it.
    #[test]
    fn should_use_one_column_when_history_is_linear() {
        let mut l = LaneLayout::new();
        assert_eq!(l.next(o(2), &[o(1)]), (0, vec![e(None, Some(0))]));
        assert_eq!(
            l.next(o(1), &[o(0)]),
            (0, vec![e(None, Some(0)), e(Some(0), None)])
        );
        assert_eq!(l.next(o(0), &[]), (0, vec![e(Some(0), None)]));
        assert_eq!(l.max_columns(), 1);
    }

    #[test]
    fn should_give_a_lone_root_commit_no_edges_when_nothing_expects_it() {
        let mut l = LaneLayout::new();
        assert_eq!(l.next(o(1), &[]), (0, vec![]));
    }

    #[test]
    fn should_report_zero_max_columns_when_no_commit_was_laid_out() {
        assert_eq!(LaneLayout::new().max_columns(), 0);
    }

    // A merge opens a second column that closes again at the fork commit.
    #[test]
    fn should_open_a_second_column_when_a_merge_has_two_parents_and_close_it_at_the_fork() {
        let (m, a, b, r) = (o(9), o(3), o(2), o(1));
        let mut l = LaneLayout::new();
        assert_eq!(
            l.next(m, &[a, b]),
            (0, vec![e(None, Some(0)), e(None, Some(1))])
        );
        assert_eq!(
            l.next(a, &[r]),
            (
                0,
                vec![e(None, Some(0)), e(Some(0), None), e(Some(1), Some(1))]
            )
        );
        assert_eq!(
            l.next(b, &[r]),
            (
                1,
                vec![e(None, Some(1)), e(Some(0), Some(0)), e(Some(1), None)]
            )
        );
        assert_eq!(
            l.next(r, &[]),
            (0, vec![e(Some(0), None), e(Some(1), None)])
        );
        assert_eq!(l.max_columns(), 2);
    }

    // Two tips with a common parent: both columns run to it and join there.
    #[test]
    fn should_join_both_columns_at_the_parent_when_two_tips_share_it() {
        let mut l = LaneLayout::new();
        assert_eq!(l.next(o(3), &[o(1)]), (0, vec![e(None, Some(0))]));
        assert_eq!(
            l.next(o(2), &[o(1)]),
            (1, vec![e(None, Some(1)), e(Some(0), Some(0))])
        );
        assert_eq!(
            l.next(o(1), &[]),
            (0, vec![e(Some(0), None), e(Some(1), None)])
        );
    }

    // A column freed by a join is available to a later tip.
    #[test]
    fn should_reuse_a_freed_column_when_a_later_tip_appears() {
        let (m, a, b, t, r) = (o(9), o(3), o(2), o(4), o(1));
        let mut l = LaneLayout::new();
        l.next(m, &[a, b]);
        l.next(b, &[a]);
        assert_eq!(
            l.next(a, &[r]),
            (
                0,
                vec![e(None, Some(0)), e(Some(0), None), e(Some(1), None)]
            )
        );
        assert_eq!(
            l.next(t, &[r]),
            (1, vec![e(None, Some(1)), e(Some(0), Some(0))])
        );
        assert_eq!(
            l.next(r, &[]),
            (0, vec![e(Some(0), None), e(Some(1), None)])
        );
        assert_eq!(l.max_columns(), 2);
    }

    #[test]
    fn should_open_two_extra_columns_when_a_merge_has_three_parents() {
        let mut l = LaneLayout::new();
        assert_eq!(
            l.next(o(9), &[o(1), o(2), o(3)]),
            (
                0,
                vec![e(None, Some(0)), e(None, Some(1)), e(None, Some(2))]
            )
        );
        assert_eq!(l.max_columns(), 3);
    }

    // A later parent already expected by another column yields a pass-through
    // for that column and a second edge to the same column (review focus 3).
    #[test]
    fn should_yield_pass_through_and_join_when_a_later_parent_is_already_expected() {
        let mut l = LaneLayout::new();
        l.next(o(5), &[o(2)]);
        assert_eq!(
            l.next(o(4), &[o(3), o(2)]),
            (
                1,
                vec![e(None, Some(0)), e(None, Some(1)), e(Some(0), Some(0))]
            )
        );
    }

    // A first parent already expected by another column still draws both
    // lines to the parent's row (review focus 3).
    #[test]
    fn should_draw_both_lines_when_the_first_parent_is_already_expected_elsewhere() {
        let (m, a, b) = (o(9), o(3), o(2));
        let mut l = LaneLayout::new();
        l.next(m, &[a, b]);
        assert_eq!(
            l.next(b, &[a]),
            (
                1,
                vec![e(None, Some(1)), e(Some(0), Some(0)), e(Some(1), None)]
            )
        );
    }

    // Untouched columns pass straight through a row that is not theirs.
    #[test]
    fn should_pass_other_columns_through_when_a_commit_is_not_expected_by_them() {
        let mut l = LaneLayout::new();
        l.next(o(5), &[o(1)]);
        assert_eq!(
            l.next(o(6), &[o(2)]),
            (1, vec![e(None, Some(1)), e(Some(0), Some(0))])
        );
    }

    #[test]
    fn should_return_edges_sorted_when_a_row_has_mixed_edges() {
        let (m, a, b, r) = (o(9), o(3), o(2), o(1));
        let mut l = LaneLayout::new();
        l.next(m, &[a, b]);
        l.next(a, &[r]);
        let (_, edges) = l.next(b, &[r]);
        let mut sorted = edges.clone();
        sorted.sort();
        assert_eq!(edges, sorted);
    }

    #[test]
    fn should_order_edges_with_none_before_some_when_compared() {
        assert!(e(None, Some(5)) < e(Some(0), None));
        assert!(e(Some(0), None) < e(Some(0), Some(0)));
        assert!(e(Some(0), Some(0)) < e(Some(1), None));
    }

    #[test]
    fn should_trim_a_trailing_free_column_when_a_root_closes_it() {
        let mut l = LaneLayout::new();
        l.next(o(3), &[o(1)]);
        l.next(o(2), &[]);
        assert_eq!(l.columns.len(), 1);
    }

    #[test]
    fn should_empty_the_columns_when_every_line_has_ended() {
        let mut l = LaneLayout::new();
        l.next(o(9), &[o(3), o(2)]);
        l.next(o(3), &[]);
        l.next(o(2), &[]);
        assert_eq!(l.columns.len(), 0);
    }

    // max_columns is sampled before trimming, so a root dot in a new last
    // column still counts toward the widest row.
    #[test]
    fn should_count_a_root_dot_in_a_new_column_when_computing_max_columns() {
        let mut l = LaneLayout::new();
        l.next(o(3), &[o(1)]);
        assert_eq!(l.next(o(2), &[]), (1, vec![e(Some(0), Some(0))]));
        assert_eq!(l.max_columns(), 2);
    }

    #[test]
    fn should_keep_max_columns_at_the_widest_row_when_lines_close_again() {
        let mut l = LaneLayout::new();
        l.next(o(9), &[o(3), o(2)]);
        l.next(o(3), &[]);
        l.next(o(2), &[]);
        assert_eq!(l.max_columns(), 2);
    }

    #[test]
    fn should_give_identical_output_when_the_same_commits_are_laid_out_twice() {
        let run = || {
            let mut l = LaneLayout::new();
            vec![
                l.next(o(9), &[o(3), o(2)]),
                l.next(o(3), &[o(1)]),
                l.next(o(2), &[o(1)]),
                l.next(o(1), &[]),
            ]
        };
        assert_eq!(run(), run());
    }
}
