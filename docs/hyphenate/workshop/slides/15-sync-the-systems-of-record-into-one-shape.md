# 15. Sync the systems of record into one shape

Source: [workshop PDF, page 15](../source/workshop-slides.pdf#page=15).

[Slide index](index.md) · [Previous](14-months-later-why-is-one-query.md) · [Next](16-map-who-may-do-what-to-which-record.md)

**Build 1: the environment**

```text
Sources  -->  Raw           -->  Standardised  -->  Golden
              Landed as-is      Typed, signed      Kept current
```

**One shape:** bank transaction; invoice and payment; customer; GL account; entity; vendor.

### Stateful, not a one-off export

Change-only sync with a cursor per source. Stable ids, so a re-sync never duplicates. Late bank posts re-read. Every golden row traces to its raw row.

### Schema shown on the slide

```sql
CREATE TABLE bank_transaction (
  id         TEXT PRIMARY KEY, -- md5(acct|src_id)
  source     TEXT,             -- 'jpm'
  txn_date   DATE,
  amount     NUMERIC(18,2),     -- 57975.00, in > 0
  memo       TEXT,             -- 'WIRE IN ACME…'
  raw_ref    TEXT              -- source row
);
CREATE TABLE invoice (
  id         TEXT PRIMARY KEY, -- 'INV-1042'
  customer   TEXT,             -- 'Acme Corp'
  amount     NUMERIC(18,2),     -- 58000.00
  status     TEXT,             -- 'Open'
  raw_ref    TEXT              -- source row
);
CREATE TABLE sync_cursor (source, cursor, at);
```

The `sync_cursor` declaration is abbreviated in the source slide; no missing column types have been invented here.

![Slide 15: Stateful record synchronization](images/slide-15.png)
