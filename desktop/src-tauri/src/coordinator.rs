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
        ActiveCapture, AppSnapshot, CaptureContext, CaptureTarget, CommitPayload, ConnectionState,
        DESKTOP_POLICY_VERSION, DeviceIdentity, PendingAuthorization, PrivacyAttestation,
        RecorderSettings, RecorderState, RecorderStatus, StartCaptureInput, StepStatus,
        TypedTextPolicy, UpdateState, UpdateStatus,
    },
    platform::{QuitChoice, capture_targets, new_scope, quit_capture_choice, windows_device_name},
    secure_store::{RecoveredSession, SecureStore},
};

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
            settings: inner.settings.clone(),
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
        match self.api.poll_authorization(&pending).await? {
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
            smart_blur: input.smart_blur.clone(),
        };
        if let Err(error) = self.store.create_session(&active) {
            let _ = self.api.discard(&started.capture_id).await;
            return Err(error);
        }
        let mut settings = self.inner.lock().settings.clone();
        settings.capture_typed_text = capture_text;
        settings.desktop_typed_text_policy = context.desktop_typed_text_policy;
        settings.smart_blur = input.smart_blur;
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
        let engine = match CaptureEngine::start(scope, settings.clone(), true, on_step, on_status) {
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
            if let Some(engine) = coordinator.engine.lock().as_ref() {
                engine.resume();
            }
            {
                let mut inner = coordinator.inner.lock();
                inner.recorder.status = RecorderStatus::Recording;
                inner.recorder.countdown_remaining = None;
                inner.recorder.status_message = Some("Recording meaningful actions".to_owned());
            }
            let _ = coordinator.show_hud(false);
            if let Some(main) = coordinator.app.get_webview_window("main") {
                let _ = main.hide();
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
            inner.recorder.status_message = Some("Recording meaningful actions".to_owned());
            active
        };
        if let Some(engine) = self.engine.lock().as_ref() {
            engine.resume();
        }
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
                self.recovery_error("Accepted actions could not drain safely. Retry Finish.");
                return Err(error);
            }
        }
        let mut stored = self.store.load_steps(&active.session_id)?;
        if stored.len() < step_count {
            self.recovery_error("Some accepted steps are still processing. Retry Finish.");
            bail!("Some accepted steps are still processing.");
        }
        if stored
            .iter()
            .any(|(_, _, state)| state == "retry" || state == "deleting")
        {
            self.recovery_error("Retry or delete the flagged step before finishing.");
            bail!("Retry or delete the flagged step before finishing.");
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
            self.recovery_error("Network unavailable. Your encrypted capture is ready to retry.");
            return Err(error);
        }
        if let Err(error) = self
            .api
            .set_expected_steps(&active.capture_id, stored.len())
            .await
        {
            self.recovery_error("Network unavailable. Your encrypted capture is ready to retry.");
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
                self.store
                    .mark_step(&active.session_id, &step.id, "retry")?;
                {
                    let mut inner = self.inner.lock();
                    if let Some(summary) = inner
                        .recorder
                        .steps
                        .iter_mut()
                        .find(|item| item.id == step.id)
                    {
                        summary.status = StepStatus::Retry;
                    }
                }
                self.recovery_error(
                    "One step needs a retry. The encrypted capture remains on this device.",
                );
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
                self.recovery_error("The private draft could not be committed. Retry Finish.");
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
        if let Some(hud) = self.app.get_webview_window("hud") {
            let _ = hud.hide();
        }
        self.show_main()?;
        self.emit();
        Ok(self.snapshot())
    }

    pub fn delete_step(&self, step_id: &str) -> Result<AppSnapshot> {
        let active = {
            let inner = self.inner.lock();
            if !matches!(
                inner.recorder.status,
                RecorderStatus::Recording | RecorderStatus::Paused
            ) {
                bail!("Steps can only be deleted before upload begins.");
            }
            inner
                .active
                .clone()
                .ok_or_else(|| anyhow!("active capture is unavailable"))?
        };
        self.store.delete_step(&active.session_id, step_id)?;
        {
            let mut inner = self.inner.lock();
            inner.recorder.steps.retain(|step| step.id != step_id);
            for (index, step) in inner.recorder.steps.iter_mut().enumerate() {
                step.order = index;
            }
        }
        self.emit();
        Ok(self.snapshot())
    }

    pub fn retry_step(&self, step_id: &str) -> Result<AppSnapshot> {
        let active = self
            .inner
            .lock()
            .active
            .clone()
            .ok_or_else(|| anyhow!("active capture is unavailable"))?;
        self.store.mark_step(&active.session_id, step_id, "ready")?;
        {
            let mut inner = self.inner.lock();
            let summary = inner
                .recorder
                .steps
                .iter_mut()
                .find(|step| step.id == step_id)
                .ok_or_else(|| anyhow!("capture step is unavailable"))?;
            summary.status = StepStatus::Ready;
            inner.recorder.status_message =
                Some("Step is ready. Choose Finish to retry upload.".to_owned());
        }
        self.emit();
        Ok(self.snapshot())
    }

    pub fn update_settings(&self, mut settings: RecorderSettings) -> Result<AppSnapshot> {
        let mut inner = self.inner.lock();
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
            inner.recorder.steps.push(step.summary(StepStatus::Ready));
            inner.recorder.status_message = Some("Step captured".to_owned());
        }
        self.emit();
    }

    pub(crate) fn set_status_message(&self, message: String) {
        self.inner.lock().recorder.status_message = Some(message);
        self.emit();
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

    pub fn show_hud(&self, expanded: bool) -> Result<()> {
        let window = self
            .app
            .get_webview_window("hud")
            .ok_or_else(|| anyhow!("capture controls are unavailable"))?;
        let scale = window.scale_factor().unwrap_or(1.0);
        let logical_width = 520.0;
        let logical_height = if expanded { 345.0 } else { 78.0 };
        window.set_size(Size::Physical(PhysicalSize::new(
            (logical_width * scale) as u32,
            (logical_height * scale) as u32,
        )))?;
        if !expanded
            && let Ok(Some(monitor)) = window
                .current_monitor()
                .or_else(|_| window.primary_monitor())
        {
            let size = monitor.size();
            let origin = monitor.position();
            let width = (logical_width * scale) as i32;
            let height = (logical_height * scale) as i32;
            window.set_position(Position::Physical(PhysicalPosition::new(
                origin.x + (i32::try_from(size.width).unwrap_or(width) - width) / 2,
                origin.y + i32::try_from(size.height).unwrap_or(height)
                    - height
                    - (24.0 * scale) as i32,
            )))?;
        }
        window.show()?;
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
        .map(|(step, _)| step.summary(StepStatus::Ready))
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

fn user_error(error: &anyhow::Error) -> String {
    error
        .downcast_ref::<ApiError>()
        .map_or_else(|| error.to_string(), |api| api.message.clone())
}

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
