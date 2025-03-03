require('dotenv').config();

const PORT = process.env.PORT
const TIMEZONE = process.env.TIMEZONE
const API_KEY = process.env.API_KEY
const API_URL = process.env.API_URL
const ALLOWED_AGENT = process.env.ALLOWED_AGENT
const API_INTEGRATION_ENABLED = process.env.API_INTEGRATION_ENABLED

module.exports = {
    PORT,
    TIMEZONE,
    API_KEY,
    API_URL,
    ALLOWED_AGENT,
    API_INTEGRATION_ENABLED
}