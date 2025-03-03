const fetch = require("node-fetch");
const FormData = require('form-data');
const { API_KEY } = require("./constants");

const stateMap = {
  "check-in": "Clock In",
  "check-out": "Clock Out",
  "break-in": "Break In",
  "break-out": "Break Out",
  "overtime-in": "Overtime In",
  "overtime-out": "Overtime Out",
  unknown: "Unknown",
};

const postAttendance = async () => {
  try {
    // Construct FormData
    const form = new FormData();
    form.append("user_id", 2); // Hardcoded for now
    form.append("state", "Clock In");
    //form.append("timestamp", activityTime);
    form.append("device", "123456");
    // API request
    const response = await fetch("http://localhost:8000/api/log-attendance/", {
      method: "post",
      headers: {
        "x-api-key": API_KEY, // No need to set Content-Type, FormData handles it
      },
      body: form,
    });
    console.log(response);
    // Parse response
    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`API Error: ${response.status} - ${errorBody}`);
    }
  } catch (error) {
    console.error("Error posting attendance record:", error.message);
  }
};

postAttendance().then(() => {
    console.log("Attendance successfully posted");
}).catch((error) => {
    console.error("Error posting attendance record:", error.message);
})