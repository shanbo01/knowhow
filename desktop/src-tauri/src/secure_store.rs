use std::{
    fs,
    path::Path,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use aes_gcm::{
    Aes256Gcm, KeyInit,
    aead::{Aead, Payload},
};
use anyhow::{Context, Result, anyhow, bail};
use parking_lot::Mutex;
use rand::RngCore;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Serialize, de::DeserializeOwned};
use zeroize::{Zeroize, Zeroizing};

use crate::model::{
    ActiveCapture, CapturedStep, DeviceCredentials, DeviceIdentity, PendingAuthorization,
    RecorderSettings,
};

const DATABASE_VERSION: i64 = 1;
const SESSION_TTL_SECONDS: i64 = 24 * 60 * 60;

#[derive(Clone)]
pub struct SecureStore {
    connection: Arc<Mutex<Connection>>,
}

pub struct RecoveredSession {
    pub active: ActiveCapture,
    pub steps: Vec<(CapturedStep, Vec<u8>)>,
}

type EncryptedSessionRow = (String, Vec<u8>, Vec<u8>, Vec<u8>);

impl SecureStore {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).context("create capture data directory")?;
        }
        let connection = Connection::open(path).context("open encrypted capture database")?;
        connection.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA journal_mode = WAL;
             PRAGMA synchronous = FULL;
             PRAGMA secure_delete = ON;
             CREATE TABLE IF NOT EXISTS schema_meta (
               version INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS protected_state (
               name TEXT PRIMARY KEY,
               value BLOB NOT NULL,
               updated_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS preferences (
               name TEXT PRIMARY KEY,
               value TEXT NOT NULL,
               updated_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS sessions (
               id TEXT PRIMARY KEY,
               capture_id TEXT NOT NULL,
               wrapped_key BLOB NOT NULL,
               metadata_nonce BLOB NOT NULL,
               metadata_ciphertext BLOB NOT NULL,
               state TEXT NOT NULL,
               created_at INTEGER NOT NULL,
               expires_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS steps (
               session_id TEXT NOT NULL,
               step_id TEXT NOT NULL,
               sequence INTEGER NOT NULL,
               metadata_nonce BLOB NOT NULL,
               metadata_ciphertext BLOB NOT NULL,
               image_nonce BLOB NOT NULL,
               image_ciphertext BLOB NOT NULL,
               state TEXT NOT NULL,
               PRIMARY KEY (session_id, step_id),
               UNIQUE (session_id, sequence),
               FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
             );
             CREATE INDEX IF NOT EXISTS steps_by_session_sequence
               ON steps(session_id, sequence);",
        )?;
        let version: Option<i64> = connection
            .query_row("SELECT version FROM schema_meta LIMIT 1", [], |row| {
                row.get(0)
            })
            .optional()?;
        match version {
            None => {
                connection.execute(
                    "INSERT INTO schema_meta(version) VALUES (?1)",
                    [DATABASE_VERSION],
                )?;
            }
            Some(DATABASE_VERSION) => {}
            Some(_) => bail!("capture database version is unsupported"),
        }
        let store = Self {
            connection: Arc::new(Mutex::new(connection)),
        };
        store.cleanup_expired()?;
        Ok(store)
    }

    pub fn save_credentials(&self, credentials: &DeviceCredentials) -> Result<()> {
        self.save_protected("device-credentials", credentials)
    }

    pub fn credentials(&self) -> Result<Option<DeviceCredentials>> {
        self.load_protected("device-credentials")
    }

    pub fn clear_credentials(&self) -> Result<()> {
        self.delete_protected("device-credentials")
    }

    pub fn save_pending_authorization(&self, pending: &PendingAuthorization) -> Result<()> {
        self.save_protected("pending-authorization", pending)
    }

    pub fn pending_authorization(&self) -> Result<Option<PendingAuthorization>> {
        self.load_protected("pending-authorization")
    }

    pub fn clear_pending_authorization(&self) -> Result<()> {
        self.delete_protected("pending-authorization")
    }

    pub fn save_device_identity(&self, identity: &DeviceIdentity) -> Result<()> {
        self.save_protected("device-identity", identity)
    }

    pub fn device_identity(&self) -> Result<Option<DeviceIdentity>> {
        self.load_protected("device-identity")
    }

    fn save_protected<T: Serialize>(&self, name: &str, value: &T) -> Result<()> {
        let mut plaintext = Zeroizing::new(serde_json::to_vec(value)?);
        let protected = platform_protect(plaintext.as_slice())?;
        plaintext.zeroize();
        self.connection.lock().execute(
            "INSERT INTO protected_state(name, value, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![name, protected, now_epoch()?],
        )?;
        Ok(())
    }

    fn load_protected<T: DeserializeOwned>(&self, name: &str) -> Result<Option<T>> {
        let protected: Option<Vec<u8>> = self
            .connection
            .lock()
            .query_row(
                "SELECT value FROM protected_state WHERE name = ?1",
                [name],
                |row| row.get(0),
            )
            .optional()?;
        let Some(protected) = protected else {
            return Ok(None);
        };
        let plaintext = Zeroizing::new(platform_unprotect(&protected)?);
        Ok(Some(serde_json::from_slice(plaintext.as_slice())?))
    }

    fn delete_protected(&self, name: &str) -> Result<()> {
        self.connection
            .lock()
            .execute("DELETE FROM protected_state WHERE name = ?1", [name])?;
        Ok(())
    }

    pub fn settings(&self) -> Result<RecorderSettings> {
        let value: Option<String> = self
            .connection
            .lock()
            .query_row(
                "SELECT value FROM preferences WHERE name = 'recorder-settings'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        value
            .map(|raw| serde_json::from_str(&raw).context("decode recorder settings"))
            .transpose()
            .map(|settings| settings.unwrap_or_default())
    }

    pub fn save_settings(&self, settings: &RecorderSettings) -> Result<()> {
        self.connection.lock().execute(
            "INSERT INTO preferences(name, value, updated_at)
             VALUES ('recorder-settings', ?1, ?2)
             ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![serde_json::to_string(settings)?, now_epoch()?],
        )?;
        Ok(())
    }

    pub fn create_session(&self, active: &ActiveCapture) -> Result<()> {
        let mut key = Zeroizing::new([0_u8; 32]);
        rand::rng().fill_bytes(key.as_mut());
        let wrapped_key = platform_protect(key.as_slice())?;
        let (metadata_nonce, metadata_ciphertext) = encrypt_json(
            key.as_slice(),
            active,
            format!("session:{}:metadata", active.session_id).as_bytes(),
        )?;
        let now = now_epoch()?;
        self.connection.lock().execute(
            "INSERT INTO sessions(
               id, capture_id, wrapped_key, metadata_nonce, metadata_ciphertext,
               state, created_at, expires_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, 'recording', ?6, ?7)",
            params![
                active.session_id,
                active.capture_id,
                wrapped_key,
                metadata_nonce,
                metadata_ciphertext,
                now,
                now + SESSION_TTL_SECONDS,
            ],
        )?;
        Ok(())
    }

    pub fn set_session_state(&self, session_id: &str, state: &str) -> Result<()> {
        self.connection.lock().execute(
            "UPDATE sessions SET state = ?2 WHERE id = ?1",
            params![session_id, state],
        )?;
        Ok(())
    }

    pub fn save_step(&self, session_id: &str, step: &CapturedStep, image: &[u8]) -> Result<()> {
        let key = self.session_key(session_id)?;
        let (metadata_nonce, metadata_ciphertext) = encrypt_json(
            key.as_slice(),
            step,
            format!("session:{session_id}:step:{}:metadata", step.id).as_bytes(),
        )?;
        let (image_nonce, image_ciphertext) = encrypt(
            key.as_slice(),
            image,
            format!("session:{session_id}:step:{}:image", step.id).as_bytes(),
        )?;
        self.connection.lock().execute(
            "INSERT INTO steps(
               session_id, step_id, sequence, metadata_nonce, metadata_ciphertext,
               image_nonce, image_ciphertext, state
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'ready')",
            params![
                session_id,
                step.id,
                i64::try_from(step.order)?,
                metadata_nonce,
                metadata_ciphertext,
                image_nonce,
                image_ciphertext,
            ],
        )?;
        Ok(())
    }

    pub fn mark_step(&self, session_id: &str, step_id: &str, state: &str) -> Result<()> {
        self.connection.lock().execute(
            "UPDATE steps SET state = ?3 WHERE session_id = ?1 AND step_id = ?2",
            params![session_id, step_id, state],
        )?;
        Ok(())
    }

    pub fn delete_step(&self, session_id: &str, step_id: &str) -> Result<()> {
        self.connection.lock().execute(
            "DELETE FROM steps WHERE session_id = ?1 AND step_id = ?2",
            params![session_id, step_id],
        )?;
        Ok(())
    }

    /// Decrypts one step's stored screenshot without touching the rest of the
    /// session. `load_steps` decrypts every step's metadata and image for a
    /// whole capture — too much work to pay for a single on-demand thumbnail,
    /// which the HUD may ask for on every step as the author records.
    pub fn load_step_image(&self, session_id: &str, step_id: &str) -> Result<Vec<u8>> {
        let key = self.session_key(session_id)?;
        let (image_nonce, image_ciphertext): (Vec<u8>, Vec<u8>) = self
            .connection
            .lock()
            .query_row(
                "SELECT image_nonce, image_ciphertext FROM steps
                 WHERE session_id = ?1 AND step_id = ?2",
                params![session_id, step_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| anyhow!("capture step is unavailable"))?;
        decrypt(
            key.as_slice(),
            &image_nonce,
            &image_ciphertext,
            format!("session:{session_id}:step:{step_id}:image").as_bytes(),
        )
    }

    pub fn load_steps(&self, session_id: &str) -> Result<Vec<(CapturedStep, Vec<u8>, String)>> {
        let key = self.session_key(session_id)?;
        let connection = self.connection.lock();
        let mut statement = connection.prepare(
            "SELECT step_id, metadata_nonce, metadata_ciphertext, image_nonce, image_ciphertext, state
             FROM steps WHERE session_id = ?1 ORDER BY sequence ASC",
        )?;
        let rows = statement.query_map([session_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Vec<u8>>(1)?,
                row.get::<_, Vec<u8>>(2)?,
                row.get::<_, Vec<u8>>(3)?,
                row.get::<_, Vec<u8>>(4)?,
                row.get::<_, String>(5)?,
            ))
        })?;
        let encrypted = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        drop(connection);
        encrypted
            .into_iter()
            .map(
                |(step_id, metadata_nonce, metadata, image_nonce, image, state)| {
                    let step = decrypt_json(
                        key.as_slice(),
                        &metadata_nonce,
                        &metadata,
                        format!("session:{session_id}:step:{step_id}:metadata").as_bytes(),
                    )?;
                    let image = decrypt(
                        key.as_slice(),
                        &image_nonce,
                        &image,
                        format!("session:{session_id}:step:{step_id}:image").as_bytes(),
                    )?;
                    Ok((step, image, state))
                },
            )
            .collect()
    }

    pub fn recover_latest(&self) -> Result<Option<RecoveredSession>> {
        self.cleanup_expired()?;
        let row: Option<EncryptedSessionRow> = self
            .connection
            .lock()
            .query_row(
                "SELECT id, wrapped_key, metadata_nonce, metadata_ciphertext
                 FROM sessions WHERE state != 'finished' AND state != 'discarded'
                 ORDER BY created_at DESC LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        let Some((session_id, wrapped_key, nonce, ciphertext)) = row else {
            return Ok(None);
        };
        let key = Zeroizing::new(platform_unprotect(&wrapped_key)?);
        let active: ActiveCapture = decrypt_json(
            key.as_slice(),
            &nonce,
            &ciphertext,
            format!("session:{session_id}:metadata").as_bytes(),
        )?;
        let steps = self
            .load_steps(&session_id)?
            .into_iter()
            .map(|(step, image, _)| (step, image))
            .collect();
        Ok(Some(RecoveredSession { active, steps }))
    }

    pub fn cryptographic_erase_session(&self, session_id: &str) -> Result<()> {
        let connection = self.connection.lock();
        connection.execute("DELETE FROM sessions WHERE id = ?1", [session_id])?;
        connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
        Ok(())
    }

    pub fn cleanup_expired(&self) -> Result<usize> {
        let connection = self.connection.lock();
        let deleted = connection.execute(
            "DELETE FROM sessions WHERE expires_at <= ?1",
            [now_epoch()?],
        )?;
        if deleted > 0 {
            connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
        }
        Ok(deleted)
    }

    fn session_key(&self, session_id: &str) -> Result<Zeroizing<Vec<u8>>> {
        let wrapped: Option<Vec<u8>> = self
            .connection
            .lock()
            .query_row(
                "SELECT wrapped_key FROM sessions WHERE id = ?1 AND expires_at > ?2",
                params![session_id, now_epoch()?],
                |row| row.get(0),
            )
            .optional()?;
        let wrapped = wrapped.ok_or_else(|| anyhow!("recoverable capture key is unavailable"))?;
        let key = Zeroizing::new(platform_unprotect(&wrapped)?);
        if key.len() != 32 {
            bail!("recoverable capture key is invalid");
        }
        Ok(key)
    }
}

