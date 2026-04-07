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

/* ---- State ---- */
let forecastChart = null;
let componentsChart = null;
let map = null;
let markerLayer = null;

/* ---- DOM refs ---- */
const $  = id => document.getElementById(id);
const siteInput   = $('site-input');
const goBtn       = $('go-btn');
const statusBar   = $('status-bar');
const stepsEl     = $('steps');
const resultsEl   = $('results');
const warningsEl  = $('warnings');

/* ---- Init map ---- */
function initMap() {
  map = L.map('map', {
    center: [41.5, -109.5],
    zoom: 5,
    zoomControl: true,
    attributionControl: true,
  });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://www.openstreetmap.org/">OSM</a>',
    maxZoom: 18,
  }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);
}

async function loadMapSensors() {
  const stateCode = $('map-state-filter').value;
  if (!stateCode) {
    $('map-count').textContent = 'Select a state to load sensors';
    return;
  }
  $('map-count').textContent = 'Loading...';
  $('load-map-btn').disabled = true;
  markerLayer.clearLayers();
  try {
    const url = USGS_SITE + '?format=rdb&stateCd=' + stateCode + '&siteType=ST&siteStatus=active&hasDataTypeCd=iv&parameterCd=00060&siteOutput=expanded';
    const text = await (await fetch(url)).text();
    const lines = text.split('\n').filter(l => !l.startsWith('#') && l.trim());
    if (lines.length < 3) { $('map-count').textContent = 'No sites found'; return; }
    const hdr = lines[0].split('\t');
    const siteNoIdx = hdr.indexOf('site_no');
    const nameIdx = hdr.indexOf('station_nm');
    const latIdx = hdr.indexOf('dec_lat_va');
    const lonIdx = hdr.indexOf('dec_long_va');
    const daIdx = hdr.indexOf('drain_area_va');

    let count = 0;
    for (let i = 2; i < lines.length; i++) {
      const cols = lines[i].split('\t');
      if (cols.length < Math.max(siteNoIdx, nameIdx, latIdx, lonIdx) + 1) continue;
      const lat = parseFloat(cols[latIdx]);
      const lon = parseFloat(cols[lonIdx]);
      if (isNaN(lat) || isNaN(lon) || lat === 0) continue;
      const siteNo = cols[siteNoIdx];
      const name = cols[nameIdx];
      const da = cols[daIdx] || '';

      const icon = L.divIcon({ className: 'sensor-marker', iconSize: [10, 10], iconAnchor: [5, 5] });
      const marker = L.marker([lat, lon], { icon }).addTo(markerLayer);
      marker.bindPopup(
        '<div class="popup-title">' + name + '</div>' +
        '<div class="popup-detail">Site: ' + siteNo + '</div>' +
        (da ? '<div class="popup-detail">Drainage: ' + parseFloat(da).toLocaleString() + ' sq mi</div>' : '') +
        '<div style="margin-top:0.4rem"><a onclick="selectSite(\'' + siteNo + '\')">Generate Forecast &rarr;</a></div>'
      );
      count++;
    }
    $('map-count').textContent = count + ' sensors';
    if (count > 0) {
      map.fitBounds(markerLayer.getBounds().pad(0.1));
    }
  } catch (e) {
    $('map-count').textContent = 'Error loading sensors';
  }
  $('load-map-btn').disabled = false;
}

function selectSite(siteNo) {
  siteInput.value = siteNo;
  map.closePopup();
  runForecast();
}
// Make it globally accessible for popup onclick
window.selectSite = selectSite;

