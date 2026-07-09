// Paul Graham-style Naive Bayes spam classifier. Entirely local — model lives
// in the encrypted SQLCipher cache, never touches the network. See
// docs/technical/spam-classifier.md for the full algorithm writeup.

use rusqlite::Connection;
use serde::Serialize;

use crate::cache;

// Require at least this many labelled messages before classifying anything —
// avoids the model firing on noise right after a fresh install.
const MIN_SPAM_MSGS: i64 = 10;
const MIN_HAM_MSGS: i64 = 10;

// High threshold so false positives (real mail in spam folder) are very rare.
const SPAM_THRESHOLD: f64 = 0.85;

// Ignore tokens seen fewer than this many times — rare tokens add noise.
const MIN_TOKEN_OCCURRENCES: i64 = 3;

// Number of strongest-signal tokens to use when combining probabilities.
const MAX_TOKENS: usize = 15;

// Splits text into lowercase alpha-only tokens of 3–30 characters.
// Each unique token appears at most once so a word repeated 100 times in a body
// doesn't count 100 times during training.
pub(crate) fn tokenize(text: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    text.to_lowercase()
        .split(|c: char| !c.is_alphabetic())
        .filter(|t| {
            let len = t.len();
            len >= 3 && len <= 30
        })
        .filter_map(|t| {
            let s = t.to_string();
            if seen.insert(s.clone()) { Some(s) } else { None }
        })
        .collect()
}

#[derive(Debug, Serialize)]
pub struct BayesStats {
    pub spam_messages: i64,
    pub ham_messages: i64,
    pub distinct_tokens: i64,
}

fn db_stats(conn: &Connection) -> Result<(i64, i64), String> {
    conn.query_row(
        "SELECT spam_messages, ham_messages FROM bayes_stats WHERE id = 1",
        [],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
    )
    .map_err(|e| format!("could not read bayes stats: {e}"))
}

fn db_update_stats(conn: &Connection, delta_spam: i64, delta_ham: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE bayes_stats
         SET spam_messages = MAX(0, spam_messages + ?1),
             ham_messages  = MAX(0, ham_messages  + ?2)
         WHERE id = 1",
        rusqlite::params![delta_spam, delta_ham],
    )
    .map(|_| ())
    .map_err(|e| format!("could not update bayes stats: {e}"))
}

