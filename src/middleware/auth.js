const { ALLOWED_AGENTS, ALLOWED_SERIALS, SN_PATTERN } = require("../constants");
const { upsertDeviceSeen, recordUnadmittedDevice, isDeviceApproved } = require("../database/deviceService");

// Endpoints and tables only Security PUSH (access-control) devices use. The handshake that
// carries DeviceType=acc only happens at boot, so this fills the type in for devices that
// were already running when the service started.
const ACC_PATHS = ["/iclock/registry", "/iclock/push", "/iclock/ping", "/iclock/rtdata", "/iclock/querydata"];
const ACC_TABLES = ["rtlog", "rtstate"];
const inferDeviceType = (req) => {
  if (req.query.DeviceType) return req.query.DeviceType;
  const table = String(req.query.table || "").toLowerCase();
  if (ACC_PATHS.includes(req.path) || ACC_TABLES.includes(table)) return "acc";
  return undefined;
};

const isAdmitted = async (serial, agent) => {
  if (serial && ALLOWED_SERIALS.includes(serial)) return true;
  if (ALLOWED_AGENTS.some((allowed) => agent.includes(allowed))) return true;
  try {
    return !!serial && (await isDeviceApproved(serial));
  } catch (error) {
    console.error("Error checking device approval:", error.message);
    return false;
  }
};

// A device is accepted when its serial number is allowlisted (ALLOWED_SERIALS), it was
// approved in the admin UI, or its User-Agent matches one of ALLOWED_AGENTS. Some devices
// (e.g. SenseFace 2A) don't send the same User-Agent as older iClock firmware, so the SN
// checks are the more reliable gate. Requests with a valid SN are recorded, so rejected
// devices show up as pending in the admin UI; only admitted ones update the stored details.
const authenticate = async function (req, res, next) {
  const agent = req.header("User-Agent") || "";
  const serial = req.query.SN || "";
  const admitted = await isAdmitted(serial, agent);

  if (typeof serial === "string" && SN_PATTERN.test(serial)) {
    const seen = {
      sn: serial,
      ip: (req.ip || "").replace(/^::ffff:/, ""),
      userAgent: agent,
      deviceType: inferDeviceType(req),
      pushVersion: req.query.pushver,
    };
    (admitted ? upsertDeviceSeen({ ...seen, keepType: true }) : recordUnadmittedDevice(seen)).catch((error) =>
      console.error("Error recording device:", error.message)
    );
  }

  if (admitted) return next();
  console.warn("Rejected device request:", { path: req.path, SN: serial, userAgent: agent });
  return res.status(200).json({ message: "Authentication failed." });
};

module.exports = {
  authenticate,
};
