use crate::launch_navigation::{
    forward_to_running_instance, parse_launch_page_argument, request_file_path, sanitize_page,
    take_forwarded_request,
};
use std::ffi::OsString;

fn args(list: &[&str]) -> Vec<OsString> {
    list.iter().map(OsString::from).collect()
}

#[test]
fn parses_page_argument_in_both_forms() {
    assert_eq!(
        parse_launch_page_argument(args(&["app", "--page", "quota"])),
        Some("quota".into())
    );
    assert_eq!(
        parse_launch_page_argument(args(&["app", "--page=oauth/quota"])),
        Some("oauth/quota".into())
    );
    assert_eq!(parse_launch_page_argument(args(&["app"])), None);
    assert_eq!(parse_launch_page_argument(args(&["app", "--page"])), None);
}

#[test]
fn rejects_unsafe_or_oversized_values() {
    assert_eq!(sanitize_page("  home "), Some("home".into()));
    assert_eq!(sanitize_page("usage-records"), Some("usage-records".into()));
    assert_eq!(sanitize_page(""), None);
    assert_eq!(sanitize_page("quota; rm -rf"), None);
    assert_eq!(sanitize_page(&"a".repeat(65)), None);
}

#[test]
fn forwarded_request_round_trips_and_is_consumed_once() {
    let dir = std::env::temp_dir().join(format!(
        "easycliproxyapi-launch-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    forward_to_running_instance(&dir, "oauth/quota").unwrap();
    assert!(request_file_path(&dir).exists());
    assert_eq!(take_forwarded_request(&dir), Some("oauth/quota".into()));
    assert_eq!(take_forwarded_request(&dir), None);
    let _ = std::fs::remove_dir_all(&dir);
}
