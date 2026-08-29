use std::{
    sync::{
        Arc, Weak,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, Result, anyhow, bail};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Local, Utc};
use parking_lot::Mutex;
use rand::RngCore;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Size};
use tauri_plugin_updater::UpdaterExt;
use tokio::sync::Mutex as AsyncMutex;
use url::Url;
use uuid::Uuid;

use crate::{
    api::{ApiClient, ApiError, AuthorizationPoll, validate_external_url},
    engine::CaptureEngine,
    model::{
        ActiveCapture, AppSnapshot, Bounds, CaptureContext, CaptureTarget, CommitPayload,
        ConnectionState,
        DESKTOP_POLICY_VERSION, DeviceIdentity, PendingAuthorization, PrivacyAttestation,
        RecorderSettings, RecorderState, RecorderStatus, StartCaptureInput, TypedTextPolicy,
        UpdateState, UpdateStatus,
    },
    platform::{
        QuitChoice, capture_targets, monitor_descriptors, new_scope, quit_capture_choice,
        scope_outline_bounds, windows_device_name,
    },
    secure_store::{RecoveredSession, SecureStore},
};

/// The floating recorder is one fixed-size bar. It has no expanded or
/// retracted state to get stuck in — it shows the capture it is recording and
/// the three controls that act on it.
const HUD_WIDTH: f64 = 560.0;
const HUD_HEIGHT: f64 = 76.0;

/// How often the outline re-reads the recorded window's position.
///
/// This is the frame budget for something the author watches while dragging a
/// window, so it is paced like an animation rather than like a poll. Reading
/// the position costs two syscalls — the expensive part is moving the overlay,
/// which only happens when the window has actually moved.
const OUTLINE_FOLLOW_INTERVAL: Duration = Duration::from_millis(16);

struct Inner {
    connection: ConnectionState,
    recorder: RecorderState,
    settings: RecorderSettings,
    update: UpdateState,
    pending_authorization: Option<PendingAuthorization>,
    context: Option<CaptureContext>,
    active: Option<ActiveCapture>,
}

pub struct Coordinator {
    app: AppHandle,
    api: ApiClient,
    store: SecureStore,
    inner: Mutex<Inner>,
    engine: Mutex<Option<CaptureEngine>>,
    countdown_generation: AtomicU64,
    outline_generation: AtomicU64,
    finish_guard: AsyncMutex<()>,
    quitting: AtomicBool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizationLaunch {
    verification_uri: String,
}

impl Coordinator {
    pub fn new(app: AppHandle) -> Result<Arc<Self>> {
        let database_path = app
            .path()
            .app_data_dir()
            .context("locate KnowHow Capture data directory")?
            .join("capture-state.sqlite3");
        let store = SecureStore::open(&database_path)?;
        let device = device_identity(&store)?;
        let credentials = store.credentials()?;
        let pending = store.pending_authorization()?.filter(|pending| {
            DateTime::parse_from_rfc3339(&pending.expires_at)
                .map(|expires| expires.with_timezone(&Utc) > Utc::now())
                .unwrap_or(false)
        });
        if pending.is_none() {
            store.clear_pending_authorization()?;
        }
        let settings = store.settings()?;
        let recovery = store.recover_latest()?;
        let connection = if let Some(credentials) = credentials.as_ref() {
            ConnectionState::Connected {
                workspace_id: credentials.workspace_id.clone(),
                workspace_name: credentials.workspace_name.clone(),
                minimum_version: credentials.minimum_version.clone(),
            }
        } else if let Some(pending) = pending.as_ref() {
            ConnectionState::Authorizing {
                device_name: device.device_name.clone(),
                expires_at: pending.expires_at.clone(),
            }
        } else {
            ConnectionState::Disconnected
        };
        let (recorder, active) = recovery_state(recovery);
        let api = ApiClient::new(store.clone(), device)?;
        Ok(Arc::new(Self {
            app,
            api,
            store,
            inner: Mutex::new(Inner {
                connection,
                recorder,
                settings,
                update: UpdateState::default(),
                pending_authorization: pending,
                context: None,
                active,
            }),
            engine: Mutex::new(None),
            countdown_generation: AtomicU64::new(0),
            outline_generation: AtomicU64::new(0),
            finish_guard: AsyncMutex::new(()),
            quitting: AtomicBool::new(false),
        }))
    }

    pub fn snapshot(&self) -> AppSnapshot {
        let inner = self.inner.lock();
        AppSnapshot {
            version: env!("CARGO_PKG_VERSION").to_owned(),
            connection: inner.connection.clone(),
            recorder: inner.recorder.clone(),
            settings: inner.settings,
            update: inner.update.clone(),
        }
    }

    pub fn emit(&self) {
        let _ = self.app.emit("app-snapshot", self.snapshot());
    }

