use std::{
    cell::{Cell, RefCell},
    collections::{HashMap, HashSet},
    ffi::c_void,
    io::Cursor,
    mem::size_of,
    path::Path,
    sync::{Arc, mpsc::{self, Sender}},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use anyhow::{Context, Result, anyhow, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use image::{DynamicImage, ImageBuffer, Rgba, codecs::jpeg::JpegEncoder, imageops::FilterType};
use parking_lot::Mutex;
use windows::{
    Win32::{
        Foundation::{
            CloseHandle, ERROR_CLASS_ALREADY_EXISTS, GetLastError, HANDLE, HINSTANCE, HWND, LPARAM,
            LRESULT, POINT, RECT, WPARAM,
        },
        Graphics::{
            Dwm::{DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute},
            Gdi::{
                BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BitBlt, CAPTUREBLT, CreateCompatibleBitmap,
                CreateCompatibleDC, DIB_RGB_COLORS, DeleteDC, DeleteObject, EnumDisplayMonitors,
                GetDC, GetDIBits, GetMonitorInfoW, HDC, HGDIOBJ, HMONITOR,
                MONITOR_DEFAULTTONEAREST, MONITORINFO, MONITORINFOEXW, MonitorFromWindow,
                ReleaseDC, SRCCOPY, SelectObject,
            },
        },
        Security::{GetTokenInformation, TOKEN_ELEVATION, TOKEN_QUERY, TokenElevation},
        System::{
            Com::{
                CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
                CoUninitialize,
            },
            LibraryLoader::GetModuleHandleW,
            RemoteDesktop::{
                NOTIFY_FOR_THIS_SESSION, WTSRegisterSessionNotification,
                WTSUnRegisterSessionNotification,
            },
            StationsAndDesktops::{
                DESKTOP_CONTROL_FLAGS, DESKTOP_READOBJECTS, GetUserObjectInformationW,
                OpenInputDesktop, UOI_NAME,
            },
            Threading::{
                GetCurrentProcess, GetCurrentThreadId, OpenProcess, OpenProcessToken,
                PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
            },
        },
        UI::{
            Accessibility::{
                CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationTextPattern,
                IUIAutomationValuePattern, UIA_ButtonControlTypeId, UIA_CheckBoxControlTypeId,
                UIA_ComboBoxControlTypeId, UIA_DataGridControlTypeId, UIA_DocumentControlTypeId,
                UIA_EditControlTypeId, UIA_HyperlinkControlTypeId, UIA_ImageControlTypeId,
                UIA_ListControlTypeId, UIA_ListItemControlTypeId, UIA_MenuItemControlTypeId,
                UIA_PaneControlTypeId, UIA_RadioButtonControlTypeId, UIA_TabItemControlTypeId,
                UIA_TableControlTypeId, UIA_TextControlTypeId, UIA_TextPatternId,
                UIA_TreeItemControlTypeId, UIA_ValuePatternId,
            },
            HiDpi::{DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext},
            Input::{
                GetRawInputData, HRAWINPUT,
                KeyboardAndMouse::{
                    GetDoubleClickTime, VK_0, VK_9, VK_A, VK_APPS, VK_C, VK_CAPITAL, VK_CONTROL, VK_DELETE, VK_DOWN,
                    VK_END, VK_ESCAPE, VK_EXECUTE, VK_F, VK_HELP, VK_HOME, VK_INSERT, VK_LCONTROL,
                    VK_LEFT, VK_LMENU, VK_LSHIFT, VK_LWIN, VK_MENU, VK_N, VK_NEXT, VK_NUMLOCK,
                    VK_O, VK_P, VK_PAUSE, VK_PRINT, VK_PRIOR, VK_R, VK_RCONTROL, VK_RETURN,
                    VK_RIGHT, VK_RMENU, VK_RSHIFT, VK_RWIN, VK_S, VK_SCROLL, VK_SELECT, VK_SHIFT,
                    VK_SLEEP, VK_SNAPSHOT, VK_T, VK_TAB, VK_UP, VK_V, VK_W, VK_X, VK_Y, VK_Z,
                },
                RAWINPUT, RAWINPUTDEVICE, RAWINPUTHEADER, RID_INPUT, RIDEV_DEVNOTIFY,
                RIDEV_INPUTSINK, RIM_TYPEKEYBOARD, RIM_TYPEMOUSE, RegisterRawInputDevices,
            },
            WindowsAndMessaging::{
                CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, EnumWindows,
                GA_ROOT, GW_OWNER, GWL_EXSTYLE, GetAncestor, GetCursorPos,
                GetForegroundWindow, GetMessageW, GetWindow, GetWindowLongW, GetWindowRect,
                GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, HWND_MESSAGE, IDNO,
                IDYES, IsWindowVisible, MB_DEFBUTTON3, MB_ICONQUESTION, MB_YESNOCANCEL, MSG,
                MessageBoxW, PostThreadMessageW, RI_KEY_BREAK, RI_MOUSE_LEFT_BUTTON_DOWN,
                RI_MOUSE_LEFT_BUTTON_UP, RI_MOUSE_RIGHT_BUTTON_DOWN, RI_MOUSE_RIGHT_BUTTON_UP,
                RIM_INPUT, RegisterClassW, TranslateMessage, WINDOW_EX_STYLE, WINDOW_STYLE,
                WM_CLOSE, WM_DESTROY, WM_DISPLAYCHANGE, WM_INPUT, WM_QUIT, WM_WTSSESSION_CHANGE,
                WNDCLASSW, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
                WTS_SESSION_LOCK, WTS_SESSION_UNLOCK, WindowFromPoint,
            },
        },
    },
    core::{BOOL, PWSTR, w},
};
use windows_capture::{
    capture::{Context as CaptureContext, GraphicsCaptureApiHandler},
    frame::Frame,
    graphics_capture_api::InternalCaptureControl,
    settings::{
        ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
        MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
    },
    window::Window as CaptureWindow,
};

use super::{
    ElementMetadata, ForegroundContext, MonitorDescriptor, PasswordStatus, PointerButton,
    QuitChoice, RawEvent, RawInputEvent, RawInputRegistration, UiAutomationClient,
};
use crate::model::{Bounds, CaptureTarget, CaptureTargetPreview, DesktopScope, ScopeKind};

/// A per-process lookup that is rebuilt wholesale once it ages out, rather
/// than tracked entry by entry. Used for the two facts about a process that
/// cannot change while it lives but were being re-read on the hot path.
type ProcessCache<T> = Mutex<Option<(Instant, HashMap<u32, T>)>>;

const PROTECTED_PROCESSES: &[&str] = &[
    "1password",
    "authy",
    "bitwarden",
    "consent",
    "credentialuibroker",
    "dashlane",
    "keepass",
    "lastpass",
    "lockapp",
    "logonui",
    "nordpass",
    "proton pass",
    "sechealthui",
    "securityhealthhost",
    "windowssecurity",
];

/// Must match the `outline` window's title in tauri.conf.json.
const OUTLINE_WINDOW_TITLE: &str = "KnowHow Capture outline";

const PREVIEW_WIDTH: u32 = 320;
const PREVIEW_HEIGHT: u32 = 180;
const PREVIEW_TIMEOUT: Duration = Duration::from_millis(400);

#[derive(Clone, Debug)]
struct WindowRecord {
    id: String,
    process_id: u32,
    application_name: String,
    title: String,
    bounds: Bounds,
    protected: bool,
    elevated: bool,
}

#[derive(Clone, Debug)]
struct PreviewFrame {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
}

struct PreviewCapture {
    output: Arc<Mutex<Option<PreviewFrame>>>,
}

impl GraphicsCaptureApiHandler for PreviewCapture {
    type Flags = Arc<Mutex<Option<PreviewFrame>>>;
    type Error = anyhow::Error;

    fn new(context: CaptureContext<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self {
            output: context.flags,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        let buffer = frame
            .buffer()
            .context("read Windows Graphics Capture frame")?;
        let width = buffer.width();
        let height = buffer.height();
        let mut scratch = Vec::new();
        let pixels = buffer.as_nopadding_buffer(&mut scratch).to_vec();
        *self.output.lock() = Some(PreviewFrame {
            width,
            height,
            pixels,
        });
        capture_control.stop();
        Ok(())
    }
}

pub fn initialize_process() -> Result<()> {
    // SAFETY: this is called once during process startup, before capture worker windows exist.
    unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) }
        .context("enable per-monitor DPI awareness")
}

/// The system's own double-click interval. A single click cannot be reported
/// until this has elapsed without a second one, so reading Windows' value —
/// rather than assuming the 500 ms default — is the difference between steps
/// appearing promptly and always feeling half a second behind.
pub fn double_click_interval() -> Duration {
    // SAFETY: GetDoubleClickTime reads a system metric and cannot fail.
    let milliseconds = unsafe { GetDoubleClickTime() };
    Duration::from_millis(u64::from(milliseconds.clamp(120, 900)))
}

pub fn windows_device_name() -> String {
    std::env::var("COMPUTERNAME")
        .ok()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "Windows device".to_owned())
}

