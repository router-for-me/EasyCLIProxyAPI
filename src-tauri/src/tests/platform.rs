use super::*;

#[cfg(target_os = "windows")]
#[test]
fn windows_tray_presentation_tracks_core_state_and_busy_actions() {
    let mut status = CoreStatus {
        installed: false,
        running: false,
        managed: false,
        auto_restart_enabled: false,
        process_id: None,
        current_version: None,
        install_dir: String::new(),
        binary_path: None,
        message: String::new(),
    };

    let missing = windows_tray_presentation(&status, false, "zh-CN");
    assert_eq!(missing.status_text, "内核状态：未安装");
    assert!(!missing.toggle_enabled);
    assert!(!missing.restart_enabled);

    status.installed = true;
    let stopped = windows_tray_presentation(&status, false, "zh-CN");
    assert_eq!(stopped.toggle_text, "启动内核");
    assert!(stopped.toggle_enabled);
    assert!(!stopped.restart_enabled);

    status.running = true;
    let running = windows_tray_presentation(&status, false, "zh-CN");
    assert_eq!(running.status_text, "内核状态：运行中");
    assert_eq!(running.toggle_text, "停止内核");
    assert!(running.toggle_enabled);
    assert!(running.restart_enabled);

    let busy = windows_tray_presentation(&status, true, "zh-CN");
    assert_eq!(busy.status_text, "内核状态：处理中");
    assert!(!busy.toggle_enabled);
    assert!(!busy.restart_enabled);

    let english = windows_tray_presentation(&status, false, "en-US");
    assert_eq!(english.status_text, "Core status: Running");
    assert_eq!(english.toggle_text, "Stop Core");

    let japanese = windows_tray_presentation(&status, false, "ja-JP");
    assert_eq!(japanese.status_text, "コア状態：実行中");
    assert_eq!(japanese.toggle_text, "コアを停止");
}

#[test]
fn app_locale_normalization_has_a_stable_chinese_fallback() {
    assert_eq!(normalize_app_locale("en"), "en");
    assert_eq!(normalize_app_locale("en-US"), "en");
    assert_eq!(normalize_app_locale("ja-JP"), "ja");
    assert_eq!(normalize_app_locale("zh-TW"), "zh-TW");
    assert_eq!(normalize_app_locale("zh-Hant-HK"), "zh-TW");
    assert_eq!(normalize_app_locale("unsupported"), "zh-CN");
    assert_eq!(GuiConfigFile::default().locale, "zh-CN");
}

#[cfg(target_os = "windows")]
#[test]
fn windows_chatgpt_discovery_parser_accepts_registered_app_and_executable() {
    let app = parse_windows_codex_app_discovery_output("APPID:OpenAI.Codex_2p2nqsd0c76g0!App\r\n")
        .unwrap();
    match app {
        CodexAppTarget::WindowsAppId(app_id) => {
            assert_eq!(app_id, "OpenAI.Codex_2p2nqsd0c76g0!App");
        }
        CodexAppTarget::Application(_) => panic!("expected Store application ID"),
    }

    let executable = parse_windows_codex_app_discovery_output(
        "warning\r\nEXE:C:\\Program Files\\OpenAI\\ChatGPT\\ChatGPT.exe\r\n",
    )
    .unwrap();
    match executable {
        CodexAppTarget::Application(path) => {
            assert_eq!(
                path,
                PathBuf::from(r"C:\Program Files\OpenAI\ChatGPT\ChatGPT.exe")
            );
        }
        CodexAppTarget::WindowsAppId(_) => panic!("expected desktop executable"),
    }

    assert!(parse_windows_codex_app_discovery_output("MSEdgePWA:ChatGPT\r\n").is_none());

    let registry_output = r"HKEY_CURRENT_USER\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages\OpenAI.Codex_26.715.4045.0_x64__2p2nqsd0c76g0";
    assert_eq!(
        parse_windows_codex_app_id_from_registry(registry_output).as_deref(),
        Some("OpenAI.Codex_2p2nqsd0c76g0!App")
    );
    assert_eq!(
        windows_codex_app_id_from_package_full_name("OpenAI.ChatGPT_1.2.3.4_arm64__2p2nqsd0c76g0")
            .as_deref(),
        Some("OpenAI.ChatGPT_2p2nqsd0c76g0!App")
    );
    assert!(windows_codex_app_id_from_package_full_name(
        "Microsoft.MicrosoftEdge_1.0.0.0_x64__8wekyb3d8bbwe"
    )
    .is_none());
}