    pub fn start_background_tasks(self: &Arc<Self>) {
        let coordinator = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            coordinator.refresh_connection().await;
        });
        let weak = Arc::downgrade(self);
        tauri::async_runtime::spawn(async move {
            if let Some(coordinator) = weak.upgrade() {
                let _ = coordinator.check_update(false).await;
            }
            loop {
                tokio::time::sleep(Duration::from_secs(6 * 60 * 60)).await;
                let Some(coordinator) = weak.upgrade() else {
                    break;
                };
                let _ = coordinator.check_update(false).await;
            }
        });
    }

    async fn refresh_connection(&self) {
        if !self.api.has_credentials().await {
            return;
        }
        match self.api.refresh_and_context().await {
            Ok((credentials, context)) => {
                if context.workspace_id != credentials.workspace_id {
                    let mut inner = self.inner.lock();
                    inner.connection = ConnectionState::Disconnected;
                    drop(inner);
                    self.emit();
                    return;
                }
                let mut inner = self.inner.lock();
                apply_context_settings(&mut inner.settings, &context);
                let _ = self.store.save_settings(&inner.settings);
                inner.connection = ConnectionState::Connected {
                    workspace_id: context.workspace_id.clone(),
                    workspace_name: context.workspace_name.clone(),
                    minimum_version: context.minimum_version.clone(),
                };
                inner.context = Some(context);
            }
            Err(error) => {
                let message = user_error(&error);
                let mut inner = self.inner.lock();
                inner.connection = if error
                    .downcast_ref::<ApiError>()
                    .is_some_and(|api| api.status.as_u16() == 426)
                {
                    ConnectionState::Blocked { message }
                } else {
                    ConnectionState::Disconnected
                };
            }
        }
        self.emit();
    }

    pub async fn begin_authorization(&self) -> Result<AuthorizationLaunch> {
        if let Some(pending) = self.inner.lock().pending_authorization.clone() {
            let url = validate_external_url(self.api.public_origin(), &pending.verification_uri)?;
            open::that(url.as_str()).context("open browser device approval")?;
            return Ok(AuthorizationLaunch {
                verification_uri: url.to_string(),
            });
        }
        let mut bytes = [0_u8; 48];
        rand::rng().fill_bytes(&mut bytes);
        let pending = self
            .api
            .begin_authorization(URL_SAFE_NO_PAD.encode(bytes))
            .await?;
        let url = validate_external_url(self.api.public_origin(), &pending.verification_uri)?;
        {
            let mut inner = self.inner.lock();
            inner.connection = ConnectionState::Authorizing {
                device_name: windows_device_name(),
                expires_at: pending.expires_at.clone(),
            };
            inner.pending_authorization = Some(pending);
        }
        self.emit();
        open::that(url.as_str()).context("open browser device approval")?;
        Ok(AuthorizationLaunch {
            verification_uri: url.to_string(),
        })
    }

    pub async fn poll_authorization(&self) -> Result<AppSnapshot> {
        let Some(pending) = self.inner.lock().pending_authorization.clone() else {
            return Ok(self.snapshot());
        };
        if DateTime::parse_from_rfc3339(&pending.expires_at)
            .map(|expires| expires.with_timezone(&Utc) <= Utc::now())
            .unwrap_or(true)
        {
            self.store.clear_pending_authorization()?;
            let mut inner = self.inner.lock();
            inner.pending_authorization = None;
            inner.connection = ConnectionState::Disconnected;
            drop(inner);
            self.emit();
            bail!("This device approval expired. Start a new connection.");
        }
        let poll = match self.api.poll_authorization(&pending).await {
            Ok(poll) => poll,
            Err(error) if authorization_request_is_terminal(&error) => {
                // The browser made a final decision, or the request can no
                // longer be claimed. Keeping it here would make the approval
                // button reopen the same dead URL forever.
                self.store.clear_pending_authorization()?;
                let mut inner = self.inner.lock();
                inner.pending_authorization = None;
                inner.connection = ConnectionState::Disconnected;
                drop(inner);
                self.emit();
                return Ok(self.snapshot());
            }
            Err(error) => return Err(error),
        };
        match poll {
            AuthorizationPoll::Pending => {}
            AuthorizationPoll::Connected(credentials) => {
                let context = self.api.context().await?;
                if context.workspace_id != credentials.workspace_id {
                    bail!("Authorized workspace does not match the issued credential");
                }
                let mut inner = self.inner.lock();
                apply_context_settings(&mut inner.settings, &context);
                self.store.save_settings(&inner.settings)?;
                inner.connection = ConnectionState::Connected {
                    workspace_id: context.workspace_id.clone(),
                    workspace_name: context.workspace_name.clone(),
                    minimum_version: context.minimum_version.clone(),
                };
                inner.pending_authorization = None;
                inner.context = Some(context);
                drop(inner);
                self.emit();
            }
        }
        Ok(self.snapshot())
    }

    pub fn targets(&self) -> Result<Vec<CaptureTarget>> {
        capture_targets()
    }

    /// Local-only sign-out: wipes the stored device credential and pending
    /// authorization, mirroring the wipe `access_credentials` already
    /// performs when the server responds 401. There is no server call here —
    /// the device simply forgets its own credential, exactly as a revoked
    /// token would leave it.
    pub async fn disconnect(&self) -> Result<AppSnapshot> {
        if self.inner.lock().active.is_some() {
            bail!("Finish or discard the current capture before disconnecting.");
        }
        self.store.clear_credentials()?;
        self.store.clear_pending_authorization()?;
        {
            let mut inner = self.inner.lock();
            inner.connection = ConnectionState::Disconnected;
            inner.context = None;
            inner.pending_authorization = None;
        }
        self.emit();
        Ok(self.snapshot())
    }

    pub async fn start_capture(self: &Arc<Self>, input: StartCaptureInput) -> Result<AppSnapshot> {
        {
            let inner = self.inner.lock();
            if !matches!(inner.connection, ConnectionState::Connected { .. }) {
                bail!("Connect KnowHow Capture before recording.");
            }
            if inner.active.is_some() || inner.recorder.status != RecorderStatus::Idle {
                bail!("Finish or discard the current capture first.");
            }
        }
        let context = self.api.context().await?;
        if context.policy_version != DESKTOP_POLICY_VERSION {
            bail!("KnowHow capture policy changed. Update the app before recording.");
        }
        let targets = capture_targets()?;
        let target = input
            .target_id
            .as_ref()
            .and_then(|id| targets.iter().find(|target| &target.id == id));
        let scope = new_scope(input.scope_kind, target)?;
        let capture_text = input.capture_typed_text
            && context.desktop_typed_text_policy == TypedTextPolicy::Allowed;
        let title = format!(
            "Workflow in {} — {}",
            input.target_label.trim(),
            Local::now().format("%Y-%m-%d")
        );
        let session_id = format!("session_{}", Uuid::new_v4().simple());
        let started = self
            .api
            .start_capture(&session_id, &title, &scope, capture_text)
            .await?;
        let active = ActiveCapture {
            session_id: session_id.clone(),
            capture_id: started.capture_id.clone(),
            scope: scope.clone(),
            title,
            text_input_capture: if capture_text {
                "exact-non-password"
            } else {
                "none"
            }
            .to_owned(),
        };
        if let Err(error) = self.store.create_session(&active) {
            let _ = self.api.discard(&started.capture_id).await;
            return Err(error);
        }
        let mut settings = self.inner.lock().settings;
        settings.capture_typed_text = capture_text;
        settings.desktop_typed_text_policy = context.desktop_typed_text_policy;
        self.store.save_settings(&settings)?;
        let weak_for_step: Weak<Self> = Arc::downgrade(self);
        let on_step = Arc::new(move |step, image| {
            if let Some(coordinator) = weak_for_step.upgrade() {
                coordinator.accept_step(step, image);
            }
        });
        let weak_for_status: Weak<Self> = Arc::downgrade(self);
        let on_status = Arc::new(move |message| {
            if let Some(coordinator) = weak_for_status.upgrade() {
                coordinator.set_status_message(message);
            }
        });
        let engine = match CaptureEngine::start(scope, settings, true, on_step, on_status) {
            Ok(engine) => engine,
            Err(error) => {
                let _ = self.api.discard(&started.capture_id).await;
                self.store.cryptographic_erase_session(&session_id)?;
                return Err(error);
            }
        };
        *self.engine.lock() = Some(engine);
        {
            let mut inner = self.inner.lock();
            inner.settings = settings;
            inner.context = Some(context);
            inner.active = Some(active.clone());
            inner.recorder = RecorderState {
                status: RecorderStatus::Countdown,
                capture_id: Some(started.capture_id),
                scope_label: Some(active.scope.label()),
                countdown_remaining: Some(3),
                steps: Vec::new(),
                status_message: None,
                editor_url: None,
            };
        }
        let generation = self.countdown_generation.fetch_add(1, Ordering::AcqRel) + 1;
        self.emit();
        let coordinator = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            for remaining in [2_u8, 1] {
                tokio::time::sleep(Duration::from_secs(1)).await;
                if coordinator.countdown_generation.load(Ordering::Acquire) != generation {
                    return;
                }
                coordinator.inner.lock().recorder.countdown_remaining = Some(remaining);
                coordinator.emit();
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
            if coordinator.countdown_generation.load(Ordering::Acquire) != generation {
                return;
            }
            // Put Tauri's windows into their final recording state before reclaiming the
            // process-wide mouse and keyboard Raw Input registrations.
            let _ = coordinator.show_hud();
            coordinator.start_outline();
            if let Some(main) = coordinator.app.get_webview_window("main") {
                let _ = main.hide();
            }
            let input_ready = {
                let mut engine = coordinator.engine.lock();
                engine.as_mut().is_some_and(|engine| {
                    engine.rebind_raw_input().is_ok_and(|()| {
                        engine.resume();
                        true
                    })
                })
            };
            {
                let mut inner = coordinator.inner.lock();
                inner.recorder.status = RecorderStatus::Recording;
                inner.recorder.countdown_remaining = None;
                inner.recorder.status_message = Some(if input_ready {
                    "Recording clicks, typing, shortcuts, and drags".to_owned()
                } else {
                    "Input capture could not start. Pause and resume to retry.".to_owned()
                });
            }
            coordinator.emit();
        });
        Ok(self.snapshot())
    }

    pub async fn cancel_countdown(&self) -> Result<AppSnapshot> {
        if self.inner.lock().recorder.status != RecorderStatus::Countdown {
            return Ok(self.snapshot());
        }
        self.countdown_generation.fetch_add(1, Ordering::AcqRel);
        self.discard_capture().await
    }

    pub async fn pause_capture(&self) -> Result<AppSnapshot> {
        let active = {
            let mut inner = self.inner.lock();
            if inner.recorder.status != RecorderStatus::Recording {
                bail!("This capture is not recording.");
            }
            let active = inner
                .active
                .clone()
                .ok_or_else(|| anyhow!("active capture is unavailable"))?;
            inner.recorder.status = RecorderStatus::Paused;
            inner.recorder.status_message = Some("Paused".to_owned());
            active
        };
        if let Some(engine) = self.engine.lock().as_ref() {
            engine.pause();
        }
        self.store.set_session_state(&active.session_id, "paused")?;
        if self
            .api
            .transition(&active.capture_id, "pause")
            .await
            .is_err()
        {
            self.set_status_message("Offline — pause will reconcile when you finish.".to_owned());
        }
        self.emit();
        Ok(self.snapshot())
    }

    pub async fn resume_capture(&self) -> Result<AppSnapshot> {
        let active = {
            let mut inner = self.inner.lock();
            if inner.recorder.status != RecorderStatus::Paused {
                bail!("This capture is not paused.");
            }
            let active = inner
                .active
                .clone()
                .ok_or_else(|| anyhow!("active capture is unavailable"))?;
            inner.recorder.status = RecorderStatus::Recording;
            active
        };
        let input_ready = {
            let mut engine = self.engine.lock();
            engine.as_mut().is_some_and(|engine| {
                engine.rebind_raw_input().is_ok_and(|()| {
                    engine.resume();
                    true
                })
            })
        };
        self.inner.lock().recorder.status_message = Some(if input_ready {
            "Recording clicks, typing, shortcuts, and drags".to_owned()
        } else {
            "Input capture could not resume. Pause and resume to retry.".to_owned()
        });
        self.store
            .set_session_state(&active.session_id, "recording")?;
        if self
            .api
            .transition(&active.capture_id, "resume")
            .await
            .is_err()
        {
            self.set_status_message("Offline — resume will reconcile when you finish.".to_owned());
        }
        self.emit();
        Ok(self.snapshot())
    }

    pub async fn finish_capture(&self) -> Result<AppSnapshot> {
        let _finish = self.finish_guard.lock().await;
        let (active, step_count) = {
            let mut inner = self.inner.lock();
            if !matches!(
                inner.recorder.status,
                RecorderStatus::Recording | RecorderStatus::Paused | RecorderStatus::Recovery
            ) {
                bail!("This capture cannot be finished right now.");
            }
            if inner.recorder.steps.is_empty() {
                bail!("Perform at least one meaningful action before finishing.");
            }
            let active = inner
                .active
                .clone()
                .ok_or_else(|| anyhow!("active capture is unavailable"))?;
            inner.recorder.status = RecorderStatus::Finishing;
            inner.recorder.status_message = Some("Draining accepted actions…".to_owned());
            (active, inner.recorder.steps.len())
        };
        self.emit();
        let engine = self.engine.lock().take();
        if let Some(mut engine) = engine {
            let drained = tokio::task::spawn_blocking(move || {
                engine.stop_accepting_and_drain(Duration::from_secs(10))
            })
            .await
            .context("join capture drain worker")?;
            if let Err(error) = drained {
                self.recovery_failure("Accepted actions could not drain safely.", &error);
                return Err(error);
            }
        }
        let mut stored = self.store.load_steps(&active.session_id)?;
        if stored.len() < step_count {
            self.recovery_error("Some accepted steps are still processing. Retry Finish.");
            bail!("Some accepted steps are still processing.");
        }
        for (index, (step, _, _)) in stored.iter_mut().enumerate() {
            step.order = index;
        }
        {
            let mut inner = self.inner.lock();
            inner.recorder.status = RecorderStatus::Uploading;
            inner.recorder.status_message = Some("Uploading the private draft…".to_owned());
        }
        self.store
            .set_session_state(&active.session_id, "uploading")?;
        self.emit();
        if let Err(error) = self.api.transition(&active.capture_id, "resume").await
            && !is_transition_already_satisfied(&error)
        {
            self.recovery_failure("The capture could not be reopened for upload.", &error);
            return Err(error);
        }
        if let Err(error) = self
            .api
            .set_expected_steps(&active.capture_id, stored.len())
            .await
        {
            self.recovery_failure("The step count could not be registered.", &error);
            return Err(error);
        }
        for (step, image, _) in &stored {
            self.store
                .mark_step(&active.session_id, &step.id, "uploading")?;
            if let Err(error) = self
                .api
                .upload_step(&active.capture_id, &active.session_id, step, image.clone())
                .await
            {
                // Uploads carry an idempotency key, so pressing Finish again
                // re-sends the whole capture safely and the steps that already
                // landed are accepted a second time without duplicating.
                self.recovery_failure("A step could not be uploaded.", &error);
                return Err(error);
            }
            self.store
                .mark_step(&active.session_id, &step.id, "uploaded")?;
        }
        let steps = stored
            .iter()
            .map(|(step, _, _)| step.clone())
            .collect::<Vec<_>>();
        let automatic_mask_count = steps.iter().map(|step| step.automatic_mask_count).sum();
        let payload = CommitPayload {
            steps,
            privacy_attestation: PrivacyAttestation {
                policy_version: DESKTOP_POLICY_VERSION.to_owned(),
                source_rasterized: true,
                password_masks_applied: true,
                excluded_window_masks_applied: true,
                automatic_mask_count,
                manual_mask_count: 0,
            },
        };
        let committed = match self.api.commit(&active.capture_id, &payload).await {
            Ok(committed) => committed,
            Err(error) => {
                self.recovery_failure("The private draft could not be committed.", &error);
                return Err(error);
            }
        };
        if committed.guide_id.trim().is_empty()
            || committed.revision_id.trim().is_empty()
            || !committed.privacy_review_pending
        {
            self.recovery_error(
                "KnowHow returned an invalid desktop draft response. The encrypted local copy was kept.",
            );
            bail!("Invalid desktop draft response");
        }
        let editor = validate_external_url(self.api.public_origin(), &committed.edit_url)?;
        self.store.cryptographic_erase_session(&active.session_id)?;
        {
            let mut inner = self.inner.lock();
            inner.active = None;
            inner.recorder = RecorderState {
                editor_url: Some(editor.to_string()),
                ..RecorderState::default()
            };
        }
        self.stop_outline();
        if let Some(hud) = self.app.get_webview_window("hud") {
            let _ = hud.hide();
        }
        if let Some(main) = self.app.get_webview_window("main") {
            let _ = main.hide();
        }
        self.emit();
        open::that(editor.as_str()).context("open the private KnowHow draft")?;
        Ok(self.snapshot())
    }

    pub async fn discard_capture(&self) -> Result<AppSnapshot> {
        self.countdown_generation.fetch_add(1, Ordering::AcqRel);
        let active = self.inner.lock().active.clone();
        let engine = { self.engine.lock().take() };
        if let Some(mut engine) = engine {
            let _ = tokio::task::spawn_blocking(move || {
                engine.stop_accepting_and_drain(Duration::from_secs(2))
            })
            .await;
        }
        let mut server_warning = None;
        if let Some(active) = active {
            if self.api.discard(&active.capture_id).await.is_err() {
                server_warning = Some(
                    "Local data was erased. The unreachable private server draft will expire automatically."
                        .to_owned(),
                );
            }
            self.store.cryptographic_erase_session(&active.session_id)?;
        }
        {
            let mut inner = self.inner.lock();
            inner.active = None;
            inner.recorder = RecorderState::default();
            inner.recorder.status_message = server_warning;
        }
        self.stop_outline();
        if let Some(hud) = self.app.get_webview_window("hud") {
            let _ = hud.hide();
        }
        self.show_main()?;
        self.emit();
        Ok(self.snapshot())
    }

    pub fn update_settings(&self, mut settings: RecorderSettings) -> Result<AppSnapshot> {
        let mut inner = self.inner.lock();
        // Typed-text capture is the workspace's call, not this device's: when
        // the workspace disables it, the toggle cannot be turned back on here.
        if inner.settings.desktop_typed_text_policy == TypedTextPolicy::Disabled {
            settings.capture_typed_text = false;
            settings.desktop_typed_text_policy = TypedTextPolicy::Disabled;
        }
        self.store.save_settings(&settings)?;
        inner.settings = settings;
        drop(inner);
        self.emit();
        Ok(self.snapshot())
    }

    fn accept_step(&self, step: crate::model::CapturedStep, image: Vec<u8>) {
        let active = self.inner.lock().active.clone();
        let Some(active) = active else {
            return;
        };
        if let Err(error) = self.store.save_step(&active.session_id, &step, &image) {
            self.set_status_message(format!(
                "A step could not be encrypted: {}",
                user_error(&error)
            ));
            return;
        }
        {
            let mut inner = self.inner.lock();
            if !matches!(
                inner.recorder.status,
                RecorderStatus::Recording | RecorderStatus::Paused
            ) {
                return;
            }
            // The engine numbers steps from a counter that never rewinds, so a
            // screenshot that failed to process leaves a hole and a step captured
            // after a deletion jumps ahead of the list it is joining. The upload
            // re-indexes by insertion order regardless; this keeps the number the
            // recorder shows the author honest in the meantime.
            let mut summary = step.summary();
            summary.order = inner.recorder.steps.len();
            inner.recorder.steps.push(summary);
            inner.recorder.status_message = Some("Step captured".to_owned());
        }
        self.emit();
    }

    pub(crate) fn set_status_message(&self, message: String) {
        {
            let mut inner = self.inner.lock();
            // The engine reports a status for every event it decides not to
            // record, and those repeat verbatim: one identical line per click
            // outside the selected scope. Re-emitting the whole snapshot for a
            // message the recorder is already showing costs a full serialize
            // and a React re-render in both windows for nothing.
            if inner.recorder.status_message.as_deref() == Some(message.as_str()) {
                return;
            }
            inner.recorder.status_message = Some(message);
        }
        self.emit();
    }

    /// Reports a failure the author is asked to act on, keeping whatever the
    /// server said about it. The summary alone ("could not be committed, retry")
    /// is not something anyone can act on, and 4xx responses are not logged
    /// server-side either, so discarding the reason left no record of it at all.
    fn recovery_failure(&self, summary: &str, error: &anyhow::Error) {
        let detail = user_error(error);
        let code = error
            .downcast_ref::<ApiError>()
            .map(|api| api.code.clone())
            .filter(|code| !code.trim().is_empty());
        let message = match code {
            Some(code) => format!("{summary} {detail} [{code}]"),
            None => format!("{summary} {detail}"),
        };
        self.recovery_error(&message);
    }

    fn recovery_error(&self, message: &str) {
        let mut inner = self.inner.lock();
        inner.recorder.status = RecorderStatus::Recovery;
        inner.recorder.status_message = Some(message.to_owned());
        drop(inner);
        self.emit();
    }

    pub fn show_main(&self) -> Result<()> {
        let window = self
            .app
            .get_webview_window("main")
            .ok_or_else(|| anyhow!("main recorder window is unavailable"))?;
        window.show()?;
        window.unminimize()?;
        window.set_focus()?;
        Ok(())
    }

    /// Shows the floating recorder, placing it near the bottom of the display
    /// the first time it appears and leaving it wherever the author dragged it
    /// on every later capture.
    pub fn show_hud(&self) -> Result<()> {
        let window = self
            .app
            .get_webview_window("hud")
            .ok_or_else(|| anyhow!("capture controls are unavailable"))?;
        let scale = window.scale_factor().unwrap_or(1.0);
        let width = (HUD_WIDTH * scale) as i32;
        let height = (HUD_HEIGHT * scale) as i32;
        if !window.is_visible().unwrap_or(false)
            && let Ok(Some(monitor)) = window
                .current_monitor()
                .or_else(|_| window.primary_monitor())
        {
            let size = monitor.size();
            let origin = monitor.position();
            let (work_origin, work_size) = monitor_work_area(
                (origin.x, origin.y),
                (
                    i32::try_from(size.width).unwrap_or(width),
                    i32::try_from(size.height).unwrap_or(height),
                ),
            );
            let (x, y) = clamp_hud_position(
                (
                    work_origin.0 + (work_size.0 - width) / 2,
                    work_origin.1 + work_size.1 - height - (24.0 * scale) as i32,
                ),
                (width, height),
                work_origin,
                work_size,
                (8.0 * scale) as i32,
            );
            window.set_position(Position::Physical(PhysicalPosition::new(x, y)))?;
        }
        window.set_size(Size::Physical(PhysicalSize::new(
            u32::try_from(width.max(1))?,
            u32::try_from(height.max(1))?,
        )))?;
        window.show()?;
        Ok(())
    }

    /// Traces the recorded window with a click-through frame so the author can
    /// always see what is being captured, and keeps it on the window as that
    /// window moves, resizes, or is replaced by another of the app's windows.
    fn start_outline(self: &Arc<Self>) {
        let generation = self.outline_generation.fetch_add(1, Ordering::AcqRel) + 1;
        // The scope cannot change within a capture, so it is read once here
        // rather than cloned out from behind the lock on every frame.
        let Some(scope) = self.inner.lock().active.as_ref().map(|active| active.scope.clone())
        else {
            return;
        };
        let weak = Arc::downgrade(self);
        tauri::async_runtime::spawn(async move {
            let mut shown = false;
            let mut last: Option<Bounds> = None;
            loop {
                let Some(coordinator) = weak.upgrade() else {
                    return;
                };
                if coordinator.outline_generation.load(Ordering::Acquire) != generation {
                    return;
                }
                let recording = matches!(
                    coordinator.inner.lock().recorder.status,
                    RecorderStatus::Recording | RecorderStatus::Paused
                );
                if !recording {
                    coordinator.hide_outline();
                    return;
                }
                // Reading the foreground window and its composited frame is a
                // pair of non-blocking syscalls, so this stays inline; handing
                // each one to a blocking worker cost more than the work.
                match scope_outline_bounds(&scope) {
                    Some(bounds) => {
                        if last != Some(bounds) {
                            let _ = coordinator.place_outline(bounds, last);
                            last = Some(bounds);
                        }
                        if !shown
                            && let Some(window) = coordinator.app.get_webview_window("outline")
                        {
                            let _ = window.set_ignore_cursor_events(true);
                            shown = window.show().is_ok();
                        }
                    }
                    // The application has no window on screen right now —
                    // minimised, behind another app, or between windows. There
                    // is nothing to trace.
                    None => {
                        if shown {
                            coordinator.hide_outline();
                        }
                        last = None;
                        shown = false;
                    }
                }
                drop(coordinator);
                tokio::time::sleep(OUTLINE_FOLLOW_INTERVAL).await;
            }
        });
    }

    /// Moves and resizes the outline, issuing only the change that actually
    /// happened. Dragging a window changes its position every frame but not its
    /// size, and a redundant resize forces the transparent overlay to relayout
    /// and repaint — which is what made the outline trail behind the window.
    fn place_outline(&self, bounds: Bounds, previous: Option<Bounds>) -> Result<()> {
        let window = self
            .app
            .get_webview_window("outline")
            .ok_or_else(|| anyhow!("the recording outline is unavailable"))?;
        let moved = previous.is_none_or(|last| last.x != bounds.x || last.y != bounds.y);
        let resized =
            previous.is_none_or(|last| last.width != bounds.width || last.height != bounds.height);
        if resized {
            window.set_size(Size::Physical(PhysicalSize::new(
                bounds.width.max(1),
                bounds.height.max(1),
            )))?;
        }
        if moved {
            window.set_position(Position::Physical(PhysicalPosition::new(bounds.x, bounds.y)))?;
        }
        Ok(())
    }

    fn hide_outline(&self) {
        if let Some(window) = self.app.get_webview_window("outline") {
            let _ = window.hide();
        }
    }

    fn stop_outline(&self) {
        self.outline_generation.fetch_add(1, Ordering::AcqRel);
        self.hide_outline();
    }

    /// Pulls the recorder back only when a drag has left it somewhere it can
    /// never be reached from — off the end of a display, or onto one that was
    /// just unplugged. It deliberately does not snap or nudge while the author
    /// is dragging: repositioning the window from inside its own move loop is
    /// what made the bar feel immovable.
    pub fn constrain_hud_to_screen(&self) -> Result<()> {
        let window = self
            .app
            .get_webview_window("hud")
            .ok_or_else(|| anyhow!("capture controls are unavailable"))?;
        let Some(monitor) = window
            .current_monitor()
            .or_else(|_| window.primary_monitor())?
        else {
            return Ok(());
        };
        let position = window.outer_position()?;
        let size = window.outer_size()?;
        let origin = monitor.position();
        let monitor_size = monitor.size();
        let width = i32::try_from(size.width).unwrap_or(i32::MAX);
        let height = i32::try_from(size.height).unwrap_or(i32::MAX);
        let monitor_width = i32::try_from(monitor_size.width).unwrap_or(width);
        let monitor_height = i32::try_from(monitor_size.height).unwrap_or(height);
        let (work_origin, work_size) =
            monitor_work_area((origin.x, origin.y), (monitor_width, monitor_height));
        if hud_is_reachable((position.x, position.y), (width, height), work_origin, work_size) {
            return Ok(());
        }
        let scale = window.scale_factor().unwrap_or(1.0);
        let (x, y) = clamp_hud_position(
            (position.x, position.y),
            (width, height),
            work_origin,
            work_size,
            (8.0 * scale) as i32,
        );
        window.set_position(Position::Physical(PhysicalPosition::new(x, y)))?;
        Ok(())
    }

    pub fn open_knowhow(&self) -> Result<()> {
        open::that(self.api.public_origin()).context("open KnowHow")
    }

    pub async fn check_update(&self, install: bool) -> Result<AppSnapshot> {
        if self.inner.lock().active.is_some() {
            self.inner.lock().update.status = UpdateStatus::Deferred;
            self.emit();
            return Ok(self.snapshot());
        }
        {
            let mut inner = self.inner.lock();
            inner.update.status = UpdateStatus::Checking;
            inner.update.version = None;
        }
        self.emit();
        let result = async {
            if option_env!("KNOWHOW_DESKTOP_UPDATER_PUBKEY")
                .unwrap_or("")
                .trim()
                .is_empty()
            {
                bail!("the signed updater is not configured in this build");
            }
            let endpoint = update_endpoint()?;
            let updater = self
                .app
                .updater_builder()
                .endpoints(vec![endpoint])?
                .build()?;
            let update = updater.check().await?;
            if let Some(update) = update {
                {
                    let mut inner = self.inner.lock();
                    inner.update.status = UpdateStatus::Available;
                    inner.update.version = Some(update.version.to_string());
                }
                self.emit();
                if install && self.inner.lock().active.is_none() {
                    update.download_and_install(|_, _| {}, || {}).await?;
                }
            } else {
                self.inner.lock().update.status = UpdateStatus::Current;
            }
            Result::<()>::Ok(())
        }
        .await;
        if result.is_err() {
            self.inner.lock().update.status = UpdateStatus::Error;
        }
        self.emit();
        result?;
        Ok(self.snapshot())
    }

    pub async fn request_quit(&self) -> Result<()> {
        let active = self.inner.lock().active.is_some();
        if active {
            match quit_capture_choice() {
                QuitChoice::Finish => {
                    self.finish_capture().await?;
                }
                QuitChoice::Discard => {
                    self.discard_capture().await?;
                }
                QuitChoice::Cancel => return Ok(()),
            }
        }
        self.quitting.store(true, Ordering::Release);
        self.app.exit(0);
        Ok(())
    }

    pub fn is_quitting(&self) -> bool {
        self.quitting.load(Ordering::Acquire)
    }
}

