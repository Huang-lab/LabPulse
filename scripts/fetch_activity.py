#!/usr/bin/env python3
"""
LabPulse — fetch GitHub activity for every repo owned by the configured
owners (organizations and/or users), including repos created after setup,
and write a compact daily-aggregated dataset the dashboard reads.

Design goals:
  * Zero third-party dependencies (Python 3.8+ standard library only).
  * Discovers all repos for each owner on every run, so new repos are
    picked up automatically.
  * Counts work per contributor by commits and by lines changed
    (additions / deletions), aggregated per repo, per author, per day.
    The dashboard rolls days up into weeks and months on the fly.
  * Incremental: per-commit line stats are cached on disk so each run only
    fetches commits it has not seen. In CI the cache is persisted with
    actions/cache. A per-run budget keeps a first-time backfill of a large
    history within the API rate limit; it finishes over subsequent runs.

Auth:
  Reads a token from $LABPULSE_TOKEN (preferred) or $GITHUB_TOKEN.
  To read every repo in an organization (including private ones), the
  token needs read access to the org's repositories. The default
  GITHUB_TOKEN inside GitHub Actions is scoped to the current repo only,
  so a PAT with org read access must be supplied as LABPULSE_TOKEN.
"""

import json
import os
import sys
import time
import argparse
import urllib.request
import urllib.parse
import urllib.error
from datetime import datetime, timezone

API_ROOT = "https://api.github.com"
USER_AGENT = "LabPulse-activity-dashboard"

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_CONFIG = os.path.join(REPO_ROOT, "config.json")
DEFAULT_OUT = os.path.join(REPO_ROOT, "public", "data", "activity.json")
DEFAULT_CACHE = os.path.join(REPO_ROOT, ".cache")

SCHEMA_VERSION = 1


# --------------------------------------------------------------------------- #
# Small logging helper
# --------------------------------------------------------------------------- #
def log(msg):
    print(msg, flush=True)


# --------------------------------------------------------------------------- #
# HTTP layer with rate-limit awareness and retries
# --------------------------------------------------------------------------- #
class GitHub:
    def __init__(self, token, budget=None):
        self.token = token
        self.detail_budget = budget  # max commit-detail fetches this run (None = unlimited)
        self.detail_spent = 0
        self.core_remaining = None

    def _headers(self):
        h = {
            "Accept": "application/vnd.github+json",
            "User-Agent": USER_AGENT,
            "X-GitHub-Api-Version": "2022-11-28",
        }
        if self.token:
            h["Authorization"] = f"Bearer {self.token}"
        return h

    def request(self, url, params=None):
        """GET a URL. Returns (status, headers, parsed_json_or_None).
        Retries transient failures with exponential backoff and honors
        the GitHub rate limit."""
        if params:
            qs = urllib.parse.urlencode(params)
            url = f"{url}?{qs}" if "?" not in url else f"{url}&{qs}"

        attempt = 0
        while True:
            attempt += 1
            req = urllib.request.Request(url, headers=self._headers())
            try:
                with urllib.request.urlopen(req, timeout=60) as resp:
                    headers = dict(resp.headers.items())
                    self._note_rate(headers)
                    body = resp.read().decode("utf-8")
                    data = json.loads(body) if body else None
                    return resp.status, headers, data
            except urllib.error.HTTPError as e:
                headers = dict(e.headers.items()) if e.headers else {}
                self._note_rate(headers)
                # Rate limited: wait until reset, then retry (does not count as an attempt).
                if e.code in (403, 429) and self._is_rate_limited(headers):
                    self._sleep_for_reset(headers)
                    attempt -= 1
                    continue
                if e.code in (500, 502, 503, 504) and attempt <= 4:
                    self._backoff(attempt)
                    continue
                body = e.read().decode("utf-8", "replace") if e.fp else ""
                return e.code, headers, _safe_json(body)
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                if attempt <= 4:
                    log(f"    network error ({e}); retrying...")
                    self._backoff(attempt)
                    continue
                raise

    def paginate(self, path, params=None, cap=None):
        """Yield items across all pages, following the Link header."""
        url = path if path.startswith("http") else API_ROOT + path
        p = dict(params or {})
        p.setdefault("per_page", 100)
        yielded = 0
        first = True
        while url:
            status, headers, data = self.request(url, p if first else None)
            first = False
            if status != 200 or not isinstance(data, list):
                if status not in (200, 404, 409):
                    log(f"    warning: {status} for {url}")
                return
            for item in data:
                yield item
                yielded += 1
                if cap and yielded >= cap:
                    return
            url = _next_link(headers.get("Link", ""))

    # -- rate limiting -----------------------------------------------------
    def _note_rate(self, headers):
        rem = headers.get("X-RateLimit-Remaining")
        if rem is not None:
            try:
                self.core_remaining = int(rem)
            except ValueError:
                pass

    def _is_rate_limited(self, headers):
        rem = headers.get("X-RateLimit-Remaining")
        return rem is not None and rem == "0"

    def _sleep_for_reset(self, headers):
        reset = headers.get("X-RateLimit-Reset")
        retry_after = headers.get("Retry-After")
        now = time.time()
        if retry_after:
            wait = float(retry_after)
        elif reset:
            wait = max(0.0, float(reset) - now)
        else:
            wait = 60.0
        wait = min(wait + 2, 3900)  # small buffer, hard cap ~65 min
        log(f"    rate limit hit; sleeping {int(wait)}s until reset...")
        time.sleep(wait)

    def _backoff(self, attempt):
        time.sleep(min(2 ** attempt, 30))

    def can_fetch_detail(self):
        return self.detail_budget is None or self.detail_spent < self.detail_budget


