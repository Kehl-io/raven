use raven_lib::test_server::{serve, TestServerOptions};
use std::path::PathBuf;

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let mut db_path = None;
    let mut port = None;
    let mut deterministic = false;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => {
                db_path = Some(PathBuf::from(
                    args.next()
                        .ok_or_else(|| "--db requires a path".to_string())?,
                ));
            }
            "--port" => {
                let value = args
                    .next()
                    .ok_or_else(|| "--port requires a value".to_string())?;
                port = Some(
                    value
                        .parse::<u16>()
                        .map_err(|error| format!("invalid --port value: {error}"))?,
                );
            }
            "--deterministic" => deterministic = true,
            "--help" | "-h" => {
                print_usage();
                return Ok(());
            }
            other => return Err(format!("unknown argument {other}")),
        }
    }

    let db_path = db_path.ok_or_else(|| "--db is required".to_string())?;
    let port = port.ok_or_else(|| "--port is required".to_string())?;

    serve(TestServerOptions {
        db_path,
        port,
        deterministic,
    })
}

fn print_usage() {
    println!("raven-test-server --db <path> --port <port> [--deterministic]");
}