fn monitor_work_area(
    monitor_origin: (i32, i32),
    monitor_size: (i32, i32),
) -> ((i32, i32), (i32, i32)) {
    monitor_descriptors()
        .ok()
        .and_then(|monitors| {
            monitors.into_iter().find(|monitor| {
                monitor.bounds.x == monitor_origin.0
                    && monitor.bounds.y == monitor_origin.1
                    && i32::try_from(monitor.bounds.width).ok() == Some(monitor_size.0)
                    && i32::try_from(monitor.bounds.height).ok() == Some(monitor_size.1)
            })
        })
        .and_then(|monitor| {
            Some((
                (monitor.work_area.x, monitor.work_area.y),
                (
                    i32::try_from(monitor.work_area.width).ok()?,
                    i32::try_from(monitor.work_area.height).ok()?,
                ),
            ))
        })
        .unwrap_or((monitor_origin, monitor_size))
}

/// Whether enough of the recorder bar is on the working area to grab it again.
fn hud_is_reachable(
    position: (i32, i32),
    window_size: (i32, i32),
    work_origin: (i32, i32),
    work_size: (i32, i32),
) -> bool {
    const REACHABLE_EDGE: i32 = 72;
    position.0 + window_size.0 > work_origin.0 + REACHABLE_EDGE
        && position.0 < work_origin.0 + work_size.0 - REACHABLE_EDGE
        && position.1 + window_size.1 > work_origin.1
        && position.1 < work_origin.1 + work_size.1
}

