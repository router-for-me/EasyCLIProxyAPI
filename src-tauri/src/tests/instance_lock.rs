use super::support::*;
use super::*;

#[test]
fn app_instance_keys_are_stable_and_directory_scoped() {
    let first = agent_test_home("instance-key-first");
    let second = agent_test_home("instance-key-second");

    assert_eq!(app_instance_key(&first), app_instance_key(&first));
    assert_ne!(app_instance_key(&first), app_instance_key(&second));

    fs::remove_dir_all(first).unwrap();
    fs::remove_dir_all(second).unwrap();
}

#[test]
fn app_instance_guard_rejects_a_second_copy_and_releases_on_drop() {
    let root = agent_test_home("instance-lock");
    let first = acquire_app_instance_guard_for(&root).unwrap();

    let duplicate = acquire_app_instance_guard_for(&root);
    assert!(duplicate.is_err());

    drop(first);
    assert!(acquire_app_instance_guard_for(&root).is_ok());
    fs::remove_dir_all(root).unwrap();
}

#[cfg(target_os = "linux")]
#[test]
fn a_second_launch_asks_the_running_copy_to_show_its_window() {
    let root = agent_test_home("instance-activation");
    let _guard = acquire_app_instance_guard_for(&root).unwrap();
    let (sender, receiver) = std::sync::mpsc::channel();
    start_app_activation_listener_for(&root, move || {
        let _ = sender.send(());
    })
    .unwrap();

    assert!(request_running_app_activation_for(&root, 1));
    receiver
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("the running copy was not asked to show its window");

    let _ = fs::remove_file(app_activation_socket_path(&root));
    fs::remove_dir_all(root).unwrap();
}

#[cfg(target_os = "linux")]
#[test]
fn a_new_lock_holder_replaces_the_socket_left_by_an_exited_copy() {
    let root = agent_test_home("instance-activation-stale");
    let socket_path = app_activation_socket_path(&root);
    drop(std::os::unix::net::UnixListener::bind(&socket_path).unwrap());
    assert!(!request_running_app_activation_for(&root, 1));

    let (sender, receiver) = std::sync::mpsc::channel();
    start_app_activation_listener_for(&root, move || {
        let _ = sender.send(());
    })
    .unwrap();

    assert!(request_running_app_activation_for(&root, 1));
    receiver
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("the new lock holder did not receive the activation request");

    let _ = fs::remove_file(socket_path);
    fs::remove_dir_all(root).unwrap();
}
