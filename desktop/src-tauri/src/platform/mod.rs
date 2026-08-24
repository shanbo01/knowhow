use anyhow::Result;

use crate::model::{Bounds, DesktopScope};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PointerButton {
    Left,
    Right,
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
    TextActivity,
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
    pub root_owner_id: String,
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

#[derive(Clone, Debug)]
pub struct ExcludedRegion {
    pub bounds: Bounds,
    pub reason: &'static str,
}

#[derive(Clone, Debug)]
pub struct PrivacyRegion {
    pub bounds: Bounds,
    pub control_role: Option<String>,
    pub text: Option<String>,
    pub password_status: PasswordStatus,
}

pub trait UiAutomationClient {
    fn element_at(&self, x: i32, y: i32) -> Result<ElementMetadata>;
    fn focused_element(&self) -> Result<ElementMetadata>;
    fn focused_element_semantic(&self) -> Result<ElementMetadata> {
        self.focused_element()
    }
    fn privacy_regions(&self, window_id: &str) -> Result<Vec<PrivacyRegion>>;
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
    capture_targets, excluded_regions, foreground_context, initialize_process, monitor_descriptors,
    new_scope, quit_capture_choice, windows_device_name,
};

#[cfg(not(windows))]
mod unsupported {
    use super::*;
    use std::sync::mpsc::SyncSender;

    use crate::model::CaptureTarget;

    pub struct NativeRawInput;
    pub struct NativeUia;

    impl NativeRawInput {
        pub fn start(_sender: SyncSender<RawEvent>) -> Result<Self> {
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
        fn privacy_regions(&self, _window_id: &str) -> Result<Vec<PrivacyRegion>> {
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
    pub fn excluded_regions() -> Result<Vec<ExcludedRegion>> {
        Ok(Vec::new())
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
    pub fn windows_device_name() -> String {
        "Windows device".to_owned()
    }
    pub fn quit_capture_choice() -> QuitChoice {
        QuitChoice::Cancel
    }
}

#[cfg(not(windows))]
pub use unsupported::*;

pub fn event_sender_capacity() -> usize {
    512
}

pub fn scope_accepts(
    scope: &DesktopScope,
    foreground: &ForegroundContext,
    point: Option<(i32, i32)>,
) -> bool {
    if foreground.protected || foreground.elevated {
        return false;
    }
    match scope {
        DesktopScope::Application { process_id, .. } => foreground.process_id == *process_id,
        DesktopScope::Window {
            window_id,
            include_owned_dialogs,
            ..
        } => {
            foreground.window_id == *window_id
                || (*include_owned_dialogs && foreground.root_owner_id == *window_id)
        }
        DesktopScope::Monitor {
            monitor_id, bounds, ..
        } => {
            let (x, y) = point.unwrap_or((foreground.bounds.x, foreground.bounds.y));
            foreground.monitor_id == *monitor_id && bounds.contains(x, y)
        }
        DesktopScope::AllDisplays { monitor_ids, .. } => {
            monitor_ids.iter().any(|id| id == &foreground.monitor_id)
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
                x: -900,
                y: 20,
                width: 800,
                height: 600,
            },
            window_id: "hwnd:2".into(),
            root_owner_id: "hwnd:1".into(),
            process_id: 42,
            monitor_id: "monitor:left".into(),
            protected: false,
            elevated: false,
        }
    }

    #[test]
    fn window_scope_follows_owned_dialogs() {
        let scope = DesktopScope::Window {
            window_id: "hwnd:1".into(),
            application_name: "Notepad".into(),
            window_title: None,
            include_owned_dialogs: true,
            excluded_window_ids: Vec::new(),
        };
        assert!(scope_accepts(&scope, &foreground(), None));
    }

    #[test]
    fn protected_and_elevated_activity_fail_closed() {
        let scope = DesktopScope::Application {
            application_name: "Notepad".into(),
            process_id: 42,
            excluded_window_ids: Vec::new(),
        };
        let mut target = foreground();
        target.protected = true;
        assert!(!scope_accepts(&scope, &target, None));
        target.protected = false;
        target.elevated = true;
        assert!(!scope_accepts(&scope, &target, None));
    }
}
