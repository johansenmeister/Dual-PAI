---
title: Reaching PAI from another computer
updated: 2026-10-04
---

# Reaching PAI from another computer

PAI runs in a terminal on one machine. With **tmux** on that machine and an
**SSH** entry on yours, `ssh pai` takes you into PAI's session from any of your
computers. Close the laptop, and the session keeps running; connect again, and
the conversation is where you left it.

You need this only if PAI runs on another machine than the one you sit at: a
server, a virtual machine, a computer in another room.

## How it fits together

```
your computer                        the PAI machine
─────────────                        ───────────────
ssh pai  ──── SSH (your key) ────▶   tmux session "pai"
                                       └─ PAI (OpenCode or Claude Code)
ssh pai-shell ── SSH ───────────▶    a plain shell
```

- **tmux** keeps the session alive on the PAI machine, whether anyone is
  connected or not. `install.sh` installs it.
- **`ssh pai`** connects and attaches to the session named `pai`, or creates it
  if it does not exist. The first time, the session holds a shell: type `pai`.
- **`ssh pai-shell`** is a normal SSH login, for commands, `rsync` and `git`.
  They do not work through `ssh pai`, which already has a command of its own
  ("Cannot execute command-line and remote command"). `scp` works with both.

## Setting it up

The setup conversation (`SETUP.md`, "Reaching PAI from another computer") does
this with you. By hand:

1. **On the PAI machine**, check that SSH and tmux run: `tmux -V`, and from
   another computer `ssh <user>@<address>` (with your password).
2. **On your computer** (Linux, macOS or WSL), copy the client script over and
   run it:

   ```
   scp <user>@<address>:<PAI folder>/scripts/pai-client.sh /tmp/
   bash /tmp/pai-client.sh --host <address> --user <user>
   ```

   It makes an SSH key if you have none, copies it to the PAI machine (you type
   your password once), and writes two entries at the top of `~/.ssh/config`,
   between `# >>> PAI client: pai >>>` and `# <<< PAI client: pai <<<`. Running
   it again replaces them. With `--alias <name>` you can add a second PAI
   machine, or the same machine by another address (see below).
3. **On Windows without WSL**, the script does not run. `SETUP.md`, "Reaching PAI
   from another computer", has the PowerShell commands and the entries to paste
   into `%USERPROFILE%\.ssh\config`. Not tested on Windows yet.

## Daily use

| You want to | Do this |
|---|---|
| open PAI from your computer | `ssh pai` |
| leave it running and disconnect | **Ctrl+b**, then **d** |
| scroll back in the shell | the mouse wheel, or **Ctrl+b**, then **[** (leave with **q**) |
| copy text the usual way | hold **Shift** while you select (on a Mac, **Option** or **Fn**, depending on the terminal) |
| open PAI on the PAI machine itself | `tmux attach -t pai` |
| end the session | quit PAI, then type `exit` in the shell |

Two computers can be attached at the same time; both see the same screen.

The scrolling and copying lines come from `~/.tmux.conf`, which `install.sh`
writes only if you had none. Your own tmux config is left alone.

## From outside your home network

**Do not open the SSH port on your router to the internet.** Every address on
the internet is scanned for open SSH ports all the time. Use a VPN instead: your
computer joins your home network first, and `ssh pai` works as at home.

- **WireGuard** is a VPN you run yourself: on the router (many have it built in,
  OPNsense and pfSense among them), or on a small machine at home with one UDP
  port forwarded. You manage the keys; nothing passes through a third party.
- **Tailscale** builds on WireGuard and does the setup for you: install it on
  the PAI machine and on your computer, log in to the same account, and they
  reach each other by a fixed address, with no port opened at home. It needs an
  account with Tailscale; check their current plans and terms.

With a VPN, the PAI machine may have another address from outside (Tailscale
gives it its own). Add an entry for that address under its own name:

```
bash /tmp/pai-client.sh --host <VPN address> --user <user> --alias pai-away
```

Then `ssh pai` at home and `ssh pai-away` elsewhere reach the same session.

## When something is wrong

| You see | It means |
|---|---|
| `Cannot execute command-line and remote command.` | you gave `ssh pai` a command; use `ssh pai-shell <command>` |
| `open terminal failed: not a terminal` | `ssh pai` ran without a terminal (from a script or a pipe); use `ssh pai-shell` |
| `_` instead of letters such as `ø` or frame lines | tmux started without `-u` on a machine with a non-UTF-8 locale; run `pai-client.sh` again |
| `ssh pai` connects and closes at once | the session ended (someone typed `exit`); `ssh pai` again starts a new one |
| a shell, not PAI | the session is new; type `pai` |
| `Permission denied (publickey)` | the key is not on the PAI machine; run `pai-client.sh` again |
| `Connection refused` | no SSH server runs there (`SETUP.md`, "Reaching PAI from another computer") |

## Removing it

Delete the lines from `# >>> PAI client: pai >>>` to `# <<< PAI client: pai <<<`
in `~/.ssh/config` on your computer. On the PAI machine, the key is a line in
`~/.ssh/authorized_keys`, and `~/.tmux.conf` can go if `install.sh` wrote it.