/* ---- Quick picks ---- */
document.querySelectorAll('.pick').forEach(el => {
  el.addEventListener('click', () => {
    siteInput.value = el.dataset.site;
    runForecast();
  });
});
goBtn.addEventListener('click', runForecast);
siteInput.addEventListener('keydown', e => { if (e.key === 'Enter') runForecast(); });
$('load-map-btn').addEventListener('click', loadMapSensors);

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
    renderSteps(steps, 0);
    const site = await fetchSiteInfo(siteNo);

    renderSteps(steps, 1);
    const recent = await fetchRecentDischarge(siteNo, 90);

    renderSteps(steps, 2);
    let weather;
    try {
      weather = await fetchWeather(site.lat, site.lon);
    } catch (e) {
      warnings.push('NWS weather unavailable — using neutral weather. ' + e.message);
      weather = fallbackWeather();
    }

    renderSteps(steps, 3);
    const forecast = computeForecast(site, recent, weather, warnings);

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
  const url = USGS_SITE + '?format=rdb&sites=' + siteNo + '&siteOutput=expanded&siteStatus=active';
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
  const url = USGS_DV + '?format=json&sites=' + siteNo + '&parameterCd=00060&period=P' + days + 'D&siteStatus=active';
  const data = await (await fetch(url)).json();
  const ts = (data && data.value && data.value.timeSeries && data.value.timeSeries[0] && data.value.timeSeries[0].values && data.value.timeSeries[0].values[0] && data.value.timeSeries[0].values[0].value) || [];
  return ts.map(function(v) {
    return { date: new Date(v.dateTime), q: parseFloat(v.value) };
  }).filter(function(v) { return !isNaN(v.q) && v.q >= 0; });
}

async function fetchWeather(lat, lon) {
  const ptUrl = NWS_BASE + '/points/' + lat.toFixed(4) + ',' + lon.toFixed(4);
  const ptResp = await fetch(ptUrl, { headers: { 'User-Agent': '(RiverForecastDashboard)' } });
  if (!ptResp.ok) throw new Error('NWS points lookup failed');
  const ptData = await ptResp.json();
  const props = ptData.properties;
  const fUrl = NWS_BASE + '/gridpoints/' + props.gridId + '/' + props.gridX + ',' + props.gridY;
  const gResp = await fetch(fUrl, { headers: { 'User-Agent': '(RiverForecastDashboard)' } });
  if (!gResp.ok) throw new Error('NWS gridpoint fetch failed');
  const gData = await gResp.json();
  const gProps = gData.properties || {};
  const tempSeries = expandNWS(gProps.temperature || {});
  const precipSeries = expandNWS(gProps.quantitativePrecipitation || {});
  const tempUnit = ((gProps.temperature || {}).uom || '').toLowerCase();
  const isCelsius = tempUnit.includes('degc') || tempUnit.includes('celsius');

  var today = new Date(); today.setHours(0,0,0,0);
  var days = [];
  for (var d = 0; d < 14; d++) {
    var day = new Date(today); day.setDate(day.getDate() + d);
    var next = new Date(day); next.setDate(next.getDate() + 1);
    var dTemps = tempSeries.filter(function(t) { return t.dt >= day && t.dt < next; }).map(function(t) { return t.v; });
    var hi = dTemps.length ? Math.max.apply(null, dTemps) : NaN;
    var lo = dTemps.length ? Math.min.apply(null, dTemps) : NaN;
    if (isCelsius && !isNaN(hi)) { hi = hi * 9/5 + 32; lo = lo * 9/5 + 32; }
    var dPrecip = precipSeries.filter(function(t) { return t.dt >= day && t.dt < next; }).map(function(t) { return t.v; });
    var precipMm = dPrecip.reduce(function(a,b) { return a + b; }, 0);
    days.push({ date: day, hi: hi, lo: lo, mean: (hi+lo)/2, precipIn: precipMm / 25.4 });
  }
  return days;
}

function expandNWS(prop) {
  var result = [];
  var values = (prop && prop.values) || [];
  for (var j = 0; j < values.length; j++) {
    var entry = values[j];
    var vt = entry.validTime || '';
    if (vt.indexOf('/') < 0) continue;
    var parts = vt.split('/');
    var dt = new Date(parts[0]);
    if (isNaN(dt.getTime())) continue;
    var val = entry.value == null ? NaN : parseFloat(entry.value);
    var hrs = parseDurationHours(parts[1]);
    for (var h = 0; h < hrs; h++) {
      result.push({ dt: new Date(dt.getTime() + h*3600000), v: val });
    }
    if (hrs < 1) result.push({ dt: dt, v: val });
  }
  return result;
}

