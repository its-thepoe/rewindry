import { DatabaseSync } from 'node:sqlite';

type IndexedFile = { path: string; digest: string; size: number };

export function migrateCheckpointFiles(db: DatabaseSync, filesForCheckpoint: (id: string) => IndexedFile[]): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoint_files (
        checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id),
        path TEXT NOT NULL,
        digest TEXT NOT NULL,
        size INTEGER NOT NULL,
        PRIMARY KEY (checkpoint_id, path)
      );
      CREATE INDEX IF NOT EXISTS checkpoint_files_path ON checkpoint_files(path, checkpoint_id);
    `);
    const checkpoints = db.prepare('SELECT id FROM checkpoints ORDER BY rowid').all() as { id: string }[];
    const insert = db.prepare('INSERT OR IGNORE INTO checkpoint_files (checkpoint_id, path, digest, size) VALUES (?, ?, ?, ?)');
    for (const checkpoint of checkpoints) {
      for (const file of filesForCheckpoint(checkpoint.id)) {
        insert.run(checkpoint.id, file.path, file.digest, file.size);
      }
    }
    db.exec('PRAGMA user_version = 2; COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
