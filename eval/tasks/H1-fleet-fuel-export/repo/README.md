# fleet-service

Vehicles and fuel card purchases for the Acme delivery fleet. It uses the shared toolkit in `vendor/acme-kit` (read its README for the conventions every Acme service follows).

```sh
npm test      # node --test
npm start     # http://127.0.0.1:3000
```

## Endpoints
- `GET /api/fuel-purchases/:id`: one fuel card purchase with vehicle plate, driver, station, litres, `net` amount and VAT rate
- `GET /api/vehicles/:id/fuel-spend?month=YYYY-MM`: number of purchases and net spend of a vehicle in a calendar month

## Data
Data comes from `fixtures/db.json` through `acme-kit/db`, which has the same value semantics as production. Fuel card statements are imported nightly into `fuel_purchases`; `net` is the amount before VAT and `vat_bp` the VAT rate in basis points (1900 = 19%) of the country where the card was used. Months are calendar months in UTC.
