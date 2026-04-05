"""Unit conversion helpers used across the forecasting system."""


def celsius_to_fahrenheit(c: float) -> float:
    return c * 9.0 / 5.0 + 32.0


def fahrenheit_to_celsius(f: float) -> float:
    return (f - 32.0) * 5.0 / 9.0


def mm_to_inches(mm: float) -> float:
    return mm / 25.4


def inches_to_mm(inches: float) -> float:
    return inches * 25.4


def cms_to_cfs(cms: float) -> float:
    """Cubic meters per second → cubic feet per second."""
    return cms * 35.3147


def cfs_to_cms(cfs: float) -> float:
    """Cubic feet per second → cubic meters per second."""
    return cfs / 35.3147


def km_to_miles(km: float) -> float:
    return km * 0.621371


def miles_to_km(mi: float) -> float:
    return mi / 0.621371
