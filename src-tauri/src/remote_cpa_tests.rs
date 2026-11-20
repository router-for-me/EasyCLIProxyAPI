use super::*;
use reqwest::Method;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

const KEY: &str = "fixture-management-key";
const ETAG: &str = "\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"";

#[test]
fn validates_endpoint_base_and_accepts_http_and_https() {
    for (input, expected) in [
        (" http://127.0.0.1:8317 ", "http://127.0.0.1:8317/"),
        ("http://localhost:8317", "http://localhost:8317/"),
        ("http://[::1]:8317", "http://[::1]:8317/"),
        ("http://[fd12::1]/cpa", "http://[fd12::1]/cpa/"),
        ("http://192.168.2.5/cpa/", "http://192.168.2.5/cpa/"),
        (
            "https://CPA.example.com/cpa_A/~edge",
            "https://cpa.example.com/cpa_A/~edge/",
        ),
    ] {
        assert_eq!(parse_endpoint(input).unwrap().as_str(), expected);
    }
    for input in [
        "http://cpa.lan",
        "http://example.com",
        "http://8.8.8.8",
        "http://169.254.169.254",
        "http://[2001:db8::1]/cpa",
    ] {
        assert_eq!(parse_endpoint(input).unwrap().as_str(), format!("{input}/"));
    }
    for input in [
        "ftp://127.0.0.1",
        "http:127.0.0.1",
        "https:///example.com",
        "https://",
        "https://example.com:0",
        "https://user:pass@example.com",
        "https://example.com?a=key",
        "https://example.com/#key",
        "https://example.com//",
        "https://example.com/cpa//core",
        "https://example.com/cpa/../core",
        "https://example.com/cpa/%2e%2e",
        "https://example.com/cpa\\core",
        "https://example.com/cpa/v8/management/",
        "http://0.0.0.0",
    ] {
        assert_eq!(
            parse_endpoint(input).unwrap_err(),
            RemoteError::InvalidEndpoint,
            "{input}"
        );
    }
    assert!(matches!(
        Target::new("http://localhost", "key\r\nforged"),
        Err(RemoteError::InvalidKey)
    ));
    assert!(matches!(
        Target::new("http://localhost", " "),
        Err(RemoteError::KeyRequired)
    ));
}

