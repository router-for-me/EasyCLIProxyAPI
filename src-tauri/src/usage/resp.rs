use std::time::Duration;

use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    time::timeout,
};

const USAGE_CHANNEL: &str = "usage";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const IO_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_BULK_BYTES: usize = 4 * 1024 * 1024;
const MAX_RESP_LINE_BYTES: usize = 4096;
const MAX_NESTING_DEPTH: usize = 4;
const SUBSCRIPTION_MAX_FRAME_BYTES: usize = MAX_BULK_BYTES + MAX_RESP_LINE_BYTES;
const SUBSCRIPTION_MAX_ARRAY_LENGTH: usize = 16;
const SUBSCRIPTION_MAX_TOTAL_BULK_BYTES: usize = MAX_BULK_BYTES;
const QUEUE_MAX_ARRAY_LENGTH: usize = 10_000;
const QUEUE_MAX_TOTAL_BULK_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Copy)]
struct RespLimits {
    max_frame_bytes: usize,
    max_array_length: usize,
    max_total_bulk_bytes: usize,
}

const SUBSCRIPTION_LIMITS: RespLimits = RespLimits {
    max_frame_bytes: SUBSCRIPTION_MAX_FRAME_BYTES,
    max_array_length: SUBSCRIPTION_MAX_ARRAY_LENGTH,
    max_total_bulk_bytes: SUBSCRIPTION_MAX_TOTAL_BULK_BYTES,
};

fn queue_limits(max_array_length: usize) -> RespLimits {
    let max_array_length = max_array_length.min(QUEUE_MAX_ARRAY_LENGTH);
    RespLimits {
        max_frame_bytes: QUEUE_MAX_TOTAL_BULK_BYTES
            .saturating_add((max_array_length + 1).saturating_mul(MAX_RESP_LINE_BYTES + 3)),
        max_array_length,
        max_total_bulk_bytes: QUEUE_MAX_TOTAL_BULK_BYTES,
    }
}

pub(super) struct UsageSubscription {
    stream: TcpStream,
    read_buffer: Vec<u8>,
}

impl UsageSubscription {
    pub(super) async fn connect(port: u16, management_key: &str) -> Result<Self, String> {
        let mut subscription = Self::connect_authenticated(port, management_key).await?;
        subscription
            .send_command(&["SUBSCRIBE", USAGE_CHANNEL])
            .await?;
        let acknowledgement = subscription.read_frame().await?;
        if !is_subscription_ack(&acknowledgement) {
            return Err("CPA 未确认 usage 订阅".to_string());
        }
        Ok(subscription)
    }

    async fn connect_authenticated(port: u16, management_key: &str) -> Result<Self, String> {
        let address = format!("127.0.0.1:{port}");
        let stream = timeout(CONNECT_TIMEOUT, TcpStream::connect(&address))
            .await
            .map_err(|_| format!("连接 CPA usage 订阅超时: {address}"))?
            .map_err(|error| format!("连接 CPA usage 订阅失败 {address}: {error}"))?;
        let mut subscription = Self {
            stream,
            read_buffer: Vec::new(),
        };
        subscription.send_command(&["AUTH", management_key]).await?;
        match subscription.read_frame().await? {
            RespValue::Simple(value) if value.eq_ignore_ascii_case("OK") => {}
            RespValue::Error(error) => return Err(format!("CPA usage 订阅认证失败: {error}")),
            value => return Err(format!("CPA usage 订阅认证响应无效: {}", value.kind())),
        }
        Ok(subscription)
    }

    pub(super) async fn next_message(&mut self) -> Result<String, String> {
        loop {
            let frame = self.read_frame().await?;
            if let Some(payload) = subscription_payload(&frame) {
                return Ok(payload);
            }
            if let RespValue::Error(error) = frame {
                return Err(format!("CPA usage 订阅返回错误: {error}"));
            }
        }
    }

    async fn send_command(&mut self, parts: &[&str]) -> Result<(), String> {
        let mut command = format!("*{}\r\n", parts.len()).into_bytes();
        for part in parts {
            command.extend_from_slice(format!("${}\r\n", part.len()).as_bytes());
            command.extend_from_slice(part.as_bytes());
            command.extend_from_slice(b"\r\n");
        }
        timeout(IO_TIMEOUT, self.stream.write_all(&command))
            .await
            .map_err(|_| "写入 CPA usage 订阅命令超时".to_string())?
            .map_err(|error| format!("写入 CPA usage 订阅命令失败: {error}"))
    }

