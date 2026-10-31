//! In-memory topological order over rows discovered by a date-ordered walk.

use std::cmp::Reverse;
use std::collections::BinaryHeap;

/// The rows in topological order, children before parents.
///
/// `parents[i]` holds the indices of row `i`'s parents and `times[i]` its
/// committer time; `i` is the discovery sequence. Among rows whose children
/// are all emitted, the newest committer time goes first, and ties go to the
/// earlier discovered row. Returns a permutation of `0..n` (Kahn's algorithm).
pub(crate) fn topo_order(parents: &[Vec<u32>], times: &[i64]) -> Vec<u32> {
    let n = parents.len();
    let mut children_left = vec![0u32; n];
    for row_parents in parents {
        for &p in row_parents {
            children_left[p as usize] += 1;
        }
    }
    let mut ready: BinaryHeap<(i64, Reverse<u32>)> = (0..n)
        .filter(|&i| children_left[i] == 0)
        .map(|i| (times[i], Reverse(index(i))))
        .collect();
    let mut order = Vec::with_capacity(n);
    while let Some((_, Reverse(i))) = ready.pop() {
        order.push(i);
        for &p in &parents[i as usize] {
            let left = &mut children_left[p as usize];
            *left -= 1;
            if *left == 0 {
                ready.push((times[p as usize], Reverse(p)));
            }
        }
    }
    order
}

fn index(i: usize) -> u32 {
    u32::try_from(i).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn topo_linear_history_is_child_first() {
        // 0 <- 1 <- 2 discovered newest first: parents = [[1],[2],[]], times = [30,20,10]
        assert_eq!(
            topo_order(&[vec![1], vec![2], vec![]], &[30, 20, 10]),
            vec![0, 1, 2]
        );
    }

    #[test]
    fn topo_puts_child_before_parent_when_parent_is_dated_newer() {
        // child 0 (time 10) -> parent 1 (time 50)
        assert_eq!(topo_order(&[vec![1], vec![]], &[10, 50]), vec![0, 1]);
    }

    #[test]
    fn topo_emits_newest_ready_commit_first() {
        // two roots-less tips 0 (time 10) and 1 (time 20) sharing parent 2
        assert_eq!(
            topo_order(&[vec![2], vec![2], vec![]], &[10, 20, 5]),
            vec![1, 0, 2]
        );
    }

    #[test]
    fn topo_breaks_ties_by_discovery_order() {
        assert_eq!(
            topo_order(&[vec![2], vec![2], vec![]], &[10, 10, 5]),
            vec![0, 1, 2]
        );
    }

    #[test]
    fn topo_is_deterministic_with_equal_times() {
        let parents = vec![vec![3], vec![3], vec![3], vec![]];
        let times = [7, 7, 7, 1];
        assert_eq!(topo_order(&parents, &times), topo_order(&parents, &times));
        assert_eq!(topo_order(&parents, &times), vec![0, 1, 2, 3]);
    }

    #[test]
    fn topo_octopus_merge_waits_for_every_child() {
        // merge 0 -> 1,2,3 ; 1,2,3 -> 4
        assert_eq!(
            topo_order(
                &[vec![1, 2, 3], vec![4], vec![4], vec![4], vec![]],
                &[50, 40, 45, 30, 1]
            ),
            vec![0, 2, 1, 3, 4]
        );
    }

    #[test]
    fn topo_handles_disconnected_roots() {
        assert_eq!(topo_order(&[vec![], vec![]], &[5, 9]), vec![1, 0]);
    }

    #[test]
    fn topo_of_empty_input_is_empty() {
        assert!(topo_order(&[], &[]).is_empty());
    }
}
