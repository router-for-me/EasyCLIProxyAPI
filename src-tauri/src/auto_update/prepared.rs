//! Durable, verified payloads. Their metadata never contains GUI credentials.
use super::*;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PreparedUpdate {
    pub version: String,
    pub origin: String,
    pub executable: PathBuf,
    pub payload: Payload,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(super) enum Payload {
    App {
        descriptor: Box<app_update::UpdateDescriptor>,
        files: Vec<CheckedFile>,
    },
    Core {
        staging_dir: PathBuf,
        binary_relative_path: PathBuf,
        asset_name: String,
        binary_sha256: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct CheckedFile {
    path: PathBuf,
    sha256: String,
}

pub(super) fn origin(config: &GuiConfigFile) -> String {
    let identity = serde_json::to_vec(&(
        config.selected_download_candidate().key(),
        &config.update_channel,
        &config.proxy_url,
    ))
    .expect("string tuple serializes");
    format!("{:x}", Sha256::digest(identity))
}

fn record_path(base: &Path, target: &str) -> Result<PathBuf, String> {
    if !matches!(target, "app" | "core") {
        return Err("Invalid update target".into());
    }
    Ok(base.join(format!("automatic-update-{target}.json")))
}

pub(super) fn core_cache_root() -> Result<PathBuf, String> {
    Ok(core_base_dir()?.join("automatic-update-payloads"))
}

impl PreparedUpdate {
    pub fn target(&self) -> &'static str {
        match self.payload {
            Payload::App { .. } => "app",
            Payload::Core { .. } => "core",
        }
    }

    pub fn matches(&self, config: &GuiConfigFile) -> bool {
        self.origin == origin(config) && config.auto_update.includes(self.target())
    }

    pub fn load(target: &str) -> Result<Option<Self>, String> {
        Self::load_at(&core_base_dir()?, target)
    }

    pub fn load_at(base: &Path, target: &str) -> Result<Option<Self>, String> {
        match fs::read(record_path(base, target)?) {
            Ok(bytes) => {
                let prepared: Self = serde_json::from_slice(&bytes)
                    .map_err(|error| format!("Invalid prepared update: {error}"))?;
                if prepared.target() != target
                    || semver::Version::parse(prepared.version.trim_start_matches('v')).is_err()
                {
                    return Err("Invalid prepared update target or version".into());
                }
                Ok(Some(prepared))
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(format!("Cannot read prepared update: {error}")),
        }
    }

    pub fn save(&self) -> Result<(), String> {
        self.save_at(&core_base_dir()?)
    }

    pub fn save_at(&self, base: &Path) -> Result<(), String> {
        write_bytes_atomically(
            &record_path(base, self.target())?,
            &serde_json::to_vec(self).map_err(|e| e.to_string())?,
        )
    }

    pub fn validate_files(&self) -> Result<(), String> {
        self.validate_files_at(
            &env::current_exe().map_err(|e| e.to_string())?,
            &core_cache_root()?,
        )
    }

    pub(super) fn validate_files_at(
        &self,
        executable: &Path,
        core_root: &Path,
    ) -> Result<(), String> {
        let saved_executable = fs::canonicalize(&self.executable).map_err(|e| e.to_string())?;
        let current_executable = fs::canonicalize(executable).map_err(|e| e.to_string())?;
        if saved_executable != current_executable {
            return Err("Application location changed since the update was downloaded".into());
        }
        match &self.payload {
            Payload::Core {
                staging_dir,
                binary_relative_path,
                binary_sha256,
                ..
            } => {
                let root = fs::canonicalize(core_root).map_err(|e| e.to_string())?;
                let staged = fs::canonicalize(staging_dir).map_err(|e| e.to_string())?;
                if staged.parent() != Some(root.as_path()) || !safe_relative(binary_relative_path) {
                    return Err("Prepared core path is out of bounds".into());
                }
                let binary = fs::canonicalize(staged.join(binary_relative_path))
                    .map_err(|e| e.to_string())?;
                if !binary.starts_with(&staged)
                    || find_core_binary(&staged)
                        .and_then(|path| fs::canonicalize(path).ok())
                        .as_ref()
                        != Some(&binary)
                {
                    return Err("Prepared core binary is out of bounds".into());
                }
                if sha256_file(&binary)? != *binary_sha256 {
                    return Err("Prepared core checksum mismatch".into());
                }
            }
            Payload::App { descriptor, files } => {
                if normalize_version(&descriptor.target_version) != normalize_version(&self.version)
                {
                    return Err("Prepared application version mismatch".into());
                }
                descriptor.validate_cached(executable)?;
                let expected = descriptor.protected_files();
                if files.len() != expected.len()
                    || expected
                        .iter()
                        .any(|path| !files.iter().any(|file| file.path == *path))
                {
                    return Err("Prepared update has incomplete verification records".into());
                }
                for file in files {
                    if sha256_file(&file.path)? != file.sha256 {
                        return Err("Prepared application checksum mismatch".into());
                    }
                }
            }
        }
        Ok(())
    }

    pub fn discard(&self) -> Result<(), String> {
        Self::remove_record(self.target())?;
        self.cleanup_payload();
        Ok(())
    }

    pub fn cleanup_payload(&self) {
        match &self.payload {
            Payload::Core { staging_dir, .. } => {
                if let (Ok(root), Ok(path)) = (
                    core_cache_root()
                        .and_then(|root| fs::canonicalize(root).map_err(|e| e.to_string())),
                    fs::canonicalize(staging_dir),
                ) {
                    if path.parent() == Some(root.as_path()) {
                        let _ = fs::remove_dir_all(path);
                    }
                }
            }
            Payload::App { descriptor, .. } => {
                // The newly launched app must leave the acknowledgement and
                // rollback payload to the updater that is still accepting it.
                if portable_update_ack_argument().is_none()
                    && env::current_exe()
                        .is_ok_and(|executable| descriptor.validate_cached(&executable).is_ok())
                {
                    let _ = fs::remove_dir_all(&descriptor.work_dir);
                }
            }
        }
    }

    pub fn remove_record(target: &str) -> Result<(), String> {
        match fs::remove_file(record_path(&core_base_dir()?, target)?) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("Cannot remove prepared update record: {error}")),
        }
    }
}

fn safe_relative(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && path
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
}

pub(super) fn capture_app(
    config: &GuiConfigFile,
    descriptor: &app_update::UpdateDescriptor,
) -> Result<PreparedUpdate, String> {
    let executable = env::current_exe().map_err(|error| error.to_string())?;
    descriptor.validate_cached(&executable)?;
    let files = descriptor
        .protected_files()
        .into_iter()
        .map(|path| sha256_file(&path).map(|sha256| CheckedFile { path, sha256 }))
        .collect::<Result<_, _>>()?;
    Ok(PreparedUpdate {
        version: descriptor.target_version.clone(),
        origin: origin(config),
        executable,
        payload: Payload::App {
            descriptor: Box::new(descriptor.clone()),
            files,
        },
    })
}

pub(super) fn capture_core(
    config: &GuiConfigFile,
    staged: core_runtime::StagedCoreInstall,
) -> Result<PreparedUpdate, String> {
    let root = core_cache_root()?;
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let destination = root.join(format!("core-{}-{unique}", std::process::id()));
    // Configuration is refreshed from the live install immediately before the
    // swap; do not keep a second durable copy of the user's credentials here.
    match fs::remove_file(staged.staging_dir.join(CORE_CONFIG_FILE)) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    let binary_sha256 = sha256_file(&staged.staging_dir.join(&staged.binary_relative_path))?;
    fs::rename(&staged.staging_dir, &destination)
        .map_err(|e| format!("Cannot cache core update: {e}"))?;
    Ok(PreparedUpdate {
        version: staged.version,
        origin: origin(config),
        executable: env::current_exe().map_err(|e| e.to_string())?,
        payload: Payload::Core {
            staging_dir: destination,
            binary_relative_path: staged.binary_relative_path,
            asset_name: staged.asset_name,
            binary_sha256,
        },
    })
}

#[cfg(all(test, any(windows, target_os = "linux")))]
mod tests {
    use super::*;

    #[test]
    fn persisted_application_is_revalidated_before_the_next_startup() {
        let root = unique_test_temp_path("automatic-update-app-cache");
        let app = root.join("app");
        let work = root.join("EasyCLIProxyAPI-update-cache-test");
        let staging = work.join("staging");
        fs::create_dir_all(&app).unwrap();
        fs::create_dir_all(staging.join("cpa-core")).unwrap();
        let executable = app.join(PORTABLE_APP_BINARY);
        fs::write(&executable, b"fake old app, never executed").unwrap();
        let helper = work.join(if cfg!(windows) {
            "EasyCLIProxyAPI-updater.exe"
        } else {
            "EasyCLIProxyAPI-updater"
        });
        fs::write(&helper, b"fake helper, never executed").unwrap();
        fs::write(staging.join(PORTABLE_APP_BINARY), b"new app").unwrap();
        fs::write(staging.join(PORTABLE_APP_MANIFEST_FILE), b"new manifest").unwrap();
        fs::write(staging.join(CORE_VERSION_FILE), b"8.0.99").unwrap();
        let archive = if cfg!(windows) {
            "CLIProxyAPI_8.0.99_windows_amd64.zip"
        } else {
            "CLIProxyAPI_8.0.99_linux_amd64.tar.gz"
        };
        fs::write(staging.join("cpa-core").join(archive), b"fake core archive").unwrap();
        let descriptor = PortableUpdateDescriptor {
            parent_pid: 1,
            current_exe: executable.clone(),
            staged_exe: staging.join(PORTABLE_APP_BINARY),
            current_manifest: app.join(PORTABLE_APP_MANIFEST_FILE),
            staged_manifest: staging.join(PORTABLE_APP_MANIFEST_FILE),
            backup_exe: app.join(format!(".{PORTABLE_APP_BINARY}.update-backup")),
            backup_manifest: app.join(".portable-app.json.update-backup"),
            current_core_version: app.join(CORE_VERSION_FILE),
            staged_core_version: staging.join(CORE_VERSION_FILE),
            backup_core_version: app.join(".core-version.txt.update-backup"),
            staged_core_archive: staging.join("cpa-core").join(archive),
            target_core_archive: app.join("cpa-core").join(archive),
            install_core_archive: true,
            ack_path: work.join("update-started.ack"),
            work_dir: work.clone(),
            target_version: "0.3.112".into(),
            preserve_core: true,
        };
        let mut refreshed = descriptor.clone();
        refreshed.refresh();
        assert_eq!(refreshed.parent_pid, std::process::id());
        assert!(refreshed.install_core_archive);
        fs::create_dir_all(app.join("cpa-core")).unwrap();
        fs::write(
            &refreshed.target_core_archive,
            b"already installed manually",
        )
        .unwrap();
        refreshed.refresh();
        assert!(!refreshed.install_core_archive);
        assert_eq!(descriptor.parent_pid, 1);
        let files = descriptor
            .protected_files()
            .into_iter()
            .map(|path| CheckedFile {
                sha256: sha256_file(&path).unwrap(),
                path,
            })
            .collect();
        let cached = PreparedUpdate {
            version: "0.3.112".into(),
            origin: origin(&GuiConfigFile::default()),
            executable: executable.clone(),
            payload: Payload::App {
                descriptor: Box::new(descriptor),
                files,
            },
        };
        let mut legacy = serde_json::to_value(&cached).unwrap();
        legacy["payload"]["helper"] = serde_json::json!(&helper);
        legacy["payload"]["work_dir"] = serde_json::json!(&work);
        legacy["payload"]["preserve_core"] = serde_json::json!(true);
        serde_json::from_value::<PreparedUpdate>(legacy)
            .unwrap()
            .validate_files_at(&executable, &root)
            .unwrap();
        cached.save_at(&root).unwrap();
        drop(cached);
        let mut restored = PreparedUpdate::load_at(&root, "app").unwrap().unwrap();
        restored.validate_files_at(&executable, &root).unwrap();
        assert!(!root
            .join("EasyCLIProxyAPI-update-cache-test/update-descriptor.json")
            .exists());
        restored.version = "0.3.113".into();
        assert!(restored
            .validate_files_at(&executable, &root)
            .unwrap_err()
            .contains("version mismatch"));
        restored.version = "0.3.112".into();
        fs::write(&helper, b"tampered helper").unwrap();
        assert!(restored
            .validate_files_at(&executable, &root)
            .unwrap_err()
            .contains("checksum mismatch"));
        fs::write(&helper, b"fake helper, never executed").unwrap();
        if let Payload::App { files, .. } = &mut restored.payload {
            files.pop();
        }
        assert!(restored
            .validate_files_at(&executable, &root)
            .unwrap_err()
            .contains("incomplete verification"));
        fs::remove_file(staging.join(PORTABLE_APP_BINARY)).unwrap();
        assert!(restored.validate_files_at(&executable, &root).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
