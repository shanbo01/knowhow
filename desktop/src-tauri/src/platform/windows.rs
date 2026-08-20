use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    ffi::c_void,
    mem::size_of,
    path::Path,
    sync::mpsc::{self, SyncSender},
    thread::{self, JoinHandle},
};

use anyhow::{Context, Result, anyhow, bail};
use windows::{
    Win32::{
        Foundation::{CloseHandle, HANDLE, HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
        Graphics::Gdi::{
            EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITOR_DEFAULTTONEAREST,
            MONITORINFO, MONITORINFOEXW, MonitorFromWindow,
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
                CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationValuePattern,
                UIA_ButtonControlTypeId, UIA_CheckBoxControlTypeId, UIA_ComboBoxControlTypeId,
                UIA_DataGridControlTypeId, UIA_DocumentControlTypeId, UIA_EditControlTypeId,
                UIA_HyperlinkControlTypeId, UIA_ImageControlTypeId, UIA_ListControlTypeId,
                UIA_ListItemControlTypeId, UIA_MenuItemControlTypeId, UIA_PaneControlTypeId,
                UIA_RadioButtonControlTypeId, UIA_TabItemControlTypeId, UIA_TableControlTypeId,
                UIA_TextControlTypeId, UIA_TreeItemControlTypeId, UIA_ValuePatternId,
            },
            HiDpi::{DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext},
            Input::{
                GetRawInputData, HRAWINPUT,
                KeyboardAndMouse::{
                    VK_0, VK_9, VK_A, VK_C, VK_CONTROL, VK_DELETE, VK_DOWN, VK_END, VK_ESCAPE,
                    VK_F, VK_HOME, VK_INSERT, VK_LCONTROL, VK_LEFT, VK_LMENU, VK_LSHIFT, VK_LWIN,
                    VK_MENU, VK_N, VK_NEXT, VK_O, VK_P, VK_PRIOR, VK_R, VK_RCONTROL, VK_RETURN,
                    VK_RIGHT, VK_RMENU, VK_RSHIFT, VK_RWIN, VK_S, VK_SHIFT, VK_T, VK_TAB, VK_UP,
                    VK_V, VK_W, VK_X, VK_Y, VK_Z,
                },
                RAWINPUT, RAWINPUTDEVICE, RAWINPUTHEADER, RID_INPUT, RIDEV_DEVNOTIFY,
                RIDEV_INPUTSINK, RIM_TYPEKEYBOARD, RIM_TYPEMOUSE, RegisterRawInputDevices,
            },
            WindowsAndMessaging::{
                CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, EnumWindows,
                GA_ROOTOWNER, GetAncestor, GetCursorPos, GetForegroundWindow, GetMessageW,
                GetWindowRect, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
                HWND_MESSAGE, IDNO, IDYES, IsWindowVisible, MB_DEFBUTTON3, MB_ICONQUESTION,
                MB_YESNOCANCEL, MSG, MessageBoxW, PostThreadMessageW, RI_KEY_BREAK,
                RI_MOUSE_LEFT_BUTTON_DOWN, RI_MOUSE_LEFT_BUTTON_UP, RI_MOUSE_RIGHT_BUTTON_DOWN,
                RI_MOUSE_RIGHT_BUTTON_UP, RegisterClassW, TranslateMessage, WINDOW_EX_STYLE,
                WINDOW_STYLE, WM_CLOSE, WM_DESTROY, WM_DISPLAYCHANGE, WM_INPUT, WM_QUIT,
                WM_WTSSESSION_CHANGE, WNDCLASSW, WTS_SESSION_LOCK, WTS_SESSION_UNLOCK,
            },
        },
    },
    core::{BOOL, PWSTR, w},
};

use super::{
    ElementMetadata, ExcludedRegion, ForegroundContext, MonitorDescriptor, PasswordStatus,
    PointerButton, QuitChoice, RawEvent, RawInputRegistration, UiAutomationClient,
};
use crate::model::{Bounds, CaptureTarget, DesktopScope, ScopeKind};

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

