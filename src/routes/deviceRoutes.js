const express = require("express");
const moment = require("moment-timezone");
const getRawBody = require("raw-body");
const NodeCache = require("node-cache");
const { insertAttendance } = require("../database/dbService");
const { postAttendance } = require("../services/apiService");
const { getConfig } = require("../helpers");
const { TIMEZONE } = require("../constants");

const router = express.Router();
const configCache = new NodeCache({ stdTTL: 600 });
const offsetMinutes = moment.tz(TIMEZONE).utcOffset();
const offsetHours = offsetMinutes / 60;

router.use((req, _, next) => {
  getRawBody(
    req,
    { length: req.headers["content-length"], limit: "1mb", encoding: "utf8" },
    (err, string) => {
      if (err) return next(err);
      req.text = string;
      next();
    }
  );
});

router.get("/iclock/cdata", async (req, res) => {
  if (!req.query.SN) {
    return res.status(400).json({ message: "Missing required parameter: SN" });
  }
  res.set("Content-Type", "text/plain").set("Date", new Date().toUTCString());
  let SN = req.query.SN;
  let cachedConfig = configCache.get(SN);
  if (cachedConfig) return res.send(cachedConfig);

  let configuration = getConfig(req, offsetHours);
  configCache.set(SN, configuration);
  res.send(configuration);
});

router.get("/iclock/getrequest", async (_, res) => {
  res.set("Content-Type", "text/plain").set("Date", new Date().toUTCString());
  let startTime = moment().subtract(5, "minutes").format("YYYY-MM-DD HH:mm:ss");
  res.send(`C:${Math.floor(Math.random() * 1000)}:DATA QUERY ATTLOG StartTime=${startTime}`);
});

router.post("/iclock/cdata", async (req, res) => {
  res.set("Content-Type", "text/plain").set("Date", new Date().toUTCString());
  let attendanceLines = req.text.split("\n");

  let insertPromises = attendanceLines
    .map((line) => {
      if (line.length) {
        let [userId, activityTime, stateId] = line.split("\t");
        if (userId.includes("LOG") || stateId == 255) return null;
        return { pin: userId, activityTime, stateId, deviceSN: req.query.SN };
      }
      return null;
    })
    .filter(Boolean)
    .map((record) => Promise.all([insertAttendance(record), postAttendance(record)]));

  try {
    await Promise.all(insertPromises);
    res.send("OK:" + (attendanceLines.length - 1));
  } catch (error) {
    console.error("Error inserting attendance:", error.message);
    res.send("FAIL");
  }
});

router.post("/iclock/devicecmd", (_, res) => {
  res.send(moment().minute() % 10 === 0 ? "OK" : "");
});

module.exports = router;
