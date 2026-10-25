-- Expiry dates: amounts of one food and kind with different dates are separate lots.
CREATE TABLE pantry_lots (
  food TEXT NOT NULL,
  kind TEXT NOT NULL,
  expires_on TEXT,
  amount REAL NOT NULL
);
INSERT INTO pantry_lots (food, kind, expires_on, amount) SELECT food, kind, NULL, amount FROM pantry;
DROP TABLE pantry;
