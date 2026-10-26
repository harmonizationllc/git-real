//! Resident set size of this process (Linux: `/proc/self/status`).

/// The `VmRSS` line of a `/proc/<pid>/status` text, kB converted to MB
/// (integer division by 1024). `None` when the line is absent or malformed.
pub fn parse_vm_rss(status: &str) -> Option<u64> {
    todo!()
}

/// Current resident set size in MB; `None` when unreadable.
pub fn current_rss_mb() -> Option<u64> {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    const STATUS: &str = "Name:\tgit-real-bench\nVmPeak:\t  200000 kB\nVmSize:\t  190000 kB\nVmRSS:\t  172032 kB\nRssAnon:\t  100000 kB\nThreads:\t4\n";

    // parse_vm_rss: pure parsing of the VmRSS line.
    #[test]
    fn parses_vm_rss_kb_to_mb() {
        assert_eq!(parse_vm_rss(STATUS), Some(168));
    }

    #[test]
    fn none_without_vm_rss_line() {
        assert_eq!(parse_vm_rss("Name:\tx\nVmSize:\t 10 kB\n"), None);
    }

    #[test]
    fn none_on_malformed_number() {
        assert_eq!(parse_vm_rss("VmRSS:\t  lots kB\n"), None);
    }

    #[test]
    fn none_on_empty_text() {
        assert_eq!(parse_vm_rss(""), None);
    }

    #[test]
    fn ignores_other_fields_that_merely_contain_rss() {
        assert_eq!(parse_vm_rss("RssAnon:\t  2048 kB\n"), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn current_rss_is_some_on_linux() {
        assert!(current_rss_mb().is_some());
    }
}
