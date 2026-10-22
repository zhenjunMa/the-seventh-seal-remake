"""Verify the running localhost static mounts; original inputs stay outside them."""
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError
import json

RUNTIME = Path(__file__).resolve().parents[1]
BASE = 'http://127.0.0.1:8767'
cases = []
for path, expected in [('/', 200), ('/data/catalog.json', 200),
                       ('/prototype/movement.mjs', 200),
                       ('/GAME.exe', 404), ('/Map/m01030.TLK', 404),
                       ('/data/', 404), ('/prototype/assets/', 404),
                       ('/../GAME.exe', 404), ('/%2e%2e/GAME.exe', 404),
                       ('/prototype/%2e%2e/%2e%2e/GAME.exe', 404),
                       ('/prototype/%5c..%5cGAME.exe', 404),
                       ('/D%3a/game/dqfy/GAME.exe', 404),
                       ('/evidence/npc_native_20261011.json', 404),
                       ('/tests/fixtures/browser_valid_save.json', 404)]:
    try:
        with urlopen(Request(BASE + path), timeout=5) as response:
            status = response.status
            headers = response.headers
            if path == '/data/catalog.json':
                assert json.load(response)['schema'] == 'seventh-seal-runtime-catalog'
    except HTTPError as error:
        status = error.code
        headers = error.headers
    assert status == expected, (path, status, expected)
    assert headers['Cache-Control'] == 'no-cache'
    assert headers['X-Content-Type-Options'] == 'nosniff'
    cases.append(dict(path=path, status=status, passed=True))
report = dict(schema='seventh-seal-runtime-http-verification', version=1,
              url=BASE, success=True, cases=cases,
              scope='Local generated assets and prototype code only; no original game or evidence mount')
(RUNTIME/'evidence/http_verification_20261011.json').write_text(json.dumps(report, indent=2)+'\n', encoding='utf-8')
print(json.dumps(dict(http_checks=len(cases), passed=True)))
