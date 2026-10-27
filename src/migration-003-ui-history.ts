import { DatabaseSync } from 'node:sqlite';

// Plain CREATE (not IF NOT EXISTS): the user_version gate makes reruns no-ops, and an
// unexpected same-named object must abort the whole migration rather than be adopted.
export function migrateUiHistory(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE ui_states (
        id TEXT PRIMARY KEY,
        origin TEXT NOT NULL CHECK (origin IN ('learned', 'configured')),
        route TEXT NOT NULL,
        path_json TEXT NOT NULL,
        component_set TEXT NOT NULL,
        modules_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL CHECK (status IN ('active', 'path_broken')),
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        UNIQUE (route, component_set)
      );
      CREATE INDEX ui_states_last_seen ON ui_states(last_seen_at, id);
      CREATE TABLE screen_frames (
        checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id),
        state_id TEXT NOT NULL REFERENCES ui_states(id),
        profile_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('captured', 'unchanged', 'path_broken', 'skipped', 'failed')),
        image_digest TEXT,
        unchanged_from TEXT REFERENCES checkpoints(id),
        capture_mode TEXT NOT NULL CHECK (capture_mode IN ('live', 'replayed')),
        reason TEXT,
        captured_at TEXT NOT NULL,
        PRIMARY KEY (checkpoint_id, state_id, profile_id),
        CHECK ((status IN ('captured', 'unchanged')) = (image_digest IS NOT NULL)),
        CHECK ((status = 'unchanged') = (unchanged_from IS NOT NULL))
      );
      CREATE INDEX screen_frames_history ON screen_frames(state_id, profile_id, checkpoint_id);
      CREATE TABLE component_versions (
        checkpoint_id TEXT NOT NULL,
        state_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        component_key TEXT NOT NULL,
        occurrence INTEGER NOT NULL CHECK (occurrence >= 0),
        crop_digest TEXT NOT NULL,
        unchanged_from TEXT REFERENCES checkpoints(id),
        box_json TEXT NOT NULL,
        PRIMARY KEY (checkpoint_id, state_id, profile_id, component_key, occurrence),
        FOREIGN KEY (checkpoint_id, state_id, profile_id) REFERENCES screen_frames(checkpoint_id, state_id, profile_id)
      );
      CREATE INDEX component_versions_history ON component_versions(component_key, profile_id, checkpoint_id);
    `);
    db.exec('PRAGMA user_version = 3; COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
