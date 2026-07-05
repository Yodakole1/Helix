use lettre::message::header::{ContentType, InReplyTo, References};
use lettre::message::{Attachment, Mailbox, Mailboxes, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::{Credentials, Mechanism};
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use crate::cache;
use crate::credentials;
use crate::imap;
use crate::oauth;
use crate::pgp;
use crate::smime;

/// Resolves what to hand lettre for this account: for an OAuth account a
/// fresh access token with the XOAUTH2 mechanism pinned (offering PLAIN
/// alongside would let the server pick a mechanism the token can't
/// satisfy), for a password account the password with lettre's default
/// PLAIN/LOGIN negotiation.
async fn transport_credentials(account_id: &str) -> Result<(Credentials, Vec<Mechanism>), String> {
    let mut secret = credentials::get_credential(account_id.to_string())?;
    let result = match oauth::access_token_for_secret(account_id, &secret).await {
        Ok(Some(access_token)) => Ok((
            Credentials::new(account_id.to_string(), access_token),
            vec![Mechanism::Xoauth2],
        )),
        Ok(None) => Ok((
            Credentials::new(account_id.to_string(), secret.clone()),
            vec![Mechanism::Plain, Mechanism::Login],
        )),
        Err(e) => Err(e),
    };
    secret.zeroize();
    result
}

/// One outgoing attachment. `content_id`, when set, marks this as an inline
/// resource referenced from the HTML body via `<img src="cid:<content_id>">`.
#[derive(Debug, Serialize, Deserialize)]
pub struct OutgoingAttachment {
    pub filename: String,
    pub content_type: String,
    pub content_base64: String,
    #[serde(default)]
    pub content_id: Option<String>,
}

// Empty string yields an empty list so Cc/Bcc can be passed unconditionally without special-casing.
fn parse_address_list(raw: &str) -> Result<Vec<Mailbox>, String> {
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    let mailboxes: Mailboxes = raw
        .parse()
        .map_err(|e| format!("invalid address list {raw:?}: {e}"))?;
    Ok(mailboxes.into_iter().collect())
}

fn attachment_part(attachment: &OutgoingAttachment) -> Result<SinglePart, String> {
    use base64::Engine;

    let content_type = ContentType::parse(&attachment.content_type)
        .map_err(|e| format!("invalid content type {} for {}: {e}", attachment.content_type, attachment.filename))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&attachment.content_base64)
        .map_err(|e| format!("invalid base64 content for attachment {}: {e}", attachment.filename))?;

    if let Some(cid) = &attachment.content_id {
        // Strip surrounding <> if the caller supplied them.
        let bare = cid.trim_matches(|c| c == '<' || c == '>');
        Ok(Attachment::new_inline(format!("<{bare}>")).body(bytes, content_type))
    } else {
        Ok(Attachment::new(attachment.filename.clone()).body(bytes, content_type))
    }
}

// plain text is always included alongside html — some spam filters distrust html-only mail.
// When the html body references inline images via cid:, those parts are wrapped in
// multipart/related alongside the alternative block; regular attachments go in the outer
// multipart/mixed, which is what Thunderbird, Apple Mail, and Gmail all expect.
fn build_multipart_body(text: String, html: Option<String>, attachments: &[OutgoingAttachment]) -> Result<MultiPart, String> {
    let (inline_atts, regular_atts): (Vec<_>, Vec<_>) =
        attachments.iter().partition(|a| a.content_id.is_some());

    let content_part = match html {
        Some(html) if !inline_atts.is_empty() => {
            // multipart/related: html + all inline images
            let mut related = MultiPart::related()
                .singlepart(SinglePart::html(html));
            for att in &inline_atts {
                related = related.singlepart(attachment_part(att)?);
            }
            // wrap in alternative so plain-text fallback is available
            MultiPart::alternative()
                .singlepart(SinglePart::plain(text))
                .multipart(related)
        }
        Some(html) => MultiPart::alternative_plain_html(text, html),
        None => {
            // no HTML — regular_atts already contains everything
            let mut mixed = MultiPart::mixed().singlepart(SinglePart::plain(text));
            for att in attachments {
                mixed = mixed.singlepart(attachment_part(att)?);
            }
            return Ok(mixed);
        }
    };

    let mut mixed = MultiPart::mixed().multipart(content_part);
    for att in &regular_atts {
        mixed = mixed.singlepart(attachment_part(att)?);
    }
    Ok(mixed)
}

