"""Client for NRCS SNOTEL data via the Report Generator.

Retrieves snow water equivalent (SWE), snow depth, and accumulated
precipitation from SNOTEL stations near a given location.

Reference: https://www.nrcs.usda.gov/wps/portal/wcc/home/
"""

from __future__ import annotations

import csv
import io
import logging
import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta

import numpy as np
import pandas as pd
import requests

from riverforecast.constants import SNOTEL_REPORT_URL, SNOTEL_SEARCH_RADIUS_MI
from riverforecast.utils import cache

logger = logging.getLogger(__name__)

# Well-known SNOTEL stations in Mountain West states, organized by state.
# This lookup table is used when the dynamic station-finder endpoint is unavailable.
# Format: (triplet, name, lat, lon, elevation_ft)
_KNOWN_STATIONS: list[tuple[str, str, float, float, int]] = [
    # Colorado
    ("412:CO:SNTL", "Berthoud Summit", 39.80, -105.78, 11300),
    ("485:CO:SNTL", "Copper Mountain", 39.50, -106.17, 10520),
    ("531:CO:SNTL", "Fremont Pass", 39.38, -106.20, 11400),
    ("737:CO:SNTL", "Schofield Pass", 39.02, -107.05, 10700),
    ("505:CO:SNTL", "Dry Lake", 40.53, -106.77, 8400),
    # Utah
    ("766:UT:SNTL", "Snowbird", 40.56, -111.67, 9640),
    ("828:UT:SNTL", "Trial Lake", 40.68, -110.95, 9980),
    ("572:UT:SNTL", "Timpanogos Divide", 40.40, -111.58, 8120),
    # Wyoming
    ("823:WY:SNTL", "Togwotee Pass", 43.75, -110.08, 9580),
    ("686:WY:SNTL", "Phantom Lake", 41.15, -106.30, 8050),
    # Montana
    ("609:MT:SNTL", "Lick Creek", 47.05, -115.58, 5960),
    ("656:MT:SNTL", "Northeast Entrance", 45.00, -110.00, 7350),
    # Idaho
    ("550:ID:SNTL", "Graham Guard Sta", 46.85, -115.95, 5280),
    ("774:ID:SNTL", "Soldier R.S.", 43.92, -115.07, 6070),
    # Nevada
    ("615:NV:SNTL", "Lee Canyon", 36.32, -115.68, 8400),
    # New Mexico
    ("708:NM:SNTL", "Red River Pass #2", 36.68, -105.32, 9850),
    # Arizona
    ("309:AZ:SNTL", "Baker Butte", 34.42, -111.38, 7620),
]


@dataclass
class SnotelStation:
    triplet: str  # e.g. "485:CO:SNTL"
    name: str
    latitude: float
    longitude: float
    elevation_ft: int
    distance_mi: float = 0.0


@dataclass
class SnotelData:
    """Daily SNOTEL observations for a single station."""

    station: SnotelStation
    dates: list[datetime] = field(default_factory=list)
    swe_in: list[float] = field(default_factory=list)  # Snow water equivalent (inches)
    snow_depth_in: list[float] = field(default_factory=list)
    precip_accum_in: list[float] = field(default_factory=list)


