//! Holds the owned ACP process across tool barriers and explicitly linked turns.
use super::tool_transport::{Event, Transport, TOOL_WAIT};
use super::*;
use std::sync::{atomic::AtomicUsize, mpsc};
use std::time::{Duration, Instant};

pub(super) const DEFAULT_MAX_LIVE: usize = 64;
pub(super) const MIN_MAX_LIVE: usize = 4;
pub(super) const MAX_MAX_LIVE: usize = 256;
const IDLE: Duration = Duration::from_secs(180);
const POLL: Duration = Duration::from_millis(50);

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Protocol {
    Chat,
    Responses,
}

#[derive(Clone, PartialEq)]
pub(super) struct Identity {
    pub account: request_pool::AccountRoute,
    pub model: String,
    pub system: String,
    // Prefix of the session instructions supplied in the Responses top-level field.
    pub instructions_bytes: usize,
    pub tools: Vec<Value>,
    pub protocol: Protocol,
    pub caller: Option<String>,
}

pub(super) struct Context {
    pub identity: Identity,
    pub pending: Option<Value>,
}

fn send_event(
    sender: &mpsc::SyncSender<Event>,
    cancel: &AtomicBool,
    mut event: Event,
) -> Result<(), String> {
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err("ACP API client disconnected or request cancelled".into());
        }
        match sender.try_send(event) {
            Ok(()) => return Ok(()),
            Err(mpsc::TrySendError::Full(pending)) => {
                event = pending;
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(mpsc::TrySendError::Disconnected(_)) => {
                return Err("ACP response receiver closed".into())
            }
        }
    }
}

pub(super) struct Sessions(
    Arc<Mutex<BTreeMap<String, Live>>>,
    Arc<AtomicUsize>,
    Arc<AtomicUsize>,
);

impl Default for Sessions {
    fn default() -> Self {
        Self(
            Arc::new(Mutex::new(BTreeMap::new())),
            Arc::new(AtomicUsize::new(0)),
            Arc::new(AtomicUsize::new(DEFAULT_MAX_LIVE)),
        )
    }
}

#[derive(Clone)]
pub(super) struct Live {
    account_id: String,
    turn: Arc<Mutex<Session>>,
    cancel: Arc<AtomicBool>,
}

pub(super) struct Session {
    receiver: mpsc::Receiver<Event>,
    cancel: Arc<AtomicBool>,
    commands: mpsc::SyncSender<Vec<bridge::PromptBlock>>,
    pending: BTreeMap<String, mpsc::SyncSender<Value>>,
    expected: Vec<Value>,
    transcript: Option<Vec<Value>>,
    identity: Identity,
    expires: Instant,
    supports_images: bool,
}

impl Drop for Session {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Release);
    }
}

struct Capacity(Arc<AtomicUsize>);
impl Drop for Capacity {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

impl Sessions {
    pub fn set_max_live(&self, limit: usize) {
        self.2
            .store(limit.clamp(MIN_MAX_LIVE, MAX_MAX_LIVE), Ordering::Release);
    }

    pub fn max_live(&self) -> usize {
        self.2.load(Ordering::Acquire)
    }

    pub fn total_live(&self) -> usize {
        self.1.load(Ordering::Acquire)
    }

    pub fn live_counts_by_account(&self) -> BTreeMap<String, usize> {
        let mut counts = BTreeMap::new();
        let Ok(sessions) = self.0.lock() else {
            return counts;
        };
        let mut seen = std::collections::HashSet::new();
        let now = Instant::now();
        for live in sessions.values() {
            let ptr = Arc::as_ptr(&live.turn) as usize;
            if !seen.insert(ptr) || live.cancel.load(Ordering::Acquire) {
                continue;
            }
            let alive = live
                .turn
                .try_lock()
                .map(|turn| now < turn.expires)
                .unwrap_or(true);
            if alive {
                *counts.entry(live.account_id.clone()).or_insert(0) += 1;
            }
        }
        counts
    }

    pub fn abandon_account(&self, account_id: &str) {
        if let Ok(mut sessions) = self.0.lock() {
            sessions.retain(|_, live| {
                if live.account_id == account_id {
                    live.cancel.store(true, Ordering::Release);
                    false
                } else {
                    true
                }
            });
        }
    }