pub fn quit_capture_choice() -> QuitChoice {
    // SAFETY: static strings remain valid for the synchronous native prompt.
    let result = unsafe {
        MessageBoxW(
            None,
            w!(
                "A KnowHow capture is still in progress.\n\nYes — Finish and upload\nNo — Discard\nCancel — Keep recording"
            ),
            w!("Quit KnowHow Capture?"),
            MB_YESNOCANCEL | MB_ICONQUESTION | MB_DEFBUTTON3,
        )
    };
    if result == IDYES {
        QuitChoice::Finish
    } else if result == IDNO {
        QuitChoice::Discard
    } else {
        QuitChoice::Cancel
    }
}

pub fn capture_targets() -> Result<Vec<CaptureTarget>> {
    capture_targets_from(enumerate_windows()?, monitor_descriptors()?)
}

/// One entry per recordable application, plus one per display.
///
/// A source the recorder cannot photograph or read is left out of the list
/// entirely rather than shown as a tile that refuses to be selected: the
/// author's own windows, password managers and other protected surfaces, and
/// anything running elevated.
fn capture_targets_from(
    windows: Vec<WindowRecord>,
    monitors: Vec<MonitorDescriptor>,
) -> Result<Vec<CaptureTarget>> {
    let mut seen_processes = HashSet::new();
    let mut targets = Vec::new();
    for window in windows {
        if window.process_id == std::process::id() || window.protected || window.elevated {
            continue;
        }
        if !seen_processes.insert(window.process_id) {
            continue;
        }
        targets.push(CaptureTarget {
            id: format!("process:{}", window.process_id),
            kind: ScopeKind::Application,
            label: window.application_name,
            detail: window.title,
            process_id: Some(window.process_id),
            bounds: Some(window.bounds),
        });
    }
    targets.extend(monitors.into_iter().map(|monitor| CaptureTarget {
        id: monitor.id,
        kind: ScopeKind::Monitor,
        label: monitor.name,
        detail: format!("{} × {}", monitor.bounds.width, monitor.bounds.height),
        process_id: None,
        bounds: Some(monitor.bounds),
    }));
    Ok(targets)
}

pub fn capture_target_previews(target_ids: &[String]) -> Result<Vec<CaptureTargetPreview>> {
    #[derive(Clone, Copy)]
    enum PreviewSource {
        Window(usize),
        Monitor(Bounds),
    }

    // One enumeration for the whole pass. Calling capture_targets() here walked
    // every window a second time, opening each owning process again just to
    // re-derive a list this function already has the inputs for.
    let windows = enumerate_windows()?;
    let monitors = monitor_descriptors()?;
    let targets = capture_targets_from(windows.clone(), monitors.clone())?;
    let mut jobs = Vec::new();
    for target_id in target_ids {
        let Some(target) = targets.iter().find(|target| target.id == *target_id) else {
            continue;
        };
        let source = match target.kind {
            ScopeKind::Application => target.process_id.and_then(|process_id| {
                windows
                    .iter()
                    .find(|window| {
                        window.process_id == process_id && !window.protected && !window.elevated
                    })
                    .and_then(|window| hwnd_from_id(&window.id))
                    .map(|hwnd| PreviewSource::Window(hwnd.0 as usize))
            }),
            ScopeKind::Monitor => monitors
                .iter()
                .find(|monitor| monitor.id == target.id)
                .map(|monitor| PreviewSource::Monitor(monitor.bounds)),
        };
        if let Some(source) = source {
            jobs.push((target.id.clone(), source));
        }
    }
    // Every preview opens its own Windows Graphics Capture session, which costs a
    // D3D device and a swap chain. Starting one for each of a couple of dozen open
    // windows at the same instant makes the whole machine stutter for a second, so
    // previews are taken a few at a time. The picker still fills in one pass.
    const PREVIEW_CONCURRENCY: usize = 4;
    Ok(thread::scope(|scope| {
        let mut previews = Vec::new();
        for batch in jobs.chunks(PREVIEW_CONCURRENCY) {
            let handles = batch
                .iter()
                .map(|(target_id, source)| {
                    let target_id = target_id.clone();
                    let source = *source;
                    scope.spawn(move || {
                        let data_url = match source {
                            PreviewSource::Window(raw) => {
                                capture_window_preview(HWND(raw as *mut c_void)).ok()
                            }
                            PreviewSource::Monitor(bounds) => capture_monitor_preview(bounds).ok(),
                        }?;
                        Some(CaptureTargetPreview {
                            target_id,
                            data_url,
                        })
                    })
                })
                .collect::<Vec<_>>();
            previews.extend(
                handles
                    .into_iter()
                    .filter_map(|handle| handle.join().ok().flatten()),
            );
        }
        previews
    }))
}

fn capture_window_preview(hwnd: HWND) -> Result<String> {
    let output = Arc::new(Mutex::new(None));
    let settings = Settings::new(
        CaptureWindow::from_raw_hwnd(hwnd.0),
        CursorCaptureSettings::WithoutCursor,
        DrawBorderSettings::WithoutBorder,
        SecondaryWindowSettings::Include,
        MinimumUpdateIntervalSettings::Default,
        DirtyRegionSettings::Default,
        ColorFormat::Bgra8,
        Arc::clone(&output),
    );
    let control = PreviewCapture::start_free_threaded(settings)
        .context("start Windows Graphics Capture preview")?;
    let deadline = Instant::now() + PREVIEW_TIMEOUT;
    while output.lock().is_none() && !control.is_finished() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(8));
    }
    control
        .stop()
        .context("stop Windows Graphics Capture preview")?;
    let frame = output
        .lock()
        .take()
        .ok_or_else(|| anyhow!("Windows did not provide a preview for this window"))?;
    encode_preview_pixels(frame.width, frame.height, frame.pixels)
}

fn capture_monitor_preview(bounds: Bounds) -> Result<String> {
    let width = i32::try_from(bounds.width)?;
    let height = i32::try_from(bounds.height)?;
    capture_preview_bitmap(width, height, |destination, source| {
        // SAFETY: both DCs are valid and the monitor bounds were returned by Windows.
        unsafe {
            BitBlt(
                destination,
                0,
                0,
                width,
                height,
                Some(source),
                bounds.x,
                bounds.y,
                SRCCOPY | CAPTUREBLT,
            )
        }
        .context("capture display preview")
    })
}

