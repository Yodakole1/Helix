import { invoke, isTauri } from "@tauri-apps/api/core";

export interface BayesStats {
  spam_count: number;
  ham_count: number;
  token_count: number;
}

export function trainMessage(text: string, isSpam: boolean): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  return invoke("train_message", { text, isSpam });
}

export function retractMessage(text: string, wasSpam: boolean): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  return invoke("retract_message", { text, wasSpam });
}

export function getSpamScore(text: string): Promise<number | null> {
  if (!isTauri()) return Promise.resolve(null);
  return invoke("get_spam_score", { text });
}

export function getBayesStats(): Promise<BayesStats> {
  if (!isTauri()) return Promise.resolve({ spam_count: 0, ham_count: 0, token_count: 0 });
  return invoke("get_bayes_stats");
}
