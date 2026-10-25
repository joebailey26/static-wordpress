-- Sections come from the site's cms.config.json and are validated by the Worker, so the table no longer lists them.
-- SQLite cannot drop a CHECK constraint; rebuild the table and keep its rows.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE content_records_next (
  revision TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  section TEXT NOT NULL,
  slug TEXT NOT NULL,
  date TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (revision, section, slug)
);
INSERT INTO content_records_next (revision, section, slug, date, payload) SELECT revision, section, slug, date, payload FROM content_records;
DROP TABLE content_records;
ALTER TABLE content_records_next RENAME TO content_records;
CREATE INDEX content_order ON content_records(revision, section, date DESC, slug);