    async fn read_frame(&mut self) -> Result<RespValue, String> {
        self.read_frame_with_limits(SUBSCRIPTION_LIMITS).await
    }

    async fn read_frame_with_limits(&mut self, limits: RespLimits) -> Result<RespValue, String> {
        loop {
            let mut remaining_bulk_bytes = limits.max_total_bulk_bytes;
            match parse_resp_frame_with_limits(
                &self.read_buffer,
                0,
                0,
                limits,
                &mut remaining_bulk_bytes,
            )? {
                ParseResult::Complete(value, consumed) => {
                    if consumed > limits.max_frame_bytes {
                        return Err("CPA usage RESP 响应超过大小限制".to_string());
                    }
                    self.read_buffer.drain(..consumed);
                    return Ok(value);
                }
                ParseResult::Incomplete => {}
            }
            if self.read_buffer.len() >= limits.max_frame_bytes {
                return Err("CPA usage RESP 响应超过大小限制".to_string());
            }
            let mut chunk = [0_u8; 8192];
            let read = timeout(IO_TIMEOUT, self.stream.read(&mut chunk))
                .await
                .map_err(|_| "读取 CPA usage 订阅响应超时".to_string())?
                .map_err(|error| format!("读取 CPA usage 订阅响应失败: {error}"))?;
            if read == 0 {
                return Err("CPA usage 订阅连接已关闭".to_string());
            }
            self.read_buffer.extend_from_slice(&chunk[..read]);
        }
    }
}

pub(super) async fn pull_usage_queue(
    port: u16,
    management_key: &str,
    queue_key: &str,
    count: usize,
) -> Result<Vec<String>, String> {
    if count == 0 || count > QUEUE_MAX_ARRAY_LENGTH {
        return Err(format!(
            "CPA usage 队列批量大小必须在 1..={QUEUE_MAX_ARRAY_LENGTH} 之间"
        ));
    }
    let mut connection = UsageSubscription::connect_authenticated(port, management_key).await?;
    let count_argument = count.to_string();
    connection
        .send_command(&["LPOP", queue_key, count_argument.as_str()])
        .await?;
    match connection
        .read_frame_with_limits(queue_limits(count))
        .await?
    {
        RespValue::Array(Some(values)) => values
            .into_iter()
            .map(|value| {
                value
                    .text()
                    .ok_or_else(|| "CPA usage 队列包含非文本消息".to_string())
            })
            .collect(),
        RespValue::Bulk(Some(value)) => String::from_utf8(value)
            .map(|value| vec![value])
            .map_err(|_| "CPA usage 队列消息不是 UTF-8".to_string()),
        RespValue::Array(None) | RespValue::Bulk(None) => Ok(Vec::new()),
        RespValue::Error(error) => Err(format!("CPA usage 队列 LPOP 失败: {error}")),
        value => Err(format!("CPA usage 队列 LPOP 响应无效: {}", value.kind())),
    }
}

#[derive(Debug)]
enum RespValue {
    Simple(String),
    Error(String),
    Integer(i64),
    Bulk(Option<Vec<u8>>),
    Array(Option<Vec<RespValue>>),
}

impl RespValue {
    fn kind(&self) -> &'static str {
        match self {
            Self::Simple(_) => "simple string",
            Self::Error(_) => "error",
            Self::Integer(_) => "integer",
            Self::Bulk(_) => "bulk string",
            Self::Array(_) => "array",
        }
    }

    fn text(&self) -> Option<String> {
        match self {
            Self::Simple(value) | Self::Error(value) => Some(value.clone()),
            Self::Bulk(Some(value)) => String::from_utf8(value.clone()).ok(),
            Self::Integer(value) => Some(value.to_string()),
            Self::Bulk(None) | Self::Array(_) => None,
        }
    }
}

enum ParseResult {
    Complete(RespValue, usize),
    Incomplete,
}

