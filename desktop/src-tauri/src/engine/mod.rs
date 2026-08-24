mod frames;

use std::{
    io::Cursor,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender},
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
        ServerAnnotation, ServerCrop,
    },
    platform::{
        ElementMetadata, ForegroundContext, NativeRawInput, NativeUia, PasswordStatus,
        PointerButton, PrivacyRegion, RawEvent, RawInputEvent, RawInputRegistration,
        UiAutomationClient, excluded_regions, foreground_context, monitor_descriptors,
        scope_accepts,
    },
};

type StepCallback = Arc<dyn Fn(CapturedStep, Vec<u8>) + Send + Sync>;
type StatusCallback = Arc<dyn Fn(String) + Send + Sync>;

// Each queued emission pins its own full-resolution display frame — tens of
// megabytes apiece — until the image worker reaches it. Queueing a hundred of
// them would pin gigabytes, so the pipeline pushes back on the action thread
// instead. That is safe now that raw input is never dropped: the author keeps
// clicking, the events wait their turn in an unbounded channel, and each one
// still carries the timestamp that picks its own pre-action frame.
const MAX_PENDING_EMISSIONS: usize = 6;
const MAX_PROCESSING_WIDTH: u32 = 1920;
const MAX_PROCESSING_HEIGHT: u32 = 1080;

pub struct CaptureEngine {
    accepting: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    raw_input: Option<NativeRawInput>,
    event_sender: Option<Sender<RawInputEvent>>,
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
        // Unbounded: see `send_raw_event`. Input the author produced must never be
        // discarded because the processor is briefly busy.
        let (sender, receiver) = mpsc::channel();
        let raw_input = NativeRawInput::start(sender.clone())?;
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
            event_sender: Some(sender),
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

    /// Reclaims Windows' process-wide Raw Input registrations after Tauri has shown or focused
    /// recorder windows. A later WebView registration can otherwise replace the capture sink.
    pub fn rebind_raw_input(&mut self) -> Result<()> {
        if let Some(mut raw_input) = self.raw_input.take() {
            raw_input.stop();
        }
        let sender = self
            .event_sender
            .as_ref()
            .ok_or_else(|| anyhow!("capture input is already closed"))?
            .clone();
        self.raw_input = Some(NativeRawInput::start(sender)?);
        Ok(())
    }

    pub fn stop_accepting_and_drain(&mut self, timeout: Duration) -> Result<()> {
        self.accepting.store(false, Ordering::Release);
        if let Some(mut raw_input) = self.raw_input.take() {
            raw_input.stop();
        }
        // Drop the engine's rebind sender after the native registration is gone so the receiver
        // observes disconnection and drains every already-accepted action.
        self.event_sender.take();
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
        self.event_sender.take();
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
    privacy_regions: Vec<PrivacyRegion>,
}

/// A keyboard action whose screenshot has to wait for the destination
/// application to paint its result — a paste landing, a dialog opening, a
/// window coming forward after Alt+Tab.
struct PendingKeyboard {
    action: MeaningfulAction,
    deadline: Instant,
}

#[derive(Clone)]
struct PendingText {
    before: ElementMetadata,
    foreground: ForegroundContext,
    activity_count: usize,
    deadline: Instant,
}

enum MeaningfulAction {
    LeftClick {
        point: (i32, i32),
        double: bool,
        destination_application: Option<String>,
    },
    RightClick {
        point: (i32, i32),
    },
    Drag {
        from: (i32, i32),
        to: (i32, i32),
    },
    TextEntry,
    Enter,
    Tab,
    Shortcut(String),
    AppSwitch,
}

struct PendingEmission {
    sequence: usize,
    action: MeaningfulAction,
    frame: DesktopFrame,
    metadata: ElementMetadata,
    foreground: ForegroundContext,
    exact_text: Option<String>,
    privacy_regions: Vec<PrivacyRegion>,
    settings: RecorderSettings,
}

struct EmissionPipeline {
    sender: Option<SyncSender<PendingEmission>>,
    worker: Option<JoinHandle<()>>,
}

impl EmissionPipeline {
    fn start(on_step: StepCallback, on_status: StatusCallback) -> Result<Self> {
        let (sender, receiver) = mpsc::sync_channel(MAX_PENDING_EMISSIONS);
        let worker = thread::Builder::new()
            .name("knowhow-image-processor".to_owned())
            .spawn(move || process_emissions(receiver, on_step, on_status))?;
        Ok(Self {
            sender: Some(sender),
            worker: Some(worker),
        })
    }

    fn queue(&self, emission: PendingEmission, on_status: &StatusCallback) {
        let Some(sender) = self.sender.as_ref() else {
            on_status("Screenshot processing is unavailable; the action was not saved.".to_owned());
            return;
        };
        if sender.send(emission).is_err() {
            on_status("Screenshot processing stopped; the action was not saved.".to_owned());
        }
    }