def _safe_json(text):
    try:
        return json.loads(text)
    except Exception:
        return {"raw": text}


def _next_link(link_header):
    if not link_header:
        return None
    for part in link_header.split(","):
        segs = part.split(";")
        if len(segs) < 2:
            continue
        url = segs[0].strip().strip("<>")
        for s in segs[1:]:
            if s.strip() == 'rel="next"':
                return url
    return None


# --------------------------------------------------------------------------- #
# Repo discovery
# --------------------------------------------------------------------------- #
def discover_repos(gh, owner, cfg):
    """Return metadata for every repo under an owner (org or user)."""
    status, _, _ = gh.request(f"{API_ROOT}/orgs/{owner}")
    if status == 200:
        source = f"/orgs/{owner}/repos"
        params = {"type": "all", "sort": "full_name"}
    else:
        source = f"/users/{owner}/repos"
        params = {"type": "owner", "sort": "full_name"}

    repos = []
    for r in gh.paginate(source, params):
        if r.get("fork") and not cfg["include_forks"]:
            continue
        if r.get("archived") and not cfg["include_archived"]:
            continue
        if r.get("name") in cfg["exclude_repos"] or r.get("full_name") in cfg["exclude_repos"]:
            continue
        if r.get("size", 0) == 0:  # empty repo, nothing to count
            continue
        repos.append({
            "name": r.get("name"),
            "full_name": r.get("full_name"),
            "owner": owner,
            "private": bool(r.get("private")),
            "archived": bool(r.get("archived")),
            "fork": bool(r.get("fork")),
            "html_url": r.get("html_url"),
            "default_branch": r.get("default_branch") or "main",
            "created_at": r.get("created_at"),
            "pushed_at": r.get("pushed_at"),
        })
    return repos


# --------------------------------------------------------------------------- #
# Commit collection (incremental, cached)
# --------------------------------------------------------------------------- #
def cache_path(cache_dir, full_name):
    safe = full_name.replace("/", "__")
    return os.path.join(cache_dir, f"{safe}.json")


def load_cache(cache_dir, full_name):
    path = cache_path(cache_dir, full_name)
    if os.path.exists(path):
        try:
            with open(path, "r") as f:
                return json.load(f)
        except Exception:
            pass
    return {"commits": {}, "complete": False, "oldest_seen": None}


def save_cache(cache_dir, full_name, cache):
    os.makedirs(cache_dir, exist_ok=True)
    tmp = cache_path(cache_dir, full_name) + ".tmp"
    with open(tmp, "w") as f:
        json.dump(cache, f)
    os.replace(tmp, cache_path(cache_dir, full_name))


def collect_repo_commits(gh, repo, cfg, cache_dir):
    """Fetch new commit line-stats for a repo, using and updating the cache.
    Returns the cache dict (sha -> record)."""
    full = repo["full_name"]
    branch = repo["default_branch"] if cfg["branch"] == "default" else cfg["branch"]
    cache = load_cache(cache_dir, full)
    known = cache["commits"]

    # List commit SHAs on the branch (newest first). Stop early once we reach
    # a page fully covered by the cache, unless we still owe an older backfill.
    list_params = {"sha": branch}
    if cfg["since"]:
        list_params["since"] = cfg["since"]

    new_shas = []
    consecutive_known = 0
    for c in gh.paginate(f"/repos/{full}/commits", list_params):
        sha = c.get("sha")
        if not sha:
            continue
        if sha in known:
            consecutive_known += 1
            # A full page of already-known commits means we've caught up with
            # history that was fully collected before; stop paging.
            if cache.get("complete") and consecutive_known >= 100:
                break
            continue
        consecutive_known = 0
        new_shas.append(sha)

    if not new_shas:
        cache["complete"] = True
        save_cache(cache_dir, full, cache)
        return cache

    log(f"    {len(new_shas)} new commit(s) to detail")
    fetched = 0
    for sha in new_shas:
        if not gh.can_fetch_detail():
            # Ran out of this run's budget; remaining commits get picked up
            # on the next scheduled run. Mark incomplete so we keep trying.
            cache["complete"] = False
            log(f"    per-run detail budget reached; {len(new_shas) - fetched} left for next run")
            break
        rec = fetch_commit_record(gh, full, sha, cfg)
        gh.detail_spent += 1
        fetched += 1
        if rec is not None:
            known[sha] = rec
        if fetched % 200 == 0:
            save_cache(cache_dir, full, cache)
            log(f"    ...{fetched}/{len(new_shas)} detailed")
    else:
        cache["complete"] = True

    save_cache(cache_dir, full, cache)
    return cache


