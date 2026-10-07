#!/usr/bin/env python3
"""
USBR RISE Catalog 24-Month Study Database Generator
Author: Application Operations Specialist
Description: Crawls data.usbr.gov catalog 6331 to fetch missing studies.
             Uses metadata extraction to bypass SPA header collisions.
             Also checks usbr.gov for current-year Chart PDFs (separate
             site, no catalog API — direct URL existence check).
"""

import os
import re
import json
import time
import urllib.parse
import requests
from datetime import datetime
from bs4 import BeautifulSoup

# CONFIGURATION
CATALOG_ROOT = "https://data.usbr.gov"
PARENT_URL = "https://data.usbr.gov/catalog/6331"
OUTPUT_FILE = "studies-data.js"

MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
]

SCENARIO_PATTERNS = ["Most Probable", "Probable Minimum", "Probable Maximum"]

# Chart PDF configuration (separate site, no catalog API — direct URL pattern)
CHART_BASE_URL = "https://www.usbr.gov/lc/region/g4000/24mo"

def robust_get(url, headers=None, max_retries=4, initial_backoff=2):
    """
    Executes an HTTP GET request with exponential backoff on timeouts or server errors.
    """
    if headers is None:
        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}

    backoff = initial_backoff
    for attempt in range(1, max_retries + 1):
        try:
            timeout = 10 + (attempt - 1) * 5
            response = requests.get(url, headers=headers, timeout=timeout)

            # Treat server issues or rate limits as failures to trigger retries
            if response.status_code in [500, 502, 503, 504, 429]:
                response.raise_for_status()

            return response
        except (requests.exceptions.RequestException, Exception) as e:
            if attempt == max_retries:
                print(f"    [!] Error: Attempt {attempt}/{max_retries} failed for {url}. Reason: {e}")
                print(f"    [!] Max retries reached. Skipping item.")
                return None

            print(f"    [!] Attempt {attempt}/{max_retries} failed. Retrying in {backoff}s... (Error: {e})")
            time.sleep(backoff)
            backoff *= 2

    return None

def load_existing_studies(file_path):
    """
    Reads the existing studies-data.js database file and loads the parsed array.
    """
    if not os.path.exists(file_path):
        print(f"[*] Database file '{file_path}' not found. Starting with a clean slate.")
        return []

    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read().strip()

        # Extract JavaScript variable assignment
        match = re.search(r'window\.__STUDIES\s*=\s*(\[.*\])\s*;?', content, re.DOTALL)
        if match:
            parsed_data = json.loads(match.group(1))
            print(f"[+] Loaded {len(parsed_data)} study records from existing '{file_path}' file.")
            return parsed_data
    except Exception as e:
        print(f"[!] Warning: Could not parse existing '{file_path}' file. Rebuilding database. (Error: {e})")

    return []

def parse_sub_from_pdf_filename(pdf_url):
    """
    Fallback sub-scenario detection from PDF filename.
    Handles patterns like SEP26_6_508.pdf / SEP26_7_508.pdf where the
    digit segment after the month/year code indicates maf variant.
    Only meaningful for Most Probable scenario ambiguity (6 maf / 7 maf).
    """
    if not pdf_url:
        return ""

    filename = pdf_url.rsplit('/', 1)[-1]

    # Match patterns like "_6_" or "_7_" as a standalone digit token
    match = re.search(r'_([67])_', filename)
    if match:
        return f"{match.group(1)} maf"

    return ""

def parse_metadata_from_title(title_text):
    """
    Extracts Year, Month, Month Index, Scenario, and Sub-Scenario from the Study Name.
    Example Input: "August 2026 Most Probable (6 maf) 24-Month Study"
    """
    title_text = re.sub(r'\s+', ' ', title_text).strip()

    # Extract Year (4-digit number starting with 20)
    year_match = re.search(r'\b(20\d{2})\b', title_text)
    year = year_match.group(1) if year_match else ""

    # Extract Month Name
    month = "January"
    for m in MONTH_NAMES:
        if m in title_text:
            month = m
            break
    mi = MONTH_NAMES.index(month)

    # Extract Scenario
    scenario = "Most Probable"
    for s in SCENARIO_PATTERNS:
        if s in title_text:
            scenario = s
            break

    # Extract Variant Sub-scenario (e.g. 6 maf, 7 maf)
    sub = ""
    sub_match = re.search(r'\(([^)]+)\)', title_text)
    if sub_match:
        sub_content = sub_match.group(1).lower()
        if "6 maf" in sub_content or "6maf" in sub_content:
            sub = "6 maf"
        elif "7 maf" in sub_content or "7maf" in sub_content:
            sub = "7 maf"

    # Standardize final display name schema
    name = f"{month} {year} {scenario}"
    if sub:
        name += f" ({sub})"
    name += " 24-Month Study"

    return year, month, mi, scenario, sub, name

