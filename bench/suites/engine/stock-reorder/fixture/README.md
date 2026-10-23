# inventory

Stock levels for the warehouse.

- `inventory/models.py`: the Product record and how it is read from and written to saved data.
- `inventory/repo.py`: products saved as JSON (`data/products.json` is today's data).
- `inventory/reports.py`: the low-stock list and the CSV export.
- `scripts/supplier_feed.py`: turns the CSV export into the supplier's feed. The supplier's system reads columns by position, so existing columns must keep their place.