fn cache_contact(email: &str, name: Option<&str>) {
    let result = cache::open()
        .and_then(|conn| cache::upsert_contacts(&conn, &[(email.to_string(), name.map(|n| n.to_string()))]));
    if let Err(e) = result {
        log::warn!("could not update local contact cache: {e}");
    }
}

/// Best-effort IMAP APPEND of a just-sent message to the account's Sent
/// folder. Skipped for POP3 accounts (no IMAP server) and any account not
/// found in the local cache. Errors are logged and never returned to the
/// caller so a Sent-folder failure never blocks the user from sending.
async fn append_to_sent(account_id: &str, raw_bytes: &[u8]) {
    let account = match cache::open()
        .and_then(|conn| cache::get_account(&conn, account_id))
    {
        Ok(Some(a)) => a,
        _ => return,
    };
    if account.imap_host.is_empty() {
        return; // POP3 account — no IMAP server to APPEND to
    }
    let result: Result<(), String> = async {
        let mut session = imap::login_for_account(
            &account.imap_host,
            account.imap_port,
            account_id,
        )
        .await?;
        let append_result = session
            .append(&account.sent_folder, Some("(\\Seen)"), None, raw_bytes)
            .await
            .map_err(|e| format!("APPEND to {} failed: {e}", account.sent_folder));

        // The configured folder name may simply not exist on this server
        // ("Sent" vs cPanel/Dovecot's "INBOX.Sent") -- resolve the real one
        // from LIST, retry, and persist the correction so the next send
        // APPENDs straight to the right place.
        if let Err(first_error) = append_result {
            let folders = imap::list_folder_names(&mut session)
                .await
                .map_err(|_| first_error.clone())?;
            let real_folder = imap::resolve_equivalent_folder(&folders, &account.sent_folder)
                .ok_or(first_error)?;
            session
                .append(&real_folder, Some("(\\Seen)"), None, raw_bytes)
                .await
                .map_err(|e| format!("APPEND to {real_folder} failed: {e}"))?;
            imap::persist_folder_correction(account_id, &account.sent_folder, &real_folder);
        }
        session.logout().await.ok();
        Ok(())
    }
    .await;
    if let Err(e) = result {
        log::warn!("could not save sent message to {}: {e}", account.sent_folder);
    }
}