    pub fn clear(&self) {
        if let Ok(mut sessions) = self.0.lock() {
            for session in sessions.values() {
                session.cancel.store(true, Ordering::Release);
            }
            sessions.clear();
        }
    }

    pub fn context(&self, id: &str, caller: Option<&str>) -> Result<Context, String> {
        if !id
            .strip_prefix("resp_acp_")
            .is_some_and(|token| token.len() == 48 && token.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            return Err("Unknown or expired ACP previous_response_id".into());
        }
        let sessions = self.0.lock().map_err(|_| "Agent sessions unavailable")?;
        let live = sessions
            .get(id)
            .ok_or("Unknown or expired ACP previous_response_id")?;
        let turn = live.turn.lock().map_err(|_| "Agent session unavailable")?;
        if turn.identity.protocol != Protocol::Responses
            || turn.identity.caller.as_deref() != caller
            || live.cancel.load(Ordering::Acquire)
            || Instant::now() >= turn.expires
        {
            return Err("Unknown or expired ACP previous_response_id".into());
        }
        Ok(Context {
            identity: turn.identity.clone(),
            pending: turn.expected.last().cloned(),
        })
    }

    pub fn chat_identity(&self, id: &str) -> Result<request_pool::AccountRoute, String> {
        let sessions = self.0.lock().map_err(|_| "Agent sessions unavailable")?;
        let live = sessions
            .get(id)
            .ok_or("Unknown or expired ACP tool call; restart this agent turn")?;
        let turn = live.turn.lock().map_err(|_| "Agent session unavailable")?;
        if turn.identity.protocol != Protocol::Chat
            || live.cancel.load(Ordering::Acquire)
            || Instant::now() >= turn.expires
        {
            return Err("Unknown or expired ACP tool call; restart this agent turn".into());
        }
        Ok(turn.identity.account.clone())
    }

    // A full HTTP transcript can claim a live turn only within its authenticated
    // caller scope and only by echoing exactly the history we already applied.
    pub fn history_match(
        &self,
        request: &bridge::Completion,
        caller: &str,
    ) -> Result<Option<(String, request_pool::AccountRoute, usize)>, String> {
        let history = responses_history(&request.messages);
        let sessions = self.0.lock().map_err(|_| "Agent sessions unavailable")?;
        let mut matched = None;
        for (id, live) in sessions
            .iter()
            .filter(|(id, _)| id.starts_with("resp_acp_"))
        {
            let Ok(turn) = live.turn.try_lock() else {
                continue;
            };
            if turn.identity.caller.as_deref() != Some(caller)
                || turn.identity.model != request.model
                || turn.identity.instructions_bytes != request.instructions_bytes
                || turn.identity.system != request.system
                || turn.identity.tools != request.tools
                || live.cancel.load(Ordering::Acquire)
                || Instant::now() >= turn.expires
            {
                continue;
            }
            let Some(expected) = &turn.transcript else {
                continue;
            };
            let Some(suffix) = history
                .strip_prefix(expected.as_slice())
                .filter(|suffix| !suffix.is_empty())
            else {
                continue;
            };
            let valid = if turn.pending.is_empty() {
                suffix.iter().all(|m| m["role"] == "user")
            } else {
                suffix.len() == request.results.len()
                    && suffix.len() == turn.pending.len()
                    && suffix.iter().all(|m| {
                        m["role"] == "tool"
                            && m["tool_call_id"]
                                .as_str()
                                .is_some_and(|call| turn.pending.contains_key(call))
                    })
            };
            if !valid {
                continue;
            }
            if matched.is_some() {
                return Ok(None);
            } // Ambiguous branch: never guess.
            matched = Some((id.clone(), turn.identity.account.clone(), expected.len()));
        }
        Ok(matched)
    }

