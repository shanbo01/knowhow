#![allow(clippy::chunks_exact_to_as_chunks)]

mod api;
mod coordinator;
mod engine;
mod model;
mod platform;
mod secure_store;

use std::sync::Arc;

use coordinator::{AuthorizationLaunch, Coordinator};
use model::{
    AppSnapshot, CaptureTarget, CaptureTargetPreview, RecorderSettings, RecorderStatus,
    StartCaptureInput,
};
use tauri::{
    Manager, State, WindowEvent,
    menu::MenuBuilder,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

type CommandResult<T> = Result<T, String>;

#[tauri::command]
fn app_snapshot(state: State<'_, Arc<Coordinator>>) -> AppSnapshot {
    state.snapshot()
}

#[tauri::command]
async fn begin_authorization(
    state: State<'_, Arc<Coordinator>>,
) -> CommandResult<AuthorizationLaunch> {
    state.begin_authorization().await.map_err(command_error)
}

#[tauri::command]
async fn poll_authorization(state: State<'_, Arc<Coordinator>>) -> CommandResult<AppSnapshot> {
    state.poll_authorization().await.map_err(command_error)
}

#[tauri::command]
async fn disconnect(state: State<'_, Arc<Coordinator>>) -> CommandResult<AppSnapshot> {
    state.disconnect().await.map_err(command_error)
}

// Window enumeration walks every top-level window and opens each owning
// process to check elevation. A synchronous Tauri command runs on the main
// thread, so doing that there stalls the recorder's own window for the whole
// pass — and the preview pass, which photographs each target, stalled it for
// far longer. Both hand the blocking work to a worker thread.
#[tauri::command]
async fn capture_targets(state: State<'_, Arc<Coordinator>>) -> CommandResult<Vec<CaptureTarget>> {
    let coordinator = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || coordinator.targets())
        .await
        .map_err(|error| error.to_string())?
        .map_err(command_error)
}

#[tauri::command]
async fn capture_target_previews(
    target_ids: Vec<String>,
) -> CommandResult<Vec<CaptureTargetPreview>> {
    tauri::async_runtime::spawn_blocking(move || platform::capture_target_previews(&target_ids))
        .await
        .map_err(|error| error.to_string())?
        .map_err(command_error)
}

#[tauri::command]
async fn start_capture(
    state: State<'_, Arc<Coordinator>>,
    input: StartCaptureInput,
) -> CommandResult<AppSnapshot> {
    state
        .inner()
        .clone()
        .start_capture(input)
        .await
        .map_err(command_error)
}

#[tauri::command]
async fn cancel_countdown(state: State<'_, Arc<Coordinator>>) -> CommandResult<AppSnapshot> {
    state.cancel_countdown().await.map_err(command_error)
}

#[tauri::command]
async fn pause_capture(state: State<'_, Arc<Coordinator>>) -> CommandResult<AppSnapshot> {
    state.pause_capture().await.map_err(command_error)
}

#[tauri::command]
async fn resume_capture(state: State<'_, Arc<Coordinator>>) -> CommandResult<AppSnapshot> {
    state.resume_capture().await.map_err(command_error)
}

#[tauri::command]
async fn finish_capture(state: State<'_, Arc<Coordinator>>) -> CommandResult<AppSnapshot> {
    state.finish_capture().await.map_err(command_error)
}

#[tauri::command]
async fn discard_capture(state: State<'_, Arc<Coordinator>>) -> CommandResult<AppSnapshot> {
    state.discard_capture().await.map_err(command_error)
}

#[tauri::command]
fn update_recorder_settings(
    state: State<'_, Arc<Coordinator>>,
    settings: RecorderSettings,
) -> CommandResult<AppSnapshot> {
    state.update_settings(settings).map_err(command_error)
}

#[tauri::command]
fn show_main_window(state: State<'_, Arc<Coordinator>>) -> CommandResult<()> {
    state.show_main().map_err(command_error)
}

#[tauri::command]
fn open_knowhow(state: State<'_, Arc<Coordinator>>) -> CommandResult<()> {
    state.open_knowhow().map_err(command_error)
}

#[tauri::command]
async fn check_for_updates(state: State<'_, Arc<Coordinator>>) -> CommandResult<AppSnapshot> {
    state.check_update(true).await.map_err(command_error)
}

#[tauri::command]
async fn request_quit(state: State<'_, Arc<Coordinator>>) -> CommandResult<()> {
    state.request_quit().await.map_err(command_error)
}

pub fn run() {
    let updater_key = option_env!("KNOWHOW_DESKTOP_UPDATER_PUBKEY")
        .unwrap_or("")
        .trim()
        .to_owned();
    let updater = if updater_key.is_empty() {
        tauri_plugin_updater::Builder::new().build()
    } else {
        tauri_plugin_updater::Builder::new()
            .pubkey(updater_key)
            .build()
    };
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(updater)
        .setup(|app| {
            // Tauri can set DPI awareness before setup; an already-set context is safe.
            let _ = platform::initialize_process();
            let coordinator = Coordinator::new(app.handle().clone())?;
            app.manage(Arc::clone(&coordinator));
            setup_tray(app.handle())?;
            coordinator.start_background_tasks();
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                let coordinator = window.state::<Arc<Coordinator>>();
                if !coordinator.is_quitting() {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            WindowEvent::Moved(_) if window.label() == "hud" => {
                let coordinator = window.state::<Arc<Coordinator>>();
                let _ = coordinator.constrain_hud_to_screen();
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            app_snapshot,
            begin_authorization,
            poll_authorization,
            disconnect,
            capture_targets,
            capture_target_previews,
            start_capture,
            cancel_countdown,
            pause_capture,
            resume_capture,
            finish_capture,
            discard_capture,
            update_recorder_settings,
            show_main_window,
            open_knowhow,
            check_for_updates,
            request_quit,
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|_error| {
            #[cfg(debug_assertions)]
            eprintln!("KnowHow Capture failed to start: {_error}");
            std::process::exit(1);
        });
}

fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .text("open-knowhow", "Open KnowHow")
        .separator()
        .text("quit", "Quit")
        .build()?;
    let mut tray = TrayIconBuilder::with_id("knowhow-capture")
        .menu(&menu)
        .tooltip("KnowHow Capture — left-click to open")
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let coordinator = tray
                    .app_handle()
                    .state::<Arc<Coordinator>>()
                    .inner()
                    .clone();
                let status = coordinator.snapshot().recorder.status;
                let result = if matches!(
                    status,
                    RecorderStatus::Recording
                        | RecorderStatus::Paused
                        | RecorderStatus::Finishing
                        | RecorderStatus::Uploading
                ) {
                    coordinator.show_hud()
                } else {
                    coordinator.show_main()
                };
                if let Err(error) = result {
                    coordinator.set_status_message(command_error(error));
                }
            }
        })
        .on_menu_event(|app, event| {
            let coordinator = app.state::<Arc<Coordinator>>().inner().clone();
            match event.id().as_ref() {
                "open-knowhow" => {
                    if let Err(error) = coordinator.open_knowhow() {
                        coordinator.set_status_message(command_error(error));
                    }
                }
                "quit" => {
                    tauri::async_runtime::spawn(async move {
                        if let Err(error) = coordinator.request_quit().await {
                            coordinator.set_status_message(command_error(error));
                        }
                    });
                }
                _ => {}
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }
    tray.build(app)?;
    Ok(())
}

fn command_error(error: anyhow::Error) -> String {
    error
        .downcast_ref::<api::ApiError>()
        .map_or_else(|| error.to_string(), |api| api.message.clone())
}
