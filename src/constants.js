require('dotenv').config('../.env')
const IP = process.env.IP
const PORT = process.env.PORT
const API_KEY = process.env.API_KEY

module.exports = {
    IP,
    PORT,
}