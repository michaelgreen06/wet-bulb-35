#!/usr/bin/env python3
from __future__ import annotations
import hashlib, json, pathlib, sqlite3, statistics

def is_material_spike(sessions, baseline):
    if len(baseline) != 28: return False
    median = statistics.median(baseline); mad = statistics.median(abs(x-median) for x in baseline)
    return sessions >= 100 and sessions - median >= 100 and sessions >= max(2 * median, median + 4 * max(mad, 1))
def evaluate_target(target, baseline):
    if not target.get("complete"): return None
    if not is_material_spike(target.get("sessions", 0), baseline): return None
    return {**target, "median": statistics.median(baseline)}
def _connect(path):
    pathlib.Path(path).parent.mkdir(parents=True, exist_ok=True); db = sqlite3.connect(path)
    db.execute("CREATE TABLE IF NOT EXISTS alerts (date TEXT PRIMARY KEY, sessions INTEGER, attribution TEXT, content_hash TEXT)"); return db
def record_if_new(path, alert):
    digest = hashlib.sha256(json.dumps(alert, sort_keys=True).encode()).hexdigest(); db = _connect(path)
    prior = db.execute("SELECT sessions, attribution, content_hash FROM alerts WHERE date=?", (alert["date"],)).fetchone()
    allowed = not prior or abs(alert["sessions"]-prior[0]) / max(prior[0], 1) >= .2 or (prior[1] == "unknown" and alert["attribution"] != "unknown")
    if allowed: db.execute("INSERT OR REPLACE INTO alerts VALUES (?, ?, ?, ?)", (alert["date"], alert["sessions"], alert["attribution"], digest)); db.commit()
    db.close(); return allowed
def render_alert(alert):
    median = alert["median"]; sources = alert.get("sources", []); warnings = []
    if sources and sources[0]["name"] == "(not set)": warnings.append("data-quality: (not set) source dominates")
    if alert.get("repeat_heavy"): warnings.append("repeat-heavy traffic: do not call this broad demand")
    lines = [f"GA4 spike {alert['date']}: {alert['sessions']} sessions vs median {median}"]
    lines += [f"- {item}" for item in warnings + [f"source: {x['name']} ({x['sessions']})" for x in sources[:3]]]
    return "\n".join(lines[:10])
