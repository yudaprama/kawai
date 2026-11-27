"""Create/update the Google Play STORE LISTING text for pro.kawai.app.

This is the app page a user sees in the Play Store (title, short
description, full description) — distinct from the IAP product listings in
play-iap-products.py. The listing text lives HERE, in `LISTINGS`; running
the script syncs every language in that dict (updates existing languages,
creates missing ones) through one Play edit and commits it live.

Usage (same auth shape as play-iap-products.py):
    PLAY_SERVICE_ACCOUNT_JSON=/path/to/key.json python3 scripts/play-store-listing.py
    python3 scripts/play-store-listing.py /path/to/key.json

Limits enforced by Play: title <= 30, shortDescription <= 80,
fullDescription <= 4000. Only languages present here are synced; removing a
language from the dict does NOT delete its live listing (do that in Console).
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request

PACKAGE_NAME = "pro.kawai.app"
API = "https://androidpublisher.googleapis.com/androidpublisher/v3"
TOKEN_URL = "https://oauth2.googleapis.com/token"
SCOPE = "https://www.googleapis.com/auth/androidpublisher"

EN_PRIVACY_NOTE = (
    "• Private by design: the same account keeps separate data on desktop "
    "and mobile — nothing syncs between devices"
)

LISTINGS: dict[str, dict[str, str]] = {
    "en-US": {
        "title": "Kawai",
        "shortDescription": "On-device AI agents: plan goals, chat, trade & keep books — private by design.",
        "fullDescription": "\n".join([
            "Kawai is an AI agents workspace that runs a supervisor-driven loop on your phone: state a goal, and a planner decomposes it into steps across a registry of specialist tools — every step's report and the final deliverable land in one view.",
            "",
            "ON-DEVICE INTELLIGENCE",
            "• Local LLM (Gemma 4 via LiteRT-LM) streams answers on your device",
            "• Chat history stays in local storage on your phone",
            "• Optional cloud failover when a task needs more",
            "",
            "AGENTS & WORKFLOWS",
            "• Pick specialist agents from the catalog",
            "• State a goal in plain language; the planner builds the plan, a scheduler executes it step by step",
            "• Tool calls, reports, and deliverables rendered as inspectable cards",
            "",
            "TRADING & BOOKS",
            "• Binance & MEXC market data, fills history, futures risk audits",
            "• Double-entry accounting agent: per-pair PnL, fee summaries, reconciliation",
            "• Side-effecting steps ask for your confirmation before executing",
            "",
            "VOICE",
            "• Text-to-speech so agents can read answers aloud",
            "",
            "PRIVACY",
            "• Passwords never leave your device — sign-in uses a derived credential",
            "• Your data lives in a per-user local database",
            EN_PRIVACY_NOTE,
            "",
            "Kawai is under active development. Feedback welcome.",
        ]),
    },
    "id": {
        "title": "Kawai",
        "shortDescription": "AI agent lokal di perangkat: chat, goal, trading & pembukuan — privat by design.",
        "fullDescription": "\n".join([
            "Kawai adalah ruang kerja AI agents yang menjalankan loop supervisor-driven di ponselmu: nyatakan sebuah goal, planner memecahnya menjadi langkah-langkah di atas registry tool spesialis — laporan setiap langkah dan deliverable akhir tampil dalam satu tampilan.",
            "",
            "KECERDASAN ON-DEVICE",
            "• LLM lokal (Gemma 4 via LiteRT-LM) mengalirkan jawaban di perangkatmu",
            "• Riwayat chat tersimpan di penyimpanan lokal ponselmu",
            "• Cloud failover opsional saat sebuah tugas butuh lebih banyak tenaga",
            "",
            "AGEN & WORKFLOW",
            "• Pilih agen spesialis dari katalog",
            "• Nyatakan goal dalam bahasa sehari-hari; planner menyusun rencana, scheduler mengeksekusinya langkah demi langkah",
            "• Tool call, laporan, dan deliverable tampil sebagai kartu yang bisa diperiksa",
            "",
            "TRADING & PEMBUKUAN",
            "• Data pasar & riwayat fills Binance & MEXC, audit risiko futures",
            "• Agen akuntansi double-entry: PnL per-pair, ringkasan fee, rekonsiliasi",
            "• Langkah ber-efek samping selalu minta konfirmasimu sebelum dieksekusi",
            "",
            "SUARA",
            "• Text-to-speech agar agen bisa membacakan jawaban",
            "",
            "PRIVASI",
            "• Password tidak pernah keluar dari perangkat — sign-in memakai derived credential",
            "• Datamu hidup di database lokal per-user",
            "• Privat by design: akun yang sama menyimpan data terpisah di desktop dan mobile — tidak ada sinkronisasi antar perangkat",
            "",
            "Kawai masih dalam pengembangan aktif. Masukan dipersilakan.",
        ]),
    },
}

LIMITS = {"title": 30, "shortDescription": 80, "fullDescription": 4000}


def die(msg: str) -> "NoReturn":  # type: ignore[name-defined]
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(1)


def service_account() -> dict[str, str]:
    """argv[1] as a PATH, or the env as a path OR the JSON content itself."""
    given = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("PLAY_SERVICE_ACCOUNT_JSON", "")
    if not given:
        die("pass the service-account JSON path, or set PLAY_SERVICE_ACCOUNT_JSON")
    if given.lstrip().startswith("{"):
        return json.loads(given)
    try:
        with open(given) as fh:
            return json.load(fh)
    except OSError as err:
        die(f"cannot read {given}: {err}")


def b64url(raw: bytes) -> str:
    import base64

    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def access_token(sa: dict[str, str]) -> str:
    """RS256 JWT assertion → OAuth access token, signed with `openssl` (no
    third-party deps; the key is handed over through a 0600 temp file)."""
    import time

    now = int(time.time())
    header = b64url(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    claims = b64url(
        json.dumps(
            {
                "iss": sa["client_email"],
                "scope": SCOPE,
                "aud": TOKEN_URL,
                "iat": now,
                "exp": now + 3600,
            }
        ).encode()
    )
    unsigned = f"{header}.{claims}".encode()

    key = sa["private_key"]
    with tempfile.NamedTemporaryFile("w", suffix=".pem", delete=False) as fh:
        fh.write(key)
        key_path = fh.name
    os.chmod(key_path, 0o600)
    try:
        signature = subprocess.run(
            ["openssl", "dgst", "-sha256", "-sign", key_path],
            input=unsigned,
            capture_output=True,
            check=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError) as err:
        die(f"openssl signing failed: {err}")
    finally:
        os.unlink(key_path)

    body = urllib.parse.urlencode(
        {
            "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
            "assertion": f"{header}.{claims}.{b64url(signature)}",
        }
    ).encode()
    req = urllib.request.Request(
        TOKEN_URL, data=body, headers={"content-type": "application/x-www-form-urlencoded"}
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return json.load(resp)["access_token"]
    except urllib.error.HTTPError as err:
        die(f"token endpoint {err.code}: {err.read().decode()}")


def call(token: str, method: str, path: str, body: object | None = None) -> tuple[int, object]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"{API}/applications/{PACKAGE_NAME}{path}",
        data=data,
        method=method,
        headers={"authorization": f"Bearer {token}", "content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read()
            return resp.status, json.loads(raw) if raw.strip() else None
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode()


def check_limits() -> None:
    for lang, listing in LISTINGS.items():
        for field, cap in LIMITS.items():
            value = listing[field]
            if len(value) > cap:
                die(f"{lang} {field} is {len(value)} chars (limit {cap})")


def sync(token: str) -> int:
    check_limits()
    status, edit = call(token, "POST", "/edits", {})
    if status != 200:
        die(f"edits:insert failed ({status}): {edit}")
    edit_id = edit["id"]  # type: ignore[index]
    print(f"edit {edit_id}")
    try:
        ok = True
        for lang, body in LISTINGS.items():
            # PUT = edits.listings.update: creates the language listing when
            # missing, full-replaces it when present (this script is the
            # source of truth). PATCH would 404 on a new language.
            status, resp = call(token, "PUT", f"/edits/{edit_id}/listings/{lang}", body)
            got = resp if isinstance(resp, dict) else {}
            matched = all(got.get(k) == v for k, v in body.items())
            mark = "✓" if status == 200 and matched else "✗"
            if mark == "✗":
                ok = False
            print(f"{mark} {lang} — HTTP {status}, echo match: {matched}")
            if mark == "✗":
                print(resp if isinstance(resp, str) else json.dumps(resp, indent=1))
        if not ok:
            print("nothing committed (failures above)", file=sys.stderr)
            return 1
        status, resp = call(token, "POST", f"/edits/{edit_id}:commit", {})
        print(f"commit: HTTP {status}" + (f" — {resp}" if status != 200 else ""))
        return 0 if status == 200 else 1
    finally:
        # A committed edit cannot be deleted; this only cleans up failures.
        call(token, "DELETE", f"/edits/{edit_id}", None)


def main() -> int:
    token = access_token(service_account())
    print(f"Play store listing for {PACKAGE_NAME}:")
    return sync(token)


if __name__ == "__main__":
    raise SystemExit(main())
