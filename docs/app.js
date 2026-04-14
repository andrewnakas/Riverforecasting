/* ============================================================
   River Forecast Dashboard v4 — Best-practices hydrology
   
   Techniques from operational forecasting:
   1. USGS daily statistics (percentiles by DOY) for bounds
   2. AR(1) persistence in log-space reverting to seasonal median
   3. KNN historical analog ensemble (5 nearest-neighbor years)
   4. Temperature perturbation from NWS forecast
   5. Climatological blending at longer lead times
   6. Percentile-based uncertainty from real distribution
   ============================================================ */

var USGS_DV   = 'https://waterservices.usgs.gov/nwis/dv/';
var USGS_SITE = 'https://waterservices.usgs.gov/nwis/site/';
var USGS_STAT = 'https://waterservices.usgs.gov/nwis/stat/';
var NWS_BASE  = 'https://api.weather.gov';

var forecastChart = null;
var componentsChart = null;
var map = null;
var markerLayer = null;

var $ = function(id) { return document.getElementById(id); };
var siteInput = $('site-input');
var goBtn = $('go-btn');
var statusBar = $('status-bar');
var stepsEl = $('steps');
var resultsEl = $('results');
var warningsEl = $('warnings');

/* ---- Map ---- */
function initMap() {
  map = L.map('map', { center: [41.5, -109.5], zoom: 5 });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; CARTO &copy; OSM', maxZoom: 18
  }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);
}

async function loadMapSensors() {
  var sc = $('map-state-filter').value;
  if (!sc) { $('map-count').textContent = 'Select a state'; return; }
  $('map-count').textContent = 'Loading...';
  $('load-map-btn').disabled = true;
  markerLayer.clearLayers();
  try {
    var url = USGS_SITE + '?format=rdb&stateCd=' + sc + '&siteType=ST&siteStatus=active&hasDataTypeCd=iv&parameterCd=00060&siteOutput=expanded';
    var text = await (await fetch(url)).text();
    var lines = text.split('\n').filter(function(l) { return !l.startsWith('#') && l.trim(); });
    if (lines.length < 3) { $('map-count').textContent = 'None found'; return; }
    var h = lines[0].split('\t');
    var si = h.indexOf('site_no'), ni = h.indexOf('station_nm');
    var li = h.indexOf('dec_lat_va'), oi = h.indexOf('dec_long_va'), di = h.indexOf('drain_area_va');
    var count = 0;
    for (var i = 2; i < lines.length; i++) {
      var c = lines[i].split('\t');
      var lat = parseFloat(c[li]), lon = parseFloat(c[oi]);
      if (isNaN(lat) || lat === 0) continue;
      var sn = c[si], nm = c[ni], da = c[di] || '';
      var ic = L.divIcon({ className: 'sensor-marker', iconSize: [10,10], iconAnchor: [5,5] });
      L.marker([lat,lon], {icon:ic}).addTo(markerLayer).bindPopup(
        '<div class="popup-title">'+nm+'</div><div class="popup-detail">Site: '+sn+'</div>'+
        (da ? '<div class="popup-detail">Drainage: '+parseFloat(da).toLocaleString()+' sq mi</div>' : '')+
        '<div style="margin-top:0.4rem"><a onclick="selectSite(\''+sn+'\')">Generate Forecast &rarr;</a></div>'
      );
      count++;
    }
    $('map-count').textContent = count + ' sensors';
    if (count > 0) map.fitBounds(markerLayer.getBounds().pad(0.1));
  } catch(e) { $('map-count').textContent = 'Error'; }
  $('load-map-btn').disabled = false;
}
function selectSite(s) { siteInput.value = s; map.closePopup(); runForecast(); }
window.selectSite = selectSite;

document.querySelectorAll('.pick').forEach(function(el) {
  el.addEventListener('click', function() { siteInput.value = el.dataset.site; runForecast(); });
});
goBtn.addEventListener('click', runForecast);
siteInput.addEventListener('keydown', function(e) { if (e.key==='Enter') runForecast(); });
$('load-map-btn').addEventListener('click', loadMapSensors);

/* ============================================================
   Pipeline — 6 data-fetch steps then model
   ============================================================ */
async function runForecast() {
  var siteNo = siteInput.value.trim();
  if (!siteNo) return;
  goBtn.disabled = true;
  resultsEl.classList.add('hidden');
  warningsEl.innerHTML = '';
  statusBar.classList.add('visible');
  var warnings = [];
  var steps = ['Site Info','Recent Flow','Historical Stats','Analog Years','Weather','Model','Render'];
  renderSteps(steps, 0);

  try {
    renderSteps(steps, 0);
    var site = await fetchSiteInfo(siteNo);

    renderSteps(steps, 1);
    var recent = await fetchRecentDischarge(siteNo, 90);
    if (recent.length < 7) { warnings.push('Fewer than 7 days of recent data.'); }

    renderSteps(steps, 2);
    var dailyStats = null;
    try { dailyStats = await fetchDailyStats(siteNo); }
    catch(e) { warnings.push('USGS daily statistics unavailable.'); }

    renderSteps(steps, 3);
    var analogTraces = null;
    try { analogTraces = await fetchAnalogTraces(siteNo, recent, 15); }
    catch(e) { warnings.push('Historical analog data unavailable.'); }

    renderSteps(steps, 4);
    var weather = null;
    try { weather = await fetchWeather(site.lat, site.lon); }
    catch(e) { warnings.push('NWS weather unavailable.'); weather = fallbackWeather(); }

    renderSteps(steps, 5);
    var forecast = computeForecastV4(site, recent, dailyStats, analogTraces, weather, warnings);

    renderSteps(steps, 6);
    renderResults(site, recent, forecast, weather, warnings);
    renderSteps(steps, 7);
  } catch(err) {
    renderStepError(steps);
    addWarning('Forecast failed: ' + err.message);
    console.error(err);
  }
  goBtn.disabled = false;
}

/* ============================================================
   Data fetching
   ============================================================ */
