require('dotenv').config();

const PORT = process.env.PORT
const TIMEZONE = process.env.TIMEZONE
const API_KEY = process.env.API_KEY
const API_URL = process.env.API_URL


module.exports = {
    PORT,
    TIMEZONE,
    API_KEY,
    API_URL,
}