def fetch_commit_record(gh, full, sha, cfg):
    """Fetch one commit's stats and identity. Returns a compact record or None."""
    status, _, data = gh.request(f"{API_ROOT}/repos/{full}/commits/{sha}")
    if status != 200 or not isinstance(data, dict):
        return None

    parents = data.get("parents") or []
    is_merge = len(parents) > 1
    if is_merge and not cfg["include_merge_commits"]:
        # Store a zero-weight marker so we don't refetch it, but it won't count.
        return {"skip": True}

    commit = data.get("commit") or {}
    gitauthor = commit.get("author") or {}
    date = gitauthor.get("date") or (commit.get("committer") or {}).get("date")
    stats = data.get("stats") or {}
    additions = int(stats.get("additions") or 0)
    deletions = int(stats.get("deletions") or 0)

    cap = cfg.get("max_lines_per_commit")
    if cap and (additions + deletions) > cap:
        return {"skip": True}

    author_obj = data.get("author")  # GitHub user (may be null if unlinked)
    login = author_obj.get("login") if author_obj else None
    avatar = author_obj.get("avatar_url") if author_obj else None
    profile = author_obj.get("html_url") if author_obj else None

    return {
        "date": date[:10] if date else None,
        "login": login,
        "name": gitauthor.get("name"),
        "email": gitauthor.get("email"),
        "avatar": avatar,
        "url": profile,
        "add": additions,
        "del": deletions,
    }


# --------------------------------------------------------------------------- #
# Identity resolution + aggregation
# --------------------------------------------------------------------------- #
def build_alias_lookup(cfg):
    """Map any alias (login/name/email, lowercased) -> canonical key."""
    lookup = {}
    for canonical, aliases in (cfg.get("author_aliases") or {}).items():
        for a in aliases:
            lookup[a.strip().lower()] = canonical
        lookup[canonical.strip().lower()] = canonical
    return lookup


def author_key(rec, alias_lookup):
    """Stable identity for a commit author, preferring the GitHub login."""
    login = rec.get("login")
    name = rec.get("name")
    email = rec.get("email")
    candidates = [c for c in (login, email, name) if c]
    for c in candidates:
        if c.strip().lower() in alias_lookup:
            return alias_lookup[c.strip().lower()]
    if login:
        return login
    if email:
        return email.strip().lower()
    return (name or "unknown").strip()


def is_excluded_author(rec, excluded):
    login = (rec.get("login") or "").lower()
    name = (rec.get("name") or "").lower()
    for ex in excluded:
        exl = ex.lower()
        if exl in (login, name):
            return True
    return False


