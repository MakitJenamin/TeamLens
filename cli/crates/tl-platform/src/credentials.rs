//! Lưu device token. Service `teamlens`, account = `server_url`.

use std::collections::HashMap;
use std::sync::Mutex;

use crate::PlatformError;

/// Tên service trong Windows Credential Manager.
pub const KEYRING_SERVICE: &str = "teamlens";

/// Lưu/đọc/xóa device token theo server. Test dùng [`MemoryCredentialStore`].
pub trait CredentialStore: Send + Sync {
    /// Token của `server_url`, `None` nếu chưa lưu.
    fn get_token(&self, server_url: &str) -> Result<Option<String>, PlatformError>;
    /// Ghi đè token của `server_url`.
    fn set_token(&self, server_url: &str, token: &str) -> Result<(), PlatformError>;
    /// Xóa token; không lỗi nếu chưa có.
    fn delete_token(&self, server_url: &str) -> Result<(), PlatformError>;
}

/// Credential store thật qua crate `keyring` (Windows Credential Manager).
#[derive(Debug, Default, Clone, Copy)]
pub struct KeyringCredentialStore;

impl KeyringCredentialStore {
    fn entry(server_url: &str) -> Result<keyring::Entry, PlatformError> {
        keyring::Entry::new(KEYRING_SERVICE, server_url).map_err(map_keyring_error)
    }
}

fn map_keyring_error(e: keyring::Error) -> PlatformError {
    PlatformError::Credential(e.to_string())
}

impl CredentialStore for KeyringCredentialStore {
    fn get_token(&self, server_url: &str) -> Result<Option<String>, PlatformError> {
        match Self::entry(server_url)?.get_password() {
            Ok(token) => Ok(Some(token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(map_keyring_error(e)),
        }
    }

    fn set_token(&self, server_url: &str, token: &str) -> Result<(), PlatformError> {
        Self::entry(server_url)?
            .set_password(token)
            .map_err(map_keyring_error)
    }

    fn delete_token(&self, server_url: &str) -> Result<(), PlatformError> {
        match Self::entry(server_url)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(map_keyring_error(e)),
        }
    }
}

/// Credential store trong bộ nhớ, dùng cho test (không đụng Credential Manager thật).
#[derive(Debug, Default)]
pub struct MemoryCredentialStore {
    tokens: Mutex<HashMap<String, String>>,
}

impl MemoryCredentialStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl CredentialStore for MemoryCredentialStore {
    fn get_token(&self, server_url: &str) -> Result<Option<String>, PlatformError> {
        Ok(self.tokens.lock().unwrap().get(server_url).cloned())
    }

    fn set_token(&self, server_url: &str, token: &str) -> Result<(), PlatformError> {
        self.tokens
            .lock()
            .unwrap()
            .insert(server_url.to_owned(), token.to_owned());
        Ok(())
    }

    fn delete_token(&self, server_url: &str) -> Result<(), PlatformError> {
        self.tokens.lock().unwrap().remove(server_url);
        Ok(())
    }
}

/// Dùng trên hệ điều hành chưa hỗ trợ.
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct UnsupportedCredentialStore;

impl CredentialStore for UnsupportedCredentialStore {
    fn get_token(&self, _server_url: &str) -> Result<Option<String>, PlatformError> {
        Err(unsupported())
    }
    fn set_token(&self, _server_url: &str, _token: &str) -> Result<(), PlatformError> {
        Err(unsupported())
    }
    fn delete_token(&self, _server_url: &str) -> Result<(), PlatformError> {
        Err(unsupported())
    }
}

fn unsupported() -> PlatformError {
    PlatformError::Unsupported {
        feature: "Credential store",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_roundtrip() {
        let s = MemoryCredentialStore::new();
        assert_eq!(s.get_token("http://a").unwrap(), None);
        s.set_token("http://a", "tld_1").unwrap();
        s.set_token("http://b", "tld_2").unwrap();
        assert_eq!(s.get_token("http://a").unwrap().as_deref(), Some("tld_1"));
        s.delete_token("http://a").unwrap();
        s.delete_token("http://a").unwrap();
        assert_eq!(s.get_token("http://a").unwrap(), None);
        assert_eq!(s.get_token("http://b").unwrap().as_deref(), Some("tld_2"));
    }
}