function parseDurationHours(s) {
  if (!s || s.charAt(0) !== 'P') return 1;
  var hours = 0;
  s = s.slice(1);
  if (s.indexOf('D') >= 0) { var p = s.split('D'); hours += parseFloat(p[0])*24; s = p[1]||''; }
  if (s.charAt(0) === 'T') s = s.slice(1);
  if (s.indexOf('H') >= 0) { hours += parseFloat(s.split('H')[0]); }
  return hours || 1;
}

function fallbackWeather() {
  var today = new Date(); today.setHours(0,0,0,0);
  var arr = [];
  for (var i = 0; i < 14; i++) {
    var d = new Date(today); d.setDate(d.getDate()+i);
    arr.push({ date: d, hi: 55, lo: 30, mean: 42.5, precipIn: 0 });
  }
  return arr;
}

/* ============================================================
   Hydrological forecast model — FIXED version
   
   Key fix: The forecast is ANCHORED to the current observed 
   discharge. Snowmelt and rainfall contributions are computed 
   as incremental changes relative to current conditions, using 
   an effective contributing area (small fraction of total drainage)
   rather than the full drainage area.
   ============================================================ */
function computeForecast(site, recent, weather, warnings) {
  var horizon = 14;
  var da = site.drainArea || 100;

  /* --- Baseflow separation (Lyne-Hollick) --- */
  var q = recent.map(function(r) { return r.q; });
  var n = q.length;
  var alpha = 0.925;
  var qf = new Array(n);
  qf[0] = 0;
  for (var i = 1; i < n; i++) {
    qf[i] = Math.max(0, alpha * qf[i-1] + (1+alpha)/2 * (q[i] - q[i-1]));
  }
  var bf = [];
  for (var i = 0; i < n; i++) {
    bf.push(Math.max(0, q[i] - qf[i]));
  }

  /* Current observed discharge — this anchors the forecast */
  var currentQ = q.length ? q[q.length - 1] : 100;
  
  /* Compute the quickflow (event-driven) fraction of current flow */
  var currentBf = bf.length ? bf[bf.length - 1] : currentQ * 0.7;
  var currentQf = Math.max(0, currentQ - currentBf);

  /* Fit recession k from observed baseflow falling limbs */
  var pairs = [];
  for (var i = 1; i < bf.length; i++) {
    if (bf[i] > 0 && bf[i] < bf[i-1]) pairs.push(bf[i] / bf[i-1]);
  }
  var k = pairs.length >= 3 ? median(pairs) : 0.97;
  k = Math.max(0.90, Math.min(0.998, k));

  /* Project baseflow using recession from current baseflow level */
  var projBf = [];
  for (var i = 0; i < horizon; i++) {
    projBf.push(currentBf * Math.pow(k, i + 1));
  }

  /* Quickflow recession (faster decay for event flow) */
  var qfK = Math.max(0.5, k - 0.2);  /* quickflow recedes faster */
  var projQf = [];
  for (var i = 0; i < horizon; i++) {
    projQf.push(currentQf * Math.pow(qfK, i + 1));
  }

  /* --- Snowmelt (degree-day) ---
     KEY FIX: Use an effective snow-contributing area that is a 
     small fraction of total drainage. Large basins like Lees Ferry 
     (111,800 sq mi) might only have 5-10% snow-covered area.
     Small headwater basins might have 30-60%. */
  var snowFrac;
  if (da < 50) snowFrac = 0.4;
  else if (da < 200) snowFrac = 0.25;
  else if (da < 1000) snowFrac = 0.12;
  else if (da < 10000) snowFrac = 0.05;
  else snowFrac = 0.02;

  var effectiveSnowArea = da * snowFrac;

  /* Estimate initial SWE based on season and latitude */
  var month = new Date().getMonth();  /* 0-11 */
  var baseSwe;
  if (month >= 3 && month <= 5) baseSwe = 4.0;       /* spring: peak snowmelt */
  else if (month >= 6 && month <= 8) baseSwe = 0.5;   /* summer: little snow */
  else if (month >= 9 && month <= 10) baseSwe = 1.0;  /* fall: early season */
  else baseSwe = 3.0;                                  /* winter */

  var DDF = 0.05;  /* inches SWE per degree-day (F) */
  var THRESH = 32;
  var swe = baseSwe;
  var meltIn = [];
  for (var i = 0; i < horizon; i++) {
    var tmean = (weather[i] && !isNaN(weather[i].mean)) ? weather[i].mean : 42;
    var dd = Math.max(0, tmean - THRESH);
    var pot = DDF * dd;
    var actual = Math.min(pot, Math.max(0, swe));
    meltIn.push(actual);
    swe = Math.max(0, swe - actual);
    /* Add new snowfall if temp is below freezing */
    if (tmean < THRESH && weather[i]) {
      var snowIn = (weather[i].precipIn || 0) * 0.8;  /* 80% of cold precip is snow */
      swe += snowIn;
    }
  }

  /* Convert melt to cfs using EFFECTIVE snow area only */
  var CONV = 26.89;  /* 1 inch over 1 sq mi in 1 day = 26.89 cfs */
  var meltCfs = [];
  for (var i = 0; i < horizon; i++) {
    meltCfs.push(meltIn[i] * effectiveSnowArea * CONV);
  }

  /* --- Rainfall runoff (SCS-CN) ---
     Also use a modest effective area — not all rain over the 
     entire basin reaches the gage in one day */
  var CN = da < 50 ? 60 : da < 500 ? 68 : 72;
  var S = 1000/CN - 10;
  var Ia = 0.2 * S;
  
  /* Effective rainfall-contributing area: smaller fraction for large basins */
  var rainFrac;
  if (da < 50) rainFrac = 0.5;
  else if (da < 500) rainFrac = 0.2;
  else if (da < 5000) rainFrac = 0.08;
  else rainFrac = 0.03;
  var effectiveRainArea = da * rainFrac;

  var rainCfs = [];
  for (var i = 0; i < horizon; i++) {
    var P = (weather[i] && weather[i].precipIn) ? weather[i].precipIn : 0;
    var tmean = (weather[i] && !isNaN(weather[i].mean)) ? weather[i].mean : 42;
    /* Only liquid precip contributes to immediate runoff */
    if (tmean < THRESH) P = P * 0.2;  /* most cold precip is stored as snow */
    if (P <= Ia) { rainCfs.push(0); continue; }
    var excess = P - Ia;
    rainCfs.push((excess*excess / (excess + S)) * effectiveRainArea * CONV);
  }

  /* Apply simple unit hydrograph smoothing to rainfall */
  var tp = Math.max(1, Math.round(0.5 * Math.pow(da, 0.15)));
  var base = Math.max(2, Math.round(2.67 * tp));
  var uh = [];
  for (var i = 0; i < base; i++) {
    if (i <= tp) uh.push(i / tp);
    else uh.push(Math.max(0, 1 - (i - tp) / (base - tp)));
  }
  var uhSum = uh.reduce(function(a,b) { return a+b; }, 0);
  if (uhSum > 0) uh = uh.map(function(v) { return v / uhSum; });
  
  var routedRain = new Array(horizon).fill(0);
  for (var i = 0; i < horizon; i++) {
    for (var j = 0; j < uh.length; j++) {
      if (i + j < horizon) routedRain[i + j] += rainCfs[i] * uh[j];
    }
  }

  /* --- Combine components ---
     Total = projected baseflow + decaying quickflow + new snowmelt + new rainfall */
  var total = [];
  for (var i = 0; i < horizon; i++) {
    total.push(projBf[i] + projQf[i] + meltCfs[i] + routedRain[i]);
  }

  /* --- Light Muskingum routing to smooth --- */
  var K = Math.min(3.0, 0.2 * Math.pow(da, 0.25));
  var X = 0.2;
  var dt = 1;
  var denom = 2*K*(1-X) + dt;
  var c0 = (dt - 2*K*X) / denom;
  var c1 = (dt + 2*K*X) / denom;
  var c2 = (2*K*(1-X) - dt) / denom;
  var routed = [total[0]];
  for (var i = 1; i < total.length; i++) {
    routed.push(Math.max(0, c0*total[i] + c1*total[i-1] + c2*routed[i-1]));
  }

  /* --- Uncertainty bands --- */
  var low = [], high = [];
  for (var i = 0; i < horizon; i++) {
    var pct = 0.15 + 0.35 * i / (horizon - 1);
    low.push(Math.max(0, routed[i] * (1 - pct)));
    high.push(routed[i] * (1 + pct));
  }

  var trend = routed[routed.length-1] - routed[0];

  return {
    dates: weather.slice(0, horizon).map(function(w) { return w.date; }),
    discharge: routed,
    low: low,
    high: high,
    baseflow: projBf.map(function(v, i) { return v + projQf[i]; }),
    snowmelt: meltCfs,
    rainfall: routedRain,
    currentQ: currentQ,
    trend: trend,
    recessionK: k,
  };
}