fn capture_preview_bitmap(
    width: i32,
    height: i32,
    render: impl FnOnce(HDC, HDC) -> Result<()>,
) -> Result<String> {
    if width < 2 || height < 2 {
        bail!("preview bounds are empty");
    }
    // SAFETY: the desktop DC is borrowed only for this synchronous preview capture.
    let source = unsafe { GetDC(None) };
    if source.0.is_null() {
        bail!("desktop graphics context is unavailable");
    }
    // SAFETY: the source DC remains valid until ReleaseDC below.
    let destination = unsafe { CreateCompatibleDC(Some(source)) };
    // SAFETY: the source DC remains valid and dimensions were checked above.
    let bitmap = unsafe { CreateCompatibleBitmap(source, width, height) };
    if destination.0.is_null() || bitmap.0.is_null() {
        if !destination.0.is_null() {
            // SAFETY: destination was created by CreateCompatibleDC.
            let _ = unsafe { DeleteDC(destination) };
        }
        // SAFETY: source was returned by GetDC(None).
        let _ = unsafe { ReleaseDC(None, source) };
        bail!("preview bitmap allocation failed");
    }
    // SAFETY: bitmap and destination are compatible GDI objects.
    let previous = unsafe { SelectObject(destination, HGDIOBJ(bitmap.0)) };
    let result = (|| {
        render(destination, source)?;
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: u32::try_from(size_of::<BITMAPINFOHEADER>())?,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let byte_count = usize::try_from(width)?
            .checked_mul(usize::try_from(height)?)
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or_else(|| anyhow!("preview is too large"))?;
        let mut pixels = vec![0_u8; byte_count];
        // SAFETY: pixels and bitmap info advertise matching 32-bit top-down storage.
        let scanlines = unsafe {
            GetDIBits(
                destination,
                bitmap,
                0,
                u32::try_from(height)?,
                Some(pixels.as_mut_ptr().cast()),
                &raw mut info,
                DIB_RGB_COLORS,
            )
        };
        if scanlines == 0 {
            bail!("read preview pixels failed");
        }
        encode_preview_pixels(u32::try_from(width)?, u32::try_from(height)?, pixels)
    })();
    // SAFETY: restore the original object before deleting our compatible bitmap and DC.
    let _ = unsafe { SelectObject(destination, previous) };
    // SAFETY: bitmap and destination were allocated above and are no longer selected.
    let _ = unsafe { DeleteObject(HGDIOBJ(bitmap.0)) };
    let _ = unsafe { DeleteDC(destination) };
    // SAFETY: source was returned by GetDC(None).
    let _ = unsafe { ReleaseDC(None, source) };
    result
}

/// Turns raw BGRA preview pixels into the thumbnail data URL the picker shows.
///
/// Both sources — Windows Graphics Capture and GetDIBits — produce BGRA, and
/// resizing is a per-channel linear filter, so reducing first and correcting
/// the thumbnail's channel order afterwards yields exactly the same image for a
/// fraction of the work. A 4K display is eight million pixels to swap before
/// the resize and fifty-eight thousand after it.
fn encode_preview_pixels(width: u32, height: u32, pixels: Vec<u8>) -> Result<String> {
    let image = ImageBuffer::<Rgba<u8>, Vec<u8>>::from_raw(width, height, pixels)
        .ok_or_else(|| anyhow!("preview pixel layout is invalid"))?;
    let mut resized = DynamicImage::ImageRgba8(image)
        .resize(PREVIEW_WIDTH, PREVIEW_HEIGHT, FilterType::Triangle)
        .to_rgba8();
    for pixel in resized.chunks_exact_mut(4) {
        pixel.swap(0, 2);
        pixel[3] = 255;
    }
    let resized = DynamicImage::ImageRgba8(resized);
    let mut encoded = Cursor::new(Vec::new());
    JpegEncoder::new_with_quality(&mut encoded, 52)
        .encode_image(&DynamicImage::ImageRgb8(resized.to_rgb8()))?;
    Ok(format!(
        "data:image/jpeg;base64,{}",
        STANDARD.encode(encoded.into_inner())
    ))
}

pub fn new_scope(kind: ScopeKind, target: Option<&CaptureTarget>) -> Result<DesktopScope> {
    let excluded_window_ids = enumerate_windows()?
        .into_iter()
        .filter(|window| {
            window.process_id == std::process::id() || window.protected || window.elevated
        })
        .map(|window| window.id)
        .collect::<Vec<_>>();
    match kind {
        ScopeKind::Application => {
            let target = valid_target(target, ScopeKind::Application)?;
            Ok(DesktopScope::Application {
                application_name: target.label.clone(),
                process_id: target
                    .process_id
                    .ok_or_else(|| anyhow!("application process is unavailable"))?,
                excluded_window_ids,
            })
        }
        ScopeKind::Monitor => {
            let target = valid_target(target, ScopeKind::Monitor)?;
            Ok(DesktopScope::Monitor {
                monitor_id: target.id.clone(),
                monitor_name: Some(target.label.clone()),
                bounds: target
                    .bounds
                    .ok_or_else(|| anyhow!("monitor bounds are unavailable"))?,
                excluded_window_ids,
            })
        }
    }
}

fn valid_target(target: Option<&CaptureTarget>, kind: ScopeKind) -> Result<&CaptureTarget> {
    let target = target.ok_or_else(|| anyhow!("Choose a capture target."))?;
    if target.kind != kind {
        bail!("The selected capture target is no longer available.");
    }
    Ok(target)
}

pub fn monitor_descriptors() -> Result<Vec<MonitorDescriptor>> {
    unsafe extern "system" fn callback(
        monitor: HMONITOR,
        _dc: HDC,
        _rect: *mut RECT,
        data: LPARAM,
    ) -> BOOL {
        // SAFETY: `data` is a unique mutable Vec pointer valid for the synchronous enumeration.
        let monitors = unsafe { &mut *(data.0 as *mut Vec<MonitorDescriptor>) };
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = u32::try_from(size_of::<MONITORINFOEXW>()).unwrap_or(0);
        // SAFETY: `info` begins with MONITORINFO as required by GetMonitorInfoW.
        if unsafe { GetMonitorInfoW(monitor, (&raw mut info).cast::<MONITORINFO>()).as_bool() } {
            let rect = info.monitorInfo.rcMonitor;
            let index = monitors.len();
            let device_name = utf16_z(&info.szDevice);
            monitors.push(MonitorDescriptor {
                id: monitor_id(monitor),
                name: friendly_monitor_name(&device_name, index),
                bounds: rect_bounds(rect),
                work_area: rect_bounds(info.monitorInfo.rcWork),
                index,
            });
        }
        BOOL(1)
    }

    let mut monitors = Vec::new();
    // SAFETY: callback uses the Vec pointer only during this synchronous call.
    let success = unsafe {
        EnumDisplayMonitors(
            None,
            None,
            Some(callback),
            LPARAM((&raw mut monitors).cast::<c_void>() as isize),
        )
    };
    if !success.as_bool() || monitors.is_empty() {
        bail!("Windows did not report an eligible display.");
    }
    Ok(monitors)
}

/// The process owning the top-level window under a screen point.
///
/// A click is attributed to whatever is *under the pointer*, not to whatever
/// happened to hold focus when the button went down. Those differ for exactly
/// the case that leaked into recordings: pressing on the taskbar, the Start
/// button, or another application while the recorded app still has focus.
pub fn process_at_point(x: i32, y: i32) -> Option<u32> {
    // SAFETY: WindowFromPoint returns a borrowed HWND managed by Windows.
    let hwnd = unsafe { WindowFromPoint(POINT { x, y }) };
    if hwnd.0.is_null() {
        return None;
    }
    // SAFETY: hwnd is valid; the returned root is borrowed.
    let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
    let hwnd = if root.0.is_null() { hwnd } else { root };
    let mut process_id = 0_u32;
    // SAFETY: HWND comes from Windows and output points to initialized storage.
    unsafe { GetWindowThreadProcessId(hwnd, Some(&raw mut process_id)) };
    (process_id != 0).then_some(process_id)
}

pub fn foreground_context() -> Result<ForegroundContext> {
    // SAFETY: GetForegroundWindow returns a borrowed HWND managed by Windows.
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() || !is_default_desktop() {
        bail!("Secure desktop activity is excluded.");
    }
    let record = window_record(hwnd)?;
    // SAFETY: HWND is valid for the duration of this lookup.
    let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    Ok(ForegroundContext {
        application_name: record.application_name,
        window_title: record.title,
        bounds: record.bounds,
        window_id: record.id,
        process_id: record.process_id,
        monitor_id: monitor_id(monitor),
        protected: record.protected || record.process_id == std::process::id(),
        elevated: record.elevated,
    })
}