def aggregate(all_caches, repos, cfg):
    """Build the daily-aggregated dataset from per-repo commit caches."""
    alias_lookup = build_alias_lookup(cfg)
    excluded = cfg.get("exclude_authors") or []
    cap = cfg.get("max_lines_per_commit")   # applied here too, so the cap takes
                                            # effect retroactively over the cache

    repo_index = {r["full_name"]: i for i, r in enumerate(repos)}
    authors = {}        # key -> author meta dict
    author_index = {}   # key -> int
    # (repo_idx, author_idx, day) -> [commits, add, del]
    buckets = {}
    min_day = None
    max_day = None

    for full, cache in all_caches.items():
        ridx = repo_index.get(full)
        if ridx is None:
            continue
        for sha, rec in cache["commits"].items():
            if not rec or rec.get("skip"):
                continue
            day = rec.get("date")
            if not day:
                continue
            if is_excluded_author(rec, excluded):
                continue
            if cap and (rec.get("add", 0) + rec.get("del", 0)) > cap:
                continue  # skip bulk/vendored/generated commits
            key = author_key(rec, alias_lookup)

            if key not in author_index:
                author_index[key] = len(authors)
                authors[key] = {
                    "key": key,
                    "login": rec.get("login"),
                    "name": rec.get("name"),
                    "avatar": rec.get("avatar"),
                    "url": rec.get("url"),
                }
            else:
                # Backfill nicer metadata if a later commit has a login/avatar.
                meta = authors[key]
                if not meta.get("login") and rec.get("login"):
                    meta["login"] = rec.get("login")
                    meta["avatar"] = rec.get("avatar")
                    meta["url"] = rec.get("url")
                if not meta.get("name") and rec.get("name"):
                    meta["name"] = rec.get("name")

            aidx = author_index[key]
            bkey = (ridx, aidx, day)
            b = buckets.get(bkey)
            if b is None:
                buckets[bkey] = [1, rec.get("add", 0), rec.get("del", 0)]
            else:
                b[0] += 1
                b[1] += rec.get("add", 0)
                b[2] += rec.get("del", 0)

            if min_day is None or day < min_day:
                min_day = day
            if max_day is None or day > max_day:
                max_day = day

    author_list = [None] * len(authors)
    for key, idx in author_index.items():
        meta = authors[key]
        display = meta.get("login") or meta.get("name") or key
        author_list[idx] = {
            "login": meta.get("login"),
            "name": meta.get("name"),
            "display": display,
            "avatar": meta.get("avatar"),
            "url": meta.get("url"),
        }

    rows = []
    for (ridx, aidx, day), (commits, add, dele) in buckets.items():
        rows.append([ridx, aidx, day, commits, add, dele])
    # Sort by date then repo then author for stable, diff-friendly output.
    rows.sort(key=lambda r: (r[2], r[0], r[1]))

    return {
        "schema": SCHEMA_VERSION,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "owners": cfg["owners"],
        "lab_members": cfg.get("lab_members", []),
        "date_range": {"start": min_day, "end": max_day},
        "columns": ["repo", "author", "date", "commits", "additions", "deletions"],
        "repos": [
            {
                "name": r["name"],
                "full_name": r["full_name"],
                "private": r["private"],
                "archived": r["archived"],
                "url": r["html_url"],
            }
            for r in repos
        ],
        "authors": author_list,
        "rows": rows,
    }


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def load_config(path):
    with open(path, "r") as f:
        cfg = json.load(f)
    cfg.setdefault("owners", [])
    cfg.setdefault("branch", "default")
    cfg.setdefault("since", None)
    cfg.setdefault("include_forks", False)
    cfg.setdefault("include_archived", True)
    cfg.setdefault("include_merge_commits", False)
    cfg.setdefault("exclude_repos", [])
    cfg.setdefault("exclude_authors", [])
    cfg.setdefault("author_aliases", {})
    cfg.setdefault("lab_members", [])
    cfg.setdefault("max_lines_per_commit", None)
    cfg.setdefault("max_commit_details_per_run", 4000)
    return cfg


def main():
    ap = argparse.ArgumentParser(description="Fetch Huang Lab GitHub activity for LabPulse.")
    ap.add_argument("--config", default=DEFAULT_CONFIG)
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--cache", default=DEFAULT_CACHE)
    args = ap.parse_args()

    cfg = load_config(args.config)
    token = os.environ.get("LABPULSE_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if not token:
        log("ERROR: set LABPULSE_TOKEN (preferred) or GITHUB_TOKEN with org read access.")
        sys.exit(2)
    if not cfg["owners"]:
        log("ERROR: config.json has no owners. Add the org/user names to scan.")
        sys.exit(2)

    gh = GitHub(token, budget=cfg["max_commit_details_per_run"])

    log(f"LabPulse fetch — owners: {', '.join(cfg['owners'])}")
    all_repos = []
    for owner in cfg["owners"]:
        log(f"Discovering repos for '{owner}'...")
        repos = discover_repos(gh, owner, cfg)
        log(f"  found {len(repos)} repo(s)")
        all_repos.extend(repos)

    all_caches = {}
    for i, repo in enumerate(all_repos, 1):
        log(f"[{i}/{len(all_repos)}] {repo['full_name']} (branch: "
            f"{repo['default_branch'] if cfg['branch'] == 'default' else cfg['branch']})")
        try:
            cache = collect_repo_commits(gh, repo, cfg, args.cache)
            all_caches[repo["full_name"]] = cache
        except Exception as e:
            log(f"    ERROR collecting {repo['full_name']}: {e}")
            all_caches[repo["full_name"]] = load_cache(args.cache, repo["full_name"])

    dataset = aggregate(all_caches, all_repos, cfg)

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(dataset, f, separators=(",", ":"))

    log("")
    log(f"Wrote {args.out}")
    log(f"  repos:        {len(dataset['repos'])}")
    log(f"  contributors: {len(dataset['authors'])}")
    log(f"  daily rows:   {len(dataset['rows'])}")
    log(f"  date range:   {dataset['date_range']['start']} -> {dataset['date_range']['end']}")
    if gh.core_remaining is not None:
        log(f"  API calls remaining this window: {gh.core_remaining}")


if __name__ == "__main__":
    main()
