-- Run after 01. You want rows > 0, with_sales > 0, and some out_of_stock rows.
SELECT
  COUNT(*) AS sku_dc_rows,
  COUNTIF(sold_30 > 0) AS with_sales,
  COUNTIF(on_hand = 0 AND sold_30 > 0) AS out_of_stock,
  COUNTIF(sold_30 = 0 AND on_hand > 0) AS idle,
  SUM(on_hand) AS units_on_hand,
  SUM(sold_30) AS units_sold_30,
  SUM(received_30) AS units_received_30,
  MIN(as_of) AS as_of
FROM `beaming-might-319312.stock_clock.sku_dc`;
