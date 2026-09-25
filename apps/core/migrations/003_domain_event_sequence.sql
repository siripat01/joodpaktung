ALTER TABLE domain_events ADD COLUMN sequence bigint;
CREATE SEQUENCE domain_events_sequence_seq OWNED BY domain_events.sequence;
UPDATE domain_events SET sequence = nextval('domain_events_sequence_seq');
ALTER TABLE domain_events ALTER COLUMN sequence SET DEFAULT nextval('domain_events_sequence_seq');
ALTER TABLE domain_events ALTER COLUMN sequence SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS domain_events_sequence_idx ON domain_events(sequence);
