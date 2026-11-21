# Cloudflare infrastructure for the TANDEM tooling hosts: the custom domain that
# binds the registry Worker to its host, a proxied DNS record for every other host,
# one route per publication on each host that lists its publications, which sends
# that path prefix of the host to the files Worker, and one route for the whole of
# each host that serves any publication.
#
# The admin host of the cognitio-tooling instance sits behind a Cloudflare Access
# application; its DNS record and route exist only once admin_route_enabled is true, and
# both wait for the application, so the host is never reachable ungated.
#
# The Worker scripts are deployed by wrangler (../workers/ and ../files/), not by
# this configuration: wrangler bundles each Worker's code and ships its secrets with
# the version, and a script resource here would hold every secret binding in the
# state. OpenTofu owns the hosts' routing, the Access application, and the R2 bucket
# and D1 database the Workers bind (instance.tf).
#
# No ruleset is created here. A zone holds one entry-point ruleset per phase, and
# the registry zone's response-compression ruleset belongs to the configuration
# that owns that zone. Its rule matches /v2/ blob and manifest paths on every host
# of the zone, with no host condition, so it already keeps this registry's blob and
# manifest responses uncompressed. The other hosts serve no /v2/.

locals {
  # One entry per route, keyed "<host>/<publication>".
  routes = merge([
    for host, pubs in var.publications : {
      for p in pubs : "${host}/${p}" => { host = host, publication = p }
    }
  ]...)

  # The hosts with no custom domain. A route needs a proxied DNS record for its host,
  # and the custom domain provisions the registry host's; these need one of their own.
  route_only_hosts = setsubtract(setunion(keys(var.publications), var.any_publication_hosts), [var.registry_hostname])

  # The Worker the any-publication routes name: the files Worker unless an instance
  # Worker is named.
  any_publication_worker_name = coalesce(var.any_publication_worker_name, var.files_worker_name)
}

# Binds the registry Worker to its host. Cloudflare provisions the proxied DNS
# record and the route as part of the attachment, so no separate DNS-record
# resource is needed for this host. The Worker (var.registry_worker_name) must
# already be deployed for this to attach.
resource "cloudflare_workers_custom_domain" "registry" {
  account_id = var.account_id
  zone_id    = var.zone_ids[var.registry_hostname]
  hostname   = var.registry_hostname
  service    = var.registry_worker_name

  lifecycle {
    precondition {
      condition     = contains(keys(var.zone_ids), var.registry_hostname)
      error_message = "zone_ids has no entry for the registry host \"${var.registry_hostname}\"."
    }
  }
}

# A proxied record for each host that only routes reach. It points at 100::, the
# IPv6 discard prefix, because no origin stands behind these hosts: a path with a
# route is answered by the files Worker, and any other path reaches no Worker.
resource "cloudflare_dns_record" "files" {
  for_each = local.route_only_hosts

  zone_id = var.zone_ids[each.value]
  name    = each.value
  type    = "AAAA"
  content = "100::"
  proxied = true
  ttl     = 1
  comment = "Tooling files host: served by Workers routes only."

  lifecycle {
    precondition {
      condition     = contains(keys(var.zone_ids), each.value)
      error_message = "zone_ids has no entry for the host \"${each.value}\"."
    }
  }
}

# Sends /<publication>/* on each host to the files Worker, for each publication that
# host lists. On the registry host a route runs before the custom domain's Worker,
# and the most specific matching pattern wins, so every other path of that host
# still reaches the registry.
resource "cloudflare_workers_route" "files" {
  for_each = local.routes

  zone_id = var.zone_ids[each.value.host]
  pattern = "${each.value.host}/${each.value.publication}/*"
  script  = var.files_worker_name

  lifecycle {
    precondition {
      condition     = contains(keys(var.zone_ids), each.value.host)
      error_message = "zone_ids has no entry for the host \"${each.value.host}\"."
    }
  }

  depends_on = [cloudflare_workers_custom_domain.registry, cloudflare_dns_record.files]
}