async function fetchSiteInfo(siteNo) {
  var url = USGS_SITE + '?format=rdb&sites=' + siteNo + '&siteOutput=expanded&siteStatus=active';
  var text = await (await fetch(url)).text();
  var lines = text.split('\n').filter(function(l) { return !l.startsWith('#') && l.trim(); });
  if (lines.length < 3) throw new Error('Site not found: ' + siteNo);
  var hdr = lines[0].split('\t'), vals = lines[2].split('\t');
  var col = function(n) { return vals[hdr.indexOf(n)] || ''; };
  return {
    siteNo: col('site_no'), name: col('station_nm'),
    lat: parseFloat(col('dec_lat_va'))||0, lon: parseFloat(col('dec_long_va'))||0,
    state: col('state_cd'), drainArea: parseFloat(col('drain_area_va'))||null, huc: col('huc_cd'),
  };
}

async function fetchRecentDischarge(siteNo, days) {
  var url = USGS_DV + '?format=json&sites=' + siteNo + '&parameterCd=00060&period=P' + days + 'D&siteStatus=active';
  var data = await (await fetch(url)).json();
  var ts = [];
  try { ts = data.value.timeSeries[0].values[0].value; } catch(e) {}
  return ts.map(function(v) {
    return { date: new Date(v.dateTime), q: parseFloat(v.value) };
  }).filter(function(v) { return !isNaN(v.q) && v.q >= 0; });
}

/**
 * Fetch USGS daily statistics: historical percentiles for each day-of-year.
 * Returns object keyed by "MM-DD" with {p10, p25, p50, p75, p90, mean, min, max, count}.
 */
async function fetchDailyStats(siteNo) {
  var url = USGS_STAT + '?format=rdb&sites=' + siteNo + '&statReportType=daily&statTypeCd=all&parameterCd=00060';
  var text = await (await fetch(url)).text();
  var lines = text.split('\n').filter(function(l) { return !l.startsWith('#') && l.trim(); });
  if (lines.length < 3) return null;
  var hdr = lines[0].split('\t');
  var stats = {};
  for (var i = 2; i < lines.length; i++) {
    var cols = lines[i].split('\t');
    if (cols.length < hdr.length) continue;
    var row = {};
    for (var j = 0; j < hdr.length; j++) row[hdr[j]] = cols[j];
    var month = parseInt(row['month_nu']), day = parseInt(row['day_nu']);
    if (isNaN(month) || isNaN(day)) continue;
    var key = pad2(month) + '-' + pad2(day);
    stats[key] = {
      p10: pf(row['p10_va']), p25: pf(row['p25_va']),
      p50: pf(row['p50_va']), p75: pf(row['p75_va']),
      p90: pf(row['p90_va']), mean: pf(row['mean_va']),
      min: pf(row['min_va']), max: pf(row['max_va']),
      count: parseInt(row['count_nu']) || 0,
    };
  }
  return Object.keys(stats).length > 100 ? stats : null;
}

function pad2(n) { return n < 10 ? '0'+n : ''+n; }
function pf(s) { var v = parseFloat(s); return isNaN(v) ? null : v; }

/**
 * KNN Analog Ensemble: fetch the same 35-day window from past N years,
 * find the K nearest neighbors (by flow level + trajectory similarity),
 * and return their forward 14-day traces as ratios to anchor-day flow.
 */
async function fetchAnalogTraces(siteNo, recent, nYears) {
  var now = new Date();
  var q = recent.map(function(r) { return r.q; });
  if (q.length < 7) return null;
  var currentQ = q[q.length - 1];
  if (currentQ <= 0) return null;

  /* Compute current 7-day trajectory (normalized slope) */
  var last7 = q.slice(-7);
  var slope = linearSlope(last7) / currentQ;

  /* Compute current acceleration (change in slope) */
  var accel = 0;
  if (q.length >= 14) {
    var prev7 = q.slice(-14, -7);
    var prevSlope = linearSlope(prev7) / Math.max(1, q[q.length - 8]);
    accel = slope - prevSlope;
  }

  /* Compute coefficient of variation of last 14 days (flow variability) */
  var cv = 0;
  if (q.length >= 14) {
    var r14 = q.slice(-14);
    var m14 = r14.reduce(function(a,b){return a+b;},0) / r14.length;
    var v14 = r14.reduce(function(a,b){return a+(b-m14)*(b-m14);},0) / r14.length;
    cv = m14 > 0 ? Math.sqrt(v14) / m14 : 0;
  }

  /* Fetch each past year */
  var fetches = [];
  for (var y = 1; y <= nYears; y++) {
    var start = new Date(now.getFullYear()-y, now.getMonth(), now.getDate()-14);
    var end   = new Date(now.getFullYear()-y, now.getMonth(), now.getDate()+16);
    var url = USGS_DV + '?format=json&sites=' + siteNo + '&parameterCd=00060&startDT=' + isoDate(start) + '&endDT=' + isoDate(end);
    fetches.push(fetch(url).then(function(r){return r.json();}).catch(function(){return null;}));
  }
  var responses = await Promise.all(fetches);

  /* Build candidate analogs with multi-feature distance */
  var candidates = [];
  for (var i = 0; i < responses.length; i++) {
    var data = responses[i]; if (!data) continue;
    var ts = [];
    try { ts = data.value.timeSeries[0].values[0].value; } catch(e) { continue; }
    var flows = ts.map(function(v){return parseFloat(v.value);}).filter(function(v){return !isNaN(v)&&v>0;});
    if (flows.length < 20) continue;

    var anchorIdx = Math.min(14, flows.length - 15);
    if (anchorIdx < 7) continue;
    var anchorQ = flows[anchorIdx];
    if (anchorQ <= 0) continue;

    /* Feature 1: Flow level similarity (log-space) */
    var flowDiff = Math.log(currentQ / anchorQ);

    /* Feature 2: 7-day trajectory similarity */
    var hist7 = flows.slice(Math.max(0, anchorIdx-6), anchorIdx+1);
    var histSlope = linearSlope(hist7) / anchorQ;
    var slopeDiff = slope - histSlope;

    /* Feature 3: Acceleration similarity */
    var histAccel = 0;
    if (anchorIdx >= 14) {
      var histPrev7 = flows.slice(anchorIdx-13, anchorIdx-6);
      var histPrevSlope = linearSlope(histPrev7) / Math.max(1, flows[anchorIdx-7]);
      histAccel = histSlope - histPrevSlope;
    }
    var accelDiff = accel - histAccel;

    /* Feature 4: Variability similarity */
    var histR14 = flows.slice(Math.max(0, anchorIdx-13), anchorIdx+1);
    var hm14 = histR14.reduce(function(a,b){return a+b;},0) / histR14.length;
    var hv14 = histR14.reduce(function(a,b){return a+(b-hm14)*(b-hm14);},0) / histR14.length;
    var histCv = hm14 > 0 ? Math.sqrt(hv14) / hm14 : 0;
    var cvDiff = cv - histCv;

    /* Weighted Euclidean distance (tuned weights) */
    var distance = Math.sqrt(
      5.0 * flowDiff*flowDiff +       /* Flow level: most important */
      1.5 * slopeDiff*slopeDiff +      /* Trajectory: important */
      0.8 * accelDiff*accelDiff +      /* Acceleration: moderate */
      0.5 * cvDiff*cvDiff              /* Variability: minor */
    );

    /* Extract forward 14-day trace as ratios */
    var trace = [];
    for (var d = 1; d <= 14; d++) {
      var idx = anchorIdx + d;
      if (idx < flows.length) {
        trace.push(flows[idx] / anchorQ);
      } else {
        trace.push(trace.length > 0 ? trace[trace.length-1] : 1.0);
      }
    }
    candidates.push({ distance: distance, trace: trace, year: now.getFullYear()-i-1 });
  }

  if (candidates.length < 3) return null;

  /* Sort by distance and take K=7 nearest */
  candidates.sort(function(a,b) { return a.distance - b.distance; });
  var K = Math.min(7, candidates.length);
  var topK = candidates.slice(0, K);

  /* Weight by inverse squared distance (sharper weighting for closer analogs) */
  var totalW = 0;
  for (var i = 0; i < K; i++) {
    topK[i].weight = 1 / ((topK[i].distance + 0.01) * (topK[i].distance + 0.01));
    totalW += topK[i].weight;
  }
  for (var i = 0; i < K; i++) topK[i].weight /= totalW;

  return topK;
}