    pub fn resume(
        &self,
        request: &bridge::Completion,
        identity: &Identity,
        previous: Option<&str>,
    ) -> Result<Option<Live>, String> {
        let id = match (previous, request.results.first()) {
            (Some(id), _) => id,
            (None, Some(first)) => first["tool_call_id"]
                .as_str()
                .ok_or("Missing tool_call_id")?,
            (None, None) => return Ok(None),
        };
        let mut sessions = self.0.lock().map_err(|_| "Agent sessions unavailable")?;
        let live = sessions
            .get(id)
            .cloned()
            .ok_or("Unknown or expired ACP continuation; restart this agent turn")?;
        let mut turn = live.turn.lock().map_err(|_| "Agent session unavailable")?;
        if live.cancel.load(Ordering::Acquire) || Instant::now() >= turn.expires {
            return Err("ACP continuation expired; restart this agent turn".into());
        }
        if &turn.identity != identity {
            return Err(
                "ACP continuation does not match its account, model, instructions or tools".into(),
            );
        }
        if previous.is_none() {
            let history_len = request.messages.len() - request.results.len();
            if canonical_history(&request.messages[..history_len])
                != canonical_history(&turn.expected)
            {
                return Err("ACP tool result history does not match the pending agent turn".into());
            }
        }
        if request.results.len() != turn.pending.len() {
            return Err("Return all pending ACP tool results in one request".into());
        }
        let mut ids = std::collections::BTreeSet::new();
        let mut results = Vec::with_capacity(request.results.len());
        for result in &request.results {
            let id = result["tool_call_id"]
                .as_str()
                .ok_or("Missing tool_call_id")?;
            if !ids.insert(id) || !turn.pending.contains_key(id) {
                return Err("Unknown or duplicate ACP tool result".into());
            }
            results.push((id, bridge::tool_text(result)?));
        }
        if results.is_empty() && !turn.supports_images && bridge::has_images(&request.prompt) {
            return Err(bridge::IMAGE_UNSUPPORTED.into());
        }
        // Do not consume the bearer ID or send a result until validation of
        // the entire batch succeeds. A racing/replayed request cannot fork.
        sessions.retain(|_, entry| !Arc::ptr_eq(&entry.turn, &live.turn));
        let delivery = if results.is_empty() {
            turn.commands
                .try_send(request.prompt.clone())
                .map_err(|_| ())
        } else {
            results.into_iter().try_for_each(|(id, content)| {
                turn.pending
                    .remove(id)
                    .unwrap()
                    .try_send(json!({"content":[{"type":"text","text":content}]}))
                    .map_err(|_| ())
            })
        };
        if delivery.is_err() {
            live.cancel.store(true, Ordering::Release);
            return Err("ACP continuation has ended".into());
        }
        drop(turn);
        Ok(Some(live))
    }

