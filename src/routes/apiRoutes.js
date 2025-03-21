const express = require("express");
const { getAttendanceByDevice, getAttendanceById, getAllAttendance } = require("../database/dbService");

const router = express.Router();

router.get("/attendance", async (_, res) => {
  try {
    let records = await getAllAttendance();
    res.json(records);
  } catch (error) {
    res.status(500).json({ message: "Error retrieving data" });
  }
});

router.get("/attendance/:id", async (req, res) => {
  try {
    let record = await getAttendanceById(req.params.id);
    if (!record) return res.status(404).json({ message: "Record not found" });
    res.json(record);
  } catch (error) {
    res.status(500).json({ message: "Error retrieving data" });
  }
});

router.get("/attendance/device/:deviceSN", async (req, res) => {
    try {
        let records = await getAttendanceByDevice(req.params.deviceSN);
        res.json(records);
    } catch (error) {
        res.status(500).json({ message: "Error retrieving data" });
    }
});

module.exports = router;
