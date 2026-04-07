/* ============================================================
   River Forecast Dashboard — Client-side application
   Fetches live data from USGS NWIS & NWS APIs, runs a
   simplified hydrological forecast, and renders charts.
   ============================================================ */

const USGS_IV  = 'https://waterservices.usgs.gov/nwis/iv/';
const USGS_DV  = 'https://waterservices.usgs.gov/nwis/dv/';
const USGS_SITE = 'https://waterservices.usgs.gov/nwis/site/';
const NWS_BASE  = 'https://api.weather.gov';

const MW_STATES = ['MT','ID','WY','CO','UT','NV','NM','AZ'];
const EXAMPLE_SITES = [
  { id: '09380000', name: 'Colorado R. at Lees Ferry, AZ' },
  { id: '09251000', name: 'Yampa R. near Maybell, CO' },
  { id: '13011000', name: 'Snake R. near Moran, WY' },
  { id: '12340000', name: 'Blackfoot R. near Bonner, MT' },
  { id: '10109000', name: 'Logan R. above State Dam, UT' },
  { id: '13185000', name: 'Boise R. near Twin Springs, ID' },
];

/* ---- State ---- */
let forecastChart = null;
let componentsChart = null;

/* ---- DOM refs ---- */
const $  = id => document.getElementById(id);
const siteInput   = $('site-input');
const stateSelect = $('state-select');
const goBtn       = $('go-btn');
const statusBar   = $('status-bar');
const stepsEl     = $('steps');
const resultsEl   = $('results');
const warningsEl  = $('warnings');

/* ---- Quick picks ---- */
document.querySelectorAll('.pick').forEach(el => {
  el.addEventListener('click', () => {
    siteInput.value = el.dataset.site;
    runForecast();
  });
});
goBtn.addEventListener('click', runForecast);
siteInput.addEventListener('keydown', e => { if (e.key === 'Enter') runForecast(); });

/* ============================================================
   Main forecast pipeline
   ============================================================ */
async function runForecast() {
  const siteNo = siteInput.value.trim();
  if (!siteNo) return;
  goBtn.disabled = true;
  resultsEl.classList.add('hidden');
  warningsEl.innerHTML = '';
  statusBar.classList.add('visible');
  const warnings = [];
  const steps = ['Site Info','Recent Flow','Weather','Forecast','Render'];
  renderSteps(steps, 0);

  try {
    /* Step 1: site info */
    renderSteps(steps, 0);
    const site = await fetchSiteInfo(siteNo);

    /* Step 2: recent discharge */
    renderSteps(steps, 1);
    const recent = await fetchRecentDischarge(siteNo, 90);

    /* Step 3: weather forecast */
    renderSteps(steps, 2);
    let weather;
    try {
      weather = await fetchWeather(site.lat, site.lon);
    } catch (e) {
      warnings.push('NWS weather unavailable — using neutral weather assumptions. ' + e.message);
      weather = fallbackWeather();
    }

    /* Step 4: run forecast model */
    renderSteps(steps, 3);
    const forecast = computeForecast(site, recent, weather, warnings);

    /* Step 5: render */
    renderSteps(steps, 4);
    renderResults(site, recent, forecast, weather, warnings);
    renderSteps(steps, 5);
  } catch (err) {
    renderStepError(steps);
    addWarning('Forecast failed: ' + err.message);
  }
  goBtn.disabled = false;
}

/* ============================================================
   Data fetching
   ============================================================ */
async function fetchSiteInfo(siteNo) {
  const url = `${USGS_SITE}?format=rdb&sites=${siteNo}&siteOutput=expanded&siteStatus=active`;
  const text = await (await fetch(url)).text();
  const lines = text.split('\n').filter(l => !l.startsWith('#') && l.trim());
  if (lines.length < 3) throw new Error('Site not found: ' + siteNo);
  const hdr = lines[0].split('\t');
  const vals = lines[2].split('\t');
  const col = name => vals[hdr.indexOf(name)] || '';
  return {
    siteNo: col('site_no'),
    name: col('station_nm'),
    lat: parseFloat(col('dec_lat_va')) || 0,
    lon: parseFloat(col('dec_long_va')) || 0,
    state: col('state_cd'),
    drainArea: parseFloat(col('drain_area_va')) || null,
    huc: col('huc_cd'),
  };
}

