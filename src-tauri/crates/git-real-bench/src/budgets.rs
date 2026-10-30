//! The three constant budgets and their evaluation.

use std::fmt;

use crate::measure::Measurement;

pub const OPEN_TO_FIRST_PAGE_MS: u128 = 3_000; // AC 2
pub const STATUS_MS: u128 = 1_500; // AC 3, raised from 500 on 2026-10-30 (GR-32 spec §6.3): CI runner timing
pub const PAGING_RSS_GROWTH_MB: u64 = 64; // AC 5

/// One exceeded budget. `metric` is the JSON key: `openToFirstPageMs`, `statusMs`
/// or `rssGrowthMb`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Violation {
    pub label: String,
    pub metric: &'static str,
    pub value: u128,
    pub budget: u128,
}

/// `<label>: <metric> <value> exceeds <budget>`
impl fmt::Display for Violation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}: {} {} exceeds {}",
            self.label, self.metric, self.value, self.budget
        )
    }
}

/// One `Violation` per exceeded budget, in the order open-to-first-page, status,
/// RSS growth. A value equal to its budget is not a violation; `None` metrics are skipped.
pub fn evaluate(m: &Measurement) -> Vec<Violation> {
    let checks = [
        (
            "openToFirstPageMs",
            Some(m.open_to_first_page_ms),
            OPEN_TO_FIRST_PAGE_MS,
        ),
        ("statusMs", m.status_ms, STATUS_MS),
        (
            "rssGrowthMb",
            m.rss_growth_mb.map(u128::from),
            u128::from(PAGING_RSS_GROWTH_MB),
        ),
    ];
    checks
        .into_iter()
        .filter_map(|(metric, value, budget)| {
            let value = value.filter(|v| *v > budget)?;
            Some(Violation {
                label: m.label.clone(),
                metric,
                value,
                budget,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::sample_measurement;

    fn metrics(m: &Measurement) -> Vec<&'static str> {
        evaluate(m).iter().map(|v| v.metric).collect()
    }

    // Budget constants are the ticket's acceptance numbers.
    #[test]
    fn budget_constants_match_the_acceptance_criteria() {
        assert_eq!(
            (OPEN_TO_FIRST_PAGE_MS, STATUS_MS, PAGING_RSS_GROWTH_MB),
            (3_000, 1_500, 64)
        );
    }

    // evaluate: positive (within budget) and negative (over budget) cases.
    #[test]
    fn no_violation_under_budget() {
        assert!(evaluate(&sample_measurement("synthetic")).is_empty());
    }

    #[test]
    fn exactly_at_every_budget_is_not_a_violation() {
        let mut m = sample_measurement("synthetic");
        m.open_to_first_page_ms = 3_000;
        m.status_ms = Some(500);
        m.rss_growth_mb = Some(64);
        assert!(evaluate(&m).is_empty());
    }

    #[test]
    fn open_to_first_page_over_budget() {
        let mut m = sample_measurement("synthetic");
        m.open_to_first_page_ms = 3_001;
        assert_eq!(metrics(&m), vec!["openToFirstPageMs"]);
    }

    #[test]
    fn status_over_budget() {
        let mut m = sample_measurement("synthetic");
        m.status_ms = Some(1_501);
        assert_eq!(metrics(&m), vec!["statusMs"]);
    }

    #[test]
    fn rss_growth_over_budget() {
        let mut m = sample_measurement("synthetic");
        m.rss_growth_mb = Some(65);
        assert_eq!(metrics(&m), vec!["rssGrowthMb"]);
    }

    #[test]
    fn all_three_violations_in_order() {
        let mut m = sample_measurement("synthetic");
        m.open_to_first_page_ms = 4_000;
        m.status_ms = Some(1_900);
        m.rss_growth_mb = Some(80);
        assert_eq!(
            metrics(&m),
            vec!["openToFirstPageMs", "statusMs", "rssGrowthMb"]
        );
    }

    #[test]
    fn status_skipped_when_none() {
        let mut m = sample_measurement("qemu-graph");
        m.status_ms = None;
        assert!(evaluate(&m).is_empty());
    }

    #[test]
    fn rss_skipped_when_none() {
        let mut m = sample_measurement("synthetic");
        m.rss_growth_mb = None;
        assert!(evaluate(&m).is_empty());
    }

    #[test]
    fn violation_carries_value_and_budget() {
        let mut m = sample_measurement("synthetic");
        m.open_to_first_page_ms = 3_412;
        let v = &evaluate(&m)[0];
        assert_eq!((v.value, v.budget), (3_412, 3_000));
    }

    #[test]
    fn violation_message_shape() {
        let mut m = sample_measurement("synthetic");
        m.open_to_first_page_ms = 3_412;
        assert_eq!(
            evaluate(&m)[0].to_string(),
            "synthetic: openToFirstPageMs 3412 exceeds 3000"
        );
    }

    #[test]
    fn rss_violation_message_shape() {
        let mut m = sample_measurement("qemu-graph");
        m.rss_growth_mb = Some(80);
        assert_eq!(
            evaluate(&m)[0].to_string(),
            "qemu-graph: rssGrowthMb 80 exceeds 64"
        );
    }
}
