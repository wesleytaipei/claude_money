import yfinance as yf
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
import time
from bs4 import BeautifulSoup
import requests
import urllib3
urllib3.disable_warnings()

def test_yf_tsm():
    tk = yf.Ticker("TSM").fast_info
    print("TSM YF:", tk.last_price, tk.previous_close)

def test_wantgoo_stwn():
    options = Options()
    options.add_argument("--headless")
    options.add_argument("--disable-gpu")
    options.add_argument("--no-sandbox")
    options.add_argument("user-agent=Mozilla/5.0")
    driver = webdriver.Chrome(options=options)
    driver.get("https://www.wantgoo.com/global/stwn&")
    time.sleep(5)
    soup = BeautifulSoup(driver.page_source, "html.parser")
    try:
        price = soup.select_one('.info-price .price').text
        change = soup.select_one('.info-price .price-bg:nth-child(2)').text
        print("Wantgoo STWN:", price, change)
    except Exception as e:
        print("Wantgoo STWN failed:", e)
    driver.quit()

def test_yahoo_margin():
    headers = {"User-Agent": "Mozilla/5.0"}
    r = requests.get("https://tw.stock.yahoo.com/margin", headers=headers)
    soup = BeautifulSoup(r.text, "html.parser")
    # find margin strings
    for el in soup.find_all(string=lambda t: t and '億' in t):
        if "融資" in el.parent.text or len(el.parent.text) < 20:
            print("Yahoo margin text:", el.parent.text)

if __name__ == "__main__":
    test_yf_tsm()
    test_wantgoo_stwn()
    test_yahoo_margin()
