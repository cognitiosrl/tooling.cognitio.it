# Provider and tooling version pins for the tooling hosts' Cloudflare infrastructure.
# The lockfile (.terraform.lock.hcl) pins the exact provider versions and their
# checksums; this file pins the acceptable ranges.
#
# The state lives in an R2 bucket, reached through its S3 API. scripts/tofu.sh passes
# the bucket and key with -backend-config and the endpoint and key pair through the
# environment, so the backend block below names neither. The state is encrypted on the
# client (encryption.tf).

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
}

provider "cloudflare" {
  # Authentication is supplied out of band through the CLOUDFLARE_API_TOKEN
  # environment variable, never written to a tracked file.
}