fn parse_resp_frame_with_limits(
    input: &[u8],
    offset: usize,
    depth: usize,
    limits: RespLimits,
    remaining_bulk_bytes: &mut usize,
) -> Result<ParseResult, String> {
    if depth > MAX_NESTING_DEPTH {
        return Err("CPA usage RESP 响应嵌套过深".to_string());
    }
    let Some(prefix) = input.get(offset).copied() else {
        return Ok(ParseResult::Incomplete);
    };
    match prefix {
        b'+' | b'-' | b':' => {
            let Some((line, next)) = resp_line(input, offset + 1)? else {
                return Ok(ParseResult::Incomplete);
            };
            let text = String::from_utf8(line.to_vec())
                .map_err(|_| "CPA usage RESP 文本响应不是 UTF-8".to_string())?;
            let value = match prefix {
                b'+' => RespValue::Simple(text),
                b'-' => RespValue::Error(text),
                _ => RespValue::Integer(
                    text.parse::<i64>()
                        .map_err(|_| "CPA usage RESP 整数响应无效".to_string())?,
                ),
            };
            Ok(ParseResult::Complete(value, next - offset))
        }
        b'$' => {
            let Some((line, data_start)) = resp_line(input, offset + 1)? else {
                return Ok(ParseResult::Incomplete);
            };
            let length = parse_resp_length(line)?;
            if length < 0 {
                return Ok(ParseResult::Complete(
                    RespValue::Bulk(None),
                    data_start - offset,
                ));
            }
            let length =
                usize::try_from(length).map_err(|_| "CPA usage RESP 字符串长度无效".to_string())?;
            if length > MAX_BULK_BYTES {
                return Err("CPA usage RESP 字符串超过大小限制".to_string());
            }
            if length > *remaining_bulk_bytes {
                return Err("CPA usage RESP 响应超过总字符串大小限制".to_string());
            }
            let data_end = data_start.saturating_add(length);
            let frame_end = data_end.saturating_add(2);
            if input.len() < frame_end {
                return Ok(ParseResult::Incomplete);
            }
            if input.get(data_end..frame_end) != Some(b"\r\n") {
                return Err("CPA usage RESP 字符串结尾无效".to_string());
            }
            *remaining_bulk_bytes -= length;
            Ok(ParseResult::Complete(
                RespValue::Bulk(Some(input[data_start..data_end].to_vec())),
                frame_end - offset,
            ))
        }
        b'*' => {
            let Some((line, mut next)) = resp_line(input, offset + 1)? else {
                return Ok(ParseResult::Incomplete);
            };
            let length = parse_resp_length(line)?;
            if length < 0 {
                return Ok(ParseResult::Complete(RespValue::Array(None), next - offset));
            }
            let length =
                usize::try_from(length).map_err(|_| "CPA usage RESP 数组长度无效".to_string())?;
            if length > limits.max_array_length {
                return Err("CPA usage RESP 数组超过大小限制".to_string());
            }
            let mut values = Vec::with_capacity(length);
            for _ in 0..length {
                match parse_resp_frame_with_limits(
                    input,
                    next,
                    depth + 1,
                    limits,
                    remaining_bulk_bytes,
                )? {
                    ParseResult::Complete(value, consumed) => {
                        values.push(value);
                        next = next.saturating_add(consumed);
                    }
                    ParseResult::Incomplete => return Ok(ParseResult::Incomplete),
                }
            }
            Ok(ParseResult::Complete(
                RespValue::Array(Some(values)),
                next - offset,
            ))
        }
        _ => Err("CPA usage RESP 响应类型无效".to_string()),
    }
}

fn resp_line(input: &[u8], start: usize) -> Result<Option<(&[u8], usize)>, String> {
    let Some(remaining) = input.get(start..) else {
        return Ok(None);
    };
    let Some(relative_end) = remaining.windows(2).position(|pair| pair == b"\r\n") else {
        if remaining.len() > MAX_RESP_LINE_BYTES + 1 {
            return Err("CPA usage RESP 行超过大小限制".to_string());
        }
        return Ok(None);
    };
    if relative_end > MAX_RESP_LINE_BYTES {
        return Err("CPA usage RESP 行超过大小限制".to_string());
    }
    let end = start + relative_end;
    Ok(Some((&input[start..end], end + 2)))
}

fn parse_resp_length(value: &[u8]) -> Result<i64, String> {
    std::str::from_utf8(value)
        .map_err(|_| "CPA usage RESP 长度不是 UTF-8".to_string())?
        .parse::<i64>()
        .map_err(|_| "CPA usage RESP 长度无效".to_string())
}

fn is_subscription_ack(value: &RespValue) -> bool {
    let RespValue::Array(Some(values)) = value else {
        return false;
    };
    values.len() >= 2
        && values[0]
            .text()
            .is_some_and(|value| value.eq_ignore_ascii_case("subscribe"))
        && values[1].text().as_deref() == Some(USAGE_CHANNEL)
}

