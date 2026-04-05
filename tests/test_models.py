"""Unit tests for the hydrological models."""

import numpy as np
import pandas as pd
import pytest

from riverforecast.models.baseflow import BaseflowSeparator
from riverforecast.models.snowmelt import SnowmeltModel
from riverforecast.models.rainfall_runoff import RainfallRunoffModel
from riverforecast.models.routing import MuskingumRouter


class TestBaseflowSeparator:
    def test_separate_returns_correct_columns(self):
        q = pd.Series([100, 120, 150, 130, 110, 100, 95, 90, 88, 85])
        sep = BaseflowSeparator()
        df = sep.separate(q)
        assert set(df.columns) == {"total", "baseflow", "quickflow"}
        assert len(df) == len(q)

    def test_baseflow_plus_quickflow_equals_total(self):
        q = pd.Series([100, 200, 300, 250, 150, 100, 90, 85, 82, 80])
        sep = BaseflowSeparator()
        df = sep.separate(q)
        np.testing.assert_allclose(df["baseflow"] + df["quickflow"], df["total"], atol=0.01)

    def test_baseflow_non_negative(self):
        q = pd.Series([50, 200, 500, 300, 100, 50, 40, 35, 30, 28])
        sep = BaseflowSeparator()
        df = sep.separate(q)
        assert (df["baseflow"] >= 0).all()

    def test_project_baseflow_decays(self):
        sep = BaseflowSeparator(recession_k=0.95)
        proj = sep.project_baseflow(100.0, 10)
        assert len(proj) == 10
        assert proj[0] < 100.0
        assert proj[-1] < proj[0]
        assert all(p > 0 for p in proj)

    def test_fit_recession_returns_valid_k(self):
        # Synthetic exponential decay
        bf = pd.Series([100 * 0.93**i for i in range(30)])
        sep = BaseflowSeparator()
        k = sep.fit_recession(bf)
        assert 0.80 <= k <= 0.995
        assert abs(k - 0.93) < 0.05  # Should be close to true value


class TestSnowmeltModel:
    def test_no_melt_below_threshold(self):
        model = SnowmeltModel(melt_threshold_f=32.0)
        temps = [25.0, 28.0, 30.0, 31.0, 20.0]
        result = model.compute_melt(temps, swe_initial_in=10.0)
        assert all(result["melt_in"] == 0.0)
        assert all(result["swe_in"] == 10.0)

    def test_melt_reduces_swe(self):
        model = SnowmeltModel(degree_day_factor=0.06, melt_threshold_f=32.0)
        temps = [50.0] * 10  # 18 degree-days per day
        result = model.compute_melt(temps, swe_initial_in=5.0)
        # SWE should decrease over time
        assert result["swe_in"].iloc[-1] < 5.0
        # Melt should be positive
        assert all(result["melt_in"] >= 0)

    def test_melt_limited_by_snowpack(self):
        model = SnowmeltModel(degree_day_factor=0.10, melt_threshold_f=32.0)
        temps = [70.0] * 10  # Very warm — high melt potential
        result = model.compute_melt(temps, swe_initial_in=1.0)  # Small snowpack
        # Total melt should not exceed initial SWE
        assert result["melt_in"].sum() <= 1.0 + 0.001
        # SWE should reach zero
        assert result["swe_in"].iloc[-1] == 0.0

    def test_melt_to_runoff_conversion(self):
        model = SnowmeltModel()
        melt = np.array([1.0])  # 1 inch
        area = 100.0  # sq mi
        runoff = model.melt_to_runoff(melt, area)
        # 1 inch over 100 sq mi in 1 day = 26.89 * 100 = 2689 cfs
        assert abs(runoff[0] - 2689.0) < 1.0


class TestRainfallRunoff:
    def test_no_runoff_below_initial_abstraction(self):
        model = RainfallRunoffModel(curve_number=70)
        # S = 1000/70 - 10 = 4.29, Ia = 0.86 inches
        precip = [0.5]  # Below Ia
        runoff = model.compute_runoff_depth(precip)
        assert runoff[0] == 0.0

    def test_runoff_increases_with_precip(self):
        model = RainfallRunoffModel(curve_number=80)
        precip = np.array([1.0, 2.0, 3.0, 4.0])
        runoff = model.compute_runoff_depth(precip)
        # Runoff should increase with precipitation
        for i in range(1, len(runoff)):
            if runoff[i] > 0:
                assert runoff[i] >= runoff[i - 1]

    def test_higher_cn_more_runoff(self):
        precip = [3.0]
        r_low = RainfallRunoffModel(curve_number=60).compute_runoff_depth(precip)
        r_high = RainfallRunoffModel(curve_number=90).compute_runoff_depth(precip)
        assert r_high[0] > r_low[0]

    def test_unit_hydrograph_conserves_volume(self):
        model = RainfallRunoffModel()
        excess = np.array([0, 0, 100, 200, 50, 0, 0, 0, 0, 0])
        routed = model.apply_unit_hydrograph(excess, tp_days=1.0)
        # Volume should be approximately conserved
        np.testing.assert_allclose(routed.sum(), excess.sum(), rtol=0.1)


class TestMuskingumRouter:
    def test_route_preserves_volume(self):
        router = MuskingumRouter(k=1.0, x=0.2)
        inflow = np.array([100, 200, 400, 300, 150, 100, 80, 70, 60, 50])
        outflow = router.route(inflow)
        # Volume should be approximately preserved
        np.testing.assert_allclose(outflow.sum(), inflow.sum(), rtol=0.15)

    def test_route_attenuates_peak(self):
        router = MuskingumRouter(k=1.5, x=0.1)
        inflow = np.array([50, 100, 500, 200, 100, 50, 40, 35, 30, 25])
        outflow = router.route(inflow)
        # Peak outflow should be less than peak inflow (attenuation)
        assert max(outflow) <= max(inflow)

    def test_route_non_negative(self):
        router = MuskingumRouter(k=1.0, x=0.2)
        inflow = np.array([0, 0, 100, 0, 0, 0, 0])
        outflow = router.route(inflow)
        assert all(outflow >= 0)

    def test_constant_inflow_passes_through(self):
        router = MuskingumRouter(k=1.0, x=0.2)
        inflow = np.array([100.0] * 20)
        outflow = router.route(inflow)
        # After initial transient, outflow should match inflow
        np.testing.assert_allclose(outflow[-5:], 100.0, atol=1.0)
