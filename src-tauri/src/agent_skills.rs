use super::*;
use std::collections::{BTreeMap, HashSet, VecDeque};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use serde_json::Value;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillEntry {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) path: String,
    pub(crate) root: String,
    pub(crate) source: String,
    pub(crate) enabled: bool,
    pub(crate) file_count: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillDetail {
    pub(crate) entry: SkillEntry,
    pub(crate) body: String,
}

const MAX_SKILLS_LIMIT: usize = 500;
const MAX_DETAIL_BODY_BYTES: usize = 512 * 1024;
const MAX_FALLBACK_DESC_CHARS: usize = 240;

fn home_directory() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn candidate_roots() -> Vec<(PathBuf, &'static str)> {
    let mut roots = Vec::new();
    let home = home_directory();

    if let Some(h) = &home {
        // 1. $HOME/.openclaw/skills -> source openclaw
        roots.push((h.join(".openclaw").join("skills"), "openclaw"));

        // 2. $HOME/.openclaw/plugin-skills -> source openclaw
        roots.push((h.join(".openclaw").join("plugin-skills"), "openclaw"));

        // 3. every $HOME/.openclaw/agents/*/agent/workshop-skills -> source workshop
        let agents_dir = h.join(".openclaw").join("agents");
        if let Ok(entries) = fs::read_dir(&agents_dir) {
            let mut agent_paths = Vec::new();
            for entry in entries.flatten() {
                if let Ok(ft) = entry.file_type() {
                    if ft.is_dir() && !ft.is_symlink() {
                        agent_paths.push(entry.path());
                    }
                }
            }
            agent_paths.sort();
            for agent_path in agent_paths {
                let workshop_skills = agent_path.join("agent").join("workshop-skills");
                roots.push((workshop_skills, "workshop"));
            }
        }

        // 4. $HOME/skills and $HOME/.agents/skills -> source project
        roots.push((h.join("skills"), "project"));
        roots.push((h.join(".agents").join("skills"), "project"));
    }

    // 5. <cwd>/skills and <cwd>/.agents/skills -> source project
    if let Ok(cwd) = std::env::current_dir() {
        roots.push((cwd.join("skills"), "project"));
        roots.push((cwd.join(".agents").join("skills"), "project"));
    }

    // 6. <exe dir>/skills -> source custom
    if let Ok(dir) = executable_dir() {
        roots.push((dir.join("skills"), "custom"));
    }

    roots
}

pub(crate) fn slugify(name: &str) -> String {
    let mut slug = String::new();
    let mut prev_dash = false;

    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash && !slug.is_empty() {
            slug.push('-');
            prev_dash = true;
        }
    }

    if slug.ends_with('-') {
        slug.pop();
    }
    slug
}

fn unquote(s: &str) -> String {
    let trimmed = s.trim();
    if (trimmed.starts_with('"') && trimmed.ends_with('"') && trimmed.len() >= 2)
        || (trimmed.starts_with('\'') && trimmed.ends_with('\'') && trimmed.len() >= 2)
    {
        trimmed[1..trimmed.len() - 1].to_string()
    } else {
        trimmed.to_string()
    }
}

pub(crate) fn parse_frontmatter(body: &str) -> (Option<String>, Option<String>) {
    let mut lines = body.lines();
    let first = match lines.next() {
        Some(line) => line.trim(),
        None => return (None, None),
    };
    if first != "---" {
        return (None, None);
    }

    let mut name = None;
    let mut description = None;
    let mut closed = false;

    for line in lines {
        if line.trim() == "---" {
            closed = true;
            break;
        }
        if line.starts_with(' ') || line.starts_with('\t') {
            continue;
        }
        if let Some(val) = line.strip_prefix("name:") {
            if name.is_none() {
                name = Some(unquote(val));
            }
        } else if let Some(val) = line.strip_prefix("description:") {
            if description.is_none() {
                description = Some(unquote(val));
            }
        }
    }

    if !closed {
        return (None, None);
    }
    (name, description)
}