# Sends every path of each host that serves any publication to the files Worker, which
# reads the host and serves every publication name there. Such a host is never the
# registry's, whose other paths must still reach the registry, and never one that also
# lists its publications, whose routes this one would make redundant.
resource "cloudflare_workers_route" "any_publication" {
  for_each = toset(var.any_publication_hosts)

  zone_id = var.zone_ids[each.value]
  pattern = "${each.value}/*"
  script  = local.any_publication_worker_name

  lifecycle {
    precondition {
      condition     = contains(keys(var.zone_ids), each.value)
      error_message = "zone_ids has no entry for the host \"${each.value}\"."
    }
    precondition {
      condition     = each.value != var.registry_hostname && !contains(keys(var.publications), each.value)
      error_message = "\"${each.value}\" serves any publication, so it is neither the registry's host nor a host in publications."
    }
    precondition {
      condition     = contains([var.files_worker_name, var.instance_worker_names.serve], local.any_publication_worker_name)
      error_message = "any_publication_worker_name is the files Worker or the instance's serving Worker, never the admin Worker or another."
    }
  }

  depends_on = [cloudflare_dns_record.files]
}

# A state that holds the tandemsdd route at cloudflare_workers_route.plugins is carried
# to files["tandemsdd"], and from there to its "<host>/<publication>" address, so the
# route is updated in place rather than destroyed and created again.
moved {
  from = cloudflare_workers_route.plugins
  to   = cloudflare_workers_route.files["tandemsdd"]
}

moved {
  from = cloudflare_workers_route.files["tandemsdd"]
  to   = cloudflare_workers_route.files["tooling.aggrega.ai/tandemsdd"]
}

# The people allowed through the admin host's Access gate, signing in with the account's
# Google identity provider.
resource "cloudflare_zero_trust_access_policy" "admin_people" {
  account_id = var.account_id
  name       = "tooling admin: allowed people"
  decision   = "allow"
  include    = [for e in var.access_allowed_emails : { email = { email = e } }]
}

# The command line's service token: it passes the gate without an identity.
resource "cloudflare_zero_trust_access_policy" "admin_service" {
  account_id = var.account_id
  name       = "tooling admin: command line service token"
  decision   = "non_identity"
  include    = [{ service_token = { token_id = var.admin_service_token_id } }]
}

resource "cloudflare_zero_trust_access_application" "admin" {
  account_id                = var.account_id
  name                      = "tooling admin: ${var.admin_hostname}"
  type                      = "self_hosted"
  domain                    = var.admin_hostname
  destinations              = [{ type = "public", uri = var.admin_hostname }]
  session_duration          = "24h"
  allowed_idps              = [var.access_idp_id]
  auto_redirect_to_identity = true
  app_launcher_visible      = false
  service_auth_401_redirect = true

  # A cross-site POST arrives without the Access cookie, so Access stops it before the Worker.
  same_site_cookie_attribute = "lax"
  # The Access cookie is out of reach of page scripts.
  http_only_cookie_attribute = true

  policies = [
    { id = cloudflare_zero_trust_access_policy.admin_people.id, precedence = 1 },
    { id = cloudflare_zero_trust_access_policy.admin_service.id, precedence = 2 },
  ]
}

# The admin host's proxied record, like the files hosts': no origin stands behind it,
# the route below answers.
resource "cloudflare_dns_record" "admin" {
  count = var.admin_route_enabled ? 1 : 0

  zone_id = var.zone_ids[var.admin_hostname]
  name    = var.admin_hostname
  type    = "AAAA"
  content = "100::"
  proxied = true
  ttl     = 1
  comment = "Tooling admin host: served by a Workers route only, behind Access."

  lifecycle {
    precondition {
      condition     = contains(keys(var.zone_ids), var.admin_hostname)
      error_message = "zone_ids has no entry for the admin host \"${var.admin_hostname}\"."
    }
  }

  depends_on = [cloudflare_zero_trust_access_application.admin]
}

# Sends every path of the admin host to the admin Worker.
resource "cloudflare_workers_route" "admin" {
  count = var.admin_route_enabled ? 1 : 0

  zone_id = var.zone_ids[var.admin_hostname]
  pattern = "${var.admin_hostname}/*"
  script  = var.instance_worker_names.admin

  depends_on = [cloudflare_zero_trust_access_application.admin, cloudflare_dns_record.admin]
}
