# maintenance-service

Maintenance work orders for Acme's buildings. It uses the shared toolkit in `vendor/acme-kit` (read its README for the conventions every Acme service follows).

```sh
npm test      # node --test
npm start     # http://127.0.0.1:3000
```

## Authentication and access
The API gateway authenticates users and passes the username in the `X-Acme-User` header (missing header: `401 unauthorized`). Roles and site assignments come from the corporate HR directory.

- Technicians, contractors and supervisors can see the work orders of the sites they are assigned to. Work orders at other sites answer `404`, as if they did not exist.
- Only supervisors assigned to the work order's site can see its cost breakdown. Everyone else gets `403 forbidden`.

Directory lookups are slow (about 300 ms per call in production), so access decisions are cached for five minutes (`src/access`).

## Endpoints
- `GET /api/me`: the current user, their role and sites
- `GET /api/work-orders/:id`: one work order
- `GET /api/work-orders/:id/costs`: cost lines and total of a work order

## Data
Data comes from `fixtures/db.json` through `acme-kit/db`, which has the same value semantics as production. `users` and `site_assignments` stand in for the HR directory.
