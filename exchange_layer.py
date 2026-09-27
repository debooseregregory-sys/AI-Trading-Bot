"""Phase 8: isolated, read-only exchange provider boundary (stdlib only).

Only fixed GET endpoints are implemented. There is deliberately no generic
request method and no order/transfer/withdrawal implementation.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time
import urllib.error
import urllib.parse
import urllib.request


class ExchangeError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class ExchangeProvider:
    """Small provider contract for future adapters."""
    name = ""
    def status(self): raise NotImplementedError
    def test_connection(self): raise NotImplementedError
    def account(self): raise NotImplementedError
    def markets(self): raise NotImplementedError


class BinanceSpotReadOnly(ExchangeProvider):
    name = "Binance Spot"
    timeout_seconds = 8
    def __init__(self, api_key=None, api_secret=None, sandbox=None, transport=None):
        self.api_key = api_key if api_key is not None else ""
        self.api_secret = api_secret if api_secret is not None else ""
        self.sandbox = sandbox if sandbox is not None else False
        self.transport = transport or self._transport
        self.base_url = "https://testnet.binance.vision" if self.sandbox else "https://api.binance.com"

    def status(self):
        configured = bool(self.api_key and self.api_secret)
        partial = bool(self.api_key) != bool(self.api_secret)
        return {"exchange": self.name, "configured": configured, "partial": partial,
                "connected": False, "state": "not_configured" if not configured else "not_tested",
                "mode": "TESTNET" if self.sandbox else "LIVE ACCOUNT",
                "readOnly": True, "tradingEnabled": False, "withdrawalsEnabled": False,
                "transfersEnabled": False, "lastSuccess": None,
                "message": "Nog geen accountverbinding ingesteld." if not configured else "Verbinding nog niet getest."}

    @staticmethod
    def _transport(url, headers, timeout):
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, request, fp, code, message, response_headers, new_url):
                return None
        request = urllib.request.Request(url, headers=headers, method="GET")
        opener = urllib.request.build_opener(NoRedirect)
        with opener.open(request, timeout=timeout) as response:
            return json.loads(response.read(3_000_001))

    def _get(self, path, params=None, signed=False):
        params = dict(params or {})
        headers = {"Accept": "application/json"}
        if signed:
            if not self.api_key or not self.api_secret:
                raise ExchangeError("not_configured", "API-sleutel of geheim ontbreekt in de beveiligde procesinstellingen.")
            params["timestamp"] = int(time.time() * 1000)
            params["recvWindow"] = 5000
            query = urllib.parse.urlencode(params)
            params["signature"] = hmac.new(self.api_secret.encode(), query.encode(), hashlib.sha256).hexdigest()
            headers["X-MBX-APIKEY"] = self.api_key
        query = urllib.parse.urlencode(params)
        url = f"{self.base_url}{path}" + (f"?{query}" if query else "")
        try:
            result = self.transport(url, headers, self.timeout_seconds)
        except TimeoutError:
            raise ExchangeError("timeout", "De exchange reageert te langzaam. Probeer het later opnieuw.") from None
        except urllib.error.HTTPError as exc:
            code = "credentials_invalid" if exc.code in (401, 403) else "exchange_unavailable"
            raise ExchangeError(code, "De exchange heeft het leesverzoek geweigerd. Controleer de sleutel, rechten en gekozen omgeving.") from None
        except (urllib.error.URLError, OSError):
            raise ExchangeError("exchange_unavailable", "De exchange is niet bereikbaar. Controleer de internetverbinding en probeer opnieuw.") from None
        except (json.JSONDecodeError, ValueError):
            raise ExchangeError("invalid_response", "De exchange stuurde een onleesbaar antwoord.") from None
        if isinstance(result, dict) and "code" in result and result.get("code", 0) < 0:
            message = "De exchange wees de verbinding af. Controleer API-rechten, klok en testnet/live-instelling."
            raise ExchangeError("credentials_invalid" if result.get("code") in (-2014, -2015) else "exchange_error", message)
        return result

    def test_connection(self):
        if not self.api_key or not self.api_secret:
            raise ExchangeError("not_configured", "API-sleutel en API-geheim zijn nog niet ingesteld.")
        self._get("/api/v3/ping")
        account = self._get("/api/v3/account", {"omitZeroBalances": "true"}, signed=True)
        return {"connected": True, "readOnly": True, "exchange": self.name,
                "mode": "TESTNET" if self.sandbox else "LIVE ACCOUNT",
                "balances": self._balances(account), "lastSuccess": int(time.time() * 1000),
                "tradingEnabled": False, "withdrawalsEnabled": False, "transfersEnabled": False}

    @staticmethod
    def _balances(account):
        rows = account.get("balances", []) if isinstance(account, dict) else []
        clean = []
        for row in rows:
            if not isinstance(row, dict): continue
            asset = row.get("asset")
            try: free, locked = float(row.get("free", 0)), float(row.get("locked", 0))
            except (ValueError, TypeError): continue
            if isinstance(asset, str) and asset.isalnum() and len(asset) <= 20 and free >= 0 and locked >= 0 and free + locked > 0:
                clean.append({"asset": asset, "free": free, "locked": locked, "total": free + locked})
        return clean

    def account(self):
        result = self._get("/api/v3/account", {"omitZeroBalances": "true"}, signed=True)
        return {"exchange": self.name, "balances": self._balances(result), "totalValuation": None,
                "valuationCurrency": None, "readOnly": True}

    def open_orders(self):
        result = self._get("/api/v3/openOrders", signed=True)
        return [{"symbol": row.get("symbol"), "side": row.get("side"), "type": row.get("type"),
                 "status": row.get("status"), "price": row.get("price"), "quantity": row.get("origQty")}
                for row in result if isinstance(row, dict)] if isinstance(result, list) else []

    def markets(self):
        data = self._get("/api/v3/exchangeInfo")
        markets = []
        for row in data.get("symbols", []) if isinstance(data, dict) else []:
            if not isinstance(row, dict) or row.get("status") != "TRADING" or row.get("isSpotTradingAllowed") is False:
                continue
            base, quote, symbol = row.get("baseAsset"), row.get("quoteAsset"), row.get("symbol")
            if all(isinstance(x, str) and x.isalnum() for x in (base, quote, symbol)):
                markets.append({"symbol": symbol, "base": base, "quote": quote})
        return markets


def create_provider():
    # The standard app never persists account credentials. An optional
    # launcher may supply process-only environment values for this session.
    import os
    provider_name = os.environ.get("EXCHANGE_PROVIDER", "").strip().lower()
    api_key = os.environ.get("EXCHANGE_API_KEY", "")
    api_secret = os.environ.get("EXCHANGE_API_SECRET", "")
    if not provider_name and not api_key and not api_secret:
        return None
    if provider_name != "binance_spot":
        raise ExchangeError("provider_unsupported", "Deze exchangeprovider wordt nog niet ondersteund.")
    sandbox = os.environ.get("EXCHANGE_SANDBOX", "").lower() in {"1", "true", "yes"}
    return BinanceSpotReadOnly(api_key, api_secret, sandbox)


def assert_action_blocked(action, mode="LIVE", user_confirmed=False):
    """Fail closed: Phase 8 has no execution path in any mode."""
    allowed = {"status", "test_connection", "account", "balances", "open_orders", "markets", "exchange_info"}
    if action not in allowed:
        raise ExchangeError("action_blocked", "Echte orders en geldbewegingen zijn uitgeschakeld in Fase 8.")
    if mode not in {"PAPER", "TESTNET", "LIVE"}:
        raise ExchangeError("mode_blocked", "Onbekende accountmodus; actie geblokkeerd.")
    return True

