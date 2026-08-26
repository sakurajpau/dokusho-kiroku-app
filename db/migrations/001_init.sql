CREATE TABLE IF NOT EXISTS books (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT,
  date TEXT,
  memo TEXT,
  rating INTEGER,
  category TEXT
);
