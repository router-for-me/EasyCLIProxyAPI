use super::*;

// Status detection must never execute an editor binary or a shell wrapper. Even a
// wrapper can start Electron; the generic probe timeout then kills its tree.
fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn installation(executable: &Path) -> Option<(PathBuf, PathBuf, Value)> {
    let executable = fs::canonicalize(executable).ok()?;
    // macOS GUI: *.app/Contents/MacOS/Electron
    // macOS CLI: *.app/Contents/Resources/app/bin/code (also via symlinks).
    for contents in executable.ancestors().skip(1).take(5) {
        if contents.file_name().and_then(|name| name.to_str()) == Some("Contents") {
            let bundle = contents.parent()?;
            if bundle.extension().and_then(|name| name.to_str()) == Some("app") {
                return installation_at(bundle, contents.join("Resources/app"));
            }
        }
    }
    let parent = executable.parent()?;
    let root = if parent.file_name()?.to_str()?.eq_ignore_ascii_case("bin") {
        parent.parent()?
    } else {
        parent
    };
    let insiders = executable
        .file_name()?
        .to_string_lossy()
        .to_ascii_lowercase()
        .contains("insiders");
    let cli = root.join("bin").join(if insiders {
        "code-insiders.cmd"
    } else {
        "code.cmd"
    });
    // Recent Windows builds put app resources under a commit directory. Read
    // the official wrapper's literal resource path, without interpreting it.
    // Never choose an arbitrary old or staged update directory.
    let script = fs::read_to_string(cli).ok().unwrap_or_default();
    let pattern =
        regex::Regex::new(r#"(?i)%~dp0\.\.\\([0-9a-f]{10,40})\\resources\\app\\out\\cli\.js"#)
            .ok()?;
    let app = match pattern.captures(&script) {
        Some(captures) => root.join(&captures[1]).join("resources/app"),
        None => root.join("resources/app"),
    };
    // Linux deb/rpm/tar installations resolve to <root>/bin/code or
    // <root>/code. Unknown launchers (e.g. /usr/bin/snap) fail closed.
    installation_at(root, app)
}

fn installation_at(root: &Path, app: PathBuf) -> Option<(PathBuf, PathBuf, Value)> {
    let product = read_json(&app.join("product.json"))?;
    if !matches!(
        product.get("applicationName").and_then(Value::as_str),
        Some("code" | "code-insiders")
    ) {
        return None;
    }
    Some((root.to_path_buf(), app, product))
}

pub(crate) fn read_vscode_version(executable: &Path, _home: &Path) -> Option<String> {
    let (_, app, _) = installation(executable)?;
    let package = read_json(&app.join("package.json"))?;
    copilot_version_number(package.get("version")?.as_str()?)
}

fn chat_version(package: &Path) -> Option<String> {
    let value = read_json(package)?;
    if !value
        .get("publisher")?
        .as_str()?
        .eq_ignore_ascii_case("github")
        || value.get("name")?.as_str()? != "copilot-chat"
    {
        return None;
    }
    copilot_version_number(value.get("version")?.as_str()?)
}

fn external_version(directory: &Path) -> Option<String> {
    // Use the installed registry, not leftover version directories from updates
    // or uninstalls. Verify the package still exists and matches its entry.
    let entries = read_json(&directory.join("extensions.json"))?;
    entries.as_array()?.iter().find_map(|entry| {
        if !entry
            .get("identifier")?
            .get("id")?
            .as_str()?
            .eq_ignore_ascii_case("github.copilot-chat")
        {
            return None;
        }
        let relative = Path::new(entry.get("relativeLocation")?.as_str()?);
        if relative.components().count() != 1
            || !matches!(
                relative.components().next()?,
                std::path::Component::Normal(_)
            )
        {
            return None;
        }
        let version = chat_version(&directory.join(relative).join("package.json"))?;
        (entry.get("version")?.as_str()? == version).then_some(version)
    })
}

pub(crate) fn read_vscode_copilot_version(executable: &Path, home: &Path) -> Option<String> {
    let (root, app, product) = installation(executable)?;
    let insiders = product["applicationName"] == "code-insiders";
    // macOS portable data lives beside the .app; Linux and Windows use data/.
    let default_portable = if root.extension().and_then(|name| name.to_str()) == Some("app") {
        root.parent()?.join(if insiders {
            "code-insiders-portable-data"
        } else {
            "code-portable-data"
        })
    } else {
        root.join("data")
    };
    let portable = agent_configuration_environment("VSCODE_PORTABLE")
        .filter(|path| path.is_absolute())
        .unwrap_or(default_portable);
    let extensions = if portable.is_dir() {
        portable.join("extensions")
    } else if let Some(directory) =
        agent_configuration_environment("VSCODE_EXTENSIONS").filter(|path| path.is_absolute())
    {
        directory
    } else {
        home.join(if product["applicationName"] == "code-insiders" {
            ".vscode-insiders"
        } else {
            ".vscode"
        })
        .join("extensions")
    };
    external_version(&extensions).or_else(|| {
        ["copilot", "github.copilot-chat"]
            .into_iter()
            .find_map(|name| chat_version(&app.join("extensions").join(name).join("package.json")))
    })
}