fn fallback_description(body: &str) -> String {
    let mut lines = body.lines();
    let has_frontmatter = {
        let mut check_lines = body.lines();
        if check_lines.next().map(|l| l.trim() == "---").unwrap_or(false) {
            check_lines.any(|l| l.trim() == "---")
        } else {
            false
        }
    };

    if has_frontmatter {
        lines.next();
        for line in lines.by_ref() {
            if line.trim() == "---" {
                break;
            }
        }
    }

    for line in lines {
        let trimmed = line.trim();
        let stripped = trimmed.trim_start_matches(|c| c == '#' || c == '*' || c == '-' || c == ' ');
        let cleaned = stripped.trim();
        if !cleaned.is_empty() {
            return truncate_chars(cleaned, MAX_FALLBACK_DESC_CHARS);
        }
    }

    String::new()
}

fn truncate_chars(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect()
}

fn count_skill_files(skill_dir: &Path) -> usize {
    let mut count = 0;
    let mut queue = VecDeque::new();
    queue.push_back((skill_dir.to_path_buf(), 0usize));

    while let Some((dir, depth)) = queue.pop_front() {
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if let Ok(ft) = entry.file_type() {
                    if ft.is_dir() && !ft.is_symlink() {
                        if depth < 4 {
                            queue.push_back((entry.path(), depth + 1));
                        }
                    } else if ft.is_file() {
                        if depth == 0 && entry.file_name() == "SKILL.md" {
                            continue;
                        }
                        count += 1;
                    }
                }
            }
        }
    }
    count
}

fn generate_unique_id(base_name: &str, existing_ids: &mut HashSet<String>) -> String {
    let mut slug = slugify(base_name);
    if slug.is_empty() {
        slug = "skill".to_string();
    }

    if !existing_ids.contains(&slug) {
        existing_ids.insert(slug.clone());
        return slug;
    }

    let mut counter = 2;
    loop {
        let candidate = format!("{slug}-{counter}");
        if !existing_ids.contains(&candidate) {
            existing_ids.insert(candidate.clone());
            return candidate;
        }
        counter += 1;
    }
}

pub(crate) fn scan_root(
    root: &Path,
    source: &str,
    out: &mut Vec<SkillEntry>,
    limit: usize,
) {
    if !root.is_dir() || out.len() >= limit {
        return;
    }

    let mut existing_ids: HashSet<String> = out.iter().map(|e| e.id.clone()).collect();
    let root_str = root.to_string_lossy().to_string();

    let mut queue = VecDeque::new();
    queue.push_back((root.to_path_buf(), 0usize));

    while let Some((current_dir, depth)) = queue.pop_front() {
        if out.len() >= limit {
            break;
        }

        let skill_md = current_dir.join("SKILL.md");
        if depth > 0 && skill_md.is_file() {
            let dir_name = current_dir
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("skill");

            let id = generate_unique_id(dir_name, &mut existing_ids);

            let body = fs::read_to_string(&skill_md).unwrap_or_default();
            let (fm_name, fm_desc) = parse_frontmatter(&body);

            let name = fm_name
                .filter(|n| !n.trim().is_empty())
                .unwrap_or_else(|| dir_name.to_string());

            let description = fm_desc
                .filter(|d| !d.trim().is_empty())
                .unwrap_or_else(|| fallback_description(&body));

            let file_count = count_skill_files(&current_dir);
            let path_str = match fs::canonicalize(&skill_md) {
                Ok(canon) => canon.to_string_lossy().to_string(),
                Err(_) => skill_md.to_string_lossy().to_string(),
            };

            out.push(SkillEntry {
                id,
                name,
                description,
                path: path_str,
                root: root_str.clone(),
                source: source.to_string(),
                enabled: true,
                file_count,
            });

            if out.len() >= limit {
                break;
            }
        }

        if depth < 4 {
            if let Ok(entries) = fs::read_dir(&current_dir) {
                let mut subdirs = Vec::new();
                for entry in entries.flatten() {
                    if let Ok(ft) = entry.file_type() {
                        if ft.is_dir() && !ft.is_symlink() {
                            subdirs.push(entry.path());
                        }
                    }
                }
                subdirs.sort();
                for subdir in subdirs {
                    queue.push_back((subdir, depth + 1));
                }
            }
        }
    }
}

