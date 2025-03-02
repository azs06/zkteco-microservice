require('dotenv').config();

const PORT = process.env.PORT
const TIMEZONE = process.env.TIMEZONE

console.log(`PORT: ${PORT}`)
console.log(`TIMEZONE: ${TIMEZONE}`)

module.exports = {
    PORT,
    TIMEZONE
}