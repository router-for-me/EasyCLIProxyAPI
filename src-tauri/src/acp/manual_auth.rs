use super::*;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, SyncSender};
use std::time::{Duration, Instant};

pub(super) const UNSUPPORTED: &str =
    "The installed Antigravity CLI does not offer supported terminal sign-in";
pub(super) const FAILED: &str = "Antigravity terminal sign-in did not complete";
const INVALID: &str = "Enter the authorization code or the official Antigravity callback URL";
const INACTIVE: &str = "This Antigravity authorization request is no longer waiting for a code";
const CANCELLED: &str = "ACP request cancelled";

const WAIT_EXPIRED: &str = "Antigravity authorization expired while waiting for a response";
const WRITE_FAILED: &str = "Could not deliver the authorization response to Antigravity CLI";
const EARLY_EXIT: &str = "Antigravity CLI exited before receiving the authorization response";
const EXCHANGE_TIMEOUT: &str = "Antigravity CLI timed out completing authorization";
const REJECTED: &str = "Google rejected the authorization response";
const NETWORK: &str = "Antigravity CLI could not reach Google during authorization";

fn exchange_diagnostic(line: &str) -> Option<(&'static str, u8)> {
    let text = line.to_ascii_lowercase();
    if text.contains("invalid_grant") {
        return Some((REJECTED, 2));
    }
    if [
        "proxyconnect tcp",
        "connection refused",
        "no such host",
        "tls handshake timeout",
        "network is unreachable",
    ]
    .iter()
    .any(|marker| text.contains(marker))
    {
        return Some((NETWORK, 1));
    }
    None
}

const DEFAULT_RESPONSE_WAIT: Duration = Duration::from_secs(300);
const EXTENDED_RESPONSE_WAIT: Duration = Duration::from_secs(900);

fn response_wait_with_opt_in(enabled: bool) -> Duration {
    if cfg!(all(target_os = "linux", debug_assertions)) && enabled {
        EXTENDED_RESPONSE_WAIT
    } else {
        DEFAULT_RESPONSE_WAIT
    }
}

fn response_wait() -> Duration {
    response_wait_with_opt_in(
        std::env::var_os("ECPA_ACP_DEBUG_EXTENDED_WAIT").is_some_and(|value| value == "1"),
    )
}

pub(super) struct TerminalLogin;

impl TerminalLogin {
    pub(super) fn advertised(initialize: &Value) -> Option<Self> {
        initialize["authMethods"]
            .as_array()?
            .iter()
            .find_map(|method| {
                if method["id"] != "terminal-login" || method["type"] != "terminal" {
                    return None;
                }
                // Only accept the documented login-only command. Arbitrary args or
                // environment entries could redirect authentication or weaken the
                // subprocess isolation. Never execute them; verify CLI help instead.
                if !method.get("env").is_none_or(|env| {
                    env.is_null() || env.as_object().is_some_and(|env| env.is_empty())
                }) {
                    return None;
                }
                let args = method["args"].as_array()?;
                if args.len() != 1 || args[0] != "--login" {
                    return None;
                }
                Some(Self)
            })
    }

    fn documented(help: &str) -> bool {
        help.lines().any(|line| {
            let line = line.trim_start();
            let Some(description) = line.strip_prefix("--login") else {
                return false;
            };
            // A standalone flag can have an optional Boolean default, but
            // must not declare a token or another required value.
            if !description.starts_with(char::is_whitespace) {
                return false;
            }
            let description = description.trim().to_ascii_lowercase();
            if description.starts_with(['<', '[', '=', '{'])
                || description
                    .split_whitespace()
                    .next()
                    .is_some_and(|word| matches!(word, "string" | "token" | "value" | "required"))
                || [
                    "not support",
                    "unsupported",
                    "disabled",
                    "unavailable",
                    "bearer",
                    "access token",
                ]
                .iter()
                .any(|marker| description.contains(marker))
            {
                return false;
            }
            let words: Vec<_> = description
                .split(|ch: char| !ch.is_ascii_alphanumeric())
                .collect();
            let google = words.contains(&"google") || description.contains("google");
            let interactive = words
                .iter()
                .any(|word| matches!(*word, "interactive" | "interactively"))
                || (words.contains(&"terminal")
                    && (words.contains(&"paste") || words.contains(&"code")))
                || description.contains("交互")
                || (description.contains("终端") && description.contains("授权码"));
            let login = [
                "log in",
                "sign in",
                "login",
                "sign-in",
                "authenticat",
                "登录",
            ]
            .iter()
            .any(|marker| description.contains(marker));
            google && interactive && login
        })
    }