// PGP encrypt is hard-fail — never silently sends plaintext when the caller asked to encrypt.
// Combining encrypt with html/attachments is also a hard error (PGP here is inline plain text only).
// Same constraint for S/MIME: encrypting only part of a multipart message is worse than not encrypting.
// STARTTLS upgrade is mandatory — starttls_relay() refuses to send credentials if the server won't upgrade.
#[tauri::command]
pub async fn send_message(
    account_id: String,
    host: String,
    port: u16,
    use_starttls: bool,
    to: String,
    cc: String,
    bcc: String,
    subject: String,
    body: String,
    html: Option<String>,
    attachments: Vec<OutgoingAttachment>,
    in_reply_to: Option<String>,
    references: Vec<String>,
    encrypt: bool,
    from_override: Option<String>,
    smime_sign: Option<bool>,
    smime_encrypt: Option<bool>,
) -> Result<(), String> {
    if encrypt && (html.is_some() || !attachments.is_empty()) {
        return Err(
            "PGP encryption only supports a plain-text body -- remove the HTML body and attachments, or disable encryption"
                .to_string(),
        );
    }

    let do_smime_sign = smime_sign.unwrap_or(false);
    let do_smime_encrypt = smime_encrypt.unwrap_or(false);

    if (do_smime_sign || do_smime_encrypt) && (html.is_some() || !attachments.is_empty()) {
        return Err(
            "S/MIME signing and encryption only support a plain-text body -- remove the HTML body and attachments, or disable S/MIME"
                .to_string(),
        );
    }

    let to_list = parse_address_list(&to)?;
    let cc_list = parse_address_list(&cc)?;
    let bcc_list = parse_address_list(&bcc)?;
    if to_list.is_empty() {
        return Err("a message needs at least one To recipient".to_string());
    }

    // PGP encrypts to one key — adding more recipients would silently leave some unable to decrypt.
    if encrypt && (to_list.len() > 1 || !cc_list.is_empty() || !bcc_list.is_empty()) {
        return Err(
            "PGP encryption supports only a single recipient -- remove Cc/Bcc and any extra To addresses, or disable encryption"
                .to_string(),
        );
    }

    // Reject a spoofed From address -- it must be the account itself or a
    // configured identity for it. Checking here (not at call sites) so every
    // code path through send_message enforces the invariant in one place.
    if let Some(addr) = &from_override {
        if addr != &account_id {
            let conn = cache::open().map_err(|e| format!("could not validate from address: {e}"))?;
            let identities = cache::list_identities(&conn, &account_id)?;
            if !identities.iter().any(|i| i.address == *addr) {
                return Err(format!("from address {addr} is not a configured identity for {account_id}"));
            }
        }
    }

    let (creds, auth_mechanisms) = transport_credentials(&account_id).await?;

    let body = if encrypt {
        let to_email = to_list[0].email.to_string();
        pgp::encrypt_and_sign(&account_id, &to_email, &body)?
    } else {
        body
    };

    let from_addr = from_override.as_deref().unwrap_or(&account_id);
    let from = from_addr
        .parse()
        .map_err(|e| format!("invalid from address {from_addr}: {e}"))?;
    let mut email_builder = Message::builder().from(from).subject(subject);
    for mailbox in &to_list {
        email_builder = email_builder.to(mailbox.clone());
    }
    for mailbox in &cc_list {
        email_builder = email_builder.cc(mailbox.clone());
    }
    for mailbox in &bcc_list {
        email_builder = email_builder.bcc(mailbox.clone());
    }

    if let Some(in_reply_to) = &in_reply_to {
        email_builder = email_builder.header(InReplyTo::from(format!("<{in_reply_to}>")));
    }
    if !references.is_empty() {
        let joined = references.iter().map(|id| format!("<{id}>")).collect::<Vec<_>>().join(" ");
        email_builder = email_builder.header(References::from(joined));
    }

    let email = if do_smime_sign || do_smime_encrypt {
        let (ct_str, smime_body) = if do_smime_sign {
            smime::sign_body(&account_id, body.as_bytes())?
        } else {
            let to_email = to_list[0].email.to_string();
            smime::encrypt_body(&to_email, body.as_bytes())?
        };
        let ct = ContentType::parse(&ct_str)
            .map_err(|e| format!("invalid S/MIME content type from openssl: {e}"))?;
        email_builder
            .singlepart(SinglePart::builder().header(ct).body(smime_body))
            .map_err(|e| format!("could not build S/MIME message: {e}"))?
    } else if html.is_none() && attachments.is_empty() {
        email_builder
            .header(ContentType::TEXT_PLAIN)
            .body(body)
            .map_err(|e| format!("could not build message: {e}"))?
    } else {
        email_builder
            .multipart(build_multipart_body(body, html, &attachments)?)
            .map_err(|e| format!("could not build message: {e}"))?
    };

    let builder = if use_starttls {
        AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&host)
    } else {
        AsyncSmtpTransport::<Tokio1Executor>::relay(&host)
    }
    .map_err(|e| format!("could not configure SMTP relay for {host}: {e}"))?;

    let mailer: AsyncSmtpTransport<Tokio1Executor> = builder
        .port(port)
        .credentials(creds)
        .authentication(auth_mechanisms)
        .build();

    // Capture the raw bytes before moving email into the transport. BCC
    // recipients are in the SMTP envelope but RFC 5322 requires they be
    // stripped from the message headers, which lettre does automatically --
    // so these bytes are safe to store as-is.
    let raw_bytes = email.formatted();

    mailer
        .send(email)
        .await
        .map_err(|e| format!("send failed: {e}"))?;

    // Harvest every recipient into the contact cache -- sending to someone is
    // a real correspondence signal regardless of which field they were in.
    for mailbox in to_list.iter().chain(cc_list.iter()).chain(bcc_list.iter()) {
        cache_contact(&mailbox.email.to_string(), mailbox.name.as_deref());
    }

    // Best-effort: save a copy to the account's Sent folder.
    append_to_sent(&account_id, &raw_bytes).await;

    Ok(())
}

