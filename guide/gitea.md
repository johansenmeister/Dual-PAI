---
title: Gitea for PAI
updated: 2026-10-05
---

# Gitea for PAI

Your own Gitea gives PAI two things: a **private copy of this repository**, which
keeps your machines in step (`pai-pull` when you start, `pai-push` when you
finish), and an **issue list** for faults and ideas. This is how PAI itself is
run: an organisation with one repository for the harness, synced from every
machine.

Gitea can run in three places. Your assistant sets up the first two:

| | A new VM on Proxmox | Your own Docker host | A Gitea you already run |
|---|---|---|---|
| **What** | the assistant builds a small Debian VM with Docker and Gitea through Proxmox's API | the assistant puts Gitea on a machine you have that runs Docker, over SSH | the assistant sets up the organisation and the sync on it |
| **Needs** | a Proxmox host, and a token for PAI there (the assistant guides you) | SSH access with a key (the assistant guides you), Docker, ports 3000 and 2222 free | your account there |
| **Uses** | 2 GB of memory, 10 GB of disk (measured: Gitea 110 MB, the VM 0.6 GB and 1.8 GB) | about 110 MB of memory, 200 MB of disk | nothing new |

Already running GitLab, or using GitHub? Then you know the way there; the issue
recipes in [Faults and improvements](issue-tracking.md) cover both.

---

## For the agent: how to run this guide

The rules of `SETUP.md` apply, also when a session starts here without it: one
step at a time; ask with the question tool (OpenCode: `question`; Claude Code:
`AskUserQuestion`); use the fixed texts here for facts; never read
`~/.opencode/.env`; run commands only from the **Run** lines, from the PAI folder;
mark what the user does as **You do this**; and **skip the PAI Algorithm format**:
no headers, no phases, no PRD, just plain sentences. And:

1. **The scripts do the work.** Every step is one script in `guide/gitea/`. Do not
   write API calls or `docker` commands of your own. Each script prints ✓ for
   what went well and ✗ with what to do when something did not; tell the user
   the ✗ line in plain words and follow it. Every script can be run again: it
   keeps what is in place and goes on from where it stopped.
2. **Fill in the values** in `<…>` from the user's answers. Never guess a name,
   an address or an id.
3. **A pause is fine.** After Part 1 the server stands, and Part 2 can be done in
   a new session. If the conversation is getting long, say so, and give the user
   the line to start the next one:
   `pai --prompt "Read guide/gitea.md and continue at Part 2. Gitea runs on <user>@<host>."`
   The scripts and `git remote -v` show what is already in place, so the new
   session can check instead of asking.

Ask first where Gitea should run (the table above), then follow that part.

---

## Part 1A: a new VM on Proxmox

### The token for PAI on Proxmox

Ask whether the user already has a Proxmox API token for PAI in
`~/.opencode/.env`. If not, offer to guide them through making one. **You do
this**, in Proxmox's web interface, one item at a time, waiting for "done" after
each. The token gets only what the steps need, on one pool, two storages, one
network bridge and one node.

1. **A storage for the cloud image.** Datacenter, Storage, pick one (`local`
   works), Edit, and tick **Import** under *Content*.
2. **A pool** for PAI's machines: Datacenter, Permissions, Pools, Create (for
   example `pai-lab`).
3. **A role:** Datacenter, Permissions, Roles, Create (for example `PAILab`),
   with these privileges:
   `VM.Allocate`, `VM.PowerMgmt`, `VM.Config.CDROM`, `VM.Config.CPU`,
   `VM.Config.Cloudinit`, `VM.Config.Disk`, `VM.Config.HWType`, `VM.Config.Memory`,
   `VM.Config.Network`, `VM.Config.Options`, `Datastore.AllocateSpace`,
   `Datastore.AllocateTemplate`.
4. **A user and a token:** Permissions, Users, Add (for example `pai@pve`, realm
   *Proxmox VE authentication server*); then Permissions, API Tokens, Add, for
   that user, with *Privilege Separation* unticked. Copy the secret now: Proxmox
   shows it once.
