const sqlite3 = require("sqlite3").verbose();

const db = new sqlite3.Database("./attendance.db", (err) => {
  if (err) {
    console.error("Database connection error:", err.message);
  } else {
    console.log("Connected to the SQLite database.");
  }
});

// Create table if it does not exist
db.serialize(() => {
  db.run(
    `CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pin TEXT,
      activityTime TEXT,
      stateId INTEGER,
      deviceSN TEXT
    )`
  );
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_attendance_punch ON attendance (deviceSN, pin, activityTime)`
  );
  db.run(
    `CREATE TABLE IF NOT EXISTS devices (
      sn TEXT PRIMARY KEY,
      name TEXT,
      deviceType TEXT,
      firmware TEXT,
      pushVersion TEXT,
      ip TEXT,
      userAgent TEXT,
      approved INTEGER NOT NULL DEFAULT 0,
      lastSeen TEXT,
      info TEXT,
      createdAt TEXT
    )`
  );
  db.run(
    `CREATE TABLE IF NOT EXISTS device_users (
      deviceSN TEXT,
      pin TEXT,
      name TEXT,
      cardNo TEXT,
      privilege INTEGER DEFAULT 0,
      password TEXT,
      updatedAt TEXT,
      PRIMARY KEY (deviceSN, pin)
    )`
  );
  db.run(
    `CREATE TABLE IF NOT EXISTS commands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deviceSN TEXT,
      kind TEXT,
      command TEXT,
      status TEXT,
      returnCode INTEGER,
      result TEXT,
      createdAt TEXT,
      sentAt TEXT,
      completedAt TEXT
    )`
  );
  db.run(`CREATE INDEX IF NOT EXISTS idx_commands_device ON commands (deviceSN, status, id)`);
});

module.exports = db;
