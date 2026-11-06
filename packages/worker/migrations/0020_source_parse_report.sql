-- S4: last parse diagnostics for a source. JSON: detected kind, entry count,
-- bytes, warnings, mirror index and the drop percent versus the previous run.
ALTER TABLE sources ADD COLUMN parse_report TEXT;
