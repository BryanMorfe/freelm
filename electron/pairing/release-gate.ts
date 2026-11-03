/** Remains false until packaged fuses, code integrity and matching signatures pass
 * release verification. No environment variable or renderer option can override it. */
export const localPairingReleaseVerified = false;
export const localPairingReleaseReason =
  'Local QR pairing is awaiting signed-build security validation. Advanced HTTPS pairing remains available.';
