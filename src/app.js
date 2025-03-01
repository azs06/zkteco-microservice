const express = require("express");
const getRawBody = require("raw-body");
const moment = require("moment-timezone");
const NodeCache = require("node-cache");
const configCache = new NodeCache({ stdTTL: 600 }); // Cache for 10 minutes
const { TIMEZONE, PORT } = require("./constants");
const { authenticate } = require("./middleware/auth");
const {
  insertAttendance,
  getAttendanceByDevice,
  getAttendanceById,
} = require("./database/dbService");

moment().tz(TIMEZONE).format();
const offsetMinutes = moment.tz(TIMEZONE).utcOffset();
const offsetHours = offsetMinutes / 60;
// To get the sign and value.
// const signedOffset = moment.tz(TIMEZONE).format("Z");

const { getConfig } = require("./helpers");

const app = express();

// authenticate against supported devices
//app.use(authenticate);

app.use(function (req, _, next) {
  getRawBody(
    req,
    {
      length: req.headers["content-length"],
      limit: "1mb",
      encoding: "utf8",
    },
    function (err, string) {
      if (err) return next(err);
      req.text = string;
      next();
    }
  );
});

app.get("/", async (_, res) => {
  return res.status(200).json({ message: "MS of ADMS API" });
});

app.use(function (error, req, res, next) {
  //Catch json error
  return res.status(200).json({ message: "Problem Loading api" });
});

app.get("/iclock/cdata", async (req, res) => {
  if (!req.query.SN) {
    return res.status(400).json({ message: "Missing required parameter: SN" });
  }
  try {
    res.set("Content-Type", "text/plain");
    res.set("Date", new Date().toUTCString());
    let SN = req.query.SN;
    let cachedConfig = configCache.get(SN);
    if (cachedConfig) {
      return res.send(cachedConfig);
    }
    let configuration = getConfig(req, offsetHours);
    configCache.set(SN, configuration);
    res.send(configuration);
  } catch (error) {
    res.status(500).json({ message: "Internal Server Error" });
  }
});

app.get("/iclock/getrequest", async (req, res) => {
  res.set("Content-Type", "text/plain");
  res.set("Date", new Date().toUTCString());

  let startTime = moment().subtract(5, "minutes").format("YYYY-MM-DD hh:mm:ss");
  res.send(
    `C:${Math.floor(
      Math.random() * 1000
    )}:DATA QUERY ATTLOG StartTime=${startTime}`
  );
});

app.post("/iclock/cdata", async (req, res) => {
  res.set("Content-Type", "text/plain");
  res.set("Date", new Date().toUTCString());
  let attendances = req.text;
  let attendanceLines = attendances.split("\n");

  let insertPromises = attendanceLines.map((line) => {
    if (line.length) {
      let attendance = line.split("\t");
      let userId = attendance[0];
      let activityTime = attendance[1];
      let stateId = attendance[2];
      const attendanceRecord = {
        pin: userId,
        activityTime: activityTime,
        stateId: stateId,
        deviceSN: req.query.SN,
      };
      console.log("Attendance record:", attendanceRecord);
      return insertAttendance(attendanceRecord);
    }
  });
  try {
    await Promise.all(insertPromises);
    res.send("OK:" + (attendanceLines.length - 1));
  } catch (error) {
    console.error("Error inserting attendance record:", error.message);
    res.send("FAIL");
  }
});

app.post("/iclock/devicecmd", async (req, res) => {
  let shouldBeOkay = moment().minute() % 10 == 0;
  if (shouldBeOkay) {
    res.send("OK");
  }
});

// Retrieve all attendance records
app.get("/attendance", async (req, res) => {
  try {
    let records = await getAllAttendance();
    res.json(records);
  } catch (error) {
    res.status(500).json({ message: "Error retrieving data" });
  }
});

app.listen(PORT, () =>
  console.log(`Zktecko service listening on port ${PORT}!`)
);
