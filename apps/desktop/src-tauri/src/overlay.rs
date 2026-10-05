//! Overlay window management.
//!
//! The Diggy avatar lives in a transparent, always-on-top, decoration-less
//! window that floats above every other app. When the user needs to interact
//! with what is *underneath* it (for example to fill a form the overlay is
//! covering), the window can be switched to "click-through" mode via
//! [`toggle_click_through`], which uses `set_ignore_cursor_events`.
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// Label of the transparent avatar overlay window.
pub const OVERLAY_LABEL: &str = "overlay";

/// Tauri 2 does not expose a getter for "ignore cursor events", so we remember
/// the overlay's click-through state ourselves.
static CLICK_THROUGH: AtomicBool = AtomicBool::new(false);

/// Create the overlay window if it does not exist yet, otherwise return the
/// existing one. Safe to call on every launch.
pub fn ensure_overlay_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
        return Ok(window);
    }

    WebviewWindowBuilder::new(app, OVERLAY_LABEL, WebviewUrl::App("index.html".into()))
        .title("Diggy Overlay")
        .inner_size(360.0, 420.0)
        .position(0.0, 0.0)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .focused(false)
        .build()
}

/// Show or hide the overlay window. Returns the new visibility.
#[tauri::command]
pub fn toggle_overlay(app: AppHandle) -> Result<bool, String> {
    let window = app
        .get_webview_window(OVERLAY_LABEL)
        .ok_or_else(|| "overlay window is not available".to_string())?;

    let visible = window.is_visible().unwrap_or(false);
    if visible {
        window.hide().map_err(|error| error.to_string())?;
    } else {
        window.show().map_err(|error| error.to_string())?;
    }
    Ok(!visible)
}

/// Toggle (or explicitly set) click-through mode on the overlay.
///
/// When click-through is enabled the mouse passes straight through the
/// transparent window to whatever is underneath it, so the user can keep
/// working while the avatar stays visible. Pass `enabled` to force a value, or
/// `None` to flip the current state. Returns the resulting state.
#[tauri::command]
pub fn toggle_click_through(app: AppHandle, enabled: Option<bool>) -> Result<bool, String> {
    let window = app
        .get_webview_window(OVERLAY_LABEL)
        .ok_or_else(|| "overlay window is not available".to_string())?;

    let current = CLICK_THROUGH.load(Ordering::Relaxed);
    let next = enabled.unwrap_or(!current);
    window
        .set_ignore_cursor_events(next)
        .map_err(|error| error.to_string())?;
    CLICK_THROUGH.store(next, Ordering::Relaxed);
    Ok(next)
}