fn subscription_payload(value: &RespValue) -> Option<String> {
    let RespValue::Array(Some(values)) = value else {
        return None;
    };
    if values.len() < 3
        || !values[0]
            .text()
            .is_some_and(|value| value.eq_ignore_ascii_case("message"))
        || values[1].text().as_deref() != Some(USAGE_CHANNEL)
    {
        return None;
    }
    values[2].text()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[test]
    fn parses_usage_subscription_message() {
        let input = b"*3\r\n$7\r\nmessage\r\n$5\r\nusage\r\n$16\r\n{\"request_id\":1}\r\n";
        let mut remaining_bulk_bytes = SUBSCRIPTION_LIMITS.max_total_bulk_bytes;
        let ParseResult::Complete(value, consumed) = parse_resp_frame_with_limits(
            input,
            0,
            0,
            SUBSCRIPTION_LIMITS,
            &mut remaining_bulk_bytes,
        )
        .unwrap() else {
            panic!("expected complete RESP frame");
        };
        assert_eq!(consumed, input.len());
        assert_eq!(
            subscription_payload(&value).as_deref(),
            Some("{\"request_id\":1}")
        );
    }

    #[test]
    fn rejects_oversized_arrays() {
        let mut remaining_bulk_bytes = SUBSCRIPTION_LIMITS.max_total_bulk_bytes;
        let error = match parse_resp_frame_with_limits(
            b"*17\r\n",
            0,
            0,
            SUBSCRIPTION_LIMITS,
            &mut remaining_bulk_bytes,
        ) {
            Err(error) => error,
            _ => panic!("expected oversized RESP array to fail"),
        };
        assert!(error.contains("数组超过大小限制"));
    }

    #[tokio::test]
    async fn authenticates_subscribes_and_receives_usage_payload() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let expected_auth = b"*2\r\n$4\r\nAUTH\r\n$6\r\nsecret\r\n";
            let mut auth = vec![0_u8; expected_auth.len()];
            stream.read_exact(&mut auth).await.unwrap();
            assert_eq!(auth, expected_auth);
            stream.write_all(b"+OK\r\n").await.unwrap();

            let expected_subscribe = b"*2\r\n$9\r\nSUBSCRIBE\r\n$5\r\nusage\r\n";
            let mut subscribe = vec![0_u8; expected_subscribe.len()];
            stream.read_exact(&mut subscribe).await.unwrap();
            assert_eq!(subscribe, expected_subscribe);
            stream
                .write_all(b"*3\r\n$9\r\nsubscribe\r\n$5\r\nusage\r\n:1\r\n")
                .await
                .unwrap();
            stream
                .write_all(b"*3\r\n$7\r\nmessage\r\n$5\r\nusage\r\n$16\r\n{\"request_id\":1}\r\n")
                .await
                .unwrap();
        });

        let mut subscription = UsageSubscription::connect(port, "secret").await.unwrap();
        assert_eq!(
            subscription.next_message().await.unwrap(),
            "{\"request_id\":1}"
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn authenticates_and_pulls_usage_queue_batch() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let expected_auth = b"*2\r\n$4\r\nAUTH\r\n$6\r\nsecret\r\n";
            let mut auth = vec![0_u8; expected_auth.len()];
            stream.read_exact(&mut auth).await.unwrap();
            assert_eq!(auth, expected_auth);
            stream.write_all(b"+OK\r\n").await.unwrap();

            let expected_pop = b"*3\r\n$4\r\nLPOP\r\n$5\r\nusage\r\n$2\r\n17\r\n";
            let mut pop = vec![0_u8; expected_pop.len()];
            stream.read_exact(&mut pop).await.unwrap();
            assert_eq!(pop, expected_pop);
            let mut response = "*17\r\n".to_string();
            for request_id in 0..17 {
                let message = format!("{{\"request_id\":{request_id}}}");
                response.push_str(&format!("${}\r\n{message}\r\n", message.len()));
            }
            stream.write_all(response.as_bytes()).await.unwrap();
        });

        let messages = pull_usage_queue(port, "secret", "usage", 17).await.unwrap();
        assert_eq!(messages.len(), 17);
        assert_eq!(
            messages.first().map(String::as_str),
            Some("{\"request_id\":0}")
        );
        assert_eq!(
            messages.last().map(String::as_str),
            Some("{\"request_id\":16}")
        );
        server.await.unwrap();
    }
}
