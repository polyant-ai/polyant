#!/usr/bin/env python3
"""Open a session-based SSM port-forward to an Aurora DB via a running ECS task.

The tunnel runs in the foreground until Ctrl-C. While it is up, connect locally:

    psql -h 127.0.0.1 -p <local-port> -U <user> -d <db>

Credentials for the Aurora Secrets Manager secret are printed once at startup,
so you can copy/paste them into psql or any DB GUI.

Requirements: awscli v2, session-manager-plugin, boto3.
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
from typing import Optional

try:
    import boto3
    from botocore.exceptions import BotoCoreError, ClientError
except ImportError:
    sys.exit("boto3 is required. Install with: pip install boto3")


def die(msg: str, code: int = 1) -> None:
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(code)


def pick_one(items: list, kind: str, hint: Optional[str]) -> str:
    if hint:
        matches = [i for i in items if hint in i]
        if not matches:
            die(f"no {kind} matches '{hint}'. available: {items}")
        if len(matches) > 1:
            die(f"multiple {kind} match '{hint}': {matches}")
        return matches[0]
    if len(items) == 0:
        die(f"no {kind} found in this account/region")
    if len(items) > 1:
        die(f"multiple {kind} found, pass a filter. available: {items}")
    return items[0]


def discover_cluster(ecs, hint: Optional[str]) -> str:
    arns = ecs.list_clusters().get("clusterArns", [])
    names = [a.split("/")[-1] for a in arns]
    return pick_one(names, "ECS cluster", hint)


def discover_service(ecs, cluster: str, hint: Optional[str]) -> str:
    arns = ecs.list_services(cluster=cluster).get("serviceArns", [])
    names = [a.split("/")[-1] for a in arns]
    return pick_one(names, "ECS service", hint)


def discover_task(ecs, cluster: str, service: str) -> tuple[str, str, str]:
    task_arns = ecs.list_tasks(cluster=cluster, serviceName=service, desiredStatus="RUNNING").get("taskArns", [])
    if not task_arns:
        die(f"no RUNNING task for service {service} in cluster {cluster}")
    task_arn = task_arns[0]
    task_id = task_arn.split("/")[-1]
    desc = ecs.describe_tasks(cluster=cluster, tasks=[task_id])
    containers = desc["tasks"][0]["containers"]
    engine = next((c for c in containers if c["name"] == "engine"), None)
    if not engine:
        die(f"no 'engine' container found in task {task_id}. containers: {[c['name'] for c in containers]}")
    return task_id, engine["runtimeId"], engine["name"]


def discover_secret(sm, hint: Optional[str]) -> str:
    paginator = sm.get_paginator("list_secrets")
    names = []
    for page in paginator.paginate():
        names.extend(s["Name"] for s in page.get("SecretList", []))
    if hint:
        return pick_one(names, "secret", hint)
    # Prefer names that look like DB creds
    db_like = [
        n for n in names
        if any(k in n.lower() for k in ("aurora", "database", "rds", "postgres", "-db-", "/db/"))
    ]
    if len(db_like) == 1:
        return db_like[0]
    return pick_one(db_like or names, "secret", None)


def parse_secret(sm, name: str) -> dict:
    raw = sm.get_secret_value(SecretId=name)["SecretString"]
    data = json.loads(raw)
    required = {"host", "port", "username", "password"}
    missing = required - data.keys()
    if missing:
        die(f"secret {name} is missing keys: {sorted(missing)}")
    return data


def port_in_use(port: int) -> bool:
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.2)
        return s.connect_ex(("127.0.0.1", port)) == 0


def main() -> int:
    p = argparse.ArgumentParser(description="Session-based SSM tunnel to an Aurora DB.")
    p.add_argument("--profile", help="AWS profile to use (e.g. test3-prod). If omitted, uses env/default credential chain.")
    p.add_argument("--region", default=os.environ.get("AWS_REGION", "eu-south-1"))
    p.add_argument("--cluster", help="ECS cluster name (substring). Auto-detected if only one.")
    p.add_argument("--service", help="ECS service name (substring). Auto-detected if only one.")
    p.add_argument("--secret", help="Secrets Manager secret name (substring).")
    p.add_argument("--local-port", type=int, default=15432)
    p.add_argument("--psql", action="store_true", help="Auto-launch psql once the tunnel is ready.")
    args = p.parse_args()

    if args.local_port < 1 or args.local_port > 65535:
        die(f"invalid --local-port {args.local_port}")
    if port_in_use(args.local_port):
        die(f"local port {args.local_port} already in use. pass --local-port <n>")

    try:
        session_kwargs = {"region_name": args.region}
        if args.profile:
            session_kwargs["profile_name"] = args.profile
        session = boto3.Session(**session_kwargs)
        ecs = session.client("ecs")
        sm = session.client("secretsmanager")
        ident = session.client("sts").get_caller_identity()
    except (BotoCoreError, ClientError) as e:
        die(f"aws session init failed: {e}")

    print(f"account : {ident['Account']}")
    print(f"identity: {ident['Arn']}")
    print(f"region  : {args.region}")

    cluster = discover_cluster(ecs, args.cluster)
    service = discover_service(ecs, cluster, args.service)
    task_id, runtime_id, container = discover_task(ecs, cluster, service)
    secret_name = discover_secret(sm, args.secret)
    creds = parse_secret(sm, secret_name)

    ssm_target = f"ecs:{cluster}_{task_id}_{runtime_id}"
    params = json.dumps({
        "host": [creds["host"]],
        "portNumber": [str(creds["port"])],
        "localPortNumber": [str(args.local_port)],
    })

    print()
    print(f"cluster : {cluster}")
    print(f"service : {service}")
    print(f"task    : {task_id} ({container})")
    print(f"secret  : {secret_name}")
    print()
    print("--- DB connection (once tunnel is up) ---")
    print(f"host    : 127.0.0.1")
    print(f"port    : {args.local_port}")
    print(f"user    : {creds['username']}")
    print(f"db      : {creds.get('dbname', creds.get('database', '<see secret>'))}")
    print(f"password: {creds['password']}")
    print()
    print(f"  PGPASSWORD='{creds['password']}' psql -h 127.0.0.1 -p {args.local_port} "
          f"-U {creds['username']} -d {creds.get('dbname', creds.get('database', 'postgres'))}")
    print()
    print("Starting SSM tunnel (Ctrl-C to stop)...")

    env = os.environ.copy()
    if args.profile:
        env["AWS_PROFILE"] = args.profile
    env["AWS_REGION"] = args.region

    cmd = [
        "aws", "ssm", "start-session",
        "--target", ssm_target,
        "--document-name", "AWS-StartPortForwardingSessionToRemoteHost",
        "--parameters", params,
    ]

    proc = subprocess.Popen(cmd, env=env)

    def _forward(signum, _frame):
        proc.send_signal(signum)

    signal.signal(signal.SIGINT, _forward)
    signal.signal(signal.SIGTERM, _forward)

    # Readiness probe
    tunnel_ready = False
    for _ in range(30):
        if port_in_use(args.local_port):
            print(f"tunnel ready on 127.0.0.1:{args.local_port}")
            tunnel_ready = True
            break
        if proc.poll() is not None:
            return proc.returncode
        time.sleep(1)
    else:
        print("warning: tunnel not ready after 30s; leaving session running anyway")

    if args.psql and tunnel_ready:
        dbname = creds.get("dbname", creds.get("database", "postgres"))
        psql_env = os.environ.copy()
        psql_env["PGPASSWORD"] = creds["password"]
        psql_proc = subprocess.Popen(
            ["psql", "-h", "127.0.0.1", "-p", str(args.local_port),
             "-U", creds["username"], "-d", dbname],
            env=psql_env,
        )
        psql_proc.wait()
        proc.terminate()
        return psql_proc.returncode

    return proc.wait()


if __name__ == "__main__":
    sys.exit(main())
