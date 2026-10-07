/* ============================================================
   24-Month Study PDF Table Extractor
   Parses USBR 24-Month Study PDFs and extracts the 18 operation
   plan tables (one per reservoir / per energy summary / per
   flood-control criterion) and exports them as individual CSVs.

   Strategy:  PDF.js extracts text with positional info, then we
   bucket tokens by Y coordinate into "rows" so multi-line column
   headers (e.g. "Live\nStorage\n(1000 Ac-Ft)") are reconstructed
   into a single header line.  Data rows are then read column by
   column from the row buckets.
   ============================================================ */

(function () {
  "use strict";

  // ----- PDF.js worker setup -----
  if (window["pdfjsLib"]) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }

  const $ = (sel) => document.querySelector(sel);

  const dropZone = $("#drop-zone");
  const pdfInput = $("#pdf-input");
  const progressCard = $("#progress-card");
  const progressStatus = $("#progress-status");
  const progressFill = $("#progress-fill");
  const summaryBanner = $("#summary-banner");
  const errEl = $("#err");
  const resultsSection = $("#results");
  const tablesList = $("#tables-list");
  const resultsCount = $("#results-count");
  const downloadZipBtn = $("#download-zip-btn");
  const downloadIndivBtn = $("#download-individual-btn");
  const resetBtn = $("#reset-btn");

  // Preview modal elements
  const previewModal = $("#preview-modal");
  const previewTitle = $("#preview-title");
  const previewThead = $("#preview-thead");
  const previewTbody = $("#preview-tbody");
  const previewClose = $("#preview-close");
  const previewDownloadBtn = $("#preview-download-btn");
  const previewProcessed = $("#preview-processed");
  const previewLegend = $("#preview-legend");
  const previewChartBtn = $("#preview-chart-btn");
  const previewChartWrap = $("#preview-chart-wrap");
  const previewChartTitle = $("#preview-chart-title");
  const previewChartHide = $("#preview-chart-hide");
  const previewSavePngBtn = $("#preview-save-png-btn");

  let currentPreviewTable = null;
  let elevationChartInstance = null;
  let currentElevationColumnIdx = -1;

  // Detected tables
  let detectedTables = []; // [{ reservoir, headers, rows, csv, slug }]
  let currentFileName = "";

  // ----- Drag & drop handlers -----
  ["dragenter", "dragover"].forEach((ev) => {
    dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.add("drag-over");
    });
  });
  ["dragleave", "drop"].forEach((ev) => {
    dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove("drag-over");
    });
  });
  dropZone.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleFile(file);
  });
  pdfInput.addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) handleFile(file);
  });

  resetBtn.addEventListener("click", () => {
    detectedTables = [];
    pdfInput.value = "";
    resultsSection.hidden = true;
    summaryBanner.hidden = true;
    errEl.hidden = true;
    progressCard.hidden = true;
    progressFill.style.width = "0%";
    dropZone.style.display = "";
  });

  // ----- Theme toggle (mirror the explorer's behavior) -----
  const tBtn = document.querySelector("[data-theme-toggle]");
  if (tBtn) {
    const root = document.documentElement;
    let theme = matchMedia("(prefers-color-scheme:dark)").matches ? "dark" : "light";
    root.setAttribute("data-theme", theme);
    const setIcon = () => {
      tBtn.setAttribute("aria-label", "Switch to " + (theme === "dark" ? "light" : "dark") + " mode");
      tBtn.innerHTML = theme === "dark"
        ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>'
        : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
    };
    setIcon();
    tBtn.addEventListener("click", () => {
      theme = theme === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", theme);
      setIcon();
    });
  }

  // ============================================================
  // Check for URL parameter to auto-load PDF
  // ============================================================

  function getPdfUrlFromParams() {
    const params = new URLSearchParams(window.location.search);
    const url = params.get("pdf");
    if (url && url.toLowerCase().endsWith(".pdf")) {
      return url;
    }
    return null;
  }

  // ============================================================
  // Main pipeline
  // ============================================================

  async function handleFile(file) {
    if (!file || file.type !== "application/pdf") {
      showError("Please choose a valid PDF file.");
      return;
    }
    currentFileName = file.name;
    errEl.hidden = true;
    summaryBanner.hidden = true;
    resultsSection.hidden = true;
    detectedTables = [];
    progressCard.hidden = false;
    setProgress(0, "Reading PDF file…");

    try {
      const arrayBuffer = await file.arrayBuffer();
      setProgress(5, "Loading PDF document…");
      const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      setProgress(10, "Loaded PDF (" + pdf.numPages + " pages). Extracting text…");

      // We only need the last ~20 pages; but the user said "last 18 pages", so we
      // start scanning from the back to find the "OPERATION PLAN" marker.  We use
      // the LAST occurrence of the marker to find the start of the operation-plan
      // section, then walk forward from there through the next 18 pages.  Most
      // 24-Month Studies fit the "last 18 pages" pattern, but we also accept the
      // marker appearing anywhere by walking all pages from the first marker hit.
      const markerText = "OPERATION PLAN FOR COLORADO RIVER SYSTEM RESERVOIRS";
      const allPagesText = new Array(pdf.numPages);

      // Extract per-page text items (with coordinates) for table parsing
      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const tc = await page.getTextContent();
        allPagesText[p - 1] = tc;
        const pct = 10 + (p / pdf.numPages) * 80;
        setProgress(pct, "Extracting text from page " + p + " of " + pdf.numPages + "…");
      }

      setProgress(92, "Reconstructing tables…");
      detectedTables = extractTables(allPagesText);

      setProgress(100, "Done.");
      progressCard.hidden = true;

      if (detectedTables.length === 0) {
        showError("No operation-plan tables were found in this PDF. The format may be unrecognized.");
        return;
      }

      showResults();
    } catch (err) {
      console.error(err);
      showError("Failed to process PDF: " + (err && err.message ? err.message : err));
      progressCard.hidden = true;
    }
  }

  function setProgress(pct, status) {
    progressFill.style.width = Math.max(0, Math.min(100, pct)) + "%";
    if (status) progressStatus.textContent = status;
  }

  function showError(msg) {
    errEl.textContent = msg;
    errEl.hidden = false;
  }

  // ============================================================
  // Page → tokens grouped by Y coordinate
  // ============================================================

  // Reconstruct a "page layout" from a PDF.js textContent object.
  // Returns an array of rows, each row an array of { str, x, y, w }.
  function pageToRows(tc) {
    if (!tc || !tc.items) return [];
    // PDF.js y coordinates grow upward.  We sort by descending y to read top→bottom.
    // Group items whose y-difference is within ~3px.
    const items = tc.items
      .filter((it) => it && it.str && it.str.trim().length > 0)
      .map((it) => {
        // Use the transform matrix: x = it.transform[4], y = it.transform[5]
        var t = it.transform;
        return {
          str: it.str,
          x: t && t.length > 4 ? t[4] : 0,
          y: t && t.length > 5 ? t[5] : 0,
          w: it.width || 0,
          h: it.height || 0,
        };
      });

    // Bucket by y.  Use 6px tolerance so that tokens on slightly different
    // vertical positions (e.g. "Jul" at y=210.0 and "2027" at y=210.9) are
    // grouped into the same logical row.
    const buckets = [];
    for (const it of items) {
      let placed = false;
      for (const b of buckets) {
        if (Math.abs(b.y - it.y) <= 6) {
          b.items.push(it);
          placed = true;
          break;
        }
      }
      if (!placed) {
        buckets.push({ y: it.y, items: [it] });
      }
    }

    // Sort buckets top-to-bottom (descending y), and within each bucket left-to-right
    buckets.sort((a, b) => b.y - a.y);
    const rows = buckets.map((b) => {
      const sorted = b.items.slice().sort((a, b2) => a.x - b2.x);
      return { y: b.y, items: sorted };
    });
    return rows;
  }

  // Safe number coercion helper
  function num(v, fallback) {
    if (v === undefined || v === null || isNaN(v)) return fallback === undefined ? 0 : fallback;
    return Number(v);
  }

  // Convert a row's items into a list of "cells" by detecting x-gaps.
  // Returns a list of cells, each { text, x1, x2 }.
  function rowToCells(row) {
    if (!row || !row.items || !Array.isArray(row.items) || row.items.length === 0) return [];
    // Filter out any items that lack required geometry or non-string str
    const items = row.items.filter(function (it) {
      return it && typeof it.x === "number" && it.str != null;
    });
    if (items.length === 0) return [];

    // Determine gap threshold based on average inter-token distance
    const gaps = [];
    for (let i = 1; i < items.length; i++) {
      var prevEnd = num(items[i - 1].x) + num(items[i - 1].w);
      var curStart = num(items[i].x);
      gaps.push(curStart - prevEnd);
    }
    const avgGap = gaps.length ? gaps.reduce(function (a, b) { return a + b; }, 0) / gaps.length : 0;
    // Use a FIXED threshold.  Within a single PDF row, tokens that belong to the
    // same logical cell are either overlapping (negative gap) or separated by
    // kerning/ligatures (~0–2px).  Tokens in different columns are separated by
    // 15–35px.  An adaptive threshold based on header rows produces >35px (because
    // header words are spread far apart), which collapses all columns into one.
    const threshold = 4;

    function safeStr(v) { return v === undefined || v === null ? "" : String(v); }

    const cells = [];
    var first = items[0];
    var cur = { text: safeStr(first.str), x1: num(first.x), x2: num(first.x) + num(first.w) };
    for (var i = 1; i < items.length; i++) {
      var prev = items[i - 1];
      var curItem = items[i];
      if (!prev || !curItem) continue;
      var gap = num(curItem.x) - (num(prev.x) + num(prev.w));
      if (gap > threshold) {
        cells.push(cur);
        cur = { text: safeStr(curItem.str), x1: num(curItem.x), x2: num(curItem.x) + num(curItem.w) };
      } else {
        var sep = (typeof cur.text === "string" && !cur.text.endsWith(" ")) ? " " : "";
        cur.text = (typeof cur.text === "string" ? cur.text : "") + sep + safeStr(curItem.str);
        cur.x2 = num(curItem.x) + num(curItem.w);
      }
    }
    cells.push(cur);
    return cells;
  }

  function cellsText(cells) {
    return cells.map((c) => c.text.trim()).filter(Boolean);
  }

  // ============================================================
  // Table detection & extraction
  // ============================================================

  const RESERVOIR_HINTS = [
    "Fontenelle Reservoir", "Flaming Gorge Reservoir", "Taylor Park Reservoir",
    "Blue Mesa Reservoir", "Morrow Point Reservoir", "Crystal Reservoir",
    "Vallecito Reservoir", "Navajo Reservoir", "Lake Powell",
    "Hoover Dam – Lake Mead", "Hoover Dam - Lake Mead", "Hoover Dam – Lake Mead ",
    "Davis Dam – Lake Mohave", "Davis Dam - Lake Mohave", "Parker Dam – Lake Havasu", "Parker Dam - Lake Havasu",
    "Upper Basin Power",
    "Flood Control Criteria: Predicted Space", "Flood Control Criteria: Creditable / Effective Space",
  ];

  // Detect the inflow scenario label from a row's text.  Returns the canonical
  // scenario name ("Most Probable" / "Probable Maximum" / "Probable Minimum") or
  // null.  The PDFs spell the label inconsistently:
  //   "Most Probable Inflow"      -> Most Probable
  //   "Probable Maximum Inflow"    -> Probable Maximum
  //   "Maximum Probable Inflow"    -> Probable Maximum  (word order swapped)
  //   "Probable Minimum Inflow"    -> Probable Minimum
  function detectScenarioFromRow(text) {
    if (!text) return null;
    const t = String(text);
    if (/\bMaximum\s+Probable\s+Inflow\b/i.test(t) ||
        /\bProbable\s+Maximum\s+Inflow\b/i.test(t)) {
      return "Probable Maximum";
    }
    if (/\bMinimum\s+Probable\s+Inflow\b/i.test(t) ||
        /\bProbable\s+Minimum\s+Inflow\b/i.test(t)) {
      return "Probable Minimum";
    }
    if (/\bMost\s+Probable\s+Inflow\b/i.test(t)) {
      return "Most Probable";
    }
    return null;
  }

  function extractTables(allPagesText) {
    try {
      // For each page, build rows
      const pageRows = allPagesText.map(function (tc, idx) {
        try { return pageToRows(tc); }
        catch (e) { console.error("pageToRows failed on page", idx + 1, e); return []; }
      });

      // Find pages that begin with the "OPERATION PLAN" marker
      const tables = [];
      for (let p = 0; p < pageRows.length; p++) {
        const rows = pageRows[p];
        if (!rows || !rows.length || !rows[0] || !rows[0].items) continue;
        // The first non-empty row should be the marker
        const first = rows[0].items
          .map(function (i) { return (i && i.str) ? i.str : ""; })
          .join(" ")
          .trim();
        if (!/^OPERATION\s+PLAN\s+FOR\s+COLORADO\s+RIVER\s+SYSTEM\s+RESERVOIRS/i.test(first)) {
          continue;
        }
        // Found a table on page p
        try {
          const table = parseTableStartingOnPage(pageRows, p);
          if (table) tables.push(table);
        } catch (e) {
          console.error("parseTableStartingOnPage failed on page", p + 1, e);
        }
      }

      // KEEP ALL tables — even those with duplicate reservoir names.
      // The 24-Month Study has Hoover/Davis/Parker tables that appear twice
      // (Most Probable Inflow and Elevated Inflow scenarios).  We mark duplicates
      // so the UI and filenames distinguish them.
      const seen = new Map();
      return tables.map((t) => {
        if (seen.has(t.reservoir)) {
          const count = seen.get(t.reservoir) + 1;
          seen.set(t.reservoir, count);
          return { ...t, duplicateIdx: count };
        }
        seen.set(t.reservoir, 1);
        return { ...t, duplicateIdx: 1 };
      });
    } catch (e) {
      console.error("extractTables fatal:", e, e && e.stack);
      throw e;
    }
  }

  // Expose extractTables for external use (compare.html)
  window.extractTables = extractTables;
  console.log("extractTables exposed to window:", typeof window.extractTables);

  // Parse the table that starts on page `startPage` and may span into subsequent pages.
  function parseTableStartingOnPage(pageRows, startPage) {
    // Find the reservoir name: the row immediately following the inflow-scenario
    // marker line.  We accept any of "Most Probable Inflow", "Probable Maximum
    // Inflow", or the swapped "Maximum Probable Inflow".
    let reservoirName = null;
    let headerStartRowIdx = -1;
    {
      const firstPageRows = pageRows[startPage];
      let sawMarker = false;
      let sawStudy = false;
      let sawScenario = false;
      for (let r = 0; r < firstPageRows.length; r++) {
        const text = firstPageRows[r].items.map((i) => i.str).join(" ").trim();
        if (!text) continue;
        if (!sawMarker && /OPERATION\s+PLAN/i.test(text)) { sawMarker = true; continue; }
        if (sawMarker && !sawStudy && /\d{4}\s+24-Month\s+Study/i.test(text)) { sawStudy = true; continue; }
        if (sawStudy && !sawScenario && detectScenarioFromRow(text)) {
          sawScenario = true; continue;
        }
        if (sawScenario) {
          reservoirName = text;
          headerStartRowIdx = r + 1;
          break;
        }
      }
    }
    if (!reservoirName) return null;

    // Collect all rows from this page and subsequent pages until the next
    // "OPERATION PLAN" marker (or end of document).
    const MONTHS_RE = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/i;
    const WY_RE = /^WY$/i;
    const allRows = [];
    for (let p = startPage; p < pageRows.length; p++) {
      const rows = pageRows[p];
      if (!rows || !rows.length) continue;
      // If this is a later page, check for a new OPERATION PLAN marker.
      if (p > startPage) {
        const firstText = (rows[0].items || []).map((i) => i.str || "").join(" ").trim();
        if (/^OPERATION\s+PLAN\s+FOR\s+COLORADO\s+RIVER\s+SYSTEM\s+RESERVOIRS/i.test(firstText)) {
          // A new table marker appeared.  The data rows for THIS table may
          // still appear on the SAME page (below the marker) before the next
          // table begins.  Check: are there any data rows (month/WY) after
          // the marker?  If yes, consume them first before stopping.
          let hadData = false;
          for (let r = 1; r < rows.length; r++) {
            const rowText = (rows[r].items || []).map((i) => i.str || "").join(" ").trim();
            if (MONTHS_RE.test(rowText) || WY_RE.test(rowText)) {
              hadData = true;
              break;
            }
          }
          if (!hadData) break; // No trailing data for this table — move on
        }
        for (const row of rows) allRows.push({ row, page: p });
        continue;
      }
      // First page: skip the first `headerStartRowIdx` rows (marker, study, inflow, name)
      for (let r = headerStartRowIdx; r < rows.length; r++) {
        allRows.push({ row: rows[r], page: p });
      }
    }

    // Convert rows to cells
    const cellRows = allRows.map((ar) => rowToCells(ar.row));

    // Find where the data rows start: first row whose first cell text matches
    // a month-year date string (e.g. "Aug 2025") or standalone month name
    // or "WY" (water year summary).  Also stop on non-data rows like
    // "Model Run ID" or empty rows.
    let dataStart = -1;
    for (let i = 0; i < cellRows.length; i++) {
      const first = cellRows[i][0] ? String(cellRows[i][0].text).trim() : "";
      // Accept: "Aug 2025", "WY 2027", or just "Aug", "WY"
      if (first && !/^(Model\s*Run|Processed|Page|Continued)/i.test(first)) {
        if (first === "WY" || MONTHS_RE.test(first) || /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}$/i.test(first)) {
          dataStart = i;
          break;
        }
      }
    }
    if (dataStart === -1) {
      // Fall back: assume last 30 rows are data
      dataStart = Math.max(0, cellRows.length - 32);
    }

    // Headers are everything before dataStart
    const headerRows = cellRows.slice(0, dataStart);
    const dataRows = cellRows.slice(dataStart).filter((r) => r.length > 0);

    // Build header columns.  The header may span 2-3 lines: top word(s) on one
    // line, units in (parens) on the next line, optional extra qualifiers.
    // We'll merge vertically by computing one column per distinct x-band on
    // the data rows (which is more reliable than trying to parse the multi-line
    // header text).
    const columnBands = computeColumnBands(dataRows);
    const headers = buildHeadersFromBands(headerRows, columnBands);

    // Build the data table by aligning each data row to the column bands
    const alignedData = dataRows.map((r) => alignRow(r, columnBands));

    return {
      reservoir: reservoirName,
      headers,
      rows: alignedData,
    };
  }

  // Determine column boundaries from data rows.  For each row, compute the x
  // positions of its cells.  Cluster these across all rows.
  function computeColumnBands(dataRows) {
    if (!dataRows.length) return [];
    // Collect every (x_center) seen in data cells (excluding the date col 0)
    const xs = [];
    for (const r of dataRows) {
      if (!Array.isArray(r)) continue;
      for (let i = 1; i < r.length; i++) {
        const c = r[i];
        const txt = (c && c.text != null) ? String(c.text).trim() : "";
        if (txt.length > 0) {
          xs.push((c.x1 + c.x2) / 2);
        }
      }
    }
    if (!xs.length) return [];
    xs.sort((a, b) => a - b);
    // Cluster: gaps > ~15px start a new column
    const bands = [];
    let cur = [xs[0]];
    for (let i = 1; i < xs.length; i++) {
      if (xs[i] - xs[i - 1] > 15) {
        bands.push(cur);
        cur = [xs[i]];
      } else {
        cur.push(xs[i]);
      }
    }
    bands.push(cur);
    // Also include the date column at the start (use first row's first cell x)
    const firstDateX = dataRows[0] && dataRows[0][0] ? (dataRows[0][0].x1 + dataRows[0][0].x2) / 2 : 0;
    return [{ x: firstDateX, label: "Date" }].concat(
      bands.map((b) => {
        const avg = b.reduce((a, c) => a + c, 0) / b.length;
        return { x: avg };
      })
    );
  }

  // Build header text for each column band by looking at the multi-line header
  // rows above the data.  We assign each header cell to the nearest band.
  function buildHeadersFromBands(headerRows, columnBands) {
    if (!columnBands.length) return ["Date"];
    // Flatten all header cells across headerRows
    const headerCells = [];
    for (const r of headerRows) {
      if (!Array.isArray(r)) continue;
      for (const c of r) {
        if (!c) continue;
        const txt = c.text != null ? String(c.text).trim() : "";
        if (txt.length > 0) {
          headerCells.push({ x: (c.x1 + c.x2) / 2, text: txt });
        }
      }
    }
    // Group vertically: cells that are roughly the same x (within 8px) but
    // on different rows stack into one column header.
    const cols = columnBands.map((b) => ({ x: b.x, parts: [] }));
    for (const hc of headerCells) {
      // Find nearest band
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < cols.length; i++) {
        const d = Math.abs(cols[i].x - hc.x);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      // Only assign if reasonably close (within ~30px)
      if (bestDist <= 30) {
        cols[bestIdx].parts.push(hc.text);
      }
    }
    return cols.map((c) => {
      if (c.parts.length === 0) return ""; // We'll fill defaults later
      // Deduplicate identical consecutive parts (rare, but safe)
      const seen = new Set();
      const uniq = [];
      for (const p of c.parts) { if (!seen.has(p)) { seen.add(p); uniq.push(p); } }
      return uniq.join(" ").replace(/\s+/g, " ").trim();
    });
  }

  // Assign a data row's cells to column bands by nearest x.
  function alignRow(row, columnBands) {
    if (!Array.isArray(row) || !Array.isArray(columnBands) || !columnBands.length) {
      return [];
    }
    const out = new Array(columnBands.length).fill("");
    for (const c of row) {
      if (!c || c.x1 == null || c.x2 == null) continue;
      const txt = c.text != null ? String(c.text).trim() : "";
      if (!txt) continue;
      const x = (c.x1 + c.x2) / 2;
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < columnBands.length; i++) {
        if (!columnBands[i] || columnBands[i].x == null) continue;
        const d = Math.abs(columnBands[i].x - x);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      // If the cell straddles two bands and is closer to the previous, prefer it
      if (bestDist > 30 && out[bestIdx] !== "") {
        // Try neighbor
        const altIdx = bestIdx + (x > columnBands[bestIdx].x ? 1 : -1);
        if (altIdx >= 0 && altIdx < columnBands.length && columnBands[altIdx]) {
          const altDist = Math.abs(columnBands[altIdx].x - x);
          if (altDist < bestDist) bestIdx = altIdx;
        }
      }
      out[bestIdx] = txt;
    }
    return out;
  }

  // ============================================================
  // Preview-time cleaning: remove empty trailing columns and
  // extract the "Processed on..." footer text.
  // ============================================================

  // Heuristic: is this cell text "footer-like"?  That is, does it contain
  // tokens such as "Processed", "Model Run", "Page", etc. that don't belong
  // in a data row?
  function isFooterLikeText(s) {
    if (!s) return false;
    return /(Processed\s+on|Model\s+Run\s*ID|^Page\s+\d+|^Continued)/i.test(String(s));
  }

  // Look across all cells of all rows for footer-like text.  Returns
  // { processedText, footerRowIdxs, footerColIdxs }.
  function findFooterContent(rows) {
    const footerRowIdxs = new Set();
    const footerColIdxs = new Set();
    const parts = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || [];
      for (let j = 0; j < r.length; j++) {
        const v = String(r[j] || "").trim();
        if (!v) continue;
        if (isFooterLikeText(v)) {
          parts.push(v);
          footerRowIdxs.add(i);
          footerColIdxs.add(j);
        }
      }
    }
    const processedText = parts.join(" ").replace(/\s+/g, " ").trim();
    return { processedText, footerRowIdxs, footerColIdxs };
  }

  // Clean a table in place: drop footer rows, remove any column whose
  // header is the auto-generated "ColN" name AND that contains only
  // footer-like text (or nothing).  Returns the harvested footer text.
  function cleanTableForPreview(table) {
    // 1) Find footer text anywhere in the table
    const { processedText: detected, footerRowIdxs, footerColIdxs } = findFooterContent(table.rows);
    let processedText = detected;

    // 2) Drop footer rows entirely
    if (footerRowIdxs.size > 0) {
      table.rows = table.rows.filter((_, i) => !footerRowIdxs.has(i));
    }

    // 3) Determine which columns to drop.  A column is droppable when:
    //    - its header is the auto-generated "ColN" name, AND
    //    - it had footer text OR is now empty.
    const dropSet = new Set();
    for (let c = 0; c < table.headers.length; c++) {
      const h = String(table.headers[c] || "");
      const isAutoName = /^Col\d+$/i.test(h);
      if (!isAutoName) continue;
      const hadFooter = footerColIdxs.has(c);
      let hasAnyData = false;
      for (const r of table.rows) {
        const v = r[c];
        if (v && String(v).trim().length > 0) {
          hasAnyData = true;
          break;
        }
      }
      if (hadFooter || !hasAnyData) {
        dropSet.add(c);
      }
    }

    // 4) Remove the droppable columns
    if (dropSet.size > 0) {
      const keep = new Set();
      for (let i = 0; i < table.headers.length; i++) {
        if (!dropSet.has(i)) keep.add(i);
      }
      table.headers = table.headers.filter((_, i) => keep.has(i));
      table.rows = table.rows.map((r) => r.filter((_, i) => keep.has(i)));
    }

    return { processedText };
  }

  // ============================================================
  // CSV building & naming
  // ============================================================

  function csvEscape(v) {
    if (v == null) return "";
    const s = String(v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function rowsToCsv(headers, rows) {
    const out = [];
    out.push(headers.map(csvEscape).join(","));
    for (const r of rows) {
      out.push(r.map(csvEscape).join(","));
    }
    return out.join("\n");
  }

  function slugify(name) {
    return name
      .toLowerCase()
      .replace(/[–—]/g, "-")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .substring(0, 60);
  }

  function toCsvAndSlug(table) {
    // Fill empty headers with default column names (C1, C2, …)
    const headers = table.headers.map((h, i) => h && h.length > 0 ? h : "Col" + (i + 1));
    // Promote the first column to a friendlier default if it's the date and the
    // header was missing
    if (headers[0] === "Col1") headers[0] = "Date";
    const csv = rowsToCsv(headers, table.rows);
    // Add duplicate suffix for tables that appear more than once (Hoover, Davis, Parker)
    const dupSuffix = table.duplicateIdx > 1 ? "_" + table.duplicateIdx : "";
    const slug = slugify(table.reservoir) + dupSuffix;
    return { csv, slug, headers };
  }

  // ============================================================
  // Results UI
  // ============================================================

  function showResults() {
    // Convert all tables to CSV + slug
    detectedTables = detectedTables.map((t) => {
      const { csv, slug, headers } = toCsvAndSlug(t);
      return { ...t, csv, slug, headers, selected: true };
    });

    summaryBanner.hidden = false;
    summaryBanner.textContent = "Detected " + detectedTables.length + " table" +
      (detectedTables.length === 1 ? "" : "s") + " in " + currentFileName + ".";

    resultsSection.hidden = false;
    tablesList.innerHTML = "";

    // Add "Select All / None" header
    const selectHeader = document.createElement("div");
    selectHeader.className = "tables-list-header";
    selectHeader.innerHTML =
      '<label class="select-all-label">' +
        '<input type="checkbox" id="select-all" checked>' +
        '<span>Select All / None</span>' +
      '</label>';
    tablesList.appendChild(selectHeader);

    // Add each table item with checkbox and preview button
    detectedTables.forEach((t, idx) => {
      const item = document.createElement("div");
      item.className = "table-item selected";
      item.innerHTML =
        '<input type="checkbox" class="table-checkbox" data-idx="' + idx + '" checked>' +
        '<svg class="ti-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' +
        '<span>' + escapeHtml(t.reservoir) + '</span>' +
        (t.duplicateIdx > 1 ? '<span class="dup-badge">' + t.duplicateIdx + '</span>' : '') +
        '<button class="preview-btn" title="Preview table" data-idx="' + idx + '">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>' +
        '</button>';
      tablesList.appendChild(item);
    });

    // Wire up preview buttons
    document.querySelectorAll(".preview-btn").forEach((btn) => {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        const idx = parseInt(this.getAttribute("data-idx"), 10);
        if (!isNaN(idx) && detectedTables[idx]) {
          openPreviewModal(detectedTables[idx]);
        }
      });
    });

    // Add selection count footer
    const footer = document.createElement("div");
    footer.className = "tables-list-footer";
    footer.innerHTML = '<span id="selection-count">' + detectedTables.length + ' of ' + detectedTables.length + ' selected</span>';
    tablesList.appendChild(footer);

    // Wire up select-all toggle
    const selectAllCheckbox = document.getElementById("select-all");
    selectAllCheckbox.addEventListener("change", function () {
      const checked = this.checked;
      detectedTables.forEach((t, i) => { t.selected = checked; });
      document.querySelectorAll(".table-checkbox").forEach((cb) => { cb.checked = checked; });
      document.querySelectorAll(".table-item").forEach((item) => {
        item.classList.toggle("selected", checked);
      });
      updateSelectionCount();
    });

    // Wire up individual checkboxes
    document.querySelectorAll(".table-checkbox").forEach((cb) => {
      cb.addEventListener("change", function () {
        const idx = parseInt(this.getAttribute("data-idx"), 10);
        if (!isNaN(idx) && detectedTables[idx]) {
          detectedTables[idx].selected = this.checked;
        }
        const item = this.closest(".table-item");
        if (item) item.classList.toggle("selected", this.checked);
        updateSelectionCount();
        // Sync select-all checkbox
        const allSelected = detectedTables.every((t) => t.selected);
        const noneSelected = detectedTables.every((t) => !t.selected);
        selectAllCheckbox.checked = allSelected;
        selectAllCheckbox.indeterminate = !allSelected && !noneSelected;
      });
    });

    // Wire up action buttons
    downloadZipBtn.onclick = downloadAllAsZip;
    downloadIndivBtn.onclick = downloadAllIndividually;
  }

  function updateSelectionCount() {
    const sel = detectedTables.filter((t) => t.selected);
    const el = document.getElementById("selection-count");
    if (el) {
      el.textContent = sel.length + " of " + detectedTables.length + " selected";
    }
  }

  // ============================================================
  // Historical / forecasted detection
  // ============================================================

  // Map a row's first cell to a Date.  Returns null when the row label
  // cannot be parsed (e.g. "WY" alone, or anything else).
  //   "Aug"      -> use the reportMonth (the report's "current" month)
  //   "Aug 2025" -> Date(2025, 7)  (month is 0-indexed in JS)
  //   "WY 2027"  -> Date(2027, 9)  (water year ends Sept 30; we use Oct 1
  //                                  as a stable midpoint inside the WY)
  const MONTH_NAME_TO_IDX = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
  };
  const MONTH_NAMES = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];

  function parseRowDate(label, reportMonth) {
    if (!label) return null;
    const t = String(label).trim();
    // "WY YYYY" or "WY"
    const wyMatch = /^WY\s+(\d{4})$/i.exec(t);
    if (wyMatch) {
      const y = parseInt(wyMatch[1], 10);
      if (!isNaN(y)) return new Date(y, 9, 1);
    }
    // "Mon YYYY"
    const myMatch = /^([A-Za-z]{3,9})\s+(\d{4})$/i.exec(t);
    if (myMatch) {
      const mKey = myMatch[1].toLowerCase().substring(0, 3);
      const mi = MONTH_NAME_TO_IDX[mKey];
      const y = parseInt(myMatch[2], 10);
      if (mi != null && !isNaN(y)) return new Date(y, mi, 1);
    }
    // bare month
    if (reportMonth) {
      const mKey = t.toLowerCase().substring(0, 3);
      const mi = MONTH_NAME_TO_IDX[mKey];
      if (mi != null) {
        return new Date(reportMonth.getFullYear(), mi, 1);
      }
    }
    return null;
  }

  // Try to read the report's "current" month from the PDF filename, which
  // USBR encodes as e.g. "AUG26_6.pdf" (Aug 2026) or "JAN25.pdf" (Jan 2025).
  function detectReportMonthFromFilename(name) {
    if (!name) return null;
    const base = String(name).replace(/\.pdf$/i, "");
    // Look for a 3-letter month prefix followed by 2 or 4 digits.
    const m = /^([A-Za-z]{3,9})\s*[_-]?(\d{2,4})/.exec(base);
    if (!m) return null;
    const monKey = m[1].toLowerCase().substring(0, 3);
    const mi = MONTH_NAME_TO_IDX[monKey];
    if (mi == null) return null;
    let y = parseInt(m[2], 10);
    if (isNaN(y)) return null;
    // 2-digit year: pivot at 70 (>=70 means 19xx, else 20xx).
    if (m[2].length === 2) {
      y = y >= 70 ? 1900 + y : 2000 + y;
    }
    return new Date(y, mi, 1);
  }

  // Data-driven fallback.  When no bare-month rows exist (everything is
  // "Mon YYYY"), the report month is the LATEST dated month in the data.
  // The 24-Month Study covers the report month + 23 future months, so the
  // last dated row is the report month.  (Some tables include water-year
  // summary rows that have a different cadence; we ignore those.)
  function detectReportMonthFromData(rows) {
    let latest = null;
    for (const r of rows) {
      const first = String(r[0] || "").trim();
      // Skip "WY YYYY" rows because the WY-end date isn't a "month".
      if (/^WY(\s|$)/i.test(first)) continue;
      // Skip bare month rows here — that branch is handled separately
      // in detectReportMonth() and would otherwise treat "Aug" as a
      // current-year row even when it should be last year's row.
      if (/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/i.test(first)) continue;
      const d = parseRowDate(first, null);
      if (d) {
        if (!latest || d.getTime() > latest.getTime()) latest = d;
      }
    }
    return latest;
  }

  // Determine the report's "current" month using the best available signal.
  // Priority:
  //   1. PDF filename (e.g. "AUG26_6.pdf" -> Aug 2026)
  //   2. A bare-month row whose year is today (e.g. "Aug" in 2026)
  //   3. The latest "Mon YYYY" date found in the data (works for 24-month
  //      studies whose last row is the report month)
  function detectReportMonth(rows) {
    const fromName = detectReportMonthFromFilename(currentFileName);
    if (fromName) return fromName;

    for (const r of rows) {
      const first = String(r[0] || "").trim();
      if (/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/i.test(first)) {
        const mKey = first.toLowerCase().substring(0, 3);
        const mi = MONTH_NAME_TO_IDX[mKey];
        if (mi != null) {
          return new Date(new Date().getFullYear(), mi, 1);
        }
      }
    }
    return detectReportMonthFromData(rows);
  }

  // Returns true if the given row (by first-cell date label) represents a
  // historical month, false if it's forecasted.
  // The "report month" itself is treated as forecasted (it is the first
  // month of the forecast horizon — the value reported in the table for
  // that month is the most-recent observed value projected forward).
  function isRowHistorical(row, reportMonth) {
    if (!reportMonth) return false;
    const label = String((row && row[0]) || "").trim();
    const d = parseRowDate(label, reportMonth);
    if (!d) return false; // unknown label -> treat as forecasted
    // Historical = the month begins strictly BEFORE the report month.
    return d.getTime() < reportMonth.getTime();
  }

  // ============================================================
  // Preview Modal Functions
  // ============================================================

  function openPreviewModal(table) {
    // Store reference to the ORIGINAL table for chart rendering
    currentPreviewTable = table;
    currentPreviewTable._originalTable = table; // Self-reference for chart
    
    previewTitle.textContent = table.reservoir + (table.duplicateIdx > 1 ? " (" + table.duplicateIdx + ")" : "");

    // Clone the table so we can mutate headers/rows for the preview only
    // (we don't want to dirty the underlying detectedTables, since that's
    // also used to build CSV output).
    const previewTable = {
      reservoir: table.reservoir,
      headers: table.headers.slice(),
      rows: table.rows.map((r) => r.slice()),
      _originalTable: table // Reference to original table for chart
    };

    // For Hoover/Davis/Parker tables, DON'T clean the previewTable - use original for both display and chart
    const reservoirLower = (table.reservoir || "").toLowerCase();
    const isHooverOrDavis = reservoirLower.includes("hoover dam") || 
                           reservoirLower.includes("davis dam") ||
                           reservoirLower.includes("parker dam") ||
                           reservoirLower.includes("lake mead") ||
                           reservoirLower.includes("lake mohave") ||
                           reservoirLower.includes("lake havasu");
    
    // Only clean if not Hoover/Davis table
    let processedText = "";
    if (!isHooverOrDavis) {
      const result = cleanTableForPreview(previewTable);
      processedText = result.processedText;
    }

    // Fill empty headers with default column names (C1, C2, …)
    const headers = previewTable.headers.map((h, i) => h && String(h).length > 0 ? h : "Col" + (i + 1));
    if (headers[0] === "Col1") headers[0] = "Date";
    previewThead.innerHTML = "<tr>" + headers.map((h) => "<th>" + escapeHtml(h) + "</th>").join("") + "</tr>";

    // Determine report month for historical/forecasted classification
    const reportMonth = detectReportMonth(previewTable.rows);

    // Build table body (limit to first 50 rows for performance)
    const maxRows = Math.min(previewTable.rows.length, 50);
    let tbodyHtml = "";
    for (let i = 0; i < maxRows; i++) {
      const row = previewTable.rows[i];
      const historical = isRowHistorical(row, reportMonth);
      const cls = historical ? ' class="historical"' : "";
      tbodyHtml += "<tr" + cls + ">" + row.map((cell) => "<td>" + escapeHtml(cell || "") + "</td>").join("") + "</tr>";
    }
    if (previewTable.rows.length > 50) {
      tbodyHtml += '<tr><td colspan="' + headers.length + '" style="text-align:center;color:var(--color-text-muted);">... and ' + (previewTable.rows.length - 50) + ' more rows</td></tr>';
    }
    previewTbody.innerHTML = tbodyHtml;

    // Show the "Processed on..." footer below the table, if present.
    if (processedText) {
      previewProcessed.textContent = processedText;
      previewProcessed.hidden = false;
    } else if (previewProcessed) {
      previewProcessed.hidden = true;
    }

    // Show the historical/forecasted legend
    if (previewLegend) {
      previewLegend.hidden = false;
    }

    // Show chart button if table has elevation data
    // Pass the ORIGINAL table (currentPreviewTable) for chart data, and the previewTable for display
    updateChartButton(previewTable, currentPreviewTable);

    previewModal.classList.remove("hidden");
    document.body.style.overflow = "hidden";
  }

  function closePreviewModal() {
    previewModal.classList.add("hidden");
    document.body.style.overflow = "";
    currentPreviewTable = null;
    // Destroy chart when closing modal
    if (elevationChartInstance) {
      elevationChartInstance.destroy();
      elevationChartInstance = null;
    }
    previewChartWrap.classList.add("hidden");
    previewChartBtn.hidden = true;
  }

  // ============================================================
  // Elevation Chart Functions
  // ============================================================

  // Check if a header contains elevation-related keywords
  function isElevationColumn(headerText) {
    if (!headerText) return false;
    const h = headerText.toLowerCase();
    // Match common elevation header variations
    const elevPatterns = [
      "elevation", "elev",        // "Elevation", "Elev"
      "water surface",           // "Water Surface Elevation"
      "reservoir elevation",     // "Reservoir Elevation"
      "lake elevation",         // "Lake Elevation"
      "pool elevation",          // "Pool Elevation"
      "stage",                   // "Stage" (water level)
      "surface elev",            // "Surface Elevation"
      "sp ill",                  // "Sp. Ill." (Special Illustration, might appear)
      "hoover dam",             // Hoover Dam - Lake Mead
      "lake mead",              // Lake Mead
    ];
    // Check if header contains any elevation-related term
    for (const pattern of elevPatterns) {
      if (h.includes(pattern)) return true;
    }
    return false;
  }

  // Find the first elevation column index
  function findElevationColumnIndex(headers, rows, reservoirName) {
    // Log headers for debugging
    console.log("Finding elevation column for:", reservoirName);
    console.log("Headers:", headers);
    
    // First try header-based detection - look for actual "elevation" text
    for (let i = 1; i < headers.length; i++) {
      const h = String(headers[i] || "").toLowerCase();
      // Only match if header actually contains "elevation" keyword
      if (h.includes("elevation") || h.includes("elev")) {
        console.log("Found elevation in header at index", i, ":", headers[i]);
        return i;
      }
    }
    
    // Check if this is a known reservoir with elevation data
    const reservoirLower = (reservoirName || "").toLowerCase();
    const isKnownElevationReservoir = 
      reservoirLower.includes("lake mead") ||
      reservoirLower.includes("lake mohave") ||
      reservoirLower.includes("lake havasu") ||
      reservoirLower.includes("hoover dam") ||
      reservoirLower.includes("davis dam") ||
      reservoirLower.includes("parker dam") ||
      reservoirLower.includes("fontenelle") ||
      reservoirLower.includes("flaming gorge") ||
      reservoirLower.includes("blue mesa") ||
      reservoirLower.includes("morrow point") ||
      reservoirLower.includes("crystal") ||
      reservoirLower.includes("vallecito") ||
      reservoirLower.includes("navajo") ||
      reservoirLower.includes("lake powell") ||
      reservoirLower.includes("taylor park");
    
    // If it's a known reservoir, look for columns with elevation-like values
    if (isKnownElevationReservoir && rows && rows.length > 0) {
      // Find all columns with numeric data and their ranges
      const columnStats = [];
      // Start from column 2 (skip Date and Inflow columns which are typically first)
      for (let i = 2; i < Math.min(headers.length, 15); i++) {
        let validCount = 0;
        let sum = 0;
        let min = Infinity;
        let max = -Infinity;
        const sampleSize = Math.min(rows.length, 30);
        
        for (let r = 0; r < sampleSize; r++) {
          if (rows[r]) {
            const val = rows[r][i];
            if (val) {
              const num = parseFloat(String(val).replace(/,/g, ""));
              if (!isNaN(num)) {
                validCount++;
                sum += num;
                if (num < min) min = num;
                if (num > max) max = num;
              }
            }
          }
        }
        
        const validRatio = sampleSize > 0 ? validCount / sampleSize : 0;
        if (validCount >= 5 && validRatio >= 0.2) {
          const avg = sum / validCount;
          columnStats.push({ idx: i, avg, min, max, validCount, validRatio });
          console.log("Column", i, "- Header:", headers[i], "- Avg:", avg.toFixed(0), "Min:", min.toFixed(0), "Max:", max.toFixed(0), "Valid:", validRatio.toFixed(2));
        }
      }
      
      // Find the column that looks like elevation based on value range
      // For Lake Mead: ~1050-1250, Lake Mohave: ~630-650, Lake Havasu: ~445-450
      // Prioritize columns with reasonable elevation ranges
      for (const stat of columnStats) {
        // Skip if values look like inflow (very negative) or massive numbers
        if (stat.min < -100 || stat.max > 15000) continue;
        
        // Accept columns with elevation-like values (very broad range)
        // Colorado River reservoirs: ~400-7500 ft
        if (stat.avg >= 400 && stat.avg <= 7500) {
          console.log("Selected elevation column", stat.idx, "with avg", stat.avg.toFixed(0));
          return stat.idx;
        }
      }
      
      // If still no match, try the first column with reasonable elevation-like values
      for (const stat of columnStats) {
        if (stat.avg >= 400 && stat.avg <= 15000) {
          console.log("Fallback: selected column", stat.idx, "with avg", stat.avg.toFixed(0));
          return stat.idx;
        }
      }
    }
    
    console.log("No elevation column found, returning -1");
    return -1;
  }

  // Update chart button visibility based on table content
  function updateChartButton(table, originalTable) {
    // Always show chart button for all tables - let user decide
    if (!table || !table.headers || table.rows.length === 0) {
      previewChartBtn.hidden = true;
      return;
    }
    
    previewChartBtn.hidden = false;
  }

  // Create and render the elevation chart
  function renderElevationChart() {
    if (!currentPreviewTable) {
      console.error("No current preview table");
      return;
    }

    const table = currentPreviewTable;
    const chartTable = table._originalTable || table;
    const headers = chartTable.headers;
    
    // Find the column that has "elevation" in the header (case-insensitive search)
    let colIdx = -1;
    let colHeader = "Value";
    
    for (let i = 0; i < headers.length; i++) {
      const h = String(headers[i] || "").toLowerCase();
      if (h.includes("elevation") || h.includes("elev")) {
        colIdx = i;
        colHeader = String(headers[i]).trim();
        console.log("Found elevation column at index", colIdx, "with header:", colHeader);
        break;
      }
    }
    
    // If no elevation column found by header, try to find by value range
    if (colIdx === -1) {
      console.log("No elevation header found, searching for elevation-like values...");
      for (let i = 1; i < Math.min(headers.length, 20); i++) {
        let validCount = 0;
        let sum = 0;
        let min = Infinity;
        let max = -Infinity;
        const sampleSize = Math.min(chartTable.rows.length, 30);
        
        for (let r = 0; r < sampleSize; r++) {
          if (chartTable.rows[r]) {
            const val = chartTable.rows[r][i];
            if (val) {
              const num = parseFloat(String(val).replace(/,/g, ""));
              if (!isNaN(num)) {
                validCount++;
                sum += num;
                if (num < min) min = num;
                if (num > max) max = num;
              }
            }
          }
        }
        
        if (validCount >= sampleSize * 0.5 && sampleSize > 0) {
          const avg = sum / validCount;
          // Check for elevation-like values (Colorado River: ~400-7500 ft)
          if (avg >= 400 && avg <= 7500 && max <= 15000) {
            colIdx = i;
            colHeader = String(headers[i]).trim() || "Column " + i;
            console.log("Found elevation-like column at index", colIdx, "with avg", avg.toFixed(0));
            break;
          }
        }
      }
    }
    
    // If still no column found, hide chart
    if (colIdx === -1) {
      console.error("Could not find elevation column");
      alert("Could not find an Elevation column in this table");
      previewChartWrap.classList.add("hidden");
      return;
    }

    // Determine report month for historical/forecasted classification
    const reportMonth = detectReportMonth(chartTable.rows);

    // Collect all data points - store with historical flag
    const chartData = [];

    for (let i = 0; i < chartTable.rows.length; i++) {
      const row = chartTable.rows[i];
      if (!row) continue;
      
      const label = row[0] ? String(row[0]).trim() : "";
      const value = row[colIdx];
      if (!value) continue;

      // Try to parse the value
      const numValue = parseFloat(String(value).replace(/,/g, ""));
      if (isNaN(numValue)) continue;

      const date = parseRowDate(label, reportMonth);
      const dateLabel = date ? (date.getMonth() + 1) + "/" + date.getFullYear() : label;
      const isHistorical = date && isRowHistorical(row, reportMonth);

      chartData.push({
        x: chartData.length,
        y: numValue,
        label: dateLabel,
        isHistorical: isHistorical
      });
    }

    console.log("Chart data collected:", chartData.length, "points");

    // If not enough valid data points, hide chart
    if (chartData.length < 2) {
      console.error("Not enough data points:", chartData.length);
      alert("Could not generate chart: not enough numeric data found in Elevation column");
      previewChartWrap.classList.add("hidden");
      return;
    }

    // Get canvas and destroy existing chart
    const canvas = document.getElementById("preview-chart");
    if (!canvas) {
      console.error("Canvas not found");
      return;
    }
    
    if (elevationChartInstance) {
      elevationChartInstance.destroy();
      elevationChartInstance = null;
    }

    // Update title
    previewChartTitle.textContent = colHeader + " Over Time";

    // Create chart with a single continuous dataset
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      console.error("Could not get canvas context");
      return;
    }
    
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    const gridColor = isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)";
    const textColor = isDark ? "#e5e7eb" : "#374151";

    // Create point colors array based on historical/forecast status
    const pointColors = chartData.map(d => d.isHistorical ? "#f97316" : "#2563eb");
    const pointBorderColors = chartData.map(() => "#ffffff");

    try {
      elevationChartInstance = new Chart(ctx, {
        type: "line",
        data: {
          labels: chartData.map(d => d.label),
          datasets: [
            {
              label: "Elevation",
              data: chartData.map(d => ({ x: d.x, y: d.y })),
              borderColor: "#6b7280",
              backgroundColor: "transparent",
              pointBackgroundColor: pointColors,
              pointBorderColor: pointBorderColors,
              pointRadius: 5,
              pointHoverRadius: 7,
              borderWidth: 2,
              tension: 0.1
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: true,
          interaction: {
            intersect: false,
            mode: "index"
          },
          plugins: {
            legend: {
              display: false
            },
            tooltip: {
              backgroundColor: isDark ? "#374151" : "#fff",
              titleColor: isDark ? "#f3f4f6" : "#111827",
              bodyColor: isDark ? "#d1d5db" : "#374151",
              borderColor: isDark ? "#4b5563" : "#e5e7eb",
              borderWidth: 1,
              padding: 10,
              displayColors: true,
              filter: function(tooltipItem) {
                return true;
              },
              callbacks: {
                title: function(context) {
                  const dataIndex = context[0] && context[0].dataIndex;
                  if (chartData[dataIndex]) {
                    return chartData[dataIndex].label;
                  }
                  return '';
                },
                label: function(context) {
                  const dataIndex = context.dataIndex;
                  const isHist = chartData[dataIndex] && chartData[dataIndex].isHistorical;
                  const type = isHist ? "Historical" : "Forecasted";
                  return type + ": " + context.parsed.y.toLocaleString();
                }
              }
            }
          },
          scales: {
            x: {
              type: 'linear',
              grid: {
                color: gridColor
              },
              ticks: {
                color: textColor,
                maxRotation: 45,
                minRotation: 0,
                callback: function(val) {
                  // val is the data index (x value from chartData)
                  // Use val directly since x values are sequential 0, 1, 2, ...
                  if (chartData[val]) {
                    return chartData[val].label;
                  }
                  return '';
                }
              }
            },
            y: {
              grid: {
                color: gridColor
              },
              ticks: {
                color: textColor,
                callback: function(value) {
                  return value.toLocaleString();
                }
              },
              title: {
                display: true,
                text: colHeader,
                color: textColor
              }
            }
          }
        }
      });
      
      // AGGRESSIVELY ensure the chart wrapper is visible
      previewChartWrap.classList.remove("hidden");
      previewChartWrap.style.removeProperty("display");
      previewChartWrap.style.display = "";
      previewChartWrap.style.visibility = "visible";
      previewChartWrap.style.opacity = "1";
      previewChartWrap.style.height = "auto";
      previewChartWrap.style.minHeight = "400px";
      
      // Also ensure the canvas container has a height
      const canvasWrap = previewChartWrap.querySelector('.preview-chart-canvas-wrap');
      if (canvasWrap) {
        canvasWrap.style.height = "320px";
        canvasWrap.style.minHeight = "320px";
      }
      
    } catch (e) {
      console.error("Chart creation error:", e);
      alert("Chart error: " + e.message);
    }
  }

  // Save chart as PNG
  function saveChartAsPng() {
    const canvas = document.getElementById("preview-chart");
    if (!canvas || !elevationChartInstance) return;

    // Create a temporary canvas with extra space for title and legend
    const tempCanvas = document.createElement("canvas");
    const ctx = tempCanvas.getContext("2d");
    const padding = 40;
    const titleHeight = 60;
    const legendHeight = 50;

    tempCanvas.width = canvas.width + padding * 2;
    tempCanvas.height = canvas.height + padding * 2 + titleHeight + legendHeight;

    // Fill background
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    ctx.fillStyle = isDark ? "#1f2937" : "#ffffff";
    ctx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);

    // Draw title
    ctx.fillStyle = isDark ? "#f3f4f6" : "#111827";
    ctx.font = "bold 16px Inter, Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(previewChartTitle.textContent, tempCanvas.width / 2, padding + 20);

    // Draw chart
    ctx.drawImage(canvas, padding, padding + titleHeight);

    // Draw legend
    const legendY = tempCanvas.height - padding - 20;
    const legendBoxSize = 12;
    const legendSpacing = 150;
    const legendStartX = tempCanvas.width / 2 - legendSpacing;

    ctx.fillStyle = "#f97316";
    ctx.fillRect(legendStartX - legendBoxSize - 5, legendY - legendBoxSize, legendBoxSize, legendBoxSize);
    ctx.fillStyle = isDark ? "#e5e7eb" : "#374151";
    ctx.font = "12px Inter, Arial, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("Historical", legendStartX, legendY);

    ctx.fillStyle = "#2563eb";
    ctx.fillRect(legendStartX + legendSpacing - legendBoxSize - 5, legendY - legendBoxSize, legendBoxSize, legendBoxSize);
    ctx.fillStyle = isDark ? "#e5e7eb" : "#374151";
    ctx.fillText("Forecasted", legendStartX + legendSpacing + 5, legendY);

    // Download
    const link = document.createElement("a");
    link.download = baseNameOfCurrentPdf() + "__" + currentPreviewTable.slug + "_elevation.png";
    link.href = tempCanvas.toDataURL("image/png");
    link.click();
  }

  // Wire up chart button
  previewChartBtn.addEventListener("click", function() {
    renderElevationChart();
  });

  // Wire up hide chart button
  previewChartHide.addEventListener("click", function() {
    previewChartWrap.classList.add("hidden");
  });

  // Wire up save PNG button
  previewSavePngBtn.addEventListener("click", function() {
    saveChartAsPng();
  });

  // Wire up preview modal close button
  previewClose.addEventListener("click", closePreviewModal);

  // Close modal on backdrop click
  previewModal.addEventListener("click", function (e) {
    if (e.target === previewModal) {
      closePreviewModal();
    }
  });

  // Close modal on Escape key
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !previewModal.classList.contains("hidden")) {
      closePreviewModal();
    }
  });

  // Wire up preview download button
  previewDownloadBtn.addEventListener("click", function () {
    if (currentPreviewTable) {
      const idx = String(detectedTables.indexOf(currentPreviewTable) + 1).padStart(2, "0");
      const filename = baseNameOfCurrentPdf() + "__" + idx + "_" + currentPreviewTable.slug + ".csv";
      const blob = new Blob([currentPreviewTable.csv], { type: "text/csv;charset=utf-8;" });
      triggerDownload(blob, filename);
    }
  });

  function escapeHtml(s) {
    var AMP = String.fromCharCode(38);
    var LT = String.fromCharCode(60);
    var GT = String.fromCharCode(62);
    var QUOT = String.fromCharCode(34);
    return String(s)
      .replace(/&/g, AMP + "amp;")
      .replace(/</g, AMP + "lt;")
      .replace(/>/g, AMP + "gt;")
      .replace(/"/g, AMP + "quot;");
  }

  function baseNameOfCurrentPdf() {
    return (currentFileName || "24-month-study").replace(/\.pdf$/i, "");
  }

  async function downloadAllAsZip() {
    if (!window.JSZip) {
      showError("JSZip failed to load. Check your network connection.");
      return;
    }
    const selected = detectedTables.filter((t) => t.selected);
    if (!selected.length) {
      showError("Please select at least one table to download.");
      return;
    }
    const zip = new window.JSZip();
    const folderName = selected.length === detectedTables.length
      ? baseNameOfCurrentPdf() + "_tables"
      : baseNameOfCurrentPdf() + "_tables_" + selected.length + "selected";
    const folder = zip.folder(folderName);
    for (let i = 0; i < selected.length; i++) {
      const t = selected[i];
      // Use a numeric prefix to keep natural sort order
      const idx = String(i + 1).padStart(2, "0");
      const name = idx + "_" + t.slug + ".csv";
      folder.file(name, t.csv);
    }
    setProgress(0, "Building ZIP…");
    progressCard.hidden = false;
    try {
      const blob = await zip.generateAsync({ type: "blob" }, (m) => {
        setProgress(m.percent, "Building ZIP… " + Math.round(m.percent) + "%");
      });
      setProgress(100, "Done.");
      progressCard.hidden = true;
      triggerDownload(blob, folderName + ".zip");
    } catch (err) {
      progressCard.hidden = true;
      showError("Failed to build ZIP: " + err.message);
    }
  }

  function downloadAllIndividually() {
    const selected = detectedTables.filter((t) => t.selected);
    if (!selected.length) {
      showError("Please select at least one table to download.");
      return;
    }
    // Browsers throttle multiple downloads; we still trigger them in sequence
    // with a small delay so the user is prompted for each.
    selected.forEach((t, i) => {
      const idx = String(i + 1).padStart(2, "0");
      const filename = baseNameOfCurrentPdf() + "__" + idx + "_" + t.slug + ".csv";
      setTimeout(() => {
        const blob = new Blob([t.csv], { type: "text/csv;charset=utf-8;" });
        triggerDownload(blob, filename);
      }, i * 250);
    });
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // ============================================================
  // Auto-load PDF from URL parameter
  // ============================================================

  async function loadPdfFromUrl(url) {
    currentFileName = url.split("/").pop() || "24-month-study.pdf";
    errEl.hidden = true;
    summaryBanner.hidden = true;
    resultsSection.hidden = true;
    detectedTables = [];
    progressCard.hidden = false;
    setProgress(0, "Fetching PDF from URL…");

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error("HTTP " + response.status + ": " + response.statusText);
      }
      const arrayBuffer = await response.arrayBuffer();
      setProgress(10, "Loading PDF document…");
      const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      setProgress(15, "Loaded PDF (" + pdf.numPages + " pages). Extracting text…");

      const allPagesText = new Array(pdf.numPages);
      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const tc = await page.getTextContent();
        allPagesText[p - 1] = tc;
        const pct = 15 + (p / pdf.numPages) * 75;
        setProgress(pct, "Extracting text from page " + p + " of " + pdf.numPages + "…");
      }

      setProgress(92, "Reconstructing tables…");
      detectedTables = extractTables(allPagesText);

      setProgress(100, "Done.");
      progressCard.hidden = true;

      if (detectedTables.length === 0) {
        showError("No operation-plan tables were found in this PDF. The format may be unrecognized.");
        return;
      }

      showResults();
    } catch (err) {
      console.error(err);
      progressCard.hidden = true;
      showError("Failed to fetch PDF: " + (err && err.message ? err.message : err) +
        ". Note: PDFs must be hosted on a server that allows cross-origin (CORS) requests.");
    }
  }

  // Check for URL parameter on page load
  (function autoLoadPdf() {
    const url = getPdfUrlFromParams();
    if (url) {
      loadPdfFromUrl(url);
    }
  })();
})();