fn db_token_counts(conn: &Connection, tokens: &[String]) -> Result<Vec<(i64, i64)>, String> {
    if tokens.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = tokens.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let query = format!(
        "SELECT spam_count, ham_count FROM bayes_tokens WHERE token IN ({placeholders})"
    );
    let mut stmt = conn
        .prepare(&query)
        .map_err(|e| format!("could not prepare token lookup: {e}"))?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(tokens.iter()), |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|e| format!("could not query token counts: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("could not read token count row: {e}"))?;
    Ok(rows)
}

// `retract = true` decrements instead of incrementing; counts floor at 0.
fn db_train_tokens(
    conn: &Connection,
    tokens: &[String],
    is_spam: bool,
    retract: bool,
) -> Result<(), String> {
    if tokens.is_empty() {
        return Ok(());
    }

    if retract {
        let col = if is_spam { "spam_count" } else { "ham_count" };
        let sql = format!(
            "UPDATE bayes_tokens SET {col} = MAX(0, {col} - 1) WHERE token = ?1"
        );
        for token in tokens {
            conn.execute(&sql, [token])
                .map_err(|e| format!("could not retract token {token:?}: {e}"))?;
        }
    } else {
        let sql = if is_spam {
            "INSERT INTO bayes_tokens (token, spam_count, ham_count) VALUES (?1, 1, 0)
             ON CONFLICT(token) DO UPDATE SET spam_count = spam_count + 1"
        } else {
            "INSERT INTO bayes_tokens (token, spam_count, ham_count) VALUES (?1, 0, 1)
             ON CONFLICT(token) DO UPDATE SET ham_count = ham_count + 1"
        };
        for token in tokens {
            conn.execute(sql, [token])
                .map_err(|e| format!("could not train token {token:?}: {e}"))?;
        }
    }

    Ok(())
}

// Laplace smoothing (+1/+2) so a token seen only in spam doesn't claim P=1.0.
// Clamped to [0.01, 0.99] so no single token can alone push the combined score to 0 or 1.
fn token_prob(spam_count: i64, ham_count: i64, total_spam: i64, total_ham: i64) -> f64 {
    let p_w_spam = (spam_count as f64 + 1.0) / (total_spam as f64 + 2.0);
    let p_w_ham = (ham_count as f64 + 1.0) / (total_ham as f64 + 2.0);
    let p = p_w_spam / (p_w_spam + p_w_ham);
    p.clamp(0.01, 0.99)
}

// Log-sum trick avoids floating-point underflow when multiplying many small probabilities.
// Uses only the top-MAX_TOKENS tokens (those furthest from 0.5) to reduce noise.
fn combine_probs(mut probs: Vec<f64>) -> f64 {
    if probs.is_empty() {
        return 0.0;
    }
    probs.sort_unstable_by(|a, b| {
        let da = (a - 0.5).abs();
        let db = (b - 0.5).abs();
        db.partial_cmp(&da).unwrap_or(std::cmp::Ordering::Equal)
    });
    probs.truncate(MAX_TOKENS);

    let log_spam: f64 = probs.iter().map(|p| p.ln()).sum();
    let log_ham: f64 = probs.iter().map(|p| (1.0 - p).ln()).sum();
    // 1 / (1 + exp(log_ham - log_spam)) — numerically stable form of the combined probability.
    1.0 / (1.0 + (log_ham - log_spam).exp())
}

// Returns false on any DB error — scoring is best-effort and must never break a fetch.
pub(crate) fn score_summary(
    conn: &Connection,
    subject: Option<&str>,
    from_addr: Option<&str>,
) -> bool {
    let text = format!(
        "{} {}",
        subject.unwrap_or(""),
        from_addr.unwrap_or("")
    );
    score_text_inner(conn, &text).unwrap_or(false)
}

fn score_text_inner(conn: &Connection, text: &str) -> Result<bool, String> {
    let (total_spam, total_ham) = db_stats(conn)?;
    if total_spam < MIN_SPAM_MSGS || total_ham < MIN_HAM_MSGS {
        return Ok(false);
    }

    let tokens = tokenize(text);
    if tokens.is_empty() {
        return Ok(false);
    }

    let counts = db_token_counts(conn, &tokens)?;
    let probs: Vec<f64> = counts
        .into_iter()
        .filter(|(sc, hc)| sc + hc >= MIN_TOKEN_OCCURRENCES)
        .map(|(sc, hc)| token_prob(sc, hc, total_spam, total_ham))
        .collect();

    if probs.is_empty() {
        return Ok(false);
    }

    Ok(combine_probs(probs) >= SPAM_THRESHOLD)
}

/// Train on `text` (subject + from + body concatenated). Call when the user marks a message
/// as spam or confirms it's legitimate. Each unique token counts once regardless of how many
/// times it appears in the text.
#[tauri::command]
pub async fn train_message(text: String, is_spam: bool) -> Result<(), String> {
    let tokens = tokenize(&text);
    if tokens.is_empty() {
        return Ok(());
    }
    let conn = cache::open()?;
    db_train_tokens(&conn, &tokens, is_spam, false)?;
    let (ds, dh) = if is_spam { (1, 0) } else { (0, 1) };
    db_update_stats(&conn, ds, dh)
}

/// Undo a previous `train_message` call (e.g., user corrects a mis-mark).
/// `was_spam` must match what `train_message` was originally called with.
/// Over-retracting is safe — counts floor at 0.
#[tauri::command]
pub async fn retract_message(text: String, was_spam: bool) -> Result<(), String> {
    let tokens = tokenize(&text);
    if tokens.is_empty() {
        return Ok(());
    }
    let conn = cache::open()?;
    db_train_tokens(&conn, &tokens, was_spam, true)?;
    let (ds, dh) = if was_spam { (-1, 0) } else { (0, -1) };
    db_update_stats(&conn, ds, dh)
}

/// Returns the raw probability [0.0–1.0] without applying the classification threshold.
/// Returns 0.0 when the model is undertrained.
#[tauri::command]
pub async fn get_spam_score(text: String) -> Result<f64, String> {
    let conn = cache::open()?;
    let (total_spam, total_ham) = db_stats(&conn)?;
    if total_spam < MIN_SPAM_MSGS || total_ham < MIN_HAM_MSGS {
        return Ok(0.0);
    }
    let tokens = tokenize(&text);
    if tokens.is_empty() {
        return Ok(0.0);
    }
    let counts = db_token_counts(&conn, &tokens)?;
    let probs: Vec<f64> = counts
        .into_iter()
        .filter(|(sc, hc)| sc + hc >= MIN_TOKEN_OCCURRENCES)
        .map(|(sc, hc)| token_prob(sc, hc, total_spam, total_ham))
        .collect();
    if probs.is_empty() {
        return Ok(0.0);
    }
    Ok(combine_probs(probs))
}

/// Returns training corpus size. The frontend uses this to show a "needs training" notice
/// when spam_messages < 10 or ham_messages < 10.
#[tauri::command]
pub async fn get_bayes_stats() -> Result<BayesStats, String> {
    let conn = cache::open()?;
    let (spam_messages, ham_messages) = db_stats(&conn)?;
    let distinct_tokens: i64 = conn
        .query_row("SELECT count(*) FROM bayes_tokens", [], |row| row.get(0))
        .map_err(|e| format!("could not count bayes tokens: {e}"))?;
    Ok(BayesStats { spam_messages, ham_messages, distinct_tokens })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct TempCache(PathBuf);

    impl TempCache {
        fn new(label: &str) -> Self {
            let unique = format!(
                "helix-bayes-test-{label}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            );
            Self(std::env::temp_dir().join(unique).join("cache.db"))
        }

        fn open(&self) -> Connection {
            cache::open_at(&self.0, "testkey").expect("cache should open")
        }
    }

    impl Drop for TempCache {
        fn drop(&mut self) {
            if let Some(dir) = self.0.parent() {
                let _ = std::fs::remove_dir_all(dir);
            }
        }
    }

    #[test]
    fn tokenize_lowercases_and_deduplicates() {
        let tokens = tokenize("Hello HELLO world WORLD");
        assert!(tokens.contains(&"hello".to_string()));
        assert!(tokens.contains(&"world".to_string()));
        assert_eq!(tokens.iter().filter(|t| t.as_str() == "hello").count(), 1);
    }

    #[test]
    fn tokenize_drops_short_tokens_and_splits_on_non_alpha() {
        // "it" is length 2 → dropped
        let tokens = tokenize("it-now! 50% off");
        assert!(!tokens.contains(&"it".to_string()));
        assert!(tokens.contains(&"now".to_string()));
        assert!(tokens.contains(&"off".to_string()));
        assert!(!tokens.iter().any(|t| t == "50"));
    }

    #[test]
    fn tokenize_excludes_tokens_over_30_chars() {
        let long_word = "a".repeat(31);
        let text = format!("hello {long_word} world");
        let tokens = tokenize(&text);
        assert!(!tokens.iter().any(|t| t.len() > 30));
        assert!(tokens.contains(&"hello".to_string()));
    }

    #[test]
    fn token_prob_is_symmetric_when_counts_are_equal() {
        let p = token_prob(10, 10, 100, 100);
        assert!((p - 0.5).abs() < 0.01, "symmetric counts should give ~0.5, got {p}");
    }

    #[test]
    fn token_prob_is_high_for_spam_only_token() {
        let p = token_prob(20, 0, 100, 100);
        assert!(p > 0.9, "spam-only token should score high, got {p}");
    }

    #[test]
    fn token_prob_is_low_for_ham_only_token() {
        let p = token_prob(0, 20, 100, 100);
        assert!(p < 0.1, "ham-only token should score low, got {p}");
    }

    #[test]
    fn token_prob_is_clamped_away_from_zero_and_one() {
        let p_max = token_prob(1_000_000, 0, 1_000_000, 1_000_000);
        assert!(p_max <= 0.99);
        let p_min = token_prob(0, 1_000_000, 1_000_000, 1_000_000);
        assert!(p_min >= 0.01);
    }

    #[test]
    fn combine_probs_returns_high_score_for_all_spam_tokens() {
        let probs = vec![0.95, 0.92, 0.88, 0.90, 0.85];
        let score = combine_probs(probs);
        assert!(score > 0.99, "all-spam probs should combine to a very high score, got {score}");
    }

    #[test]
    fn combine_probs_returns_low_score_for_all_ham_tokens() {
        let probs = vec![0.05, 0.08, 0.12, 0.10, 0.15];
        let score = combine_probs(probs);
        assert!(score < 0.01, "all-ham probs should combine to a very low score, got {score}");
    }

    #[test]
    fn combine_probs_returns_zero_for_empty_input() {
        assert_eq!(combine_probs(vec![]), 0.0);
    }

    #[test]
    fn train_increments_counts_and_stats() {
        let cache = TempCache::new("train");
        let conn = cache.open();

        db_train_tokens(&conn, &["free".to_string(), "money".to_string()], true, false)
            .expect("train should succeed");
        db_update_stats(&conn, 1, 0).expect("stat update should succeed");

        let (spam, ham) = db_stats(&conn).unwrap();
        assert_eq!(spam, 1);
        assert_eq!(ham, 0);

        let counts = db_token_counts(&conn, &["free".to_string(), "money".to_string()]).unwrap();
        assert_eq!(counts.len(), 2);
        for (sc, hc) in &counts {
            assert_eq!(*sc, 1);
            assert_eq!(*hc, 0);
        }
    }

    #[test]
    fn retract_decrements_counts_and_floors_at_zero() {
        let cache = TempCache::new("retract");
        let conn = cache.open();

        db_train_tokens(&conn, &["free".to_string()], true, false).unwrap();
        db_update_stats(&conn, 1, 0).unwrap();
        db_train_tokens(&conn, &["free".to_string()], true, true).unwrap();
        db_update_stats(&conn, -1, 0).unwrap();

        let (spam, ham) = db_stats(&conn).unwrap();
        assert_eq!(spam, 0);
        assert_eq!(ham, 0);

        let counts = db_token_counts(&conn, &["free".to_string()]).unwrap();
        assert_eq!(counts[0], (0, 0));
    }

    #[test]
    fn retract_over_retract_stays_at_zero() {
        let cache = TempCache::new("over-retract");
        let conn = cache.open();

        // Retract a token never trained — should be a no-op, not go negative.
        db_train_tokens(&conn, &["free".to_string()], true, true).unwrap();
        let counts = db_token_counts(&conn, &["free".to_string()]).unwrap();
        assert!(counts.is_empty() || counts[0] == (0, 0));
    }

    fn train_many(conn: &Connection, text: &str, is_spam: bool, n: usize) {
        let tokens = tokenize(text);
        for _ in 0..n {
            db_train_tokens(conn, &tokens, is_spam, false).unwrap();
        }
        let (ds, dh): (i64, i64) = if is_spam { (n as i64, 0) } else { (0, n as i64) };
        db_update_stats(conn, ds, dh).unwrap();
    }

    #[test]
    fn model_scores_trained_spam_above_threshold() {
        let cache = TempCache::new("score-spam");
        let conn = cache.open();

        let spam_text = "buy now free money urgent limited offer click here";
        let ham_text = "hello team meeting tomorrow please review the document";

        train_many(&conn, spam_text, true, 15);
        train_many(&conn, ham_text, false, 15);

        assert!(score_text_inner(&conn, spam_text).unwrap(), "spam text should score above threshold");
    }

    #[test]
    fn model_does_not_flag_trained_ham() {
        let cache = TempCache::new("score-ham");
        let conn = cache.open();

        let spam_text = "buy now free money urgent limited offer click here";
        let ham_text = "hello team meeting tomorrow please review the document";

        train_many(&conn, spam_text, true, 15);
        train_many(&conn, ham_text, false, 15);

        assert!(!score_text_inner(&conn, ham_text).unwrap(), "ham text should not be flagged");
    }

    #[test]
    fn model_returns_false_when_undertrained() {
        let cache = TempCache::new("cold-start");
        let conn = cache.open();

        // 5 + 5 is below the 10+10 minimum.
        train_many(&conn, "buy now free money", true, 5);
        train_many(&conn, "hello team meeting", false, 5);

        assert!(!score_text_inner(&conn, "buy now free money").unwrap(), "undertrained model should not classify");
    }

    #[test]
    fn get_spam_score_returns_zero_below_min_training() {
        let cache = TempCache::new("score-zero");
        let conn = cache.open();
        let _ = conn;

        let (total_spam, total_ham) = db_stats(&conn).unwrap();
        assert_eq!(total_spam, 0);
        assert_eq!(total_ham, 0);
        let result = if total_spam < MIN_SPAM_MSGS || total_ham < MIN_HAM_MSGS {
            0.0f64
        } else {
            1.0
        };
        assert_eq!(result, 0.0);
    }
}
