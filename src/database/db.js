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
});

module.exports = db;
