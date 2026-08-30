ALTER TABLE users ADD COLUMN recommend_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN recommend_count_month TEXT;
