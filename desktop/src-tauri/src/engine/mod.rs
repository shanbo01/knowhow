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
        PointerButton, RawEvent, RawInputEvent, RawInputRegistration, UiAutomationClient,
        double_click_interval, foreground_context, monitor_descriptors, recorder_window_bounds,
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
// A display ring can be momentarily empty — DXGI reconnecting after a mode
// change, a capture thread restarting. An action that arrives in that window
// still happened, so it waits for the next frame instead of being dropped.
const FRAME_RETRY_INTERVAL: Duration = Duration::from_millis(60);
const MAX_FRAME_RETRIES: u8 = 8;
/// How often the focused control is re-read while a capture runs. This is what
/// notices that the author has left a field, and what keeps that field's
/// contents current until they do.
const FOCUS_POLL_INTERVAL: Duration = Duration::from_millis(120);
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
}

/// A keyboard action whose screenshot has to wait for the destination
/// application to paint its result — a paste landing, a dialog opening, a
/// window coming forward after Alt+Tab.
struct PendingKeyboard {
    action: MeaningfulAction,
    deadline: Instant,
    retries: u8,
}

/// A field the author is typing into.
///
/// The field is read when they have *finished* with it — when they click
/// elsewhere, press Enter or Tab, move focus, or stop the capture — and never
/// on a timer. A pause in the middle of a word is not the end of a value: the
/// idle timer this replaces turned "quarterly report" into a step that said
/// "quarterly" and another that said " report", and required the keystroke
/// count to match the text exactly, which one backspace was enough to break.
#[derive(Clone)]
struct PendingText {
    /// The field as last seen while it still held focus, refreshed by the
    /// focus poll. Windows gives no way to read a control once focus has left
    /// it, so the last reading taken while it was focused is what gets
    /// reported — the same value the author finished with.
    target: ElementMetadata,
    /// Its contents when typing began, to tell a real edit from a caret move.
    before: Option<String>,
    foreground: ForegroundContext,
    /// Set only when a flush found no display frame and has to be retried.
    retry_after: Option<Instant>,
    retries: u8,
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
    region: Bounds,
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
    double_click: Duration,
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
        double_click: double_click_interval(),
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
                if state.last_focus_poll.elapsed() >= FOCUS_POLL_INTERVAL {
                    state.last_focus_poll = Instant::now();
                    let focused = uia.focused_element_semantic().ok();
                    match (&mut state.pending_text, &focused) {
                        // Still in the same field: keep its latest contents, so
                        // that whatever the author leaves behind is what gets
                        // reported once they move on.
                        (Some(pending), Some(current))
                            if same_text_target(&pending.target, current) =>
                        {
                            pending.target = current.clone();
                        }
                        // Focus has left the field. This is the desktop's blur:
                        // the author is finished with it, so the value they
                        // finished with becomes the step.
                        (Some(_), _) => flush_text(
                            &mut state, &uia, &scope, &settings, &frames, &order, &emissions,
                            &on_status,
                        ),
                        (None, _) => {}
                    }
                    if state.pending_text.is_none() {
                        state.last_focus = focused;
                    }
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
    }
    let uia = UnavailableUia;
    let mut state = ProcessorState {
        double_click: double_click_interval(),
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
    flush_keyboard(state, uia, scope, frames, order, emissions, on_status);
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
            state.last_focus = Some(pointer.metadata.clone());
            state.last_focus_poll = at;
            let distance = squared_distance(pointer.point, (x, y));
            // A press that travels is a drag — a text selection, a scrollbar, a
            // window move. KnowHow records clicks, typing and shortcuts, so the
            // gesture itself is not a step; whatever it produced shows up in the
            // screenshot of the action the author takes next.
            if button == PointerButton::Left && distance > 64 {
                return;
            }
            if button == PointerButton::Right {
                let region = capture_region(scope, &pointer.foreground, &pointer.frame);
                emit(
                    MeaningfulAction::RightClick {
                        point: pointer.point,
                    },
                    pointer.frame,
                    pointer.metadata,
                    pointer.foreground,
                    None,
                    region,
                    order,
                    emissions,
                    on_status,
                );
            } else if let Some(first) = state.pending_click.take() {
                if pointer.started_at.duration_since(first.started_at) <= state.double_click
                    && squared_distance(pointer.point, first.point) <= 25
                {
                    let region = capture_region(scope, &first.foreground, &first.frame);
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
                        region,
                        order,
                        emissions,
                        on_status,
                    );
                } else {
                    emit_pending_click(first, scope, order, emissions, on_status);
                    state.pending_click = Some(pointer);
                }
            } else {
                state.pending_click = Some(pointer);
            }
        }
        RawEvent::TextActivity { changes_text } => {
            // A key that only moves the caret is not the start of anything.
            if !changes_text || state.pending_text.is_some() {
                return;
            }
            // Once typing begins, the preceding pointer action cannot become a double-click.
            // Emit it now so Start -> type -> Enter cannot be reordered as type -> Enter -> Start.
            if let Some(click) = state.pending_click.take() {
                emit_pending_click(click, scope, order, emissions, on_status);
            }
            let Ok(foreground) = foreground_context() else {
                return;
            };
            if !scope_accepts(scope, &foreground, None) {
                on_status("Activity outside the selected scope is ignored.".to_owned());
                return;
            }
            // The field as it stood before this key landed: the reading taken
            // when the author clicked into it, when it is still the same field.
            let observed = uia.focused_element_semantic().ok();
            let target = match (state.last_focus.clone(), observed) {
                (Some(previous), Some(current)) if same_text_target(&previous, &current) => previous,
                (_, Some(current)) => current,
                (Some(previous), None) => previous,
                (None, None) => fallback_metadata(&foreground),
            };
            state.pending_text = Some(PendingText {
                before: target.value.clone(),
                target,
                foreground,
                retry_after: None,
                retries: 0,
            });
        }
        RawEvent::Enter | RawEvent::Tab => {
            if let Some(click) = state.pending_click.take() {
                emit_pending_click(click, scope, order, emissions, on_status);
            }
            flush_text(
                state, uia, scope, settings, frames, order, emissions, on_status,
            );
            // Enter and Tab need no settle delay, but they do need a display
            // frame. If the ring is momentarily empty the action is parked and
            // retried on the next pass rather than dropped.
            if let Some(action) = emit_keyboard_action(
                if matches!(event, RawEvent::Enter) {
                    MeaningfulAction::Enter
                } else {
                    MeaningfulAction::Tab
                },
                uia,
                scope,
                frames,
                order,
                emissions,
                on_status,
            ) {
                state.pending_keyboard = Some(PendingKeyboard {
                    action,
                    deadline: Instant::now() + FRAME_RETRY_INTERVAL,
                    retries: 0,
                });
            }
        }
        RawEvent::Shortcut(shortcut) => {
            if let Some(click) = state.pending_click.take() {
                emit_pending_click(click, scope, order, emissions, on_status);
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
                retries: 0,
            });
        }
        RawEvent::DisplayChanged | RawEvent::SessionLocked | RawEvent::SessionUnlocked => {}
    }
}

