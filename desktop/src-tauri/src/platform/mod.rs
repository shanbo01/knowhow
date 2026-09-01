use std::time::Instant;

use anyhow::Result;

use crate::model::{Bounds, DesktopScope};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PointerButton {
    Left,
    Right,
}

/// A raw input event together with the moment the hardware produced it.
///
/// The processor can fall behind — a UI Automation lookup on a busy application
/// takes as long as it takes — and when it does, `Instant::now()` inside the
/// handler is no longer the time of the action. Choosing a pre-action screenshot
/// or deciding whether two presses were a double-click from that later reading
/// silently attributes the wrong moment to the author's click, so the timestamp
/// travels with the event instead.
#[derive(Clone, Debug)]
pub struct RawInputEvent {
    pub at: Instant,
    pub event: RawEvent,
}

#[derive(Clone, Debug)]
pub enum RawEvent {
    PointerDown {
        button: PointerButton,
        x: i32,
        y: i32,
    },
    PointerUp {
        button: PointerButton,
        x: i32,
        y: i32,
    },
    /// An unmodified key press in a text field. `changes_text` is true for the
    /// keys that can alter what the field holds — characters, Backspace,
    /// Delete — and false for the ones that only move the caret or the view.
    TextActivity {
        changes_text: bool,
    },
    Enter,
    Tab,
    Shortcut(String),
    DisplayChanged,
    SessionLocked,
    SessionUnlocked,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PasswordStatus {
    NotPassword,
    Password,
    Unknown,
}

impl PasswordStatus {
    pub fn as_server_value(self) -> &'static str {
        match self {
            Self::NotPassword => "not-password",
            Self::Password => "password",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Debug)]
pub struct ElementMetadata {
    pub application_name: String,
    pub window_title: String,
    pub control_role: Option<String>,
    pub control_label: Option<String>,
    pub bounds: Option<Bounds>,
    pub password_status: PasswordStatus,
    pub value: Option<String>,
    pub window_id: String,
    pub process_id: u32,
}

#[derive(Clone, Debug)]
pub struct ForegroundContext {
    pub application_name: String,
    pub window_title: String,
    pub bounds: Bounds,
    pub window_id: String,
    pub process_id: u32,
    pub monitor_id: String,
    pub protected: bool,
    pub elevated: bool,
}

#[derive(Clone, Debug)]
pub struct MonitorDescriptor {
    pub id: String,
    pub name: String,
    pub bounds: Bounds,
    pub work_area: Bounds,
    pub index: usize,
}

pub trait UiAutomationClient {
    fn element_at(&self, x: i32, y: i32) -> Result<ElementMetadata>;
    fn focused_element(&self) -> Result<ElementMetadata>;
    fn focused_element_semantic(&self) -> Result<ElementMetadata> {
        self.focused_element()
    }
}

pub trait RawInputRegistration: Send {
    fn stop(&mut self);
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum QuitChoice {
    Finish,
    Discard,
    Cancel,
}

#[cfg(windows)]
mod windows;

#[cfg(windows)]
pub use windows::{
    WindowsRawInput as NativeRawInput, WindowsUia as NativeUia, capture_target_previews,
    capture_targets, double_click_interval, foreground_context, initialize_process,
    monitor_descriptors, new_scope, process_at_point, quit_capture_choice, recorder_window_bounds,
    scope_outline_bounds, windows_device_name,
};

#[cfg(not(windows))]
mod unsupported {
    use super::*;
    use std::sync::mpsc::Sender;

    use crate::model::CaptureTarget;

    pub struct NativeRawInput;
    pub struct NativeUia;

    impl NativeRawInput {
        pub fn start(_sender: Sender<RawInputEvent>) -> Result<Self> {
            anyhow::bail!("KnowHow Capture supports Windows only")
        }
    }

    impl RawInputRegistration for NativeRawInput {
        fn stop(&mut self) {}
    }

    impl NativeUia {
        pub fn new() -> Result<Self> {
            anyhow::bail!("KnowHow Capture supports Windows only")
        }
    }

    impl UiAutomationClient for NativeUia {
        fn element_at(&self, _x: i32, _y: i32) -> Result<ElementMetadata> {
            anyhow::bail!("KnowHow Capture supports Windows only")
        }
        fn focused_element(&self) -> Result<ElementMetadata> {
            anyhow::bail!("KnowHow Capture supports Windows only")
        }
        fn focused_element_semantic(&self) -> Result<ElementMetadata> {
            anyhow::bail!("KnowHow Capture supports Windows only")
        }
    }