    pub(super) fn resolve(
        executable: &Path,
        profile: &Path,
        proxy: &str,
        cancel: &Arc<AtomicBool>,
    ) -> Result<Self, String> {
        if cancel.load(Ordering::Acquire) {
            return Err(CANCELLED.into());
        }
        // The documented standalone command need not have a working ACP
        // initialize handshake. Verify its actual flag before probing RPC.
        let help_status = Self::probe_help(executable, profile, proxy, cancel)?;
        if help_status == Some(true) {
            return Ok(Self);
        }
        let mut probe = rpc::Client::spawn(executable, profile, proxy)?;
        match probe.initialize_manual(cancel) {
            Ok(Some(login)) => Ok(login),
            Ok(None) if help_status == Some(false) => Err(UNSUPPORTED.into()),
            Ok(None) => Err(
                "Could not verify Antigravity CLI terminal sign-in: command help unavailable"
                    .into(),
            ),
            Err(error) if cancel.load(Ordering::Acquire) => Err(error),
            Err(_) => Err(
                "Could not verify Antigravity CLI terminal sign-in: ACP initialization failed"
                    .into(),
            ),
        }
    }

    fn probe_help(
        executable: &Path,
        profile: &Path,
        proxy: &str,
        cancel: &AtomicBool,
    ) -> Result<Option<bool>, String> {
        let mut command = rpc::command_with_args(executable, profile, proxy, &["--help"])?;
        command.stdin(Stdio::null()).stderr(Stdio::piped());
        let mut child = crate::spawn_core_child(command)
            .map_err(|_| "Could not start Antigravity CLI to check terminal sign-in")?;
        fn read_pipe(reader: impl Read + Send + 'static) -> mpsc::Receiver<String> {
            let (send, receive) = mpsc::sync_channel(1);
            std::thread::spawn(move || {
                let mut bytes = Vec::new();
                let _ = reader.take(64 * 1024).read_to_end(&mut bytes);
                let _ = send.send(String::from_utf8_lossy(&bytes).into_owned());
            });
            receive
        }
        let stdout = read_pipe(
            child
                .stdout
                .take()
                .ok_or("Antigravity CLI help output is unavailable")?,
        );
        let stderr = read_pipe(
            child
                .stderr
                .take()
                .ok_or("Antigravity CLI help output is unavailable")?,
        );
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if cancel.load(Ordering::Acquire) {
                return Err(CANCELLED.into());
            }
            if let Some(exit) = child
                .try_wait()
                .map_err(|_| "Could not read Antigravity CLI exit status")?
            {
                if !exit.success() {
                    return Ok(None);
                }
                let out = stdout
                    .recv_timeout(Duration::from_millis(150))
                    .unwrap_or_default();
                let err = stderr
                    .recv_timeout(Duration::from_millis(150))
                    .unwrap_or_default();
                if Self::documented(&out) || Self::documented(&err) {
                    return Ok(Some(true));
                }
                // A --login line with unclear semantics is not a negative
                // capability report. Let ACP supply authoritative evidence.
                let text = format!("{out}\n{err}");
                let ambiguous = text.lines().any(|line| {
                    line.trim_start()
                        .strip_prefix("--login")
                        .is_some_and(|rest| rest.is_empty() || rest.starts_with(['=', ' ', '\t']))
                });
                let is_acp_help = text
                    .lines()
                    .any(|line| line.trim_start().starts_with("Usage: agy acp"));
                return Ok((is_acp_help && !ambiguous).then_some(false));
            }
            if Instant::now() >= deadline {
                return Ok(None);
            }
            std::thread::sleep(Duration::from_millis(40));
        }
    }

    pub(super) fn command(
        &self,
        executable: &Path,
        profile: &Path,
        proxy: &str,
    ) -> Result<Command, String> {
        let mut command = rpc::command_with_args(executable, profile, proxy, &["--login"])?;
        command.stderr(Stdio::piped());
        Ok(command)
    }
}

#[derive(Clone, Serialize)]
pub(crate) struct ManualLink {
    attempt: String,
    url: String,
}

#[derive(Default)]
pub(super) struct ManualAuth(Mutex<Option<Input>>);

