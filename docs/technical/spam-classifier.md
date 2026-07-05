# Local Bayesian spam classifier

`src-tauri/src/bayes.rs` — entirely local, no network, no cloud. Model data
lives in the same encrypted SQLCipher cache as everything else.

## Algorithm

Naive Bayes / "bag of words" following Paul Graham's "A Plan for Spam":

1. **Tokenise** the text — lowercase, split on non-alpha characters, keep
   3–30 character alphabetic tokens, deduplicate within a message so a word
   repeated 100 times in a body counts once, not 100 times.

2. **Train** — for each unique token, increment `spam_count` or `ham_count`
   in `bayes_tokens`. Track the total number of training messages in
   `bayes_stats`.

3. **Score** — for each token look up its counts, compute a per-token
   P(spam | token) with Laplace smoothing (+1 / +2 to numerator/denominator
   so no token can claim probability 0 or 1 from a single data point). Take
   the 15 most "interesting" tokens (those furthest from 0.5, giving the
   strongest signal) and combine them using the log-sum trick to avoid
   underflow:
   ```
   combined = 1 / (1 + exp(Σ log(1−p_i) − Σ log(p_i)))
   ```

4. **Classify** — `combined ≥ 0.85` → is_spam. 0.85 is deliberately high
   to minimise false positives (legitimate email in the spam folder is worse
   than missed spam).

5. **Cold-start guard** — below 10 spam + 10 ham training messages the model
   never classifies anything as spam. A freshly installed client shows the
   normal inbox, not a hallucinating classifier.

## Schema

Two new tables added to the encrypted SQLCipher cache in `ensure_schema`:

```sql
CREATE TABLE IF NOT EXISTS bayes_tokens (
    token       TEXT NOT NULL PRIMARY KEY,
    spam_count  INTEGER NOT NULL DEFAULT 0,
    ham_count   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bayes_stats (
    id            INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
    spam_messages INTEGER NOT NULL DEFAULT 0,
    ham_messages  INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO bayes_stats VALUES (1, 0, 0);
```

The `INSERT OR IGNORE` seeds the one stats row on first open and is silently
skipped on every subsequent open (idempotent, same as the rest of the schema).

## Tauri commands

| Command | Description |
|---|---|
| `train_message(text, is_spam)` | Tokenise `text`, increment appropriate counts. Call after the user moves a message to/from the spam folder. Pass subject + from + body concatenated. |
| `retract_message(text, was_spam)` | Decrement the counts trained by a previous `train_message` call. Call when the user corrects a mistake (e.g., un-spams a false positive). Counts are floored at 0. |
| `get_spam_score(text)` | Returns the raw combined probability [0.0–1.0]. Useful for a debug/confidence view in the message detail pane. Returns 0.0 if undertrained. |
| `get_bayes_stats()` | Returns `{spam_messages, ham_messages, distinct_tokens}`. The frontend uses this to show "train me first" placeholder when counts are below the minimum. |

## Integration with fetch_messages

`imap::MessageSummary` gained an `is_spam: bool` field (default `false`).
`fetch_messages` and `fetch_threaded_messages` open the local cache after
the IMAP fetch, run `bayes::score_summary(subject, from)` for each summary,
and set `is_spam` accordingly. This is best-effort: a cache error or
undertrained model leaves `is_spam = false` and never fails the fetch.

Scoring uses only subject and from-address — not the body, since the body
isn't fetched at the summary stage. The model is trained on full body text,
but scored on partial text; this means scoring is less accurate than training
(some spam won't be caught by subject/from alone), which is the right
tradeoff: fewer false positives.

## Frontend integration

The frontend should:

1. Call `get_bayes_stats()` and show a "model needs training" placeholder if
   `spam_messages < 10 || ham_messages < 10`.

2. When the user marks a message as spam (via "Report spam" / `report_spam`):
   also call `train_message(subject + " " + from + " " + body_text, true)`.

3. When the user moves a message out of the spam folder to inbox:
   call `retract_message(…, true)` (undo the spam training) and
   `train_message(…, false)` (add ham training).

4. Read `is_spam` from `MessageSummary` to style the row (e.g., a coloured
   badge) or auto-move it to the spam folder on next fetch.

The backend never automatically moves messages based on `is_spam` — it's
purely an annotation. What action to take (hide, badge, auto-archive) is a
UI decision.

## Why local-only

Every piece of classification logic runs inside the app, against the
encrypted local DB. No message text or token statistics are ever sent
anywhere. The model is per-device (not synced across devices), which means
it needs to be re-trained on a new install, but avoids the privacy tradeoff
of sending even anonymised text to a cloud service.

## Limitations

- **Summary-only scoring.** `fetch_messages` only has subject + from.
  Full-body scoring would require a separate call after opening a message,
  or a background scoring step after `fetch_message_body` populates the cache.

- **No sync.** The trained model doesn't sync across devices. CardDAV /
  IMAP STORE of spam flags serve as a cross-device signal for now.

- **Single-pass training.** Each `train_message` call trains on exactly the
  text provided. There's no bulk re-training from the cache.

## Verification

17 unit tests in `bayes::tests` run in the default `cargo test` pass (no
network or container required):

- **Tokenization** (3 tests): lowercasing, deduplication, length filtering
- **Probability maths** (4 tests): symmetry, spam-only, ham-only, clamping
- **`combine_probs`** (3 tests): all-spam, all-ham, empty input
- **DB round-trips** (3 tests): train, retract, over-retract safety
- **End-to-end scoring** (3 tests): spam above threshold, ham below, cold-start
- **`get_spam_score` command** (1 test): returns 0.0 when undertrained
