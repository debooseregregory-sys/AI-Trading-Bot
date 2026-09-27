"""Optional interactive session launcher; credentials stay in process memory."""
from getpass import getpass
import os
from pathlib import Path
import subprocess
import sys


def main():
    print("Accountverbinding voor Binance Spot")
    print("L = live account, altijd alleen lezen. T = Testnet account, met aparte handmatig bevestigde Testnet-oefenorders.")
    choice = input("Kies T voor Testnet of L voor live account (alleen lezen): ").strip().lower()
    if choice not in {"t", "l"}:
        print("Ongeldige keuze; de applicatie is niet gestart.")
        return
    if choice == "t":
        print("Gebruik uitsluitend een Testnet-sleutel. Deze sessie kan alleen na ordervoorbereiding en jouw aparte bevestiging Testnet-orders versturen.")
        print("Gebruik hier NOOIT een echte/live sleutel. LIVE-orders zijn in deze applicatie geblokkeerd.")
    else:
        print("Gebruik uitsluitend een API-sleutel met leesrechten. Live trading, transfers en withdrawals zijn in deze sessie geblokkeerd.")
    api_key = getpass("API-sleutel (invoer blijft verborgen): ").strip()
    api_secret = getpass("API-geheim (invoer blijft verborgen): ").strip()
    if not api_key or not api_secret:
        print("Een gegeven ontbreekt; er zijn geen verbindingen gestart.")
        return
    environment = os.environ.copy()
    environment.update({
        "EXCHANGE_PROVIDER": "binance_spot",
        "EXCHANGE_API_KEY": api_key,
        "EXCHANGE_API_SECRET": api_secret,
        "EXCHANGE_SANDBOX": "1" if choice == "t" else "0",
    })
    project = Path(__file__).resolve().parent
    print("Sleutels worden alleen tijdelijk in het geheugen van deze sessie gebruikt; ze worden niet opgeslagen.")
    print("Sluit het servervenster om de sessie te beëindigen en de tijdelijke waarden te wissen.")
    try:
        subprocess.run([sys.executable, str(project / "run_local.py")], cwd=project, env=environment, check=False)
    except OSError:
        print("De lokale server kon niet worden gestart. Geheime gegevens zijn niet getoond.")


if __name__ == "__main__":
    main()
