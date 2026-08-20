mod frames;

use std::{
    io::Cursor,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use anyhow::{Context, Result, anyhow, bail};
use image::{ImageEncoder, Rgba, RgbaImage, imageops};
use parking_lot::Mutex;
use uuid::Uuid;

use self::frames::{DesktopFrame, FrameHub};
use crate::{
    model::{
        Bounds, CapturedStep, DesktopScope, MAX_SCREENSHOT_BYTES, MAX_STEPS, RecorderSettings,
        ServerAnnotation,
    },
    platform::{
        ElementMetadata, ForegroundContext, NativeRawInput, NativeUia, PasswordStatus,
        PointerButton, RawEvent, RawInputRegistration, UiAutomationClient, event_sender_capacity,
        excluded_regions, foreground_context, monitor_descriptors, scope_accepts,
    },
};

type StepCallback = Arc<dyn Fn(CapturedStep, Vec<u8>) + Send + Sync>;
type StatusCallback = Arc<dyn Fn(String) + Send + Sync>;

pub struct CaptureEngine {
    accepting: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    raw_input: Option<NativeRawInput>,
    frames: Arc<Mutex<FrameHub>>,
    processor: Option<JoinHandle<()>>,
    complete: Receiver<()>,
}

impl CaptureEngine {
    pub fn start(
        scope: DesktopScope,
        settings: RecorderSettings,
        start_paused: bool,
        on_step: StepCallback,
        on_status: StatusCallback,
    ) -> Result<Self> {
        let monitors = monitor_descriptors()?;
        let frames = Arc::new(Mutex::new(FrameHub::start(
            monitors,
            Arc::clone(&on_status),
        )?));
        let (sender, receiver) = mpsc::sync_channel(event_sender_capacity());
        let raw_input = NativeRawInput::start(sender)?;
        let accepting = Arc::new(AtomicBool::new(true));
        let paused = Arc::new(AtomicBool::new(start_paused));
        let processor_accepting = Arc::clone(&accepting);
        let processor_paused = Arc::clone(&paused);
        let processor_frames = Arc::clone(&frames);
        let (complete_sender, complete) = mpsc::sync_channel(1);
        let processor = thread::Builder::new()
            .name("knowhow-action-processor".to_owned())
            .spawn(move || {
                process_actions(
                    receiver,
                    scope,
                    settings,
                    processor_accepting,
                    processor_paused,
                    processor_frames,
                    on_step,
                    on_status,
                );
                let _ = complete_sender.send(());
            })?;
        Ok(Self {
            accepting,
            paused,
            raw_input: Some(raw_input),
            frames,
            processor: Some(processor),
            complete,
        })
    }

    pub fn pause(&self) {
        self.paused.store(true, Ordering::Release);
    }

    pub fn resume(&self) {
        self.paused.store(false, Ordering::Release);
    }

    pub fn stop_accepting_and_drain(&mut self, timeout: Duration) -> Result<()> {
        self.accepting.store(false, Ordering::Release);
        if let Some(mut raw_input) = self.raw_input.take() {
            raw_input.stop();
        }
        self.complete
            .recv_timeout(timeout)
            .context("accepted capture actions did not drain within ten seconds")?;
        if let Some(processor) = self.processor.take() {
            processor
                .join()
                .map_err(|_| anyhow!("capture action processor stopped unexpectedly"))?;
        }
        self.frames.lock().stop();
        Ok(())
    }
}

impl Drop for CaptureEngine {
    fn drop(&mut self) {
        self.accepting.store(false, Ordering::Release);
        if let Some(mut raw_input) = self.raw_input.take() {
            raw_input.stop();
        }
        let _ = self.complete.recv_timeout(Duration::from_secs(2));
        if let Some(processor) = self.processor.take()
            && processor.is_finished()
        {
            let _ = processor.join();
        }
        self.frames.lock().stop();
    }
}

#[derive(Clone)]
struct PendingPointer {
    button: PointerButton,
    point: (i32, i32),
    started_at: Instant,
    frame: DesktopFrame,
    metadata: ElementMetadata,
    foreground: ForegroundContext,
}

#[derive(Clone)]
struct PendingText {
    before: ElementMetadata,
    foreground: ForegroundContext,
    deadline: Instant,
}

enum MeaningfulAction {
    LeftClick { point: (i32, i32), double: bool },
    RightClick { point: (i32, i32) },
    Drag { from: (i32, i32), to: (i32, i32) },
    TextEntry,
    Enter,
    Tab,
    Shortcut(String),
    AppSwitch,
}

struct ProcessorState {
    pending_pointer: Option<PendingPointer>,
    pending_click: Option<PendingPointer>,
    pending_text: Option<PendingText>,
    last_focus: Option<ElementMetadata>,
    last_focus_poll: Instant,
    last_signature: Option<(String, Instant)>,
    locked: bool,
}

#[allow(clippy::too_many_arguments)]
fn process_actions(
    receiver: Receiver<RawEvent>,
    scope: DesktopScope,
    settings: RecorderSettings,
    accepting: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    frames: Arc<Mutex<FrameHub>>,
    on_step: StepCallback,
    on_status: StatusCallback,
) {
    let Ok(uia) = NativeUia::new() else {
        on_status("UI metadata is unavailable; coordinate instructions will be used.".to_owned());
        process_without_uia(
            receiver, scope, settings, accepting, paused, frames, on_step, on_status,
        );
        return;
    };
    let mut state = ProcessorState {
        pending_pointer: None,
        pending_click: None,
        pending_text: None,
        last_focus: uia.focused_element().ok(),
        last_focus_poll: Instant::now(),
        last_signature: None,
        locked: false,
    };
    let order = AtomicUsize::new(0);
    loop {
        flush_due(
            &mut state, &uia, &scope, &settings, &frames, &order, &on_step, &on_status,
        );
        match receiver.recv_timeout(Duration::from_millis(35)) {
            Ok(event) => {
                if handle_control_event(&event, &mut state, &on_status) {
                    continue;
                }
                if paused.load(Ordering::Acquire) || state.locked {
                    continue;
                }
                handle_event(
                    event, &mut state, &uia, &scope, &settings, &frames, &order, &on_step,
                    &on_status,
                );
            }
            Err(RecvTimeoutError::Timeout) => {
                if state.pending_text.is_none()
                    && state.last_focus_poll.elapsed() >= Duration::from_millis(120)
                {
                    state.last_focus = uia.focused_element().ok();
                    state.last_focus_poll = Instant::now();
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                flush_all(
                    &mut state, &uia, &scope, &settings, &frames, &order, &on_step, &on_status,
                );
                break;
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn process_without_uia(
    receiver: Receiver<RawEvent>,
    scope: DesktopScope,
    settings: RecorderSettings,
    _accepting: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    frames: Arc<Mutex<FrameHub>>,
    on_step: StepCallback,
    on_status: StatusCallback,
) {
    struct UnavailableUia;
    impl UiAutomationClient for UnavailableUia {
        fn element_at(&self, _x: i32, _y: i32) -> Result<ElementMetadata> {
            bail!("UI Automation unavailable")
        }
        fn focused_element(&self) -> Result<ElementMetadata> {
            bail!("UI Automation unavailable")
        }
    }
    let uia = UnavailableUia;
    let mut state = ProcessorState {
        pending_pointer: None,
        pending_click: None,
        pending_text: None,
        last_focus: None,
        last_focus_poll: Instant::now(),
        last_signature: None,
        locked: false,
    };
    let order = AtomicUsize::new(0);
    loop {
        let event = match receiver.recv_timeout(Duration::from_millis(50)) {
            Ok(event) => event,
            Err(RecvTimeoutError::Timeout) => {
                flush_due(
                    &mut state, &uia, &scope, &settings, &frames, &order, &on_step, &on_status,
                );
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => break,
        };
        if handle_control_event(&event, &mut state, &on_status)
            || paused.load(Ordering::Acquire)
            || state.locked
        {
            continue;
        }
        handle_event(
            event, &mut state, &uia, &scope, &settings, &frames, &order, &on_step, &on_status,
        );
    }
    flush_all(
        &mut state, &uia, &scope, &settings, &frames, &order, &on_step, &on_status,
    );
}

fn handle_control_event(
    event: &RawEvent,
    state: &mut ProcessorState,
    status: &StatusCallback,
) -> bool {
    match event {
        RawEvent::DisplayChanged => {
            status("Display layout changed. Reconnecting capture…".to_owned());
            true
        }
        RawEvent::SessionLocked => {
            state.locked = true;
            state.pending_pointer = None;
            state.pending_click = None;
            state.pending_text = None;
            status("Windows is locked. Activity is excluded.".to_owned());
            true
        }
        RawEvent::SessionUnlocked => {
            state.locked = false;
            status("Windows unlocked. Capture is ready.".to_owned());
            true
        }
        _ => false,
    }
}

#[allow(clippy::too_many_arguments)]
fn handle_event<U: UiAutomationClient>(
    event: RawEvent,
    state: &mut ProcessorState,
    uia: &U,
    scope: &DesktopScope,
    settings: &RecorderSettings,
    frames: &Arc<Mutex<FrameHub>>,
    order: &AtomicUsize,
    on_step: &StepCallback,
    on_status: &StatusCallback,
) {
    match event {
        RawEvent::PointerDown { button, x, y } => {
            let now = Instant::now();
            let Ok(foreground) = foreground_context() else {
                on_status("Protected or secure-desktop activity is excluded.".to_owned());
                return;
            };
            if !scope_accepts(scope, &foreground, Some((x, y))) {
                on_status("Activity outside the selected scope is ignored.".to_owned());
                return;
            }
            let Some(frame) = frames.lock().newest_before(&foreground.monitor_id, now) else {
                on_status("Waiting for a safe display frame…".to_owned());
                return;
            };
            let metadata = uia
                .element_at(x, y)
                .unwrap_or_else(|_| fallback_metadata(&foreground));
            state.pending_pointer = Some(PendingPointer {
                button,
                point: (x, y),
                started_at: now,
                frame,
                metadata,
                foreground,
            });
        }
        RawEvent::PointerUp { button, x, y } => {
            let Some(pointer) = state.pending_pointer.take() else {
                return;
            };
            if pointer.button != button {
                return;
            }
            let distance = squared_distance(pointer.point, (x, y));
            if button == PointerButton::Left && distance > 64 {
                emit(
                    MeaningfulAction::Drag {
                        from: pointer.point,
                        to: (x, y),
                    },
                    pointer.frame,
                    pointer.metadata,
                    pointer.foreground,
                    None,
                    settings,
                    order,
                    on_step,
                    on_status,
                );
            } else if button == PointerButton::Right {
                emit(
                    MeaningfulAction::RightClick {
                        point: pointer.point,
                    },
                    pointer.frame,
                    pointer.metadata,
                    pointer.foreground,
                    None,
                    settings,
                    order,
                    on_step,
                    on_status,
                );
            } else if let Some(first) = state.pending_click.take() {
                if pointer.started_at.duration_since(first.started_at) <= Duration::from_millis(500)
                    && squared_distance(pointer.point, first.point) <= 25
                {
                    emit(
                        MeaningfulAction::LeftClick {
                            point: first.point,
                            double: true,
                        },
                        first.frame,
                        first.metadata,
                        first.foreground,
                        None,
                        settings,
                        order,
                        on_step,
                        on_status,
                    );
                } else {
                    emit_pending_click(first, settings, order, on_step, on_status);
                    state.pending_click = Some(pointer);
                }
            } else {
                state.pending_click = Some(pointer);
            }
        }
        RawEvent::TextActivity => {
            let now = Instant::now();
            if let Some(pending) = &mut state.pending_text {
                pending.deadline = now + Duration::from_millis(450);
                return;
            }
            let Ok(foreground) = foreground_context() else {
                return;
            };
            if !scope_accepts(scope, &foreground, None) {
                on_status("Activity outside the selected scope is ignored.".to_owned());
                return;
            }
            let before = state
                .last_focus
                .clone()
                .or_else(|| uia.focused_element().ok())
                .unwrap_or_else(|| fallback_metadata(&foreground));
            state.pending_text = Some(PendingText {
                before,
                foreground,
                deadline: now + Duration::from_millis(450),
            });
        }
        RawEvent::Enter | RawEvent::Tab => {
            flush_text(
                state, uia, scope, settings, frames, order, on_step, on_status,
            );
            emit_keyboard_action(
                if matches!(event, RawEvent::Enter) {
                    MeaningfulAction::Enter
                } else {
                    MeaningfulAction::Tab
                },
                uia,
                scope,
                settings,
                frames,
                order,
                on_step,
                on_status,
            );
        }
        RawEvent::Shortcut(shortcut) => {
            flush_text(
                state, uia, scope, settings, frames, order, on_step, on_status,
            );
            let signature = format!("shortcut:{shortcut}");
            if is_duplicate(
                &mut state.last_signature,
                &signature,
                Duration::from_millis(220),
            ) {
                return;
            }
            if shortcut == "Alt+Tab" || shortcut.starts_with("Win+") {
                thread::sleep(Duration::from_millis(220));
                emit_keyboard_action(
                    MeaningfulAction::AppSwitch,
                    uia,
                    scope,
                    settings,
                    frames,
                    order,
                    on_step,
                    on_status,
                );
            } else {
                emit_keyboard_action(
                    MeaningfulAction::Shortcut(shortcut),
                    uia,
                    scope,
                    settings,
                    frames,
                    order,
                    on_step,
                    on_status,
                );
            }
        }
        RawEvent::DisplayChanged | RawEvent::SessionLocked | RawEvent::SessionUnlocked => {}
    }
}

#[allow(clippy::too_many_arguments)]
fn emit_keyboard_action<U: UiAutomationClient>(
    action: MeaningfulAction,
    uia: &U,
    scope: &DesktopScope,
    settings: &RecorderSettings,
    frames: &Arc<Mutex<FrameHub>>,
    order: &AtomicUsize,
    on_step: &StepCallback,
    on_status: &StatusCallback,
) {
    let Ok(foreground) = foreground_context() else {
        on_status("Protected or secure-desktop activity is excluded.".to_owned());
        return;
    };
    if !scope_accepts(scope, &foreground, None) {
        on_status("Activity outside the selected scope is ignored.".to_owned());
        return;
    }
    let Some(frame) = frames.lock().latest(&foreground.monitor_id) else {
        on_status("Waiting for a safe display frame…".to_owned());
        return;
    };
    let metadata = uia
        .focused_element()
        .unwrap_or_else(|_| fallback_metadata(&foreground));
    emit(
        action, frame, metadata, foreground, None, settings, order, on_step, on_status,
    );
}

#[allow(clippy::too_many_arguments)]
fn flush_due<U: UiAutomationClient>(
    state: &mut ProcessorState,
    uia: &U,
    scope: &DesktopScope,
    settings: &RecorderSettings,
    frames: &Arc<Mutex<FrameHub>>,
    order: &AtomicUsize,
    on_step: &StepCallback,
    on_status: &StatusCallback,
) {
    if state
        .pending_click
        .as_ref()
        .is_some_and(|click| click.started_at.elapsed() > Duration::from_millis(500))
        && let Some(click) = state.pending_click.take()
    {
        emit_pending_click(click, settings, order, on_step, on_status);
    }
    if state
        .pending_text
        .as_ref()
        .is_some_and(|text| text.deadline <= Instant::now())
    {
        flush_text(
            state, uia, scope, settings, frames, order, on_step, on_status,
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn flush_all<U: UiAutomationClient>(
    state: &mut ProcessorState,
    uia: &U,
    scope: &DesktopScope,
    settings: &RecorderSettings,
    frames: &Arc<Mutex<FrameHub>>,
    order: &AtomicUsize,
    on_step: &StepCallback,
    on_status: &StatusCallback,
) {
    if let Some(click) = state.pending_click.take() {
        emit_pending_click(click, settings, order, on_step, on_status);
    }
    flush_text(
        state, uia, scope, settings, frames, order, on_step, on_status,
    );
}

fn emit_pending_click(
    click: PendingPointer,
    settings: &RecorderSettings,
    order: &AtomicUsize,
    on_step: &StepCallback,
    on_status: &StatusCallback,
) {
    emit(
        MeaningfulAction::LeftClick {
            point: click.point,
            double: false,
        },
        click.frame,
        click.metadata,
        click.foreground,
        None,
        settings,
        order,
        on_step,
        on_status,
    );
}

#[allow(clippy::too_many_arguments)]
fn flush_text<U: UiAutomationClient>(
    state: &mut ProcessorState,
    uia: &U,
    scope: &DesktopScope,
    settings: &RecorderSettings,
    frames: &Arc<Mutex<FrameHub>>,
    order: &AtomicUsize,
    on_step: &StepCallback,
    on_status: &StatusCallback,
) {
    let Some(pending) = state.pending_text.take() else {
        return;
    };
    let after = uia
        .focused_element()
        .unwrap_or_else(|_| fallback_metadata(&pending.foreground));
    state.last_focus = Some(after.clone());
    let foreground = foreground_context().unwrap_or(pending.foreground);
    if !scope_accepts(scope, &foreground, None) {
        on_status("Activity outside the selected scope is ignored.".to_owned());
        return;
    }
    let Some(frame) = frames.lock().latest(&foreground.monitor_id) else {
        on_status("Waiting for a stable post-entry frame…".to_owned());
        return;
    };
    let exact_text = if settings.capture_typed_text
        && pending.before.password_status == PasswordStatus::NotPassword
        && after.password_status == PasswordStatus::NotPassword
        && pending.before.window_id == after.window_id
        && pending.before.process_id == after.process_id
    {
        match (pending.before.value.as_deref(), after.value.as_deref()) {
            (Some(before), Some(after)) => inserted_text(before, after),
            _ => None,
        }
    } else {
        None
    };
    emit(
        MeaningfulAction::TextEntry,
        frame,
        after,
        foreground,
        exact_text,
        settings,
        order,
        on_step,
        on_status,
    );
}

#[allow(clippy::too_many_arguments)]
fn emit(
    action: MeaningfulAction,
    frame: DesktopFrame,
    metadata: ElementMetadata,
    foreground: ForegroundContext,
    exact_text: Option<String>,
    settings: &RecorderSettings,
    order: &AtomicUsize,
    on_step: &StepCallback,
    on_status: &StatusCallback,
) {
    let sequence = order.fetch_add(1, Ordering::AcqRel);
    if sequence >= MAX_STEPS {
        on_status("The 100-step limit is reached. Finish this capture to continue.".to_owned());
        return;
    }
    let (title, instructions, source_event) =
        deterministic_instruction(&action, &metadata, &foreground, exact_text.as_deref());
    let annotations = annotations(&action, &metadata, &frame);
    match rasterize(&frame, &metadata, &foreground, &action, settings) {
        Ok(processed) => {
            let text = if metadata.password_status == PasswordStatus::NotPassword {
                exact_text
            } else {
                None
            };
            let step = CapturedStep {
                id: format!("step_{}", Uuid::new_v4().simple()),
                order: sequence,
                title,
                instructions,
                source_event: source_event.to_owned(),
                password_status: metadata.password_status.as_server_value().to_owned(),
                annotations,
                text,
                image_width: processed.width,
                image_height: processed.height,
                automatic_mask_count: processed.mask_count,
            };
            on_step(step, processed.jpeg);
        }
        Err(_) => on_status(
            "A screenshot could not be processed safely; that action was not saved.".to_owned(),
        ),
    }
}

fn fallback_metadata(foreground: &ForegroundContext) -> ElementMetadata {
    ElementMetadata {
        application_name: foreground.application_name.clone(),
        window_title: foreground.window_title.clone(),
        control_role: None,
        control_label: None,
        bounds: None,
        password_status: PasswordStatus::Unknown,
        value: None,
        window_id: foreground.window_id.clone(),
        process_id: foreground.process_id,
    }
}

fn deterministic_instruction(
    action: &MeaningfulAction,
    metadata: &ElementMetadata,
    foreground: &ForegroundContext,
    exact_text: Option<&str>,
) -> (String, String, &'static str) {
    let application = if metadata.application_name.is_empty() {
        &foreground.application_name
    } else {
        &metadata.application_name
    };
    let location = if metadata.window_title.trim().is_empty()
        || metadata.window_title.eq_ignore_ascii_case(application)
    {
        application.to_owned()
    } else {
        format!("{} in {application}", truncate(&metadata.window_title, 80))
    };
    let target = metadata
        .control_label
        .as_deref()
        .filter(|label| !label.trim().is_empty());
    let role = metadata.control_role.as_deref().unwrap_or("control");
    let described = target
        .map(|label| format!("the “{}” {role}", truncate(label, 120)))
        .unwrap_or_else(|| format!("the selected area in {location}"));
    match action {
        MeaningfulAction::LeftClick { double: false, .. } => (
            target.map_or_else(
                || "Click the selected area".to_owned(),
                |label| format!("Click {}", truncate(label, 80)),
            ),
            format!("Click {described}."),
            "left-click",
        ),
        MeaningfulAction::LeftClick { double: true, .. } => (
            target.map_or_else(
                || "Double-click the selected area".to_owned(),
                |label| format!("Double-click {}", truncate(label, 80)),
            ),
            format!("Double-click {described}."),
            "double-click",
        ),
        MeaningfulAction::RightClick { .. } => (
            target.map_or_else(
                || "Open the context menu".to_owned(),
                |label| format!("Right-click {}", truncate(label, 80)),
            ),
            format!("Right-click {described}."),
            "right-click",
        ),
        MeaningfulAction::Drag { .. } => (
            "Drag the selected item".to_owned(),
            format!("Drag {described} to the highlighted destination."),
            "drag",
        ),
        MeaningfulAction::TextEntry => {
            let instruction = exact_text.map_or_else(
                || format!("Enter text in {described}."),
                |text| format!("Enter “{}” in {described}.", truncate(text, 180)),
            );
            ("Enter text".to_owned(), instruction, "text-entry")
        }
        MeaningfulAction::Enter => (
            "Press Enter".to_owned(),
            format!("Press Enter in {location}."),
            "enter",
        ),
        MeaningfulAction::Tab => (
            "Press Tab".to_owned(),
            format!("Press Tab in {location}."),
            "tab",
        ),
        MeaningfulAction::Shortcut(shortcut) => (
            format!("Press {shortcut}"),
            format!("Press {shortcut} in {location}."),
            "shortcut",
        ),
        MeaningfulAction::AppSwitch => (
            format!("Switch to {application}"),
            format!("Switch to {application}."),
            "app-switch",
        ),
    }
}

fn annotations(
    action: &MeaningfulAction,
    metadata: &ElementMetadata,
    frame: &DesktopFrame,
) -> Vec<ServerAnnotation> {
    match action {
        MeaningfulAction::LeftClick { point, .. } | MeaningfulAction::RightClick { point } => {
            let (x, y) = normalize_point(*point, frame.monitor_bounds);
            vec![ServerAnnotation {
                id: format!("annotation_{}", Uuid::new_v4().simple()),
                kind: "click".to_owned(),
                x,
                y,
                width: Some(0.035),
                height: None,
                x2: None,
                y2: None,
                color: Some("#25634f".to_owned()),
            }]
        }
        MeaningfulAction::Drag { from, to } => {
            let (x, y) = normalize_point(*from, frame.monitor_bounds);
            let (x2, y2) = normalize_point(*to, frame.monitor_bounds);
            vec![ServerAnnotation {
                id: format!("annotation_{}", Uuid::new_v4().simple()),
                kind: "arrow".to_owned(),
                x,
                y,
                width: None,
                height: None,
                x2: Some(x2),
                y2: Some(y2),
                color: Some("#25634f".to_owned()),
            }]
        }
        MeaningfulAction::TextEntry | MeaningfulAction::Enter | MeaningfulAction::Tab => metadata
            .bounds
            .and_then(|bounds| normalize_bounds(bounds, frame.monitor_bounds))
            .map(|(x, y, width, height)| ServerAnnotation {
                id: format!("annotation_{}", Uuid::new_v4().simple()),
                kind: "box".to_owned(),
                x,
                y,
                width: Some(width),
                height: Some(height),
                x2: None,
                y2: None,
                color: Some("#25634f".to_owned()),
            })
            .into_iter()
            .collect(),
        MeaningfulAction::Shortcut(_) | MeaningfulAction::AppSwitch => Vec::new(),
    }
}

struct ProcessedImage {
    jpeg: Vec<u8>,
    width: u32,
    height: u32,
    mask_count: usize,
}

fn rasterize(
    frame: &DesktopFrame,
    metadata: &ElementMetadata,
    foreground: &ForegroundContext,
    action: &MeaningfulAction,
    settings: &RecorderSettings,
) -> Result<ProcessedImage> {
    let expected = usize::try_from(frame.width)?
        .checked_mul(usize::try_from(frame.height)?)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| anyhow!("display frame is too large"))?;
    if frame.bgra.len() != expected {
        bail!("DXGI frame size does not match its dimensions");
    }
    let mut image = RgbaImage::new(frame.width, frame.height);
    for (target, source) in image.pixels_mut().zip(frame.bgra.chunks_exact(4)) {
        *target = Rgba([source[2], source[1], source[0], 255]);
    }
    let mut mask_count = 0_usize;
    for excluded in excluded_regions().unwrap_or_default() {
        let _reason = excluded.reason;
        if let Some(bounds) = global_to_image_bounds(excluded.bounds, frame) {
            solid_mask(&mut image, bounds);
            mask_count += 1;
        }
    }
    if matches!(action, MeaningfulAction::TextEntry)
        && metadata.password_status != PasswordStatus::NotPassword
    {
        let fail_closed = metadata.bounds.unwrap_or(foreground.bounds);
        if let Some(bounds) = global_to_image_bounds(fail_closed, frame) {
            solid_mask(&mut image, bounds);
            mask_count += 1;
        }
    } else if metadata.password_status == PasswordStatus::Password
        && let Some(bounds) = metadata
            .bounds
            .and_then(|bounds| global_to_image_bounds(bounds, frame))
    {
        solid_mask(&mut image, bounds);
        mask_count += 1;
    }
    if should_smart_blur(metadata, settings)
        && let Some(bounds) = metadata
            .bounds
            .and_then(|bounds| global_to_image_bounds(bounds, frame))
    {
        blur_region(&mut image, bounds);
        mask_count += 1;
    }
    let (jpeg, width, height) = encode_bounded(image)?;
    Ok(ProcessedImage {
        jpeg,
        width,
        height,
        mask_count,
    })
}

fn should_smart_blur(metadata: &ElementMetadata, settings: &RecorderSettings) -> bool {
    let role = metadata.control_role.as_deref().unwrap_or("");
    let value = metadata.value.as_deref().unwrap_or("");
    (settings.smart_blur.form_fields && matches!(role, "text field" | "combo box"))
        || (settings.smart_blur.images && role == "image")
        || (settings.smart_blur.table_rows && matches!(role, "table" | "data grid" | "list item"))
        || (settings.smart_blur.emails && looks_like_email(value))
        || (settings.smart_blur.phone_numbers && looks_like_phone(value))
        || (settings.smart_blur.financial_numbers && looks_like_financial(value))
        || (settings.smart_blur.identifiers && looks_like_identifier(value))
        || (settings.smart_blur.long_text && value.chars().count() >= 80)
}

fn looks_like_email(value: &str) -> bool {
    value.split_whitespace().any(|word| {
        let mut parts = word.split('@');
        parts.next().is_some_and(|left| !left.is_empty())
            && parts.next().is_some_and(|right| right.contains('.'))
            && parts.next().is_none()
    })
}

fn looks_like_phone(value: &str) -> bool {
    let digits = value.chars().filter(char::is_ascii_digit).count();
    digits >= 7 && digits * 2 >= value.chars().count().max(1)
}

fn looks_like_financial(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    (lower.contains('$') || lower.contains('€') || lower.contains('£') || lower.contains("qar"))
        && value.chars().filter(char::is_ascii_digit).count() >= 2
}

fn looks_like_identifier(value: &str) -> bool {
    value.chars().count() >= 12
        && value.chars().filter(char::is_ascii_alphanumeric).count() >= 10
        && !value.contains(' ')
}

fn global_to_image_bounds(bounds: Bounds, frame: &DesktopFrame) -> Option<Bounds> {
    let intersection = bounds.intersection(frame.monitor_bounds)?;
    let scale_x = f64::from(frame.width) / f64::from(frame.monitor_bounds.width.max(1));
    let scale_y = f64::from(frame.height) / f64::from(frame.monitor_bounds.height.max(1));
    let x = (f64::from(intersection.x - frame.monitor_bounds.x) * scale_x)
        .floor()
        .max(0.0);
    let y = (f64::from(intersection.y - frame.monitor_bounds.y) * scale_y)
        .floor()
        .max(0.0);
    let width = (f64::from(intersection.width) * scale_x).ceil().max(1.0);
    let height = (f64::from(intersection.height) * scale_y).ceil().max(1.0);
    Some(Bounds {
        x: x as i32,
        y: y as i32,
        width: (width as u32).min(frame.width.saturating_sub(x as u32)),
        height: (height as u32).min(frame.height.saturating_sub(y as u32)),
    })
}

fn solid_mask(image: &mut RgbaImage, bounds: Bounds) {
    let right = (bounds.x.max(0) as u32)
        .saturating_add(bounds.width)
        .min(image.width());
    let bottom = (bounds.y.max(0) as u32)
        .saturating_add(bounds.height)
        .min(image.height());
    for y in bounds.y.max(0) as u32..bottom {
        for x in bounds.x.max(0) as u32..right {
            image.put_pixel(x, y, Rgba([27, 32, 30, 255]));
        }
    }
}

fn blur_region(image: &mut RgbaImage, bounds: Bounds) {
    if bounds.width == 0 || bounds.height == 0 {
        return;
    }
    let x = bounds.x.max(0) as u32;
    let y = bounds.y.max(0) as u32;
    let width = bounds.width.min(image.width().saturating_sub(x));
    let height = bounds.height.min(image.height().saturating_sub(y));
    let source = imageops::crop_imm(image, x, y, width, height).to_image();
    let blurred = imageops::blur(&source, 16.0);
    imageops::replace(image, &blurred, i64::from(x), i64::from(y));
}

fn encode_bounded(mut image: RgbaImage) -> Result<(Vec<u8>, u32, u32)> {
    loop {
        for quality in [88_u8, 78, 68, 58, 48] {
            let mut output = Cursor::new(Vec::new());
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, quality).write_image(
                image.as_raw(),
                image.width(),
                image.height(),
                image::ExtendedColorType::Rgba8,
            )?;
            if output.get_ref().len() <= MAX_SCREENSHOT_BYTES {
                return Ok((output.into_inner(), image.width(), image.height()));
            }
        }
        if image.width() <= 1280 || image.height() <= 720 {
            bail!("processed screenshot exceeds the upload limit");
        }
        let width = image.width().saturating_mul(4) / 5;
        let height = image.height().saturating_mul(4) / 5;
        image = imageops::resize(&image, width, height, imageops::FilterType::Lanczos3);
    }
}

fn normalize_point(point: (i32, i32), monitor: Bounds) -> (f64, f64) {
    let x = f64::from(point.0 - monitor.x) / f64::from(monitor.width.max(1));
    let y = f64::from(point.1 - monitor.y) / f64::from(monitor.height.max(1));
    (x.clamp(0.0, 1.0), y.clamp(0.0, 1.0))
}

fn normalize_bounds(bounds: Bounds, monitor: Bounds) -> Option<(f64, f64, f64, f64)> {
    let bounds = bounds.intersection(monitor)?;
    let (x, y) = normalize_point((bounds.x, bounds.y), monitor);
    let width = (f64::from(bounds.width) / f64::from(monitor.width.max(1))).clamp(0.001, 1.0 - x);
    let height =
        (f64::from(bounds.height) / f64::from(monitor.height.max(1))).clamp(0.001, 1.0 - y);
    Some((x, y, width, height))
}

fn inserted_text(before: &str, after: &str) -> Option<String> {
    if before == after {
        return None;
    }
    let before = before.chars().collect::<Vec<_>>();
    let after = after.chars().collect::<Vec<_>>();
    let prefix = before
        .iter()
        .zip(after.iter())
        .take_while(|(left, right)| left == right)
        .count();
    let max_suffix = before
        .len()
        .saturating_sub(prefix)
        .min(after.len().saturating_sub(prefix));
    let suffix = (0..max_suffix)
        .take_while(|offset| before[before.len() - 1 - offset] == after[after.len() - 1 - offset])
        .count();
    let end = after.len().saturating_sub(suffix);
    (prefix < end).then(|| after[prefix..end].iter().collect::<String>())
}

fn is_duplicate(last: &mut Option<(String, Instant)>, signature: &str, window: Duration) -> bool {
    let now = Instant::now();
    let duplicate = last
        .as_ref()
        .is_some_and(|(previous, at)| previous == signature && now.duration_since(*at) <= window);
    *last = Some((signature.to_owned(), now));
    duplicate
}

fn squared_distance(left: (i32, i32), right: (i32, i32)) -> i64 {
    let x = i64::from(left.0) - i64::from(right.0);
    let y = i64::from(left.1) - i64::from(right.1);
    x * x + y * y
}

fn truncate(value: &str, maximum: usize) -> String {
    let mut chars = value.chars();
    let text = chars.by_ref().take(maximum).collect::<String>();
    if chars.next().is_some() {
        format!("{text}…")
    } else {
        text
    }
}

#[cfg(test)]
mod tests {
    use super::{inserted_text, is_duplicate, looks_like_email, looks_like_phone};
    use std::time::{Duration, Instant};

    #[test]
    fn text_differencing_handles_typing_paste_and_replacement() {
        assert_eq!(
            inserted_text("Hello", "Hello world").as_deref(),
            Some(" world")
        );
        assert_eq!(
            inserted_text("abc xyz", "abc pasted xyz").as_deref(),
            Some("pasted ")
        );
        assert_eq!(
            inserted_text("old value", "new value").as_deref(),
            Some("new")
        );
        assert_eq!(inserted_text("same", "same"), None);
        assert_eq!(inserted_text("delete me", "delete "), None);
    }

    #[test]
    fn semantic_deduplication_has_a_bounded_window() {
        let mut last = Some(("shortcut:Ctrl+S".to_owned(), Instant::now()));
        assert!(is_duplicate(
            &mut last,
            "shortcut:Ctrl+S",
            Duration::from_secs(1)
        ));
        assert!(!is_duplicate(
            &mut last,
            "shortcut:Ctrl+P",
            Duration::from_secs(1)
        ));
    }

    #[test]
    fn smart_blur_detection_is_local_and_deterministic() {
        assert!(looks_like_email("author@example.com"));
        assert!(looks_like_phone("+974 5555 0101"));
        assert!(!looks_like_phone("Step 12"));
    }
}