async function fetchRecentDischarge(siteNo, days) {
  const url = `${USGS_DV}?format=json&sites=${siteNo}&parameterCd=00060&period=P${days}D&siteStatus=active`;
  const data = await (await fetch(url)).json();
  const ts = data?.value?.timeSeries?.[0]?.values?.[0]?.value || [];
  return ts.map(v => ({
    date: new Date(v.dateTime),
    q: parseFloat(v.value)
  })).filter(v => !isNaN(v.q) && v.q >= 0);
}

async function fetchWeather(lat, lon) {
  const ptUrl = `${NWS_BASE}/points/${lat.toFixed(4)},${lon.toFixed(4)}`;
  const ptResp = await fetch(ptUrl, { headers: { 'User-Agent': '(RiverForecastDashboard)' } });
  if (!ptResp.ok) throw new Error('NWS points lookup failed');
  const ptData = await ptResp.json();
  const fUrl = ptData.properties.forecastGridData || `${NWS_BASE}/gridpoints/${ptData.properties.gridId}/${ptData.properties.gridX},${ptData.properties.gridY}`;
  const gResp = await fetch(fUrl, { headers: { 'User-Agent': '(RiverForecastDashboard)' } });
  if (!gResp.ok) throw new Error('NWS gridpoint fetch failed');
  const gData = await gResp.json();
  const props = gData.properties || {};
  const tempSeries = expandNWS(props.temperature || {});
  const precipSeries = expandNWS(props.quantitativePrecipitation || {});
  const tempUnit = (props.temperature?.uom || '').toLowerCase();
  const isCelsius = tempUnit.includes('degc') || tempUnit.includes('celsius');

  const today = new Date(); today.setHours(0,0,0,0);
  const days = [];
  for (let d = 0; d < 14; d++) {
    const day = new Date(today); day.setDate(day.getDate() + d);
    const next = new Date(day); next.setDate(next.getDate() + 1);
    const dTemps = tempSeries.filter(t => t.dt >= day && t.dt < next).map(t => t.v);
    let hi = dTemps.length ? Math.max(...dTemps) : NaN;
    let lo = dTemps.length ? Math.min(...dTemps) : NaN;
    if (isCelsius && !isNaN(hi)) { hi = hi * 9/5 + 32; lo = lo * 9/5 + 32; }
    const dPrecip = precipSeries.filter(t => t.dt >= day && t.dt < next).map(t => t.v);
    const precipMm = dPrecip.reduce((a,b) => a + b, 0);
    days.push({ date: day, hi, lo, mean: (hi+lo)/2, precipIn: precipMm / 25.4 });
  }
  return days;
}

function expandNWS(prop) {
  const result = [];
  for (const entry of (prop.values || [])) {
    const vt = entry.validTime || '';
    if (!vt.includes('/')) continue;
    const [dtStr, dur] = vt.split('/');
    const dt = new Date(dtStr);
    if (isNaN(dt)) continue;
    const val = entry.value == null ? NaN : parseFloat(entry.value);
    const hrs = parseDurationHours(dur);
    for (let h = 0; h < hrs; h++) {
      result.push({ dt: new Date(dt.getTime() + h*3600000), v: val });
    }
    if (hrs < 1) result.push({ dt, v: val });
  }
  return result;
}

function parseDurationHours(s) {
  if (!s.startsWith('P')) return 1;
  let hours = 0;
  s = s.slice(1);
  if (s.includes('D')) { const p = s.split('D'); hours += parseFloat(p[0])*24; s = p[1]||''; }
  if (s.startsWith('T')) s = s.slice(1);
  if (s.includes('H')) { hours += parseFloat(s.split('H')[0]); }
  return hours || 1;
}