#[allow(clippy::too_many_arguments)]
/// Emits a keyboard action, or hands it back when no display frame is
/// available yet so the caller can try again rather than lose the step.
fn emit_keyboard_action<U: UiAutomationClient>(
    action: MeaningfulAction,
    uia: &U,
    scope: &DesktopScope,
    frames: &Arc<Mutex<FrameHub>>,
    order: &AtomicUsize,
    emissions: &EmissionPipeline,
    on_status: &StatusCallback,
) -> Option<MeaningfulAction> {
    let Ok(foreground) = foreground_context() else {
        on_status("Protected or secure-desktop activity is excluded.".to_owned());
        return None;
    };
    if !scope_accepts(scope, &foreground, None) {
        on_status("Activity outside the selected scope is ignored.".to_owned());
        return None;
    }
    let Some(frame) = ({
        let hub = frames.lock();
        hub.note_active_monitor(&foreground.monitor_id);
        hub.latest(&foreground.monitor_id)
    }) else {
        on_status("Waiting for a safe display frame…".to_owned());
        return Some(action);
    };
    let metadata = uia
        .focused_element_semantic()
        .unwrap_or_else(|_| fallback_metadata(&foreground));
    let region = capture_region(scope, &foreground, &frame);
    emit(
        action,
        frame,
        metadata,
        foreground,
        None,
        region,
        order,
        emissions,
        on_status,
    );
    None
}

