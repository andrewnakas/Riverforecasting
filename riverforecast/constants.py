"""Constants and configuration for the Mountain West river forecasting system."""

# Mountain West states (FIPS 2-letter codes)
MOUNTAIN_WEST_STATES = ("MT", "ID", "WY", "CO", "UT", "NV", "NM", "AZ")

# USGS parameter codes
PARAM_DISCHARGE = "00060"  # Discharge (cfs)
PARAM_GAGE_HEIGHT = "00065"  # Gage height (ft)
PARAM_WATER_TEMP = "00010"  # Water temperature (°C)

# USGS NWIS API
USGS_IV_URL = "https://waterservices.usgs.gov/nwis/iv/"
USGS_DV_URL = "https://waterservices.usgs.gov/nwis/dv/"
USGS_SITE_URL = "https://waterservices.usgs.gov/nwis/site/"

# NWS API
NWS_BASE_URL = "https://api.weather.gov"
NWS_USER_AGENT = "(RiverForecast, riverforecast@example.com)"

# NRCS SNOTEL Report Generator
SNOTEL_REPORT_URL = "https://wcc.sc.egov.usda.gov/reportGenerator/view_csv"
SNOTEL_STATION_URL = "https://wcc.sc.egov.usda.gov/nwcc/inventory"

# Hydrology defaults
FORECAST_HORIZON_DAYS = 14
DEGREE_DAY_FACTOR = 0.06  # inches SWE per degree-day (°F) — typical Mountain West
RECESSION_CONSTANT = 0.95  # Daily baseflow recession constant (dimensionless)
RUNOFF_COEFFICIENT = 0.35  # Fraction of precip that becomes runoff
MELT_THRESHOLD_F = 32.0  # Temperature threshold for snowmelt (°F)
ROUTING_K = 1.5  # Muskingum K parameter (days)
ROUTING_X = 0.2  # Muskingum X parameter (dimensionless, 0–0.5)

# Cache settings
CACHE_DIR = ".riverforecast_cache"
CACHE_TTL_SECONDS = 3600  # 1 hour

# Search radius for SNOTEL stations (miles)
SNOTEL_SEARCH_RADIUS_MI = 50