fn now_epoch() -> Result<i64> {
    i64::try_from(SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs())
        .context("system time is outside the supported range")
}

fn encrypt_json<T: Serialize>(key: &[u8], value: &T, aad: &[u8]) -> Result<(Vec<u8>, Vec<u8>)> {
    let plaintext = Zeroizing::new(serde_json::to_vec(value)?);
    encrypt(key, plaintext.as_slice(), aad)
}

fn encrypt(key: &[u8], plaintext: &[u8], aad: &[u8]) -> Result<(Vec<u8>, Vec<u8>)> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| anyhow!("session key is invalid"))?;
    let mut nonce = [0_u8; 12];
    rand::rng().fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(
            (&nonce).into(),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| anyhow!("capture encryption failed"))?;
    Ok((nonce.to_vec(), ciphertext))
}

fn decrypt_json<T: DeserializeOwned>(
    key: &[u8],
    nonce: &[u8],
    ciphertext: &[u8],
    aad: &[u8],
) -> Result<T> {
    let plaintext = Zeroizing::new(decrypt(key, nonce, ciphertext, aad)?);
    serde_json::from_slice(plaintext.as_slice()).context("decrypt capture metadata")
}

fn decrypt(key: &[u8], nonce: &[u8], ciphertext: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
    if nonce.len() != 12 {
        bail!("capture nonce is invalid");
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| anyhow!("session key is invalid"))?;
    cipher
        .decrypt(
            nonce.into(),
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map_err(|_| anyhow!("capture data failed authentication"))
}

#[cfg(windows)]
fn platform_protect(plaintext: &[u8]) -> Result<Vec<u8>> {
    use windows::{
        Win32::{
            Foundation::{HLOCAL, LocalFree},
            Security::Cryptography::{
                CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData,
            },
        },
        core::PCWSTR,
    };

    let size = u32::try_from(plaintext.len()).context("protected value is too large")?;
    let input = CRYPT_INTEGER_BLOB {
        cbData: size,
        pbData: plaintext.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // SAFETY: input references `plaintext` for the duration of the call. Windows allocates
    // output with LocalAlloc and we copy it before releasing with LocalFree.
    unsafe {
        CryptProtectData(
            &raw const input,
            PCWSTR::null(),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &raw mut output,
        )?;
        let result = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
        Ok(result)
    }
}

#[cfg(windows)]
fn platform_unprotect(protected: &[u8]) -> Result<Vec<u8>> {
    use windows::Win32::{
        Foundation::{HLOCAL, LocalFree},
        Security::Cryptography::{
            CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptUnprotectData,
        },
    };

    let size = u32::try_from(protected.len()).context("protected value is too large")?;
    let input = CRYPT_INTEGER_BLOB {
        cbData: size,
        pbData: protected.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // SAFETY: input references `protected` for the duration of the call. Windows allocates
    // output with LocalAlloc and we copy it before releasing with LocalFree.
    unsafe {
        CryptUnprotectData(
            &raw const input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &raw mut output,
        )?;
        let result = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
        Ok(result)
    }
}

#[cfg(not(windows))]
fn platform_protect(_plaintext: &[u8]) -> Result<Vec<u8>> {
    bail!("KnowHow Capture secure storage requires Windows DPAPI")
}

#[cfg(not(windows))]
fn platform_unprotect(_protected: &[u8]) -> Result<Vec<u8>> {
    bail!("KnowHow Capture secure storage requires Windows DPAPI")
}

#[cfg(test)]
mod tests {
    use super::{decrypt, encrypt};

    #[test]
    fn aes_gcm_authenticates_ciphertext_and_context() -> anyhow::Result<()> {
        let key = [7_u8; 32];
        let (nonce, mut ciphertext) = encrypt(&key, b"private guide text", b"step:1")?;
        assert_eq!(
            decrypt(&key, &nonce, &ciphertext, b"step:1")?,
            b"private guide text"
        );
        ciphertext[0] ^= 0x80;
        assert!(decrypt(&key, &nonce, &ciphertext, b"step:1").is_err());
        assert!(decrypt(&key, &nonce, b"bad", b"step:2").is_err());
        Ok(())
    }
}
