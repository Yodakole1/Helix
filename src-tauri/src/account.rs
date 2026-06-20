use serde::Serialize;

use crate::credentials;
use crate::imap;

#[derive(Debug, Serialize)]
pub struct AddAccountResult {
    pub account_id: String,
    pub folders: Vec<String>,
}

/// Stores the account's password in the OS keychain, then verifies it by
/// actually connecting and logging in. If the connection check fails, the
/// just-stored credential is removed again — onboarding shouldn't leave a
/// broken, unverified account sitting in the keychain.
#[tauri::command]
pub async fn add_account(
    account_id: String,
    password: String,
    host: String,
    port: u16,
) -> Result<AddAccountResult, String> {
    credentials::store_credential(account_id.clone(), password)?;

    match imap::list_folders(account_id.clone(), host, port).await {
        Ok(folders) => Ok(AddAccountResult { account_id, folders }),
        Err(e) => {
            credentials::delete_credential(account_id).ok();
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore = "requires network access to a real IMAP server"]
    async fn rolls_back_the_stored_credential_when_verification_fails() {
        let account_id = "helix-test-add-account@gmail.com";

        let result = add_account(
            account_id.to_string(),
            "definitely-not-a-real-password".to_string(),
            "imap.gmail.com".to_string(),
            993,
        )
        .await;

        let err = result.expect_err("login should fail without real credentials");
        assert!(
            err.starts_with("login failed"),
            "expected an IMAP login failure, got: {err}"
        );

        let leftover = credentials::get_credential(account_id.to_string());
        assert!(
            leftover.is_err(),
            "the credential should have been rolled back after the failed verification"
        );
    }
}
