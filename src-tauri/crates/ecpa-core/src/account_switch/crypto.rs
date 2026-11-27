use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use std::fs;
use std::path::Path;

pub(crate) const ENVELOPE_PREFIX: &str = "ECPA_ENC_V1:";
const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;

pub(crate) fn fill_random_bytes(target: &mut [u8]) -> Result<(), String> {
    getrandom::fill(target).map_err(|error| format!("Failed to generate random bytes: {error}"))
}

pub(crate) fn write_atomic_secure(path: &Path, content: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Invalid target file path: {}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create directory {}: {error}", parent.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
    }

    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("data");
    let mut suffix = [0u8; 6];
    let _ = fill_random_bytes(&mut suffix);
    let hex: String = suffix.iter().map(|b| format!("{b:02x}")).collect();
    let temp_path = parent.join(format!(".{file_name}.tmp-{}-{hex}", std::process::id()));

    {
        use std::io::Write;
        let mut options = fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp_path).map_err(|error| {
            format!(
                "Failed to open temporary file {}: {error}",
                temp_path.display()
            )
        })?;
        file.write_all(content).map_err(|error| {
            let _ = fs::remove_file(&temp_path);
            format!(
                "Failed to write temporary file {}: {error}",
                temp_path.display()
            )
        })?;
        file.sync_all().map_err(|error| {
            let _ = fs::remove_file(&temp_path);
            format!(
                "Failed to flush temporary file {}: {error}",
                temp_path.display()
            )
        })?;
    }

    #[cfg(windows)]
    {
        if path.exists() {
            if let Err(error) = fs::rename(&temp_path, path) {
                let backup = parent.join(format!(".{file_name}.bak-{hex}"));
                let _ = fs::rename(path, &backup);
                match fs::rename(&temp_path, path) {
                    Ok(()) => {
                        let _ = fs::remove_file(&backup);
                    }
                    Err(second_error) => {
                        let _ = fs::rename(&backup, path);
                        let _ = fs::remove_file(&temp_path);
                        return Err(format!(
                            "Failed to replace {}: {error}; retry error: {second_error}",
                            path.display()
                        ));
                    }
                }
            }
            return Ok(());
        }
    }

    fs::rename(&temp_path, path).map_err(|error| {
        let _ = fs::remove_file(&temp_path);
        format!("Failed to commit file {}: {error}", path.display())
    })
}

pub(crate) fn load_or_create_vault_key(key_path: &Path) -> Result<[u8; KEY_LEN], String> {
    if key_path.is_file() {
        let raw = fs::read_to_string(key_path)
            .map_err(|error| format!("Failed to read vault key {}: {error}", key_path.display()))?;
        let trimmed = raw.trim();
        let decoded = BASE64
            .decode(trimmed)
            .map_err(|error| format!("Failed to decode vault key: {error}"))?;
        if decoded.len() != KEY_LEN {
            return Err(format!(
                "Invalid vault key length: expected {KEY_LEN}, got {}",
                decoded.len()
            ));
        }
        let mut key = [0u8; KEY_LEN];
        key.copy_from_slice(&decoded);
        return Ok(key);
    }

    let mut key = [0u8; KEY_LEN];
    fill_random_bytes(&mut key)?;
    let encoded = BASE64.encode(key);
    write_atomic_secure(key_path, encoded.as_bytes())?;
    Ok(key)
}

pub(crate) fn encrypt_envelope(
    key: &[u8; KEY_LEN],
    plaintext: &[u8],
    aad: Option<&[u8]>,
) -> Result<String, String> {
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|error| format!("Failed to initialize AES-256-GCM cipher: {error}"))?;
    let mut nonce_bytes = [0u8; NONCE_LEN];
    fill_random_bytes(&mut nonce_bytes)?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = match aad {
        Some(aad_bytes) => cipher.encrypt(
            nonce,
            Payload {
                msg: plaintext,
                aad: aad_bytes,
            },
        ),
        None => cipher.encrypt(nonce, plaintext),
    }
    .map_err(|error| format!("Failed to encrypt account vault payload: {error}"))?;

    let mut blob = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    blob.extend_from_slice(&nonce_bytes);
    blob.extend_from_slice(&ciphertext);
    Ok(format!("{ENVELOPE_PREFIX}{}", BASE64.encode(blob)))
}