function linearSlope(arr) {
  var n = arr.length;
  if (n < 2) return 0;
  var sx=0, sy=0, sxy=0, sx2=0;
  for (var i=0; i<n; i++) { sx+=i; sy+=arr[i]; sxy+=i*arr[i]; sx2+=i*i; }
  return (n*sxy - sx*sy) / (n*sx2 - sx*sx);
}

function isoDate(d) { return d.toISOString().slice(0,10); }

async function fetchWeather(lat, lon) {
  var ptUrl = NWS_BASE + '/points/' + lat.toFixed(4) + ',' + lon.toFixed(4);
  var ptResp = await fetch(ptUrl, { headers: { 'User-Agent': '(RiverForecastDashboard)' } });
  if (!ptResp.ok) throw new Error('NWS points failed');
  var ptData = await ptResp.json();
  var props = ptData.properties;
  var fUrl = NWS_BASE + '/gridpoints/' + props.gridId + '/' + props.gridX + ',' + props.gridY;
  var gResp = await fetch(fUrl, { headers: { 'User-Agent': '(RiverForecastDashboard)' } });
  if (!gResp.ok) throw new Error('NWS gridpoint failed');
  var gData = await gResp.json();
  var gProps = gData.properties || {};
  var tempSeries = expandNWS(gProps.temperature || {});
  var precipSeries = expandNWS(gProps.quantitativePrecipitation || {});
  var isCelsius = ((gProps.temperature||{}).uom||'').toLowerCase().indexOf('degc') >= 0;

  var today = new Date(); today.setHours(0,0,0,0);
  var days = [];
  for (var d = 0; d < 14; d++) {
    var day = new Date(today); day.setDate(day.getDate()+d);
    var next = new Date(day); next.setDate(next.getDate()+1);
    var dT = tempSeries.filter(function(t){return t.dt>=day&&t.dt<next;}).map(function(t){return t.v;});
    var hi = dT.length ? Math.max.apply(null,dT) : NaN;
    var lo = dT.length ? Math.min.apply(null,dT) : NaN;
    if (isCelsius && !isNaN(hi)) { hi=hi*9/5+32; lo=lo*9/5+32; }
    var dP = precipSeries.filter(function(t){return t.dt>=day&&t.dt<next;}).map(function(t){return t.v;});
    var pmm = dP.reduce(function(a,b){return a+b;}, 0);
    days.push({ date: day, hi:hi, lo:lo, mean:(hi+lo)/2, precipIn: pmm/25.4 });
  }
  return days;
}

function expandNWS(prop) {
  var result = [], values = (prop&&prop.values)||[];
  for (var j=0; j<values.length; j++) {
    var e = values[j], vt = e.validTime||'';
    if (vt.indexOf('/')<0) continue;
    var parts = vt.split('/'), dt = new Date(parts[0]);
    if (isNaN(dt.getTime())) continue;
    var val = e.value==null ? NaN : parseFloat(e.value);
    var hrs = parseDurH(parts[1]);
    for (var h=0; h<hrs; h++) result.push({dt:new Date(dt.getTime()+h*3600000), v:val});
    if (hrs<1) result.push({dt:dt, v:val});
  }
  return result;
}
function parseDurH(s) {
  if (!s||s[0]!=='P') return 1;
  var h=0; s=s.slice(1);
  if (s.indexOf('D')>=0){var p=s.split('D');h+=parseFloat(p[0])*24;s=p[1]||'';}
  if (s[0]==='T') s=s.slice(1);
  if (s.indexOf('H')>=0) h+=parseFloat(s.split('H')[0]);
  return h||1;
}
function fallbackWeather() {
  var today=new Date(); today.setHours(0,0,0,0);
  var a=[];
  for(var i=0;i<14;i++){var d=new Date(today);d.setDate(d.getDate()+i);a.push({date:d,hi:55,lo:30,mean:42.5,precipIn:0});}
  return a;
}

/* ============================================================
   V4 Forecast Model — Multi-method ensemble
   
   Combines three independent forecast methods and blends with
   climatological percentiles as lead time increases.
   
   Method 1: AR(1) persistence in log-space
   Method 2: KNN historical analog ensemble
   Method 3: Seasonal median trajectory (from USGS daily stats)
   
   Final = weighted blend that shifts from AR(1)/KNN at short
   lead times toward climatology at long lead times.
   ============================================================ */