/// The rectangle the recording outline should trace right now, or `None` when
/// there is nothing to trace.
///
/// The outline reports what is *currently* being recorded, so it appears only
/// while the recorded surface is the one in front. An always-on-top frame drawn
/// around a window that is buried behind another application would be tracing a
/// window the author cannot see, over activity that is not being captured.
pub fn scope_outline_bounds(scope: &DesktopScope) -> Option<Bounds> {
    // SAFETY: GetForegroundWindow returns a borrowed HWND managed by Windows.
    let foreground = unsafe { GetForegroundWindow() };
    if foreground.0.is_null() || !is_default_desktop() {
        return None;
    }
    match scope {
        DesktopScope::Application { process_id, .. } => {
            (window_process(foreground) == Some(*process_id)).then(|| window_rect(foreground))?
        }
        DesktopScope::Monitor {
            monitor_id, bounds, ..
        } => {
            // SAFETY: the foreground HWND is valid for this lookup.
            let monitor = unsafe { MonitorFromWindow(foreground, MONITOR_DEFAULTTONEAREST) };
            (monitor_id == &self::monitor_id(monitor)).then_some(*bounds)
        }
    }
}

fn window_process(hwnd: HWND) -> Option<u32> {
    let mut process_id = 0_u32;
    // SAFETY: HWND comes from Windows and output points to initialized storage.
    unsafe { GetWindowThreadProcessId(hwnd, Some(&raw mut process_id)) };
    (process_id != 0).then_some(process_id)
}

/// A window's visible bounds.
///
/// `GetWindowRect` reports the resize border too — several invisible pixels of
/// desktop on every side of an ordinary window. Cropping a screenshot to that
/// rectangle leaves a sliver of whatever is behind the window along each edge,
/// and an outline drawn on it floats away from the window it is tracing, so the
/// composited frame bounds are preferred wherever the compositor reports them.
fn window_rect(hwnd: HWND) -> Option<Bounds> {
    let mut frame = RECT::default();
    // SAFETY: hwnd is valid and the output buffer matches the advertised size.
    let composited = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            (&raw mut frame).cast(),
            u32::try_from(size_of::<RECT>()).unwrap_or(16),
        )
    };
    if composited.is_ok() {
        let bounds = rect_bounds(frame);
        if bounds.width > 0 && bounds.height > 0 {
            return Some(bounds);
        }
    }
    let mut rect = RECT::default();
    // SAFETY: HWND comes from Windows and rect is writable.
    unsafe { GetWindowRect(hwnd, &raw mut rect) }.ok()?;
    let bounds = rect_bounds(rect);
    (bounds.width > 0 && bounds.height > 0).then_some(bounds)
}

/// Where the recorder's own windows are right now.
///
/// The floating recorder sits on top of the work being captured, so the
/// display mirror photographs it along with everything else. These bounds are
/// painted out of every screenshot, which is what keeps KnowHow from appearing
/// in its own guides. This walks visible top-level windows without opening any
/// process — it runs once per captured step.
pub fn recorder_window_bounds() -> Vec<Bounds> {
    unsafe extern "system" fn callback(hwnd: HWND, data: LPARAM) -> BOOL {
        // SAFETY: data is a valid Vec pointer during synchronous EnumWindows.
        let bounds = unsafe { &mut *(data.0 as *mut Vec<Bounds>) };
        // SAFETY: hwnd is supplied by EnumWindows and remains valid here.
        if !unsafe { IsWindowVisible(hwnd) }.as_bool() {
            return BOOL(1);
        }
        if window_process(hwnd) != Some(std::process::id()) {
            return BOOL(1);
        }
        // The recording outline is one of our windows too, but it is a
        // click-through frame drawn around the *whole* recorded window. Painting
        // it out would black out the entire screenshot, so it is never masked —
        // it is excluded from capture by the window itself instead. Both its
        // title and its click-through style are checked, because getting this
        // wrong costs every screenshot in the capture.
        // SAFETY: reading a style does not mutate the enumerated window.
        let extended_style = unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) } as u32;
        if extended_style & WS_EX_TRANSPARENT.0 != 0 || window_text(hwnd) == OUTLINE_WINDOW_TITLE {
            return BOOL(1);
        }
        if let Some(window) = window_rect(hwnd) {
            bounds.push(window);
        }
        BOOL(1)
    }

    let mut bounds = Vec::new();
    // SAFETY: callback uses the Vec pointer only during this synchronous call.
    let _ = unsafe {
        EnumWindows(
            Some(callback),
            LPARAM((&raw mut bounds).cast::<c_void>() as isize),
        )
    };
    bounds
}

fn enumerate_windows() -> Result<Vec<WindowRecord>> {
    unsafe extern "system" fn callback(hwnd: HWND, data: LPARAM) -> BOOL {
        // SAFETY: data is a valid Vec pointer during synchronous EnumWindows.
        let windows = unsafe { &mut *(data.0 as *mut Vec<WindowRecord>) };
        if !is_shareable_app_window(hwnd) {
            return BOOL(1);
        }
        if let Ok(record) = window_record(hwnd)
            && !record.title.trim().is_empty()
            && record.bounds.width > 1
            && record.bounds.height > 1
        {
            windows.push(record);
        }
        BOOL(1)
    }

    let mut windows = Vec::new();
    // SAFETY: callback uses the Vec pointer only during this synchronous call.
    unsafe {
        EnumWindows(
            Some(callback),
            LPARAM((&raw mut windows).cast::<c_void>() as isize),
        )?;
    }
    Ok(windows)
}

fn is_shareable_app_window(hwnd: HWND) -> bool {
    // SAFETY: hwnd is supplied by EnumWindows and remains valid for this callback.
    if !unsafe { IsWindowVisible(hwnd).as_bool() } {
        return false;
    }
    let mut cloaked = 0_u32;
    // A failed DWM query is treated as not cloaked so classic Win32 windows remain available.
    let is_cloaked = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            (&raw mut cloaked).cast(),
            u32::try_from(size_of::<u32>()).unwrap_or(4),
        )
    }
    .is_ok()
        && cloaked != 0;
    // SAFETY: reading styles and ownership does not mutate the enumerated window.
    let extended_style = unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) } as u32;
    let has_owner = unsafe { GetWindow(hwnd, GW_OWNER) }.is_ok();
    is_shareable_window_properties(true, is_cloaked, extended_style, has_owner)
}

fn is_shareable_window_properties(
    visible: bool,
    cloaked: bool,
    extended_style: u32,
    has_owner: bool,
) -> bool {
    // Minimized top-level windows are intentionally included: they still represent open
    // taskbar applications and are valid capture targets even though they are not on-screen.
    if !visible || cloaked {
        return false;
    }
    let app_window = extended_style & WS_EX_APPWINDOW.0 != 0;
    let tool_window = extended_style & WS_EX_TOOLWINDOW.0 != 0;
    app_window || (!tool_window && !has_owner)
}

fn window_record(hwnd: HWND) -> Result<WindowRecord> {
    let mut process_id = 0_u32;
    // SAFETY: HWND comes from Windows and output points to initialized storage.
    unsafe { GetWindowThreadProcessId(hwnd, Some(&raw mut process_id)) };
    if process_id == 0 {
        bail!("window process is unavailable");
    }
    let title = window_text(hwnd);
    let application_name = process_application_name_cached(process_id)
        .unwrap_or_else(|| "Windows application".to_owned());
    let bounds = window_rect(hwnd).context("read window bounds")?;
    let protected = is_known_protected(&application_name, &title);
    Ok(WindowRecord {
        id: window_id(hwnd),
        process_id,
        application_name,
        title,
        bounds,
        protected,
        elevated: process_id != std::process::id() && process_is_elevated_cached(process_id),
    })
}

