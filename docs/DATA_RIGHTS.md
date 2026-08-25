# Market-data publication policy

The public app publishes StockScout's derived EOD scan output. It does not
publish raw provider caches or downloadable OHLCV archives.

The single-user app publishes a bounded display projection:

- charts are lazy-loaded without login from immutable current-run gzip shards;
- only five years of daily OHLCV and weekly bars derived from that same window
  are included;
- historical public scan records contain derived candidate/setup fields only;
- provider caches, deep-history archives and chart shards never enter Git,
  GitHub Pages, database tables, logs, or workflow artifacts.

Provider provenance is recorded for each scan and must be reviewed when a data
source or subscription changes.