pub(crate) fn decrypt_envelope(
    key: &[u8; KEY_LEN],
    stored: &str,
    aad: Option<&[u8]>,
) -> Result<(Vec<u8>, bool), String> {
    let trimmed = stored.trim();
    let Some(encoded) = trimmed.strip_prefix(ENVELOPE_PREFIX) else {
        // Legacy / plaintext migration path.
        return Ok((stored.as_bytes().to_vec(), false));
    };
    let blob = BASE64
        .decode(encoded.trim())
        .map_err(|error| format!("Corrupted account envelope base64: {error}"))?;
    if blob.len() <= NONCE_LEN + 16 {
        return Err("Corrupted account envelope: truncated ciphertext".into());
    }
    let (nonce_bytes, ciphertext) = blob.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|error| format!("Failed to initialize AES-256-GCM cipher: {error}"))?;
    let nonce = Nonce::from_slice(nonce_bytes);
    let plaintext = match aad {
        Some(aad_bytes) => cipher.decrypt(
            nonce,
            Payload {
                msg: ciphertext,
                aad: aad_bytes,
            },
        ),
        None => cipher.decrypt(nonce, ciphertext),
    }
    .map_err(|_| "Account vault authentication failed (wrong key or tampered file)".to_string())?;
    Ok((plaintext, true))
}

/// Shared Chromium/Electron `os_crypt` helpers used by VS Code Copilot and Devin/Windsurf.
pub(crate) mod os_crypt {
    use super::*;
    use serde_json::Value;

    pub(crate) const V10_PREFIX: &[u8] = b"v10";
    #[cfg(target_os = "linux")]
    pub(crate) const V11_PREFIX: &[u8] = b"v11";
    #[cfg(not(target_os = "windows"))]
    const SALT: &[u8] = b"saltysalt";
    #[cfg(not(target_os = "windows"))]
    const CBC_IV: [u8; 16] = [b' '; 16];
    #[cfg(target_os = "linux")]
    const LINUX_V10_PASSWORD: &str = "peanuts";

