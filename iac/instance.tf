# The resources the Workers bind or read: the D1 database, the R2 bucket and the two
# generated keys (the serving and admin Workers verify with VERIFIER_KEY; the admin Worker
# signs with CSRF_KEY). None of them is ever destroyed by a run: each carries prevent_destroy,
# so a plan that would destroy or replace one fails.

resource "cloudflare_d1_database" "tooling" {
  account_id            = var.account_id
  name                  = "cognitio-tooling"
  primary_location_hint = "weur"

  # The API returns this setting; left undeclared, every run would plan a change to null.
  read_replication = {
    mode = "disabled"
  }

  lifecycle {
    prevent_destroy = true
  }
}

# The bucket every Worker binds. It already exists in the account; the import
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

# Generated once and kept in the state; each Worker version is uploaded with them. A
# replacement would change the keys every credential is verified with, so OpenTofu refuses
# to plan one: prevent_destroy below.
resource "random_bytes" "verifier_key" {
  length = 32

  lifecycle {
    prevent_destroy = true
  }
}

resource "random_bytes" "csrf_key" {
  length = 32

  lifecycle {
    prevent_destroy = true
  }
}
