import tempfile
import io
import json
import contextlib
import unittest
import threading
import time
from unittest.mock import patch
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen

from exchange_layer import ExchangeError
from testnet_trading import BinanceSpotTestnet, TestnetError, TestnetOrderService, create_testnet_service
import testnet_readonly_check
import run_local
from testnet_readonly_check import ReadOnlyTestnetClient


class FakeProvider(BinanceSpotTestnet):
    def __init__(self, order_status="NEW", send_error=None, balance=10000):
        self.api_key, self.api_secret = "fake", "fake"
        self.calls, self.order_status_value, self.send_error, self.lookups = [], order_status, send_error, 0
        self.balance = balance
        self.base_balance = 0.0
        self.last_side = "BUY"
        self.last_quantity = 0.1
        self.applied_trade_ids = set()
        self.protective_orders = []
        self.protective_details = {}
        self.remote_orders = []
        self.remote_status = {}
        self.fee_asset = "BTC"
        self.fee_amount = .001
        self.current_price = 100.0
        self.price_time = 1780000000000
    def symbol_info(self, symbol): return {"symbol": symbol, "status": "TRADING", "baseAsset":symbol[:-4], "quoteAsset":"USDT",
        "isSpotTradingAllowed":True, "orderTypes":["MARKET","LIMIT","LIMIT_MAKER","STOP_LOSS_LIMIT"],
        "otoAllowed":True, "ocoAllowed":True, "filters": [
        {"filterType":"LOT_SIZE","minQty":"0.00001","maxQty":"100000","stepSize":"0.00001"},
        {"filterType":"MARKET_LOT_SIZE","minQty":"0.00001","maxQty":"100000","stepSize":"0.00001"},
        {"filterType":"PRICE_FILTER","minPrice":"0.01","maxPrice":"1000000","tickSize":"0.01"},
        {"filterType":"MIN_NOTIONAL","minNotional":"5"}]}
    def price(self, symbol): return 1.08 if symbol == "EURUSDT" else self.current_price
    def fresh_price(self, symbol): return self.price(symbol), self.price_time
    def commission(self, symbol):
        zero = {"maker":"0", "taker":"0", "buyer":"0", "seller":"0"}
        standard = {"maker":"0.001", "taker":"0.001", "buyer":"0", "seller":"0"}
        return {"standardCommission":standard, "specialCommission":zero, "taxCommission":zero,
                "discount":{"enabledForAccount":True,"enabledForSymbol":True,"discount":"0.25","discountAsset":"BNB"}}
    def open_orders(self, symbol=None): return [row for row in self.remote_orders if symbol is None or row.get("symbol") == symbol]
    def open_order_lists(self): return []
    def account(self):
        locked = sum(max(0, float(row.get("origQty", 0)) - float(row.get("executedQty", 0))) * float(row.get("price", 0))
                     for row in self.remote_orders if row.get("side") == "BUY")
        rows=[{"asset":"USDT","free":str(max(0, self.balance-locked)),"locked":str(locked)}]
        if self.base_balance: rows.append({"asset":"BTC","free":str(self.base_balance),"locked":"0"})
        return {"balances":rows}
    def find_order(self, symbol, client_id):
        if client_id in self.remote_status:
            return dict(self.remote_status[client_id])
        self.calls.append(("lookup", client_id))
        self.lookups += 1
        if self.lookups == 1: raise TestnetError("order_not_found", "not found")
        return {"status": self.order_status_value, "executedQty": str(self.last_quantity), "price": "100", "orderId": 42 if self.last_side == "BUY" else 43}
    def trades(self, symbol, order_id):
        if order_id not in (42, 43): return []
        trade_id = 7 if order_id == 42 else 8
        if trade_id not in self.applied_trade_ids:
            self.applied_trade_ids.add(trade_id)
            if self.fee_asset == "BTC":
                self.base_balance += self.last_quantity - self.fee_amount if self.last_side == "BUY" else -(self.last_quantity + self.fee_amount)
            else:
                self.base_balance += self.last_quantity if self.last_side == "BUY" else -self.last_quantity
            self.balance += (-1 if self.last_side == "BUY" else 1) * self.last_quantity * 100
            if self.fee_asset == "USDT": self.balance -= self.fee_amount
        return [{"id": trade_id, "qty": str(self.last_quantity), "price": "100", "quoteQty": str(self.last_quantity*100), "commission": str(self.fee_amount), "commissionAsset": self.fee_asset, "isBuyer": self.last_side == "BUY", "time": 1780000000000}]
    def submit_order(self, params):
        self.calls.append(("submit_order", params)); self.last_side=params["side"]; self.last_quantity=float(params["quantity"])
        self.send_error and (_ for _ in ()).throw(self.send_error)
        self.order_status_value="FILLED"
        return {"status":"FILLED","orderId":43,"executedQty":str(self.last_quantity)}
    def submit_bracket(self, params):
        self.calls.append(("submit", params))
        if self.send_error: raise self.send_error
        return {"orderListId": 123, "listOrderStatus": "EXECUTING"}
    def order_list(self, **params): return {"listOrderStatus":"EXECUTING","orders":self.protective_orders}
    def order_by_id(self, symbol, order_id): return self.protective_details.get(order_id,{})
    def request(self, method, path, params=None, signed=True):
        if path == "/api/v3/order":
            return {"status": self.order_status_value, "executedQty": "0.1", "price": "100"}
        return {}


class TestnetWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.provider = FakeProvider()
        self.service = TestnetOrderService(self.provider, Path(self.temp.name) / "ledger.sqlite3", clock=lambda: 1780000000000)
        self.payload = {"symbol":"BTCUSDT", "side":"BUY", "quantity":0.1, "stopLoss":95.0, "takeProfit":110.0}
    def tearDown(self): self.temp.cleanup()
    def prepare(self, payload=None): return self.service.prepare(payload or self.payload)
    def seed_open_buy(self, client_id, symbol="BTCUSDT", quantity=9, price=100, stop=95, executed=0, include_price=True):
        payload = {"symbol":symbol,"side":"BUY","quantity":quantity,"price":price,"stopLoss":stop,"takeProfit":110,
                   "commissionRate":.001,"riskSettings":{"profile":"balanced"}}
        with self.service._db() as db:
            db.execute("INSERT INTO orders VALUES (?,?,?,?,?,?,?)", (client_id,symbol,json.dumps(payload),
                       "PARTIALLY_FILLED" if executed else "NEW",1780000000000,1780000000000,"{}"))
        remote = {"symbol":symbol,"side":"BUY","status":"PARTIALLY_FILLED" if executed else "NEW",
                  "clientOrderId":client_id,"origQty":str(quantity),"executedQty":str(executed)}
        if include_price: remote["price"] = str(price)
        self.provider.remote_orders.append(remote)
        self.provider.remote_status[client_id] = {"status":remote["status"],"executedQty":str(executed),
                                                   "price":str(price),"orderId":9999}
        return remote
    def test_spot_testnet_time_endpoint_and_signed_timestamp_offset(self):
        server_time=1_780_000_000_000
        calls=[]
        def transport(method,url,headers,timeout,body=None):
            calls.append((method,url,headers,body))
            path=urlsplit(url).path
            if path == "/api/v3/time": return {"serverTime":server_time}
            if path == "/api/v3/account": return {"balances":[{"asset":"USDT","free":"12.5","locked":"1"}]}
            raise AssertionError(f"unexpected endpoint: {path}")
        provider=BinanceSpotTestnet("dummy-key","dummy-secret",transport=transport)
        result=provider.account()
        self.assertEqual(result["balances"][0]["locked"],"1")
        self.assertEqual([urlsplit(call[1]).path for call in calls],["/api/v3/time","/api/v3/account"])
        self.assertTrue(all(urlsplit(call[1]).netloc=="testnet.binance.vision" for call in calls))
        signed=parse_qs(urlsplit(calls[1][1]).query)
        self.assertAlmostEqual(int(signed["timestamp"][0]),server_time,delta=10_000)
        self.assertEqual(signed["recvWindow"],["5000"])
        self.assertIn("signature",signed)
    def test_testnet_http_rate_limit_and_auth_errors_are_distinguished(self):
        for status,body,expected in ((429,b'{"code":-1003,"msg":"rate limit"}',"rate_limited"),
                                      (401,b'{"code":-2015,"msg":"bad key"}',"authentication_failed")):
            provider=BinanceSpotTestnet("dummy-key","dummy-secret",
                transport=lambda *args,s=status,b=body: (_ for _ in ()).throw(HTTPError("https://testnet.binance.vision/api/v3/account",s,"err",{},io.BytesIO(b))))
            with self.subTest(status=status),self.assertRaises(TestnetError) as caught:
                provider.account()
            self.assertEqual(caught.exception.code,expected)
            self.assertNotIn("dummy-key",str(caught.exception))
            self.assertNotIn("bad key",str(caught.exception))
    def test_ambiguous_write_timeout_and_exchange_code_never_retry(self):
        for failure in (TimeoutError("no response"), {"code":-1007,"msg":"timeout"}):
            calls=[]
            def transport(method,url,headers,timeout,body=None):
                calls.append(urlsplit(url).path)
                if urlsplit(url).path=="/api/v3/time": return {"serverTime":1780000000000}
                if isinstance(failure,Exception): raise failure
                return failure
            provider=BinanceSpotTestnet("dummy-key","dummy-secret",transport=transport)
            with self.subTest(failure=type(failure).__name__),self.assertRaises(TestnetError) as caught:
                provider.submit_order({"symbol":"BTCUSDT","side":"SELL","type":"MARKET","quantity":"0.01","newClientOrderId":"codex-test"})
            self.assertEqual(caught.exception.code,"outcome_unknown")
            self.assertEqual(calls,["/api/v3/time","/api/v3/order"])
    def test_account_and_market_malformed_responses_fail_closed(self):
        def malformed_transport(method,url,headers,timeout,body=None):
            if urlsplit(url).path=="/api/v3/time": return {"serverTime":1780000000000}
            return {"balances":[{"asset":"USDT","free":"NaN","locked":"0"}]}
        malformed=BinanceSpotTestnet("dummy-key","dummy-secret",transport=malformed_transport)
        with self.assertRaisesRegex(TestnetError,"balans bevat"):
            malformed.account()
        market_client=BinanceSpotTestnet("dummy-key","dummy-secret",transport=lambda *args:{"symbols":[
            {"symbol":"BTCUSDT","status":"TRADING","baseAsset":"BTC","quoteAsset":"USDT","isSpotTradingAllowed":False,"filters":[]}]})
        with self.assertRaises(TestnetError):
            market_client.symbol_info("BTCUSDT")
    def test_readonly_diagnostic_can_only_get_time_market_and_account(self):
        server_time=1_780_000_000_000
        calls=[]
        def get_only(url,headers,timeout):
            calls.append((url,headers))
            path=urlsplit(url).path
            if path=="/api/v3/time": return {"serverTime":server_time}
            if path=="/api/v3/exchangeInfo": return {"symbols":[{"symbol":"BTCUSDT","status":"TRADING"}]}
            if path=="/api/v3/account": return {"balances":[]}
            raise AssertionError("Unexpected read-only endpoint")
        client=ReadOnlyTestnetClient("dummy-key","dummy-secret",transport=get_only)
        result=client.run()
        self.assertEqual(result["symbol"],"BTCUSDT")
        self.assertEqual([urlsplit(call[0]).path for call in calls],["/api/v3/time","/api/v3/exchangeInfo","/api/v3/account"])
        self.assertTrue(all(urlsplit(call[0]).netloc=="testnet.binance.vision" for call in calls))
        signed=parse_qs(urlsplit(calls[-1][0]).query)
        self.assertAlmostEqual(int(signed["timestamp"][0]),server_time,delta=10_000)
        with self.assertRaisesRegex(ValueError,"Endpoint blocked"):
            client._get("/api/v3/order")
    def test_readonly_diagnostic_makes_no_call_without_credentials(self):
        output=io.StringIO()
        with patch.dict("os.environ",{},clear=True),contextlib.redirect_stdout(output):
            result=testnet_readonly_check.main()
        self.assertEqual(result,2)
        self.assertIn("Er is geen verbinding gemaakt",output.getvalue())
    def test_sync_queries_documented_open_order_list_endpoint_and_blocks_unknown_list(self):
        calls=[]
        server_time=1_780_000_000_000
        def transport(method,url,headers,timeout,body=None):
            calls.append((method,url))
            path=urlsplit(url).path
            if path=="/api/v3/time": return {"serverTime":server_time}
            if path=="/api/v3/openOrderList": return [{"orderListId":91,"listOrderStatus":"EXECUTING","symbol":"BTCUSDT","orders":[]}]
            raise AssertionError(f"unexpected request: {path}")
        client=BinanceSpotTestnet("dummy-key","dummy-secret",transport=transport)
        self.assertEqual(client.open_order_lists()[0]["orderListId"],91)
        self.assertEqual(urlsplit(calls[-1][1]).path,"/api/v3/openOrderList")
        self.provider.open_order_lists=lambda:[{"orderListId":91,"listOrderStatus":"EXECUTING","symbol":"BTCUSDT","orders":[]}]
        self.assertTrue(self.service.sync()["reconciliationRequired"])
    def test_successful_order_requires_confirmation_and_uses_unique_id(self):
        order = self.prepare()
        with self.assertRaises(TestnetError): self.service.confirm(order["clientOrderId"], False)
        result = self.service.confirm(order["clientOrderId"], True)
        self.assertEqual(result["status"], "NEW")
        self.assertEqual(len([x for x in self.provider.calls if x[0] == "submit"]), 1)
        submit = next(x for x in self.provider.calls if x[0] == "submit")
        self.assertIn("workingClientOrderId", submit[1])
    def test_partial_fill_uses_actual_quantity_and_protection_unconfirmed(self):
        self.provider.order_status_value="PARTIALLY_FILLED"
        o=self.prepare(); status=self.service.confirm(o["clientOrderId"], True)
        self.assertEqual(status["status"], "PARTIALLY_FILLED")
        self.assertEqual(status["details"]["executedQty"], .1)
        self.assertEqual(status["details"]["protection"], "PENDING_EXCHANGE_CONFIRMATION")
    def test_actual_trade_fill_and_fee_are_persisted_and_reported(self):
        order=self.prepare(); status=self.service.confirm(order["clientOrderId"], True)
        self.assertEqual(status["details"]["fees"], [{"amount": 0.001, "asset": "BTC"}])
        history=self.service.history()[0]
        self.assertEqual(history["fills"][0]["quantity"], 0.1)
        self.assertEqual(history["fills"][0]["fee_asset"], "BTC")
        # Reconciliation is idempotent: the same exchange trade is not booked twice.
        self.service.order_status(order["clientOrderId"])
        with self.service._db() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM fills").fetchone()[0], 1)
    def test_usdt_fee_and_buy_settlement_match_fill_cashflow_after_restart(self):
        self.provider.order_status_value="FILLED"
        self.provider.fee_asset="USDT"
        order=self.prepare()
        self.provider.protective_orders=[
            {"orderId":44,"clientOrderId":order["clientOrderId"]+"TP","side":"SELL","status":"NEW","type":"LIMIT_MAKER","price":"110.0","origQty":"0.1","executedQty":"0"},
            {"orderId":45,"clientOrderId":order["clientOrderId"]+"SL","side":"SELL","status":"NEW","type":"STOP_LOSS_LIMIT","price":"94.9","stopPrice":"95.0","origQty":"0.1","executedQty":"0"}]
        self.service.confirm(order["clientOrderId"],True)
        restarted=TestnetOrderService(self.provider,self.service.db_path,clock=lambda:1780000000000)
        portfolio=restarted.sync()
        self.assertFalse(portfolio["reconciliationRequired"])
        self.assertEqual(portfolio["dailyPnlStatus"],"LOCAL_FIRST_SYNC_ESTIMATE")
        self.assertAlmostEqual(self.provider.balance,9989.999)
        with restarted._db() as db:
            self.assertAlmostEqual(db.execute("SELECT SUM(delta_usdt) FROM cash_movements").fetchone()[0],-10.001)
    def test_missing_trade_commission_is_unknown_and_requires_reconciliation(self):
        self.provider.trades=lambda symbol,order_id:[{"id":17,"qty":"0.1","price":"100","quoteQty":"10","isBuyer":True,"time":1780000000000}]
        order=self.prepare(); self.service.confirm(order["clientOrderId"],True)
        with self.service._db() as db:
            row=db.execute("SELECT fee FROM fills").fetchone()
        self.assertIsNone(row[0])
        self.assertTrue(self.service._positions()[0]["reconciliationRequired"])
    def test_exchange_step_and_tick_filters_are_enforced(self):
        with self.assertRaisesRegex(TestnetError, "stapgrootte"):
            self.prepare(dict(self.payload, quantity=0.100001))
        with self.assertRaisesRegex(TestnetError, "prijstick"):
            self.prepare(dict(self.payload, stopLoss=95.005))
    def test_phase7_profile_is_shared_and_custom_values_are_used(self):
        settings={"profile":"cautious","riskPerTradePercent":0.5,"maxPositionEur":500,
            "maxPositionPercent":5,"maxOpenPositions":2,"maxExposurePercent":25,
            "maxTotalRiskPercent":1.5,"dailyLossLimitPercent":2,"maxDrawdownPercent":10,"minRiskReward":1.5}
        self.assertEqual(self.service.phase7_profiles["cautious"]["riskPerTradePercent"], .5)
        with self.assertRaisesRegex(TestnetError, "Fase 7 berekende positiegrootte"):
            self.prepare(dict(self.payload, quantity=5.5, riskSettings=settings))
    def test_one_open_buy_reserves_same_symbol_position_size(self):
        self.seed_open_buy("codexopenone", quantity=9)
        with self.assertRaisesRegex(TestnetError, "Fase 7 berekende positiegrootte"):
            self.prepare(dict(self.payload, quantity=1.1))
        self.assertEqual(len(self.service._last_snapshot["reservedBuyOrders"]), 1)
        self.assertEqual(self.service._last_snapshot["positions"], [], "an unfilled BUY remains a reservation, not a position")
    def test_multiple_open_buys_jointly_exceed_aggregate_risk(self):
        for index in range(7):
            self.seed_open_buy(f"codexmany{index}", symbol=f"X{index}USDT", quantity=9)
        settings={"profile":"balanced","riskPerTradePercent":1,"maxPositionEur":10000,
            "maxPositionPercent":100,"maxOpenPositions":12,"maxExposurePercent":100,
            "maxTotalRiskPercent":3,"dailyLossLimitPercent":3,"maxDrawdownPercent":15,"minRiskReward":1.5}
        with self.assertRaisesRegex(TestnetError, "Fase 7-risk engine blokkeerde"):
            self.prepare(dict(self.payload, riskSettings=settings))
        self.assertEqual(len(self.service._last_snapshot["reservedBuyOrders"]), 7)
    def test_partial_fill_splits_filled_position_from_remaining_reservation(self):
        self.seed_open_buy("codexpartial", quantity=9, executed=4)
        self.provider.balance=9600
        self.provider.base_balance=3.999
        with self.service._db() as db:
            db.execute("INSERT INTO fills(symbol,trade_id,client_id,order_id,side,quantity,price,quote_quantity,fee,fee_asset,time,fee_quote) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                ("BTCUSDT","partial-fill","codexpartial","9999","BUY",4,100,400,.001,"BTC",1780000000000,0))
        portfolio=self.service.sync()
        position=next(x for x in portfolio["positions"] if x["symbol"]=="BTCUSDT")
        reservation=next(x for x in portfolio["reservedBuyOrders"] if x["clientOrderId"]=="codexpartial")
        self.assertAlmostEqual(position["quantity"],3.999)
        self.assertAlmostEqual(reservation["quantity"],5)
        self.assertNotEqual(position["quantity"],reservation["quantity"])
        self.assertNotEqual(position.get("protection"), "ACTIVE_CONFIRMED")
        restarted=TestnetOrderService(self.provider,self.service.db_path,clock=lambda:1780000000000)
        recovered=restarted.sync()
        recovered_position=next(x for x in recovered["positions"] if x["symbol"]=="BTCUSDT")
        recovered_reservation=next(x for x in recovered["reservedBuyOrders"] if x["clientOrderId"]=="codexpartial")
        self.assertAlmostEqual(recovered_position["quantity"],3.999)
        self.assertAlmostEqual(recovered_reservation["quantity"],5)
        self.assertNotEqual(recovered_position.get("protection"), "ACTIVE_CONFIRMED")
    def test_existing_position_and_open_buy_share_phase7_risk_space(self):
        self.provider.balance=9800
        self.provider.base_balance=2
        with self.service._db() as db:
            db.execute("INSERT INTO fills(symbol,trade_id,client_id,order_id,side,quantity,price,quote_quantity,fee,fee_asset,time,fee_quote) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                ("BTCUSDT","existing-position","seed-existing","1","BUY",2,100,200,0,"USDT",1780000000000,0))
        self.seed_open_buy("codexwithposition", symbol="BTCUSDT", quantity=3)
        settings={"profile":"balanced","riskPerTradePercent":.1,"maxPositionEur":10000,
            "maxPositionPercent":100,"maxOpenPositions":5,"maxExposurePercent":100,
            "maxTotalRiskPercent":.5,"dailyLossLimitPercent":3,"maxDrawdownPercent":15,"minRiskReward":1.5}
        with self.assertRaisesRegex(TestnetError, "Fase 7-risk engine blokkeerde"):
            self.prepare(dict(self.payload, symbol="ETHUSDT", riskSettings=settings))
    def test_unknown_open_buy_fields_require_reconciliation(self):
        self.seed_open_buy("codexunknown", include_price=False)
        with self.assertRaisesRegex(TestnetError, "reconciliatie"):
            self.prepare()
        self.assertTrue(self.service._last_snapshot["reconciliationRequired"])
        self.assertTrue(any("limietprijs" in reason for reason in self.service._last_snapshot["reconciliationReasons"]))
    def test_open_buy_reservations_recover_after_restart(self):
        self.seed_open_buy("codexrestart", quantity=9)
        restarted=TestnetOrderService(self.provider,self.service.db_path,clock=lambda:1780000000000)
        portfolio=restarted.sync()
        self.assertEqual(len(portfolio["reservedBuyOrders"]),1)
        self.assertEqual(portfolio["reservedBuyOrders"][0]["clientOrderId"],"codexrestart")
    def test_live_commission_is_used_conservatively_and_discount_is_ignored(self):
        self.provider.commission=lambda symbol: {
            "standardCommission":{"maker":"0.0005","taker":"0.001","buyer":"0.0002","seller":"0.0001"},
            "specialCommission":{"maker":"0","taker":"0","buyer":"0","seller":"0"},
            "taxCommission":{"maker":"0","taker":"0","buyer":"0","seller":"0"},
            "discount":{"enabledForAccount":True,"enabledForSymbol":True,"discount":"0.75"}}
        order=self.prepare()
        self.assertAlmostEqual(order["commissionRate"], 0.0012)
        self.assertAlmostEqual(order["estimatedFees"], 0.024)
    def test_missing_or_malformed_commission_blocks_order(self):
        self.provider.commission=lambda symbol: {}
        with self.assertRaisesRegex(TestnetError,"commissietarief"):
            self.prepare()
    def test_sell_is_limited_to_fill_confirmed_position_and_records_realized_pnl(self):
        self.provider.base_balance=.1
        with self.service._db() as db:
            db.execute("INSERT INTO fills(symbol,trade_id,client_id,order_id,side,quantity,price,quote_quantity,fee,fee_asset,time,fee_quote) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                ("BTCUSDT","seed","seed-order","1","BUY",.1,100,10,0,"USDT",1780000000000,0))
        order=self.service.prepare({"symbol":"BTCUSDT","side":"SELL","quantity":.05,"stopLoss":0,"takeProfit":0})
        self.provider.lookups=0
        result=self.service.confirm(order["clientOrderId"],True)
        self.assertEqual(result["status"],"FILLED")
        self.assertEqual(len([call for call in self.provider.calls if call[0]=="submit_order"]),1)
        self.service._snapshot()
        summary=self.service.portfolio_summary()
        self.assertAlmostEqual(summary["positions"][0]["quantity"], .049)
        self.assertAlmostEqual(summary["realizedPnlUSDT"], -.1)
        self.assertFalse(summary["reconciliationRequired"], "realized SELL settlement is explained by the confirmed fill cashflow")
    def test_sell_cannot_exceed_fill_confirmed_inventory(self):
        with self.assertRaisesRegex(TestnetError,"open positie"):
            self.service.prepare({"symbol":"BTCUSDT","side":"SELL","quantity":.1,"stopLoss":0,"takeProfit":0})
    def test_restart_sync_preserves_peak_and_fill_ledger(self):
        self.service._set_state("portfolio_peak","25000")
        restarted=TestnetOrderService(self.provider, self.service.db_path, clock=lambda:1780000000000)
        summary=restarted.sync()
        self.assertEqual(summary["portfolioPeakUSDT"],25000)
        self.assertEqual(restarted._state_value("last_sync"),"1780000000000")
    def test_multiple_fill_backed_positions_are_restored_and_marked(self):
        with self.service._db() as db:
            for sym, trade, qty in (("BTCUSDT","btc-fill",.1),("ETHUSDT","eth-fill",.2)):
                db.execute("INSERT INTO fills(symbol,trade_id,client_id,order_id,side,quantity,price,quote_quantity,fee,fee_asset,time,fee_quote) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                    (sym,trade,"seed-"+trade,"1","BUY",qty,100,qty*100,0,"USDT",1780000000000,0))
        summary=self.service.sync()
        self.assertEqual({position["symbol"] for position in summary["positions"]},{"BTCUSDT","ETHUSDT"})
        self.assertTrue(all(position["marketValue"] > 0 for position in summary["positions"]))
    def test_drawdown_lock_requires_manual_resume_and_is_persistent(self):
        self.service._set_state("portfolio_peak","20000")
        self.service._snapshot()
        with self.assertRaisesRegex(TestnetError,"handmatige hervatting"):
            self.prepare()
        restarted=TestnetOrderService(self.provider,self.service.db_path,clock=lambda:1780000000000)
        with self.assertRaisesRegex(TestnetError,"handmatige hervatting"):
            restarted.prepare(self.payload)
        restarted.manual_resume(True)
        self.assertEqual(restarted._state_value("drawdown_lock"),"0")
    def test_full_fill_status(self):
        self.provider.order_status_value="FILLED"; o=self.prepare(); self.assertEqual(self.service.confirm(o["clientOrderId"],True)["status"],"FILLED")
    def test_protective_orders_require_exchange_confirmation_for_actual_fill_size(self):
        self.provider.order_status_value="FILLED"
        order=self.prepare()
        self.provider.protective_orders=[
            {"orderId":44,"clientOrderId":order["clientOrderId"]+"TP","side":"SELL","status":"NEW","type":"LIMIT_MAKER","price":"110.0","origQty":"0.1","executedQty":"0"},
            {"orderId":45,"clientOrderId":order["clientOrderId"]+"SL","side":"SELL","status":"NEW","type":"STOP_LOSS_LIMIT","price":"94.9","stopPrice":"95.0","origQty":"0.1","executedQty":"0"}]
        result=self.service.confirm(order["clientOrderId"],True)
        self.assertEqual(result["details"]["protection"],"ACTIVE_CONFIRMED")
        self.provider.protective_orders[1]["origQty"]="0.2"
        result=self.service.order_status(order["clientOrderId"])
        self.assertNotEqual(result["details"]["protection"],"ACTIVE_CONFIRMED")
        self.assertTrue(self.service.sync()["reconciliationRequired"])
    def test_wrong_protective_leg_type_or_price_never_confirms_protection(self):
        self.provider.order_status_value="FILLED"
        order=self.prepare()
        self.provider.protective_orders=[
            {"orderId":44,"clientOrderId":order["clientOrderId"]+"TP","side":"SELL","status":"NEW","type":"STOP_LOSS_LIMIT","price":"110.0","stopPrice":"109.0","origQty":"0.1","executedQty":"0"},
            {"orderId":45,"clientOrderId":order["clientOrderId"]+"SL","side":"SELL","status":"NEW","type":"STOP_LOSS_LIMIT","price":"94.9","stopPrice":"95.0","origQty":"0.1","executedQty":"0"}]
        result=self.service.confirm(order["clientOrderId"],True)
        self.assertNotEqual(result["details"]["protection"],"ACTIVE_CONFIRMED")
        self.assertTrue(result["details"]["reconciliationRequired"])
        self.assertTrue(self.service.sync()["reconciliationRequired"])
        with self.assertRaisesRegex(TestnetError,"reconciliatie"):
            self.prepare(dict(self.payload, symbol="ETHUSDT"))
    def test_malformed_protective_status_after_restart_fails_closed(self):
        self.provider.order_status_value="FILLED"
        order=self.prepare()
        self.provider.protective_orders=[
            {"orderId":44,"clientOrderId":order["clientOrderId"]+"TP","side":"SELL","status":"NEW","type":"LIMIT_MAKER","price":"110.0","origQty":"0.1","executedQty":"0"},
            {"orderId":45,"clientOrderId":order["clientOrderId"]+"SL","side":"SELL","status":"NEW","type":"STOP_LOSS_LIMIT","price":"94.9","stopPrice":"95.0","origQty":"0.1","executedQty":"0"}]
        result=self.service.confirm(order["clientOrderId"],True)
        self.assertEqual(result["details"]["protection"],"ACTIVE_CONFIRMED")
        restarted=TestnetOrderService(self.provider,self.service.db_path,clock=lambda:1780000000000)
        self.provider.protective_orders[1]["origQty"]="not-a-number"
        result=restarted.order_status(order["clientOrderId"])
        self.assertEqual(result["status"],"FILLED")
        self.assertNotEqual(result["details"]["protection"],"ACTIVE_CONFIRMED")
        self.assertTrue(restarted.sync()["reconciliationRequired"])
    def test_protective_order_query_resolves_documented_order_id_only_entries(self):
        self.provider.order_status_value="FILLED"
        self.provider.protective_orders=[{"orderId":44,"clientOrderId":"tp"},{"orderId":45,"clientOrderId":"sl"}]
        self.provider.protective_details={
            44:{"orderId":44,"clientOrderId":"pendingTP","status":"NEW","side":"SELL","type":"LIMIT_MAKER","price":"110.0","origQty":"0.1","executedQty":"0"},
            45:{"orderId":45,"clientOrderId":"pendingSL","status":"NEW","side":"SELL","type":"STOP_LOSS_LIMIT","price":"94.9","stopPrice":"95.0","origQty":"0.1","executedQty":"0"}}
        order=self.prepare()
        self.provider.protective_orders[0]["clientOrderId"]=order["clientOrderId"]+"TP"
        self.provider.protective_orders[1]["clientOrderId"]=order["clientOrderId"]+"SL"
        self.provider.protective_details[44]["clientOrderId"]=order["clientOrderId"]+"TP"
        self.provider.protective_details[45]["clientOrderId"]=order["clientOrderId"]+"SL"
        result=self.service.confirm(order["clientOrderId"],True)
        self.assertEqual(result["details"]["protection"],"ACTIVE_CONFIRMED")
    def test_rejected_status(self):
        self.provider.order_status_value="REJECTED"; o=self.prepare(); self.assertEqual(self.service.confirm(o["clientOrderId"],True)["status"],"REJECTED")
    def test_canceled_status(self):
        self.provider.order_status_value="CANCELED"; o=self.prepare(); self.assertEqual(self.service.confirm(o["clientOrderId"],True)["status"],"CANCELED")
    def test_unknown_status_fails_closed(self):
        self.provider.order_status_value="ODD"; o=self.prepare(); self.assertEqual(self.service.confirm(o["clientOrderId"],True)["status"],"UNKNOWN")
        with self.assertRaisesRegex(TestnetError,"nieuwe instaporder geblokkeerd"):
            self.prepare(dict(self.payload, symbol="ETHUSDT"))
    def test_malformed_order_status_becomes_unknown_and_is_not_booked_as_fill(self):
        calls={"n":0}
        def lookup(symbol,client_id):
            calls["n"]+=1
            if calls["n"]==1: raise TestnetError("order_not_found","first lookup only")
            return {"status":"FILLED"}
        self.provider.find_order=lookup
        order=self.prepare()
        result=self.service.confirm(order["clientOrderId"],True)
        self.assertEqual(result["status"],"UNKNOWN")
        self.assertTrue(result["details"]["reconciliationRequired"])
        with self.service._db() as db: self.assertEqual(db.execute("SELECT COUNT(*) FROM fills").fetchone()[0],0)
    def test_timeout_is_unknown_and_never_blindly_retried(self):
        self.provider.send_error=TestnetError("outcome_unknown", "timeout")
        o=self.prepare()
        with self.assertRaises(TestnetError): self.service.confirm(o["clientOrderId"],True)
        self.assertEqual(self.service.order_status(o["clientOrderId"])["status"],"NEW")
        self.assertEqual(len([x for x in self.provider.calls if x[0]=="submit"]),1)
    def test_duplicate_confirmation_blocked(self):
        o=self.prepare(); self.service.confirm(o["clientOrderId"],True)
        with self.assertRaises(TestnetError): self.service.confirm(o["clientOrderId"],True)
    def test_insufficient_balance(self):
        self.provider.balance=1
        with self.assertRaises(TestnetError): self.prepare()
    def test_missing_stop_loss(self):
        p=dict(self.payload); p["stopLoss"]=None
        with self.assertRaises(TestnetError): self.prepare(p)
    def test_max_risk_limit(self):
        p=dict(self.payload, quantity=20)
        with self.assertRaises(TestnetError): self.prepare(p)
    def test_daily_loss_limit(self):
        self.service._set_state("daily_date", time.strftime("%Y-%m-%d",time.localtime(1780000000000/1000)))
        self.service._set_state("daily_start_equity", "10310")
        self.service._set_state("daily_date", time.strftime("%Y-%m-%d",time.localtime(1780000000000/1000)))
        with self.assertRaisesRegex(TestnetError,"Dagelijkse verlieslimiet"): self.prepare()
    def test_unexpected_usdt_increase_is_sticky_and_not_reported_as_pnl(self):
        self.prepare()
        daily_start=self.service._state_value("daily_start_equity")
        peak=self.service._state_value("portfolio_peak")
        self.provider.balance += 100
        portfolio=self.service.sync()
        self.assertTrue(portfolio["reconciliationRequired"])
        self.assertIsNone(portfolio["dailyPnlUSDT"])
        self.assertEqual(portfolio["dailyPnlStatus"],"UNAVAILABLE_RECONCILIATION")
        self.assertIn("USDT-balans wijkt af", " ".join(portfolio["reconciliationReasons"]))
        self.assertEqual(self.service._state_value("daily_start_equity"),daily_start)
        self.assertEqual(self.service._state_value("portfolio_peak"),peak)
        with self.assertRaisesRegex(TestnetError,"reconciliatie"):
            self.prepare()
        restarted=TestnetOrderService(self.provider,self.service.db_path,clock=lambda:1780000000000)
        recovered=restarted.sync()
        self.assertTrue(recovered["reconciliationRequired"])
        self.assertIsNone(recovered["dailyPnlUSDT"])
        self.assertEqual(restarted._state_value("daily_start_equity"),daily_start)
    def test_unexpected_usdt_decrease_is_not_counted_as_daily_loss(self):
        self.prepare()
        daily_start=self.service._state_value("daily_start_equity")
        self.provider.balance -= 100
        portfolio=self.service.sync()
        self.assertTrue(portfolio["reconciliationRequired"])
        self.assertIsNone(portfolio["dailyPnlUSDT"])
        self.assertEqual(self.service._state_value("daily_start_equity"),daily_start)
        self.assertEqual(portfolio["dailyPnlStatus"],"UNAVAILABLE_RECONCILIATION")
    def test_drawdown_limit(self):
        import json
        with self.service._db() as db: db.execute("INSERT INTO ledger(event,payload,created) VALUES('EQUITY',?,?)",(json.dumps({"equity":20000}),1780000000000))
        with self.assertRaisesRegex(TestnetError,"drawdown"): self.prepare()
    def test_invalid_market_information(self):
        self.provider.symbol_info=lambda symbol: (_ for _ in ()).throw(TestnetError("market_unavailable","x"))
        with self.assertRaises(TestnetError): self.prepare()
    def test_risk_rechecked_immediately_before_execution(self):
        o=self.prepare(); self.provider.balance=1
        with self.assertRaises(TestnetError): self.service.confirm(o["clientOrderId"],True)
        self.assertEqual(len([x for x in self.provider.calls if x[0]=="submit"]),0)
    def test_changed_price_before_confirmation_requires_new_preparation(self):
        order=self.prepare(); self.provider.current_price=101
        with self.assertRaisesRegex(TestnetError,"prijs is sinds voorbereiding veranderd"):
            self.service.confirm(order["clientOrderId"],True)
        self.assertEqual(len([x for x in self.provider.calls if x[0]=="submit"]),0)
    def test_stale_market_timestamp_fails_closed(self):
        self.provider.price_time=1780000000000-90_001
        with self.assertRaisesRegex(TestnetError,"verouderd"):
            self.prepare()
    def test_live_factory_is_hard_blocked(self):
        import os
        old=(os.environ.get("EXCHANGE_PROVIDER"),os.environ.get("EXCHANGE_SANDBOX"))
        os.environ["EXCHANGE_PROVIDER"]="binance_spot"; os.environ["EXCHANGE_SANDBOX"]="0"
        try:
            with self.assertRaises(TestnetError): create_testnet_service()
        finally:
            for k,v in zip(("EXCHANGE_PROVIDER","EXCHANGE_SANDBOX"),old):
                if v is None: os.environ.pop(k,None)
                else: os.environ[k]=v
    def test_withdrawal_and_live_capabilities_absent(self):
        self.assertFalse(hasattr(self.provider,"withdraw")); self.assertFalse(hasattr(self.provider,"transfer"))
        self.assertEqual(self.service.history(), [])
    def test_http_mode_is_disabled_without_explicit_testnet_session(self):
        import os, run_local
        old={k:os.environ.get(k) for k in ("EXCHANGE_PROVIDER","EXCHANGE_SANDBOX","EXCHANGE_API_KEY","EXCHANGE_API_SECRET")}
        for k in old: os.environ.pop(k,None)
        server=run_local.create_server(0); thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
        base=f"http://127.0.0.1:{server.server_port}"
        try:
            status=json.load(urlopen(base+"/api/testnet/status"))
            self.assertFalse(status["enabled"]); self.assertFalse(status["liveEnabled"])
            req=Request(base+"/api/testnet/prepare",data=json.dumps(self.payload).encode(),headers={"Origin":base,"Content-Type":"application/json"},method="POST")
            with self.assertRaises(Exception): urlopen(req)
        finally:
            server.shutdown(); server.server_close(); thread.join()
            for k,v in old.items():
                if v is not None: os.environ[k]=v


class TestnetPostRequestSecurityTests(unittest.TestCase):
    class RouteService:
        def __init__(self):
            self.calls = []
            self.state_changes = 0

        def prepare(self, payload):
            self.calls.append(("prepare", payload))
            self.state_changes += 1
            return {"clientOrderId": "codex-mock-prepared"}

        def confirm(self, client_order_id, confirmed):
            self.calls.append(("confirm", client_order_id, confirmed))
            self.state_changes += 1
            return {"status": "NEW"}

        def manual_resume(self, confirmed):
            self.calls.append(("resume", confirmed))
            self.state_changes += 1

        def portfolio_summary(self):
            return {"drawdownLocked": False}

    @classmethod
    def setUpClass(cls):
        cls.server = run_local.create_server(0)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.origin = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(2)

    def setUp(self):
        self.service = self.RouteService()
        self.factory = patch("run_local.create_testnet_service", return_value=self.service)
        self.factory.start()

    def tearDown(self):
        self.factory.stop()

    def request(self, route, payload, origin=None, content_type="application/json", extra_headers=()):
        headers = {}
        if origin is not None:
            headers["Origin"] = origin
        if content_type is not None:
            headers["Content-Type"] = content_type
        request = Request(self.origin + route, data=payload, headers=headers, method="POST")
        for name, value in extra_headers:
            request.add_header(name, value)
        try:
            with urlopen(request) as response:
                return response.status, json.load(response)
        except HTTPError as exc:
            return exc.code, json.loads(exc.read().decode("utf-8"))

    def test_valid_local_origin_and_json_content_type_reach_all_routes(self):
        routes = (
            ("/api/testnet/prepare", {"symbol": "BTCUSDT", "side": "BUY"}),
            ("/api/testnet/confirm", {"clientOrderId": "codex-mock-prepared", "confirmed": True}),
            ("/api/testnet/resume", {"confirmed": True}),
        )
        for route, payload in routes:
            with self.subTest(route=route):
                status, _ = self.request(route, json.dumps(payload).encode(), self.origin)
                self.assertEqual(status, 200)
        self.assertEqual([call[0] for call in self.service.calls], ["prepare", "confirm", "resume"])
        self.assertEqual(self.service.state_changes, 3)

    def test_wrong_origin_blocks_prepare_confirm_resume_before_service_or_state_change(self):
        routes = (
            ("/api/testnet/prepare", {"symbol": "BTCUSDT", "side": "BUY"}),
            ("/api/testnet/confirm", {"clientOrderId": "codex-mock-prepared", "confirmed": True}),
            ("/api/testnet/resume", {"confirmed": True}),
        )
        for route, payload in routes:
            with self.subTest(route=route):
                status, body = self.request(route, json.dumps(payload).encode(), "https://attacker.example")
                self.assertEqual(status, 403)
                self.assertEqual(body["error"], "origin_not_allowed")
                self.assertEqual(self.service.calls, [])
                self.assertEqual(self.service.state_changes, 0)

    def test_missing_origin_blocks_testnet_post(self):
        status, body = self.request("/api/testnet/resume", b'{"confirmed":true}', origin=None)
        self.assertEqual(status, 403)
        self.assertEqual(body["error"], "origin_not_allowed")
        self.assertEqual(self.service.calls, [])
        self.assertEqual(self.service.state_changes, 0)

    def test_duplicate_origin_headers_are_rejected_as_suspicious(self):
        status, body = self.request("/api/testnet/resume", b'{"confirmed":true}', self.origin,
                                    extra_headers=(("origin", "https://attacker.example"),))
        self.assertEqual(status, 403)
        self.assertEqual(body["error"], "origin_not_allowed")
        self.assertEqual(self.service.calls, [])
        self.assertEqual(self.service.state_changes, 0)

    def test_wrong_content_type_blocks_every_testnet_post_route(self):
        routes = (
            ("/api/testnet/prepare", {"symbol": "BTCUSDT", "side": "BUY"}),
            ("/api/testnet/confirm", {"clientOrderId": "codex-mock-prepared", "confirmed": True}),
            ("/api/testnet/resume", {"confirmed": True}),
        )
        for route, payload in routes:
            with self.subTest(route=route):
                status, body = self.request(route, json.dumps(payload).encode(), self.origin, "text/plain")
                self.assertEqual(status, 415)
                self.assertEqual(body["error"], "content_type_not_allowed")
                self.assertEqual(self.service.calls, [])
                self.assertEqual(self.service.state_changes, 0)

    def test_missing_content_type_is_rejected_before_state_change(self):
        status, body = self.request("/api/testnet/resume", b'{"confirmed":true}', self.origin,
                                    content_type=None)
        self.assertEqual(status, 415)
        self.assertEqual(body["error"], "content_type_not_allowed")
        self.assertEqual(self.service.calls, [])
        self.assertEqual(self.service.state_changes, 0)

    def test_malformed_json_is_rejected_before_service_creation(self):
        status, body = self.request("/api/testnet/resume", b"not-json", self.origin)
        self.assertEqual(status, 400)
        self.assertEqual(body["error"], "invalid_json")
        self.assertEqual(self.service.calls, [])
        self.assertEqual(self.service.state_changes, 0)


if __name__ == "__main__": unittest.main()