    fn finish(&mut self, on_status: &StatusCallback) {
        self.sender.take();
        if let Some(worker) = self.worker.take()
            && worker.join().is_err()
        {
            on_status("Screenshot processing stopped unexpectedly.".to_owned());
        }
    }
}

struct ProcessorState {
    pending_pointer: Option<PendingPointer>,
    pending_click: Option<PendingPointer>,
    pending_text: Option<PendingText>,
    pending_keyboard: Option<PendingKeyboard>,
    last_focus: Option<ElementMetadata>,
    last_focus_poll: Instant,
    last_signature: Option<(String, Instant)>,
    locked: bool,
}

#[allow(clippy::too_many_arguments)]
fn process_actions(
    receiver: Receiver<RawInputEvent>,
    scope: DesktopScope,
    settings: RecorderSettings,
    accepting: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    frames: Arc<Mutex<FrameHub>>,
    on_step: StepCallback,
    on_status: StatusCallback,
) {
    let Ok(mut emissions) = EmissionPipeline::start(on_step, Arc::clone(&on_status)) else {
        on_status("Screenshot processing could not start; capture was stopped.".to_owned());
        return;
    };
    let Ok(uia) = NativeUia::new() else {
        on_status("UI metadata is unavailable; coordinate instructions will be used.".to_owned());
        process_without_uia(
            receiver, scope, settings, accepting, paused, frames, &emissions, &on_status,
        );
        emissions.finish(&on_status);
        return;
    };
    let mut state = ProcessorState {
        pending_pointer: None,
        pending_click: None,
        pending_text: None,
        pending_keyboard: None,
        last_focus: uia.focused_element_semantic().ok(),
        last_focus_poll: Instant::now(),
        last_signature: None,
        locked: false,
    };
    let order = AtomicUsize::new(0);
    loop {
        flush_due(
            &mut state, &uia, &scope, &settings, &frames, &order, &emissions, &on_status,
        );
        match receiver.recv_timeout(Duration::from_millis(35)) {
            Ok(RawInputEvent { at, event }) => {
                if handle_control_event(&event, &mut state, &on_status) {
                    continue;
                }
                if paused.load(Ordering::Acquire) || state.locked {
                    continue;
                }
                handle_event(
                    event, at, &mut state, &uia, &scope, &settings, &frames, &order, &emissions,
                    &on_status,
                );
            }
            Err(RecvTimeoutError::Timeout) => {
                if state.pending_text.is_none()
                    && state.last_focus_poll.elapsed() >= Duration::from_millis(120)
                {
                    state.last_focus = uia.focused_element_semantic().ok();
                    state.last_focus_poll = Instant::now();
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                flush_all(
                    &mut state, &uia, &scope, &settings, &frames, &order, &emissions, &on_status,
                );
                break;
            }
        }
    }
    emissions.finish(&on_status);
}

#[allow(clippy::too_many_arguments)]
fn process_without_uia(
    receiver: Receiver<RawInputEvent>,
    scope: DesktopScope,
    settings: RecorderSettings,
    _accepting: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    frames: Arc<Mutex<FrameHub>>,
    emissions: &EmissionPipeline,
    on_status: &StatusCallback,
) {
    struct UnavailableUia;
    impl UiAutomationClient for UnavailableUia {
        fn element_at(&self, _x: i32, _y: i32) -> Result<ElementMetadata> {
            bail!("UI Automation unavailable")
        }
        fn focused_element(&self) -> Result<ElementMetadata> {
            bail!("UI Automation unavailable")
        }
        fn privacy_regions(&self, _window_id: &str) -> Result<Vec<PrivacyRegion>> {
            bail!("UI Automation unavailable")
        }
    }
    let uia = UnavailableUia;
    let mut state = ProcessorState {
        pending_pointer: None,
        pending_click: None,
        pending_text: None,
        pending_keyboard: None,
        last_focus: None,
        last_focus_poll: Instant::now(),
        last_signature: None,
        locked: false,
    };
    let order = AtomicUsize::new(0);
    loop {
        let RawInputEvent { at, event } = match receiver.recv_timeout(Duration::from_millis(50)) {
            Ok(event) => event,
            Err(RecvTimeoutError::Timeout) => {
                flush_due(
                    &mut state, &uia, &scope, &settings, &frames, &order, emissions, on_status,
                );
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => break,
        };
        if handle_control_event(&event, &mut state, on_status)
            || paused.load(Ordering::Acquire)
            || state.locked
        {
            continue;
        }
        handle_event(
            event, at, &mut state, &uia, &scope, &settings, &frames, &order, emissions, on_status,
        );
    }
    flush_all(
        &mut state, &uia, &scope, &settings, &frames, &order, emissions, on_status,
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
            state.pending_keyboard = None;
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
    at: Instant,
    state: &mut ProcessorState,
    uia: &U,
    scope: &DesktopScope,
    settings: &RecorderSettings,
    frames: &Arc<Mutex<FrameHub>>,
    order: &AtomicUsize,
    emissions: &EmissionPipeline,
    on_status: &StatusCallback,
) {
    // Steps are recorded in the order the author performed them, so anything
    // still parked is emitted before the event that arrived after it.
    flush_keyboard(
        state, uia, scope, settings, frames, order, emissions, on_status,
    );
    match event {
        RawEvent::PointerDown { button, x, y } => {
            // A pointer action closes the previous typing group. This preserves the user's
            // workflow order when they type and click again before the idle timer expires.
            flush_text(
                state, uia, scope, settings, frames, order, emissions, on_status,
            );
            // The moment the button actually went down, not the moment this
            // handler reached it: the pre-action frame is chosen against it.
            let now = at;
            let Ok(foreground) = foreground_context() else {
                on_status("Protected or secure-desktop activity is excluded.".to_owned());
                return;
            };
            if !scope_accepts(scope, &foreground, Some((x, y))) {
                on_status("Activity outside the selected scope is ignored.".to_owned());
                return;
            }
            let Some(frame) = ({
                // Full-rate display mirroring follows the author. Other displays
                // keep a slower ring that is still fresh enough to serve a click
                // the moment they move there.
                let hub = frames.lock();
                hub.note_active_monitor(&foreground.monitor_id);
                hub.newest_before(&foreground.monitor_id, now)
            }) else {
                on_status("Waiting for a safe display frame…".to_owned());
                return;
            };
            let metadata = uia
                .element_at(x, y)
                .unwrap_or_else(|_| fallback_metadata(&foreground));
            let privacy_regions = privacy_regions_or_fail_closed(uia, &foreground, on_status);
            state.pending_pointer = Some(PendingPointer {
                button,
                point: (x, y),
                started_at: now,
                frame,
                metadata,
                foreground,
                privacy_regions,
            });
        }
        RawEvent::PointerUp { button, x, y } => {
            let Some(pointer) = state.pending_pointer.take() else {
                return;
            };
            if pointer.button != button {
                return;
            }
            state.last_focus = Some(pointer.metadata.clone());
            state.last_focus_poll = at;
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
                    pointer.privacy_regions,
                    settings,
                    order,
                    emissions,
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
                    pointer.privacy_regions,
                    settings,
                    order,
                    emissions,
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
                            destination_application: click_destination(&first),
                        },
                        first.frame,
                        first.metadata,
                        first.foreground,
                        None,
                        first.privacy_regions,
                        settings,
                        order,
                        emissions,
                        on_status,
                    );
                } else {
                    emit_pending_click(first, settings, order, emissions, on_status);
                    state.pending_click = Some(pointer);
                }
            } else {
                state.pending_click = Some(pointer);
            }
        }
        RawEvent::TextActivity => {
            // Once typing begins, the preceding pointer action cannot become a double-click.
            // Emit it now so Start -> type -> Enter cannot be reordered as type -> Enter -> Start.
            if let Some(click) = state.pending_click.take() {
                emit_pending_click(click, settings, order, emissions, on_status);
            }
            let now = at;
            if let Some(pending) = &mut state.pending_text {
                pending.activity_count = pending.activity_count.saturating_add(1);
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
            let observed = uia.focused_element_semantic().ok();
            let before = match (state.last_focus.clone(), observed) {
                (Some(previous), Some(current)) if same_text_target(&previous, &current) => {
                    previous
                }
                (_, Some(current)) => current,
                (Some(previous), None) => previous,
                (None, None) => fallback_metadata(&foreground),
            };
            state.pending_text = Some(PendingText {
                before,
                foreground,
                activity_count: 1,
                deadline: now + Duration::from_millis(450),
            });
        }
        RawEvent::Enter | RawEvent::Tab => {
            if let Some(click) = state.pending_click.take() {
                emit_pending_click(click, settings, order, emissions, on_status);
            }
            flush_text(
                state, uia, scope, settings, frames, order, emissions, on_status,
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
                emissions,
                on_status,
            );
        }
        RawEvent::Shortcut(shortcut) => {
            if let Some(click) = state.pending_click.take() {
                emit_pending_click(click, settings, order, emissions, on_status);
            }
            flush_text(
                state, uia, scope, settings, frames, order, emissions, on_status,
            );
            let signature = format!("shortcut:{shortcut}");
            if is_duplicate(
                &mut state.last_signature,
                &signature,
                Duration::from_millis(220),
            ) {
                return;
            }
            // Raw Input reports the chord without delaying the user's key path. The
            // destination application still needs a moment to paint the result before
            // the screenshot that represents the action is chosen — but sleeping here
            // would stall the whole processor, and every click the author made during
            // that stall would be recorded late or, when the queue was bounded, not at
            // all. The action is parked with a deadline instead and the loop keeps
            // draining input.
            let (action, settle) = if shortcut == "Alt+Tab" || shortcut.starts_with("Win+") {
                (MeaningfulAction::AppSwitch, Duration::from_millis(220))
            } else if is_paste_shortcut(&shortcut) {
                (
                    MeaningfulAction::Shortcut(shortcut),
                    Duration::from_millis(180),
                )
            } else {
                (
                    MeaningfulAction::Shortcut(shortcut),
                    Duration::from_millis(90),
                )
            };
            state.pending_keyboard = Some(PendingKeyboard {
                action,
                deadline: at + settle,
            });
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
    emissions: &EmissionPipeline,
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
    let Some(frame) = ({
        let hub = frames.lock();
        hub.note_active_monitor(&foreground.monitor_id);
        hub.latest(&foreground.monitor_id)
    }) else {
        on_status("Waiting for a safe display frame…".to_owned());
        return;
    };
    let metadata = uia
        .focused_element_semantic()
        .unwrap_or_else(|_| fallback_metadata(&foreground));
    let privacy_regions = privacy_regions_or_fail_closed(uia, &foreground, on_status);
    emit(
        action,
        frame,
        metadata,
        foreground,
        None,
        privacy_regions,
        settings,
        order,
        emissions,
        on_status,
    );
}

#[allow(clippy::too_many_arguments)]
fn flush_keyboard<U: UiAutomationClient>(
    state: &mut ProcessorState,
    uia: &U,
    scope: &DesktopScope,
    settings: &RecorderSettings,
    frames: &Arc<Mutex<FrameHub>>,
    order: &AtomicUsize,
    emissions: &EmissionPipeline,
    on_status: &StatusCallback,
) {
    let Some(pending) = state.pending_keyboard.take() else {
        return;
    };
    emit_keyboard_action(
        pending.action,
        uia,
        scope,
        settings,
        frames,
        order,
        emissions,
        on_status,
    );
}

fn keyboard_action_is_due(state: &ProcessorState) -> bool {
    state
        .pending_keyboard
        .as_ref()
        .is_some_and(|pending| pending.deadline <= Instant::now())
}

#[allow(clippy::too_many_arguments)]
fn flush_due<U: UiAutomationClient>(
    state: &mut ProcessorState,
    uia: &U,
    scope: &DesktopScope,
    settings: &RecorderSettings,
    frames: &Arc<Mutex<FrameHub>>,
    order: &AtomicUsize,
    emissions: &EmissionPipeline,
    on_status: &StatusCallback,
) {
    if keyboard_action_is_due(state) {
        flush_keyboard(
            state, uia, scope, settings, frames, order, emissions, on_status,
        );
    }
    if state
        .pending_click
        .as_ref()
        .is_some_and(|click| click.started_at.elapsed() > Duration::from_millis(500))
        && let Some(click) = state.pending_click.take()
    {
        emit_pending_click(click, settings, order, emissions, on_status);
    }
    if state
        .pending_text
        .as_ref()
        .is_some_and(|text| text.deadline <= Instant::now())
    {
        flush_text(
            state, uia, scope, settings, frames, order, emissions, on_status,
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
    emissions: &EmissionPipeline,
    on_status: &StatusCallback,
) {
    flush_keyboard(
        state, uia, scope, settings, frames, order, emissions, on_status,
    );
    if let Some(click) = state.pending_click.take() {
        emit_pending_click(click, settings, order, emissions, on_status);
    }
    flush_text(
        state, uia, scope, settings, frames, order, emissions, on_status,
    );
}

fn emit_pending_click(
    click: PendingPointer,
    settings: &RecorderSettings,
    order: &AtomicUsize,
    emissions: &EmissionPipeline,
    on_status: &StatusCallback,
) {
    emit(
        MeaningfulAction::LeftClick {
            point: click.point,
            double: false,
            destination_application: click_destination(&click),
        },
        click.frame,
        click.metadata,
        click.foreground,
        None,
        click.privacy_regions,
        settings,
        order,
        emissions,
        on_status,
    );
}

fn click_destination(click: &PendingPointer) -> Option<String> {
    let destination = foreground_context().ok()?;
    (destination.process_id != click.foreground.process_id
        && !destination
            .application_name
            .eq_ignore_ascii_case(&click.foreground.application_name)
        && !destination.application_name.trim().is_empty())
    .then_some(destination.application_name)
}

fn same_text_target(left: &ElementMetadata, right: &ElementMetadata) -> bool {
    left.process_id == right.process_id
        && left.window_id == right.window_id
        && left.bounds == right.bounds
        && left.control_role == right.control_role
}

#[allow(clippy::too_many_arguments)]
fn flush_text<U: UiAutomationClient>(
    state: &mut ProcessorState,
    uia: &U,
    scope: &DesktopScope,
    settings: &RecorderSettings,
    frames: &Arc<Mutex<FrameHub>>,
    order: &AtomicUsize,
    emissions: &EmissionPipeline,
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
    let Some(frame) = ({
        let hub = frames.lock();
        hub.note_active_monitor(&foreground.monitor_id);
        hub.latest(&foreground.monitor_id)
    }) else {
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
            (Some(before), Some(after)) => {
                verified_inserted_text(before, after, pending.activity_count)
            }
            _ => None,
        }
    } else {
        None
    };
    let privacy_regions = privacy_regions_or_fail_closed(uia, &foreground, on_status);
    emit(
        MeaningfulAction::TextEntry,
        frame,
        after,
        foreground,
        exact_text,
        privacy_regions,
        settings,
        order,
        emissions,
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
    privacy_regions: Vec<PrivacyRegion>,
    settings: &RecorderSettings,
    order: &AtomicUsize,
    emissions: &EmissionPipeline,
    on_status: &StatusCallback,
) {
    let sequence = order.fetch_add(1, Ordering::AcqRel);
    if sequence >= MAX_STEPS {
        on_status("The 100-step limit is reached. Finish this capture to continue.".to_owned());
        return;
    }
    emissions.queue(
        PendingEmission {
            sequence,
            action,
            frame,
            metadata,
            foreground,
            exact_text,
            privacy_regions,
            settings: settings.clone(),
        },
        on_status,
    );
}

fn process_emissions(
    receiver: Receiver<PendingEmission>,
    on_step: StepCallback,
    on_status: StatusCallback,
) {
    while let Ok(emission) = receiver.recv() {
        process_emission(emission, &on_step, &on_status);
    }
}

fn process_emission(emission: PendingEmission, on_step: &StepCallback, on_status: &StatusCallback) {
    let PendingEmission {
        sequence,
        action,
        frame,
        metadata,
        foreground,
        exact_text,
        privacy_regions,
        settings,
    } = emission;
    let (title, instructions, source_event) =
        deterministic_instruction(&action, &metadata, &foreground, exact_text.as_deref());
    let annotations = annotations(&action, &metadata, &frame);
    let crop = contextual_crop(&action, &metadata, &frame);
    match rasterize(
        &frame,
        &metadata,
        &privacy_regions,
        &foreground,
        &action,
        &settings,
    ) {
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
                crop,
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

fn privacy_regions_or_fail_closed<U: UiAutomationClient>(
    uia: &U,
    foreground: &ForegroundContext,
    on_status: &StatusCallback,
) -> Vec<PrivacyRegion> {
    match uia.privacy_regions(&foreground.window_id) {
        Ok(regions) => regions,
        Err(_) => {
            on_status(
                "Live Smart Blur is preparing this app; the current window was masked.".to_owned(),
            );
            vec![PrivacyRegion {
                bounds: foreground.bounds,
                control_role: Some("text field".to_owned()),
                text: None,
                password_status: PasswordStatus::Unknown,
            }]
        }
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
        MeaningfulAction::LeftClick {
            double: false,
            destination_application,
            ..
        } => {
            let opens_start = target.is_some_and(|label| {
                matches!(
                    label.trim().to_ascii_lowercase().as_str(),
                    "start" | "windows"
                )
            });
            if opens_start {
                (
                    "Open Start".to_owned(),
                    "Click the Windows Start button.".to_owned(),
                    "left-click",
                )
            } else if let Some(destination) = destination_application {
                (
                    format!("Open {}", truncate(destination, 80)),
                    format!("Click {described} to open {}.", truncate(destination, 80)),
                    "left-click",
                )
            } else {
                (
                    target.map_or_else(
                        || "Click the selected area".to_owned(),
                        |label| format!("Click {}", truncate(label, 80)),
                    ),
                    format!("Click {described}."),
                    "left-click",
                )
            }
        }
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
        MeaningfulAction::Shortcut(shortcut) => {
            shortcut_instruction(shortcut, &location, &described)
        }
        MeaningfulAction::AppSwitch => (
            format!("Switch to {application}"),
            format!("Switch to {application}."),
            "app-switch",
        ),
    }
}

fn shortcut_instruction(
    shortcut: &str,
    location: &str,
    described: &str,
) -> (String, String, &'static str) {
    match shortcut {
        "Ctrl+A" => (
            "Select all".to_owned(),
            format!("Press Ctrl+A to select all in {location}."),
            "shortcut",
        ),
        "Ctrl+C" | "Ctrl+Shift+C" => (
            "Copy the selection".to_owned(),
            format!("Press {shortcut} to copy the selected content from {location}."),
            "shortcut",
        ),
        "Ctrl+X" | "Shift+Delete" => (
            "Cut the selection".to_owned(),
            format!("Press {shortcut} to cut the selected content from {location}."),
            "shortcut",
        ),
        "Ctrl+V" | "Shift+Insert" => (
            "Paste".to_owned(),
            format!("Press {shortcut} to paste into {described}."),
            "shortcut",
        ),
        "Ctrl+S" => (
            "Save".to_owned(),
            format!("Press Ctrl+S to save in {location}."),
            "shortcut",
        ),
        _ => (
            format!("Press {shortcut}"),
            format!("Press {shortcut} in {location}."),
            "shortcut",
        ),
    }
}

fn is_paste_shortcut(shortcut: &str) -> bool {
    matches!(shortcut, "Ctrl+V" | "Shift+Insert")
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
                color: Some("#ff5a12".to_owned()),
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
                color: Some("#ff5a12".to_owned()),
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
                color: Some("#ff5a12".to_owned()),
            })
            .into_iter()
            .collect(),
        MeaningfulAction::Shortcut(_) | MeaningfulAction::AppSwitch => Vec::new(),
    }
}

fn contextual_crop(
    action: &MeaningfulAction,
    metadata: &ElementMetadata,
    frame: &DesktopFrame,
) -> Option<ServerCrop> {
    let click = match action {
        MeaningfulAction::LeftClick { point, .. } | MeaningfulAction::RightClick { point } => {
            Some(normalize_point(*point, frame.monitor_bounds))
        }
        MeaningfulAction::Drag { to, .. } => Some(normalize_point(*to, frame.monitor_bounds)),
        MeaningfulAction::TextEntry
        | MeaningfulAction::Enter
        | MeaningfulAction::Tab
        | MeaningfulAction::Shortcut(_)
        | MeaningfulAction::AppSwitch => None,
    };
    let focus = metadata
        .bounds
        .and_then(|bounds| normalize_bounds(bounds, frame.monitor_bounds))
        // Some UIA providers expose only their full top-level surface. Treat that as
        // unavailable so a precise click can still receive the browser-style zoom.
        .filter(|(_, _, width, height)| *width <= 0.7 && *height <= 0.7);
    contextual_crop_for_geometry(click, focus, frame.width, frame.height)
}

fn contextual_crop_for_geometry(
    click: Option<(f64, f64)>,
    focus: Option<(f64, f64, f64, f64)>,
    image_width: u32,
    image_height: u32,
) -> Option<ServerCrop> {
    if click.is_none() && focus.is_none() {
        return None;
    }
    let image_width = f64::from(image_width.max(1));
    let image_height = f64::from(image_height.max(1));
    let image_aspect = image_width / image_height;
    let presentation_aspect = 16.0 / 9.0;
    let widest_for_ratio = (presentation_aspect / image_aspect).min(1.0);
    let height_for_width = |width: f64| width * image_aspect / presentation_aspect;
    let width_for_height = |height: f64| height * presentation_aspect / image_aspect;
    let target = focus.unwrap_or_else(|| {
        let (x, y) = click.unwrap_or((0.5, 0.5));
        (x, y, 0.0, 0.0)
    });
    let needed_width = target.2 + (0.1_f64).max(target.2 * 0.85) * 2.0;
    let needed_height = target.3 + (0.13_f64).max(target.3 * 0.85) * 2.0;
    let closest_width = widest_for_ratio.min(1.0 / 2.6);
    let width = clamp_between(
        needed_width
            .max(width_for_height(needed_height))
            .max(closest_width),
        closest_width,
        widest_for_ratio,
    );
    let height = height_for_width(width).clamp(0.01, 1.0);
    let center = click.unwrap_or((target.0 + target.2 / 2.0, target.1 + target.3 / 2.0));
    let mut x = (center.0 - width / 2.0).clamp(0.0, (1.0 - width).max(0.0));
    let mut y = (center.1 - height / 2.0).clamp(0.0, (1.0 - height).max(0.0));
    if focus.is_some() {
        x = clamp_between(
            x,
            (target.0 + target.2 - width).clamp(0.0, (1.0 - width).max(0.0)),
            target.0.clamp(0.0, (1.0 - width).max(0.0)),
        );
        y = clamp_between(
            y,
            (target.1 + target.3 - height).clamp(0.0, (1.0 - height).max(0.0)),
            target.1.clamp(0.0, (1.0 - height).max(0.0)),
        );
    }
    Some(ServerCrop {
        x,
        y,
        width,
        height,
    })
}

fn clamp_between(value: f64, first: f64, second: f64) -> f64 {
    value.clamp(first.min(second), first.max(second))
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
    privacy_regions: &[PrivacyRegion],
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
    let (processing_width, processing_height) = processing_dimensions(frame.width, frame.height);
    if processing_width != frame.width || processing_height != frame.height {
        image = imageops::resize(
            &image,
            processing_width,
            processing_height,
            imageops::FilterType::Triangle,
        );
    }
    let mask_frame = DesktopFrame {
        width: image.width(),
        height: image.height(),
        ..frame.clone()
    };
    let mut mask_count = 0_usize;
    let mut masked_bounds = Vec::new();
    for excluded in excluded_regions().unwrap_or_default() {
        let _reason = excluded.reason;
        if let Some(bounds) = global_to_image_bounds(excluded.bounds, &mask_frame) {
            solid_mask(&mut image, bounds);
            mask_count += 1;
            masked_bounds.push(bounds);
        }
    }
    if matches!(action, MeaningfulAction::TextEntry)
        && metadata.password_status != PasswordStatus::NotPassword
    {
        let fail_closed = metadata.bounds.unwrap_or(foreground.bounds);
        if let Some(bounds) = global_to_image_bounds(fail_closed, &mask_frame) {
            solid_mask(&mut image, bounds);
            mask_count += 1;
            masked_bounds.push(bounds);
        }
    } else if metadata.password_status == PasswordStatus::Password
        && let Some(bounds) = metadata
            .bounds
            .and_then(|bounds| global_to_image_bounds(bounds, &mask_frame))
    {
        solid_mask(&mut image, bounds);
        mask_count += 1;
        masked_bounds.push(bounds);
    }
    if should_smart_blur(
        metadata.control_role.as_deref(),
        metadata.value.as_deref(),
        settings,
    ) && let Some(bounds) = metadata
        .bounds
        .and_then(|bounds| global_to_image_bounds(bounds, &mask_frame))
        && !contains_bounds(&masked_bounds, bounds)
    {
        blur_region(&mut image, bounds);
        mask_count += 1;
        masked_bounds.push(bounds);
    }
    // Smart Blur is applied to every visible UI Automation region in the foreground window,
    // not only the control that was clicked. Password and uncertain form controls are always
    // solid-masked before a screenshot can enter encrypted storage.
    for region in privacy_regions {
        let Some(bounds) = global_to_image_bounds(region.bounds, &mask_frame) else {
            continue;
        };
        if contains_bounds(&masked_bounds, bounds) {
            continue;
        }
        let role = region.control_role.as_deref();
        let mandatory_mask = region.password_status == PasswordStatus::Password
            || (region.password_status == PasswordStatus::Unknown
                && matches!(role, Some("text field" | "combo box")));
        if mandatory_mask {
            solid_mask(&mut image, bounds);
            mask_count += 1;
            masked_bounds.push(bounds);
        } else if region.password_status == PasswordStatus::NotPassword
            && should_smart_blur(role, region.text.as_deref(), settings)
        {
            blur_region(&mut image, bounds);
            mask_count += 1;
            masked_bounds.push(bounds);
        }
    }
    let (jpeg, width, height) = encode_bounded(image)?;
    Ok(ProcessedImage {
        jpeg,
        width,
        height,
        mask_count,
    })
}

fn processing_dimensions(width: u32, height: u32) -> (u32, u32) {
    if width <= MAX_PROCESSING_WIDTH && height <= MAX_PROCESSING_HEIGHT {
        return (width, height);
    }
    let width_scale = f64::from(MAX_PROCESSING_WIDTH) / f64::from(width.max(1));
    let height_scale = f64::from(MAX_PROCESSING_HEIGHT) / f64::from(height.max(1));
    let scale = width_scale.min(height_scale);
    (
        (f64::from(width) * scale).round().max(1.0) as u32,
        (f64::from(height) * scale).round().max(1.0) as u32,
    )
}

fn should_smart_blur(
    control_role: Option<&str>,
    text: Option<&str>,
    settings: &RecorderSettings,
) -> bool {
    let role = control_role.unwrap_or("");
    let value = text.unwrap_or("");
    (settings.smart_blur.form_fields && matches!(role, "text field" | "combo box"))
        || (settings.smart_blur.images && role == "image")
        || (settings.smart_blur.table_rows && matches!(role, "table" | "data grid" | "list item"))
        || (settings.smart_blur.emails && looks_like_email(value))
        || (settings.smart_blur.phone_numbers && looks_like_phone(value))
        || (settings.smart_blur.financial_numbers && looks_like_financial(value))
        || (settings.smart_blur.identifiers && looks_like_identifier(value))
        || (settings.smart_blur.long_text && value.chars().count() >= 80)
}

fn contains_bounds(regions: &[Bounds], candidate: Bounds) -> bool {
    regions.iter().any(|bounds| {
        bounds.x == candidate.x
            && bounds.y == candidate.y
            && bounds.width == candidate.width
            && bounds.height == candidate.height
    })
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
    // A true Gaussian blur costs work proportional to the kernel radius, and at
    // this radius a screenshot with a few dozen covered regions took seconds to
    // process — long enough for the step feed to fall behind the author. This
    // approximation runs three box passes in time independent of the radius and
    // is visually indistinguishable at these sizes.
    let blurred = imageops::fast_blur(&source, 16.0);
    imageops::replace(image, &blurred, i64::from(x), i64::from(y));
}

fn encode_bounded(image: RgbaImage) -> Result<(Vec<u8>, u32, u32)> {
    let mut image = image::DynamicImage::ImageRgba8(image).to_rgb8();
    loop {
        for quality in [88_u8, 78, 68, 58, 48] {
            let mut output = Cursor::new(Vec::new());
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, quality).write_image(
                image.as_raw(),
                image.width(),
                image.height(),
                image::ExtendedColorType::Rgb8,
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

fn verified_inserted_text(before: &str, after: &str, activity_count: usize) -> Option<String> {
    let inserted = inserted_text(before, after)?;
    // Raw Input contributes only a count of semantic text-changing key presses. Requiring the
    // UIA diff to account for every press prevents a raced first snapshot from turning
    // "powershell" into the misleading partial instruction "owershell".
    (inserted.chars().count() == activity_count).then_some(inserted)
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
    use super::{
        MeaningfulAction, contextual_crop_for_geometry, deterministic_instruction, encode_bounded,
        inserted_text, is_duplicate, looks_like_email, looks_like_phone, processing_dimensions,
        shortcut_instruction, should_smart_blur, verified_inserted_text,
    };
    use crate::{
        model::{Bounds, RecorderSettings},
        platform::{ElementMetadata, ForegroundContext, PasswordStatus},
    };
    use image::{Rgba, RgbaImage};
    use std::time::{Duration, Instant};

    #[test]
    fn processed_rgba_frames_encode_as_jpeg() {
        let image = RgbaImage::from_pixel(64, 48, Rgba([32, 64, 96, 255]));
        let Ok((jpeg, width, height)) = encode_bounded(image) else {
            panic!("a solid RGBA frame must encode as JPEG");
        };
        assert_eq!((width, height), (64, 48));
        assert!(jpeg.starts_with(&[0xff, 0xd8]));
    }

    #[test]
    fn capture_processing_is_bounded_without_distorting_the_display() {
        assert_eq!(processing_dimensions(3440, 1440), (1920, 804));
        assert_eq!(processing_dimensions(3840, 2160), (1920, 1080));
        assert_eq!(processing_dimensions(1280, 720), (1280, 720));
    }

    #[test]
    fn desktop_clicks_receive_the_browser_style_contextual_crop() {
        let Some(crop) = contextual_crop_for_geometry(Some((0.72, 0.44)), None, 3440, 1440) else {
            panic!("an ultrawide click must produce a contextual crop");
        };
        assert!(crop.width < 0.4);
        assert!(crop.x <= 0.72 && crop.x + crop.width >= 0.72);
        assert!(crop.y <= 0.44 && crop.y + crop.height >= 0.44);
        let ratio = (3440.0 * crop.width) / (1440.0 * crop.height);
        assert!((ratio - 16.0 / 9.0).abs() < 0.001);
    }

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
    fn exact_text_is_emitted_only_when_the_uia_diff_covers_the_whole_group() {
        assert_eq!(
            verified_inserted_text("", "powershell", 10).as_deref(),
            Some("powershell")
        );
        assert_eq!(verified_inserted_text("p", "powershell", 10), None);
        assert_eq!(
            verified_inserted_text("PS C:\\> ", "PS C:\\> ls", 2).as_deref(),
            Some("ls")
        );
    }

    #[test]
    fn requested_workflow_shortcuts_have_semantic_instructions() {
        assert_eq!(
            shortcut_instruction("Ctrl+A", "PowerShell", "the terminal").0,
            "Select all"
        );
        assert_eq!(
            shortcut_instruction("Ctrl+Shift+C", "PowerShell", "the terminal").0,
            "Copy the selection"
        );
        assert_eq!(
            shortcut_instruction("Ctrl+V", "Word", "the document").0,
            "Paste"
        );
    }

    #[test]
    fn start_click_and_mouse_app_transition_keep_click_semantics() {
        let metadata = ElementMetadata {
            application_name: "Windows Explorer".to_owned(),
            window_title: "Taskbar".to_owned(),
            control_role: Some("button".to_owned()),
            control_label: Some("Start".to_owned()),
            bounds: Some(Bounds {
                x: 0,
                y: 0,
                width: 48,
                height: 48,
            }),
            password_status: PasswordStatus::NotPassword,
            value: None,
            window_id: "1".to_owned(),
            process_id: 1,
        };
        let foreground = ForegroundContext {
            application_name: "Windows Explorer".to_owned(),
            window_title: "Taskbar".to_owned(),
            bounds: Bounds {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
            window_id: "1".to_owned(),
            root_owner_id: "1".to_owned(),
            process_id: 1,
            monitor_id: "display-1".to_owned(),
            protected: false,
            elevated: false,
        };
        let start = deterministic_instruction(
            &MeaningfulAction::LeftClick {
                point: (24, 1050),
                double: false,
                destination_application: Some("Start".to_owned()),
            },
            &metadata,
            &foreground,
            None,
        );
        assert_eq!(start.0, "Open Start");
        assert_eq!(start.2, "left-click");

        let open_word = deterministic_instruction(
            &MeaningfulAction::LeftClick {
                point: (200, 1050),
                double: false,
                destination_application: Some("Microsoft Word".to_owned()),
            },
            &ElementMetadata {
                control_label: Some("Word".to_owned()),
                ..metadata
            },
            &foreground,
            None,
        );
        assert_eq!(open_word.0, "Open Microsoft Word");
        assert_eq!(open_word.2, "left-click");
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

    #[test]
    fn live_smart_blur_applies_to_every_enabled_region_kind() {
        let mut settings = RecorderSettings::default();
        settings.smart_blur.form_fields = true;
        settings.smart_blur.emails = true;
        assert!(should_smart_blur(Some("text field"), None, &settings));
        assert!(should_smart_blur(
            Some("text"),
            Some("author@example.com"),
            &settings
        ));
        assert!(!should_smart_blur(
            Some("text"),
            Some("Public heading"),
            &settings
        ));
    }
}