fn hud_limits(
    window_size: (i32, i32),
    work_origin: (i32, i32),
    work_size: (i32, i32),
    gap: i32,
) -> (i32, i32, i32, i32) {
    let min_x = work_origin.0 + gap;
    let min_y = work_origin.1 + gap;
    let max_x = (work_origin.0 + work_size.0 - window_size.0 - gap).max(min_x);
    let max_y = (work_origin.1 + work_size.1 - window_size.1 - gap).max(min_y);
    (min_x, max_x, min_y, max_y)
}

fn clamp_hud_position(
    position: (i32, i32),
    window_size: (i32, i32),
    monitor_origin: (i32, i32),
    monitor_size: (i32, i32),
    gap: i32,
) -> (i32, i32) {
    let (min_x, max_x, min_y, max_y) = hud_limits(window_size, monitor_origin, monitor_size, gap);
    (
        position.0.clamp(min_x, max_x),
        position.1.clamp(min_y, max_y),
    )
}

fn device_identity(store: &SecureStore) -> Result<DeviceIdentity> {
    if let Some(identity) = store.device_identity()? {
        return Ok(identity);
    }
    let identity = DeviceIdentity {
        device_id: format!("windows-{}", Uuid::new_v4().simple()),
        device_name: windows_device_name(),
        architecture: if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "x64"
        }
        .to_owned(),
    };
    store.save_device_identity(&identity)?;
    Ok(identity)
}

