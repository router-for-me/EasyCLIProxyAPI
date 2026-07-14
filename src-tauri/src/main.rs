#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[tauri::command]
fn health_check() -> &'static str {
    "CPA GUI Rust backend is ready"
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![health_check])
        .run(tauri::generate_context!())
        .expect("failed to run app");
}
