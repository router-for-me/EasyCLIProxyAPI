//! Private stdio MCP adapter used only by the owned ACP process. Tool execution
//! is suspended here until a later API request supplies the client's result.
use super::*;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const LIMIT: u64 = 1024 * 1024;
pub(super) const TOOL_WAIT: Duration = Duration::from_secs(600);

pub(super) enum Event {
    Text(String),
    Tool {
        call: Value,
        result: mpsc::SyncSender<Value>,
    },
    Done(Result<(), String>),
}

pub(super) struct Transport {
    pub config: Value,
    stop: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}

pub(super) fn secret() -> Result<String, String> {
    let mut bytes = [0_u8; 24];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

impl Transport {
    pub fn start(
        tools: &[Value],
        events: mpsc::SyncSender<Event>,
        cancel: Arc<AtomicBool>,
    ) -> Result<Self, String> {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let key = secret()?;
        let helper = if cfg!(test) {
            std::env::var_os("ECPA_ACP_TEST_HELPER_EXE")
        } else {
            None
        };
        let executable = helper
            .clone()
            .map(PathBuf::from)
            .unwrap_or(std::env::current_exe().map_err(|e| e.to_string())?);
        let args = if cfg!(test) && helper.is_none() {
            vec![
                "--exact",
                "acp::tool_transport::tests::helper",
                "--nocapture",
            ]
        } else {
            vec!["--cpa-acp-tools"]
        };
        let config = json!({"name":"api_client","command":executable,"args":args,"env":[
            {"name":"ECPA_ACP_TOOL_PORT","value":port.to_string()},
            {"name":"ECPA_ACP_TOOL_KEY","value":key}
        ],"_meta":{"antigravity":{"forceAllToolsEager":true}}});
        let declarations: Vec<_> = tools.iter().map(|tool| {
            let f = &tool["function"];
            json!({"name":f["name"],"description":f["description"].as_str().unwrap_or(""),
                "inputSchema":f.get("parameters").cloned().unwrap_or_else(||json!({"type":"object","properties":{}}))})
        }).collect();
        let stop = cancel.clone();
        let worker = std::thread::spawn(move || {
            let mut handlers = Vec::new();
            while !cancel.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((socket, _)) => {
                        let key = key.clone();
                        let tools = declarations.clone();
                        let events = events.clone();
                        let cancel = cancel.clone();
                        handlers.push(std::thread::spawn(move || {
                            let _ = socket.set_read_timeout(Some(Duration::from_secs(2)));
                            let _ = socket.set_write_timeout(Some(Duration::from_secs(2)));
                            let frame = read_frame(&socket);
                            let request_id = frame.as_ref().ok().and_then(|frame|frame["request"].get("id")).cloned().unwrap_or(Value::Null);
                            let reply = frame.and_then(|frame| {
                                if frame["key"].as_str() != Some(key.as_str()) { return Err("Invalid internal tool key".into()); }
                                handle(&frame["request"], &tools, &events, &cancel)
                            }).unwrap_or_else(|error| json!({"jsonrpc":"2.0","id":request_id,"error":{"code":-32602,"message":error}}));
                            let _ = writeln!(&socket, "{reply}");
                        }));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(10))
                    }
                    Err(_) => break,
                }
                let mut index = 0;
                while index < handlers.len() {
                    if handlers[index].is_finished() {
                        let _ = handlers.swap_remove(index).join();
                    } else {
                        index += 1;
                    }
                }
            }
            for handler in handlers {
                let _ = handler.join();
            }
        });
        Ok(Self {
            config,
            stop,
            worker: Some(worker),
        })
    }
}