fn load_skill_states() -> Result<BTreeMap<String, bool>, String> {
    let path = core_base_dir()?.join("skill-states.json");
    match fs::read(&path) {
        Ok(content) => serde_json::from_slice(&content)
            .map_err(|error| format!("Failed to parse skill states: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(error) => Err(format!("Failed to read skill states: {error}")),
    }
}

fn save_skill_states(states: &BTreeMap<String, bool>) -> Result<(), String> {
    let content = serde_json::to_vec_pretty(states).map_err(|e| e.to_string())?;
    write_bytes_atomically(&core_base_dir()?.join("skill-states.json"), &content)
}

fn find_matching_root(
    canonical_path: &Path,
    roots: &[(PathBuf, &'static str)],
) -> Option<(PathBuf, &'static str)> {
    for (candidate, source) in roots {
        if let Ok(canon_root) = fs::canonicalize(candidate) {
            if canonical_path.starts_with(&canon_root) {
                return Some((canon_root, *source));
            }
        }
    }
    None
}

fn find_canonical_root(canonical_path: &Path) -> Result<(PathBuf, String), String> {
    let roots = candidate_roots();
    find_matching_root(canonical_path, &roots)
        .map(|(root, source)| (root, source.to_string()))
        .ok_or_else(|| {
            format!(
                "Path '{}' is not inside any known skill root",
                canonical_path.display()
            )
        })
}

fn build_entry_from_file(
    canonical_file: &Path,
    root: &Path,
    source: &str,
    enabled: bool,
) -> Result<SkillEntry, String> {
    let skill_dir = canonical_file
        .parent()
        .ok_or_else(|| "Failed to get skill directory".to_string())?;

    let dir_name = skill_dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("skill");

    let id = slugify(dir_name);
    let body = fs::read_to_string(canonical_file)
        .map_err(|e| format!("Failed to read skill file: {e}"))?;

    let (fm_name, fm_desc) = parse_frontmatter(&body);
    let name = fm_name
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| dir_name.to_string());

    let description = fm_desc
        .filter(|d| !d.trim().is_empty())
        .unwrap_or_else(|| fallback_description(&body));

    let file_count = count_skill_files(skill_dir);

    Ok(SkillEntry {
        id: if id.is_empty() { "skill".into() } else { id },
        name,
        description,
        path: canonical_file.to_string_lossy().to_string(),
        root: root.to_string_lossy().to_string(),
        source: source.to_string(),
        enabled,
        file_count,
    })
}

#[tauri::command]
pub(crate) fn list_skills() -> Result<Vec<SkillEntry>, String> {
    let roots = candidate_roots();
    let mut entries = Vec::new();
    let mut seen_roots = HashSet::new();

    for (root, source) in roots {
        if !root.is_dir() {
            continue;
        }
        let canon = match fs::canonicalize(&root) {
            Ok(c) => c,
            Err(_) => continue,
        };
        if !seen_roots.insert(canon.clone()) {
            continue;
        }
        scan_root(&canon, source, &mut entries, MAX_SKILLS_LIMIT);
        if entries.len() >= MAX_SKILLS_LIMIT {
            break;
        }
    }

    let states = load_skill_states().unwrap_or_default();
    for entry in &mut entries {
        if let Some(&enabled) = states.get(&entry.path) {
            entry.enabled = enabled;
        }
    }

    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(entries)
}

#[tauri::command]
pub(crate) fn get_skill_detail(path: String) -> Result<SkillDetail, String> {
    let canonical_path = fs::canonicalize(&path)
        .map_err(|error| format!("Failed to canonicalize path '{path}': {error}"))?;

    if canonical_path.file_name().and_then(|n| n.to_str()) != Some("SKILL.md") || !canonical_path.is_file() {
        return Err("Target file must be named SKILL.md".into());
    }

    let (root, source) = find_canonical_root(&canonical_path)?;

    let states = load_skill_states().unwrap_or_default();
    let path_key = canonical_path.to_string_lossy().to_string();
    let enabled = states.get(&path_key).copied().unwrap_or(true);

    let entry = build_entry_from_file(&canonical_path, &root, &source, enabled)?;

    let mut file = fs::File::open(&canonical_path)
        .map_err(|e| format!("Failed to open skill file: {e}"))?;

    let mut buf = Vec::new();
    let mut handle = (&mut file).take((MAX_DETAIL_BODY_BYTES + 1) as u64);
    handle
        .read_to_end(&mut buf)
        .map_err(|e| format!("Failed to read skill file: {e}"))?;

    let truncated = buf.len() > MAX_DETAIL_BODY_BYTES;
    if truncated {
        buf.truncate(MAX_DETAIL_BODY_BYTES);
    }

    let mut body = match String::from_utf8(buf) {
        Ok(s) => s,
        Err(e) => {
            let valid_len = e.utf8_error().valid_up_to();
            let mut bytes = e.into_bytes();
            bytes.truncate(valid_len);
            String::from_utf8(bytes).map_err(|err| err.to_string())?
        }
    };

    if truncated {
        body.push_str("\n\n… (truncated)");
    }

    Ok(SkillDetail { entry, body })
}

fn read_openclaw_config(path: &Path) -> Result<serde_json::Map<String, Value>, String> {
    if !path.exists() {
        return Ok(serde_json::Map::new());
    }
    let content = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read OpenClaw config file: {e}"))?;
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Ok(serde_json::Map::new());
    }
    let parsed: Value = serde_json::from_str(trimmed)
        .or_else(|_| json5::from_str(trimmed))
        .map_err(|e| format!("Corrupt OpenClaw configuration file: {e}"))?;
    match parsed {
        Value::Object(map) => Ok(map),
        _ => Err("Corrupt OpenClaw configuration file: root must be an object".to_string()),
    }
}

fn write_openclaw_config(path: &Path, root: &serde_json::Map<String, Value>) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(&Value::Object(root.clone()))
        .map_err(|e| format!("Failed to serialize OpenClaw configuration: {e}"))?;
    write_bytes_atomically(path, &bytes)
}

pub(crate) fn sync_skill_enabled_to_openclaw(skill_name: &str, enabled: bool) -> Result<(), String> {
    let home = home_directory().ok_or_else(|| "Failed to resolve home directory".to_string())?;
    let config_path = openclaw_agent_config_path(&home);
    sync_skill_enabled_to_openclaw_at_path(skill_name, enabled, &config_path)
}

pub(crate) fn sync_skill_enabled_to_openclaw_at_path(
    skill_name: &str,
    enabled: bool,
    config_path: &Path,
) -> Result<(), String> {
    let sanitized_name = skill_name.trim();
    if sanitized_name.is_empty() {
        return Err("Skill name cannot be empty".to_string());
    }
    if sanitized_name == "__proto__" {
        return Err("Skill name cannot be '__proto__'".to_string());
    }

    let mut root = read_openclaw_config(config_path)?;
    let skills = ensure_json_object_entry(&mut root, "skills");
    let entries = ensure_json_object_entry(skills, "entries");
    let skill_obj = ensure_json_object_entry(entries, sanitized_name);
    skill_obj.insert("enabled".to_string(), Value::Bool(enabled));

    write_openclaw_config(config_path, &root)
}

#[tauri::command]
pub(crate) fn set_skill_enabled(path: String, enabled: bool) -> Result<SkillEntry, String> {
    let canonical_path = fs::canonicalize(&path)
        .map_err(|error| format!("Failed to canonicalize path '{path}': {error}"))?;

    if canonical_path.file_name().and_then(|n| n.to_str()) != Some("SKILL.md") || !canonical_path.is_file() {
        return Err("Target file must be named SKILL.md".into());
    }

    let (root, source) = find_canonical_root(&canonical_path)?;
    let entry = build_entry_from_file(&canonical_path, &root, &source, enabled)?;

    if source == "openclaw" {
        sync_skill_enabled_to_openclaw(&entry.id, enabled)?;
    }

    let mut states = load_skill_states().unwrap_or_default();
    let path_key = canonical_path.to_string_lossy().to_string();
    states.insert(path_key, enabled);
    save_skill_states(&states)?;

    Ok(entry)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_dir(name: &str) -> PathBuf {
        let unique = format!(
            "cpa_test_{}_{}_{}",
            name,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let path = std::env::temp_dir().join(unique);
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn test_frontmatter_with_quoted_values() {
        let content_double_quotes = "---\nname: \"My Quoted Skill\"\ndescription: \"A double quoted description\"\n---\n# Body";
        let (name, desc) = parse_frontmatter(content_double_quotes);
        assert_eq!(name.as_deref(), Some("My Quoted Skill"));
        assert_eq!(desc.as_deref(), Some("A double quoted description"));

        let content_single_quotes = "---\nname: 'Single Quoted Skill'\ndescription: 'A single quoted description'\n---\n# Body";
        let (name, desc) = parse_frontmatter(content_single_quotes);
        assert_eq!(name.as_deref(), Some("Single Quoted Skill"));
        assert_eq!(desc.as_deref(), Some("A single quoted description"));

        let content_unquoted = "---\nname: Plain Skill\ndescription: Plain description\nother: ignored\n---\n# Body";
        let (name, desc) = parse_frontmatter(content_unquoted);
        assert_eq!(name.as_deref(), Some("Plain Skill"));
        assert_eq!(desc.as_deref(), Some("Plain description"));
    }

    #[test]
    fn test_frontmatter_absent_fallback_description() {
        let content = "# My Awesome Skill\nThis skill does great things.\n";
        let (name, desc) = parse_frontmatter(content);
        assert_eq!(name, None);
        assert_eq!(desc, None);

        let fallback = fallback_description(content);
        assert_eq!(fallback, "My Awesome Skill");

        let content_bullet = "\n\n   \n- First bullet description\nSecond line";
        let fallback_bullet = fallback_description(content_bullet);
        assert_eq!(fallback_bullet, "First bullet description");

        let long_line = "A".repeat(300);
        let fallback_long = fallback_description(&long_line);
        assert_eq!(fallback_long.len(), 240);
    }

    #[test]
    fn test_slugify_edge_cases() {
        assert_eq!(slugify("Hello World"), "hello-world");
        assert_eq!(slugify("UPPERCASE"), "uppercase");
        assert_eq!(slugify("foo / bar ! baz"), "foo-bar-baz");
        assert_eq!(slugify(""), "");
        assert_eq!(slugify("---"), "");
        assert_eq!(slugify("   "), "");
        assert_eq!(slugify("  mixed Case & Punctuation... "), "mixed-case-punctuation");
    }

    #[test]
    fn test_scan_finds_skill_and_ignores_without() {
        let test_dir = create_test_dir("scan");
        let root = test_dir.join("root");
        fs::create_dir_all(&root).unwrap();

        let skill_a = root.join("skill-a");
        fs::create_dir_all(&skill_a).unwrap();
        fs::write(
            skill_a.join("SKILL.md"),
            "---\nname: Skill A\ndescription: Desc A\n---\n",
        )
        .unwrap();
        fs::write(skill_a.join("extra.txt"), "extra file").unwrap();

        let empty_b = root.join("dir-b");
        fs::create_dir_all(&empty_b).unwrap();
        fs::write(empty_b.join("not_a_skill.txt"), "hello").unwrap();

        let mut out = Vec::new();
        scan_root(&root, "workshop", &mut out, 500);

        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "skill-a");
        assert_eq!(out[0].name, "Skill A");
        assert_eq!(out[0].description, "Desc A");
        assert_eq!(out[0].source, "workshop");
        assert_eq!(out[0].file_count, 1);
        assert!(out[0].enabled);

        let _ = fs::remove_dir_all(&test_dir);
    }

    #[test]
    fn test_containment_check_rejects_path_outside_root() {
        let test_dir = create_test_dir("containment");
        let root = test_dir.join("root");
        let outside = test_dir.join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();

        let outside_skill = outside.join("SKILL.md");
        fs::write(&outside_skill, "---\nname: Outside\n---\n").unwrap();
        let canon_outside = fs::canonicalize(&outside_skill).unwrap();

        let inside_skill = root.join("valid-skill").join("SKILL.md");
        fs::create_dir_all(root.join("valid-skill")).unwrap();
        fs::write(&inside_skill, "---\nname: Inside\n---\n").unwrap();
        let canon_inside = fs::canonicalize(&inside_skill).unwrap();

        let custom_roots = [(root.clone(), "custom")];
        assert!(find_matching_root(&canon_outside, &custom_roots).is_none());

        let matched = find_matching_root(&canon_inside, &custom_roots);
        assert!(matched.is_some());
        let (matched_root, matched_source) = matched.unwrap();
        assert_eq!(matched_root, fs::canonicalize(&root).unwrap());
        assert_eq!(matched_source, "custom");

        let _ = fs::remove_dir_all(&test_dir);
    }

    static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct TempHomeGuard {
        home_dir: PathBuf,
        prev_home: Option<std::ffi::OsString>,
        prev_userprofile: Option<std::ffi::OsString>,
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl TempHomeGuard {
        fn new(name: &str) -> Self {
            let lock = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            let dir = create_test_dir(name);
            let prev_home = std::env::var_os("HOME");
            let prev_userprofile = std::env::var_os("USERPROFILE");
            std::env::set_var("HOME", &dir);
            std::env::set_var("USERPROFILE", &dir);
            Self {
                home_dir: dir,
                prev_home,
                prev_userprofile,
                _lock: lock,
            }
        }
    }

    impl Drop for TempHomeGuard {
        fn drop(&mut self) {
            match &self.prev_home {
                Some(val) => std::env::set_var("HOME", val),
                None => std::env::remove_var("HOME"),
            }
            match &self.prev_userprofile {
                Some(val) => std::env::set_var("USERPROFILE", val),
                None => std::env::remove_var("USERPROFILE"),
            }
            let _ = fs::remove_dir_all(&self.home_dir);
        }
    }

    #[test]
    fn set_skill_enabled_writes_openclaw_config_while_preserving_keys() {
        let guard = TempHomeGuard::new("skill_openclaw_sync");
        let openclaw_skills = guard.home_dir.join(".openclaw").join("skills");
        let skill_dir = openclaw_skills.join("weather-reporter");
        fs::create_dir_all(&skill_dir).unwrap();
        let skill_file = skill_dir.join("SKILL.md");
        fs::write(
            &skill_file,
            "---\nname: Weather Reporter\ndescription: Reports weather\n---\n# Docs\n",
        )
        .unwrap();

        let config_file = guard.home_dir.join(".openclaw").join("openclaw.json");
        let initial_json = r#"{
            "preserveRoot": "yes",
            "skills": {
                "preserveSkillSetting": 99,
                "entries": {
                    "existing-skill": {
                        "enabled": true
                    }
                }
            }
        }"#;
        fs::write(&config_file, initial_json).unwrap();

        // Disable skill
        let entry = set_skill_enabled(skill_file.to_string_lossy().to_string(), false).unwrap();
        assert!(!entry.enabled);
        assert_eq!(entry.id, "weather-reporter");
        assert_eq!(entry.source, "openclaw");

        let updated_content = fs::read_to_string(&config_file).unwrap();
        let parsed: Value = serde_json::from_str(&updated_content).unwrap();

        // Other keys preserved
        assert_eq!(parsed["preserveRoot"], "yes");
        assert_eq!(parsed["skills"]["preserveSkillSetting"], 99);
        assert_eq!(parsed["skills"]["entries"]["existing-skill"]["enabled"], true);

        // Entry updated
        assert_eq!(parsed["skills"]["entries"]["weather-reporter"]["enabled"], false);

        // Local skill-states.json is also maintained
        let states = load_skill_states().unwrap_or_default();
        let canon_path = fs::canonicalize(&skill_file).unwrap();
        assert_eq!(states.get(&canon_path.to_string_lossy().to_string()), Some(&false));

        // Re-enable skill
        let entry2 = set_skill_enabled(skill_file.to_string_lossy().to_string(), true).unwrap();
        assert!(entry2.enabled);

        let re_updated_content = fs::read_to_string(&config_file).unwrap();
        let parsed2: Value = serde_json::from_str(&re_updated_content).unwrap();
        assert_eq!(parsed2["skills"]["entries"]["weather-reporter"]["enabled"], true);
        assert_eq!(parsed2["preserveRoot"], "yes");
    }

    #[test]
    fn set_skill_enabled_corrupt_openclaw_config_returns_err_and_leaves_file_untouched() {
        let guard = TempHomeGuard::new("skill_corrupt_config");
        let openclaw_skills = guard.home_dir.join(".openclaw").join("skills");
        let skill_dir = openclaw_skills.join("test-corrupt-skill");
        fs::create_dir_all(&skill_dir).unwrap();
        let skill_file = skill_dir.join("SKILL.md");
        fs::write(&skill_file, "---\nname: Test Corrupt\n---\n").unwrap();

        let config_file = guard.home_dir.join(".openclaw").join("openclaw.json");
        let corrupt_content = "{ corrupt : json [[{";
        fs::write(&config_file, corrupt_content).unwrap();

        let result = set_skill_enabled(skill_file.to_string_lossy().to_string(), false);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Corrupt OpenClaw configuration"));

        let file_after = fs::read_to_string(&config_file).unwrap();
        assert_eq!(file_after, corrupt_content);
    }

    #[test]
    fn set_skill_enabled_proto_and_empty_rejected() {
        let guard = TempHomeGuard::new("skill_proto_rejected");
        let config_file = guard.home_dir.join(".openclaw").join("openclaw.json");

        let err1 = sync_skill_enabled_to_openclaw_at_path("__proto__", true, &config_file).unwrap_err();
        assert!(err1.contains("__proto__"));

        let err2 = sync_skill_enabled_to_openclaw_at_path("   ", true, &config_file).unwrap_err();
        assert!(err2.contains("empty"));

        assert!(!config_file.exists());
    }

    #[test]
    fn set_skill_enabled_missing_openclaw_config_created() {
        let guard = TempHomeGuard::new("skill_missing_config");
        let openclaw_skills = guard.home_dir.join(".openclaw").join("skills");
        let skill_dir = openclaw_skills.join("auto-create-config");
        fs::create_dir_all(&skill_dir).unwrap();
        let skill_file = skill_dir.join("SKILL.md");
        fs::write(&skill_file, "---\nname: Auto Create\n---\n").unwrap();

        let config_file = guard.home_dir.join(".openclaw").join("openclaw.json");
        assert!(!config_file.exists());

        set_skill_enabled(skill_file.to_string_lossy().to_string(), true).unwrap();

        assert!(config_file.exists());
        let parsed: Value = serde_json::from_str(&fs::read_to_string(&config_file).unwrap()).unwrap();
        assert_eq!(parsed["skills"]["entries"]["auto-create-config"]["enabled"], true);
    }
}