/// A process cannot change its own elevation, so asking Windows again for every
/// window of every application on every picker refresh only costs an
/// `OpenProcess` and a token query apiece. The answer is remembered briefly
/// instead — long enough to cover a picker session, short enough that a reused
/// process identifier corrects itself.
fn process_is_elevated_cached(process_id: u32) -> bool {
    const ELEVATION_CACHE_MAX_AGE: Duration = Duration::from_secs(60);
    static ELEVATION: ProcessCache<bool> = Mutex::new(None);

    let mut cache = ELEVATION.lock();
    let stale = cache
        .as_ref()
        .is_none_or(|(filled_at, _)| filled_at.elapsed() >= ELEVATION_CACHE_MAX_AGE);
    if stale {
        *cache = Some((Instant::now(), HashMap::new()));
    }
    let Some((_, entries)) = cache.as_mut() else {
        return process_is_elevated(process_id).unwrap_or(true);
    };
    if let Some(elevated) = entries.get(&process_id) {
        return *elevated;
    }
    // Fail closed: a process KnowHow cannot inspect is treated as elevated and
    // left out of the picker rather than captured blind.
    let elevated = process_is_elevated(process_id).unwrap_or(true);
    entries.insert(process_id, elevated);
    elevated
}

fn window_text(hwnd: HWND) -> String {
    // SAFETY: HWND comes from Windows.
    let length = unsafe { GetWindowTextLengthW(hwnd) };
    if length <= 0 {
        return String::new();
    }
    let mut buffer = vec![0_u16; usize::try_from(length).unwrap_or(0) + 1];
    // SAFETY: buffer is writable and includes a terminating slot.
    let copied = unsafe { GetWindowTextW(hwnd, &mut buffer) };
    String::from_utf16_lossy(&buffer[..usize::try_from(copied).unwrap_or(0)])
}

/// A process's executable name never changes while it lives, but this was
/// being re-derived — an `OpenProcess`, a 64 KB path query and an allocation —
/// several times for every single captured action, once per `window_record`
/// call on the hot path. It is remembered per process instead, briefly enough
/// that a reused identifier corrects itself.
fn process_application_name_cached(process_id: u32) -> Option<String> {
    const NAME_CACHE_MAX_AGE: Duration = Duration::from_secs(30);
    static NAMES: ProcessCache<Option<String>> = Mutex::new(None);

    let mut cache = NAMES.lock();
    let stale = cache
        .as_ref()
        .is_none_or(|(filled_at, _)| filled_at.elapsed() >= NAME_CACHE_MAX_AGE);
    if stale {
        *cache = Some((Instant::now(), HashMap::new()));
    }
    let Some((_, entries)) = cache.as_mut() else {
        return process_application_name(process_id);
    };
    if let Some(name) = entries.get(&process_id) {
        return name.clone();
    }
    let name = process_application_name(process_id);
    entries.insert(process_id, name.clone());
    name
}

fn process_application_name(process_id: u32) -> Option<String> {
    // SAFETY: OpenProcess validates the process identifier.
    let process =
        unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) }.ok()?;
    let mut path = vec![0_u16; 32_768];
    let mut length = u32::try_from(path.len()).ok()?;
    // SAFETY: process handle is valid and buffer/length satisfy the API contract.
    let result = unsafe {
        QueryFullProcessImageNameW(
            process,
            Default::default(),
            PWSTR(path.as_mut_ptr()),
            &raw mut length,
        )
    };
    // SAFETY: process was returned by OpenProcess.
    let _ = unsafe { CloseHandle(process) };
    result.ok()?;
    let path = String::from_utf16_lossy(&path[..usize::try_from(length).ok()?]);
    Path::new(&path)
        .file_stem()
        .and_then(|name| name.to_str())
        .map(friendly_process_name)
}

fn friendly_process_name(name: &str) -> String {
    match name.to_ascii_lowercase().as_str() {
        "chrome" => "Google Chrome".to_owned(),
        "explorer" => "File Explorer".to_owned(),
        "applicationframehost" => "Windows application".to_owned(),
        "msedge" => "Microsoft Edge".to_owned(),
        "winword" => "Microsoft Word".to_owned(),
        "excel" => "Microsoft Excel".to_owned(),
        "powerpnt" => "Microsoft PowerPoint".to_owned(),
        "snippingtool" => "Snipping Tool".to_owned(),
        "steamwebhelper" => "Steam".to_owned(),
        "sublime_text" => "Sublime Text".to_owned(),
        "windowsterminal" => "Windows Terminal".to_owned(),
        _ => name.to_owned(),
    }
}

fn friendly_monitor_name(device_name: &str, fallback_index: usize) -> String {
    let display_number = device_name
        .to_ascii_uppercase()
        .strip_prefix(r"\\.\DISPLAY")
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(fallback_index + 1);
    format!("Display {display_number}")
}

fn process_is_elevated(process_id: u32) -> Result<bool> {
    // SAFETY: OpenProcess validates the identifier.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) }?;
    let mut token = HANDLE::default();
    // SAFETY: process is valid and token points to initialized storage.
    let opened = unsafe { OpenProcessToken(process, TOKEN_QUERY, &raw mut token) };
    // SAFETY: process was returned by OpenProcess.
    let _ = unsafe { CloseHandle(process) };
    opened?;
    let mut elevation = TOKEN_ELEVATION::default();
    let mut returned = 0_u32;
    // SAFETY: token is valid and the TOKEN_ELEVATION buffer has the advertised size.
    let result = unsafe {
        GetTokenInformation(
            token,
            TokenElevation,
            Some((&raw mut elevation).cast()),
            u32::try_from(size_of::<TOKEN_ELEVATION>())?,
            &raw mut returned,
        )
    };
    // SAFETY: token was returned by OpenProcessToken.
    let _ = unsafe { CloseHandle(token) };
    result?;
    Ok(elevation.TokenIsElevated != 0 && !current_process_is_elevated())
}

fn current_process_is_elevated() -> bool {
    let mut token = HANDLE::default();
    // SAFETY: pseudo process handle remains valid and token is writable.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw mut token) }.is_err() {
        return false;
    }
    let mut elevation = TOKEN_ELEVATION::default();
    let mut returned = 0_u32;
    // SAFETY: token and output buffer are valid.
    let result = unsafe {
        GetTokenInformation(
            token,
            TokenElevation,
            Some((&raw mut elevation).cast()),
            u32::try_from(size_of::<TOKEN_ELEVATION>()).unwrap_or(0),
            &raw mut returned,
        )
    };
    // SAFETY: token was returned by OpenProcessToken.
    let _ = unsafe { CloseHandle(token) };
    result.is_ok() && elevation.TokenIsElevated != 0
}

fn is_default_desktop() -> bool {
    // SAFETY: requests read-only access to the current input desktop.
    let Ok(desktop) =
        (unsafe { OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS) })
    else {
        return false;
    };
    let mut buffer = [0_u16; 128];
    let mut needed = 0_u32;
    // SAFETY: desktop is valid and buffer is writable. HDESK closes on drop.
    let result = unsafe {
        GetUserObjectInformationW(
            HANDLE(desktop.0),
            UOI_NAME,
            Some(buffer.as_mut_ptr().cast()),
            u32::try_from(size_of::<u16>() * buffer.len()).unwrap_or(0),
            Some(&raw mut needed),
        )
    };
    result.is_ok() && utf16_z(&buffer).eq_ignore_ascii_case("default")
}

fn is_known_protected(application_name: &str, title: &str) -> bool {
    let process = application_name.to_ascii_lowercase();
    let title = title.to_ascii_lowercase();
    PROTECTED_PROCESSES
        .iter()
        .any(|name| process.contains(name))
        || title.contains(" inprivate")
        || title.contains("incognito")
        || title.contains("private browsing")
        || title.contains("windows security")
        || title.contains("credential")
}