/// Sends an RFC 8098 Message Disposition Notification (MDN) — a read receipt.
/// Called by the frontend when the user chooses to send one after seeing a
/// `Disposition-Notification-To` header. The caller must supply:
/// - `account_id` / SMTP connection params (same as `send_message`)
/// - `notify_address`: the address from the `Disposition-Notification-To` header
/// - `original_message_id`: the `Message-ID` of the message being receipted
/// - `original_subject`: used to compose a human-readable subject line
/// - `recipient_display_address`: the account's own address/display name
#[tauri::command]
pub async fn send_mdn(
    account_id: String,
    host: String,
    port: u16,
    use_starttls: bool,
    notify_address: String,
    original_message_id: String,
    original_subject: String,
    recipient_display_address: String,
) -> Result<(), String> {
    let (creds, auth_mechanisms) = transport_credentials(&account_id).await?;

    let from: Mailbox = recipient_display_address
        .parse()
        .map_err(|e| format!("invalid from address {recipient_display_address:?}: {e}"))?;
    let to: Mailbox = notify_address
        .parse()
        .map_err(|e| format!("invalid notify address {notify_address:?}: {e}"))?;

    // RFC 8098 §3.2: the MDN report body is a multipart/report with a human-readable
    // text/plain part and a message/disposition-notification part.
    // We use a simplified form that most MUAs will understand.
    // RFC 8098 §3.2 specifies multipart/report with a machine-readable
    // message/disposition-notification part. We send a human-readable
    // text/plain body instead — sufficient for interoperability with
    // modern MUAs that only surface the human-readable part anyway.
    let original_id_bare = original_message_id.trim_matches(|c| c == '<' || c == '>');
    let mdn_body = format!(
        "This is a read receipt for the message:\r\n\
         Subject: {original_subject}\r\n\
         Message-ID: <{original_id_bare}>\r\n\r\n\
         The message has been displayed.\r\n\
         \r\nReporting-UA: Helix Mail\r\n\
         Final-Recipient: rfc822; {}\r\n\
         Original-Message-ID: <{original_id_bare}>\r\n\
         Disposition: manual-action/MDN-sent-manually; displayed",
        from.email,
    );

    let email = Message::builder()
        .from(from)
        .to(to)
        .subject(format!("Read: {original_subject}"))
        .header(InReplyTo::from(format!("<{original_id_bare}>")))
        .body(mdn_body)
        .map_err(|e| format!("could not build MDN: {e}"))?;

    let mailer = if use_starttls {
        AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&host)
            .map_err(|e| format!("STARTTLS setup failed for {host}: {e}"))?
            .port(port)
            .credentials(creds)
            .authentication(auth_mechanisms)
            .build()
    } else {
        AsyncSmtpTransport::<Tokio1Executor>::relay(&host)
            .map_err(|e| format!("relay setup failed for {host}: {e}"))?
            .port(port)
            .credentials(creds)
            .authentication(auth_mechanisms)
            .build()
    };

    mailer
        .send(email)
        .await
        .map(|_| ())
        .map_err(|e| format!("MDN send failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_address_list_handles_empty_single_and_multiple() {
        assert!(parse_address_list("").expect("empty is ok").is_empty());
        assert!(parse_address_list("   ").expect("whitespace is ok").is_empty());

        let one = parse_address_list("alice@helix.test").expect("single address");
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].email.to_string(), "alice@helix.test");

        let many = parse_address_list("alice@helix.test, Bob <bob@helix.test>").expect("two addresses");
        assert_eq!(many.len(), 2);
        assert_eq!(many[1].email.to_string(), "bob@helix.test");
        assert_eq!(many[1].name.as_deref(), Some("Bob"));
    }

    #[test]
    fn parse_address_list_rejects_a_malformed_address() {
        assert!(parse_address_list("not-an-email").is_err());
    }

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
            false,
            "nobody@example.com".to_string(),
            String::new(),
            String::new(),
            "test".to_string(),
            "test body".to_string(),
            None,
            Vec::new(),
            None,
            Vec::new(),
            false,
            None,
            None,
            None,
        )
        .await;

        credentials::delete_credential(account_id.to_string()).ok();

        let err = result.expect_err("send should fail without real credentials");
        assert!(
            err.starts_with("send failed"),
            "expected an SMTP send/auth failure, got: {err}"
        );
    }

    // Same as above but exercises the STARTTLS path (`use_starttls: true`)
    // against smtp.gmail.com:587 instead of the implicit-TLS path. GreenMail
    // can't stand in for this one -- its bundled SMTP server doesn't
    // implement the STARTTLS extension at all (confirmed by inspecting its
    // class files; only the JavaMail *client* libraries it bundles mention
    // STARTTLS), so a real STARTTLS-capable server is the only way to
    // exercise this branch end to end.
    #[tokio::test]
    #[ignore = "requires network access to a real SMTP server"]
    async fn rejects_bad_credentials_against_a_real_smtp_server_via_starttls() {
        let account_id = "helix-test-no-such-account-starttls@gmail.com";
        credentials::store_credential(
            account_id.to_string(),
            "definitely-not-a-real-password".to_string(),
        )
        .expect("storing the test credential should succeed");

        let result = send_message(
            account_id.to_string(),
            "smtp.gmail.com".to_string(),
            587,
            true,
            "nobody@example.com".to_string(),
            String::new(),
            String::new(),
            "test".to_string(),
            "test body".to_string(),
            None,
            Vec::new(),
            None,
            Vec::new(),
            false,
            None,
            None,
            None,
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

    // Exercises the In-Reply-To/References header construction send_message
    // does internally (replicated here directly, same reason every other
    // GreenMail test in this file bypasses send_message itself: its real
    // certificate validation rejects GreenMail's self-signed cert). Sends
    // an "original" message with an explicit Message-ID, then a "reply"
    // with In-Reply-To/References pointed at it, then reads the reply back
    // over IMAP and confirms imap::MessageBody.in_reply_to/references come
    // back exactly as sent -- proving both the `<...>` header formatting
    // and mail_parser's stripping of it round-trip correctly together.
    #[tokio::test]
    #[ignore = "requires a local GreenMail test server, see docs/technical/smtp.md"]
    async fn sends_a_reply_with_threading_headers_and_lands_it_on_a_local_test_server() {
        use lettre::message::header::MessageId;
        use lettre::transport::smtp::client::{Tls, TlsParameters};

        let tls_parameters = TlsParameters::builder("127.0.0.1".to_string())
            .dangerous_accept_invalid_certs(true)
            .dangerous_accept_invalid_hostnames(true)
            .build_native()
            .expect("building permissive test TLS parameters should not fail");

        let mailer: AsyncSmtpTransport<Tokio1Executor> =
            AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous("127.0.0.1")
                .port(3465)
                .tls(Tls::Wrapper(tls_parameters))
                .credentials(Credentials::new("helix".to_string(), "helixpass".to_string()))
                .build();

        let original_id = "original-message@helix.test".to_string();
        let original = Message::builder()
            .from("Sender Name <sender@helix.test>".parse().unwrap())
            .to("helix@helix.test".parse().unwrap())
            .subject("Helix original test message")
            .header(MessageId::from(format!("<{original_id}>")))
            .header(ContentType::TEXT_PLAIN)
            .body(String::from("This is the original message."))
            .unwrap();
        mailer.send(original).await.expect("sending the original message should succeed");

        // Addressed to helix@helix.test, same as the original above -- both
        // need to land in the one mailbox this test inspects over IMAP,
        // regardless of who a real reply would actually be addressed to.
        let reply = Message::builder()
            .from("Someone Else <someone-else@helix.test>".parse().unwrap())
            .to("helix@helix.test".parse().unwrap())
            .subject("Re: Helix original test message")
            .header(InReplyTo::from(format!("<{original_id}>")))
            .header(References::from(format!("<{original_id}>")))
            .header(ContentType::TEXT_PLAIN)
            .body(String::from("This is the reply."))
            .unwrap();
        mailer.send(reply).await.expect("sending the reply should succeed");

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

        // UID 2: the reply, sent second.
        let (reply_body, _sender_email, _contacts) = crate::imap::fetch_body_by_uid(&mut session, "INBOX", 2)
            .await
            .expect("fetch should succeed");
        session.logout().await.ok();

        assert_eq!(reply_body.in_reply_to.as_deref(), Some(original_id.as_str()));
        assert_eq!(reply_body.references, vec![original_id]);
    }

    // Exercises build_multipart_body (the real function send_message uses
    // for anything beyond plain text) against a real GreenMail send, then
    // reads the message back over IMAP -- using imap::fetch_body_by_uid
    // for the text/html parts and imap::extract_attachment for the
    // attachment's bytes -- to confirm the whole round trip, not just that
    // building the MIME structure didn't panic. Builds its own permissive-
    // TLS mailer rather than calling send_message directly, same reason as
    // the plain-text GreenMail test above: GreenMail's cert is self-signed
    // and send_message enforces real certificate validation.
    #[tokio::test]
    #[ignore = "requires a local GreenMail test server, see docs/technical/smtp.md"]
    async fn sends_an_html_message_with_an_attachment_and_lands_it_on_a_local_test_server() {
        use base64::Engine;
        use lettre::transport::smtp::client::{Tls, TlsParameters};

        let attachment = OutgoingAttachment {
            filename: "notes.txt".to_string(),
            content_type: "text/plain".to_string(),
            content_base64: base64::engine::general_purpose::STANDARD.encode(b"attachment contents"),
            content_id: None,
        };
        let body = build_multipart_body(
            "This is the plain text body.".to_string(),
            Some("<p>This is the <b>HTML</b> body.</p>".to_string()),
            &[attachment],
        )
        .expect("building the multipart body should succeed");

        let tls_parameters = TlsParameters::builder("127.0.0.1".to_string())
            .dangerous_accept_invalid_certs(true)
            .dangerous_accept_invalid_hostnames(true)
            .build_native()
            .expect("building permissive test TLS parameters should not fail");

        let email = Message::builder()
            .from("Sender Name <sender@helix.test>".parse().unwrap())
            .to("helix@helix.test".parse().unwrap())
            .subject("Helix multipart SMTP test message")
            .multipart(body)
            .unwrap();

        let mailer: AsyncSmtpTransport<Tokio1Executor> =
            AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous("127.0.0.1")
                .port(3465)
                .tls(Tls::Wrapper(tls_parameters))
                .credentials(Credentials::new("helix".to_string(), "helixpass".to_string()))
                .build();

        mailer.send(email).await.expect("send to GreenMail should succeed");

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

        let (parsed_body, _sender_email, _contacts) = crate::imap::fetch_body_by_uid(&mut session, "INBOX", 1)
            .await
            .expect("fetch should succeed");

        assert_eq!(parsed_body.text.as_deref(), Some("This is the plain text body."));
        assert!(parsed_body.html.unwrap().contains("<b>HTML</b>"));
        assert_eq!(parsed_body.attachments.len(), 1);
        assert_eq!(parsed_body.attachments[0].filename.as_deref(), Some("notes.txt"));

        let raw_message = crate::imap::fetch_raw_message_by_uid(&mut session, "INBOX", 1)
            .await
            .expect("raw fetch should succeed");
        session.logout().await.ok();

        let downloaded = crate::imap::extract_attachment(&raw_message, 0).expect("attachment should be present");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&downloaded.content_base64)
            .expect("content should be valid base64");
        assert_eq!(decoded, b"attachment contents");
    }

    // The one true end-to-end proof for pgp.rs: encrypt over a real SMTP
    // delivery, decrypt over a real IMAP fetch. Everything else PGP-related
    // is covered by in-process unit tests in pgp.rs; this is just confirming
    // an armored message actually survives a real send/fetch round trip
    // (line-ending normalization, encoding, etc.) unmangled.
    //
    // Sets up a real (if disposable) PGP identity for the GreenMail test
    // account -- self-generated and self-imported as its own contact, same
    // self-test pattern as pgp.rs's own unit tests -- then cleans those rows
    // back out of the real local cache afterward, same precedent as
    // credentials.rs's real-keychain test using a throwaway account_id and
    // deleting it when done.
    #[tokio::test]
    #[ignore = "requires a local GreenMail test server, see docs/technical/smtp.md"]
    async fn sends_an_encrypted_message_and_decrypts_it_on_a_local_test_server() {
        use lettre::transport::smtp::client::{Tls, TlsParameters};

        crate::pgp::generate_keypair("helix@helix.test".to_string(), "Helix Test".to_string())
            .expect("keygen should succeed");
        let public_key = crate::pgp::export_public_key("helix@helix.test".to_string())
            .expect("export should succeed")
            .public_key;
        crate::pgp::import_contact_key("helix@helix.test".to_string(), public_key)
            .expect("import should succeed");

        let plaintext = "This was sent through send_message's encrypted SMTP path.";
        let armored = crate::pgp::encrypt_and_sign("helix@helix.test", "helix@helix.test", plaintext)
            .expect("encrypt should succeed");

        let tls_parameters = TlsParameters::builder("127.0.0.1".to_string())
            .dangerous_accept_invalid_certs(true)
            .dangerous_accept_invalid_hostnames(true)
            .build_native()
            .expect("building permissive test TLS parameters should not fail");

        let email = Message::builder()
            .from("Helix Test <helix@helix.test>".parse().unwrap())
            .to("helix@helix.test".parse().unwrap())
            .subject("Helix encrypted SMTP test message")
            .header(ContentType::TEXT_PLAIN)
            .body(armored)
            .unwrap();

        let mailer: AsyncSmtpTransport<Tokio1Executor> =
            AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous("127.0.0.1")
                .port(3465)
                .tls(Tls::Wrapper(tls_parameters))
                .credentials(Credentials::new("helix".to_string(), "helixpass".to_string()))
                .build();

        mailer.send(email).await.expect("send to GreenMail should succeed");

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

        let (body, sender_email, _contacts) = crate::imap::fetch_body_by_uid(&mut session, "INBOX", 1)
            .await
            .expect("fetch should succeed");
        session.logout().await.ok();

        let body = crate::pgp::maybe_decrypt("helix@helix.test", sender_email.as_deref(), body);

        let conn = cache::open().expect("cache should open");
        conn.execute(
            "DELETE FROM pgp_keys WHERE account_id = ?1",
            rusqlite::params!["helix@helix.test"],
        )
        .ok();
        conn.execute(
            "DELETE FROM pgp_contact_keys WHERE email = ?1",
            rusqlite::params!["helix@helix.test"],
        )
        .ok();

        assert_eq!(body.text.as_deref(), Some(plaintext));
        assert_eq!(body.pgp_signed_by.as_deref(), Some("helix@helix.test"));
        assert_eq!(body.pgp_signature_valid, Some(true));
    }
}