function computeForecastV4(site, recent, dailyStats, analogTraces, weather, warnings) {
  var horizon = 14;
  var q = recent.map(function(r) { return r.q; });
  var n = q.length;
  var currentQ = n > 0 ? q[n-1] : 100;
  var today = new Date(); today.setHours(0,0,0,0);
  var currentMonth = today.getMonth(); /* 0-11 */

  /* ================================================================
     NOISE-ROBUST INITIAL CONDITIONS
     Use geometric mean of last 3 days to reduce impact of single-day
     measurement noise. This improves day-1 accuracy significantly.
     ================================================================ */
  var initQ = currentQ;
  if (n >= 3) {
    var logSum = 0;
    for (var j = 0; j < 3; j++) logSum += Math.log(Math.max(1, q[n-1-j]));
    initQ = Math.exp(logSum / 3);
  }

  /* ================================================================
     FLOW REGIME DETECTION
     ================================================================ */
  var last7 = q.slice(-7);
  var last14 = q.slice(-14);
  var slope7 = n >= 7 ? linearSlope(last7) / Math.max(1, currentQ) : 0;
  var accel = 0;
  if (n >= 14) {
    var first7slope = linearSlope(q.slice(-14, -7)) / Math.max(1, q[Math.max(0, n-8)]);
    accel = slope7 - first7slope;
  }
  var regime = Math.abs(slope7) < 0.005 ? 0 : (slope7 > 0 ? 1 : -1);

  /* ================================================================
     RETROSPECTIVE BIAS ESTIMATION
     ================================================================ */
  var biasFactor = 1.0;
  if (n >= 21 && dailyStats) {
    var biasLogErrs = [];
    for (var b = 7; b >= 1; b--) {
      var bIdx = n - 1 - b;
      if (bIdx < 1) continue;
      var bDate = new Date(today); bDate.setDate(bDate.getDate() - b);
      var bKey = pad2(bDate.getMonth()+1) + '-' + pad2(bDate.getDate());
      var bSeasonal = (dailyStats[bKey] && dailyStats[bKey].p50 != null) ? dailyStats[bKey].p50 : q[bIdx];
      var predLog = 0.93 * Math.log(Math.max(1, q[bIdx-1])) + 0.07 * Math.log(Math.max(1, bSeasonal));
      var actualLog = Math.log(Math.max(1, q[bIdx]));
      biasLogErrs.push(actualLog - predLog);
    }
    if (biasLogErrs.length >= 3) {
      var sortedErrs = biasLogErrs.slice().sort(function(a,b){return a-b;});
      var medErr = sortedErrs[Math.floor(sortedErrs.length/2)];
      biasFactor = Math.exp(Math.max(-0.15, Math.min(0.15, medErr)));
    }
  }

  /* ================================================================
     METHOD 1: Momentum-aware AR(2) in log-space
     AR(2) uses two lagged terms for better short-term accuracy.
     phi1 captures day-to-day persistence, phi2 captures momentum.
     Also flow-dependent: high anomalous flows decay faster.
     ================================================================ */
  var phi = 0.95;
  var phi2 = 0.0; /* AR(2) coefficient */
  if (n >= 14) {
    var logQ = [];
    for (var i = 0; i < n; i++) logQ.push(Math.log(Math.max(1, q[i])));
    var pairs = [];
    for (var i = 1; i < logQ.length; i++) pairs.push([logQ[i-1], logQ[i]]);
    if (pairs.length >= 7) {
      var mx = 0, my = 0;
      for (var i = 0; i < pairs.length; i++) { mx += pairs[i][0]; my += pairs[i][1]; }
      mx /= pairs.length; my /= pairs.length;
      var num = 0, den = 0;
      for (var i = 0; i < pairs.length; i++) {
        num += (pairs[i][0]-mx)*(pairs[i][1]-my);
        den += (pairs[i][0]-mx)*(pairs[i][0]-mx);
      }
      if (den > 0) phi = Math.max(0.80, Math.min(0.98, num/den));
    }
    /* Estimate AR(2) term from lag-2 autocorrelation */
    if (n >= 21) {
      var pairs2 = [];
      for (var i = 2; i < logQ.length; i++) pairs2.push([logQ[i-2], logQ[i]]);
      if (pairs2.length >= 7) {
        var mx2 = 0, my2 = 0;
        for (var i = 0; i < pairs2.length; i++) { mx2 += pairs2[i][0]; my2 += pairs2[i][1]; }
        mx2 /= pairs2.length; my2 /= pairs2.length;
        var num2 = 0, den2 = 0;
        for (var i = 0; i < pairs2.length; i++) {
          num2 += (pairs2[i][0]-mx2)*(pairs2[i][1]-my2);
          den2 += (pairs2[i][0]-mx2)*(pairs2[i][0]-mx2);
        }
        var rho2 = den2 > 0 ? num2 / den2 : 0;
        /* phi2 = (rho2 - phi^2) / (1 - phi^2) — Yule-Walker */
        var phi2raw = (rho2 - phi * phi) / Math.max(0.01, 1 - phi * phi);
        phi2 = Math.max(-0.10, Math.min(0.15, phi2raw));
      }
    }
  }

  /* Flow-dependent phi: high anomalous flows decay faster toward seasonal */
  var logAnomaly = Math.abs(Math.log(Math.max(1,currentQ)) - Math.log(Math.max(1,
    (dailyStats && dailyStats[pad2(today.getMonth()+1)+'-'+pad2(today.getDate())] &&
     dailyStats[pad2(today.getMonth()+1)+'-'+pad2(today.getDate())].p50 != null)
    ? dailyStats[pad2(today.getMonth()+1)+'-'+pad2(today.getDate())].p50 : currentQ)));
  var phiFlowAdj = logAnomaly > 0.5 ? -0.02 * Math.min(1, (logAnomaly - 0.5) / 1.0) : 0;

  var phiAdj = phi + phiFlowAdj;
  if (regime === 1) phiAdj = Math.min(0.99, phiAdj + 0.02);
  else if (regime === 0) phiAdj = Math.max(0.80, phiAdj - 0.01);

  /* Recession curve detection: fit exponential decay on falling limb */
  var recessionRate = 0;
  if (regime === -1 && n >= 7) {
    var logLast = last7.map(function(v){return Math.log(Math.max(1,v));});
    recessionRate = -linearSlope(logLast); /* positive = decaying */
    recessionRate = Math.max(0, Math.min(0.10, recessionRate));
  }

  /* Seasonal medians and percentile data */
  var seasonalQ = [], seasonalP25 = [], seasonalP75 = [];
  for (var i = 0; i < horizon; i++) {
    var fDate = new Date(today); fDate.setDate(fDate.getDate() + i + 1);
    var key = pad2(fDate.getMonth()+1) + '-' + pad2(fDate.getDate());
    var ds = dailyStats && dailyStats[key];
    seasonalQ.push(ds && ds.p50 != null ? ds.p50 : currentQ);
    seasonalP25.push(ds && ds.p25 != null ? ds.p25 : currentQ * 0.7);
    seasonalP75.push(ds && ds.p75 != null ? ds.p75 : currentQ * 1.3);
  }

  /* Percentile-anchored target */
  var todayKey = pad2(today.getMonth()+1) + '-' + pad2(today.getDate());
  var todayP50 = (dailyStats && dailyStats[todayKey] && dailyStats[todayKey].p50 != null)
    ? dailyStats[todayKey].p50 : currentQ;
  var todayP25 = (dailyStats && dailyStats[todayKey] && dailyStats[todayKey].p25 != null)
    ? dailyStats[todayKey].p25 : currentQ * 0.7;
  var todayP75 = (dailyStats && dailyStats[todayKey] && dailyStats[todayKey].p75 != null)
    ? dailyStats[todayKey].p75 : currentQ * 1.3;

  var pctilePos = 0.5;
  if (currentQ <= todayP25) pctilePos = 0.25;
  else if (currentQ >= todayP75) pctilePos = 0.75;
  else if (currentQ < todayP50) pctilePos = 0.25 + 0.25 * (currentQ - todayP25) / Math.max(1, todayP50 - todayP25);
  else pctilePos = 0.50 + 0.25 * (currentQ - todayP50) / Math.max(1, todayP75 - todayP50);

  var targetQ = [];
  for (var i = 0; i < horizon; i++) {
    var t = i / (horizon - 1);
    var effectivePctile = pctilePos + (0.5 - pctilePos) * t * 0.7;
    if (effectivePctile <= 0.5) {
      var w = Math.max(0, Math.min(1, (effectivePctile - 0.25) / 0.25));
      targetQ.push(seasonalP25[i] + w * (seasonalQ[i] - seasonalP25[i]));
    } else {
      var w = Math.max(0, Math.min(1, (effectivePctile - 0.50) / 0.25));
      targetQ.push(seasonalQ[i] + w * (seasonalP75[i] - seasonalQ[i]));
    }
  }

  /* AR(2) forecast using smoothed initQ */
  var ar1 = [];
  var prevLogQ = Math.log(Math.max(1, initQ));
  var prevLogQ2 = n >= 2 ? Math.log(Math.max(1, q[n-2])) : prevLogQ;
  for (var i = 0; i < horizon; i++) {
    var logTarget = Math.log(Math.max(1, targetQ[i]));
    var effPhi = i < 3 ? phiAdj : phi;
    /* AR(2): phi1*X(t-1) + phi2*X(t-2) + (1-phi1-phi2)*seasonal */
    var effPhi2 = i < 5 ? phi2 : phi2 * 0.5; /* fade AR(2) at longer leads */
    var logForecast = effPhi * prevLogQ + effPhi2 * prevLogQ2 + (1 - effPhi - effPhi2) * logTarget;
    /* Recession curve: if falling, apply exponential decay */
    if (recessionRate > 0 && i < 7) {
      var recessionPred = Math.log(Math.max(1, initQ)) - recessionRate * (i + 1);
      var recW = Math.max(0, 0.3 * (1 - i / 7)); /* fade recession influence */
      logForecast = (1 - recW) * logForecast + recW * recessionPred;
    }
    var bcDamp = Math.max(0, 1 - i * 0.12);
    ar1.push(Math.exp(logForecast) * (1 + (biasFactor - 1) * bcDamp));
    prevLogQ2 = prevLogQ;
    prevLogQ = logForecast;
  }

  /* ================================================================
     METHOD 2: Trend Extrapolation (short-term only)
     Linear extrapolation in log-space from recent trajectory.
     Most accurate for day 1-3, meaningless beyond day 5.
     ================================================================ */
  var trend = [];
  if (n >= 7) {
    var logLast7 = last7.map(function(v) { return Math.log(Math.max(1, v)); });
    var logSlope = linearSlope(logLast7);
    var logLast = Math.log(Math.max(1, initQ));
    for (var i = 0; i < horizon; i++) {
      /* Extrapolate with dampening: slope decays to 0 over 7 days */
      var dampSlope = logSlope * Math.max(0, 1 - i / 7);
      trend.push(Math.exp(logLast + dampSlope * (i + 1)));
    }
  } else {
    for (var i = 0; i < horizon; i++) trend.push(currentQ);
  }

  /* ================================================================
     METHOD 3: KNN Analog ensemble with outlier trimming
     Remove the most extreme trace before computing weighted mean
     if we have enough analogs (trimmed weighted mean).
     ================================================================ */
  var knnMedian = [];
  var knnTraces = [];
  if (analogTraces && analogTraces.length >= 3) {
    for (var d = 0; d < horizon; d++) {
      var traceVals = [];
      var traceWeights = [];
      for (var k = 0; k < analogTraces.length; k++) {
        var ratio = analogTraces[k].trace[d] || 1.0;
        traceVals.push(currentQ * ratio);
        traceWeights.push(analogTraces[k].weight);
      }

      /* Trimmed weighted mean: remove most extreme value if K >= 5 */
      var useVals = traceVals.slice();
      var useWeights = traceWeights.slice();
      if (useVals.length >= 5) {
        /* Find the value furthest from the weighted geometric mean */
        var rawLogWm = 0;
        for (var k = 0; k < useVals.length; k++) rawLogWm += Math.log(Math.max(1, useVals[k])) * useWeights[k];
        var maxDevIdx = 0, maxDev = 0;
        for (var k = 0; k < useVals.length; k++) {
          var dev = Math.abs(Math.log(Math.max(1, useVals[k])) - rawLogWm);
          if (dev > maxDev) { maxDev = dev; maxDevIdx = k; }
        }
        useVals.splice(maxDevIdx, 1);
        useWeights.splice(maxDevIdx, 1);
        /* Re-normalize weights */
        var wt = useWeights.reduce(function(a,b){return a+b;}, 0);
        for (var k = 0; k < useWeights.length; k++) useWeights[k] /= wt;
      }

      /* Log-space weighted mean (geometric mean) — avoids high-flow bias */
      var logWeightedSum = 0;
      for (var k = 0; k < useVals.length; k++) logWeightedSum += Math.log(Math.max(1, useVals[k])) * useWeights[k];
      knnMedian.push(Math.exp(logWeightedSum));
      knnTraces.push(traceVals); /* keep all traces for uncertainty */
    }
  } else {
    for (var d = 0; d < horizon; d++) {
      knnMedian.push(ar1[d]);
      knnTraces.push([ar1[d]]);
    }
  }

  /* ================================================================
     METHOD 4: Percentile-anchored climatology
     ================================================================ */
  /* targetQ computed above */

  /* ================================================================
     DYNAMIC METHOD WEIGHTING
     ================================================================ */
  var ar1Skill = 1.0, knnSkill = 1.0;
  if (n >= 14 && dailyStats) {
    var ar1Errs = [];
    for (var b = 7; b >= 1; b--) {
      var bIdx = n - 1 - b;
      if (bIdx < 1) continue;
      var bDate = new Date(today); bDate.setDate(bDate.getDate() - b);
      var bKey = pad2(bDate.getMonth()+1) + '-' + pad2(bDate.getDate());
      var bSeas = (dailyStats[bKey] && dailyStats[bKey].p50 != null) ? dailyStats[bKey].p50 : q[bIdx];
      var ar1Pred = Math.exp(phi * Math.log(Math.max(1, q[bIdx-1])) + (1-phi) * Math.log(Math.max(1, bSeas)));
      ar1Errs.push(Math.abs(Math.log(ar1Pred) - Math.log(Math.max(1, q[bIdx]))));
    }
    var ar1MeanErr = ar1Errs.length > 0 ? ar1Errs.reduce(function(a,b){return a+b;},0) / ar1Errs.length : 0.1;
    ar1Skill = 1 / (1 + ar1MeanErr * 5);
    knnSkill = analogTraces && analogTraces.length >= 3 ? 1 / (1 + ar1MeanErr * 3) : 0.5;
  }

  /* ================================================================
     FOUR-METHOD ADAPTIVE BLENDING in log-space

     Methods: AR(1), Trend Extrapolation, KNN, Climatology
     Trend gets high weight at short leads, zero at long leads.
     ================================================================ */
  var logAnomaly = Math.abs(Math.log(Math.max(1,currentQ)) - Math.log(Math.max(1,todayP50)));
  var anomalyFactor = Math.min(1, logAnomaly / 1.0);

  var blended = [];
  for (var i = 0; i < horizon; i++) {
    var t = i / (horizon - 1);

    /* Base weights for 4 methods — optimized for benchmark scores */
    var wTrend = Math.max(0, 0.25 - 0.25 * (i / 4)); /* 0.25 → 0 by day 5 */
    var wAR1  = (0.45 - 0.35 * t) * (1 - wTrend/0.60);
    var wKNN  = (0.25 - 0.05 * t);
    var wClim = (0.05 + 0.55 * t);

    /* Normalize to 1 */
    var wBase = wTrend + wAR1 + wKNN + wClim;
    wTrend /= wBase; wAR1 /= wBase; wKNN /= wBase; wClim /= wBase;

    /* Adaptive: anomalous → reduce climatology */
    var climShift = anomalyFactor * 0.12 * (1 - t*0.5);
    wClim = Math.max(0.05, wClim - climShift);
    wAR1 += climShift * 0.4;
    wKNN += climShift * 0.4;
    wTrend += climShift * 0.2;

    /* Dynamic skill-based adjustment */
    var skillTotal = ar1Skill + knnSkill + 0.5;
    var dynAR1 = ar1Skill / skillTotal;
    var dynKNN = knnSkill / skillTotal;
    wAR1 = 0.75 * wAR1 + 0.25 * dynAR1 * (wAR1 + wKNN);
    wKNN = 0.75 * wKNN + 0.25 * dynKNN * (wAR1 + wKNN);

    /* Re-normalize */
    var wSum = wTrend + wAR1 + wKNN + wClim;
    wTrend /= wSum; wAR1 /= wSum; wKNN /= wSum; wClim /= wSum;

    /* Blend in log-space */
    var logTrend = Math.log(Math.max(1, trend[i]));
    var logAR1  = Math.log(Math.max(1, ar1[i]));
    var logKNN  = Math.log(Math.max(1, knnMedian[i]));
    var logClim = Math.log(Math.max(1, targetQ[i]));
    var logBlend = wTrend * logTrend + wAR1 * logAR1 + wKNN * logKNN + wClim * logClim;
    blended.push(Math.exp(logBlend));
  }

  /* ================================================================
     WEATHER PERTURBATION — Season-aware temperature response
     ================================================================ */
  var seasonalSensitivity;
  if (currentMonth >= 2 && currentMonth <= 5) {
    seasonalSensitivity = { warm: 0.006, cool: 0.004 };
  } else if (currentMonth >= 6 && currentMonth <= 8) {
    seasonalSensitivity = { warm: 0.003, cool: 0.002 };
  } else {
    seasonalSensitivity = { warm: 0.002, cool: 0.001 };
  }

  var typicalMeanF = 45;
  for (var i = 0; i < horizon; i++) {
    var tmean = (weather[i] && !isNaN(weather[i].mean)) ? weather[i].mean : typicalMeanF;
    var tempDelta = tmean - typicalMeanF;
    var pctAdj = tempDelta > 0 ? tempDelta * seasonalSensitivity.warm : tempDelta * seasonalSensitivity.cool;
    var leadDampen = 1 - (i / horizon) * 0.6;
    blended[i] *= (1 + pctAdj * leadDampen);
    var precip = (weather[i] && weather[i].precipIn) ? weather[i].precipIn : 0;
    if (precip > 0.1 && tmean > 32) {
      blended[i] += precip * currentQ * 0.015 * leadDampen;
    }
  }

  /* Adaptive smoothing in log-space — lighter touch on early days for accuracy */
  var smoothed = [];
  var logBlended = blended.map(function(v) { return Math.log(Math.max(1, v)); });
  for (var i = 0; i < horizon; i++) {
    var logSmooth;
    if (i === 0) {
      /* Day 1: no smoothing — preserve best short-term accuracy */
      logSmooth = logBlended[0];
    } else if (i === 1) {
      /* Day 2: very light 3-point smooth (center-weighted) */
      logSmooth = (logBlended[0] + logBlended[1]*2 + logBlended[2]) / 4;
    } else if (i === 2) {
      /* Day 3: light 3-point smooth */
      logSmooth = (logBlended[1] + logBlended[2] + logBlended[3]) / 3;
    } else {
      /* Days 4+: 5-point smooth */
      if (i >= 2 && i < horizon-2) {
        logSmooth = (logBlended[i-2] + logBlended[i-1] + logBlended[i] + logBlended[i+1] + logBlended[i+2]) / 5;
      } else if (i === horizon-2) {
        logSmooth = (logBlended[i-1] + logBlended[i] + logBlended[i+1]) / 3;
      } else {
        logSmooth = (logBlended[i-1] + logBlended[i]*2) / 3;
      }
    }
    smoothed.push(Math.max(1, Math.exp(logSmooth)));
  }

  /* Floor at 1 cfs */
  for (var i = 0; i < horizon; i++) smoothed[i] = Math.max(1, smoothed[i]);

  /* ================================================================
     UNCERTAINTY from multiple sources:
     1. KNN trace spread (real historical variability)
     2. Climatological percentiles (p10, p90 for each DOY)
     3. Minimum model spread that widens with lead time
     ================================================================ */
  var low = [], high = [];
  var climP10 = [], climP25 = [], climP50 = [], climP75 = [], climP90 = [];
  for (var i = 0; i < horizon; i++) {
    var fDate = new Date(today); fDate.setDate(fDate.getDate() + i + 1);
    var key = pad2(fDate.getMonth()+1) + '-' + pad2(fDate.getDate());
    var ds = dailyStats && dailyStats[key];

    /* Climatological percentiles for this day */
    var cp10 = ds && ds.p10 != null ? ds.p10 : smoothed[i] * 0.5;
    var cp25 = ds && ds.p25 != null ? ds.p25 : smoothed[i] * 0.7;
    var cp50 = ds && ds.p50 != null ? ds.p50 : smoothed[i];
    var cp75 = ds && ds.p75 != null ? ds.p75 : smoothed[i] * 1.3;
    var cp90 = ds && ds.p90 != null ? ds.p90 : smoothed[i] * 1.5;
    climP10.push(cp10); climP25.push(cp25); climP50.push(cp50);
    climP75.push(cp75); climP90.push(cp90);

    /* KNN trace spread */
    var knnLo = smoothed[i], knnHi = smoothed[i];
    if (knnTraces[i] && knnTraces[i].length > 1) {
      var sorted = knnTraces[i].slice().sort(function(a,b){return a-b;});
      knnLo = sorted[0];
      knnHi = sorted[sorted.length - 1];
    }

    /* Blend uncertainty sources: KNN at short lead, climatology at long */
    var t = i / (horizon - 1);
    var wKnnU = 1 - t;      /* 1.0 → 0.0 */
    var wClimU = t;          /* 0.0 → 1.0 */

    var lo = wKnnU * knnLo + wClimU * cp10;
    var hi = wKnnU * knnHi + wClimU * cp90;

    /* Minimum spread: ±10% at day 1, ±35% at day 14 */
    var minPct = 0.10 + 0.25 * t;
    lo = Math.min(lo, smoothed[i] * (1 - minPct));
    hi = Math.max(hi, smoothed[i] * (1 + minPct));

    low.push(Math.max(0, lo));
    high.push(hi);
  }

  var trend = smoothed[horizon-1] - smoothed[0];

  /* Components for display */
  return {
    dates: weather.slice(0, horizon).map(function(w) { return w.date; }),
    discharge: smoothed,
    low: low, high: high,
    /* Breakdown for components chart */
    ar1: ar1,
    knn: knnMedian,
    seasonal: seasonalQ,
    /* Climatological envelope */
    climP10: climP10, climP25: climP25, climP50: climP50,
    climP75: climP75, climP90: climP90,
    currentQ: currentQ,
    trend: trend,
    phi: phi,
    nAnalogs: analogTraces ? analogTraces.length : 0,
    analogYears: analogTraces ? analogTraces.map(function(a){return a.year;}) : [],
  };
}

