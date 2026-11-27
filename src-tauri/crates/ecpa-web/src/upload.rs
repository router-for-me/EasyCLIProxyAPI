use axum::extract::Multipart;
use serde::Serialize;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

pub const MAX_UPLOAD_BYTES: usize = 64 * 1024 * 1024;
const UPLOADS_DIR_NAME: &str = "webui-uploads";
const STALE_UPLOAD_AGE: Duration = Duration::from_secs(2 * 3600);
const ALLOWED_EXTENSIONS: &[&str] = &["zip", "so", "dll", "dylib"];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedUpload {
    pub path: String,
    pub file_name: String,
    pub size: usize,
}

pub fn uploads_root(data_dir: &Path) -> PathBuf {
    data_dir.join(UPLOADS_DIR_NAME)
}

pub fn cleanup_stale_uploads(data_dir: &Path) {
    let root = uploads_root(data_dir);
    let Ok(entries) = fs::read_dir(&root) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let path = entry.path();
        let expired = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age >= STALE_UPLOAD_AGE);
        if expired {
            let _ = if path.is_dir() {
                fs::remove_dir_all(&path)
            } else {
                fs::remove_file(&path)
            };
        }
    }
}

pub fn sanitize_upload_filename(raw: &str) -> Result<String, String> {
    let base = raw
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .trim();
    if base.is_empty() || base == "." || base == ".." {
        return Err("Uploaded file name is missing or invalid".to_string());
    }
    let cleaned: String = base
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .collect();
    if cleaned.is_empty() || cleaned.starts_with('.') {
        return Err("Uploaded file name is invalid".to_string());
    }
    let ext = Path::new(&cleaned)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .ok_or_else(|| "Uploaded file must have a supported file extension".to_string())?;
    if !ALLOWED_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!(
            "Unsupported upload file type '.{ext}'. Allowed extensions: .zip, .so, .dll, .dylib"
        ));
    }
    Ok(cleaned)
}

fn random_hex(len_bytes: usize) -> Result<String, String> {
    let mut bytes = vec![0u8; len_bytes];
    getrandom::fill(&mut bytes).map_err(|error| format!("CSPRNG failed: {error}"))?;
    let mut hex = String::with_capacity(len_bytes * 2);
    for b in bytes {
        use std::fmt::Write as _;
        let _ = write!(&mut hex, "{b:02x}");
    }
    Ok(hex)
}

pub async fn stage_multipart_upload(
    data_dir: &Path,
    mut multipart: Multipart,
) -> Result<StagedUpload, String> {
    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|error| format!("Failed to read upload form field: {error}"))?
    {
        let Some(raw_name) = field.file_name().map(ToString::to_string) else {
            continue;
        };
        let file_name = sanitize_upload_filename(&raw_name)?;
        let stage_dir = uploads_root(data_dir).join(random_hex(12)?);
        fs::create_dir_all(&stage_dir)
            .map_err(|error| format!("Failed to create upload staging directory: {error}"))?;
        let dest = stage_dir.join(&file_name);
        let mut file = fs::File::create(&dest)
            .map_err(|error| format!("Failed to create staged upload file: {error}"))?;

        let mut total = 0usize;
        while let Some(chunk) = field
            .chunk()
            .await
            .map_err(|error| format!("Failed to read upload chunk: {error}"))?
        {
            total = total.saturating_add(chunk.len());
            if total > MAX_UPLOAD_BYTES {
                drop(file);
                let _ = fs::remove_dir_all(&stage_dir);
                return Err(format!(
                    "Uploaded file exceeds maximum allowed size ({} MiB)",
                    MAX_UPLOAD_BYTES / (1024 * 1024)
                ));
            }
            if let Err(error) = file.write_all(&chunk) {
                drop(file);
                let _ = fs::remove_dir_all(&stage_dir);
                return Err(format!("Failed to write staged upload file: {error}"));
            }
        }
        file.flush()
            .map_err(|error| format!("Failed to flush staged upload file: {error}"))?;

        return Ok(StagedUpload {
            path: ecpa_core::path_to_string(&dest),
            file_name,
            size: total,
        });
    }

    Err("No file field found in multipart upload".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_and_sanitizes_upload_filenames() {
        assert_eq!(sanitize_upload_filename("theme.zip").unwrap(), "theme.zip");
        assert_eq!(
            sanitize_upload_filename("../../evil/plugin.so").unwrap(),
            "plugin.so"
        );
        assert_eq!(
            sanitize_upload_filename(r"C:\Temp\my-plugin.DLL").unwrap(),
            "my-plugin.DLL"
        );
        assert!(sanitize_upload_filename("script.sh").is_err());
        assert!(sanitize_upload_filename(".hidden.zip").is_err());
        assert!(sanitize_upload_filename("noext").is_err());
    }
}