    pub fn start(
        &self,
        request: &bridge::Completion,
        identity: Identity,
        mut client: rpc::Client,
    ) -> Result<Live, String> {
        let max_live = self.2.load(Ordering::Acquire);
        if self
            .1
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < max_live).then_some(n + 1)
            })
            .is_err()
        {
            return Err(
                "Too many live ACP agent sessions; wait for an idle session to expire".into(),
            );
        }
        let capacity = Capacity(self.1.clone());
        let account_id = identity.account.id.clone();
        let profile = identity.account.profile.clone();
        let persistent = identity.protocol == Protocol::Responses;
        let (sender, receiver) = mpsc::sync_channel(128);
        let (commands, prompts) = mpsc::sync_channel(1);
        let cancel = Arc::new(AtomicBool::new(false));
        let live = Live {
            account_id,
            turn: Arc::new(Mutex::new(Session {
                receiver,
                commands,
                cancel: cancel.clone(),
                pending: BTreeMap::new(),
                expected: Vec::new(),
                transcript: None,
                identity,
                expires: Instant::now() + TOOL_WAIT,
                supports_images: client.supports_prompt_images(),
            })),
            cancel: cancel.clone(),
        };
        let tools = request.tools.clone();
        let mut instructions = request.system.clone();
        let mut prompt = request.prompt.clone();
        let model = request.model.clone();
        let registry = Arc::downgrade(&self.0);
        let session_ref = Arc::downgrade(&live.turn);
        std::thread::spawn(move || {
            let _capacity = capacity;
            let result: Result<(), bridge::RunError> = (|| {
                let transport = if tools.is_empty() {
                    None
                } else {
                    client.allow_api_tools(&tools);
                    instructions.push_str("\n\nThe API client provides tools through api_client. Use only those tools when needed. Do not use local built-in tools. Their results will arrive from the API client; wait for each result before continuing.");
                    Some(Transport::start(&tools, sender.clone(), cancel.clone())?)
                };
                let servers = transport
                    .iter()
                    .map(|transport| transport.config.clone())
                    .collect::<Vec<_>>();
                let session = client.api_session(&profile, &instructions, &servers, &cancel)?;
                let session_id = session["sessionId"]
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| "ACP did not return a session ID".to_owned())?;
                client.model(&session, &model, &cancel)?;
                loop {
                    let mut bytes = 0_usize;
                    let result = client.agent_prompt(
                        json!({"sessionId":session_id,"prompt":prompt}),
                        &cancel,
                        true,
                        |update| {
                            if update["sessionUpdate"] == "agent_message_chunk"
                                && update["content"]["type"] == "text"
                            {
                                if let Some(text) = update["content"]["text"].as_str() {
                                    bytes = bytes.saturating_add(text.len());
                                    if bytes > 1024 * 1024
                                        || send_event(&sender, &cancel, Event::Text(text.into()))
                                            .is_err()
                                    {
                                        cancel.store(true, Ordering::Release);
                                    }
                                }
                            }
                        },
                    )?;
                    if result["stopReason"] != "end_turn" {
                        return Err(
                            format!("ACP agent turn stopped: {}", result["stopReason"]).into()
                        );
                    }
                    if !persistent {
                        return Ok(());
                    }
                    sender
                        .send(Event::Done(Ok(())))
                        .map_err(|_| "ACP response receiver closed".to_owned())?;
                    let deadline = Instant::now() + IDLE + POLL;
                    prompt = loop {
                        if cancel.load(Ordering::Acquire) || Instant::now() >= deadline {
                            return Ok(());
                        }
                        match prompts.recv_timeout(POLL) {
                            Ok(prompt) => break prompt,
                            Err(mpsc::RecvTimeoutError::Timeout) => {}
                            Err(_) => return Ok(()),
                        }
                    };
                }
            })();
            if !persistent || result.is_err() {
                let _ = send_event(&sender, &cancel, Event::Done(result));
            }
            if let (Some(registry), Some(turn)) = (registry.upgrade(), session_ref.upgrade()) {
                if let Ok(mut sessions) = registry.lock() {
                    sessions.retain(|_, registered| !Arc::ptr_eq(&registered.turn, &turn));
                }
            }
        });
        Ok(live)
    }

    pub fn collect<F: FnMut(&str)>(
        &self,
        live: &Live,
        request: &bridge::Completion,
        disconnected: &Arc<AtomicBool>,
        preserve_transcript: bool,
        mut chunk: F,
    ) -> Result<bridge::Output, bridge::RunError> {
        let mut turn = live
            .turn
            .lock()
            .map_err(|_| "Agent session unavailable".to_owned())?;
        let result = (|| {
            let mut text = String::new();
            let mut calls = Vec::new();
            let mut argument_bytes = 0_usize;
            let deadline = Instant::now() + Duration::from_secs(150);
            loop {
                if disconnected.load(Ordering::Acquire) || live.cancel.load(Ordering::Acquire) {
                    return Err("ACP API client disconnected or request cancelled"
                        .to_owned()
                        .into());
                }
                let wait = if calls.is_empty() {
                    POLL
                } else {
                    Duration::from_millis(100)
                };
                match turn.receiver.recv_timeout(wait) {
                    Ok(Event::Text(part)) => {
                        text.push_str(&part);
                        chunk(&part);
                    }
                    Ok(Event::Tool { call, result }) => {
                        let id = call["id"]
                            .as_str()
                            .ok_or_else(|| "Missing generated tool id".to_owned())?
                            .to_string();
                        argument_bytes = argument_bytes.saturating_add(
                            call["function"]["arguments"]
                                .as_str()
                                .unwrap_or_default()
                                .len(),
                        );
                        if argument_bytes > bridge::MAX_BODY {
                            return Err("ACP tool arguments exceed 1 MiB per response"
                                .to_owned()
                                .into());
                        }
                        turn.pending.insert(id, result);
                        calls.push(call);
                    }
                    Ok(Event::Done(result)) => {
                        result?;
                        if !calls.is_empty() {
                            return Err("ACP ended with unanswered tool calls".to_owned().into());
                        }
                        break;
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) if !calls.is_empty() => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(_) => return Err("ACP agent execution channel closed".to_owned().into()),
                }
                if Instant::now() >= deadline {
                    return Err(response_timeout(
                        !text.is_empty(),
                        !turn.identity.system.is_empty(),
                    )
                    .to_owned()
                    .into());
                }
            }
            if disconnected.load(Ordering::Acquire) || live.cancel.load(Ordering::Acquire) {
                return Err("ACP API client disconnected or request cancelled"
                    .to_owned()
                    .into());
            }
            if turn.identity.protocol == Protocol::Responses {
                bridge::responses::label_calls(&mut calls, &turn.identity.tools);
            }
            let output = bridge::Output { text, calls };
            if output.calls.is_empty() && output.text.trim().is_empty() {
                return Err(
                    "ACP Agent ended without an assistant reply or a client tool call"
                        .to_owned()
                        .into(),
                );
            }
            // Native continuation IDs do not need any stored transcript.
            // Keep only the emitted tool call envelope to validate the next batch.
            turn.transcript = if preserve_transcript && turn.identity.caller.is_some() {
                let mut history = responses_history(&request.messages);
                history.extend(responses_history(&[output.message()]));
                (json!(history).to_string().len() <= bridge::MAX_BODY).then_some(history)
            } else {
                None
            };
            turn.expected.clear();
            if !output.calls.is_empty() {
                if turn.identity.protocol != Protocol::Responses {
                    turn.expected = request.messages.clone();
                }
                turn.expected.push(output.message());
            }
            Ok(output)
        })();
        if result.is_err() {
            live.cancel.store(true, Ordering::Release);
        }
        result
    }

    pub fn publish(
        &self,
        live: &Live,
        id: Option<&str>,
        output: &bridge::Output,
        request_cancel: &AtomicBool,
    ) -> Result<(), String> {
        let mut sessions = self.0.lock().map_err(|_| "Agent sessions unavailable")?;
        if request_cancel.load(Ordering::Acquire) || live.cancel.load(Ordering::Acquire) {
            return Err("ACP API client disconnected or request cancelled".into());
        }
        sessions.retain(|_, registered| {
            registered
                .turn
                .try_lock()
                .map(|turn| {
                    !registered.cancel.load(Ordering::Acquire) && Instant::now() < turn.expires
                })
                .unwrap_or(true)
        });
        if let Some(id) = id {
            sessions.insert(id.to_owned(), live.clone());
        } else {
            for call in &output.calls {
                if let Some(id) = call["id"].as_str() {
                    sessions.insert(id.to_owned(), live.clone());
                }
            }
        }
        if id.is_none() && output.calls.is_empty() {
            return Ok(());
        }
        let duration = if output.calls.is_empty() {
            IDLE
        } else {
            TOOL_WAIT
        };
        live.turn
            .lock()
            .map_err(|_| "Agent session unavailable")?
            .expires = Instant::now() + duration;
        Ok(())
    }
    pub fn abandon(&self, id: &str) {
        if let Ok(mut registered) = self.0.lock() {
            if let Some(live) = registered.remove(id) {
                live.cancel.store(true, Ordering::Release);
                registered.retain(|_, other| !Arc::ptr_eq(&other.turn, &live.turn));
            }
        }
    }
}

