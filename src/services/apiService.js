const fetch = require("node-fetch");
const FormData = require("form-data");
const { API_URL, API_KEY } = require("../constants");
const { getStateById } = require("../helpers");

const stateMap = {
  "check-in": "Clock In",
  "check-out": "Clock Out",
  "break-in": "Break In",
  "break-out": "Break Out",
  "overtime-in": "Overtime In",
  "overtime-out": "Overtime Out",
  unknown: "Unknown",
};

const postAttendance = async (attendance) => {
  try {
    const { pin, activityTime, stateId, deviceSN } = attendance;

    // Validate required fields
    if (!pin || !activityTime || stateId === undefined || !deviceSN) {
      throw new Error("Missing required attendance fields.");
    }

    // Get state from stateId
    const stateKey = getStateById(stateId);
    const state = stateMap[stateKey] || stateMap.unknown;

    // Construct FormData
    const form = new FormData();
    form.append("user_id", pin); // Hardcoded for now
    form.append("state", state);
    //form.append("timestamp", activityTime);
    form.append("device", deviceSN);
    // API request
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "x-api-key": API_KEY, // No need to set Content-Type, FormData handles it
      },
      body: form,
    });
    console.log(response);
    const responseJson = await response.json();
    console.log(responseJson);
    // Parse response
    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`API Error: ${response.status} - ${errorBody}`);
    }

    console.log("Attendance successfully posted:", {
      pin,
      state,
      activityTime,
      deviceSN,
    });
  } catch (error) {
    console.error("Error posting attendance record:", error.message);
  }
};

module.exports = {
  postAttendance,
};
