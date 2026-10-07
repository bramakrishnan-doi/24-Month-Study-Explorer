/* ============================================================
   24-Month Study Comparator
   Compares operational data from up to 3 24-Month Study PDFs
   Standalone version with embedded extraction logic
   ============================================================ */

(function () {
  "use strict";

  // ====== EXTRACTION FUNCTIONS (embedded from extractor.js) ======

  // Reconstruct a "page layout" from a PDF.js textContent object.
  function pageToRows(tc) {
    if (!tc || !tc.items) return [];
    const items = tc.items
      .filter((it) => it && it.str && it.str.trim().length > 0)
      .map((it) => {
        var t = it.transform;
        return {
          str: it.str,
          x: t && t.length > 4 ? t[4] : 0,
          y: t && t.length > 5 ? t[5] : 0,
          w: it.width || 0,
          h: it.height || 0,
        };
      });

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

    buckets.sort((a, b) => b.y - a.y);
    return buckets.map((b) => {
      const sorted = b.items.slice().sort((a, b2) => a.x - b2.x);
      return { y: b.y, items: sorted };
    });
  }

  function num(v, fallback) {
    if (v === undefined || v === null || isNaN(v)) return fallback === undefined ? 0 : fallback;
    return Number(v);
  }

  function rowToCells(row) {
    if (!row || !row.items || !Array.isArray(row.items) || row.items.length === 0) return [];
    const items = row.items.filter(function (it) {
      return it && typeof it.x === "number" && it.str != null;
    });
    if (items.length === 0) return [];

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

  function computeColumnBands(dataRows) {
    if (!dataRows.length) return [];
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
    const firstDateX = dataRows[0] && dataRows[0][0] ? (dataRows[0][0].x1 + dataRows[0][0].x2) / 2 : 0;
    return [{ x: firstDateX, label: "Date" }].concat(
      bands.map((b) => {
        const avg = b.reduce((a, c) => a + c, 0) / b.length;
        return { x: avg };
      })
    );
  }

  function buildHeadersFromBands(headerRows, columnBands) {
    if (!columnBands.length) return ["Date"];
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
    const cols = columnBands.map((b) => ({ x: b.x, parts: [] }));
    for (const hc of headerCells) {
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < cols.length; i++) {
        const d = Math.abs(cols[i].x - hc.x);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      if (bestDist <= 30) {
        cols[bestIdx].parts.push(hc.text);
      }
    }
    return cols.map((c) => {
      if (c.parts.length === 0) return "";
      const seen = new Set();
      const uniq = [];
      for (const p of c.parts) { if (!seen.has(p)) { seen.add(p); uniq.push(p); } }
      return uniq.join(" ").replace(/\s+/g, " ").trim();
    });
  }

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
      if (bestDist > 30 && out[bestIdx] !== "") {
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

  function parseTableStartingOnPage(pageRows, startPage) {
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

    const MONTHS_RE = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/i;
    const WY_RE = /^WY$/i;
    const allRows = [];
    for (let p = startPage; p < pageRows.length; p++) {
      const rows = pageRows[p];
      if (!rows || !rows.length) continue;
      if (p > startPage) {
        const firstText = (rows[0].items || []).map((i) => i.str || "").join(" ").trim();
        if (/^OPERATION\s+PLAN\s+FOR\s+COLORADO\s+RIVER\s+SYSTEM\s+RESERVOIRS/i.test(firstText)) {
          let hadData = false;
          for (let r = 1; r < rows.length; r++) {
            const rowText = (rows[r].items || []).map((i) => i.str || "").join(" ").trim();
            if (MONTHS_RE.test(rowText) || WY_RE.test(rowText)) {
              hadData = true;
              break;
            }
          }
          if (!hadData) break;
        }
        for (const row of rows) allRows.push({ row, page: p });
        continue;
      }
      for (let r = headerStartRowIdx; r < rows.length; r++) {
        allRows.push({ row: rows[r], page: p });
      }
    }

    const cellRows = allRows.map((ar) => rowToCells(ar.row));

    let dataStart = -1;
    for (let i = 0; i < cellRows.length; i++) {
      const first = cellRows[i][0] ? String(cellRows[i][0].text).trim() : "";
      if (first && !/^(Model\s*Run|Processed|Page|Continued)/i.test(first)) {
        if (first === "WY" || MONTHS_RE.test(first) || /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}$/i.test(first)) {
          dataStart = i;
          break;
        }
      }
    }
    if (dataStart === -1) {
      dataStart = Math.max(0, cellRows.length - 32);
    }

    const headerRows = cellRows.slice(0, dataStart);
    const dataRows = cellRows.slice(dataStart).filter((r) => r.length > 0);

    const columnBands = computeColumnBands(dataRows);
    const headers = buildHeadersFromBands(headerRows, columnBands);
    const alignedData = dataRows.map((r) => alignRow(r, columnBands));

    return {
      reservoir: reservoirName,
      headers,
      rows: alignedData,
    };
  }

  function extractTables(allPagesText) {
    try {
      const pageRows = allPagesText.map(function (tc, idx) {
        try { return pageToRows(tc); }
        catch (e) { console.error("pageToRows failed on page", idx + 1, e); return []; }
      });

      const tables = [];
      for (let p = 0; p < pageRows.length; p++) {
        const rows = pageRows[p];
        if (!rows || !rows.length || !rows[0] || !rows[0].items) continue;
        const first = rows[0].items
          .map(function (i) { return (i && i.str) ? i.str : ""; })
          .join(" ")
          .trim();
        if (!/^OPERATION\s+PLAN\s+FOR\s+COLORADO\s+RIVER\s+SYSTEM\s+RESERVOIRS/i.test(first)) {
          continue;
        }
        try {
          const table = parseTableStartingOnPage(pageRows, p);
          if (table) tables.push(table);
        } catch (e) {
          console.error("parseTableStartingOnPage failed on page", p + 1, e);
        }
      }

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

  // ====== END EXTRACTION FUNCTIONS ======

  // State
  let studies = [];
  let studyData = [];
  let currentTable = null;
  let selectedColumns = [];
  let comparisonChart = null;

  // DOM Elements
  const extractionProgress = document.getElementById("extraction-progress");
  const errorBanner = document.getElementById("error-banner");
  const studyInfoBar = document.getElementById("study-info-bar");
  const displayStudyA = document.getElementById("display-study-a");
  const displayStudyB = document.getElementById("display-study-b");
  const displayStudyC = document.getElementById("display-study-c");
  const badgeC = document.getElementById("badge-c");
  const vsCLabel = document.getElementById("vs-c-label");
  const controlsRow = document.getElementById("controls-row");
  const tableSelect = document.getElementById("table-select");
  const columnPicker = document.getElementById("column-picker");
  const columnGrid = document.getElementById("column-grid");
  const selectAllBtn = document.getElementById("select-all-btn");
  const viewTabs = document.getElementById("view-tabs");
  const noSelection = document.getElementById("no-selection");
  const tableView = document.getElementById("table-view");
  const chartView = document.getElementById("chart-view");
  const downloadCsvBtn = document.getElementById("download-csv-btn");
  const comparisonThead = document.getElementById("comparison-thead");
  const comparisonTbody = document.getElementById("comparison-tbody");

  // ----- Get study info from URL params -----
  function getStudiesFromParams() {
    const params = new URLSearchParams(window.location.search);
    const result = [];
    
    // Check for studies A, B, and optionally C
    for (let i = 0; i < 3; i++) {
      const key = i === 0 ? '' : String.fromCharCode(97 + i); // '', 'b', 'c'
      const url = params.get(key || 'a');
      const name = params.get(key + 'Name');
      
      if (url) {
        result.push({
          url: url,
          name: name ? decodeURIComponent(name) : `Study ${String.fromCharCode(65 + i)}`
        });
      }
    }
    
    if (result.length < 2) {
      showError("Please select at least two studies to compare.");
      return null;
    }
    
    return result;
  }

  // ----- Theme toggle -----
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
      updateChartTheme();
    });
  }

  function updateChartTheme() {
    if (comparisonChart) {
      const isDark = document.documentElement.getAttribute("data-theme") === "dark";
      comparisonChart.options.scales.x.grid.color = isDark ? "#28425a" : "#d6dee5";
      comparisonChart.options.scales.y.grid.color = isDark ? "#28425a" : "#d6dee5";
      comparisonChart.options.scales.x.ticks.color = isDark ? "#8aa0b0" : "#5b707e";
      comparisonChart.options.scales.y.ticks.color = isDark ? "#8aa0b0" : "#5b707e";
      comparisonChart.update();
    }
  }

  // ----- Error handling -----
  function showError(msg) {
    errorBanner.textContent = msg;
    errorBanner.style.display = "block";
  }

  // ----- PDF Extraction -----
  async function extractPdfFromUrl(url, studyName, index) {
    const progressId = String.fromCharCode(97 + index); // 'a', 'b', 'c'
    const iconEl = document.querySelector(`#progress-${progressId} .progress-icon`);
    const subEl = document.querySelector(`#progress-${progressId} .progress-text .sub`);
    const nameEl = document.getElementById(`study-${progressId}-name`);

    nameEl.textContent = studyName;
    iconEl.className = "progress-icon loading";
    iconEl.textContent = "◐";
    subEl.textContent = "Fetching PDF...";

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const arrayBuffer = await response.arrayBuffer();

      subEl.textContent = "Parsing PDF...";
      const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;

      subEl.textContent = `Loaded ${pdf.numPages} pages. Extracting tables...`;
      
      const allPagesText = [];
      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const tc = await page.getTextContent();
        allPagesText.push(tc);
      }

      subEl.textContent = "Processing tables...";
      
      // Use the embedded extractTables function
      const tables = extractTables(allPagesText);

      if (!tables || tables.length === 0) {
        throw new Error("No tables found in this PDF");
      }

      iconEl.className = "progress-icon done";
      iconEl.textContent = "✓";
      subEl.textContent = `Found ${tables.length} tables`;

      return {
        name: studyName,
        url: url,
        tables: tables
      };
    } catch (err) {
      iconEl.className = "progress-icon error";
      iconEl.textContent = "✗";
      subEl.textContent = err.message || "Failed";
      throw err;
    }
  }

  // ----- UI Rendering -----
  function populateTableSelector() {
    if (!studyData || studyData.length === 0) return;
    
    const firstStudy = studyData[0];
    tableSelect.innerHTML = '<option value="">Choose a table...</option>';
    firstStudy.tables.forEach((t, idx) => {
      const opt = document.createElement("option");
      opt.value = idx;
      opt.textContent = t.reservoir + (t.duplicateIdx > 1 ? ` (${t.duplicateIdx})` : "");
      tableSelect.appendChild(opt);
    });
  }

  function renderColumnPicker(tableIdx) {
    if (tableIdx === "" || !studyData || studyData.length === 0) {
      columnPicker.style.display = "none";
      return;
    }

    const firstStudy = studyData[0];
    const table = firstStudy.tables[parseInt(tableIdx)];
    currentTable = table;

    const headers = table.headers.map((h, i) => h && h.length > 0 ? h : `Column ${i + 1}`);
    
    columnGrid.innerHTML = "";
    selectedColumns = [];

    headers.slice(1).forEach((h, i) => {
      const colIdx = i + 1;
      const chip = document.createElement("label");
      chip.className = "column-chip";
      chip.innerHTML = `<input type="checkbox" value="${colIdx}"><span>${escapeHtml(h)}</span>`;
      
      const checkbox = chip.querySelector("input");
      checkbox.addEventListener("change", () => {
        updateSelectedColumns();
        chip.classList.toggle("selected", checkbox.checked);
      });

      columnGrid.appendChild(chip);
    });

    columnPicker.style.display = "block";
    selectAllBtn.textContent = "Select All";
  }

  function updateSelectedColumns() {
    const checkboxes = columnGrid.querySelectorAll('input[type="checkbox"]');
    selectedColumns = Array.from(checkboxes)
      .filter((cb) => cb.checked)
      .map((cb) => parseInt(cb.value));
    
    const total = checkboxes.length;
    const selected = selectedColumns.length;
    selectAllBtn.textContent = selected === total ? "Deselect All" : "Select All";

    if (selected > 0) {
      renderComparison();
    } else {
      tableView.style.display = "none";
      chartView.style.display = "none";
      noSelection.style.display = "block";
    }
  }

  function renderComparison() {
    if (!currentTable || selectedColumns.length === 0 || !studyData || studyData.length === 0) return;

    const tableIdx = parseInt(tableSelect.value);
    const firstStudy = studyData[0];
    const tableA = firstStudy.tables[tableIdx];
    
    const tables = studyData.map((sd, idx) => {
      if (idx === 0) return tableA;
      return findMatchingTable(sd.tables, tableA.reservoir, tableA.duplicateIdx);
    });

    const missingStudies = tables.some(t => !t);
    if (missingStudies) {
      showError("Some tables are not available in all selected studies");
      return;
    }

    const activeTab = document.querySelector(".view-tab.active");
    const view = activeTab ? activeTab.dataset.view : "table";

    if (view === "table") {
      renderTableComparison(tables);
      tableView.style.display = "block";
      chartView.style.display = "none";
    } else {
      renderChartComparison(tables);
      tableView.style.display = "none";
      chartView.style.display = "block";
    }

    noSelection.style.display = "none";
  }

  function findMatchingTable(tables, reservoir, dupIdx) {
    const matches = tables.filter((t) => t.reservoir === reservoir);
    if (matches.length === 1) return matches[0];
    if (matches.length >= dupIdx) return matches[dupIdx - 1];
    return matches[0];
  }

  function renderTableComparison(tables) {
    let headerHtml = `<tr><th>Date</th>`;
    const labels = ['A', 'B', 'C'];
    const colors = ['study-a', 'study-b', 'study-c'];
    
    tables.forEach((_, idx) => {
      headerHtml += `<th class="${colors[idx]}">${escapeHtml(studyData[idx].name)}</th>`;
    });
    headerHtml += `<th class="diff">Diff (B-A)</th><th class="diff">Diff (C-B)</th></tr>`;
    comparisonThead.innerHTML = headerHtml;

    const firstTable = tables[0];
    const maxRows = Math.max(...tables.map(t => t.rows.length));
    let tbody = "";

    for (let r = 0; r < maxRows; r++) {
      const rows = tables.map(t => t.rows[r] || []);
      
      for (const colIdx of selectedColumns) {
        const vals = rows.map(row => row[colIdx] || "-");
        const headerA = firstTable.headers[colIdx] || `Column ${colIdx}`;
        
        const numVals = vals.map(v => parseNumeric(v));
        let diffBA = "-", diffCB = "-";
        let diffBAClass = "", diffCBClass = "";
        
        if (numVals[0] !== null && numVals[1] !== null) {
          diffBA = numVals[1] - numVals[0];
          diffBAClass = diffBA >= 0 ? "diff-pos" : "diff-neg";
          diffBA = (diffBA >= 0 ? "+" : "") + diffBA.toFixed(2);
        }
        
        if (numVals[1] !== null && numVals[2] !== null) {
          diffCB = numVals[2] - numVals[1];
          diffCBClass = diffCB >= 0 ? "diff-pos" : "diff-neg";
          diffCB = (diffCB >= 0 ? "+" : "") + diffCB.toFixed(2);
        }

        const rowLabel = r === 0 ? headerA : "";
        const dateLabel = rows[0][0] || "";

        tbody += `<tr>
          <td class="row-label">${escapeHtml(dateLabel)}${rowLabel ? `<br><small style="color:var(--color-text-muted)">${escapeHtml(rowLabel)}</small>` : ""}</td>`;
        
        vals.forEach((v, idx) => {
          tbody += `<td class="val-${colors[idx]}">${escapeHtml(v)}</td>`;
        });
        
        tbody += `<td class="${diffBAClass}">${diffBA}</td>
          <td class="${diffCBClass}">${diffCB}</td>
        </tr>`;
      }
    }

    comparisonTbody.innerHTML = tbody;
  }

  function parseNumeric(val) {
    if (!val || val === "-") return null;
    const cleaned = String(val).replace(/[,\s]/g, "");
    const num = parseFloat(cleaned);
    return isNaN(num) ? null : num;
  }

  function renderChartComparison(tables) {
    const ctx = document.getElementById("comparison-chart").getContext("2d");
    
    if (comparisonChart) {
      comparisonChart.destroy();
    }

    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    const gridColor = isDark ? "#28425a" : "#d6dee5";
    const tickColor = isDark ? "#8aa0b0" : "#5b707e";

    const datasets = [];

    const studyColors = [
      { solid: "#168244", light: "#4ade80" },
      { solid: "#1d4ed8", light: "#60a5fa" },
      { solid: "#c22525", light: "#f87171" }
    ];

    selectedColumns.forEach((colIdx, ci) => {
      const header = tables[0].headers[colIdx] || `Column ${colIdx}`;
      
      tables.forEach((table, si) => {
        const data = table.rows.map(row => {
          const val = parseNumeric(row[colIdx]);
          return val !== null ? val : null;
        });

        const isDashed = si > 0;

        datasets.push({
          label: `${studyData[si].name} - ${header}`,
          data: data,
          borderColor: studyColors[si].solid,
          backgroundColor: studyColors[si].solid + "33",
          tension: 0.1,
          fill: false,
          pointRadius: 3,
          pointHoverRadius: 5,
          borderDash: isDashed ? [5, 5] : []
        });
      });
    });

    const dates = tables[0].rows.map(r => r[0] || "");

    comparisonChart = new Chart(ctx, {
      type: "line",
      data: { labels: dates, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: "index",
          intersect: false
        },
        plugins: {
          legend: {
            position: "bottom",
            labels: { 
              usePointStyle: true,
              padding: 20,
              color: tickColor
            }
          },
          tooltip: {
            backgroundColor: isDark ? "#1a2b3b" : "#ffffff",
            titleColor: isDark ? "#e2ecf2" : "#0f2430",
            bodyColor: isDark ? "#e2ecf2" : "#0f2430",
            borderColor: gridColor,
            borderWidth: 1
          }
        },
        scales: {
          x: {
            grid: { color: gridColor },
            ticks: { color: tickColor }
          },
          y: {
            grid: { color: gridColor },
            ticks: { color: tickColor }
          }
        }
      }
    });
  }

  function escapeHtml(str) {
    if (!str) return "";
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ----- Download CSV -----
  function downloadComparisonCsv() {
    if (!currentTable || selectedColumns.length === 0 || !studyData || studyData.length === 0) return;

    const tableIdx = parseInt(tableSelect.value);
    const firstTable = studyData[0].tables[tableIdx];
    
    const tables = studyData.map((sd, idx) => {
      if (idx === 0) return firstTable;
      return findMatchingTable(sd.tables, firstTable.reservoir, firstTable.duplicateIdx);
    });

    const labels = ['A', 'B', 'C'];
    const headerRow = ["Date", "Column", ...studyData.map((sd, i) => `${labels[i]} (${sd.name})`), "Diff (B-A)", "Diff (C-B)"];
    const rows = [headerRow];

    const maxRows = Math.max(...tables.map(t => t.rows.length));

    for (const colIdx of selectedColumns) {
      const header = firstTable.headers[colIdx] || `Column ${colIdx}`;
      
      for (let r = 0; r < maxRows; r++) {
        const tableRows = tables.map(t => t.rows[r] || []);
        const dateLabel = tableRows[0][0] || "";
        
        const vals = tableRows.map(row => row[colIdx] || "");
        const numVals = vals.map(v => parseNumeric(v));
        
        let diffBA = "", diffCB = "";
        if (numVals[0] !== null && numVals[1] !== null) {
          diffBA = (numVals[1] - numVals[0]).toFixed(4);
        }
        if (numVals[1] !== null && numVals[2] !== null) {
          diffCB = (numVals[2] - numVals[1]).toFixed(4);
        }

        rows.push([
          csvEscape(dateLabel),
          csvEscape(header),
          ...vals.map(v => csvEscape(v)),
          diffBA,
          diffCB
        ]);
      }
    }

    const csv = rows.map((r) => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `comparison_${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function csvEscape(v) {
    if (v == null) return "";
    const s = String(v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  // ----- Event Listeners -----
  tableSelect.addEventListener("change", (e) => {
    renderColumnPicker(e.target.value);
    if (e.target.value === "") {
      tableView.style.display = "none";
      chartView.style.display = "none";
      noSelection.style.display = "block";
    }
  });

  selectAllBtn.addEventListener("click", () => {
    const checkboxes = columnGrid.querySelectorAll('input[type="checkbox"]');
    const allSelected = Array.from(checkboxes).every((cb) => cb.checked);
    
    checkboxes.forEach((cb) => {
      cb.checked = !allSelected;
      const chip = cb.closest(".column-chip");
      if (chip) chip.classList.toggle("selected", !allSelected);
    });
    
    updateSelectedColumns();
  });

  viewTabs.addEventListener("click", (e) => {
    const tab = e.target.closest(".view-tab");
    if (!tab) return;

    viewTabs.querySelectorAll(".view-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");

    if (selectedColumns.length > 0) {
      renderComparison();
    }
  });

  downloadCsvBtn.addEventListener("click", downloadComparisonCsv);

  // ----- Initialize -----
  async function init() {
    studies = getStudiesFromParams();
    if (!studies) return;

    extractionProgress.style.display = "block";

    try {
      const promises = studies.map((s, i) => extractPdfFromUrl(s.url, s.name, i));
      studyData = await Promise.all(promises);

      await new Promise((resolve) => setTimeout(resolve, 500));

      extractionProgress.style.display = "none";
      studyInfoBar.style.display = "flex";
      controlsRow.style.display = "flex";
      viewTabs.style.display = "flex";
      noSelection.style.display = "block";

      displayStudyA.textContent = studyData[0].name;
      displayStudyB.textContent = studyData[1].name;
      
      if (studyData.length > 2) {
        displayStudyC.textContent = studyData[2].name;
        badgeC.style.display = "flex";
        vsCLabel.style.display = "inline";
      }

      populateTableSelector();

    } catch (err) {
      console.error("Extraction failed:", err);
      showError("Failed to extract one or more PDFs: " + (err.message || "Unknown error"));
    }
  }

  init();
})();
