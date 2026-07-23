-- Daily heartbeat cards: one row per location per local day, claimed before
-- posting so restarts/parallel cycles can't double-post.
CREATE TABLE voip_heartbeats (
  location_id int NOT NULL REFERENCES voip_locations(id),
  day date NOT NULL,
  posted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, day)
);
