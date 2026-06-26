use lettre::message::header::{ContentType, InReplyTo, References};
use lettre::message::{Attachment, Mailbox, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use serde::{Deserialize, Serialize};

use crate::cache;
use crate::credentials;
use crate::pgp;

/// One outgoing attachment, as supplied by the caller. Mirrors
/// `imap::AttachmentContent`'s shape (base64 over IPC, for the same
/// reason: a `Vec<u8>` would serialize as a much larger JSON array of
/// numbers) but is its own type rather than a reuse — that one is a
/// *downloaded* attachment's content (always has bytes, filename,
/// content-type all populated from a real parsed message), this one is
/// caller-supplied input with no relationship to a message that's been
/// fetched from anywhere.
#[derive(Debug, Serialize, Deserialize)]
pub struct OutgoingAttachment {
    pub filename: String,
    pub content_type: String,
    pub content_base64: String,
}

fn attachment_part(attachment: &OutgoingAttachment) -> Result<SinglePart, String> {
    use base64::Engine;

    let content_type = ContentType::parse(&attachment.content_type)
        .map_err(|e| format!("invalid content type {} for {}: {e}", attachment.content_type, attachment.filename))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&attachment.content_base64)
        .map_err(|e| format!("invalid base64 content for attachment {}: {e}", attachment.filename))?;

    Ok(Attachment::new(attachment.filename.clone()).body(bytes, content_type))
}

/// Builds the multipart body for a message that has an HTML alternative
/// and/or attachments — `send_message` only takes this path when there's
/// something beyond plain text to send; a plain-text-only message stays a
/// single `TEXT_PLAIN` body, unchanged from before this existed.
///
/// `text` is always included alongside `html`, not replaced by it: a
/// plain-text fallback part is standard practice for HTML mail (some
/// clients/spam filters treat HTML-only mail with suspicion), and the
/// receiving side of this codebase already expects both to coexist
/// (`imap::MessageBody` has separate `text`/`html` fields).
fn build_multipart_body(text: String, html: Option<String>, attachments: &[OutgoingAttachment]) -> Result<MultiPart, String> {
    let mut body = match html {
        Some(html) => MultiPart::mixed().multipart(MultiPart::alternative_plain_html(text, html)),
        None => MultiPart::mixed().singlepart(SinglePart::plain(text)),
    };

    for attachment in attachments {
        body = body.singlepart(attachment_part(attachment)?);
    }

    Ok(body)
}

/// Best-effort, log-and-continue caching of one address into the local
/// contact cache -- same posture as the IMAP layer's `cache_summaries`/
/// `cache_body`.
fn cache_contact(email: &str, name: Option<&str>) {
    let result = cache::open()
        .and_then(|conn| cache::upsert_contacts(&conn, &[(email.to_string(), name.map(|n| n.to_string()))]));
    if let Err(e) = result {
        log::warn!("could not update local contact cache: {e}");
    }
}

/// `account_id` doubles as both the SMTP login username and the message's
/// From address, same convention as the IMAP layer — accounts are
/// identified by their email address.
///
/// `use_starttls` picks which of lettre's two TLS strategies to use:
/// `false` for implicit TLS (`relay()`, the SMTPS/port-465 style, TLS from
/// the first byte) or `true` for STARTTLS (`starttls_relay()`, connects
/// in plaintext and then upgrades, the port-587 style). This is an
/// explicit caller-supplied flag rather than something inferred from
/// `port` — some providers run implicit TLS on nonstandard ports, and
/// guessing wrong would silently attempt the wrong handshake instead of
/// failing clearly. Either way the upgrade/connection is required, not
/// opportunistic: `starttls_relay()` refuses to send anything, including
/// credentials, if the server won't upgrade.
///
/// `encrypt` mirrors Compose's "Encrypt" toggle (currently inert UI
/// state, see `docs/technical/encryption.md`). Unlike the cache/contact
/// writes elsewhere in this codebase, PGP encryption here is **not**
/// best-effort: if the caller asked for encryption and it fails (no
/// recipient key on file, etc.), the send itself fails rather than
/// silently mailing plaintext the user explicitly asked to encrypt. The
/// same hard-fail posture applies to combining `encrypt` with `html`/
/// `attachments` — PGP support in this codebase is inline-armored
/// plain-text only (see `pgp.md`), so encrypting a message that also
/// carries an HTML body or attachments would mean either silently
/// encrypting only part of what the user asked to encrypt, or silently
/// sending the rest in the clear. Neither is acceptable, so it's a clean
/// upfront error instead.
///
/// `html` is optional; `body` (the plain-text version) is always
/// required and always sent, even alongside `html` — see
/// `build_multipart_body`. `attachments` defaults to an empty list for a
/// plain message; supplying either makes this build a real multipart MIME
/// message instead of the single `TEXT_PLAIN` body this command used to
/// always send.
///
/// `in_reply_to`/`references` are how a reply actually threads in a real
/// mail client (Gmail/Outlook/Apple Mail group by these headers, not just
/// matching subjects) — building them is the caller's job, using the
/// message being replied to: `in_reply_to` is that message's own
/// `message_id` (see `imap::MessageBody`), and `references` is that
/// message's own `references` with its `message_id` appended (RFC 5322
/// section 3.6.4). Neither is validated against the other here — this
/// command just sets whatever it's given, since it has no way to know
/// what message either ID is supposed to refer to.
#[tauri::command]
pub async fn send_message(
    account_id: String,
    host: String,
    port: u16,
    use_starttls: bool,
    to: String,
    subject: String,
    body: String,
    html: Option<String>,
    attachments: Vec<OutgoingAttachment>,
    in_reply_to: Option<String>,
    references: Vec<String>,
    encrypt: bool,
) -> Result<(), String> {
    if encrypt && (html.is_some() || !attachments.is_empty()) {
        return Err(
            "PGP encryption only supports a plain-text body -- remove the HTML body and attachments, or disable encryption"
                .to_string(),
        );
    }

    let password = credentials::get_credential(account_id.clone())?;

    let to_mailbox: Mailbox = to.parse().map_err(|e| format!("invalid to address {to}: {e}"))?;
    let to_email = to_mailbox.email.to_string();
    let to_name = to_mailbox.name.clone();

    let body = if encrypt {
        pgp::encrypt_and_sign(&account_id, &to_email, &body)?
    } else {
        body
    };

    let from = account_id
        .parse()
        .map_err(|e| format!("invalid from address {account_id}: {e}"))?;
    let mut email_builder = Message::builder().from(from).to(to_mailbox).subject(subject);

    if let Some(in_reply_to) = &in_reply_to {
        email_builder = email_builder.header(InReplyTo::from(format!("<{in_reply_to}>")));
    }
    if !references.is_empty() {
        let joined = references.iter().map(|id| format!("<{id}>")).collect::<Vec<_>>().join(" ");
        email_builder = email_builder.header(References::from(joined));
    }

    let email = if html.is_none() && attachments.is_empty() {
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
        .credentials(Credentials::new(account_id, password))
        .build();

    mailer
        .send(email)
        .await
        .map_err(|e| format!("send failed: {e}"))?;

    cache_contact(&to_email, to_name.as_deref());

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
            false,
            "nobody@example.com".to_string(),
            "test".to_string(),
            "test body".to_string(),
            None,
            Vec::new(),
            None,
            Vec::new(),
            false,
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
            "test".to_string(),
            "test body".to_string(),
            None,
            Vec::new(),
            None,
            Vec::new(),
            false,
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
