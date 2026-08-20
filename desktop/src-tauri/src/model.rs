use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, ZeroizeOnDrop};

pub const DESKTOP_POLICY_VERSION: &str = "desktop-v2-redacted";
pub const MAX_STEPS: usize = 100;
pub const MAX_SCREENSHOT_BYTES: usize = 5 * 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum ConnectionState {
    Disconnected,
    Authorizing {
        #[serde(rename = "deviceName")]
        device_name: String,
        #[serde(rename = "expiresAt")]
        expires_at: String,
    },
    Connected {
        #[serde(rename = "workspaceId")]
        workspace_id: String,
        #[serde(rename = "workspaceName")]
        workspace_name: String,
        #[serde(rename = "minimumVersion")]
        minimum_version: String,
    },
    Blocked {
        message: String,
    },
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RecorderStatus {
    #[default]
    Idle,
    Countdown,
    Recording,
    Paused,
    Finishing,
    Uploading,
    Recovery,
    Blocked,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecorderState {
    pub status: RecorderStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capture_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub countdown_remaining: Option<u8>,
    pub steps: Vec<StepSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub editor_url: Option<String>,
}

impl Default for RecorderState {
    fn default() -> Self {
        Self {
            status: RecorderStatus::Idle,
            capture_id: None,
            scope_label: None,
            countdown_remaining: None,
            steps: Vec::new(),
            status_message: None,
            editor_url: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StepStatus {
    Ready,
    Processing,
    Retry,
    Deleting,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepSummary {
    pub id: String,
    pub order: usize,
    pub title: String,
    pub instruction: String,
    pub interaction: String,
    pub status: StepStatus,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ScopeKind {
    Application,
    Window,
    Monitor,
    AllDisplays,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Bounds {
    pub fn contains(self, x: i32, y: i32) -> bool {
        let right = i64::from(self.x) + i64::from(self.width);
        let bottom = i64::from(self.y) + i64::from(self.height);
        i64::from(x) >= i64::from(self.x)
            && i64::from(x) < right
            && i64::from(y) >= i64::from(self.y)
            && i64::from(y) < bottom
    }

    pub fn intersection(self, other: Self) -> Option<Self> {
        let left = self.x.max(other.x);
        let top = self.y.max(other.y);
        let right = (i64::from(self.x) + i64::from(self.width))
            .min(i64::from(other.x) + i64::from(other.width));
        let bottom = (i64::from(self.y) + i64::from(self.height))
            .min(i64::from(other.y) + i64::from(other.height));
        let width = right - i64::from(left);
        let height = bottom - i64::from(top);
        if width <= 0 || height <= 0 {
            return None;
        }
        Some(Self {
            x: left,
            y: top,
            width: u32::try_from(width).ok()?,
            height: u32::try_from(height).ok()?,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureTarget {
    pub id: String,
    pub kind: ScopeKind,
    pub label: String,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_id: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<Bounds>,
    pub protected: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartBlurSettings {
    pub emails: bool,
    pub phone_numbers: bool,
    pub financial_numbers: bool,
    pub identifiers: bool,
    pub form_fields: bool,
    pub images: bool,
    pub table_rows: bool,
    pub long_text: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TypedTextPolicy {
    Allowed,
    Disabled,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecorderSettings {
    pub capture_typed_text: bool,
    pub desktop_typed_text_policy: TypedTextPolicy,
    pub smart_blur: SmartBlurSettings,
}

impl Default for RecorderSettings {
    fn default() -> Self {
        Self {
            capture_typed_text: false,
            desktop_typed_text_policy: TypedTextPolicy::Allowed,
            smart_blur: SmartBlurSettings::default(),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartCaptureInput {
    pub scope_kind: ScopeKind,
    pub target_id: Option<String>,
    pub target_label: String,
    pub capture_typed_text: bool,
    pub smart_blur: SmartBlurSettings,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    pub status: UpdateStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

impl Default for UpdateState {
    fn default() -> Self {
        Self {
            status: UpdateStatus::Idle,
            version: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum UpdateStatus {
    Idle,
    Checking,
    Available,
    Deferred,
    Current,
    Error,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSnapshot {
    pub version: String,
    pub connection: ConnectionState,
    pub recorder: RecorderState,
    pub settings: RecorderSettings,
    pub update: UpdateState,
}

#[derive(Clone, Debug, Deserialize, Serialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCredentials {
    pub access_token: String,
    pub access_expires_at: String,
    pub refresh_token: String,
    pub refresh_expires_at: String,
    pub workspace_id: String,
    pub workspace_name: String,
    pub minimum_version: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase")]
pub struct PendingAuthorization {
    pub authorization_id: String,
    pub verification_uri: String,
    pub expires_at: String,
    pub interval_seconds: u64,
    pub verifier: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceIdentity {
    pub device_id: String,
    pub device_name: String,
    pub architecture: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureContext {
    pub workspace_id: String,
    pub workspace_name: String,
    pub policy_version: String,
    pub minimum_version: String,
    pub desktop_typed_text_policy: TypedTextPolicy,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum DesktopScope {
    Application {
        application_name: String,
        process_id: u32,
        excluded_window_ids: Vec<String>,
    },
    Window {
        window_id: String,
        application_name: String,
        window_title: Option<String>,
        include_owned_dialogs: bool,
        excluded_window_ids: Vec<String>,
    },
    Monitor {
        monitor_id: String,
        monitor_name: Option<String>,
        bounds: Bounds,
        excluded_window_ids: Vec<String>,
    },
    AllDisplays {
        monitor_ids: Vec<String>,
        excluded_window_ids: Vec<String>,
    },
}

impl DesktopScope {
    pub fn label(&self) -> String {
        match self {
            Self::Application {
                application_name, ..
            }
            | Self::Window {
                application_name, ..
            } => application_name.clone(),
            Self::Monitor {
                monitor_name,
                monitor_id,
                ..
            } => monitor_name.clone().unwrap_or_else(|| monitor_id.clone()),
            Self::AllDisplays { .. } => "All displays".to_owned(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerAnnotation {
    pub id: String,
    pub kind: String,
    pub x: f64,
    pub y: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x2: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y2: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturedStep {
    pub id: String,
    pub order: usize,
    pub title: String,
    pub instructions: String,
    pub source_event: String,
    pub password_status: String,
    pub annotations: Vec<ServerAnnotation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    pub image_width: u32,
    pub image_height: u32,
    pub automatic_mask_count: usize,
}

impl CapturedStep {
    pub fn summary(&self, status: StepStatus) -> StepSummary {
        StepSummary {
            id: self.id.clone(),
            order: self.order,
            title: self.title.clone(),
            instruction: self.instructions.clone(),
            interaction: self.source_event.clone(),
            status,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitPayload {
    pub steps: Vec<CapturedStep>,
    pub privacy_attestation: PrivacyAttestation,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivacyAttestation {
    pub policy_version: String,
    pub source_rasterized: bool,
    pub password_masks_applied: bool,
    pub excluded_window_masks_applied: bool,
    pub automatic_mask_count: usize,
    pub manual_mask_count: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ActiveCapture {
    pub session_id: String,
    pub capture_id: String,
    pub scope: DesktopScope,
    pub title: String,
    pub text_input_capture: String,
    pub smart_blur: SmartBlurSettings,
}

#[cfg(test)]
mod tests {
    use super::Bounds;

    #[test]
    fn bounds_support_negative_mixed_dpi_coordinates() {
        let left_monitor = Bounds {
            x: -2560,
            y: -240,
            width: 2560,
            height: 1440,
        };
        assert!(left_monitor.contains(-1, 0));
        assert!(left_monitor.contains(-2560, -240));
        assert!(!left_monitor.contains(0, 0));
    }

    #[test]
    fn intersection_clips_excluded_windows() {
        let monitor = Bounds {
            x: -1920,
            y: 0,
            width: 1920,
            height: 1080,
        };
        let window = Bounds {
            x: -200,
            y: 100,
            width: 600,
            height: 500,
        };
        assert_eq!(
            monitor.intersection(window).map(|bounds| bounds.width),
            Some(200)
        );
    }
}
