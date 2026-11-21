# Inputs for the tooling hosts' Cloudflare infrastructure. Every value is supplied
# by scripts/tofu.sh from the environment. The API token is read from the
# CLOUDFLARE_API_TOKEN environment variable, and the registry credentials are
# Worker secrets, never OpenTofu inputs, so they never reach the state.

variable "account_id" {
  description = "Cloudflare account ID that owns both Workers: the same account as the hub, and the account holding every zone in var.zone_ids."
  type        = string
}

variable "zone_ids" {
  description = "Cloudflare zone ID of the zone holding each host, keyed by hostname: one entry for var.registry_hostname and for every host in var.publications."
  type        = map(string)
}

variable "registry_hostname" {
  description = "Host the registry Worker is bound to as a custom domain: it serves the OCI API under /v2/, and every path of this host that no publication's route claims."
  type        = string
  default     = "tooling.aggrega.ai"
}

variable "registry_worker_name" {
  description = "Name of the deployed registry Worker; must equal \"name\" in ../workers/registry.wrangler.jsonc."
  type        = string
  default     = "tandem-tooling-registry"
}

variable "files_worker_name" {
  description = "Name of the deployed files Worker; must equal \"name\" in ../files/wrangler.jsonc."
  type        = string
  default     = "tandem-tooling-files"
}

variable "publications" {
  description = "The publications the files Worker serves one by one on each host, keyed by hostname, one route each at https://<host>/<publication>/*. Together the lists must name the same publications as PUBLICATIONS in ../files/wrangler.jsonc. \"tandemsdd\" is the TANDEM plugin marketplace's name, which the core Feature registers and the release workflow publishes under."
  type        = map(list(string))
  default = {
    "tooling.aggrega.ai" = ["tandemsdd"]
  }

  validation {
    condition     = length(var.publications) > 0 && alltrue([for host, pubs in var.publications : length(pubs) > 0 && alltrue([for p in pubs : can(regex("^[a-z0-9][a-z0-9-]*$", p)) && p != "v2"])])
    error_message = "Each host lists at least one publication, and each publication is lowercase letters, digits and \"-\", starting with a letter or digit, and never \"v2\", the registry's own path."
  }
}

variable "any_publication_hosts" {
  description = "The hosts the files Worker serves whole, one route each at https://<host>/*, where every publication name is a publication: a site module is served there once its release uploads it, with no route or deploy of its own. Must name the same hosts as ANY_PUBLICATION_HOSTS in ../files/wrangler.jsonc, and none that var.publications lists or the registry's host."
  type        = list(string)
  default     = ["tooling.cognitio.it"]

  validation {
    condition     = length(distinct(var.any_publication_hosts)) == length(var.any_publication_hosts)
    error_message = "any_publication_hosts lists a host twice."
  }
}

variable "any_publication_worker_name" {
  description = "Name of the Worker the any_publication_hosts routes send their host to. Null means var.files_worker_name; set it to the serving Worker's name in var.instance_worker_names to move the hosts to the cognitio-tooling instance."
  type        = string
  default     = null
}

variable "instance_worker_names" {
  description = "Names of the cognitio-tooling instance's two Workers; must equal \"name\" in ../workers/serve.wrangler.jsonc and ../workers/admin.wrangler.jsonc."
  type = object({
    serve = string
    admin = string
  })
  default = {
    serve = "cognitio-tooling"
    admin = "cognitio-tooling-admin"
  }
}

variable "admin_hostname" {
  description = "Host of the cognitio-tooling admin Worker, behind the Access application; must equal ADMIN_HOST in ../workers/admin.wrangler.jsonc and have an entry in var.zone_ids."
  type        = string
  default     = "tooling-admin.cognitio.it"
}

variable "admin_route_enabled" {
  description = "Whether the admin host's DNS record and route exist. Set it false only to take the host offline: the route sends the host to the admin Worker, which holds the Access application's audience (output admin_access_aud) and verifies every token."
  type        = bool
  default     = true
}

variable "access_allowed_emails" {
  description = "E-mail addresses allowed through the admin host's Access gate."
  type        = list(string)
  sensitive   = true

  validation {
    condition     = length(var.access_allowed_emails) > 0
    error_message = "access_allowed_emails lists at least one address."
  }
}

variable "access_idp_id" {
  description = "ID of the account's Access identity provider (Google) the admin host's sign-in uses."
  type        = string

  validation {
    condition     = length(var.access_idp_id) > 0
    error_message = "access_idp_id is empty."
  }
}

variable "admin_service_token_id" {
  description = "ID of the Access service token the command line presents to the admin host (created in the Zero Trust dashboard; the ID, never the secret)."
  type        = string

  validation {
    condition     = length(var.admin_service_token_id) > 0
    error_message = "admin_service_token_id is empty."
  }
}

variable "state_passphrase" {
  description = "Passphrase of the client-side state encryption (at least 16 characters). Without it the state cannot be read."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.state_passphrase) >= 16
    error_message = "state_passphrase has at least 16 characters."
  }
}