fn rect_bounds(rect: RECT) -> Bounds {
    Bounds {
        x: rect.left,
        y: rect.top,
        width: u32::try_from((rect.right - rect.left).max(0)).unwrap_or(0),
        height: u32::try_from((rect.bottom - rect.top).max(0)).unwrap_or(0),
    }
}

fn window_id(hwnd: HWND) -> String {
    format!("hwnd:{:x}", hwnd.0 as usize)
}

fn hwnd_from_id(id: &str) -> Option<HWND> {
    let value = usize::from_str_radix(id.strip_prefix("hwnd:")?, 16).ok()?;
    (value != 0).then_some(HWND(value as *mut c_void))
}

fn monitor_id(monitor: HMONITOR) -> String {
    format!("monitor:{:x}", monitor.0 as usize)
}

fn utf16_z(buffer: &[u16]) -> String {
    let length = buffer
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..length])
}

pub struct WindowsUia {
    automation: IUIAutomation,
    initialized: bool,
}

impl WindowsUia {
    pub fn new() -> Result<Self> {
        // SAFETY: this object is constructed and used on one dedicated worker thread.
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
            .ok()
            .context("initialize UI Automation COM worker")?;
        // SAFETY: CUIAutomation is an in-process COM class and IUIAutomation is its interface.
        let automation = unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }
            .context("create Windows UI Automation client")?;
        Ok(Self {
            automation,
            initialized: true,
        })
    }

    fn metadata(
        &self,
        element: &IUIAutomationElement,
        allow_text_pattern: bool,
    ) -> Result<ElementMetadata> {
        // Every UIA provider call is individually fallible. Password status fails closed.
        let password_status = match unsafe { element.CurrentIsPassword() } {
            Ok(value) if value.as_bool() => PasswordStatus::Password,
            Ok(_) => PasswordStatus::NotPassword,
            Err(_) => PasswordStatus::Unknown,
        };
        let label = unsafe { element.CurrentName() }
            .ok()
            .map(|name| name.to_string())
            .filter(|name| !name.trim().is_empty());
        let role = unsafe { element.CurrentControlType() }
            .ok()
            .map(control_role);
        let bounds = unsafe { element.CurrentBoundingRectangle() }
            .ok()
            .map(rect_bounds)
            .filter(|bounds| bounds.width > 0 && bounds.height > 0);
        let hwnd = unsafe { element.CurrentNativeWindowHandle() }.unwrap_or_default();
        let fallback_hwnd = bounds
            .map(|bounds| POINT {
                x: bounds.x,
                y: bounds.y,
            })
            .map(|point| unsafe { WindowFromPoint(point) })
            .unwrap_or_default();
        let hwnd = if hwnd.0.is_null() {
            fallback_hwnd
        } else {
            hwnd
        };
        let record =
            window_record(hwnd).or_else(|_| window_record(unsafe { GetForegroundWindow() }))?;
        let value = if password_status == PasswordStatus::NotPassword {
            self.read_non_password_value(
                element,
                &record.application_name,
                role.as_deref(),
                allow_text_pattern,
            )
        } else {
            None
        };
        Ok(ElementMetadata {
            application_name: record.application_name,
            window_title: record.title,
            control_role: role,
            control_label: label,
            bounds,
            password_status,
            value,
            window_id: record.id,
            process_id: record.process_id,
        })
    }

    fn read_non_password_value(
        &self,
        element: &IUIAutomationElement,
        application_name: &str,
        role: Option<&str>,
        allow_text_pattern: bool,
    ) -> Option<String> {
        const MAX_TEXT_CHARS: i32 = 65_536;

        let value = unsafe {
            element
                .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                .and_then(|pattern| pattern.CurrentValue())
        }
        .ok()
        .map(|value| value.to_string());
        if value.is_some() {
            return value;
        }

        // TextPattern document walks are useful for native editors and terminals, but browser
        // document providers can take seconds (or never return). Browser fields expose
        // ValuePattern directly, so never enter their document tree on the action thread.
        let supports_bounded_document_text = allow_text_pattern
            && role == Some("document")
            && matches!(
                application_name,
                "Windows Terminal" | "Notepad" | "Microsoft Word"
            );
        if !supports_bounded_document_text {
            return None;
        }

        // Document surfaces such as Windows Terminal expose TextPattern instead of
        // ValuePattern. Walk a few provider parents so a focused text child can still yield
        // the document's before/after value without collecting or persisting raw keystrokes.
        let walker = unsafe { self.automation.RawViewWalker() }.ok()?;
        let mut current = Some(element.clone());
        for _ in 0..5 {
            let candidate = current.take()?;
            let text = unsafe {
                candidate
                    .GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
                    .and_then(|pattern| pattern.DocumentRange())
                    .and_then(|range| range.GetText(MAX_TEXT_CHARS))
            }
            .ok()
            .map(|value| value.to_string());
            if text.is_some() {
                return text;
            }
            current = unsafe { walker.GetParentElement(&candidate) }.ok();
        }
        None
    }
}

impl UiAutomationClient for WindowsUia {
    fn element_at(&self, x: i32, y: i32) -> Result<ElementMetadata> {
        // SAFETY: automation and returned element remain on this COM worker thread.
        let element = unsafe { self.automation.ElementFromPoint(POINT { x, y }) }
            .context("look up UI Automation element at pointer")?;
        self.metadata(&element, true)
    }

    fn focused_element(&self) -> Result<ElementMetadata> {
        // SAFETY: automation and returned element remain on this COM worker thread.
        let element = unsafe { self.automation.GetFocusedElement() }
            .context("look up focused UI Automation element")?;
        self.metadata(&element, true)
    }

    fn focused_element_semantic(&self) -> Result<ElementMetadata> {
        // SAFETY: automation and returned element remain on this COM worker thread.
        let element = unsafe { self.automation.GetFocusedElement() }
            .context("look up focused UI Automation element")?;
        self.metadata(&element, false)
    }
}

impl Drop for WindowsUia {
    fn drop(&mut self) {
        if self.initialized {
            // SAFETY: balances CoInitializeEx on the same worker thread.
            unsafe { CoUninitialize() };
        }
    }
}

fn control_role(control_type: windows::Win32::UI::Accessibility::UIA_CONTROLTYPE_ID) -> String {
    match control_type {
        value if value == UIA_ButtonControlTypeId => "button",
        value if value == UIA_CheckBoxControlTypeId => "checkbox",
        value if value == UIA_ComboBoxControlTypeId => "combo box",
        value if value == UIA_DataGridControlTypeId => "data grid",
        value if value == UIA_DocumentControlTypeId => "document",
        value if value == UIA_EditControlTypeId => "text field",
        value if value == UIA_HyperlinkControlTypeId => "link",
        value if value == UIA_ImageControlTypeId => "image",
        value if value == UIA_ListControlTypeId => "list",
        value if value == UIA_ListItemControlTypeId => "list item",
        value if value == UIA_MenuItemControlTypeId => "menu item",
        value if value == UIA_PaneControlTypeId => "pane",
        value if value == UIA_RadioButtonControlTypeId => "radio button",
        value if value == UIA_TabItemControlTypeId => "tab",
        value if value == UIA_TableControlTypeId => "table",
        value if value == UIA_TextControlTypeId => "text",
        value if value == UIA_TreeItemControlTypeId => "tree item",
        _ => "control",
    }
    .to_owned()
}

thread_local! {
    static RAW_SENDER: RefCell<Option<Sender<RawInputEvent>>> = const { RefCell::new(None) };
    static MODIFIERS: Cell<ModifierState> = const { Cell::new(ModifierState::new()) };
}

#[derive(Clone, Copy)]
struct ModifierState {
    control: bool,
    alt: bool,
    shift: bool,
    windows: bool,
}

impl ModifierState {
    const fn new() -> Self {
        Self {
            control: false,
            alt: false,
            shift: false,
            windows: false,
        }
    }
}

pub struct WindowsRawInput {
    thread_id: u32,
    join: Option<JoinHandle<()>>,
}

