-- The pantry: one amount per food and kind of unit (mass in g, volume in ml, a count, or another unit), in the kind's base unit.
CREATE TABLE pantry (
  food TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount REAL NOT NULL,
  PRIMARY KEY (food, kind)
);
