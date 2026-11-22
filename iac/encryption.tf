# Client-side encryption of the state and of a saved plan. The state names who may pass the
# admin host's Access gate and holds the generated keys the Workers verify and sign with, so both are encrypted with
# AES-GCM under a key derived from var.state_passphrase. Both are enforced: OpenTofu's
# encryption refuses to read or write either one unencrypted, so a plain state put in the
# bucket is refused, never read. Without the passphrase the state cannot be read: keep it
# with the other secrets.
#
# scripts/tofu.sh migrate-state carries a plain state in by running in a temporary copy of
# this directory, where it replaces this file with one that also reads a plain state; this
# directory is never changed for it.

terraform {
  encryption {
    key_provider "pbkdf2" "passphrase" {
      passphrase = var.state_passphrase # gitleaks:allow reads the input variable, not a value
    }
    method "aes_gcm" "state" {
      keys = key_provider.pbkdf2.passphrase
    }
    state {
      method   = method.aes_gcm.state
      enforced = true
    }
    plan {
      method   = method.aes_gcm.state
      enforced = true
    }
  }
}