    #[cfg(target_os = "windows")]
    pub(crate) fn dpapi_unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};

        let input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        let ok = unsafe {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null(),
                0,
                &mut output,
            )
        };
        if ok == 0 {
            return Err("Windows DPAPI CryptUnprotectData failed".into());
        }
        let slice = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) };
        let result = slice.to_vec();
        unsafe {
            LocalFree(output.pbData as _);
        }
        Ok(result)
    }

    #[cfg(target_os = "windows")]
    pub(crate) fn windows_local_state_key(data_root: &Path) -> Result<[u8; 32], String> {
        let local_state_path = data_root.join("Local State");
        let content = fs::read_to_string(&local_state_path).map_err(|error| {
            format!(
                "Failed to read Electron Local State {}: {error}",
                local_state_path.display()
            )
        })?;
        let json: Value = serde_json::from_str(&content)
            .map_err(|error| format!("Invalid Local State JSON: {error}"))?;
        let encrypted_b64 = json
            .get("os_crypt")
            .and_then(|v| v.get("encrypted_key"))
            .and_then(Value::as_str)
            .ok_or("Local State is missing os_crypt.encrypted_key")?;
        let raw = BASE64
            .decode(encrypted_b64)
            .map_err(|error| format!("Invalid base64 in encrypted_key: {error}"))?;
        if raw.len() < 6 || &raw[..5] != b"DPAPI" {
            return Err("Unexpected os_crypt.encrypted_key prefix (expected DPAPI)".into());
        }
        let decrypted = dpapi_unprotect(&raw[5..])?;
        if decrypted.len() != 32 {
            return Err(format!(
                "Unexpected DPAPI AES key length: {}",
                decrypted.len()
            ));
        }
        let mut key = [0u8; 32];
        key.copy_from_slice(&decrypted);
        Ok(key)
    }

    #[cfg(target_os = "windows")]
    pub(crate) fn encrypt_windows_v10(key: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>, String> {
        let cipher = Aes256Gcm::new_from_slice(key)
            .map_err(|error| format!("AES-GCM init failed: {error}"))?;
        let mut nonce_bytes = [0u8; 12];
        fill_random_bytes(&mut nonce_bytes)?;
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&nonce_bytes), plaintext)
            .map_err(|error| format!("AES-GCM encrypt failed: {error}"))?;
        let mut out = Vec::with_capacity(3 + 12 + ciphertext.len());
        out.extend_from_slice(V10_PREFIX);
        out.extend_from_slice(&nonce_bytes);
        out.extend_from_slice(&ciphertext);
        Ok(out)
    }

    #[cfg(target_os = "windows")]
    pub(crate) fn decrypt_windows_v10(key: &[u8; 32], payload: &[u8]) -> Result<Vec<u8>, String> {
        if payload.len() <= 3 + 12 + 16 || &payload[..3] != V10_PREFIX {
            return Err("Invalid Windows v10 encrypted secret buffer".into());
        }
        let cipher = Aes256Gcm::new_from_slice(key)
            .map_err(|error| format!("AES-GCM init failed: {error}"))?;
        cipher
            .decrypt(Nonce::from_slice(&payload[3..15]), &payload[15..])
            .map_err(|_| "Windows v10 AES-GCM decryption failed".into())
    }

    #[cfg(not(target_os = "windows"))]
    pub(crate) fn pbkdf2_sha1_16(password: &str, iterations: u32) -> [u8; 16] {
        let mut key = [0u8; 16];
        pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password.as_bytes(), SALT, iterations, &mut key);
        key
    }

    #[cfg(not(target_os = "windows"))]
    pub(crate) fn encrypt_cbc_prefixed(
        prefix: &[u8],
        key: &[u8; 16],
        plaintext: &[u8],
    ) -> Result<Vec<u8>, String> {
        use aes::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
        type Aes128CbcEnc = cbc::Encryptor<aes::Aes128>;

        let cipher = Aes128CbcEnc::new_from_slices(key, &CBC_IV)
            .map_err(|error| format!("AES-128-CBC init failed: {error}"))?;
        let mut buf = plaintext.to_vec();
        let msg_len = buf.len();
        let pad_len = 16 - (msg_len % 16);
        buf.resize(msg_len + pad_len, 0);
        let ciphertext = cipher
            .encrypt_padded_mut::<Pkcs7>(&mut buf, msg_len)
            .map_err(|error| format!("AES-128-CBC encrypt failed: {error}"))?;
        let mut out = Vec::with_capacity(prefix.len() + ciphertext.len());
        out.extend_from_slice(prefix);
        out.extend_from_slice(ciphertext);
        Ok(out)
    }

    #[cfg(not(target_os = "windows"))]
    pub(crate) fn decrypt_cbc_prefixed(key: &[u8; 16], payload: &[u8]) -> Result<Vec<u8>, String> {
        use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
        type Aes128CbcDec = cbc::Decryptor<aes::Aes128>;

        if payload.len() < 3 + 16 {
            return Err("Truncated AES-128-CBC payload".into());
        }
        let cipher = Aes128CbcDec::new_from_slices(key, &CBC_IV)
            .map_err(|error| format!("AES-128-CBC init failed: {error}"))?;
        let mut buf = payload[3..].to_vec();
        let plain = cipher
            .decrypt_padded_mut::<Pkcs7>(&mut buf)
            .map_err(|error| format!("AES-128-CBC decrypt failed: {error}"))?;
        Ok(plain.to_vec())
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn macos_safe_storage_password(
        candidates: &[(&str, Option<&str>)],
    ) -> Result<String, String> {
        use std::process::Command;
        for (service, account) in candidates {
            let mut cmd = Command::new("security");
            cmd.args(["find-generic-password", "-w", "-s", service]);
            if let Some(account) = account {
                cmd.args(["-a", account]);
            }
            if let Ok(output) = cmd.output() {
                if output.status.success() {
                    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    if !value.is_empty() {
                        return Ok(value);
                    }
                }
            }
        }
        Err("Failed to read macOS Safe Storage password from Keychain".into())
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn linux_v11_key(app_names: &[&str]) -> Option<[u8; 16]> {
        use std::process::Command;
        for app in app_names {
            if let Ok(output) = Command::new("secret-tool")
                .args(["lookup", "application", app])
                .output()
            {
                if output.status.success() {
                    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    if !value.is_empty() {
                        return Some(pbkdf2_sha1_16(&value, 1));
                    }
                }
            }
        }
        None
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn linux_v10_key() -> [u8; 16] {
        pbkdf2_sha1_16(LINUX_V10_PASSWORD, 1)
    }

    pub(crate) fn encrypt_electron_secret(
        data_root: &Path,
        plaintext: &[u8],
        #[allow(unused_variables)] macos_candidates: &[(&str, Option<&str>)],
        #[allow(unused_variables)] linux_apps: &[&str],
        #[allow(unused_variables)] preferred_prefix: Option<&str>,
    ) -> Result<Vec<u8>, String> {
        #[cfg(target_os = "windows")]
        {
            let key = windows_local_state_key(data_root)?;
            encrypt_windows_v10(&key, plaintext)
        }
        #[cfg(target_os = "macos")]
        {
            let _ = data_root;
            let password = macos_safe_storage_password(macos_candidates)?;
            let key = pbkdf2_sha1_16(&password, 1003);
            encrypt_cbc_prefixed(V10_PREFIX, &key, plaintext)
        }
        #[cfg(target_os = "linux")]
        {
            let _ = data_root;
            let use_v11 = match preferred_prefix {
                Some("v10") => false,
                Some("v11") => true,
                _ => linux_v11_key(linux_apps).is_some(),
            };
            if use_v11 {
                let key = linux_v11_key(linux_apps)
                    .ok_or_else(|| "Linux Secret Service key unavailable".to_string())?;
                encrypt_cbc_prefixed(V11_PREFIX, &key, plaintext)
            } else {
                encrypt_cbc_prefixed(V10_PREFIX, &linux_v10_key(), plaintext)
            }
        }
    }

    pub(crate) fn decrypt_electron_secret(
        data_root: &Path,
        payload: &[u8],
        #[allow(unused_variables)] macos_candidates: &[(&str, Option<&str>)],
        #[allow(unused_variables)] linux_apps: &[&str],
    ) -> Result<Vec<u8>, String> {
        #[cfg(target_os = "windows")]
        {
            let key = windows_local_state_key(data_root)?;
            decrypt_windows_v10(&key, payload)
        }
        #[cfg(target_os = "macos")]
        {
            let _ = data_root;
            let password = macos_safe_storage_password(macos_candidates)?;
            let key = pbkdf2_sha1_16(&password, 1003);
            decrypt_cbc_prefixed(&key, payload)
        }
        #[cfg(target_os = "linux")]
        {
            let _ = data_root;
            if payload.starts_with(V11_PREFIX) {
                let key = linux_v11_key(linux_apps)
                    .ok_or_else(|| "Linux Secret Service key unavailable".to_string())?;
                decrypt_cbc_prefixed(&key, payload)
            } else {
                decrypt_cbc_prefixed(&linux_v10_key(), payload)
            }
        }
    }

    pub(crate) fn decode_buffer_json(raw: &str) -> Option<Vec<u8>> {
        let value: Value = serde_json::from_str(raw).ok()?;
        let arr = value.get("data")?.as_array()?;
        let mut bytes = Vec::with_capacity(arr.len());
        for item in arr {
            bytes.push(item.as_u64()? as u8);
        }
        Some(bytes)
    }

    pub(crate) fn encode_buffer_json(bytes: &[u8]) -> Result<String, String> {
        serde_json::to_string(&serde_json::json!({
            "type": "Buffer",
            "data": bytes,
        }))
        .map_err(|error| format!("Failed to serialize Electron secret Buffer JSON: {error}"))
    }
}