impl WindowsRawInput {
    pub fn start(sender: Sender<RawInputEvent>) -> Result<Self> {
        let (ready_sender, ready_receiver) = mpsc::sync_channel::<Result<u32>>(1);
        let join = thread::Builder::new()
            .name("knowhow-raw-input".to_owned())
            .spawn(move || {
                RAW_SENDER.with(|slot| *slot.borrow_mut() = Some(sender));
                let result = run_raw_input_thread();
                let _ = ready_sender.send(
                    result
                        .as_ref()
                        .map(|value| *value)
                        .map_err(|error| anyhow!(error.to_string())),
                );
                if result.is_err() {
                    return;
                }
                raw_message_loop();
                RAW_SENDER.with(|slot| slot.borrow_mut().take());
            })
            .context("start raw input message thread")?;
        let thread_id = ready_receiver
            .recv_timeout(std::time::Duration::from_secs(5))
            .context("raw input thread did not initialize")??;
        Ok(Self {
            thread_id,
            join: Some(join),
        })
    }
}

impl RawInputRegistration for WindowsRawInput {
    fn stop(&mut self) {
        if self.thread_id != 0 {
            // SAFETY: posting WM_QUIT to the dedicated message thread is the documented shutdown path.
            let _ = unsafe { PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0)) };
            self.thread_id = 0;
        }
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

impl Drop for WindowsRawInput {
    fn drop(&mut self) {
        self.stop();
    }
}

fn run_raw_input_thread() -> Result<u32> {
    // SAFETY: no borrowed memory escapes; class and window live on this message thread.
    unsafe {
        let module = GetModuleHandleW(None)?;
        let instance = HINSTANCE(module.0);
        let class = WNDCLASSW {
            lpfnWndProc: Some(raw_window_proc),
            hInstance: instance,
            lpszClassName: w!("KnowHowCaptureRawInput"),
            ..Default::default()
        };
        if RegisterClassW(&raw const class) == 0 && GetLastError() != ERROR_CLASS_ALREADY_EXISTS {
            bail!("register raw input message class failed");
        }
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            w!("KnowHowCaptureRawInput"),
            w!("KnowHow Capture input sink"),
            WINDOW_STYLE::default(),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            Some(instance),
            None,
        )?;
        let flags = RIDEV_INPUTSINK | RIDEV_DEVNOTIFY;
        let devices = [
            RAWINPUTDEVICE {
                usUsagePage: 0x01,
                usUsage: 0x02,
                dwFlags: flags,
                hwndTarget: hwnd,
            },
            RAWINPUTDEVICE {
                usUsagePage: 0x01,
                usUsage: 0x06,
                dwFlags: flags,
                hwndTarget: hwnd,
            },
        ];
        RegisterRawInputDevices(&devices, u32::try_from(size_of::<RAWINPUTDEVICE>())?)?;
        WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION)?;
        Ok(GetCurrentThreadId())
    }
}

fn raw_message_loop() {
    let mut message = MSG::default();
    // SAFETY: this is the owning message loop for the raw input window.
    while unsafe { GetMessageW(&raw mut message, None, 0, 0).as_bool() } {
        unsafe {
            let _ = TranslateMessage(&raw const message);
            DispatchMessageW(&raw const message);
        }
    }
}

unsafe extern "system" fn raw_window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        WM_INPUT => {
            // SAFETY: lparam is the HRAWINPUT provided for WM_INPUT.
            unsafe { handle_raw_input(HRAWINPUT(lparam.0 as *mut c_void)) };
            if wparam.0 == RIM_INPUT as usize {
                // SAFETY: foreground WM_INPUT must reach DefWindowProc so Windows can release
                // the raw-input handle after processing.
                unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
            } else {
                LRESULT(0)
            }
        }
        WM_DISPLAYCHANGE => {
            send_raw_event(RawEvent::DisplayChanged);
            LRESULT(0)
        }
        WM_WTSSESSION_CHANGE => {
            if wparam.0 as u32 == WTS_SESSION_LOCK {
                send_raw_event(RawEvent::SessionLocked);
            } else if wparam.0 as u32 == WTS_SESSION_UNLOCK {
                send_raw_event(RawEvent::SessionUnlocked);
            }
            LRESULT(0)
        }
        WM_CLOSE => {
            // SAFETY: hwnd is the raw input window owned by this thread.
            let _ = unsafe { WTSUnRegisterSessionNotification(hwnd) };
            let _ = unsafe { DestroyWindow(hwnd) };
            LRESULT(0)
        }
        WM_DESTROY => LRESULT(0),
        _ => {
            // SAFETY: unhandled messages are delegated to the system window procedure.
            unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
        }
    }
}

unsafe fn handle_raw_input(handle: HRAWINPUT) {
    let mut size = 0_u32;
    let header_size = u32::try_from(size_of::<RAWINPUTHEADER>()).unwrap_or(0);
    // SAFETY: first call requests the required buffer size.
    if unsafe { GetRawInputData(handle, RID_INPUT, None, &raw mut size, header_size) } == u32::MAX
        || size < header_size
    {
        return;
    }
    let mut bytes = vec![0_u8; size as usize];
    // SAFETY: buffer has exactly the size requested by Windows.
    if unsafe {
        GetRawInputData(
            handle,
            RID_INPUT,
            Some(bytes.as_mut_ptr().cast()),
            &raw mut size,
            header_size,
        )
    } == u32::MAX
    {
        return;
    }
    // SAFETY: GetRawInputData populated a RAWINPUT-aligned structure; read_unaligned avoids
    // relying on Vec<u8> alignment and copies the small header/union value.
    let raw = unsafe { (bytes.as_ptr().cast::<RAWINPUT>()).read_unaligned() };
    match raw.header.dwType {
        value if value == RIM_TYPEMOUSE.0 => {
            // SAFETY: union discriminator is RIM_TYPEMOUSE.
            let mouse = unsafe { raw.data.mouse };
            // SAFETY: mouse Anonymous discriminator is the documented button flag layout.
            let flags = unsafe { mouse.Anonymous.Anonymous.usButtonFlags } as u32;
            let mut point = POINT::default();
            // SAFETY: point is writable.
            if unsafe { GetCursorPos(&raw mut point) }.is_err() {
                return;
            }
            if flags & RI_MOUSE_LEFT_BUTTON_DOWN != 0 {
                send_raw_event(RawEvent::PointerDown {
                    button: PointerButton::Left,
                    x: point.x,
                    y: point.y,
                });
            }
            if flags & RI_MOUSE_LEFT_BUTTON_UP != 0 {
                send_raw_event(RawEvent::PointerUp {
                    button: PointerButton::Left,
                    x: point.x,
                    y: point.y,
                });
            }
            if flags & RI_MOUSE_RIGHT_BUTTON_DOWN != 0 {
                send_raw_event(RawEvent::PointerDown {
                    button: PointerButton::Right,
                    x: point.x,
                    y: point.y,
                });
            }
            if flags & RI_MOUSE_RIGHT_BUTTON_UP != 0 {
                send_raw_event(RawEvent::PointerUp {
                    button: PointerButton::Right,
                    x: point.x,
                    y: point.y,
                });
            }
            // Pointer movement and wheel flags are deliberately ignored.
        }
        value if value == RIM_TYPEKEYBOARD.0 => {
            // SAFETY: union discriminator is RIM_TYPEKEYBOARD.
            let keyboard = unsafe { raw.data.keyboard };
            handle_keyboard(keyboard.VKey, keyboard.Flags & RI_KEY_BREAK as u16 != 0);
        }
        _ => {}
    }
}

