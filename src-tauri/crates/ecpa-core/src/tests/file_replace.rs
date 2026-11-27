use super::support::*;
use super::*;
use std::os::windows::fs::OpenOptionsExt;
use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};

fn lock_against_replacement(path: &Path) -> File {
    File::options()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .open(path)
        .unwrap()
}

fn release_lock_soon(file: File) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(200));
        drop(file);
    })
}

#[test]
fn windows_file_replace_retries_transient_errors_including_1175() {
    let mut errors = [1175, 32, 5, 33].into_iter();
    let mut waits = Vec::new();
    let mut attempts = 0;
    retry_windows_file_replace(
        || {
            attempts += 1;
            match errors.next() {
                Some(code) => Err(io::Error::from_raw_os_error(code)),
                None => Ok(()),
            }
        },
        |delay| waits.push(delay.as_millis()),
    )
    .unwrap();

    assert_eq!(attempts, 5);
    assert_eq!(waits, [50, 100, 200, 400]);
}

#[test]
fn windows_file_replace_stops_retrying_and_preserves_the_last_os_error() {
    let mut attempts = 0;
    let mut waits = Vec::new();
    let error = retry_windows_file_replace(
        || {
            attempts += 1;
            Err(io::Error::from_raw_os_error(if attempts < 6 {
                32
            } else {
                1175
            }))
        },
        |delay| waits.push(delay.as_millis()),
    )
    .unwrap_err();

    assert_eq!(error.raw_os_error(), Some(1175));
    assert_eq!(attempts, 6);
    assert_eq!(waits, [50, 100, 200, 400, 800]);
}

#[test]
fn windows_file_replace_does_not_retry_permanent_or_partial_replacement_errors() {
    for code in [2, 3, 87, 112, 1176, 1177] {
        let mut attempts = 0;
        let error = retry_windows_file_replace(
            || {
                attempts += 1;
                Err(io::Error::from_raw_os_error(code))
            },
            |_| panic!("unexpected retry for Windows error {code}"),
        )
        .unwrap_err();

        assert_eq!(error.raw_os_error(), Some(code));
        assert_eq!(attempts, 1);
    }
}

#[test]
fn core_file_replace_succeeds_after_a_temporary_target_lock_is_released() {
    let root = agent_test_home("core-replace-transient-lock");
    for name in [CORE_CONFIG_FILE, CORE_METADATA_FILE] {
        let target = root.join(name);
        let source = root.join(format!("{name}.new"));
        fs::write(&target, b"old content").unwrap();
        fs::write(&source, b"new content").unwrap();
        let release = release_lock_soon(lock_against_replacement(&target));

        let result = copy_core_file_replace(&source, &target);
        release.join().unwrap();

        result.unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new content");
        assert_eq!(fs::read(&source).unwrap(), b"new content");
    }
    assert_eq!(fs::read_dir(&root).unwrap().count(), 4);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn atomic_replace_retries_a_locked_temporary_file_for_existing_and_new_targets() {
    let root = agent_test_home("atomic-replace-source-lock");
    for existing in [false, true] {
        let target = root.join(format!("target-{existing}.json"));
        let temporary = root.join(format!("temporary-{existing}.json"));
        if existing {
            fs::write(&target, b"old content").unwrap();
        }
        fs::write(&temporary, b"new content").unwrap();
        let release = release_lock_soon(lock_against_replacement(&temporary));

        let result = replace_file_atomically(&temporary, &target);
        release.join().unwrap();

        result.unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new content");
        assert!(!temporary.exists());
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn atomic_config_write_retries_a_temporary_lock_and_records_the_successful_write() {
    let root = agent_test_home("config-write-transient-lock");
    let target = root.join(CORE_CONFIG_FILE);
    fs::write(&target, b"port: 8317\n").unwrap();
    let release = release_lock_soon(lock_against_replacement(&target));

    let result = write_bytes_atomically(&target, b"port: 8318\n");
    release.join().unwrap();

    result.unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"port: 8318\n");
    assert!(consume_software_write(&target));
    assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn persistent_locks_preserve_original_files_and_clean_up_failed_write_temporary_files() {
    let root = agent_test_home("file-replace-persistent-lock");
    let source = root.join("source.json");
    fs::write(&source, b"new content").unwrap();

    for core_file in [false, true] {
        let target = root.join(if core_file {
            CORE_METADATA_FILE
        } else {
            CORE_CONFIG_FILE
        });
        fs::write(&target, b"old content").unwrap();
        let lock = lock_against_replacement(&target);
        let result = if core_file {
            copy_core_file_replace(&source, &target)
        } else {
            write_bytes_atomically(&target, b"new content")
        };
        drop(lock);

        let error = result.unwrap_err();
        assert!(error.contains("os error 32"), "{error}");
        assert_eq!(fs::read(&target).unwrap(), b"old content");
        assert_eq!(fs::read(&source).unwrap(), b"new content");
        assert!(!consume_software_write(&target));
    }
    assert_eq!(fs::read_dir(&root).unwrap().count(), 3);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_missing_replacement_file_leaves_the_original_intact() {
    let root = agent_test_home("file-replace-missing-source");
    let target = root.join(CORE_METADATA_FILE);
    fs::write(&target, b"old content").unwrap();

    let error = replace_file_atomically(&root.join("missing.json"), &target).unwrap_err();

    assert_eq!(error.kind(), io::ErrorKind::NotFound);
    assert_eq!(fs::read(&target).unwrap(), b"old content");
    fs::remove_dir_all(root).unwrap();
}