function fallbackWeather() {
  const today = new Date(); today.setHours(0,0,0,0);
  return Array.from({length:14}, (_,i) => {
    const d = new Date(today); d.setDate(d.getDate()+i);
    return { date: d, hi: 55, lo: 30, mean: 42.5, precipIn: 0 };
  });
}

/* ============================================================
   Hydrological forecast model (simplified JS version)
   ============================================================ */
function computeForecast(site, recent, weather, warnings) {
  const horizon = 14;
  const da = site.drainArea || 100;

  /* --- Baseflow separation (Lyne-Hollick) --- */
  const q = recent.map(r => r.q);
  const n = q.length;
  const alpha = 0.925;
  const qf = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    qf[i] = Math.max(0, alpha * qf[i-1] + (1+alpha)/2 * (q[i] - q[i-1]));
  }
  const bf = q.map((v,i) => Math.max(0, v - qf[i]));

  /* Fit recession k */
  const pairs = [];
  for (let i = 1; i < bf.length; i++) {
    if (bf[i] > 0 && bf[i] < bf[i-1]) pairs.push(bf[i] / bf[i-1]);
  }
  let k = pairs.length >= 3 ? median(pairs) : 0.95;
  k = Math.max(0.80, Math.min(0.995, k));

  const lastBf = bf.length > 0 ? bf[bf.length-1] : (q.length ? q[q.length-1]*0.6 : 100);
  const projBf = Array.from({length: horizon}, (_,i) => lastBf * Math.pow(k, i+1));

  /* --- Snowmelt (degree-day) --- */
  const DDF = 0.06;
  const THRESH = 32;
  let swe = 3.0; // Default assumption for spring
  const meltIn = [];
  for (let i = 0; i < horizon; i++) {
    const dd = Math.max(0, (weather[i]?.mean || 42) - THRESH);
    const pot = DDF * dd;
    const actual = Math.min(pot, Math.max(0, swe));
    meltIn.push(actual);
    swe = Math.max(0, swe - actual);
  }
  const CONV = 26.89;
  const meltCfs = meltIn.map(m => m * da * CONV);

  /* --- Rainfall runoff (SCS-CN) --- */
  const CN = da < 50 ? 60 : da < 500 ? 68 : 72;
  const S = 1000/CN - 10;
  const Ia = 0.2 * S;
  const rainCfs = weather.map(w => {
    const P = w.precipIn || 0;
    if (P <= Ia) return 0;
    const excess = P - Ia;
    return (excess*excess / (excess + S)) * da * CONV;
  }).slice(0, horizon);

  /* --- Combine --- */
  const total = projBf.map((b,i) => b + meltCfs[i] + (rainCfs[i]||0));

  /* --- Muskingum routing --- */
  const K = 0.3 * Math.pow(da, 0.3);
  const X = 0.2;
  const dt = 1;
  const denom = 2*K*(1-X) + dt;
  const c0 = (dt - 2*K*X) / denom;
  const c1 = (dt + 2*K*X) / denom;
  const c2 = (2*K*(1-X) - dt) / denom;
  const routed = [total[0]];
  for (let i = 1; i < total.length; i++) {
    routed.push(Math.max(0, c0*total[i] + c1*total[i-1] + c2*routed[i-1]));
  }

  /* --- Uncertainty --- */
  const low = routed.map((v,i) => Math.max(0, v * (1 - (0.15 + 0.35*i/(horizon-1)))));
  const high = routed.map((v,i) => v * (1 + (0.15 + 0.35*i/(horizon-1))));

  const currentQ = q.length ? q[q.length - 1] : null;
  const trend = routed[routed.length-1] - routed[0];

  return {
    dates: weather.slice(0, horizon).map(w => w.date),
    discharge: routed,
    low, high,
    baseflow: projBf,
    snowmelt: meltCfs,
    rainfall: rainCfs,
    currentQ,
    trend,
    recessionK: k,
  };
}