def crawl_current_year_charts(existing_cats):
    """
    Checks for Chart PDFs on usbr.gov for the current calendar year only.
    Chart PDFs live on a separate site (www.usbr.gov, not data.usbr.gov RISE
    catalog) with a predictable URL pattern:
        https://www.usbr.gov/lc/region/g4000/24mo/{year}/{Month}-Chart.pdf
    There is no catalog API for these, so existence is checked via direct GET.
    Only the current year is checked since past-year charts are static and
    already captured; this keeps the scraper fast on every run.
    """
    year = str(datetime.now().year)
    print(f"[*] Checking Chart PDFs for current year: {year}...")

    new_records = []
    for month in MONTH_NAMES:
        cat_url = f"{CHART_BASE_URL}/{year}/{month}-Chart.pdf"

        if cat_url in existing_cats:
            continue  # already have this one

        try:
            resp = requests.get(
                cat_url,
                headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"},
                timeout=10,
                stream=True
            )
            status = resp.status_code
            found = status == 200
            resp.close()
        except requests.exceptions.RequestException as e:
            print(f"    [!] Request error for {month} {year} chart: {e}")
            continue

        if found:
            mi = MONTH_NAMES.index(month)
            record = {
                "y": year,
                "m": month,
                "mi": mi,
                "s": "Charts",
                "sub": "",
                "n": f"{month} {year} 24-Month Study Chart",
                "pdf": cat_url,
                "cat": cat_url
            }
            print(f"    [+] Found: {month} {year} Chart")
            new_records.append(record)
        else:
            print(f"    [-] Not available: {month} {year} Chart (status {status})")

    return new_records

def get_child_links():
    """
    Crawls the main parent page to collect all child dataset links.
    """
    print(f"[*] Accessing parent catalog: {PARENT_URL}...")
    response = robust_get(PARENT_URL)

    if not response:
        print("[!] Critical: Failed to retrieve parent catalog index.")
        return []

    soup = BeautifulSoup(response.text, 'html.parser')
    links = []

    # Find dataset anchor tags pointing to item detail routes
    for a in soup.find_all('a', href=True):
        href = a['href']
        if "/catalog/6331/item/" in href:
            full_url = urllib.parse.urljoin(CATALOG_ROOT, href)
            if full_url not in links:
                links.append(full_url)

    print(f"[+] Discovered {len(links)} total study listings in catalog index.")
    return links