5. **Where the role applies:** Permissions, Add, User Permission, for the user,
   five times:

   | Path | Role | Why |
   |---|---|---|
   | `/pool/pai-lab` | `PAILab` | create and change the VMs in the pool |
   | `/storage/<the VM disk storage>` | `PAILab` | room for the disks |
   | `/storage/<the import storage>` | `PAILab` | download the image |
   | `/sdn/zones/localnetwork/vmbr0` | `PVESDNUser` (built in) | a network card on the bridge |
   | `/nodes/<node>` | a role with only `Sys.AccessNetwork` (make one, for example `PAIDownload`) | let Proxmox download the image |

   **With a root shell on the Proxmox host** (`ssh root@<host>`), steps 2 to 5
   are one block instead. The user runs it there, with the names filled in;
   `token add` prints the secret once:

   ```bash
   pveum pool add pai-lab
   pveum role add PAILab --privs "VM.Allocate,VM.PowerMgmt,VM.Config.CDROM,VM.Config.CPU,VM.Config.Cloudinit,VM.Config.Disk,VM.Config.HWType,VM.Config.Memory,VM.Config.Network,VM.Config.Options,Datastore.AllocateSpace,Datastore.AllocateTemplate"
   pveum role add PAIDownload --privs Sys.AccessNetwork
   pveum user add pai@pve
   pveum user token add pai@pve gitea --privsep 0
   pveum acl modify /pool/pai-lab --users pai@pve --roles PAILab
   pveum acl modify /storage/<the VM disk storage> --users pai@pve --roles PAILab
   pveum acl modify /storage/<the import storage> --users pai@pve --roles PAILab
   pveum acl modify /sdn/zones/localnetwork/vmbr0 --users pai@pve --roles PVESDNUser
   pveum acl modify /nodes/<node> --users pai@pve --roles PAIDownload --propagate 0
   ```

   `pveum` takes no wildcards, so the privileges are written out. The token is
   then `pai@pve!gitea`.

6. **The keys:** open `~/.opencode/.env` in an editor and add:

   ```
   PROXMOX_API_URL=https://<proxmox address>:8006
   PROXMOX_TOKEN_ID=pai@pve!<token name>
   PROXMOX_TOKEN_SECRET=<the secret>
   ```

