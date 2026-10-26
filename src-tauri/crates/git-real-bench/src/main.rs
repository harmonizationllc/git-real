mod app;
mod budgets;
mod cli;
mod fixtures;
mod git;
mod measure;
mod report;
mod rss;
#[cfg(test)]
mod test_support;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = app::run(&args, &mut std::io::stdout(), &mut std::io::stderr());
    std::process::exit(code)
}
