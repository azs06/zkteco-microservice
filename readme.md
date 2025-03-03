# An express based http microservice that logs data from ZkTecko devices

## This microserive exposes an api endpoint that accepts data from ZkTecko devices and saves it to a sqlite database, Optionally you can integrate this microservice with other application using an api

If you want to integrate this microservice with another application, you can set `API_INTEGRATION_ENABLED` to `true` and provide the `API_URL` and `API_KEY` in the `.env` file. Check `services/apiService.js` for more information.

```bash
API_URL=https://api.example.com
API_KEY=1234567890
API_INTEGRATION_ENABLED=true
```

### Also includes couple of endpoints to retrieve the data from the database

Available endpoints:

- GET /api/attendance - retrieves all attendance logs
- GET /api/attendance/:id - retrieves attendance log by id
- GET /api/attendance/devices/:deviceSn - retrieves attendance log by devices serial number.

> Note: This was tested using ZkTecko uFace 800 device only, but should work with other ZkTecko devices as well.

#### Feel free to contribute to this project by creating a pull request
