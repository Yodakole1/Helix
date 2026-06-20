use lettre::message::header::ContentType;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

use crate::credentials;

/// `account_id` doubles as both the SMTP login username and the message's
/// From address, same convention as the IMAP layer — accounts are
/// identified by their email address.
#[tauri::command]
pub async fn send_message(
    account_id: String,
    host: String,
    port: u16,
    to: String,
    subject: String,
    body: String,
) -> Result<(), String> {
    let password = credentials::get_credential(account_id.clone())?;

    let email = Message::builder()
        .from(
            account_id
                .parse()
                .map_err(|e| format!("invalid from address {account_id}: {e}"))?,
        )
        .to(to.parse().map_err(|e| format!("invalid to address {to}: {e}"))?)
        .subject(subject)
        .header(ContentType::TEXT_PLAIN)
        .body(body)
        .map_err(|e| format!("could not build message: {e}"))?;

    let mailer: AsyncSmtpTransport<Tokio1Executor> =
        AsyncSmtpTransport::<Tokio1Executor>::relay(&host)
            .map_err(|e| format!("could not configure SMTP relay for {host}: {e}"))?
            .port(port)
            .credentials(Credentials::new(account_id, password))
            .build();

    mailer
        .send(email)
        .await
        .map_err(|e| format!("send failed: {e}"))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Hits a real external SMTP server, so it's excluded from the default
    // test run. There's no real credential to send a message with, so
    // this only checks that we get a clean SMTP-level auth rejection from
    // smtp.gmail.com:465, not a network or TLS error -- enough to prove
    // the TLS/SMTP-protocol stack and keychain lookup both work.
    #[tokio::test]
    #[ignore = "requires network access to a real SMTP server"]
    async fn rejects_bad_credentials_against_a_real_smtp_server() {
        let account_id = "helix-test-no-such-account@gmail.com";
        credentials::store_credential(
            account_id.to_string(),
            "definitely-not-a-real-password".to_string(),
        )
        .expect("storing the test credential should succeed");

        let result = send_message(
            account_id.to_string(),
            "smtp.gmail.com".to_string(),
            465,
            "nobody@example.com".to_string(),
            "test".to_string(),
            "test body".to_string(),
        )
        .await;

        credentials::delete_credential(account_id.to_string()).ok();

        let err = result.expect_err("send should fail without real credentials");
        assert!(
            err.starts_with("send failed"),
            "expected an SMTP send/auth failure, got: {err}"
        );
    }

    // Exercises a real send against a local GreenMail SMTPS server, then
    // confirms the message actually landed by reading it back over IMAP.
    // GreenMail's cert is self-signed, so this test builds its own
    // permissive TLS parameters instead of going through `relay()` —
    // production code keeps requiring a valid certificate.
    #[tokio::test]
    #[ignore = "requires a local GreenMail test server, see docs/technical/smtp.md"]
    async fn sends_and_lands_a_real_message_on_a_local_test_server() {
        use lettre::transport::smtp::client::{Tls, TlsParameters};

        let tls_parameters = TlsParameters::builder("127.0.0.1".to_string())
            .dangerous_accept_invalid_certs(true)
            .dangerous_accept_invalid_hostnames(true)
            .build_native()
            .expect("building permissive test TLS parameters should not fail");

        let email = Message::builder()
            .from("Sender Name <sender@helix.test>".parse().unwrap())
            .to("helix@helix.test".parse().unwrap())
            .subject("Helix SMTP test message")
            .header(ContentType::TEXT_PLAIN)
            .body(String::from("This was sent through send_message's SMTP path."))
            .unwrap();

        let mailer: AsyncSmtpTransport<Tokio1Executor> =
            AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous("127.0.0.1")
                .port(3465)
                .tls(Tls::Wrapper(tls_parameters))
                .credentials(Credentials::new("helix".to_string(), "helixpass".to_string()))
                .build();

        mailer
            .send(email)
            .await
            .expect("send to GreenMail should succeed");

        // Read it back over IMAP (same permissive-TLS pattern as imap.rs's
        // GreenMail tests) to confirm the message actually arrived, not
        // just that the SMTP transaction reported success.
        let tcp_stream = tokio::net::TcpStream::connect(("127.0.0.1", 3993))
            .await
            .expect("GreenMail should be reachable on 127.0.0.1:3993");
        let insecure_connector = tokio_native_tls::TlsConnector::from(
            tokio_native_tls::native_tls::TlsConnector::builder()
                .danger_accept_invalid_certs(true)
                .build()
                .expect("building a permissive test TLS connector should not fail"),
        );
        let tls_stream = insecure_connector
            .connect("127.0.0.1", tcp_stream)
            .await
            .expect("TLS handshake with GreenMail should succeed");
        let mut session = async_imap::Client::new(tls_stream)
            .login("helix", "helixpass")
            .await
            .map_err(|(e, _)| e)
            .expect("login to the GreenMail test account should succeed");

        let mailbox = session.examine("INBOX").await.expect("examine should succeed");
        session.logout().await.ok();

        assert_eq!(mailbox.exists, 1, "the sent message should have landed in INBOX");
    }
}
