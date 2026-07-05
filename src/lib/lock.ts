import { invoke, isTauri } from "@tauri-apps/api/core";

export interface AppLockConfig {
  password_set: boolean;
  passkey_set: boolean;
  // False when the desktop build was compiled without the `passkey` cargo
  // feature -- the UI explains how to enable it instead of a dead button.
  passkey_available: boolean;
}

export function getAppLockConfig(): Promise<AppLockConfig> {
  if (!isTauri()) {
    return Promise.resolve({ password_set: false, passkey_set: false, passkey_available: false });
  }
  return invoke("get_app_lock_config");
}

export function setAppLockPassword(password: string): Promise<void> {
  return invoke("set_app_lock_password", { password });
}

export function clearAppLockPassword(): Promise<void> {
  return invoke("clear_app_lock_password");
}

export function verifyAppLockPassword(password: string): Promise<boolean> {
  return invoke("verify_app_lock_password", { password });
}

// Enrolls the connected FIDO2 security key. `pin` is the key's own PIN,
// only needed when the key has one configured.
export function registerAppLockPasskey(pin?: string): Promise<void> {
  return invoke("register_app_lock_passkey", { pin: pin ?? null });
}

export function clearAppLockPasskey(): Promise<void> {
  return invoke("clear_app_lock_passkey");
}

// Blocks until the user touches the key (or it errors); resolves true when
// the key's signature verifies against the enrolled credential.
export function passkeyUnlock(pin?: string): Promise<boolean> {
  return invoke("passkey_unlock", { pin: pin ?? null });
}
