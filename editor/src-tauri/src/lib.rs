use serde::Serialize;
use std::{
    fs,
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectEntry {
    path: String,
    name: String,
    kind: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadResult {
    content: String,
    last_modified: u64,
}

fn project_path(root: &str, relative: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    let relative = Path::new(relative);
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(format!("Invalid project path: {relative:?}"));
    }
    let path = fs::canonicalize(root.join(relative)).map_err(|error| error.to_string())?;
    if !path.starts_with(&root) {
        return Err("Project path resolves outside the selected directory".into());
    }
    Ok(path)
}

fn modified(path: &Path) -> Result<u64, String> {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .and_then(|time| {
            time.duration_since(UNIX_EPOCH)
                .map_err(std::io::Error::other)
        })
        .map(|duration| duration.as_millis() as u64)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn open_project() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("Open Anachronist project")
        .pick_folder()
        .map(|path| path.to_string_lossy().into_owned())
}

fn visit(root: &Path, directory: &Path, entries: &mut Vec<ProjectEntry>) -> Result<(), String> {
    for item in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let item = item.map_err(|error| error.to_string())?;
        let name = item.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let path = item.path();
        let relative = path
            .strip_prefix(root)
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        let kind = if path.is_dir() { "directory" } else { "file" };
        entries.push(ProjectEntry {
            path: relative,
            name,
            kind,
        });
        if kind == "directory" {
            visit(root, &path, entries)?;
        }
    }
    Ok(())
}

#[tauri::command]
fn list_project_files(root: String) -> Result<Vec<ProjectEntry>, String> {
    let root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    let mut entries = Vec::new();
    visit(&root, &root, &mut entries)?;
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(entries)
}

#[tauri::command]
fn read_project_text(root: String, path: String) -> Result<ReadResult, String> {
    let path = project_path(&root, &path)?;
    Ok(ReadResult {
        content: fs::read_to_string(&path).map_err(|error| error.to_string())?,
        last_modified: modified(&path)?,
    })
}

#[tauri::command]
fn read_project_bytes(root: String, path: String) -> Result<Vec<u8>, String> {
    fs::read(project_path(&root, &path)?).map_err(|error| error.to_string())
}

#[tauri::command]
fn write_project_text(root: String, path: String, content: String) -> Result<u64, String> {
    let path = project_path(&root, &path)?;
    fs::write(&path, content).map_err(|error| error.to_string())?;
    modified(&path)
}

#[tauri::command]
fn project_file_modified(root: String, path: String) -> Result<u64, String> {
    modified(&project_path(&root, &path)?)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            open_project,
            list_project_files,
            read_project_text,
            read_project_bytes,
            write_project_text,
            project_file_modified
        ])
        .run(tauri::generate_context!())
        .expect("error while running Anachronist Editor");
}
