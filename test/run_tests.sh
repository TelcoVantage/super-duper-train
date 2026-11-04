#!/usr/bin/env sh
# Validates every JSON/YAML artifact and runs the Velocity template tests.
set -e
cd "$(dirname "$0")/.."
python3 - <<'PY'
import json, pathlib, sys
ok = True
for p in list(pathlib.Path("data-actions").glob("*.json")) + list(pathlib.Path("triggers").glob("*.json")) + list(pathlib.Path("scripts").glob("*.script")):
    try:
        json.loads(p.read_text()); print("json ok  ", p)
    except Exception as e:
        ok = False; print("json FAIL", p, e)
try:
    import yaml
    for p in pathlib.Path("workflow").glob("*.yaml"):
        yaml.safe_load(p.read_text()); print("yaml ok  ", p)
except ImportError:
    print("(pyyaml not installed: skipping YAML syntax check)")
sys.exit(0 if ok else 1)
PY
python3 test/test_reply_watch_script.py
python3 test/test_reply_state_template.py