fn recovery_state(recovery: Option<RecoveredSession>) -> (RecorderState, Option<ActiveCapture>) {
    let Some(recovery) = recovery else {
        return (RecorderState::default(), None);
    };
    let steps = recovery
        .steps
        .iter()
        .map(|(step, _)| step.summary())
        .collect();
    let recorder = RecorderState {
        status: RecorderStatus::Recovery,
        capture_id: Some(recovery.active.capture_id.clone()),
        scope_label: Some(recovery.active.scope.label()),
        countdown_remaining: None,
        steps,
        status_message: Some(
            "An unfinished encrypted capture was recovered. Finish or discard it.".to_owned(),
        ),
        editor_url: None,
    };
    (recorder, Some(recovery.active))
}

fn apply_context_settings(settings: &mut RecorderSettings, context: &CaptureContext) {
    settings.desktop_typed_text_policy = context.desktop_typed_text_policy;
    if context.desktop_typed_text_policy == TypedTextPolicy::Disabled {
        settings.capture_typed_text = false;
    }
}

fn is_transition_already_satisfied(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<ApiError>()
        .is_some_and(|api| api.code == "CAPTURE_TRANSITION_INVALID")
}

fn authorization_request_is_terminal(error: &anyhow::Error) -> bool {
    error.downcast_ref::<ApiError>().is_some_and(|api| {
        matches!(
            api.code.as_str(),
            "DESKTOP_AUTHORIZATION_DENIED"
                | "DESKTOP_AUTHORIZATION_EXPIRED"
                | "DESKTOP_AUTHORIZATION_INVALID"
                | "DESKTOP_AUTHORIZATION_COMPLETE"
                | "PKCE_VERIFIER_INVALID"
                | "DEVICE_BINDING_INVALID"
        )
    })
}

