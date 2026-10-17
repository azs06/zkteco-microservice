const fs = require("fs");
const path = require("path");
const https = require("https");
const express = require("express");
const { PORT, HTTPS_PORT, HTTPS_KEY, HTTPS_CERT } = require("./constants");
const deviceRoutes = require("./routes/deviceRoutes");
const apiRoutes = require("./routes/apiRoutes");
const adminRoutes = require("./routes/adminRoutes");
const { adminAuth } = require("./middleware/adminAuth");

const app = express();
app.disable("x-powered-by");

app.get("/", (_, res) => res.status(200).json({ message: "MS of ADMS API" }));

// Admin UI and API (Basic auth). Mounted before the device router, which handles everything else.
app.use("/admin", adminAuth, express.static(path.join(__dirname, "..", "public", "admin")));
app.use("/admin", (_, res) => res.status(404).json({ message: "Not found" }));
app.use("/api/admin", adminAuth, adminRoutes);

// API routes (with `/api` prefix)
app.use("/api", apiRoutes);

// Device routes (no prefix)
app.use("/", deviceRoutes);


app.use((error, _, res, __) => res.status(200).json({ message: "Problem Loading API" }));

// Express 4 doesn't catch rejected async handlers; log them instead of exiting, since one
// bad device request shouldn't take the service down for every device.
process.on("unhandledRejection", (error) => console.error("Unhandled rejection:", error));

app.listen(PORT, () => console.log(`ZKTeco service listening on port ${PORT}!`));

// Newer firmware (e.g. SenseFace 2A) only talks HTTPS to the ADMS server.
if (HTTPS_PORT) {
  const credentials = { key: fs.readFileSync(HTTPS_KEY), cert: fs.readFileSync(HTTPS_CERT) };
  https
    .createServer(credentials, app)
    .listen(HTTPS_PORT, () => console.log(`ZKTeco service listening on HTTPS port ${HTTPS_PORT}!`));
}
