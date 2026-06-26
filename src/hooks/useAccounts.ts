import { useCallback, useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listAccounts, type AccountRecord } from "../lib/account";
import type { MailAccount } from "../data/accounts";

export interface UseAccountsResult {
  accounts: MailAccount[];
  records: AccountRecord[];
  loading: boolean;
  reload: () => void;
}

// Loads the real persisted accounts from the Rust backend (list_accounts).
// Falls back to empty arrays when the backend is unreachable (browser-only
// dev mode without Tauri) -- in that case the welcome screen shows instead
// of crashing, and the sample data in data/accounts.ts is still available
// as a fallback for demo purposes if needed.
export function useAccounts(): UseAccountsResult {
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [records, setRecords] = useState<AccountRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    if (!isTauri()) {
      // Browser dev mode (npm run dev) -- no backend available.
      setLoading(false);
      return;
    }
    setLoading(true);
    listAccounts()
      .then((recs) => {
        setRecords(recs);
        setAccounts(
          recs.map((rec) => ({
            id: rec.account_id,
            label: rec.display_name ?? rec.account_id.split("@")[0],
            email: rec.account_id,
          })),
        );
      })
      .catch(() => {
        // Backend not available or no accounts -- leave arrays empty so
        // App.tsx shows the welcome screen.
        setAccounts([]);
        setRecords([]);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return { accounts, records, loading, reload: load };
}