#[allow(clippy::too_many_arguments)]
fn flush_keyboard<U: UiAutomationClient>(
    state: &mut ProcessorState,
    uia: &U,
    scope: &DesktopScope,
    frames: &Arc<Mutex<FrameHub>>,
    order: &AtomicUsize,
    emissions: &EmissionPipeline,
    on_status: &StatusCallback,
) {
    let Some(pending) = state.pending_keyboard.take() else {
        return;
    };
    let PendingKeyboard {
        action, retries, ..
    } = pending;
    // A returned action means the display ring had nothing to photograph yet.
    if let Some(action) = emit_keyboard_action(action, uia, scope, frames, order, emissions, on_status)
    {
        if retries >= MAX_FRAME_RETRIES {
            on_status(
                "A keyboard action could not be captured: no display frame was available."
                    .to_owned(),
            );
            return;
        }
        state.pending_keyboard = Some(PendingKeyboard {
            action,
            deadline: Instant::now() + FRAME_RETRY_INTERVAL,
            retries: retries + 1,
        });
    }
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
        flush_keyboard(state, uia, scope, frames, order, emissions, on_status);
    }
    if state
        .pending_click
        .as_ref()
        .is_some_and(|click| click.started_at.elapsed() > state.double_click)
        && let Some(click) = state.pending_click.take()
    {
        emit_pending_click(click, scope, order, emissions, on_status);
    }
    // Only a flush that could not find a display frame is retried on a clock.
    // Typing itself is never ended by a timer; see `PendingText`.
    if state
        .pending_text
        .as_ref()
        .is_some_and(|text| text.retry_after.is_some_and(|at| at <= Instant::now()))
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
    flush_keyboard(state, uia, scope, frames, order, emissions, on_status);
    if let Some(click) = state.pending_click.take() {
        emit_pending_click(click, scope, order, emissions, on_status);
    }
    flush_text(
        state, uia, scope, settings, frames, order, emissions, on_status,
    );
}

fn emit_pending_click(
    click: PendingPointer,
    scope: &DesktopScope,
    order: &AtomicUsize,
    emissions: &EmissionPipeline,
    on_status: &StatusCallback,
) {
    let region = capture_region(scope, &click.foreground, &click.frame);
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
        region,
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
    // When focus has not moved yet — a click, Enter, Tab, or a shortcut, all of
    // which arrive before the application processes them — the field can still
    // be read directly, which catches the last characters typed. Once focus has
    // gone the last polled reading is what there is.
    let target = match uia.focused_element() {
        Ok(current) if same_text_target(&current, &pending.target) => current,
        _ => pending.target.clone(),
    };
    let foreground = foreground_context().unwrap_or_else(|_| pending.foreground.clone());
    if !scope_accepts(scope, &foreground, None) {
        on_status("Activity outside the selected scope is ignored.".to_owned());
        return;
    }
    let readable = settings.capture_typed_text
        && target.password_status == PasswordStatus::NotPassword;
    let text = readable.then(|| target.value.clone()).flatten();
    // Nothing was actually typed: the keys moved the caret or edited nothing.
    // Reporting a step here is how arrow keys used to become "Enter text".
    if readable && text.is_some() && text == pending.before {
        state.last_focus = Some(target);
        return;
    }
    let Some(frame) = ({
        let hub = frames.lock();
        hub.note_active_monitor(&foreground.monitor_id);
        hub.latest(&foreground.monitor_id)
    }) else {
        // The author's typing is already recorded in `pending`; putting it back
        // is the difference between a late step and a missing one.
        if pending.retries >= MAX_FRAME_RETRIES {
            on_status(
                "Typed text could not be captured: no display frame was available.".to_owned(),
            );
            return;
        }
        on_status("Waiting for a stable post-entry frame…".to_owned());
        state.pending_text = Some(PendingText {
            retry_after: Some(Instant::now() + FRAME_RETRY_INTERVAL),
            retries: pending.retries + 1,
            ..pending
        });
        return;
    };
    state.last_focus = Some(target.clone());
    let region = capture_region(scope, &foreground, &frame);
    emit(
        MeaningfulAction::TextEntry,
        frame,
        target,
        foreground,
        text,
        region,
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
    region: Bounds,
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
            region,
        },
        on_status,
    );
}

