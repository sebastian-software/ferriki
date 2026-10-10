use std::env;

fn main() {
    println!("cargo:rerun-if-env-changed=RUSTFLAGS");
    println!("cargo:rerun-if-env-changed=CARGO_ENCODED_RUSTFLAGS");
    let flags = env::var("CARGO_ENCODED_RUSTFLAGS")
        .or_else(|_| env::var("RUSTFLAGS"))
        .unwrap_or_else(|_| "<unset>".to_owned())
        .replace('\n', " ")
        .replace('\r', " ");
    println!("cargo:rustc-env=BENCHMARK_RUSTFLAGS={flags}");
    println!(
        "cargo:rustc-env=BENCHMARK_TARGET={}",
        env::var("TARGET").unwrap_or_else(|_| "unknown target".to_owned())
    );
}
