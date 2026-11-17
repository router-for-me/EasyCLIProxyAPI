//! Retains the live ACP turn while an OpenAI client executes a tool. A tool
//! response completes one HTTP call, not the underlying ACP prompt.
use super::tool_transport::{Event, Transport, TOOL_WAIT};
use super::*;
use std::sync::mpsc;
use std::time::{Duration, Instant};

#[derive(Default)]
pub(super) struct Sessions(Mutex<BTreeMap<String, Arc<Mutex<Session>>>>);

pub(super) struct Session {
    receiver: mpsc::Receiver<Event>,
    cancel: Arc<AtomicBool>,
    pending: BTreeMap<String, mpsc::SyncSender<Value>>,
    expected: Vec<Value>,
    identity: Value,
    expires: Instant,
}

impl Drop for Session {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Release);
    }
}

impl Sessions {
    pub fn clear(&self) {
        let sessions = self
            .0
            .lock()
            .map(|mut sessions| std::mem::take(&mut *sessions))
            .unwrap_or_default();
        for session in sessions.values() {
            if let Ok(session) = session.lock() {
                session.cancel.store(true, Ordering::Release);
            }
        }
    }

    pub fn resume(
        &self,
        request: &bridge::Completion,
        identity: &Value,
    ) -> Result<Option<Arc<Mutex<Session>>>, String> {
        let Some(first) = request.results.first() else {
            return Ok(None);
        };
        let id = first["tool_call_id"]
            .as_str()
            .ok_or("Missing tool_call_id")?;
        let mut sessions = self.0.lock().map_err(|_| "Agent sessions unavailable")?;
        let session = sessions
            .get(id)
            .cloned()
            .ok_or("Unknown or expired ACP tool call; restart this agent turn")?;
        {
            let mut turn = session.lock().map_err(|_| "Agent session unavailable")?;
            if turn.cancel.load(Ordering::Acquire) || Instant::now() >= turn.expires {
                return Err("ACP tool call expired; restart this agent turn".into());
            }
            if &turn.identity != identity {
                return Err("ACP tool result does not match its account, model or tools".into());
            }
            let history_len = request.messages.len() - request.results.len();
            if canonical_history(&request.messages[..history_len])
                != canonical_history(&turn.expected)
            {
                return Err("ACP tool result history does not match the pending agent turn".into());
            }
            if request.results.len() != turn.pending.len() {
                return Err("Return all pending ACP tool results in one request".into());
            }
            let mut ids = std::collections::BTreeSet::new();
            for result in &request.results {
                let id = result["tool_call_id"]
                    .as_str()
                    .ok_or("Missing tool_call_id")?;
                if !ids.insert(id.to_string()) || !turn.pending.contains_key(id) {
                    return Err("Unknown or duplicate ACP tool result".into());
                }
                bridge::message_text(result, "tool")?;
            }
            for result in &request.results {
                let id = result["tool_call_id"].as_str().unwrap();
                let content = bridge::message_text(result, "tool")?;
                turn.pending
                    .remove(id)
                    .unwrap()
                    .send(json!({"content":[{"type":"text","text":content}]}))
                    .map_err(|_| "ACP tool execution has ended")?;
                sessions.remove(id);
            }
            turn.expected = request.messages.clone();
        }
        Ok(Some(session))
    }

    pub fn start(
        &self,
        request: &bridge::Completion,
        identity: Value,
        executable: &Path,
        profile: &Path,
        proxy: &str,
        spawn: bridge::SpawnClient,
    ) -> Result<Arc<Mutex<Session>>, String> {
        {
            let mut sessions = self.0.lock().map_err(|_| "Agent sessions unavailable")?;
            sessions.retain(|_, session| {
                session
                    .try_lock()
                    .map(|s| !s.cancel.load(Ordering::Acquire) && Instant::now() < s.expires)
                    .unwrap_or(true)
            });
            if sessions.len() >= 16 {
                return Err("Too many ACP turns waiting for client tool results".into());
            }
        }
        let (sender, receiver) = mpsc::sync_channel(128);
        let cancel = Arc::new(AtomicBool::new(false));
        let session = Arc::new(Mutex::new(Session {
            receiver,
            cancel: cancel.clone(),
            pending: BTreeMap::new(),
            expected: request.messages.clone(),
            identity,
            expires: Instant::now() + TOOL_WAIT,
        }));
        let tools = request.tools.clone();
        let system = request.system.clone();
        let text = request.text.clone();
        let model = request.model.clone();
        let executable = executable.to_path_buf();
        let profile = profile.to_path_buf();
        let proxy = proxy.to_string();
        std::thread::spawn(move || {
            let result = (|| {
                let transport = Transport::start(&tools, sender.clone(), cancel.clone())?;
                let mut client = spawn(&executable, &profile, &proxy)?;
                client.initialize(&cancel)?;
                client.allow_api_tools(&tools);
                let instructions = format!("{system}\n\nThe API client provides tools through api_client. Use only those tools when needed. Do not use local built-in tools. Their results will arrive from the API client; wait for each result before continuing.");
                let session = client.api_session(
                    &profile,
                    &instructions,
                    &[transport.config.clone()],
                    &cancel,
                )?;
                client.model(&session, &model, &cancel)?;
                let mut bytes = 0_usize;
                let result = client.agent_prompt(json!({"sessionId":session["sessionId"],"prompt":[{"type":"text","text":text}]}), &cancel, |update| {
                    if update["sessionUpdate"] == "agent_message_chunk" && update["content"]["type"] == "text" {
                        if let Some(text) = update["content"]["text"].as_str() {
                            bytes = bytes.saturating_add(text.len());
                            if bytes > 1024*1024 || sender.try_send(Event::Text(text.into())).is_err() { cancel.store(true, Ordering::Release); }
                        }
                    }
                })?;
                if result["stopReason"] != "end_turn" {
                    return Err(format!("ACP agent turn stopped: {}", result["stopReason"]));
                }
                Ok(())
            })();
            let _ = sender.try_send(Event::Done(result));
        });
        Ok(session)
    }