struct Input {
    attempt: String,
    state: String,
    sender: SyncSender<String>,
    deadline: Instant,
}

struct ClearInput<'a>(&'a ManualAuth);
impl Drop for ClearInput<'_> {
    fn drop(&mut self) {
        if let Ok(mut input) = self.0 .0.lock() {
            input.take();
        }
    }
}

impl ManualAuth {
    pub(super) fn submit(&self, attempt: &str, response: &str) -> Result<(), String> {
        let mut slot = self.0.lock().map_err(|_| INACTIVE)?;
        let input = slot
            .as_ref()
            .filter(|input| input.attempt == attempt)
            .ok_or(INACTIVE)?;
        if Instant::now() >= input.deadline {
            return Err(WAIT_EXPIRED.into());
        }
        let response = validate_response(response, &input.state).ok_or(INVALID)?;
        input
            .sender
            .try_send(response.into())
            .map_err(|_| INACTIVE)?;
        slot.take();
        Ok(())
    }

    pub(super) fn run(
        &self,
        command: Command,
        attempt: &str,
        cancel: &AtomicBool,
        show: impl FnMut(ManualLink) -> Result<(), String>,
    ) -> Result<Option<String>, String> {
        self.run_with_wait(command, attempt, cancel, show, response_wait())
    }

    fn run_with_wait(
        &self,
        command: Command,
        attempt: &str,
        cancel: &AtomicBool,
        mut show: impl FnMut(ManualLink) -> Result<(), String>,
        wait: Duration,
    ) -> Result<Option<String>, String> {
        if cancel.load(Ordering::Acquire) {
            return Err(CANCELLED.into());
        }
        let _cleanup = ClearInput(self);
        let mut child = crate::spawn_core_child(command).map_err(|_| FAILED)?;
        let input = child.stdin.take().ok_or(FAILED)?;
        let output = child.stdout.take().ok_or(FAILED)?;
        let (links, next_link) = mpsc::sync_channel(1);
        let (identity, reported_identity) = mpsc::sync_channel(1);
        let (codes, next_code) = mpsc::sync_channel::<String>(1);
        let (write_code, code_to_write) = mpsc::sync_channel::<String>(1);
        let (written, write_result) = mpsc::sync_channel(1);
        let diagnostic = Arc::new(std::sync::atomic::AtomicU8::new(0));
        fn scan(
            reader: impl Read + Send + 'static,
            links: SyncSender<(String, String)>,
            identity: SyncSender<String>,
            diagnostic: Arc<std::sync::atomic::AtomicU8>,
        ) {
            std::thread::spawn(move || {
                let mut output = BufReader::new(reader);
                loop {
                    let mut line = String::new();
                    match (&mut output).take(8192).read_line(&mut line) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            if let Some((_, category)) = exchange_diagnostic(&line) {
                                diagnostic.fetch_max(category, Ordering::Relaxed);
                            }
                            if let Some(state) = official_state(line.trim()) {
                                let _ = links.try_send((line.trim().to_string(), state));
                            } else if let Some(email) = line
                                .trim()
                                .strip_prefix("Logged in as ")
                                .and_then(|s| s.strip_suffix('.'))
                                .and_then(rpc::valid_account_email)
                            {
                                let _ = identity.try_send(email.to_owned());
                            }
                        }
                    }
                }
            });
        }
        if let Some(stderr) = child.stderr.take() {
            scan(stderr, links.clone(), identity.clone(), diagnostic.clone());
        }
        scan(output, links, identity, diagnostic.clone());
        std::thread::spawn(move || {
            let mut input = input;
            if let Ok(code) = code_to_write.recv() {
                let _ = written.send(writeln!(input, "{code}").is_ok() && input.flush().is_ok());
            }
        });
        let mut deadline = Instant::now() + Duration::from_secs(30);
        let mut codes = Some(codes);
        let mut writing = false;
        let mut submitted = false;
        let mut writer = Some(write_code);
        loop {
            if cancel.load(Ordering::Acquire) {
                return Err(CANCELLED.into());
            }
            if let (Some(_), Ok((url, state))) = (&codes, next_link.try_recv()) {
                deadline = Instant::now() + wait;
                *self.0.lock().map_err(|_| FAILED)? = Some(Input {
                    attempt: attempt.into(),
                    state,
                    sender: codes.take().unwrap(),
                    deadline,
                });
                show(ManualLink {
                    attempt: attempt.into(),
                    url,
                })?;
            }
            if !writing && !submitted {
                // Serialize expiry and queue consumption against IPC submission.
                // A response accepted before the deadline starts its own phase.
                let mut slot = self.0.lock().map_err(|_| FAILED)?;
                if let Ok(code) = next_code.try_recv() {
                    writer
                        .take()
                        .ok_or(WRITE_FAILED)?
                        .try_send(code)
                        .map_err(|_| WRITE_FAILED)?;
                    writing = true;
                    deadline = Instant::now() + Duration::from_secs(5);
                } else if Instant::now() >= deadline {
                    slot.take();
                    return Err(if codes.is_some() {
                        "Antigravity CLI did not provide an authorization link in time"
                    } else {
                        WAIT_EXPIRED
                    }
                    .into());
                }
            }
            if writing {
                match write_result.try_recv() {
                    Ok(true) => {
                        writing = false;
                        submitted = true;
                        deadline = Instant::now() + Duration::from_secs(60);
                    }
                    Ok(false) | Err(mpsc::TryRecvError::Disconnected) => {
                        return Err(WRITE_FAILED.into())
                    }
                    Err(mpsc::TryRecvError::Empty) if Instant::now() >= deadline => {
                        return Err(WRITE_FAILED.into())
                    }
                    Err(mpsc::TryRecvError::Empty) => {}
                }
            }
            if let Some(exit) = child.try_wait().map_err(|_| FAILED)? {
                if writing && write_result.recv_timeout(Duration::from_millis(150)) != Ok(true) {
                    return Err(WRITE_FAILED.into());
                }
                if !submitted && !writing {
                    return Err(EARLY_EXIT.into());
                }
                // Output readers can still drain the final pipe bytes after exit.
                let identity = reported_identity
                    .recv_timeout(Duration::from_millis(150))
                    .ok();
                if exit.success() {
                    return Ok(identity);
                }
                return Err(match diagnostic.load(Ordering::Relaxed) {
                    2 => REJECTED,
                    1 => NETWORK,
                    _ => FAILED,
                }
                .into());
            }
            if submitted && Instant::now() >= deadline {
                return Err(EXCHANGE_TIMEOUT.into());
            }
            std::thread::sleep(Duration::from_millis(40));
        }
    }
}

