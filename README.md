# tooling.cognitio.it

This repository deploys the tooling install: the Cloudflare resources and Workers that serve the Cognitio tooling
and the TANDEM marketplace.

## What it deploys

| Host | Worker | Serves |
|---|---|---|
| `tooling.cognitio.it` | `cognitio-tooling` | the tooling's public surface |
| `tooling-admin.cognitio.it` | `cognitio-tooling-admin` | the administration surface, behind Cloudflare Access |
| `tooling.aggrega.ai` | `tandem-tooling-registry` | the TANDEM registry |
| `tooling.aggrega.ai` | `tandem-tooling-files` | the TANDEM marketplace files |

The four Workers share one R2 bucket, `tandem-tooling`. OpenTofu (`iac/`) owns the bucket, the D1 database, the
generated keys, the DNS records, the routes, the custom domain and the Access application; `wrangler deploy` owns
each Worker's code, variables and bindings.

## Pins

Two submodules carry the code that is deployed:

- `cognitio-tooling` is pinned at a release tag `vX.Y.Z`.
- `serverless-registry` is pinned at a commit of its `aggrega` branch.

An upgrade is one commit that moves one gitlink: to a newer release tag for `cognitio-tooling`, to a newer `aggrega`
commit for `serverless-registry`. Pushing that commit deploys it.

## Operator steps

This section lists the steps the operator runs by hand: the first apply, the cutover of each host and the moments a
person reads a plan before a gate changes.

## TANDEM credentials and machine log-in

This section covers the credentials TANDEM consumers use against the registry and how a machine logs in with them.
