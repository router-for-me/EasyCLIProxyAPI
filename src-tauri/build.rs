fn main() {
    println!("cargo:rerun-if-env-changed=GITCODE_GUI_REPOSITORY");
    println!("cargo:rerun-if-env-changed=GITCODE_CORE_REPOSITORY");
    println!("cargo:rerun-if-env-changed=ECPA_RELEASE_FAMILY");
    println!("cargo:rerun-if-env-changed=ECPA_STABLE_SERIES_VERSION");
    println!("cargo:rerun-if-env-changed=ECPA_PREVIEW_SERIES_VERSION");
    tauri_build::build()
}
