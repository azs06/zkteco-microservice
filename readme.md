# Express-based HTTP Microservice for ZKTeco Device Logging

This microservice provides an API endpoint to accept data from **ZKTeco** devices and store it in an **SQLite database**. Additionally, it offers optional **API integration** with other applications.

## 🔗 API Integration

To integrate this microservice with another application, set the following environment variables in the `.env` file:

```bash
API_URL=https://api.example.com
API_KEY=1234567890
API_INTEGRATION_ENABLED=true
```

Refer to [`services/apiService.js`](services/apiService.js) for more details.

## 📌 Available Endpoints

The microservice includes endpoints to **retrieve attendance data**:

- `GET /api/attendance` — Retrieves all attendance logs.
- `GET /api/attendance/:id` — Retrieves a specific attendance log by ID.
- `GET /api/attendance/devices/:deviceSn` — Retrieves attendance logs by **device serial number**.

> **Note:** This was tested using the **ZKTeco uFace 800** device but should work with other **ZKTeco** devices as well.

## 🤝 Contributing

Feel free to contribute by submitting a **pull request**. Your contributions are welcome! 🚀

---

This version is clearer, well-structured, and more visually appealing. Let me know if you need any further modifications! 😊
