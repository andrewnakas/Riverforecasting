"""Command-line interface for the River Forecasting System.

Usage:
    riverforecast forecast 09380000
    riverforecast search --state CO
    riverforecast info 09380000
"""

from __future__ import annotations

import logging
import sys

import click
from rich.console import Console
from rich.table import Table
from rich.panel import Panel
from rich.text import Text

console = Console()


def _setup_logging(verbose: bool) -> None:
    level = logging.DEBUG if verbose else logging.WARNING
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )


@click.group()
@click.option("-v", "--verbose", is_flag=True, help="Enable debug logging.")
def main(verbose: bool) -> None:
    """River Forecasting System — 14-day streamflow forecasts for the Mountain West."""
    _setup_logging(verbose)


@main.command()
@click.argument("site_no")
@click.option("--days", default=14, show_default=True, help="Forecast horizon (max 14).")
@click.option("--json", "as_json", is_flag=True, help="Output as JSON.")
@click.option("--csv", "as_csv", is_flag=True, help="Output as CSV.")
def forecast(site_no: str, days: int, as_json: bool, as_csv: bool) -> None:
    """Generate a streamflow forecast for a USGS site.

    SITE_NO is a USGS site number, e.g. 09380000 (Colorado River at Lees Ferry).
    """
    from riverforecast.engine import ForecastEngine

    days = min(days, 14)

    with console.status("[bold blue]Generating forecast...", spinner="dots"):
        engine = ForecastEngine(horizon=days)
        try:
            result = engine.forecast(site_no)
        except Exception as e:
            console.print(f"[bold red]Error:[/] {e}")
            sys.exit(1)

    if as_json:
        import json

        data = {
            "site": {"site_no": result.site.site_no, "site_name": result.site.site_name},
            "generated_at": result.generated_at.isoformat(),
            "current_discharge_cfs": result.current_discharge_cfs,
            "current_swe_in": result.current_swe_in,
            "forecast": [
                {
                    "date": d.strftime("%Y-%m-%d"),
                    "discharge_cfs": q,
                    "low_cfs": lo,
                    "high_cfs": hi,
                    "baseflow_cfs": bf,
                    "snowmelt_cfs": sm,
                    "rainfall_cfs": rr,
                }
                for d, q, lo, hi, bf, sm, rr in zip(
                    result.dates,
                    result.discharge_cfs,
                    result.discharge_low_cfs,
                    result.discharge_high_cfs,
                    result.baseflow_cfs,
                    result.snowmelt_runoff_cfs,
                    result.rainfall_runoff_cfs,
                )
            ],
            "warnings": result.warnings,
        }
        console.print_json(json.dumps(data))
        return

    if as_csv:
        df = result.to_dataframe()
        click.echo(df.to_csv())
        return

    # Rich table output
    _print_forecast(result)


def _print_forecast(result) -> None:
    """Pretty-print a forecast result using Rich tables."""
    site = result.site

    # Header
    header = Text()
    header.append(f"  {site.site_name}\n", style="bold white")
    header.append(f"  USGS {site.site_no}", style="dim")
    header.append(f"  |  ({site.latitude:.4f}, {site.longitude:.4f})", style="dim")
    if site.drainage_area_sq_mi:
        header.append(f"  |  {site.drainage_area_sq_mi:.0f} sq mi", style="dim")
    console.print(Panel(header, title="[bold blue]River Forecast[/]", border_style="blue"))

    # Current conditions
    if result.current_discharge_cfs is not None:
        console.print(
            f"  Current discharge: [bold yellow]{result.current_discharge_cfs:,.1f} cfs[/]"
        )
    if result.current_swe_in is not None and result.current_swe_in > 0:
        console.print(f"  Current snowpack:  [bold cyan]{result.current_swe_in:.1f}\" SWE[/]")
    console.print()

    # Forecast table
    table = Table(
        title=f"14-Day Forecast (generated {result.generated_at.strftime('%Y-%m-%d %H:%M UTC')})",
        show_lines=False,
        padding=(0, 1),
    )
    table.add_column("Date", style="bold")
    table.add_column("Discharge\n(cfs)", justify="right", style="bold yellow")
    table.add_column("Low\n(cfs)", justify="right", style="dim")
    table.add_column("High\n(cfs)", justify="right", style="dim")
    table.add_column("Baseflow\n(cfs)", justify="right", style="blue")
    table.add_column("Snowmelt\n(cfs)", justify="right", style="cyan")
    table.add_column("Rain\n(cfs)", justify="right", style="green")

    for i, d in enumerate(result.dates):
        # Sparkline indicator
        q = result.discharge_cfs[i]
        table.add_row(
            d.strftime("%a %m/%d"),
            f"{q:,.1f}",
            f"{result.discharge_low_cfs[i]:,.1f}",
            f"{result.discharge_high_cfs[i]:,.1f}",
            f"{result.baseflow_cfs[i]:,.1f}",
            f"{result.snowmelt_runoff_cfs[i]:,.1f}",
            f"{result.rainfall_runoff_cfs[i]:,.1f}",
        )

    console.print(table)

    # Warnings
    if result.warnings:
        console.print()
        for w in result.warnings:
            console.print(f"  [yellow]Warning:[/] {w}")

    # Trend summary
    if len(result.discharge_cfs) >= 2:
        trend = result.discharge_cfs[-1] - result.discharge_cfs[0]
        direction = "rising" if trend > 0 else "falling" if trend < 0 else "steady"
        console.print(f"\n  Trend: [bold]{direction}[/] ({trend:+,.1f} cfs over {len(result.dates)} days)")
    console.print()