#[derive(Clone, Debug)]
struct WindowRecord {
    id: String,
    root_owner_id: String,
    process_id: u32,
    application_name: String,
    title: String,
    bounds: Bounds,
    protected: bool,
    elevated: bool,
}

pub fn initialize_process() -> Result<()> {
    // SAFETY: this is called once during process startup, before capture worker windows exist.
    unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) }
        .context("enable per-monitor DPI awareness")
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
    let windows = enumerate_windows()?;
    let mut applications = BTreeMap::<u32, &WindowRecord>::new();
    for window in &windows {
        if window.process_id == std::process::id() || window.protected || window.elevated {
            continue;
        }
        applications.entry(window.process_id).or_insert(window);
    }
    let mut targets = applications
        .into_iter()
        .map(|(process_id, window)| CaptureTarget {
            id: format!("process:{process_id}"),
            kind: ScopeKind::Application,
            label: window.application_name.clone(),
            detail: window.title.clone(),
            process_id: Some(process_id),
            bounds: Some(window.bounds),
            protected: false,
        })
        .collect::<Vec<_>>();
    targets.extend(windows.into_iter().map(|window| CaptureTarget {
        id: window.id,
        kind: ScopeKind::Window,
        label: window.title,
        detail: window.application_name,
        process_id: Some(window.process_id),
        bounds: Some(window.bounds),
        protected: window.protected || window.elevated || window.process_id == std::process::id(),
    }));
    targets.extend(
        monitor_descriptors()?
            .into_iter()
            .map(|monitor| CaptureTarget {
                id: monitor.id,
                kind: ScopeKind::Monitor,
                label: monitor.name,
                detail: format!("{} × {}", monitor.bounds.width, monitor.bounds.height),
                process_id: None,
                bounds: Some(monitor.bounds),
                protected: false,
            }),
    );
    Ok(targets)
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
        ScopeKind::Window => {
            let target = valid_target(target, ScopeKind::Window)?;
            Ok(DesktopScope::Window {
                window_id: target.id.clone(),
                application_name: target.detail.clone(),
                window_title: Some(target.label.clone()),
                include_owned_dialogs: true,
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
        ScopeKind::AllDisplays => Ok(DesktopScope::AllDisplays {
            monitor_ids: monitor_descriptors()?
                .into_iter()
                .map(|monitor| monitor.id)
                .collect(),
            excluded_window_ids,
        }),
    }
}

fn valid_target(target: Option<&CaptureTarget>, kind: ScopeKind) -> Result<&CaptureTarget> {
    let target = target.ok_or_else(|| anyhow!("Choose a capture target."))?;
    if target.kind != kind || target.protected {
        bail!("The selected capture target is protected or no longer available.");
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
            let name = utf16_z(&info.szDevice);
            monitors.push(MonitorDescriptor {
                id: monitor_id(monitor),
                name: if name.is_empty() {
                    format!("Display {}", index + 1)
                } else {
                    name
                },
                bounds: rect_bounds(rect),
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
        root_owner_id: record.root_owner_id,
        process_id: record.process_id,
        monitor_id: monitor_id(monitor),
        protected: record.protected || record.process_id == std::process::id(),
        elevated: record.elevated,
    })
}

pub fn excluded_regions() -> Result<Vec<ExcludedRegion>> {
    Ok(enumerate_windows()?
        .into_iter()
        .filter_map(|window| {
            let reason = if window.process_id == std::process::id() {
                Some("knowhow-window")
            } else if window.protected {
                Some("protected-window")
            } else if window.elevated {
                Some("elevated-window")
            } else {
                None
            }?;
            Some(ExcludedRegion {
                bounds: window.bounds,
                reason,
            })
        })
        .collect())
}

fn enumerate_windows() -> Result<Vec<WindowRecord>> {
    unsafe extern "system" fn callback(hwnd: HWND, data: LPARAM) -> BOOL {
        // SAFETY: data is a valid Vec pointer during synchronous EnumWindows.
        let windows = unsafe { &mut *(data.0 as *mut Vec<WindowRecord>) };
        // SAFETY: hwnd is supplied by EnumWindows.
        if !unsafe { IsWindowVisible(hwnd).as_bool() } {
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

fn window_record(hwnd: HWND) -> Result<WindowRecord> {
    let mut process_id = 0_u32;
    // SAFETY: HWND comes from Windows and output points to initialized storage.
    unsafe { GetWindowThreadProcessId(hwnd, Some(&raw mut process_id)) };
    if process_id == 0 {
        bail!("window process is unavailable");
    }
    let title = window_text(hwnd);
    let application_name =
        process_application_name(process_id).unwrap_or_else(|| "Windows application".to_owned());
    let mut rect = RECT::default();
    // SAFETY: HWND comes from Windows and rect is writable.
    unsafe { GetWindowRect(hwnd, &raw mut rect) }.context("read window bounds")?;
    // SAFETY: HWND is valid; returned root owner is borrowed.
    let root_owner = unsafe { GetAncestor(hwnd, GA_ROOTOWNER) };
    let protected = is_known_protected(&application_name, &title);
    Ok(WindowRecord {
        id: window_id(hwnd),
        root_owner_id: window_id(root_owner),
        process_id,
        application_name,
        title,
        bounds: rect_bounds(rect),
        protected,
        elevated: process_id != std::process::id()
            && process_is_elevated(process_id).unwrap_or(true),
    })
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
        "explorer" => "File Explorer".to_owned(),
        "applicationframehost" => "Windows application".to_owned(),
        "msedge" => "Microsoft Edge".to_owned(),
        "winword" => "Microsoft Word".to_owned(),
        "excel" => "Microsoft Excel".to_owned(),
        "powerpnt" => "Microsoft PowerPoint".to_owned(),
        _ => name.to_owned(),
    }
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

    fn metadata(&self, element: &IUIAutomationElement) -> Result<ElementMetadata> {
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
            .map(|point| unsafe { windows::Win32::UI::WindowsAndMessaging::WindowFromPoint(point) })
            .unwrap_or_default();
        let hwnd = if hwnd.0.is_null() {
            fallback_hwnd
        } else {
            hwnd
        };
        let record =
            window_record(hwnd).or_else(|_| window_record(unsafe { GetForegroundWindow() }))?;
        let value = if password_status == PasswordStatus::NotPassword {
            unsafe {
                element
                    .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                    .and_then(|pattern| pattern.CurrentValue())
            }
            .ok()
            .map(|value| value.to_string())
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
}

impl UiAutomationClient for WindowsUia {
    fn element_at(&self, x: i32, y: i32) -> Result<ElementMetadata> {
        // SAFETY: automation and returned element remain on this COM worker thread.
        let element = unsafe { self.automation.ElementFromPoint(POINT { x, y }) }
            .context("look up UI Automation element at pointer")?;
        self.metadata(&element)
    }

    fn focused_element(&self) -> Result<ElementMetadata> {
        // SAFETY: automation and returned element remain on this COM worker thread.
        let element = unsafe { self.automation.GetFocusedElement() }
            .context("look up focused UI Automation element")?;
        self.metadata(&element)
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
    static RAW_SENDER: RefCell<Option<SyncSender<RawEvent>>> = const { RefCell::new(None) };
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
    pub fn start(sender: SyncSender<RawEvent>) -> Result<Self> {
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
        if RegisterClassW(&raw const class) == 0 {
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
            LRESULT(0)
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
        } else if state.control || state.alt || state.windows {
            if let Some(shortcut) = shortcut_name(vkey, state) {
                send_raw_event(RawEvent::Shortcut(shortcut));
            }
        } else {
            // No character or scan code leaves this thread. The worker receives only a
            // semantic signal that a focused value may have changed.
            send_raw_event(RawEvent::TextActivity);
        }
    });
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
    RAW_SENDER.with(|slot| {
        if let Some(sender) = slot.borrow().as_ref() {
            // A full channel drops the signal instead of delaying the user's input path.
            let _ = sender.try_send(event);
        }
    });
}
