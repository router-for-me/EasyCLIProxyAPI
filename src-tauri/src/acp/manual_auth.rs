use super::*;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::Command;
use std::sync::mpsc::{self, SyncSender};
use std::time::{Duration, Instant};

pub(super) const UNSUPPORTED: &str =
    "The installed Antigravity CLI does not offer supported terminal sign-in";
pub(super) const FAILED: &str = "Antigravity terminal sign-in did not complete";
const INVALID: &str = "Enter the authorization code or the official Antigravity callback URL";
const INACTIVE: &str = "This Antigravity authorization request is no longer waiting for a code";
const CANCELLED: &str = "ACP request cancelled";

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
        mut show: impl FnMut(ManualLink) -> Result<(), String>,
    ) -> Result<(), String> {
        if cancel.load(Ordering::Acquire) {
            return Err(CANCELLED.into());
        }
        let _cleanup = ClearInput(self);
        let mut child = crate::spawn_core_child(command).map_err(|_| FAILED)?;
        let input = child.stdin.take().ok_or(FAILED)?;
        let output = child.stdout.take().ok_or(FAILED)?;
        let (links, next_link) = mpsc::sync_channel(1);
        let (codes, next_code) = mpsc::sync_channel::<String>(1);
        let (written, write_result) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mut output = BufReader::new(output);
            loop {
                let mut line = String::new();
                match (&mut output).take(8192).read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        if let Some(state) = official_state(line.trim()) {
                            let _ = links.try_send((line.trim().to_string(), state));
                        }
                    }
                }
            }
        });
        std::thread::spawn(move || {
            let mut input = input;
            if let Ok(code) = next_code.recv() {
                let _ = written.send(writeln!(input, "{code}").is_ok() && input.flush().is_ok());
            }
        });
        let deadline = Instant::now() + Duration::from_secs(300);
        let mut codes = Some(codes);
        let mut submitted = false;
        loop {
            if cancel.load(Ordering::Acquire) {
                return Err(CANCELLED.into());
            }
            if let (Some(_), Ok((url, state))) = (&codes, next_link.try_recv()) {
                *self.0.lock().map_err(|_| FAILED)? = Some(Input {
                    attempt: attempt.into(),
                    state,
                    sender: codes.take().unwrap(),
                });
                show(ManualLink {
                    attempt: attempt.into(),
                    url,
                })?;
            }
            if let Ok(ok) = write_result.try_recv() {
                if !ok {
                    return Err(FAILED.into());
                }
                submitted = true;
            }
            if let Some(exit) = child.try_wait().map_err(|_| FAILED)? {
                // The writer may not have notified yet when the child exits.
                if !submitted {
                    submitted = write_result.recv_timeout(Duration::from_millis(100)) == Ok(true);
                }
                return if exit.success() && submitted {
                    Ok(())
                } else {
                    Err(FAILED.into())
                };
            }
            if Instant::now() >= deadline {
                return Err(FAILED.into());
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
    fn terminal_child_fixture() {
        if std::env::var_os("ECPA_MANUAL_CHILD_FIXTURE").is_none() {
            return;
        }
        println!("Open this link in a browser to log in with Google:\n  {LINK}");
        std::io::stdout().flush().unwrap();
        let mut line = String::new();
        std::io::stdin().read_line(&mut line).unwrap();
        assert_eq!(line.trim_end(), "4/synthetic-code");
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
            .stderr(Stdio::null());
        auth.run(command, "once", &AtomicBool::new(false), |link| {
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

    #[test]
    #[ignore = "requires a checksum-verified official CLI; no authorization response is submitted"]
    fn official_advertised_terminal_handoff_without_authorization() {
        let executable =
            PathBuf::from(std::env::var_os("ECPA_ACP_UNAUTHORIZED_PROBE_CLI").unwrap());
        let root = crate::unique_test_temp_path("acp-manual-official");
        prepare_profile(&root).unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let mut probe_command = rpc::command(&executable, &root, "");
        probe_command
            .env("HOME", &root)
            .env_remove("DISPLAY")
            .env_remove("WAYLAND_DISPLAY")
            .env("PATH", &root);
        let mut probe = rpc::Client::spawn_command(probe_command).unwrap();
        probe.initialize_manual(&cancel).unwrap();
        drop(probe);
        let mut command = rpc::command(&executable, &root, "");
        command
            .arg("--login")
            .env("HOME", &root)
            .env_remove("DISPLAY")
            .env_remove("WAYLAND_DISPLAY")
            .env("PATH", &root);
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
        assert!(root.join(".gemini/antigravity-cli/log").is_dir());
        std::fs::remove_dir_all(root).unwrap();
    }
}
