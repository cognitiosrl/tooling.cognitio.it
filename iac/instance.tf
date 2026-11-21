# The resources the Workers bind or read: the D1 database, the R2 bucket and the two
# keys the serving Worker verifies and signs with. Neither the database nor the bucket
# is ever destroyed by a run.

resource "cloudflare_d1_database" "tooling" {
  account_id            = var.account_id
  name                  = "cognitio-tooling"
  primary_location_hint = "weur"

  lifecycle {
    prevent_destroy = true
  }
}

# The bucket all four Workers bind. It already exists in the account; the import
# block adopts it into the state instead of creating it.
resource "cloudflare_r2_bucket" "tooling" {
  account_id = var.account_id
  name       = "tandem-tooling"

  lifecycle {
    prevent_destroy = true
  }
}

import {
  to = cloudflare_r2_bucket.tooling
  id = "${var.account_id}/tandem-tooling/default"
}

# Generated once and kept in the state; each Worker version is uploaded with them.
resource "random_bytes" "verifier_key" {
  length = 32
}

resource "random_bytes" "csrf_key" {
  length = 32
}