// SDKs and CPA may represent an empty assistant content as null, an empty
// string, or omit it. Compare semantic history, including parsed arguments.
fn response_timeout(started_text: bool, has_instructions: bool) -> &'static str {
    if !started_text && has_instructions {
        "ACP agent response timed out before any assistant text or client tool call. The bridge did not remove or shorten the submitted instructions."
    } else if !started_text {
        "ACP agent response timed out before any assistant text or client tool call."
    } else {
        "ACP agent response timed out after receiving assistant text."
    }
}

fn canonical_history(messages: &[Value]) -> Vec<Value> {
    messages
        .iter()
        .map(|message| {
            let mut item = message.clone();
            if let Some(object) = item.as_object_mut() {
                object.remove("reasoning_content");
                if object.get("role").is_some_and(|role| role == "assistant")
                    && object.get("content").is_none_or(Value::is_null)
                {
                    object.insert("content".into(), json!(""));
                }
            }
            if let Some(calls) = item.get_mut("tool_calls").and_then(Value::as_array_mut) {
                for call in calls {
                    if let Some(arguments) = call["function"]["arguments"]
                        .as_str()
                        .and_then(|args| serde_json::from_str::<Value>(args).ok())
                    {
                        call["function"]["arguments"] = arguments;
                    }
                    if let Some(object) = call.as_object_mut() {
                        object.remove("index");
                    }
                }
            }
            item
        })
        .collect()
}

