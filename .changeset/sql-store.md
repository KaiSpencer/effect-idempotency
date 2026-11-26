---
"effect-idempotency": patch
---

Add `IdempotencyStore.layerSql`, a store in PostgreSQL or SQLite through the `SqlClient` the application already provides. Servers that share the database share the keys, and a stored response survives a restart.

The layer creates its table, `effect_idempotency` unless `layerSql({ table })` names another, and an index. A key is claimed with one statement, so no transaction is needed and two servers cannot both get a key. For as long as the layer is built it deletes, every five minutes, the responses past their retention and the claims a dead process left more than 24 hours ago.
