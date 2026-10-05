// Prevents an extra console window from appearing on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod overlay;

use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// Ctrl+Shift+D toggles the overlay on/off from anywhere on the desktop.
fn overlay_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyD)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        let _ = overlay::toggle_overlay(app.clone());
                    }
                })
                .build(),
        )
        // Holds the spawned `node services/bridge` process, if any.
        .manage(commands::BridgeProcess::default())
        .setup(|app| {
            let handle = app.handle().clone();
            // The overlay may already exist (declared in tauri.conf.json);
            // this is idempotent and guarantees the window on first launch.
            overlay::ensure_overlay_window(&handle)?;
            handle.global_shortcut().register(overlay_shortcut())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            overlay::toggle_overlay,
            overlay::toggle_click_through,
            commands::start_bridge,
            commands::stop_bridge,
            commands::bridge_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Diggy desktop app");
}