def crawl_study_item(url):
    """
    Crawls an individual study item detail page to parse its title and direct PDF file.
    Prefers USBR direct JSON API for robustness, falling back to HTML parsing if necessary.
    """
    # Extract item ID from URL (e.g., https://data.usbr.gov/catalog/6331/item/134136)
    id_match = re.search(r'/item/(\d+)', url)
    if not id_match:
        print(f"    [-] Skipped: Could not parse ID from URL: {url}")
        return None
    item_id = id_match.group(1)

    title = ""
    pdf_url = ""

    # 1. Attempt REST API Retrieval (Bypasses CSR Issues)
    api_url = f"https://data.usbr.gov/rise/api/catalog-item/{item_id}"
    response = robust_get(api_url)

    if response and "application/json" in response.headers.get("Content-Type", "").lower():
        try:
            data = response.json()
            title = data.get("title", "").strip()
            binary_path = data.get("binaryFilePath", "").strip()
            if binary_path:
                pdf_url = urllib.parse.urljoin(CATALOG_ROOT, binary_path)
        except Exception as e:
            print(f"    [!] Warning: Failed parsing JSON API response for ID {item_id}: {e}")

    # 2. HTML Soup Fallback (If API fails or is unreachable)
    if not title or not pdf_url:
        print(f"    [*] API unavailable. Falling back to HTML scraping for ID {item_id}...")
        response = robust_get(url)
        if not response:
            return None

        soup = BeautifulSoup(response.text, 'html.parser')

        # Robust HTML extraction avoiding generic branding header collisions
        og_title = soup.find('meta', attrs={'property': 'og:title'})
        if not og_title:
            og_title = soup.find('meta', attrs={'name': 'twitter:title'})
        if og_title and og_title.get('content'):
            title = og_title['content'].strip()

        if not title or title.lower() == "reclamation information sharing environment (rise)":
            if soup.title and soup.title.string:
                title = soup.title.string.strip()

        if not title or title.lower() == "reclamation information sharing environment (rise)":
            for h1_tag in soup.find_all('h1'):
                h1_text = h1_tag.text.strip()
                if h1_text and h1_text.lower() != "reclamation information sharing environment (rise)":
                    title = h1_text
                    break

        # Remove standard site name suffixes from resolved title
        suffixes = [
            " | Reclamation Information Sharing Environment (RISE)",
            " | RISE",
            " - Reclamation Information Sharing Environment (RISE)"
        ]
        for suffix in suffixes:
            if title.endswith(suffix):
                title = title[:-len(suffix)].strip()

        # Resolve direct download link
        for a in soup.find_all('a', href=True):
            href = a['href']
            if "/rise/content-rise-public/rise/catalog-item/binary/" in href or "/binary/" in href:
                pdf_url = urllib.parse.urljoin(CATALOG_ROOT, href)
                break

        if not pdf_url:
            for a in soup.find_all('a', href=True):
                if a['href'].endswith('.pdf'):
                    pdf_url = urllib.parse.urljoin(CATALOG_ROOT, a['href'])
                    break

    # 3. Safeguard Confirmations
    if not title:
        print(f"    [-] Skipped: Could not resolve item title for: {url}")
        return None

    # Filter non-report catalog attachments
    if "24-Month Study" not in title:
        print(f"    [-] Skipped: Item is not a report (Title: '{title}')")
        return None

    if not pdf_url:
        print(f"    [!] Warning: Direct PDF binary path not resolved for: '{title}'")
        return None

    # Extract metadata properties from resolved title
    year, month, mi, scenario, sub, clean_name = parse_metadata_from_title(title)

    # Fallback: derive sub-scenario from PDF filename when title lacks it
    # (e.g. SEP26_6_508.pdf / SEP26_7_508.pdf carry the maf variant in filename,
    # not in title text)
    if not sub and scenario == "Most Probable":
        sub = parse_sub_from_pdf_filename(pdf_url)
        if sub:
            clean_name = f"{month} {year} {scenario} ({sub}) 24-Month Study"

    if not year:
        print(f"    [-] Skipped: Could not resolve a valid 4-digit Year from Title: '{title}'")
        return None

    return {
        "y": year,
        "m": month,
        "mi": mi,
        "s": scenario,
        "sub": sub,
        "n": clean_name,
        "pdf": pdf_url,
        "cat": url
    }

def main():
    print("====================================================")
    print(" USBR RISE Catalog Scraper - Delta Database Sync")
    print("====================================================")

    # 1. Load the current database to check progress
    existing_studies = load_existing_studies(OUTPUT_FILE)
    existing_cats = {s['cat'] for s in existing_studies if 'cat' in s}

    # 2. Crawl parent index page
    child_urls = get_child_links()
    if not child_urls:
        print("[!] No studies found to crawl. Exiting.")
        return

    # 3. Calculate missing items (delta)
    urls_to_crawl = [url for url in child_urls if url not in existing_cats]
    print(f"[*] Filtered: {len(existing_cats)} records are already up to date.")
    print(f"[*] Identified: {len(urls_to_crawl)} new links that need to be crawled.")

    if not urls_to_crawl:
        print("[+] Everything is up to date! Database is synchronized.")
        studies = existing_studies
    else:
        # Clone existing datasets to append new crawls
        studies = list(existing_studies)

        # Crawl only the missing items dynamically
        for idx, url in enumerate(urls_to_crawl, 1):
            print(f"[{idx}/{len(urls_to_crawl)}] Syncing: {url}...")
            meta = crawl_study_item(url)
            if meta:
                print(f"    [+] Crawled: '{meta['n']}'")
                studies.append(meta)

    # 4. Check current-year Chart PDFs (separate site, no catalog API)
    chart_records = crawl_current_year_charts(existing_cats)
    if chart_records:
        print(f"[+] Found {len(chart_records)} new Chart PDF(s) for current year.")
        studies.extend(chart_records)
    else:
        print("[*] No new Chart PDFs found for current year.")

    # Sort dynamically (Year ascending, Month index ascending, Variant sub-scenario ascending)
    print("[*] Sorting and restructuring database records...")
    studies.sort(key=lambda x: (int(x.get('y', 0)), x.get('mi', 0), x.get('sub', '')))

    # Format and save as JS global variable definition
    js_output = f"window.__STUDIES = {json.dumps(studies, indent=2)};"

    try:
        with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
            f.write(js_output)
        print(f"\n[+] SUCCESS: Database successfully updated at: {OUTPUT_FILE}")
        print(f"[+] Total Database Records: {len(studies)} (Added: {len(studies) - len(existing_cats)} new items).")
    except Exception as e:
        print(f"\n[!] Failed to save export file: {e}")

if __name__ == "__main__":
    main()
