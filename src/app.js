const express = require("express");
const { PORT } = require("./constants");
const deviceRoutes = require("./routes/deviceRoutes");
const apiRoutes = require("./routes/apiRoutes");

const app = express();

app.get("/", (_, res) => res.status(200).json({ message: "MS of ADMS API" }));

// Device routes (no prefix)
app.use("/", deviceRoutes);

// API routes (with `/api` prefix)
app.use("/api", apiRoutes);

app.use((error, _, res, __) => res.status(200).json({ message: "Problem Loading API" }));

app.listen(PORT, () => console.log(`ZKTeco service listening on port ${PORT}!`));