fn exact_url(url: &reqwest::Url, host: &str, path: &str) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some(host)
        && url.path() == path
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.fragment().is_none()
}

fn official_state(input: &str) -> Option<String> {
    let url = reqwest::Url::parse(input).ok()?;
    if !exact_url(&url, "accounts.google.com", "/o/oauth2/auth")
        || input
            .bytes()
            .any(|b| b.is_ascii_whitespace() || b.is_ascii_control())
    {
        return None;
    }
    let mut query = url.query_pairs();
    if !query
        .clone()
        .any(|(k, v)| k == "redirect_uri" && v == "https://antigravity.google/oauth-callback")
    {
        return None;
    }
    if !query
        .clone()
        .any(|(k, v)| k == "code_challenge_method" && v == "S256")
    {
        return None;
    }
    query.find_map(|(k, v)| (k == "state" && !v.is_empty()).then(|| v.into_owned()))
}

fn validate_response<'a>(input: &'a str, expected_state: &str) -> Option<&'a str> {
    let input = input.trim();
    if input.is_empty()
        || input.len() > 3072
        || input
            .bytes()
            .any(|b| b.is_ascii_whitespace() || b.is_ascii_control())
    {
        return None;
    }
    if let Ok(url) = reqwest::Url::parse(input) {
        if !exact_url(&url, "antigravity.google", "/oauth-callback") {
            return None;
        }
        let mut states = url.query_pairs().filter(|(key, _)| key == "state");
        if let Some((_, state)) = states.next() {
            if state != expected_state || states.next().is_some() {
                return None;
            }
        }
        if url.query_pairs().any(|(k, v)| k == "code" && !v.is_empty()) {
            return Some(input);
        }
        return None;
    }
    input
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"-_./".contains(&b))
        .then_some(input)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;

    const LINK: &str = "https://accounts.google.com/o/oauth2/auth?redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&code_challenge_method=S256&state=fixture";

    #[test]
    fn extended_response_wait_is_bounded_and_debug_linux_only() {
        assert_eq!(response_wait_with_opt_in(false), Duration::from_secs(300));
        assert_eq!(
            response_wait_with_opt_in(true),
            Duration::from_secs(if cfg!(all(target_os = "linux", debug_assertions)) {
                900
            } else {
                300
            })
        );
    }

    #[test]
    fn terminal_method_accepts_only_supported_invocation() {
        for env in [Value::Null, json!({})] {
            let value = json!({"authMethods":[{"id":"terminal-login","type":"terminal","args":["--login"],"env":env}]});
            assert!(TerminalLogin::advertised(&value).is_some());
        }
        for method in [
            json!({"id":"terminal-login","args":["--login"]}),
            json!({"id":"terminal-login","type":"terminal","args":["--login","--gemini-dir","other"]}),
            json!({"id":"terminal-login","type":"terminal","args":["--login"],"env":{"PATH":"other"}}),
        ] {
            assert!(TerminalLogin::advertised(&json!({"authMethods":[method]})).is_none());
        }
        assert!(TerminalLogin::documented("Usage: agy acp [flags]\r\n  --login    Log in with Google interactively, then exit (ACP terminal auth)\r\n"));
        assert!(!TerminalLogin::documented(
            "  --login-file  Unrelated option\n"
        ));
        assert!(!TerminalLogin::documented("Pass --login to continue\n"));
        assert!(TerminalLogin::documented(
            "  --login  在终端交互式登录 Google\r\n"
        ));
    }

    #[test]
    fn ambiguous_login_help_is_not_authorization_capability() {
        for line in [
            "--login=<token> Use a custom bearer credential",
            "--login Use a custom bearer credential",
            "--login is not supported in this build",
            "--login <token> Interactively sign in to Google",
            "--login string  Interactively sign in to Google",
        ] {
            assert!(!TerminalLogin::documented(line), "{line}");
        }
        assert!(TerminalLogin::documented(
            "  --login  Sign in interactively with your Google account"
        ));
    }

    #[cfg(unix)]
    #[test]
    fn absent_descriptor_resolves_only_when_installed_cli_documents_terminal_login() {
        use std::os::unix::fs::PermissionsExt;
        let root = crate::unique_test_temp_path("acp-manual-help");
        prepare_profile(&root).unwrap();
        let executable = root.join("agy");
        let cancel = Arc::new(AtomicBool::new(false));
        for supported in [true, false] {
            let help = if supported {
                "  --login   Log in with Google interactively, then exit (ACP terminal auth)"
            } else {
                "  --login-file   Unrelated option"
            };
            std::fs::write(&executable, format!(r#"#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = '--help' ]; then printf '%s\n' 'Usage: agy acp [flags]' '{help}' >&2; exit 0; fi
done
read -r input
if [ "{supported}" = 'true' ]; then exit 17; fi
printf '%s\n' '{{"jsonrpc":"2.0","id":1,"result":{{"protocolVersion":1,"authMethods":[{{"id":"oauth-personal"}}]}}}}'
"#)).unwrap();
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
            let result = TerminalLogin::resolve(&executable, &root, "", &cancel);
            if supported {
                assert!(result.is_ok());
            } else {
                assert!(matches!(result, Err(ref error) if error == UNSUPPORTED));
            }
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn ambiguous_help_falls_back_to_advertisement_and_failed_rpc_is_not_unsupported() {
        use std::os::unix::fs::PermissionsExt;
        let root = crate::unique_test_temp_path("acp-help-negative");
        prepare_profile(&root).unwrap();
        let executable = root.join("agy");
        for (reply, expected) in [
            (
                r#"printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"authMethods":[{"id":"terminal-login","type":"terminal","args":["--login"]}]}}'"#,
                None,
            ),
            (
                "exit 17",
                Some(
                    "Could not verify Antigravity CLI terminal sign-in: ACP initialization failed",
                ),
            ),
        ] {
            std::fs::write(&executable, format!("#!/bin/sh\nfor arg; do [ \"$arg\" != --help ] || {{ printf '%s\\n' 'Usage: agy acp [flags]' '--login Use a custom bearer credential' >&2; exit 0; }}; done\nread -r request\n{reply}\n")).unwrap();
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
            let result =
                TerminalLogin::resolve(&executable, &root, "", &Arc::new(AtomicBool::new(false)));
            assert_eq!(result.err().as_deref(), expected);
        }
        std::fs::write(
            &executable,
            "#!/bin/sh\necho $$ > child.pid\nwhile :; do :; done\n",
        )
        .unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let flag = cancel.clone();
        let marker = root.join("workspace/child.pid");
        let wait = marker.clone();
        let stop = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(2);
            while !wait.is_file() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            flag.store(true, Ordering::Release);
        });
        assert_eq!(
            TerminalLogin::resolve(&executable, &root, "", &cancel)
                .err()
                .as_deref(),
            Some(CANCELLED)
        );
        stop.join().unwrap();
        #[cfg(target_os = "linux")]
        assert!(!Path::new("/proc")
            .join(std::fs::read_to_string(marker).unwrap().trim())
            .exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn terminal_child_fixture() {
        let Ok(mode) = std::env::var("ECPA_MANUAL_CHILD_FIXTURE") else {
            return;
        };
        if mode == "early" {
            std::process::exit(3);
        }
        eprintln!("Open this link in a browser to log in with Google:\n  {LINK}");
        std::io::stderr().flush().unwrap();
        let mut line = String::new();
        assert!(std::io::stdin().read_line(&mut line).unwrap() > 0);
        if mode == "full-length" {
            assert_eq!(line, format!("{}\n", full_length_response()));
        } else {
            assert_eq!(line, "4/synthetic-code\n");
        }
        match mode.as_str() {
            "reject" => {
                eprintln!("invalid_grant private-fixture-marker");
                std::process::exit(1);
            }
            "network" => {
                eprintln!("proxyconnect tcp: connection refused private-fixture-marker");
                std::process::exit(1);
            }
            "unknown" => {
                eprintln!("private-fixture-marker");
                std::process::exit(1);
            }
            _ => println!("Logged in as fixture@example.test."),
        }
    }

    fn full_length_response() -> String {
        format!("4/{}z", "a".repeat(3069))
    }

    #[test]
    fn authorization_maximum_length_reaches_child_without_truncation() {
        let auth = ManualAuth::default();
        let response = full_length_response();
        assert_eq!(response.len(), 3072);
        let result = auth.run(
            terminal_fixture("full-length"),
            "exact-length",
            &AtomicBool::new(false),
            |link| {
                let too_long = format!("{response}x");
                assert_eq!(auth.submit(&link.attempt, &too_long).unwrap_err(), INVALID);
                auth.submit(&link.attempt, &response)
            },
        );
        assert_eq!(result.unwrap().as_deref(), Some("fixture@example.test"));
    }

    fn terminal_fixture(mode: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "acp::manual_auth::tests::terminal_child_fixture",
                "--nocapture",
            ])
            .env("ECPA_MANUAL_CHILD_FIXTURE", mode)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }

    #[test]
    fn terminal_phase_outcomes_are_distinct_and_do_not_expose_child_output() {
        let auth = ManualAuth::default();
        let cancel = AtomicBool::new(false);
        for (mode, error) in [
            ("early", EARLY_EXIT),
            ("reject", REJECTED),
            ("network", NETWORK),
            ("unknown", FAILED),
        ] {
            let result = auth.run(terminal_fixture(mode), "once", &cancel, |link| {
                auth.submit(&link.attempt, "4/synthetic-code")
            });
            assert_eq!(result.unwrap_err(), error);
            assert_eq!(
                auth.submit("once", "4/synthetic-code").unwrap_err(),
                INACTIVE
            );
        }
        let result = auth.run_with_wait(
            terminal_fixture("ok"),
            "expire",
            &cancel,
            |link| {
                std::thread::sleep(Duration::from_millis(90));
                assert_eq!(
                    auth.submit(&link.attempt, "4/synthetic-code").unwrap_err(),
                    WAIT_EXPIRED
                );
                Ok(())
            },
            Duration::from_millis(40),
        );
        assert_eq!(result.unwrap_err(), WAIT_EXPIRED);
        let result = auth.run_with_wait(
            terminal_fixture("ok"),
            "queued",
            &cancel,
            |link| {
                auth.submit(&link.attempt, "4/synthetic-code")?;
                // The accepted submission survives even if the runner resumes after expiry.
                std::thread::sleep(Duration::from_millis(90));
                Ok(())
            },
            Duration::from_millis(40),
        );
        assert_eq!(result.unwrap().as_deref(), Some("fixture@example.test"));
    }

    #[cfg(unix)]
    #[test]
    fn terminal_closed_stdin_reports_delivery_failure() {
        let auth = ManualAuth::default();
        let mut command = Command::new("/bin/sh");
        command
            .arg("-c")
            .arg(format!(
                "exec 0<&-; printf '%s\\n' '{LINK}'; exec /bin/sleep 5"
            ))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let result = auth.run(command, "closed", &AtomicBool::new(false), |link| {
            auth.submit(&link.attempt, "4/synthetic-code")
        });
        assert_eq!(result.unwrap_err(), WRITE_FAILED);
    }

    #[test]
    fn only_approved_terminal_urls_and_single_use_local_response() {
        let auth = ManualAuth::default();
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "acp::manual_auth::tests::terminal_child_fixture",
                "--nocapture",
            ])
            .env("ECPA_MANUAL_CHILD_FIXTURE", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let result = auth
            .run(command, "once", &AtomicBool::new(false), |link| {
                assert!(link.url == LINK);
                assert_eq!(
                    auth.submit("other", "4/synthetic-code").unwrap_err(),
                    INACTIVE
                );
                for invalid in [
                    "https://antigravity.google.evil.test/oauth-callback?code=a",
                    "https://antigravity.google/oauth-callback?code=a&state=stale",
                    "code\nextra",
                ] {
                    assert_eq!(auth.submit(&link.attempt, invalid).unwrap_err(), INVALID);
                }
                auth.submit(&link.attempt, "4/synthetic-code")?;
                assert_eq!(
                    auth.submit(&link.attempt, "4/synthetic-code").unwrap_err(),
                    INACTIVE
                );
                Ok(())
            })
            .unwrap();
        assert_eq!(result.as_deref(), Some("fixture@example.test"));
        assert!(official_state(
            &LINK.replace("accounts.google.com", "accounts.google.com.evil.test")
        )
        .is_none());
        assert!(validate_response(
            "https://antigravity.google/oauth-callback?code=synthetic&state=fixture",
            "fixture"
        )
        .is_some());
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "requires checksum-verified CLI; sends a synthetic response only to a refused loopback proxy"]
    fn official_synthetic_exchange_classifies_proxy_failure() {
        let cli = PathBuf::from(std::env::var_os("ECPA_ACP_UNAUTHORIZED_PROBE_CLI").unwrap());
        let root = crate::unique_test_temp_path("acp-manual-no-network");
        let profile = root
            .join("accounts")
            .join("a".repeat(32))
            .join(accounts::ISOLATED_HOME);
        prepare_profile(&profile).unwrap();
        let mut command = TerminalLogin
            .command(&cli, &profile, "http://127.0.0.1:1")
            .unwrap();
        command
            .env("HTTPS_PROXY", "http://127.0.0.1:1")
            .env("HTTP_PROXY", "http://127.0.0.1:1")
            .env("NO_PROXY", "");
        let auth = ManualAuth::default();
        let result = auth.run(command, "local-test", &AtomicBool::new(false), |link| {
            auth.submit(&link.attempt, "4/synthetic-ecpa-fixture")
        });
        assert_eq!(result.unwrap_err(), NETWORK);
        assert!(!accounts::isolated_token(&profile).exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "requires a checksum-verified official CLI; no authorization response is submitted"]
    fn official_advertised_terminal_handoff_without_authorization() {
        let executable =
            PathBuf::from(std::env::var_os("ECPA_ACP_UNAUTHORIZED_PROBE_CLI").unwrap());
        let root = crate::unique_test_temp_path("acp-manual-official");
        let directory = root
            .join("accounts")
            .join("a".repeat(32))
            .join(accounts::ISOLATED_HOME);
        prepare_profile(&directory).unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let plan = TerminalLogin::resolve(&executable, &directory, "", &cancel).unwrap();
        let command = plan.command(&executable, &directory, "").unwrap();
        let auth = ManualAuth::default();
        let mut received = false;
        let result = auth.run(command, "current", &cancel, |link| {
            assert!(official_state(&link.url).is_some());
            received = true;
            cancel.store(true, Ordering::Release);
            Ok(())
        });
        assert!(received);
        assert_eq!(result.unwrap_err(), CANCELLED);
        assert_eq!(
            auth.submit("current", "4/synthetic-code").unwrap_err(),
            INACTIVE
        );
        assert!(directory.join(".gemini/antigravity-cli/log").is_dir());
        std::fs::remove_dir_all(root).unwrap();
    }
}
