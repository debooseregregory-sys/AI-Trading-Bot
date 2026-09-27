"""One-shot Spot Testnet diagnostic with a GET-only, fixed-host boundary.

This module intentionally has no order, cancel, transfer, or withdrawal method.
It requires both existing Testnet credential environment variables before it
will make any network request and never prints credentials or raw responses.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

BASE_URL = "https://testnet.binance.vision"
TIME_PATH = "/api/v3/time"
MARKETS_PATH = "/api/v3/exchangeInfo"
ACCOUNT_PATH = "/api/v3/account"
TIMEOUT = 8


class ReadOnlyTestnetClient:
    """Only permits documented GET time, exchangeInfo and account requests."""
    def __init__(self, api_key, api_secret, transport=None):
        if not api_key or not api_secret:
            raise ValueError("Both Testnet credentials are required.")
        self._key = api_key
        self._secret = api_secret
        self._transport = transport or self._http_get
        self._server_offset_ms = 0

    @staticmethod
    def _http_get(url, headers, timeout):
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, hdrs, new_url):
                return None
        request = urllib.request.Request(url, headers=headers, method="GET")
        with urllib.request.build_opener(NoRedirect).open(request, timeout=timeout) as response:
            if response.geturl().split("/", 3)[:3] != ["https:", "", "testnet.binance.vision"]:
                raise ValueError("Unexpected response host.")
            return json.loads(response.read(1_000_001))

    def _get(self, path, params=None, signed=False):
        if path not in {TIME_PATH, MARKETS_PATH, ACCOUNT_PATH}:
            raise ValueError("Endpoint blocked by read-only diagnostic.")
        if path == ACCOUNT_PATH and not signed:
            raise ValueError("Account endpoint must be signed.")
        values = dict(params or {})
        headers = {"Accept": "application/json", "X-MBX-APIKEY": self._key}
        if signed:
            values.update(timestamp=int(time.time() * 1000) + self._server_offset_ms, recvWindow=5000)
            encoded = urllib.parse.urlencode(values)
            values["signature"] = hmac.new(self._secret.encode(), encoded.encode(), hashlib.sha256).hexdigest()
        url = BASE_URL + path
        query = urllib.parse.urlencode(values)
        if query:
            url += "?" + query
        try:
            before = int(time.time() * 1000) if path == TIME_PATH else None
            result = self._transport(url, headers, TIMEOUT)
            if path == TIME_PATH:
                after = int(time.time() * 1000)
                server = result.get("serverTime") if isinstance(result, dict) else None
                if not isinstance(server, int) or server <= 0 or after < before or after - before > 10_000:
                    raise RuntimeError("Testnet returned invalid server time.")
                self._server_offset_ms = server - (before + after) // 2
            return result
        except urllib.error.HTTPError as exc:
            if exc.code in (401, 403):
                raise RuntimeError("Testnet read-only authentication failed.") from None
            if exc.code in (418, 429):
                raise RuntimeError("Testnet read-only request rate limited.") from None
            raise RuntimeError(f"Testnet read-only HTTP failure ({exc.code}).") from None
        except (TimeoutError, urllib.error.URLError, OSError, ValueError):
            raise RuntimeError("Testnet read-only request failed or returned malformed data.") from None

    def run(self):
        time_data = self._get(TIME_PATH)
        server_time = time_data.get("serverTime") if isinstance(time_data, dict) else None
        if not isinstance(server_time, int) or server_time <= 0:
            raise RuntimeError("Testnet returned malformed server time.")
        market_data = self._get(MARKETS_PATH, {"symbol": "BTCUSDT"})
        symbols = market_data.get("symbols") if isinstance(market_data, dict) else None
        if not isinstance(symbols, list) or not symbols or not isinstance(symbols[0], dict):
            raise RuntimeError("Testnet returned malformed market information.")
        market = symbols[0]
        if market.get("symbol") != "BTCUSDT" or market.get("status") not in {"TRADING", "BREAK", "HALT"}:
            raise RuntimeError("Testnet returned unexpected market information.")
        account_data = self._get(ACCOUNT_PATH, {"omitZeroBalances": "true"}, signed=True)
        balances = account_data.get("balances") if isinstance(account_data, dict) else None
        if not isinstance(balances, list):
            raise RuntimeError("Testnet returned malformed account information.")
        return {"serverTime": server_time, "symbol": market["symbol"], "marketStatus": market["status"],
                "nonzeroBalanceRows": len(balances)}


def main():
    api_key = os.environ.get("EXCHANGE_API_KEY")
    api_secret = os.environ.get("EXCHANGE_API_SECRET")
    if not api_key or not api_secret:
        print("Niet uitgevoerd: EXCHANGE_API_KEY en/of EXCHANGE_API_SECRET ontbreekt. Er is geen verbinding gemaakt.")
        return 2
    try:
        result = ReadOnlyTestnetClient(api_key, api_secret).run()
    except Exception as exc:
        print(f"Testnet read-only controle mislukt: {exc}")
        return 1
    print("Testnet read-only controle geslaagd; uitsluitend GET gebruikt.")
    print(f"serverTime={result['serverTime']} symbol={result['symbol']} status={result['marketStatus']} balansregels={result['nonzeroBalanceRows']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