function median(arr) {
  const s = arr.slice().sort((a,b) => a-b);
  const m = Math.floor(s.length/2);
  return s.length % 2 ? s[m] : (s[m-1]+s[m])/2;
}

/* ============================================================
   Rendering
   ============================================================ */
function renderSteps(names, current) {
  stepsEl.innerHTML = names.map((name, i) => {
    const cls = i < current ? 'step done' : i === current ? 'step active' : 'step';
    const icon = i < current ? '&#10003; ' : i === current ? '&#9679; ' : '';
    return `<span class="${cls}">${icon}${name}</span>`;
  }).join('');
}
function renderStepError(names) {
  stepsEl.innerHTML = names.map(name =>
    `<span class="step error">${name}</span>`
  ).join('');
}
function addWarning(msg) {
  warningsEl.innerHTML += `<div class="warning">${msg}</div>`;
}

function renderResults(site, recent, forecast, weather, warnings) {
  resultsEl.classList.remove('hidden');

  /* Site info */
  $('site-name').textContent = site.name;
  $('site-meta').textContent = `USGS ${site.siteNo}  |  (${site.lat.toFixed(4)}, ${site.lon.toFixed(4)})${site.drainArea ? '  |  ' + site.drainArea.toLocaleString() + ' sq mi' : ''}`;

  /* Cards */
  $('card-current').innerHTML = forecast.currentQ != null
    ? `<div class="label">Current Discharge</div><div class="value" style="color:var(--yellow)">${fmt(forecast.currentQ)} cfs</div><div class="sub">Most recent daily mean</div>`
    : `<div class="label">Current Discharge</div><div class="value" style="color:var(--text-dim)">N/A</div>`;

  const d7 = forecast.discharge[6] || 0;
  $('card-day7').innerHTML = `<div class="label">Day 7 Forecast</div><div class="value" style="color:var(--accent)">${fmt(d7)} cfs</div><div class="sub">${fmt(forecast.low[6])} – ${fmt(forecast.high[6])} cfs</div>`;

  const d14 = forecast.discharge[13] || forecast.discharge[forecast.discharge.length-1];
  $('card-day14').innerHTML = `<div class="label">Day 14 Forecast</div><div class="value" style="color:var(--accent2)">${fmt(d14)} cfs</div><div class="sub">${fmt(forecast.low[13]||forecast.low[forecast.low.length-1])} – ${fmt(forecast.high[13]||forecast.high[forecast.high.length-1])} cfs</div>`;

  const dir = forecast.trend > 0 ? 'Rising' : forecast.trend < 0 ? 'Falling' : 'Steady';
  const dirColor = forecast.trend > 0 ? 'var(--green)' : forecast.trend < 0 ? 'var(--red)' : 'var(--text-dim)';
  $('card-trend').innerHTML = `<div class="label">14-Day Trend</div><div class="value" style="color:${dirColor}">${dir}</div><div class="sub">${forecast.trend > 0 ? '+' : ''}${fmt(forecast.trend)} cfs</div>`;

  /* Charts */
  renderForecastChart(recent, forecast);
  renderComponentsChart(forecast);

  /* Table */
  renderTable(forecast, weather);

  /* Warnings */
  warnings.forEach(addWarning);
}

function renderForecastChart(recent, forecast) {
  const ctx = $('forecast-chart').getContext('2d');
  if (forecastChart) forecastChart.destroy();

  const recentDates = recent.slice(-30).map(r => r.date);
  const recentQ = recent.slice(-30).map(r => r.q);
  const fDates = forecast.dates;
  const allDates = [...recentDates, ...fDates];
  const labels = allDates.map(d => fmtDate(d));

  const recentData = recentQ.map(v => v);
  const padded = new Array(recentQ.length).fill(null);

  forecastChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Observed',
          data: [...recentData, ...new Array(fDates.length).fill(null)],
          borderColor: '#e2e8f0',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.3,
        },
        {
          label: 'Forecast',
          data: [...padded, ...forecast.discharge],
          borderColor: '#38bdf8',
          borderWidth: 2.5,
          pointRadius: 0,
          tension: 0.3,
        },
        {
          label: '90% Confidence',
          data: [...padded, ...forecast.high],
          borderColor: 'transparent',
          backgroundColor: 'rgba(56,189,248,0.12)',
          fill: '+1',
          pointRadius: 0,
        },
        {
          label: '10% Confidence',
          data: [...padded, ...forecast.low],
          borderColor: 'transparent',
          backgroundColor: 'rgba(56,189,248,0.12)',
          fill: '-1',
          pointRadius: 0,
        },
      ]
    },
    options: chartOpts('Discharge (cfs)'),
  });
}

