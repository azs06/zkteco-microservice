require('dotenv').config();

const toList = (value) => (value || "").split(",").map((item) => item.trim()).filter(Boolean);

const PORT = process.env.PORT
const TIMEZONE = process.env.TIMEZONE
const API_KEY = process.env.API_KEY
const API_URL = process.env.API_URL
const ALLOWED_AGENTS = toList(process.env.ALLOWED_AGENT)
const ALLOWED_SERIALS = toList(process.env.ALLOWED_SERIALS)
const API_INTEGRATION_ENABLED = process.env.API_INTEGRATION_ENABLED === "true"
const HTTPS_PORT = process.env.HTTPS_PORT
const HTTPS_KEY = process.env.HTTPS_KEY
const HTTPS_CERT = process.env.HTTPS_CERT
const ADMIN_USER = process.env.ADMIN_USER || "admin"
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD
// Serial numbers accepted from devices and the admin API.
const SN_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

module.exports = {
    PORT,
    TIMEZONE,
    API_KEY,
    API_URL,
    ALLOWED_AGENTS,
    ALLOWED_SERIALS,
    API_INTEGRATION_ENABLED,
    HTTPS_PORT,
    HTTPS_KEY,
    HTTPS_CERT,
    ADMIN_USER,
    ADMIN_PASSWORD,
    SN_PATTERN
}
