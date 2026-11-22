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
    target = [cloudflare_workers_route.admin, cloudflare_dns_record.admin, cloudflare_workers_route.serving]
  }

  variables {
    admin_route_enabled = false
  }

  assert {
    condition     = length(cloudflare_dns_record.admin) == 0 && length(cloudflare_workers_route.admin) == 0
    error_message = "the admin record and route exist while admin_route_enabled is false"
  }
}

run "the_admin_record_and_route_exist_with_the_admin_worker_and_host_when_enabled" {
  command = plan
  plan_options {
    target = [cloudflare_workers_route.admin, cloudflare_dns_record.admin, cloudflare_workers_route.serving]
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

run "the_serving_route_exists_for_each_serving_host_and_names_the_serve_worker" {
  command = plan
  plan_options {
    target = [cloudflare_workers_route.admin, cloudflare_dns_record.admin, cloudflare_workers_route.serving]
  }

  assert {
    condition     = length(cloudflare_workers_route.serving) == 1 && cloudflare_workers_route.serving["tooling.cognitio.it"].script == "cognitio-tooling"
    error_message = "the serving route is absent for tooling.cognitio.it or does not name the serving Worker"
  }
  assert {
    condition     = cloudflare_workers_route.serving["tooling.cognitio.it"].pattern == "tooling.cognitio.it/*"
    error_message = "the serving route does not cover every path of the host"
  }
}

run "a_serving_route_names_no_other_worker" {
  command = plan
  plan_options {
    target = [cloudflare_workers_route.admin, cloudflare_dns_record.admin, cloudflare_workers_route.serving]
  }

  variables {
    serving_hosts = ["tooling.cognitio.it", "tooling-admin.cognitio.it"]
  }

  assert {
    condition     = alltrue([for route in cloudflare_workers_route.serving : route.script == "cognitio-tooling"])
    error_message = "a serving route names a Worker other than the serving Worker"
  }
}

run "a_serving_host_that_is_the_registry_host_fails_the_routes_precondition" {
  command = plan
  plan_options {
    target = [cloudflare_workers_route.admin, cloudflare_dns_record.admin, cloudflare_workers_route.serving]
  }

  variables {
    serving_hosts = ["tooling.aggrega.ai"]
  }

  expect_failures = [cloudflare_workers_route.serving]
}

run "a_serving_host_listed_twice_fails_validation" {
  command = plan
  plan_options {
    target = [cloudflare_workers_route.admin, cloudflare_dns_record.admin, cloudflare_workers_route.serving]
  }

  variables {
    serving_hosts = ["tooling.cognitio.it", "tooling.cognitio.it"]
  }

  expect_failures = [var.serving_hosts]
}

run "an_empty_email_list_fails_validation" {
  command = plan
  plan_options {
    target = [cloudflare_workers_route.admin, cloudflare_dns_record.admin, cloudflare_workers_route.serving]
  }

  variables {
    access_allowed_emails = []
  }

  expect_failures = [var.access_allowed_emails]
}

run "the_d1_database_declares_the_read_replication_the_api_returns" {
  command = plan
  plan_options {
    target = [cloudflare_d1_database.tooling]
  }

  assert {
    condition     = cloudflare_d1_database.tooling.read_replication.mode == "disabled"
    error_message = "the D1 database does not declare read_replication.mode as disabled"
  }
}