function median(arr) {
  var s = arr.slice().sort(function(a,b) { return a-b; });
  var m = Math.floor(s.length/2);
  return s.length % 2 ? s[m] : (s[m-1]+s[m])/2;
}

/* ============================================================
   Rendering
   ============================================================ */
function renderSteps(names, current) {
  stepsEl.innerHTML = names.map(function(name, i) {
    var cls = i < current ? 'step done' : i === current ? 'step active' : 'step';
    var icon = i < current ? '&#10003; ' : i === current ? '&#9679; ' : '';
    return '<span class="' + cls + '">' + icon + name + '</span>';
  }).join('');
}
function renderStepError(names) {
  stepsEl.innerHTML = names.map(function(name) {
    return '<span class="step error">' + name + '</span>';
  }).join('');
}
function addWarning(msg) {
  warningsEl.innerHTML += '<div class="warning">' + msg + '</div>';
}

function renderResults(site, recent, forecast, weather, warnings) {
  resultsEl.classList.remove('hidden');

  $('site-name').textContent = site.name;
  $('site-meta').textContent = 'USGS ' + site.siteNo + '  |  (' + site.lat.toFixed(4) + ', ' + site.lon.toFixed(4) + ')' + (site.drainArea ? '  |  ' + site.drainArea.toLocaleString() + ' sq mi' : '');

  $('card-current').innerHTML = forecast.currentQ != null
    ? '<div class="label">Current Discharge</div><div class="value" style="color:var(--yellow)">' + fmt(forecast.currentQ) + ' cfs</div><div class="sub">Most recent daily mean</div>'
    : '<div class="label">Current Discharge</div><div class="value" style="color:var(--text-dim)">N/A</div>';

  var d7 = forecast.discharge[6] || 0;
  $('card-day7').innerHTML = '<div class="label">Day 7 Forecast</div><div class="value" style="color:var(--accent)">' + fmt(d7) + ' cfs</div><div class="sub">' + fmt(forecast.low[6]) + ' &ndash; ' + fmt(forecast.high[6]) + ' cfs</div>';

  var d14 = forecast.discharge[13] || forecast.discharge[forecast.discharge.length-1];
  var d14Low = forecast.low[13] || forecast.low[forecast.low.length-1];
  var d14High = forecast.high[13] || forecast.high[forecast.high.length-1];
  $('card-day14').innerHTML = '<div class="label">Day 14 Forecast</div><div class="value" style="color:var(--accent2)">' + fmt(d14) + ' cfs</div><div class="sub">' + fmt(d14Low) + ' &ndash; ' + fmt(d14High) + ' cfs</div>';

  var dir = forecast.trend > 0 ? 'Rising' : forecast.trend < 0 ? 'Falling' : 'Steady';
  var dirColor = forecast.trend > 0 ? 'var(--green)' : forecast.trend < 0 ? 'var(--red)' : 'var(--text-dim)';
  $('card-trend').innerHTML = '<div class="label">14-Day Trend</div><div class="value" style="color:' + dirColor + '">' + dir + '</div><div class="sub">' + (forecast.trend > 0 ? '+' : '') + fmt(forecast.trend) + ' cfs</div>';

  renderForecastChart(recent, forecast);
  renderComponentsChart(forecast);
  renderTable(forecast, weather);
  warnings.forEach(addWarning);

  /* Scroll to results */
  resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderForecastChart(recent, forecast) {
  var ctx = $('forecast-chart').getContext('2d');
  if (forecastChart) forecastChart.destroy();

  var recentSlice = recent.slice(-30);
  var recentDates = recentSlice.map(function(r) { return r.date; });
  var recentQ = recentSlice.map(function(r) { return r.q; });
  var fDates = forecast.dates;
  var allDates = recentDates.concat(fDates);
  var labels = allDates.map(fmtDate);

  var padded = new Array(recentQ.length).fill(null);

  forecastChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Observed',
          data: recentQ.concat(new Array(fDates.length).fill(null)),
          borderColor: '#e2e8f0',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.3,
        },
        {
          label: 'Forecast',
          data: padded.concat(forecast.discharge),
          borderColor: '#38bdf8',
          borderWidth: 2.5,
          pointRadius: 0,
          tension: 0.3,
        },
        {
          label: '90% Confidence',
          data: padded.concat(forecast.high),
          borderColor: 'transparent',
          backgroundColor: 'rgba(56,189,248,0.12)',
          fill: '+1',
          pointRadius: 0,
        },
        {
          label: '10% Confidence',
          data: padded.concat(forecast.low),
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
  var ctx = $('components-chart').getContext('2d');
  if (componentsChart) componentsChart.destroy();
  var labels = forecast.dates.map(fmtDate);
  componentsChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        { label: 'Baseflow', data: forecast.baseflow, backgroundColor: 'rgba(56,189,248,0.6)', stack: 'stack' },
        { label: 'Snowmelt', data: forecast.snowmelt, backgroundColor: 'rgba(129,140,248,0.6)', stack: 'stack' },
        { label: 'Rainfall', data: forecast.rainfall, backgroundColor: 'rgba(52,211,153,0.6)', stack: 'stack' },
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#94a3b8', usePointStyle: true, padding: 20, font: { size: 11 } } },
        tooltip: { backgroundColor: '#1e293b', borderColor: '#475569', borderWidth: 1, titleColor: '#e2e8f0', bodyColor: '#e2e8f0' },
      },
      scales: {
        x: { stacked: true, ticks: { color: '#94a3b8', font: { size: 10 } }, grid: { color: 'rgba(71,85,105,0.3)' } },
        y: { stacked: true, title: { display: true, text: 'Discharge (cfs)', color: '#94a3b8' }, ticks: { color: '#94a3b8' }, grid: { color: 'rgba(71,85,105,0.3)' } },
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
  var tbody = $('forecast-tbody');
  tbody.innerHTML = '';
  for (var i = 0; i < forecast.dates.length; i++) {
    var d = forecast.dates[i];
    var w = weather[i] || {};
    var tr = document.createElement('tr');
    tr.innerHTML =
      '<td>' + fmtDateLong(d) + '</td>' +
      '<td style="color:var(--yellow);font-weight:600">' + fmt(forecast.discharge[i]) + '</td>' +
      '<td style="color:var(--text-dim)">' + fmt(forecast.low[i]) + '</td>' +
      '<td style="color:var(--text-dim)">' + fmt(forecast.high[i]) + '</td>' +
      '<td style="color:var(--accent)">' + fmt(forecast.baseflow[i]) + '</td>' +
      '<td style="color:var(--accent2)">' + fmt(forecast.snowmelt[i]) + '</td>' +
      '<td style="color:var(--green)">' + fmt(forecast.rainfall[i]) + '</td>' +
      '<td>' + (isNaN(w.hi) ? '—' : Math.round(w.hi) + '\u00B0') + '</td>' +
      '<td>' + (isNaN(w.lo) ? '—' : Math.round(w.lo) + '\u00B0') + '</td>' +
      '<td>' + ((w.precipIn||0).toFixed(2)) + '"</td>';
    tbody.appendChild(tr);
  }
}

/* Formatting helpers */
function fmt(v) { return v == null || isNaN(v) ? '—' : v.toLocaleString(undefined, {maximumFractionDigits:1}); }
function fmtDate(d) { return d.toLocaleDateString('en-US', {month:'short', day:'numeric'}); }
function fmtDateLong(d) { return d.toLocaleDateString('en-US', {weekday:'short', month:'short', day:'numeric'}); }

/* ---- Init ---- */
initMap();
loadMapSensors();
