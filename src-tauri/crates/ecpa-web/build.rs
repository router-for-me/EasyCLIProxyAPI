use std::{env, fs, path::PathBuf};

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let repo_dist = manifest_dir.join("..").join("..").join("..").join("dist");
    println!("cargo:rerun-if-changed={}", repo_dist.display());
    println!(
        "cargo:rerun-if-changed={}",
        repo_dist.join("index.html").display()
    );

    let embed_dir = if repo_dist.is_dir() {
        repo_dist
    } else {
        let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
        let placeholder = out_dir.join("empty-dist");
        let _ = fs::create_dir_all(&placeholder);
        placeholder
    };
    println!("cargo:rustc-env=ECPA_WEB_DIST_DIR={}", embed_dir.display());
}
