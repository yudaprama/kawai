#!/usr/bin/env python3
"""Create/update the Google Play one-time products the IAP top-up lane sells.

`kawai-server/worker/src/iap.ts` owns the productId → tokens catalog; this
script owns the Play side of the same four products (`tokens_10k` …). It is an
idempotent upsert (`oneTimeProducts.patch` with `allowMissing`), so running it
twice is safe and it doubles as "fix the price/listing" after an edit.

    python3 scripts/play-iap-products.py [service-account.json]
    PLAY_SERVICE_ACCOUNT_JSON='{...json content...}' python3 scripts/play-iap-products.py

The credential is the SAME Play service account the release workflow uses
(`kawai-play-ci@kawai-mobile-ci.iam.gserviceaccount.com` — see
../CREDENTIALS.md).

PREREQUISITE: Play only allows the first product to be created once an uploaded
artifact declares `com.android.vending.BILLING`. That permission comes from
`tauri-plugin-iap`'s own manifest, so ONLY the `release-android-play` variant
carries it — a QRIS-variant AAB on the internal track does not count. Until such
an AAB is live Google answers:

    400 … Product "tokens_10k": Can't create product.
        To fix, request billing permission.

That message names the billing permission OF THE ARTIFACT, not a Play Console
grant: the service account is already authorized on the product surface (a
`PATCH` of a missing product answers `404 NOT_FOUND`, not `403`). If creation
still fails after a billing-enabled AAB is published, then the account is
missing the catalog permission ("Manage store presence" → Products), which is a
separate grant from the financial-data read the worker's
`purchases.products.get` verification needs.

Prices: the IDR anchor per product is the product's top-up amount at the QRIS
rate (base × 100 tokens), i.e. tokens_10k = Rp 10.000 = 1.000.000 token. Play
takes its cut (15% small-business / 30% standard) out of that, so the per-token
margin is thinner than on QRIS — a business decision, change PRICES below (or
the Play Console) rather than the token mapping in the worker.

Prices for every other country/currency are Play's own conversion of that IDR
anchor (`pricing:convertRegionPrices`), all regions marked AVAILABLE, and the
converted USD/EUR pair feeds the "new regions" config — the same shape the Play
Console writes for a simple one-time product.
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

# productId, IDR anchor (whole rupiah), listing copy — en-US is the app's default and is required, `id` is Play's code for Indonesian (`id-ID` is rejected).
PRODUCTS: list[dict[str, object]] = [
    {
        "productId": "tokens_10k",
        "priceIdr": "10000",
        "title": {"id": "1 juta token", "en-US": "1 million tokens"},
        "description": {
            "id": "Tambah 1.000.000 token ke saldo kawai. Sekali pakai.",
            "en-US": "Add 1,000,000 tokens to your kawai balance. One-time purchase.",
        },
    },
    {
        "productId": "tokens_25k",
        "priceIdr": "25000",
        "title": {"id": "2,5 juta token", "en-US": "2.5 million tokens"},
        "description": {
            "id": "Tambah 2.500.000 token ke saldo kawai. Sekali pakai.",
            "en-US": "Add 2,500,000 tokens to your kawai balance. One-time purchase.",
        },
    },
    {
        "productId": "tokens_50k",
        "priceIdr": "50000",
        "title": {"id": "5 juta token", "en-US": "5 million tokens"},
        "description": {
            "id": "Tambah 5.000.000 token ke saldo kawai. Sekali pakai.",
            "en-US": "Add 5,000,000 tokens to your kawai balance. One-time purchase.",
        },
    },
    {
        "productId": "tokens_100k",
        "priceIdr": "100000",
        "title": {"id": "10 juta token", "en-US": "10 million tokens"},
        "description": {
            "id": "Tambah 10.000.000 token ke saldo kawai. Sekali pakai.",
            "en-US": "Add 10,000,000 tokens to your kawai balance. One-time purchase.",
        },
    },
]


def die(msg: str) -> "NoReturn":  # type: ignore[name-defined]
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(1)


def b64url(raw: bytes) -> str:
    import base64

    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def service_account() -> dict[str, str]:
    """The key comes from argv[1] as a PATH, or the env as a path OR the JSON
    content itself (that is how the release workflow passes the CI secret)."""
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


def money(value: dict) -> dict:
    """`Money` with the zero parts omitted (the API rejects `units: 0`)."""
    out: dict[str, object] = {"currencyCode": value["currencyCode"]}
    units = str(value.get("units", "0"))
    if units not in ("0", ""):
        out["units"] = units
    if value.get("nanos"):
        out["nanos"] = value["nanos"]
    return out


def product_body(token: str, product: dict[str, object]) -> tuple[str, dict]:
    status, conv = call(
        token,
        "POST",
        "/pricing:convertRegionPrices",
        {"price": {"currencyCode": "IDR", "units": product["priceIdr"]}},
    )
    if status != 200 or not isinstance(conv, dict):
        die(f"convertRegionPrices failed ({status}): {conv}")
    region_version = conv["regionVersion"]["version"]
    other = conv["convertedOtherRegionsPrice"]
    return region_version, {
        "packageName": PACKAGE_NAME,
        "productId": product["productId"],
        "listings": [
            {
                "languageCode": lang,
                "title": product["title"][lang],  # type: ignore[index]
                "description": product["description"][lang],  # type: ignore[index]
            }
            for lang in ("id", "en-US")
        ],
        "purchaseOptions": [
            {
                "purchaseOptionId": "buy",
                # `legacyCompatible` is what makes a simple one-time product
                # purchasable through the plain INAPP flow the app uses.
                "buyOption": {"legacyCompatible": True, "multiQuantityEnabled": False},
                "regionalPricingAndAvailabilityConfigs": [
                    {
                        "regionCode": region,
                        "price": money(entry["price"]),
                        "availability": "AVAILABLE",
                    }
                    for region, entry in sorted(conv["convertedRegionPrices"].items())
                ],
                "newRegionsConfig": {
                    "usdPrice": money(other["usdPrice"]),
                    "eurPrice": money(other["eurPrice"]),
                    "availability": "AVAILABLE",
                },
            }
        ],
    }


def activate(token: str, product_id: str, option_id: str) -> str:
    """A created product is born DRAFT and is not purchasable. The state is
    output-only, so activation goes through its own endpoint instead of the
    PATCH. Returns the state Play reports afterwards."""
    status, resp = call(
        token,
        "POST",
        f"/oneTimeProducts/{product_id}/purchaseOptions:batchUpdateStates",
        {
            "requests": [
                {
                    "activatePurchaseOptionRequest": {
                        "packageName": PACKAGE_NAME,
                        "productId": product_id,
                        "purchaseOptionId": option_id,
                    }
                }
            ]
        },
    )
    if status >= 400:
        print(f"  ✗ activate {product_id} — HTTP {status}")
        print(resp if isinstance(resp, str) else json.dumps(resp, indent=1))
        return "DRAFT"
    updated = resp["oneTimeProducts"][0]["purchaseOptions"][0]  # type: ignore[index]
    return str(updated.get("state"))


def upsert(token: str, product: dict[str, object]) -> bool:
    version, body = product_body(token, product)
    query = urllib.parse.urlencode(
        {
            "allowMissing": "true",
            "updateMask": "listings,purchaseOptions",
            "regionsVersion.version": version,
        }
    )
    status, resp = call(token, "PATCH", f"/onetimeproducts/{product['productId']}?{query}", body)
    if status >= 400:
        print(f"✗ {product['productId']} — HTTP {status}")
        print(resp if isinstance(resp, str) else json.dumps(resp, indent=1))
        return False

    option = resp["purchaseOptions"][0]  # type: ignore[index]
    state = str(option.get("state"))
    if state != "ACTIVE":
        state = activate(token, str(product["productId"]), str(option["purchaseOptionId"]))
    idr = next(
        (c for c in option["regionalPricingAndAvailabilityConfigs"] if c["regionCode"] == "ID"), None
    )
    price = idr["price"] if idr else {}
    idr_label = f"Rp{int(price.get('units', 0)):,}".replace(",", ".")
    print(
        f"{'✓' if state == 'ACTIVE' else '✗'} {product['productId']} — state {state}, "
        f"{len(option['regionalPricingAndAvailabilityConfigs'])} region, "
        f"ID {idr_label}, regions version {version}"
    )
    return state == "ACTIVE"


def main() -> int:
    token = access_token(service_account())
    print(f"Play one-time products for {PACKAGE_NAME}:")
    results = [upsert(token, product) for product in PRODUCTS]
    if not all(results):
        print(
            "\nSome products failed. If the message is "
            '"Can\'t create product. To fix, request billing permission.", Play has no '
            "uploaded artifact declaring com.android.vending.BILLING yet — ship the Play "
            "variant (release-android-play) to a track first, then re-run. Only if it still "
            'refuses after that is a Play Console grant missing ("Manage store presence" → '
            "Products, separate from financial-data read).",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
