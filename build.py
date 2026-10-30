#!/usr/bin/env python3
"""Bundle src/*.js (ES modules) into js/bazinga.js (one classic script).

A single classic script works everywhere: hosted on GitHub Pages AND when
index.html is opened straight from disk (browsers block ES modules on file://).
Run:  python3 build.py   after editing anything in src/.
"""
import re, pathlib

ROOT = pathlib.Path(__file__).parent
SRC = ROOT / 'src'
ORDER = ['db', 'util', 'ui', 'meta', 'store', 'youtube', 'ytaccount', 'spotify', 'importers', 'player', 'backup', 'sync', 'voice', 'legal', 'qr', 'app']

def convert(name, code):
    exports = re.findall(r'^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)', code, re.M)
    def imp(m):
        what, mod = m.group(1).strip(), m.group(2)
        ref = '__m_' + mod
        if what.startswith('*'):
            return f'const {what.split(" as ")[1].strip()} = {ref};'
        names = [n.strip() for n in what.strip('{} ').split(',') if n.strip()]
        names = [n.replace(' as ', ': ') for n in names]
        return 'const { ' + ', '.join(names) + ' } = ' + ref + ';'
    code = re.sub(r'^import\s+(.+?)\s+from\s+[\'"]\./(\w+)\.js[\'"];?', imp, code, flags=re.M | re.S)
    code = re.sub(r'^export\s+', '', code, flags=re.M)
    return f'const __m_{name} = (() => {{\n{code}\nreturn {{ {", ".join(exports)} }};\n}})();\n'

out = ['/* BAZINGA — built from src/ by build.py. Edit src/, then run: python3 build.py */\n(() => {\n"use strict";\n']
for n in ORDER:
    out.append(f'// ---------- {n}.js ----------\n' + convert(n, (SRC / f'{n}.js').read_text()))
out.append('})();\n')
(ROOT / 'js').mkdir(exist_ok=True)
(ROOT / 'js' / 'bazinga.js').write_text(''.join(out))
print('built js/bazinga.js')

# Cache-busting: stamp index.html with a content hash so every browser (Safari especially,
# which holds on to cached CSS) always loads the newest stylesheet and script.
import hashlib
for rel in ['css/app.css', 'js/bazinga.js']:
    h = hashlib.sha1((ROOT / rel).read_bytes()).hexdigest()[:10]
    idx = ROOT / 'index.html'
    txt = re.sub(re.escape(rel) + r'(\?v=[0-9a-f]+)?"', rel + '?v=' + h + '"', idx.read_text())
    idx.write_text(txt)
print('stamped index.html')
# version.json: the installed app checks this on every launch and reloads itself when it changes
import json
js_hash = hashlib.sha1((ROOT / 'js' / 'bazinga.js').read_bytes()).hexdigest()[:10]
css_hash = hashlib.sha1((ROOT / 'css' / 'app.css').read_bytes()).hexdigest()[:10]
(ROOT / 'version.json').write_text(json.dumps({'v': js_hash + '.' + css_hash}) + '\n')
print('wrote version.json')

# Standalone privacy page (Google's OAuth review needs a normal URL for it)
import subprocess, html as _html
try:
    legal = subprocess.run(['node', '--input-type=module', '-e',
        "import('./src/legal.js').then(m => process.stdout.write(m.LEGAL_HTML))"], cwd=ROOT, capture_output=True, text=True, check=True).stdout
    (ROOT / 'privacy.html').write_text(f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BAZINGA! - Privacy Policy & Terms</title><link rel="icon" href="favicon.ico"><style>
body{{margin:0;background:#0c0c0e;color:#f5f2e8;font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}}main{{max-width:760px;margin:0 auto;padding:32px 20px 60px}}
a{{color:#ffd60a}}h1{{font-size:34px;margin:12px 0}}h3{{margin-top:32px;font-size:22px}}h4{{margin:22px 0 4px}}p,li{{color:#d6d2c7}}.tiny{{font-size:13px}}.muted{{color:#9b988f}}
.top{{display:flex;align-items:center;gap:10px;text-decoration:none;color:#f5f2e8;font-weight:800;font-style:italic;font-size:22px}}.top img{{width:34px}}</style></head>
<body><main><a class="top" href="./"><img src="icons/icon-192.png" alt="">BAZINGA!</a><h1>Privacy Policy &amp; Terms of Use</h1>{legal}
<p class="tiny muted">© 2026 Abbel Dawit · <a href="./">Open BAZINGA!</a></p></main></body></html>""")
    print('built privacy.html')
except Exception as e:
    print('privacy.html skipped:', e)
