//! Tauri commands that supervise the local Node bridge.
//!
//! The desktop shell is a thin supervisor: rather than re-implementing the
//! bridge in Rust, it spawns the already-working `@diggy/bridge` package and
//! keeps a handle to the child process so it can be stopped again.
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use serde::Serialize;
use tauri::State;

/// Workspace root, derived from this crate's manifest directory:
/// `<root>/apps/desktop/src-tauri` -> `<root>`.
fn workspace_root() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent() // apps/desktop
        .and_then(|path| path.parent()) // apps
        .and_then(|path| path.parent()) // repo root
        .map(PathBuf::from)
        .unwrap_or(manifest_dir)
}

/// Build the command that runs the Node bridge.
///
/// `@diggy/bridge`'s documented entry point is `pnpm --filter @diggy/bridge
/// start`, i.e. `tsx src/main.ts`. We spawn the same entry through Node's tsx
/// loader — the equivalent of `node services/bridge` once the package is
/// registered with a TypeScript loader.
fn bridge_command() -> Command {
    let mut command = Command::new("node");
    command
        .arg("--import")
        .arg("tsx")
        .arg("services/bridge/src/main.ts")
        .current_dir(workspace_root())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    command
}

/// Managed state that owns the spawned bridge process, if one is running.
#[derive(Default)]
pub struct BridgeProcess(pub Mutex<Option<Child>>);

/// Serializable snapshot of the bridge's state, returned to the frontend.
#[derive(Debug, Serialize)]
pub struct BridgeStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub message: String,
}

impl BridgeStatus {
    fn stopped(message: impl Into<String>) -> Self {
        Self {
            running: false,
            pid: None,
            message: message.into(),
        }
    }
}

/// Start the bridge if it is not already running.
#[tauri::command]
pub fn start_bridge(state: State<'_, BridgeProcess>) -> Result<BridgeStatus, String> {
    let mut guard = state.0.lock().map_err(|error| error.to_string())?;

    if let Some(child) = guard.as_mut() {
        if child.try_wait().map_err(|error| error.to_string())?.is_none() {
            return Ok(BridgeStatus {
                running: true,
                pid: Some(child.id()),
                message: "bridge already running".into(),
            });
        }
    }

    let child = bridge_command()
        .spawn()
        .map_err(|error| format!("failed to spawn node bridge: {error}"))?;
    let status = BridgeStatus {
        running: true,
        pid: Some(child.id()),
        message: "bridge started".into(),
    };
    *guard = Some(child);
    Ok(status)
}

/// Stop the bridge if it is running.
#[tauri::command]
pub fn stop_bridge(state: State<'_, BridgeProcess>) -> Result<BridgeStatus, String> {
    let mut guard = state.0.lock().map_err(|error| error.to_string())?;

    match guard.take() {
        Some(mut child) => {
            let pid = child.id();
            child.kill().map_err(|error| error.to_string())?;
            let _ = child.wait();
            Ok(BridgeStatus {
                running: false,
                pid: Some(pid),
                message: "bridge stopped".into(),
            })
        }
        None => Ok(BridgeStatus::stopped("bridge was not running")),
    }
}

/// Report whether the bridge is currently running.
#[tauri::command]
pub fn bridge_status(state: State<'_, BridgeProcess>) -> Result<BridgeStatus, String> {
    let mut guard = state.0.lock().map_err(|error| error.to_string())?;

    match guard.as_mut() {
        Some(child) => {
            let running = child.try_wait().map_err(|error| error.to_string())?.is_none();
            Ok(BridgeStatus {
                running,
                pid: Some(child.id()),
                message: if running {
                    "bridge running".into()
                } else {
                    "bridge stopped".into()
                },
            })
        }
        None => Ok(BridgeStatus::stopped("bridge stopped")),
    }
}
