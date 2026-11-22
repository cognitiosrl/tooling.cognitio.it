output "admin_access_aud" {
  description = "The audience tag of the admin host's Access application: ACCESS_AUD in ../workers/admin.wrangler.jsonc."
  value       = cloudflare_zero_trust_access_application.admin.aud
}

output "d1_database_id" {
  description = "The ID of the D1 database the Workers bind."
  value       = cloudflare_d1_database.tooling.uuid
}

output "verifier_key" {
  description = "The serving Worker's VERIFIER_KEY, base64."
  value       = random_bytes.verifier_key.base64
  sensitive   = true
}

output "csrf_key" {
  description = "The admin Worker's CSRF_KEY, base64."
  value       = random_bytes.csrf_key.base64
  sensitive   = true
}