Then ask for the five names (the user sees them in Proxmox's tree on the left):
the node, the pool, the storage for VM disks, the storage for the image, and the
bridge (usually `vmbr0`). Check the token:

Run: `bash -c '. guide/gitea/pve.sh && pve_check <node> <pool> <disk storage> <import storage> <bridge>'`

Every line should be ✓. A ✗ line names what is missing; guide the user to add
it, and run the check again. Two things worth knowing: deleting a VM also
deletes the permissions given on `/vms/<id>`, which is why they go on the pool;
and the line on `/nodes/<node>` hides the node's status from the token, which the
steps don't need.

### The VM

Ask for a free VM id and a name (for example `gitea`). DHCP is the default; if
the user wants a fixed address, add `--ip <address>/<prefix> --gw <gateway>`.

Run: `bash guide/gitea/vm.sh --node <node> --vmid <id> --name <name> --pool <pool> --disk-storage <disk storage> --import-storage <import storage> --bridge <bridge>`

It takes two to four minutes, and ends with `ADDRESS=<address>`. The VM's user
is `pai`. With DHCP, suggest a reservation for the VM in the router, so the
address does not move. Then:

Run: `bash guide/gitea/deploy.sh pai@<address>`

Continue at "The account".

## Part 1B: your own Docker host

Ask for the host and the user name there. The host needs Docker with its compose
plugin, and ports 3000 and 2222 free. On Debian or Ubuntu, where the user has
sudo without a password, the script installs Docker itself.

Run: `bash guide/gitea/deploy.sh <user>@<host>`

**If it stops with "cannot log in … with a key yet"** (exit status 2), guide the
SSH setup:

1. If it says this machine has no key, offer to make one. Run:
   `ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""`
2. **You do this**, in a second terminal on this machine (the one PAI runs on):
   `ssh-copy-id <user>@<host>`, and type the password for the host once.
3. Run the `deploy.sh` line again.

If Gitea should be reached at another address than the host name (for example a
DNS name), add `--address <that address>`.

## The account

**You do this**, in a second terminal, so the password is shown only to you
(`deploy.sh` printed the line):

`ssh <user>@<host> docker exec -u git gitea gitea admin user create --admin --username <you> --email <your email> --random-password`

It prints a password once. Log in on `http://<address>:3000`; Gitea asks for a
new password at once.

---

## Part 2: Gitea set up for PAI

### How much PAI may do on Gitea

Ask before anything else. PAI's token belongs to the user's account, which is
Gitea's administrator, so its scope decides what PAI can do on the whole server.

**Choice: tightened access**
- *What:* PAI keeps a token that can write issues and nothing else. A wider token
  is used during the setup, and deleted afterwards.
- *You get:* issues from PAI, and a token that is harmless if it leaks: it cannot
  read or change code, users or settings. The sync uses your SSH key, not the
  token.
- *Needs:* one step from you after the setup: deleting the setup token in Gitea's
  web page.
- *Costs:* PAI cannot create repositories or manage Gitea for you; you do that in
  the web page.
- *Change later:* yes, by hand in Gitea's web page: make a wider token and
  replace the line in `~/.opencode/.env`.
- *We recommend:* for most users.

**Choice: full access**
- *What:* one token with every scope, kept in `~/.opencode/.env`. PAI acts on
  Gitea as the user does.
- *You get:* an assistant that can run Gitea for you: create repositories (for
  your infrastructure code, say), organise issues with labels and milestones,
  open and merge pull requests, add deploy keys and webhooks, and manage users.
- *Needs:* nothing more.
- *Costs:* risk. A leaked token, or a mistake by the model, reaches every
  repository and every user on the server, and could delete them. PAI's security
  guard stops known dangerous commands, such as `rm -rf /`, and asks before an
  API call with the `DELETE` method, but anything else the token allows, such as
  changing a user or a branch protection, goes through as an ordinary `curl`.
- *Change later:* yes, by hand in Gitea's web page (Settings, Applications):
  delete the token and make a narrower one. The assistant cannot delete tokens.
- *We recommend:* only if you want PAI to look after Gitea itself, and Gitea holds
  nothing you could not rebuild.

### The organisation, the repository, the key and the token

Ask for a name for the organisation (for example the user's name or their
lab's). The repository is `pai`.

Run: `bash guide/gitea/pai-setup.sh <user>@<host> --gitea-user <you> --org <org> --access <tight or full>`

It creates the organisation and a private repository, adds this machine's SSH
key to the account, and writes `GITEA_API_URL` and `GITEA_TOKEN` to
`~/.opencode/.env` without showing them. The last line is
`REPO=ssh://git@<address>:2222/<org>/pai.git`. Add `--address <address>` if
`deploy.sh` had one.

With tightened access, **You do this**: on Gitea's web page, Settings,
Applications, delete every token named `pai-setup-…`. Gitea deletes a token only
with the user's password, so the assistant cannot.

**On a Gitea the user already runs** (not one from Part 1), the assistant cannot
make tokens there. **You do this** in Gitea's web page instead: a new
organisation (the `+` at the top, visibility *Private*), a repository `pai` in it
(*Private*, no files), this machine's key under Settings, SSH / GPG Keys (run
`cat ~/.ssh/id_ed25519.pub` and show it), and a token under Settings,
Applications (scope `write:issue`, or *all* for full access). Then edit
`~/.opencode/.env` and add `GITEA_API_URL=<Gitea's address, without /api/v1>` and
`GITEA_TOKEN=<the token>`. The repository's SSH address is on its page.

### Your PAI copy on Gitea, synced

Ask whether the user wants their PAI copy kept there and synced between
machines. Say what it means first: their identity, lab and memory go to their own
server, in the private repository, and every machine with PAI pulls and pushes
it. Ask for a yes before running:

Run: `bash guide/gitea/sync.sh <the REPO address>`

It makes `origin` the user's Gitea (which `pai-pull` and `pai-push` use) and
`upstream` where PAI was cloned from, pushes, and adds `pai-pull`, `pai-push` and
`pai-start` to the shell profile. Then tell the user, in four short lines:

- **`pai-pull`** before a session brings what other machines pushed.
- **`pai-push`** after a session commits everything that changed and pushes it.
  It refuses to commit anything that looks like a key or an `.env` file.
- **Updates of PAI:** `git pull --no-rebase --no-edit upstream main`, then
  `pai-push`.
- **A second machine:** add its SSH key to the Gitea account (avatar → Settings →
  SSH / GPG Keys), clone the repository from Gitea, and run `./install.sh` in it.
  It sees that this PAI is already set up and makes only what belongs to that
  machine: `settings.json` with the user's names, the `~/.opencode` link and the
  `pai` command. The tracked files stay as they are, so `pai-push` spreads
  nothing back. Then `bash guide/gitea/sync.sh <the REPO address>` there gives it
  `pai-pull` and `pai-push`, and the keys are copied by hand: `~/.opencode/.env`
  is not in git.

### The instructions, and a test

Run: `bun PAI-Install/cli/issue-tracking.ts --gitea <org>/pai`

It writes the section for a git server from [Faults and improvements](issue-tracking.md)
at the end of `.opencode/PAI/USER/INFRASTRUCTURE.md`, with the Gitea recipe and
`<org>/pai` filled in, and replaces an earlier one. Then file a test issue with
the recipe, titled "Test from the PAI setup", and show the link it prints. If the copy is synced, `pai-push`
brings the new section to Gitea too.

---

## What the scripts do

For the curious, and for anyone who wants to do it by hand. Measured on Proxmox
VE 9.2 with Gitea 1.27.3, 2026-10-04.

- **`pve.sh`**: the Proxmox API with the token from `~/.opencode/.env`, which goes
  to `curl` through a file descriptor, never on a command line. `pve_check` asks
  Proxmox for the token's rights on each path the steps use.
- **`vm.sh`**: downloads Debian 13's cloud image to the import storage if it is
  not there (checked against Debian's SHA-512 list); creates the VM in one call,
  with the disk imported from the image and cloud-init for the user `pai` with
  this machine's key; grows the disk; starts it; finds the address by its name in
  DNS or its MAC address; checks that the machine answering is the VM (its host
  name); waits for cloud-init; installs Debian's `docker.io` and
  `docker-compose`.
- **`deploy.sh`**: checks the SSH login, Docker and the ports; copies
  `compose.yml` (Gitea's version pinned) to `~/gitea` on the host and starts it.
- **`pai-setup.sh`**: makes tokens with Gitea's own command inside the
  container; creates the organisation, the repository and the key through
  Gitea's API; writes PAI's token to `~/.opencode/.env`.
- **`sync.sh`**: the remotes, the first push, and the line in the shell profile.

## Taking it down

For a VM from Part 1A: Run:
`bash -c '. guide/gitea/pve.sh && pve_wait "$(pve POST nodes/<node>/qemu/<id>/status/stop | jq -r .data)" && pve_wait "$(pve DELETE "nodes/<node>/qemu/<id>?destroy-unreferenced-disks=1" | jq -r .data)"'`

On a Docker host: `ssh <user>@<host> 'cd ~/gitea && docker compose down'`, and
remove `~/gitea` if the data can go.

Then remove the Gitea lines from `~/.opencode/.env`, and, if the copy was
synced, make `upstream` the `origin` again: `git remote remove origin && git
remote rename upstream origin`, and delete the `source …/aliases.sh` line from
the shell profile.