    pub fn collect<F: FnMut(&str)>(
        &self,
        session: &Arc<Mutex<Session>>,
        request: &bridge::Completion,
        disconnected: &Arc<AtomicBool>,
        mut chunk: F,
    ) -> Result<bridge::Output, String> {
        let mut turn = session.lock().map_err(|_| "Agent session unavailable")?;
        let mut text = String::new();
        let mut calls = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(150);
        loop {
            if disconnected.load(Ordering::Acquire) {
                turn.cancel.store(true, Ordering::Release);
                return Err("ACP API client disconnected".into());
            }
            let wait = if calls.is_empty() {
                Duration::from_millis(50)
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
                        .ok_or("Missing generated tool id")?
                        .to_string();
                    turn.pending.insert(id, result);
                    calls.push(call);
                }
                Ok(Event::Done(result)) => {
                    result?;
                    break;
                }
                Err(mpsc::RecvTimeoutError::Timeout) if !calls.is_empty() => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if Instant::now() >= deadline {
                        turn.cancel.store(true, Ordering::Release);
                        return Err("ACP agent response timed out".into());
                    }
                }
                Err(_) => return Err("ACP agent execution channel closed".into()),
            }
        }
        let output = bridge::Output { text, calls };
        if output.calls.is_empty() && output.text.trim().is_empty() {
            return Err("ACP Agent ended without an assistant reply or a client tool call".into());
        }
        if !output.calls.is_empty() {
            turn.expected = request.messages.clone();
            turn.expected.push(output.message());
            turn.expires = Instant::now() + TOOL_WAIT;
            let ids: Vec<_> = output
                .calls
                .iter()
                .filter_map(|call| call["id"].as_str().map(str::to_owned))
                .collect();
            drop(turn);
            let mut sessions = self.0.lock().map_err(|_| "Agent sessions unavailable")?;
            for id in &ids {
                sessions.insert(id.clone(), session.clone());
            }
            drop(sessions);
            let weak = Arc::downgrade(session);
            std::thread::spawn(move || {
                std::thread::sleep(TOOL_WAIT);
                if let Some(session) = weak.upgrade() {
                    if let Ok(turn) = session.lock() {
                        if Instant::now() >= turn.expires {
                            turn.cancel.store(true, Ordering::Release);
                        }
                    }
                }
            });
        }
        Ok(output)
    }
}

// SDKs and CPA may represent an empty assistant content as null, an empty
// string, or omit it. Compare semantic history, including parsed arguments.
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

#[cfg(test)]
mod tests {
    use super::*;

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
        let identity = json!({"account":"first"});
        let turn = Arc::new(Mutex::new(Session {
            receiver,
            cancel,
            pending: BTreeMap::from([("call_test".into(), result)]),
            expected: expected.clone(),
            identity: identity.clone(),
            expires: Instant::now() + TOOL_WAIT,
        }));
        sessions
            .0
            .lock()
            .unwrap()
            .insert("call_test".into(), turn.clone());
        let mut messages = expected.clone();
        messages.push(json!({"role":"tool","tool_call_id":"call_test","content":"RESULT"}));
        let mut request = bridge::Completion {
            model: "test".into(),
            alias: "test".into(),
            text: String::new(),
            system: String::new(),
            stream: false,
            ignored_parameters: Vec::new(),
            tools: Vec::new(),
            messages: messages.clone(),
            results: vec![messages.last().unwrap().clone()],
        };
        assert!(sessions
            .resume(&request, &json!({"account":"other"}))
            .is_err());
        request.messages[0]["content"] = json!("changed");
        assert!(sessions.resume(&request, &identity).is_err());
        assert!(delivered.try_recv().is_err());
        request.messages = messages;
        request.messages[1]
            .as_object_mut()
            .unwrap()
            .remove("content");
        request.messages[1]["tool_calls"][0]["function"]["arguments"] =
            json!("{\"key\":\"alpha\"}");
        assert!(sessions.resume(&request, &identity).unwrap().is_some());
        assert_eq!(delivered.recv().unwrap()["content"][0]["text"], "RESULT");
        assert!(sessions.resume(&request, &identity).is_err());
        drop(events);
    }
}
