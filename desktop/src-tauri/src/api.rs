use std::{sync::Arc, time::Duration};

use anyhow::{Context, Result, anyhow, bail};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use reqwest::{Client, Method, Response, StatusCode, redirect::Policy};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use url::Url;
use uuid::Uuid;

use crate::{
    model::{
        CaptureContext, CapturedStep, CommitPayload, DESKTOP_POLICY_VERSION, DesktopScope,
        DeviceCredentials, DeviceIdentity, PendingAuthorization,
    },
    secure_store::SecureStore,
};

#[derive(Clone)]
pub struct ApiClient {
    origin: Url,
    http: Client,
    store: SecureStore,
    device: DeviceIdentity,
    credentials: Arc<Mutex<Option<DeviceCredentials>>>,
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct ApiError {
    pub status: StatusCode,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthorizationResponse {
    authorization_id: String,
    verification_uri: String,
    expires_at: String,
    interval_seconds: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenResponse {
    access_token: String,
    expires_at: String,
    refresh_token: String,
    refresh_expires_at: String,
    workspace_id: String,
    workspace_name: Option<String>,
    minimum_version: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartCaptureResponse {
    pub capture_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitResponse {
    pub guide_id: String,
    pub revision_id: String,
    pub edit_url: String,
    pub privacy_review_pending: bool,
}

pub enum AuthorizationPoll {
    Pending,
    Connected(DeviceCredentials),
}

impl ApiClient {
    pub fn new(store: SecureStore, device: DeviceIdentity) -> Result<Self> {
        let origin = configured_origin()?;
        let http = Client::builder()
            .https_only(!cfg!(debug_assertions))
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(45))
            .user_agent(concat!("KnowHow-Capture/", env!("CARGO_PKG_VERSION")))
            .build()
            .context("build private desktop HTTP client")?;
        let credentials = store.credentials()?;
        Ok(Self {
            origin,
            http,
            store,
            device,
            credentials: Arc::new(Mutex::new(credentials)),
        })
    }

    pub fn public_origin(&self) -> &str {
        self.origin.as_str().trim_end_matches('/')
    }

    pub async fn has_credentials(&self) -> bool {
        self.credentials.lock().await.is_some()
    }

    pub async fn begin_authorization(&self, verifier: String) -> Result<PendingAuthorization> {
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let response = self
            .http
            .post(self.endpoint("api/desktop/v1/authorizations")?)
            .header("idempotency-key", Uuid::new_v4().to_string())
            .json(&json!({
                "deviceId": self.device.device_id,
                "deviceName": self.device.device_name,
                "architecture": self.device.architecture,
                "desktopVersion": env!("CARGO_PKG_VERSION"),
                "codeChallenge": challenge,
                "codeChallengeMethod": "S256",
            }))
            .send()
            .await
            .context("request browser device authorization")?;
        let body: AuthorizationResponse = decode(response).await?;
        let pending = PendingAuthorization {
            authorization_id: body.authorization_id,
            verification_uri: body.verification_uri,
            expires_at: body.expires_at,
            interval_seconds: body.interval_seconds.max(2),
            verifier,
        };
        self.store.save_pending_authorization(&pending)?;
        Ok(pending)
    }

    pub async fn poll_authorization(
        &self,
        pending: &PendingAuthorization,
    ) -> Result<AuthorizationPoll> {
        let response = self
            .http
            .post(self.endpoint(&format!(
                "api/desktop/v1/authorizations/{}/token",
                pending.authorization_id
            ))?)
            .json(&json!({
                "codeVerifier": pending.verifier,
                "deviceId": self.device.device_id,
                "architecture": self.device.architecture,
                "desktopVersion": env!("CARGO_PKG_VERSION"),
            }))
            .send()
            .await
            .context("poll browser device authorization")?;
        if response.status() == StatusCode::PRECONDITION_REQUIRED {
            return Ok(AuthorizationPoll::Pending);
        }
        let token: TokenResponse = decode(response).await?;
        let credentials = credentials_from(token);
        self.store.save_credentials(&credentials)?;
        self.store.clear_pending_authorization()?;
        *self.credentials.lock().await = Some(credentials.clone());
        Ok(AuthorizationPoll::Connected(credentials))
    }

    pub async fn refresh_and_context(&self) -> Result<(DeviceCredentials, CaptureContext)> {
        let credentials = self.access_credentials(true).await?;
        let context = self
            .authorized_json(Method::GET, "api/desktop/v1/context", None)
            .await?;
        Ok((credentials, context))
    }

    pub async fn context(&self) -> Result<CaptureContext> {
        self.authorized_json(Method::GET, "api/desktop/v1/context", None)
            .await
    }

    pub async fn start_capture(
        &self,
        session_id: &str,
        title: &str,
        scope: &DesktopScope,
        capture_text: bool,
    ) -> Result<StartCaptureResponse> {
        let body = json!({
            "sessionId": session_id,
            "policyVersion": DESKTOP_POLICY_VERSION,
            "title": title,
            "stepCount": 0,
            "scope": scope,
            "textInputCapture": if capture_text { "exact-non-password" } else { "none" },
        });
        self.authorized_json_with_headers(
            Method::POST,
            "api/desktop/v1/captures",
            Some(body),
            &[("idempotency-key", session_id)],
        )
        .await
    }

    pub async fn set_expected_steps(&self, capture_id: &str, count: usize) -> Result<()> {
        let _: Value = self
            .authorized_json(
                Method::PATCH,
                &format!("api/desktop/v1/captures/{capture_id}"),
                Some(json!({ "expectedSteps": count })),
            )
            .await?;
        Ok(())
    }

    pub async fn transition(&self, capture_id: &str, transition: &str) -> Result<()> {
        let _: Value = self
            .authorized_json(
                Method::POST,
                &format!("api/desktop/v1/captures/{capture_id}/{transition}"),
                Some(json!({})),
            )
            .await?;
        Ok(())
    }

    pub async fn upload_step(
        &self,
        capture_id: &str,
        session_id: &str,
        step: &CapturedStep,
        image: Vec<u8>,
    ) -> Result<()> {
        let token = self.access_token().await?;
        let response = self
            .http
            .put(self.endpoint(&format!(
                "api/desktop/v1/captures/{capture_id}/steps/{}/screenshot",
                step.id
            ))?)
            .bearer_auth(token)
            .header("idempotency-key", format!("{session_id}:{}", step.id))
            .header("content-type", "image/jpeg")
            .header("x-knowhow-source-rasterized", "true")
            .header("x-knowhow-redacted", "true")
            .header("x-knowhow-image-width", step.image_width)
            .header("x-knowhow-image-height", step.image_height)
            .body(image)
            .send()
            .await
            .context("upload encrypted recovery step")?;
        decode::<Value>(response).await?;
        Ok(())
    }

    pub async fn commit(
        &self,
        capture_id: &str,
        payload: &CommitPayload,
    ) -> Result<CommitResponse> {
        self.authorized_json(
            Method::POST,
            &format!("api/desktop/v1/captures/{capture_id}/commit"),
            Some(serde_json::to_value(payload)?),
        )
        .await
    }

    pub async fn discard(&self, capture_id: &str) -> Result<()> {
        let _: Value = self
            .authorized_json(
                Method::DELETE,
                &format!("api/desktop/v1/captures/{capture_id}"),
                None,
            )
            .await?;
        Ok(())
    }

    async fn authorized_json<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<T> {
        self.authorized_json_with_headers(method, path, body, &[])
            .await
    }

    async fn authorized_json_with_headers<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        headers: &[(&str, &str)],
    ) -> Result<T> {
        let token = self.access_token().await?;
        let mut request = self
            .http
            .request(method, self.endpoint(path)?)
            .bearer_auth(token);
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        decode(
            request
                .send()
                .await
                .context("contact KnowHow desktop API")?,
        )
        .await
    }

    async fn access_token(&self) -> Result<String> {
        Ok(self.access_credentials(false).await?.access_token.clone())
    }

    async fn access_credentials(&self, force_refresh: bool) -> Result<DeviceCredentials> {
        // The mutex intentionally spans refresh. Two rotations using the same refresh
        // credential would correctly trigger server-side reuse revocation.
        let mut guard = self.credentials.lock().await;
        let current = guard
            .as_ref()
            .ok_or_else(|| anyhow!("Connect KnowHow Capture before recording."))?;
        let expires_soon = DateTime::parse_from_rfc3339(&current.access_expires_at)
            .map(|expires| {
                expires.with_timezone(&Utc) <= Utc::now() + chrono::Duration::seconds(60)
            })
            .unwrap_or(true);
        if !force_refresh && !expires_soon {
            return Ok(current.clone());
        }
        let response = self
            .http
            .post(self.endpoint("api/desktop/v1/token/refresh")?)
            .json(&json!({
                "refreshToken": current.refresh_token,
                "desktopVersion": env!("CARGO_PKG_VERSION"),
                "architecture": self.device.architecture,
            }))
            .send()
            .await
            .context("refresh desktop authorization")?;
        match decode::<TokenResponse>(response).await {
            Ok(token) => {
                let next = credentials_from(token);
                self.store.save_credentials(&next)?;
                *guard = Some(next.clone());
                Ok(next)
            }
            Err(error) => {
                if error
                    .downcast_ref::<ApiError>()
                    .is_some_and(|api| api.status == StatusCode::UNAUTHORIZED)
                {
                    self.store.clear_credentials()?;
                    *guard = None;
                }
                Err(error)
            }
        }
    }

    fn endpoint(&self, path: &str) -> Result<Url> {
        self.origin
            .join(path)
            .context("construct KnowHow API endpoint")
    }
}

fn credentials_from(token: TokenResponse) -> DeviceCredentials {
    DeviceCredentials {
        access_token: token.access_token,
        access_expires_at: token.expires_at,
        refresh_token: token.refresh_token,
        refresh_expires_at: token.refresh_expires_at,
        workspace_id: token.workspace_id,
        workspace_name: token
            .workspace_name
            .unwrap_or_else(|| "KnowHow workspace".to_owned()),
        minimum_version: token.minimum_version,
    }
}

async fn decode<T: DeserializeOwned>(response: Response) -> Result<T> {
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .context("read KnowHow desktop API response")?;
    if status.is_success() {
        return serde_json::from_slice(&bytes).context("decode KnowHow desktop API response");
    }
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let code = value
        .pointer("/error/code")
        .or_else(|| value.get("code"))
        .and_then(Value::as_str)
        .unwrap_or("DESKTOP_REQUEST_FAILED")
        .to_owned();
    let message = value
        .pointer("/error/message")
        .or_else(|| value.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("KnowHow could not complete this desktop request.")
        .to_owned();
    Err(ApiError {
        status,
        code,
        message,
    }
    .into())
}

fn configured_origin() -> Result<Url> {
    let configured =
        option_env!("KNOWHOW_PUBLIC_APP_ORIGIN").unwrap_or(if cfg!(debug_assertions) {
            "http://localhost:3001"
        } else {
            ""
        });
    if configured.is_empty() {
        bail!("KNOWHOW_PUBLIC_APP_ORIGIN must be compiled into release builds");
    }
    let origin = Url::parse(configured).context("parse compiled KnowHow origin")?;
    let is_local_dev = cfg!(debug_assertions)
        && origin.scheme() == "http"
        && matches!(origin.host_str(), Some("localhost" | "127.0.0.1"));
    if origin.scheme() != "https" && !is_local_dev {
        bail!("the compiled KnowHow origin must use HTTPS");
    }
    if origin.username() != ""
        || origin.password().is_some()
        || origin.path() != "/"
        || origin.query().is_some()
        || origin.fragment().is_some()
    {
        bail!("the compiled KnowHow origin must be an origin without credentials or a path");
    }
    Ok(origin)
}

pub fn validate_external_url(origin: &str, candidate: &str) -> Result<Url> {
    let origin = Url::parse(origin)?;
    let candidate = Url::parse(candidate)?;
    if candidate.scheme() != origin.scheme()
        || candidate.host_str() != origin.host_str()
        || candidate.port_or_known_default() != origin.port_or_known_default()
        || candidate.username() != ""
        || candidate.password().is_some()
    {
        bail!("KnowHow refused to open an untrusted URL");
    }
    Ok(candidate)
}

#[cfg(test)]
mod tests {
    use super::validate_external_url;

    #[test]
    fn browser_handoff_is_same_origin_only() {
        assert!(
            validate_external_url(
                "https://knowhow.example/",
                "https://knowhow.example/w/acme/guides/guide_1/edit"
            )
            .is_ok()
        );
        assert!(
            validate_external_url(
                "https://knowhow.example/",
                "https://knowhow.example.evil.test/steal"
            )
            .is_err()
        );
        assert!(
            validate_external_url("https://knowhow.example/", "http://knowhow.example/w/acme")
                .is_err()
        );
    }
}
