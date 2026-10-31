fn main() {
    println!("cargo:rerun-if-env-changed=GITCODE_GUI_REPOSITORY");
    println!("cargo:rerun-if-env-changed=GITCODE_CORE_REPOSITORY");
    tauri_build::build()
}