fn user_error(error: &anyhow::Error) -> String {
    error
        .downcast_ref::<ApiError>()
        .map_or_else(|| error.to_string(), |api| api.message.clone())
}

// Small enough that a HUD feed of several thumbnails costs nothing to hold,
// large enough to still show what was on screen.
fn update_endpoint() -> Result<Url> {
    let endpoint = option_env!("KNOWHOW_DESKTOP_UPDATE_ENDPOINT").unwrap_or("");
    if endpoint.trim().is_empty() {
        bail!("the signed updater endpoint is not configured in this build");
    }
    let url = Url::parse(endpoint).context("parse signed updater endpoint")?;
    if url.scheme() != "https"
        || url.username() != ""
        || url.password().is_some()
        || url.fragment().is_some()
    {
        bail!("the signed updater endpoint must be an HTTPS URL");
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use anyhow::Error;
    use reqwest::StatusCode;

    use super::{authorization_request_is_terminal, clamp_hud_position, hud_is_reachable};
    use crate::api::ApiError;

    fn api_error(status: StatusCode, code: &str) -> Error {
        ApiError {
            status,
            code: code.to_owned(),
            message: "authorization failed".to_owned(),
        }
        .into()
    }

    #[test]
    fn denied_or_unusable_authorization_requests_are_terminal() {
        for (status, code) in [
            (StatusCode::FORBIDDEN, "DESKTOP_AUTHORIZATION_DENIED"),
            (StatusCode::GONE, "DESKTOP_AUTHORIZATION_EXPIRED"),
            (StatusCode::UNAUTHORIZED, "DESKTOP_AUTHORIZATION_INVALID"),
            (StatusCode::CONFLICT, "DESKTOP_AUTHORIZATION_COMPLETE"),
            (StatusCode::UNAUTHORIZED, "PKCE_VERIFIER_INVALID"),
            (StatusCode::UNAUTHORIZED, "DEVICE_BINDING_INVALID"),
        ] {
            assert!(authorization_request_is_terminal(&api_error(status, code)));
        }
        assert!(!authorization_request_is_terminal(&api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "DESKTOP_REQUEST_FAILED",
        )));
    }

    #[test]
    fn keeps_the_hud_inside_the_lower_right_screen_edge() {
        assert_eq!(
            clamp_hud_position((1_700, 1_050), (520, 72), (0, 0), (1_920, 1_080), 8),
            (1_392, 1_000)
        );
    }

    #[test]
    fn clamps_against_negative_coordinate_monitors() {
        assert_eq!(
            clamp_hud_position((-2_500, -20), (520, 72), (-1_920, 0), (1_920, 1_080), 8),
            (-1_912, 8)
        );
    }

    #[test]
    fn pins_oversized_hud_to_the_safe_origin() {
        assert_eq!(
            clamp_hud_position((400, 400), (2_400, 1_400), (0, 0), (1_920, 1_080), 8),
            (8, 8)
        );
    }

    #[test]
    fn a_dragged_hud_is_left_where_the_author_put_it() {
        // Hanging off an edge is a deliberate placement, not a rescue case:
        // pulling it back mid-drag is what stopped the bar from moving at all.
        assert!(hud_is_reachable((-200, 900), (560, 76), (0, 0), (1_920, 1_080)));
        assert!(hud_is_reachable((1_700, 1_040), (560, 76), (0, 0), (1_920, 1_080)));
    }

    #[test]
    fn a_hud_left_off_the_display_is_pulled_back() {
        assert!(!hud_is_reachable((-540, 900), (560, 76), (0, 0), (1_920, 1_080)));
        assert!(!hud_is_reachable((300, 1_200), (560, 76), (0, 0), (1_920, 1_080)));
    }
}
