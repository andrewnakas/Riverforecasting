# River Forecasting System

**14-day streamflow forecasts for any USGS sensor in the Mountain West.**

This system generates operational river flow forecasts by combining real-time data from three federal sources with standard hydrological models:

- **USGS NWIS** — real-time and historical streamflow (discharge, gage height)
- **NWS Weather API** — temperature and precipitation forecasts (7–14 day)
- **NRCS SNOTEL** — snowpack (snow water equivalent) for snowmelt modeling

Forecasts are built from physically-based hydrology components: baseflow recession, degree-day snowmelt, SCS curve-number rainfall-runoff, and Muskingum channel routing — with uncertainty bounds that widen appropriately with lead time.

## Coverage

Mountain West states: **MT, ID, WY, CO, UT, NV, NM, AZ**

Any active USGS streamflow monitoring site in these states can be forecast.

## Installation

```bash
pip install -e .
```

Or with plotting support:

```bash
pip install -e ".[plot]"
```

## Quick Start

### CLI

```bash
# Generate a 14-day forecast for the Colorado River at Lees Ferry
riverforecast forecast 09380000

# Search for sites in Colorado
riverforecast search --state CO

# Get site details and nearby SNOTEL stations
riverforecast info 09380000

# Output as JSON or CSV
riverforecast forecast 09380000 --json
riverforecast forecast 09380000 --csv

# Clear cached API responses
riverforecast clear-cache
```

### Python API

```python
from riverforecast import ForecastEngine

engine = ForecastEngine()
result = engine.forecast("09380000")

# Access the forecast
print(f"Site: {result.site.site_name}")
print(f"Current flow: {result.current_discharge_cfs} cfs")
print(f"Current SWE: {result.current_swe_in} inches")

# As a DataFrame
df = result.to_dataframe()
print(df)

# Components are broken out
print(f"Day 1 baseflow: {result.baseflow_cfs[0]} cfs")
print(f"Day 1 snowmelt: {result.snowmelt_runoff_cfs[0]} cfs")
print(f"Day 1 rainfall: {result.rainfall_runoff_cfs[0]} cfs")

# Uncertainty bounds
print(f"Day 7 range: {result.discharge_low_cfs[6]} – {result.discharge_high_cfs[6]} cfs")
```

### Search for Sites

```python
from riverforecast.data import USGSClient

client = USGSClient()

# Find all active streamflow sites in Wyoming
sites = client.search_sites(state="WY")
for s in sites:
    print(f"{s.site_no}: {s.site_name} ({s.drainage_area_sq_mi} sq mi)")
```

## How It Works

The forecast is assembled from four model components:

### 1. Baseflow Recession
Recent observed discharge is separated into baseflow and quickflow using the Lyne-Hollick digital filter. The recession constant is fitted from falling limbs of the baseflow hydrograph, then used to project baseflow forward via exponential decay: `Q(t) = Q₀ × k^t`.

### 2. Snowmelt Runoff (Degree-Day Model)
Current snowpack (SWE) is obtained from the nearest SNOTEL station. Daily melt is estimated using the temperature-index method:
```
Melt = DDF × max(0, T_mean - T_threshold)
```
where DDF is the degree-day factor (inches SWE per °F-day). Melt is converted to runoff in cfs using standard USGS watershed conversion factors.

### 3. Rainfall Runoff (SCS Curve Number)
Forecast precipitation is routed through the SCS Curve Number equation to estimate direct runoff depth. A triangular unit hydrograph distributes the runoff in time. The curve number is estimated from drainage area as a proxy for land cover.

### 4. Channel Routing (Muskingum Method)
The combined hydrograph is routed using the Muskingum method to account for flood-wave travel time and attenuation through the channel network.

### Uncertainty
Forecast uncertainty is expressed as ±percentile bands that widen with lead time (±15% at day 1 to ±50% at day 14), consistent with standard hydrologic forecast skill decay.

## Example Sites

| Site | Name | State |
|------|------|-------|
| `09380000` | Colorado River at Lees Ferry | AZ |
| `09251000` | Yampa River near Maybell | CO |
| `13011000` | Snake River near Moran | WY |
| `12340000` | Blackfoot River near Bonner | MT |
| `10109000` | Logan River above State Dam | UT |
| `13185000` | Boise River near Twin Springs | ID |

## Running Tests

```bash
pip install -e ".[dev]"
pytest tests/ -v
```

## Project Structure

```
riverforecast/
├── __init__.py          # Package entry point
├── cli.py               # Click CLI (riverforecast command)
├── constants.py         # Hydrology constants and API URLs
├── engine.py            # Forecast orchestration engine
├── data/
│   ├── usgs.py          # USGS NWIS client (streamflow data)
│   ├── nws.py           # NWS Weather API client (forecasts)
│   └── snotel.py        # NRCS SNOTEL client (snowpack)
├── models/
│   ├── baseflow.py      # Baseflow separation & recession
│   ├── snowmelt.py      # Degree-day snowmelt model
│   ├── rainfall_runoff.py  # SCS Curve Number method
│   └── routing.py       # Muskingum channel routing
└── utils/
    ├── cache.py          # Disk cache for API responses
    └── units.py          # Unit conversion helpers
```

## License

MIT
