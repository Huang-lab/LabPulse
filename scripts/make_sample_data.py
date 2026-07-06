#!/usr/bin/env python3
"""
Generate a realistic *demo* dataset so the dashboard renders before the real
fetch is wired up. Output shape matches scripts/fetch_activity.py exactly, with
an extra "demo": true flag so the UI can show a "Demo data" badge.

Usage: python3 scripts/make_sample_data.py
The first real `fetch_activity.py` run overwrites public/data/activity.json.
"""

import json
import os
import random
from datetime import date, timedelta

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(REPO_ROOT, "public", "data", "activity.json")

random.seed(20260706)

REPOS = [
    ("scrna-atlas", False, False),
    ("variant-caller", False, False),
    ("labpulse", False, False),
    ("proteomics-pipeline", True, False),
    ("grant-figures", True, False),
    ("website", False, False),
    ("crispr-screen-analysis", False, True),  # archived
]

# (login, display name) with a rough activity weight
CONTRIBUTORS = [
    ("awong-lab", "Alice Wong", 1.0),
    ("bmartinez", "Ben Martinez", 0.85),
    ("chen-yq", "Yuqi Chen", 0.7),
    ("dpatel-phd", "Dev Patel", 0.6),
    ("ekim", "Eun Kim", 0.5),
    ("kuanlinhuang", "Kuan Huang", 0.35),
    ("frotem", "Faye Rotem", 0.3),
    ("grad-sofia", "Sofia Duarte", 0.25),
]

DAYS = 220  # a bit over 7 months of history


def main():
    end = date(2026, 7, 5)
    start = end - timedelta(days=DAYS - 1)

    repos = [
        {
            "name": n,
            "full_name": f"huang-lab/{n}",
            "private": priv,
            "archived": arch,
            "url": f"https://github.com/huang-lab/{n}",
        }
        for (n, priv, arch) in REPOS
    ]
    authors = [
        {
            "login": login,
            "name": name,
            "display": login,
            "avatar": None,
            "url": f"https://github.com/{login}",
        }
        for (login, name, _w) in CONTRIBUTORS
    ]

    # Give each contributor a couple of "home" repos they work on most.
    home = {}
    for ai, (_login, _name, _w) in enumerate(CONTRIBUTORS):
        k = random.choice([1, 2, 2, 3])
        home[ai] = set(random.sample(range(len(REPOS)), k))

    rows = []
    d = start
    while d <= end:
        weekday = d.weekday()  # 0 Mon .. 6 Sun
        weekend = weekday >= 5
        # A gentle upward ramp over time so trends are visible.
        progress = (d - start).days / max(1, DAYS)
        season = 0.7 + 0.6 * progress
        for ai, (_login, _name, w) in enumerate(CONTRIBUTORS):
            day_weight = w * season * (0.25 if weekend else 1.0)
            if random.random() > day_weight * 0.9:
                continue  # no work from this person today
            n_repos_today = 1 if random.random() < 0.8 else 2
            pool = list(home[ai]) or list(range(len(REPOS)))
            for ri in random.sample(pool, min(n_repos_today, len(pool))):
                # archived repo: only occasional historical activity
                if REPOS[ri][2] and random.random() > 0.15:
                    continue
                commits = max(1, int(random.gauss(3 * day_weight + 1, 1.5)))
                add = int(abs(random.gauss(60, 45)) * commits * (0.6 + day_weight))
                dele = int(add * random.uniform(0.15, 0.7))
                rows.append([ri, ai, d.isoformat(), commits, add, dele])
        d += timedelta(days=1)

    rows.sort(key=lambda r: (r[2], r[0], r[1]))

    dataset = {
        "schema": 1,
        "demo": True,
        "generated_at": "2026-07-06T00:00:00Z",
        "owners": ["huang-lab"],
        # Demo: mark most people as lab members; the rest render as "External".
        "lab_members": [c[0] for c in CONTRIBUTORS[:6]],
        "date_range": {"start": start.isoformat(), "end": end.isoformat()},
        "columns": ["repo", "author", "date", "commits", "additions", "deletions"],
        "repos": repos,
        "authors": authors,
        "rows": rows,
    }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(dataset, f, separators=(",", ":"))
    print(f"Wrote demo dataset: {OUT}")
    print(f"  {len(repos)} repos, {len(authors)} contributors, {len(rows)} daily rows")


if __name__ == "__main__":
    main()
