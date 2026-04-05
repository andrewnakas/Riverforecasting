"""Tests for utility functions."""

from riverforecast.utils.units import (
    celsius_to_fahrenheit,
    fahrenheit_to_celsius,
    mm_to_inches,
    cms_to_cfs,
)


def test_celsius_to_fahrenheit():
    assert celsius_to_fahrenheit(0) == 32.0
    assert celsius_to_fahrenheit(100) == 212.0
    assert abs(celsius_to_fahrenheit(-40) - (-40.0)) < 0.001


def test_fahrenheit_to_celsius():
    assert fahrenheit_to_celsius(32) == 0.0
    assert fahrenheit_to_celsius(212) == 100.0


def test_mm_to_inches():
    assert abs(mm_to_inches(25.4) - 1.0) < 0.001


def test_cms_to_cfs():
    assert abs(cms_to_cfs(1.0) - 35.3147) < 0.01