function median(arr) {
  var s = arr.slice().sort(function(a,b){return a-b;});
  var m = Math.floor(s.length/2);
  return s.length%2 ? s[m] : (s[m-1]+s[m])/2;
}

/* ============================================================
   Rendering — updated for v4 outputs
   ============================================================ */
function renderSteps(names, current) {
  stepsEl.innerHTML = names.map(function(name,i) {
    var cls = i<current?'step done':i===current?'step active':'step';
    var icon = i<current?'&#10003; ':i===current?'&#9679; ':'';
    return '<span class="'+cls+'">'+icon+name+'</span>';
  }).join('');
}
function renderStepError(names) {
  stepsEl.innerHTML = names.map(function(n){return '<span class="step error">'+n+'</span>';}).join('');
}
function addWarning(msg) { warningsEl.innerHTML += '<div class="warning">'+msg+'</div>'; }

function renderResults(site, recent, forecast, weather, warnings) {
  resultsEl.classList.remove('hidden');
  $('site-name').textContent = site.name;
  var metaText = 'USGS ' + site.siteNo + '  |  (' + site.lat.toFixed(4)+', '+site.lon.toFixed(4)+')';
  if (site.drainArea) metaText += '  |  '+site.drainArea.toLocaleString()+' sq mi';
  metaText += '  |  AR(1) \u03C6=' + forecast.phi.toFixed(3);
  if (forecast.nAnalogs > 0) metaText += '  |  ' + forecast.nAnalogs + ' analogs (' + forecast.analogYears.join(', ') + ')';
  $('site-meta').textContent = metaText;

  /* Cards */
  $('card-current').innerHTML = '<div class="label">Current Discharge</div><div class="value" style="color:var(--yellow)">'+fmt(forecast.currentQ)+' cfs</div><div class="sub">Most recent daily mean</div>';

  var d7 = forecast.discharge[6]||0;
  $('card-day7').innerHTML = '<div class="label">Day 7 Forecast</div><div class="value" style="color:var(--accent)">'+fmt(d7)+' cfs</div><div class="sub">'+fmt(forecast.low[6])+' \u2013 '+fmt(forecast.high[6])+' cfs</div>';

  var li = forecast.discharge.length-1;
  $('card-day14').innerHTML = '<div class="label">Day 14 Forecast</div><div class="value" style="color:var(--accent2)">'+fmt(forecast.discharge[li])+' cfs</div><div class="sub">'+fmt(forecast.low[li])+' \u2013 '+fmt(forecast.high[li])+' cfs</div>';

  var dir = forecast.trend>0?'Rising':forecast.trend<0?'Falling':'Steady';
  var dc = forecast.trend>0?'var(--green)':forecast.trend<0?'var(--red)':'var(--text-dim)';
  $('card-trend').innerHTML = '<div class="label">14-Day Trend</div><div class="value" style="color:'+dc+'">'+dir+'</div><div class="sub">'+(forecast.trend>0?'+':'')+fmt(forecast.trend)+' cfs</div>';

  renderForecastChart(recent, forecast);
  renderComponentsChart(forecast);
  renderTable(forecast, weather);
  warnings.forEach(addWarning);
  resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderForecastChart(recent, forecast) {
  var ctx = $('forecast-chart').getContext('2d');
  if (forecastChart) forecastChart.destroy();

  var slice = recent.slice(-30);
  var rDates = slice.map(function(r){return r.date;});
  var rQ = slice.map(function(r){return r.q;});
  var fDates = forecast.dates;
  var lastQ = rQ.length > 0 ? rQ[rQ.length-1] : null;

  /* Connect observed → forecast by overlapping last point */
  var allDates = rDates.concat(fDates);
  var labels = allDates.map(fmtDate);

  var obsData = rQ.concat(new Array(fDates.length).fill(null));

  var fPad = new Array(rQ.length-1).fill(null);
  var forecastData = fPad.concat([lastQ]).concat(forecast.discharge);
  var highData = fPad.concat([lastQ]).concat(forecast.high);
  var lowData = fPad.concat([lastQ]).concat(forecast.low);

  /* Climatological envelope */
  var climHiData = fPad.concat([lastQ]).concat(forecast.climP75);
  var climLoData = fPad.concat([lastQ]).concat(forecast.climP25);
  var climMedData = fPad.concat([null]).concat(forecast.climP50);

  forecastChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        { label:'Observed', data:obsData, borderColor:'#e2e8f0', borderWidth:2, pointRadius:0, tension:0.3 },
        { label:'Forecast', data:forecastData, borderColor:'#38bdf8', borderWidth:2.5, pointRadius:0, tension:0.3 },
        { label:'90% Conf.', data:highData, borderColor:'transparent', backgroundColor:'rgba(56,189,248,0.10)', fill:'+1', pointRadius:0 },
        { label:'10% Conf.', data:lowData, borderColor:'transparent', backgroundColor:'rgba(56,189,248,0.10)', fill:'-1', pointRadius:0 },
        { label:'Hist. p75', data:climHiData, borderColor:'rgba(251,191,36,0.3)', borderWidth:1, borderDash:[4,4], pointRadius:0, fill:false },
        { label:'Hist. p25', data:climLoData, borderColor:'rgba(251,191,36,0.3)', borderWidth:1, borderDash:[4,4], pointRadius:0, fill:false },
        { label:'Hist. Median', data:climMedData, borderColor:'rgba(251,191,36,0.5)', borderWidth:1.5, borderDash:[6,3], pointRadius:0, fill:false },
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
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        { label:'Blended Forecast', data:forecast.discharge, borderColor:'#38bdf8', borderWidth:2.5, pointRadius:0, tension:0.3 },
        { label:'AR(1) Persistence', data:forecast.ar1, borderColor:'#f87171', borderWidth:1.5, borderDash:[4,4], pointRadius:0, tension:0.3 },
        { label:'KNN Analogs', data:forecast.knn, borderColor:'#34d399', borderWidth:1.5, borderDash:[4,4], pointRadius:0, tension:0.3 },
        { label:'Seasonal Median', data:forecast.seasonal, borderColor:'#fbbf24', borderWidth:1.5, borderDash:[6,3], pointRadius:0, tension:0.3 },
      ]
    },
    options: chartOpts('Discharge (cfs)'),
  });
}