/// The slice of the display that becomes the screenshot.
///
/// Recording an application means recording that application, so the image is
/// the window itself — not the desktop it happens to sit on. This is what keeps
/// the taskbar, the wallpaper and every unrelated window out of the guide. A
/// display capture is the whole display by definition.
fn capture_region(
    scope: &DesktopScope,
    foreground: &ForegroundContext,
    frame: &DesktopFrame,
) -> Bounds {
    match scope {
        DesktopScope::Application { .. } => foreground
            .bounds
            .intersection(frame.monitor_bounds)
            .filter(|region| region.width > 16 && region.height > 16)
            .unwrap_or(frame.monitor_bounds),
        DesktopScope::Monitor { .. } => frame.monitor_bounds,
    }
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
        region,
    } = emission;
    let (title, instructions, source_event) =
        deterministic_instruction(&action, &metadata, &foreground, exact_text.as_deref());
    match rasterize(&frame, region, &metadata, &foreground, &action) {
        Ok(processed) => {
            // The crop is decided first: it is what the reader actually sees, so
            // the click marker is sized against it rather than against the whole
            // screenshot it was cut from.
            let crop = contextual_crop(&action, &metadata, region, processed.width, processed.height);
            let annotations = annotations(&action, &metadata, region, crop.as_ref());
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
    let window_title = metadata.window_title.as_str();
    let location =
        if window_title.trim().is_empty() || window_title.eq_ignore_ascii_case(application) {
            application.to_owned()
        } else {
            format!("{} in {application}", truncate(window_title, 80))
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
        MeaningfulAction::TextEntry => {
            let field = target.unwrap_or("the field");
            if metadata.password_status != PasswordStatus::NotPassword {
                return (
                    "Enter your password".to_owned(),
                    format!("Enter your password in {described}."),
                    "text-entry",
                );
            }
            match exact_text.map(|text| truncate(text, 180)) {
                Some(text) => (
                    format!("Type “{}” into {}", text, truncate(field, 60)),
                    format!("Type “{text}” into {described}."),
                    "text-entry",
                ),
                None => (
                    format!("Type into {}", truncate(field, 60)),
                    format!("Type the value you need into {described}."),
                    "text-entry",
                ),
            }
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

/// The reader draws a click marker at `radius / crop.width` of the framed
/// image, so a radius fixed against the whole screenshot balloons the moment a
/// zoom crop is applied — a 0.035 radius inside a 0.38-wide crop covered
/// roughly a fifth of the picture. The stored radius is scaled by the crop
/// instead, so the marker lands at the same modest size whatever the zoom.
const CLICK_MARKER_DIAMETER: f64 = 0.06;

fn click_marker_radius(crop: Option<&ServerCrop>) -> f64 {
    let framed = crop.map_or(1.0, |crop| crop.width);
    (CLICK_MARKER_DIAMETER / 2.0 * framed).clamp(0.004, 0.05)
}

fn annotations(
    action: &MeaningfulAction,
    metadata: &ElementMetadata,
    region: Bounds,
    crop: Option<&ServerCrop>,
) -> Vec<ServerAnnotation> {
    match action {
        MeaningfulAction::LeftClick { point, .. } | MeaningfulAction::RightClick { point } => {
            let (x, y) = normalize_point(*point, region);
            vec![ServerAnnotation {
                id: format!("annotation_{}", Uuid::new_v4().simple()),
                kind: "click".to_owned(),
                x,
                y,
                width: Some(click_marker_radius(crop)),
                height: None,
                color: Some("#ff5a12".to_owned()),
            }]
        }
        MeaningfulAction::TextEntry | MeaningfulAction::Enter | MeaningfulAction::Tab => metadata
            .bounds
            .and_then(|bounds| normalize_bounds(bounds, region))
            .map(|(x, y, width, height)| ServerAnnotation {
                id: format!("annotation_{}", Uuid::new_v4().simple()),
                kind: "box".to_owned(),
                x,
                y,
                width: Some(width),
                height: Some(height),
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
    region: Bounds,
    image_width: u32,
    image_height: u32,
) -> Option<ServerCrop> {
    let click = match action {
        MeaningfulAction::LeftClick { point, .. } | MeaningfulAction::RightClick { point } => {
            Some(normalize_point(*point, region))
        }
        MeaningfulAction::TextEntry
        | MeaningfulAction::Enter
        | MeaningfulAction::Tab
        | MeaningfulAction::Shortcut(_)
        | MeaningfulAction::AppSwitch => None,
    };
    let focus = metadata
        .bounds
        .and_then(|bounds| normalize_bounds(bounds, region))
        // Some UIA providers expose only their full top-level surface. Treat that as
        // unavailable so a precise click can still receive the browser-style zoom.
        .filter(|(_, _, width, height)| *width <= 0.7 && *height <= 0.7);
    contextual_crop_for_geometry(click, focus, image_width, image_height)
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

/// Turns the captured slice of a display frame into the JPEG stored for a step.
///
/// Only `region` is copied out of the frame — for an application capture that
/// is the window itself, so the desktop around it never reaches the image.
/// Two things are then painted out: the recorder's own windows, so KnowHow
/// never appears in its own guides, and any password field involved in the
/// action. A field whose password state UI Automation could not report is
/// treated as a password — the recorder masks what it cannot vouch for.
fn rasterize(
    frame: &DesktopFrame,
    region: Bounds,
    metadata: &ElementMetadata,
    foreground: &ForegroundContext,
    action: &MeaningfulAction,
) -> Result<ProcessedImage> {
    let expected = usize::try_from(frame.width)?
        .checked_mul(usize::try_from(frame.height)?)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| anyhow!("display frame is too large"))?;
    if frame.bgra.len() != expected {
        bail!("DXGI frame size does not match its dimensions");
    }
    let source = region_in_frame_pixels(region, frame)
        .ok_or_else(|| anyhow!("the captured window is not on the recorded display"))?;
    // Copied a scanline at a time into one contiguous buffer: the recorder runs
    // this for every captured step on the machine being recorded, and a
    // per-pixel put_pixel pass over a full window was pure overhead.
    let stride = usize::try_from(frame.width)?;
    let left = usize::try_from(source.x.max(0))?;
    let top = usize::try_from(source.y.max(0))?;
    let region_width = usize::try_from(source.width)?;
    let region_height = usize::try_from(source.height)?;
    let mut pixels = vec![0_u8; region_width * region_height * 4];
    for (row, target) in pixels.chunks_exact_mut(region_width * 4).enumerate() {
        let start = ((top + row) * stride + left) * 4;
        let Some(scanline) = frame.bgra.get(start..start + region_width * 4) else {
            bail!("captured region falls outside the display frame");
        };
        for (destination, source) in target.chunks_exact_mut(4).zip(scanline.chunks_exact(4)) {
            destination[0] = source[2];
            destination[1] = source[1];
            destination[2] = source[0];
            destination[3] = 255;
        }
    }
    let mut image = RgbaImage::from_raw(source.width, source.height, pixels)
        .ok_or_else(|| anyhow!("captured region has an invalid pixel layout"))?;
    let (processing_width, processing_height) = processing_dimensions(source.width, source.height);
    if processing_width != source.width || processing_height != source.height {
        image = imageops::resize(
            &image,
            processing_width,
            processing_height,
            imageops::FilterType::Triangle,
        );
    }
    let mut mask_count = 0_usize;
    let mut mask = |image: &mut RgbaImage, bounds: Bounds| {
        if let Some(bounds) = global_to_image_bounds(bounds, region, image.width(), image.height()) {
            solid_mask(image, bounds);
            mask_count += 1;
        }
    };
    for recorder_window in recorder_window_bounds() {
        mask(&mut image, recorder_window);
    }
    let password_bounds = match metadata.password_status {
        // A text entry KnowHow cannot confirm is not a password is masked at the
        // focused control, falling back to the whole window when even its bounds
        // are unavailable.
        PasswordStatus::Unknown if matches!(action, MeaningfulAction::TextEntry) => {
            Some(metadata.bounds.unwrap_or(foreground.bounds))
        }
        PasswordStatus::Password => metadata.bounds,
        _ => None,
    };
    if let Some(bounds) = password_bounds {
        mask(&mut image, bounds);
    }
    let (jpeg, width, height) = encode_bounded(image)?;
    Ok(ProcessedImage {
        jpeg,
        width,
        height,
        mask_count,
    })
}

/// Maps a rectangle in Windows' virtual-desktop coordinates onto the pixels of
/// one captured display frame. The frame can be a different size than the
/// monitor's logical bounds on a scaled display, so both axes are scaled.
fn region_in_frame_pixels(region: Bounds, frame: &DesktopFrame) -> Option<Bounds> {
    let monitor = frame.monitor_bounds;
    let visible = region.intersection(monitor)?;
    let scale_x = f64::from(frame.width) / f64::from(monitor.width.max(1));
    let scale_y = f64::from(frame.height) / f64::from(monitor.height.max(1));
    let x = (f64::from(visible.x - monitor.x) * scale_x).floor().max(0.0) as u32;
    let y = (f64::from(visible.y - monitor.y) * scale_y).floor().max(0.0) as u32;
    let width = ((f64::from(visible.width) * scale_x).round() as u32)
        .min(frame.width.saturating_sub(x))
        .max(1);
    let height = ((f64::from(visible.height) * scale_y).round() as u32)
        .min(frame.height.saturating_sub(y))
        .max(1);
    Some(Bounds {
        x: i32::try_from(x).ok()?,
        y: i32::try_from(y).ok()?,
        width,
        height,
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

fn global_to_image_bounds(
    bounds: Bounds,
    region: Bounds,
    image_width: u32,
    image_height: u32,
) -> Option<Bounds> {
    let visible = bounds.intersection(region)?;
    let scale_x = f64::from(image_width) / f64::from(region.width.max(1));
    let scale_y = f64::from(image_height) / f64::from(region.height.max(1));
    let x = (f64::from(visible.x - region.x) * scale_x).floor().max(0.0);
    let y = (f64::from(visible.y - region.y) * scale_y).floor().max(0.0);
    let width = (f64::from(visible.width) * scale_x).ceil().max(1.0);
    let height = (f64::from(visible.height) * scale_y).ceil().max(1.0);
    Some(Bounds {
        x: x as i32,
        y: y as i32,
        width: (width as u32).min(image_width.saturating_sub(x as u32)),
        height: (height as u32).min(image_height.saturating_sub(y as u32)),
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
        MeaningfulAction, click_marker_radius, contextual_crop_for_geometry,
        deterministic_instruction, encode_bounded, is_duplicate, processing_dimensions,
        shortcut_instruction,
    };
    use crate::{
        model::{Bounds, ServerCrop},
        platform::{ElementMetadata, ForegroundContext, PasswordStatus},
    };
    use image::{Rgba, RgbaImage};
    use std::time::{Duration, Instant};

    fn metadata() -> ElementMetadata {
        ElementMetadata {
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
        }
    }

    fn foreground() -> ForegroundContext {
        ForegroundContext {
            application_name: "Windows Explorer".to_owned(),
            window_title: "Taskbar".to_owned(),
            bounds: Bounds {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
            window_id: "1".to_owned(),
            process_id: 1,
            monitor_id: "display-1".to_owned(),
            protected: false,
            elevated: false,
        }
    }

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
    fn clicks_receive_a_contextual_crop_centred_on_the_pointer() {
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
    fn a_clicked_control_keeps_the_whole_control_inside_the_crop() {
        let Some(crop) =
            contextual_crop_for_geometry(Some((0.5, 0.5)), Some((0.42, 0.46, 0.16, 0.08)), 1920, 1080)
        else {
            panic!("a click on a known control must produce a contextual crop");
        };
        assert!(crop.x <= 0.42 && crop.x + crop.width >= 0.58);
        assert!(crop.y <= 0.46 && crop.y + crop.height >= 0.54);
    }

    #[test]
    fn a_click_marker_keeps_its_rendered_size_whatever_the_zoom() {
        // The reader draws the marker at radius / crop.width, so a tight crop
        // must store a proportionally smaller radius.
        let zoomed = click_marker_radius(Some(&ServerCrop {
            x: 0.0,
            y: 0.0,
            width: 0.385,
            height: 0.216,
        }));
        let whole = click_marker_radius(None);
        assert!(zoomed < whole);
        assert!(((zoomed / 0.385) * 200.0 - 6.0).abs() < 0.001);
    }

    fn text_field() -> ElementMetadata {
        ElementMetadata {
            control_role: Some("text field".to_owned()),
            control_label: Some("Search".to_owned()),
            ..metadata()
        }
    }

    #[test]
    fn a_typed_value_is_reported_as_the_value_the_author_finished_with() {
        let step = deterministic_instruction(
            &MeaningfulAction::TextEntry,
            &text_field(),
            &foreground(),
            Some("quarterly report"),
        );
        assert_eq!(step.0, "Type “quarterly report” into Search");
        assert!(step.1.contains("quarterly report"));
        assert_eq!(step.2, "text-entry");
    }

    #[test]
    fn a_password_field_never_quotes_what_was_typed() {
        let step = deterministic_instruction(
            &MeaningfulAction::TextEntry,
            &ElementMetadata {
                password_status: PasswordStatus::Password,
                control_label: Some("Password".to_owned()),
                ..text_field()
            },
            &foreground(),
            // Even handed the text, a password field must never repeat it.
            Some("hunter2"),
        );
        assert_eq!(step.0, "Enter your password");
        assert!(!step.1.contains("hunter2"));
    }

    #[test]
    fn a_field_that_cannot_be_read_still_produces_a_usable_step() {
        let step = deterministic_instruction(
            &MeaningfulAction::TextEntry,
            &text_field(),
            &foreground(),
            None,
        );
        assert_eq!(step.0, "Type into Search");
        assert_eq!(step.2, "text-entry");
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
    fn an_unmapped_chord_still_reads_as_a_shortcut_step() {
        let step = deterministic_instruction(
            &MeaningfulAction::Shortcut("Ctrl+Shift+P".to_owned()),
            &metadata(),
            &foreground(),
            None,
        );
        assert_eq!(step.0, "Press Ctrl+Shift+P");
        assert_eq!(step.2, "shortcut");
    }

    #[test]
    fn start_click_and_mouse_app_transition_keep_click_semantics() {
        let start = deterministic_instruction(
            &MeaningfulAction::LeftClick {
                point: (24, 1050),
                double: false,
                destination_application: Some("Start".to_owned()),
            },
            &metadata(),
            &foreground(),
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
                ..metadata()
            },
            &foreground(),
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
}
