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
