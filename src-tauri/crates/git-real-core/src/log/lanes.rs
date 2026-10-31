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

    /// A layout resuming from a checkpoint: `columns` as [`Self::columns`]
    /// returned them. The seed's width counts toward [`Self::max_columns`].
    #[cfg_attr(not(test), expect(dead_code, reason = "used by the builder (Task 4)"))]
    pub(crate) fn from_columns(columns: Vec<Option<Oid>>) -> Self {
        let max_columns = to_u32(columns.len());
        Self {
            columns,
            max_columns,
        }
    }

    /// The column state between rows, the checkpoint a replay starts from.
    #[cfg_attr(not(test), expect(dead_code, reason = "used by the builder (Task 4)"))]
    pub(crate) fn columns(&self) -> &[Option<Oid>] {
        &self.columns
    }

    /// Places `oid` and returns its column and the row's edges, sorted.
    pub(crate) fn next(&mut self, oid: Oid, parents: &[Oid]) -> (u32, Vec<GraphEdge>) {
        let mut edges = Vec::new();
        let lane = self.place(oid, parents, Some(&mut edges));
        edges.sort();
        (lane, edges)
    }

    /// Places `oid` like [`Self::next`] and returns only its column, without
    /// building edges.
    #[cfg_attr(not(test), expect(dead_code, reason = "used by the builder (Task 4)"))]
    pub(crate) fn advance(&mut self, oid: Oid, parents: &[Oid]) -> u32 {
        self.place(oid, parents, None)
    }

    /// The one state transition behind `next` and `advance`; edges go to
    /// `edges` when given, unsorted.
    fn place(&mut self, oid: Oid, parents: &[Oid], mut edges: Option<&mut Vec<GraphEdge>>) -> u32 {
        let mut push = |e: GraphEdge| {
            if let Some(edges) = edges.as_deref_mut() {
                edges.push(e);
            }
        };

        // 1. One scan before anything moves: every column expecting this
        //    commit joins the dot and is freed, the first of them holding the
        //    dot; every column waiting for another commit passes straight
        //    through, since the steps below never free or move it.
        let mut expecting = None;
        for (k, column) in self.columns.iter_mut().enumerate() {
            match *column {
                Some(expected) if expected == oid => {
                    expecting.get_or_insert(k);
                    *column = None;
                    push(edge(Some(k), None));
                }
                Some(_) => push(edge(Some(k), Some(k))),
                None => {}
            }
        }

        // 2. The dot's column: the first one expecting this commit, else a free one.
        let lane = match expecting {
            Some(k) => k,
            None => self.take_free(),
        };

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
            push(edge(None, Some(k)));
        }

        self.max_columns = self.max_columns.max(to_u32(self.columns.len()));
        while self.columns.last().is_some_and(Option::is_none) {
            self.columns.pop();
        }
        to_u32(lane)
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

    // A column freed by a join in this row is reused by a later parent of
    // the same commit.
    #[test]
    fn should_reuse_a_column_freed_by_the_join_for_a_later_parent_of_the_same_commit() {
        let (m, p, q) = (o(9), o(2), o(1));
        let mut l = LaneLayout::new();
        l.next(o(7), &[m]);
        l.next(o(8), &[m]);
        assert_eq!(
            l.next(m, &[p, q]),
            (
                0,
                vec![
                    e(None, Some(0)),
                    e(None, Some(1)),
                    e(Some(0), None),
                    e(Some(1), None)
                ]
            )
        );
        assert_eq!(l.max_columns(), 2);
    }

    // A hole left in the middle is the first free column handed out, and
    // the columns on either side of it keep passing through.
    #[test]
    fn should_fill_a_free_column_in_the_middle_before_opening_a_new_one() {
        let mut l = LaneLayout::new();
        l.next(o(7), &[o(1)]);
        l.next(o(8), &[o(2)]);
        l.next(o(9), &[o(3)]);
        l.next(o(2), &[]);
        assert_eq!(
            l.next(o(6), &[o(4)]),
            (
                1,
                vec![e(None, Some(1)), e(Some(0), Some(0)), e(Some(2), Some(2))]
            )
        );
        assert_eq!(l.max_columns(), 3);
    }

    // A later parent that is expected by a column further left than a free
    // one joins that column rather than taking the free column.
    #[test]
    fn should_join_the_expecting_column_for_a_later_parent_even_when_a_free_column_exists() {
        let mut l = LaneLayout::new();
        l.next(o(7), &[o(1)]);
        l.next(o(8), &[o(2)]);
        l.next(o(9), &[o(3)]);
        l.next(o(2), &[]);
        let (lane, edges) = l.next(o(6), &[o(4), o(3)]);
        assert_eq!(
            (lane, edges),
            (
                1,
                vec![
                    e(None, Some(1)),
                    e(None, Some(2)),
                    e(Some(0), Some(0)),
                    e(Some(2), Some(2))
                ]
            )
        );
    }

    // The dot takes the first of several columns expecting it, and every
    // one of them is closed, none passes through.
    #[test]
    fn should_place_the_dot_in_the_first_expecting_column_when_three_columns_expect_it() {
        let mut l = LaneLayout::new();
        l.next(o(7), &[o(1)]);
        l.next(o(8), &[o(1)]);
        l.next(o(9), &[o(1)]);
        assert_eq!(
            l.next(o(1), &[]),
            (
                0,
                vec![e(Some(0), None), e(Some(1), None), e(Some(2), None)]
            )
        );
        assert_eq!(l.columns.len(), 0);
    }

    // A commit that nothing expects, in the middle of other lines, takes
    // the first free column and is never reported as a pass-through itself.
    #[test]
    fn should_open_a_new_last_column_when_every_existing_column_is_busy_and_unrelated() {
        let mut l = LaneLayout::new();
        l.next(o(7), &[o(1)]);
        l.next(o(8), &[o(2)]);
        assert_eq!(
            l.next(o(9), &[o(3)]),
            (
                2,
                vec![e(None, Some(2)), e(Some(0), Some(0)), e(Some(1), Some(1))]
            )
        );
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

    #[test]
    fn advance_returns_the_same_lane_as_next_for_the_same_sequence() {
        let seq = [
            (o(9), vec![o(3), o(2)]),
            (o(3), vec![o(1)]),
            (o(2), vec![o(1)]),
            (o(1), vec![]),
        ];
        let (mut a, mut b) = (LaneLayout::new(), LaneLayout::new());
        for (oid, parents) in &seq {
            assert_eq!(a.advance(*oid, parents), b.next(*oid, parents).0);
            assert_eq!(a.columns(), b.columns());
        }
        assert_eq!(a.max_columns(), b.max_columns());
    }

    #[test]
    fn replay_from_a_checkpoint_equals_a_straight_run() {
        let seq = [
            (o(9), vec![o(3), o(2)]),
            (o(3), vec![o(1)]),
            (o(2), vec![o(1)]),
            (o(1), vec![]),
        ];
        let mut straight = LaneLayout::new();
        let mut expected = Vec::new();
        for (oid, parents) in &seq {
            expected.push(straight.next(*oid, parents));
        }
        let mut head = LaneLayout::new();
        head.advance(seq[0].0, &seq[0].1);
        let mut replay = LaneLayout::from_columns(head.columns().to_vec());
        let got: Vec<_> = seq[1..]
            .iter()
            .map(|(oid, p)| replay.next(*oid, p))
            .collect();
        assert_eq!(got, expected[1..]);
    }

    #[test]
    fn from_columns_counts_the_seed_width_in_max_columns() {
        assert_eq!(
            LaneLayout::from_columns(vec![Some(o(1)), None, Some(o(2))]).max_columns(),
            3
        );
    }

    #[test]
    fn next_with_a_filtered_parent_list_draws_no_edge_for_the_omitted_parent() {
        let mut l = LaneLayout::new();
        // commit 5 has parents [1, 2] but 2 is omitted by the caller: only one bottom edge.
        assert_eq!(l.next(o(5), &[o(1)]), (0, vec![e(None, Some(0))]));
    }
}
