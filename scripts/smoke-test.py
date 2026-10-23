#!/usr/bin/env python3
"""Check public HTTPS, CORS, authentication, JSON completions and streaming."""
import argparse
import json
from pathlib import Path
import urllib.error
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--base-url', default='https://ds.personalinfra.co.uk')
parser.add_argument('--token-file', type=Path, default=Path.home() / '.config/ds-passthrough/proxy-token')
args = parser.parse_args()
token = args.token_file.read_text().strip()
base = args.base_url.rstrip('/')

def request(path, *, method='GET', authenticated=True, body=None):
    headers = {'Origin': 'null'}
    if authenticated:
        headers['Authorization'] = f'Bearer {token}'
    if body is not None:
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(base + path, method=method, headers=headers,
                                 data=json.dumps(body).encode() if body is not None else None)
    try:
        response = urllib.request.urlopen(req, timeout=120)
    except urllib.error.HTTPError as error:
        response = error
    assert response.headers.get('Access-Control-Allow-Origin') == '*', 'Missing CORS header'
    return response

with request('/healthz', authenticated=False) as response:
    assert response.status == 200, f'Health status {response.status}'
    assert json.load(response)['status'] == 'ok'
print('PASS HTTPS certificate and health')

with request('/chat/completions', method='OPTIONS', authenticated=False) as response:
    assert response.status == 204, f'Preflight status {response.status}'
print('PASS browser CORS preflight (Origin: null)')

with request('/models', authenticated=False) as response:
    assert response.status == 401, f'Unauthenticated status {response.status}'
print('PASS unauthenticated requests rejected')

with request('/v1/models') as response:
    assert response.status == 200, f'Model list status {response.status}'
    models = [model['id'] for model in json.load(response)['data']]
model = next((name for name in ['deepseek-flash', 'deepseek-chat'] if name in models), models[0])
print(f'PASS authenticated model list; using {model}')

payload = {'model': model, 'messages': [{'role': 'user', 'content': 'Reply with just OK.'}],
           'thinking': {'type': 'disabled'}, 'max_tokens': 32, 'stream': False}
with request('/chat/completions', method='POST', body=payload) as response:
    assert response.status == 200, f'Completion status {response.status}'
    result = json.load(response)
    assert result['choices'][0]['message']['content'], 'Empty completion'
print('PASS real DeepSeek JSON completion')

payload['stream'] = True
with request('/v1/chat/completions', method='POST', body=payload) as response:
    assert response.status == 200, f'Stream status {response.status}'
    assert 'text/event-stream' in response.headers['Content-Type']
    done = False
    content = ''
    for line in response:
        if not line.startswith(b'data: '):
            continue
        value = line[6:].strip()
        if value == b'[DONE]':
            done = True
            break
        event = json.loads(value)
        if event.get('choices'):
            content += event['choices'][0].get('delta', {}).get('content') or ''
    assert done and content, 'Incomplete SSE response'
print('PASS real DeepSeek streaming completion')
