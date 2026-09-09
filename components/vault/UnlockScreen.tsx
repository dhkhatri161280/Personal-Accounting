"use client";
import type React from "react";

interface UnlockScreenProps {
  biometricChecked: boolean;
  hasBiometric: boolean;
  // A navigator.credentials.get() call is already awaiting the fingerprint/face prompt --
  // disables the button so a tap here can't fire a second, concurrent WebAuthn ceremony (which
  // throws "OperationError: A request is already pending" instead of either one completing).
  biometricPending: boolean;
  showPasswordFallback: boolean;
  password: string;
  status: string;
  onPasswordChange: (pw: string) => void;
  onPasswordSubmit: (e: React.FormEvent) => void;
  onBiometricUnlock: () => void;
  onShowPasswordFallback: (show: boolean) => void;
}

export function UnlockScreen({
  biometricChecked,
  hasBiometric,
  biometricPending,
  showPasswordFallback,
  password,
  status,
  onPasswordChange,
  onPasswordSubmit,
  onBiometricUnlock,
  onShowPasswordFallback,
}: UnlockScreenProps) {
  return (
    <div className="unlock">
      <div className="vault-mark">DK</div>
      <h1>Unlock FinTech by DK</h1>
      {!biometricChecked ? (
        <p>Preparing secure device authentication...</p>
      ) : hasBiometric && !showPasswordFallback ? (
        <>
          <p>Use your device biometric to unlock both US and India Books.</p>
          <button className="biometric-primary" onClick={onBiometricUnlock} disabled={biometricPending}>
            {biometricPending ? "Confirming..." : "Unlock with fingerprint, face, or Windows Hello"}
          </button>
          <button className="password-fallback" onClick={() => onShowPasswordFallback(true)}>
            Use vault password instead
          </button>
        </>
      ) : (
        <>
          <p>Your vault password is processed only in this browser.</p>
          <form onSubmit={onPasswordSubmit}>
            <input
              type="password"
              value={password}
              onChange={(e) => onPasswordChange(e.target.value)}
              placeholder="Vault password"
              required
              autoFocus
            />
            <button className="primary">Unlock vault</button>
          </form>
          {hasBiometric && (
            <button className="password-fallback" onClick={() => onShowPasswordFallback(false)}>
              Back to biometric unlock
            </button>
          )}
        </>
      )}
      <small>{status}</small>
    </div>
  );
}
