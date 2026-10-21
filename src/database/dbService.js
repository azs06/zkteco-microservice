const db = require("./db");

// Insert attendance record, skipping punches already stored (devices re-send logs
// on retries and reconnects). Resolves with `inserted: false` for duplicates.
const insertAttendance = ({pin, activityTime, stateId, deviceSN}) => {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO attendance (pin, activityTime, stateId, deviceSN)
       SELECT ?, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM attendance WHERE deviceSN = ? AND pin = ? AND activityTime = ?
       )`,
      [pin, activityTime, stateId, deviceSN, deviceSN, pin, activityTime],
      function (err) {
        if (err) {
          console.error("Error inserting attendance record:", err.message);
          reject(err);
        } else {
          resolve({ id: this.lastID, pin, activityTime, stateId, deviceSN, inserted: this.changes > 0 });
        }
      }
    );
  });
};

// Retrieve all attendance records
const getAllAttendance = () => {
  return new Promise((resolve, reject) => {
    db.all("SELECT * FROM attendance ORDER BY id DESC", [], (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
};

// Retrieve attendance records by deviceSN
const getAttendanceByDevice = (deviceSN) => {
  return new Promise((resolve, reject) => {
    db.all("SELECT * FROM attendance WHERE deviceSN = ? ORDER BY id DESC", [deviceSN], (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
};

// Retrieve attendance record by ID
const getAttendanceById = (id) => {
  return new Promise((resolve, reject) => {
    db.get("SELECT * FROM attendance WHERE id = ?", [id], (err, row) => {
      if (err) {
        reject(err);
      } else {
        resolve(row);
      }
    });
  });
};

const isDateOnly = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || "");

// Filtered, paginated attendance (newest first). from/to are "YYYY-MM-DD" or
// "YYYY-MM-DD HH:mm:ss"; a date-only `to` includes that whole day. limit <= 0 means no limit.
const queryAttendance = ({ sn, pin, from, to, limit = 100, offset = 0 } = {}) => {
  const where = [];
  const params = [];
  if (sn) { where.push("deviceSN = ?"); params.push(sn); }
  if (pin) { where.push("pin = ?"); params.push(String(pin)); }
  if (from) { where.push("activityTime >= ?"); params.push(from); }
  if (to) { where.push("activityTime <= ?"); params.push(isDateOnly(to) ? `${to} 23:59:59` : to); }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const max = parseInt(limit, 10) > 0 ? parseInt(limit, 10) : -1;
  const skip = parseInt(offset, 10) > 0 ? parseInt(offset, 10) : 0;

  return new Promise((resolve, reject) => {
    db.get(`SELECT COUNT(*) AS total FROM attendance ${clause}`, params, (err, count) => {
      if (err) return reject(err);
      db.all(
        `SELECT * FROM attendance ${clause} ORDER BY activityTime DESC, id DESC LIMIT ? OFFSET ?`,
        [...params, max, skip],
        (err, rows) => (err ? reject(err) : resolve({ rows, total: count.total }))
      );
    });
  });
};

module.exports = {
  insertAttendance,
  queryAttendance,
  getAllAttendance,
  getAttendanceById,
  getAttendanceByDevice,
};
