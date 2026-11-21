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

- `cognitio-tooling` is pinned at a release tag `vX.Y.Z` on its `main` branch.
- `serverless-registry` is pinned at a commit of its `aggrega` branch.

`scripts/check-pins.sh` refuses a deploy whose pins break either rule, or whose checkouts are not at the commits the
gitlinks name; the deploy runs it before the tests and again before the D1 migrations and the Worker deploys.

An upgrade is one commit that moves one gitlink: to a newer release tag for `cognitio-tooling`, to a newer `aggrega`
commit for `serverless-registry`. Pushing that commit deploys it.

## Operator steps

This section lists the steps the operator runs by hand: the first apply, the cutover of each host and the moments a
person reads a plan before a gate changes.

## TANDEM credentials and machine log-in

This section covers the credentials TANDEM consumers use against the registry and how a machine logs in with them.

Every credential is a Worker secret, never in the repository or in OpenTofu state.

- **The push pair**, used only by the release workflow: `USERNAME` and `PASSWORD` on the registry Worker,
  `tandem-tooling-registry`.
- **The registry's read-only pair**: `READONLY_USERNAME` and `READONLY_PASSWORD` on the registry Worker, which every
  machine building a TANDEM container logs in with. The registry has this one read pair and no per-consumer scoping.
- **The files Worker's consumers**: the secret `CONSUMERS` on the files Worker, `tandem-tooling-files`, a JSON list
  with one entry per consumer. A request is served only when its Basic credential is a consumer's and that consumer
  lists the publication. The list is the same on both hosts.

  ```json
  [
    {"name": "cognitio", "username": "cognitio", "passwordSha256": "<hex>", "publications": ["tandemsdd", "l10n"]},
    {"name": "aggrega",  "username": "aggrega",  "passwordSha256": "<hex>", "publications": ["tandemsdd", "l10n"]},
    {"name": "acme",     "username": "acme",     "passwordSha256": "<hex>", "publications": ["l10n"]}
  ]
  ```

  `passwordSha256` is the SHA-256 of the password, in hex, so the secret holds no password. Usernames are unique and
  carry no `:`. A consumer whose `publications` is `["*"]` is allowed every publication on both hosts, including one
  added later, so adding a publication changes nothing for it.

  `files/consumers.mjs` keeps the list in `consumers.htpasswd`, beside this README, one consumer per line
  (`<username>:<sha256>:<publications or *>`), and puts it as the secret. The file is git-ignored and kept with the
  operator's other secrets. Run its commands from `files/`:

  ```bash
  cd files
  node consumers.mjs add aggrega '*' --generate     # prints a random password once
  node consumers.mjs add acme l10n                  # prompts for the password
  node consumers.mjs allow acme l10n,modules,modules-admin
  node consumers.mjs remove acme
  node consumers.mjs push                           # wrangler secret put CONSUMERS
  ```

  Every change is checked by the Worker's own parser, and against the publications `files/wrangler.jsonc`
  configures, whichever host serves them, before the file is written; `--help` states the rest.
- **The read-only pair on the files Worker**: the files Worker also holds `READONLY_USERNAME` and `READONLY_PASSWORD`,
  set to the registry's read-only pair. That pair is one more consumer, allowed `tandemsdd` and nothing else. A machine
  set up as under "Machine log-in" below reads the plugin marketplace with that pair, so it stays set.

The registry's two usernames must differ: the registry looks a credential up by username and takes the first match,
which is the push pair. No consumer may reuse the read-only username. Neither registry password may contain `,` or `|`,
which the devcontainer CLI's credential variable cannot carry.

**For `tandemsdd`, the read-only pair stays the practical credential.** The plugin's marketplace helper sends the first
Docker login for the host it finds — the container's own Docker config, then `~/.docker-tandem` — and `docker login`
checks a credential against the registry, which knows only its own pairs, so a container is logged in with the
registry's read-only pair. A consumer's own credential serves every other publication, read by whatever client that
package's consumers use.

The release workflow in `aggrega-ai/tandemsdd` reads four repository Actions secrets:

| Secret | Value |
|---|---|
| `TOOLING_REGISTRY_USERNAME`, `TOOLING_REGISTRY_PASSWORD` | the push pair: the registry Worker's `USERNAME`/`PASSWORD`, never the read-only pair |
| `TOOLING_R2_API_TOKEN` | a Cloudflare API token that can write R2 objects; see the scope below |
| `CLOUDFLARE_ACCOUNT_ID` | the account ID |

It runs on the machine named by the Actions variable `AGGREGA_RUNNER`, as the Aggrega workflows do. Set it on
`aggrega-ai/tandemsdd` (or at the organization) to the self-hosted runner's label; without it the release runs on a
GitHub-hosted `ubuntu-latest`.

The repositories are private on GitHub Free, where neither tag nor branch protection is available, so any account with
write access can push a `v*` tag and start a release. What a release can publish is bounded by the credentials its
workflow holds, so scope each one as narrowly as Cloudflare allows: an R2 API token with Object Read & Write on the
bucket `tandem-tooling` alone, created under R2's API tokens, rather than an account-wide Workers R2 Storage: Edit
token, and no token shared between packages.
🔴 **UNVERIFIED:** that `wrangler r2 object put` accepts a bucket-scoped token, and that such a token can list the
bucket's objects through the REST API, which the site modules' index job does; until a release has published with one,
keep the account-wide token at hand to fall back to.

### Machine log-in

Log in twice on each machine that builds containers, with the read-only pair:

```bash
docker login tooling.aggrega.ai --username <read-only user>
docker --config ~/.docker-tandem login tooling.aggrega.ai --username <read-only user>
```

The first login is what pulls the Features when a container is built. The second writes a tooling-only login file,
which the TANDEM Template mounts read-only into the container at `~/.docker-tandem` for the plugin's marketplace. It is
mounted as a directory, so a login made after the container was created is read at once, without a rebuild. Check that
`~/.docker-tandem/config.json` holds an `auths` entry for `tooling.aggrega.ai`: a Docker client that keeps logins in an
OS credential store, such as a macOS keychain, can store it there instead, where the container cannot read it.
