const fetch = require("node-fetch");
const { API_URL, API_KEY } = require("../constants");
const { getStateById } = require("../helpers");


const stateMap = {
  "clock-in": "Clock In",
  "clock-out": "Clock Out",
  "break-in": "Break In",
  "break-out": "Break Out",
  "overtime-in": "Overtime In",
  "overtime-out": "Overtime Out",
  "unknown": "Unknown",
};

const postAttendance = async (attendance) => {
  const { pin, activityTime, stateId, deviceSN } = attendance;
  const state = stateMap[getStateById(stateId)];
  const form = new FormData();
  form.append("user_id", 2); // hardcoded for now
  form.append(state, state);
  form.append("timestamp", activityTime);
  form.append("device", deviceSN);

  const headers = {
    "Content-Type": "multipart/form-data",
    "x-api-key": API_KEY,
  };
  await fetch(`${API_URL}`, {
    method: "POST",
    headers,
    body: JSON.stringify(toPostData),
  });
};


module.exports = {
    postAttendance,
}