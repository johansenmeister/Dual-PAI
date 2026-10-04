#!/usr/bin/env python3
"""
PortainerApi.py — trygg les/skriv mot Portainer for docker-verten.

Secrets leses fra ~/.opencode/.env (PORTAINER_API_URL, PORTAINER_API_KEY).
Secrets skrives ALDRI til stdout og aldri i argv.

Bruk:
  PortainerApi.py list [--endpoint 2]
  PortainerApi.py show <id>                       # metadata + maskerte env-vars
  PortainerApi.py file <id>                       # compose-innhold (kan ha secrets — bruk varsomt)
  PortainerApi.py bump <id> <old-tag> <new-tag>  # bytt image-tag(er) i compose + redeploy
  PortainerApi.py setenv <id> KEY=VALUE [...]     # legg til/oppdater env-vars + redeploy
  PortainerApi.py deploy <id> [--pull]            # trigger redeploy alene
  PortainerApi.py health <id>                     # sjekk faktisk kjørende images (via ssh)
"""
import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

ENV_PATH = os.path.expanduser("~/.opencode/.env")
ENDPOINT = "2"


def load_env():
    env = {}
    with open(ENV_PATH) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


ENV = load_env()
URL = ENV["PORTAINER_API_URL"]
KEY = ENV["PORTAINER_API_KEY"]
# SSH-aliaset for Docker-verten (`docker`, som i PAI/USER/INFRASTRUCTURE.md), eller
# DOCKER_SSH_HOST i .env. Sto som en bestemt vert her til 2026-10-05 (M-29).
SSH_HOST = ENV.get("DOCKER_SSH_HOST") or "docker"


def req(method, path, body=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(URL + path, data=data, method=method)
    r.add_header("X-API-Key", KEY)
    r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def get_stack(sid):
    _, raw = req("GET", f"/api/stacks/{sid}")
    return json.loads(raw)


def get_file(sid):
    _, raw = req("GET", f"/api/stacks/{sid}/file")
    return json.loads(raw)["StackFileContent"]


def put_stack(sid, compose, env_list, pull=False):
    body = {
        "StackFileContent": compose,
        "Env": env_list,
        "Prune": False,
        "PullImage": pull,
    }
    return req("PUT", f"/api/stacks/{sid}?endpointId={ENDPOINT}", body)


def cmd_list(args):
    _, raw = req("GET", "/api/stacks")
    for s in json.loads(raw):
        if args.endpoint and str(s.get("EndpointId")) != str(args.endpoint):
            continue
        print(f"{s.get('Id'):>3}  {s.get('Name'):<18} ep={s.get('EndpointId')} status={s.get('Status')}")


def cmd_show(args):
    s = get_stack(args.id)
    print(f"Name:     {s.get('Name')}")
    print(f"Endpoint: {s.get('EndpointId')}  Status: {s.get('Status')}")
    print("Env (masked):")
    for e in s.get("Env", []):
        name = e.get("name", "")
        sensitive = any(k in name.upper() for k in ("PASS", "SECRET", "TOKEN", "KEY", "PASSWORD"))
        val = "***" if sensitive else e.get("value", "")
        print(f"  {name}={val}")


def cmd_file(args):
    print(get_file(args.id))


def cmd_bump(args):
    compose = get_file(args.id)
    s = get_stack(args.id)
    env_list = s.get("Env", [])
    n = compose.count(args.old)
    if n == 0:
        print(f"FEIL: '{args.old}' ikke funnet i compose.", file=sys.stderr)
        sys.exit(1)
    compose = compose.replace(args.old, args.new)
    print(f"Bytter '{args.old}' -> '{args.new}' ({n} forekomst(er))")
    status, raw = put_stack(args.id, compose, env_list, pull=args.pull)
    print(f"PUT status {status}")
    if status != 200:
        # IKKE print respons-body: den kan ekkoe Env med secrets umaskert.
        sys.exit(1)
    print("Deploy startet (verifiser med 'health' om litt).")


def cmd_setenv(args):
    compose = get_file(args.id)
    s = get_stack(args.id)
    env_list = s.get("Env", [])
    for pair in args.KEYVALUE:
        if "=" not in pair:
            print(f"FEIL: ugyldig KEY=VALUE: {pair}", file=sys.stderr)
            sys.exit(1)
        k, v = pair.split("=", 1)
        for item in env_list:
            if item.get("name") == k:
                item["value"] = v
                break
        else:
            env_list.append({"name": k, "value": v})
        print(f"Satt {k} (verdi skjult)")
    status, raw = put_stack(args.id, compose, env_list, pull=args.pull)
    print(f"PUT status {status}")  # ikke print body: Portainer kan ekkoe Env-secrets umaskert
    if status != 200:
        sys.exit(1)
    print("Deploy startet (verifiser med 'health' om litt).")


def cmd_deploy(args):
    compose = get_file(args.id)
    s = get_stack(args.id)
    status, raw = put_stack(args.id, compose, s.get("Env", []), pull=args.pull)
    print(f"PUT status {status}")  # ikke print body: Portainer kan ekkoe Env-secrets umaskert
    if status != 200:
        sys.exit(1)
    print("Deploy startet.")


def cmd_health(args):
    # Inspect running images on the docker host (no secrets read)
    out = subprocess.run(
        ["ssh", SSH_HOST, "docker ps --format '{{.Names}}\\t{{.Image}}\\t{{.Status}}'"],
        capture_output=True, text=True,
    )
    if out.returncode != 0:
        print(out.stderr, file=sys.stderr)
        sys.exit(1)
    for line in out.stdout.splitlines():
        if args.filter.lower() in line.lower():
            print(line)


def main():
    p = argparse.ArgumentParser(description="Portainer API helper")
    sub = p.add_subparsers(dest="cmd", required=True)

    pl = sub.add_parser("list")
    pl.add_argument("--endpoint", default=None)
    pl.set_defaults(func=cmd_list)

    ps = sub.add_parser("show")
    ps.add_argument("id", type=int)
    ps.set_defaults(func=cmd_show)

    pf = sub.add_parser("file")
    pf.add_argument("id", type=int)
    pf.set_defaults(func=cmd_file)

    pb = sub.add_parser("bump")
    pb.add_argument("id", type=int)
    pb.add_argument("old")
    pb.add_argument("new")
    pb.add_argument("--pull", action="store_true")
    pb.set_defaults(func=cmd_bump)

    pe = sub.add_parser("setenv")
    pe.add_argument("id", type=int)
    pe.add_argument("KEYVALUE", nargs="+")
    pe.add_argument("--pull", action="store_true")
    pe.set_defaults(func=cmd_setenv)

    pd = sub.add_parser("deploy")
    pd.add_argument("id", type=int)
    pd.add_argument("--pull", action="store_true")
    pd.set_defaults(func=cmd_deploy)

    ph = sub.add_parser("health")
    ph.add_argument("--filter", default="")
    ph.set_defaults(func=cmd_health)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
