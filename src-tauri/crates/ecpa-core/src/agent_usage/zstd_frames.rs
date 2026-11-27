use std::fs::File;
use std::io::{BufRead, BufReader, Cursor, Read};
use std::path::Path;

const ZSTD_MAGIC: u32 = 0xFD2F_B528;
const MAX_DECOMPRESSED_BYTES: usize = 256 * 1024 * 1024;

/// Scans concatenated zstd frames in `buffer` by header structure without decompressing.
/// Returns byte ranges of complete frames so a torn trailing frame written by a live
/// process is cleanly skipped instead of failing the entire file.
pub(super) fn scan_zstd_frames(buffer: &[u8]) -> (Vec<(usize, usize)>, Option<usize>) {
    let mut frames = Vec::new();
    let mut offset = 0usize;
    while offset < buffer.len() {
        let start = offset;
        if buffer.len() - offset < 4 {
            return (frames, Some(start));
        }
        let magic = u32::from_le_bytes([
            buffer[offset],
            buffer[offset + 1],
            buffer[offset + 2],
            buffer[offset + 3],
        ]);
        if magic != ZSTD_MAGIC {
            return (frames, Some(start));
        }
        offset += 4;
        if offset == buffer.len() {
            return (frames, Some(start));
        }
        let descriptor = buffer[offset];
        offset += 1;
        if descriptor & 0x18 != 0 {
            return (frames, Some(start));
        }
        let content_size_flag = descriptor >> 6;
        let single_segment = descriptor & 0x20 != 0;
        let checksum = descriptor & 0x04 != 0;
        let dictionary_flag = descriptor & 0x03;
        let dictionary_bytes = if dictionary_flag == 3 {
            4
        } else {
            usize::from(dictionary_flag)
        };
        let content_size_bytes = if content_size_flag == 0 {
            if single_segment {
                1
            } else {
                0
            }
        } else {
            1usize << content_size_flag
        };
        let window_descriptor_bytes = if single_segment { 0 } else { 1 };
        let remaining = window_descriptor_bytes + dictionary_bytes + content_size_bytes;
        if buffer.len() - offset < remaining {
            return (frames, Some(start));
        }
        offset += remaining;

        loop {
            if buffer.len() - offset < 3 {
                return (frames, Some(start));
            }
            let header = u32::from(buffer[offset])
                | (u32::from(buffer[offset + 1]) << 8)
                | (u32::from(buffer[offset + 2]) << 16);
            offset += 3;
            let last_block = header & 1 != 0;
            let block_type = (header >> 1) & 0x03;
            let block_size = (header >> 3) as usize;
            if block_type == 0x03 {
                return (frames, Some(start));
            }
            let payload_bytes = if block_type == 0x01 { 1 } else { block_size };
            if buffer.len() - offset < payload_bytes {
                return (frames, Some(start));
            }
            offset += payload_bytes;
            if last_block {
                break;
            }
        }
        if checksum {
            if buffer.len() - offset < 4 {
                return (frames, Some(start));
            }
            offset += 4;
        }
        frames.push((start, offset));
    }
    (frames, None)
}

pub(super) fn is_zstd_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("zst") || ext.eq_ignore_ascii_case("zstd"))
}

/// Decompresses all complete concatenated zstd frames in a file into memory,
/// enforcing a safety limit on total uncompressed bytes.
pub(super) fn read_zstd_bytes(path: &Path) -> Result<Vec<u8>, ()> {
    let raw = std::fs::read(path).map_err(|_| ())?;
    if raw.is_empty() {
        return Ok(Vec::new());
    }
    let (frames, _) = scan_zstd_frames(&raw);
    if frames.is_empty() {
        return Ok(Vec::new());
    }
    let mut output = Vec::new();
    for (start, end) in frames {
        let mut decoder = zstd::stream::read::Decoder::new(&raw[start..end]).map_err(|_| ())?;
        let budget = MAX_DECOMPRESSED_BYTES.saturating_sub(output.len());
        if budget == 0 {
            break;
        }
        let mut limited = (&mut decoder).take(budget as u64);
        limited.read_to_end(&mut output).map_err(|_| ())?;
    }
    Ok(output)
}

/// Opens a plain or zstd-compressed JSONL file as a `BufRead` stream.
/// For `.zst` (single-stream compressed files), streams decompression lazily so
/// peeking header lines does not decompress the entire file.
/// For `.zstd` (concatenated multi-frame append logs), scans complete frames to
/// tolerate a partially-written trailing frame.
pub(super) fn open_jsonl_reader(path: &Path) -> Result<Box<dyn BufRead>, ()> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default();
    if ext.eq_ignore_ascii_case("zstd") {
        let decoded = read_zstd_bytes(path)?;
        Ok(Box::new(BufReader::new(Cursor::new(decoded))))
    } else if ext.eq_ignore_ascii_case("zst") {
        let file = File::open(path).map_err(|_| ())?;
        let decoder = zstd::stream::read::Decoder::new(BufReader::new(file)).map_err(|_| ())?;
        Ok(Box::new(BufReader::new(decoder)))
    } else {
        let file = File::open(path).map_err(|_| ())?;
        Ok(Box::new(BufReader::new(file)))
    }
}