fn handle_keyboard(vkey: u16, released: bool) {
    MODIFIERS.with(|cell| {
        let mut state = cell.get();
        let is_control = [VK_CONTROL.0, VK_LCONTROL.0, VK_RCONTROL.0].contains(&vkey);
        let is_alt = [VK_MENU.0, VK_LMENU.0, VK_RMENU.0].contains(&vkey);
        let is_shift = [VK_SHIFT.0, VK_LSHIFT.0, VK_RSHIFT.0].contains(&vkey);
        let is_windows = [VK_LWIN.0, VK_RWIN.0].contains(&vkey);
        if is_control {
            state.control = !released;
        }
        if is_alt {
            state.alt = !released;
        }
        if is_shift {
            state.shift = !released;
        }
        if is_windows {
            state.windows = !released;
        }
        cell.set(state);
        if released || is_control || is_alt || is_shift || is_windows {
            return;
        }
        if vkey == VK_RETURN.0 && !state.control && !state.alt && !state.windows {
            send_raw_event(RawEvent::Enter);
        } else if vkey == VK_TAB.0 && !state.control && !state.alt && !state.windows {
            send_raw_event(RawEvent::Tab);
        } else if state.control
            || state.alt
            || state.windows
            || (state.shift
                && matches!(vkey, value if value == VK_INSERT.0 || value == VK_DELETE.0))
        {
            if let Some(shortcut) = shortcut_name(vkey, state) {
                send_raw_event(RawEvent::Shortcut(shortcut));
            }
        } else {
            // No character or scan code leaves this thread. The worker receives only a
            // semantic signal that a focused value may have changed, plus whether the
            // key was one that can add a character. Counting arrow keys, Backspace and
            // the function row as typed characters is what made the verification below
            // reject nearly every real typing group.
            send_raw_event(RawEvent::TextActivity {
                changes_text: key_changes_text(vkey),
            });
        }
    });
}

/// Whether an unmodified key press can change what a text field holds.
///
/// Characters, Backspace and Delete can; the arrows, Home/End, the function row
/// and the lock keys only move the caret or the view. Starting a typing group
/// on one of those is how a stray arrow key became an "Enter text" step.
fn key_changes_text(vkey: u16) -> bool {
    const VK_BACKSPACE: u16 = 0x08;
    const VK_CLEAR: u16 = 0x0C;
    const VK_FIRST_FUNCTION: u16 = 0x70;
    const VK_LAST_FUNCTION: u16 = 0x87;
    const VK_FIRST_BROWSER: u16 = 0xA6;
    const VK_LAST_MEDIA: u16 = 0xB7;

    if matches!(vkey, VK_BACKSPACE) || vkey == VK_DELETE.0 {
        return true;
    }
    !matches!(
        vkey,
        VK_CLEAR | VK_FIRST_FUNCTION..=VK_LAST_FUNCTION | VK_FIRST_BROWSER..=VK_LAST_MEDIA
    ) && ![
        VK_PAUSE.0,
        VK_CAPITAL.0,
        VK_ESCAPE.0,
        VK_PRIOR.0,
        VK_NEXT.0,
        VK_END.0,
        VK_HOME.0,
        VK_LEFT.0,
        VK_UP.0,
        VK_RIGHT.0,
        VK_DOWN.0,
        VK_SELECT.0,
        VK_PRINT.0,
        VK_EXECUTE.0,
        VK_SNAPSHOT.0,
        VK_INSERT.0,
        VK_DELETE.0,
        VK_HELP.0,
        VK_APPS.0,
        VK_SLEEP.0,
        VK_NUMLOCK.0,
        VK_SCROLL.0,
    ]
    .contains(&vkey)
}

fn shortcut_name(vkey: u16, state: ModifierState) -> Option<String> {
    let key = match vkey {
        value if value == VK_A.0 => "A",
        value if value == VK_C.0 => "C",
        value if value == VK_F.0 => "F",
        value if value == VK_N.0 => "N",
        value if value == VK_O.0 => "O",
        value if value == VK_P.0 => "P",
        value if value == VK_R.0 => "R",
        value if value == VK_S.0 => "S",
        value if value == VK_T.0 => "T",
        value if value == VK_V.0 => "V",
        value if value == VK_W.0 => "W",
        value if value == VK_X.0 => "X",
        value if value == VK_Y.0 => "Y",
        value if value == VK_Z.0 => "Z",
        value if value == VK_TAB.0 => "Tab",
        value if value == VK_DELETE.0 => "Delete",
        value if value == VK_ESCAPE.0 => "Escape",
        value if value == VK_INSERT.0 => "Insert",
        value if value == VK_HOME.0 => "Home",
        value if value == VK_END.0 => "End",
        value if value == VK_PRIOR.0 => "Page Up",
        value if value == VK_NEXT.0 => "Page Down",
        value if value == VK_LEFT.0 => "Left",
        value if value == VK_RIGHT.0 => "Right",
        value if value == VK_UP.0 => "Up",
        value if value == VK_DOWN.0 => "Down",
        value if (VK_0.0..=VK_9.0).contains(&value) => {
            return Some((char::from_u32(u32::from(value)).unwrap_or('?')).to_string());
        }
        _ => return None,
    };
    let mut parts = Vec::with_capacity(4);
    if state.control {
        parts.push("Ctrl");
    }
    if state.alt {
        parts.push("Alt");
    }
    if state.shift {
        parts.push("Shift");
    }
    if state.windows {
        parts.push("Win");
    }
    parts.push(key);
    Some(parts.join("+"))
}

fn send_raw_event(event: RawEvent) {
    // Stamped here, on the input thread, so a busy processor cannot backdate or
    // postdate the author's action.
    let event = RawInputEvent {
        at: Instant::now(),
        event,
    };
    RAW_SENDER.with(|slot| {
        if let Some(sender) = slot.borrow().as_ref() {
            // The channel is unbounded on purpose. A dropped event is a click the
            // author performed and KnowHow silently forgot, which is never an
            // acceptable trade for a shorter queue: hardware input arrives at human
            // speed and each event is a few dozen bytes, so even a processor stalled
            // for a minute costs a few kilobytes. Unbounded send also never blocks,
            // so this stays off the user's input path.
            let _ = sender.send(event);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{friendly_monitor_name, is_shareable_window_properties, key_changes_text};
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        VK_A, VK_DELETE, VK_END, VK_ESCAPE, VK_F, VK_HOME, VK_LEFT, VK_RIGHT, VK_SPACE, VK_UP,
    };
    use windows::Win32::UI::WindowsAndMessaging::{WS_EX_APPWINDOW, WS_EX_TOOLWINDOW};

    #[test]
    fn only_keys_that_can_change_a_field_begin_a_typing_group() {
        const VK_BACKSPACE: u16 = 0x08;
        const VK_F5: u16 = 0x74;
        for key in [VK_A.0, VK_F.0, VK_SPACE.0, VK_BACKSPACE, VK_DELETE.0] {
            assert!(key_changes_text(key), "{key:#x} should count as typing");
        }
        // A caret move is not typing: treating one as the start of a group is
        // how a stray arrow key turned into an "Enter text" step.
        for key in [
            VK_LEFT.0,
            VK_RIGHT.0,
            VK_UP.0,
            VK_HOME.0,
            VK_END.0,
            VK_ESCAPE.0,
            VK_F5,
        ] {
            assert!(!key_changes_text(key), "{key:#x} should not count as typing");
        }
    }

    #[test]
    fn alt_tab_filter_excludes_helper_and_cloaked_windows() {
        assert!(is_shareable_window_properties(true, false, 0, false));
        assert!(!is_shareable_window_properties(false, false, 0, false));
        assert!(!is_shareable_window_properties(true, true, 0, false));
        assert!(!is_shareable_window_properties(
            true,
            false,
            WS_EX_TOOLWINDOW.0,
            false
        ));
        assert!(!is_shareable_window_properties(true, false, 0, true));
        assert!(is_shareable_window_properties(
            true,
            false,
            WS_EX_TOOLWINDOW.0 | WS_EX_APPWINDOW.0,
            true
        ));
    }

    #[test]
    fn physical_displays_never_leak_device_paths_into_the_picker() {
        assert_eq!(friendly_monitor_name(r"\\.\DISPLAY1", 4), "Display 1");
        assert_eq!(friendly_monitor_name("", 1), "Display 2");
    }
}
