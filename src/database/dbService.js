const db = require("./db");

// Insert attendance record
const insertAttendance = (pin, activityTime, stateId, deviceSN) => {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO attendance (pin, activityTime, stateId, deviceSN) VALUES (?, ?, ?, ?)`,
      [pin, activityTime, stateId, deviceSN],
      function (err) {
        if (err) {
          console.error("Error inserting attendance record:", err.message);
          reject(err);
        } else {
          resolve({ id: this.lastID, pin, activityTime, stateId, deviceSN });
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

module.exports = {
  insertAttendance,
  getAllAttendance,
  getAttendanceById,
  getAttendanceByDevice,
};
