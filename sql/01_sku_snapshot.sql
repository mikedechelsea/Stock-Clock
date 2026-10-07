-- Stock Clock · thelook_ecommerce snapshot (v2)
-- Project: beaming-might-319312 · creates ONE table: stock_clock.sku_dc
-- Changes from v1:
--   * SKUs that are already OUT of stock are included (v1 dropped them).
--   * Items received after the as-of date are ignored (no "future" stock).
--   * 8 weeks of sales AND receipts per SKU (receipts = inventory_items.created_at).
--   * Keeps the 540 busiest SKUs plus the 60 largest idle racks, so KV stays small.
-- In thelook every SKU ships from one distribution center, so a row = SKU × DC.

CREATE SCHEMA IF NOT EXISTS `beaming-might-319312.stock_clock`
OPTIONS(location="US");

CREATE OR REPLACE TABLE `beaming-might-319312.stock_clock.sku_dc` AS
WITH bounds AS (
  SELECT LEAST(DATE(MAX(sold_at)), CURRENT_DATE()) AS as_of
  FROM `bigquery-public-data.thelook_ecommerce.inventory_items`
  WHERE sold_at IS NOT NULL
),
items AS (
  SELECT
    ii.*,
    b.as_of,
    DATE(ii.created_at) AS rcv_day,
    IF(ii.sold_at IS NOT NULL AND DATE(ii.sold_at) <= b.as_of, DATE(ii.sold_at), NULL) AS sold_day
  FROM `bigquery-public-data.thelook_ecommerce.inventory_items` ii
  CROSS JOIN bounds b
  WHERE ii.product_sku IS NOT NULL
    AND DATE(ii.created_at) <= b.as_of
),
agg AS (
  SELECT
    product_sku AS sku,
    product_distribution_center_id AS dc_id,
    ANY_VALUE(as_of) AS as_of,
    ANY_VALUE(product_name) AS name,
    ANY_VALUE(product_brand) AS brand,
    ANY_VALUE(product_category) AS category,
    ANY_VALUE(product_department) AS department,
    ANY_VALUE(product_retail_price) AS price,
    AVG(cost) AS cost,
    COUNTIF(sold_day IS NULL) AS on_hand,
    COUNTIF(sold_day BETWEEN DATE_SUB(as_of, INTERVAL 29 DAY) AND as_of) AS sold_30,
    COUNTIF(sold_day BETWEEN DATE_SUB(as_of, INTERVAL 6 DAY) AND as_of) AS sold_7,
    COUNTIF(sold_day BETWEEN DATE_SUB(as_of, INTERVAL 13 DAY) AND DATE_SUB(as_of, INTERVAL 7 DAY)) AS sold_prev_7,
    COUNTIF(rcv_day BETWEEN DATE_SUB(as_of, INTERVAL 29 DAY) AND as_of) AS received_30,
    MAX(rcv_day) AS last_received,
    -- weekly sales, w7 = 7 weeks ago ... w0 = latest week
    COUNTIF(DIV(DATE_DIFF(as_of, sold_day, DAY), 7) = 7) AS s7,
    COUNTIF(DIV(DATE_DIFF(as_of, sold_day, DAY), 7) = 6) AS s6,
    COUNTIF(DIV(DATE_DIFF(as_of, sold_day, DAY), 7) = 5) AS s5,
    COUNTIF(DIV(DATE_DIFF(as_of, sold_day, DAY), 7) = 4) AS s4,
    COUNTIF(DIV(DATE_DIFF(as_of, sold_day, DAY), 7) = 3) AS s3,
    COUNTIF(DIV(DATE_DIFF(as_of, sold_day, DAY), 7) = 2) AS s2,
    COUNTIF(DIV(DATE_DIFF(as_of, sold_day, DAY), 7) = 1) AS s1,
    COUNTIF(DIV(DATE_DIFF(as_of, sold_day, DAY), 7) = 0) AS s0,
    -- weekly receipts
    COUNTIF(DIV(DATE_DIFF(as_of, rcv_day, DAY), 7) = 7) AS r7,
    COUNTIF(DIV(DATE_DIFF(as_of, rcv_day, DAY), 7) = 6) AS r6,
    COUNTIF(DIV(DATE_DIFF(as_of, rcv_day, DAY), 7) = 5) AS r5,
    COUNTIF(DIV(DATE_DIFF(as_of, rcv_day, DAY), 7) = 4) AS r4,
    COUNTIF(DIV(DATE_DIFF(as_of, rcv_day, DAY), 7) = 3) AS r3,
    COUNTIF(DIV(DATE_DIFF(as_of, rcv_day, DAY), 7) = 2) AS r2,
    COUNTIF(DIV(DATE_DIFF(as_of, rcv_day, DAY), 7) = 1) AS r1,
    COUNTIF(DIV(DATE_DIFF(as_of, rcv_day, DAY), 7) = 0) AS r0
  FROM items
  GROUP BY 1, 2
),
ranked AS (
  SELECT
    a.*,
    ROW_NUMBER() OVER (ORDER BY a.sold_30 DESC, a.sold_7 DESC, a.on_hand ASC) AS busy_rank,
    ROW_NUMBER() OVER (PARTITION BY a.sold_30 = 0 ORDER BY a.on_hand DESC) AS idle_rank
  FROM agg a
  WHERE a.on_hand > 0 OR (a.s0 + a.s1 + a.s2 + a.s3 + a.s4 + a.s5 + a.s6 + a.s7) > 0
)
SELECT
  r.as_of,
  r.sku,
  r.dc_id,
  IFNULL(dc.name, CONCAT("DC ", CAST(r.dc_id AS STRING))) AS dc_name,
  r.name,
  r.brand,
  r.category,
  r.department,
  ROUND(r.price, 2) AS price,
  ROUND(r.cost, 2) AS cost,
  r.on_hand,
  r.sold_30,
  r.sold_7,
  r.sold_prev_7,
  r.received_30,
  r.last_received,
  [r.s7, r.s6, r.s5, r.s4, r.s3, r.s2, r.s1, r.s0] AS weekly,
  [r.r7, r.r6, r.r5, r.r4, r.r3, r.r2, r.r1, r.r0] AS received_weekly
FROM ranked r
LEFT JOIN `bigquery-public-data.thelook_ecommerce.distribution_centers` dc
  ON dc.id = r.dc_id
WHERE r.busy_rank <= 540
   OR (r.sold_30 = 0 AND r.idle_rank <= 60);
