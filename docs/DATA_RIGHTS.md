# Market-data publication policy

The public app publishes StockScout's derived EOD scan output. It does not
publish raw provider caches or downloadable OHLCV archives.

Until a provider contract explicitly permits public display/redistribution:

- anonymous users receive an external-chart link;
- owner authentication unlocks private, lazy-loaded StockScout chart shards;
- historical public scan records contain derived candidate/setup fields only;
- chart data never enters Git, GitHub Pages, public Supabase tables, logs, or
  workflow artifacts.

Provider provenance is recorded for each scan and must be reviewed when a data
source or subscription changes.

