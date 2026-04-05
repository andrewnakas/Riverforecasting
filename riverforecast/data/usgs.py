"""Client for the USGS National Water Information System (NWIS) API.

Provides access to real-time and historical streamflow, gage height,
and water temperature data for any USGS monitoring site.

Reference: https://waterservices.usgs.gov/docs/
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta

import numpy as np
import pandas as pd
import requests

from riverforecast.constants import (
    MOUNTAIN_WEST_STATES,
    PARAM_DISCHARGE,
    PARAM_GAGE_HEIGHT,
    PARAM_WATER_TEMP,
    USGS_DV_URL,
    USGS_IV_URL,
    USGS_SITE_URL,
)
from riverforecast.utils import cache

logger = logging.getLogger(__name__)


@dataclass
class SiteInfo:
    """Metadata for a USGS monitoring site."""

    site_no: str
    site_name: str
    latitude: float
    longitude: float
    state_cd: str
    huc_cd: str = ""
    drainage_area_sq_mi: float | None = None
    available_params: list[str] = field(default_factory=list)


class USGSClient:
    """Fetch hydrologic data from the USGS NWIS water services API."""

    TIMEOUT = 30

    # ------------------------------------------------------------------ #
    #  Site discovery
    # ------------------------------------------------------------------ #

    def get_site_info(self, site_no: str) -> SiteInfo:
        """Return metadata for a single USGS site number (e.g. '09380000')."""
        params = {
            "format": "rdb",
            "sites": site_no,
            "siteOutput": "expanded",
            "siteStatus": "active",
        }
        cached = cache.get(USGS_SITE_URL, params)
        if cached:
            return self._parse_site_rdb(cached["text"], single=True)
        resp = requests.get(USGS_SITE_URL, params=params, timeout=self.TIMEOUT)
        resp.raise_for_status()
        cache.put(USGS_SITE_URL, params, {"text": resp.text})
        return self._parse_site_rdb(resp.text, single=True)

    def search_sites(
        self,
        state: str | None = None,
        bbox: tuple[float, float, float, float] | None = None,
        parameter: str = PARAM_DISCHARGE,
        limit: int = 100,
    ) -> list[SiteInfo]:
        """Search for active USGS streamflow sites.

        Args:
            state: Two-letter state code (must be in MOUNTAIN_WEST_STATES).
            bbox:  (west, south, east, north) in decimal degrees.
            parameter: USGS parameter code to require.
            limit: Max sites to return.
        """
        if state and state.upper() not in MOUNTAIN_WEST_STATES:
            raise ValueError(
                f"State '{state}' is not in the Mountain West. "
                f"Supported: {', '.join(MOUNTAIN_WEST_STATES)}"
            )
        params: dict = {
            "format": "rdb",
            "siteOutput": "expanded",
            "siteType": "ST",
            "siteStatus": "active",
            "parameterCd": parameter,
            "hasDataTypeCd": "iv",
        }
        if state:
            params["stateCd"] = state.upper()
        elif bbox:
            params["bBox"] = ",".join(str(v) for v in bbox)
        else:
            raise ValueError("Provide either state or bbox for site search.")

        cached = cache.get(USGS_SITE_URL, params)
        if cached:
            text = cached["text"]
        else:
            resp = requests.get(USGS_SITE_URL, params=params, timeout=60)
            resp.raise_for_status()
            text = resp.text
            cache.put(USGS_SITE_URL, params, {"text": text})

        sites = self._parse_site_rdb(text, single=False)
        return sites[:limit]

    # ------------------------------------------------------------------ #
    #  Time-series data
    # ------------------------------------------------------------------ #

    def get_instantaneous(
        self,
        site_no: str,
        parameters: list[str] | None = None,
        period: str = "P7D",
    ) -> pd.DataFrame:
        """Fetch instantaneous-value data (typically 15-min intervals).

        Args:
            site_no: USGS site number.
            parameters: List of parameter codes. Defaults to discharge + gage height.
            period: ISO 8601 duration string (e.g. 'P7D' for 7 days).

        Returns:
            DataFrame indexed by datetime with columns named by parameter code.
        """
        if parameters is None:
            parameters = [PARAM_DISCHARGE, PARAM_GAGE_HEIGHT]
        params = {
            "format": "json",
            "sites": site_no,
            "parameterCd": ",".join(parameters),
            "period": period,
            "siteStatus": "active",
        }
        data = self._fetch_json(USGS_IV_URL, params)
        return self._json_to_dataframe(data)

    def get_daily_values(
        self,
        site_no: str,
        parameters: list[str] | None = None,
        start: datetime | str | None = None,
        end: datetime | str | None = None,
        period: str | None = None,
    ) -> pd.DataFrame:
        """Fetch daily-value (mean daily) data.

        Provide either (start, end) or period, not both.
        """
        if parameters is None:
            parameters = [PARAM_DISCHARGE]
        params: dict = {
            "format": "json",
            "sites": site_no,
            "parameterCd": ",".join(parameters),
            "siteStatus": "active",
        }
        if period:
            params["period"] = period
        else:
            if start is None:
                start = datetime.now() - timedelta(days=365)
            if end is None:
                end = datetime.now()
            params["startDT"] = _fmt_date(start)
            params["endDT"] = _fmt_date(end)

        data = self._fetch_json(USGS_DV_URL, params)
        return self._json_to_dataframe(data)

    def get_recent_discharge(self, site_no: str, days: int = 30) -> pd.Series:
        """Convenience: return a daily-mean discharge Series (cfs) for recent history."""
        df = self.get_daily_values(site_no, [PARAM_DISCHARGE], period=f"P{days}D")
        if PARAM_DISCHARGE in df.columns:
            return df[PARAM_DISCHARGE].dropna()
        # Fall back to whatever column we got
        return df.iloc[:, 0].dropna()

    # ------------------------------------------------------------------ #
    #  Internal helpers
    # ------------------------------------------------------------------ #

    def _fetch_json(self, url: str, params: dict) -> dict:
        cached = cache.get(url, params)
        if cached:
            return cached
        logger.debug("USGS request: %s %s", url, params)
        resp = requests.get(url, params=params, timeout=self.TIMEOUT)
        resp.raise_for_status()
        data = resp.json()
        cache.put(url, params, data)
        return data

    @staticmethod
    def _json_to_dataframe(data: dict) -> pd.DataFrame:
        """Convert USGS JSON (WaterML 2.0 style) to a tidy DataFrame."""
        ts_list = data.get("value", {}).get("timeSeries", [])
        if not ts_list:
            return pd.DataFrame()

        frames = {}
        for ts in ts_list:
            var_code = ts["variable"]["variableCode"][0]["value"]
            values = ts["values"][0]["value"]
            if not values:
                continue
            records = []
            for v in values:
                try:
                    val = float(v["value"])
                except (ValueError, TypeError):
                    val = np.nan
                records.append({"datetime": pd.to_datetime(v["dateTime"]), "value": val})
            s = pd.DataFrame(records).set_index("datetime")["value"]
            # Replace USGS sentinel -999999 with NaN
            s = s.replace(-999999.0, np.nan)
            frames[var_code] = s

        if not frames:
            return pd.DataFrame()
        df = pd.DataFrame(frames)
        df.index.name = "datetime"
        return df.sort_index()

    @staticmethod
    def _parse_site_rdb(text: str, single: bool = False):
        """Parse USGS RDB (tab-delimited) site information."""
        lines = [l for l in text.strip().splitlines() if not l.startswith("#")]
        if len(lines) < 2:
            if single:
                raise ValueError("No site data returned from USGS.")
            return []
        header = lines[0].split("\t")
        # Skip the format line (line index 1)
        data_lines = lines[2:]

        def _col(row_dict: dict, name: str, default=""):
            return row_dict.get(name, default)

        sites = []
        for line in data_lines:
            fields = line.split("\t")
            if len(fields) < len(header):
                continue
            row = dict(zip(header, fields))
            try:
                lat = float(_col(row, "dec_lat_va", "0"))
                lon = float(_col(row, "dec_long_va", "0"))
            except ValueError:
                lat, lon = 0.0, 0.0
            da_str = _col(row, "drain_area_va", "")
            da = float(da_str) if da_str else None
            sites.append(
                SiteInfo(
                    site_no=_col(row, "site_no"),
                    site_name=_col(row, "station_nm"),
                    latitude=lat,
                    longitude=lon,
                    state_cd=_col(row, "state_cd"),
                    huc_cd=_col(row, "huc_cd"),
                    drainage_area_sq_mi=da,
                )
            )
        if single:
            if not sites:
                raise ValueError("No site data returned from USGS.")
            return sites[0]
        return sites


def _fmt_date(d: datetime | str) -> str:
    if isinstance(d, str):
        return d
    return d.strftime("%Y-%m-%d")