    pub fn initialize_process() -> Result<()> {
        anyhow::bail!("KnowHow Capture supports Windows only")
    }
    pub fn capture_targets() -> Result<Vec<CaptureTarget>> {
        Ok(Vec::new())
    }
    pub fn capture_target_previews(
        _target_ids: &[String],
    ) -> Result<Vec<crate::model::CaptureTargetPreview>> {
        Ok(Vec::new())
    }
    pub fn monitor_descriptors() -> Result<Vec<MonitorDescriptor>> {
        Ok(Vec::new())
    }
    pub fn recorder_window_bounds() -> Vec<Bounds> {
        Vec::new()
    }
    pub fn process_at_point(_x: i32, _y: i32) -> Option<u32> {
        None
    }
    pub fn scope_outline_bounds(_scope: &DesktopScope) -> Option<Bounds> {
        None
    }
    pub fn foreground_context() -> Result<ForegroundContext> {
        anyhow::bail!("KnowHow Capture supports Windows only")
    }
    pub fn new_scope(
        _kind: crate::model::ScopeKind,
        _target: Option<&CaptureTarget>,
    ) -> Result<DesktopScope> {
        anyhow::bail!("KnowHow Capture supports Windows only")
    }
    pub fn double_click_interval() -> std::time::Duration {
        std::time::Duration::from_millis(500)
    }
    pub fn windows_device_name() -> String {
        "Windows device".to_owned()
    }
    pub fn quit_capture_choice() -> QuitChoice {
        QuitChoice::Cancel
    }
}

#[cfg(not(windows))]
pub use unsupported::*;

/// Whether an action belongs to the capture the author chose to record.
///
/// Protected surfaces (password managers, UAC, the lock screen) and elevated
/// windows are never recorded: KnowHow cannot read their contents reliably, so
/// it declines them rather than photographing something it does not understand.
pub fn scope_accepts(
    scope: &DesktopScope,
    foreground: &ForegroundContext,
    point: Option<(i32, i32)>,
) -> bool {
    if foreground.protected || foreground.elevated {
        return false;
    }
    match scope {
        // A press is attributed to the window under the pointer. Focus still
        // belongs to the recorded application at the moment the button goes
        // down on the taskbar, the Start button or another window, so checking
        // focus alone recorded all three as steps of the application's guide.
        DesktopScope::Application { process_id, .. } => match point {
            Some((x, y)) => process_at_point(x, y).is_some_and(|owner| owner == *process_id),
            None => foreground.process_id == *process_id,
        },
        DesktopScope::Monitor {
            monitor_id, bounds, ..
        } => {
            let (x, y) = point.unwrap_or((foreground.bounds.x, foreground.bounds.y));
            foreground.monitor_id == *monitor_id && bounds.contains(x, y)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{ForegroundContext, scope_accepts};
    use crate::model::{Bounds, DesktopScope};

    fn foreground() -> ForegroundContext {
        ForegroundContext {
            application_name: "Notepad".into(),
            window_title: "Notes".into(),
            bounds: Bounds {
                x: 0,
                y: 0,
                width: 800,
                height: 600,
            },
            window_id: "hwnd:1".into(),
            process_id: 42,
            monitor_id: "monitor:1".into(),
            protected: false,
            elevated: false,
        }
    }

    #[test]
    fn an_application_scope_follows_every_window_of_that_process() {
        let scope = DesktopScope::Application {
            application_name: "Notepad".into(),
            process_id: 42,
            excluded_window_ids: Vec::new(),
        };
        assert!(scope_accepts(&scope, &foreground(), None));
        let other = ForegroundContext {
            process_id: 43,
            ..foreground()
        };
        assert!(!scope_accepts(&scope, &other, None));
    }

    #[test]
    fn protected_and_elevated_activity_fail_closed() {
        let scope = DesktopScope::Application {
            application_name: "Notepad".into(),
            process_id: 42,
            excluded_window_ids: Vec::new(),
        };
        let protected = ForegroundContext {
            protected: true,
            ..foreground()
        };
        let elevated = ForegroundContext {
            elevated: true,
            ..foreground()
        };
        assert!(!scope_accepts(&scope, &protected, None));
        assert!(!scope_accepts(&scope, &elevated, None));
    }

    #[test]
    fn a_display_scope_only_accepts_actions_on_that_display() {
        let scope = DesktopScope::Monitor {
            monitor_id: "monitor:1".into(),
            monitor_name: Some("Display 1".into()),
            bounds: Bounds {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
            excluded_window_ids: Vec::new(),
        };
        assert!(scope_accepts(&scope, &foreground(), Some((100, 100))));
        assert!(!scope_accepts(&scope, &foreground(), Some((3000, 100))));
    }
}
