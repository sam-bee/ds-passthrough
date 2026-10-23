#!/usr/bin/env python3
"""Store credentials in Kubernetes without command-line secrets or Git files."""
import argparse
import base64
import getpass
import json
import os
from pathlib import Path
import secrets
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--key-file', type=Path, help='Read the DeepSeek key from this file instead of prompting')
parser.add_argument('--rotate-token', action='store_true', help='Generate a new colleague proxy token')
args = parser.parse_args()
key = (args.key_file.read_text() if args.key_file else getpass.getpass('DeepSeek API key: ')).strip()
if not key or any(c.isspace() for c in key):
    parser.error('The API key must be one nonempty value without whitespace.')
if args.key_file:
    args.key_file.chmod(0o600)

def kubectl(*arguments, payload=None, check=True):
    return subprocess.run(
        ['kubectl', '--context=default', '--request-timeout=20s', *arguments],
        input=json.dumps(payload) if payload else None,
        text=True, capture_output=True, check=check,
    )

try:
    kubectl('apply', '-f', '-', payload={
        'apiVersion': 'v1', 'kind': 'Namespace', 'metadata': {'name': 'ds-passthrough'},
    })
    result = kubectl('-n', 'ds-passthrough', 'get', 'secret', 'ds-passthrough', '-o', 'json', '--ignore-not-found')
    existing = json.loads(result.stdout) if result.stdout.strip() else None
    if existing:
        token = base64.b64decode(existing.get('data', {}).get('PROXY_TOKEN', '')).decode()
    else:
        token = ''
    token = secrets.token_urlsafe(32) if args.rotate_token or not token else token
    credentials = {'DEEPSEEK_API_KEY': key, 'PROXY_TOKEN': token}
    if existing:
        kubectl('-n', 'ds-passthrough', 'patch', 'secret', 'ds-passthrough', '--type=merge', '--patch-file=/dev/stdin', payload={
            'stringData': credentials,
        })
    else:
        kubectl('-n', 'ds-passthrough', 'create', '-f', '-', payload={
            'apiVersion': 'v1', 'kind': 'Secret', 'type': 'Opaque',
            'metadata': {'name': 'ds-passthrough', 'namespace': 'ds-passthrough'},
            'stringData': credentials,
        })
    directory = Path.home() / '.config' / 'ds-passthrough'
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory.chmod(0o700)
    destination = directory / 'proxy-token'
    fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, 'w') as output:
        output.write(token + '\n')
    print(f'Kubernetes Secret updated. Colleague proxy token saved to {destination}')
    print('Mounted credentials refresh automatically, normally within two minutes.')
except subprocess.CalledProcessError as error:
    # Never print command arguments, payloads or API responses containing credentials.
    raise SystemExit(f'kubectl failed with exit code {error.returncode}; check the current cluster connection.') from None
