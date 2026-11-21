mock_provider "cloudflare" {}
mock_provider "random" {}

# Each run targets the routing resources under test: the mock provider cannot import,
# and a plan that reaches the bucket's import block stops. The import is read by the
# first plan against the real account.

variables {
  account_id             = "0123456789abcdef0123456789abcdef"
  zone_ids               = { "tooling.aggrega.ai" = "zone-aggrega", "tooling.cognitio.it" = "zone-cognitio", "tooling-admin.cognitio.it" = "zone-cognitio" }
  access_allowed_emails  = ["someone@example.test"]
  access_idp_id          = "idp-test"
  admin_service_token_id = "token-test"
  state_passphrase       = "test-passphrase-0123456789"
}

run "admin_record_and_route_absent_while_admin_route_enabled_is_false" {
  command = plan
  plan_options {
    target = [cloudflare_workers_route.admin, cloudflare_dns_record.admin, cloudflare_workers_route.any_publication]
  }

  assert {
    condition     = length(cloudflare_dns_record.admin) == 0 && length(cloudflare_workers_route.admin) == 0
    error_message = "the admin record and route exist while admin_route_enabled is false"
  }
}

run "admin_record_and_route_depend_on_the_access_application_when_enabled" {
  command = plan
  plan_options {
    target = [cloudflare_workers_route.admin, cloudflare_dns_record.admin, cloudflare_workers_route.any_publication]
  }

  variables {
    admin_route_enabled = true
  }

  assert {
    condition     = length(cloudflare_dns_record.admin) == 1 && length(cloudflare_workers_route.admin) == 1
    error_message = "the admin record and route are absent while admin_route_enabled is true"
  }
  assert {
    condition     = cloudflare_workers_route.admin[0].script == "cognitio-tooling-admin" && cloudflare_dns_record.admin[0].name == "tooling-admin.cognitio.it"
    error_message = "the admin route or record names the wrong Worker or host"
  }
}

run "the_any_publication_route_names_the_files_worker_by_default" {
  command = plan
  plan_options {
    target = [cloudflare_workers_route.admin, cloudflare_dns_record.admin, cloudflare_workers_route.any_publication]
  }

  assert {
    condition     = cloudflare_workers_route.any_publication["tooling.cognitio.it"].script == "tandem-tooling-files"
    error_message = "the any-publication route does not name the files Worker"
  }
}

run "the_any_publication_route_names_the_serving_worker_when_the_variable_says_so" {
  command = plan
  plan_options {
    target = [cloudflare_workers_route.admin, cloudflare_dns_record.admin, cloudflare_workers_route.any_publication]
  }

  variables {
    any_publication_worker_name = "cognitio-tooling"
  }

  assert {
    condition     = cloudflare_workers_route.any_publication["tooling.cognitio.it"].script == "cognitio-tooling"
    error_message = "the any-publication route does not name the serving Worker"
  }
}

run "a_variable_naming_the_admin_worker_fails_the_routes_precondition" {
  command = plan
  plan_options {
    target = [cloudflare_workers_route.admin, cloudflare_dns_record.admin, cloudflare_workers_route.any_publication]
  }

  variables {
    any_publication_worker_name = "cognitio-tooling-admin"
  }

  expect_failures = [cloudflare_workers_route.any_publication]
}

run "an_empty_email_list_fails_validation" {
  command = plan
  plan_options {
    target = [cloudflare_workers_route.admin, cloudflare_dns_record.admin, cloudflare_workers_route.any_publication]
  }

  variables {
    access_allowed_emails = []
  }

  expect_failures = [var.access_allowed_emails]
}