struct TestDir(PathBuf);
impl TestDir {
    fn new() -> Self {
        let path = crate::unique_test_temp_path("ecpa-remote-test");
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn profile_switch_keeps_local_files_unmodified_and_never_exports_its_key() {
    let directory = TestDir::new();
    let path = directory.0.join(PROFILE_FILE);
    let local_file = directory.0.join("config.toml");
    fs::write(&local_file, "local setting sentinel").unwrap();
    let local = RemoteCpaState::from_path(Some(path.clone()));
    assert!(!local.remote_launch);
    let mut selection = local.selection.lock().await;
    let chosen = local
        .persist(
            &mut selection,
            Profile::Remote {
                endpoint: "http://127.0.0.1:9999/".into(),
                key: KEY.into(),
            },
        )
        .unwrap();
    assert!(!chosen.remote_active && chosen.remote_selected);
    assert!(!serde_json::to_string(&chosen).unwrap().contains(KEY));
    assert!(matches!(
        current_target(local.remote_launch, &selection, chosen.revision),
        Err(RemoteError::NotActive)
    ));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    let remote = RemoteCpaState::from_path(Some(path.clone()));
    assert!(remote.remote_launch);
    let mut selection = remote.selection.lock().await;
    assert!(candidate(&selection, "http://127.0.0.1:9999".into(), "".into()).is_ok());
    for changed in [
        "http://127.0.0.1:9998",
        "http://127.0.0.1:9999/new",
        "https://127.0.0.1:9999",
    ] {
        assert!(matches!(
            candidate(&selection, changed.into(), "".into()),
            Err(RemoteError::KeyRequired)
        ));
    }
    selection.keys_etag = Some((1, header::HeaderValue::from_static(ETAG)));
    let active_revision = selection.revision;
    assert!(remote.selection.try_lock().is_err());
    remote
        .persist(
            &mut selection,
            Profile::Remote {
                endpoint: "http://127.0.0.1:9998/".into(),
                key: "second-key".into(),
            },
        )
        .unwrap();
    assert!(matches!(
        current_target(true, &selection, active_revision),
        Err(RemoteError::EndpointChanged)
    ));
    assert!(selection.keys_etag.is_none());
    let active = current_target(true, &selection, selection.revision).unwrap();
    assert_eq!(active.endpoint.port(), Some(9998));
    assert_eq!(active.auth, "Bearer second-key");
    let restored = remote.persist(&mut selection, Profile::Local).unwrap();
    assert_eq!(restored.endpoint, None);
    assert!(!restored.remote_selected && restored.remote_active);
    assert!(!fs::read_to_string(&path).unwrap().contains("second-key"));
    assert!(!RemoteCpaState::from_path(Some(path.clone())).remote_launch);
    assert_eq!(
        fs::read_to_string(local_file).unwrap(),
        "local setting sentinel"
    );
    fs::write(&path, "unable to parse").unwrap();
    let corrupt = RemoteCpaState::from_path(Some(path));
    assert!(corrupt.remote_launch);
    assert!(corrupt.view(&*corrupt.selection.lock().await).needs_repair);
}

async fn receive(tcp: &mut TcpStream) -> (String, String) {
    let mut buf = Vec::new();
    let header_end = loop {
        let mut bytes = [0; 1024];
        let count = tcp.read(&mut bytes).await.unwrap();
        assert_ne!(count, 0);
        buf.extend_from_slice(&bytes[..count]);
        if let Some(i) = buf.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
            break i + 4;
        }
        assert!(buf.len() < 16384);
    };
    let headers = std::str::from_utf8(&buf[..header_end]).unwrap().to_owned();
    let len = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().unwrap())
        })
        .unwrap_or(0);
    while buf.len() < header_end + len {
        let mut bytes = [0; 1024];
        let count = tcp.read(&mut bytes).await.unwrap();
        assert_ne!(count, 0);
        buf.extend_from_slice(&bytes[..count]);
    }
    (
        headers,
        std::str::from_utf8(&buf[header_end..header_end + len])
            .unwrap()
            .to_owned(),
    )
}

async fn send(tcp: &mut TcpStream, status: &str, other_headers: &str, body: &str) {
    let response = format!("HTTP/1.1 {status}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{other_headers}\r\n{body}", body.len());
    tcp.write_all(response.as_bytes()).await.unwrap();
}

#[tokio::test]
async fn fixed_v8_routes_use_header_auth_prefix_and_conditional_update() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/edge/cpa", listener.local_addr().unwrap());
    let fixture = tokio::spawn(async move {
        for (method, route, status, body) in [
            ("GET", VERSION_PATH, "200 OK", "8"),
            ("GET", KEYS_PATH, "200 OK", r#"["first-client"]"#),
            (
                "PUT",
                KEYS_PATH,
                "200 OK",
                r#"{"status":"ok","config-version":8}"#,
            ),
            (
                "PUT",
                KEYS_PATH,
                "412 Precondition Failed",
                r#"{"error":"precondition_failed"}"#,
            ),
        ] {
            let (mut tcp, _) = listener.accept().await.unwrap();
            let (headers, request_body) = receive(&mut tcp).await;
            assert_eq!(
                headers.lines().next().unwrap(),
                format!("{method} /edge/cpa/v8/management/{route} HTTP/1.1")
            );
            assert!(headers
                .lines()
                .any(|line| line == format!("authorization: Bearer {KEY}")));
            assert_eq!(headers.matches(KEY).count(), 1);
            if method == "PUT" {
                assert!(headers.contains(&format!("if-match: {ETAG}\r\n")));
                assert_eq!(request_body, r#"["new-client"]"#);
            }
            send(&mut tcp, status, &format!("ETag: {ETAG}\r\n"), body).await;
        }
    });
    let target = Target::new(&url, KEY).unwrap();
    let (keys, etag) = load_keys(&target).await.unwrap();
    assert_eq!(keys, ["first-client"]);
    let new_keys = vec!["new-client".into()];
    save_keys(&target, etag.clone(), &new_keys).await.unwrap();
    assert_eq!(
        save_keys(&target, etag, &new_keys).await,
        Err(RemoteError::Conflict)
    );
    fixture.await.unwrap();
}

#[tokio::test]
async fn remote_errors_are_actionable_and_do_not_reflect_response_or_follow_redirects() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let other = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = listener.local_addr().unwrap();
    let redirect = format!(
        "Location: http://{}/should-not-see-key\r\n",
        other.local_addr().unwrap()
    );
    let fixture = tokio::spawn(async move {
        for (status, headers, body) in [
            ("401 Unauthorized", "".to_owned(), KEY),
            ("307 Temporary Redirect", redirect, KEY),
            ("200 OK", format!("ETag: {ETAG}\r\n"), KEY),
        ] {
            let (mut tcp, _) = listener.accept().await.unwrap();
            receive(&mut tcp).await;
            send(&mut tcp, status, &headers, body).await;
        }
    });
    let target = Target::new(&format!("http://{origin}"), KEY).unwrap();
    let errors = [
        RemoteError::NotAuthorized,
        RemoteError::Redirect,
        RemoteError::InvalidResponse,
    ];
    for error in errors {
        let actual = check_target(&target).await.unwrap_err();
        assert_eq!(actual, error);
        assert!(!serde_json::to_string(&actual).unwrap().contains(KEY));
    }
    fixture.await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(50), other.accept())
            .await
            .is_err()
    );
    assert_eq!(
        check_target(&target).await.unwrap_err(),
        RemoteError::Unreachable
    );
}

