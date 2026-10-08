# Bug: work-order access depends on what the user opened before

**Reported by:** facilities IT and information security (ticket MNT-142)

1. Dana Ruiz (technician, Riverside Campus) followed a link to a Northgate Depot work order and got "not found", which is correct. For the next few minutes she also got "not found" on her own Riverside work orders. Later it worked again by itself.
2. In an access review, security found log entries showing that Lee Chen (contractor, Riverside Campus only) opened Northgate work order 2 and the cost breakdown of work order 1. Contractors must see neither.
3. Grace Obi (supervisor, Northgate Depot) says the cost breakdowns of her own work orders are sometimes refused.

Nobody can reproduce it on demand. It seems to depend on which requests came before.

**Acceptance**
- Every request gets the access decision that is right for its user, the work order's site and the data requested, whatever was requested before.
- Access checks stay as fast as they are now. The directory is slow and must not be asked again for decisions that are already cached.
- Existing behaviour stays as it is (`npm test` passes).