@main.command()
@click.option("--state", help="Two-letter state code (MT, ID, WY, CO, UT, NV, NM, AZ).")
@click.option("--limit", default=20, show_default=True, help="Max sites to return.")
def search(state: str | None, limit: int) -> None:
    """Search for USGS streamflow monitoring sites."""
    from riverforecast.data.usgs import USGSClient

    if not state:
        console.print("[red]Provide --state (e.g. --state CO)[/]")
        sys.exit(1)

    with console.status(f"[bold blue]Searching sites in {state.upper()}...", spinner="dots"):
        client = USGSClient()
        try:
            sites = client.search_sites(state=state.upper(), limit=limit)
        except Exception as e:
            console.print(f"[bold red]Error:[/] {e}")
            sys.exit(1)

    table = Table(title=f"USGS Streamflow Sites — {state.upper()}")
    table.add_column("Site No", style="bold")
    table.add_column("Name")
    table.add_column("Lat", justify="right")
    table.add_column("Lon", justify="right")
    table.add_column("Drain Area\n(sq mi)", justify="right")

    for s in sites:
        da = f"{s.drainage_area_sq_mi:,.0f}" if s.drainage_area_sq_mi else "—"
        table.add_row(s.site_no, s.site_name, f"{s.latitude:.4f}", f"{s.longitude:.4f}", da)

    console.print(table)
    console.print(f"\n  {len(sites)} sites found. Use [bold]riverforecast forecast <site_no>[/] to generate a forecast.")


@main.command()
@click.argument("site_no")
def info(site_no: str) -> None:
    """Show detailed information for a USGS site."""
    from riverforecast.data.usgs import USGSClient

    with console.status("[bold blue]Fetching site info...", spinner="dots"):
        client = USGSClient()
        try:
            site = client.get_site_info(site_no)
        except Exception as e:
            console.print(f"[bold red]Error:[/] {e}")
            sys.exit(1)

    console.print(Panel(
        f"[bold]{site.site_name}[/]\n"
        f"Site No:        {site.site_no}\n"
        f"State:          {site.state_cd}\n"
        f"Location:       ({site.latitude:.4f}, {site.longitude:.4f})\n"
        f"HUC:            {site.huc_cd or '—'}\n"
        f"Drainage Area:  {site.drainage_area_sq_mi or '—'} sq mi",
        title="[bold blue]Site Information[/]",
        border_style="blue",
    ))

    # Show nearby SNOTEL stations
    from riverforecast.data.snotel import SnotelClient
    snotel = SnotelClient()
    stations = snotel.find_nearest_stations(site.latitude, site.longitude, limit=3)
    if stations:
        console.print("\n[bold]Nearby SNOTEL Stations:[/]")
        for s in stations:
            console.print(f"  {s.name} ({s.triplet}) — {s.distance_mi:.1f} mi, {s.elevation_ft:,} ft")


@main.command()
def clear_cache() -> None:
    """Clear the local API response cache."""
    from riverforecast.utils.cache import clear
    clear()
    console.print("[green]Cache cleared.[/]")


if __name__ == "__main__":
    main()
