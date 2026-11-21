# Provider and tooling version pins for the tooling hosts' Cloudflare infrastructure.
# The lockfile (.terraform.lock.hcl) pins the exact provider versions and their
# checksums; this file pins the acceptable ranges.
#
# The state lives in an R2 bucket, reached through its S3 API. scripts/tofu.sh passes
# the bucket and key with -backend-config and the endpoint and key pair through the
# environment, so the backend block below names neither.
#
# The state names who may pass the admin host's Access gate, so it is encrypted
# client-side with AES-GCM under a key derived from var.state_passphrase. Without the
# passphrase the state cannot be read: keep it with the other secrets.
#
# Until the state has been written encrypted, the unencrypted method below stays the
# state's fallback and enforced stays false, so a plain state still reads. Once the
# state is written encrypted, delete the fallback block and the "migrate" method and
# set enforced = true on the state.

terraform {
  # 1.10: the S3 backend's use_lockfile.
  required_version = ">= 1.10.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  backend "s3" {
    region                      = "auto"
    use_path_style              = true
    use_lockfile                = true # the lock is a <key>.tflock object written with a conditional write
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
  }

  encryption {
    key_provider "pbkdf2" "passphrase" {
      passphrase = var.state_passphrase # gitleaks:allow reads the input variable, not a value
    }
    method "aes_gcm" "state" {
      keys = key_provider.pbkdf2.passphrase
    }
    method "unencrypted" "migrate" {}
    state {
      method = method.aes_gcm.state
      fallback {
        method = method.unencrypted.migrate
      }
      enforced = false
    }
    plan {
      method   = method.aes_gcm.state
      enforced = true
    }
  }
}

provider "cloudflare" {
  # Authentication is supplied out of band through the CLOUDFLARE_API_TOKEN
  # environment variable, never written to a tracked file.
}
