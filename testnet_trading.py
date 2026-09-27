"""Fail-closed Binance Spot TESTNET-only order workflow.

This module deliberately has no LIVE host and no withdrawal/transfer methods.
All transport calls in tests are mocked.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import math
import os
import re
import shutil
import sqlite3
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from decimal import Decimal, InvalidOperation, ROUND_DOWN
from contextlib import contextmanager
from pathlib import Path

from exchange_layer import ExchangeError


class TestnetError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code, self.message = code, message


class BinanceSpotTestnet:
    """Dedicated adapter: fixed testnet host and explicitly enumerated endpoints."""
    name = "Binance Spot Testnet"
    base_url = "https://testnet.binance.vision"
    timeout_seconds = 8
    allowed = {
        ("GET", "/api/v3/account"), ("GET", "/api/v3/ticker/price"),
        ("GET", "/api/v3/time"),
        ("GET", "/api/v3/account/commission"),
        ("GET", "/api/v3/exchangeInfo"), ("GET", "/api/v3/order"),
        ("GET", "/api/v3/ticker/24hr"),
        ("GET", "/api/v3/openOrders"), ("POST", "/api/v3/order"),
        ("POST", "/api/v3/orderList/otoco"),
        ("GET", "/api/v3/orderList"), ("GET", "/api/v3/openOrderList"),
        ("GET", "/api/v3/myTrades"),
        ("GET", "/api/v3/klines"),
        ("GET", "/api/v3/aggTrades"),
    }

    def __init__(self, api_key, api_secret, transport=None):
        if not api_key or not api_secret:
            raise TestnetError("not_configured", "Voor Testnet ontbreken de tijdelijke sleutelgegevens.")
        self.api_key, self.api_secret = api_key, api_secret
        self.transport = transport or self._transport
        self._server_offset_ms = None
        self._server_time_checked = 0.0

    @staticmethod
    def _transport(method, url, headers, timeout, body=None):
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, hdrs, new_url): return None
        req = urllib.request.Request(url, data=body.encode("ascii") if body is not None else None, headers=headers, method=method)
        with urllib.request.build_opener(NoRedirect).open(req, timeout=timeout) as response:
            return json.loads(response.read(1_000_001))

    def request(self, method, path, params=None, signed=True):
        method = method.upper()
        if (method, path) not in self.allowed:
            raise TestnetError("endpoint_blocked", "Deze exchangeactie is niet toegestaan.")
        values = dict(params or {})
        headers = {"Accept": "application/json", "X-MBX-APIKEY": self.api_key}
        if signed:
            self._refresh_server_offset()
            values.update(timestamp=int(time.time() * 1000) + self._server_offset_ms, recvWindow=5000)
            query = urllib.parse.urlencode(values)
            values["signature"] = hmac.new(self.api_secret.encode(), query.encode(), hashlib.sha256).hexdigest()
        query = urllib.parse.urlencode(values)
        url = self.base_url + path
        if method == "GET" and query:
            url += "?" + query
        elif method != "GET":
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        try:
            result = self.transport(method, url, headers, self.timeout_seconds, query if method != "GET" else None)
        except TypeError:
            # Four-argument injectable transport remains convenient for GET-only test doubles.
            if method != "GET":
                raise TestnetError("transport_invalid", "De Testnet-verbinding kan deze veilige aanvraag niet uitvoeren.") from None
            result = self.transport(url, headers, self.timeout_seconds)
        except urllib.error.HTTPError as exc:
            # HTTPError subclasses URLError, so it must be handled before network failures.
            try: error_data = json.loads(exc.read(100_000))
            except Exception: error_data = {}
            if method == "GET" and path == "/api/v3/order" and isinstance(error_data, dict) and error_data.get("code") == -2013:
                raise TestnetError("order_not_found", "De unieke Testnet-clientorder is nog niet aangemaakt.") from None
            if exc.code in (418, 429):
                raise TestnetError("rate_limited", "Testnet heeft een rate limit gemeld; wacht volgens de Retry-After-respons voordat je opnieuw controleert.") from None
            if exc.code in (401, 403):
                raise TestnetError("authentication_failed", "Testnet heeft de accountaanvraag niet geautoriseerd; controleer Testnet-sleutel en rechten.") from None
            code = error_data.get("code") if isinstance(error_data, dict) else None
            if isinstance(code, int) and code <= -1000:
                raise TestnetError("exchange_rejected", "Testnet heeft de aanvraag afgewezen; controleer de status voordat je verdergaat.") from None
            # Any HTTP failure on a write is treated as an uncertain outcome.
            if method != "GET":
                raise TestnetError("outcome_unknown", "Testnet gaf een HTTP-fout op een schrijfaanvraag. Controleer eerst de orderstatus; er wordt niets opnieuw verstuurd.") from None
            raise TestnetError("exchange_unavailable", "Testnet heeft de leesaanvraag geweigerd.") from None
        except (TimeoutError, urllib.error.URLError, OSError):
            code = "outcome_unknown" if method != "GET" else "exchange_unavailable"
            message = "Geen antwoord van Testnet. De orderstatus moet eerst worden gecontroleerd; er wordt niets opnieuw verstuurd." if method != "GET" else "Testnet is niet bereikbaar voor een leesaanvraag."
            raise TestnetError(code, message) from None
        except Exception:
            raise TestnetError("exchange_unavailable", "Testnet gaf geen veilig leesbaar antwoord.") from None
        if isinstance(result, dict) and isinstance(result.get("code"), int) and result["code"] < 0:
            if path == "/api/v3/order" and result.get("code") == -2013:
                raise TestnetError("order_not_found", "De unieke Testnet-clientorder is nog niet aangemaakt.")
            if method != "GET" and -1099 <= result["code"] <= -1000:
                raise TestnetError("outcome_unknown", "Testnet gaf een onzekere schrijfstatus terug. Controleer eerst de orderstatus; er wordt niets opnieuw verstuurd.")
            raise TestnetError("exchange_rejected", "Testnet heeft de aanvraag geweigerd.")
        if not isinstance(result, (dict, list)):
            raise TestnetError("invalid_response", "Testnet gaf een ongeldige reactie.")
        return result

    def server_time(self):
        result = self.request("GET", "/api/v3/time", signed=False)
        try:
            value = int(result["serverTime"])
            if value <= 0:
                raise ValueError()
            return value
        except (KeyError, TypeError, ValueError):
            raise TestnetError("invalid_response", "Testnet gaf geen geldige serverklok terug.") from None

    def _refresh_server_offset(self):
        now_mono = time.monotonic()
        if self._server_offset_ms is not None and now_mono - self._server_time_checked < 30:
            return
        before = int(time.time() * 1000)
        server = self.server_time()
        after = int(time.time() * 1000)
        if after < before or after - before > 10_000:
            raise TestnetError("server_time_unavailable", "De Testnet-klokmeting was te traag; signed request geblokkeerd.")
        self._server_offset_ms = server - (before + after) // 2
        self._server_time_checked = time.monotonic()

    def account(self):
        result = self.request("GET", "/api/v3/account", {"omitZeroBalances": "true"})
        if not isinstance(result, dict) or not isinstance(result.get("balances"), list):
            raise TestnetError("invalid_response", "Testnet-accountrespons mist de balanslijst.")
        for row in result["balances"]:
            try:
                if not isinstance(row, dict) or not isinstance(row.get("asset"), str):
                    raise ValueError()
                free, locked = float(row["free"]), float(row["locked"])
                if not math.isfinite(free) or not math.isfinite(locked) or free < 0 or locked < 0:
                    raise ValueError()
            except (KeyError, TypeError, ValueError):
                raise TestnetError("invalid_response", "Testnet-balans bevat ontbrekende of ongeldige velden.") from None
        return result

    def commission(self, symbol):
        return self.request("GET", "/api/v3/account/commission", {"symbol": symbol})

    def fresh_price(self, symbol):
        result = self.request("GET", "/api/v3/ticker/24hr", {"symbol": symbol}, signed=False)
        value, at = float(result["lastPrice"]), int(result["closeTime"])
        if not 0 < value < 10_000_000 or at <= 0: raise ValueError()
        return value, at

    def price(self, symbol):
        return self.fresh_price(symbol)[0]

    def symbol_info(self, symbol):
        data = self.request("GET", "/api/v3/exchangeInfo", {"symbol": symbol}, signed=False)
        rows = data.get("symbols", []) if isinstance(data, dict) else []
        row = next((x for x in rows if x.get("symbol") == symbol and x.get("status") == "TRADING"), None)
        if not row or row.get("isSpotTradingAllowed") is not True:
            raise TestnetError("market_unavailable", "Dit Testnet-paar is niet beschikbaar voor spotorders.")
        if row.get("baseAsset") != symbol[:-4] or row.get("quoteAsset") != "USDT":
            raise TestnetError("invalid_response", "Testnet-paar en base/quote assets komen niet overeen.")
        return row

    def find_order(self, symbol, client_id):
        return self.request("GET", "/api/v3/order", {"symbol": symbol, "origClientOrderId": client_id})

    def order_by_id(self, symbol, order_id):
        return self.request("GET", "/api/v3/order", {"symbol": symbol, "orderId": order_id})

    def submit_bracket(self, params):
        return self.request("POST", "/api/v3/orderList/otoco", params)

    def submit_order(self, params):
        return self.request("POST", "/api/v3/order", params)

    def open_orders(self, symbol=None):
        return self.request("GET", "/api/v3/openOrders", {"symbol": symbol} if symbol else {})

    def open_order_lists(self):
        return self.request("GET", "/api/v3/openOrderList")

    def order_list(self, **params):
        return self.request("GET", "/api/v3/orderList", params)

    def trades(self, symbol, order_id):
        return self.request("GET", "/api/v3/myTrades", {"symbol": symbol, "orderId": order_id, "limit": 1000})

    def account_trades(self, symbol, **params):
        return self.request("GET", "/api/v3/myTrades", {"symbol": symbol, **params})

    def price_at(self, symbol, timestamp):
        rows = self.request("GET", "/api/v3/aggTrades", {"symbol": symbol, "startTime": int(timestamp)-60_000, "endTime": int(timestamp)+60_000, "limit": 1000}, signed=False)
        if not isinstance(rows, list) or not rows:
            raise TestnetError("fee_conversion_unavailable", "Historische fee-omrekening ontbreekt.")
        nearest = min(rows, key=lambda row: abs(int(row.get("T", 0))-int(timestamp)))
        if abs(int(nearest.get("T",0))-int(timestamp)) > 5_000:
            raise TestnetError("fee_conversion_unavailable", "Geen voldoende nabije historische fee-koers beschikbaar.")
        price = float(nearest["p"])
        if not 0 < price < 10_000_000:
            raise TestnetError("fee_conversion_unavailable", "Historische fee-omrekening is ongeldig.")
        return price


class TestnetOrderService:
    """Two-step user-confirmed Testnet workflow with server-side second risk check."""
    # Conservative Fase 7 baseline (USDT quote valuation); no client-provided overrides.
    FEE_RATE = .001
    SYMBOL = re.compile(r"^[A-Z0-9]{2,20}USDT$")

    def __init__(self, provider, db_path=None, clock=None):
        if not isinstance(provider, BinanceSpotTestnet):
            raise TestnetError("mode_blocked", "Orderuitvoering is uitsluitend voor expliciet gekozen Testnet beschikbaar.")
        self.provider = provider
        self.clock = clock or (lambda: int(time.time() * 1000))
        self.db_path = str(db_path or Path(__file__).parent / "outputs" / "testnet_ledger.sqlite3")
        source_profiles = (Path(__file__).parent / "src" / "risk-profiles.js").read_text(encoding="utf-8")
        match = re.search(r"globalThis\.PHASE7_RISK_PROFILES\s*=\s*(\{.*\})\s*;", source_profiles)
        if not match:
            raise TestnetError("risk_settings_invalid", "Gedeelde Fase 7-risicoprofielen ontbreken.")
        self.phase7_profiles = json.loads(match.group(1))
        self.prepared_order_ttl_ms = 15 * 60 * 1000
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        with self._db() as db:
            db.execute("CREATE TABLE IF NOT EXISTS orders (client_id TEXT PRIMARY KEY, symbol TEXT, payload TEXT, state TEXT, created INTEGER, updated INTEGER, exchange_json TEXT)")
            db.execute("CREATE TABLE IF NOT EXISTS ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT, payload TEXT, created INTEGER)")
            db.execute("CREATE TABLE IF NOT EXISTS fills (symbol TEXT NOT NULL, trade_id TEXT NOT NULL, client_id TEXT NOT NULL, order_id TEXT, side TEXT NOT NULL, quantity REAL NOT NULL, price REAL NOT NULL, quote_quantity REAL NOT NULL, fee REAL, fee_asset TEXT, time INTEGER NOT NULL, PRIMARY KEY(symbol, trade_id))")
            db.execute("CREATE INDEX IF NOT EXISTS fills_client_id ON fills(client_id)")
            columns = {row[1] for row in db.execute("PRAGMA table_info(fills)")}
            if "fee_quote" not in columns:
                db.execute("ALTER TABLE fills ADD COLUMN fee_quote REAL")
            db.execute("CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS children (order_id TEXT PRIMARY KEY, symbol TEXT NOT NULL, client_id TEXT NOT NULL, side TEXT NOT NULL, exchange_json TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS cash_movements (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, trade_id TEXT NOT NULL, delta_usdt REAL NOT NULL, UNIQUE(symbol,trade_id))")

    @staticmethod
    def _filters(info):
        return {item.get("filterType"): item for item in info.get("filters", []) if isinstance(item, dict)}

    @staticmethod
    def _aligned(value, step):
        try:
            val, increment = Decimal(str(value)), Decimal(str(step))
            return increment > 0 and val % increment == 0
        except (InvalidOperation, TypeError, ValueError):
            return False

    def _validate_market_order(self, info, qty, price, stop=None, target=None, market=False):
        order_types = info.get("orderTypes")
        required_types = {"MARKET"} if market else {"LIMIT", "LIMIT_MAKER", "STOP_LOSS_LIMIT"}
        if (not isinstance(order_types, list) or not required_types.issubset(set(order_types))
                or (not market and (info.get("otoAllowed") is not True or info.get("ocoAllowed") is not True))):
            raise TestnetError("market_unavailable", "Testnet-markt bevestigt niet alle ordertypen/beschermorders die deze order vereist.")
        filters = self._filters(info)
        lot = (filters.get("MARKET_LOT_SIZE") or filters.get("LOT_SIZE") or {}) if market else (filters.get("LOT_SIZE") or {})
        price_filter = filters.get("PRICE_FILTER") or {}
        notional = filters.get("NOTIONAL") or filters.get("MIN_NOTIONAL") or {}
        minimum = Decimal(str(notional.get("minNotional", "0")))
        if not self._aligned(qty, lot.get("stepSize", "0")):
            raise TestnetError("market_filter", "Hoeveelheid voldoet niet aan de exchange-stapgrootte.")
        q = Decimal(str(qty))
        if q < Decimal(str(lot.get("minQty", "0"))) or (Decimal(str(lot.get("maxQty", "0"))) > 0 and q > Decimal(str(lot["maxQty"]))):
            raise TestnetError("market_filter", "Hoeveelheid valt buiten de toegestane exchangegrenzen.")
        if market and notional.get("applyToMarket") is False and notional.get("applyMinToMarket") is False and q * Decimal(str(price)) < minimum:
            raise TestnetError("market_filter", "MARKET-orderwaarde is lager dan het exchange-minimum.")
        maximum = Decimal(str(notional.get("maxNotional", "0")))
        if maximum > 0 and (not market or notional.get("applyMaxToMarket") is not False) and q * Decimal(str(price)) > maximum:
            raise TestnetError("market_filter", "Orderwaarde overschrijdt het exchange-maximum.")
        for value in [price, stop, target]:
            if value is not None and not self._aligned(value, price_filter.get("tickSize", "0")):
                raise TestnetError("market_filter", "Prijs, stop-loss of take-profit voldoet niet aan de exchange-prijstick.")
            if value is not None:
                dec = Decimal(str(value))
                min_price, max_price = Decimal(str(price_filter.get("minPrice", "0"))), Decimal(str(price_filter.get("maxPrice", "0")))
                if dec < min_price or (max_price > 0 and dec > max_price):
                    raise TestnetError("market_filter", "Prijs valt buiten de exchange-prijsgrenzen.")
        if not market and q * Decimal(str(price)) < minimum:
            raise TestnetError("market_filter", "Orderwaarde is lager dan het exchange-minimum.")
        open_orders = getattr(self, "_last_snapshot", {}).get("openOrders", [])
        expected_orders, expected_algo = (1, 0) if market else (3, 2)
        max_orders = filters.get("MAX_NUM_ORDERS", {}).get("maxNumOrders")
        if max_orders is not None and len(open_orders) + expected_orders > int(max_orders):
            raise TestnetError("market_filter", "Exchange-limiet voor gelijktijdige orders wordt overschreden.")
        max_algo = filters.get("MAX_NUM_ALGO_ORDERS", {}).get("maxNumAlgoOrders")
        current_algo = sum(1 for order in open_orders if order.get("type") in {"STOP_LOSS", "STOP_LOSS_LIMIT", "TAKE_PROFIT", "TAKE_PROFIT_LIMIT"})
        if max_algo is not None and current_algo + expected_algo > int(max_algo):
            raise TestnetError("market_filter", "Exchange-limiet voor beschermende/algo-orders wordt overschreden.")

    @staticmethod
    def _commission_rate(response):
        """Use the highest non-discounted taker/buyer/seller commission components."""
        if not isinstance(response, dict):
            raise TestnetError("commission_unavailable", "Testnet-commissietarief ontbreekt; order geblokkeerd.")
        total = 0.0
        for name in ("standardCommission", "specialCommission", "taxCommission"):
            group = response.get(name)
            if not isinstance(group, dict):
                raise TestnetError("commission_unavailable", "Testnet-commissietarief is onvolledig; order geblokkeerd.")
            try:
                vals = [float(group[key]) for key in ("maker", "taker", "buyer", "seller")]
            except (KeyError, TypeError, ValueError):
                raise TestnetError("commission_unavailable", "Testnet-commissietarief is ongeldig; order geblokkeerd.") from None
            if any(not math.isfinite(v) or v < 0 or v > .1 for v in vals):
                raise TestnetError("commission_unavailable", "Testnet-commissietarief valt buiten veilige grenzen.")
            total += max(vals[0], vals[1]) + max(vals[2], vals[3])
        if not math.isfinite(total) or total > .1:
            raise TestnetError("commission_unavailable", "Testnet-commissietarief valt buiten veilige grenzen.")
        return total

    @contextmanager
    def _db(self):
        db = sqlite3.connect(self.db_path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            yield db
            db.commit()
        finally:
            db.close()

    def _fresh_price(self, symbol):
        try:
            value, at = self.provider.fresh_price(symbol)
            age = self.clock() - at
            if not 0 < value < 10_000_000 or age < -5000 or age > 90_000:
                raise ValueError("stale")
            return value, at
        except Exception:
            raise TestnetError("stale_market_data", "Testnet-prijs ontbreekt, is verouderd of heeft geen betrouwbare tijdstempel.") from None

    def _reserved_buy_orders(self, remote_open, local_orders, exclude_client_id=None, now=None):
        """Build reservations from local intent and exchange-confirmed open BUYs.

        Fill-backed inventory remains in ``positions``; this list contains only
        unfilled remainder or locally prepared intent, for the shared Phase 7
        engine to include in its existing risk calculation.
        """
        now = self.clock() if now is None else now
        remote_by_id = {}
        for item in remote_open:
            if not isinstance(item, dict):
                raise TestnetError("reconciliation_required", "Open-orderinformatie is ongeldig; instaporder geblokkeerd.")
            client_id = item.get("clientOrderId")
            if isinstance(client_id, str):
                remote_by_id[client_id] = item
        reservations, reasons = [], []
        with self._db() as db:
            for row in local_orders:
                client_id, state = row["client_id"], row["state"]
                if client_id == exclude_client_id:
                    continue
                payload = json.loads(row["payload"] or "{}")
                if payload.get("side") != "BUY":
                    continue
                if state in {"PREPARED", "CONFIRMING"} and now - int(row["created"] or 0) > self.prepared_order_ttl_ms:
                    db.execute("UPDATE orders SET state='EXPIRED_LOCAL',updated=? WHERE client_id=? AND state=?",
                               (now, client_id, state))
                    continue
                if state not in {"PREPARED", "CONFIRMING", "SENDING", "UNKNOWN", "NEW", "PARTIALLY_FILLED"}:
                    continue
                remote = remote_by_id.get(client_id)
                if remote is None and state in {"PREPARED", "CONFIRMING"}:
                    quantity, price = payload.get("quantity"), payload.get("price")
                    local_only = True
                elif remote is None:
                    reasons.append(f"Status van open BUY-order {client_id} kon niet met de exchange worden bevestigd.")
                    continue
                else:
                    if (remote.get("symbol") != row["symbol"] or remote.get("side") != "BUY"
                            or remote.get("status") not in {"NEW", "PARTIALLY_FILLED"}):
                        reasons.append(f"Exchangegegevens van open BUY-order {client_id} komen niet overeen.")
                        continue
                    try:
                        original = float(remote["origQty"])
                        executed = float(remote.get("executedQty", 0))
                        quantity = original - executed
                        price = float(remote["price"])
                        if not all(math.isfinite(x) for x in (original, executed, quantity, price)) or original <= 0 or executed < 0 or executed > original or price <= 0:
                            raise ValueError()
                    except (KeyError, TypeError, ValueError, OverflowError):
                        reasons.append(f"Hoeveelheid of limietprijs van open BUY-order {client_id} ontbreekt of is ongeldig.")
                        continue
                    local_only = False
                stop = payload.get("stopLoss")
                try:
                    quantity, price, stop = float(quantity), float(price), float(stop)
                    if not all(math.isfinite(x) for x in (quantity, price, stop)) or quantity <= 0 or price <= 0 or stop <= 0 or stop >= price:
                        raise ValueError()
                    fee_rate = float(payload.get("commissionRate", self.FEE_RATE))
                    if not math.isfinite(fee_rate) or fee_rate < 0 or fee_rate > .1:
                        raise ValueError()
                except (TypeError, ValueError, OverflowError):
                    reasons.append(f"Risico-informatie van open BUY-order {client_id} is onbekend of ongeldig.")
                    continue
                reservations.append({"clientOrderId": client_id, "symbol": row["symbol"],
                    "quantity": quantity, "price": price, "stopLoss": stop,
                    "feePercent": fee_rate * 100, "localOnly": local_only})
        return reservations, reasons

    def _snapshot(self, exclude_client_id=None):
        account = self.provider.account()
        balances = {r["asset"]: float(r["free"]) + float(r["locked"]) for r in account.get("balances", [])}
        self._last_free_balances = {r["asset"]: float(r["free"]) for r in account.get("balances", [])}
        remote_open = self.provider.open_orders()
        if not isinstance(remote_open, list):
            raise TestnetError("reconciliation_required", "Openstaande Testnet-orders konden niet veilig worden gesynchroniseerd.")
        remote_lists = self.provider.open_order_lists()
        if not isinstance(remote_lists, list) or any(not isinstance(x, dict) or x.get("orderListId") is None for x in remote_lists):
            raise TestnetError("reconciliation_required", "Testnet order-lists konden niet veilig worden gesynchroniseerd.")
        with self._db() as db:
            local_orders = db.execute("SELECT client_id,symbol,payload,state,created,exchange_json FROM orders").fetchall()
            local_ids = {r["client_id"] for r in local_orders}
            known_bases = {r["symbol"][:-4] for r in local_orders if r["symbol"] and r["symbol"].endswith("USDT")}
            local_order_data = [json.loads(r["exchange_json"] or "{}") for r in local_orders]
        known_list_ids = {str(item["orderListId"]) for item in local_order_data if item.get("orderListId") is not None}
        unknown_lists = [item for item in remote_lists if str(item.get("orderListId")) not in known_list_ids]
        unknown_open = [x for x in remote_open if not any(str(x.get("clientOrderId", "")).startswith(cid) for cid in local_ids)]
        reservations, reservation_reasons = self._reserved_buy_orders(remote_open, local_orders, exclude_client_id)
        marked = []
        equity = balances.get("USDT", 0)
        reconciliation_reasons = list(reservation_reasons)
        if unknown_open:
            reconciliation_reasons.append("Er zijn niet-herkende open exchange-orders.")
        if unknown_lists:
            reconciliation_reasons.append("Er zijn niet-herkende open exchange-order-lists.")
        reconciliation = bool(reconciliation_reasons)
        local_positions = {x["symbol"][:-4]: x for x in self._positions()}
        known_bases.update(local_positions)
        for asset in known_bases:
            actual = balances.get(asset, 0)
            expected = local_positions.get(asset, {}).get("quantity", 0)
            if abs(actual - expected) > max(1e-8, max(actual, expected) * 1e-6):
                reconciliation = True
        fee_assets = set()
        with self._db() as db:
            fee_assets = {r[0] for r in db.execute("SELECT DISTINCT fee_asset FROM fills WHERE fee_asset IS NOT NULL").fetchall()}
        unknown_assets = []
        for asset, amount in balances.items():
            if asset == "USDT" or amount <= 1e-12 or asset in known_bases:
                continue
            try:
                asset_price = self.provider.price(asset + "USDT")
                value = amount * asset_price
                equity += value
                unknown_assets.append({"asset":asset,"quantity":amount,"valueUSDT":value,"knownFeeAsset":asset in fee_assets})
            except Exception:
                unknown_assets.append({"asset":asset,"quantity":amount,"valueUSDT":None,"knownFeeAsset":asset in fee_assets})
            reconciliation = True
        for position in self._positions():
            try:
                price, _ = self._fresh_price(position["symbol"])
            except Exception:
                reconciliation = True
                continue
            marked.append(dict(position, markPrice=price, marketValue=position["quantity"] * price,
                               unrealizedPnl=position["quantity"] * price - position["cost"]))
            equity += position["quantity"] * price
            actual = balances.get(position["symbol"][:-4], 0)
            if abs(actual - position["quantity"]) > max(1e-8, position["quantity"] * 1e-6):
                reconciliation = True
            reconciliation = reconciliation or position["reconciliationRequired"]
        now = self.clock()
        day_key = time.strftime("%Y-%m-%d", time.localtime(now / 1000))
        usdt_balance = balances.get("USDT", 0.0)
        with self._db() as db:
            anchor = db.execute("SELECT value FROM state WHERE key='usdt_anchor_balance'").fetchone()
            cursor = db.execute("SELECT value FROM state WHERE key='usdt_anchor_cashflow_id'").fetchone()
            sticky_usdt = db.execute("SELECT value FROM state WHERE key='usdt_reconciliation_required'").fetchone()
            if anchor is None or cursor is None:
                last_flow = db.execute("SELECT COALESCE(MAX(id),0) FROM cash_movements").fetchone()[0]
                db.execute("INSERT INTO state(key,value) VALUES('usdt_anchor_balance',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (str(usdt_balance),))
                db.execute("INSERT INTO state(key,value) VALUES('usdt_anchor_cashflow_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (str(last_flow),))
                expected_usdt = usdt_balance
            else:
                known_delta = db.execute("SELECT COALESCE(SUM(delta_usdt),0) FROM cash_movements WHERE id>?", (int(cursor[0]),)).fetchone()[0]
                expected_usdt = float(anchor[0]) + float(known_delta)
                tolerance = max(1e-7, abs(expected_usdt) * 1e-10)
                if abs(usdt_balance - expected_usdt) > tolerance:
                    message = "USDT-balans wijkt af van de opgeslagen basis plus exchange-bevestigde fills; oorzaak onbekend."
                    db.execute("INSERT INTO state(key,value) VALUES('usdt_reconciliation_required','1') ON CONFLICT(key) DO UPDATE SET value='1'")
                    db.execute("INSERT INTO state(key,value) VALUES('usdt_reconciliation_reason',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (message,))
                    sticky_usdt = ("1",)
            if sticky_usdt and sticky_usdt[0] == "1":
                reconciliation = True
                stored_reason = db.execute("SELECT value FROM state WHERE key='usdt_reconciliation_reason'").fetchone()
                reconciliation_reasons.append(stored_reason[0] if stored_reason else "USDT-balans vereist handmatige reconciliatie; oorzaak onbekend.")
            if reconciliation and not reconciliation_reasons:
                reconciliation_reasons.append("Account- of fillgegevens vereisen reconciliatie; oorzaak niet vastgesteld.")
            state_peak = float((db.execute("SELECT value FROM state WHERE key='portfolio_peak'").fetchone() or ["0"])[0])
            legacy_peak = max([float(data.get("equity", 0)) for data in
                               (json.loads(r[0]) for r in db.execute("SELECT payload FROM ledger WHERE event='EQUITY'").fetchall())
                               if not data.get("reconciliationRequired")] + [0])
            old_peak = max(state_peak, legacy_peak)
            peak = old_peak if reconciliation else max(old_peak, equity)
            if not reconciliation:
                db.execute("INSERT INTO state(key,value) VALUES('portfolio_peak',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (str(peak),))
            old_day = db.execute("SELECT value FROM state WHERE key='daily_date'").fetchone()
            if (not old_day or old_day[0] != day_key) and not reconciliation:
                db.execute("INSERT INTO state(key,value) VALUES('daily_date',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (day_key,))
                db.execute("INSERT INTO state(key,value) VALUES('daily_start_equity',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (str(equity),))
                db.execute("INSERT INTO state(key,value) VALUES('daily_pnl_status','LOCAL_FIRST_SYNC_ESTIMATE') ON CONFLICT(key) DO UPDATE SET value='LOCAL_FIRST_SYNC_ESTIMATE'")
                db.execute("INSERT INTO state(key,value) VALUES('daily_loss_locked','0') ON CONFLICT(key) DO UPDATE SET value='0'")
            risk_row = db.execute("SELECT value FROM state WHERE key='risk_settings'").fetchone()
            active = json.loads(risk_row[0]) if risk_row else {"profile":"balanced"}
            profile = self.phase7_profiles.get(active.get("profile", "balanced"), self.phase7_profiles["balanced"])
            daily_limit = float(active.get("dailyLossLimitPercent", profile["dailyLossLimitPercent"]))
            max_dd = float(active.get("maxDrawdownPercent", profile["maxDrawdownPercent"]))
            daily_start_row = db.execute("SELECT value FROM state WHERE key='daily_start_equity'").fetchone()
            daily_start = float(daily_start_row[0]) if daily_start_row else equity
            if equity - daily_start <= -daily_start * daily_limit / 100:
                db.execute("INSERT INTO state(key,value) VALUES('daily_loss_locked','1') ON CONFLICT(key) DO UPDATE SET value='1'")
            if peak > 0 and (peak-equity)/peak >= max_dd/100:
                db.execute("INSERT INTO state(key,value) VALUES('drawdown_lock','1') ON CONFLICT(key) DO UPDATE SET value='1'")
            daily_pnl_status = "UNAVAILABLE_RECONCILIATION" if reconciliation else "LOCAL_FIRST_SYNC_ESTIMATE"
            db.execute("INSERT INTO state(key,value) VALUES('daily_pnl_status',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (daily_pnl_status,))
            db.execute("INSERT INTO ledger(event,payload,created) VALUES('EQUITY',?,?)",
                       (json.dumps({"equity": equity, "basis": "USDT cash + fill-derived positions at fresh Testnet ticker", "reconciliationRequired": reconciliation,
                                    "reconciliationReasons": reconciliation_reasons, "dailyPnlStatus": daily_pnl_status}), now))
            db.execute("INSERT INTO state(key,value) VALUES('open_orders',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (json.dumps(remote_open),))
            db.execute("INSERT INTO state(key,value) VALUES('open_order_lists',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (json.dumps(remote_lists),))
        self._last_snapshot = {"equity": equity, "peak": peak, "positions": marked,
                               "reconciliationRequired": reconciliation, "unknownOpenOrders":unknown_open,
                               "openOrders":remote_open, "openOrderLists":remote_lists,
                               "unknownOrderLists":unknown_lists, "unknownAssets":unknown_assets,
                               "reservedBuyOrders": reservations, "reconciliationReasons": reconciliation_reasons,
                               "dailyPnlStatus": daily_pnl_status, "time": now}
        return account, balances

    def _risk_rules(self, risk=None, eur_usdt=1):
        """Translate the selected Phase 7 profile/settings into Testnet quote currency."""
        if risk is None:
            risk = {"profile": "balanced"}
        if not isinstance(risk, dict) or risk.get("profile") not in self.phase7_profiles:
            raise TestnetError("risk_settings_invalid", "Een geldig Fase 7-risicoprofiel is vereist.")
        defaults = self.phase7_profiles[risk["profile"]]
        mapping = {"risk_per_trade": "riskPerTradePercent", "max_position": "maxPositionEur",
                   "max_position_pct": "maxPositionPercent", "max_positions": "maxOpenPositions",
                   "max_exposure_pct": "maxExposurePercent", "max_open_risk_pct": "maxTotalRiskPercent",
                   "daily_loss_pct": "dailyLossLimitPercent", "max_drawdown_pct": "maxDrawdownPercent", "min_rr": "minRiskReward"}
        out = {key: defaults[name] for key, name in mapping.items()}
        for key, name in mapping.items():
            value = risk.get(name, defaults[name])
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not (0 < value <= 10000000):
                raise TestnetError("risk_settings_invalid", "Ongeldige Fase 7-risicowaarde; order geblokkeerd.")
            out[key] = value
        if not (.1 <= out["risk_per_trade"] <= 10 and 1 <= out["max_position"] <= 10000000
                and 1 <= out["max_position_pct"] <= 100 and 1 <= out["max_positions"] <= 20
                and 1 <= out["max_exposure_pct"] <= 100 and out["risk_per_trade"] <= out["max_open_risk_pct"] <= 50
                and .1 <= out["daily_loss_pct"] <= 50 and 1 <= out["max_drawdown_pct"] <= 90
                and .1 <= out["min_rr"] <= 20):
            raise TestnetError("risk_settings_invalid", "Fase 7-limieten vallen buiten de toegestane instellingen.")
        if out["max_positions"] != int(out["max_positions"]):
            raise TestnetError("risk_settings_invalid", "Maximaal aantal posities moet een geheel getal zijn.")
        out["max_positions"] = int(out["max_positions"])
        if not isinstance(eur_usdt, (int, float)) or not 0 < eur_usdt < 10:
            raise TestnetError("fx_unavailable", "Actuele EUR/USDT-koers ontbreekt; Fase 7-positielimiet kan niet veilig worden omgerekend.")
        out["max_position"] *= eur_usdt
        out["fee_rate"] = getattr(self, "_last_commission_rate", self.FEE_RATE)
        return out

    def _positions(self, include_closed=False):
        """Average-cost inventory derived only from persisted exchange-confirmed fills."""
        with self._db() as db:
            rows = db.execute("SELECT * FROM fills ORDER BY time,rowid").fetchall()
        with self._db() as db:
            order_rows = db.execute("SELECT client_id,payload,exchange_json FROM orders").fetchall()
        order_payloads = {r["client_id"]: json.loads(r["payload"]) for r in order_rows}
        order_details = {r["client_id"]: json.loads(r["exchange_json"] or "{}") for r in order_rows}
        result = {}
        for row in rows:
            symbol, base, quote = row["symbol"], row["symbol"][:-4], "USDT"
            position = result.setdefault(symbol, {"symbol": symbol, "quantity": 0.0, "cost": 0.0, "realizedPnl": 0.0, "fees": {}, "reconciliationRequired": False})
            qty, quote_qty = float(row["quantity"]), float(row["quote_quantity"])
            fee_raw = row["fee"]
            fee = float(fee_raw or 0)
            fee_asset = row["fee_asset"]
            fee_quote = row["fee_quote"] if "fee_quote" in row.keys() else None
            if fee_raw is None or (fee > 0 and not fee_asset):
                position["reconciliationRequired"] = True
            elif fee_asset == base:
                if row["side"] == "BUY": qty -= fee
                else: qty += fee
            elif fee_asset == quote:
                fee_quote = fee if fee_quote is None else fee_quote
            elif fee_asset in (None, "") and fee == 0:
                fee_quote = 0 if fee_quote is None else fee_quote
            else:
                if fee_quote is None:
                    position["reconciliationRequired"] = True
            if fee_asset:
                position["fees"][fee_asset] = position["fees"].get(fee_asset, 0) + fee
            if row["side"] == "BUY":
                position["quantity"] += qty
                position["cost"] += quote_qty + (fee_quote or 0)
                stop = order_payloads.get(row["client_id"], {}).get("stopLoss")
                if isinstance(stop, (int, float)) and stop > 0:
                    position["stopLoss"] = max(float(stop), float(position.get("stopLoss", 0)))
                    position["protection"] = order_details.get(row["client_id"], {}).get("protection", "NOT_CONFIRMED")
                    position["reconciliationRequired"] = position["reconciliationRequired"] or bool(
                        order_details.get(row["client_id"], {}).get("reconciliationRequired"))
            else:
                if qty > position["quantity"] + 1e-10:
                    position["reconciliationRequired"] = True
                    continue
                avg = position["cost"] / position["quantity"] if position["quantity"] > 0 else 0
                sold = min(qty, position["quantity"])
                allocated = sold * avg
                proceeds = quote_qty - (fee_quote or 0)
                position["realizedPnl"] += proceeds - allocated
                position["quantity"] -= sold
                position["cost"] -= allocated
        return [dict(p, averageEntry=p["cost"] / p["quantity"] if p["quantity"] > 0 else None) for p in result.values() if include_closed or p["quantity"] > 1e-10]

    def _checks(self, p, price, balances, risk=None, eur_usdt=1):
        errors, rules = [], self._risk_rules(risk, eur_usdt)
        sym, side, qty = p.get("symbol"), p.get("side"), p.get("quantity")
        sl, tp = p.get("stopLoss"), p.get("takeProfit")
        if not isinstance(sym, str) or not self.SYMBOL.fullmatch(sym): errors.append("Ongeldig USDT-spotpaar.")
        if side not in {"BUY", "SELL"}: errors.append("Kies BUY of SELL.")
        if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0 for v in (qty, price)):
            errors.append("Hoeveelheid en prijs moeten positief zijn.")
            return errors
        if side == "BUY" and not all(isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0 for v in (sl, tp)):
            errors.append("Voor een BUY zijn een geldige stop-loss en take-profit verplicht.")
            return errors
        snap = getattr(self, "_last_snapshot", {})
        equity = max(float(snap.get("equity", balances.get("USDT", 0))), 1)
        if snap.get("reconciliationRequired"):
            reasons = "; ".join(snap.get("reconciliationReasons", []))
            errors.append("Testnet-account/feegegevens vereisen reconciliatie; order geblokkeerd." + (f" Reden: {reasons}" if reasons else ""))
        if side == "BUY" and self._state_value("drawdown_lock", "0") == "1":
            errors.append("Drawdownblokkade actief; handmatige hervatting vereist.")
        if side == "BUY":
            if not sl < price < tp: errors.append("Voor BUY moet stop-loss onder en take-profit boven de actuele prijs liggen.")
            if any(x["symbol"] == sym for x in self._positions()): errors.append("Er staat al een fill-bevestigde positie open voor dit paar.")
            if qty * price * (1 + rules["fee_rate"]) > getattr(self, "_last_free_balances", balances).get("USDT", 0): errors.append("Onvoldoende vrije USDT-balans.")
        else:
            held = next((x for x in self._positions() if x["symbol"] == sym), None)
            if not held or qty > held["quantity"] + 1e-10: errors.append("Verkoophoeveelheid is groter dan de door fills bevestigde open positie.")
            if qty > getattr(self, "_last_free_balances", balances).get(sym[:-4], 0): errors.append("Onvoldoende vrij bezit om te verkopen.")
            if held and held["reconciliationRequired"]: errors.append("Positie bevat een niet gewaardeerde fee; verkoop/P&L vereist reconciliatie.")
        if side == "BUY":
            p7 = self._phase7_check(p, price, balances, risk if isinstance(risk, dict) else p.get("riskSettings"), eur_usdt)
            if not p7["allowed"]:
                failed = ", ".join(x["rule"] for x in p7.get("checks", []) if not x.get("passed"))
                drawdown_note = "; handmatige hervatting vereist" if "maximale drawdown" in failed else ""
                errors.append("Fase 7-risk engine blokkeerde de order" + (f": {failed}{drawdown_note}." if failed else "."))
            if p7.get("drawdown", 0) * 100 >= rules["max_drawdown_pct"]:
                self._set_state("drawdown_lock", "1")
        if side == "BUY" and self._state_value("daily_loss_locked", "0") == "1":
            errors.append("Dagelijkse verlieslimiet bereikt; nieuwe orders geblokkeerd.")
        if side == "BUY" and not p.get("stopLoss"): errors.append("Verplichte stop-loss ontbreekt.")
        return errors

    def _phase7_check(self, p, price, balances, settings, eur_usdt):
        node = shutil.which("node")
        if not node:
            raise TestnetError("risk_engine_unavailable", "Node.js/Fase 7-risk engine ontbreekt; Testnet-order geblokkeerd.")
        profile = settings.get("profile", "balanced") if isinstance(settings, dict) else "balanced"
        settings = {**self.phase7_profiles[profile], **(settings or {}), "profile": profile}
        rules = self._risk_rules(settings, eur_usdt)
        fx = eur_usdt if settings else 1
        snap = getattr(self, "_last_snapshot", {})
        positions = []
        for position in snap.get("positions", []):
            positions.append({"id": position["symbol"], "symbol": position["symbol"], "quantity": position["quantity"],
                "entryPriceEur": position["averageEntry"] / fx, "entryPriceUsdt": position["averageEntry"],
                "entryNotionalEur": position["cost"] / fx, "entryFeeEur": 0,
                "lastPriceEur": position["markPrice"] / fx, "lastPriceUsdt": position["markPrice"],
                "lastPriceAt": self.clock(), "stopLossEur": (position.get("stopLoss", 0) / fx
                    if position.get("protection") == "ACTIVE_CONFIRMED" else 0),
                "takeProfitEur": 0})
        reserved_orders = [{"symbol": order["symbol"], "quantity": order["quantity"],
                            "priceEur": order["price"] / fx, "stopLossEur": order["stopLoss"] / fx,
                            "feePercent": order["feePercent"]}
                           for order in snap.get("reservedBuyOrders", [])]
        settings = settings or {"profile":"balanced"}
        price_eur = price / fx
        stop_eur, target_eur = float(p["stopLoss"]) / fx, float(p["takeProfit"]) / fx
        account = {"initialCapitalEur": max(snap.get("equity", balances.get("USDT",0)) / fx, 1),
            "cashEur": balances.get("USDT",0) / fx, "realizedProfitLossEur":0,
            "feePercent": getattr(self, "_last_commission_rate", self.FEE_RATE) * 100, "slippagePercent":0,
            "maxPositionEur":settings["maxPositionEur"], "maxPositionPercent":settings["maxPositionPercent"],
            "maxOpenPositions":settings["maxOpenPositions"], "maxExposurePercent":settings["maxExposurePercent"],
            "riskPerTradePercent":settings["riskPerTradePercent"], "maxTotalRiskPercent":settings["maxTotalRiskPercent"],
            "dailyLossLimitPercent":settings["dailyLossLimitPercent"], "maxDrawdownLimitPercent":settings["maxDrawdownPercent"],
            "minRiskReward":settings["minRiskReward"], "stopLossMode":"fixed",
            "stopLossFixedEur":price_eur-stop_eur, "stopLossPercent":0,
            "takeProfitPercent":(target_eur/price_eur-1)*100,
            "dailyStartEquityEur":float(self._state_value("daily_start_equity", str(snap.get("equity",1))))/fx,
            "dailyLossLocked":self._state_value("daily_loss_locked","0")=="1",
            "peakEquityEur":float(self._state_value("portfolio_peak",str(snap.get("peak",1))))/fx,
            "riskLock":{"reason":"drawdown"} if self._state_value("drawdown_lock","0")=="1" else None,
            "positions":positions, "reservedOrders":reserved_orders}
        request={"account":account,"item":{"symbol":p["symbol"],"priceEur":price_eur,"priceUsdt":price,
            "timestamp":self.clock(),"fresh":True},"timestamp":self.clock()}
        try:
            result=subprocess.run([node,str(Path(__file__).parent/"src"/"phase7-risk-cli.cjs")],input=json.dumps(request),
                capture_output=True,text=True,timeout=5,check=False)
            checked=json.loads(result.stdout)
        except Exception:
            raise TestnetError("risk_engine_unavailable", "Fase 7-risk engine gaf geen betrouwbare controle; order geblokkeerd.") from None
        requested_exceeds = p["quantity"] > float(checked.get("quantity",0))+1e-10
        checks = checked.get("checks", [])
        if requested_exceeds:
            checks.append({"rule":"gevraagde hoeveelheid overschrijdt de door Fase 7 berekende positiegrootte", "passed":False})
        if result.returncode != 0 or not checked.get("allowed") or requested_exceeds:
            self._set_state("daily_loss_locked","1") if checked.get("dailyPnl",0) <= -checked.get("dailyLimit",float("inf")) else None
            self._set_state("drawdown_lock","1") if checked.get("drawdown",0)*100 >= rules["max_drawdown_pct"] else None
            return {"allowed": False, "checks": checks, "drawdown": checked.get("drawdown",0),
                    "dailyPnl": checked.get("dailyPnl",0), "dailyLimit": checked.get("dailyLimit",float("inf"))}
        return {"allowed": True, "checks": checks, "drawdown": checked.get("drawdown",0),
                "dailyPnl": checked.get("dailyPnl",0), "dailyLimit": checked.get("dailyLimit",float("inf"))}

    def _state_value(self, key, default=None):
        with self._db() as db:
            row = db.execute("SELECT value FROM state WHERE key=?", (key,)).fetchone()
        return row[0] if row else default

    def _set_state(self, key, value):
        with self._db() as db:
            db.execute("INSERT INTO state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, str(value)))

    def _refresh_local_orders(self, exclude_client_id=None):
        with self._db() as db:
            rows = db.execute("SELECT client_id,state FROM orders ORDER BY created").fetchall()
        active = {"SENDING", "UNKNOWN", "NEW", "PARTIALLY_FILLED"}
        for row in rows:
            if row["client_id"] == exclude_client_id or row["state"] not in active:
                continue
            status = self.order_status(row["client_id"])
            if status.get("status") == "UNKNOWN":
                raise TestnetError("reconciliation_required", "Een eerder openstaande orderstatus is onbekend; nieuwe instaporder geblokkeerd.")

    def manual_resume(self, confirmed):
        if confirmed is not True:
            raise TestnetError("confirmation_required", "Handmatige hervatting vereist expliciete bevestiging.")
        self._snapshot()
        if self._state_value("drawdown_lock", "0") != "1":
            raise TestnetError("no_risk_lock", "Er is geen drawdownblokkade om te hervatten.")
        self._set_state("portfolio_peak", str(self._last_snapshot["equity"]))
        self._set_state("drawdown_lock", "0")

    def _sync_child_fills(self, client_id, symbol, reports):
        for child in reports if isinstance(reports, list) else []:
            order_id = child.get("orderId") if isinstance(child, dict) else None
            if order_id is None:
                continue
            side = child.get("side", "SELL")
            with self._db() as db:
                db.execute("INSERT INTO children(order_id,symbol,client_id,side,exchange_json) VALUES(?,?,?,?,?) ON CONFLICT(order_id) DO UPDATE SET exchange_json=excluded.exchange_json", (str(order_id), symbol, client_id, side, json.dumps(child)))
            try:
                rows = self.provider.trades(symbol, order_id)
            except (AttributeError, TestnetError):
                continue
            for trade in rows if isinstance(rows, list) else []:
                if not isinstance(trade, dict) or "id" not in trade:
                    continue
                qty, price = float(trade.get("qty", 0)), float(trade.get("price", 0))
                if qty <= 0 or price <= 0:
                    continue
                fee = float(trade.get("commission", 0) or 0)
                asset = trade.get("commissionAsset")
                at = int(trade.get("time", self.clock()))
                base = symbol[:-4]
                fee_quote = 0.0 if not fee or asset == base else fee if asset == "USDT" else None
                if fee and asset not in {base, "USDT", None}:
                    try: fee_quote = fee * self.provider.price_at(asset + "USDT", at)
                    except Exception: pass
                with self._db() as db:
                    db.execute("INSERT OR IGNORE INTO fills(symbol,trade_id,client_id,order_id,side,quantity,price,quote_quantity,fee,fee_asset,time,fee_quote) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                               (symbol, str(trade["id"]), client_id, str(order_id), "BUY" if trade.get("isBuyer") else "SELL", qty, price, float(trade.get("quoteQty", qty*price)), fee, asset, at, fee_quote))

    def sync(self):
        """Reconcile known orders/fills and exchange open orders after start or refresh."""
        self._refresh_local_orders()
        self._snapshot()
        with self._db() as db:
            db.execute("INSERT INTO state(key,value) VALUES('last_sync',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (str(self.clock()),))
        return self.portfolio_summary()

    def portfolio_summary(self):
        snap = getattr(self, "_last_snapshot", None)
        if snap is None:
            self._snapshot(); snap = self._last_snapshot
        positions = snap["positions"]
        with self._db() as db:
            fill_rows = db.execute("SELECT fee,fee_asset FROM fills").fetchall()
            peak_row = db.execute("SELECT value FROM state WHERE key='portfolio_peak'").fetchone()
            start_row = db.execute("SELECT value FROM state WHERE key='daily_start_equity'").fetchone()
        fees = {}
        for row in fill_rows:
            if row["fee_asset"]:
                fees[row["fee_asset"]] = fees.get(row["fee_asset"], 0) + float(row["fee"] or 0)
        peak = float(peak_row[0]) if peak_row else snap["equity"]
        drawdown = max(0, (peak - snap["equity"]) / peak * 100) if peak else 0
        daily_start = float(start_row[0]) if start_row else snap["equity"]
        with self._db() as db:
            open_orders = json.loads((db.execute("SELECT value FROM state WHERE key='open_orders'").fetchone() or ["null"])[0] or "null")
        daily_pnl = None if snap.get("reconciliationRequired") else snap["equity"] - daily_start
        return {"mode": "TESTNET", "equityUSDT": snap["equity"], "portfolioPeakUSDT": peak,
                "drawdownPercent": drawdown, "dailyPnlUSDT": daily_pnl,
                "dailyPnlStatus": snap.get("dailyPnlStatus", "LOCAL_FIRST_SYNC_ESTIMATE"),
                "realizedPnlUSDT": sum(x["realizedPnl"] for x in self._positions(include_closed=True)),
                "unrealizedPnlUSDT": sum(x["unrealizedPnl"] for x in positions),
                "openRiskUSDT": sum(max(0, x["averageEntry"] - x.get("stopLoss", 0)) * x["quantity"] for x in positions),
                "positions": positions, "feesByAsset": fees,
                "dailyLossLocked": self._state_value("daily_loss_locked", "0") == "1",
                "drawdownLocked": self._state_value("drawdown_lock", "0") == "1",
                "reconciliationRequired": snap["reconciliationRequired"], "openOrders": open_orders,
                "reconciliationReasons": snap.get("reconciliationReasons", []),
                "reservedBuyOrders": snap.get("reservedBuyOrders", []),
                "untrackedOpenOrders": snap.get("unknownOpenOrders", []), "untrackedAssets": snap.get("unknownAssets", []),
                "untrackedOrderLists": snap.get("unknownOrderLists", []),
                "lastSync": self._state_value("last_sync")}

    def prepare(self, payload):
        if not isinstance(payload, dict) or set(payload) - {"symbol", "side", "quantity", "stopLoss", "takeProfit", "riskSettings"} or not {"symbol", "side", "quantity", "stopLoss", "takeProfit"}.issubset(payload):
            raise TestnetError("invalid_order", "De ordergegevens zijn onvolledig of ongeldig.")
        side = payload.get("side")
        if side not in {"BUY", "SELL"}:
            raise TestnetError("invalid_order", "Kies BUY of SELL.")
        if side == "BUY" and (not isinstance(payload.get("stopLoss"), (int, float)) or isinstance(payload.get("stopLoss"), bool) or payload["stopLoss"] <= 0):
            raise TestnetError("risk_rejected", "Een geldige verplichte stop-loss ontbreekt.")
        if not isinstance(payload.get("quantity"), (int, float)) or isinstance(payload.get("quantity"), bool) or payload["quantity"] <= 0:
            raise TestnetError("invalid_order", "Een geldige hoeveelheid ontbreekt.")
        sym = payload.get("symbol")
        if not isinstance(sym, str) or not self.SYMBOL.fullmatch(sym): raise TestnetError("invalid_symbol", "Alleen geldige USDT spotparen zijn toegestaan.")
        risk_settings = payload.get("riskSettings") or {"profile":"balanced"}
        try:
            self._refresh_local_orders()
            info = self.provider.symbol_info(sym)
            price, price_at = self._fresh_price(sym)
            eur_usdt, _ = self._fresh_price("EURUSDT")
            self._last_commission_rate = self._commission_rate(self.provider.commission(sym))
            risk = self._risk_rules(risk_settings, eur_usdt)
            self._set_state("risk_settings", json.dumps(risk_settings))
            account, balances = self._snapshot()
        except TestnetError: raise
        except Exception: raise TestnetError("market_unavailable", "Prijs, account of marktdetails zijn niet betrouwbaar beschikbaar.") from None
        stop = payload.get("stopLoss") if side == "BUY" else None
        target = payload.get("takeProfit") if side == "BUY" else None
        self._validate_market_order(info, payload["quantity"], price, stop, target, market=side == "SELL")
        p = dict(payload, stopLoss=stop, takeProfit=target, price=price, orderType="OTOCO_LIMIT" if side == "BUY" else "MARKET_CLOSE", quote="USDT", commissionRate=risk["fee_rate"], maxRisk=float(payload["quantity"]) * (price-float(stop or price)) + float(payload["quantity"])*price*risk["fee_rate"]*2,
                 estimatedFees=float(payload["quantity"])*price*risk["fee_rate"]*2, availableBalance=balances.get("USDT", 0), priceTimestamp=price_at,
                 exchange=self.provider.name, riskSettings=risk_settings, ruleVersion="Fase 7-engine · Testnet")
        errors = self._checks(p, price, balances, risk_settings, eur_usdt)
        if errors: raise TestnetError("risk_rejected", "Order niet voorbereid: " + " ".join(errors))
        client_id = "codex" + uuid.uuid4().hex[:28]
        p["clientOrderId"] = client_id
        with self._db() as db:
            db.execute("INSERT INTO orders VALUES (?,?,?,?,?,?,?)", (client_id, sym, json.dumps(p), "PREPARED", self.clock(), self.clock(), "{}"))
        return {k: p[k] for k in ("exchange", "symbol", "side", "quantity", "price", "orderType", "stopLoss", "takeProfit", "maxRisk", "estimatedFees", "commissionRate", "availableBalance", "priceTimestamp", "clientOrderId")}

    def confirm(self, client_id, confirmed):
        if confirmed is not True: raise TestnetError("confirmation_required", "Zonder expliciete Testnet-bevestiging wordt niets verstuurd.")
        with self._db() as db:
            row = db.execute("SELECT * FROM orders WHERE client_id=?", (client_id,)).fetchone()
            if not row or row["state"] != "PREPARED": raise TestnetError("order_not_prepared", "Deze order is niet meer bevestigbaar; status veilig controleren.")
            p = json.loads(row["payload"])
            changed = db.execute("UPDATE orders SET state='CONFIRMING',updated=? WHERE client_id=? AND state='PREPARED'", (self.clock(), client_id)).rowcount
            if changed != 1: raise TestnetError("duplicate_blocked", "Deze order is al verwerkt; er wordt niets dubbel verstuurd.")
        try:
            self._refresh_local_orders(exclude_client_id=client_id)
            price, price_at = self._fresh_price(p["symbol"])
            eur_usdt, _ = self._fresh_price("EURUSDT")
            self._last_commission_rate = self._commission_rate(self.provider.commission(p["symbol"]))
            self._set_state("risk_settings", json.dumps(p.get("riskSettings") or {"profile":"balanced"}))
            _, balances = self._snapshot(exclude_client_id=client_id)
            info = self.provider.symbol_info(p["symbol"])
            self._validate_market_order(info, p["quantity"], price, p.get("stopLoss"), p.get("takeProfit"), market=p["side"] == "SELL")
            # Price movement invalidates the user's prepared screen; require a new review.
            if abs(price - float(p["price"])) / float(p["price"]) > 0.001:
                raise TestnetError("price_changed", "De prijs is sinds voorbereiding veranderd. Bereid de order opnieuw voor en controleer de nieuwe gegevens.")
            p = dict(p, price=price, priceTimestamp=price_at)
            errors = self._checks(p, price, balances, p.get("riskSettings"), eur_usdt)
            if errors: raise TestnetError("second_risk_check_failed", "Laatste veiligheidscontrole mislukt: " + " ".join(errors))
            # Verify an idempotency key before send, then submit exactly once.
            try:
                existing = self.provider.find_order(p["symbol"], client_id)
            except TestnetError as exc:
                if exc.code != "order_not_found": raise
                existing = None
            if existing:
                response = existing
            else:
                if p["side"] == "SELL":
                    with self._db() as db:
                        db.execute("UPDATE orders SET state='SENDING',updated=? WHERE client_id=? AND state='CONFIRMING'", (self.clock(), client_id))
                    response = self.provider.submit_order({"symbol": p["symbol"], "side": "SELL", "type": "MARKET",
                        "quantity": p["quantity"], "newClientOrderId": client_id})
                else:
                    # OTOCO queues protective OCO legs after the entry fills.
                    tick = Decimal(str((self._filters(info).get("PRICE_FILTER") or {}).get("tickSize", "0")))
                    stop_limit = Decimal(str(p["stopLoss"])) * Decimal("0.999")
                    if tick > 0:
                        stop_limit = (stop_limit // tick) * tick
                    if stop_limit <= 0:
                        raise TestnetError("market_filter", "De stop-limitprijs valt buiten de exchange-prijstick.")
                    params = {"symbol": p["symbol"], "workingSide": "BUY", "workingType": "LIMIT",
                          "workingTimeInForce": "GTC", "workingQuantity": p["quantity"],
                          "workingPrice": p["price"], "workingClientOrderId": client_id,
                          "pendingSide": "SELL", "pendingQuantity": p["quantity"],
                          "pendingAboveType": "LIMIT_MAKER", "pendingAbovePrice": p["takeProfit"],
                          "pendingAboveClientOrderId": client_id + "TP",
                          "pendingBelowType": "STOP_LOSS_LIMIT", "pendingBelowPrice": format(stop_limit, "f"),
                          "pendingBelowStopPrice": p["stopLoss"], "pendingBelowTimeInForce": "GTC",
                          "pendingBelowClientOrderId": client_id + "SL"}
                    with self._db() as db:
                        db.execute("UPDATE orders SET state='SENDING',updated=? WHERE client_id=? AND state='CONFIRMING'", (self.clock(), client_id))
                    response = self.provider.submit_bracket(params)
        except TestnetError as exc:
            state = "UNKNOWN" if exc.code == "outcome_unknown" else "REJECTED"
            self._save_state(client_id, state, {"safeMessage": exc.message})
            raise
        except Exception:
            self._save_state(client_id, "UNKNOWN", {"safeMessage": "Verzendresultaat onbekend; statuscontrole vereist."})
            raise TestnetError("outcome_unknown", "Verzendresultaat onbekend. Controleer eerst orderstatus; niet opnieuw versturen.") from None
        status = response.get("listOrderStatus") or response.get("status") or "UNKNOWN" if isinstance(response, dict) else "UNKNOWN"
        normalized = {"NEW": "NEW", "EXECUTING": "NEW", "PARTIALLY_FILLED": "PARTIALLY_FILLED", "FILLED": "FILLED",
                      "CANCELED": "CANCELED", "REJECT": "REJECTED", "REJECTED": "REJECTED", "EXPIRED": "EXPIRED"}.get(status, "UNKNOWN")
        self._save_state(client_id, normalized, response)
        return self.order_status(client_id)

    def _save_state(self, client_id, state, response):
        safe = response if isinstance(response, (dict, list)) else {"value": str(response)}
        with self._db() as db:
            db.execute("UPDATE orders SET state=?,updated=?,exchange_json=? WHERE client_id=?", (state, self.clock(), json.dumps(safe), client_id))

    def order_status(self, client_id):
        with self._db() as db:
            row = db.execute("SELECT * FROM orders WHERE client_id=?", (client_id,)).fetchone()
        if not row: raise TestnetError("not_found", "Order niet gevonden.")
        if row["state"] in {"UNKNOWN", "SENDING", "NEW", "PARTIALLY_FILLED", "FILLED", "CANCELED", "EXPIRED", "REJECTED"}:
            p = json.loads(row["payload"])
            try:
                response = self.provider.find_order(p["symbol"], client_id)
                if not isinstance(response, dict) or not isinstance(response.get("status"), str) or "executedQty" not in response:
                    raise TestnetError("invalid_response", "Orderstatus mist verplichte exchangevelden.")
                original_details = json.loads(row["exchange_json"] or "{}")
                if original_details.get("orderListId") is not None:
                    response.setdefault("orderListId", original_details["orderListId"])
                status = response["status"]
                mapped = {"NEW":"NEW", "PARTIALLY_FILLED":"PARTIALLY_FILLED", "FILLED":"FILLED", "CANCELED":"CANCELED", "REJECTED":"REJECTED", "EXPIRED":"EXPIRED"}.get(status, "UNKNOWN")
                try:
                    executed = float(response["executedQty"] or 0)
                    quote = float(response.get("cummulativeQuoteQty", response.get("cumulativeQuoteQty", 0)) or 0)
                    if not math.isfinite(executed) or not math.isfinite(quote) or executed < 0 or quote < 0:
                        raise ValueError()
                except (TypeError, ValueError, OverflowError):
                    raise TestnetError("invalid_response", "Orderstatus bevat ongeldige fillvelden.") from None
                if mapped == "FILLED" and executed <= 0:
                    raise TestnetError("invalid_response", "Testnet meldde FILLED zonder uitgevoerde hoeveelheid.")
                avg = quote / executed if executed > 0 and quote > 0 else float(response.get("price", 0) or 0)
                response["executedQty"] = executed
                response["averageEntry"] = avg
                response["fees"] = []
                # Trade-level commissions are authoritative. Order status alone does
                # not contain a fee, so never substitute the configured estimate.
                if executed > 0 and response.get("orderId") is None:
                    response["fillStatus"] = "RECONCILIATION_REQUIRED"
                    response["feeStatus"] = "RECONCILIATION_REQUIRED"
                if executed > 0 and response.get("orderId") is not None and hasattr(self.provider, "trades"):
                    try:
                        trade_rows = self.provider.trades(p["symbol"], response["orderId"])
                        if not isinstance(trade_rows, list) or not trade_rows:
                            response["fillStatus"] = "RECONCILIATION_REQUIRED"
                            response["feeStatus"] = "RECONCILIATION_REQUIRED"
                        for trade in trade_rows if isinstance(trade_rows, list) else []:
                            if not isinstance(trade, dict):
                                response["fillStatus"] = "RECONCILIATION_REQUIRED"
                                response["feeStatus"] = "RECONCILIATION_REQUIRED"
                                continue
                            try:
                                fill_qty, fill_price = float(trade["qty"]), float(trade["price"])
                                fill_quote = float(trade.get("quoteQty", fill_qty * fill_price))
                                fill_time = int(trade["time"])
                                trade_id = trade["id"]
                                is_buyer = trade["isBuyer"]
                                fee_raw = trade.get("commission")
                                fee = float(fee_raw) if fee_raw is not None else None
                                fee_asset = trade.get("commissionAsset")
                                if (not math.isfinite(fill_qty) or not math.isfinite(fill_price) or not math.isfinite(fill_quote)
                                        or fill_qty <= 0 or fill_price <= 0 or fill_quote <= 0 or fill_time <= 0
                                        or not isinstance(is_buyer, bool) or trade_id is None
                                        or (fee is not None and (not math.isfinite(fee) or fee < 0))
                                        or (fee is not None and fee > 0 and not isinstance(fee_asset, str))):
                                    raise ValueError()
                            except (KeyError, TypeError, ValueError, OverflowError):
                                response["fillStatus"] = "RECONCILIATION_REQUIRED"
                                response["feeStatus"] = "RECONCILIATION_REQUIRED"
                                continue
                            base_asset = p["symbol"][:-4]
                            if fee is None:
                                fee_quote = None
                            elif not fee or fee_asset in {None, base_asset}:
                                fee_quote = 0.0
                            elif fee_asset == "USDT":
                                fee_quote = fee
                            else:
                                try:
                                    fee_quote = fee * self.provider.price_at(fee_asset + "USDT", fill_time)
                                except (AttributeError, TestnetError, ValueError, TypeError):
                                    fee_quote = None
                            fill = (p["symbol"], str(trade_id), client_id, str(response["orderId"]),
                                    "BUY" if is_buyer else "SELL", fill_qty, fill_price,
                                    fill_quote, fee,
                                    fee_asset, fill_time, fee_quote)
                            with self._db() as db:
                                inserted = db.execute("INSERT OR IGNORE INTO fills(symbol,trade_id,client_id,order_id,side,quantity,price,quote_quantity,fee,fee_asset,time,fee_quote) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", fill).rowcount
                                if inserted and fee is not None and (fee == 0 or isinstance(fee_asset, str)):
                                    fee_usdt = fee if fee_asset == "USDT" else 0.0
                                    delta_usdt = -fill_quote - fee_usdt if is_buyer else fill_quote - fee_usdt
                                    db.execute("INSERT OR IGNORE INTO cash_movements(symbol,trade_id,delta_usdt) VALUES(?,?,?)",
                                               (p["symbol"], str(trade_id), delta_usdt))
                                stored = db.execute("SELECT quantity,price,quote_quantity,fee,fee_asset FROM fills WHERE client_id=? ORDER BY time", (client_id,)).fetchall()
                            total_qty = sum(x[0] for x in stored)
                            total_quote = sum(x[2] for x in stored)
                            response["averageEntry"] = total_quote / total_qty if total_qty else avg
                            response["fees"].append({"amount": fee, "asset": trade.get("commissionAsset")})
                    except (TestnetError, TypeError, ValueError):
                        # Fill/fee reconciliation is retried on the next status sync.
                        response["feeStatus"] = "RECONCILIATION_REQUIRED"
                response["protection"] = ("NOT_APPLICABLE" if p.get("side") == "SELL" else
                                           "PENDING_EXCHANGE_CONFIRMATION" if executed > 0 else "NOT_ACTIVE")
                if p.get("side") == "BUY" and executed > 0 and mapped == "FILLED":
                    original = json.loads(row["exchange_json"] or "{}")
                    list_id = response.get("orderListId") or original.get("orderListId")
                    protection_confirmed = False
                    if list_id is not None:
                        response["orderListId"] = list_id
                        try:
                            bracket = self.provider.order_list(orderListId=list_id)
                            reports = bracket.get("orderReports") if isinstance(bracket, dict) else None
                            if not isinstance(reports, list) or not reports:
                                reports = bracket.get("orders", []) if isinstance(bracket, dict) else []
                            normalized_reports = []
                            for item in reports if isinstance(reports, list) else []:
                                if isinstance(item, dict) and all(key in item for key in ("status", "side", "origQty", "clientOrderId", "type", "price", "executedQty")):
                                    normalized_reports.append(item)
                                elif isinstance(item, dict) and item.get("orderId") is not None:
                                    try:
                                        detail = self.provider.order_by_id(p["symbol"], item["orderId"])
                                        if isinstance(detail, dict): normalized_reports.append(detail)
                                    except (AttributeError, TestnetError):
                                        pass
                            reports = normalized_reports
                            open_children = [x for x in reports if x.get("status") in {"NEW", "PARTIALLY_FILLED"}]
                            self._sync_child_fills(client_id, p["symbol"], reports)
                            expected = {client_id + "TP": "LIMIT_MAKER", client_id + "SL": "STOP_LOSS_LIMIT"}
                            reports_by_client = {x.get("clientOrderId"): x for x in reports if isinstance(x, dict)}
                            confirmed = (isinstance(bracket, dict) and bracket.get("listOrderStatus") == "EXECUTING"
                                and len(reports) == 2 and len(open_children) == 2
                                and set(reports_by_client) == set(expected))
                            if confirmed:
                                for child_id, expected_type in expected.items():
                                    child = reports_by_client[child_id]
                                    qty = float(child.get("origQty", "nan"))
                                    child_executed = float(child.get("executedQty", 0))
                                    if (child.get("status") != "NEW" or child.get("side") != "SELL"
                                            or child.get("type") != expected_type
                                            or not math.isfinite(qty) or abs(qty - executed) > max(1e-10, executed * 1e-8)
                                            or not math.isfinite(child_executed) or child_executed != 0):
                                        confirmed = False
                                        break
                                    if child_id.endswith("TP"):
                                        price_value = float(child.get("price", "nan"))
                                        if not math.isfinite(price_value) or abs(price_value-float(p["takeProfit"])) > max(1e-8, abs(float(p["takeProfit"])) * 1e-8):
                                            confirmed = False
                                            break
                                    else:
                                        stop_value = float(child.get("stopPrice", "nan"))
                                        limit_value = float(child.get("price", "nan"))
                                        if (not math.isfinite(stop_value) or not math.isfinite(limit_value)
                                                or abs(stop_value-float(p["stopLoss"])) > max(1e-8, abs(float(p["stopLoss"])) * 1e-8)
                                                or limit_value <= 0 or limit_value >= stop_value):
                                            confirmed = False
                                            break
                            if confirmed:
                                protection_confirmed = True
                                response["protection"] = "ACTIVE_CONFIRMED"
                                response["protectiveOrders"] = open_children
                        except Exception:
                            protection_confirmed = False
                    if not protection_confirmed:
                        response["protection"] = "PENDING_EXCHANGE_CONFIRMATION"
                        response["reconciliationRequired"] = True
                        response["protectionStatus"] = "UNKNOWN_OR_MISMATCHED"
                self._save_state(client_id, mapped, response)
                row = dict(row); row["state"] = mapped; row["exchange_json"] = json.dumps(response)
            except TestnetError as exc:
                previous = json.loads(row["exchange_json"] or "{}")
                previous.update({"status":"UNKNOWN", "reconciliationRequired":True,
                                 "protection":"PENDING_EXCHANGE_CONFIRMATION" if p.get("side") == "BUY" else "NOT_APPLICABLE",
                                 "safeMessage":exc.message})
                self._save_state(client_id, "UNKNOWN", previous)
                row = dict(row); row["state"] = "UNKNOWN"; row["exchange_json"] = json.dumps(previous)
            except Exception:
                previous = json.loads(row["exchange_json"] or "{}")
                previous.update({"status":"UNKNOWN", "reconciliationRequired":True,
                                 "protection":"PENDING_EXCHANGE_CONFIRMATION" if p.get("side") == "BUY" else "NOT_APPLICABLE",
                                 "safeMessage":"Exchangeorder- of beschermingsstatus kon niet veilig worden gevalideerd."})
                self._save_state(client_id, "UNKNOWN", previous)
                row = dict(row); row["state"] = "UNKNOWN"; row["exchange_json"] = json.dumps(previous)
        exchange_data = json.loads(row["exchange_json"] or "{}")
        return {"clientOrderId": client_id, "status": row["state"], "exchange": "Binance Spot Testnet", "details": exchange_data,
                "liveEnabled": False, "withdrawalsEnabled": False}

    def history(self):
        with self._db() as db:
            rows = [dict(r) for r in db.execute("SELECT * FROM orders ORDER BY created DESC")]
        result = []
        for row in rows:
            state = row["state"]
            if state in {"NEW", "PARTIALLY_FILLED", "UNKNOWN", "SENDING", "FILLED", "CANCELED", "EXPIRED", "REJECTED"}:
                try: latest = self.order_status(row["client_id"])
                except TestnetError: latest = {"status": state, "details": {}}
            else: latest = {"status": state, "details": json.loads(row["exchange_json"] or "{}")}
            details = latest.get("details") or {}
            with self._db() as db:
                fills = [dict(fill) for fill in db.execute("SELECT trade_id,side,quantity,price,quote_quantity,fee,fee_asset,time FROM fills WHERE client_id=? ORDER BY time", (row["client_id"],))]
            result.append({"clientOrderId": row["client_id"], "symbol": row["symbol"], "status": latest["status"],
                           "createdAt": row["created"], "executedQty": details.get("executedQty", 0),
                           "averageEntry": details.get("averageEntry"), "fees": details.get("fees", []),
                           "fills": fills, "protection": details.get("protection", "NOT_CONFIRMED")})
        return result


def create_testnet_service():
    """Never builds a provider unless caller explicitly selected sandbox mode."""
    if os.environ.get("EXCHANGE_PROVIDER", "").lower() != "binance_spot" or os.environ.get("EXCHANGE_SANDBOX", "").lower() not in {"1", "true", "yes"}:
        raise TestnetError("mode_blocked", "Testnet-orderstroom is uitgeschakeld. Kies expliciet de TESTNET-sessiestarter.")
    key, secret = os.environ.get("EXCHANGE_API_KEY", ""), os.environ.get("EXCHANGE_API_SECRET", "")
    try: return TestnetOrderService(BinanceSpotTestnet(key, secret))
    except TestnetError: raise
    except Exception: raise TestnetError("not_configured", "Testnet is niet ingesteld.") from None