fn responses_message(mut message: Value) -> Value {
    if let Some(parts) = message["content"].as_array() {
        if parts
            .iter()
            .all(|part| part["type"] == "text" && part["text"].is_string())
        {
            message["content"] = json!(parts
                .iter()
                .map(|part| part["text"].as_str().unwrap())
                .collect::<String>());
        }
    }
    message
}

fn responses_history(messages: &[Value]) -> Vec<Value> {
    canonical_history(
        &messages
            .iter()
            .filter(|m| m["role"] != "system" && m["role"] != "developer")
            .cloned()
            .map(responses_message)
            .collect::<Vec<_>>(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeout_diagnostic_does_not_attribute_the_stall_to_prompt_content() {
        let unstarted = response_timeout(false, true);
        assert!(unstarted.contains("timed out before any assistant text"));
        assert!(unstarted.contains("did not remove or shorten"));
        assert!(!response_timeout(false, false).contains("instructions"));
        assert!(response_timeout(true, true).contains("after receiving assistant text"));
    }

    fn identity(id: &str, protocol: Protocol) -> Identity {
        Identity {
            account: request_pool::AccountRoute {
                id: id.into(),
                profile: PathBuf::new(),
            },
            model: "test".into(),
            system: String::new(),
            instructions_bytes: 0,
            tools: Vec::new(),
            protocol,
            caller: None,
        }
    }

    #[test]
    fn expired_response_ids_cannot_claim_a_live_worker() {
        let sessions = Sessions::default();
        let (_events, receiver) = mpsc::sync_channel(1);
        let (commands, prompts) = mpsc::sync_channel(1);
        let cancel = Arc::new(AtomicBool::new(false));
        let identity = identity("same", Protocol::Responses);
        let live = Live {
            account_id: "same".into(),
            cancel: cancel.clone(),
            turn: Arc::new(Mutex::new(Session {
                receiver,
                commands,
                cancel,
                pending: BTreeMap::new(),
                expected: Vec::new(),
                transcript: None,
                identity,
                expires: Instant::now() - POLL,
                supports_images: false,
            })),
        };
        let id = format!("resp_acp_{}", "0".repeat(48));
        sessions.0.lock().unwrap().insert(id.clone(), live);
        assert!(sessions.context(&id, None).is_err());
        assert!(prompts.try_recv().is_err());
    }

    #[test]
    fn account_reset_cancels_and_forgets_pending_continuations() {
        let state = AcpState::default();
        let (_sender, receiver) = mpsc::sync_channel(1);
        let cancel = Arc::new(AtomicBool::new(false));
        let (commands, _) = mpsc::sync_channel(1);
        let turn = Live {
            account_id: "old".into(),
            cancel: cancel.clone(),
            turn: Arc::new(Mutex::new(Session {
                receiver,
                commands,
                cancel: cancel.clone(),
                supports_images: false,
                pending: BTreeMap::new(),
                expected: Vec::new(),
                transcript: None,
                identity: identity("old", Protocol::Chat),
                expires: Instant::now() + TOOL_WAIT,
            })),
        };
        state
            .agents
            .0
            .lock()
            .unwrap()
            .insert("old-call".into(), turn);
        reset_account(&state).unwrap();
        assert!(cancel.load(Ordering::Acquire));
        assert!(state.agents.0.lock().unwrap().is_empty());
    }

    #[test]
    fn pending_tools_require_matching_history_identity_and_single_delivery() {
        let sessions = Sessions::default();
        let (events, receiver) = mpsc::sync_channel(4);
        let cancel = Arc::new(AtomicBool::new(false));
        let (result, delivered) = mpsc::sync_channel(1);
        let call = json!({"id":"call_test","type":"function","function":{"name":"lookup","arguments":"{ \"key\": \"alpha\" }"}});
        let expected = vec![
            json!({"role":"user","content":"lookup"}),
            json!({"role":"assistant","content":null,"tool_calls":[call]}),
        ];
        let first = identity("first", Protocol::Chat);
        let (commands, _) = mpsc::sync_channel(1);
        let turn = Live {
            account_id: "first".into(),
            cancel: cancel.clone(),
            turn: Arc::new(Mutex::new(Session {
                receiver,
                commands,
                cancel: cancel.clone(),
                supports_images: false,
                pending: BTreeMap::from([("call_test".into(), result)]),
                expected: expected.clone(),
                transcript: None,
                identity: first.clone(),
                expires: Instant::now() + TOOL_WAIT,
            })),
        };
        sessions
            .0
            .lock()
            .unwrap()
            .insert("call_test".into(), turn.clone());
        let mut messages = expected.clone();
        messages.push(json!({"role":"tool","tool_call_id":"call_test","content":"RESULT"}));
        let mut request = bridge::Completion {
            policy: bridge::PromptProfile::Append,
            model: "test".into(),
            alias: "test".into(),
            prompt: Vec::new(),
            system: String::new(),
            instructions_bytes: 0,
            stream: false,
            ignored_parameters: Vec::new(),
            tools: Vec::new(),
            messages: messages.clone(),
            results: vec![messages.last().unwrap().clone()],
        };
        assert!(sessions
            .resume(&request, &identity("other", Protocol::Chat), None)
            .is_err());
        request.messages[0]["content"] = json!("changed");
        assert!(sessions.resume(&request, &first, None).is_err());
        assert!(delivered.try_recv().is_err());
        request.messages = messages;
        request.messages[1]
            .as_object_mut()
            .unwrap()
            .remove("content");
        request.messages[1]["tool_calls"][0]["function"]["arguments"] =
            json!("{\"key\":\"alpha\"}");
        assert!(sessions.resume(&request, &first, None).unwrap().is_some());
        assert_eq!(delivered.recv().unwrap()["content"][0]["text"], "RESULT");
        assert!(sessions.resume(&request, &first, None).is_err());
        drop(events);
    }

    #[test]
    fn abandon_account_only_drops_target_sessions_and_live_counts_deduplicate() {
        let sessions = Sessions::default();
        sessions.set_max_live(128);
        assert_eq!(sessions.max_live(), 128);
        let mk_live = |id: &str| {
            let (_s, receiver) = mpsc::sync_channel(1);
            let (commands, _) = mpsc::sync_channel(1);
            let cancel = Arc::new(AtomicBool::new(false));
            let live = Live {
                account_id: id.into(),
                cancel: cancel.clone(),
                turn: Arc::new(Mutex::new(Session {
                    receiver,
                    commands,
                    cancel: cancel.clone(),
                    supports_images: false,
                    pending: BTreeMap::new(),
                    expected: Vec::new(),
                    transcript: None,
                    identity: identity(id, Protocol::Chat),
                    expires: Instant::now() + TOOL_WAIT,
                })),
            };
            (live, cancel)
        };
        let (acc_a, cancel_a) = mk_live("acc-a");
        let (acc_b, cancel_b) = mk_live("acc-b");
        {
            let mut map = sessions.0.lock().unwrap();
            // Two tool IDs sharing one live session for acc-a should count as 1.
            map.insert("call-a1".into(), acc_a.clone());
            map.insert("call-a2".into(), acc_a);
            map.insert("call-b1".into(), acc_b);
        }
        let counts = sessions.live_counts_by_account();
        assert_eq!(counts.get("acc-a"), Some(&1));
        assert_eq!(counts.get("acc-b"), Some(&1));

        sessions.abandon_account("acc-a");
        assert!(cancel_a.load(Ordering::Acquire));
        assert!(!cancel_b.load(Ordering::Acquire));
        let counts_after = sessions.live_counts_by_account();
        assert_eq!(counts_after.get("acc-a"), None);
        assert_eq!(counts_after.get("acc-b"), Some(&1));
    }
}