function chartOpts(yLabel) {
  return {
    responsive:true, maintainAspectRatio:false,
    interaction:{mode:'index',intersect:false},
    plugins:{
      legend:{labels:{color:'#94a3b8',usePointStyle:true,pointStyle:'line',padding:20,font:{size:11}}},
      tooltip:{backgroundColor:'#1e293b',borderColor:'#475569',borderWidth:1,titleColor:'#e2e8f0',bodyColor:'#e2e8f0'},
    },
    scales:{
      x:{ticks:{color:'#94a3b8',maxRotation:45,font:{size:10}},grid:{color:'rgba(71,85,105,0.3)'}},
      y:{title:{display:true,text:yLabel,color:'#94a3b8'},ticks:{color:'#94a3b8'},grid:{color:'rgba(71,85,105,0.3)'}},
    }
  };
}

function renderTable(forecast, weather) {
  var tbody = $('forecast-tbody');
  tbody.innerHTML = '';
  for (var i = 0; i < forecast.dates.length; i++) {
    var d = forecast.dates[i], w = weather[i]||{};
    var tr = document.createElement('tr');
    tr.innerHTML =
      '<td>'+fmtDateLong(d)+'</td>'+
      '<td style="color:var(--yellow);font-weight:600">'+fmt(forecast.discharge[i])+'</td>'+
      '<td style="color:var(--text-dim)">'+fmt(forecast.low[i])+'</td>'+
      '<td style="color:var(--text-dim)">'+fmt(forecast.high[i])+'</td>'+
      '<td style="color:var(--accent)">'+fmt(forecast.ar1[i])+'</td>'+
      '<td style="color:var(--green)">'+fmt(forecast.knn[i])+'</td>'+
      '<td style="color:var(--yellow)">'+fmt(forecast.seasonal[i])+'</td>'+
      '<td>'+(isNaN(w.hi)?'\u2014':Math.round(w.hi)+'\u00B0')+'</td>'+
      '<td>'+(isNaN(w.lo)?'\u2014':Math.round(w.lo)+'\u00B0')+'</td>'+
      '<td>'+((w.precipIn||0).toFixed(2))+'"</td>';
    tbody.appendChild(tr);
  }
}

function fmt(v) { return v==null||isNaN(v)?'\u2014':v.toLocaleString(undefined,{maximumFractionDigits:1}); }
function fmtDate(d) { return d.toLocaleDateString('en-US',{month:'short',day:'numeric'}); }
function fmtDateLong(d) { return d.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'}); }

/* Init */
initMap();
loadMapSensors();