class SnotelClient:
    """Find and fetch SNOTEL snowpack data near a geographic point."""

    TIMEOUT = 30

    def find_nearest_stations(
        self,
        lat: float,
        lon: float,
        radius_mi: float = SNOTEL_SEARCH_RADIUS_MI,
        limit: int = 5,
    ) -> list[SnotelStation]:
        """Return nearby SNOTEL stations sorted by distance."""
        results: list[SnotelStation] = []
        for triplet, name, slat, slon, elev in _KNOWN_STATIONS:
            d = _haversine_mi(lat, lon, slat, slon)
            if d <= radius_mi:
                results.append(
                    SnotelStation(
                        triplet=triplet,
                        name=name,
                        latitude=slat,
                        longitude=slon,
                        elevation_ft=elev,
                        distance_mi=round(d, 1),
                    )
                )
        results.sort(key=lambda s: s.distance_mi)
        return results[:limit]

    def get_station_data(
        self,
        station: SnotelStation | str,
        days: int = 90,
    ) -> SnotelData:
        """Fetch recent SWE, snow depth, and precip for a SNOTEL station.

        Args:
            station: A SnotelStation object or triplet string (e.g. '485:CO:SNTL').
            days: Number of days of history to retrieve.
        """
        if isinstance(station, SnotelStation):
            triplet = station.triplet
            sta = station
        else:
            triplet = station
            sta = SnotelStation(triplet=triplet, name="", latitude=0, longitude=0, elevation_ft=0)

        end_dt = datetime.now()
        start_dt = end_dt - timedelta(days=days)
        start_str = start_dt.strftime("%Y-%m-%d")
        end_str = end_dt.strftime("%Y-%m-%d")

        # Build NRCS Report Generator URL
        # Elements: WTEQ (SWE), SNWD (snow depth), PREC (accum precip)
        station_id = triplet.split(":")[0]
        state = triplet.split(":")[1]
        url = (
            f"{SNOTEL_REPORT_URL}/customSingleStationReport/daily/"
            f"{station_id}:{state}:SNTL"
            f"|id=%22%22|name/{start_str},{end_str}/"
            f"WTEQ::value,SNWD::value,PREC::value"
        )

        cached = cache.get(url, None, ttl=3600)
        if cached:
            text = cached["text"]
        else:
            logger.debug("SNOTEL request: %s", url)
            resp = requests.get(url, timeout=self.TIMEOUT)
            resp.raise_for_status()
            text = resp.text
            cache.put(url, None, {"text": text})

        return self._parse_csv(text, sta)

    def get_current_swe(self, lat: float, lon: float) -> float | None:
        """Quick helper: get the most recent SWE (inches) from the nearest station."""
        stations = self.find_nearest_stations(lat, lon, limit=3)
        for station in stations:
            try:
                data = self.get_station_data(station, days=7)
                if data.swe_in:
                    # Return the most recent non-NaN value
                    for val in reversed(data.swe_in):
                        if not np.isnan(val):
                            return val
            except Exception as e:
                logger.warning("Failed to get SWE from %s: %s", station.name, e)
                continue
        return None

    # ------------------------------------------------------------------ #
    #  Internal
    # ------------------------------------------------------------------ #

    @staticmethod
    def _parse_csv(text: str, station: SnotelStation) -> SnotelData:
        """Parse NRCS Report Generator CSV into SnotelData."""
        # Skip comment lines (start with #)
        lines = [l for l in text.strip().splitlines() if not l.startswith("#")]
        if not lines:
            return SnotelData(station=station)

        reader = csv.reader(io.StringIO("\n".join(lines)))
        header = next(reader, None)
        if not header:
            return SnotelData(station=station)

        dates, swe, depth, precip = [], [], [], []
        for row in reader:
            if len(row) < 2:
                continue
            try:
                dt = datetime.strptime(row[0].strip(), "%Y-%m-%d")
            except ValueError:
                continue
            dates.append(dt)
            swe.append(_safe_float(row[1] if len(row) > 1 else ""))
            depth.append(_safe_float(row[2] if len(row) > 2 else ""))
            precip.append(_safe_float(row[3] if len(row) > 3 else ""))

        return SnotelData(
            station=station,
            dates=dates,
            swe_in=swe,
            snow_depth_in=depth,
            precip_accum_in=precip,
        )


def _safe_float(s: str) -> float:
    try:
        return float(s.strip())
    except (ValueError, TypeError):
        return float("nan")


def _haversine_mi(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in miles between two points."""
    R = 3958.8  # Earth radius in miles
    lat1, lon1, lat2, lon2 = map(math.radians, [lat1, lon1, lat2, lon2])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return R * 2 * math.asin(math.sqrt(a))
