/* Colorado River Basin 24-Month Study Explorer with Admin Editor Module */
(function () {
  "use strict";

  const SCENARIOS = ["Most Probable", "Probable Minimum", "Probable Maximum", "Charts"];
  const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const ACCENT = {
    "Most Probable": { cssVar: "--color-most", soft: "--color-most-soft" },
    "Probable Minimum": { cssVar: "--color-min", soft: "--color-min-soft" },
    "Probable Maximum": { cssVar: "--color-max", soft: "--color-max-soft" },
    "Charts": { cssVar: "--color-charts", soft: "--color-charts-soft" },
  };

  const $ = (sel) => document.querySelector(sel);

  let STUDIES = [];
  let byYear = new Map();
  let byYearScenario = new Map();
  let years = [];
  let state = { year: "", scenario: "Most Probable" };

  // ---- 1. Data Normalization & Sanitization ----
  function normalizeStudies(rawArray) {
    if (!Array.isArray(rawArray)) return [];
    return rawArray.map(s => {
      const normY = String(s.y !== undefined ? s.y : (s.year !== undefined ? s.year : "")).trim();
      const normM = String(s.m !== undefined ? s.m : (s.month !== undefined ? s.month : "January")).trim();
      const normS = String(s.s !== undefined ? s.s : (s.scenario !== undefined ? s.scenario : "Most Probable")).trim();
      const normN = String(s.n !== undefined ? s.n : (s.name !== undefined ? s.name : "")).trim();
      const normPdf = String(s.pdf !== undefined ? s.pdf : (s.pdf_url !== undefined ? s.pdf_url : "")).trim();
      const normCat = String(s.cat !== undefined ? s.cat : (s.catalog_url !== undefined ? s.catalog_url : "")).trim();
      const normSub = String(s.sub !== undefined ? s.sub : "").trim();

      const parsedMi = s.mi !== undefined && s.mi !== null ? Number(s.mi) : MONTHS.indexOf(normM);
      const normMi = parsedMi >= 0 ? parsedMi : 0;

      // Deduce sub-scenario from legacy title formats if undefined
      let parsedSub = normSub;
      if (!parsedSub && normS === "Most Probable") {
        if (normN.includes("6 maf") || normN.includes("6maf")) parsedSub = "6 maf";
        else if (normN.includes("7 maf") || normN.includes("7maf")) parsedSub = "7 maf";
      }

      const finalName = normN ? normN : `${normM} ${normY} ${normS}${parsedSub ? ' (' + parsedSub + ')' : ''} 24-Month Study`;

      return {
        y: normY,
        m: normM,
        mi: normMi,
        s: normS,
        sub: parsedSub,
        n: finalName,
        pdf: normPdf,
        cat: normCat
      };
    });
  }

  // ---- 2. Initialize State and Storage Sync ----
  try {
    const fileData = JSON.stringify(window.__STUDIES || []);
    const fileHash = fileData.length + ":" + fileData.slice(0, 200); // cheap fingerprint
    const storedHash = localStorage.getItem("usbr_studies_hash");
    const localData = localStorage.getItem("usbr_studies");

    if (localData && storedHash === fileHash) {
      // Local edits match current file version — keep local (admin edits preserved)
      STUDIES = normalizeStudies(JSON.parse(localData));
    } else {
      // File changed (or no local data yet) — reseed from file, file wins
      STUDIES = normalizeStudies(window.__STUDIES || []);
      localStorage.setItem("usbr_studies", JSON.stringify(STUDIES));
      localStorage.setItem("usbr_studies_hash", fileHash);
    }
  } catch (e) {
    STUDIES = normalizeStudies(window.__STUDIES || []);
  }

  // ---- 3. Build Derived Indexes ----
  function buildIndexes() {
    byYear.clear();
    byYearScenario.clear();

    STUDIES.forEach((s) => {
      const yStr = String(s.y);
      if (!byYear.has(yStr)) byYear.set(yStr, new Set());
      byYear.get(yStr).add(s.s);

      const key = `${yStr}|${s.s}`;
      if (!byYearScenario.has(key)) byYearScenario.set(key, []);
      byYearScenario.get(key).push(s);
    });

    byYearScenario.forEach((arr) => arr.sort((a, b) => Number(a.mi) - Number(b.mi)));
    years = Array.from(byYear.keys()).sort((a, b) => Number(b) - Number(a));

    if (years.length > 0) {
      if (!state.year || !byYear.has(state.year)) {
        state.year = years[0];
      }
      if (!byYear.get(state.year).has(state.scenario)) {
        state.scenario = SCENARIOS.find((sc) => byYear.get(state.year).has(sc)) || "Most Probable";
      }
    } else {
      state.year = "";
    }
  }

  // ---- 4. UI Filters ----
  const yearSelect = $("#year-select");

  function renderYearDropdown() {
    yearSelect.innerHTML = "";
    if (years.length === 0) {
      const opt = document.createElement("option");
      opt.textContent = "No Data";
      yearSelect.appendChild(opt);
      return;
    }
    years.forEach((y) => {
      const opt = document.createElement("option");
      opt.value = y; opt.textContent = y;
      yearSelect.appendChild(opt);
    });
    yearSelect.value = state.year;
  }

  yearSelect.addEventListener("change", () => {
    state.year = yearSelect.value;
    if (byYear.has(state.year) && !byYear.get(state.year).has(state.scenario)) {
      state.scenario = SCENARIOS.find((sc) => byYear.get(state.year).has(sc)) || "Most Probable";
    }
    renderScenario();
    renderResults();
  });

  const segWrap = $(".segmented");
  function renderScenario() {
    segWrap.innerHTML = "";
    if (!state.year) return;

    SCENARIOS.forEach((sc) => {
      const available = byYear.get(state.year) ? byYear.get(state.year).has(sc) : false;
      const btn = document.createElement("button");
      btn.className = "seg";
      btn.type = "button";
      btn.setAttribute("role", "radio");
      btn.setAttribute("aria-checked", state.scenario === sc ? "true" : "false");
      btn.setAttribute("data-sc", sc);
      btn.disabled = !available;
      if (!available) btn.title = "Not available for " + state.year;

      const dot = document.createElement("span");
      dot.className = "seg-dot";
      btn.appendChild(dot);
      btn.appendChild(document.createTextNode(sc));

      btn.addEventListener("click", () => {
        if (!available) return;
        state.scenario = sc;
        renderScenario();
        renderResults();
      });
      segWrap.appendChild(btn);
    });
  }

  // ---- 5. Render Grid Cards ----
  const grid = $("#month-grid");
  const empty = $("#empty");
  const titleEl = $("#results-title");
  const countEl = $("#results-count");

  function renderResults() {
    if (!state.year) {
      titleEl.textContent = "No data available";
      countEl.textContent = "";
      grid.innerHTML = "";
      empty.hidden = false;
      return;
    }

    const key = `${state.year}|${state.scenario}`;
    const list = byYearScenario.get(key) || [];
    titleEl.textContent = `${state.year} · ${state.scenario}`;
    countEl.textContent = list.length ? `${list.length} report${list.length > 1 ? "s" : ""}` : "";
    grid.innerHTML = "";

    if (!list.length) {
      empty.hidden = false;
      grid.style.display = "none";
      return;
    }
    empty.hidden = true;
    grid.style.display = "";

    list.forEach((s) => {
      const accent = getComputedStyle(document.documentElement).getPropertyValue(ACCENT[s.s].cssVar).trim();
      const card = document.createElement("article");
      card.className = "month-card";
      card.style.setProperty("--accent", accent);

      // Append sub-scenario descriptors dynamically
      const displayLabel = s.sub ? `${s.s} (${s.sub})` : s.s;

      // Extraction/comparison only meaningful for tabular study PDFs, not chart images
      const isChart = s.s === "Charts";

      const extractBtn = isChart ? "" :
        '<a class="csv-btn mc-extract" href="extractor.html?pdf=' + encodeURIComponent(s.pdf) + '" target="_blank" rel="noopener noreferrer" title="Extract tables to CSV">' +
          'Extract to CSV' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
        '</a>';

      card.innerHTML =
        '<div class="mc-month">' + s.m + " " + s.y + "</div>" +
        '<span class="mc-scenario"><span class="mc-dot"></span>' + displayLabel + '</span>' +
        '<div class="mc-actions">' +
          '<a class="mc-open" href="' + s.pdf + '" target="_blank" rel="noopener noreferrer">Open PDF' +
            '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg>' +
          '</a>' +
          extractBtn +
          '<a class="mc-catalog" href="' + s.cat + '" target="_blank" rel="noopener noreferrer" title="View in RISE Catalog">' +
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>' +
          '</a>' +
          '<button class="mc-edit" type="button" title="Edit Study Info" data-year="' + s.y + '" data-month="' + s.m + '" data-scenario="' + s.s + '" data-sub="' + (s.sub || "") + '">' +
            '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>' +
          '</button>' +
        '</div>';

      card.querySelector(".mc-edit").addEventListener("click", (e) => {
        const btn = e.currentTarget;
        const y = btn.getAttribute("data-year");
        const m = btn.getAttribute("data-month");
        const sc = btn.getAttribute("data-scenario");
        const sub = btn.getAttribute("data-sub");
        openAdminModal(y, m, sc, sub);
      });

      grid.appendChild(card);
    });
  }

  // ---- 6. Admin Panel Setup ----
  const adminModal = $("#admin-modal");
  const adminForm = $("#admin-form");
  const modalTitle = $("#modal-title-text");
  const editIndexInput = $("#edit-index");
  const deleteBtn = $("#delete-btn");

  const formScenario = $("#form-scenario");
  const formSubField = $("#form-sub-field");
  const formSub = $("#form-sub");

  // Auto-toggle sub-scenario menu in editor form
  formScenario.addEventListener("change", () => {
    if (formScenario.value === "Most Probable") {
      formSubField.style.display = "block";
    } else {
      formSubField.style.display = "none";
      formSub.value = "";
    }
  });

  function openAdminModal(year = null, month = null, scenario = null, sub = null) {
    adminModal.hidden = false;
    document.body.style.overflow = "hidden";

    if (year && month && scenario) {
      // Precise index-matching incorporating sub-scenario parameters to prevent card editing collisions
      const targetIndex = STUDIES.findIndex(item =>
        String(item.y) === String(year) &&
        String(item.m) === String(month) &&
        String(item.s) === String(scenario) &&
        String(item.sub || "") === String(sub || "")
      );

      if (targetIndex >= 0) {
        modalTitle.textContent = "Edit Study Details";
        editIndexInput.value = targetIndex;
        deleteBtn.style.display = "inline-flex";

        const study = STUDIES[targetIndex];
        $("#form-year").value = study.y || "";
        $("#form-month").value = study.m || "January";
        formScenario.value = study.s || "Most Probable";
        $("#form-name").value = study.n || "";
        $("#form-pdf").value = study.pdf || "";
        $("#form-cat").value = study.cat || "";

        if (study.s === "Most Probable") {
          formSubField.style.display = "block";
          formSub.value = study.sub || "";
        } else {
          formSubField.style.display = "none";
          formSub.value = "";
        }
        return;
      }
    }

    // ADD Mode
    modalTitle.textContent = "Add New Study";
    editIndexInput.value = "";
    deleteBtn.style.display = "none";
    adminForm.reset();

    $("#form-year").value = state.year || new Date().getFullYear();
    formScenario.value = state.scenario;
    if (state.scenario === "Most Probable") {
      formSubField.style.display = "block";
    } else {
      formSubField.style.display = "none";
    }
  }

  function closeAdminModal() {
    adminModal.hidden = true;
    document.body.style.overflow = "";
    adminForm.reset();
  }

  $("#open-admin-btn").addEventListener("click", () => openAdminModal());
  $("#close-admin-btn").addEventListener("click", closeAdminModal);
  $("#cancel-form-btn").addEventListener("click", closeAdminModal);

  // Submit form
  adminForm.addEventListener("submit", (e) => {
    e.preventDefault();

    const yearVal = String($("#form-year").value.trim());
    const monthVal = $("#form-month").value;
    const scenarioVal = formScenario.value;
    const subVal = formSub.value;
    const pdfVal = $("#form-pdf").value.trim();
    const catVal = $("#form-cat").value.trim();
    const miVal = MONTHS.indexOf(monthVal);

    let nameVal = $("#form-name").value.trim();
    if (!nameVal) {
      nameVal = `${monthVal} ${yearVal} ${scenarioVal}${subVal ? ' (' + subVal + ')' : ''} 24-Month Study`;
    }

    const targetObj = {
      y: yearVal,
      m: monthVal,
      mi: miVal,
      s: scenarioVal,
      sub: subVal,
      n: nameVal,
      pdf: pdfVal,
      cat: catVal
    };

    const editIndex = editIndexInput.value;
    if (editIndex !== "" && editIndex !== null && editIndex !== undefined) {
      STUDIES[Number(editIndex)] = targetObj;
    } else {
      STUDIES.push(targetObj);
    }

    localStorage.setItem("usbr_studies", JSON.stringify(STUDIES));
    localStorage.setItem("usbr_studies_hash", JSON.stringify(window.__STUDIES || []).length + ":" + JSON.stringify(window.__STUDIES || []).slice(0, 200));
    buildIndexes();
    renderYearDropdown();
    renderScenario();
    renderResults();
    closeAdminModal();
  });

  // Delete record
  deleteBtn.addEventListener("click", () => {
    const editIndex = editIndexInput.value;
    if (editIndex === "") return;

    if (confirm("Are you sure you want to delete this study record? This cannot be undone.")) {
      STUDIES.splice(Number(editIndex), 1);
      localStorage.setItem("usbr_studies", JSON.stringify(STUDIES));
      localStorage.setItem("usbr_studies_hash", JSON.stringify(window.__STUDIES || []).length + ":" + JSON.stringify(window.__STUDIES || []).slice(0, 200));
      buildIndexes();
      renderYearDropdown();
      renderScenario();
      renderResults();
      closeAdminModal();
    }
  });

  // ---- 7. Code Exporters ----
  $("#export-js-btn").addEventListener("click", () => {
    const sorted = STUDIES.slice().sort((a, b) => Number(a.y) - Number(b.y) || a.mi - b.mi);
    const code = "window.__STUDIES = " + JSON.stringify(sorted) + ";";

    const blob = new Blob([code], { type: "application/javascript;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "studies-data.js";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  $("#csv-btn").addEventListener("click", () => {
    const header = ["year","month","scenario","sub_scenario","name","catalog_url","pdf_url"];
    const esc = (v) => {
      v = String(v == null ? "" : v);
      return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    };
    const lines = [header.join(",")];
    STUDIES.slice().sort((a, b) => Number(a.y) - Number(b.y) || a.mi - b.mi).forEach((s) => {
      lines.push([s.y, s.m, s.s, s.sub || "", s.n, s.cat, s.pdf].map(esc).join(","));
    });
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "usbr_catalog_links.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  // ---- Theme Toggler ----
  const tBtn = document.querySelector("[data-theme-toggle]");
  const root = document.documentElement;
  let theme = matchMedia("(prefers-color-scheme:dark)").matches ? "dark" : "light";
  root.setAttribute("data-theme", theme);
  function setThemeIcon() {
    tBtn.setAttribute("aria-label", "Switch to " + (theme === "dark" ? "light" : "dark") + " mode");
    tBtn.innerHTML = theme === "dark"
      ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>'
      : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  }
  setThemeIcon();
  tBtn.addEventListener("click", () => {
    theme = theme === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", theme);
    setThemeIcon();
    renderResults();
  });

  // ---- 8. Admin Mode Toggle (via URL ?admin) ----
  function isAdminMode() {
    return new URLSearchParams(window.location.search).has("admin");
  }

  // ---- 9. Compare Studies Modal ----
  const compareModal = $("#compare-modal");
  const compareStudyA = $("#compare-study-a");
  const compareStudyB = $("#compare-study-b");
  const compareStudyC = $("#compare-study-c");
  const compareStudyD = $("#compare-study-d");
  const startCompareBtn = $("#start-compare-btn");

  function populateCompareDropdowns() {
    // Populate dropdowns with all studies (exclude Charts — not tabular data to compare)
    const options = STUDIES.slice()
      .filter((s) => s.s !== "Charts")
      .sort((a, b) => {
        // Sort by year descending, then by month index
        if (Number(b.y) !== Number(a.y)) return Number(b.y) - Number(a.y);
        return a.mi - b.mi;
      });

    const createOptions = (select, includeOptional) => {
      select.innerHTML = includeOptional ? '<option value="">Optional...</option>' : '<option value="">Select...</option>';
      options.forEach((s) => {
        const origIdx = STUDIES.findIndex(item =>
          item.y === s.y && item.m === s.m && item.s === s.s && (item.sub || "") === (s.sub || "")
        );
        const displayName = s.n || `${s.m} ${s.y} ${s.s}${s.sub ? ' (' + s.sub + ')' : ''}`;
        const opt = document.createElement("option");
        opt.value = origIdx;
        opt.textContent = displayName;
        select.appendChild(opt);
      });
    };

    createOptions(compareStudyA, false);
    createOptions(compareStudyB, false);
    createOptions(compareStudyC, true);
    createOptions(compareStudyD, true);
  }

  function openCompareModal() {
    populateCompareDropdowns();
    compareModal.hidden = false;
    document.body.style.overflow = "hidden";
  }

  function closeCompareModal() {
    compareModal.hidden = true;
    document.body.style.overflow = "";
    compareStudyA.value = "";
    compareStudyB.value = "";
    compareStudyC.value = "";
    compareStudyD.value = "";
  }

  $("#compare-btn").addEventListener("click", openCompareModal);
  $("#close-compare-btn").addEventListener("click", closeCompareModal);
  $("#cancel-compare-btn").addEventListener("click", closeCompareModal);

  startCompareBtn.addEventListener("click", () => {
    const idxA = compareStudyA.value;
    const idxB = compareStudyB.value;
    const idxC = compareStudyC.value;
    const idxD = compareStudyD.value;

    if (!idxA || !idxB) {
      alert("Please select at least two studies to compare.");
      return;
    }

    // Check for duplicates
    const selected = [idxA, idxB, idxC, idxD].filter(v => v !== "");
    if (new Set(selected).size !== selected.length) {
      alert("Please select different studies - no duplicates allowed.");
      return;
    }

    const studyA = STUDIES[parseInt(idxA)];
    const studyB = STUDIES[parseInt(idxB)];

    if (!studyA.pdf || !studyB.pdf) {
      alert("Selected studies must have PDF links.");
      return;
    }

    // Build URL with study info
    const params = new URLSearchParams();
    params.set("a", studyA.pdf);
    params.set("b", studyB.pdf);
    params.set("aName", encodeURIComponent(studyA.n || `${studyA.m} ${studyA.y} ${studyA.s}`));
    params.set("bName", encodeURIComponent(studyB.n || `${studyB.m} ${studyB.y} ${studyB.s}`));

    // Add third study if selected
    if (idxC) {
      const studyC = STUDIES[parseInt(idxC)];
      if (studyC && studyC.pdf) {
        params.set("c", studyC.pdf);
        params.set("cName", encodeURIComponent(studyC.n || `${studyC.m} ${studyC.y} ${studyC.s}`));
      }
    }

    // Add fourth study if selected
    if (idxD) {
      const studyD = STUDIES[parseInt(idxD)];
      if (studyD && studyD.pdf) {
        params.set("d", studyD.pdf);
        params.set("dName", encodeURIComponent(studyD.n || `${studyD.m} ${studyD.y} ${studyD.s}`));
      }
    }

    closeCompareModal();
    window.open("compare.html?" + params.toString(), "_blank");
  });

  // ---- 10. App Initialization ----
  buildIndexes();
  renderYearDropdown();
  renderScenario();
  renderResults();

  // Show/hide all edit buttons on cards based on URL parameter
  document.querySelectorAll(".mc-edit").forEach(btn => {
    btn.style.display = isAdminMode() ? "" : "none";
  });
  // Also hide the admin panel open button if not in admin mode
  const openAdminBtn = document.getElementById("open-admin-btn");
  if (openAdminBtn && !isAdminMode()) {
    openAdminBtn.style.display = "none";
  }
  // Hide export buttons in non-admin mode
  const exportSection = document.querySelector(".export-section");
  if (exportSection && !isAdminMode()) {
    exportSection.style.display = "none";
  }
  // Hide the "Download Studies CSV" button (#csv-btn) outside of admin mode.
  // It is shown again on the index page when the URL contains ?admin.
  const csvDownloadBtn = document.getElementById("csv-btn");
  if (csvDownloadBtn && !isAdminMode()) {
    csvDownloadBtn.style.display = "none";
  }
})();