impl Drop for Transport {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn handle(
    request: &Value,
    tools: &[Value],
    events: &mpsc::SyncSender<Event>,
    cancel: &Arc<AtomicBool>,
) -> Result<Value, String> {
    let result = match request["method"].as_str().unwrap_or("") {
        "initialize" => {
            json!({"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"ecpa-client-tools","version":"1"}})
        }
        "tools/list" => json!({"tools":tools}),
        "tools/call" => {
            let name = request["params"]["name"]
                .as_str()
                .ok_or("Missing tool name")?;
            if !tools.iter().any(|tool| tool["name"] == name) {
                return Err("Unknown client tool".into());
            }
            let mut arguments = request["params"]
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            if !arguments.is_object() {
                return Err("Tool arguments must be an object".into());
            }
            // Antigravity adds presentation-only toolSummary to MCP inputs.
            // It is not a client argument unless explicitly declared there.
            let declaration = tools.iter().find(|tool| tool["name"] == name).unwrap();
            if declaration["inputSchema"]["properties"]
                .get("toolSummary")
                .is_none()
            {
                arguments.as_object_mut().unwrap().remove("toolSummary");
            }
            let (sender, receiver) = mpsc::sync_channel(1);
            let call = json!({"id":format!("call_acp_{}",secret()?),"type":"function","function":{"name":name,"arguments":arguments.to_string()}});
            events
                .try_send(Event::Tool {
                    call,
                    result: sender,
                })
                .map_err(|_| "Tool event queue unavailable")?;
            let deadline = Instant::now() + TOOL_WAIT;
            loop {
                if cancel.load(Ordering::Acquire) || Instant::now() >= deadline {
                    return Err("Client tool call cancelled or expired".into());
                }
                match receiver.recv_timeout(Duration::from_millis(50)) {
                    Ok(output) => break output,
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(_) => return Err("Client tool result channel closed".into()),
                }
            }
        }
        "ping" => json!({}),
        _ => {
            return Ok(
                json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32601,"message":"Method not found"}}),
            )
        }
    };
    Ok(json!({"jsonrpc":"2.0","id":request["id"],"result":result}))
}

fn read_frame(socket: &TcpStream) -> Result<Value, String> {
    let mut line = String::new();
    BufReader::new(socket)
        .take(LIMIT + 1)
        .read_line(&mut line)
        .map_err(|e| e.to_string())?;
    if line.len() as u64 > LIMIT || !line.ends_with('\n') {
        return Err("Invalid internal tool frame".into());
    }
    serde_json::from_str(&line).map_err(|e| e.to_string())
}

pub(crate) fn run_helper() -> Result<(), String> {
    let port: u16 = std::env::var("ECPA_ACP_TOOL_PORT")
        .map_err(|_| "Missing tool port")?
        .parse()
        .map_err(|_| "Invalid tool port")?;
    let key = std::env::var("ECPA_ACP_TOOL_KEY").map_err(|_| "Missing tool key")?;
    let mut input = BufReader::new(std::io::stdin());
    loop {
        let mut line = String::new();
        let length = input
            .by_ref()
            .take(LIMIT + 1)
            .read_line(&mut line)
            .map_err(|e| e.to_string())?;
        if length == 0 {
            return Ok(());
        }
        if length as u64 > LIMIT {
            return Err("MCP request exceeds 1 MiB".into());
        }
        let request: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
        if request.get("id").is_none() {
            continue;
        }
        let mut socket =
            TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)).map_err(|e| e.to_string())?;
        socket
            .set_read_timeout(Some(TOOL_WAIT + Duration::from_secs(5)))
            .map_err(|e| e.to_string())?;
        socket
            .set_write_timeout(Some(Duration::from_secs(2)))
            .map_err(|e| e.to_string())?;
        writeln!(socket, "{}", json!({"key":key,"request":request})).map_err(|e| e.to_string())?;
        let response = read_frame(&socket)?;
        println!("{response}");
        std::io::stdout().flush().map_err(|e| e.to_string())?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_result_waits_for_client_and_cancellation_releases_it() {
        let tools = vec![json!({"name":"lookup","inputSchema":{"type":"object","properties":{"key":{"type":"string"}}}})];
        for cancelled in [false, true] {
            let (sender, receiver) = mpsc::sync_channel(2);
            let cancel = Arc::new(AtomicBool::new(false));
            let flag = cancel.clone(); let declarations = tools.clone();
            let worker = std::thread::spawn(move || handle(&json!({"id":9,"method":"tools/call","params":{"name":"lookup","arguments":{"key":"alpha","toolSummary":"presentation"}}}), &declarations, &sender, &flag));
            let Event::Tool { call, result } = receiver.recv_timeout(Duration::from_secs(2)).unwrap() else { panic!("missing tool event") };
            assert_eq!(call["function"]["arguments"], "{\"key\":\"alpha\"}");
            assert!(!worker.is_finished(), "MCP call must wait for the client result");
            if cancelled { cancel.store(true,Ordering::Release); assert!(worker.join().unwrap().is_err()); }
            else { result.send(json!({"content":[{"type":"text","text":"RESULT"}]})).unwrap(); let response = worker.join().unwrap().unwrap(); assert_eq!(response["id"],9); assert_eq!(response["result"]["content"][0]["text"],"RESULT"); }
        }
    }

    #[test]
    fn helper() {
        if std::env::var_os("ECPA_ACP_TOOL_PORT").is_some() {
            super::run_helper().unwrap();
        }
    }
}