function renderComponentsChart(forecast) {
  const ctx = $('components-chart').getContext('2d');
  if (componentsChart) componentsChart.destroy();
  const labels = forecast.dates.map(d => fmtDate(d));
  componentsChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Baseflow', data: forecast.baseflow, backgroundColor: 'rgba(56,189,248,0.6)', stack: 'stack' },
        { label: 'Snowmelt', data: forecast.snowmelt, backgroundColor: 'rgba(129,140,248,0.6)', stack: 'stack' },
        { label: 'Rainfall', data: forecast.rainfall, backgroundColor: 'rgba(52,211,153,0.6)', stack: 'stack' },
      ]
    },
    options: {
      ...chartOpts('Discharge (cfs)'),
      scales: {
        x: { stacked: true, ticks: { color: '#94a3b8', font: { size: 10 } }, grid: { color: 'rgba(71,85,105,0.3)' } },
        y: { stacked: true, ticks: { color: '#94a3b8' }, grid: { color: 'rgba(71,85,105,0.3)' } },
      }
    }
  });
}

function chartOpts(yLabel) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { labels: { color: '#94a3b8', usePointStyle: true, pointStyle: 'line', padding: 20, font: { size: 11 } } },
      tooltip: { backgroundColor: '#1e293b', borderColor: '#475569', borderWidth: 1, titleColor: '#e2e8f0', bodyColor: '#e2e8f0' },
    },
    scales: {
      x: { ticks: { color: '#94a3b8', maxRotation: 45, font: { size: 10 } }, grid: { color: 'rgba(71,85,105,0.3)' } },
      y: { title: { display: true, text: yLabel, color: '#94a3b8' }, ticks: { color: '#94a3b8' }, grid: { color: 'rgba(71,85,105,0.3)' } },
    }
  };
}

function renderTable(forecast, weather) {
  const tbody = $('forecast-tbody');
  tbody.innerHTML = '';
  forecast.dates.forEach((d, i) => {
    const w = weather[i] || {};
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${fmtDateLong(d)}</td>
      <td style="color:var(--yellow);font-weight:600">${fmt(forecast.discharge[i])}</td>
      <td style="color:var(--text-dim)">${fmt(forecast.low[i])}</td>
      <td style="color:var(--text-dim)">${fmt(forecast.high[i])}</td>
      <td style="color:var(--accent)">${fmt(forecast.baseflow[i])}</td>
      <td style="color:var(--accent2)">${fmt(forecast.snowmelt[i])}</td>
      <td style="color:var(--green)">${fmt(forecast.rainfall[i])}</td>
      <td>${isNaN(w.hi) ? '—' : Math.round(w.hi)+'°'}</td>
      <td>${isNaN(w.lo) ? '—' : Math.round(w.lo)+'°'}</td>
      <td>${(w.precipIn||0).toFixed(2)}"</td>
    `;
    tbody.appendChild(tr);
  });
}

/* Formatting helpers */
function fmt(v) { return v == null || isNaN(v) ? '—' : v.toLocaleString(undefined, {maximumFractionDigits:1}); }
function fmtDate(d) { return d.toLocaleDateString('en-US', {month:'short', day:'numeric'}); }
function fmtDateLong(d) { return d.toLocaleDateString('en-US', {weekday:'short', month:'short', day:'numeric'}); }