#[test]
fn valid_replacements_require_distinct_nonempty_keys() {
    assert_eq!(
        normalize_keys(vec![" new-client ".into()]).unwrap(),
        ["new-client"]
    );
    for keys in [
        vec![],
        vec!["".into()],
        vec!["a".into(), " a ".into()],
        vec!["with space".into()],
    ] {
        assert_eq!(normalize_keys(keys), Err(RemoteError::InvalidKeys));
    }
}

#[tokio::test]
#[ignore = "requires a pinned disposable CPA binary via CPA_V8_TEST_CORE"]
async fn pinned_cpa_accepts_reads_and_conditional_updates_only_on_selected_instance() {
    use std::process::{Child, Command, Stdio};
    struct Core(Child);
    impl Drop for Core {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let executable =
        fs::canonicalize(std::env::var_os("CPA_V8_TEST_CORE").expect("CPA_V8_TEST_CORE")).unwrap();
    let directory = TestDir::new();
    let config = directory.0.join("config.yaml");
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    fs::write(&config, format!("config-version: 8\nserver: {{host: 127.0.0.1, port: {port}}}\nmanagement: {{secret-key: {KEY}, disable-control-panel: true, disable-auto-update-panel: true}}\noauth: {{auth-dir: auth}}\n")).unwrap();
    let origin = format!("http://127.0.0.1:{port}");
    drop(listener);
    let mut core = Core(
        Command::new(executable)
            .args(["--config", config.to_str().unwrap(), "--local-model"])
            .current_dir(&directory.0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let target = Target::new(&origin, KEY).unwrap();
    let (keys, stale_tag) = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            assert!(
                core.0.try_wait().unwrap().is_none(),
                "fixture core exited during startup"
            );
            if let Ok(result) = load_keys(&target).await {
                break result;
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    })
    .await
    .expect("v8 fixture did not return supported version and keys");
    assert!(keys.is_empty());
    let updated = vec!["isolated-client".into(), "second-isolated-client".into()];
    save_keys(&target, stale_tag.clone(), &updated)
        .await
        .unwrap();
    assert_eq!(load_keys(&target).await.unwrap().0, updated);
    assert_eq!(
        save_keys(&target, stale_tag, &["stale-edit".into()]).await,
        Err(RemoteError::Conflict)
    );
    let bad = Target::new(&origin, "incorrect-test-key").unwrap();
    assert_eq!(
        check_target(&bad).await.unwrap_err(),
        RemoteError::NotAuthorized
    );
    assert_eq!(
        target
            .send(Method::GET, KEYS_PATH, None)
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert!(
        core.0.try_wait().unwrap().is_none(),
        "CPA still belongs to the fixture owner"
    );
}
